const { EventEmitter } = require('events');
const crypto = require('crypto');
const { normalizeEffort, normalizeModel, resolveClaudeModel } = require('./config');
const { parseClaudeContextOutput, parseClaudeUsageOutput } = require('./cli-usage');

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const EXIT_PLAN_TOOLS = new Set(['exit_plan_mode', 'ExitPlanMode']);
const DENY_PERMISSION_MESSAGE = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const LOCAL_COMMAND_TIMEOUT_MS = 30_000;

function normalizePermissionMode(value) {
  const mode = String(value || 'default');
  return PERMISSION_MODES.has(mode) ? mode : 'default';
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
  constructor({
    id,
    tool,
    workingDir,
    name,
    logger,
    options = {},
    localCommandRunner = null
  }) {
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
    this.runnerReadyPromise = null;
    this.runnerInitializationAnnounced = false;
    this.abortRequested = false;
    this.localCommandRunner = localCommandRunner;
    this.localCommandChain = Promise.resolve();
    this.pendingLocalCommand = null;
    this.permissionMode = normalizePermissionMode(options.permissionMode);
    this.model = normalizeModel(options.model);
    this.effort = normalizeEffort(options.effort);
    this.allowedTools = new Set();
    this.allowedBashLiterals = new Set();
    this.allowedBashPrefixes = new Set();
    this.resumeSessionId = options.resume || null;
    this.claudeSessionId = options.resume || null;
    this.activeOptionSignature = null;
    this.turnQueue = [];

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

  sendUserMessage(text, attachments = []) {
    if (!this.running) return false;
    const prompt = String(text || '').trim();
    const images = Array.isArray(attachments) ? attachments.filter(item => item?.data && item?.mediaType) : [];
    if (!prompt && images.length === 0) return false;
    this.hasUnreadCompletion = false;
    const turn = this.beginTurn(prompt, images.map(item => ({ name: item.name, size: item.size })));
    this.setStatus('thinking');

    const content = images.length > 0 ? [
      ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ...images.map(item => ({
        type: 'image',
        source: { type: 'base64', media_type: item.mediaType, data: item.data }
      }))
    ] : prompt;

    const sdkMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content
      }
    };

    if (!this.runnerStarted) {
      this.startRunner(sdkMessage);
    } else if (this.inputQueue) {
      this.inputQueue.push(sdkMessage);
    }
    return true;
  }

  beginTurn(prompt, attachments = []) {
    const turn = { id: crypto.randomUUID(), startedAt: Date.now() };
    this.turnQueue.push(turn);
    this.appendMessage({ kind: 'turn-start', turnId: turn.id, createdAt: turn.startedAt });
    this.appendMessage({ kind: 'user', text: prompt, attachments, turnId: turn.id, createdAt: turn.startedAt });
    return turn;
  }

  currentTurn() {
    return this.turnQueue[0] || null;
  }

  completeCurrentTurn(status = 'completed', reportedDurationMs = null) {
    const turn = this.turnQueue.shift();
    if (!turn) return null;
    const completedAt = Date.now();
    return this.appendMessage({
      kind: 'turn-end',
      turnId: turn.id,
      turnStatus: status,
      durationMs: Number.isFinite(Number(reportedDurationMs))
        ? Math.max(0, Number(reportedDurationMs))
        : Math.max(0, completedAt - turn.startedAt),
      createdAt: completedAt
    });
  }

  sealTurns(status = 'cancelled') {
    while (this.turnQueue.length > 0) this.completeCurrentTurn(status);
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
        Promise.resolve(this.query.setPermissionMode(this.getSdkPermissionMode())).catch(error => {
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
    this.rejectPendingLocalCommand(new Error(reason));
    this.runnerStarted = false;
    this.runnerReadyPromise = null;
    this.runnerInitializationAnnounced = false;
    this.inputQueue = null;
    this.query = null;
    this.abortController = null;
    this.sealTurns('cancelled');
    this.setStatus('idle');
    this.appendMessage({ kind: 'event', level: 'info', text: reason });
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return true;
  }

  resetRunnerForNextTurn() {
    this.inputQueue?.close();
    this.query?.close?.();
    this.rejectPendingLocalCommand(new Error('Claude CLI session was reset'));
    this.runnerStarted = false;
    this.runnerReadyPromise = null;
    this.runnerInitializationAnnounced = false;
    this.inputQueue = null;
    this.query = null;
    this.abortController = null;
    this.turnQueue = [];
  }

  finishRunner() {
    this.rejectPendingLocalCommand(new Error('Claude CLI session ended before returning the command output'));
    this.runnerStarted = false;
    this.runnerReadyPromise = null;
    this.runnerInitializationAnnounced = false;
    this.inputQueue?.close();
    this.inputQueue = null;
    this.query = null;
    this.abortController = null;
  }

  respondPermission(id, approved, action = null) {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    this.pendingPermissions.delete(id);
    const normalizedAction = this.normalizePermissionAction(action, approved);
    const allowedTools = this.getAllowedToolsForAction(normalizedAction, pending);
    const nextMode = this.getPermissionModeForAction(normalizedAction);
    if (allowedTools.length > 0) this.addAllowedTools(allowedTools);
    if (nextMode) {
      this.permissionMode = nextMode;
      if (this.query && typeof this.query.setPermissionMode === 'function') {
        Promise.resolve(this.query.setPermissionMode(this.getSdkPermissionMode())).catch(error => {
          this.logger.debugInfo?.(`[claude-structured] setPermissionMode failed: ${error.message}`);
        });
      }
    }
    const publicRequest = {
      ...pending.public,
      status: approved ? 'approved' : 'denied',
      action: normalizedAction,
      mode: nextMode || undefined,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined
    };
    this.emitEvent({ type: 'permission-updated', request: publicRequest });
    pending.resolve(approved
      ? {
          behavior: 'allow',
          updatedInput: pending.input || {},
          updatedPermissions: this.getPermissionUpdatesForAction(normalizedAction, pending),
          toolUseID: pending.toolUseID,
          decisionClassification: normalizedAction === 'allow-once' ? 'user_temporary' : 'user_permanent'
        }
      : { behavior: 'deny', message: DENY_PERMISSION_MESSAGE, interrupt: true, toolUseID: pending.toolUseID, decisionClassification: 'user_reject' });
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return true;
  }

  normalizePermissionAction(action, approved) {
    if (!approved) return 'deny';
    const value = String(action || '').trim();
    if (['allow-once', 'allow-tool', 'allow-edits', 'bypass'].includes(value)) return value;
    return 'allow-once';
  }

  getPermissionModeForAction(action) {
    if (action === 'allow-edits') return 'acceptEdits';
    if (action === 'bypass') return 'bypassPermissions';
    return null;
  }

  getSdkPermissionMode() {
    // Claude CLI refuses --dangerously-skip-permissions under root/sudo. Glad
    // keeps bypass as local state and auto-allows through canUseTool instead.
    if (this.permissionMode === 'bypassPermissions') return 'default';
    return this.permissionMode;
  }

  getAllowedToolsForAction(action, pending) {
    if (action !== 'allow-tool') return [];
    const toolName = pending.toolName || pending.public.toolName;
    if (!toolName) return [];
    if (toolName === 'Bash') {
      const command = pending.input && typeof pending.input.command === 'string'
        ? pending.input.command
        : '';
      return command ? [`Bash(${command})`] : ['Bash'];
    }
    return [toolName];
  }

  getPermissionUpdatesForAction(action, pending) {
    const mode = this.getPermissionModeForAction(action);
    const allowedTools = this.getAllowedToolsForAction(action, pending);
    const updates = [];
    if (allowedTools.length > 0) {
      updates.push({
        type: 'addRules',
        rules: allowedTools.map(tool => this.permissionRuleFromTool(tool)),
        behavior: 'allow',
        destination: 'session'
      });
    }
    if (mode === 'acceptEdits') {
      updates.push({
        type: 'addRules',
        rules: Array.from(EDIT_TOOLS).map(toolName => ({ toolName })),
        behavior: 'allow',
        destination: 'session'
      });
    }
    return updates.length > 0 ? updates : undefined;
  }

  permissionRuleFromTool(tool) {
    const match = String(tool || '').match(/^Bash\(([\s\S]*)\)$/);
    if (match) return { toolName: 'Bash', ruleContent: match[1] };
    return { toolName: String(tool || '') };
  }

  addAllowedTools(tools) {
    for (const tool of tools) {
      if (tool === 'Bash') {
        this.allowedTools.add(tool);
      } else if (tool.startsWith('Bash(')) {
        this.parseBashPermission(tool);
      } else {
        this.allowedTools.add(tool);
      }
    }
  }

  parseBashPermission(permission) {
    const match = String(permission || '').match(/^Bash\(([\s\S]*)\)$/);
    if (!match) return;
    const command = match[1];
    if (command.endsWith(':*')) {
      this.allowedBashPrefixes.add(command.slice(0, -2));
    } else {
      this.allowedBashLiterals.add(command);
    }
  }

  isToolAllowed(toolName, input) {
    if (toolName === 'Bash') {
      if (this.allowedTools.has('Bash')) return true;
      const command = input && typeof input.command === 'string' ? input.command : '';
      if (command && this.allowedBashLiterals.has(command)) return true;
      for (const prefix of this.allowedBashPrefixes) {
        if (command.startsWith(prefix)) return true;
      }
      return false;
    }
    return this.allowedTools.has(toolName);
  }

  shouldAutoAllowTool(toolName, input) {
    if (this.isToolAllowed(toolName, input)) return true;
    if (this.permissionMode === 'bypassPermissions' && !EXIT_PLAN_TOOLS.has(toolName)) return true;
    if (this.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;
    if (this.permissionMode === 'plan' && !this.isDangerousTool(toolName)) return true;
    return false;
  }

  isDangerousTool(toolName) {
    return toolName === 'Bash' || EDIT_TOOLS.has(toolName) || EXIT_PLAN_TOOLS.has(toolName);
  }

  markCompletionRead() {
    this.hasUnreadCompletion = false;
    this.completionReadInputSeq = this.inputSeq || 0;
  }

  startRunner(initialMessage = null) {
    if (this.runnerStarted) {
      if (initialMessage && this.inputQueue) this.inputQueue.push(initialMessage);
      return this.runnerReadyPromise || Promise.resolve(this.query);
    }
    this.runnerStarted = true;
    this.runnerInitializationAnnounced = false;
    this.inputQueue = new AsyncMessageQueue();
    if (initialMessage) this.inputQueue.push(initialMessage);
    this.abortController = new AbortController();
    this.abortRequested = false;
    this.activeOptionSignature = this.getOptionSignature();
    if (initialMessage) this.setStatus('thinking');

    let resolveReady;
    this.runnerReadyPromise = new Promise(resolve => { resolveReady = resolve; });
    void this.runRunner(resolveReady);
    return this.runnerReadyPromise;
  }

  async runRunner(resolveReady) {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const resolvedModel = resolveClaudeModel(this.model, process.env);
      const options = {
        cwd: this.workingDir,
        resume: this.resumeSessionId || undefined,
        permissionMode: this.getSdkPermissionMode(),
        allowDangerouslySkipPermissions: false,
        effort: this.effort,
        tools: { type: 'preset', preset: 'claude_code' },
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'glad-web'
        },
        abortController: this.abortController,
        canUseTool: (toolName, input, options) => this.requestPermission(toolName, input, options)
      };
      if (resolvedModel) options.model = resolvedModel;
      this.query = sdk.query({
        prompt: this.inputQueue,
        options
      });
      if (typeof this.query.initializationResult === 'function') {
        await this.query.initializationResult();
      }
      resolveReady(this.query);

      for await (const message of this.query) {
        this.handleSdkMessage(message);
      }
      this.finishRunner();
      this.sealTurns('completed');
      this.setStatus('idle');
    } catch (error) {
      resolveReady(null);
      const wasAborted = this.abortRequested;
      this.inputQueue?.close();
      this.query?.close?.();
      this.finishRunner();
      if (!this.running) return;
      if (wasAborted) {
        this.setStatus('idle');
        return;
      }
      this.appendMessage({
        kind: 'event',
        level: 'error',
        text: `Claude session error: ${error && error.message ? error.message : String(error)}`
      });
      this.sealTurns('failed');
      this.setStatus('error');
    }
  }

  async showUsage() {
    try {
      const output = await this.runLocalCommand('/usage');
      const usage = { source: 'claude-cli-command', session: parseClaudeUsageOutput(output), fetchedAt: Date.now() };
      this.appendMessage({ kind: 'usage', title: 'Claude usage', usage });
      return true;
    } catch (error) {
      this.appendMessage({
        kind: 'usage',
        title: 'Claude usage',
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  }

  async showContext() {
    try {
      const output = await this.runLocalCommand('/context');
      this.appendMessage({ kind: 'context', title: 'Claude context', context: parseClaudeContextOutput(output) });
      return true;
    } catch (error) {
      this.appendMessage({
        kind: 'context',
        title: 'Claude context',
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  }

  runLocalCommand(command) {
    const task = this.localCommandChain.then(() => this.executeLocalCommand(command));
    this.localCommandChain = task.catch(() => {});
    return task;
  }

  async executeLocalCommand(command) {
    if (this.status === 'thinking') throw new Error('Wait for Claude to finish before running a local command');
    if (this.localCommandRunner) return this.localCommandRunner(command);

    const query = await this.startRunner();
    if (!query || !this.inputQueue) throw new Error('Claude CLI session is not available');
    if (this.pendingLocalCommand) throw new Error('Another Claude local command is already running');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingLocalCommand?.command !== command) return;
        this.pendingLocalCommand = null;
        reject(new Error(`Claude ${command} command timed out`));
      }, LOCAL_COMMAND_TIMEOUT_MS);
      this.pendingLocalCommand = {
        command,
        resolve: output => {
          clearTimeout(timeout);
          this.pendingLocalCommand = null;
          resolve(output);
        },
        reject: error => {
          clearTimeout(timeout);
          this.pendingLocalCommand = null;
          reject(error);
        }
      };
      this.inputQueue.push({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: command }
      });
    });
  }

  rejectPendingLocalCommand(error) {
    this.pendingLocalCommand?.reject(error);
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
    if (toolName !== 'AskUserQuestion' && this.shouldAutoAllowTool(toolName, input)) {
      return Promise.resolve({
        behavior: 'allow',
        updatedInput: input || {},
        toolUseID: options.toolUseID,
        decisionClassification: 'user_permanent'
      });
    }
    const id = crypto.randomUUID();
    const request = {
      id,
      toolName,
      title: options.title || `${toolName} requires approval`,
      displayName: options.displayName || '',
      description: options.description || '',
      reason: options.decisionReason || options.description || '',
      blockedPath: options.blockedPath || null,
      canAllowTool: Boolean(toolName && !EDIT_TOOLS.has(toolName) && !EXIT_PLAN_TOOLS.has(toolName)),
      canAllowEdits: EDIT_TOOLS.has(toolName) || EXIT_PLAN_TOOLS.has(toolName),
      canBypass: EXIT_PLAN_TOOLS.has(toolName),
      input,
      toolUseId: options.toolUseID || null,
      createdAt: Date.now(),
      status: 'pending'
    };
    this.emitEvent({ type: 'permission-request', request });
    return new Promise(resolve => {
      this.pendingPermissions.set(id, {
        public: request,
        resolve,
        input,
        toolName,
        toolUseID: options.toolUseID
      });
    });
  }

  handleSdkMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'system' && message.subtype === 'init') {
      const signatureBeforeInit = this.getOptionSignature();
      this.claudeSessionId = message.session_id || this.claudeSessionId;
      this.resumeSessionId = this.claudeSessionId || this.resumeSessionId;
      if (message.model) this.model = String(message.model);
      // Resolving runtime session/model values is not a user settings change
      // and must not recycle the live runner after the turn.
      if (this.activeOptionSignature === signatureBeforeInit) {
        this.activeOptionSignature = this.getOptionSignature();
      }
      if (!this.runnerInitializationAnnounced) {
        this.runnerInitializationAnnounced = true;
        this.appendMessage({
          kind: 'event',
          level: 'info',
          text: `Claude ready${message.model ? ` (${message.model})` : ''}`
        });
      }
      this.emitEvent({ type: 'state', state: this.getControlState() });
      return;
    }

    if (message.type === 'system' && message.subtype === 'local_command_output') {
      if (this.pendingLocalCommand) {
        this.pendingLocalCommand.resolve(String(message.content || ''));
      }
      return;
    }

    if (this.pendingLocalCommand && message.type === 'assistant') return;

    if (this.pendingLocalCommand && message.type === 'result') {
      const output = typeof message.result === 'string' ? message.result : '';
      if (message.is_error || !output) {
        this.pendingLocalCommand.reject(new Error(output || `Claude ${this.pendingLocalCommand.command} command failed`));
      } else {
        this.pendingLocalCommand.resolve(output);
      }
      this.setStatus('idle');
      return;
    }

    if (message.type === 'assistant') {
      const turn = this.currentTurn();
      const content = message.message && message.message.content;
      const text = textFromContent(content).trim();
      const toolBlocks = Array.isArray(content)
        ? content.filter(item => item && item.type === 'tool_use')
        : [];
      if (text) {
        this.appendMessage({ kind: 'assistant', text, raw: message, turnId: turn?.id || null });
      }
      for (const block of toolBlocks) {
        this.appendMessage({
          kind: 'tool',
          name: block.name || 'tool',
          summary: this.summarizeToolInput(block.input),
          input: block.input,
          toolUseId: block.id,
          turnId: turn?.id || null,
          startedAtMs: Date.now()
        });
      }
      this.setStatus('thinking');
      return;
    }

    if (message.type === 'user') {
      const turn = this.currentTurn();
      const content = message.message && message.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.type === 'tool_result') {
            this.appendMessage({
              kind: 'tool-result',
              toolUseId: item.tool_use_id,
              text: textFromContent([item]).trim(),
              isError: Boolean(item.is_error),
              turnId: turn?.id || null,
              completedAtMs: Date.now()
            });
          }
        }
      }
      return;
    }

    if (message.type === 'result') {
      this.completeCurrentTurn(message.is_error || message.subtype !== 'success' ? 'failed' : 'completed', message.duration_ms);
      this.setStatus(this.turnQueue.length > 0 ? 'thinking' : 'idle');
      if (this.inputSeq > this.completionReadInputSeq) {
        this.hasUnreadCompletion = true;
      }
      this.emit('complete');
      if (this.activeOptionSignature !== this.getOptionSignature()) {
        this.resetRunnerForNextTurn();
      }
    }
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
    return item;
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
