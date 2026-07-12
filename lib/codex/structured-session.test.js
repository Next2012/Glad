const test = require('node:test');
const assert = require('node:assert/strict');
const CodexStructuredSession = require('./structured-session');

function createSession() {
  return new CodexStructuredSession({
    id: 'test-session',
    tool: { key: 'codex', displayName: 'Codex', command: 'codex' },
    workingDir: '/tmp',
    name: 'Test',
    logger: {}
  });
}

test('merges provider user messages and maps Codex tools semantically', () => {
  const session = createSession();
  session.append({ kind: 'user', text: 'hello' });
  session.applyProviderItem({ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] });
  session.applyProviderItem({ id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: '/tmp', status: 'completed', aggregatedOutput: '/tmp\n', exitCode: 0 });
  session.applyProviderItem({ id: 'patch-1', type: 'fileChange', status: 'completed', changes: [{ path: 'a.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }] });
  session.applyProviderItem({ id: 'mcp-1', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { q: 'codex' }, result: 'ok', status: 'completed' });

  assert.equal(session.messages.filter(item => item.kind === 'user').length, 1);
  assert.equal(session.messages.find(item => item.providerId === 'cmd-1').name, 'CodexBash');
  assert.equal(session.messages.find(item => item.providerId === 'patch-1').name, 'CodexPatch');
  assert.equal(session.messages.find(item => item.providerId === 'mcp-1').title, 'docs.search');
});

test('routes MCP elicitation through permission UI and preserves its decision', () => {
  const session = createSession();
  const responses = [];
  session.respond = (id, result) => responses.push({ id, result });

  session.handleServerRequest({ id: 7, method: 'mcpServer/elicitation/request', params: {
    serverName: 'happy', message: 'Allow tool "change_title"?', mode: 'form', _meta: { tool_params: { title: 'New' } }
  } });
  const request = Array.from(session.pendingPermissions.values())[0].public;
  assert.equal(request.status, 'pending');
  assert.equal(session.respondPermission(request.id, 'approved_for_session'), true);
  assert.deepEqual(responses[0], { id: 7, result: { action: 'accept', content: {}, _meta: null } });
  assert.equal(session.completedPermissions[0].decision, 'approved_for_session');
});

test('uses current Codex approval wire decisions', () => {
  const session = createSession();
  const responses = [];
  session.respond = (id, result) => responses.push({ id, result });
  session.handleServerRequest({ id: 8, method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd-2', command: 'git status' } });
  session.respondPermission('cmd-2', 'approved_for_session');
  assert.deepEqual(responses[0], { id: 8, result: { decision: 'acceptForSession' } });
});

test('marks completed web searches as completed even when the item omits status', () => {
  const session = createSession();
  session.currentTurnId = 'turn-web';

  session.handleNotification('item/started', { item: { id: 'web-1', type: 'webSearch', query: 'Codex' } });
  assert.equal(session.messages.find(item => item.providerId === 'web-1').toolStatus, 'running');

  session.handleNotification('item/completed', { item: { id: 'web-1', type: 'webSearch', query: 'Codex' } });
  assert.equal(session.messages.find(item => item.providerId === 'web-1').toolStatus, 'completed');

  session.applyProviderItem({ id: 'web-history', type: 'webSearch', status: 'inProgress' }, 'completed');
  assert.equal(session.messages.find(item => item.providerId === 'web-history').toolStatus, 'completed');
});

test('seals unfinished tool states and duration when a turn completes', () => {
  const session = createSession();
  session.currentTurnId = 'turn-finish';
  session.currentTurnStartedAt = Date.now() - 2500;
  session.applyProviderItem({ id: 'web-2', type: 'webSearch', turnId: 'turn-finish' });

  session.handleNotification('turn/completed', { turn: { id: 'turn-finish', status: 'completed' } });

  assert.equal(session.messages.find(item => item.providerId === 'web-2').toolStatus, 'completed');
  const turnEnd = session.messages.find(item => item.kind === 'turn-end' && item.turnId === 'turn-finish');
  assert.ok(turnEnd.durationMs >= 2400 && turnEnd.durationMs < 4000);
});

test('renders subscription account limits and context through status', async () => {
  const session = createSession();
  session.model = 'gpt-test';
  session.effort = 'high';
  session.ensureProcess = async () => {};
  session.request = async method => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' } };
    if (method === 'account/rateLimits/read') return { rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 200 }
    } };
    return {};
  };
  session.handleNotification('thread/tokenUsage/updated', { tokenUsage: {
    last: { totalTokens: 25000 }, modelContextWindow: 100000
  } });

  assert.equal(await session.showStatus(), true);

  const status = session.messages.find(item => item.kind === 'status');
  assert.equal(status.account.planType, 'plus');
  assert.equal(status.rateLimits.primary.usedPercent, 20);
  assert.deepEqual(status.context, {
    usedTokens: 25000, contextWindow: 100000, remainingTokens: 75000, remainingPercent: 75
  });
});

test('shows API-key context without requesting ChatGPT rate limits', async () => {
  const session = createSession();
  const methods = [];
  session.models = [{ id: 'api-model', contextWindow: 200000 }];
  session.model = 'api-model';
  session.ensureProcess = async () => {};
  session.request = async method => {
    methods.push(method);
    if (method === 'account/read') return { account: { type: 'apiKey' } };
    return {};
  };

  assert.equal(await session.showStatus(), true);

  const status = session.messages.find(item => item.kind === 'status');
  assert.deepEqual(methods, ['account/read']);
  assert.equal(status.rateLimits, null);
  assert.equal(status.context.remainingPercent, 100);
});

test('inherits config defaults when sandbox and approvals are left on default', async () => {
  const session = createSession();
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  };

  await session.sendUserMessage('hello');

  const threadStart = requests.find(item => item.method === 'thread/start').params;
  const turnStart = requests.find(item => item.method === 'turn/start').params;
  assert.equal('approvalPolicy' in threadStart, false);
  assert.equal('sandbox' in threadStart, false);
  assert.equal('approvalPolicy' in turnStart, false);
  assert.equal('sandboxPolicy' in turnStart, false);
  assert.equal(session.getControlState().permissionMode, 'default');
  assert.equal(session.getControlState().sandboxMode, 'default');
});

test('inherits the effective Codex model and effort for a new thread', async () => {
  const session = createSession();
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'config/read') return { config: {
      model: 'configured-model',
      model_reasoning_effort: 'high'
    } };
    if (method === 'model/list') return { data: [
      { id: 'catalog-default', isDefault: true, defaultReasoningEffort: 'medium' },
      { id: 'configured-model', defaultReasoningEffort: 'low' }
    ] };
    if (method === 'thread/start') return { thread: { id: 'thread-config' } };
    if (method === 'turn/start') return { turn: { id: 'turn-config' } };
    return {};
  };

  await session.refreshConfigDefaults();
  await session.refreshModels();
  await session.sendUserMessage('hello');

  assert.equal(session.model, 'configured-model');
  assert.equal(session.effort, 'high');
  const threadStart = requests.find(item => item.method === 'thread/start').params;
  const turnStart = requests.find(item => item.method === 'turn/start').params;
  assert.equal('model' in threadStart, false);
  assert.equal('model' in turnStart, false);
  assert.equal('effort' in turnStart, false);
});

