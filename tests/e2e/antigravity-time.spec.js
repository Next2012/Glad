const { conversationView } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

const chat = '#antigravity-chat-container';
const message = id => `${chat} [data-agy-key="message-${id}"]`;

async function saveEvidence(page, testInfo, name) {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: false, scale: 'css', animations: 'disabled' });
  await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
}

async function createSession(page) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity', name: 'Antigravity message times' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).waitForFunction(() => activeSessionHydrated && antigravityState.status === 'idle');
  return id;
}

async function nativeMessageTimes(page) {
  return (await conversationView(page)).evaluate(() => antigravityMessages.filter(item => ['user', 'assistant'].includes(item.kind) && item.text).map(item => ({
    id: item.id, kind: item.kind, streaming: Boolean(item.streaming),
    timestamp: item.kind === 'assistant' ? item.completedAtMs : item.createdAt
  })));
}

async function expectNativeTimes(page, expected) {
  for (const item of expected) {
    expect(item.streaming).toBe(false);
    expect(Number.isFinite(item.timestamp)).toBe(true);
    expect(item.timestamp).toBeGreaterThan(0);
    const time = (await conversationView(page)).locator(`${message(item.id)} .codex-message-meta > time.antigravity-message-time`);
    await expect(time).toBeVisible();
    await expect(time).toHaveAttribute('datetime', new Date(item.timestamp).toISOString());
    await expect(time).toHaveAttribute('title', /\S/);
  }
}

async function openTimeHarness(page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await (await conversationView(page)).evaluate(() => {
    activeSessionId = 'antigravity-time-harness';
    activeToolKey = 'antigravity';
    activeSessionHydrated = true;
    antigravityPendingPermissions = [];
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    antigravityMessages = [
      { id: 'known-user', kind: 'user', text: 'A prompt with a trustworthy sent time.', createdAt: 1700000000123, updatedAt: Date.now() },
      { id: 'known-assistant', kind: 'assistant', text: 'A finished answer with a trustworthy completion time.', createdAt: 1700000001000, completedAtMs: 1700000002456, updatedAt: Date.now() },
      { id: 'native-start-assistant', kind: 'assistant', text: 'An imported answer with its original native start time.', createdAt: 1700000003000, timeSource: 'native', updatedAt: Date.now() },
      { id: 'unknown-user', kind: 'user', text: 'An imported prompt without its original timestamp.', createdAt: 0, updatedAt: Date.now() },
      { id: 'unknown-assistant', kind: 'assistant', text: 'An imported answer with no trustworthy original timestamp.', createdAt: null, timeSource: 'unknown', updatedAt: Date.now() },
      { id: 'invalid-user', kind: 'user', text: 'An imported prompt with an invalid timestamp.', createdAt: -1 },
      { id: 'invalid-assistant', kind: 'assistant', text: 'An imported answer with an out-of-range timestamp.', completedAtMs: 9e20 },
      { id: 'streaming-assistant', kind: 'assistant', text: 'An answer that is still being generated.', createdAt: 1700000004000, updatedAt: Date.now(), streaming: true }
    ];
    antigravityState = { ...createDefaultAntigravityState(), status: 'running', turnId: 'time-turn', canAbort: true, canSteer: true };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    applyAntigravityState(antigravityState);
    handleComposerSocketOpen();
  });
  await expect((await conversationView(page)).locator(message('known-user'))).toBeVisible();
}

async function expectKnownAndUnknownTimes(scope) {
  await expect(scope.locator('[data-agy-key="message-known-user"] time')).toHaveAttribute('datetime', '2023-11-14T22:13:20.123Z');
  await expect(scope.locator('[data-agy-key="message-known-assistant"] time')).toHaveAttribute('datetime', '2023-11-14T22:13:22.456Z');
  await expect(scope.locator('[data-agy-key="message-known-assistant"] time')).toHaveAttribute('title', /^Completed at /);
  await expect(scope.locator('[data-agy-key="message-native-start-assistant"] time')).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
  await expect(scope.locator('[data-agy-key="message-native-start-assistant"] time')).toHaveAttribute('title', /^Message started at /);
  for (const id of ['unknown-user', 'unknown-assistant', 'invalid-user', 'invalid-assistant']) {
    const block = scope.locator(`[data-agy-key="message-${id}"]`);
    await expect(block.locator('time[datetime]')).toHaveCount(0);
    await expect(block.locator('[data-agy-time-unknown="true"]')).toHaveText('Time unknown');
  }
}

