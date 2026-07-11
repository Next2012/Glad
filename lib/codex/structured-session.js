const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const PTYManager = require('../session/pty-manager');

const PERMISSION_MODES = new Set(['untrusted', 'on-request', 'never']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const FALLBACK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'];

function normalizePermissionMode(value) {
  const mode = String(value || 'default');
  return PERMISSION_MODES.has(mode) ? mode : null;
}

function normalizeSandboxMode(value) {
  const mode = String(value || 'default');
  return SANDBOX_MODES.has(mode) ? mode : null;
}

function sandboxPolicyFor(mode, workingDir, workspaceOptions = {}) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (mode === 'workspace-write') {
    const roots = Array.isArray(workspaceOptions.writable_roots) ? workspaceOptions.writable_roots : [];
    return { type: 'workspaceWrite', writableRoots: [workingDir, ...roots.filter(root => root !== workingDir)],
      networkAccess: Boolean(workspaceOptions.network_access),
      excludeTmpdirEnvVar: Boolean(workspaceOptions.exclude_tmpdir_env_var),
      excludeSlashTmp: Boolean(workspaceOptions.exclude_slash_tmp) };
  }
  return null;
}

function sandboxModeFromPolicy(policy) {
  const type = typeof policy === 'string' ? policy : policy?.type;
  if (type === 'dangerFullAccess' || type === 'danger-full-access') return 'danger-full-access';
  if (type === 'readOnly' || type === 'read-only') return 'read-only';
  if (type === 'workspaceWrite' || type === 'workspace-write') return 'workspace-write';
  return null;
}

function safeJson(value) {
  try { return JSON.stringify(value || {}, null, 2); } catch (_) { return String(value || ''); }
}

function textFromInputItems(content) {
  return (Array.isArray(content) ? content : [])
    .filter(item => item && item.type === 'text')
    .map(item => item.text || '')
    .join('\n');
}

function toolDetails(raw) {
  if (raw.type === 'commandExecution') {
    return {
      name: 'CodexBash',
      title: 'Command',
      command: String(raw.command || ''),
      cwd: String(raw.cwd || ''),
      input: { command: raw.command || '', cwd: raw.cwd || '' },
      result: typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : '',
      exitCode: raw.exitCode ?? null
    };
  }
  if (raw.type === 'fileChange') {
    return {
      name: 'CodexPatch',
      title: 'Apply patch',
      changes: raw.changes || [],
      input: { changes: raw.changes || [] },
      result: ''
    };
  }
  if (raw.type === 'mcpToolCall') {
    const server = String(raw.server || 'MCP');
    const tool = String(raw.tool || 'tool');
    return {
      name: 'McpTool',
      title: `${server}.${tool}`,
      server,
      tool,
      input: raw.arguments || {},
      result: raw.error != null ? String(raw.error) : safeJson(raw.result || ''),
      error: raw.error != null ? String(raw.error) : null
    };
  }
  if (raw.type === 'collabAgentToolCall') {
    return {
      name: 'Agent',
      title: raw.tool || raw.action || 'Subagent',
      input: raw.arguments || raw.input || raw,
      result: raw.error != null ? String(raw.error) : safeJson(raw.result || ''),
      error: raw.error != null ? String(raw.error) : null,
      subagentId: raw.receiverThreadId || raw.agentId || raw.id || null
    };
  }
  return {
    name: raw.type === 'webSearch' ? 'WebSearch' : (raw.tool || raw.type || 'Tool'),
    title: raw.tool || raw.type || 'Tool',
    input: raw.arguments || raw.input || raw,
    result: raw.error != null ? String(raw.error) : safeJson(raw.result || ''),
    error: raw.error != null ? String(raw.error) : null
  };
}

