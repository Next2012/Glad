const { test, expect } = require('@playwright/test');

const chatSelector = '#antigravity-chat-container';
const groupSelector = `${chatSelector} .antigravity-work-group`;

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, scale: 'css', animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function openHistoryHarness(page) {
  await page.addInitScript(() => localStorage.setItem('glad-theme', 'light'));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    activeSessionId = 'antigravity-presentation';
    activeToolKey = 'antigravity';
    activeSessionHydrated = true;
    antigravityMessages = [];
    antigravityPendingPermissions = [];
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    for (let turn = 1; turn <= 3; turn++) {
      const turnId = `history-turn-${turn}`;
      antigravityMessages.push(
        { id: `user-${turn}`, kind: 'user', turnId, text: `Review project area ${turn}.` },
        { id: `start-${turn}`, kind: 'turn-start', turnId },
        { id: `progress-${turn}`, kind: 'assistant', turnId, text: `I am reviewing project area ${turn}.` }
      );
      for (let tool = 0; tool < 4; tool++) {
        if (tool % 2 === 0) antigravityMessages.push({
          id: `reasoning-${turn}-${tool}`, kind: 'reasoning', turnId,
          text: `Thinking through project area ${turn}, operation ${tool + 1}.`, hasDetail: true, detailLoaded: false
        });
        antigravityMessages.push({
          id: `tool-${turn}-${tool}`, kind: 'tool', turnId,
          providerId: `native-${turn}-${tool}`, toolUseId: `native-${turn}-${tool}`,
          name: tool % 2 ? 'run_command' : 'read_file', title: `Inspect area ${turn}, file ${tool + 1}`,
          toolStatus: 'completed', status: 'completed', hasDetail: true, detailLoaded: false,
          input: { path: `src/area-${turn}/file-${tool + 1}.js` }, text: 'Native tool output is available on expansion.'
        });
      }
      antigravityMessages.push(
        { id: `answer-${turn}`, kind: 'assistant', turnId, text: `Final answer for area ${turn}: the review is complete.` },
        { id: `end-${turn}`, kind: 'turn-end', turnId, turnStatus: 'completed',
          context: { contextWindow: 100000, remainingTokens: 100000 - turn * 1200 } }
      );
    }
    antigravityState = { ...createDefaultAntigravityState(), status: 'idle', canCompact: true,
      context: { contextWindow: 100000, remainingTokens: 96400 } };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    window.__presentationFrames = [];
    currentSocket = { readyState: WebSocket.OPEN, send: value => window.__presentationFrames.push(JSON.parse(value)) };
    applyAntigravityState(antigravityState);
    handleComposerSocketOpen();
  });
  await expect(page.locator(groupSelector)).toHaveCount(3);
}

async function expectFinishedHistoryCollapsed(page, count = 3) {
  const chat = page.locator(chatSelector);
  await expect(page.locator(groupSelector)).toHaveCount(count);
  await expect(chat.locator('.antigravity-work-group[open]')).toHaveCount(0);
  await expect(chat.locator('.antigravity-conversation > .antigravity-tool, .antigravity-conversation > .antigravity-reasoning')).toHaveCount(0);
  await expect(chat.locator('.antigravity-work-group .antigravity-tool')).toHaveCount(12);
  await expect(chat.locator('.antigravity-work-group .antigravity-reasoning')).toHaveCount(6);
  await expect(page.locator('#antigravity-state-bar .codex-context-meter')).toHaveCount(0);
  await expect(chat.locator('.codex-context-meter')).toHaveCount(3);
  await expect(chat.locator('.codex-message-meta .codex-context-meter')).toHaveCount(3);
  const expectedContextOwners = await page.evaluate(() => [1, 2, 3].map(turn =>
    `message-${antigravityMessages.filter(item => item.kind === 'assistant' && item.turnId === `history-turn-${turn}`).at(-1).id}`));
  expect(await chat.locator('.codex-context-meter').evaluateAll(meters => meters.map(meter =>
    meter.closest('.codex-message-block.assistant')?.dataset.agyKey))).toEqual(expectedContextOwners);
  for (let turn = 1; turn <= 3; turn++) {
    await expect(chat.locator(`.codex-message-block.assistant[data-agy-key="message-answer-${turn}"]`)).toBeVisible();
  }
}

