const { test, expect } = require('@playwright/test');

async function expectInsideViewport(locator, page) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + Math.min(box.height, viewport.height)).toBeLessThanOrEqual(viewport.height + 1);
}

test('lobby assets and primary dialogs remain usable', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('Glad - AI Sessions');
  await expect(page.locator('#lobby-view')).toHaveClass(/active/);
  await expect(page.locator('.header')).toBeVisible();

  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    resources: performance.getEntriesByType('resource').map(entry => entry.name)
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.resources.some(url => url.includes('unpkg.com'))).toBe(false);
  for (const asset of ['styles.css', 'core.js', 'claude.js', 'codex.js', 'session.js', 'vendor/xterm.js']) {
    expect(layout.resources.some(url => url.endsWith(asset))).toBe(true);
  }

  await page.getByTitle('New session').click();
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await expectInsideViewport(page.locator('#tool-modal'), page);
  await page.locator('#modal-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#modal-overlay')).toBeHidden();

  await page.getByTitle('New scheduler').click();
  await expect(page.locator('#schedule-modal-overlay')).toBeVisible();
  await expectInsideViewport(page.locator('#schedule-modal'), page);
  await expect(page.locator('#schedule-name')).toBeEditable();

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('lobby-and-schedule.png'), fullPage: true });
});
