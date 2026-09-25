const { test, expect } = require('@playwright/test');
const { mockVisualViewport } = require('./helpers/visual-viewport');

const screenshot = {
  name: 'screenshot.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
};

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

async function editableQuestionCard(page) {
  if (page.viewportSize().width <= 640) {
    await page.locator('#codex-chat-container .codex-question-card').last()
      .getByRole('button', { name: /Answer question/ }).click();
    return page.locator('#codex-question-reply .codex-question-card');
  }
  return page.locator('#codex-chat-container .codex-question-card').last();
}

test('async questions accept an answer during work and preserve the draft across stream updates', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION__');
  try {
    const inlineCard = page.locator('#codex-chat-container .codex-question-card').last();
    const card = await editableQuestionCard(page);
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
    await expect(inlineCard).toContainText('Answer sent');
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toHaveCount(2);
    await expect(page.locator('.codex-message-block.assistant').last()).toContainText('Received answer');
    await expect(page.getByRole('button', { name: 'Jump to pending question' })).toHaveCount(0);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

for (const iosStandalone of [false, true]) {
  test(`mobile answer panel follows the keyboard and sends a screenshot (${iosStandalone ? 'PWA' : 'browser'})`, async ({ page }) => {
    test.skip(page.viewportSize().width > 640, 'Mobile answer panel regression');
    await mockVisualViewport(page, { iosStandalone });
    const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION__');
    try {
      await page.getByRole('button', { name: 'Jump to pending question' }).click();
      const panel = page.locator('#codex-question-reply');
      await expect(panel).toBeVisible();
      const card = panel.locator('.codex-question-card');
      await card.locator('[data-codex-question-file]').setInputFiles(screenshot);
      await expect(card.locator('.codex-question-image')).toContainText('screenshot.png');
      await card.locator('textarea').first().fill('See attached screenshot');
      await card.locator('textarea').nth(1).fill('2位');
      const layoutHeight = await page.evaluate(() => innerHeight);
      for (const geometry of [
        { height: 520, offsetTop: 0 },
        { height: 520, offsetTop: 140 },
        { height: layoutHeight, offsetTop: 0 },
        { height: 520, offsetTop: 0 }
      ]) {
        await page.evaluate(next => window.setTestVisualViewport(next), geometry);
        await expect.poll(() => page.evaluate(() => {
          const viewport = window.visualViewport;
          const submit = document.querySelector('#codex-question-reply button[type="submit"]').getBoundingClientRect();
          const body = document.querySelector('#codex-question-reply .codex-question-body').getBoundingClientRect();
          const input = document.activeElement.getBoundingClientRect();
          return submit.top >= viewport.offsetTop && submit.bottom <= viewport.offsetTop + viewport.height
            && body.height > 0 && body.top >= viewport.offsetTop
            && input.top >= body.top - 1 && input.bottom <= body.bottom + 1;
        })).toBe(true);
        expect(await page.evaluate(() => innerHeight)).toBe(layoutHeight);
        await expect(card.locator('textarea').nth(1)).toBeFocused();
        await expect(card.locator('textarea').first()).toHaveValue('See attached screenshot');
      }
      await page.screenshot({ path: test.info().outputPath('mobile-answer-panel.png') });
      const answerRequest = page.waitForRequest(request => request.url().endsWith('/codex-user-input'));
      await card.getByRole('button', { name: 'Submit answer' }).click();
      expect((await answerRequest).postDataJSON().attachmentIds).toHaveLength(1);
      await expect(page.locator('#codex-chat-container .codex-question-card')).toContainText('Answer sent');
      await expect(page.locator('.codex-message-block.user').last().locator('.claude-message-attachment')).toHaveCount(1);
    } finally { await page.request.delete(`/api/sessions/${id}`); }
  });
}

test('blocking questions survive refresh and only resume after all answers are submitted', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_SYNC_QUESTION__');
  try {
    let card = await editableQuestionCard(page);
    await expect(card).toContainText('Waiting for your answer');
    await page.waitForTimeout(600);
    await expect(page.locator('#send-btn')).toBeDisabled();
    await expect(page.locator('.codex-message-block.assistant')).toHaveCount(0);
    await connect(page, id);
    card = await editableQuestionCard(page);
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
    await expect(page.locator('#codex-chat-container .codex-question-card').last()).toContainText('Answer sent');
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
    const card = await editableQuestionCard(page);
    await card.locator('textarea').first().fill('reject-once');
    await card.locator('textarea').nth(1).fill('2位');
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(card.getByRole('alert')).toContainText('forced answer failure');
    await expect(card.locator('textarea').first()).toHaveValue('reject-once');
    await expect(card.locator('textarea').nth(1)).toHaveValue('2位');
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    await expect(page.locator('.codex-message-block.user')).toHaveCount(1);
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(page.locator('#codex-chat-container .codex-question-card').last()).toContainText('Answer sent');
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

test('answer panel recovers after a websocket reconnect without losing the draft', async ({ page }) => {
  test.skip(page.viewportSize().width > 640, 'Mobile answer panel regression');
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION_IDLE__');
  try {
    await expect(page.locator('#send-btn')).toBeEnabled();
    const card = await editableQuestionCard(page);
    await card.locator('textarea').first().fill('Keep this answer');
    await card.locator('textarea').nth(1).fill('2位');
    await page.evaluate(() => {
      const id = codexQuestionReplyId;
      closeCodexQuestionReply();
      currentSocket.close();
      openCodexQuestionReply(id);
    });
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
    await page.waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    await expect(card.locator('textarea').first()).toHaveValue('Keep this answer');
    await expect(card.locator('textarea').nth(1)).toHaveValue('2位');
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(page.locator('#codex-chat-container .codex-question-card')).toContainText('Answer sent');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('failed screenshot uploads show an error and retry keeps the answer focused', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION_IDLE__');
  let releaseUpload;
  try {
    await expect(page.locator('#send-btn')).toBeEnabled();
    const card = await editableQuestionCard(page);
    await card.locator('textarea').first().fill('See the screenshot');
    await card.locator('textarea').nth(1).fill('2位');
    let attempts = 0;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    await page.route('**/attachments/images/chunks', async route => {
      if (++attempts === 1) {
        await route.fulfill({ status: 500, json: { error: 'forced screenshot upload failure' } });
      } else {
        await uploadGate;
        await route.continue();
      }
    });
    await card.locator('[data-codex-question-file]').setInputFiles(screenshot);
    await expect(card.getByRole('alert')).toContainText('forced screenshot upload failure');
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    const uploading = page.waitForRequest(request => request.url().endsWith('/attachments/images/chunks'));
    await card.locator('[data-codex-question-file]').setInputFiles(screenshot);
    await uploading;
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
    const field = card.locator('textarea').first();
    await field.focus();
    await field.evaluate(element => element.setSelectionRange(4, 7));
    releaseUpload();
    await expect(card.locator('.codex-question-image')).toContainText('screenshot.png');
    await expect(card.getByRole('button', { name: 'Submit answer' })).toBeEnabled();
    await expect(card.locator('.codex-question-error')).toBeEmpty();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('See the screenshot');
    expect(await field.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([4, 7]);
  } finally {
    releaseUpload?.();
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('screenshots cannot be removed while an answer is being submitted', async ({ page }) => {
  const id = await openSession(page, '__GLAD_E2E_ASYNC_QUESTION_IDLE__');
  let releaseAnswer;
  try {
    await expect(page.locator('#send-btn')).toBeEnabled();
    const card = await editableQuestionCard(page);
    await card.locator('[data-codex-question-file]').setInputFiles(screenshot);
    await expect(card.locator('.codex-question-image')).toBeVisible();
    await card.locator('textarea').first().fill('See screenshot');
    await card.locator('textarea').nth(1).fill('2位');
    const gate = new Promise(resolve => { releaseAnswer = resolve; });
    await page.route('**/codex-user-input', async route => { await gate; await route.continue(); });
    const posted = page.waitForRequest(request => request.url().endsWith('/codex-user-input'));
    const result = page.waitForResponse(response => response.url().endsWith('/codex-user-input'));
    await card.getByRole('button', { name: 'Submit answer' }).click();
    const payload = (await posted).postDataJSON();
    await expect(card.locator('[data-remove-codex-question-image]')).toBeDisabled();
    // Also protect callers that already queued a removal before the UI updated.
    await page.evaluate(({ id, attachmentIds }) => removeCodexQuestionImage(id, attachmentIds[0]), payload);
    await expect(card.locator('.codex-question-image')).toBeVisible();
    releaseAnswer();
    expect((await result).ok()).toBe(true);
    await expect(page.locator('#codex-chat-container .codex-question-card')).toContainText('Answer sent');
    await expect(page.locator('.codex-message-block.user').last().locator('.claude-message-attachment')).toHaveCount(1);
  } finally {
    releaseAnswer?.();
    await page.request.delete(`/api/sessions/${id}`);
  }
});