test('Antigravity collapses twelve tools and mixed thinking into per-turn work history', async ({ page }, testInfo) => {
  await openHistoryHarness(page);
  await expectFinishedHistoryCollapsed(page);
  expect(await page.evaluate(() => window.__presentationFrames.filter(frame => frame.type === 'antigravity-detail-request'))).toEqual([]);
  await screenshot(page, testInfo, 'long-history-collapsed');

  const firstGroup = page.locator(groupSelector).first();
  const firstKey = await firstGroup.getAttribute('data-agy-key');
  await firstGroup.locator(':scope > summary').click();
  await expect(firstGroup).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => window.__presentationFrames.filter(frame => frame.type === 'antigravity-detail-request').length)).toBeGreaterThan(0);
  const requested = await page.evaluate(() => window.__presentationFrames.filter(frame => frame.type === 'antigravity-detail-request').flatMap(frame => frame.ids || []));
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every(id => /^(tool|reasoning)-1-/.test(id))).toBe(true);
  await expect(firstGroup.locator('.antigravity-tool')).toHaveCount(4);
  await expect(firstGroup.locator('.antigravity-reasoning')).toHaveCount(2);
  const firstTool = firstGroup.locator('[data-agy-message-id="tool-1-0"]');
  await firstTool.locator(':scope > summary').click();
  await expect(firstTool).toHaveAttribute('open', '');

  // A streaming patch and snapshot replay must retain explicit disclosure choices.
  await page.evaluate(() => applyAntigravityEvent({ type: 'message-updated', message: {
    ...antigravityMessages.find(item => item.id === 'tool-1-0'), text: 'Updated native output', detailLoaded: true
  } }));
  await expect(firstGroup).toHaveAttribute('data-agy-key', firstKey);
  await expect(firstGroup).toHaveAttribute('open', '');
  await expect(firstTool).toHaveAttribute('open', '');
  await firstGroup.locator(':scope > summary').click();
  const secondGroup = page.locator(groupSelector).nth(1);
  await secondGroup.locator(':scope > summary').click();
  await page.evaluate(() => {
    applyAntigravityEvent({ type: 'message', message: {
      id: 'followup-answer', kind: 'assistant', turnId: 'history-turn-3', text: 'Additional final response remains visible.'
    } });
    applyAntigravityEvent({ type: 'history-reset', messages: JSON.parse(JSON.stringify(antigravityMessages)), pendingPermissions: [] });
  });
  await expect(firstGroup).not.toHaveAttribute('open', '');
  await expect(secondGroup).toHaveAttribute('open', '');
  await expect(page.locator(`${chatSelector} [data-agy-key="message-followup-answer"]`)).toBeVisible();
  await expect(page.locator(`${chatSelector} [data-agy-message-id="tool-1-0"]`)).not.toBeVisible();
  await secondGroup.locator(':scope > summary').click();
  await expectFinishedHistoryCollapsed(page);
});

test('Antigravity read-only previews preserve compact work history and visible answers', async ({ page }, testInfo) => {
  await openHistoryHarness(page);
  await page.evaluate(() => {
    const host = document.getElementById('antigravity-chat-container');
    host.innerHTML = buildAntigravityConversationHtml(JSON.parse(JSON.stringify(antigravityMessages)), [], { status: 'idle' });
    makeTileConversationReadOnly(host);
  });
  await expectFinishedHistoryCollapsed(page);
  const buttons = page.locator(`${chatSelector} button`);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  expect(await page.evaluate(() => window.__presentationFrames.filter(frame => frame.type === 'antigravity-detail-request'))).toEqual([]);
  await screenshot(page, testInfo, 'read-only-history-collapsed');
});

test('Antigravity disclosure choices survive appended work, completion and replay', async ({ page }) => {
  await openHistoryHarness(page);
  const previous = page.locator(groupSelector).first();
  await previous.locator(':scope > summary').click();
  await previous.locator(':scope > summary').click();
  await page.evaluate(() => {
    antigravityMessages.push(
      { id: 'stream-user', kind: 'user', turnId: 'stream-turn', text: 'Continue with a new review.' },
      { id: 'stream-start', kind: 'turn-start', turnId: 'stream-turn' },
      { id: 'stream-reason', kind: 'reasoning', turnId: 'stream-turn', text: 'Checking the next file.' },
      { id: 'stream-tool-0', kind: 'tool', turnId: 'stream-turn', providerId: 'stream-native-0', toolStatus: 'running', title: 'Read the next file' }
    );
    applyAntigravityState({ status: 'running', turnId: 'stream-turn', canAbort: true, canSteer: true });
  });
  await expect(page.locator(groupSelector)).toHaveCount(4);
  const streaming = page.locator(groupSelector).last();
  if (!await streaming.evaluate(group => group.open)) await streaming.locator(':scope > summary').click();
  // Make the open choice explicit even when running work initially opens itself.
  await streaming.locator(':scope > summary').click();
  await streaming.locator(':scope > summary').click();
  const key = await streaming.getAttribute('data-agy-key');
  await page.evaluate(() => applyAntigravityEvent({ type: 'message', message: {
    id: 'stream-tool-1', kind: 'tool', turnId: 'stream-turn', providerId: 'stream-native-1',
    toolStatus: 'running', title: 'Read another file'
  } }));
  await expect(streaming).toHaveAttribute('data-agy-key', key);
  await expect(streaming).toHaveAttribute('open', '');
  await expect(streaming.locator('.antigravity-tool')).toHaveCount(2);
  await expect(previous).not.toHaveAttribute('open', '');
  await page.evaluate(() => {
    for (const item of antigravityMessages) if (item.turnId === 'stream-turn' && item.kind === 'tool') item.toolStatus = 'completed';
    antigravityMessages.push(
      { id: 'stream-final', kind: 'assistant', turnId: 'stream-turn', text: 'The follow-up review is complete.' },
      { id: 'stream-end', kind: 'turn-end', turnId: 'stream-turn', turnStatus: 'completed' }
    );
    applyAntigravityState({ status: 'idle', canAbort: false, canSteer: false });
  });
  await expect(streaming).toHaveAttribute('open', '');
  await expect(page.locator(`${chatSelector} [data-agy-key="message-stream-final"]`)).toBeVisible();
  await streaming.locator(':scope > summary').click();
  await page.evaluate(() => applyAntigravityEvent({
    type: 'history-reset', messages: JSON.parse(JSON.stringify(antigravityMessages)), pendingPermissions: []
  }));
  await expect(streaming).toHaveAttribute('data-agy-key', key);
  await expect(streaming).not.toHaveAttribute('open', '');
  await expect(previous).not.toHaveAttribute('open', '');
  await expect(page.locator(`${chatSelector} [data-agy-key="message-stream-final"]`)).toBeVisible();
});

