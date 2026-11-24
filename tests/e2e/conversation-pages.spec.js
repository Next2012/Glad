const { conversationView } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

const agyChat = '#antigravity-chat-container';
const olderButton = container => container.getByRole('button', { name: 'Load earlier messages', exact: true });

test('a delayed Claude initialization cannot replace the session selected afterwards', async ({ page }) => {
  const sessions = [];
  let release, arrived, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  try {
    for (const toolKey of ['claude-code', 'codex']) {
      const response = await page.request.post('/api/sessions', { data: { toolKey } });
      expect(response.ok()).toBe(true); sessions.push(await response.json());
    }
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.route('**/api/claude-config*', async route => {
      try {
        const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
      } finally { finished(); }
    });
    await page.evaluate(id => { joinSession(id, 'Delayed Claude', 'claude-code'); }, sessions[0].id);
    await ready;
    await page.evaluate(id => { joinSession(id, 'Selected Codex', 'codex'); }, sessions[1].id);
    await (await conversationView(page)).waitForFunction(id => activeSessionId === id && activeToolKey === 'codex' && activeSessionHydrated, sessions[1].id);
    release(); await settled;
    await expect((await conversationView(page)).locator('#codex-chat-container')).toBeVisible();
    expect(await (await conversationView(page)).evaluate(() => activeToolKey)).toBe('codex');
    expect(await (await conversationView(page)).evaluate(() => currentSocket.url)).toContain(sessions[1].id);
  } finally {
    release();
    for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
  }
});

async function createWindowSession(page, nativeId) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity', name: 'Paged native conversation' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  try {
    const resumed = await page.request.post(`/api/sessions/${id}/antigravity-resume`, { data: { sessionId: nativeId } });
    expect(resumed.ok()).toBe(true);
    return id;
  } catch (error) {
    await page.request.delete(`/api/sessions/${id}`);
    throw error;
  }
}

async function joinWindowSession(page, id) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect((await conversationView(page)).locator(agyChat)).toContainText('WINDOW_ASSISTANT_120');
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
}

function captureAgyFrames(page) {
  const frames = [];
  page.on('websocket', socket => socket.on('framereceived', event => {
    try {
      const raw = String(event.payload);
      const payload = JSON.parse(raw);
      if (payload.type === 'antigravity-snapshot' || payload.type === 'antigravity-event') frames.push({ payload, bytes: Buffer.byteLength(raw), url: socket.url() });
    } catch (_) {}
  }));
  return frames;
}

async function visibleTurnNumbers(page, kind = 'user') {
  return (await conversationView(page)).locator(`${agyChat} .codex-message-block.${kind} > .codex-message`).evaluateAll((elements, kind) => {
    const pattern = new RegExp(`WINDOW_${kind === 'user' ? 'USER' : 'ASSISTANT'}_(\\d+)`);
    return elements.map(element => element.textContent.match(pattern)).filter(Boolean).map(match => Number(match[1]));
  }, kind);
}

async function expectUniqueAgyCards(page) {
  const ids = await (await conversationView(page)).locator(`${agyChat} .codex-message-block[data-agy-key]`).evaluateAll(elements => elements.map(element => element.dataset.agyKey));
  expect(new Set(ids).size).toBe(ids.length);
}

async function anchorOffset(container, anchor) {
  const containerBox = await container.boundingBox();
  const box = await anchor.boundingBox();
  return box.y - containerBox.y;
}

