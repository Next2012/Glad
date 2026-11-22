const { test, expect } = require('@playwright/test');
const { mockVisualViewport } = require('./helpers/visual-viewport');

// Exercise the production renderer without opening a native session or changing
// a user's saved configuration. Long native labels expose intrinsic-width bugs.
async function openAntigravityHarness(page, theme) {
  await page.addInitScript(theme => localStorage.setItem('glad-theme', theme), theme);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    activeSessionId = 'antigravity-layout';
    activeToolKey = 'antigravity';
    activeSessionHydrated = true;
    antigravityMessages = [
      { id: 'layout-user', kind: 'user', text: 'Review the composer layout on this screen.' },
      { id: 'layout-assistant', kind: 'assistant', text: 'The native model, thinking, and mode controls are available below.' }
    ];
    antigravityPendingPermissions = [];
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    antigravityState = {
      ...createDefaultAntigravityState(), status: 'idle', canCompact: true,
      usage: { used: 1200, size: 100000 },
      capabilities: { resume: true, list: true },
      commands: [{ name: 'compact', description: 'Compact context' }, { name: 'plan', description: 'Plan the next change' }],
      configOptions: [
        { id: 'model', category: 'model', name: 'Model', currentValue: 'gemini-3.1-pro', options: [
          { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro — native model with an extended display name' },
          { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }
        ] },
        { id: 'thought_level', category: 'thought_level', name: 'Thinking', currentValue: 'high', options: [
          { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }
        ] },
        { id: 'mode', category: 'mode', name: 'Mode', currentValue: 'default', options: [
          { value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }
        ] },
        { id: 'native_extra', name: 'Additional native setting with a long label', currentValue: 'enabled', options: [
          { value: 'enabled', name: 'Enabled with a long native option label that must fit this panel' },
          { value: 'disabled', name: 'Disabled' }
        ] }
      ]
    };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
    applyAntigravityState(antigravityState);
    handleComposerSocketOpen();
  });
  await expect(page.locator('#antigravity-control-panel')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('#send-btn')).toBeEnabled();
}

async function expectComposerGeometry(page) {
  await expectHiddenStateBar(page);
  await expect(page.locator('#antigravity-state-bar .codex-context-meter')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const send = rect('send-btn');
    const input = rect('cmd-input');
    const row = rect('input-row');
    const panel = rect('antigravity-control-panel');
    const rail = rect('antigravity-control-rail');
    const closedAuxPanels = [...document.querySelectorAll('#antigravity-control-panel > .antigravity-aux-panel')]
      .every(panel => panel.hidden || getComputedStyle(panel).display === 'none');
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (window.visualViewport?.height || innerHeight);
    return {
      sendInside: send.width > 0 && send.left >= 0 && send.right <= innerWidth + 1
        && send.top >= viewportTop - 1 && send.bottom <= viewportBottom + 1,
      inputInside: input.left >= row.left - 1 && input.right <= row.right + 1
        && input.right <= innerWidth + 1 && input.bottom <= viewportBottom + 1,
      railInside: rail.left >= panel.left - 1 && rail.right <= panel.right + 1,
      railDisjointFromSend: rail.right <= send.left + 1,
      sendOnActionRow: Math.abs(send.top - rail.top) <= 1 && Math.abs(send.height - 40) <= 1,
      compactInputActionGap: !closedAuxPanels || (rail.top - input.bottom >= -1 && rail.top - input.bottom <= 14),
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
    };
  })).toEqual({
    sendInside: true, inputInside: true, railInside: true,
    railDisjointFromSend: true, sendOnActionRow: true, compactInputActionGap: true, noPageOverflow: true
  });

  const actions = await page.locator('#antigravity-control-rail > button, #antigravity-mode-control').evaluateAll(elements =>
    elements.filter(element => !element.hidden && getComputedStyle(element).display !== 'none').map(element => {
      const box = element.getBoundingClientRect();
      return { id: element.id, width: box.width, height: box.height, top: box.top };
    }));
  expect(actions.map(action => action.id)).toEqual(expect.arrayContaining([
    'attachment-btn', 'schedule-send-btn', 'antigravity-model-btn', 'antigravity-mode-control',
    'antigravity-status-btn', 'antigravity-abort-btn', 'antigravity-resume-btn',
    'antigravity-commands-btn', 'antigravity-compact-btn'
  ]));
  for (const action of actions) {
    expect(action.width, `${action.id} width`).toBeCloseTo(40, 0);
    expect(action.height, `${action.id} height`).toBeCloseTo(40, 0);
    expect(action.top, `${action.id} action row`).toBeCloseTo(actions[0].top, 0);
  }
}

