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