class CodexStructuredSession extends EventEmitter {
  constructor({ id, tool, workingDir, name, logger, options = {} }) {
    super();
    this.id = id;
    this.tool = tool;
    this.name = name || tool.displayName;
    this.workingDir = workingDir;
    this.logger = logger || console;
    this.kind = 'codex-structured';
    this.startTime = Date.now();
    this.running = true;
    this.status = 'idle';
    this.presentation = 'structured';
    this.messages = [];
    this.pendingPermissions = new Map();
    this.completedPermissions = [];
    this.threadId = options.resume || null;
    this.currentTurnId = null;
    this.currentTurnStartedAt = null;
    this.permissionMode = normalizePermissionMode(options.permissionMode);
    this.sandboxMode = normalizeSandboxMode(options.sandboxMode);
    this.effectivePermissionMode = null;
    this.effectiveSandboxMode = null;
    this.configPermissionMode = null;
    this.configSandboxMode = null;
    this.configSandboxWorkspaceWrite = {};
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.models = [];
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.process = null;
    this.processReady = null;
    this.terminalSession = null;
    this.terminalOutput = '';
    this.hasUnreadCompletion = false;
    this.inputSeq = 0;
    this.completionReadInputSeq = 0;
    this.timedInputs = new Map();
    this.ptyManager = {
      workingDir,
      isRunning: () => this.isRunning(),
      write: data => this.write(data),
      kill: () => this.kill(),
      resize: (cols, rows) => this.terminalSession?.resize(cols, rows),
      redraw: () => false
    };
  }

  toListItem() {
    return { id: this.id, name: this.name, tool: this.tool.displayName, startTime: this.startTime,
      toolKey: this.tool.key, workingDirectory: this.workingDir, mode: this.presentation === 'terminal' ? 'terminal' : 'structured',
      hasUnreadCompletion: Boolean(this.hasUnreadCompletion), timedInputCount: this.timedInputs.size };
  }

  snapshot() {
    return { id: this.id, name: this.name, tool: this.tool.displayName, toolKey: this.tool.key,
      status: this.status, state: this.getControlState(), messages: this.messages,
      pendingPermissions: [
        ...this.completedPermissions,
        ...Array.from(this.pendingPermissions.values()).map(item => item.public)
      ] };
  }

  getControlState() {
    return { permissionMode: this.permissionMode || 'default', sandboxMode: this.sandboxMode || 'default',
      effectivePermissionMode: this.effectivePermissionMode, effectiveSandboxMode: this.effectiveSandboxMode,
      model: this.model, effort: this.effort,
      status: this.status, threadId: this.threadId, presentation: this.presentation,
      canAbort: this.presentation === 'structured' && this.status !== 'idle',
      canSwitchToTerminal: this.presentation === 'structured' && this.status === 'idle' && Boolean(this.threadId),
      canSwitchToStructured: this.presentation === 'terminal',
      pendingPermissionCount: this.pendingPermissions.size, models: this.models };
  }

  getHistory() {
    const text = this.messages.map(item => {
      if (item.kind === 'user') return `User: ${item.text}`;
      if (item.kind === 'assistant') return `Codex: ${item.text}`;
      if (item.kind === 'tool') return `Tool ${item.name}: ${item.summary || ''}`;
      return item.text || '';
    }).filter(Boolean).join('\n\n');
    return { success: true, sessionId: this.id, sessionName: this.name, tool: this.tool.displayName,
      historyMode: this.presentation === 'terminal' ? 'terminal' : 'structured', text, updatedAt: Date.now(),
      truncated: false, bytes: Buffer.byteLength(text, 'utf8'), lines: text ? text.split('\n').length : 0 };
  }

  getCatchupOutput() {
    if (this.presentation === 'terminal') return { source: 'codex-terminal', items: 1, data: this.terminalOutput };
    return { source: 'codex-structured', items: this.messages.length, data: '' };
  }
  isRunning() { return this.running && (this.presentation !== 'terminal' || Boolean(this.terminalSession)); }

