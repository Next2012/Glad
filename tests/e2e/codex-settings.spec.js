const { test, expect } = require('@playwright/test');

async function createAndConnectCodex(page, codexOptions = {}) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', codexOptions } });
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

test('Fast is opt-in per session, affects the next turn, and disappears for unsupported models', async ({ page }) => {
  const firstId = await createAndConnectCodex(page, { model: 'gpt-e2e', effort: 'medium' });
  let secondId;
  const panel = page.locator('#codex-model-panel');
  const fast = panel.getByRole('switch', { name: 'Fast mode' });
  async function toggleFast(checked) {
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith(`/api/sessions/${firstId}/codex-settings`));
    await fast.click();
    expect((await saved).ok()).toBe(true);
    await expect(fast).toHaveAttribute('aria-checked', String(checked));
    await expect(fast).toBeEnabled();
  }
  async function sendTierProbe(tier) {
    await page.locator('#codex-model-btn').click();
    await page.locator('#cmd-input').fill(`__GLAD_E2E_SERVICE_TIER__ ${tier}`);
    await page.locator('#send-btn').click();
    await expect(page.locator('#codex-chat-container')).toContainText(`Service tier: ${tier}; model: gpt-e2e; effort: medium`);
    await page.waitForFunction(() => codexState.status === 'idle');
    await page.locator('#codex-model-btn').click();
  }
  try {
    await page.locator('#codex-model-btn').click();
    await expect(fast).toHaveAttribute('aria-checked', 'false');
    await toggleFast(true);
    await sendTierProbe('priority');
    await expect(fast).toHaveAttribute('aria-checked', 'true');
    await toggleFast(false);
    await sendTierProbe('default');
    await toggleFast(true);

    secondId = await createAndConnectCodex(page, { model: 'gpt-e2e', effort: 'medium' });
    await page.locator('#codex-model-btn').click();
    await expect(fast).toHaveAttribute('aria-checked', 'false');
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${firstId}"]`).getByRole('button', { name: 'Connect' }).click();
    await page.locator('#codex-model-btn').click();
    await expect(fast).toHaveAttribute('aria-checked', 'true');
    await panel.getByRole('button', { name: 'Luna', exact: true }).click();
    await expect(fast).toHaveCount(0);
    const changed = page.waitForResponse(response => response.request().method() === 'PATCH'
      && response.url().endsWith(`/api/sessions/${firstId}/codex-settings`));
    await panel.getByRole('button', { name: 'low', exact: true }).click();
    expect((await changed).ok()).toBe(true);
    await expect.poll(() => page.evaluate(() => codexState.serviceTier)).toBe('default');
    const invalid = await page.request.patch(`/api/sessions/${firstId}/codex-settings`, { data: { serviceTier: 'priority' } });
    expect(invalid.ok()).toBe(false);
  } finally {
    if (secondId) await page.request.delete(`/api/sessions/${secondId}`);
    await page.request.delete(`/api/sessions/${firstId}`);
  }
});

test('failed Fast saves restore the switch and the selected service tier', async ({ page }) => {
  const id = await createAndConnectCodex(page, { model: 'gpt-e2e', effort: 'medium' });
  try {
    await page.route(`**/api/sessions/${id}/codex-settings`, route => route.fulfill({
      status: 400, json: { success: false, error: 'Fast unavailable' }
    }));
    await page.locator('#codex-model-btn').click();
    const fast = page.getByRole('switch', { name: 'Fast mode' });
    await fast.click();
    await expect(page.locator('#app-toast')).toHaveText('Fast unavailable');
    await expect(fast).toHaveAttribute('aria-checked', 'false');
    await expect(fast).toBeEnabled();
    expect(await page.evaluate(() => codexState.serviceTier)).toBe('default');
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});
