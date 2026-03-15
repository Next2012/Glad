const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const PTYManager = require('../session/pty-manager');
const CircularBuffer = require('../session/buffer');
const { selectAITool } = require('../ai-tools/selector');
const logger = require('../utils/logger');

async function webCommand(options) {
  const port = parseInt(options.port) || 3000;
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const workingDir = process.cwd();
  
  const selectedTool = await selectAITool(options);
  if (!selectedTool) process.exit(1);

  const buffer = new CircularBuffer(200000); 
  const ptyManager = new PTYManager(selectedTool, workingDir, buffer);

  app.get('/', (req, res) => res.send(getHTML(selectedTool.displayName)));
  app.get('/manifest.json', (req, res) => res.json({ name: "Termly Web", short_name: "Termly", start_url: "/", display: "standalone" }));

  wss.on('connection', (ws) => {
    const history = buffer.getAfter(0);
    if (history.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: history.map(m => m.data).join('') }));
    }
    ws.on('message', (message) => {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'input') ptyManager.write(payload.data);
        if (payload.type === 'resize') ptyManager.resize(payload.cols, payload.rows);
      } catch (e) {}
    });
  });

  let isThinking = false;
  let completionTimer = null;
  ptyManager.onData((data) => {
    if (!isThinking && data.trim().length > 0) isThinking = true;
    if (isThinking) {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        wss.clients.forEach(c => {
          if (c.readyState === 1) c.send(JSON.stringify({ type: 'notification', title: '执行完成', body: `${selectedTool.displayName} 已就绪` }));
        });
        isThinking = false;
      }, 2500);
    }
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'output', data })); });
  });

  ptyManager.start(options.aiArgs ? options.aiArgs.split(' ') : []);
  server.listen(port, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let networkInfo = '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          networkInfo += `\n   ➜  内网/PWA: http://${iface.address}:${port}`;
        }
      }
    }
    console.log(chalk.green(`\n🚀 Web 服务已启动!\n本地访问: http://localhost:${port}${networkInfo}\n`));
  });

  process.on('SIGINT', () => { ptyManager.kill(); process.exit(0); });
}

