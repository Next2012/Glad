const { test, expect } = require('@playwright/test');

async function openSession(page, prompt) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await connect(page, id);
  await page.locator('#cmd-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(page.locator('.codex-question-card')).toBeVisible();
  return id;
}

async function connect(page, id) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
}

test('async questions accept an answer during work and preserve the draft across stream updates', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION__');
  try {
    const card = page.locator('.codex-question-card');
    await expect(card).toContainText('You can answer while Codex continues working');
    await expect(page.locator('#send-btn')).toBeDisabled();
    await card.getByRole('button', { name: '1000次独立动作', exact: true }).click();
    await card.locator('textarea').nth(1).fill('2位');
    await page.waitForTimeout(800);
    await expect(card.locator('textarea').first()).toHaveValue('1000次独立动作');
    await expect(card.locator('textarea').nth(1)).toHaveValue('2位');
    await expect(card.locator('textarea').nth(1)).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('question-card.png') });
    await expect(page.locator('.codex-message-block.assistant')).toContainText('继续整理');
    const answerResponse = page.waitForResponse(response => response.url().endsWith('/codex-user-input'));
    await card.getByRole('button', { name: 'Submit answer' }).click();
    expect((await answerResponse).ok()).toBe(true);
    await expect(card).toContainText('Answer sent');
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toHaveCount(2);
    await expect(page.locator('.codex-message-block.assistant').last()).toContainText('Received answer');
    await expect(page.getByRole('button', { name: 'Jump to pending question' })).toHaveCount(0);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('blocking questions survive refresh and only resume after all answers are submitted', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_SYNC_QUESTION__');
  try {
    const card = page.locator('.codex-question-card');
    await expect(card).toContainText('Waiting for your answer');
    await page.waitForTimeout(600);
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(page.locator('.codex-message-block.assistant')).toHaveCount(0);
    await connect(page, id);
    await expect(card).toContainText('Waiting for your answer');
    const questionID = await card.getAttribute('data-codex-question-id');
    const incomplete = await page.request.post(`/api/sessions/${id}/codex-user-input`, { data: {
      id: questionID, clientMessageId: 'incomplete', answers: { count: '1000次独立动作' }
    } });
    expect(incomplete.status()).toBe(409);
    await expect(card).toContainText('Waiting for your answer');
    await card.getByRole('button', { name: '1000次独立动作 每次动作单独计数' }).click();
    await card.locator('textarea').nth(1).fill('2位');
    const answerRequest = page.waitForRequest(request => request.url().endsWith('/codex-user-input'));
    await card.getByRole('button', { name: 'Submit answer' }).click();
    const payload = (await answerRequest).postDataJSON();
    await expect(card).toContainText('Answer sent');
    await expect(page.locator('#send-btn')).toBeEnabled();
    const repeat = await page.request.post(`/api/sessions/${id}/codex-user-input`, { data: payload });
    expect(repeat.ok()).toBe(true);
    await expect(page.locator('.codex-message-block.user')).toHaveCount(2);
    await expect(page.locator('.codex-message-block.assistant')).toHaveCount(1);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('rejected async answers remain editable and can be retried', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION__');
  try {
    const card = page.locator('.codex-question-card');
    await card.locator('textarea').first().fill('reject-once');
    await card.locator('textarea').nth(1).fill('2位');
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(card.getByRole('alert')).toContainText('forced answer failure');
    await expect(card.locator('textarea').first()).toHaveValue('reject-once');
    await expect(card.locator('textarea').nth(1)).toHaveValue('2位');
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toHaveCount(1);
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(card).toContainText('Answer sent');
    await expect(page.locator('#send-btn')).toBeEnabled();
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('completed async questions accept a late reply and aborted questions close', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Lifecycle regression runs once on desktop');
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION_IDLE__');
  try {
    const card = page.locator('.codex-question-card');
    await expect(page.locator('#send-btn')).toBeEnabled();
    await card.locator('textarea').first().fill('1000次');
    await card.locator('textarea').nth(1).fill('2位');
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(card).toContainText('Answer sent');
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toHaveCount(2);
    await page.locator('#cmd-input').fill('__GLAD_E2E_SYNC_QUESTION__');
    await page.locator('#send-btn').click();
    await expect(card.last()).toContainText('Waiting for your answer');
    await page.locator('#codex-abort-btn').click();
    await expect(card.last()).toContainText('Question closed');
    await expect(card.last().getByRole('button', { name: 'Submit answer' })).toHaveCount(0);
    await expect(page.locator('#send-btn')).toBeEnabled();
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});
