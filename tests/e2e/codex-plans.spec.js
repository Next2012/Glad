const { test, expect } = require('@playwright/test');

async function connect(page, id) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
}

async function openPlan(page, prompt = '__GLAD_E2E_PLAN_HOLD__') {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await connect(page, id);
  await page.locator('#cmd-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(page.locator('#codex-chat-container .codex-plan-card.floating')).toBeVisible();
  return id;
}

const floating = page => page.locator('#codex-chat-container .codex-plan-card.floating');
const historyPlans = page => page.locator('#codex-chat-container .codex-conversation > .codex-plan-history');

async function expectConversationOrder(page, expected) {
  await expect.poll(() => page.locator('#codex-chat-container .codex-conversation').evaluate(element =>
    Array.from(element.children).flatMap(child => child.matches('.codex-message-block.user') ? ['user']
      : child.matches('.codex-message-block.assistant') ? ['assistant']
      : child.matches('.codex-plan-history') ? ['plan'] : [])
  )).toEqual(expected);
}

test('saved plans restore in fresh sessions, retain their turn status, and survive repeated resume and fork', async ({ page }) => {
  let id;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Historical plans' } });
      expect(created.ok()).toBe(true);
      id = (await created.json()).id;
      for (let resume = 0; resume < 2; resume += 1) {
        const response = await page.request.post(`/api/sessions/${id}/codex-resume`, { data: { threadId: 'plan-history-e2e' } });
        expect(response.ok()).toBe(true);
        if (resume === 0) await connect(page, id);
        const cards = historyPlans(page);
        await expect(cards).toHaveCount(2);
        await expect(cards.first()).toHaveAttribute('data-plan-phase', 'completed');
        await expect(cards.first().locator('.codex-plan-count')).toHaveText('3/3');
        await expect(cards.last()).toHaveAttribute('data-plan-phase', 'stopped');
        await expect(cards.last().locator('.codex-plan-count')).toHaveText('1/3');
        await expect(floating(page)).toHaveCount(0);
        await expectConversationOrder(page, ['user', 'plan', 'assistant', 'user', 'plan', 'assistant']);
      }
      await connect(page, id);
      await expect(historyPlans(page)).toHaveCount(2);
      await historyPlans(page).last().locator('summary').click();
      await expect(historyPlans(page).last().locator('.codex-plan-step.current')).toContainText('恢复步骤状态');
      await expect(historyPlans(page).last().locator('.spinning')).toHaveCount(0);
      const forked = await page.request.post(`/api/sessions/${id}/codex-fork`, { data: { threadId: 'plan-history-e2e' } });
      expect(forked.ok()).toBe(true);
      await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe('fork-of-plan-history-e2e');
      await expect(historyPlans(page)).toHaveCount(2);
      await expectConversationOrder(page, ['user', 'plan', 'assistant', 'user', 'plan', 'assistant']);
      await page.screenshot({ path: test.info().outputPath(`restored-task-plans-${attempt}.png`) });
      await page.request.delete(`/api/sessions/${id}`);
      id = null;
    }
  } finally { if (id) await page.request.delete(`/api/sessions/${id}`); }
});

