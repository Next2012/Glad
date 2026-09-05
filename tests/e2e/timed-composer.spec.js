const { test, expect } = require('@playwright/test');

async function expectTimerLayout(page, railSelector) {
  const geometry = await page.evaluate(selector => {
    const box = id => document.querySelector(id).getBoundingClientRect();
    const send = box('#send-btn');
    const rail = box(selector);
    const timer = box('#timed-send-panel');
    const controls = box('#terminal-controls');
    return {
      sendTop: send.top, railTop: rail.top, sendLeft: send.left, railRight: rail.right,
      timerBottom: timer.bottom, timerLeft: timer.left, timerRight: timer.right,
      controlsBottom: controls.bottom, width: innerWidth, height: innerHeight
    };
  }, railSelector);
  expect(Math.abs(geometry.sendTop - geometry.railTop)).toBeLessThanOrEqual(1);
  expect(geometry.sendLeft - geometry.railRight).toBeGreaterThanOrEqual(8);
  expect(geometry.timerBottom).toBeLessThanOrEqual(geometry.railTop + 1);
  expect(geometry.timerLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.timerRight).toBeLessThanOrEqual(geometry.width);
  expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.height + 1);
}

async function expectReadableTimerOptions(page) {
  const colors = await page.locator('#timed-send-panel select, #timed-send-panel option').evaluateAll(elements => {
    const backdrop = getComputedStyle(document.getElementById('timed-send-panel')).backgroundColor;
    return elements.map(element => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, backdrop };
    });
  });
  const channels = color => color.match(/[\d.]+/g).map(Number);
  const luminance = rgb => {
    const values = rgb.slice(0, 3).map(value => {
      value /= 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  for (const pair of colors) {
    const rgba = channels(pair.background), backdrop = channels(pair.backdrop);
    const alpha = rgba[3] ?? 1;
    const fg = luminance(channels(pair.color));
    const bg = luminance(rgba.slice(0, 3).map((value, index) => value * alpha + backdrop[index] * (1 - alpha)));
    expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
  }
}

for (const toolKey of ['codex', 'claude-code']) {
  test(`${toolKey} scheduled-send editor stays aligned and readable in both themes`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const created = await page.request.post('/api/sessions', { data: { toolKey, name: 'Timer layout test' } });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    try {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
      const rail = toolKey === 'codex' ? '#codex-control-rail' : '.claude-control-rail';
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => setGladTheme(value), theme);
        await page.locator('#cmd-input').fill(`Scheduled ${theme} message`);
        await page.locator('#schedule-send-btn').click();
        await expect(page.getByRole('group', { name: 'Scheduled send' })).toBeVisible();
        await expect(page.locator('#timed-editor-actions')).toBeHidden();
        await expectTimerLayout(page, rail);
        await expectReadableTimerOptions(page);
        await page.evaluate(() => {
          const controls = document.getElementById('terminal-controls');
          controls.style.maxHeight = '150px';
          controls.scrollTop = controls.scrollHeight;
        });
        await expectTimerLayout(page, rail);
        await page.evaluate(() => {
          const controls = document.getElementById('terminal-controls');
          controls.style.removeProperty('max-height');
          controls.scrollTop = 0;
        });
        await page.getByLabel('Delay hours').selectOption('1');
        await page.getByLabel('Delay minutes').selectOption('5');
        await page.locator('#timed-save-btn').click();
        const tag = page.locator('#timed-tag-rail .timed-tag');
        await expect(tag).toHaveCount(1);
        await expect(tag).toContainText(/1h \d{2}m/);
        await expect(tag.locator('use')).toHaveAttribute('href', '#icon-schedule');
        const style = await tag.evaluate(element => {
          const s = getComputedStyle(element);
          return { shadow: s.boxShadow, whiteSpace: s.whiteSpace, weight: Number(s.fontWeight), height: element.getBoundingClientRect().height };
        });
        expect(style.shadow).toBe('none');
        expect(style.whiteSpace).toBe('nowrap');
        expect(style.weight).toBeLessThanOrEqual(600);
        expect(style.height).toBeLessThanOrEqual(30);
        await tag.click();
        await expect(page.locator('#cmd-input')).toHaveValue(`Scheduled ${theme} message`);
        await expect(page.locator('#timed-editor-actions')).toBeVisible();
        await expect(tag).toHaveAttribute('aria-pressed', 'true');
        await expectTimerLayout(page, rail);
        await page.getByLabel('Delay minutes').selectOption('6');
        await page.locator('#timed-save-btn').click();
        await expect(page.locator('#timed-editor-actions')).toBeHidden();
        await tag.click();
        await expectTimerLayout(page, rail);
        await page.screenshot({ path: testInfo.outputPath(`${toolKey}-timer-${theme}.png`), fullPage: true });
        await page.locator('#timed-delete-btn').click();
        await expect(tag).toHaveCount(0);
        await page.locator('#schedule-send-btn').click();
        await expect(page.locator('#timed-send-panel')).toBeHidden();
      }
      expect(errors).toEqual([]);
    } finally {
      await page.request.delete(`/api/sessions/${id}`);
    }
  });
}

test('sidebar handle follows every drag update without trailing animation', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop sidebar only');
  await page.goto('/', { waitUntil: 'networkidle' });
  const divider = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, 80);
  await page.mouse.down();
  for (const x of [430, 320, 460, 348]) {
    await page.mouse.move(x, 80);
    // Deliberately measure immediately: polling would hide a lagging transition.
    const geometry = await page.evaluate(() => {
      const bar = document.getElementById('sidebar-resizer').getBoundingClientRect();
      const handle = document.getElementById('lobby-collapse-button').getBoundingClientRect();
      return { divider: bar.left, handle: handle.left + handle.width / 2 };
    });
    expect(Math.abs(geometry.divider - geometry.handle)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.divider - x)).toBeLessThanOrEqual(2);
  }
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('glad-sidebar-width')))).toBe(348);
});