// Hold an actual or mocked page response after it has been captured. The gate
// controls the race itself, without depending on network sleeps or render speed.
async function gateOlderPage(page, sessionId, json = null) {
  let release, arrived, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { arrived = resolve; });
  const done = new Promise(resolve => { finished = resolve; });
  let captured = false;
  const pattern = `**/api/sessions/${sessionId}/conversation?*`;
  const handler = async route => {
    if (captured) return route.continue();
    captured = true;
    try {
      const response = json ? null : await route.fetch();
      arrived();
      await gate;
      if (json) await route.fulfill({ json });
      else await route.fulfill({ response });
    } catch (_) {
      // An epoch/session change is allowed to abort the waiting browser fetch.
      arrived();
    } finally {
      finished();
    }
  };
  await page.route(pattern, handler);
  return { ready, done, release, async dispose() { release(); await page.unroute(pattern, handler); } };
}

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, scale: 'css', animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('Antigravity opens a bounded native history, expands UTF-8 text and prepends pages without losing live replies or approvals', async ({ page }, testInfo) => {
  const frames = captureAgyFrames(page);
  const textReads = [];
  page.on('request', request => { if (request.url().includes('/conversation-messages/')) textReads.push(request.url()); });
  const id = await createWindowSession(page, 'agy-window-history-main');
  let gate;
  try {
    await joinWindowSession(page, id);
    const container = (await conversationView(page)).locator(agyChat);
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 12 }, (_, index) => 109 + index));
    await expect.poll(() => visibleTurnNumbers(page, 'assistant')).toEqual(Array.from({ length: 12 }, (_, index) => 109 + index));
    const initial = frames.find(frame => frame.payload.type === 'antigravity-snapshot' && frame.payload.snapshot.id === id);
    expect(initial).toBeTruthy();
    expect(new URL(initial.url).searchParams.get('history')).toBe('tail');
    expect(initial.payload.snapshot.messages.length).toBeLessThanOrEqual(128);
    expect(initial.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(initial.payload.snapshot.historyPage.totalMessages).toBeGreaterThan(initial.payload.snapshot.messages.length);
    await screenshot(page, testInfo, 'native-conversation-tail');

    const finalAnswer = container.locator('.codex-message-block.assistant').filter({ hasText: 'WINDOW_ASSISTANT_120' });
    await expect(finalAnswer).not.toContainText('WINDOW_UTF8_END_完成🌙');
    expect(textReads).toHaveLength(0);
    await finalAnswer.getByRole('button', { name: 'Read full message', exact: true }).click();
    await expect(finalAnswer).toContainText('WINDOW_UTF8_END_完成🌙');
    await expect(finalAnswer).toContainText('中文正文🌙用分块读取保留字符。');
    await expect(finalAnswer).not.toContainText('\uFFFD');
    await expect(finalAnswer.getByRole('button', { name: 'Read full message', exact: true })).toHaveCount(0);
    expect(textReads.length).toBeGreaterThan(1);

    await container.evaluate(element => { element.scrollTop = 0; });
    const anchor = container.locator('.codex-message-block.user').filter({ hasText: 'WINDOW_USER_109' });
    const before = await anchorOffset(container, anchor);
    await olderButton(container).click();
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 24 }, (_, index) => 97 + index));
    await expect.poll(() => anchorOffset(container, anchor)).toBeCloseTo(before, 0);
    await expectUniqueAgyCards(page);
    await expect(finalAnswer).toContainText('WINDOW_UTF8_END_完成🌙');

    gate = await gateOlderPage(page, id);
    await olderButton(container).click();
    await gate.ready;
    await (await conversationView(page)).locator('#cmd-input').fill('Continue after loading older history');
    await (await conversationView(page)).locator('#send-btn').click();
    await expect(container).toContainText('AGY fixture reply: Continue after loading older history');
    gate.release();
    await gate.done;
    await expect(olderButton(container)).toBeEnabled();
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 36 }, (_, index) => 85 + index));
    await expect(container.locator('.codex-message-block.assistant').last()).toContainText('AGY fixture reply: Continue after loading older history');
    await expectUniqueAgyCards(page);

    await (await conversationView(page)).locator('#cmd-input').fill('agy-approval');
    await (await conversationView(page)).locator('#send-btn').click();
    const approval = container.locator('[data-agy-permission]').filter({ has: (await conversationView(page)).getByRole('button', { name: 'Reject', exact: true }) });
    await expect((await conversationView(page)).locator('#session-attention-rail .approval')).toBeVisible();
    await (await conversationView(page)).locator('#session-attention-rail .approval').click();
    await expect(approval.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
    await olderButton(container).click();
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 48 }, (_, index) => 73 + index));
    await expect((await conversationView(page)).locator('#session-attention-rail .approval')).toBeVisible();
    await (await conversationView(page)).locator('#session-attention-rail .approval').click();
    await expect(approval.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    await expect((await conversationView(page)).locator('#send-btn')).toBeDisabled();
    await screenshot(page, testInfo, 'paged-history-pending-approval');
    await approval.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(container).toContainText('AGY approval denied');
    await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
  } finally {
    if (gate) await gate.dispose();
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('an Antigravity native conversation change rejects the old cursor and ignores its delayed page', async ({ page }, testInfo) => {
  const id = await createWindowSession(page, 'agy-window-history-before');
  let gate;
  try {
    await joinWindowSession(page, id);
    const container = (await conversationView(page)).locator(agyChat);
    const snapshot = await (await page.request.get(`/api/sessions/${id}?history=tail`)).json();
    const cursor = snapshot.historyPage.beforeCursor;
    gate = await gateOlderPage(page, id);
    await olderButton(container).click();
    await gate.ready;
    const resumed = await page.request.post(`/api/sessions/${id}/antigravity-resume`, { data: { sessionId: 'agy-window-history-after' } });
    expect(resumed.ok()).toBe(true);
    await expect(container).toContainText('WINDOW_ASSISTANT_120 agy-window-history-after');
    await expect(container).not.toContainText('agy-window-history-before');
    const stale = await page.request.get(`/api/sessions/${id}/conversation?before=${encodeURIComponent(cursor)}`);
    expect(stale.status()).toBe(409);
    gate.release();
    await gate.done;
    await expect(container).not.toContainText('agy-window-history-before');
    await expect(olderButton(container)).toBeEnabled();
    await olderButton(container).click();
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 24 }, (_, index) => 97 + index));
    await expect(container).not.toContainText('agy-window-history-before');
    await expect(container.locator('.conversation-page-error')).toHaveCount(0);
    await expectUniqueAgyCards(page);
    await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
    await screenshot(page, testInfo, 'native-conversation-new-epoch');
  } finally {
    if (gate) await gate.dispose();
    await page.request.delete(`/api/sessions/${id}`);
  }
});

