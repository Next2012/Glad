const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { v4: uuidv4 } = require('uuid');
const PTYManager = require('../session/pty-manager');
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
  const workingDir = process.cwd();
  
  const sessions = new Map();

  app.get('/api/tools', async (req, res) => {
    try {
      const tools = await detectInstalledTools();
      res.json(tools);
    } catch (e) {
      res.status(500).json({ error: 'Failed to detect tools' });
    }
  });

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

  app.post('/api/sessions', async (req, res) => {
    logger.debug(`API: POST /api/sessions - ${JSON.stringify(req.body)}`);
    const { toolKey, args, workingDirectory } = req.body;
    const tool = getToolByKey(toolKey);
    if (!tool) return res.status(400).json({ error: 'Invalid tool' });

    const id = uuidv4();
    const buffer = new CircularBuffer(200000);
    const sessionDir = workingDirectory && workingDirectory.trim() ? workingDirectory.trim() : workingDir;
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
      if (!session.isThinking && data.trim().length > 0) session.isThinking = true;
      if (session.isThinking) {
        clearTimeout(session.completionTimer);
        session.completionTimer = setTimeout(() => {
          broadcastToSession(id, { type: 'notification', title: '执行完成', body: session.name + ' 已就绪' });
          session.isThinking = false;
        }, 2500);
      }
      broadcastToSession(id, { type: 'output', data });
    });

    ptyManager.onExit(() => {
      sessions.delete(id);
      broadcastToSession(id, { type: 'exit' });
    });

    ptyManager.start(args ? args.split(' ') : []);
    res.json({ id });
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session && req.body.name) {
      session.name = req.body.name;
      res.json({ success: true, name: session.name });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session) {
      session.ptyManager.kill();
      sessions.delete(req.params.id);
    }
    res.json({ success: true });
  });

  function broadcastToSession(sessionId, message) {
    const msgStr = JSON.stringify(message);
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client.sessionId === sessionId) {
        client.send(msgStr);
      }
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const sessionId = url.searchParams.get('sessionId');
    
    if (!sessionId || !sessions.has(sessionId)) {
      ws.close(4001, 'Invalid Session ID');
      return;
    }

    ws.sessionId = sessionId;
    const session = sessions.get(sessionId);
    
    const history = session.buffer.getAfter(0);
    if (history.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: history.map(m => m.data).join('') }));
    }

    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'input') session.ptyManager.write(payload.data);
        if (payload.type === 'resize') session.ptyManager.resize(payload.cols, payload.rows);
      } catch (e) {}
    });
  });

  app.get('/', (req, res) => res.send(getHTML()));
  app.get('/manifest.json', (req, res) => res.json({ name: "Termly Web", short_name: "Termly", start_url: "/", display: "standalone" }));

  server.listen(port, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let networkInfo = '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          networkInfo += '\n   ➜  内网/PWA: http://' + iface.address + ':' + port;
        }
      }
    }
    console.log(chalk.green('\n🚀 Termly 服务已启动!\n本地访问: http://localhost:' + port + networkInfo + '\n'));
    console.log(chalk.gray('提示: 如需在后台运行，建议使用 \'pm2 start termly -- web\' 或 \'screen -dmS termly node bin/cli.js web\'\n'));
  });

  process.on('SIGINT', () => { 
    for (const s of sessions.values()) s.ptyManager.kill();
    process.exit(0); 
  });
}

