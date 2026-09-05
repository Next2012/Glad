const { test, expect } = require('@playwright/test');

async function connectHistorySession(page) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex' } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#codex-resume-btn')).toBeEnabled();
  return id;
}

test('Codex history offers only sorting controls with pagination, preview and explicit resume/fork', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = await connectHistorySession(page);
  const originalThreadId = await page.evaluate(() => codexState.threadId);
  const mutations = [];
  const previews = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /codex-(resume|fork)$/.test(request.url())) mutations.push(request.postDataJSON());
    if (request.url().includes('/codex-thread-preview')) previews.push(request.url());
  });
  try {
    await page.locator('#codex-resume-btn').click();
    const panel = page.locator('#codex-resume-panel');
    await expect(panel.locator('.codex-history-item')).toHaveCount(40);
    await expect(panel.locator('.codex-history-location')).toHaveCount(0);
    await expect(panel.locator('.codex-history-row').first()).not.toContainText('/root/data/Test/glad');
    expect(previews).toHaveLength(0);
    await panel.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(panel.locator('.codex-history-item')).toHaveCount(45);
    await expect(panel.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);

    await expect(panel.getByRole('searchbox')).toHaveCount(0);
    await expect(panel.getByLabel('History directory')).toHaveCount(0);
    await expect(panel.locator('select')).toHaveCount(1);
    await panel.getByLabel('History sort').selectOption('created_at');
    await expect(panel.locator('.codex-history-item')).toHaveCount(40);
    await expect(panel.locator('.codex-history-item').first()).toContainText('History 088');
    await panel.getByRole('button', { name: 'Preview History 084', exact: true }).click();
    await expect(panel.locator('.codex-history-detail')).toContainText('Recent question for picker-thread-84');
    await expect(panel.locator('.codex-history-detail')).toContainText('Recent answer <script>not executable</script>');
    await expect(panel.locator('.codex-history-detail script')).toHaveCount(0);
    await expect(panel.locator('.codex-history-detail')).not.toContainText('Hidden tool payload');
    expect(previews).toHaveLength(1);
    expect(mutations).toHaveLength(0);
    await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe(originalThreadId);
    await expect(panel.locator('.codex-history-detail')).toContainText('feature/history-84');
    await expect(panel.locator('.codex-history-row').filter({ hasText: 'History 084' })).not.toContainText('feature/history-84');

    // Both themes and small screens keep the selector and composer in bounds.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    await expect(page.locator('#cmd-input')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('codex-history-preview.png'), fullPage: true });

    await panel.getByRole('button', { name: 'Resume History 084', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe('picker-thread-84');
    expect(mutations).toEqual([{ threadId: 'picker-thread-84' }]);

    await page.locator('#codex-fork-btn').click();
    const fork = page.locator('#codex-fork-panel');
    await expect(fork.locator('.codex-history-item')).toHaveCount(40);
    await expect(fork.locator('.codex-history-location')).toHaveCount(0);
    await expect(fork.locator('.codex-history-row').first()).not.toContainText('/root/data/Test/glad');
    await expect(fork.getByRole('searchbox')).toHaveCount(0);
    await expect(fork.getByLabel('History directory')).toHaveCount(0);
    await expect(fork.locator('select')).toHaveCount(1);
    await fork.getByLabel('History sort').selectOption('created_at');
    await expect(fork.locator('.codex-history-item').first()).toContainText('History 088');
    await expect(fork).not.toContainText('/other-project');
    await fork.getByRole('button', { name: 'Preview History 088', exact: true }).click();
    await expect(fork.locator('.codex-history-detail')).toContainText('Recent question for picker-thread-88');
    expect(mutations).toHaveLength(1);
    await fork.getByRole('button', { name: 'Fork History 088', exact: true }).click();
    await expect(fork).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe('fork-of-picker-thread-88');
    expect(mutations).toEqual([{ threadId: 'picker-thread-84' }, { threadId: 'picker-thread-88' }]);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('Codex history ignores stale sorting and previews, and offers retries', async ({ page }) => {
  const id = await connectHistorySession(page);
  try {
    await page.locator('#codex-resume-btn').click();
    const panel = page.locator('#codex-resume-panel');
    await expect(panel.locator('.codex-history-item')).toHaveCount(40);
    await page.evaluate(() => {
      const original = window.fetch;
      window.__historyOriginalFetch = original;
      window.__historyPending = {};
      window.fetch = (url, options) => {
        const address = String(url);
        const query = new URL(address, location.href).searchParams;
        if (address.includes('codex-resume-threads') && query.get('sort') === 'created_at') {
          return new Promise(resolve => { window.__historyPending.slow = resolve; });
        }
        if (address.includes('codex-thread-preview')) {
          return new Promise(resolve => { window.__historyPending.preview = resolve; });
        }
        return original(url, options);
      };
    });
    await panel.getByLabel('History sort').selectOption('created_at');
    await expect.poll(() => page.evaluate(() => Boolean(window.__historyPending.slow))).toBe(true);
    await panel.getByLabel('History sort').selectOption('updated_at');
    await expect(panel.locator('.codex-history-item')).toHaveCount(40);
    await page.evaluate(() => window.__historyPending.slow(new Response(JSON.stringify({ success: true, items: [{ id: 'stale', title: 'Stale search' }] }))));
    await expect(panel.locator('.codex-history-item').first()).toContainText('History 000');
    await panel.getByRole('button', { name: 'Preview History 000' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.__historyPending.preview))).toBe(true);
    await page.locator('#codex-fork-btn').click();
    await page.evaluate(() => window.__historyPending.preview(new Response(JSON.stringify({ success: true, messages: [{ kind: 'assistant', text: 'Stale preview' }] }))));
    await expect(page.locator('#codex-fork-panel')).not.toContainText('Stale preview');
    await page.evaluate(() => { window.fetch = window.__historyOriginalFetch; });

    let fail = true;
    await page.route('**/codex-resume-threads?**', async route => {
      if (fail) {
        fail = false;
        return route.fulfill({ status: 503, json: { success: false, error: 'Temporary history failure' } });
      }
      return route.continue();
    });
    const fork = page.locator('#codex-fork-panel');
    await fork.getByLabel('History sort').selectOption('created_at');
    await expect(fork.getByRole('alert')).toContainText('Temporary history failure');
    await fork.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(fork.locator('.codex-history-item')).toHaveCount(40);
    await expect(fork.locator('.codex-history-item').first()).toContainText('History 088');

    // Network failures must release the Fork action lock and remain recoverable.
    await page.route('**/codex-fork', route => route.abort('failed'));
    await fork.getByRole('button', { name: 'Fork History 088', exact: true }).click();
    await expect(fork.getByRole('button', { name: 'Back to sessions' })).toBeVisible();
    await expect(page.locator('#codex-resume-btn')).toBeEnabled();
    await fork.getByRole('button', { name: 'Back to sessions' }).click();
    await expect(fork.locator('.codex-history-item')).toHaveCount(40);
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});