async function activateProviderHarness(page, kind, sessionId, epoch, fresh = false) {
  await (await conversationView(page)).evaluate(({ kind, sessionId, epoch, fresh }) => {
    activeSessionId = sessionId;
    activeToolKey = kind;
    activeSessionHydrated = true;
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(kind === 'claude-code');
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    window.gladConversationPages.activate(sessionId, kind);
    const messages = fresh ? [{ id: 'fresh-other-session', kind: 'assistant', text: 'FRESH_OTHER_SESSION', historyIndex: 0, revision: 1 }]
      : [
        { id: 'anchor-100', kind: 'assistant', text: 'ANCHOR_CURRENT_100', historyIndex: 1, revision: 10 },
        { id: 'user-101', kind: 'user', text: 'INITIAL_LATEST_USER', historyIndex: 2, revision: 10 },
        { id: 'answer-102', kind: 'assistant', text: 'INITIAL_LATEST_ANSWER', historyIndex: 3, revision: 10 }
      ];
    const snapshot = window.gladConversationPages.acceptSnapshot(sessionId, {
      messages, pendingQuestions: [], historyPage: { paged: true, epoch, revision: 10, hasBefore: !fresh, beforeCursor: 'harness-before', totalMessages: fresh ? 1 : 4 }
    });
    if (kind === 'codex') {
      codexMessages = snapshot.messages;
      codexPendingPermissions = [];
      applyCodexState({ status: 'idle', models: [], canSteer: false, canAbort: false });
    } else {
      claudeMessages = snapshot.messages;
      claudePendingPermissions = [];
      claudeStatus = 'idle';
      applyClaudeState({ status: 'idle', canAbort: false });
    }
    handleComposerSocketOpen();
  }, { kind, sessionId, epoch, fresh });
}

async function providerTexts(container, kind) {
  const block = kind === 'codex' ? '.codex-message-block' : '.claude-message-block';
  return container.locator(block).evaluateAll(elements => elements.map(element => element.querySelector('.codex-message, .claude-message')?.textContent.trim()).filter(Boolean));
}

for (const kind of ['codex', 'claude-code']) {
  test(`${kind} keeps newer live content when an older page arrives and isolates a new session`, async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const sessionId = `page-harness-${kind}`;
    const container = (await conversationView(page)).locator(kind === 'codex' ? '#codex-chat-container' : '#claude-chat-container');
    let gate;
    try {
      await activateProviderHarness(page, kind, sessionId, 'epoch-a');
      gate = await gateOlderPage(page, sessionId, {
        success: true, messages: [{ id: 'older-099', kind: 'assistant', text: 'STALE_OLDER_RESPONSE_099', historyIndex: 0, revision: 5 }],
        historyPage: { paged: true, epoch: 'epoch-a', revision: 10, hasBefore: false, beforeCursor: '', totalMessages: 4 }
      });
      await olderButton(container).click();
      await gate.ready;
      await (await conversationView(page)).evaluate(kind => {
        const apply = kind === 'codex' ? applyCodexEvent : applyClaudeEvent;
        apply({ type: 'message-updated', message: { id: 'older-099', kind: 'assistant', text: 'LIVE_OLDER_UPDATED_099', historyIndex: 0, revision: 20 } });
        apply({ type: 'message', message: { id: 'new-103', kind: 'assistant', text: 'LIVE_NEW_REPLY_103', historyIndex: 4, revision: 21 } });
      }, kind);
      await expect(container).toContainText('LIVE_NEW_REPLY_103');
      gate.release();
      await gate.done;
      await expect(container).toContainText('Beginning of loaded conversation');
      await expect.poll(() => providerTexts(container, kind)).toEqual([
        'LIVE_OLDER_UPDATED_099', 'ANCHOR_CURRENT_100', 'INITIAL_LATEST_USER', 'INITIAL_LATEST_ANSWER', 'LIVE_NEW_REPLY_103'
      ]);
      await expect(container).not.toContainText('STALE_OLDER_RESPONSE_099');
      await gate.dispose();

      await activateProviderHarness(page, kind, sessionId, 'epoch-switch');
      gate = await gateOlderPage(page, sessionId, {
        success: true, messages: [{ id: 'wrong-session', kind: 'assistant', text: 'WRONG_SESSION_OLD_PAGE', historyIndex: 0, revision: 5 }],
        historyPage: { paged: true, epoch: 'epoch-switch', revision: 10, hasBefore: false, beforeCursor: '', totalMessages: 4 }
      });
      await olderButton(container).click();
      await gate.ready;
      await activateProviderHarness(page, kind, `${sessionId}-other`, 'epoch-other', true);
      await expect(container).toContainText('FRESH_OTHER_SESSION');
      gate.release();
      await gate.done;
      await expect.poll(() => providerTexts(container, kind)).toEqual(['FRESH_OTHER_SESSION']);
      await expect(container).not.toContainText('WRONG_SESSION_OLD_PAGE');
      await expect(olderButton(container)).toHaveCount(0);
      await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
      await screenshot(page, testInfo, `${kind}-paged-session-isolation`);
    } finally {
      if (gate) await gate.dispose();
    }
  });
}

