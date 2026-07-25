const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const chalk = require('chalk');
const { getAllTools } = require('../ai-tools/registry');
const { GitService } = require('../git/service');
const WorkspaceService = require('../workspace/service');
const SessionManager = require('../session/session-manager');

function sendCompressedJson(req, res, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const acceptEncoding = req.headers['accept-encoding'] || '';

  if (/\bgzip\b/.test(acceptEncoding)) {
    zlib.gzip(body, { level: 6 }, (error, compressed) => {
      if (error) {
        res.type('application/json').send(body);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', compressed.length);
      res.send(compressed);
    });
    return;
  }

  res.type('application/json').send(body);
}

function getSessionWorkingDirectory(session) {
  return session.workingDir || (session.ptyManager && session.ptyManager.workingDir) || process.cwd();
}

const { detectInstalledTools } = require('../ai-tools/detector');
const logger = require('../utils/logger');
const { JobStore } = require('../schedule/job-store');
const JobRunner = require('../schedule/job-runner');
const SchedulerService = require('../schedule/scheduler-service');
const { getClaudeRuntimeConfig } = require('../claude/config');
const registerScheduleRoutes = require('../server/routes/schedules');
const registerWorkspaceRoutes = require('../server/routes/workspace');
const registerProviderRoutes = require('../server/routes/providers');
const registerNotificationRoutes = require('../server/routes/notifications');
const { ServerChanSettingsStore } = require('../notifications/serverchan-settings-store');
const ServerChanClient = require('../notifications/serverchan-client');
const NotificationService = require('../notifications/notification-service');

async function webCommand(options) {
  const port = parseInt(options.port) || 3000;
  const debugHistoryEnabled = process.env.DEBUG_SESSION_HISTORY === '1';
  const defaultRenderedTools = getAllTools().map(tool => tool.key).join(',');
  const renderHistoryTools = new Set(
    String(process.env.HISTORY_RENDER_TOOLS || defaultRenderedTools)
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });
  app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 3 },
      zlibInflateOptions: {},
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    }
  });
  
  // Use directory from options if provided, otherwise default to current working directory
  const baseDir = options.directory ? path.resolve(process.cwd(), options.directory) : process.cwd();
  
  const jobStore = new JobStore();
  const gitService = new GitService();
  const workspaceService = new WorkspaceService({ gitService });
  const sessionManager = new SessionManager({
    baseDir,
    renderHistoryTools,
    debugHistoryEnabled,
    logger,
    hasConnectedSessionClient
  });
  const serverChanSettings = new ServerChanSettingsStore();
  const notificationService = new NotificationService({
    sessionManager,
    settingsStore: serverChanSettings,
    channel: new ServerChanClient(),
    logger
  });
  sessionManager.on('output', ({ sessionId, data }) => {
    broadcastToSession(sessionId, { type: 'output', data });
  });
  sessionManager.on('claude-event', ({ sessionId, event }) => {
    broadcastToSession(sessionId, { type: 'claude-event', event });
  });
  sessionManager.on('codex-event', ({ sessionId, event }) => {
    broadcastToSession(sessionId, { type: 'codex-event', event });
  });
  sessionManager.on('exit', ({ sessionId }) => {
    broadcastToSession(sessionId, { type: 'exit' });
  });

  const jobRunner = new JobRunner({
    createSession: input => sessionManager.create(input),
    getJob: id => jobStore.get(id),
    updateJob: (id, patch) => jobStore.patchRuntime(id, patch),
    logger
  });
  const schedulerService = new SchedulerService({ jobStore, jobRunner, logger });
  schedulerService.start();

  // API: Get all supported and installed tools
  app.get('/api/tools', async (req, res) => {
    try {
      const tools = await detectInstalledTools();
      res.json(tools);
    } catch (e) {
      res.status(500).json({ error: 'Failed to detect tools' });
    }
  });

  // API: Get web UI runtime configuration
  app.get('/api/config', (req, res) => {
    res.json({ defaultWorkingDirectory: baseDir });
  });

  registerScheduleRoutes(app, { jobStore, jobRunner });
  registerNotificationRoutes(app, {
    settingsStore: serverChanSettings,
    notificationService
  });

  // API: List all active sessions
  app.get('/api/sessions', (req, res) => {
    logger.debug('API: GET /api/sessions');
    res.json(sessionManager.list());
  });

  app.get('/api/claude-config', (req, res) => {
    res.json({ success: true, config: getClaudeRuntimeConfig(process.env) });
  });

  // API: Create a new PTY session
  app.post('/api/sessions', async (req, res) => {
    logger.debug(`API: POST /api/sessions - ${JSON.stringify(req.body)}`);
    try {
      const { toolKey, workingDirectory, claudeOptions } = req.body;
      const session = sessionManager.create({ toolKey, workingDirectory, claudeOptions });
      res.json({ id: session.id });
    } catch (e) {
      logger.error(`API: POST /api/sessions failed: ${e.message}`);
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // API: Plain text terminal history for mobile-friendly reading
  app.get('/api/sessions/:id/history', (req, res) => {
    const history = sessionManager.getHistory(req.params.id);
    if (!history) return res.status(404).json({ error: 'Session not found' });
    sessionManager.logHistoryRequest(req.params.id, req);
    sendCompressedJson(req, res, history);
  });

  // API: Rename session
  app.patch('/api/sessions/:id', (req, res) => {
    const session = sessionManager.rename(req.params.id, req.body.name);
    if (session) {
      res.json({ success: true, name: session.name });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // API: Mark a session completion indicator as read
  app.post('/api/sessions/:id/completion/read', (req, res) => {
    const session = sessionManager.markCompletionRead(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  });

  app.get('/api/sessions/:id/timed-inputs', (req, res) => {
    const items = sessionManager.listTimedInputs(req.params.id);
    if (!items) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, items });
  });

  app.post('/api/sessions/:id/timed-inputs', (req, res) => {
    try {
      const item = sessionManager.scheduleTimedInput(req.params.id, req.body || {});
      if (!item) return res.status(404).json({ error: 'Session not found' });
      res.json({ success: true, item });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.patch('/api/sessions/:id/timed-inputs/:inputId', (req, res) => {
    try {
      const item = sessionManager.updateTimedInput(req.params.id, req.params.inputId, req.body || {});
      if (item === null) return res.status(404).json({ error: 'Session not found' });
      if (!item) return res.status(404).json({ error: 'Timed input not found' });
      res.json({ success: true, item });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.delete('/api/sessions/:id/timed-inputs/:inputId', (req, res) => {
    const cancelled = sessionManager.cancelTimedInput(req.params.id, req.params.inputId);
    if (cancelled === null) return res.status(404).json({ error: 'Session not found' });
    if (!cancelled) return res.status(404).json({ error: 'Timed input not found' });
    res.json({ success: true });
  });

  // Browser images are stored only in a private, per-session temporary directory.
  // Structured providers receive either a local path or validated base64 content.
  app.post('/api/sessions/:id/attachments/images', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    try {
      const attachment = await sessionManager.storeImageAttachment(req.params.id, req.body);
      res.status(201).json({ success: true, attachment });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // Mobile Safari can coalesce progress events for a single large request.
  // Small sequential chunks let the browser report progress from server receipts.
  app.post('/api/sessions/:id/attachments/images/chunks', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    try {
      const result = await sessionManager.appendImageChunk(req.params.id, {
        uploadId: req.get('X-Glad-Upload-Id'),
        chunkIndex: req.get('X-Glad-Chunk-Index'),
        chunkTotal: req.get('X-Glad-Chunk-Total')
      }, req.body);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.delete('/api/sessions/:id/attachments/images/uploads/:uploadId', async (req, res) => {
    try {
      const removed = await sessionManager.discardImageUpload(req.params.id, req.params.uploadId);
      res.json({ success: true, removed });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.delete('/api/sessions/:id/attachments/images/:attachmentId', async (req, res) => {
    try {
      const removed = await sessionManager.discardImageAttachment(req.params.id, req.params.attachmentId);
      if (!removed) return res.status(404).json({ error: 'Image attachment not found' });
      res.json({ success: true });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // API: Delete/Kill session
  app.delete('/api/sessions/:id', (req, res) => {
    sessionManager.kill(req.params.id);
    res.json({ success: true });
  });

  app.get('/api/sessions/:id/debug', (req, res) => {
    const diagnostics = sessionManager.getDiagnostics(req.params.id);
    if (!diagnostics) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, diagnostics });
  });

  registerProviderRoutes(app, { sessionManager });

  registerWorkspaceRoutes(app, {
    sessionManager,
    gitService,
    workspaceService,
    getWorkingDirectory: getSessionWorkingDirectory
  });


  function broadcastToSession(sessionId, message) {
    const msgStr = JSON.stringify(message);
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client.sessionId === sessionId) {
        client.send(msgStr);
      }
    });
  }

  function hasConnectedSessionClient(sessionId) {
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.sessionId === sessionId) return true;
    }
    return false;
  }

  // WebSocket: Terminal I/O
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const sessionId = url.searchParams.get('sessionId');
    
    if (!sessionId || !sessionManager.has(sessionId)) {
      ws.close(4001, 'Invalid Session ID');
      return;
    }

    ws.sessionId = sessionId;
    const session = sessionManager.get(sessionId);
    const isReconnect = session.hasConnectedWebClient;
    session.hasConnectedWebClient = true;
    if (!session.resizeOwner) {
      session.resizeOwner = ws;
    }
    sessionManager.logWsConnected(sessionId, req);

    if (session.kind === 'claude-structured') {
      ws.send(JSON.stringify({ type: 'claude-snapshot', snapshot: sessionManager.getClaudeSnapshot(sessionId) }));
    }
    if (session.kind === 'codex-structured' && session.presentation === 'structured') {
      ws.send(JSON.stringify({ type: 'codex-snapshot', snapshot: sessionManager.getCodexSnapshot(sessionId) }));
    }
    
    // Send catchup output. TUI tools may skip the raw circular buffer, so fall
    // back to the rendered/text history snapshot instead of reconnecting blank.
    const catchup = sessionManager.getCatchupOutput(sessionId);
    ws.needsTuiRedraw = !['claude-structured', 'codex-structured'].includes(session.kind)
      && ['antigravity', 'claude-code', 'codex'].includes(session.tool.key)
      && (isReconnect || (catchup && catchup.source === 'rendered-history'));
    if (ws.needsTuiRedraw) {
      ws.send(JSON.stringify({ type: 'reset' }));
    } else if (!(session.kind === 'claude-structured' || (session.kind === 'codex-structured' && session.presentation === 'structured')) && catchup && catchup.data) {
      sessionManager.logWsCatchupOutput(sessionId, catchup);
      ws.send(JSON.stringify({ type: 'output', data: catchup.data }));
    }

    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'input') {
          session.write(payload.data);
        }
        if (payload.type === 'claude-input') {
          sessionManager.sendClaudeInput(sessionId, payload.text || '', payload.attachmentIds || [])
            .catch(error => logger.error(`Claude input error: ${error.message}`));
        }
        if (payload.type === 'claude-permission') {
          sessionManager.respondClaudePermission(sessionId, payload.id, Boolean(payload.approved), payload.action || null);
        }
        if (payload.type === 'claude-settings') {
          sessionManager.updateClaudeSettings(sessionId, payload.settings || {});
        }
        if (payload.type === 'claude-usage') {
          sessionManager.showClaudeUsage(sessionId).catch(error => logger.error(`Claude usage error: ${error.message}`));
        }
        if (payload.type === 'claude-context') {
          sessionManager.showClaudeContext(sessionId).catch(error => logger.error(`Claude context error: ${error.message}`));
        }
        if (payload.type === 'claude-abort') {
          sessionManager.abortClaude(sessionId);
        }
        if (payload.type === 'codex-input') {
          sessionManager.sendCodexInput(sessionId, payload.text || '', payload.attachmentIds || [], payload.skills || [])
            .catch(error => logger.error(`Codex input error: ${error.message}`));
        }
        if (payload.type === 'codex-permission') {
          const codex = sessionManager.get(sessionId);
          if (codex && codex.kind === 'codex-structured') {
            codex.respondPermission(payload.id, payload.decision || Boolean(payload.approved));
          }
        }
        if (payload.type === 'codex-settings') {
          sessionManager.updateCodexSettings(sessionId, payload.settings || {}).catch(error => logger.error(`Codex settings error: ${error.message}`));
        }
        if (payload.type === 'codex-status') {
          sessionManager.showCodexStatus(sessionId).catch(error => logger.error(`Codex status error: ${error.message}`));
        }
        if (payload.type === 'codex-compact') {
          sessionManager.compactCodexContext(sessionId).catch(error => logger.error(`Codex compact error: ${error.message}`));
        }
        if (payload.type === 'codex-detail-request') {
          const codex = sessionManager.get(sessionId);
          if (codex && codex.kind === 'codex-structured' && codex.presentation === 'structured') {
            ws.send(JSON.stringify({
              type: 'codex-detail-response',
              requestId: payload.requestId || null,
              detail: codex.getMessageDetails({ ids: payload.ids, threadId: payload.threadId })
            }));
          }
        }
        if (payload.type === 'codex-abort') {
          sessionManager.abortCodex(sessionId);
        }
        if (payload.type === 'claude-resume') {
          sessionManager.resumeClaude(sessionId, payload.resumeSessionId || '');
        }
        if (payload.type === 'resize' && session.resizeOwner === ws) {
          sessionManager.logWsResize(sessionId, payload.cols, payload.rows);
          if (ws.needsTuiRedraw) {
            ws.needsTuiRedraw = false;
            sessionManager.redraw(sessionId, payload.cols, payload.rows);
          } else {
            sessionManager.resize(sessionId, payload.cols, payload.rows);
          }
        }
      } catch (e) {
        logger.error('WS Message Error: ' + e.message);
      }
    });

    ws.on('close', () => {
      sessionManager.logWsClosed(sessionId);
      if (session.resizeOwner !== ws) return;
      session.resizeOwner = null;
      for (const client of wss.clients) {
        if (client.readyState === 1 && client.sessionId === sessionId) {
          session.resizeOwner = client;
          break;
        }
      }
    });
  });

  // Frontend routes
  const assetsDir = path.resolve(__dirname, '../../assets');
  const webDir = path.join(__dirname, '../web');
  const xtermScript = require.resolve('@xterm/xterm');
  const xtermStyles = path.resolve(path.dirname(xtermScript), '../css/xterm.css');
  const fitAddonScript = require.resolve('@xterm/addon-fit');

  const sendLogo = (req, res) => {
    res.sendFile('logo.svg', { root: assetsDir }, error => {
      if (error && !res.headersSent) res.status(404).send('Not found');
    });
  };

  app.get('/', (req, res) => {
    try {
      const htmlPath = path.join(__dirname, '../web/index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.send(html);
    } catch (e) {
      res.status(500).send('UI not found');
    }
  });

  const sendWebAsset = assetName => (req, res) => {
    res.sendFile(assetName, { root: webDir }, error => {
      if (error && !res.headersSent) res.status(404).send('Not found');
    });
  };

  const sendDependencyAsset = assetPath => (req, res) => {
    res.sendFile(path.basename(assetPath), { root: path.dirname(assetPath) });
  };

  const webAssets = [
    'gitgraph.js',
    'styles.css',
    'core.js',
    'notifications.js',
    'claude.js',
    'schedules.js',
    'shell.js',
    'codex.js',
    'session.js',
    'composer.js',
    'timed-inputs.js',
    'terminal-scroll.js',
    'git.js'
  ];
  for (const assetName of webAssets) {
    const escapedName = assetName.replace('.', '\\.');
    app.get([`/${assetName}`, new RegExp(`.*\\/${escapedName}$`)], sendWebAsset(assetName));
  }

  app.get('/vendor/xterm.js', sendDependencyAsset(xtermScript));
  app.get('/vendor/xterm.css', sendDependencyAsset(xtermStyles));
  app.get('/vendor/xterm-addon-fit.js', sendDependencyAsset(fitAddonScript));

  app.get(['/logo.svg', /.*\/logo\.svg$/], sendLogo);

  app.get(['/favicon.ico', /.*\/favicon\.ico$/], (req, res) => {
    res.type('image/svg+xml');
    sendLogo(req, res);
  });

  app.get(['/manifest.json', /.*\/manifest\.json$/], (req, res) => res.json({ 
    name: "Glad Web", 
    short_name: "Glad", 
    start_url: ".", 
    display: "standalone",
    background_color: "#000000",
    theme_color: "#007aff",
    icons: [
      {
        src: "logo.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  }));

  server.listen(port, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let networkInfo = '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          networkInfo += `\n   ➜  Network: http://${iface.address}:${port}`;
        }
      }
    }
    console.log(chalk.green(`\n🚀 Glad Web Server is running!`));
    console.log(chalk.cyan(`   ➜  Local:   http://localhost:${port}${networkInfo}\n`));
    console.log(chalk.gray(`   ➜  Project: ${baseDir}\n`));
    console.log(chalk.gray(`   ➜  History Render Tools: ${Array.from(renderHistoryTools).join(', ') || '(none)'}\n`));
    console.log(chalk.gray(`Tips: Access from your phone via the Network URL above.\n`));
  });

  process.on('SIGINT', () => { 
    schedulerService.stop();
    notificationService.stop();
    sessionManager.killAll();
    process.exit(0); 
  });
}

module.exports = webCommand;
