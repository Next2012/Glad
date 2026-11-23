const { test, expect } = require('@playwright/test');
const fs = require('node:fs');

// Real browser WebSockets and the fixture CLI behind the actual Glad handler.
// Do not replace this transport with routeWebSocket: negotiation/framing is the
// regression boundary. Linux WebKit is not Apple's NSURLSession implementation.
async function openSession(page, testInfo) {
  const connections = [], sent = [], received = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws') return;
    connections.push(socket);
    socket.on('framesent', frame => {
      try { sent.push(JSON.parse(String(frame.payload))); } catch (_) {}
    });
    socket.on('framereceived', frame => {
      try { received.push(JSON.parse(String(frame.payload))); } catch (_) {}
    });
  });
  const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
    await page.waitForFunction(() => activeSessionHydrated && currentSocket?.readyState === WebSocket.OPEN);
    await expect(page.locator('#send-btn')).toBeEnabled();
    const negotiation = await page.evaluate(() => {
      window.__transportSocket = currentSocket;
      window.__transportCloses = [];
      currentSocket.addEventListener('close', event => window.__transportCloses.push({ code: event.code, reason: event.reason }));
      return { userAgent: navigator.userAgent, extensions: currentSocket.extensions, threadId: codexState.threadId || '' };
    });
    const negotiationPath = testInfo.outputPath('websocket-negotiation.json');
    fs.writeFileSync(negotiationPath, JSON.stringify(negotiation, null, 2));
    await testInfo.attach('websocket-negotiation.json', { path: negotiationPath, contentType: 'application/json' });
    if (/AppleWebKit/i.test(negotiation.userAgent) && !/(?:Chrome|Chromium|Edg|OPR)\//i.test(negotiation.userAgent)) {
      expect(negotiation.extensions).not.toMatch(/permessage-deflate/i);
    } else if (/(?:Chrome|Chromium)\//i.test(negotiation.userAgent)) {
      expect(negotiation.extensions).toMatch(/permessage-deflate/i);
    }
    return { id, connections, sent, received, errors, negotiation };
  } catch (error) {
    await page.request.delete(`/api/sessions/${id}`);
    throw error;
  }
}

async function sendAndComplete(page, session, text, turns) {
  await expect(page.locator('#send-btn')).toBeEnabled();
  await page.locator('#cmd-input').fill(text);
  await page.locator('#send-btn').click();
  await expect(page.locator('#cmd-input')).toHaveValue('');
  await page.waitForFunction(() => codexState.status === 'idle' && !composerPendingSend);
  await expect.poll(async () => {
    const snapshot = await (await page.request.get(`/api/sessions/${session.id}`)).json();
    return snapshot.messages.filter(message => message.kind === 'turn-end').length;
  }).toBe(turns);
}

async function assertHistory(page, session, texts) {
  const snapshot = await (await page.request.get(`/api/sessions/${session.id}`)).json();
  expect(snapshot.messages.filter(message => message.kind === 'user').map(message => message.text)).toEqual(texts);
  const inputs = session.sent.filter(message => message.type === 'codex-input');
  expect(inputs.map(message => message.text)).toEqual(texts);
  expect(new Set(inputs.map(message => message.clientMessageId)).size).toBe(texts.length);
  expect(session.received.filter(message => message.type === 'send-result' && message.accepted)
    .map(message => message.clientMessageId).sort()).toEqual(inputs.map(message => message.clientMessageId).sort());
  expect(session.errors).toEqual([]);
  await expect(page.locator('#app-toast')).not.toContainText('Sending result is unconfirmed');
}

test('real socket accepts first thread identity and long UTF-8 without reconnecting or duplicating', async ({ page }, testInfo) => {
  const session = await openSession(page, testInfo);
  try {
    expect(session.negotiation.threadId).toBe('');
    expect(session.received.find(message => message.type === 'codex-snapshot')?.snapshot.messages).toEqual([]);
    await sendAndComplete(page, session, 'hello', 1);
    await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe('thread-e2e');
    expect(session.received.some(message => message.type === 'codex-event'
      && message.event?.type === 'history-reset' && message.event.state?.threadId === 'thread-e2e')).toBe(true);
    const text = '长中文消息传输：你好，世界。'.repeat(2000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(32768);
    await sendAndComplete(page, session, text, 2);
    await assertHistory(page, session, ['hello', text]);
    expect(session.connections).toHaveLength(1);
    expect(await page.evaluate(() => currentSocket === window.__transportSocket && currentSocket.readyState === WebSocket.OPEN)).toBe(true);
    expect(await page.evaluate(() => window.__transportCloses)).toEqual([]);
  } finally {
    await page.request.delete(`/api/sessions/${session.id}`);
  }
});

test('real socket reconnect restores its snapshot and continues the same native thread', async ({ page }, testInfo) => {
  const session = await openSession(page, testInfo);
  try {
    await sendAndComplete(page, session, 'Before transport recovery', 1);
    await page.evaluate(() => currentSocket.close(1000, 'Transport recovery regression'));
    await expect(page.locator('#send-btn')).toBeDisabled();
    await page.waitForFunction(() => currentSocket !== window.__transportSocket
      && currentSocket?.readyState === WebSocket.OPEN && activeSessionHydrated);
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toContainText('Before transport recovery');
    expect(await page.evaluate(() => codexState.threadId)).toBe('thread-e2e');
    expect(await page.evaluate(() => currentSocket.extensions)).toBe(session.negotiation.extensions);
    await sendAndComplete(page, session, 'After transport recovery', 2);
    await assertHistory(page, session, ['Before transport recovery', 'After transport recovery']);
    expect(session.connections).toHaveLength(2);
    expect(session.received.filter(message => message.type === 'codex-snapshot')).toHaveLength(2);
    expect(await page.evaluate(() => window.__transportCloses)).toEqual([{ code: 1000, reason: 'Transport recovery regression' }]);
  } finally {
    await page.request.delete(`/api/sessions/${session.id}`);
  }
});