function getHTML() {
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Termly - 会话管理</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css" />
    <style>
        :root { --primary: #007aff; --bg: #000; --card-bg: #1c1c1e; --text: #fff; --text-dim: #8e8e93; }
        body, html { margin: 0; padding: 0; height: 100dvh; width: 100vw; background: var(--bg); color: var(--text); overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .view { display: none; height: 100%; width: 100%; flex-direction: column; }
        .view.active { display: flex; }
        #lobby { overflow-y: auto; padding: 20px; padding-top: env(safe-area-inset-top); box-sizing: border-box; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .header h1 { font-size: 28px; font-weight: 700; margin: 0; }
        .btn-new { background: var(--primary); color: #fff; border: none; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 15px; cursor: pointer; }
        .btn-retry { background: #333; color: #fff; border: none; padding: 8px 16px; border-radius: 20px; margin-top: 10px; cursor: pointer; }
        .session-card { background: var(--card-bg); border-radius: 12px; padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; transition: transform 0.1s; position: relative; }
        .session-card:active { transform: scale(0.98); }
        .session-info { flex: 1; min-width: 0; }
        .session-info h3 { margin: 0 0 4px 0; font-size: 17px; display: flex; align-items: center; gap: 8px; }
        .session-info p { margin: 0; font-size: 13px; color: var(--text-dim); }
        .session-actions { display: flex; gap: 12px; align-items: center; margin-left: 10px; }
        .btn-join { background: rgba(255,255,255,0.1); border: none; color: var(--primary); padding: 8px 14px; border-radius: 18px; font-weight: 600; font-size: 14px; cursor: pointer; }
        .icon-btn { color: var(--text-dim); background: none; border: none; padding: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .icon-btn:active { color: var(--text); }
        .btn-delete { color: #ff3b30; }
        #modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 10000; display: none; align-items: center; justify-content: center; padding: 20px; }
        #tool-modal { background: var(--card-bg); width: 100%; max-width: 400px; border-radius: 16px; padding: 20px; }
        .tool-item { padding: 12px; border-bottom: 1px solid #333; cursor: pointer; display: flex; align-items: center; }
        .tool-item:last-child { border: none; }
        .tool-icon { width: 32px; height: 32px; background: #333; border-radius: 8px; margin-right: 12px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        #terminal-view { background: #000; }
        #top-ui { flex-shrink: 0; background: #121212; border-bottom: 1px solid #222; z-index: 2000; padding-top: env(safe-area-inset-top); }
        #nav-bar { display: flex; align-items: center; padding: 8px 14px; border-bottom: 1px solid #222; }
        #back-btn { color: var(--primary); font-size: 16px; font-weight: 500; display: flex; align-items: center; text-decoration: none; background: none; border: none; padding: 0; cursor: pointer; }
        #session-title { flex: 1; text-align: center; font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 10px; }
        #input-row { display: flex; align-items: flex-end; padding: 10px 14px; }
        #cmd-input { flex: 1; min-height: 38px; max-height: 100px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 19px; color: #fff; padding: 9px 16px; font-size: 16px; outline: none; resize: none; overflow-y: auto; line-height: 20px; box-sizing: border-box; }
        #send-btn { width: 44px; height: 38px; margin-left: 10px; background: #007aff; border: none; border-radius: 19px; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; }
        #shortcut-bar { display: flex; padding: 2px 12px 12px 12px; gap: 8px; justify-content: space-between; }
        .key-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; height: 38px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; color: #ccc; font-size: 11px; font-weight: 700; text-transform: uppercase; cursor: pointer; }
        .key-btn.active { background: rgba(0, 122, 255, 0.25); border-color: #007aff; color: #00a2ff; }
        #terminal-container { flex: 1; min-height: 0; width: 100%; background: #000; position: relative; overflow: hidden; }
        #terminal { height: 100%; width: 100%; }
        #scroll-controls { position: fixed; right: 14px; top: 60%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 18px; z-index: 3000; }
        .scroll-btn { width: 56px; height: 56px; background: rgba(30, 30, 30, 0.5); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); cursor: pointer; }
        #debug-log { position: fixed; bottom: 0; left: 0; right: 0; max-height: 100px; background: rgba(0,0,0,0.8); color: #0f0; font-size: 10px; overflow-y: auto; padding: 5px; z-index: 9999; display: none; pointer-events: none; }
    </style>
</head>
<body>
    <div id="debug-log"></div>
    <div id="lobby-view" class="view active">
        <div id="lobby">
            <div class="header">
                <h1>Termly 会话</h1>
                <button class="btn-new" onclick="showToolModal()">+ 新建</button>
            </div>
            <div id="sessions-list">
                <p style="color:#888; text-align:center; margin-top:50px;">正在加载会话...</p>
            </div>
        </div>
    </div>

    <div id="terminal-view" class="view">
        <div id="top-ui">
            <div id="nav-bar">
                <button id="back-btn" onclick="showLobby()">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    大厅
                </button>
                <div id="session-title">Terminal</div>
                <div style="width: 50px"></div>
            </div>
            <div id="input-row">
                <textarea id="cmd-input" rows="1" placeholder="输入命令..."></textarea>
                <button id="send-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                </button>
            </div>
            <div id="shortcut-bar">
                <div class="key-btn special-key" data-key="up">↑</div>
                <div class="key-btn special-key" data-key="down">↓</div>
                <div class="key-btn" data-key="ctrl">Ctrl</div>
                <div class="key-btn special-key" data-key="enter">⏎</div>
                <div class="key-btn" data-key="esc">Esc</div>
                <div class="key-btn" data-key="tab">Tab</div>
                <div class="key-btn" data-key="alt">Alt</div>
            </div>
        </div>
        <div id="scroll-controls">
            <div class="scroll-btn" id="scroll-up">▲</div>
            <div class="scroll-btn" id="scroll-down">▼</div>
        </div>
        <div id="terminal-container"><div id="terminal"></div></div>
    </div>

    <div id="modal-overlay" onclick="closeToolModal(event)">
        <div id="tool-modal">
            <h2 style="margin-top:0">选择工具</h2>
            <div style="margin-bottom: 15px;">
                <label style="display:block; margin-bottom: 8px; font-size: 14px; color: var(--text-dim);">工作目录 (可选):</label>
                <textarea id="cwd-input" rows="2" placeholder="默认: 当前启动路径" style="width: 100%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; padding: 10px; font-size: 14px; box-sizing: border-box; resize: vertical; font-family: monospace;"></textarea>
            </div>
            <div id="tools-list">
                <p>正在加载工具...</p>
            </div>
        </div>
    </div>

    <script defer src="https://unpkg.com/xterm@5.3.0/lib/xterm.js" onerror="log('XTerm Load Failed')"></script>
    <script defer src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js" onerror="log('FitAddon Load Failed')"></script>
    <script>
        let currentSocket = null, term = null, fitAddon = null, activeSessionId = null;
        const modifiers = { ctrl: false, alt: false };

        function log(msg) {
            const el = document.getElementById('debug-log');
            const entry = document.createElement('div');
            entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            el.appendChild(entry);
            console.log(msg);
        }

        async function fetchWithTimeout(url, options = {}, timeout = 5000) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(id);
                return response;
            } catch (e) {
                clearTimeout(id);
                throw e;
            }
        }

        async function loadSessions() {
            log('Loading sessions...');
            const list = document.getElementById('sessions-list');
            try {
                const res = await fetchWithTimeout('/api/sessions');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const sessions = await res.json();
                log('Sessions loaded: ' + sessions.length);
                if (!sessions || sessions.length === 0) { 
                    list.innerHTML = '<p style="color:#888; text-align:center; margin-top:50px;">暂无活跃会话</p>'; 
                    return; 
                }
                
                let html = '';
                for (let i = 0; i < sessions.length; i++) {
                    const s = sessions[i];
                    html += '<div class="session-card">' +
                        '<div class="session-info">' +
                            '<h3>' + s.name + ' <button class="icon-btn" onclick="renameSession(&quot;' + s.id + '&quot;, &quot;' + s.name + '&quot;, event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></h3>' +
                            '<p>工具: ' + s.tool + ' | ' + new Date(s.startTime).toLocaleTimeString() + '</p>' +
                        '</div>' +
                        '<div class="session-actions">' +
                            '<button class="btn-join" onclick="joinSession(&quot;' + s.id + '&quot;, &quot;' + s.name + '&quot;)">连接</button>' +
                            '<button class="icon-btn btn-delete" onclick="deleteSession(&quot;' + s.id + '&quot;, event)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>' +
                        '</div>' +
                    '</div>';
                }
                list.innerHTML = html;
            } catch (e) { 
                log('Load sessions error: ' + e.message);
                list.innerHTML = '<div style="color:#ff3b30; text-align:center; margin-top:50px;"><p>加载失败: ' + e.message + '</p><button class="btn-retry" onclick="loadSessions()">重试</button></div>';
            }
        }

        async function renameSession(id, oldName, e) {
            e.stopPropagation();
            const newName = prompt('重命名会话', oldName);
            if (newName && newName !== oldName) {
                try {
                    await fetchWithTimeout('/api/sessions/' + id, { 
                        method: 'PATCH', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName }) 
                    });
                    loadSessions();
                } catch (e) { alert('重命名失败'); }
            }
        }

        async function showToolModal() {
            log('Opening tool modal...');
            document.getElementById('modal-overlay').style.display = 'flex';
            const list = document.getElementById('tools-list');
            try {
                const res = await fetchWithTimeout('/api/tools');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const tools = await res.json();
                
                let html = '';
                for (let i = 0; i < tools.length; i++) {
                    const t = tools[i];
                    html += '<div class="tool-item" onclick="createSession(&quot;' + t.key + '&quot;)">' +
                        '<div class="tool-icon">' + t.displayName[0] + '</div>' +
                        '<div>' +
                            '<div style="font-weight:600">' + t.displayName + '</div>' +
                            '<div style="font-size:12px; color:#888">' + (t.version || 'v1.0') + '</div>' +
                        '</div>' +
                    '</div>';
                }
                list.innerHTML = html;
            } catch (e) { 
                log('Load tools error: ' + e.message);
                list.innerHTML = '<p style="color:#ff3b30">工具检测失败: ' + e.message + '</p>';
            }
        }

        function closeToolModal(e) { if (e.target.id === 'modal-overlay') document.getElementById('modal-overlay').style.display = 'none'; }

        async function createSession(toolKey) {
            try {
                const workingDirectory = document.getElementById('cwd-input').value;
                const res = await fetchWithTimeout('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolKey, workingDirectory }) });
                const { id } = await res.json();
                document.getElementById('modal-overlay').style.display = 'none';
                loadSessions();
            } catch (e) { log('Create session failed: ' + e.message); alert('失败'); }
        }

        async function deleteSession(id, e) {
            e.stopPropagation(); if (!confirm('终止？')) return;
            try { await fetchWithTimeout('/api/sessions/' + id, { method: 'DELETE' }); loadSessions(); } catch (e) { alert('失败'); }
        }

        function showLobby() {
            if (currentSocket) { currentSocket.close(); currentSocket = null; }
            document.getElementById('terminal-view').classList.remove('active');
            document.getElementById('lobby-view').classList.add('active');
            loadSessions();
        }

        function joinSession(id, sessionName) {
            activeSessionId = id;
            document.getElementById('session-title').innerText = sessionName;
            document.getElementById('lobby-view').classList.remove('active');
            document.getElementById('terminal-view').classList.add('active');
            initTerminal(id);
        }

        function initTerminal(sessionId) {
            if (typeof Terminal === 'undefined') {
                alert('Terminal 库尚未加载完成，请检查网络连接或稍后再试。');
                showLobby();
                return;
            }
            if (!term) {
                term = new Terminal({ theme: { background: '#000', foreground: '#fff', cursor: '#0f0' }, cursorBlink: true, fontSize: 14, cursorStyle: 'bar', scrollback: 5000 });
                fitAddon = new FitAddon.FitAddon();
                term.loadAddon(fitAddon);
                term.open(document.getElementById('terminal'));
                term.onData(data => {
                    if (data.startsWith('\\x1b[?') || data.startsWith('\\x1b[>')) return;
                    let finalData = data;
                    if (modifiers.ctrl && data.length === 1) {
                        const code = data.toLowerCase().charCodeAt(0);
                        if (code >= 97 && code <= 122) finalData = String.fromCharCode(code - 96);
                    }
                    if (modifiers.alt) finalData = '\\x1b' + finalData;
                    sendWS(finalData);
                });
            } else { term.clear(); }
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            currentSocket = new WebSocket(protocol + '//' + window.location.host + '?sessionId=' + sessionId);
            currentSocket.onopen = () => syncLayout();
            currentSocket.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'output') term.write(msg.data);
                if (msg.type === 'exit') showLobby();
            };
        }

        function sendWS(data) { if (currentSocket && currentSocket.readyState === 1) currentSocket.send(JSON.stringify({ type: 'input', data })); }
        function syncLayout() { 
            if (!fitAddon || !currentSocket) return;
            setTimeout(() => { fitAddon.fit(); if (currentSocket.readyState === 1) currentSocket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }, 50); 
        }

        const inputEl = document.getElementById('cmd-input');
        inputEl.addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px'; syncLayout(); });
        function performSend() {
            const val = inputEl.value;
            if (val) { 
                const formattedVal = val.replace(/\\n/g, '\\r');
                sendWS(formattedVal);
                inputEl.value = ''; 
                inputEl.style.height = '38px'; 
                syncLayout(); 
                
                setTimeout(() => {
                    sendWS('\\r');
                }, 1000);
            }
        }
        document.getElementById('send-btn').addEventListener('click', performSend);
        inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); performSend(); } });

        document.getElementById('shortcut-bar').addEventListener('click', (e) => {
            const btn = e.target.closest('.key-btn'); if (!btn) return;
            const key = btn.dataset.key;
            if (['ctrl', 'alt'].includes(key)) { modifiers[key] = !modifiers[key]; btn.classList.toggle('active', modifiers[key]); return; }
            const sequences = { up: '\\x1b[A', down: '\\x1b[B', enter: '\\r', esc: '\\x1b', tab: '\\t' };
            if (sequences[key]) sendWS(sequences[key]);
        });

        let isScrolling = false, scrollDir = 0, scrollSpeed = 0, rafId = null;
        function smoothScrollLoop() {
            if (!isScrolling) return;
            const viewport = document.querySelector('.xterm-viewport');
            if (viewport) { viewport.scrollTop += (scrollDir * scrollSpeed); scrollSpeed = Math.min(30, scrollSpeed + 0.2); }
            rafId = requestAnimationFrame(smoothScrollLoop);
        }
        function startScroll(dir) { if (isScrolling) return; isScrolling = true; scrollDir = dir; scrollSpeed = 4; smoothScrollLoop(); }
        function stopScroll() { isScrolling = false; if (rafId) cancelAnimationFrame(rafId); }
        document.getElementById('scroll-up').addEventListener('touchstart', (e) => { e.preventDefault(); startScroll(-1); });
        document.getElementById('scroll-down').addEventListener('touchstart', (e) => { e.preventDefault(); startScroll(1); });
        window.addEventListener('touchend', stopScroll);
        window.addEventListener('touchcancel', stopScroll);
        window.addEventListener('resize', syncLayout);
        
        document.addEventListener('DOMContentLoaded', () => {
            log('DOM Content Loaded');
            loadSessions();
        });
    </script>
</body>
</html>`;
}

module.exports = webCommand;