async function expectHiddenStateBar(page) {
  const bar = page.locator('#antigravity-state-bar');
  await expect(bar).not.toBeVisible();
  await expect(bar).toBeEmpty();
  await expect.poll(() => bar.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
}

async function expectSteeringLabelGeometry(page, railId = 'antigravity-control-rail') {
  const label = page.locator('#send-btn > .action-label');
  await expect(label).toHaveText('Add instruction');
  const geometry = await label.evaluate((element, railId) => {
    const box = element.getBoundingClientRect();
    const button = element.parentElement.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: box.width, height: box.height, buttonWidth: button.width,
      clip: style.clip, position: style.position,
      inside: box.left >= button.left && box.right <= button.right + 1 && box.top >= button.top && box.bottom <= button.bottom + 1,
      untruncated: element.scrollWidth <= element.clientWidth + 1,
      railMargin: getComputedStyle(document.getElementById(railId)).marginRight
    };
  }, railId);
  expect(geometry.width).toBeGreaterThan(60);
  expect(geometry.height).toBeGreaterThan(8);
  expect(geometry.buttonWidth).toBe(132);
  expect(geometry.clip).toBe('auto');
  expect(geometry.position).toBe('static');
  expect(geometry.inside).toBe(true);
  expect(geometry.untruncated).toBe(true);
  expect(geometry.railMargin).toBe('146px');
}

async function expectScrollableRail(page) {
  const before = await page.locator('#send-btn').boundingBox();
  const result = await page.locator('#antigravity-control-rail').evaluate(rail => {
    rail.scrollLeft = rail.scrollWidth;
    const box = rail.getBoundingClientRect();
    const final = document.getElementById('antigravity-compact-btn').getBoundingClientRect();
    return {
      overflow: getComputedStyle(rail).overflowX,
      scrollable: rail.scrollWidth > rail.clientWidth,
      reachedEnd: final.left >= box.left - 1 && final.right <= box.right + 1
    };
  });
  expect(result.overflow).toMatch(/auto|scroll/);
  if (page.viewportSize().width <= 440) expect(result.scrollable).toBe(true);
  expect(result.reachedEnd).toBe(true);
  const after = await page.locator('#send-btn').boundingBox();
  expect(after).toEqual(before);
  await expectComposerGeometry(page);
  await page.locator('#antigravity-control-rail').evaluate(rail => { rail.scrollLeft = 0; });
}

async function expectModelPanelInsideViewport(page) {
  await expect.poll(() => page.locator('#antigravity-model-panel').evaluate(panel => {
    const box = panel.getBoundingClientRect();
    const viewportTop = window.visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (window.visualViewport?.height || innerHeight);
    return {
      inside: box.left >= -1 && box.right <= innerWidth + 1
        && box.top >= viewportTop - 1 && box.bottom <= viewportBottom + 1,
      noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      controlsFit: [...panel.querySelectorAll('[data-agy-config-choice]')].every(button => {
        const control = button.getBoundingClientRect();
        return control.left >= box.left - 1 && control.right <= box.right + 1;
      })
    };
  })).toEqual({ inside: true, noHorizontalOverflow: true, noPageOverflow: true, controlsFit: true });
}

async function saveScreenshot(page, testInfo, name) {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: false, animations: 'disabled', scale: 'css' });
  await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
}

