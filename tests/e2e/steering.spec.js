const { conversationView } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

for (const provider of [
  { key: 'codex', marker: '__GLAD_E2E_STEER__', reply: 'Received steering instruction: ', state: 'codexState', container: '#codex-chat-container' },
  { key: 'antigravity', marker: 'agy-long', reply: 'AGY steering accepted: ', state: 'antigravityState', container: '#antigravity-chat-container' }
]) {
  async function connect(page) {
    const created = await page.request.post('/api/sessions', { data: { toolKey: provider.key } });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
    await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
    await (await conversationView(page)).waitForFunction(state => window.eval(state).status === 'idle', provider.state);
    return id;
  }
  test(`${provider.key} adds an instruction to the active turn and keeps idle controls unavailable`, async ({ page }) => {
    const sent = [];
    page.on('websocket', socket => socket.on('framesent', event => { try { sent.push(JSON.parse(String(event.payload))); } catch (_) {} }));
    const id = await connect(page);
    try {
      await (await conversationView(page)).locator('#cmd-input').fill(provider.marker);
      await (await conversationView(page)).locator('#send-btn').click();
      await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('');
      await expect((await conversationView(page)).locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
      await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
      await expect((await conversationView(page)).locator('#send-btn')).toContainText('Add instruction');
      await expect((await conversationView(page)).locator(`#${provider.key}-resume-btn`)).toBeDisabled();
      const turnId = await (await conversationView(page)).evaluate(state => window.eval(state).turnId, provider.state);
      expect(turnId).toBeTruthy();
      await (await conversationView(page)).locator('#cmd-input').fill('Use the smaller change');
      await (await conversationView(page)).locator('#send-btn').click();
      await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('');
      await expect((await conversationView(page)).locator(provider.container)).toContainText(provider.reply + 'Use the smaller change');
      const frames = sent.filter(frame => frame.type === `${provider.key}-input`);
      expect(frames).toHaveLength(2);
      expect(frames[0].delivery).toBeUndefined();
      expect(frames[1]).toMatchObject({ delivery: 'steer', expectedTurnId: turnId, text: 'Use the smaller change' });
      const turns = await (await conversationView(page)).evaluate(() => {
        const messages = isCodexSession() ? codexMessages : antigravityMessages;
        return [...new Set(messages.filter(item => item.kind === 'user').map(item => item.turnId))];
      });
      expect(turns).toEqual([turnId]);
    } finally { await page.request.delete(`/api/sessions/${id}`); }
  });

  test(`${provider.key} rejects expired steering without retrying or discarding draft attachments`, async ({ page }) => {
    const sent = [];
    page.on('websocket', socket => socket.on('framesent', event => { try { sent.push(JSON.parse(String(event.payload))); } catch (_) {} }));
    const id = await connect(page);
    try {
      await (await conversationView(page)).locator('#cmd-input').fill(provider.marker);
      await (await conversationView(page)).locator('#send-btn').click();
      await expect((await conversationView(page)).locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
      const turnId = await (await conversationView(page)).evaluate(state => window.eval(state).turnId, provider.state);
      await (await conversationView(page)).locator(`#${provider.key}-abort-btn`).click();
      await (await conversationView(page)).waitForFunction(state => window.eval(state).status === 'idle', provider.state);
      await (await conversationView(page)).locator('#attachment-file-input').setInputFiles({ name: 'instruction.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this attachment') });
      await (await conversationView(page)).locator('.attachment-chip:not(.uploading)').waitFor();
      await (await conversationView(page)).locator('#cmd-input').fill('Preserve the stale steering draft');
      // Dismiss as soon as the alert opens: waiting for click to return first
      // can deadlock Playwright's navigation wait against the modal dialog.
      const rejection = page.waitForEvent('dialog').then(async dialog => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      });
      const [message] = await Promise.all([
        rejection,
        (await conversationView(page)).evaluate(({ key, turnId }) => {
          // Inject the stale snapshot and click in one task so a late idle
          // frame cannot turn this intentional steering attempt into a new turn.
          const patch = { status: 'running', turnId, canSteer: true, canAbort: true };
          if (key === 'codex') applyCodexState(patch); else applyAntigravityState(patch);
          document.getElementById('send-btn').click();
        }, { key: provider.key, turnId })
      ]);
      expect(message).toContain('Unable to send');
      await expect((await conversationView(page)).locator('#cmd-input')).toHaveValue('Preserve the stale steering draft');
      await expect((await conversationView(page)).locator('.attachment-chip')).toContainText('instruction.txt');
      const attempts = sent.filter(frame => frame.type === `${provider.key}-input` && frame.text === 'Preserve the stale steering draft');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ delivery: 'steer', expectedTurnId: turnId });
      const history = await (await page.request.get(`/api/sessions/${id}/history`)).json();
      expect(history.text).not.toContain('Preserve the stale steering draft');
    } finally { await page.request.delete(`/api/sessions/${id}`); }
  });
}