test('sends an explicit Glad model selection as an app-server override', async () => {
  const session = createSession();
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-override' } };
    if (method === 'turn/start') return { turn: { id: 'turn-override' } };
    return {};
  };

  await session.updateSettings({ model: 'glad-model', effort: 'xhigh' });
  await session.sendUserMessage('hello');

  const configWrite = requests.find(item => item.method === 'config/batchWrite').params;
  assert.deepEqual(configWrite, { edits: [
    { keyPath: 'model', value: 'glad-model', mergeStrategy: 'upsert' },
    { keyPath: 'model_reasoning_effort', value: 'xhigh', mergeStrategy: 'upsert' }
  ] });
  const threadStart = requests.find(item => item.method === 'thread/start').params;
  const turnStart = requests.find(item => item.method === 'turn/start').params;
  assert.equal(threadStart.model, 'glad-model');
  assert.equal(turnStart.model, 'glad-model');
  assert.equal(turnStart.effort, 'xhigh');
});

test('maps explicit sandbox and approval selections to app-server overrides', async () => {
  const session = createSession();
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-2' } };
    if (method === 'turn/start') return { turn: { id: 'turn-2' } };
    return {};
  };
  await session.updateSettings({ permissionMode: 'never', sandboxMode: 'danger-full-access' });

  await session.sendUserMessage('hello');

  const threadStart = requests.find(item => item.method === 'thread/start').params;
  const turnStart = requests.find(item => item.method === 'turn/start').params;
  assert.equal(threadStart.approvalPolicy, 'never');
  assert.equal(threadStart.sandbox, 'danger-full-access');
  assert.equal(turnStart.approvalPolicy, 'never');
  assert.deepEqual(turnStart.sandboxPolicy, { type: 'dangerFullAccess' });
});

test('restores effective config values when an active thread switches back to default', async () => {
  const session = createSession();
  const requests = [];
  session.threadId = 'thread-3';
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'config/read') return { config: {
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    } };
    return {};
  };

  await session.updateSettings({ permissionMode: 'default', sandboxMode: 'default' });

  const update = requests.find(item => item.method === 'thread/settings/update').params;
  assert.equal(update.approvalPolicy, 'never');
  assert.deepEqual(update.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(session.getControlState().permissionMode, 'default');
  assert.equal(session.getControlState().sandboxMode, 'default');
});

test('resumes with the stored thread model without changing config', async () => {
  const session = createSession();
  const requests = [];
  session.model = 'current-config-model';
  session.effort = 'medium';
  session.hasModelOverride = true;
  session.hasEffortOverride = true;
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: 'stored-thread', model: 'stored-model', reasoningEffort: 'high' } };
    if (method === 'thread/read') return { thread: { id: 'stored-thread', model: 'stored-model', reasoningEffort: 'high', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'resumed-turn' } };
    return {};
  };

  assert.equal(await session.resume('stored-thread'), true);

  const resumeRequest = requests.find(item => item.method === 'thread/resume').params;
  assert.equal('model' in resumeRequest, false);
  assert.equal(requests.some(item => item.method === 'config/batchWrite'), false);
  assert.equal(session.model, 'stored-model');
  assert.equal(session.effort, 'high');
  assert.equal(session.hasModelOverride, false);
  assert.equal(session.hasEffortOverride, false);

  await session.sendUserMessage('continue');
  const turnStart = requests.find(item => item.method === 'turn/start').params;
  assert.equal('model' in turnStart, false);
  assert.equal('effort' in turnStart, false);
});

test('persists a model selected after resume', async () => {
  const session = createSession();
  const requests = [];
  session.threadId = 'stored-thread';
  session.model = 'stored-model';
  session.ensureProcess = async () => {};
  session.request = async (method, params) => { requests.push({ method, params }); return {}; };

  await session.updateSettings({ model: 'new-model', effort: 'xhigh' });

  assert.ok(requests.some(item => item.method === 'config/batchWrite'));
  const update = requests.find(item => item.method === 'thread/settings/update').params;
  assert.equal(update.model, 'new-model');
  assert.equal(update.effort, 'xhigh');
});