for (const screen of [
  { width: 375, height: 812, theme: 'light', name: 'narrow-phone' },
  { width: 440, height: 956, theme: 'dark', name: 'large-phone' },
  { width: 820, height: 1180, theme: 'light', name: 'tablet' },
  { width: 843, height: 388, theme: 'dark', name: 'short-landscape' },
  { width: 1440, height: 1000, theme: 'dark', name: 'desktop' }
]) {
  test(`Antigravity composer stays inside ${screen.name} (${screen.width}px, ${screen.theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await openAntigravityHarness(page, screen.theme);
    const model = page.locator('#antigravity-model-btn');
    const panel = page.locator('#antigravity-model-panel');
    await expect(panel).not.toBeVisible();
    await expect(page.locator('#send-btn > .action-label')).not.toBeVisible();
    await expect(model).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#antigravity-control-rail [data-agy-config]')).toHaveCount(1);
    await expect(page.locator('#antigravity-mode-control [data-agy-config="mode"]')).toHaveCount(1);
    await expectComposerGeometry(page);
    await saveScreenshot(page, testInfo, `${screen.name}-idle`);
    await expectScrollableRail(page);

    await model.click();
    await expect(model).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-agy-config="model"]')).toBeHidden();
    await expect(panel.locator('[data-agy-config="model"]')).toHaveValue('gemini-3.1-pro');
    await expect(panel.locator('[data-agy-config="thought_level"]')).toBeHidden();
    await expect(panel.locator('[data-agy-config="thought_level"]')).toHaveValue('high');
    await expect(panel.locator('[data-agy-config="native_extra"]')).toBeHidden();
    await expect(panel.locator('[data-agy-config="native_extra"]')).toHaveValue('enabled');
    await expect(panel.locator('[data-agy-config-choice="model"][aria-pressed="true"]')).toBeVisible();
    await expect(panel.locator('[data-agy-config-choice="thought_level"][aria-pressed="true"]')).toBeVisible();
    await expect(panel.locator('[data-agy-config-choice="native_extra"][aria-pressed="true"]')).toBeVisible();
    await expect(panel.locator('[data-agy-config="mode"]')).toHaveCount(0);
    await expectModelPanelInsideViewport(page);
    await expectComposerGeometry(page);
    await saveScreenshot(page, testInfo, `${screen.name}-model-panel`);
    await model.click();
    await expect(model).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).not.toBeVisible();

    await page.evaluate(() => applyAntigravityState({
      status: 'running', turnId: 'layout-turn', canSteer: true, canAbort: true
    }));
    await page.locator('#cmd-input').fill('Keep this instruction available while the turn is running.');
    await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
    await expect(page.locator('#send-btn')).toBeEnabled();
    await expectSteeringLabelGeometry(page);
    await expectComposerGeometry(page);
    await saveScreenshot(page, testInfo, `${screen.name}-steering`);
    await expectScrollableRail(page);
    await model.click();
    await expect(panel).toBeVisible();
    for (const choice of await panel.locator('[data-agy-config-choice]').all()) await expect(choice).toBeDisabled();
    await expectModelPanelInsideViewport(page);
  });
}

test('Antigravity model settings scroll within a short landscape viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 843, height: 388 });
  await openAntigravityHarness(page, 'light');
  await page.evaluate(() => applyAntigravityState({
    configOptions: [...antigravityState.configOptions, ...Array.from({ length: 14 }, (_, index) => ({
      id: `native-extra-${index}`, name: `Native setting ${index + 1}`, currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }, { value: 'custom', name: 'Custom' }]
    }))]
  }));
  await page.locator('#antigravity-model-btn').click();
  await expectModelPanelInsideViewport(page);
  const scroll = await page.locator('#antigravity-model-panel').evaluate(panel => {
    const overflow = getComputedStyle(panel).overflowY;
    const overflowing = panel.scrollHeight > panel.clientHeight;
    panel.scrollTop = panel.scrollHeight;
    const box = panel.getBoundingClientRect();
    const last = [...panel.querySelectorAll('[data-agy-config-choice="native-extra-13"]')].at(-1).getBoundingClientRect();
    return { overflow, overflowing, reachedEnd: last.top >= box.top - 1 && last.bottom <= box.bottom + 1 };
  });
  expect(scroll.overflow).toMatch(/auto|scroll/);
  expect(scroll.overflowing).toBe(true);
  expect(scroll.reachedEnd).toBe(true);
  await expectComposerGeometry(page);
  await saveScreenshot(page, testInfo, 'short-landscape-model-panel-scrolled');
});

test('Antigravity composer follows an iOS keyboard viewport in idle and steering', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockVisualViewport(page, { iosStandalone: true });
  await openAntigravityHarness(page, 'light');
  await page.locator('#cmd-input').fill('Keyboard-visible instruction');
  await page.evaluate(() => window.setTestVisualViewport({ height: 410, offsetTop: 52 }));
  await expectComposerGeometry(page);
  await page.locator('#antigravity-model-btn').click();
  await expectModelPanelInsideViewport(page);
  await saveScreenshot(page, testInfo, 'phone-keyboard-model-panel');
  await page.locator('#antigravity-model-btn').click();
  await page.evaluate(() => applyAntigravityState({
    status: 'running', turnId: 'keyboard-layout-turn', canSteer: true, canAbort: true
  }));
  await expect(page.locator('#send-btn')).toHaveAttribute('aria-label', 'Add instruction');
  await expectSteeringLabelGeometry(page);
  await expectComposerGeometry(page);
  await expectScrollableRail(page);
  await saveScreenshot(page, testInfo, 'phone-keyboard-steering');
});

test('the shared Codex steering Send label is readable on narrow and short screens', async ({ page }, testInfo) => {
  await openAntigravityHarness(page, 'light');
  await page.evaluate(() => {
    activeToolKey = 'codex';
    setClaudeModeEnabled(false);
    applyCodexState({ status: 'idle', models: [], canSteer: false, canAbort: false });
  });
  await expect(page.locator('#send-btn > .action-label')).not.toBeVisible();
  await page.evaluate(() => applyCodexState({ status: 'running', turnId: 'codex-layout-turn', canSteer: true, canAbort: true }));
  for (const screen of [{ width: 375, height: 812 }, { width: 440, height: 956 }, { width: 820, height: 1180 }, { width: 843, height: 388 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(screen);
    await expectSteeringLabelGeometry(page, 'codex-control-rail');
    const bounds = await page.locator('#send-btn').boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(screen.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(screen.height + 1);
    await saveScreenshot(page, testInfo, `codex-steering-send-${screen.width}`);
  }
});

test('Antigravity shows transient status without reserving an idle row or hiding pending attention', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAntigravityHarness(page, 'light');
  const bar = page.locator('#antigravity-state-bar');
  for (const transition of [
    { patch: { status: 'connecting' }, text: /Connecting/ },
    { patch: { status: 'stopping', aborting: true }, text: /Stopping/ },
    { patch: { status: 'resuming', resuming: true }, text: /Restoring/ },
    { patch: { status: 'idle', compacting: true }, text: /Compacting/ }
  ]) {
    await page.evaluate(patch => applyAntigravityState({
      aborting: false, resuming: false, compacting: false, canSteer: false, canAbort: false, ...patch
    }), transition.patch);
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(transition.text);
    expect(await bar.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(0);
    await page.evaluate(() => applyAntigravityState({
      status: 'idle', aborting: false, resuming: false, compacting: false, canSteer: false, canAbort: false
    }));
    await expectHiddenStateBar(page);
    await expectComposerGeometry(page);
  }
  await page.evaluate(() => applyAntigravityState({ status: 'running', turnId: 'plain-running', canSteer: false, canAbort: true }));
  await expectHiddenStateBar(page);
  await expectComposerGeometry(page);

  await page.evaluate(() => {
    antigravityMessages.push({ id: 'attention-tool', kind: 'tool', providerId: 'native-attention-tool', turnId: 'attention-turn', toolStatus: 'pending', title: 'Review this command' });
    antigravityPendingPermissions = [{
      id: 'attention-permission', toolUseId: 'native-attention-tool', turnId: 'attention-turn',
      status: 'pending', title: 'Review this command', options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }];
    applyAntigravityState({ status: 'waiting_approval', turnId: 'attention-turn', canSteer: false, canAbort: false });
  });
  await expectHiddenStateBar(page);
  await expectComposerGeometry(page);
  const attention = page.locator('#session-attention-rail .approval');
  await expect(attention).toHaveText(/1 approval/);
  await expect(attention).toBeVisible();
  await attention.click();
  await expect(page.locator('[data-agy-permission="attention-permission"] [data-agy-permission-option="allow-once"]')).toBeVisible();
  await expect(page.locator('#send-btn')).toBeDisabled();
  await saveScreenshot(page, testInfo, 'approval-attention-without-state-row');

  await page.evaluate(() => {
    antigravityPendingPermissions = [];
    antigravityMessages.push({
      id: 'attention-question', kind: 'question', questionStatus: 'pending', title: 'Choose the next step',
      questions: [{ id: 'next', question: 'What should happen next?', type: 'string' }]
    });
    applyAntigravityState({ status: 'waiting_input', canSteer: false, canAbort: false });
  });
  await expectHiddenStateBar(page);
  await expectComposerGeometry(page);
  await expect(attention).toHaveText(/1 awaiting answer/);
  await expect(attention).toBeVisible();
  await attention.click();
  await expect(page.locator('[data-agy-question="attention-question"] textarea')).toBeFocused();
  await expect(page.locator('#send-btn')).toBeDisabled();
  await saveScreenshot(page, testInfo, 'question-attention-without-state-row');
});
