const { test, expect } = require('@playwright/test');

const providers = [
  { key: 'codex', type: 'codex', connect: 'connectCodexSocket', container: '#codex-chat-container' },
  { key: 'claude-code', type: 'claude', connect: 'connectClaudeSocket', container: '#claude-chat-container' },
  { key: 'antigravity', type: 'antigravity', connect: 'connectAntigravitySocket', container: '#antigravity-chat-container' }
];
function snapshot(provider, id, messages = []) {
  return { type: `${provider.type}-snapshot`, snapshot: { id, name: 'Restored fixture', status: 'idle', messages, pendingPermissions: [], state: { status: 'idle', threadId: 'native-fixture', nativeConversationId: 'native-fixture', canAbort: false, canSteer: false, commands: [], configOptions: [] } } };
}
async function harness(page, provider) {
  const id = `socket-ready-${provider.type}`;
  const sockets = [], frames = [], dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.routeWebSocket(url => url.pathname === '/ws' && url.searchParams.get('sessionId') === id, socket => {
    sockets.push(socket);
    socket.onMessage(value => { try { frames.push(JSON.parse(String(value))); } catch (_) {} });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(({ id, key, connect }) => {
    activeSessionId = id; activeToolKey = key; activeSessionHydrated = true;
    claudeStatus = 'idle'; claudeStatusPending = false;
    claudeState = { ...claudeState, status: 'idle', canAbort: false, commands: [] };
    codexState = { ...createDefaultCodexState(), status: 'idle' };
    antigravityState = { ...createDefaultAntigravityState(), status: 'idle' };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(key === 'claude-code');
    if (key === 'codex') installCodexLazyDetailHandler();
    window[connect](id);
  }, { id, key: provider.key, connect: provider.connect });
  await expect.poll(() => sockets.length).toBe(1);
  await page.waitForFunction(() => currentSocket.readyState === WebSocket.OPEN);
  return { id, sockets, frames, dialogs };
}

for (const provider of providers) {
  test(`${provider.type}: OPEN waits for this connection's snapshot before enabling Send`, async ({ page }) => {
    const fixture = await harness(page, provider);
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send disabled while restoring conversation');
    await expect(page.locator('#send-btn')).toHaveAttribute('title', 'Waiting for the restored conversation snapshot');
    expect(await page.evaluate(() => activeSessionHydrated)).toBe(false);
    await page.locator('#cmd-input').fill('Keep this draft while restoring');
    await page.evaluate(() => performSend());
    expect(fixture.frames).toHaveLength(0);
    fixture.sockets[0].send(JSON.stringify(snapshot(provider, fixture.id)));
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send');
    expect(await page.evaluate(() => activeSessionHydrated)).toBe(true);
    await expect(page.locator('#cmd-input')).toHaveValue('Keep this draft while restoring');
    expect(fixture.frames.filter(frame => frame.type.endsWith('-input'))).toHaveLength(0);
    expect(fixture.dialogs).toEqual([]);
  });

  test(`${provider.type}: unconfirmed close keeps drafts, restores before Send and ignores old socket callbacks`, async ({ page }) => {
    const fixture = await harness(page, provider);
    fixture.sockets[0].send(JSON.stringify(snapshot(provider, fixture.id)));
    await expect(page.locator('#send-btn')).toBeEnabled();
    await page.evaluate(id => {
      selectedFileAttachments = [{ id: 'kept-attachment', sessionId: id, name: 'draft.txt' }]; renderComposerAttachments();
      window.__oldReadyCallbacks = { open: currentSocket.onopen, message: currentSocket.onmessage, close: currentSocket.onclose };
    }, fixture.id);
    await page.locator('#cmd-input').fill('Unconfirmed original draft');
    await page.locator('#send-btn').click();
    await expect.poll(() => fixture.frames.filter(frame => frame.type === `${provider.type}-input`).length).toBe(1);
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send disabled while awaiting confirmation');
    const closeCode = provider.type === 'antigravity' ? 1009 : 1001;
    fixture.sockets[0].close({ code: closeCode, reason: 'Fixture disconnect before acknowledgement' });
    await expect(page.locator('#app-toast')).toContainText('Sending result is unconfirmed');
    if (closeCode === 1009) await expect(page.locator('#app-toast')).toContainText('message was too large');
    await expect(page.locator('#cmd-input')).toHaveValue('Unconfirmed original draft');
    await expect(page.locator('.attachment-chip')).toContainText('draft.txt');
    await expect.poll(() => fixture.sockets.length).toBe(2);
    await page.waitForFunction(() => currentSocket.readyState === WebSocket.OPEN);
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send disabled while restoring conversation');
    // A TCP/WebSocket handshake alone must not reset reconnect backoff.
    expect(await page.evaluate(() => structuredReconnectDelay)).toBe(2000);
    const acceptedWithoutAck = { id: 'accepted-original', kind: 'user', text: 'Unconfirmed original draft', createdAt: 1700000000000 };
    fixture.sockets[1].send(JSON.stringify(snapshot(provider, fixture.id, [acceptedWithoutAck])));
    await expect(page.locator('#send-btn')).toBeEnabled();
    expect(await page.evaluate(() => structuredReconnectDelay)).toBe(1000);
    await expect(page.locator(provider.container)).toContainText('Unconfirmed original draft');
    await expect(page.locator('#cmd-input')).toHaveValue('Unconfirmed original draft');
    expect(fixture.frames.filter(frame => frame.type === `${provider.type}-input`)).toHaveLength(1);
    await page.locator('#cmd-input').fill('A new manual draft');
    await page.locator('#send-btn').click();
    await expect.poll(() => fixture.frames.filter(frame => frame.type === `${provider.type}-input`).length).toBe(2);
    const latest = fixture.frames.filter(frame => frame.type === `${provider.type}-input`).at(-1);
    await page.evaluate(({ type, clientMessageId }) => {
      window.__oldReadyCallbacks.open({});
      window.__oldReadyCallbacks.close({ code: 1009 });
      window.__oldReadyCallbacks.message({ data: JSON.stringify({ type: `${type}-snapshot`, snapshot: { name: 'STALE SOCKET', messages: [], status: 'running', state: { status: 'running' } } }) });
      window.__oldReadyCallbacks.message({ data: JSON.stringify({ type: 'send-result', clientMessageId, accepted: true }) });
    }, { type: provider.type, clientMessageId: latest.clientMessageId });
    await expect(page.locator('#cmd-input')).toHaveValue('A new manual draft');
    await expect(page.locator('.attachment-chip')).toContainText('draft.txt');
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send disabled while awaiting confirmation');
    expect(await page.evaluate(() => activeSessionHydrated)).toBe(true);
    fixture.sockets[1].send(JSON.stringify({ type: 'send-result', clientMessageId: latest.clientMessageId, accepted: true }));
    await expect(page.locator('#cmd-input')).toHaveValue('');
    await expect(page.locator('.attachment-chip')).toHaveCount(0);
    await expect(page.locator('#send-btn')).toBeEnabled();
    expect(fixture.dialogs).toEqual([]);
  });
}

for (const provider of providers.filter(item => item.type !== 'claude')) {
  test(`${provider.type}: overloaded detail requests settle without automatic retry storms and allow manual retry`, async ({ page }) => {
    const fixture = await harness(page, provider);
    fixture.sockets[0].send(JSON.stringify(snapshot(provider, fixture.id, [{ id: 'overloaded-tool', kind: 'tool', title: 'Waiting native detail', toolStatus: 'completed', hasDetail: true, detailLoaded: false }])));
    await expect(page.locator('#send-btn')).toBeEnabled();
    await page.evaluate(type => {
      if (type === 'codex') window.__detailOutcome = requestCodexDetails({ ids: ['overloaded-tool'] });
      else requestAntigravityDetails('overloaded-tool');
    }, provider.type);
    await expect.poll(() => fixture.frames.filter(frame => frame.type === `${provider.type}-detail-request`).length).toBe(1);
    const request = fixture.frames.find(frame => frame.type === `${provider.type}-detail-request`);
    fixture.sockets[0].send(JSON.stringify({ type: 'error', commandRejected: true, requestType: request.type, requestId: request.requestId, message: 'Session command queue is full. Retry this request.' }));
    await expect(page.locator('#app-toast')).toContainText('command queue is full');
    if (provider.type === 'codex') expect(await page.evaluate(() => window.__detailOutcome)).toBe(false);
    expect(await page.evaluate(type => type === 'codex' ? codexDetailRequests.size : antigravityDetailRequests.size, provider.type)).toBe(0);
    await page.evaluate(async type => {
      for (let i = 0; i < 4; i++) {
        if (type === 'codex') await requestCodexDetails({ ids: ['overloaded-tool'] });
        else requestAntigravityDetails('overloaded-tool');
      }
    }, provider.type);
    expect(fixture.frames.filter(frame => frame.type === request.type)).toHaveLength(1);
    await page.locator(`${provider.container} .codex-work-group > summary`).first().click();
    if (provider.type === 'antigravity') {
      await page.locator(`${provider.container} .antigravity-tool > summary`).click();
      await page.locator(`${provider.container} [data-agy-detail="overloaded-tool"]`).click();
    }
    await expect.poll(() => fixture.frames.filter(frame => frame.type === request.type).length).toBe(2);
    const retry = fixture.frames.filter(frame => frame.type === request.type).at(-1);
    if (provider.type === 'codex') await page.evaluate(requestId => { window.__retryDetailOutcome = codexDetailRequests.get(requestId).promise; }, retry.requestId);
    fixture.sockets[0].send(JSON.stringify({ type: `${provider.type}-detail-response`, requestId: retry.requestId, detail: { messages: [{ id: 'overloaded-tool', kind: 'tool', title: 'Loaded after retry', toolStatus: 'completed', result: 'Native detail' }] } }));
    if (provider.type === 'codex') expect(await page.evaluate(() => window.__retryDetailOutcome)).toBe(true);
    await expect(page.locator(provider.container)).toContainText('Loaded after retry');
    expect(await page.evaluate(type => type === 'codex' ? codexDetailRequests.size : antigravityDetailRequests.size, provider.type)).toBe(0);
    if (provider.type === 'codex') {
      await page.evaluate(() => { codexStatusPending = true; });
      fixture.sockets[0].send(JSON.stringify({ type: 'error', commandRejected: true, requestType: 'codex-status', message: 'Status queue is full. Retry later.' }));
      await expect.poll(() => page.evaluate(() => codexStatusPending)).toBe(false);
    }
  });
}


test('Claude clears old readiness before awaiting runtime configuration', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  let configRequest;
  await page.route('**/api/claude-config', route => { configRequest = route; });
  await page.evaluate(() => {
    activeSessionId = 'initializing-claude'; activeToolKey = 'claude-code'; activeSessionHydrated = true;
    claudeStatus = 'idle'; claudeStatusPending = false;
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    setClaudeModeEnabled(true); syncComposerSendState();
    window.__beforeClaudeInitEnabled = !document.getElementById('send-btn').disabled;
    connectClaudeSocket = () => {};
    window.__claudeInitialization = initClaudeSession(activeSessionId);
  });
  await expect.poll(() => Boolean(configRequest)).toBe(true);
  expect(await page.evaluate(() => window.__beforeClaudeInitEnabled)).toBe(true);
  await expect(page.locator('#send-btn')).toBeDisabled();
  await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Send disabled while restoring conversation');
  expect(await page.evaluate(() => activeSessionHydrated)).toBe(false);
  await configRequest.continue();
  await page.evaluate(() => window.__claudeInitialization);
  await expect(page.locator('#send-btn')).toBeDisabled();
});

test('a rejected Claude status command leaves its loading state and permits retry', async ({ page }) => {
  const provider = providers.find(item => item.type === 'claude');
  const fixture = await harness(page, provider);
  fixture.sockets[0].send(JSON.stringify(snapshot(provider, fixture.id)));
  await expect(page.locator('#send-btn')).toBeEnabled();
  await page.evaluate(() => requestClaudeStatus());
  await expect.poll(() => fixture.frames.filter(frame => frame.type === 'claude-status').length).toBe(1);
  fixture.sockets[0].send(JSON.stringify({ type: 'error', commandRejected: true, requestType: 'claude-status', message: 'Status command queue is full. Retry later.' }));
  await expect(page.locator('#claude-info-content')).toContainText('queue is full');
  expect(await page.evaluate(() => claudeStatusPending)).toBe(false);
  await expect(page.locator('#claude-info-retry')).toBeEnabled();
  await page.locator('#claude-info-retry').click();
  await expect.poll(() => fixture.frames.filter(frame => frame.type === 'claude-status').length).toBe(2);
  fixture.sockets[0].send(JSON.stringify({ type: 'error', commandRejected: true, requestType: 'claude-status', message: 'Status command queue is full. Retry later.' }));
  await expect.poll(() => page.evaluate(() => claudeStatusPending)).toBe(false);
});
