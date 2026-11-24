const { test, expect } = require('@playwright/test');
const { conversationView } = require('./helpers/conversation');
async function open(page) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Navigation owner' } });
  const item = await response.json();
  await page.goto('/'); await page.evaluate(item => joinSession(item.id, item.name, 'codex'), item);
  const view = await conversationView(page); await expect(view.locator('#send-btn')).toBeEnabled(); return { item, view };
}

test('a delayed Git status cannot overwrite Directories and Refresh keeps the current subview', async ({ page }) => {
  const { item, view } = await open(page);
  let release, arrived, settled; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; }); const done = new Promise(resolve => { settled = resolve; });
  let directories = 0;
  await page.route(`**/api/sessions/${item.id}/git-status`, async route => { arrived(); await gate; await route.fulfill({ json: { success: true, files: [] } }); settled(); });
  await page.route(`**/api/sessions/${item.id}/fs/dir?*`, async route => { directories++; await route.fulfill({ json: { success: true, files: [{ name: 'review-folder', isDirectory: true }] } }); });
  try {
    await view.evaluate(() => showGitPreview()); await ready;
    await view.locator('#tab-directories').click(); await expect(view.locator('#git-content')).toContainText('review-folder');
    release(); await done; await expect(view.locator('#git-content')).not.toContainText('No changes detected');
    const reads = directories; await view.locator('#git-view').getByTitle('Refresh', { exact: true }).click();
    await expect.poll(() => directories).toBe(reads + 1); await expect(view.locator('#tab-directories')).toHaveClass(/active/);
    await expect(view.locator('#git-content')).toContainText('review-folder');
  } finally { release(); await page.request.delete(`/api/sessions/${item.id}`); }
});

test('refreshing a staged file preserves its staged source and selected file mode', async ({ page }) => {
  const { item, view } = await open(page); const stagedReads = [];
  await page.route(`**/api/sessions/${item.id}/git-diff-file?*`, async route => {
    stagedReads.push(new URL(route.request().url()).searchParams.get('staged'));
    await route.fulfill({ json: { success: true, stdout: 'diff --git a/staged.txt b/staged.txt\n+STAGED_ONLY_CHANGE' } });
  });
  await page.route(`**/api/sessions/${item.id}/file?*`, route => route.fulfill({ json: { success: true, content: 'Current staged file content' } }));
  try {
    await view.evaluate(async () => { showSessionSubview('git-view'); await showFileDetails('staged.txt', true, true, false, false); });
    await expect(view.locator('#git-content')).toContainText('STAGED_ONLY_CHANGE');
    await view.locator('#git-view').getByTitle('Refresh', { exact: true }).click();
    await expect.poll(() => stagedReads.length).toBe(2); expect(stagedReads).toEqual(['true', 'true']);
    await view.evaluate(() => toggleFileMode()); await view.locator('#git-view').getByTitle('Refresh', { exact: true }).click();
    await expect.poll(() => stagedReads.length).toBe(3); expect(stagedReads.every(value => value === 'true')).toBe(true);
    expect(await view.evaluate(() => currentFileMode)).toBe('file');
    await expect(view.locator('#git-content')).toContainText('Current staged file content');
  } finally { await page.request.delete(`/api/sessions/${item.id}`); }
});