for (const kind of ['codex', 'claude-code', 'antigravity']) {
  test(`${kind} deferred non-body text stays readable through its original message`, async ({ page }) => {
    const sessionId = `non-body-${kind}`;
    const bodies = {
      'long-event': '**LITERAL_EVENT**\n' + '正文🌙'.repeat(1500) + '\nEVENT_ORIGINAL_END',
      'group-result': '<em>Literal tool output</em>\n' + '正文🌙'.repeat(1500) + '\nGROUP_RESULT_ORIGINAL_END',
      'orphan-result': 'Orphan output\n' + '正文🌙'.repeat(1500) + '\nORPHAN_RESULT_ORIGINAL_END',
      'long-reasoning': '**Reasoning title**\n' + '正文🌙'.repeat(1500) + '\nREASONING_ORIGINAL_END'
    };
    const requested = [];
    await page.route(`**/api/sessions/${sessionId}/conversation-messages/*/text?*`, async route => {
      const url = new URL(route.request().url());
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      requested.push(id);
      if (!bodies[id]) return route.fulfill({ status: 404, json: { error: 'Wrong source message' } });
      return route.fulfill({ json: { text: bodies[id], version: `version-${id}`, nextOffset: Buffer.byteLength(bodies[id]), hasMore: false } });
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await (await conversationView(page)).evaluate(({ kind, sessionId, bodies }) => {
      activeSessionId = sessionId;
      activeToolKey = kind;
      activeSessionHydrated = true;
      document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
      document.getElementById('terminal-view').classList.add('active');
      setClaudeModeEnabled(kind === 'claude-code');
      currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
      window.gladConversationPages.activate(sessionId, kind);
      const deferred = (id, messageKind, extra = {}) => ({
        id, kind: messageKind, text: Array.from(bodies[id]).slice(0, 100).join(''), textVersion: `version-${id}`,
        textDeferred: true, revision: 1, turnId: 'non-body-turn', ...extra
      });
      const messages = [deferred('long-event', 'event', { level: 'error' })];
      if (kind === 'claude-code') messages.push(
        { id: 'compact-tool', kind: 'tool', name: 'Bash', toolUseId: 'native-compact-tool', turnId: 'non-body-turn', toolStatus: 'completed', input: { command: 'echo output' } },
        deferred('group-result', 'tool-result', { toolUseId: 'native-compact-tool' }),
        deferred('orphan-result', 'tool-result', { toolUseId: 'unavailable-parent' }),
        deferred('long-reasoning', 'reasoning')
      );
      messages.forEach((message, index) => { message.historyIndex = index; });
      const snapshot = window.gladConversationPages.acceptSnapshot(sessionId, { messages, pendingQuestions: [],
        historyPage: { paged: true, epoch: 'non-body', revision: 1, hasBefore: false, totalMessages: messages.length } });
      if (kind === 'codex') {
        codexMessages = snapshot.messages; codexPendingPermissions = [];
        applyCodexState({ status: 'idle', models: [], canSteer: false, canAbort: false });
      } else if (kind === 'claude-code') {
        claudeMessages = snapshot.messages; claudePendingPermissions = []; claudeStatus = 'idle';
        applyClaudeState({ status: 'idle', canAbort: false });
      } else {
        antigravityMessages = snapshot.messages; antigravityPendingPermissions = [];
        antigravityState = { ...createDefaultAntigravityState(), status: 'idle' };
        applyAntigravityState(antigravityState);
      }
      handleComposerSocketOpen();
    }, { kind, sessionId, bodies });
    const container = (await conversationView(page)).locator(kind === 'codex' ? '#codex-chat-container' : kind === 'claude-code' ? '#claude-chat-container' : '#antigravity-chat-container');
    const ids = kind === 'claude-code' ? ['long-event', 'group-result', 'orphan-result', 'long-reasoning'] : ['long-event'];
    for (const id of ids) {
      const button = container.locator(`.conversation-expand-message[data-conversation-message="${id}"]`);
      await expect(button).toBeAttached();
      for (const ancestor of await button.locator('xpath=ancestor::details').all()) {
        if (!await ancestor.evaluate(element => element.open)) await ancestor.locator(':scope > summary').click();
      }
      const marker = bodies[id].split('\n').at(-1);
      await expect(container).not.toContainText(marker);
      await button.click();
      await expect(container).toContainText(marker);
      await expect(button).toHaveCount(0);
    }
    expect(requested).toEqual(ids);
    await expect(container).not.toContainText('\uFFFD');
    await expect(container.locator('.codex-message.event strong, .claude-message.event strong')).toHaveCount(0);
    if (kind === 'claude-code') {
      const compactTool = container.locator('[data-claude-key="tool-compact-tool"]');
      await expect(compactTool).toContainText('GROUP_RESULT_ORIGINAL_END');
      await expect(compactTool.locator('em')).toHaveCount(0);
    }
  });
}

test('a same-epoch reconnect preserves contiguous earlier history while a page is in flight', async ({ page }) => {
  const id = await createWindowSession(page, 'agy-window-history-main');
  let gate;
  try {
    await joinWindowSession(page, id);
    const view = await conversationView(page), container = view.locator(agyChat);
    for (const count of [24, 36]) {
      await olderButton(container).click();
      await expect.poll(() => visibleTurnNumbers(page)).toHaveLength(count);
    }
    gate = await gateOlderPage(page, id);
    await olderButton(container).click(); await gate.ready;
    await view.evaluate(() => { window.socketBeforePageReconnect = currentSocket; currentSocket.close(); });
    await view.waitForFunction(() => currentSocket !== window.socketBeforePageReconnect && currentSocket.readyState === WebSocket.OPEN && activeSessionHydrated);
    await expect(view.locator('#send-btn')).toBeEnabled();
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 36 }, (_, index) => 85 + index));
    gate.release(); await gate.done;
    await expect.poll(() => visibleTurnNumbers(page)).toEqual(Array.from({ length: 48 }, (_, index) => 73 + index));
    await expectUniqueAgyCards(page);
  } finally { if (gate) await gate.dispose(); await page.request.delete(`/api/sessions/${id}`); }
});

