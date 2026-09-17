const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'MacBook Pro 16', 'Installed iOS app regression');
  if (testInfo.project.name === 'iPad Air 7') await page.setViewportSize({ width: 1180, height: 820 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    localStorage.setItem('glad-theme', 'light');

    // Desktop WebKit cannot open an iPad keyboard. Model its independently
    // resized/panned visual viewport while leaving the layout viewport intact.
    const nativeViewport = window.visualViewport;
    const viewport = new EventTarget();
    const state = {};
    for (const key of ['height', 'offsetTop', 'scale']) {
      Object.defineProperty(viewport, key, { get: () => state[key] ?? nativeViewport[key] });
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.setTestVisualViewport = (next, event = 'resize') => {
      Object.assign(state, next);
      viewport.dispatchEvent(new Event(event));
    };
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    activeToolKey = 'codex';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    applyCodexState({ ...codexState, status: 'idle' });
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    syncComposerSendState();
  });
});

async function expectComposerInViewport(page) {
  await expect.poll(() => page.evaluate(() => {
    const viewport = window.visualViewport;
    const shell = document.getElementById('app-shell').getBoundingClientRect();
    const composer = document.getElementById('terminal-controls').getBoundingClientRect();
    const topBar = document.getElementById('nav-bar').getBoundingClientRect();
    return {
      shellAtViewportTop: Math.abs(shell.top - viewport.offsetTop) <= 1,
      shellFillsViewport: Math.abs(shell.height - viewport.height) <= 1,
      composerAtViewportBottom: Math.abs(composer.bottom - (viewport.offsetTop + viewport.height)) <= 1,
      navigationVisible: topBar.top >= viewport.offsetTop,
      composerBelowNavigation: composer.top >= topBar.bottom
    };
  })).toEqual({
    shellAtViewportTop: true,
    shellFillsViewport: true,
    composerAtViewportBottom: true,
    navigationVisible: true,
    composerBelowNavigation: true
  });
}

test('long drafts and the next input stay at the bottom after root scrolling', async ({ page }) => {
  const input = page.locator('#cmd-input');
  await input.fill('很长的输入内容，左侧对话、右侧流程图。\n'.repeat(200));
  expect((await input.boundingBox()).height).toBeLessThanOrEqual(150);

  // Reproduce a keyboard/caret scroll of the outer document, independently of
  // the textarea's own scroll position. The app's panes must remain on screen.
  await page.evaluate(() => {
    document.body.style.paddingBottom = '600px';
    window.scrollTo(0, 600);
  });
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await expectComposerInViewport(page);
  if (page.viewportSize().width >= 920) {
    await expect(page.getByTitle('New AI session')).toBeInViewport();
  } else {
    await expect(page.locator('#back-btn')).toBeInViewport();
  }

  await page.locator('#send-btn').click();
  await page.evaluate(() => handleComposerSendResult({
    clientMessageId: composerPendingSend.clientMessageId, accepted: true
  }));
  await expect(input).toHaveValue('');
  expect((await input.boundingBox()).height).toBeLessThanOrEqual(44);
  await input.fill('下一条消息');
  await expectComposerInViewport(page);
  await expect(input).toHaveValue('下一条消息');
});

test('tapping the empty composer after sending a long draft keeps it above the keyboard', async ({ page }) => {
  const { height } = page.viewportSize();
  const input = page.locator('#cmd-input');

  for (const visibleHeight of [Math.round(height * .56), height - 60]) {
    await input.fill('这是一条较长的消息，发送后再次点击输入框。\n'.repeat(200));
    await page.evaluate(height => window.setTestVisualViewport({ height, offsetTop: 0 }), visibleHeight);
    await expectComposerInViewport(page);
    await page.locator('#send-btn').click();
    await page.evaluate(() => handleComposerSendResult({
      clientMessageId: composerPendingSend.clientMessageId, accepted: true
    }));
    await expect(input).toHaveValue('');
    await input.blur();
    await page.evaluate(height => window.setTestVisualViewport({ height, offsetTop: 0 }), height);
    await expectComposerInViewport(page);

    // The reported trigger is tapping the cleared field on the next input,
    // after the previous tall textarea has already shrunk.
    await input.tap();
    await expect(input).toBeFocused();
    await page.evaluate(({ visibleHeight, height }) => {
      document.body.style.paddingBottom = '600px';
      window.scrollTo(0, 600);
      window.setTestVisualViewport({
        height: visibleHeight, offsetTop: Math.min(180, height - visibleHeight)
      });
    }, { visibleHeight, height });
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expectComposerInViewport(page);
    expect((await input.boundingBox()).height).toBeLessThanOrEqual(44);
    await page.keyboard.insertText('下一条消息');
    await expect(input).toHaveValue('下一条消息');
    await expectComposerInViewport(page);

    await input.blur();
    await page.evaluate(height => {
      document.body.style.removeProperty('padding-bottom');
      window.scrollTo(0, 0);
      window.setTestVisualViewport({ height, offsetTop: 0 });
    }, height);
    await expectComposerInViewport(page);
  }
});

test('composer follows keyboard opening, panning, dismissal and refocus', async ({ page }) => {
  const { width, height } = page.viewportSize();
  const visibleHeight = Math.round(height * .56);
  const input = page.locator('#cmd-input');
  const draft = '保留未发送的长文本。\n'.repeat(80);
  await input.fill(draft);

  for (const geometry of [
    { height: visibleHeight, offsetTop: 0 },
    { height: visibleHeight, offsetTop: Math.round(height * .31) },
    { height: height - 60, offsetTop: 0 }, // Hardware keyboard accessory bar.
    { height, offsetTop: 0 }
  ]) {
    await page.evaluate(next => window.setTestVisualViewport(next), geometry);
    await expectComposerInViewport(page);
    await expect(input).toHaveValue(draft);
  }

  await input.blur();
  await input.focus();
  await page.evaluate(next => window.setTestVisualViewport(next, 'scroll'), { height: visibleHeight, offsetTop: 180 });
  await expectComposerInViewport(page);
  await page.evaluate(height => window.setTestVisualViewport({ height, offsetTop: 0 }), height);
  await expectComposerInViewport(page);

  await page.setViewportSize({ width: height, height: width });
  await page.evaluate(height => window.setTestVisualViewport({ height, offsetTop: 0 }), width);
  await expectComposerInViewport(page);
  await expect(input).toHaveValue(draft);
});