test('native rejected approval becomes a collapsed tool audit after the final answer and reconnect', async ({ page }, testInfo) => {
  const sent = [];
  page.on('websocket', socket => socket.on('framesent', event => {
    try { sent.push(JSON.parse(String(event.payload))); } catch (_) {}
  }));
  const created = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
    await page.waitForFunction(() => activeSessionHydrated && antigravityState.status === 'idle');
    await page.locator('#cmd-input').fill('agy-approval');
    await page.locator('#send-btn').click();
    const permission = page.locator(`${chatSelector} [data-agy-permission]`);
    await expect(permission).toHaveCount(1);
    await expect(permission).toBeVisible();
    const permissionId = await permission.getAttribute('data-agy-permission');
    const toolId = await permission.evaluate(element => element.closest('.antigravity-tool')?.dataset.agyMessageId);
    expect(toolId).toBeTruthy();
    const nativeToolId = await page.evaluate(id => antigravityMessages.find(item => item.id === id)?.providerId, toolId);
    expect(await page.evaluate(id => antigravityPendingPermissions.find(item => item.id === id)?.toolUseId, permissionId)).toBe(nativeToolId);
    await expect(page.locator(`${chatSelector} .antigravity-conversation > [data-agy-permission]`)).toHaveCount(0);
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(permission.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();

    // Attention navigation must reveal the action even after ancestors are closed.
    await permission.evaluate(element => {
      for (let parent = element; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = false;
    });
    await page.locator('#session-attention-rail .approval').click();
    await expect(permission.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    expect(await permission.evaluate(element => {
      for (let parent = element; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) return false;
      return true;
    })).toBe(true);
    await screenshot(page, testInfo, 'approval-pending-inline');
    await permission.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect.poll(() => sent.find(frame => frame.type === 'antigravity-permission' && frame.id === permissionId)?.optionId).toBe('reject-once-exact');
    await expect(page.locator(chatSelector)).toContainText('AGY approval denied');
    await page.waitForFunction(() => antigravityState.status === 'idle');

    async function expectDeniedAuditCollapsed() {
      await expect(page.locator(`${chatSelector} .antigravity-pending-work`)).toHaveCount(0);
      await expect(page.locator(`${chatSelector} [data-agy-permission-option]`)).toHaveCount(0);
      await expect(page.locator('#session-attention-rail .approval')).toHaveCount(0);
      await expect(permission).toHaveCount(1);
      await expect(permission).not.toBeVisible();
      await expect(permission).not.toHaveAttribute('open', '');
      expect(await permission.evaluate(element => Boolean(element.closest('.antigravity-work-group') && element.closest('.antigravity-tool')))).toBe(true);
      await expect(page.locator(`${chatSelector} .antigravity-conversation > [data-agy-permission]`)).toHaveCount(0);
      await expect(page.locator(`${chatSelector} .codex-message-block.assistant`).filter({ hasText: 'AGY approval denied' })).toBeVisible();
    }
    await expectDeniedAuditCollapsed();
    await screenshot(page, testInfo, 'approval-denied-final-collapsed');

    // A successful retry is a separate operation; it must not inherit denial UI.
    await page.locator('#cmd-input').fill('agy-tool successful retry after denial');
    await page.locator('#send-btn').click();
    await expect(page.locator(chatSelector)).toContainText('AGY fixture reply: agy-tool successful retry after denial');
    await page.waitForFunction(() => antigravityState.status === 'idle');
    await expect(page.locator(groupSelector)).toHaveCount(2);
    await expectDeniedAuditCollapsed();
    await page.evaluate(() => { window.__presentationOldSocket = currentSocket; currentSocket.close(); });
    await page.waitForFunction(() => currentSocket !== window.__presentationOldSocket && currentSocket?.readyState === WebSocket.OPEN && activeSessionHydrated);
    await expect(page.locator(groupSelector)).toHaveCount(2);
    await expectDeniedAuditCollapsed();
    await expect(page.locator(`${chatSelector} .antigravity-work-group[open]`)).toHaveCount(0);
    await screenshot(page, testInfo, 'approval-denied-retry-reconnected');
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});