test('a same-epoch reconnect with a gap adopts the new tail cursor and rejects the old in-flight page', async ({ page }) => {
  const frames = captureAgyFrames(page), id = await createWindowSession(page, 'agy-window-history-main');
  let gate;
  try {
    await joinWindowSession(page, id); const view = await conversationView(page), container = view.locator(agyChat);
    await olderButton(container).click(); await expect.poll(() => visibleTurnNumbers(page)).toHaveLength(24);
    gate = await gateOlderPage(page, id); await olderButton(container).click(); await gate.ready;
    const snapshot = structuredClone(frames.find(frame => frame.payload.type === 'antigravity-snapshot').payload.snapshot);
    snapshot.messages = snapshot.messages.map(item => ({ ...item, id: `new-tail-${item.id}`, historyIndex: item.historyIndex + 10000 }));
    snapshot.historyPage = { ...snapshot.historyPage, hasBefore: true, beforeCursor: 'new-tail-cursor' };
    await view.evaluate(snapshot => {
      const accepted = gladConversationPages.acceptSnapshot(activeSessionId, snapshot);
      antigravityMessages = accepted.messages; renderAntigravityChat();
    }, snapshot);
    gate.release(); await gate.done;
    const ids = await view.evaluate(() => antigravityMessages.map(item => item.id));
    expect(ids.length).toBe(snapshot.messages.length); expect(ids.every(id => id.startsWith('new-tail-'))).toBe(true);
    await expect(olderButton(container)).toBeEnabled();
  } finally { if (gate) await gate.dispose(); await page.request.delete(`/api/sessions/${id}`); }
});
