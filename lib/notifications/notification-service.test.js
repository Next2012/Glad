const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const NotificationService = require('./notification-service');

function createHarness() {
  const sessionManager = new EventEmitter();
  sessionManager.sessions = new Map();
  sessionManager.get = id => sessionManager.sessions.get(id) || null;
  const settings = {
    sendKey: 'SCT_TEST_SECRET',
    clientType: 'wechat'
  };
  const settingsStore = {
    get: () => ({ ...settings }),
    getPublic: () => ({
      configured: Boolean(settings.sendKey),
      maskedKey: 'SCT••••••••CRET',
      clientType: settings.clientType
    }),
    resolve: input => ({
      sendKey: input.sendKey || settings.sendKey,
      clientType: input.clientType || settings.clientType
    })
  };
  const sent = [];
  const channel = {
    send: async message => { sent.push(message); }
  };
  const errors = [];
  const service = new NotificationService({
    sessionManager,
    settingsStore,
    channel,
    logger: { error: message => errors.push(message) }
  });
  return { sessionManager, settings, sent, service, errors };
}

function createCodexSession() {
  return {
    id: 'session-1',
    name: 'Codex工作',
    kind: 'codex-structured',
    threadId: 'root-thread',
    startTime: Date.now(),
    workingDir: '/tmp/project',
    serverChanNotificationEnabled: true,
    pendingPermissions: new Map(),
    tool: { displayName: 'Codex' }
  };
}

async function flushNotifications() {
  await new Promise(resolve => setImmediate(resolve));
}

test('deduplicates approvals and only reports completion for the root Codex turn', async () => {
  const { sessionManager, sent, service } = createHarness();
  const session = createCodexSession();
  sessionManager.sessions.set(session.id, session);

  const approval = {
    sessionId: session.id,
    session,
    event: { type: 'permission-request', request: { id: 'approval-1' } }
  };
  sessionManager.emit('codex-event', approval);
  sessionManager.emit('codex-event', approval);
  sessionManager.emit('codex-event', {
    sessionId: session.id,
    session,
    event: {
      type: 'message',
      message: { id: 'child-end', kind: 'turn-end', threadId: 'child-thread', turnId: 'child-turn', status: 'completed' }
    }
  });
  sessionManager.emit('codex-event', {
    sessionId: session.id,
    session,
    event: {
      type: 'message',
      message: { id: 'root-end', kind: 'turn-end', threadId: 'root-thread', turnId: 'root-turn', status: 'completed' }
    }
  });
  await flushNotifications();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].title, '待审批｜Codex工作');
  assert.equal(sent[1].title, '已完成｜Codex工作');
  service.stop();
});

test('keeps new sessions disabled and refuses enabling without global configuration', async () => {
  const { sessionManager, settings, service } = createHarness();
  const session = createCodexSession();
  session.serverChanNotificationEnabled = false;
  sessionManager.sessions.set(session.id, session);
  settings.sendKey = '';

  await assert.rejects(
    service.setSessionEnabled(session.id, true),
    error => error.statusCode === 409 && error.code === 'SERVERCHAN_NOT_CONFIGURED'
  );
  assert.equal(session.serverChanNotificationEnabled, false);
  service.stop();
});

test('sends the current pending approval when a configured session is enabled', async () => {
  const { sessionManager, sent, service } = createHarness();
  const session = createCodexSession();
  session.serverChanNotificationEnabled = false;
  session.pendingPermissions.set('approval-existing', { id: 'approval-existing' });
  sessionManager.sessions.set(session.id, session);

  const state = await service.setSessionEnabled(session.id, true);

  assert.equal(state.enabled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '待审批｜Codex工作');
  service.stop();
});
