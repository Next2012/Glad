const { EventEmitter } = require('events');
const crypto = require('crypto');

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizePermissionMode(value) {
  const mode = String(value || 'default');
  return PERMISSION_MODES.has(mode) ? mode : 'default';
}

function normalizeModel(value) {
  const model = String(value || 'sonnet').trim().toLowerCase();
  return model || 'sonnet';
}

function normalizeEffort(value) {
  const effort = String(value || 'medium').trim().toLowerCase();
  return EFFORT_LEVELS.has(effort) ? effort : 'medium';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'tool_result') {
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) return textFromContent(item.content);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

class AsyncMessageQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  close() {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift(), done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      }
    };
  }
}

class ClaudeStructuredSession extends EventEmitter {
  constructor({ id, tool, workingDir, name, logger, options = {} }) {
    super();
    this.id = id;
    this.tool = tool;
    this.name = name || tool.displayName;
    this.workingDir = workingDir;
    this.logger = logger || console;
    this.kind = 'claude-structured';
    this.startTime = Date.now();
    this.running = true;
    this.status = 'idle';
    this.messages = [];
    this.pendingPermissions = new Map();
    this.pendingInput = '';
    this.inputSeq = 0;
    this.hasUnreadCompletion = false;
    this.completionReadInputSeq = 0;
    this.timedInputs = new Map();
    this.abortController = null;
    this.inputQueue = null;
    this.query = null;
    this.runnerStarted = false;
    this.abortRequested = false;
    this.permissionMode = normalizePermissionMode(options.permissionMode);
    this.model = normalizeModel(options.model);
    this.effort = normalizeEffort(options.effort);
    this.resumeSessionId = options.resume || null;
    this.claudeSessionId = options.resume || null;
    this.activeOptionSignature = null;
    this.contextRemaining = null;

    // Compatibility with existing session-scoped Git/file APIs.
    this.ptyManager = {
      workingDir,
      isRunning: () => this.isRunning(),
      write: data => this.write(data),
      kill: () => this.kill(),
      resize: () => {},
      redraw: () => false
    };
  }

