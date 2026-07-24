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

function toTimestampMs(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return null;
  return timestamp < 100000000000 ? timestamp * 1000 : timestamp;
}

function appServerSpawnOptions({ cwd, env, platform = process.platform }) {
  const options = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] };

  // Globally installed npm CLIs expose a .cmd shim on Windows. child_process.spawn
  // does not resolve that shim without a shell, causing `spawn codex ENOENT`.
  if (platform === 'win32') {
    options.shell = true;
    options.windowsHide = true;
  }

  return options;
}

function textFromInputItems(content) {
  return (Array.isArray(content) ? content : [])
    .filter(item => item && item.type === 'text')
    .map(item => item.text || '')
    .join('\n');
}

function skillsFromInputItems(content) {
  const seen = new Set();
  const skills = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!item || item.type !== 'skill') continue;
    const name = String(item.name || '').trim();
    const path = String(item.path || '').trim();
    const key = `${name}\n${path}`;
    if (!name || !path || seen.has(key)) continue;
    seen.add(key);
    skills.push({ name, path });
  }
  return skills;
}

function recentUserQuestions(thread, limit = 2) {
  const questions = [];
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && questions.length < limit; turnIndex -= 1) {
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0 && questions.length < limit; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type !== 'userMessage') continue;
      const text = (textFromInputItems(item.content) || item.text || '').trim();
      if (text) questions.push(text);
    }
  }
  while (questions.length < limit) questions.push('');
  return questions;
}

