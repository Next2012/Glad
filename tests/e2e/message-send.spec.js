const { conversationView, closeConversation } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

async function openCodexSession(page) {
  const sent = [];
  page.on('websocket', socket => socket.on('framesent', event => {
    try { sent.push(JSON.parse(String(event.payload))); } catch (_) {}
  }));
  const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
  return { id, sent };
}

test('large UTF-8 input is acknowledged without reconnecting or duplicating the turn', async ({ page }) => {
  const { id, sent } = await openCodexSession(page);
  const text = '长消息传输回归。'.repeat(4000);
  expect(Buffer.byteLength(JSON.stringify({ type: 'codex-input', text }))).toBeGreaterThan(32768);
  try {
    await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
    await (await conversationView(page)).evaluate(() => {
      window.__largeInputSocket = currentSocket;
      window.__largeInputCloses = [];
      currentSocket.addEventListener('close', event => window.__largeInputCloses.push(event.code));
    });
    await (await conversationView(page)).locator('#cmd-input').fill(text);
    await (await conversationView(page)).locator('#send-btn').click();
    await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('');
    await expect.poll(async () => (await (await page.request.get(`/api/sessions/${id}`)).json()).messages.filter(message => message.kind === 'turn-end').length).toBe(1);
    const snapshot = await (await page.request.get(`/api/sessions/${id}`)).json();
    expect(snapshot.messages.filter(message => message.kind === 'user').map(message => message.text)).toEqual([text]);
    expect(sent.filter(message => message.type === 'codex-input')).toHaveLength(1);
    expect(await (await conversationView(page)).evaluate(() => currentSocket === window.__largeInputSocket && currentSocket.readyState === WebSocket.OPEN)).toBe(true);
    expect(await (await conversationView(page)).evaluate(() => window.__largeInputCloses)).toEqual([]);
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('Codex composer reconnects after its WebSocket closes', async ({ page }) => {
  const { id } = await openCodexSession(page);
  await (await conversationView(page)).evaluate(() => {
    window.__closedSocket = currentSocket;
    currentSocket.close();
  });
  await (await conversationView(page)).waitForFunction(() => currentSocket !== window.__closedSocket
    && currentSocket?.readyState === WebSocket.OPEN);
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  await (await conversationView(page)).locator('#cmd-input').fill('Reply after reconnect');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('.codex-message-block.user')).toContainText('Reply after reconnect');
  await page.request.delete(`/api/sessions/${id}`);
});

test('structured send is acknowledged, idempotent, and preserves rejected drafts', async ({ page }) => {
  const first = await openCodexSession(page);
  await (await conversationView(page)).locator('#attachment-file-input').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment body')
  });
  await (await conversationView(page)).locator('.attachment-chip:not(.uploading)').waitFor();
  await (await conversationView(page)).locator('#cmd-input').fill('Read the attachment and keep this visible');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('');
  await expect((await conversationView(page)).locator('.codex-message-block.user')).toHaveCount(1);
  await expect((await conversationView(page)).locator('.codex-message-block.user')).toContainText('Read the attachment and keep this visible');
  await expect((await conversationView(page)).locator('.codex-message-block.user')).toContainText('notes.txt');
  await page.waitForTimeout(500);
  const history = await (await page.request.get(`/api/sessions/${first.id}/history`)).json();
  expect((history.text.match(/User:/g) || [])).toHaveLength(1);
  expect(history.text).not.toContain('/tmp/glad/attachments');
  const firstFrame = first.sent.find(item => item.type === 'codex-input');
  expect(firstFrame.clientMessageId).toBeTruthy();
  await page.request.delete(`/api/sessions/${first.id}`);

  const missing = await openCodexSession(page);
  await (await conversationView(page)).locator('#attachment-file-input').setInputFiles({
    name: 'missing.txt', mimeType: 'text/plain', buffer: Buffer.from('remove before send')
  });
  await (await conversationView(page)).locator('.attachment-chip:not(.uploading)').waitFor();
  const attachmentId = await (await conversationView(page)).evaluate(() => selectedFileAttachments[0].id);
  await page.request.delete(`/api/sessions/${missing.id}/attachments/files/${attachmentId}`);
  await (await conversationView(page)).locator('#cmd-input').fill('This draft must survive');
  const rejection = page.waitForEvent('dialog').then(async dialog => {
    await dialog.dismiss();
    return dialog;
  });
  await (await conversationView(page)).locator('#send-btn').click();
  const dialog = await rejection;
  expect(dialog.message()).toContain('attachments are no longer available');
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('This draft must survive');
  await expect((await conversationView(page)).locator('.attachment-chip')).toContainText('missing.txt');
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  expect((await (await page.request.get(`/api/sessions/${missing.id}/history`)).json()).text).toBe('');
  await page.request.delete(`/api/sessions/${missing.id}`);

  const idempotent = await openCodexSession(page);
  await (await conversationView(page)).evaluate(() => {
    const payload = {
      type: 'codex-input', clientMessageId: 'same-message-id', text: 'Only once', attachmentIds: [], skills: []
    };
    currentSocket.send(JSON.stringify(payload));
    currentSocket.send(JSON.stringify(payload));
  });
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${idempotent.id}/history`)).json()).text)
    .toContain('User: Only once');
  const idempotentHistory = await (await page.request.get(`/api/sessions/${idempotent.id}/history`)).json();
  expect((idempotentHistory.text.match(/User:/g) || [])).toHaveLength(1);
  await page.request.delete(`/api/sessions/${idempotent.id}`);
});

test('disconnected and whitespace-only sends keep the draft', async ({ page }) => {
  const session = await openCodexSession(page);
  await (await conversationView(page)).locator('#cmd-input').fill('Keep this after disconnect');
  await (await conversationView(page)).evaluate(() => currentSocket.close());
  await expect((await conversationView(page)).locator('#send-btn')).toBeDisabled();
  await (await conversationView(page)).evaluate(() => performSend());
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('Keep this after disconnect');
  expect(session.sent.filter(item => item.type === 'codex-input')).toHaveLength(0);
  await page.request.delete(`/api/sessions/${session.id}`);

  const whitespace = await openCodexSession(page);
  await (await conversationView(page)).locator('#cmd-input').fill('   \n  ');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('   \n  ');
  expect(whitespace.sent.filter(item => item.type === 'codex-input')).toHaveLength(0);
  await page.request.delete(`/api/sessions/${whitespace.id}`);
});

test('completion dots only mark work finished outside the visible session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPhone 17 Pro Max', 'Completion visibility regression runs once');
  test.setTimeout(30000);
  const session = await openCodexSession(page);
  await page.route(`**/api/sessions/${session.id}/completion/read`, async route => {
    const revision = Number(route.request().postDataJSON()?.revision) || 0;
    if (revision > 0) await new Promise(resolve => setTimeout(resolve, 400));
    await route.continue();
  });

  await (await conversationView(page)).locator('#cmd-input').fill('visible completion');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  await closeConversation(page);
  await expect(page.locator(`.session-card[data-session-id="${session.id}"] .completion-dot`)).toHaveCount(0);
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    return sessions.find(item => item.id === session.id)?.hasUnreadCompletion;
  }).toBe(false);

  await page.locator(`.session-card[data-session-id="${session.id}"]`).getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).locator('#cmd-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__');
  await (await conversationView(page)).locator('#send-btn').click();
  await closeConversation(page);
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    return sessions.find(item => item.id === session.id)?.hasUnreadCompletion;
  }).toBe(true);
  await page.evaluate(() => refreshSessionsNow());
  await expect(page.locator(`.session-card[data-session-id="${session.id}"] .completion-dot`)).toBeVisible();

  await page.locator(`.session-card[data-session-id="${session.id}"]`).getByRole('button', { name: 'Connect' }).click();
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    return sessions.find(item => item.id === session.id)?.hasUnreadCompletion;
  }).toBe(false);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('visible tiled previews acknowledge completed work', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Tiled completion regression runs once on desktop');
  test.setTimeout(30000);
  const session = await openCodexSession(page);

  await page.evaluate(() => toggleTiledMode());
  const tile = page.locator(`.tile-session-window[data-session-id="${session.id}"]`);
  await expect(tile).toBeVisible();
  await tile.getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).locator('#cmd-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    return sessions.find(item => item.id === session.id)?.status;
  }).toBe('running');
  await page.getByRole('button', { name: 'Return to tiled view' }).click();
  await expect(page.locator('#tile-workspace')).toBeVisible();
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    const current = sessions.find(item => item.id === session.id);
    return `${current?.status}:${current?.hasUnreadCompletion}`;
  }).toBe('idle:false');
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('provider rejection keeps the draft and unlocks send', async ({ page }) => {
  const session = await openCodexSession(page);
  const text = '__GLAD_E2E_FAIL_SEND__ keep this draft';
  await (await conversationView(page)).locator('#cmd-input').fill(text);
  const rejection = page.waitForEvent('dialog').then(async dialog => {
    await dialog.dismiss();
    return dialog;
  });
  await (await conversationView(page)).evaluate(() => {
    document.getElementById('send-btn').click();
    document.getElementById('cmd-input').value = '';
  });
  const dialog = await rejection;
  expect(dialog.message()).toContain('forced send failure');
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue(text);
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  await expect((await conversationView(page)).locator('.codex-message-block.user')).toHaveCount(0);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('large Codex command output still reaches turn completion', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Large stdout regression runs once on desktop');
  test.setTimeout(60000);
  const session = await openCodexSession(page);
  await (await conversationView(page)).locator('#cmd-input').fill('__GLAD_E2E_LARGE_OUTPUT__');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('');
  await expect((await conversationView(page)).locator('.codex-tool')).toContainText('large-output', { timeout: 30000 });
  await (await conversationView(page)).waitForFunction(() => codexState.status === 'idle', null, { timeout: 30000 });
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled({ timeout: 30000 });
  const debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('Codex tracks active subagents without marking the root turn idle', async ({ page }) => {
  const session = await openCodexSession(page);
  await (await conversationView(page)).locator('#cmd-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__');
  await (await conversationView(page)).locator('#send-btn').click();

  const subagentJump = (await conversationView(page)).getByRole('button', { name: 'Jump to active subagent' });
  await expect(subagentJump).toContainText('1 subagent running');
  await expect.poll(async () => {
    const debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
    return debug.diagnostics.status;
  }).toBe('running');
  await expect((await conversationView(page)).locator('#codex-abort-btn')).toBeEnabled();
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  await expect((await conversationView(page)).locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
  await expect(subagentJump).toHaveCount(0);

  await expect((await conversationView(page)).locator('.codex-message-block.assistant')).toContainText('root completed after child');
  await (await conversationView(page)).waitForFunction(() => codexState.status === 'idle');
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  const debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('stuck Codex interrupt force-recovers and restarts before the next send', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Abort watchdog regression runs once on desktop');
  test.setTimeout(60000);
  const session = await openCodexSession(page);
  await (await conversationView(page)).locator('#cmd-input').fill('__GLAD_E2E_STUCK_ABORT__');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('.codex-tool')).toContainText('stuck-command');
  await (await conversationView(page)).locator('#codex-abort-btn').click();
  await expect((await conversationView(page)).locator('#codex-state-bar')).toContainText('Stopping Codex');
  await (await conversationView(page)).waitForFunction(() => codexState.status === 'idle', null, { timeout: 15000 });
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled({ timeout: 15000 });
  let debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');

  await (await conversationView(page)).locator('#cmd-input').fill('works after forced restart');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('.codex-message-block.user').last()).toContainText('works after forced restart');
  await (await conversationView(page)).waitForFunction(() => codexState.status === 'idle', null, { timeout: 15000 });
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled({ timeout: 15000 });
  debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('Codex resume can be stopped before a turn id exists', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Resume abort regression runs once on desktop');
  test.setTimeout(60000);
  const session = await openCodexSession(page);
  await (await conversationView(page)).evaluate(sessionId => {
    window.__resumeAbortResult = null;
    fetch(`/api/sessions/${sessionId}/codex-resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'stuck-resume-e2e' })
    }).then(async response => ({ status: response.status, body: await response.json() }))
      .then(result => { window.__resumeAbortResult = result; });
  }, session.id);
  await expect((await conversationView(page)).locator('#codex-state-bar')).toContainText('Resuming conversation');
  await (await conversationView(page)).locator('#codex-abort-btn').click();
  await expect.poll(async () => (await conversationView(page)).evaluate(() => window.__resumeAbortResult)).not.toBeNull();
  const result = await (await conversationView(page)).evaluate(() => window.__resumeAbortResult);
  expect(result.status).toBe(400);
  expect(result.body.error).toContain('resume aborted');
  await (await conversationView(page)).waitForFunction(() => codexState.status === 'idle', null, { timeout: 15000 });
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled({ timeout: 15000 });
  const debug = await (await page.request.get(`/api/sessions/${session.id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('large paginated Codex history publishes one reset to two WebSockets', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Large resume regression runs once on desktop');
  test.setTimeout(60000);
  const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
  await (await conversationView(page)).evaluate(() => {
    window.__mainHistoryResetCount = 0;
    const original = window.applyCodexEvent;
    window.applyCodexEvent = event => {
      if (event?.type === 'history-reset') window.__mainHistoryResetCount += 1;
      return original(event);
    };
  });
  await (await conversationView(page)).evaluate(async sessionId => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
    window.__historyEvents = [[]];
    window.__historySockets = window.__historyEvents.map((events, index) => {
      const socket = new WebSocket(url);
      socket.onmessage = message => {
        try { events.push(JSON.parse(message.data)); } catch (_) {}
      };
      socket.__index = index;
      return socket;
    });
    await Promise.all(window.__historySockets.map(socket => new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    })));
  }, id);
  await expect.poll(async () => {
    const debug = await (await page.request.get(`/api/sessions/${id}/debug`)).json();
    return debug.diagnostics.clients;
  }).toBe(2);
  await (await conversationView(page)).evaluate(() => window.__historyEvents.forEach(events => { events.length = 0; }));

  const started = Date.now();
  const resumed = await page.request.post(`/api/sessions/${id}/codex-resume`, {
    data: { threadId: 'large-history-e2e' }, timeout: 30000
  });
  expect(resumed.ok(), await resumed.text()).toBe(true);
  expect(Date.now() - started).toBeLessThan(30000);
  await expect.poll(async () => (await conversationView(page)).evaluate(() => window.__historyEvents.map(events => events
    .filter(message => message.type === 'codex-event' && message.event?.type === 'history-reset').length)))
    .toEqual([1]);
  await expect.poll(async () => (await conversationView(page)).evaluate(() => window.__mainHistoryResetCount)).toBe(1);
  await expect.poll(async () => (await conversationView(page)).evaluate(() => codexMessages.length)).toBeGreaterThan(0);
  expect(await (await conversationView(page)).evaluate(() => codexMessages.length)).toBeLessThanOrEqual(128);
  await expect((await conversationView(page)).getByRole('button', { name: 'Load earlier messages', exact: true })).toBeVisible();
  const legacyReset = await (await conversationView(page)).evaluate(() => window.__historyEvents[0].find(message => message.event?.type === 'history-reset'));
  expect(legacyReset.event.messages).toHaveLength(1480);
  const incrementalCounts = await (await conversationView(page)).evaluate(() => window.__historyEvents.map(events => events
    .filter(message => message.type === 'codex-event' && ['message', 'message-updated'].includes(message.event?.type)).length));
  expect(incrementalCounts).toEqual([0]);
  const debug = await (await page.request.get(`/api/sessions/${id}/debug`)).json();
  expect(debug.diagnostics.status).toBe('idle');
  expect(debug.diagnostics.messages).toBe(1480);
  await (await conversationView(page)).evaluate(() => window.__historySockets.forEach(socket => socket.close()));
  await page.request.delete(`/api/sessions/${id}`);
});
