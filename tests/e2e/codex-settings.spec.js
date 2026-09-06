const { test, expect } = require('@playwright/test');

async function createAndConnectCodex(page) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#codex-model-btn')).toBeVisible();
  return id;
}

test('Codex settings persist as Glad defaults and global defaults require an explicit action', async ({ page }) => {
  const firstId = await createAndConnectCodex(page);
  let secondId = '';
  try {
    await page.locator('#codex-model-btn').click();
    await page.locator('#codex-model-panel').getByRole('button', { name: 'Luna', exact: true }).click();
    const modelSave = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith(`/api/sessions/${firstId}/codex-settings`));
    await page.locator('#codex-model-panel').getByRole('button', { name: 'low', exact: true }).click();
    expect((await modelSave).ok()).toBe(true);

    const policySaves = [];
    const collectPolicySave = response => {
      if (response.request().method() === 'PATCH'
        && response.url().endsWith(`/api/sessions/${firstId}/codex-settings`)) policySaves.push(response);
    };
    page.on('response', collectPolicySave);
    await page.locator('#codex-sandbox-select').selectOption('workspace-write');
    await page.locator('#codex-permission-select').selectOption('on-request');
    await expect.poll(() => policySaves.length).toBe(2);
    expect(policySaves.every(response => response.ok())).toBe(true);
    page.off('response', collectPolicySave);
    await expect.poll(() => page.evaluate(() => ({
      model: codexState.model,
      effort: codexState.effort,
      sandboxMode: codexState.sandboxMode,
      permissionMode: codexState.permissionMode
    }))).toEqual({
      model: 'gpt-5.6-luna', effort: 'low',
      sandboxMode: 'workspace-write', permissionMode: 'on-request'
    });

    const created = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
    expect(created.ok()).toBe(true);
    secondId = (await created.json()).id;
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${secondId}"]`).getByRole('button', { name: 'Connect' }).click();
    await expect.poll(() => page.evaluate(() => ({
      model: codexState.model,
      effort: codexState.effort,
      sandboxMode: codexState.sandboxMode,
      permissionMode: codexState.permissionMode
    }))).toEqual({
      model: 'gpt-5.6-luna', effort: 'low',
      sandboxMode: 'workspace-write', permissionMode: 'on-request'
    });

    page.once('dialog', dialog => dialog.accept());
    const globalSave = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith(`/api/sessions/${secondId}/codex-global-defaults`));
    await page.getByRole('button', { name: 'Set current settings as Codex global defaults' }).click();
    expect((await globalSave).ok()).toBe(true);
    await expect(page.locator('#app-toast')).toHaveText('Codex global defaults updated');
  } finally {
    if (secondId) await page.request.delete(`/api/sessions/${secondId}`);
    await page.request.delete(`/api/sessions/${firstId}`);
  }
});
