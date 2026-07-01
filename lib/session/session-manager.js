const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const PTYManager = require('./pty-manager');
const TextHistory = require('./text-history');
const RenderedHistory = require('./rendered-history');
const CircularBuffer = require('./buffer');
const { getToolByKey } = require('../ai-tools/registry');

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
      workingDirectory: session.ptyManager.workingDir,
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

  create({ toolKey, workingDirectory, name }) {
    this.logger.info(`Creating session: toolKey=${toolKey || ''}, workingDirectory=${workingDirectory || '(default)'}`);
    const tool = getToolByKey(toolKey);
    if (!tool) {
      const err = new Error('Invalid tool');
      err.statusCode = 400;
      this.logger.error(`Create session failed: invalid toolKey=${toolKey || ''}`);
      throw err;
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

  write(id, data) {
    const session = this.get(id);
    if (!session) return false;
    this.markSessionInput(session, data);
    return session.ptyManager.write(data);
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session) return false;
    if (session.renderedHistory) {
      session.renderedHistory.resize(cols, rows);
    }
    session.ptyManager.resize(cols, rows);
    return true;
  }

  redraw(id, cols, rows) {
    const session = this.get(id);
    if (!session) return false;
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
}

module.exports = SessionManager;
