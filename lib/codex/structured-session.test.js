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