test('live Antigravity sent and completion times survive steering and reconnect', async ({ page }, testInfo) => {
  const id = await createSession(page);
  try {
    await (await conversationView(page)).locator('#cmd-input').fill('agy-long');
    await (await conversationView(page)).locator('#send-btn').click();
    await expect((await conversationView(page)).locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
    await expect((await conversationView(page)).locator(chat)).toContainText('AGY working before steering');
    const original = await (await conversationView(page)).evaluate(() => antigravityMessages.find(item => item.kind === 'user'));
    expect(original.createdAt).toBeGreaterThan(0);
    await expect((await conversationView(page)).locator(`${message(original.id)} time`)).toHaveAttribute('datetime', new Date(original.createdAt).toISOString());
    const generating = (await conversationView(page)).locator(`${chat} .codex-message-block.assistant`).filter({ hasText: 'AGY working before steering' });
    await expect(generating.locator('time')).toHaveCount(0);
    await (await conversationView(page)).locator('#cmd-input').fill('Keep the timestamp on this steering instruction.');
    await (await conversationView(page)).locator('#send-btn').click();
    await expect((await conversationView(page)).locator(chat)).toContainText('AGY original turn completed after steering');
    await (await conversationView(page)).waitForFunction(() => antigravityState.status === 'idle');
    const expected = await nativeMessageTimes(page);
    expect(expected.filter(item => item.kind === 'user')).toHaveLength(2);
    expect(expected.some(item => item.kind === 'assistant')).toBe(true);
    await expectNativeTimes(page, expected);
    await expect((await conversationView(page)).locator('#antigravity-state-bar .codex-context-meter')).toHaveCount(0);
    await expect((await conversationView(page)).locator(`${chat} .codex-context-meter`)).toHaveCount(1);
    await expect((await conversationView(page)).locator(`${chat} .codex-message-block.assistant .codex-message-meta .codex-context-meter`)).toHaveCount(1);
    const steering = await (await conversationView(page)).evaluate(() => antigravityMessages.find(item => item.kind === 'user' && item.text.includes('steering instruction')));
    expect(steering.createdAt).toBeGreaterThanOrEqual(original.createdAt);
    await saveEvidence(page, testInfo, 'antigravity-live-steering-times');
    await (await conversationView(page)).evaluate(() => { window.__timeOldSocket = currentSocket; currentSocket.close(); });
    await (await conversationView(page)).waitForFunction(() => currentSocket !== window.__timeOldSocket && currentSocket?.readyState === WebSocket.OPEN);
    await expect.poll(() => nativeMessageTimes(page)).toEqual(expected);
    await expectNativeTimes(page, expected);

    if (page.viewportSize().width >= 920) {
      await page.evaluate(() => toggleTiledMode());
      const tile = page.locator(`.tile-session-window[data-session-id="${id}"]`);
      for (const item of expected) {
        await expect(tile.locator(`[data-agy-key="message-${item.id}"] time`)).toHaveAttribute('datetime', new Date(item.timestamp).toISOString());
      }
      await saveEvidence(page, testInfo, 'antigravity-tile-message-times');
    }
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('Antigravity timestamps use trusted fields and remain legible at 375px in both themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openTimeHarness(page);
  await expectKnownAndUnknownTimes((await conversationView(page)).locator(chat));
  await expect((await conversationView(page)).locator(`${message('streaming-assistant')} .antigravity-message-time`)).toHaveCount(0);
  await (await conversationView(page)).evaluate(() => applyAntigravityEvent({ type: 'message-updated', message: {
    ...antigravityMessages.find(item => item.id === 'streaming-assistant'), streaming: false,
    text: 'The generated answer is complete.', completedAtMs: 1700000005789
  }, state: { status: 'idle', canAbort: false, canSteer: false } }));
  await expect((await conversationView(page)).locator(`${message('streaming-assistant')} time`)).toHaveAttribute('datetime', '2023-11-14T22:13:25.789Z');
  for (const theme of ['light', 'dark']) {
    await (await conversationView(page)).evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const geometry = await (await conversationView(page)).locator(`${chat} .antigravity-message-time`).evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      const block = element.closest('.codex-message-block').getBoundingClientRect();
      const bubble = element.closest('.codex-message-block').querySelector('.codex-message').getBoundingClientRect();
      return {
        fitsViewport: box.left >= 0 && box.right <= innerWidth + 1,
        fitsMessage: box.left >= block.left - 1 && box.right <= block.right + 1,
        belowText: box.top >= bubble.bottom - 1,
        readable: box.width > 0 && box.height >= 10
      };
    }));
    expect(geometry.length).toBe(8);
    for (const item of geometry) expect(item).toEqual({ fitsViewport: true, fitsMessage: true, belowText: true, readable: true });
    expect(await (await conversationView(page)).evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await saveEvidence(page, testInfo, `antigravity-message-times-${theme}-375`);
  }
  await (await conversationView(page)).evaluate(() => {
    for (const item of antigravityMessages) item.updatedAt = Date.now() + 60000;
    renderAntigravityChat();
  });
  await expectKnownAndUnknownTimes((await conversationView(page)).locator(chat));
  await expect((await conversationView(page)).locator(`${message('streaming-assistant')} time`)).toHaveAttribute('datetime', '2023-11-14T22:13:25.789Z');
});

test('read-only preview and tile renderers preserve known and unknown message times', async ({ page }, testInfo) => {
  await openTimeHarness(page);
  await (await conversationView(page)).evaluate(() => {
    const messages = JSON.parse(JSON.stringify(antigravityMessages));
    const host = document.getElementById('antigravity-chat-container');
    host.innerHTML = '<section data-testid="time-preview"></section><section data-testid="time-tile"></section>';
    const preview = host.querySelector('[data-testid="time-preview"]');
    preview.innerHTML = buildAntigravityConversationHtml(messages, [], { status: 'idle' }, { sessionId: 'time-preview' });
    makeTileConversationReadOnly(preview);
    const tile = host.querySelector('[data-testid="time-tile"]');
    tile.innerHTML = tileConversationHtml({ id: 'time-tile', toolKey: 'antigravity' }, {
      hydrated: true, messages, permissions: [], status: 'idle', state: { status: 'idle' }
    });
    makeTileConversationReadOnly(tile);
  });
  const preview = (await conversationView(page)).getByTestId('time-preview');
  const tile = (await conversationView(page)).getByTestId('time-tile');
  await expectKnownAndUnknownTimes(preview);
  await expectKnownAndUnknownTimes(tile);
  expect(await preview.locator('time').evaluateAll(times => times.map(time => time.dateTime)))
    .toEqual(await tile.locator('time').evaluateAll(times => times.map(time => time.dateTime)));
  await expect(preview.locator('[data-agy-key="message-streaming-assistant"] .antigravity-message-time')).toHaveCount(0);
  await expect(tile.locator('[data-agy-key="message-streaming-assistant"] .antigravity-message-time')).toHaveCount(0);
  await saveEvidence(page, testInfo, 'antigravity-read-only-message-times');
});

test('native history without original timestamps shows unknown time in resume and preview', async ({ page }, testInfo) => {
  const id = await createSession(page);
  try {
    const nativeId = 'agy-time-unknown-native-history';
    const response = await page.request.post(`/api/sessions/${id}/antigravity-resume`, { data: { sessionId: nativeId } });
    expect(response.ok()).toBe(true);
    await expect((await conversationView(page)).locator(chat)).toContainText('Historical fixture reply');
    const imported = (await conversationView(page)).locator(`${chat} .codex-message-block.user, ${chat} .codex-message-block.assistant`);
    await expect(imported).toHaveCount(2);
    await expect(imported.locator('time[datetime]')).toHaveCount(0);
    await expect(imported.locator('[data-agy-time-unknown="true"]')).toHaveCount(2);
    await (await conversationView(page)).locator('#antigravity-resume-btn').click();
    await expect((await conversationView(page)).locator('#antigravity-history-preview')).toBeAttached();
    await (await conversationView(page)).evaluate(nativeId => previewAntigravitySession(nativeId), nativeId);
    const preview = (await conversationView(page)).locator('#antigravity-history-preview');
    await expect(preview).toContainText('Historical fixture reply');
    await expect(preview.locator('time[datetime]')).toHaveCount(0);
    await expect(preview.locator('[data-agy-time-unknown="true"]')).toHaveCount(2);
    await saveEvidence(page, testInfo, 'antigravity-native-history-time-unknown');
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});
