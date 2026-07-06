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
  sessionManager.on('output', ({ sessionId, data }) => {
    broadcastToSession(sessionId, { type: 'output', data });
  });
  sessionManager.on('claude-event', ({ sessionId, event }) => {
    broadcastToSession(sessionId, { type: 'claude-event', event });
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

  // API: Scheduled tasks
  app.get('/api/schedules', (req, res) => {
    res.json(jobStore.list());
  });

  app.post('/api/schedules', (req, res) => {
    try {
      const job = jobStore.create(req.body || {});
      res.json(job);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/schedules/:id', (req, res) => {
    const job = jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.patch('/api/schedules/:id', (req, res) => {
    const job = jobStore.update(req.params.id, req.body || {});
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.patch('/api/schedules/:id/enabled', (req, res) => {
    const job = jobStore.patchRuntime(req.params.id, { enabled: Boolean(req.body && req.body.enabled) });
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.delete('/api/schedules/:id', (req, res) => {
    res.json({ success: jobStore.delete(req.params.id) });
  });

  app.post('/api/schedules/:id/duplicate', (req, res) => {
    const job = jobStore.duplicate(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scheduled task not found' });
    res.json(job);
  });

  app.post('/api/schedules/:id/run', async (req, res) => {
    try {
      const result = await jobRunner.run(req.params.id, { manual: false });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/schedules/:id/simulate', async (req, res) => {
    try {
      const result = await jobRunner.run(req.params.id, { manual: true, background: true });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // API: List all active sessions
  app.get('/api/sessions', (req, res) => {
    logger.debug('API: GET /api/sessions');
    res.json(sessionManager.list());
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

  app.get('/api/sessions/:id/claude-resume-sessions', (req, res) => {
    const items = sessionManager.listClaudeResumeSessions(req.params.id);
    if (!items) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true, items });
  });

  app.patch('/api/sessions/:id/claude-settings', (req, res) => {
    const state = sessionManager.updateClaudeSettings(req.params.id, req.body || {});
    if (!state) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true, state });
  });

  app.post('/api/sessions/:id/claude-abort', (req, res) => {
    const success = sessionManager.abortClaude(req.params.id);
    if (!success) return res.status(404).json({ error: 'Claude session not found or idle' });
    res.json({ success: true });
  });

  app.post('/api/sessions/:id/claude-resume', (req, res) => {
    const resumeSessionId = req.body && req.body.resumeSessionId;
    if (!resumeSessionId) return res.status(400).json({ error: 'Missing resumeSessionId' });
    const success = sessionManager.resumeClaude(req.params.id, resumeSessionId);
    if (!success) return res.status(404).json({ error: 'Claude session not found' });
    res.json({ success: true });
  });

  app.post('/api/debug/client-log', (req, res) => {
    const { sessionId, event, payload } = req.body || {};
    sessionManager.logClientDebug(sessionId, event, payload);
    res.json({ success: true });
  });

  // API: Git Show
  app.get('/api/sessions/:id/git-show/:hash', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const hash = req.params.hash;
    const result = await gitService.show(getSessionWorkingDirectory(session), hash);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Branch Name for Commit
  app.get('/api/sessions/:id/git-branch/:hash', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const hash = req.params.hash;
    const result = await gitService.nameRev(getSessionWorkingDirectory(session), hash);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Log
  app.get('/api/sessions/:id/git-log', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const result = await gitService.log(getSessionWorkingDirectory(session), req.query.maxCount);
    if (!result.success) {
      return res.status(500).json({ error: result.error, stderr: result.stderr });
    }
    res.json({ success: true, commits: result.commits });
  });

  // API: Git Status
  app.get('/api/sessions/:id/git-status', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const result = await gitService.status(getSessionWorkingDirectory(session));
    if (!result.success) {
      return res.status(500).json({ error: result.error, stderr: result.stderr });
    }
    res.json({ success: true, files: result.files });
  });

  // API: Git Diff Numstat (unstaged and staged)
  app.get('/api/sessions/:id/git-diff-numstat', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const result = await gitService.diffNumstat(getSessionWorkingDirectory(session), isStaged);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Diff File
  app.get('/api/sessions/:id/git-diff-file', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const result = await gitService.diffFile(getSessionWorkingDirectory(session), filePath, isStaged);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Get File Content
  app.get('/api/sessions/:id/file', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const filePath = req.query.path || '';
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const cwd = getSessionWorkingDirectory(session);
    try {
      const content = workspaceService.readFile(cwd, filePath);
      res.json({ success: true, content });
    } catch (e) {
      res.status(e.statusCode || 200).json({ success: false, error: e.message });
    }
  });

  // API: Get Directory Contents
  app.get('/api/sessions/:id/fs/dir', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const dirPath = req.query.path || '';
    const cwd = getSessionWorkingDirectory(session);
    try {
      const files = await workspaceService.listDirectory(cwd, dirPath);
      res.json({ success: true, files });
    } catch (e) {
      res.status(e.statusCode || 200).json({ success: false, error: e.message });
    }
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
    
    // Send catchup output. TUI tools may skip the raw circular buffer, so fall
    // back to the rendered/text history snapshot instead of reconnecting blank.
    const catchup = sessionManager.getCatchupOutput(sessionId);
    ws.needsTuiRedraw = session.kind !== 'claude-structured'
      && ['antigravity', 'claude-code', 'codex'].includes(session.tool.key)
      && (isReconnect || (catchup && catchup.source === 'rendered-history'));
    if (ws.needsTuiRedraw) {
      ws.send(JSON.stringify({ type: 'reset' }));
    } else if (session.kind !== 'claude-structured' && catchup && catchup.data) {
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
          sessionManager.sendClaudeInput(sessionId, payload.text || '');
        }
        if (payload.type === 'claude-permission') {
          sessionManager.respondClaudePermission(sessionId, payload.id, Boolean(payload.approved));
        }
        if (payload.type === 'claude-settings') {
          sessionManager.updateClaudeSettings(sessionId, payload.settings || {});
        }
        if (payload.type === 'claude-abort') {
          sessionManager.abortClaude(sessionId);
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

  app.get(['/gitgraph.js', /.*\/gitgraph\.js$/], (req, res) => {
    res.sendFile('gitgraph.js', { root: webDir }, error => {
      if (error && !res.headersSent) res.status(404).send('Not found');
    });
  });

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
    sessionManager.killAll();
    process.exit(0); 
  });
}

module.exports = webCommand;