function userPromptsFromThread(thread, fallbackTimestamp = null) {
  const prompts = [];
  const threadId = String(thread?.id || '');
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    const turnTimestamp = toTimestampMs(turn.startedAt || turn.createdAt || turn.completedAt || turn.updatedAt)
      || fallbackTimestamp;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type !== 'userMessage') continue;
      const prompt = (textFromInputItems(item.content) || item.text || '').trim();
      if (!prompt) continue;
      prompts.push({
        id: String(item.id || `${threadId}:${turn.id || 'turn'}:${prompts.length}`),
        threadId,
        text: prompt,
        createdAt: toTimestampMs(item.createdAt || item.updatedAt) || turnTimestamp || null
      });
    }
  }
  return prompts;
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
    const receiverThreadIds = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.filter(Boolean) : [];
    const input = raw.arguments || raw.input || {
      ...(raw.prompt ? { prompt: raw.prompt } : {}),
      ...(receiverThreadIds.length ? { receiverThreadIds } : {}),
      ...(raw.agentsStates && Object.keys(raw.agentsStates).length ? { agentsStates: raw.agentsStates } : {})
    };
    return {
      name: 'Agent',
      title: raw.tool || raw.action || 'Subagent',
      tool: raw.tool || raw.action || 'subagent',
      input,
      result: raw.error != null ? String(raw.error) : raw.result == null ? '' : safeJson(raw.result),
      error: raw.error != null ? String(raw.error) : null,
      subagentId: raw.receiverThreadId || receiverThreadIds[0] || raw.agentId || null,
      subagentIds: receiverThreadIds,
      agentsStates: raw.agentsStates || {}
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
    this.replayingHistory = false;
    this.pendingPermissions = new Map();
    this.completedPermissions = [];
    this.threadId = options.resume || null;
    this.currentTurnId = null;
    this.currentTurnStartedAt = null;
    this.threadTurns = new Map();
    this.turnContexts = new Map();
    this.providerItemContexts = new Map();
    this.tokenUsage = null;
    this.compacting = false;
    this.permissionMode = normalizePermissionMode(options.permissionMode);
    this.sandboxMode = normalizeSandboxMode(options.sandboxMode);
    this.effectivePermissionMode = null;
    this.effectiveSandboxMode = null;
    this.configPermissionMode = null;
    this.configSandboxMode = null;
    this.configSandboxWorkspaceWrite = {};
    this.configModel = null;
    this.configEffort = null;
    this.hasModelOverride = Boolean(options.model);
    this.hasEffortOverride = Boolean(options.effort);
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
    this.promptHistoryCache = null;
    this.deferredWarnings = null;
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
      status: this.status, state: this.getControlState(), messages: this.messages.map(item => this.toPublicMessage(item)),
      pendingPermissions: [
        ...this.completedPermissions,
        ...Array.from(this.pendingPermissions.values()).map(item => item.public)
      ] };
  }

  toPublicMessage(item) {
    if (!item || typeof item !== 'object') return item;
    const message = { ...item };
    const isSubagent = Boolean(message.threadId && this.threadId && message.threadId !== this.threadId);
    let hasDetail = false;

    if (message.kind === 'tool') {
      for (const field of ['result', 'input', 'changes', 'error', 'agentsStates']) {
        const value = message[field];
        if (value != null && value !== '' && (!Array.isArray(value) || value.length)) hasDetail = true;
        delete message[field];
      }
      if (item.error) message.hasError = true;
    }
    if (isSubagent && ['user', 'assistant', 'reasoning', 'event'].includes(message.kind)) {
      if (message.text) hasDetail = true;
      delete message.text;
      delete message.skills;
    }
    if (message.kind === 'reasoning') {
      if (message.text) hasDetail = true;
      delete message.text;
    }
    message.hasDetail = hasDetail;
    message.detailRevision = Number(item.updatedAt || item.createdAt || 0);
    return message;
  }

  getMessageDetails({ ids = [], threadId = null } = {}) {
    const requestedIds = new Set((Array.isArray(ids) ? ids : [])
      .map(value => String(value || '')).filter(Boolean));
    const requestedThreadId = threadId == null ? '' : String(threadId);
    const messages = this.messages.filter(item => {
      if (requestedThreadId && String(item.threadId || '') === requestedThreadId) return true;
      return requestedIds.has(String(item.id || ''));
    }).map(item => ({ ...item, detailLoaded: true }));
    return { messages, threadId: requestedThreadId || null };
  }

  getControlState() {
    const activeSubagentCount = Array.from(this.threadTurns.entries())
      .filter(([threadId, turn]) => threadId !== this.threadId && turn?.status === 'running').length;
    return { permissionMode: this.permissionMode || 'default', sandboxMode: this.sandboxMode || 'default',
      effectivePermissionMode: this.effectivePermissionMode, effectiveSandboxMode: this.effectiveSandboxMode,
      model: this.model, effort: this.effort,
      status: this.status, threadId: this.threadId, presentation: this.presentation,
      canAbort: this.presentation === 'structured' && this.status !== 'idle',
      canCompact: this.presentation === 'structured' && this.status === 'idle' && !this.compacting && Boolean(this.threadId),
      compacting: this.compacting,
      canSwitchToTerminal: this.presentation === 'structured' && this.status === 'idle' && Boolean(this.threadId),
      canSwitchToStructured: this.presentation === 'terminal',
      pendingPermissionCount: this.pendingPermissions.size, activeSubagentCount, models: this.models };
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
  append(item) {
    const next = this.createItem(item);
    this.messages.push(next);
    if (!this.replayingHistory) this.emitEvent({ type: 'message', message: this.toPublicMessage(next) });
    return next;
  }
  patch(id, patch) {
    const item = this.messages.find(message => message.id === id);
    if (!item) return null;
    Object.assign(item, { updatedAt: Date.now() }, patch);
    if (!this.replayingHistory) this.emitEvent({ type: 'message-updated', message: this.toPublicMessage(item) });
    return item;
  }
  emitEvent(event) { this.emit('event', event); }
  setStatus(status) { if (this.status !== status) { this.status = status; this.emitEvent({ type: 'state', state: this.getControlState() }); } }
  emitControlState() { this.emitEvent({ type: 'state', state: this.getControlState() }); }
  recordPermission(request, status, decision) {
    const completed = { ...request, status, decision };
    this.completedPermissions = [...this.completedPermissions.filter(item => item.id !== request.id), completed].slice(-50);
    this.emitEvent({ type: 'permission-updated', request: completed });
    return completed;
  }

  async ensureProcess() {
    if (this.processReady) return this.processReady;
    this.processReady = new Promise((resolve, reject) => {
      const child = spawn(this.tool.command, ['app-server', '--listen', 'stdio://'], appServerSpawnOptions({
        cwd: this.workingDir,
        env: { ...process.env }
      }));
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
            this.compacting = false;
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
    if (method === 'thread/tokenUsage/updated') {
      this.tokenUsage = params.tokenUsage || params.usage || params;
      this.recordTurnContext(params.turnId, this.tokenUsage);
      return;
    }
    if (method === 'turn/started') {
      const threadId = params.threadId || this.threadId;
      const turnId = params.turn?.id || params.turnId || null;
      const startedAt = Number(params.turn?.startedAt || 0);
      const startedAtMs = startedAt > 0 && startedAt < 100000000000 ? startedAt * 1000 : startedAt || Date.now();
      if (threadId && turnId) this.threadTurns.set(threadId, { turnId, startedAt: startedAtMs, status: 'running' });
      if (!threadId || threadId === this.threadId) {
        this.currentTurnId = turnId || this.currentTurnId;
        this.currentTurnStartedAt = startedAtMs;
        this.setStatus('running');
      } else {
        this.emitControlState();
      }
      this.append({ kind: 'turn-start', threadId, turnId, createdAt: startedAtMs });
      return;
    }
    if (method === 'turn/completed') {
      const threadId = params.threadId || this.threadId;
      const trackedTurn = threadId ? this.threadTurns.get(threadId) : null;
      const completedTurnId = params.turn?.id || params.turnId || trackedTurn?.turnId || this.currentTurnId;
      const turnStatus = params.turn?.status === 'failed' || params.turn?.error ? 'failed'
        : params.turn?.status === 'interrupted' ? 'cancelled' : 'completed';
      const completedAt = Number(params.turn?.completedAt || 0);
      const completedAtMs = completedAt > 0 && completedAt < 100000000000 ? completedAt * 1000 : completedAt || Date.now();
      const startedAtMs = trackedTurn?.startedAt || ((!threadId || threadId === this.threadId) ? this.currentTurnStartedAt : null);
      const durationMs = Number(params.turn?.durationMs || 0)
        || (startedAtMs ? Math.max(0, completedAtMs - startedAtMs) : null);
      const context = this.turnContexts.get(String(completedTurnId || ''));
      this.append({ kind: 'turn-end', threadId, turnId: completedTurnId, status: turnStatus,
        durationMs, createdAt: completedAtMs, ...(context ? { context } : {}) });
      const observedNow = Date.now();
      const observedCompletedAtMs = Math.abs(observedNow - completedAtMs) < 5000
        ? Math.max(completedAtMs, observedNow) : completedAtMs;
      for (const item of this.messages.filter(message => message.kind === 'tool'
        && message.turnId === completedTurnId && ['running', 'inProgress'].includes(message.toolStatus))) {
        const toolDurationMs = Number(item.durationMs || 0)
          || (item.startedAtMs || item.createdAt ? Math.max(1, observedCompletedAtMs - Number(item.startedAtMs || item.createdAt)) : null);
        const toolStatus = turnStatus === 'failed' ? 'failed' : turnStatus === 'cancelled' ? 'cancelled' : 'completed';
        this.patch(item.id, { toolStatus,
          completedAtMs: observedCompletedAtMs, ...(toolDurationMs != null ? { durationMs: toolDurationMs } : {}) });
      }
      for (const item of this.messages.filter(message => message.kind === 'compaction'
        && message.turnId === completedTurnId && message.compactionStatus === 'running')) {
        this.patch(item.id, { compactionStatus: 'completed', completedAtMs: observedCompletedAtMs });
      }
      if (threadId) this.threadTurns.delete(threadId);
      if (!threadId || threadId === this.threadId) {
        this.compacting = false;
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
      } else {
        this.emitControlState();
      }
      return;
    }
    if (method === 'thread/compacted') {
      const threadId = params.threadId || this.threadId;
      const turnId = params.turnId || (threadId ? this.threadTurns.get(threadId)?.turnId : null) || this.currentTurnId;
      this.applyProviderItem({ id: `compaction-${turnId || Date.now()}`, type: 'contextCompaction', threadId, turnId }, 'completed', {
        threadId, turnId, completedAtMs: Date.now()
      });
      return;
    }
    if (method === 'thread/started' || method === 'thread/resumed') {
      const threadId = params.thread?.id || params.threadId;
      if (threadId && !this.threadId) { this.threadId = threadId; this.emitControlState(); }
      return;
    }
    if (method === 'thread/status/changed') {
      const threadId = params.threadId || this.threadId;
      const status = params.status?.type || params.status;
      if (!threadId || threadId === this.threadId) {
        if (status === 'idle' && !this.currentTurnId) { this.compacting = false; this.setStatus('idle'); }
        if (status === 'active') this.setStatus('running');
      }
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
      if (!params.willRetry) { this.compacting = false; this.setStatus('idle'); }
      return;
    }
    if (method === 'warning' || method === 'guardianWarning') {
      const warning = { kind: 'event', level: 'warning', text: params.message || params.warning || 'Codex warning.' };
      if (this.deferredWarnings) this.deferredWarnings.push(warning);
      else this.append(warning);
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
      const known = this.providerItemContexts.get(providerId) || {};
      const threadId = params.threadId || target?.threadId || known.threadId || null;
      const turnId = params.turnId || target?.turnId || known.turnId
        || (threadId ? this.threadTurns.get(threadId)?.turnId : null) || this.currentTurnId;
      if (providerId && (threadId || turnId)) this.providerItemContexts.set(providerId, { threadId, turnId });
      if (target) this.patch(target.id, { text: String(target.text || '') + String(params.delta || ''), threadId, turnId });
      else this.append({ kind: 'reasoning', providerId, text: String(params.delta || ''), threadId, turnId, streaming: true });
      return;
    }
    if (method.includes('agentMessage/delta') || method.includes('reasoning/textDelta') || method.includes('reasoning/summaryTextDelta')) {
      const kind = method.includes('agentMessage') ? 'assistant' : 'reasoning';
      const itemId = String(params.itemId || params.id || '');
      const target = this.messages.find(item => item.providerId === itemId && item.kind === kind);
      const known = this.providerItemContexts.get(itemId) || {};
      const threadId = params.threadId || target?.threadId || known.threadId || null;
      const turnId = params.turnId || target?.turnId || known.turnId
        || (threadId ? this.threadTurns.get(threadId)?.turnId : null) || this.currentTurnId;
      const delta = String(params.delta || '');
      if (itemId && (threadId || turnId)) this.providerItemContexts.set(itemId, { threadId, turnId });
      if (target) this.patch(target.id, { text: (target.text || '') + delta, threadId, turnId });
      else this.append({ kind, providerId: itemId, text: delta, threadId, turnId, streaming: true });
      return;
    }
    if (method.startsWith('item/')) {
      const inferredStatus = method === 'item/completed' ? 'completed' : method === 'item/started' ? 'running' : null;
      this.applyProviderItem(params.item || params, inferredStatus, {
        threadId: params.threadId || null,
        turnId: params.turnId || null,
        startedAtMs: Number(params.startedAtMs || 0) || null,
        completedAtMs: Number(params.completedAtMs || 0) || null
      });
    }
  }

  applyProviderItem(raw, inferredStatus = null, context = {}) {
    if (!raw || typeof raw !== 'object') return;
    const providerId = String(raw.id || '');
    let existing = providerId && this.messages.find(item => item.providerId === providerId);
    const kind = raw.type === 'userMessage' ? 'user' : raw.type === 'agentMessage' ? 'assistant' : ['reasoning', 'plan'].includes(raw.type) ? 'reasoning'
      : ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall'].includes(raw.type) ? 'tool'
        : raw.type === 'contextCompaction' ? 'compaction' : null;
    if (!kind) return;
    const text = kind === 'user' ? textFromInputItems(raw.content) : kind === 'assistant' ? String(raw.text || '')
      : kind === 'reasoning' ? (raw.text || (Array.isArray(raw.summary) ? raw.summary.join('\n') : Array.isArray(raw.content) ? raw.content.join('\n') : '')) : '';
    const inferredToolStatus = existing?.toolStatus === 'cancelled' ? 'cancelled'
      : inferredStatus === 'completed' && ['failed', 'declined'].includes(raw.status) ? raw.status : inferredStatus;
    const threadId = raw.threadId || context.threadId || null;
    const trackedTurnId = threadId ? this.threadTurns.get(threadId)?.turnId : null;
    const turnId = raw.turnId || context.turnId || trackedTurnId || this.currentTurnId;
    if (!existing && kind === 'compaction' && turnId) {
      existing = this.messages.find(item => item.kind === 'compaction' && item.turnId === turnId);
    }
    if (providerId && (threadId || turnId)) this.providerItemContexts.set(providerId, { threadId, turnId });
    const existingStartedAtMs = existing?.startedAtMs || existing?.createdAt || null;
    const startedAtMs = Number(context.startedAtMs || raw.startedAtMs || 0)
      || toTimestampMs(raw.startedAt || raw.createdAt) || existingStartedAtMs;
    const completedAtMs = Number(context.completedAtMs || raw.completedAtMs || 0)
      || toTimestampMs(raw.completedAt || raw.updatedAt);
    const durationMs = Number(raw.durationMs || 0)
      || (completedAtMs && startedAtMs && completedAtMs >= startedAtMs ? completedAtMs - startedAtMs : null)
      || Number(existing?.durationMs || 0) || null;
    const timing = {
      ...(startedAtMs ? { startedAtMs } : {}),
      ...(completedAtMs ? { completedAtMs } : {}),
      ...(durationMs != null ? { durationMs } : {})
    };
    const patch = kind === 'tool' ? { ...toolDetails(raw), threadId, turnId,
      ...timing, toolStatus: inferredToolStatus || raw.status || 'running' }
      : kind === 'compaction' ? { providerId, threadId, turnId, ...timing,
        compactionStatus: inferredStatus || raw.status || 'running' }
      : { text, threadId, turnId, streaming: false,
        ...(kind === 'user' ? { skills: skillsFromInputItems(raw.content) } : {}),
        ...(completedAtMs ? { completedAtMs } : {}) };
    if (existing) {
      this.patch(existing.id, patch);
    } else if (kind === 'user') {
      const local = [...this.messages].reverse().find(item => item.kind === 'user' && !item.providerId && item.text === text);
      if (local) this.patch(local.id, { providerId, ...patch });
      else this.append({ kind, providerId, ...(startedAtMs ? { createdAt: startedAtMs } : {}), ...patch });
    } else {
      this.append({ kind, providerId, ...(startedAtMs ? { createdAt: startedAtMs } : {}), ...patch });
    }
    if (kind === 'compaction' && (!threadId || threadId === this.threadId)) {
      this.compacting = patch.compactionStatus === 'running';
      this.emitControlState();
    }
  }

  async refreshModels() {
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
      for (const item of result?.data || []) models.push({ id: item.id || item.model, label: item.displayName || item.model || item.id,
        efforts: (item.supportedReasoningEfforts || []).map(value => value.reasoningEffort), defaultEffort: item.defaultReasoningEffort || null,
        isDefault: Boolean(item.isDefault), contextWindow: Number(item.contextWindow || item.context_window || 0) || null });
      cursor = result?.nextCursor || null;
    } while (cursor);
    this.models = models;
    if (!this.model) this.model = (models.find(item => item.isDefault) || models[0])?.id || null;
    if (!this.effort) this.effort = models.find(item => item.id === this.model)?.defaultEffort || 'medium';
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return models;
  }

  async listSkills(forceReload = false) {
    await this.ensureProcess();
    const result = await this.request('skills/list', {
      cwds: [this.workingDir],
      forceReload: Boolean(forceReload)
    });
    const entries = Array.isArray(result?.data) ? result.data : [];
    const entry = entries.find(item => item?.cwd === this.workingDir) || entries[0] || {};
    return {
      skills: (Array.isArray(entry.skills) ? entry.skills : []).filter(item => item?.enabled !== false),
      errors: Array.isArray(entry.errors) ? entry.errors : []
    };
  }

  async resolveSkillInputs(skills) {
    const requested = (Array.isArray(skills) ? skills : []).slice(0, 8);
    if (!requested.length) return [];
    const available = await this.listSkills(false);
    const allowed = new Map(available.skills.map(item => [`${item.name}\n${item.path}`, item]));
    const seen = new Set();
    const resolved = [];
    for (const item of requested) {
      const key = `${String(item?.name || '')}\n${String(item?.path || '')}`;
      const skill = allowed.get(key);
      if (!skill || seen.has(key)) continue;
      seen.add(key);
      resolved.push({ type: 'skill', name: skill.name, path: skill.path });
    }
    return resolved;
  }

  async refreshConfigDefaults() {
    const result = await this.request('config/read', { cwd: this.workingDir, includeLayers: false });
    const config = result?.config || {};
    this.configPermissionMode = config.approval_policy || null;
    this.configSandboxMode = normalizeSandboxMode(config.sandbox_mode);
    this.configSandboxWorkspaceWrite = config.sandbox_workspace_write || {};
    this.configModel = config.model || null;
    this.configEffort = config.model_reasoning_effort || null;
    if (!this.permissionMode) this.effectivePermissionMode = this.configPermissionMode;
    if (!this.sandboxMode) this.effectiveSandboxMode = this.configSandboxMode;
    if (!this.hasModelOverride && this.configModel) this.model = this.configModel;
    if (!this.hasEffortOverride && this.configEffort) this.effort = this.configEffort;
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
    const threads = (result?.data || []).filter(item => !item.parentThreadId);
    const items = [];
    for (const item of threads) {
      let questions = [];
      try {
        const history = await this.request('thread/read', { threadId: item.id, includeTurns: true });
        questions = recentUserQuestions(history?.thread);
      } catch (error) {
        this.logger.debugInfo?.(`[codex-app-server] unable to read resume preview for ${item.id}: ${error.message}`);
      }
      if (!questions[0]) questions[0] = item.preview || '';
      if (questions.length < 2) questions.push('');
      items.push({
        id: item.id,
        sessionId: item.sessionId || item.id,
        questions: questions.slice(0, 2),
        updatedAt: Number(item.updatedAt || item.createdAt || 0) * 1000,
        cwd: item.cwd || '',
        current: item.id === this.threadId
      });
    }
    return items;
  }

  async listPromptHistory({ offset = 0, limit = 30 } = {}) {
    await this.ensureProcess();
    const safeOffset = Math.max(0, Math.min(199, Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(30, Number(limit) || 30));
    const cacheFresh = this.promptHistoryCache
      && Date.now() - this.promptHistoryCache.loadedAt < 15000;

    if (!cacheFresh) {
      const prompts = [];
      let cursor = null;
      let pageCount = 0;
      let capped = false;
      do {
        const result = await this.request('thread/list', {
          cursor,
          limit: 20,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          archived: false,
          cwd: this.workingDir
        });
        const threads = (result?.data || []).filter(item => !item.parentThreadId);
        const histories = await Promise.all(threads.map(async item => {
          try {
            const history = await this.request('thread/read', { threadId: item.id, includeTurns: true });
            const fallbackTimestamp = toTimestampMs(item.updatedAt || item.createdAt);
            return userPromptsFromThread(history?.thread || { id: item.id, turns: [] }, fallbackTimestamp)
              .map(prompt => ({ ...prompt, threadId: prompt.threadId || item.id }));
          } catch (error) {
            this.logger.debugInfo?.(`[codex-app-server] unable to read prompt history for ${item.id}: ${error.message}`);
            return [];
          }
        }));
        prompts.push(...histories.flat());
        cursor = result?.nextCursor || null;
        pageCount += 1;
        if (prompts.length >= 200 || pageCount >= 5) {
          capped = Boolean(cursor) || prompts.length > 200;
          break;
        }
      } while (cursor);

      prompts.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      this.promptHistoryCache = {
        loadedAt: Date.now(),
        items: prompts.slice(0, 200),
        capped
      };
    }

    const items = this.promptHistoryCache.items.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + items.length;
    return {
      items,
      offset: safeOffset,
      nextOffset,
      total: this.promptHistoryCache.items.length,
      hasMore: nextOffset < this.promptHistoryCache.items.length,
      capped: this.promptHistoryCache.capped
    };
  }

  contextStatus(tokenUsage = this.tokenUsage) {
    const usage = tokenUsage || {};
    const selectedModel = this.models.find(item => item.id === this.model);
    const contextWindow = Number(usage.modelContextWindow || usage.model_context_window
      || usage.contextWindow || usage.context_window || selectedModel?.contextWindow || 0);
    const last = usage.last || usage.lastTokenUsage || usage.last_token_usage || {};
    const usedTokens = Number(last.totalTokens || last.total_tokens || usage.contextTokens
      || usage.context_tokens || 0);
    if (!contextWindow) {
      return !this.threadId && !this.tokenUsage
        ? { usedTokens: 0, contextWindow: null, remainingTokens: null, remainingPercent: 100 }
        : null;
    }
    return {
      usedTokens: Math.max(0, usedTokens),
      contextWindow,
      remainingTokens: Math.max(0, contextWindow - usedTokens),
      remainingPercent: Math.max(0, Math.min(100, Math.round((contextWindow - usedTokens) / contextWindow * 100)))
    };
  }

  recordTurnContext(turnId, tokenUsage = this.tokenUsage) {
    const id = String(turnId || '').trim();
    const context = this.contextStatus(tokenUsage);
    if (!id || !context) return context;
    this.turnContexts.set(id, context);
    const turnEnd = this.messages.find(item => item.kind === 'turn-end' && String(item.turnId || '') === id);
    if (turnEnd) this.patch(turnEnd.id, { context });
    return context;
  }

  async showStatus() {
    if (this.presentation !== 'structured') return false;
    await this.ensureProcess();
    const accountResult = await this.request('account/read', { refreshToken: false });
    const account = accountResult?.account || null;
    let rateLimits = null;
    if (account?.type === 'chatgpt') {
      try {
        const result = await this.request('account/rateLimits/read', {});
        rateLimits = result?.rateLimits || null;
      } catch (error) {
        this.logger.debugInfo?.(`[codex-app-server] account/rateLimits/read failed: ${error.message}`);
      }
    }
    this.append({ kind: 'status', title: 'Codex status', model: this.model, effort: this.effort,
      account, rateLimits, context: this.contextStatus() });
    return true;
  }

  async updateSettings(settings = {}) {
    const configEdits = [];
    if (settings.model) configEdits.push({ keyPath: 'model', value: String(settings.model), mergeStrategy: 'upsert' });
    if (settings.effort) configEdits.push({ keyPath: 'model_reasoning_effort', value: String(settings.effort), mergeStrategy: 'upsert' });
    if (configEdits.length) {
      await this.ensureProcess();
      await this.request('config/batchWrite', { edits: configEdits });
      if (settings.model) this.configModel = String(settings.model);
      if (settings.effort) this.configEffort = String(settings.effort);
    }
    if (settings.permissionMode !== undefined) this.permissionMode = normalizePermissionMode(settings.permissionMode);
    if (settings.sandboxMode !== undefined) this.sandboxMode = normalizeSandboxMode(settings.sandboxMode);
    if (settings.model !== undefined) {
      this.hasModelOverride = Boolean(settings.model);
      this.model = settings.model || this.configModel || null;
    }
    if (settings.effort !== undefined) {
      this.hasEffortOverride = Boolean(settings.effort);
      this.effort = settings.effort || this.configEffort || null;
    }
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
      if (settings.model !== undefined) params.model = this.hasModelOverride ? this.model : null;
      if (settings.effort !== undefined) params.effort = this.hasEffortOverride ? this.effort : null;
      if (Object.keys(params).length > 1) await this.request('thread/settings/update', params);
    }
    this.emitEvent({ type: 'state', state: this.getControlState() });
    return this.getControlState();
  }

  async sendUserMessage(text, attachments = [], skills = []) {
    const prompt = String(text || '').trim();
    const images = (Array.isArray(attachments) ? attachments : [])
      .filter(item => item && typeof item.path === 'string' && item.path);
    if ((!prompt && images.length === 0) || this.presentation !== 'structured' || this.status !== 'idle') return false;
    this.hasUnreadCompletion = false;
    this.promptHistoryCache = null;
    this.append({
      kind: 'user',
      text: prompt || '📷 Image attachment',
      attachments: images.map(item => ({ id: item.id, name: item.name || 'image' })),
      skills: (Array.isArray(skills) ? skills : []).map(item => ({
        name: String(item?.name || ''), path: String(item?.path || '')
      })).filter(item => item.name && item.path)
    });
    try {
      await this.ensureProcess();
      if (!this.threadId) {
        const params = { cwd: this.workingDir };
        if (this.hasModelOverride) params.model = this.model;
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
      const input = [];
      input.push(...await this.resolveSkillInputs(skills));
      if (prompt) input.push({ type: 'text', text: prompt });
      for (const image of images) input.push({ type: 'localImage', path: image.path });
      const params = { threadId: this.threadId, input, cwd: this.workingDir, summary: 'auto' };
      if (this.hasModelOverride) params.model = this.model;
      if (this.hasEffortOverride) params.effort = this.effort;
      if (this.permissionMode) params.approvalPolicy = this.permissionMode;
      const sandboxPolicy = sandboxPolicyFor(this.sandboxMode, this.workingDir);
      if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
      const started = await this.request('turn/start', params);
      this.currentTurnId = started?.turn?.id || started?.turnId || this.currentTurnId;
      return true;
    } catch (error) {
      this.currentTurnId = null;
      this.currentTurnStartedAt = null;
      this.setStatus('idle');
      this.append({ kind: 'event', level: 'error', text: `Unable to send message: ${error.message}` });
      throw error;
    }
  }

  async compactContext() {
    if (!this.threadId || this.presentation !== 'structured' || this.status !== 'idle') return false;
    await this.ensureProcess();
    this.compacting = true;
    this.setStatus('running');
    try {
      await this.request('thread/compact/start', { threadId: this.threadId });
      return true;
    } catch (error) {
      this.compacting = false;
      this.setStatus('idle');
      this.append({ kind: 'event', level: 'error', text: `Unable to compact context: ${error.message}` });
      throw error;
    }
  }

  write(data) {
    if (this.presentation === 'terminal') return this.terminalSession?.write(data) || false;
    const text = String(data || '').replace(/\r/g, '\n');
    const prompt = text.trim();
    if (prompt) void this.sendUserMessage(prompt).catch(error => {
      this.logger.debugInfo?.(`[codex-app-server] send failed: ${error.message}`);
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
    const targets = Array.from(this.threadTurns.entries())
      .filter(([, turn]) => turn?.turnId && turn.status === 'running')
      .map(([threadId, turn]) => ({ threadId, turnId: turn.turnId }));
    if (this.threadId && this.currentTurnId
      && !targets.some(target => target.threadId === this.threadId && target.turnId === this.currentTurnId)) {
      targets.push({ threadId: this.threadId, turnId: this.currentTurnId });
    }
    for (const target of targets) {
      this.request('turn/interrupt', target).catch(error => {
        this.logger.debugInfo?.(`[codex-app-server] turn/interrupt failed for ${target.threadId}/${target.turnId}: ${error.message}`);
      });
    }
    this.append({ kind: 'event', level: 'info', text: reason });
    return true;
  }

  async resume(threadId = null) {
    const target = String(threadId || this.threadId || '').trim();
    if (!target || this.presentation !== 'structured' || this.status !== 'idle') return false;
    await this.ensureProcess();
    const selectedModel = this.model;
    const selectedEffort = this.effort;
    const resumeWithModelOverride = Boolean(this.hasModelOverride && selectedModel);
    const resumeWithEffortOverride = Boolean(this.hasEffortOverride && selectedEffort);
    const params = { threadId: target, cwd: this.workingDir };
    if (this.permissionMode) params.approvalPolicy = this.permissionMode;
    if (this.sandboxMode) params.sandbox = this.sandboxMode;
    if (resumeWithModelOverride) params.model = selectedModel;
    if (resumeWithEffortOverride) params.config = { model_reasoning_effort: selectedEffort };
    this.deferredWarnings = [];
    try {
      const result = await this.request('thread/resume', params);
      this.threadId = result.thread?.id || target;
      this.hasModelOverride = resumeWithModelOverride;
      this.hasEffortOverride = resumeWithEffortOverride;
      this.model = result.model || result.thread?.model || selectedModel;
      this.effort = result.reasoningEffort || result.thread?.reasoningEffort || selectedEffort;
      this.effectivePermissionMode = result.approvalPolicy || this.effectivePermissionMode;
      this.effectiveSandboxMode = sandboxModeFromPolicy(result.sandbox) || this.effectiveSandboxMode;
      const history = await this.request('thread/read', { threadId: this.threadId, includeTurns: true });
      this.restoreThreadHistory(history?.thread, `Resumed Codex thread ${this.threadId}`, {
        preserveModel: resumeWithModelOverride,
        preserveEffort: resumeWithEffortOverride
      });
      const warnings = this.deferredWarnings;
      this.deferredWarnings = null;
      for (const warning of warnings) this.append(warning);
      this.promptHistoryCache = null;
      return true;
    } catch (error) {
      const warnings = this.deferredWarnings || [];
      this.deferredWarnings = null;
      for (const warning of warnings) this.append(warning);
      throw error;
    }
  }

  restoreThreadHistory(thread, eventText = '', options = {}) {
    if (!options.preserveModel) this.model = thread?.model || this.model;
    if (!options.preserveEffort) this.effort = thread?.reasoningEffort || thread?.reasoning_effort || this.effort;
    this.tokenUsage = thread?.tokenUsage || thread?.token_usage || this.tokenUsage;
    this.messages = [];
    this.replayingHistory = true;
    this.completedPermissions = [];
    this.turnContexts.clear();
    this.providerItemContexts.clear();
    try {
      for (const turn of thread?.turns || []) {
      const status = turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'cancelled' : 'completed';
      const startedAt = Number(turn.startedAt || turn.createdAt || 0);
      const completedAt = Number(turn.completedAt || turn.updatedAt || 0);
      const toMilliseconds = value => value > 0 && value < 100000000000 ? value * 1000 : value;
      const startedAtMs = toMilliseconds(startedAt);
      const completedAtMs = toMilliseconds(completedAt);
      this.append({ kind: 'turn-start', turnId: turn.id, ...(startedAtMs ? { createdAt: startedAtMs } : {}) });
      for (const item of turn.items || []) {
        this.applyProviderItem({ ...item, turnId: turn.id }, status === 'failed' ? 'failed' : 'completed', {
          threadId: this.threadId,
          startedAtMs,
          completedAtMs
        });
      }
      const durationMs = Number(turn.durationMs || turn.duration_ms || 0)
        || (startedAtMs && completedAtMs && completedAtMs >= startedAtMs ? completedAtMs - startedAtMs : null);
      this.append({ kind: 'turn-end', turnId: turn.id, status, durationMs,
        ...(completedAtMs ? { createdAt: completedAtMs } : {}) });
      }
      if (eventText) this.append({ kind: 'event', level: 'info', text: eventText });
    } finally {
      this.replayingHistory = false;
    }
    this.emitEvent({ type: 'history-reset', messages: this.messages.map(item => this.toPublicMessage(item)) });
    this.emitEvent({ type: 'state', state: this.getControlState() });
  }

  async forkFrom(threadId) {
    const sourceThreadId = String(threadId || '').trim();
    if (!sourceThreadId || this.presentation !== 'structured' || this.status !== 'idle') return false;
    await this.ensureProcess();
    const params = { threadId: sourceThreadId, cwd: this.workingDir, ephemeral: false, threadSource: null };
    if (this.hasModelOverride) params.model = this.model;
    if (this.permissionMode) params.approvalPolicy = this.permissionMode;
    if (this.sandboxMode) params.sandbox = this.sandboxMode;
    const result = await this.request('thread/fork', params);
    const forkedThread = result?.thread;
    if (!forkedThread?.id) throw new Error('Codex did not return a forked thread');
    this.threadId = forkedThread.id;
    this.model = result.model || forkedThread.model || this.model;
    this.effort = result.reasoningEffort || forkedThread.reasoningEffort || forkedThread.reasoning_effort || this.effort;
    this.effectivePermissionMode = result.approvalPolicy || this.effectivePermissionMode;
    this.effectiveSandboxMode = sandboxModeFromPolicy(result.sandbox) || this.effectiveSandboxMode;
    this.restoreThreadHistory(forkedThread, `Forked from Codex thread ${sourceThreadId}`);
    this.promptHistoryCache = null;
    return { threadId: this.threadId };
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
module.exports.appServerSpawnOptions = appServerSpawnOptions;
