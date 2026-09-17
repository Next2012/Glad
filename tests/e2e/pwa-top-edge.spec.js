const { test, expect } = require('@playwright/test');

// WebKit samples near the top midpoint and requires a container at least 90%
// of the viewport width. A sticky sidebar header alone cannot cover that point.
async function expectSolidTopEdge(page, backgroundColor) {
  const candidates = await page.evaluate(() => Array.from(document.body.querySelectorAll('*')).flatMap(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!['fixed', 'sticky'].includes(style.position)
      || style.visibility !== 'visible' || Number(style.opacity) !== 1
      || rect.top > 0 || rect.bottom < 6
      || rect.left > 0 || rect.right < innerWidth
      || style.backgroundColor === 'rgba(0, 0, 0, 0)') return [];
    return [{ backgroundColor: style.backgroundColor, pointerEvents: style.pointerEvents }];
  }));
  expect(candidates).toContainEqual({ backgroundColor, pointerEvents: 'none' });
}

test('iOS standalone keeps a solid full-width top edge across layout changes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'MacBook Pro 16', 'Installed iOS app layouts');
  const isIpad = testInfo.project.name === 'iPad Air 7';
  await page.addInitScript(({ isIpad }) => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: isIpad
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'
        : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: isIpad ? 'MacIntel' : 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    localStorage.setItem('glad-theme', 'dark');
  }, { isIpad });
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveClass(/ios-standalone/);

  const portrait = page.viewportSize();
  for (const viewport of [portrait, { width: portrait.height, height: portrait.width }, portrait]) {
    await page.setViewportSize(viewport);
    await expectSolidTopEdge(page, 'rgb(0, 0, 0)');

    // Keep the controls below the painted strip, and keep them clickable.
    await expect.poll(async () => {
      const shell = await page.locator('#app-shell').boundingBox();
      return shell.y + shell.height;
    }).toBeLessThanOrEqual(viewport.height + 1);
    const button = await page.getByTitle('New AI session').boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(12);
    await page.getByTitle('New AI session').click();
    await expect(page.locator('#tool-modal')).toBeVisible();
    await page.locator('#modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#modal-overlay')).toBeHidden();

    // Exercise the sidebar scroll container without creating provider sessions.
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.id = 'top-edge-scroll-spacer';
      spacer.style.height = '2000px';
      document.getElementById('sessions-list').append(spacer);
      document.getElementById('lobby').scrollTop = 500;
    });
    await expectSolidTopEdge(page, 'rgb(0, 0, 0)');
    await page.evaluate(() => {
      document.getElementById('top-edge-scroll-spacer').remove();
      document.getElementById('lobby').scrollTop = 0;
    });

    if (viewport.width >= 920) {
      await page.locator('#lobby-collapse-button').click();
      await expect(page.locator('#tile-workspace')).toBeVisible();
      await expectSolidTopEdge(page, 'rgb(0, 0, 0)');
      const tileButton = await page.locator('#tile-layout-trigger').boundingBox();
      // The floating tab deliberately overlaps its pane edge by one border pixel.
      expect(tileButton.y + 1).toBeGreaterThanOrEqual(12);
      await page.locator('#lobby-collapse-button').click();
    }

    await page.evaluate(() => setGladTheme('light'));
    await expectSolidTopEdge(page, 'rgb(245, 246, 248)');
    await page.evaluate(() => setGladTheme('dark'));
  }
});

test('ordinary browser tabs do not reserve a PWA top edge', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).not.toHaveClass(/ios-standalone/);
  await expect(page.locator('#app-shell')).toHaveCSS('padding-top', '0px');
  await expect(page.locator('#pwa-top-edge')).toBeHidden();
});
