const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const PTYManager = require('./pty-manager');
const TextHistory = require('./text-history');
const RenderedHistory = require('./rendered-history');
const CircularBuffer = require('./buffer');
const { getToolByKey } = require('../ai-tools/registry');
const ClaudeStructuredSession = require('../claude/structured-session');
const CodexStructuredSession = require('../codex/structured-session');

function previewText(text, maxChars = 320) {
  if (!text) return '';
  const normalized = String(text)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x1b/g, '\\x1b');
  return normalized.length > maxChars ? normalized.slice(-maxChars) : normalized;
}

class SessionManager extends EventEmitter {
  constructor({ baseDir, renderHistoryTools, debugHistoryEnabled = false, logger, hasConnectedSessionClient } = {}) {
    super();
    this.baseDir = baseDir || process.cwd();
    this.renderHistoryTools = renderHistoryTools || new Set();
    this.debugHistoryEnabled = debugHistoryEnabled;
    this.logger = logger || console;
    this.hasConnectedSessionClient = hasConnectedSessionClient || (() => false);
    this.sessions = new Map();
  }

  list() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      name: session.name,
      tool: session.tool.displayName,
      startTime: session.startTime,
      toolKey: session.tool.key,
      workingDirectory: this.getSessionWorkingDirectory(session),
      mode: ['claude-structured', 'codex-structured'].includes(session.kind) ? (session.presentation || 'structured') : 'terminal',
      hasUnreadCompletion: Boolean(session.hasUnreadCompletion),
      timedInputCount: session.timedInputs
        ? Array.from(session.timedInputs.values()).filter(item => item.sendAt > Date.now()).length
        : 0
    }));
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  has(id) {
    return this.sessions.has(id);
  }

  create({ toolKey, workingDirectory, name, claudeOptions }) {
    this.logger.info(`Creating session: toolKey=${toolKey || ''}, workingDirectory=${workingDirectory || '(default)'}`);
    const tool = getToolByKey(toolKey);
    if (!tool) {
      const err = new Error('Invalid tool');
      err.statusCode = 400;
      this.logger.error(`Create session failed: invalid toolKey=${toolKey || ''}`);
      throw err;
    }

    if (tool.key === 'claude-code') {
      return this.createClaudeStructuredSession({ tool, workingDirectory, name, claudeOptions });
    }
    if (tool.key === 'codex') {
      return this.createCodexStructuredSession({ tool, workingDirectory, name });
    }

    const id = uuidv4();
    const buffer = new CircularBuffer(500000);
    const textHistory = new TextHistory({ maxBytes: 20 * 1024 * 1024, debugLabel: id });
    const historyMode = this.getHistoryModeForTool(tool.key);
    const renderedHistory = historyMode === 'rendered'
      ? new RenderedHistory({ maxBytes: 20 * 1024 * 1024, debugLabel: id, cols: 80, rows: 24 })
      : null;

    const sessionDir = workingDirectory && String(workingDirectory).trim()
      ? path.resolve(this.baseDir, String(workingDirectory).trim())
      : this.baseDir;

    if (!fs.existsSync(sessionDir)) {
      const err = new Error(`Directory does not exist: ${sessionDir}`);
      err.statusCode = 400;
      this.logger.error(`Create session failed: missing directory ${sessionDir}`);
      throw err;
    }

    this.logger.info(`Resolved session directory: ${sessionDir}`);

    const ptyManager = new PTYManager(tool, sessionDir, buffer, { silent: true });
    const session = {
      id,
      name: name || tool.displayName,
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
      hasConnectedWebClient: false,
      hasUnreadCompletion: false,
      timedInputs: new Map(),
      write: data => this.write(id, data),
      isRunning: () => this.has(id) && ptyManager.isRunning(),
      kill: () => this.kill(id)
    };

    this.sessions.set(id, session);
    this.logSessionDiagnostics('session-created', session, {}, { compact: true });

    ptyManager.onData((data) => this.handleOutput(session, data));
    ptyManager.onExit(() => this.handleExit(session));

    const started = ptyManager.start([]);
    if (!started) {
      const err = new Error(`Failed to start ${tool.displayName}`);
      err.statusCode = 500;
      this.sessions.delete(id);
      throw err;
    }

    return session;
  }

  createClaudeStructuredSession({ tool, workingDirectory, name, claudeOptions = {} }) {
    const sessionDir = workingDirectory && String(workingDirectory).trim()
      ? path.resolve(this.baseDir, String(workingDirectory).trim())
      : this.baseDir;

    if (!fs.existsSync(sessionDir)) {
      const err = new Error(`Directory does not exist: ${sessionDir}`);
      err.statusCode = 400;
      this.logger.error(`Create Claude session failed: missing directory ${sessionDir}`);
      throw err;
    }

    const id = uuidv4();
    const session = new ClaudeStructuredSession({
      id,
      tool,
      workingDir: sessionDir,
      name: name || tool.displayName,
      logger: this.logger,
      options: claudeOptions
    });

    this.sessions.set(id, session);
    session.on('event', event => this.emit('claude-event', { sessionId: id, event, session }));
    session.on('exit', () => this.handleExit(session));
    this.logSessionDiagnostics('claude-session-created', session, {}, { compact: true });

    return session;
  }

  createCodexStructuredSession({ tool, workingDirectory, name, codexOptions = {} }) {
    const sessionDir = workingDirectory && String(workingDirectory).trim()
      ? path.resolve(this.baseDir, String(workingDirectory).trim())
      : this.baseDir;
    if (!fs.existsSync(sessionDir)) {
      const err = new Error(`Directory does not exist: ${sessionDir}`);
      err.statusCode = 400;
      throw err;
    }
    const id = uuidv4();
    const session = new CodexStructuredSession({ id, tool, workingDir: sessionDir, name: name || tool.displayName, logger: this.logger, options: codexOptions });
    this.sessions.set(id, session);
    session.on('event', event => this.emit('codex-event', { sessionId: id, event, session }));
    session.on('output', data => this.emit('output', { sessionId: id, data, session }));
    session.on('exit', () => this.handleExit(session));
    session.ensureProcess().catch(error => {
      session.append({ kind: 'event', level: 'error', text: `Unable to start Codex app-server: ${error.message}` });
    });
    this.logSessionDiagnostics('codex-session-created', session, {}, { compact: true });
    return session;
  }

  write(id, data) {
    const session = this.get(id);
    if (!session) return false;
    this.markSessionInput(session, data);
    if (['claude-structured', 'codex-structured'].includes(session.kind)) return session.write(data);
    return session.ptyManager.write(data);
  }

  sendClaudeInput(id, text) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return false;
    this.markSessionInput(session, text);
    return session.sendUserMessage(text);
  }

  respondClaudePermission(id, permissionId, approved, action = null) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return false;
    return session.respondPermission(permissionId, approved, action);
  }

  updateClaudeSettings(id, settings) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return null;
    return session.updateSettings(settings || {});
  }

  abortClaude(id) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return false;
    return session.abort('Aborted by user');
  }

  resumeClaude(id, resumeSessionId) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return false;
    const historyMessages = this.readClaudeTranscriptMessages(this.getSessionWorkingDirectory(session), resumeSessionId);
    return session.selectResumeSession(resumeSessionId, historyMessages);
  }

  listClaudeResumeSessions(id) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return null;
    return this.scanClaudeProjectSessions(this.getSessionWorkingDirectory(session));
  }

  getCodexSnapshot(id) {
    const session = this.get(id);
    return session && session.kind === 'codex-structured' ? session.snapshot() : null;
  }

  updateCodexSettings(id, settings) {
    const session = this.get(id);
    if (!session || session.kind !== 'codex-structured') return null;
    return session.updateSettings(settings || {});
  }

  abortCodex(id) {
    const session = this.get(id);
    return session && session.kind === 'codex-structured' ? session.abort('Aborted by user') : false;
  }

  resumeCodex(id, threadId) {
    const session = this.get(id);
    return session && session.kind === 'codex-structured' ? session.resume(threadId) : false;
  }

  listCodexResumeThreads(id) {
    const session = this.get(id);
    if (!session || session.kind !== 'codex-structured') return null;
    return session.listResumeThreads();
  }

  switchCodexPresentation(id, presentation) {
    const session = this.get(id);
    if (!session || session.kind !== 'codex-structured') return Promise.resolve(false);
    return presentation === 'terminal' ? session.switchToTerminal() : session.switchToStructured();
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) return false;
    if (session.kind === 'claude-structured') return true;
    if (session.kind === 'codex-structured') {
      if (session.presentation === 'terminal') session.ptyManager.resize(cols, rows);
      return true;
    }
    if (session.renderedHistory) {
      session.renderedHistory.resize(cols, rows);
    }
    session.ptyManager.resize(cols, rows);
    return true;
  }

  redraw(id, cols, rows) {
    const session = this.get(id);
    if (!session) return false;
    if (['claude-structured', 'codex-structured'].includes(session.kind)) return true;
    if (session.renderedHistory) {
      session.renderedHistory.resize(cols, rows);
    }
    return session.ptyManager.redraw(cols, rows);
  }

  rename(id, name) {
    const session = this.get(id);
    if (!session || !name) return null;
    session.name = name;
    this.logSessionDiagnostics('session-renamed', session, {}, { compact: true });
    return session;
  }

  markCompletionRead(id) {
    const session = this.get(id);
    if (!session) return null;
    if (['claude-structured', 'codex-structured'].includes(session.kind)) {
      session.markCompletionRead();
      this.logSessionDiagnostics('completion-read', session, {}, { compact: true });
      return session;
    }
    session.hasUnreadCompletion = false;
    session.awaitingCompletion = false;
    session.isThinking = false;
    session.completionReadInputSeq = session.inputSeq || 0;
    clearTimeout(session.completionTimer);
    this.logSessionDiagnostics('completion-read', session, {}, { compact: true });
    return session;
  }

  listTimedInputs(id) {
    const session = this.get(id);
    if (!session) return null;
    return Array.from(session.timedInputs.values()).map(item => ({
      id: item.id,
      text: item.text,
      sendAt: item.sendAt,
      createdAt: item.createdAt
    })).sort((a, b) => a.sendAt - b.sendAt);
  }

  scheduleTimedInput(id, input = {}) {
    const session = this.get(id);
    if (!session) return null;

    const { text, sendAt, delay } = this.validateTimedInput(input);

    const item = {
      id: uuidv4(),
      text,
      sendAt,
      createdAt: Date.now(),
      timer: null
    };

    item.timer = setTimeout(() => {
      this.executeTimedInput(session.id, item.id);
    }, delay);
    session.timedInputs.set(item.id, item);
    return {
      id: item.id,
      text: item.text,
      sendAt: item.sendAt,
      createdAt: item.createdAt
    };
  }

  updateTimedInput(id, inputId, input = {}) {
    const session = this.get(id);
    if (!session) return null;
    const item = session.timedInputs.get(inputId);
    if (!item) return false;

    const { text, sendAt, delay } = this.validateTimedInput(input);
    clearTimeout(item.timer);
    item.text = text;
    item.sendAt = sendAt;
    item.updatedAt = Date.now();
    item.timer = setTimeout(() => {
      this.executeTimedInput(session.id, item.id);
    }, delay);

    return {
      id: item.id,
      text: item.text,
      sendAt: item.sendAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  validateTimedInput(input = {}) {
    const text = String(input.text || '');
    const sendAt = Number(input.sendAt);
    if (!text.trim()) {
      const err = new Error('Text is required');
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
      const err = new Error('Send time must be in the future');
      err.statusCode = 400;
      throw err;
    }

    const maxDelay = 30 * 24 * 60 * 60 * 1000;
    const delay = sendAt - Date.now();
    if (delay > maxDelay) {
      const err = new Error('Send time must be within 30 days');
      err.statusCode = 400;
      throw err;
    }

    return { text, sendAt, delay };
  }

  cancelTimedInput(id, inputId) {
    const session = this.get(id);
    if (!session) return null;
    const item = session.timedInputs.get(inputId);
    if (!item) return false;
    clearTimeout(item.timer);
    session.timedInputs.delete(inputId);
    return true;
  }

  executeTimedInput(id, inputId) {
    const session = this.get(id);
    if (!session) return false;
    const item = session.timedInputs.get(inputId);
    if (!item) return false;
    session.timedInputs.delete(inputId);
    const formatted = item.text.replace(/\n/g, '\r');
    this.write(id, formatted);
    setTimeout(() => {
      if (this.has(id)) this.write(id, '\r');
    }, 1000);
    return true;
  }

  kill(id) {
    const session = this.get(id);
    if (!session) return false;
    clearTimeout(session.completionTimer);
    this.clearTimedInputs(session);
    this.logSessionDiagnostics('session-deleted', session, {}, { compact: true });
    this.disposeSessionHistory(session);
    if (['claude-structured', 'codex-structured'].includes(session.kind)) {
      session.ptyManager.kill();
      return true;
    }
    session.ptyManager.kill();
    this.sessions.delete(id);
    this.emit('exit', { sessionId: id, session });
    return true;
  }

  killAll() {
    for (const session of this.sessions.values()) {
      clearTimeout(session.completionTimer);
      this.clearTimedInputs(session);
      this.disposeSessionHistory(session);
      session.ptyManager.kill();
    }
    this.sessions.clear();
  }

  getHistory(id) {
    const session = this.get(id);
    if (!session) return null;
    if (['claude-structured', 'codex-structured'].includes(session.kind)) return session.getHistory();
    const historySource = session.renderedHistory || session.textHistory;
    return {
      success: true,
      sessionId: session.id,
      sessionName: session.name,
      tool: session.tool.displayName,
      historyMode: session.historyMode,
      ...historySource.toJSON()
    };
  }

  getCatchupOutput(id) {
    const session = this.get(id);
    if (!session) return null;
    if (['claude-structured', 'codex-structured'].includes(session.kind)) return session.getCatchupOutput();

    const bufferHistory = session.buffer.getAfter(0);
    if (bufferHistory.length > 0) {
      return {
        source: 'buffer',
        items: bufferHistory.length,
        data: bufferHistory.map(message => message.data).join('')
      };
    }

    const historySource = session.renderedHistory || session.textHistory;
    if (!historySource || typeof historySource.toJSON !== 'function') {
      return { source: 'none', items: 0, data: '' };
    }

    const snapshot = historySource.toJSON();
    const text = String(snapshot.text || '');
    return {
      source: session.renderedHistory ? 'rendered-history' : 'text-history',
      items: snapshot.lines || 0,
      data: text ? text + (text.endsWith('\n') ? '' : '\r\n') : ''
    };
  }

  getDiagnostics(id) {
    const session = this.get(id);
    return session ? this.getSessionDiagnostics(session) : null;
  }

  getClaudeSnapshot(id) {
    const session = this.get(id);
    if (!session || session.kind !== 'claude-structured') return null;
    return session.snapshot();
  }

  scanClaudeProjectSessions(workingDirectory) {
    const projectDir = this.getClaudeProjectDir(workingDirectory);
    if (!projectDir || !fs.existsSync(projectDir)) return [];
    const files = fs.readdirSync(projectDir)
      .filter(file => /^[0-9a-f-]{36}\.jsonl$/i.test(file))
      .map(file => {
        const fullPath = path.join(projectDir, file);
        const stat = fs.statSync(fullPath);
        return {
          id: file.replace(/\.jsonl$/i, ''),
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40);

    return files.map(file => this.describeClaudeSessionFile(file));
  }

  getClaudeProjectDir(workingDirectory) {
    const cwd = path.resolve(workingDirectory || this.baseDir);
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  describeClaudeSessionFile(file) {
    let cwd = '';
    let firstText = '';
    let lastText = '';
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = this.parseClaudeJsonLine(line);
        if (!parsed) continue;
        if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
        const text = this.extractClaudeTranscriptText(parsed);
        if (!text) continue;
        if (!firstText) firstText = text;
        lastText = text;
      }
    } catch (error) {
      this.logger.debugInfo?.(`[claude-resume] Failed to read ${file.path}: ${error.message}`);
    }
    return {
      id: file.id,
      cwd,
      updatedAt: file.mtimeMs,
      size: file.size,
      firstText: firstText ? previewText(firstText, 120) : '',
      lastText: lastText ? previewText(lastText, 160) : ''
    };
  }

  readClaudeTranscriptMessages(workingDirectory, resumeSessionId) {
    const id = String(resumeSessionId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
    const filePath = path.join(this.getClaudeProjectDir(workingDirectory), `${id}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const messages = [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const record = this.parseClaudeJsonLine(line);
        if (!record || record.isSidechain) continue;
        messages.push(...this.mapClaudeTranscriptRecord(record));
      }
    } catch (error) {
      this.logger.debugInfo?.(`[claude-resume] Failed to backfill ${filePath}: ${error.message}`);
      return [];
    }

    const maxMessages = 1000;
    const visible = messages.filter(Boolean).slice(-maxMessages);
    if (messages.length > maxMessages) {
      visible.unshift({
        id: uuidv4(),
        kind: 'event',
        level: 'info',
        text: `Showing the latest ${maxMessages} resumed transcript items.`,
        createdAt: Date.now()
      });
    }
    return visible;
  }

  mapClaudeTranscriptRecord(record) {
    const createdAt = Number.isFinite(Date.parse(record.timestamp)) ? Date.parse(record.timestamp) : Date.now();
    const message = record.message || {};
    const content = message.content;
    if (record.type === 'user') {
      if (typeof content === 'string') {
        const text = content.trim();
        return text ? [{ id: uuidv4(), kind: 'user', text, createdAt }] : [];
      }
      if (Array.isArray(content)) {
        return content.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          if (item.type === 'tool_result') {
            const text = this.textFromClaudeContent(item.content).trim();
            return text ? [{
              id: uuidv4(),
              kind: 'tool-result',
              toolUseId: item.tool_use_id,
              text,
              isError: Boolean(item.is_error),
              createdAt
            }] : [];
          }
          if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
            return [{ id: uuidv4(), kind: 'user', text: item.text.trim(), createdAt }];
          }
          return [];
        });
      }
    }

    if (record.type === 'assistant' && Array.isArray(content)) {
      const mapped = [];
      const text = this.textFromClaudeContent(content).trim();
      if (text) mapped.push({ id: uuidv4(), kind: 'assistant', text, createdAt });
      for (const item of content) {
        if (!item || item.type !== 'tool_use') continue;
        mapped.push({
          id: uuidv4(),
          kind: 'tool',
          name: item.name || 'tool',
          summary: this.summarizeClaudeToolInput(item.input),
          input: item.input,
          toolUseId: item.id,
          createdAt
        });
      }
      return mapped;
    }

    if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.trim()) {
      return [{ id: uuidv4(), kind: 'event', level: 'info', text: `Summary: ${record.summary.trim()}`, createdAt }];
    }

    return [];
  }

  textFromClaudeContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(item => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'tool_result') return this.textFromClaudeContent(item.content);
      return '';
    }).filter(Boolean).join('\n');
  }

  summarizeClaudeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    const serialized = JSON.stringify(input);
    return serialized.length > 240 ? serialized.slice(0, 240) + '...' : serialized;
  }

  parseClaudeJsonLine(line) {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }

  extractClaudeTranscriptText(record) {
    const message = record && record.message;
    const content = message && message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map(item => {
        if (!item || typeof item !== 'object') return '';
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        if (item.type === 'tool_use') return `[tool] ${item.name || 'tool'}`;
        return '';
      }).filter(Boolean).join('\n').trim();
    }
    return '';
  }

  logHistoryRequest(id, req) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('history-request', session, {
      userAgent: req.headers['user-agent'] || '',
      acceptEncoding: req.headers['accept-encoding'] || ''
    }, { compact: true });
  }

  logClientDebug(sessionId, event, payload) {
    const session = sessionId ? this.get(sessionId) : null;
    this.logger.debugInfo(`[client-debug] ${JSON.stringify({
      sessionId: sessionId || null,
      event: event || 'unknown',
      payload: payload || null,
      serverSide: session ? this.getSessionDiagnostics(session) : null
    })}`);
  }

  logWsConnected(id, req) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('ws-connected', session, {
      remoteAddress: req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || ''
    }, { compact: true });
  }

  logWsCatchup(id, history) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('ws-catchup', session, {
      catchupItems: history.length,
      catchupPreview: previewText(history.map(message => message.data).join(''))
    }, { compact: true });
  }

  logWsCatchupOutput(id, catchup) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('ws-catchup', session, {
      catchupSource: catchup.source,
      catchupItems: catchup.items,
      catchupBytes: Buffer.byteLength(String(catchup.data || ''), 'utf8'),
      catchupPreview: previewText(catchup.data)
    }, { compact: true });
  }

  logWsResize(id, cols, rows) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('ws-resize', session, { cols, rows }, { compact: true });
  }

  logWsClosed(id) {
    const session = this.get(id);
    if (!session) return;
    this.logSessionDiagnostics('ws-closed', session, {}, { compact: true });
  }

  getHistoryModeForTool(toolKey) {
    return this.renderHistoryTools.has(String(toolKey || '').toLowerCase()) ? 'rendered' : 'transcript';
  }

  handleOutput(session, data) {
    session.textHistory.write(data);
    if (session.renderedHistory) {
      session.renderedHistory.write(data);
    }
    this.logSessionDiagnostics('pty-output', session, {
      chunkBytes: Buffer.byteLength(String(data), 'utf8'),
      chunkPreview: previewText(data),
      containsClear: /\x1b\[[0-9;?]*J/.test(data),
      containsCursorMove: /\x1b\[[0-9;?]*(?:[ABCDGHf])/.test(data)
    }, { compact: true });

    if (session.awaitingCompletion && !session.isThinking && data.trim().length > 0) session.isThinking = true;
    if (session.awaitingCompletion && session.isThinking) {
      clearTimeout(session.completionTimer);
      const watchedInputSeq = session.inputSeq || 0;
      session.completionTimer = setTimeout(() => {
        const hasUnreadInput = watchedInputSeq > (session.completionReadInputSeq || 0);
        const isCurrentInput = watchedInputSeq === (session.inputSeq || 0);
        if (session.awaitingCompletion && hasUnreadInput && isCurrentInput && !this.hasConnectedSessionClient(session.id)) {
          session.hasUnreadCompletion = true;
        }
        session.awaitingCompletion = false;
        session.isThinking = false;
      }, 10000);
    }

    this.emit('output', { sessionId: session.id, data, session });
  }

  handleExit(session) {
    if (!this.sessions.has(session.id)) return;
    this.logger.info(`Session ${session.id} (${session.name}) exited.`);
    clearTimeout(session.completionTimer);
    this.clearTimedInputs(session);
    this.disposeSessionHistory(session);
    this.sessions.delete(session.id);
    this.emit('exit', { sessionId: session.id, session });
  }

  markSessionInput(session, data) {
    if (typeof data !== 'string' || data.length === 0) return;
    session.inputSeq = (session.inputSeq || 0) + 1;
    if (['claude-structured', 'codex-structured'].includes(session.kind)) {
      session.hasUnreadCompletion = false;
      this.logSessionDiagnostics('session-input', session, {
        inputSeq: session.inputSeq,
        inputPreview: previewText(data)
      }, { compact: true });
      return;
    }
    session.awaitingCompletion = true;
    session.isThinking = false;
    session.hasUnreadCompletion = false;
    clearTimeout(session.completionTimer);
    this.logSessionDiagnostics('session-input', session, {
      inputSeq: session.inputSeq,
      inputPreview: previewText(data)
    }, { compact: true });
  }

  disposeSessionHistory(session) {
    if (['claude-structured', 'codex-structured'].includes(session.kind)) return;
    if (session.renderedHistory) {
      session.renderedHistory.dispose();
      session.renderedHistory = null;
    }
  }

  clearTimedInputs(session) {
    if (!session || !session.timedInputs) return;
    for (const item of session.timedInputs.values()) {
      clearTimeout(item.timer);
    }
    session.timedInputs.clear();
  }

  getSessionDiagnostics(session, extra = {}) {
    if (['claude-structured', 'codex-structured'].includes(session.kind)) {
      return {
        sessionId: session.id,
        sessionName: session.name,
        toolKey: session.tool.key,
        kind: session.kind,
        historyMode: 'structured',
        status: session.status,
        workingDirectory: this.getSessionWorkingDirectory(session),
        messages: session.messages.length,
        pendingPermissions: session.pendingPermissions.size,
        timedInputCount: session.timedInputs ? session.timedInputs.size : 0,
        ...extra
      };
    }
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

  getCompactSessionDiagnostics(session, extra = {}) {
    if (['claude-structured', 'codex-structured'].includes(session.kind)) {
      return this.getSessionDiagnostics(session, extra);
    }
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

  logSessionDiagnostics(reason, session, extra = {}, options = {}) {
    if (!this.debugHistoryEnabled || !session) return;
    const payload = options.compact
      ? this.getCompactSessionDiagnostics(session, extra)
      : this.getSessionDiagnostics(session, extra);
    this.logger.debugInfo(`[history-debug] ${reason} ${JSON.stringify(payload)}`);
  }

  getSessionWorkingDirectory(session) {
    return session.workingDir || (session.ptyManager && session.ptyManager.workingDir) || this.baseDir;
  }
}

module.exports = SessionManager;
