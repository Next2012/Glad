const pty = require('node-pty');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { RESTORE_RESIZE_DELAY } = require('../config/constants');

class PTYManager {
  constructor(tool, workingDir, buffer, options = {}) {
    this.tool = tool;
    this.workingDir = workingDir;
    this.buffer = buffer;
    this.silent = options.silent || false;
    this.ptyProcess = null;
    this.onDataCallback = null;
    this.onExitCallback = null;
    this.mobileConnected = false;
    this.localResizeListener = null;
    this.outputPaused = false; 

    this.tuiTools = ['opencode', 'kilo'];
    this.isTUIMode = this.tuiTools.includes(tool.key);

    this.recentOutputs = []; 
    this.duplicateThresholdMs = 150; 
    this.maxRecentOutputs = 10; 
  }

  // Start PTY process
  start(additionalArgs = []) {
    const isWindows = os.platform() === 'win32';
    const args = [...this.tool.args, ...additionalArgs];

    logger.info(`Starting ${this.tool.displayName}...`);
    
    try {
      if (!this.silent) {
        process.stdout.write('\x1b[?2004l');
      }

      let spawnCommand = this.tool.command;
      let spawnArgs = args;

      if (isWindows) {
        spawnCommand = 'cmd.exe';
        spawnArgs = ['/c', this.tool.command, ...args];
      } else {
        spawnCommand = 'bash';
        const escaped = [this.tool.command, ...args]
          .map(a => `'${String(a).replace(/'/g, "'\\''")}'`)
          .join(' ');
        spawnArgs = ['-i', '-c', escaped];
      }

      let spawnEnv = process.env;
      if (isWindows) {
        const path = require('path');
        const npmGlobalBin = path.join(process.env.APPDATA || '', 'npm');
        const currentPath = process.env.PATH || '';

        spawnEnv = {
          ...process.env,
          PATH: `${npmGlobalBin};${currentPath}`
        };
      }

      this.ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
        name: 'xterm-256color',
        cols: this.silent ? 80 : (process.stdout.columns || 80),
        rows: this.silent ? 24 : (process.stdout.rows || 24),
        cwd: this.workingDir,
        env: spawnEnv
      });

      logger.success(`${this.tool.displayName} started (PID: ${this.ptyProcess.pid})`);

      this.ptyProcess.onData((data) => {
        this.handlePTYOutput(data);
      });

      this.ptyProcess.onExit((exitCode) => {
        this.handlePTYExit(exitCode);
      });

      if (!this.silent && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.setEncoding('utf8');
        process.stdin.resume(); 

        process.stdin.on('data', (data) => {
          const filtered = data.toString()
            .replace(/\x1b\[I/g, '') 
            .replace(/\x1b\[O/g, ''); 

          if (filtered.length > 0) {
            this.ptyProcess.write(filtered);
          }

          if (data === '\u0003') { 
            this.kill();
            process.exit(0);
          }
        });
      }

      if (!this.silent) {
        this.setupLocalResizeListener();
      }

      return true;
    } catch (err) {
      logger.error(`Failed to start ${this.tool.displayName}: ${err.message}`);
      return false;
    }
  }

  // Handle PTY output
  handlePTYOutput(data) {
    let filtered = data
      .replace(/\x1b\[I/g, '') 
      .replace(/\x1b\[O/g, ''); 

    if (filtered.length > 0) {
      if (os.platform() === 'win32') {
        const now = Date.now();
        const hash = crypto.createHash('sha256').update(filtered).digest('hex');
        this.recentOutputs = this.recentOutputs.filter(entry => now - entry.timestamp < this.duplicateThresholdMs);
        const duplicate = this.recentOutputs.find(entry => entry.hash === hash);
        if (duplicate) return;
        this.recentOutputs.push({ hash, timestamp: now });
        if (this.recentOutputs.length > this.maxRecentOutputs) this.recentOutputs.shift();
      }

      if (!this.silent && !this.outputPaused) {
        process.stdout.write(filtered);
      }

      let forMobile = filtered;
      if (os.platform() === 'win32' && forMobile.startsWith('\x1b[H\x1b[K')) {
        forMobile = '\x1b[2J\x1b[3J\x1b[H' + forMobile.slice(6);
      }

      if (!this.isTUIMode) {
        this.buffer.append(forMobile);
      }

      if (this.onDataCallback) {
        this.onDataCallback(forMobile);
      }
    }
  }

  handlePTYExit(exitCode) {
    logger.info(`${this.tool.displayName} exited with code ${exitCode.exitCode}`);
    if (this.onExitCallback) {
      this.onExitCallback(exitCode);
    }
  }

  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  resize(cols, rows) {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  restoreLocalSize() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    this.resize(cols, rows);
  }

  setupLocalResizeListener() {
    if (!process.stdout.isTTY) return;
    this.localResizeListener = () => {
      if (!this.mobileConnected) {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        this.resize(cols, rows);
      }
    };
    process.stdout.on('resize', this.localResizeListener);
  }

  setMobileConnected(connected) {
    this.mobileConnected = connected;
  }

  onData(callback) {
    this.onDataCallback = callback;
  }

  onExit(callback) {
    this.onExitCallback = callback;
  }

  kill() {
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
    if (this.localResizeListener && process.stdout.off) {
      process.stdout.off('resize', this.localResizeListener);
      this.localResizeListener = null;
    }
    if (!this.silent && process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }

  isRunning() {
    return this.ptyProcess !== null;
  }

  getPid() {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  pauseOutput() {
    this.outputPaused = true;
  }

  resumeOutput() {
    this.outputPaused = false;
  }

  isTUI() {
    return this.isTUIMode;
  }
}

module.exports = PTYManager;
