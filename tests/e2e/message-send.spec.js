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
  await page.waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN);
  return { id, sent };
}

test('structured send is acknowledged, idempotent, and preserves rejected drafts', async ({ page }) => {
  const first = await openCodexSession(page);
  await page.locator('#attachment-file-input').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment body')
  });
  await page.locator('.attachment-chip:not(.uploading)').waitFor();
  await page.locator('#cmd-input').fill('Read the attachment and keep this visible');
  await page.locator('#send-btn').click();
  await expect(page.locator('#cmd-input')).toHaveValue('');
  await expect(page.locator('.codex-message-block.user')).toHaveCount(1);
  await expect(page.locator('.codex-message-block.user')).toContainText('Read the attachment and keep this visible');
  await expect(page.locator('.codex-message-block.user')).toContainText('notes.txt');
  await page.waitForTimeout(500);
  const history = await (await page.request.get(`/api/sessions/${first.id}/history`)).json();
  expect((history.text.match(/User:/g) || [])).toHaveLength(1);
  expect(history.text).not.toContain('/tmp/glad/attachments');
  const firstFrame = first.sent.find(item => item.type === 'codex-input');
  expect(firstFrame.clientMessageId).toBeTruthy();
  await page.request.delete(`/api/sessions/${first.id}`);

  const missing = await openCodexSession(page);
  await page.locator('#attachment-file-input').setInputFiles({
    name: 'missing.txt', mimeType: 'text/plain', buffer: Buffer.from('remove before send')
  });
  await page.locator('.attachment-chip:not(.uploading)').waitFor();
  const attachmentId = await page.evaluate(() => selectedFileAttachments[0].id);
  await page.request.delete(`/api/sessions/${missing.id}/attachments/files/${attachmentId}`);
  await page.locator('#cmd-input').fill('This draft must survive');
  const rejection = page.waitForEvent('dialog');
  await page.locator('#send-btn').click();
  const dialog = await rejection;
  expect(dialog.message()).toContain('attachments are no longer available');
  await dialog.dismiss();
  await expect(page.locator('#cmd-input')).toHaveValue('This draft must survive');
  await expect(page.locator('.attachment-chip')).toContainText('missing.txt');
  await expect(page.locator('#send-btn')).toBeEnabled();
  expect((await (await page.request.get(`/api/sessions/${missing.id}/history`)).json()).text).toBe('');
  await page.request.delete(`/api/sessions/${missing.id}`);

  const idempotent = await openCodexSession(page);
  await page.evaluate(() => {
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
  await page.locator('#cmd-input').fill('Keep this after disconnect');
  await page.evaluate(() => currentSocket.close());
  await expect(page.locator('#send-btn')).toBeDisabled();
  await page.evaluate(() => performSend());
  await expect(page.locator('#cmd-input')).toHaveValue('Keep this after disconnect');
  expect(session.sent.filter(item => item.type === 'codex-input')).toHaveLength(0);
  await page.request.delete(`/api/sessions/${session.id}`);

  const whitespace = await openCodexSession(page);
  await page.locator('#cmd-input').fill('   \n  ');
  await page.locator('#send-btn').click();
  await expect(page.locator('#cmd-input')).toHaveValue('   \n  ');
  expect(whitespace.sent.filter(item => item.type === 'codex-input')).toHaveLength(0);
  await page.request.delete(`/api/sessions/${whitespace.id}`);
});

test('provider rejection keeps the draft and unlocks send', async ({ page }) => {
  const session = await openCodexSession(page);
  const text = '__GLAD_E2E_FAIL_SEND__ keep this draft';
  await page.locator('#cmd-input').fill(text);
  const rejection = page.waitForEvent('dialog');
  await page.locator('#send-btn').click();
  await page.locator('#cmd-input').fill('');
  const dialog = await rejection;
  expect(dialog.message()).toContain('forced send failure');
  await dialog.dismiss();
  await expect(page.locator('#cmd-input')).toHaveValue(text);
  await expect(page.locator('#send-btn')).toBeEnabled();
  await expect(page.locator('.codex-message-block.user')).toHaveCount(0);
  await page.request.delete(`/api/sessions/${session.id}`);
});