test('live plans update one card, preserve collapse, and survive reconnect', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = await openPlan(page);
  try {
    const card = floating(page);
    const wide = await page.locator('#codex-chat-container').evaluate(element => element.clientWidth >= 640);
    await expect(card).toHaveJSProperty('open', wide);
    if (wide) await card.locator('summary').click();
    await expect(card.locator('.codex-plan-count')).toHaveText('2/4');
    await expect(card).toHaveJSProperty('open', false);
    await expect(card.locator('.codex-plan-current')).toHaveText('运行测试');
    await expect(card).toHaveCount(1);
    await card.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(card).toHaveJSProperty('open', true);
    await expect(card.locator('.codex-plan-step')).toHaveCount(4);
    await expect(card.locator('.codex-plan-step').nth(1)).toContainText('<script>unsafe()</script>');
    await expect(card.locator('script')).toHaveCount(0);
    await connect(page, id);
    await expect(card.locator('.codex-plan-count')).toHaveText('2/4');
    expect(errors).toEqual([]);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('each finished plan moves between its command and first reply, including after reconnect', async ({ page }) => {
  const id = await openPlan(page, '__GLAD_E2E_PLAN__');
  try {
    const liveCard = floating(page);
    if (!(await liveCard.evaluate(element => element.open))) await liveCard.locator('summary').click();
    const card = historyPlans(page);
    await expect(card).toHaveAttribute('data-plan-phase', 'completed');
    await expect(liveCard).toHaveCount(0);
    await expect(card).toHaveJSProperty('open', false);
    await expect(card.locator('.codex-plan-count')).toHaveText('4/4');
    await card.locator('summary').click();
    await expect(card.locator('.codex-plan-step.completed')).toHaveCount(4);
    await expect(card.locator('.spinning')).toHaveCount(0);
    await expectConversationOrder(page, ['user', 'plan', 'assistant', 'assistant']);
    await expect(page.locator('#send-btn')).toBeEnabled();
    await page.locator('#cmd-input').fill('__GLAD_E2E_PLAN_SECOND__');
    await page.locator('#send-btn').click();
    await expect(liveCard).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(card).toHaveCount(2, { timeout: 10000 });
    await expect(liveCard).toHaveCount(0);
    const order = ['user', 'plan', 'assistant', 'assistant', 'user', 'plan', 'assistant', 'assistant'];
    await expectConversationOrder(page, order);
    await connect(page, id);
    await expectConversationOrder(page, order);
    await expect(card).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath('completed-plans-between-messages.png') });
    await page.locator('#cmd-input').fill('Next question without a plan');
    await page.locator('#send-btn').click();
    await expect(liveCard).toHaveCount(0);
    await expect(card).toHaveCount(2);
    await expectConversationOrder(page, [...order, 'user']);
    await card.last().locator('summary').click();
    await expect(card.last().locator('.codex-plan-step')).toHaveCount(4);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('stopping a turn preserves progress and keeps child tasks out of the root card', async ({ page }) => {
  const id = await openPlan(page, '__GLAD_E2E_PLAN_CHILD_HOLD__');
  try {
    const card = floating(page);
    await expect(card.locator('.codex-plan-count')).toHaveText('2/4');
    await expect(card).not.toContainText('子任务独立检查');
    await page.locator('#codex-abort-btn').click();
    const history = historyPlans(page);
    await expect(history).toHaveAttribute('data-plan-phase', 'stopped');
    await expect(card).toHaveCount(0);
    await expect(history.locator('.codex-plan-count')).toHaveText('2/4');
    await expect(history.locator('.spinning')).toHaveCount(0);
    await expectConversationOrder(page, ['user', 'plan', 'assistant', 'assistant']);
    await history.locator('summary').click();
    await expect(history.locator('.codex-plan-step.current')).toHaveCount(1);
    await history.locator('summary').click();
    const child = page.locator('.codex-subagent-group');
    await child.locator(':scope > summary').click();
    await expect(child.locator('.codex-plan-card')).toHaveAttribute('data-plan-phase', 'stopped');
    await expect(child.locator('.codex-plan-count')).toHaveText('0/1');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('failed turns do not mark unfinished tasks completed', async ({ page }) => {
  const id = await openPlan(page, '__GLAD_E2E_PLAN_FAIL__');
  try {
    const card = historyPlans(page);
    await expect(card).toHaveAttribute('data-plan-phase', 'failed');
    await expect(floating(page)).toHaveCount(0);
    await expect(card.locator('.codex-plan-count')).toHaveText('2/4');
    await expect(card).toHaveJSProperty('open', false);
    await expect(card.locator('.spinning')).toHaveCount(0);
    await expectConversationOrder(page, ['user', 'plan', 'assistant', 'assistant']);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('long plans stay within the chat pane and support both themes', async ({ page }) => {
  const id = await openPlan(page, '__GLAD_E2E_PLAN_LONG_HOLD__');
  try {
    const card = floating(page);
    if (!(await card.evaluate(element => element.open))) await card.locator('summary').click();
    await expect(card.locator('.codex-plan-step')).toHaveCount(28);
    const pane = await page.locator('#codex-chat-container').boundingBox();
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(pane.x);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
    expect(box.y).toBeGreaterThanOrEqual(pane.y);
    expect(box.height).toBeLessThanOrEqual(pane.height / 3 + 3);
    const chat = page.locator('#codex-chat-container');
    expect(await chat.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await chat.evaluate(element => { element.scrollTop = 0; });
    const top = (await card.boundingBox()).y;
    await chat.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(Math.abs((await card.boundingBox()).y - top)).toBeLessThanOrEqual(2);
    const body = card.locator('.codex-plan-body');
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await body.evaluate(element => { element.scrollTop = 0; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => setGladTheme(value), theme);
      await page.screenshot({ path: test.info().outputPath(`task-plan-${theme}.png`) });
    }
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('tiled sessions keep separate, locally expandable plan cards', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Tiled desktop workspace');
  const first = await openPlan(page, '__GLAD_E2E_PLAN_LONG_HOLD__');
  let second;
  try {
    second = await openPlan(page);
    await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
    const firstTile = page.locator(`.tile-session-window[data-session-id="${first}"]`);
    const secondTile = page.locator(`.tile-session-window[data-session-id="${second}"]`);
    const firstCard = firstTile.locator('.codex-plan-card.floating');
    const secondCard = secondTile.locator('.codex-plan-card.floating');
    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();
    await expect(firstCard).toHaveJSProperty('open', false);
    await expect(secondCard).toHaveJSProperty('open', false);
    await firstCard.locator('summary').click();
    await expect(firstCard).toHaveJSProperty('open', true);
    await expect(secondCard).toHaveJSProperty('open', false);
    await expect(firstCard.locator('.codex-plan-step')).toHaveCount(28);
    await expect(secondCard.locator('.codex-plan-step')).toHaveCount(4);
    const pane = await firstTile.locator('.tile-chat-surface').boundingBox();
    const box = await firstCard.boundingBox();
    expect(box.height).toBeLessThanOrEqual(pane.height / 3 + 3);
    await page.evaluate(id => renderTileConversation(id), first);
    await expect(firstCard).toHaveJSProperty('open', true);
    await page.screenshot({ path: test.info().outputPath('task-plan-tiles.png') });
  } finally {
    await page.request.delete(`/api/sessions/${first}`);
    if (second) await page.request.delete(`/api/sessions/${second}`);
  }
});