  createItem(item) { return { id: crypto.randomUUID(), createdAt: Date.now(), ...item }; }
  append(item) { const next = this.createItem(item); this.messages.push(next); this.emitEvent({ type: 'message', message: next }); return next; }
  patch(id, patch) {
    const item = this.messages.find(message => message.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.emitEvent({ type: 'message-updated', message: item });
    return item;
  }
  emitEvent(event) { this.emit('event', event); }
  setStatus(status) { if (this.status !== status) { this.status = status; this.emitEvent({ type: 'state', state: this.getControlState() }); } }
  recordPermission(request, status, decision) {
    const completed = { ...request, status, decision };
    this.completedPermissions = [...this.completedPermissions.filter(item => item.id !== request.id), completed].slice(-50);
    this.emitEvent({ type: 'permission-updated', request: completed });
    return completed;
  }

  async ensureProcess() {
    if (this.processReady) return this.processReady;
    this.processReady = new Promise((resolve, reject) => {
      const child = spawn(this.tool.command, ['app-server', '--listen', 'stdio://'], {
        cwd: this.workingDir, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe']
      });
      this.process = child;
      const fail = error => {
        this.processReady = null;
        this.process = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      child.once('error', fail);
      child.once('exit', code => {
        if (this.process === child) {
          this.process = null;
          this.processReady = null;
          for (const request of this.pendingRequests.values()) request.reject(new Error(`Codex app-server exited (${code})`));
          this.pendingRequests.clear();
          if (this.running && this.presentation === 'structured') {
            this.append({ kind: 'event', level: 'error', text: 'Codex app-server exited.' });
            this.setStatus('idle');
          }
        }
      });
      child.stderr.on('data', data => this.logger.debugInfo?.(`[codex-app-server] ${String(data).trim()}`));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => this.handleRpcLine(line));
      this.request('initialize', { clientInfo: { name: 'glad-web', title: 'Glad', version: '1.0' }, capabilities: { experimentalApi: true } })
        .then(async () => {
          try { await this.refreshConfigDefaults(); } catch (error) { this.logger.debugInfo?.(`[codex-app-server] config/read failed: ${error.message}`); }
          try { await this.refreshModels(); } catch (error) { this.logger.debugInfo?.(`[codex-app-server] model/list failed: ${error.message}`); }
          resolve();
        }).catch(fail);
    });
    return this.processReady;
  }

  request(method, params) {
    if (!this.process || !this.process.stdin?.writable) return Promise.reject(new Error('Codex app-server is not connected'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRequests.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.process || !this.process.stdin?.writable) return false;
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return true;
  }

  respond(id, result) {
    if (!this.process || !this.process.stdin?.writable) return false;
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    return true;
  }

  handleRpcLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (message.id !== undefined && !message.method) {
      const request = this.pendingRequests.get(message.id);
      if (!request) return;
      this.pendingRequests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || 'Codex RPC error'));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params || {});
  }

  handleServerRequest(message) {
    const params = message.params || {};
    if (message.method === 'mcpServer/elicitation/request') {
      const toolMatch = typeof params.message === 'string' ? params.message.match(/tool "([^"]+)"/i) : null;
      const id = String(params.callId || `${params.serverName || 'mcp'}:${message.id}`);
      const toolName = toolMatch?.[1] || params.serverName || 'MCP tool';
      const publicRequest = { id, status: 'pending', title: toolName, toolName,
        input: params._meta?.tool_params || {}, reason: params.message || '', canAllowTool: true };
      this.pendingPermissions.set(id, { rpcId: message.id, public: publicRequest, method: message.method, params });
      this.setStatus('waiting_approval');
      this.emitEvent({ type: 'permission-request', request: publicRequest });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') {
      this.append({ kind: 'event', level: 'warning', text: 'Codex requested additional input in Terminal-compatible form. The request was skipped.' });
      this.respond(message.id, { answers: {} });
      return;
    }
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method)) {
      const id = String(params.itemId || params.callId || params.approvalId || message.id);
      const name = message.method.includes('fileChange') ? 'File change' : message.method.includes('permissions') ? 'Permission request' : 'Command execution';
      const publicRequest = { id, status: 'pending', title: name, toolName: name,
        input: params, reason: params.reason || '', canAllowTool: false };
      this.pendingPermissions.set(id, { rpcId: message.id, public: publicRequest, method: message.method });
      this.setStatus('waiting_approval');
      this.emitEvent({ type: 'permission-request', request: publicRequest });
      return;
    }
    this.respond(message.id, null);
  }

  handleNotification(method, params) {
    if (method === 'turn/started') {
      this.currentTurnId = params.turn?.id || params.turnId || this.currentTurnId;
      this.currentTurnStartedAt = Date.now();
      this.append({ kind: 'turn-start', turnId: this.currentTurnId });
      this.setStatus('running');
      return;
    }
    if (method === 'turn/completed') {
      const completedTurnId = params.turn?.id || params.turnId || this.currentTurnId;
      const turnStatus = params.turn?.status === 'failed' || params.turn?.error ? 'failed'
        : params.turn?.status === 'interrupted' ? 'cancelled' : 'completed';
      this.append({ kind: 'turn-end', turnId: completedTurnId, status: turnStatus,
        durationMs: this.currentTurnStartedAt ? Date.now() - this.currentTurnStartedAt : null });
      for (const pending of this.pendingPermissions.values()) {
        this.recordPermission(pending.public, 'denied', 'abort');
      }
      this.currentTurnId = null;
      this.currentTurnStartedAt = null;
      this.pendingPermissions.clear();
      if (params.turn?.status === 'failed' || params.turn?.error) {
        this.append({ kind: 'event', level: 'error', text: params.turn?.error?.message || 'Codex turn failed.' });
      }
      this.setStatus('idle');
      this.hasUnreadCompletion = true;
      return;
    }
    if (method === 'thread/started' || method === 'thread/resumed') {
      const threadId = params.thread?.id || params.threadId;
      if (threadId) { this.threadId = threadId; this.emitEvent({ type: 'state', state: this.getControlState() }); }
      return;
    }
    if (method === 'thread/status/changed') {
      const status = params.status?.type || params.status;
      if (status === 'idle') this.setStatus('idle');
      if (status === 'active') this.setStatus('running');
      return;
    }
    if (method === 'thread/settings/updated') {
      const settings = params.threadSettings || {};
      this.model = settings.model || this.model;
      this.effort = settings.effort || this.effort;
      this.effectivePermissionMode = settings.approvalPolicy || this.effectivePermissionMode;
      this.effectiveSandboxMode = sandboxModeFromPolicy(settings.sandboxPolicy) || this.effectiveSandboxMode;
      this.emitEvent({ type: 'state', state: this.getControlState() });
      return;
    }
    if (method === 'error') {
      this.append({ kind: 'event', level: 'error', text: params.error?.message || 'Codex reported an error.' });
      if (!params.willRetry) this.setStatus('idle');
      return;
    }
    if (method === 'warning' || method === 'guardianWarning') {
      this.append({ kind: 'event', level: 'warning', text: params.message || params.warning || 'Codex warning.' });
      return;
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const target = this.messages.find(item => item.providerId === String(params.itemId || '') && item.kind === 'tool');
      if (target) this.patch(target.id, { result: String(target.result || '') + String(params.delta || '') });
      return;
    }
    if (method === 'item/plan/delta') {
      const providerId = String(params.itemId || '');
      const target = this.messages.find(item => item.providerId === providerId && item.kind === 'reasoning');
      if (target) this.patch(target.id, { text: String(target.text || '') + String(params.delta || '') });
      else this.append({ kind: 'reasoning', providerId, text: String(params.delta || ''), streaming: true });
      return;
    }
    if (method.includes('agentMessage/delta') || method.includes('reasoning/textDelta') || method.includes('reasoning/summaryTextDelta')) {
      const kind = method.includes('agentMessage') ? 'assistant' : 'reasoning';
      const itemId = String(params.itemId || params.id || '');
      const target = this.messages.find(item => item.providerId === itemId && item.kind === kind);
      const delta = String(params.delta || '');
      if (target) this.patch(target.id, { text: (target.text || '') + delta });
      else this.append({ kind, providerId: itemId, text: delta, streaming: true });
      return;
    }
    if (method.startsWith('item/')) this.applyProviderItem(params.item || params);
  }

  applyProviderItem(raw) {
    if (!raw || typeof raw !== 'object') return;
    const providerId = String(raw.id || '');
    const existing = providerId && this.messages.find(item => item.providerId === providerId);
    const kind = raw.type === 'userMessage' ? 'user' : raw.type === 'agentMessage' ? 'assistant' : ['reasoning', 'plan'].includes(raw.type) ? 'reasoning'
      : ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall'].includes(raw.type) ? 'tool' : null;
    if (!kind) return;
    const text = kind === 'user' ? textFromInputItems(raw.content) : kind === 'assistant' ? String(raw.text || '')
      : kind === 'reasoning' ? (raw.text || (Array.isArray(raw.summary) ? raw.summary.join('\n') : Array.isArray(raw.content) ? raw.content.join('\n') : '')) : '';
    const patch = kind === 'tool' ? { ...toolDetails(raw), turnId: raw.turnId || this.currentTurnId,
      toolStatus: raw.status || 'running' } : { text, turnId: raw.turnId || this.currentTurnId, streaming: false };
    if (existing) {
      this.patch(existing.id, patch);
    } else if (kind === 'user') {
      const local = [...this.messages].reverse().find(item => item.kind === 'user' && !item.providerId && item.text === text);
      if (local) this.patch(local.id, { providerId, ...patch });
      else this.append({ kind, providerId, ...patch });
    } else {
      this.append({ kind, providerId, ...patch });
    }
  }

  async refreshModels() {
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
      for (const item of result?.data || []) models.push({ id: item.id || item.model, label: item.displayName || item.model || item.id,
        efforts: (item.supportedReasoningEfforts || []).map(value => value.reasoningEffort), defaultEffort: item.defaultReasoningEffort || null });
      cursor = result?.nextCursor || null;
    } while (cursor);
    this.models = models;
    if (!this.model && models[0]) this.model = models[0].id;
    if (!this.effort) this.effort = models.find(item => item.id === this.model)?.defaultEffort || 'medium';
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return models;
  }

  async refreshConfigDefaults() {
    const result = await this.request('config/read', { cwd: this.workingDir, includeLayers: false });
    const config = result?.config || {};
    this.configPermissionMode = config.approval_policy || null;
    this.configSandboxMode = normalizeSandboxMode(config.sandbox_mode);
    this.configSandboxWorkspaceWrite = config.sandbox_workspace_write || {};
    if (!this.permissionMode) this.effectivePermissionMode = this.configPermissionMode;
    if (!this.sandboxMode) this.effectiveSandboxMode = this.configSandboxMode;
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return config;
  }

  async listResumeThreads() {
    await this.ensureProcess();
    const result = await this.request('thread/list', {
      cursor: null,
      limit: 40,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      cwd: this.workingDir
    });
    return (result?.data || []).filter(item => !item.parentThreadId).map(item => ({
      id: item.id,
      sessionId: item.sessionId || item.id,
      preview: item.preview || item.name || '',
      updatedAt: Number(item.updatedAt || item.createdAt || 0) * 1000,
      cwd: item.cwd || '',
      current: item.id === this.threadId
    }));
  }

  async updateSettings(settings = {}) {
    if (settings.permissionMode !== undefined) this.permissionMode = normalizePermissionMode(settings.permissionMode);
    if (settings.sandboxMode !== undefined) this.sandboxMode = normalizeSandboxMode(settings.sandboxMode);
    if (settings.model !== undefined) this.model = settings.model || null;
    if (settings.effort !== undefined) this.effort = settings.effort || null;
    const needsConfigDefaults = (settings.permissionMode !== undefined && !this.permissionMode)
      || (settings.sandboxMode !== undefined && !this.sandboxMode);
    if (needsConfigDefaults && this.presentation === 'structured') {
      await this.ensureProcess();
      await this.refreshConfigDefaults();
    }
    if (this.threadId && this.presentation === 'structured') {
      await this.ensureProcess();
      const params = { threadId: this.threadId };
      if (settings.permissionMode !== undefined) {
        const approvalPolicy = this.permissionMode || this.configPermissionMode;
        if (approvalPolicy) params.approvalPolicy = approvalPolicy;
      }
      if (settings.sandboxMode !== undefined) {
        const sandboxPolicy = sandboxPolicyFor(this.sandboxMode || this.configSandboxMode, this.workingDir,
          this.sandboxMode ? {} : this.configSandboxWorkspaceWrite);
        if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
      }
      if (settings.model !== undefined) params.model = this.model;
      if (settings.effort !== undefined) params.effort = this.effort;
      if (Object.keys(params).length > 1) await this.request('thread/settings/update', params);
    }
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return this.getControlState();
  }

  async sendUserMessage(text) {
    const prompt = String(text || '').trim();
    if (!prompt || this.presentation !== 'structured' || this.status !== 'idle') return false;
    this.hasUnreadCompletion = false;
    this.append({ kind: 'user', text: prompt });
    await this.ensureProcess();
    if (!this.threadId) {
      const params = { model: this.model, cwd: this.workingDir };
      if (this.permissionMode) params.approvalPolicy = this.permissionMode;
      if (this.sandboxMode) params.sandbox = this.sandboxMode;
      const started = await this.request('thread/start', params);
      this.threadId = started.thread?.id;
      this.model = started.model || this.model;
      this.effort = started.reasoningEffort || this.effort;
      this.effectivePermissionMode = started.approvalPolicy || this.effectivePermissionMode;
      this.effectiveSandboxMode = sandboxModeFromPolicy(started.sandbox) || this.effectiveSandboxMode;
      this.emitEvent({ type: 'state', state: this.getControlState() });
    }
    this.setStatus('running');
    const params = { threadId: this.threadId, input: [{ type: 'text', text: prompt }], cwd: this.workingDir,
      model: this.model, effort: this.effort, summary: 'auto' };
    if (this.permissionMode) params.approvalPolicy = this.permissionMode;
    const sandboxPolicy = sandboxPolicyFor(this.sandboxMode, this.workingDir);
    if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
    const started = await this.request('turn/start', params);
    this.currentTurnId = started?.turn?.id || started?.turnId || this.currentTurnId;
    return true;
  }

  write(data) {
    if (this.presentation === 'terminal') return this.terminalSession?.write(data) || false;
    const text = String(data || '').replace(/\r/g, '\n');
    const prompt = text.trim();
    if (prompt) void this.sendUserMessage(prompt).catch(error => {
      this.currentTurnId = null;
      this.setStatus('idle');
      this.append({ kind: 'event', level: 'error', text: error.message });
    });
    return true;
  }

  respondPermission(id, decision) {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    const normalized = ['approved', 'approved_for_session', 'denied', 'abort'].includes(decision)
      ? decision : (decision ? 'approved' : 'denied');
    this.pendingPermissions.delete(id);
    if (pending.method === 'mcpServer/elicitation/request') {
      const action = normalized === 'approved' || normalized === 'approved_for_session' ? 'accept'
        : normalized === 'abort' ? 'cancel' : 'decline';
      this.respond(pending.rpcId, { action, content: action === 'accept' && pending.params?.mode === 'form' ? {} : null, _meta: null });
    } else if (pending.method === 'item/permissions/requestApproval') {
      const approved = normalized === 'approved' || normalized === 'approved_for_session';
      this.respond(pending.rpcId, { permissions: approved ? (pending.public.input.permissions || {}) : {},
        scope: normalized === 'approved_for_session' ? 'session' : 'turn' });
    } else {
      const wireDecision = normalized === 'approved' ? 'accept' : normalized === 'approved_for_session' ? 'acceptForSession'
        : normalized === 'abort' ? 'cancel' : 'decline';
      this.respond(pending.rpcId, { decision: wireDecision });
    }
    const status = normalized === 'approved' || normalized === 'approved_for_session' ? 'approved' : 'denied';
    this.recordPermission(pending.public, status, normalized);
    this.setStatus(this.pendingPermissions.size ? 'waiting_approval' : 'running');
    return true;
  }

  abort(reason = 'Aborted by user') {
    if (this.presentation !== 'structured' || this.status === 'idle') return false;
    for (const pending of this.pendingPermissions.values()) {
      const response = pending.method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' }
        : pending.method === 'mcpServer/elicitation/request'
          ? { action: 'cancel', content: null, _meta: null }
          : { decision: 'cancel' };
      this.respond(pending.rpcId, response);
      this.recordPermission(pending.public, 'denied', 'abort');
    }
    this.pendingPermissions.clear();
    if (this.threadId && this.currentTurnId) {
      this.request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId }).catch(error => {
        this.logger.debugInfo?.(`[codex-app-server] turn/interrupt failed: ${error.message}`);
      });
    }
    this.append({ kind: 'event', level: 'info', text: reason });
    return true;
  }

  async resume(threadId = null) {
    const target = String(threadId || this.threadId || '').trim();
    if (!target || this.presentation !== 'structured' || this.status !== 'idle') return false;
    await this.ensureProcess();
    const params = { threadId: target, model: this.model, cwd: this.workingDir };
    if (this.permissionMode) params.approvalPolicy = this.permissionMode;
    if (this.sandboxMode) params.sandbox = this.sandboxMode;
    const result = await this.request('thread/resume', params);
    this.threadId = result.thread?.id || target;
    this.model = result.model || this.model;
    this.effectivePermissionMode = result.approvalPolicy || this.effectivePermissionMode;
    this.effectiveSandboxMode = sandboxModeFromPolicy(result.sandbox) || this.effectiveSandboxMode;
    const history = await this.request('thread/read', { threadId: this.threadId, includeTurns: true });
    this.messages = [];
    this.completedPermissions = [];
    for (const turn of history?.thread?.turns || []) {
      this.append({ kind: 'turn-start', turnId: turn.id });
      for (const item of turn.items || []) this.applyProviderItem({ ...item, turnId: turn.id });
      const status = turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'cancelled' : 'completed';
      this.append({ kind: 'turn-end', turnId: turn.id, status });
    }
    this.append({ kind: 'event', level: 'info', text: `Resumed Codex thread ${this.threadId}` });
    this.emitEvent({ type: 'history-reset', messages: this.messages });
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return true;
  }

  async switchToTerminal() {
    if (this.presentation !== 'structured' || this.status !== 'idle' || !this.threadId) throw new Error('Codex must be idle before switching to Terminal.');
    await this.disconnectProcess();
    this.terminalOutput = '';
    const terminal = new PTYManager(this.tool, this.workingDir, { append() {} }, { silent: true });
    terminal.onData(data => {
      this.terminalOutput = (this.terminalOutput + data).slice(-1024 * 1024);
      this.emit('output', data);
    });
    terminal.onExit(() => { this.terminalSession = null; this.emitEvent({ type: 'state', state: this.getControlState() }); });
    if (!terminal.start(['resume', this.threadId])) throw new Error('Failed to start Codex terminal.');
    this.terminalSession = terminal;
    this.presentation = 'terminal';
    this.emitEvent({ type: 'presentation', presentation: 'terminal', state: this.getControlState() });
    return true;
  }

  async switchToStructured() {
    if (this.presentation !== 'terminal') throw new Error('Codex is already in chat mode.');
    await this.ensureProcess();
    const listed = await this.request('thread/list', { limit: 100, archived: false, cwd: this.workingDir, useStateDbOnly: true });
    const current = (listed?.data || []).find(item => item.id === this.threadId);
    if (current?.status?.type === 'active') throw new Error('Codex is still running in Terminal. Wait for it to finish before switching.');
    if (this.terminalSession) {
      this.terminalSession.kill();
      this.terminalSession = null;
    }
    this.presentation = 'structured';
    this.emitEvent({ type: 'presentation', presentation: 'structured', state: this.getControlState() });
    return this.resume();
  }

  async disconnectProcess() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    this.processReady = null;
    for (const request of this.pendingRequests.values()) { clearTimeout(request.timer); request.reject(new Error('Codex app-server disconnected')); }
    this.pendingRequests.clear();
    child.kill();
  }

  markCompletionRead() { this.hasUnreadCompletion = false; this.completionReadInputSeq = this.inputSeq; }
  kill() { this.running = false; this.terminalSession?.kill(); this.terminalSession = null; void this.disconnectProcess(); this.emit('exit'); }
}

module.exports = CodexStructuredSession;
