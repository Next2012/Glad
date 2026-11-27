const { test, expect } = require('@playwright/test');
const { conversationView } = require('./helpers/conversation');
async function open(page, policy = {}) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity', antigravityOptions: { permissionPolicy: { toolPermission: 'request-review', ...policy } } } });
  expect(response.ok()).toBeTruthy();
  const { id } = await response.json();
  await page.goto(`/?embed=1&embedSession=${id}`, { waitUntil: 'networkidle' });
  const view = await conversationView(page);
  await view.waitForFunction(() => activeSessionHydrated && antigravityState.status === 'idle');
  await view.locator('#antigravity-mode-control').click();
  await expect(view.locator('[data-agy-preset]')).toHaveCount(7);
  return { id, view };
}
async function apply(page, view, id) {
  const response = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${id}/antigravity-permissions`) && response.request().method() === 'PATCH');
  await view.locator('[data-agy-policy-apply]').click();
  expect((await response).ok()).toBeTruthy();
  await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
}
for (const width of [1440, 390]) test(`compact presets apply policy and rules at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const { id, view } = await open(page);
  try {
    const native = await view.evaluate(() => antigravityState.nativeConversationId);
    await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
    await expect(view.locator('#antigravity-permissions-panel details')).toHaveCount(0);
    await expect(view.locator('[data-agy-policy-toggle]')).toHaveCount(3);
    const mode = page.waitForResponse(r => r.url().endsWith('/antigravity-settings') && r.request().method() === 'PATCH');
    await view.locator('[data-agy-preset="accept-edits"]').click();
    expect((await mode).ok()).toBeTruthy();
    await expect(view.locator('[data-agy-preset="accept-edits"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
    await expect(view.locator('[data-agy-policy-toggle="enableTerminalSandbox"]')).toBeVisible();
    if (width === 390) {
      const geometry = await view.evaluate(() => {
        const panel = document.getElementById('antigravity-permissions-panel');
        const row = panel.querySelector('.agy-policy-switches').getBoundingClientRect();
        return { fits: panel.scrollHeight <= panel.clientHeight + 1, sandboxVisible: row.bottom <= panel.getBoundingClientRect().bottom + 1 };
      });
      expect(geometry).toEqual({ fits: true, sandboxVisible: true });
      await expect(view.locator('#antigravity-mode-control .agy-policy-short')).toHaveText('Edits');
    }
    await page.screenshot({ path: testInfo.outputPath(`presets-${width}.png`), fullPage: true });
    await view.locator('[data-agy-preset="strict"]').click();
    await expect(view.locator('[data-agy-policy-apply]')).toHaveText('Apply and reconnect');
    expect(await view.evaluate(() => antigravityState.permissionPolicy.values.toolPermission)).not.toBe('strict');
    await apply(page, view, id);
    expect(await view.evaluate(() => antigravityState.nativeConversationId)).toBe(native);
    await expect(view.locator('[data-agy-preset="strict"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('[data-agy-policy-current]')).toBeHidden();
    await view.locator('[data-agy-policy-tab="rules"]').click();
    await view.locator('[data-agy-rule-kind="allow"]').click();
    await view.locator('[data-agy-rule-list="allow"]').fill('command(git status)\nread_file(/tmp)');
    await apply(page, view, id);
    await expect(view.locator('[data-agy-rule-list="allow"]')).toHaveValue(/command\(git status\)/);
    await view.locator('[data-agy-rule-scope]').selectOption('project');
    await view.locator('[data-agy-rule-kind="deny"]').click();
    await view.locator('[data-agy-rule-list="deny"]').fill('command(regex:[)');
    const bad = page.waitForResponse(r => r.url().endsWith('/antigravity-permissions') && r.request().method() === 'PATCH');
    await view.locator('[data-agy-policy-apply]').click();
    expect((await bad).status()).toBe(400);
    await expect(view.locator('[data-agy-policy-error]')).toContainText('regular expression');
    await expect(view.locator('[data-agy-rule-list="deny"]')).toHaveValue('command(regex:[)');
    await view.locator('[data-agy-rule-list="deny"]').fill(`command(rm --fixture-${width})`);
    await apply(page, view, id);
    await expect(view.locator('[data-agy-rule-scope] option:checked')).toHaveText('Project · Glad (1)');
    await expect(view.locator('[data-agy-rule-help]')).toHaveCount(0);
    await expect(view.locator('[data-agy-policy-current]')).toBeHidden();
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    expect(errors).toEqual([]);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('presets preserve pending rules and reset Strict through a reconnect', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    await view.locator('[data-agy-preset="strict"]').click();
    await apply(page, view, id);
    const nativeMode = await view.evaluate(() => antigravityState.mode);
    await view.locator('[data-agy-preset="auto"]').click();
    await expect(view.locator('[data-agy-policy-apply]')).toHaveText('Apply and reconnect');
    expect(await view.evaluate(() => antigravityState.mode)).toBe(nativeMode);
    await expect(view.locator('[data-agy-policy-toggle="enableTerminalSandbox"]')).toHaveAttribute('aria-checked', 'true');
    await expect(view.locator('[data-agy-policy-toggle="enableTerminalSandbox"]')).toBeDisabled();
    await view.locator('[data-agy-policy-cancel]').click();
    await expect(view.locator('[data-agy-preset="strict"]')).toHaveAttribute('aria-pressed', 'true');
    await view.locator('[data-agy-policy-tab="rules"]').click();
    await view.locator('[data-agy-rule-list="deny"]').fill('command(rm)');
    await view.locator('[data-agy-policy-tab="policy"]').click();
    await view.locator('[data-agy-preset="accept-edits"]').click();
    expect(await view.evaluate(() => antigravityState.mode)).toBe(nativeMode);
    await view.locator('[data-agy-policy-tab="rules"]').click();
    await expect(view.locator('[data-agy-rule-list="deny"]')).toHaveValue('command(rm)');
    await apply(page, view, id);
    expect(await view.evaluate(() => antigravityState.mode)).toBe('accept-edits');
    expect(await view.evaluate(() => antigravityState.permissionPolicy.values.toolPermission)).toBe('request-review');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('rule shortcuts target the active list and keep other drafts intact', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    await view.locator('[data-agy-policy-tab="rules"]').click();
    await view.locator('[data-agy-rule-prefix="command"]').click();
    await expect(view.locator('[data-agy-rule-list="deny"]')).toHaveValue('command()');
    await expect(view.locator('[data-agy-rule-list="allow"]')).toHaveValue('');
    await view.locator('[data-agy-rule-kind="ask"]').click();
    await view.locator('[data-agy-rule-prefix="mcp"]').click();
    await expect(view.locator('[data-agy-rule-list="ask"]')).toHaveValue('mcp()');
    await expect(view.locator('[data-agy-rule-list="deny"]')).toHaveValue('command()');
    await view.locator('[data-agy-rule-kind="allow"]').click();
    await expect(view.locator('[data-agy-rule-list="ask"]')).toBeHidden();
    await view.locator('[data-agy-rule-prefix="read_file"]').click();
    await expect(view.locator('[data-agy-rule-list="allow"]')).toHaveValue('read_file()');
    await view.locator('[data-agy-policy-cancel]').click();
    await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('skip preset preserves sandbox and outside-workspace access preferences', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    const mode = await view.evaluate(() => antigravityState.mode);
    await view.locator('[data-agy-preset="skip"]').click();
    expect(await view.evaluate(() => antigravityState.mode)).toBe(mode);
    expect(await view.evaluate(() => agyPermissionDraft.enableTerminalSandbox)).toBe('inherit');
    expect(await view.evaluate(() => agyPermissionDraft.allowNonWorkspaceAccess)).toBe('inherit');
    page.once('dialog', dialog => dialog.accept());
    await apply(page, view, id);
    expect(await view.evaluate(() => antigravityState.mode)).toBe('accept-edits');
    expect(await view.evaluate(() => antigravityState.permissionPolicy.values.toolPermission)).toBe('always-proceed');
    await expect(view.locator('[data-agy-preset="skip"]')).toHaveAttribute('aria-pressed', 'true');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('mode shortcut preserves drafts and approval blocks policy changes', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    await view.locator('[data-agy-preset="strict"]').click();
    const initial = await view.evaluate(() => antigravityState.mode);
    await view.locator('#cmd-input').focus(); await view.locator('#cmd-input').press('Shift+Tab');
    expect(await view.evaluate(() => antigravityState.mode)).toBe(initial);
    await view.locator('[data-agy-policy-cancel]').click();
    await view.locator('#cmd-input').focus(); await view.locator('#cmd-input').press('Shift+Tab');
    await expect.poll(() => view.evaluate(() => antigravityState.mode)).not.toBe(initial);
    await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
    await view.locator('#cmd-input').fill('agy-approval'); await view.locator('#send-btn').click();
    await view.waitForFunction(() => antigravityState.status === 'waiting_approval');
    await expect(view.locator('[data-agy-preset="default"]')).toBeDisabled();
    const response = await page.request.patch(`/api/sessions/${id}/antigravity-permissions`, { data: { policy: { toolPermission: 'always-proceed' } } });
    expect(response.status()).toBe(400);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('direct Save default saves defaults without changing the active session', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    const original = await view.evaluate(() => antigravityState.permissionPolicy);
    const before = await (await page.request.get(`/api/sessions/${id}/antigravity-permissions`)).json();
    await view.locator(before.defaults.toolPermission === 'strict' ? '[data-agy-preset="default"]' : '[data-agy-preset="strict"]').click();
    page.once('dialog', dialog => dialog.accept());
    const saved = page.waitForResponse(r => r.url().endsWith('/antigravity-permission-defaults'));
    await view.locator('[data-agy-policy-defaults]').click();
    expect((await saved).ok()).toBeTruthy();
    expect(await view.evaluate(() => antigravityState.permissionPolicy)).toEqual(original);
    const stale = await page.request.post(`/api/sessions/${id}/antigravity-permission-defaults`, { data: { policy: { toolPermission: 'always-proceed' }, revision: before.globalRevision } });
    expect(stale.status()).toBe(400);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('sandbox execution errors remain visible in the compact editor', async ({ page }) => {
  const { id, view } = await open(page);
  try {
    await view.locator('#cmd-input').fill('agy-sandbox-error'); await view.locator('#send-btn').click();
    await view.waitForFunction(() => antigravityState.status === 'idle' && antigravityState.permissionPolicy.sandboxWarning);
    await expect(view.locator('[data-agy-policy-note]')).toContainText('Sandbox connection failed');
    await expect(view.locator('#antigravity-mode-control')).toHaveAttribute('data-sandbox-error', 'true');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Proceed in sandbox enables sandbox, and overrides stay selected across Mode changes', async ({ page }) => {
  const { id, view } = await open(page, { enableTerminalSandbox: false });
  try {
    await view.locator('[data-agy-preset="sandbox"]').click();
    await expect(view.locator('[data-agy-policy-toggle="enableTerminalSandbox"]')).toHaveAttribute('aria-checked', 'true');
    await apply(page, view, id);
    expect(await view.evaluate(() => antigravityState.permissionPolicy.values.toolPermission)).toBe('proceed-in-sandbox');
    await expect(view.locator('#antigravity-mode-control')).toHaveAttribute('data-sandbox', 'true');
    await view.locator('[data-agy-preset="strict"]').click();
    await apply(page, view, id);
    let mode = await page.request.patch(`/api/sessions/${id}/antigravity-settings`, { data: { mode: 'plan' } });
    expect(mode.ok()).toBeTruthy();
    await view.waitForFunction(() => antigravityState.mode === 'plan');
    await view.locator('[data-agy-policy-close]').click();
    await view.locator('#antigravity-mode-control').click();
    await expect(view.locator('[data-agy-preset="strict"]')).toHaveAttribute('aria-pressed', 'true');
    await view.locator('[data-agy-preset="skip"]').click();
    page.once('dialog', dialog => dialog.accept());
    await apply(page, view, id);
    mode = await page.request.patch(`/api/sessions/${id}/antigravity-settings`, { data: { mode: 'plan' } });
    expect(mode.ok()).toBeTruthy();
    await view.waitForFunction(() => antigravityState.mode === 'plan');
    await view.locator('[data-agy-policy-close]').click();
    await view.locator('#antigravity-mode-control').click();
    await expect(view.locator('[data-agy-preset="skip"]')).toHaveAttribute('aria-pressed', 'true');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('toggles preserve agent-decides and inherited settings unless changed', async ({ page }) => {
  const { id, view } = await open(page, { artifactReviewPolicy: 'agent-decides' });
  try {
    await expect(view.locator('[data-agy-policy-toggle="artifactReviewPolicy"]')).toHaveAttribute('aria-checked', 'true');
    await view.locator('[data-agy-policy-toggle="allowNonWorkspaceAccess"]').click();
    await view.locator('[data-agy-policy-toggle="artifactReviewPolicy"]').click();
    await view.locator('[data-agy-policy-toggle="artifactReviewPolicy"]').click();
    expect(await view.evaluate(() => agyPermissionDraft.artifactReviewPolicy)).toBe('agent-decides');
    expect(await view.evaluate(() => agyPermissionDraft.enableTerminalSandbox)).toBe('inherit');
    await apply(page, view, id);
    const current = await (await page.request.get(`/api/sessions/${id}/antigravity-permissions`)).json();
    expect(current.values.artifactReviewPolicy).toBe('agent-decides');
    expect(current.overrides).not.toHaveProperty('enableTerminalSandbox');
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('opening refreshes clean data and preserves a pending draft', async ({ page }) => {
  const { id, view } = await open(page);
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/antigravity-permissions')) reads++; });
  try {
    await view.locator('[data-agy-policy-close]').click();
    await view.locator('#antigravity-mode-control').click();
    await expect.poll(() => reads).toBe(1);
    await expect(view.locator('[data-agy-preset]')).toHaveCount(7);
    await view.locator('[data-agy-policy-toggle="allowNonWorkspaceAccess"]').click();
    await view.locator('[data-agy-policy-close]').click();
    await view.locator('#antigravity-mode-control').click();
    expect(reads).toBe(1);
    await expect(view.locator('[data-agy-policy-toggle="allowNonWorkspaceAccess"]')).toHaveAttribute('aria-checked', 'true');
    await view.locator('[data-agy-policy-cancel]').click();
    await expect.poll(() => reads).toBe(2);
    await expect(view.locator('[data-agy-policy-footer]')).toBeHidden();
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});