function getHTML(toolName) {
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${toolName} - Termly</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
    <style>
        body, html { margin: 0; padding: 0; height: 100dvh; width: 100vw; background: #000; overflow: hidden; display: flex; flex-direction: column; overscroll-behavior: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        
        #top-ui { flex-shrink: 0; background: #121212; border-bottom: 1px solid #222; z-index: 2000; padding-top: env(safe-area-inset-top); }

        #input-row { display: flex; align-items: flex-end; padding: 10px 14px; }
        
        #cmd-input {
            flex: 1; min-height: 38px; max-height: 100px;
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 19px;
            color: #fff; padding: 9px 16px; font-size: 16px;
            outline: none; resize: none; overflow-y: auto; line-height: 20px;
            box-sizing: border-box; transition: border-color 0.2s;
        }
        #cmd-input:focus { border-color: rgba(0, 122, 255, 0.5); background: rgba(255,255,255,0.12); }

        #send-btn {
            width: 44px; height: 38px; margin-left: 10px;
            background: #007aff; border: none; border-radius: 19px; color: #fff;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
            transition: all 0.1s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #send-btn:active { transform: scale(0.88); background: #005bbd; }

        #shortcut-bar { display: flex; padding: 2px 12px 12px 12px; gap: 8px; justify-content: space-between; }
        
        .key-btn {
            flex: 1; display: inline-flex; align-items: center; justify-content: center;
            height: 38px; background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
            color: #ccc; font-size: 11px; font-weight: 700;
            transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
            user-select: none; -webkit-user-tap-highlight-color: transparent;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        
        .key-btn:active {
            background: rgba(255,255,255,0.2);
            transform: scale(0.92);
            color: #fff;
        }
        
        .key-btn.active {
            background: rgba(0, 122, 255, 0.25);
            border-color: #007aff;
            color: #00a2ff;
            box-shadow: 0 0 15px rgba(0, 122, 255, 0.3);
        }

        .key-btn.special-key { font-size: 18px; }

        #terminal-container { flex: 1; min-height: 0; width: 100%; background: #000; position: relative; overflow: hidden; }
        #terminal { height: 100%; width: 100%; }
        .xterm-viewport { overflow-y: auto !important; -webkit-overflow-scrolling: touch; }
        .xterm-viewport::-webkit-scrollbar { width: 0; height: 0; display: none; }
        
        #scroll-controls { position: fixed; right: 14px; top: 60%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 18px; z-index: 3000; }
        .scroll-btn {
            width: 56px; height: 56px; background: rgba(30, 30, 30, 0.5);
            backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
            border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px;
            color: #fff; display: flex; align-items: center; justify-content: center;
            font-size: 20px; user-select: none; -webkit-user-tap-highlight-color: transparent;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4); transition: all 0.2s;
        }
        .scroll-btn:active { background: rgba(0, 122, 255, 0.4); transform: scale(0.9); }
    </style>
</head>
<body>
    <div id="top-ui">
        <div id="input-row">
            <textarea id="cmd-input" rows="1" placeholder="Type a command..."></textarea>
            <button id="send-btn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
        </div>
        <div id="shortcut-bar">
            <div class="key-btn special-key" data-key="up">↑</div>
            <div class="key-btn special-key" data-key="down">↓</div>
            <div class="key-btn" data-key="ctrl">Ctrl</div>
            <div class="key-btn special-key" data-key="enter">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10l-5 5 5 5"></path><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg>
            </div>
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
    
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script>
        const term = new Terminal({ theme: { background: '#000', foreground: '#fff', cursor: '#0f0' }, cursorBlink: true, fontSize: 14, cursorStyle: 'bar', scrollback: 5000 });
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('terminal'));
        const socket = new WebSocket('ws://' + window.location.host);
        const inputEl = document.getElementById('cmd-input');
        const sendBtn = document.getElementById('send-btn');
        const modifiers = { ctrl: false, alt: false };

        function syncLayout() { setTimeout(() => { fitAddon.fit(); socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }, 50); }
        inputEl.addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px'; syncLayout(); });

        function send(data) { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'input', data })); }
        function performSend() {
            const val = inputEl.value;
            if (val) {
                send(val + '\\r');
                inputEl.value = ''; inputEl.style.height = '38px'; syncLayout();
                if (navigator.vibrate) navigator.vibrate(40);
            }
        }

        sendBtn.addEventListener('click', performSend);
        inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); performSend(); } });

        document.getElementById('shortcut-bar').addEventListener('click', (e) => {
            const btn = e.target.closest('.key-btn');
            if (!btn) return;
            const key = btn.dataset.key;
            if (navigator.vibrate) navigator.vibrate(30);
            if (['ctrl', 'alt'].includes(key)) { modifiers[key] = !modifiers[key]; btn.classList.toggle('active', modifiers[key]); return; }
            const sequences = { up: '\\x1b[A', down: '\\x1b[B', enter: '\\r', esc: '\\x1b', tab: '\\t' };
            if (sequences[key]) send(sequences[key]);
        });

        term.onData(data => {
            let finalData = data;
            if (modifiers.ctrl && data.length === 1) {
                const code = data.toLowerCase().charCodeAt(0);
                if (code >= 97 && code <= 122) finalData = String.fromCharCode(code - 96);
            }
            if (modifiers.alt) finalData = '\\x1b' + finalData;
            send(finalData);
        });

        let isScrolling = false, scrollDir = 0, scrollSpeed = 0, rafId = null;
        function smoothScrollLoop() {
            if (!isScrolling) return;
            const viewport = document.querySelector('.xterm-viewport');
            if (viewport) { viewport.scrollTop += (scrollDir * scrollSpeed); scrollSpeed = Math.min(30, scrollSpeed + 0.2); }
            rafId = requestAnimationFrame(smoothScrollLoop);
        }
        function startScroll(dir) { if (isScrolling) return; isScrolling = true; scrollDir = dir; scrollSpeed = 4; if (navigator.vibrate) navigator.vibrate(20); smoothScrollLoop(); }
        function stopScroll() { isScrolling = false; if (rafId) cancelAnimationFrame(rafId); }
        document.getElementById('scroll-up').addEventListener('touchstart', (e) => { e.preventDefault(); startScroll(-1); });
        document.getElementById('scroll-down').addEventListener('touchstart', (e) => { e.preventDefault(); startScroll(1); });
        window.addEventListener('touchend', stopScroll);
        window.addEventListener('touchcancel', stopScroll);

        document.addEventListener('touchmove', (e) => {
            if (!e.target.closest('.xterm-viewport') && !e.target.closest('#cmd-input')) e.preventDefault();
        }, { passive: false });

        socket.onopen = () => syncLayout();
        socket.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.type === 'output') term.write(msg.data); };
        document.getElementById('terminal-container').addEventListener('click', () => term.focus());
        window.addEventListener('resize', syncLayout);
        syncLayout();
    </script>
</body>
</html>`;
}

module.exports = webCommand;
