const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const chalk = require('chalk');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const PTYManager = require('../session/pty-manager');
const TextHistory = require('../session/text-history');
const RenderedHistory = require('../session/rendered-history');
const { getAllTools } = require('../ai-tools/registry');

function execFilePromise(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ success: !error, error: error?.message, stdout, stderr });
    });
  });
}

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

function parseGitStatusZ(stdout) {
  if (!stdout) return [];

  const entries = [];
  const records = stdout.split('\0').filter(Boolean);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 3) continue;

    const status = record.substring(0, 2);
    const path = record.substring(3);
    const entry = { path, status };

    // In porcelain -z output, rename/copy records are followed by the original path.
    if ((status.includes('R') || status.includes('C')) && i + 1 < records.length) {
      entry.originalPath = records[++i];
    }

    entries.push(entry);
  }

  return entries;
}

const CircularBuffer = require('../session/buffer');
const { detectInstalledTools } = require('../ai-tools/detector');
const { getToolByKey } = require('../ai-tools/registry');
const logger = require('../utils/logger');

function previewText(text, maxChars = 320) {
  if (!text) return '';
  const normalized = String(text)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x1b/g, '\\x1b');
  return normalized.length > maxChars ? normalized.slice(-maxChars) : normalized;
}

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
  
  const sessions = new Map();

  function getHistoryModeForTool(toolKey) {
    return renderHistoryTools.has(String(toolKey || '').toLowerCase()) ? 'rendered' : 'transcript';
  }

  function getSessionDiagnostics(session, extra = {}) {
    return {
      sessionId: session.id,
      sessionName: session.name,
      toolKey: session.tool.key,
      historyMode: session.historyMode,
      workingDirectory: session.ptyManager.workingDir,
      buffer: session.buffer.getDebugSnapshot(),
      textHistory: session.textHistory.getDebugSnapshot(),
      renderedHistory: session.renderedHistory ? session.renderedHistory.getDebugSnapshot() : null,
      ...extra
    };
  }

  function getCompactSessionDiagnostics(session, extra = {}) {
    const buffer = session.buffer.getDebugSnapshot();
    const textHistory = session.textHistory.getDebugSnapshot();
    const renderedHistory = session.renderedHistory ? session.renderedHistory.getDebugSnapshot() : null;
    return {
      sessionId: session.id,
      sessionName: session.name,
      toolKey: session.tool.key,
      historyMode: session.historyMode,
      workingDirectory: session.ptyManager.workingDir,
      buffer: {
        items: buffer.items,
        totalSize: buffer.totalSize,
        currentSeq: buffer.currentSeq,
        oldestSeq: buffer.oldestSeq,
        newestSeq: buffer.newestSeq,
        combinedTailPreview: buffer.combinedTailPreview
      },
      textHistory: {
        lines: textHistory.lines,
        bytes: textHistory.bytes,
        totalWrites: textHistory.totalWrites,
        totalBytes: textHistory.totalBytes,
        escapeCount: textHistory.escapeCount,
        clearEvents: textHistory.clearEvents,
        eraseLineEvents: textHistory.eraseLineEvents,
        cursorMoveEvents: textHistory.cursorMoveEvents,
        trimEvents: textHistory.trimEvents,
        tailPreview: textHistory.tailPreview
      },
      renderedHistory: renderedHistory ? {
        cols: renderedHistory.cols,
        rows: renderedHistory.rows,
        totalWrites: renderedHistory.totalWrites,
        totalBytes: renderedHistory.totalBytes,
        pendingWrites: renderedHistory.pendingWrites,
        resizeEvents: renderedHistory.resizeEvents,
        bufferLines: renderedHistory.bufferLines,
        baseY: renderedHistory.baseY,
        cursorY: renderedHistory.cursorY,
        cursorX: renderedHistory.cursorX,
        tailPreview: renderedHistory.tailPreview
      } : null,
      ...extra
    };
  }

  function logSessionDiagnostics(reason, session, extra = {}, options = {}) {
    if (!debugHistoryEnabled || !session) return;
    const payload = options.compact
      ? getCompactSessionDiagnostics(session, extra)
      : getSessionDiagnostics(session, extra);
    logger.debugInfo(`[history-debug] ${reason} ${JSON.stringify(payload)}`);
  }

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

  // API: List all active sessions
  app.get('/api/sessions', (req, res) => {
    logger.debug('API: GET /api/sessions');
    const list = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      name: s.name,
      tool: s.tool.displayName,
      startTime: s.startTime,
      toolKey: s.tool.key,
      workingDirectory: s.ptyManager.workingDir,
      hasUnreadCompletion: Boolean(s.hasUnreadCompletion)
    }));
    res.json(list);
  });

  // API: Create a new PTY session
  app.post('/api/sessions', async (req, res) => {
    logger.debug(`API: POST /api/sessions - ${JSON.stringify(req.body)}`);
    const { toolKey, workingDirectory } = req.body;
    const tool = getToolByKey(toolKey);
    if (!tool) return res.status(400).json({ error: 'Invalid tool' });

    const id = uuidv4();
    const buffer = new CircularBuffer(500000); // 500KB terminal replay history
    const textHistory = new TextHistory({ maxBytes: 20 * 1024 * 1024, debugLabel: id });
    const historyMode = getHistoryModeForTool(tool.key);
    const renderedHistory = historyMode === 'rendered'
      ? new RenderedHistory({ maxBytes: 20 * 1024 * 1024, debugLabel: id, cols: 80, rows: 24 })
      : null;
    
    // Resolve working directory
    const sessionDir = workingDirectory && workingDirectory.trim() 
      ? path.resolve(baseDir, workingDirectory.trim()) 
      : baseDir;

    // Check if directory exists
    if (!fs.existsSync(sessionDir)) {
      return res.status(400).json({ error: `Directory does not exist: ${sessionDir}` });
    }

    const ptyManager = new PTYManager(tool, sessionDir, buffer, { silent: true });
    
    const session = {
      id,
      name: tool.displayName,
      ptyManager,
      buffer,
      textHistory,
      renderedHistory,
      historyMode,
      tool,
      startTime: Date.now(),
      isThinking: false,
      completionTimer: null,
      awaitingCompletion: false,
      inputSeq: 0,
      completionReadInputSeq: 0,
      resizeOwner: null,
      hasUnreadCompletion: false
    };

    sessions.set(id, session);
    logSessionDiagnostics('session-created', session, {}, { compact: true });

    ptyManager.onData((data) => {
      session.textHistory.write(data);
      if (session.renderedHistory) {
        session.renderedHistory.write(data);
      }
      logSessionDiagnostics('pty-output', session, {
        chunkBytes: Buffer.byteLength(String(data), 'utf8'),
        chunkPreview: previewText(data),
        containsClear: /\x1b\[[0-9;?]*J/.test(data),
        containsCursorMove: /\x1b\[[0-9;?]*(?:[ABCDGHf])/.test(data)
      }, { compact: true });

      // Treat 10 seconds without new terminal output as task completion, but only after user input.
      if (session.awaitingCompletion && !session.isThinking && data.trim().length > 0) session.isThinking = true;
      if (session.awaitingCompletion && session.isThinking) {
        clearTimeout(session.completionTimer);
        const watchedInputSeq = session.inputSeq || 0;
        session.completionTimer = setTimeout(() => {
          const hasUnreadInput = watchedInputSeq > (session.completionReadInputSeq || 0);
          const isCurrentInput = watchedInputSeq === (session.inputSeq || 0);
          if (session.awaitingCompletion && hasUnreadInput && isCurrentInput && !hasConnectedSessionClient(id)) {
            session.hasUnreadCompletion = true;
          }
          session.awaitingCompletion = false;
          session.isThinking = false;
        }, 10000);
      }
      broadcastToSession(id, { type: 'output', data });
    });

    ptyManager.onExit(() => {
      logger.info(`Session ${id} (${session.name}) exited.`);
      clearTimeout(session.completionTimer);
      if (session.renderedHistory) session.renderedHistory.dispose();
      sessions.delete(id);
      broadcastToSession(id, { type: 'exit' });
    });

    ptyManager.start([]);
    res.json({ id });
  });

  // API: Plain text terminal history for mobile-friendly reading
  app.get('/api/sessions/:id/history', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const historySource = session.renderedHistory || session.textHistory;
    logSessionDiagnostics('history-request', session, {
      userAgent: req.headers['user-agent'] || '',
      acceptEncoding: req.headers['accept-encoding'] || ''
    }, { compact: true });

    sendCompressedJson(req, res, {
      success: true,
      sessionId: session.id,
      sessionName: session.name,
      tool: session.tool.displayName,
      historyMode: session.historyMode,
      ...historySource.toJSON()
    });
  });

  // API: Rename session
  app.patch('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session && req.body.name) {
      session.name = req.body.name;
      logSessionDiagnostics('session-renamed', session, {}, { compact: true });
      res.json({ success: true, name: session.name });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // API: Mark a session completion indicator as read
  app.post('/api/sessions/:id/completion/read', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    session.hasUnreadCompletion = false;
    session.awaitingCompletion = false;
    session.isThinking = false;
    session.completionReadInputSeq = session.inputSeq || 0;
    clearTimeout(session.completionTimer);
    logSessionDiagnostics('completion-read', session, {}, { compact: true });
    res.json({ success: true });
  });

  // API: Delete/Kill session
  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
      clearTimeout(session.completionTimer);
      logSessionDiagnostics('session-deleted', session, {}, { compact: true });
      if (session.renderedHistory) session.renderedHistory.dispose();
      session.ptyManager.kill();
      sessions.delete(req.params.id);
    }
    res.json({ success: true });
  });

  app.get('/api/sessions/:id/debug', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, diagnostics: getSessionDiagnostics(session) });
  });

  app.post('/api/debug/client-log', (req, res) => {
    const { sessionId, event, payload } = req.body || {};
    const session = sessionId ? sessions.get(sessionId) : null;
    logger.debugInfo(`[client-debug] ${JSON.stringify({
      sessionId: sessionId || null,
      event: event || 'unknown',
      payload: payload || null,
      serverSide: session ? getSessionDiagnostics(session) : null
    })}`);
    res.json({ success: true });
  });

  // API: Git Show
  app.get('/api/sessions/:id/git-show/:hash', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const hash = req.params.hash;
    const result = await execFilePromise('git', ['show', '--format=fuller', '--stat', '-p', hash], session.ptyManager.workingDir);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Log
  app.get('/api/sessions/:id/git-log', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const maxCount = parseInt(req.query.maxCount) || 100;
    const result = await execFilePromise(
      'git',
      ['log', '--all', '--date-order', `--max-count=${maxCount}`, '--pretty=format:%h|%p|%d|%s|%an|%ar'],
      session.ptyManager.workingDir
    );
    if (!result.success) {
      return res.status(500).json({ error: result.error, stderr: result.stderr });
    }
    const commits = result.stdout.split('\n').filter(Boolean).map(line => {
      const [hash, parents, refs, subject, author, time] = line.split('|');
      return { hash, parents: parents ? parents.split(' ') : [], refs: refs ? refs.trim() : '', subject, author, time };
    });
    res.json({ success: true, commits });
  });

  // API: Git Status
  app.get('/api/sessions/:id/git-status', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const result = await execFilePromise('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], session.ptyManager.workingDir);
    if (!result.success) {
      return res.status(500).json({ error: result.error, stderr: result.stderr });
    }
    res.json({ success: true, files: parseGitStatusZ(result.stdout) });
  });

  // API: Git Diff Numstat (unstaged and staged)
  app.get('/api/sessions/:id/git-diff-numstat', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const args = isStaged ? ['diff', '--cached', '--numstat'] : ['diff', '--numstat'];
    const result = await execFilePromise('git', args, session.ptyManager.workingDir);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Diff File
  app.get('/api/sessions/:id/git-diff-file', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const args = isStaged
      ? ['diff', '--cached', '--no-ext-diff', '--', filePath]
      : ['diff', '--no-ext-diff', '--', filePath];
    const result = await execFilePromise('git', args, session.ptyManager.workingDir);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Get File Content
  app.get('/api/sessions/:id/file', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const filePath = req.query.path || '';
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const cwd = session.ptyManager.workingDir || '';
    const fullPath = path.resolve(cwd, filePath);
    if (!fullPath.startsWith(cwd)) {
       return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      res.json({ success: true, content });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // API: Get Directory Contents
  app.get('/api/sessions/:id/fs/dir', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const dirPath = req.query.path || '';
    const cwd = session.ptyManager.workingDir || '';
    const fullPath = path.resolve(cwd, dirPath);
    if (!fullPath.startsWith(cwd)) {
       return res.status(403).json({ error: 'Access denied' });
    }
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      let files = entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })).sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      
      // Try to get git status for the directory to decorate files
      try {
        const gitResult = await execFilePromise('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
        if (gitResult.success && gitResult.stdout) {
           const gitMap = new Map();

           parseGitStatusZ(gitResult.stdout).forEach(entry => {
             gitMap.set(entry.path, entry.status);
           });
           
           files = files.map(f => {
             const fRelPath = dirPath ? `${dirPath}/${f.name}` : f.name;
             let fStatus = null;
             
             if (f.isDirectory) {
                // Check if any file inside this dir has changes
                for (const [gitFile, gitStatus] of gitMap.entries()) {
                   if (gitFile.startsWith(fRelPath + '/')) {
                      fStatus = 'M'; // Mark dir as modified if it contains changes
                      break;
                   }
                }
             } else {
                if (gitMap.has(fRelPath)) {
                   fStatus = gitMap.get(fRelPath);
                }
             }
             return { ...f, gitStatus: fStatus };
           });
        }
      } catch (gitErr) {
        // Ignore git errors, just return files without status
      }

      res.json({ success: true, files });
    } catch (e) {
      res.json({ success: false, error: e.message });
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
    
    if (!sessionId || !sessions.has(sessionId)) {
      ws.close(4001, 'Invalid Session ID');
      return;
    }

    ws.sessionId = sessionId;
    const session = sessions.get(sessionId);
    if (!session.resizeOwner) {
      session.resizeOwner = ws;
    }
    logSessionDiagnostics('ws-connected', session, {
      remoteAddress: req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || ''
    }, { compact: true });
    
    // Send catchup buffer
    const history = session.buffer.getAfter(0);
    if (history.length > 0) {
      logSessionDiagnostics('ws-catchup', session, {
        catchupItems: history.length,
        catchupPreview: previewText(history.map(m => m.data).join(''))
      }, { compact: true });
      ws.send(JSON.stringify({ type: 'output', data: history.map(m => m.data).join('') }));
    }

    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'input') {
          if (typeof payload.data === 'string' && payload.data.length > 0) {
            session.inputSeq = (session.inputSeq || 0) + 1;
            session.awaitingCompletion = true;
            session.isThinking = false;
            session.hasUnreadCompletion = false;
            clearTimeout(session.completionTimer);
            logSessionDiagnostics('ws-input', session, {
              inputSeq: session.inputSeq,
              inputPreview: previewText(payload.data)
            }, { compact: true });
          }
          session.ptyManager.write(payload.data);
        }
        if (payload.type === 'resize' && session.resizeOwner === ws) {
          logSessionDiagnostics('ws-resize', session, {
            cols: payload.cols,
            rows: payload.rows
          }, { compact: true });
          if (session.renderedHistory) {
            session.renderedHistory.resize(payload.cols, payload.rows);
          }
          session.ptyManager.resize(payload.cols, payload.rows);
        }
      } catch (e) {
        logger.error('WS Message Error: ' + e.message);
      }
    });

    ws.on('close', () => {
      logSessionDiagnostics('ws-closed', session, {}, { compact: true });
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
  app.get('/', (req, res) => {
    try {
      const htmlPath = path.join(__dirname, '../web/index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.send(html);
    } catch (e) {
      res.status(500).send('UI not found');
    }
  });

  app.get('/gitgraph.js', (req, res) => {
    try {
      res.sendFile(path.join(__dirname, '../web/gitgraph.js'));
    } catch (e) {
      res.status(404).send('Not found');
    }
  });

  app.get('/logo.svg', (req, res) => {
    try {
      res.sendFile(path.resolve(__dirname, '../../assets/logo.svg'));
    } catch (e) {
      res.status(404).send('Not found');
    }
  });

  app.get('/manifest.json', (req, res) => res.json({ 
    name: "Glad Web", 
    short_name: "Glad", 
    start_url: "/", 
    display: "standalone",
    background_color: "#000000",
    theme_color: "#007aff",
    icons: [
      {
        src: "/logo.svg",
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
    for (const s of sessions.values()) s.ptyManager.kill();
    process.exit(0); 
  });
}

module.exports = webCommand;
