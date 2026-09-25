const { test, expect } = require('@playwright/test');
const { mockVisualViewport } = require('./helpers/visual-viewport');

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'MacBook Pro 16', 'Installed iOS app regression');
  if (testInfo.project.name === 'iPad Air 7') await page.setViewportSize({ width: 1180, height: 820 });
  await mockVisualViewport(page, { iosStandalone: true });
  await page.addInitScript(() => localStorage.setItem('glad-theme', 'light'));
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

async function seedLongCodexConversation(page) {
  await page.evaluate(() => {
    codexMessages = Array.from({ length: 120 }, (_, index) => ({
      id: `keyboard-history-${index}`,
      kind: 'assistant',
      text: `History ${index + 1}\n${'Long conversation content. '.repeat(20)}`
    }));
    commitCodexChatRender();
    const chat = document.getElementById('codex-chat-container');
    chat.scrollTop = chat.scrollHeight;
  });
}

async function expectChatAtBottom(page) {
  await expect.poll(() => page.evaluate(() => {
    const chat = document.getElementById('codex-chat-container');
    return chat.scrollHeight - chat.clientHeight - chat.scrollTop;
  })).toBeLessThanOrEqual(1);
}

async function expectTileFocusInsideViewport(page) {
  await expect.poll(() => page.evaluate(() => {
    const viewport = window.visualViewport;
    const terminal = document.getElementById('terminal-view').getBoundingClientRect();
    const input = document.getElementById('cmd-input').getBoundingClientRect();
    const returnButton = document.getElementById('tile-return-button').getBoundingClientRect();
    return {
      terminalInside: terminal.top >= viewport.offsetTop - 1
        && terminal.bottom <= viewport.offsetTop + viewport.height + 1,
      inputInside: input.top >= viewport.offsetTop - 1
        && input.bottom <= viewport.offsetTop + viewport.height + 1,
      returnButtonInside: returnButton.top >= viewport.offsetTop - 1
        && returnButton.bottom <= viewport.offsetTop + viewport.height + 1
    };
  })).toEqual({ terminalInside: true, inputInside: true, returnButtonInside: true });
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

test('keyboard resizing preserves a long conversation scroll anchor', async ({ page }) => {
  const { height } = page.viewportSize();
  const visibleHeight = Math.round(height * .56);
  await seedLongCodexConversation(page);
  await expectChatAtBottom(page);

  await page.evaluate(next => window.setTestVisualViewport(next), { height: visibleHeight, offsetTop: 0 });
  await expectComposerInViewport(page);
  await expectChatAtBottom(page);

  await page.evaluate(height => window.setTestVisualViewport({ height, offsetTop: 0 }), height);
  await expectComposerInViewport(page);
  await expectChatAtBottom(page);

  const readingPosition = await page.evaluate(() => {
    const chat = document.getElementById('codex-chat-container');
    chat.scrollTop = Math.min(420, chat.scrollHeight - chat.clientHeight - 200);
    return chat.scrollTop;
  });
  await page.evaluate(next => window.setTestVisualViewport(next), { height: visibleHeight, offsetTop: 0 });
  await expect.poll(() => page.evaluate(() => document.getElementById('codex-chat-container').scrollTop))
    .toBeCloseTo(readingPosition, 0);
});

test('tiled focus composer stays inside the iPad keyboard viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPad Air 7', 'Landscape tiled focus regression');
  const { height } = page.viewportSize();
  const visibleHeight = Math.round(height * .56);

  await page.evaluate(() => {
    document.body.classList.add('tile-mode', 'tile-focus-open');
    document.getElementById('tile-workspace').classList.add('active');
  });
  await seedLongCodexConversation(page);
  await page.evaluate(next => window.setTestVisualViewport(next), { height: visibleHeight, offsetTop: 0 });
  await expectTileFocusInsideViewport(page);
  await expectChatAtBottom(page);

  await page.evaluate(next => window.setTestVisualViewport(next, 'scroll'), {
    height: visibleHeight,
    offsetTop: Math.round(height * .22)
  });
  await expectTileFocusInsideViewport(page);
  await expectChatAtBottom(page);
});
