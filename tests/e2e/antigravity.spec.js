const { test, expect } = require('@playwright/test');

async function createSession(page) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => antigravityState.status === 'idle' && activeSessionHydrated);
  await expect(page.locator('#antigravity-control-panel')).toBeVisible();
  return id;
}
async function send(page, text) {
  await page.locator('#cmd-input').fill(text);
  await page.locator('#send-btn').click();
  await expect(page.locator('#cmd-input')).toHaveValue('');
}
async function expandWorkAncestors(item) {
  await expect(item).toBeAttached();
  const ancestors = item.locator('xpath=ancestor::details');
  for (const ancestor of await ancestors.all()) {
    if (!await ancestor.evaluate(details => details.open)) await ancestor.locator(':scope > summary').click();
  }
}

test('Antigravity is offered in the lobby, sends native messages and reconnects with history', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = await createSession(page);
  try {
    await expect(page.locator('#codex-control-panel')).not.toBeVisible();
    await expect(page.locator('#claude-control-panel')).not.toBeVisible();
    await expect(page.locator('#antigravity-control-panel')).not.toContainText('Fork');
    await expect(page.locator('#antigravity-control-panel')).not.toContainText('Fast');
    await send(page, 'Hello Antigravity');
    await expect(page.locator('#antigravity-chat-container')).toContainText('AGY fixture reply: Hello Antigravity');
    const nativeId = await page.evaluate(() => antigravityState.nativeConversationId);
    expect(nativeId).toBeTruthy();
    await page.evaluate(() => { window.__oldAgySocket = currentSocket; currentSocket.close(); });
    await page.waitForFunction(() => currentSocket !== window.__oldAgySocket && currentSocket?.readyState === WebSocket.OPEN);
    await expect(page.locator('#antigravity-chat-container .codex-message-block.user')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => antigravityState.nativeConversationId)).toBe(nativeId);
    await send(page, 'Reply after reconnect');
    await expect(page.locator('#antigravity-chat-container')).toContainText('AGY fixture reply: Reply after reconnect');
    if (await page.locator('#back-btn').isVisible()) await page.locator('#back-btn').click();
    await page.getByTitle('New AI session').click();
    await expect(page.locator('.tool-item').filter({ hasText: 'Antigravity' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity shows native tool details, reasoning, plans and exact permission choices', async ({ page }) => {
  const sent = [];
  page.on('websocket', socket => socket.on('framesent', event => { try { sent.push(JSON.parse(String(event.payload))); } catch (_) {} }));
  const id = await createSession(page);
  try {
    await send(page, 'agy-tool');
    const tool = page.locator('#antigravity-chat-container .antigravity-tool').last();
    await expandWorkAncestors(tool);
    await expect(tool).toBeVisible();
    await tool.locator(':scope > summary').click();
    await expect.poll(() => sent.some(message => message.type === 'antigravity-detail-request' && message.ids?.length)).toBe(true);
    await expect.poll(() => page.evaluate(() => antigravityMessages.some(item => item.kind === 'tool' && item.detailLoaded))).toBe(true);
    await page.waitForFunction(() => antigravityState.status === 'idle');
    await send(page, 'agy-plan');
    await expandWorkAncestors(page.locator('#antigravity-chat-container .agent-task-card').last());
    await expect(page.locator('#antigravity-chat-container .agent-task-card')).toBeVisible();
    await page.waitForFunction(() => antigravityState.status === 'idle');
    await send(page, 'agy-approval');
    const permission = page.locator('#antigravity-chat-container [data-agy-permission]').last();
    await expect(permission).toBeVisible();
    await expect(page.locator('#send-btn')).toBeDisabled();
    const option = await permission.locator('[data-agy-permission-option]').first().getAttribute('data-agy-permission-option');
    expect(option).toBeTruthy();
    await permission.locator('[data-agy-permission-option]').first().click();
    await expect.poll(() => sent.filter(message => message.type === 'antigravity-permission').at(-1)?.optionId).toBe(option);
    await page.waitForFunction(() => antigravityState.status === 'idle');
    expect(sent.filter(message => message.type === 'antigravity-permission').at(-1).decision).toBeUndefined();
    const reasoning = page.locator('#antigravity-chat-container .antigravity-reasoning').first();
    await expandWorkAncestors(reasoning);
    await expect(reasoning).toBeVisible();
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity questions accept answers and support cancellation', async ({ page }) => {
  const id = await createSession(page);
  try {
    await send(page, 'agy-question');
    const question = page.locator('#antigravity-chat-container [data-agy-question]').last();
    await expect(question).toBeVisible();
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(question.getByRole('spinbutton')).toHaveValue('1');
    await question.getByRole('spinbutton').fill('3');
    await question.locator('select[name="destination"]').selectOption('Remote');
    const fields = question.locator('textarea');
    for (let i = 0; i < await fields.count(); i++) await fields.nth(i).fill('Keep the change small');
    const accepted = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${id}/antigravity-user-input`));
    await question.getByRole('button', { name: 'Submit answer' }).click();
    expect((await accepted).ok()).toBe(true);
    await page.waitForFunction(() => antigravityState.status === 'idle');
    await expect.poll(() => page.evaluate(() => antigravityMessages.find(item => item.kind === 'question')?.answers)).toEqual({ count: 3, destination: 'Remote', enabled: true });
    await expect(question.getByRole('spinbutton')).toHaveValue('3');
    await send(page, 'agy-question');
    const cancelled = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${id}/antigravity-user-input`));
    await page.locator('#antigravity-chat-container [data-agy-question]').last().getByRole('button', { name: 'Cancel question' }).click();
    expect((await cancelled).ok()).toBe(true);
    await page.waitForFunction(() => antigravityState.status === 'idle');
    await expect.poll(() => page.evaluate(() => antigravityMessages.filter(item => item.kind === 'question').map(item => item.questionStatus))).toEqual(['answered', 'cancelled']);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity config options update dynamically and native history restores a conversation', async ({ page }) => {
  const id = await createSession(page);
  try {
    await expect(page.locator('#antigravity-model-panel')).not.toBeVisible();
    await page.locator('#antigravity-model-btn').click();
    await expect(page.locator('#antigravity-model-btn')).toHaveAttribute('aria-expanded', 'true');
    const config = page.locator('#antigravity-model-panel [data-agy-config="model"]');
    await expect(config).toBeHidden();
    const options = await config.locator('option').evaluateAll(options => options.map(option => option.value));
    expect(options.length).toBeGreaterThan(1);
    const current = await config.inputValue();
    const selected = options.find(value => value !== current);
    const settings = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/sessions/${id}/antigravity-settings`));
    await page.locator(`#antigravity-model-panel [data-agy-config-choice="model"][data-agy-value="${selected}"]`).click();
    expect((await settings).ok()).toBe(true);
    await expect(config).toHaveValue(selected);
    await expect(page.locator(`#antigravity-model-panel [data-agy-config-choice="model"][data-agy-value="${selected}"]`)).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#antigravity-model-btn').click();
    await expect(page.locator('#antigravity-model-panel')).not.toBeVisible();
    await page.locator('#antigravity-commands-btn').click();
    await expect(page.locator('#antigravity-command-panel')).toContainText('/plan');
    await page.locator('#antigravity-command-panel [data-agy-command="plan"]').click();
    await expect(page.locator('#cmd-input')).toHaveValue('/plan');
    await page.locator('#cmd-input').fill('');
    await page.locator('#antigravity-status-btn').click();
    await expect(page.locator('#antigravity-chat-container .antigravity-status')).toContainText('75% remaining');
    const originalNative = await page.evaluate(() => antigravityState.nativeConversationId);
    await page.locator('#antigravity-resume-btn').click();
    const panel = page.locator('#antigravity-resume-panel');
    await expect(panel.locator('[data-agy-resume]').first()).toBeVisible();
    const native = await panel.locator('[data-agy-resume]').first().getAttribute('data-agy-resume');
    await panel.locator('[data-agy-preview]').first().click();
    await expect(panel.locator('#antigravity-history-preview .codex-message-block')).not.toHaveCount(0);
    expect(await page.evaluate(() => antigravityState.nativeConversationId)).toBe(originalNative);
    const resumed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/sessions/${id}/antigravity-resume`));
    await panel.locator('[data-agy-resume]').first().click();
    expect((await resumed).ok()).toBe(true);
    await expect(panel).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => antigravityState.nativeConversationId)).toBe(native);
    await send(page, 'Continue restored conversation');
    await expect(page.locator('#antigravity-chat-container')).toContainText('AGY fixture reply: Continue restored conversation');
    await page.goto(`/?embed=1&embedSession=${id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('#antigravity-chat-container')).toBeVisible();
    await expect.poll(() => page.evaluate(() => antigravityState.nativeConversationId)).toBe(native);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity renders in tiled workspaces and opens pending native approvals', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Tiled workspace requires desktop width');
  const id = await createSession(page);
  try {
    await send(page, 'agy-approval');
    await expect(page.locator('#antigravity-chat-container [data-agy-permission]')).toBeVisible();
    await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
    const tile = page.locator(`.tile-session-window[data-session-id="${id}"]`);
    await expect(tile.locator('.antigravity-conversation')).toBeVisible();
    await expect(tile.locator('[data-agy-permission-option]').first()).toBeDisabled();
    await tile.locator('.tile-approval-alert').click();
    await expect(page.locator('#antigravity-control-panel')).toBeVisible();
    await expect(page.locator('#antigravity-chat-container [data-agy-permission] button').first()).toBeEnabled();
    await page.locator('#antigravity-chat-container [data-agy-permission] button').first().click();
    await page.waitForFunction(() => antigravityState.status === 'idle');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity compacts through its advertised native command and keeps progress in history and tiles', async ({ page }) => {
  const phases = [];
  page.on('websocket', socket => {
    socket.on('framereceived', event => {
      try {
        const payload = JSON.parse(String(event.payload));
        if (payload.type === 'antigravity-event' && payload.event?.message?.kind === 'compaction') phases.push(payload.event.message.compactionStatus);
      } catch (_) {}
    });
  });
  const id = await createSession(page);
  try {
    await send(page, 'Prepare the conversation for compaction');
    await page.waitForFunction(() => antigravityState.status === 'idle');
    const usersBefore = await page.evaluate(() => antigravityMessages.filter(item => item.kind === 'user').length);
    const compact = page.locator('#antigravity-compact-btn');
    await expect(compact).toBeVisible();
    await expect(compact).toBeEnabled();
    const compactResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/sessions/${id}/antigravity-compact`));
    await compact.click();
    expect((await compactResponse).ok()).toBe(true);
    const card = page.locator('#antigravity-chat-container .antigravity-compaction-card').last();
    await expect(card).toHaveAttribute('data-agy-compaction-phase', 'completed');
    await expect(card).toContainText('Context compacted');
    await page.waitForFunction(() => antigravityState.status === 'idle' && !antigravityState.compacting);
    await expect(compact).toBeEnabled();
    expect(phases).toContain('in_progress');
    expect(phases).toContain('completed');
    expect(await page.evaluate(() => antigravityMessages.filter(item => item.kind === 'user').length)).toBe(usersBefore);
    const history = await (await page.request.get(`/api/sessions/${id}/history`)).json();
    expect(history.text).not.toContain('User: /compact');

    await page.evaluate(() => { window.__beforeCompactionReconnect = currentSocket; currentSocket.close(); });
    await page.waitForFunction(() => currentSocket !== window.__beforeCompactionReconnect && currentSocket?.readyState === WebSocket.OPEN);
    await expect(card).toHaveAttribute('data-agy-compaction-phase', 'completed');
    if (page.viewportSize().width >= 920) {
      await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
      const tile = page.locator(`.tile-session-window[data-session-id="${id}"]`);
      await expect(tile.locator('.antigravity-compaction-card')).toHaveAttribute('data-agy-compaction-phase', 'completed');
      await expect(tile.locator('.antigravity-compaction-card')).toContainText('Context compacted');
      await expect(tile.locator('.antigravity-compaction-card button')).toHaveCount(0);
    }
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Antigravity compaction cards distinguish running, completed, failed and stopped phases in read-only previews', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const phases = await page.evaluate(() => {
    const messages = ['in_progress', 'completed', 'failed', 'cancelled'].map((status, index) => ({ id: `compaction-${index}`, kind: 'compaction', compactionStatus: status }));
    const host = document.createElement('div');
    host.innerHTML = buildAntigravityConversationHtml(messages, [], { status: 'idle' });
    makeTileConversationReadOnly(host);
    return Array.from(host.querySelectorAll('.antigravity-compaction-card')).map(card => ({ phase: card.dataset.agyCompactionPhase, title: card.querySelector('.codex-compaction-title').textContent, running: card.classList.contains('running'), controls: card.querySelectorAll('button, input, select').length }));
  });
  expect(phases).toEqual([
    { phase: 'running', title: 'Compacting context', running: true, controls: 0 },
    { phase: 'completed', title: 'Context compacted', running: false, controls: 0 },
    { phase: 'failed', title: 'Compaction failed', running: false, controls: 0 },
    { phase: 'cancelled', title: 'Compaction stopped', running: false, controls: 0 }
  ]);
});