  toListItem() {
    return {
      id: this.id,
      name: this.name,
      tool: this.tool.displayName,
      startTime: this.startTime,
      toolKey: this.tool.key,
      workingDirectory: this.workingDir,
      hasUnreadCompletion: Boolean(this.hasUnreadCompletion),
      timedInputCount: Array.from(this.timedInputs.values()).filter(item => item.sendAt > Date.now()).length,
      mode: 'structured'
    };
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      tool: this.tool.displayName,
      toolKey: this.tool.key,
      status: this.status,
      state: this.getControlState(),
      messages: this.messages,
      pendingPermissions: Array.from(this.pendingPermissions.values()).map(item => item.public)
    };
  }

  getControlState() {
    return {
      permissionMode: this.permissionMode,
      model: this.model,
      effort: this.effort,
      status: this.status,
      claudeSessionId: this.claudeSessionId || null,
      resumeSessionId: this.resumeSessionId || null,
      contextRemaining: this.contextRemaining,
      canAbort: this.status === 'thinking',
      pendingPermissionCount: this.pendingPermissions.size
    };
  }

  getHistory() {
    const lines = [];
    for (const message of this.messages) {
      if (message.kind === 'user') lines.push(`User: ${message.text}`);
      if (message.kind === 'assistant') lines.push(`Claude: ${message.text}`);
      if (message.kind === 'tool') lines.push(`Tool ${message.name}: ${message.summary}`);
      if (message.kind === 'event') lines.push(message.text);
    }
    const text = lines.join('\n\n');
    return {
      success: true,
      sessionId: this.id,
      sessionName: this.name,
      tool: this.tool.displayName,
      historyMode: 'structured',
      text,
      updatedAt: Date.now(),
      truncated: false,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text ? text.split('\n').length : 0
    };
  }

  getCatchupOutput() {
    return {
      source: 'claude-structured',
      items: this.messages.length,
      data: ''
    };
  }

  write(data) {
    if (!this.running) return false;
    const text = String(data || '');
    if (!text) return true;

    this.pendingInput += text.replace(/\r/g, '\n');
    if (!this.pendingInput.includes('\n')) return true;

    const parts = this.pendingInput.split('\n');
    this.pendingInput = parts.pop() || '';
    const prompt = parts.join('\n').trim();
    if (prompt) this.sendUserMessage(prompt);
    return true;
  }

  sendUserMessage(text) {
    if (!this.running) return false;
    const prompt = String(text || '').trim();
    if (!prompt) return false;
    this.hasUnreadCompletion = false;
    this.appendMessage({ kind: 'user', text: prompt });

    const sdkMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: prompt
      }
    };

    if (!this.runnerStarted) {
      this.startRunner(sdkMessage);
    } else if (this.inputQueue) {
      this.inputQueue.push(sdkMessage);
    }
    return true;
  }

  createMessageItem(message) {
    return {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...message
    };
  }

  updateSettings(settings = {}) {
    const next = {
      permissionMode: settings.permissionMode === undefined ? this.permissionMode : normalizePermissionMode(settings.permissionMode),
      model: settings.model === undefined ? this.model : normalizeModel(settings.model),
      effort: settings.effort === undefined ? this.effort : normalizeEffort(settings.effort)
    };
    const changed = next.permissionMode !== this.permissionMode
      || next.model !== this.model
      || next.effort !== this.effort;
    this.permissionMode = next.permissionMode;
    this.model = next.model;
    this.effort = next.effort;

    if (changed) {
      if (this.query && typeof this.query.setPermissionMode === 'function') {
        Promise.resolve(this.query.setPermissionMode(this.permissionMode)).catch(error => {
          this.logger.debugInfo?.(`[claude-structured] setPermissionMode failed: ${error.message}`);
        });
      }
      if (this.runnerStarted && this.status === 'idle' && this.activeOptionSignature !== this.getOptionSignature()) {
        this.resetRunnerForNextTurn();
      }
      this.emitEvent({ type: 'state', state: this.getControlState() });
    }
    return this.getControlState();
  }

  selectResumeSession(resumeSessionId, historyMessages = null) {
    const id = String(resumeSessionId || '').trim();
    if (!id) return false;
    if (this.status === 'thinking') this.abort('Switching resume target');
    this.resumeSessionId = id;
    this.claudeSessionId = id;
    this.resetRunnerForNextTurn();
    const eventMessage = this.createMessageItem({
      kind: 'event',
      level: 'info',
      text: `Resume target selected: ${id}`
    });
    if (Array.isArray(historyMessages)) {
      this.messages = [...historyMessages, eventMessage];
      this.emitEvent({ type: 'history-reset', messages: this.messages });
    } else {
      this.messages.push(eventMessage);
      this.emitEvent({ type: 'message', message: eventMessage });
    }
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return true;
  }

  abort(reason = 'Aborted by user') {
    if (!this.runnerStarted && this.status !== 'thinking') return false;
    this.abortRequested = true;
    this.inputQueue?.close();
    this.query?.close?.();
    this.abortController?.abort();
    this.runnerStarted = false;
    this.inputQueue = null;
    this.query = null;
    this.abortController = null;
    this.setStatus('idle');
    this.appendMessage({ kind: 'event', level: 'info', text: reason });
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return true;
  }

  resetRunnerForNextTurn() {
    this.inputQueue?.close();
    this.query?.close?.();
    this.runnerStarted = false;
    this.inputQueue = null;
    this.query = null;
    this.abortController = null;
  }

  respondPermission(id, approved) {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    this.pendingPermissions.delete(id);
    const publicRequest = { ...pending.public, status: approved ? 'approved' : 'denied' };
    this.emitEvent({ type: 'permission-updated', request: publicRequest });
    pending.resolve(approved
      ? { behavior: 'allow', toolUseID: pending.toolUseID, decisionClassification: 'user_temporary' }
      : { behavior: 'deny', message: 'Denied by user', interrupt: true, toolUseID: pending.toolUseID, decisionClassification: 'user_reject' });
    return true;
  }

  markCompletionRead() {
    this.hasUnreadCompletion = false;
    this.completionReadInputSeq = this.inputSeq || 0;
  }

  async startRunner(initialMessage) {
    this.runnerStarted = true;
    this.inputQueue = new AsyncMessageQueue();
    this.inputQueue.push(initialMessage);
    this.abortController = new AbortController();
    this.abortRequested = false;
    this.activeOptionSignature = this.getOptionSignature();
    this.setStatus('thinking');

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      this.query = sdk.query({
        prompt: this.inputQueue,
        options: {
          cwd: this.workingDir,
          resume: this.resumeSessionId || undefined,
          permissionMode: this.permissionMode,
          model: this.model,
          effort: this.effort,
          tools: { type: 'preset', preset: 'claude_code' },
          env: {
            ...process.env,
            CLAUDE_AGENT_SDK_CLIENT_APP: 'glad-web'
          },
          abortController: this.abortController,
          canUseTool: (toolName, input, options) => this.requestPermission(toolName, input, options)
        }
      });

      for await (const message of this.query) {
        this.handleSdkMessage(message);
      }
      this.setStatus('idle');
    } catch (error) {
      if (!this.running) return;
      if (this.abortRequested) {
        this.setStatus('idle');
        return;
      }
      this.appendMessage({
        kind: 'event',
        level: 'error',
        text: `Claude session error: ${error && error.message ? error.message : String(error)}`
      });
      this.setStatus('error');
    }
  }

  getOptionSignature() {
    return JSON.stringify({
      permissionMode: this.permissionMode,
      model: this.model,
      effort: this.effort,
      resume: this.resumeSessionId || null
    });
  }

  requestPermission(toolName, input, options = {}) {
    const id = crypto.randomUUID();
    const request = {
      id,
      toolName,
      title: options.title || `${toolName} requires approval`,
      reason: options.decisionReason || '',
      input,
      createdAt: Date.now(),
      status: 'pending'
    };
    this.emitEvent({ type: 'permission-request', request });
    return new Promise(resolve => {
      this.pendingPermissions.set(id, {
        public: request,
        resolve,
        toolUseID: options.toolUseID
      });
    });
  }

  handleSdkMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'system' && message.subtype === 'init') {
      this.claudeSessionId = message.session_id || this.claudeSessionId;
      this.resumeSessionId = this.claudeSessionId || this.resumeSessionId;
      if (message.model) this.model = String(message.model);
      this.appendMessage({
        kind: 'event',
        level: 'info',
        text: `Claude ready${message.model ? ` (${message.model})` : ''}`
      });
      this.emitEvent({ type: 'state', state: this.getControlState() });
      return;
    }

    if (message.type === 'assistant') {
      const content = message.message && message.message.content;
      const text = textFromContent(content).trim();
      const toolBlocks = Array.isArray(content)
        ? content.filter(item => item && item.type === 'tool_use')
        : [];
      if (text) {
        this.appendMessage({ kind: 'assistant', text, raw: message });
      }
      for (const block of toolBlocks) {
        this.appendMessage({
          kind: 'tool',
          name: block.name || 'tool',
          summary: this.summarizeToolInput(block.input),
          input: block.input,
          toolUseId: block.id
        });
      }
      this.setStatus('thinking');
      return;
    }

    if (message.type === 'user') {
      const content = message.message && message.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.type === 'tool_result') {
            this.appendMessage({
              kind: 'tool-result',
              toolUseId: item.tool_use_id,
              text: textFromContent([item]).trim(),
              isError: Boolean(item.is_error)
            });
          }
        }
      }
      return;
    }

    if (message.type === 'result') {
      this.updateUsageFromResult(message);
      this.setStatus('idle');
      if (this.inputSeq > this.completionReadInputSeq) {
        this.hasUnreadCompletion = true;
      }
      this.emit('complete');
      if (this.activeOptionSignature !== this.getOptionSignature()) {
        this.resetRunnerForNextTurn();
      }
    }
  }

  updateUsageFromResult(message) {
    const usage = message && (message.usage || message.total_usage || message.result && message.result.usage);
    const context = usage && (usage.context_remaining || usage.contextRemaining || usage.remaining_context || usage.remainingContext);
    this.contextRemaining = typeof context === 'number' ? context : null;
  }

  summarizeToolInput(input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    const serialized = JSON.stringify(input);
    return serialized.length > 240 ? serialized.slice(0, 240) + '...' : serialized;
  }

  appendMessage(message) {
    const item = this.createMessageItem(message);
    this.messages.push(item);
    this.emitEvent({ type: 'message', message: item });
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emitEvent({ type: 'status', status });
    this.emitEvent({ type: 'state', state: this.getControlState() });
  }

  emitEvent(event) {
    this.emit('event', event);
  }

  isRunning() {
    return this.running;
  }

  kill() {
    this.running = false;
    this.inputQueue?.close();
    this.query?.close?.();
    this.abortController?.abort();
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ behavior: 'deny', message: 'Session ended', interrupt: true, toolUseID: pending.toolUseID });
    }
    this.pendingPermissions.clear();
    this.setStatus('stopped');
    this.emit('exit', { exitCode: 0 });
  }
}

module.exports = ClaudeStructuredSession;
