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

test('uses a shell for the Windows npm Codex command shim', () => {
  const env = { PATH: 'C:\\Users\\xing\\AppData\\Roaming\\npm' };

  assert.deepEqual(CodexStructuredSession.appServerSpawnOptions({ cwd: 'D:\\Test', env, platform: 'win32' }), {
    cwd: 'D:\\Test',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true
  });
  assert.deepEqual(CodexStructuredSession.appServerSpawnOptions({ cwd: '/tmp', env, platform: 'linux' }), {
    cwd: '/tmp',
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
});

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

test('sends local image paths alongside text through the Codex app-server', async () => {
  const requests = [];
  const session = createSession();
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-images' } };
    if (method === 'turn/start') return { turn: { id: 'turn-images' } };
    return {};
  };

  await session.sendUserMessage('describe this', [{ id: 'image-1', name: 'image.png', path: '/tmp/glad/image.png' }]);

  const turn = requests.find(item => item.method === 'turn/start');
  assert.deepEqual(turn.params.input, [
    { type: 'text', text: 'describe this' },
    { type: 'localImage', path: '/tmp/glad/image.png' }
  ]);
});

test('returns to idle and reports an error when starting a Codex turn fails', async () => {
  const session = createSession();
  session.threadId = 'existing-thread';
  session.ensureProcess = async () => {};
  session.request = async method => {
    assert.equal(method, 'turn/start');
    throw new Error('request timed out');
  };

  await assert.rejects(session.sendUserMessage('hello'), /request timed out/);

  assert.equal(session.status, 'idle');
  assert.equal(session.currentTurnId, null);
  assert.equal(session.messages.filter(item => item.kind === 'user').length, 1);
  assert.match(session.messages.at(-1).text, /Unable to send message: request timed out/);
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

test('keeps collab wait empty when Codex provides no result', () => {
  const session = createSession();
  session.applyProviderItem({
    id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress',
    senderThreadId: 'root-thread', receiverThreadIds: [], agentsStates: {}
  });

  const wait = session.messages.find(item => item.providerId === 'wait-1');
  assert.equal(wait.name, 'Agent');
  assert.equal(wait.title, 'wait');
  assert.equal(wait.result, '');
  assert.deepEqual(wait.input, {});
  assert.equal(wait.subagentId, null);
});

test('isolates root and subagent turn lifecycle and timing', () => {
  const session = createSession();
  session.threadId = 'root-thread';

  session.handleNotification('turn/started', {
    threadId: 'root-thread', turn: { id: 'root-turn', startedAt: 1000 }
  });
  session.handleNotification('turn/started', {
    threadId: 'child-thread', turn: { id: 'child-turn', startedAt: 1002 }
  });
  session.handleNotification('item/started', {
    threadId: 'child-thread', turnId: 'child-turn', startedAtMs: 1002500,
    item: { id: 'child-command', type: 'commandExecution', command: 'sleep 10', cwd: '/tmp' }
  });

  assert.equal(session.currentTurnId, 'root-turn');
  assert.equal(session.status, 'running');
  assert.equal(session.getControlState().activeSubagentCount, 1);
  assert.equal(session.messages.find(item => item.providerId === 'child-command').turnId, 'child-turn');

  session.handleNotification('thread/status/changed', { threadId: 'child-thread', status: { type: 'idle' } });
  assert.equal(session.status, 'running');

  session.handleNotification('turn/completed', {
    threadId: 'child-thread',
    turn: { id: 'child-turn', status: 'completed', completedAt: 1012, durationMs: 10000 }
  });
  assert.equal(session.currentTurnId, 'root-turn');
  assert.equal(session.status, 'running');
  assert.equal(session.getControlState().activeSubagentCount, 0);
  assert.equal(session.messages.find(item => item.providerId === 'child-command').durationMs, 9500);

  session.handleNotification('turn/completed', {
    threadId: 'root-thread',
    turn: { id: 'root-turn', status: 'completed', completedAt: 1014, durationMs: 14000 }
  });
  assert.equal(session.currentTurnId, null);
  assert.equal(session.status, 'idle');
  assert.equal(session.messages.find(item => item.kind === 'turn-end' && item.turnId === 'root-turn').durationMs, 14000);
});

test('keeps subagent identity on streamed agent messages', () => {
  const session = createSession();
  session.threadId = 'root-thread';
  session.handleNotification('turn/started', {
    threadId: 'child-thread', turn: { id: 'child-turn', startedAt: 1000 }
  });
  session.handleNotification('item/started', {
    threadId: 'child-thread', turnId: 'child-turn',
    item: { id: 'child-message', type: 'agentMessage', text: '' }
  });
  session.handleNotification('item/agentMessage/delta', {
    itemId: 'child-message', delta: 'child answer'
  });

  const message = session.messages.find(item => item.providerId === 'child-message');
  assert.equal(message.text, 'child answer');
  assert.equal(message.threadId, 'child-thread');
  assert.equal(message.turnId, 'child-turn');
});

test('aborts every active Codex thread with its matching turn id', async () => {
  const session = createSession();
  const requests = [];
  session.threadId = 'root-thread';
  session.currentTurnId = 'root-turn';
  session.status = 'running';
  session.threadTurns.set('root-thread', { turnId: 'root-turn', startedAt: 1000, status: 'running' });
  session.threadTurns.set('child-thread', { turnId: 'child-turn', startedAt: 2000, status: 'running' });
  session.request = async (method, params) => { requests.push({ method, params }); return {}; };

  assert.equal(session.abort(), true);
  await Promise.resolve();

  assert.deepEqual(requests, [
    { method: 'turn/interrupt', params: { threadId: 'root-thread', turnId: 'root-turn' } },
    { method: 'turn/interrupt', params: { threadId: 'child-thread', turnId: 'child-turn' } }
  ]);
});

test('keeps late item completion from erasing cancelled status and duration', () => {
  const session = createSession();
  session.threadId = 'root-thread';
  session.handleNotification('turn/started', {
    threadId: 'root-thread', turn: { id: 'root-turn', startedAt: 1000 }
  });
  session.handleNotification('item/started', {
    threadId: 'root-thread', turnId: 'root-turn', startedAtMs: 1001000,
    item: { id: 'cmd-cancel', type: 'commandExecution', command: 'sleep 30', cwd: '/tmp' }
  });
  session.handleNotification('turn/completed', {
    threadId: 'root-thread', turn: { id: 'root-turn', status: 'interrupted', completedAt: 1005, durationMs: 5000 }
  });
  session.handleNotification('item/completed', {
    threadId: 'root-thread', turnId: 'root-turn', completedAtMs: 1001000,
    item: { id: 'cmd-cancel', type: 'commandExecution', command: 'sleep 30', cwd: '/tmp', status: 'completed' }
  });

  const command = session.messages.find(item => item.providerId === 'cmd-cancel');
  assert.equal(command.toolStatus, 'cancelled');
  assert.equal(command.durationMs, 4000);
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

test('attaches context remaining to its turn before or after completion', () => {
  const session = createSession();
  session.threadId = 'root-thread';

  session.handleNotification('turn/started', {
    threadId: 'root-thread', turn: { id: 'turn-before', startedAt: 1000 }
  });
  session.handleNotification('thread/tokenUsage/updated', {
    threadId: 'root-thread', turnId: 'turn-before', tokenUsage: {
      last: { totalTokens: 45000 }, total: { totalTokens: 90000 }, modelContextWindow: 100000
    }
  });
  session.handleNotification('turn/completed', {
    threadId: 'root-thread', turn: { id: 'turn-before', status: 'completed', completedAt: 1002 }
  });

  assert.deepEqual(session.messages.find(item => item.kind === 'turn-end' && item.turnId === 'turn-before').context, {
    usedTokens: 45000, contextWindow: 100000, remainingTokens: 55000, remainingPercent: 55
  });

  session.handleNotification('turn/started', {
    threadId: 'root-thread', turn: { id: 'turn-after', startedAt: 1003 }
  });
  session.handleNotification('turn/completed', {
    threadId: 'root-thread', turn: { id: 'turn-after', status: 'completed', completedAt: 1004 }
  });
  session.handleNotification('thread/tokenUsage/updated', {
    threadId: 'root-thread', turnId: 'turn-after', tokenUsage: {
      last: { totalTokens: 62000 }, total: { totalTokens: 152000 }, modelContextWindow: 100000
    }
  });

  assert.deepEqual(session.messages.find(item => item.kind === 'turn-end' && item.turnId === 'turn-after').context, {
    usedTokens: 62000, contextWindow: 100000, remainingTokens: 38000, remainingPercent: 38
  });
});

test('renders one context compaction item and starts manual compaction through app-server', async () => {
  const session = createSession();
  session.threadId = 'root-thread';
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => { requests.push({ method, params }); return {}; };

  assert.equal(await session.compactContext(), true);
  assert.deepEqual(requests, [{ method: 'thread/compact/start', params: { threadId: 'root-thread' } }]);
  assert.equal(session.compacting, true);
  assert.equal(session.status, 'running');

  session.handleNotification('item/started', {
    threadId: 'root-thread', turnId: 'compact-turn',
    item: { id: 'compact-item', type: 'contextCompaction' }
  });
  session.handleNotification('item/completed', {
    threadId: 'root-thread', turnId: 'compact-turn',
    item: { id: 'compact-item', type: 'contextCompaction' }
  });
  session.handleNotification('thread/compacted', { threadId: 'root-thread', turnId: 'compact-turn' });

  const compactions = session.messages.filter(item => item.kind === 'compaction');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].compactionStatus, 'completed');
  assert.equal(session.compacting, false);
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

test('lists the two most recent user questions for each resume thread', async () => {
  const session = createSession();
  session.threadId = 'current-thread';
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    if (method === 'thread/list') return { data: [
      { id: 'current-thread', sessionId: 'session-1', preview: 'First question', updatedAt: 100, cwd: '/tmp' },
      { id: 'single-turn', preview: 'Only question', updatedAt: 90, cwd: '/tmp' },
      { id: 'child-thread', parentThreadId: 'current-thread', preview: 'child' }
    ] };
    assert.equal(method, 'thread/read');
    if (params.threadId === 'current-thread') return { thread: { turns: [
      { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'First question' }] }] },
      { items: [{ type: 'agentMessage', text: 'Answer' },
        { type: 'userMessage', content: [{ type: 'text', text: 'Second question' }] }] },
      { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Latest question' }] }] }
    ] } };
    return { thread: { turns: [
      { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Only question' }] }] }
    ] } };
  };

  const items = await session.listResumeThreads();

  assert.deepEqual(items, [{
    id: 'current-thread', sessionId: 'session-1', questions: ['Latest question', 'Second question'],
    updatedAt: 100000, cwd: '/tmp', current: true
  }, {
    id: 'single-turn', sessionId: 'single-turn', questions: ['Only question', ''],
    updatedAt: 90000, cwd: '/tmp', current: false
  }]);
});

test('forks a Codex thread and hydrates the new session from provider history', async () => {
  const session = createSession();
  const requests = [];
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/fork') return {
      thread: {
        id: 'thread-forked',
        model: 'fork-model',
        reasoningEffort: 'high',
        turns: [{
          id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 102,
          items: [
            { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
            { id: 'agent-1', type: 'agentMessage', text: 'hi' }
          ]
        }]
      },
      model: 'fork-model',
      reasoningEffort: 'high'
    };
    return {};
  };

  const result = await session.forkFrom('thread-source');

  assert.deepEqual(result, { threadId: 'thread-forked' });
  assert.deepEqual(requests, [{
    method: 'thread/fork',
    params: { threadId: 'thread-source', cwd: '/tmp', ephemeral: false, threadSource: null }
  }]);
  assert.equal(session.threadId, 'thread-forked');
  assert.equal(session.model, 'fork-model');
  assert.equal(session.messages.find(item => item.providerId === 'user-1').text, 'hello');
  assert.equal(session.messages.find(item => item.providerId === 'user-1').createdAt, 100000);
  assert.equal(session.messages.find(item => item.providerId === 'agent-1').text, 'hi');
  assert.equal(session.messages.find(item => item.providerId === 'agent-1').completedAtMs, 102000);
  assert.match(session.messages.at(-1).text, /Forked from Codex thread thread-source/);
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

test('resumes with the stored thread model when no explicit override is selected', async () => {
  const session = createSession();
  const requests = [];
  session.model = 'current-config-model';
  session.effort = 'medium';
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

test('resumes with an explicit model override and preserves the official warning after history replay', async () => {
  const session = createSession();
  const requests = [];
  session.model = 'model-b';
  session.effort = 'xhigh';
  session.hasModelOverride = true;
  session.hasEffortOverride = true;
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/resume') {
      session.handleNotification('warning', {
        threadId: 'stored-thread',
        message: 'This session was recorded with model A but is resuming with model B.'
      });
      return { thread: { id: 'stored-thread', model: 'model-b', reasoningEffort: 'xhigh' }, model: 'model-b', reasoningEffort: 'xhigh' };
    }
    if (method === 'thread/read') return { thread: { id: 'stored-thread', model: 'model-a', reasoningEffort: 'high', turns: [] } };
    return {};
  };

  assert.equal(await session.resume('stored-thread'), true);

  const resumeRequest = requests.find(item => item.method === 'thread/resume').params;
  assert.equal(resumeRequest.model, 'model-b');
  assert.deepEqual(resumeRequest.config, { model_reasoning_effort: 'xhigh' });
  assert.equal(session.model, 'model-b');
  assert.equal(session.effort, 'xhigh');
  assert.equal(session.hasModelOverride, true);
  assert.equal(session.hasEffortOverride, true);
  const warning = session.messages.find(item => item.level === 'warning');
  assert.ok(warning);
  assert.match(warning.text, /recorded with model A/);
  assert.ok(session.messages.indexOf(warning) > session.messages.findIndex(item => item.text?.startsWith('Resumed Codex thread')));
});

test('lists prompt history in pages, newest first, with a hard 200 item cap', async () => {
  const session = createSession();
  let threadListRequests = 0;
  session.ensureProcess = async () => {};
  session.request = async (method, params) => {
    if (method === 'thread/list') {
      threadListRequests += 1;
      return { data: [{ id: 'prompt-thread', updatedAt: 500 }] };
    }
    assert.equal(method, 'thread/read');
    assert.equal(params.threadId, 'prompt-thread');
    return { thread: {
      id: 'prompt-thread',
      turns: Array.from({ length: 205 }, (_, index) => ({
        id: `turn-${index}`,
        startedAt: index + 1,
        items: [{ id: `prompt-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${index}` }] }]
      }))
    } };
  };

  const first = await session.listPromptHistory({ offset: 0, limit: 30 });
  const second = await session.listPromptHistory({ offset: 30, limit: 30 });

  assert.equal(first.items.length, 30);
  assert.equal(first.items[0].text, 'Prompt 204');
  assert.equal(first.total, 200);
  assert.equal(first.hasMore, true);
  assert.equal(first.capped, true);
  assert.equal(second.items[0].text, 'Prompt 174');
  assert.equal(second.nextOffset, 60);
  assert.equal(threadListRequests, 1);
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
