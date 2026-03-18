const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const PTYManager = require('../session/pty-manager');

function execPromise(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd }, (error, stdout, stderr) => {
      resolve({ success: !error, error: error?.message, stdout, stderr });
    });
  });
}

const CircularBuffer = require('../session/buffer');
const { detectInstalledTools } = require('../ai-tools/detector');
const { getToolByKey } = require('../ai-tools/registry');
const logger = require('../utils/logger');

async function webCommand(options) {
  const port = parseInt(options.port) || 3000;
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const baseDir = process.cwd();
  
  const sessions = new Map();

  // API: Get all supported and installed tools
  app.get('/api/tools', async (req, res) => {
    try {
      const tools = await detectInstalledTools();
      res.json(tools);
    } catch (e) {
      res.status(500).json({ error: 'Failed to detect tools' });
    }
  });

  // API: List all active sessions
  app.get('/api/sessions', (req, res) => {
    logger.debug('API: GET /api/sessions');
    const list = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      name: s.name,
      tool: s.tool.displayName,
      startTime: s.startTime,
      toolKey: s.tool.key
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
    const buffer = new CircularBuffer(200000); // 200KB history
    
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
      tool,
      startTime: Date.now(),
      isThinking: false,
      completionTimer: null
    };

    sessions.set(id, session);

    ptyManager.onData((data) => {
      // Logic to detect "thinking" state for notifications
      if (!session.isThinking && data.trim().length > 0) session.isThinking = true;
      if (session.isThinking) {
        clearTimeout(session.completionTimer);
        session.completionTimer = setTimeout(() => {
          broadcastToSession(id, { type: 'notification', title: 'Task Finished', body: session.name + ' is ready' });
          session.isThinking = false;
        }, 2500);
      }
      broadcastToSession(id, { type: 'output', data });
    });

    ptyManager.onExit(() => {
      logger.info(`Session ${id} (${session.name}) exited.`);
      sessions.delete(id);
      broadcastToSession(id, { type: 'exit' });
    });

    ptyManager.start([]);
    res.json({ id });
  });

  // API: Rename session
  app.patch('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session && req.body.name) {
      session.name = req.body.name;
      res.json({ success: true, name: session.name });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // API: Delete/Kill session
  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
      session.ptyManager.kill();
      sessions.delete(req.params.id);
    }
    res.json({ success: true });
  });

  // API: Git Status
  app.get('/api/sessions/:id/git-status', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const result = await execPromise('git status --porcelain=v2 --branch --untracked-files=all', session.ptyManager.cwd);
    if (!result.success) {
      return res.status(500).json({ error: result.error, stderr: result.stderr });
    }
    res.json({ stdout: result.stdout });
  });

  // API: Git Diff Numstat (unstaged and staged)
  app.get('/api/sessions/:id/git-diff-numstat', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const cmd = isStaged ? 'git diff --cached --numstat' : 'git diff --numstat';
    const result = await execPromise(cmd, session.ptyManager.cwd);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Git Diff File
  app.get('/api/sessions/:id/git-diff-file', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isStaged = req.query.staged === 'true';
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const cmd = isStaged 
      ? `git diff --cached --no-ext-diff -- "${filePath}"`
      : `git diff --no-ext-diff -- "${filePath}"`;
    const result = await execPromise(cmd, session.ptyManager.cwd);
    res.json({ success: result.success, stdout: result.stdout, stderr: result.stderr });
  });

  // API: Get File Content
  app.get('/api/sessions/:id/file', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const filePath = req.query.path || '';
    if (!filePath) return res.status(400).json({ error: 'Missing file path' });
    const cwd = session.ptyManager.cwd || '';
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
    const cwd = session.ptyManager.cwd || '';
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
        const gitResult = await execPromise('git status --porcelain', cwd);
        if (gitResult.success && gitResult.stdout) {
           const lines = gitResult.stdout.split('\n');
           const gitMap = new Map();
           
           lines.forEach(line => {
             if (line.length < 4) return;
             const status = line.substring(0, 2);
             const file = line.substring(3).trim();
             gitMap.set(file, status);
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
    
    // Send catchup buffer
    const history = session.buffer.getAfter(0);
    if (history.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: history.map(m => m.data).join('') }));
    }

    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'input') session.ptyManager.write(payload.data);
        if (payload.type === 'resize') session.ptyManager.resize(payload.cols, payload.rows);
      } catch (e) {
        logger.error('WS Message Error: ' + e.message);
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
      res.status(500).send('Error loading UI: ' + e.message);
    }
  });

  app.get('/manifest.json', (req, res) => res.json({ 
    name: "Glad Web", 
    short_name: "Glad", 
    start_url: "/", 
    display: "standalone",
    background_color: "#000000",
    theme_color: "#007aff"
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
    console.log(chalk.gray(`Tips: Access from your phone via the Network URL above.\n`));
  });

  process.on('SIGINT', () => { 
    for (const s of sessions.values()) s.ptyManager.kill();
    process.exit(0); 
  });
}

module.exports = webCommand;
