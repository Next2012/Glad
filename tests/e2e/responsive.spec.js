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

async function createNamedSession(page, toolKey, name) {
  const created = await page.request.post('/api/sessions', { data: { toolKey } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  const renamed = await page.request.patch(`/api/sessions/${id}`, { data: { name } });
  expect(renamed.ok()).toBe(true);
  return id;
}

async function expectSessionDeleted(page, sessionId) {
  const response = await page.request.get('/api/sessions');
  expect(response.ok()).toBe(true);
  expect((await response.json()).some(session => session.id === sessionId)).toBe(false);
}

test('lobby assets and primary dialogs remain usable', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('Glad - AI Sessions');
  await expect(page.locator('#lobby-view')).toHaveClass(/active/);
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('#lobby-view .header h1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByTitle('New AI session')).toContainText('Session');
  await expect(page.getByTitle('Usage dashboard')).toBeVisible();
  await expect(page.getByTitle('New scheduled task')).toBeVisible();
  await expect(page.locator('#lobby-tab-sessions')).toHaveText('Sessions');
  await expect(page.locator('#lobby-tab-schedules')).toHaveText('Tasks');

  const headerActionStyles = await page.locator('.header-action-btn').evaluateAll(buttons =>
    buttons.map(button => {
      const style = getComputedStyle(button);
      return {
        backgroundColor: style.backgroundColor,
        height: style.height,
        borderRadius: style.borderRadius
      };
    })
  );
  expect(headerActionStyles).toHaveLength(4);
  expect(new Set(headerActionStyles.map(style => style.backgroundColor)).size).toBe(1);
  expect(new Set(headerActionStyles.map(style => style.height)).size).toBe(1);
  expect(new Set(headerActionStyles.map(style => style.borderRadius)).size).toBe(1);
  const headerActionTitles = await page.locator('.header-action-btn').evaluateAll(buttons =>
    buttons.map(button => button.title)
  );
  expect(headerActionTitles).toEqual(['New AI session', 'Usage dashboard', 'New scheduled task', 'Settings']);

  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    resources: performance.getEntriesByType('resource').map(entry => entry.name)
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.resources.some(url => url.includes('unpkg.com'))).toBe(false);
  for (const asset of ['bootstrap.js', 'styles.css', 'core.js', 'claude.js', 'codex.js', 'session.js', 'usage.js', 'vendor/xterm.js']) {
    expect(layout.resources.some(url => url.endsWith(asset))).toBe(true);
  }

  await page.getByTitle('New AI session').click();
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await expectInsideViewport(page.locator('#tool-modal'), page);
  await page.locator('#modal-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#modal-overlay')).toBeHidden();

  await page.getByTitle('New scheduled task').click();
  await expect(page.locator('#schedule-modal-overlay')).toBeVisible();
  await expect(page.locator('#schedule-modal-title')).toHaveText('New Scheduled Task');
  await expect(page.locator('.schedule-modal-subtitle')).toContainText('automatically');
  await expectInsideViewport(page.locator('#schedule-modal'), page);
  await expect(page.locator('#schedule-name')).toBeEditable();

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('lobby-and-schedule.png'), fullPage: true });
});

test('desktop sidebar identifies and deletes the active structured session', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop split layout only');

  const sessionId = await createNamedSession(page, 'codex', 'A deliberately long desktop session name');
  let deleteCount = 0;

  await page.addInitScript(() => localStorage.setItem('glad-sidebar-width', '300'));
  page.on('request', request => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/sessions/${sessionId}`) {
      deleteCount += 1;
    }
  });
  page.on('dialog', dialog => dialog.accept());

  await page.goto('/', { waitUntil: 'networkidle' });

  const newSessionButton = page.getByTitle('New AI session');
  await expect(newSessionButton).toContainText('+Session');
  const newSessionGeometry = await newSessionButton.evaluate(button => {
    const label = button.querySelector('span:last-child').getBoundingClientRect();
    const sidebar = document.getElementById('lobby-view').getBoundingClientRect();
    const header = document.querySelector('#lobby-view .header').getBoundingClientRect();
    return {
      buttonLeft: button.getBoundingClientRect().left,
      headerLeft: header.left,
      labelWidth: label.width,
      labelRight: label.right,
      sidebarRight: sidebar.right,
      fontSize: parseFloat(getComputedStyle(button.querySelector('span:last-child')).fontSize)
    };
  });
  expect(newSessionGeometry.fontSize).toBeGreaterThan(0);
  expect(newSessionGeometry.labelWidth).toBeGreaterThan(35);
  expect(newSessionGeometry.buttonLeft).toBeGreaterThanOrEqual(newSessionGeometry.headerLeft);
  expect(newSessionGeometry.labelRight).toBeLessThanOrEqual(newSessionGeometry.sidebarRight);

  const sessionCard = page.locator(`.session-card[data-session-id="${sessionId}"]`);
  await expect(sessionCard).toHaveCount(1);
  await sessionCard.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('#terminal-view')).toHaveClass(/active/);
  await expect(sessionCard).toHaveClass(/selected/);
  await expect(sessionCard.locator('.active-session-dot')).toBeVisible();
  await expect(sessionCard.locator('.active-session-dot')).toHaveCSS('background-color', 'rgb(52, 199, 89)');
  await sessionCard.getByRole('button', { name: 'Delete session' }).click();
  await expect.poll(() => deleteCount).toBe(1);
  await expect(sessionCard).toHaveCount(0);
  await expect(page.locator('#detail-empty')).toBeVisible();
  await expectSessionDeleted(page, sessionId);
});

test('touch lobby deletes a structured session', async ({ page }) => {
  test.skip(page.viewportSize().width >= 920, 'Compact touch layouts only');

  const sessionId = await createNamedSession(page, 'codex', 'Touch deletion regression');
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/', { waitUntil: 'networkidle' });

  const sessionCard = page.locator(`.session-card[data-session-id="${sessionId}"]`);
  await sessionCard.getByRole('button', { name: 'Delete session' }).tap();
  await expect(sessionCard).toHaveCount(0);
  await expectSessionDeleted(page, sessionId);
});

test('split sidebar divider stays fixed while the saved width is restored', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(() => {
    localStorage.setItem('glad-sidebar-width', '430');
    window.__sidebarLoadPositions = [];
    document.addEventListener('DOMContentLoaded', () => {
      window.__sidebarLoadPositions.push(document.getElementById('sidebar-resizer').getBoundingClientRect().left);
      requestAnimationFrame(() => {
        window.__sidebarLoadPositions.push(document.getElementById('sidebar-resizer').getBoundingClientRect().left);
      });
    }, { once: true });
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => window.__sidebarLoadPositions.length)).toBe(2);
  const positions = await page.evaluate(() => window.__sidebarLoadPositions);

  expect(positions[0]).toBeGreaterThanOrEqual(429);
  expect(Math.abs(positions[1] - positions[0])).toBeLessThanOrEqual(1);
});

test('structured execution disables send until the provider returns to idle', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const sendButton = page.locator('#send-btn');

  await page.evaluate(() => {
    activeToolKey = 'claude-code';
    claudeStatus = 'idle';
    claudeState = { ...claudeState, status: 'idle', canAbort: false };
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    window.__composerMessages = [];
    currentSocket = { readyState: 1, send: message => window.__composerMessages.push(JSON.parse(message)) };
    document.getElementById('cmd-input').value = 'Run once';
    performSend();
  });

  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveAttribute('aria-label', 'Send disabled while running');
  expect(await page.evaluate(() => window.__composerMessages.length)).toBe(1);
  await page.evaluate(() => applyClaudeState({ model: claudeState.model }));
  await expect(sendButton).toBeDisabled();

  await page.evaluate(() => applyClaudeState({ status: 'thinking', canAbort: true }, { providerStateReceived: true }));
  await expect(sendButton).toBeDisabled();
  await page.evaluate(() => applyClaudeState({ status: 'idle', canAbort: false }, { providerStateReceived: true }));
  await expect(sendButton).toBeEnabled();

  await page.evaluate(() => {
    activeToolKey = 'codex';
    setClaudeModeEnabled(false);
    applyCodexState({ status: 'running', aborting: false, resuming: false }, { providerStateReceived: true });
  });
  await expect(sendButton).toBeDisabled();
  await page.evaluate(() => applyCodexState({ status: 'waiting_approval' }, { providerStateReceived: true }));
  await expect(sendButton).toBeDisabled();
  await page.evaluate(() => applyCodexState({ status: 'idle', aborting: false, resuming: false }, { providerStateReceived: true }));
  await expect(sendButton).toBeEnabled();
});

test('light theme keeps dialogs, subview navigation, and file chips readable', async ({ page }) => {
  await page.route('**/api/tools', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ key: 'codex', displayName: 'Codex', version: '0.149.0' }])
  }));
  await page.route('**/api/usage/sources*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sources: [{ id: 'codex', label: 'Codex', badge: 'CX' }] })
  }));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => setGladTheme('light'));

  await page.getByTitle('New AI session').click();
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(page.locator('.tool-item')).toContainText('Codex');
  const toolColors = await page.locator('.tool-item').evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
    iconBackground: getComputedStyle(element.querySelector('.tool-icon')).backgroundColor
  }));
  expect(toolColors).toEqual({ background: 'rgb(247, 249, 251)', color: 'rgb(23, 32, 51)', iconBackground: 'rgb(220, 238, 255)' });
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByTitle('Usage dashboard').click();
  await expect(page.locator('.usage-source-copy strong')).toHaveText('Codex');
  await expect(page.locator('.usage-source-copy strong')).toHaveCSS('color', 'rgb(23, 32, 51)');
  await page.locator('#usage-source-overlay').click({ position: { x: 5, y: 5 } });

  await page.evaluate(() => {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('git-view').classList.add('active');
  });
  await expect(page.locator('#git-view .subview-nav')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('#git-view .subview-nav-title')).toHaveCSS('color', 'rgb(23, 32, 51)');

  await page.evaluate(() => {
    activeToolKey = 'codex';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    selectedFileAttachments = [{ id: 'file-preview', name: 'notes.txt', sessionId: 'preview', size: 10 }];
    renderComposerAttachments();
  });
  await expect(page.locator('.attachment-chip.file')).toHaveCSS('color', 'rgb(52, 64, 84)');
  await expect(page.locator('.attachment-chip.file')).toHaveCSS('background-color', 'rgb(242, 244, 247)');
  await page.evaluate(() => {
    activeToolKey = 'demo';
    setClaudeModeEnabled(false);
    currentSocket = { readyState: 1, send: value => { window.__terminalFileSent = JSON.parse(value); } };
  });
  await page.locator('#cmd-input').fill('Inspect this file');
  await page.locator('#send-btn').click();
  await expect.poll(() => page.evaluate(() => window.__terminalFileSent)).toEqual({
    type: 'file-input', text: 'Inspect this file', fileAttachmentIds: ['file-preview']
  });
});

test('git change cards use readable surfaces in light and dark themes', async ({ page }) => {
  await page.route('**/api/sessions/theme-git/git-status', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, files: [
      { path: 'src/theme.js', status: ' M' },
      { path: 'src/new-file.js', status: '??' },
      { path: 'src/old-file.js', status: ' D' }
    ] })
  }));
  await page.route('**/api/sessions/theme-git/git-diff-numstat**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, stdout: '3\t1\tsrc/theme.js' })
  }));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    activeSessionId = 'theme-git';
    window.activeSessionId = 'theme-git';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('git-view').classList.add('active');
    setGladTheme('light');
    await loadGitStatus();
  });

  const firstCard = page.locator('.git-change-card').first();
  await expect(firstCard).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(firstCard.locator('.git-change-header')).toHaveCSS('color', 'rgb(23, 32, 51)');
  await expect(page.locator('.git-status-badge.modified')).toHaveCSS('color', 'rgb(154, 103, 0)');

  await page.evaluate(() => setGladTheme('dark'));
  await expect(firstCard).toHaveCSS('background-color', 'rgb(28, 28, 30)');
  await expect(firstCard.locator('.git-change-header')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('#git-view .subview-nav')).toHaveCSS('background-color', 'rgb(18, 18, 18)');
});

test('dark theme keeps modal rows and attachment chips readable', async ({ page }) => {
  await page.route('**/api/tools', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ key: 'codex', displayName: 'Codex', version: '0.149.0' }])
  }));
  await page.route('**/api/usage/sources*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sources: [{ id: 'codex', label: 'Codex', badge: 'CX' }] })
  }));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => setGladTheme('dark'));

  await page.getByTitle('New AI session').click();
  await expect(page.locator('.tool-item')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('.tool-icon')).toHaveCSS('background-color', 'rgb(51, 51, 51)');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByTitle('Usage dashboard').click();
  await expect(page.locator('.usage-source-copy strong')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.locator('#usage-source-overlay').click({ position: { x: 5, y: 5 } });

  await page.evaluate(() => {
    activeToolKey = 'codex';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    selectedFileAttachments = [{ id: 'dark-file', name: 'archive.zip', sessionId: 'preview', size: 10 }];
    renderComposerAttachments();
  });
  await expect(page.locator('.attachment-chip.file')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('.attachment-chip.file')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.08)');
});

test('usage dashboard selects week or month and renders model summaries with daily charts', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.route('**/api/usage/sources*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      sources: [
        { id: 'codex', label: 'Codex', badge: 'CX' },
        { id: 'claude', label: 'Claude', badge: 'CL' }
      ],
      generatedAt: '2026-08-26T10:00:00.000Z',
      timezone: 'Asia/Shanghai'
    })
  }));
  await page.route('**/api/usage/report*', route => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') || 'weekly';
    const availablePeriods = scope === 'weekly' ? ['2026-08-24', '2026-08-17'] : ['2026-08', '2026-07'];
    const selectedPeriod = url.searchParams.get('period') || availablePeriods[0];
    const models = [
      { modelName: 'gpt-5.6-sol', uncachedInputTokens: 123456, cachedInputTokens: 9876543, outputTokens: 45678, totalTokens: 10045677, estimatedCostUSD: 8.7654 },
      { modelName: 'deepseek-v4-pro', uncachedInputTokens: 4000, cachedInputTokens: 0, outputTokens: 200, totalTokens: 4200, estimatedCostUSD: null }
    ];
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        source: { id: 'codex', label: 'Codex', badge: 'CX' },
        scope,
        availablePeriods,
        selectedPeriod,
        summary: {
          models,
          totals: { uncachedInputTokens: 127456, cachedInputTokens: 9876543, outputTokens: 45878, totalTokens: 10049877, estimatedCostUSD: 8.7654 }
        },
        days: [
          { period: '2026-08-25', models, totals: { totalTokens: 10049877, estimatedCostUSD: 8.7654 } },
          { period: '2026-08-26', models: [models[0]], totals: { totalTokens: 10045677, estimatedCostUSD: 8.7654 } }
        ],
        generatedAt: '2026-08-26T10:00:00.000Z',
        timezone: 'Asia/Shanghai',
        engine: { name: 'ccusage', version: '20.0.20', pricingMode: 'embedded' },
        cost: { basis: 'ccusage estimate for Codex GPT models', note: 'Estimate only.' }
      })
    });
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByTitle('Usage dashboard').click();
  await expect(page.locator('#usage-source-overlay')).toBeVisible();
  await expectInsideViewport(page.locator('#usage-source-modal'), page);
  await page.getByRole('button', { name: /Codex/ }).click();

  await expect(page.locator('#usage-view')).toHaveClass(/active/);
  await expect(page.locator('#usage-source-title')).toHaveText('Codex Usage');
  await expect(page.locator('#usage-scope-weekly')).toHaveClass(/active/);
  await expect(page.locator('#usage-period-select')).toHaveValue('2026-08-24');
  await expect(page.locator('#usage-summary')).toContainText('All-model tokens');
  await expect(page.locator('#usage-summary')).toContainText('All GPT cost');
  await expect(page.locator('#usage-model-summary')).toContainText('gpt-5.6-sol');
  await expect(page.locator('#usage-model-summary')).toContainText('deepseek-v4-pro');
  await expect(page.locator('#usage-model-summary')).toContainText('All models');
  await expect(page.locator('#usage-model-summary tbody tr').filter({ hasText: 'deepseek-v4-pro' })).toContainText('—');
  await expect(page.locator('#usage-token-chart .usage-chart-row')).toHaveCount(2);
  await expect(page.locator('#usage-token-legend')).toContainText('deepseek-v4-pro');
  await expect(page.locator('#usage-cost-chart .usage-chart-row')).toHaveCount(2);
  await expect(page.locator('#usage-cost-legend')).not.toContainText('deepseek-v4-pro');
  await expect(page.locator('#usage-daily-table')).toContainText('2026-08-26');
  await expect(page.locator('#usage-engine-note')).toContainText('ccusage 20.0.20');
  await expect(page.locator('#usage-engine-note')).toContainText('embedded pricing');
  await expectInsideViewport(page.locator('.usage-summary-card').first(), page);

  await page.locator('#usage-period-select').selectOption('2026-08-17');
  await expect(page.locator('#usage-period-select')).toHaveValue('2026-08-17');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page.locator('#usage-scope-monthly')).toHaveClass(/active/);
  await expect(page.locator('#usage-period-select')).toHaveValue('2026-08');

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('usage-dashboard.png'), fullPage: true });
});

test('approval bubble expands and jumps to its pending request', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(async () => {
    activeToolKey = 'codex';
    codexState = {
      ...codexState,
      status: 'waiting_approval',
      pendingPermissionCount: 1,
      threadId: 'root-thread'
    };
    codexPendingPermissions = [{
      id: 'approval-command-1',
      status: 'pending',
      title: 'Run command',
      reason: 'Allow this command to run?'
    }];
    codexMessages = [{
      id: 'tool-approval',
      providerId: 'approval-command-1',
      kind: 'tool',
      name: 'CodexBash',
      command: 'npm test',
      toolStatus: 'running',
      turnId: 'turn-1',
      hasDetail: true,
      detailRevision: 1,
      createdAt: Date.now()
    }, ...Array.from({ length: 24 }, (_, index) => ({
      id: `message-${index}`,
      kind: 'assistant',
      text: `Completed follow-up item ${index + 1}.\n\nAdditional output keeps the pending request above the current scroll position.`,
      createdAt: Date.now() + index + 1
    }))];

    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    installCodexLazyDetailHandler();
    currentSocket = {
      readyState: 1,
      send: value => {
        const request = JSON.parse(value);
        if (request.type !== 'codex-detail-request') return;
        setTimeout(() => applyCodexDetailResponse({
          requestId: request.requestId,
          detail: { messages: [{
            id: 'tool-approval', providerId: 'approval-command-1', kind: 'tool',
            name: 'CodexBash', command: 'npm test', result: 'Approval detail loaded',
            toolStatus: 'running', turnId: 'turn-1', createdAt: 1
          }] }
        }), 0);
      }
    };
    commitCodexChatRender();
    renderCodexStateBar();
    const chat = document.getElementById('codex-chat-container');
    chat.scrollTop = chat.scrollHeight;
  });

  const target = page.locator('[data-codex-permission-id="approval-command-1"]');
  await expect(target).toHaveCount(1);
  await expect(target).not.toBeVisible();
  const approvalJump = page.getByRole('button', { name: 'Jump to pending approval' });
  await expect(approvalJump.locator('xpath=..')).toHaveAttribute('id', 'session-attention-rail');
  const stripBox = await page.locator('#session-status-strip').boundingBox();
  const chatBox = await page.locator('#codex-chat-container').boundingBox();
  expect(stripBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(chatBox.y + 1);
  await approvalJump.click();

  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/codex-approval-focus/);
  await expect.poll(() => target.evaluate(element => {
    const parents = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parents.push(parent.open);
    }
    return parents.length > 0 && parents.every(Boolean);
  })).toBe(true);
  await expect(page.locator('.codex-work-group').first()).toContainText('Approval detail loaded');
  await expect(target).toBeInViewport();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('approval-jump.png'), fullPage: true });
});

test('Codex lazily loads folded tool and subagent details', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeSessionId = 'lazy-codex';
    activeToolKey = 'codex';
    codexState = { ...codexState, threadId: 'root-thread' };
    codexMessages = [
      { id: 'root-start', kind: 'turn-start', threadId: 'root-thread', turnId: 'root-turn', createdAt: 1 },
      { id: 'tool-lazy', providerId: 'tool-provider', kind: 'tool', threadId: 'root-thread',
        turnId: 'root-turn', name: 'CodexBash', command: 'npm test', toolStatus: 'completed',
        hasDetail: true, detailRevision: 2, createdAt: 2 },
      { id: 'agent-start', kind: 'turn-start', threadId: 'agent-thread', turnId: 'agent-turn', createdAt: 3 },
      { id: 'agent-message', kind: 'assistant', threadId: 'agent-thread', turnId: 'agent-turn',
        hasDetail: true, detailRevision: 4, createdAt: 4 },
      { id: 'agent-end', kind: 'turn-end', threadId: 'agent-thread', turnId: 'agent-turn',
        status: 'completed', createdAt: 5 }
    ];
    codexPendingPermissions = [];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    installCodexLazyDetailHandler();
    window.__codexDetailRequests = [];
    currentSocket = { readyState: 1, send: value => window.__codexDetailRequests.push(JSON.parse(value)) };
    commitCodexChatRender();
  });

  const toolGroup = page.locator('.codex-work-group:not(.codex-subagent-group)').first();
  await toolGroup.locator(':scope > summary').click();
  await expect.poll(() => page.evaluate(() => window.__codexDetailRequests.length)).toBe(1);
  await page.evaluate(async () => {
    const request = window.__codexDetailRequests[0];
    applyCodexDetailResponse({
      type: 'codex-detail-response',
      requestId: request.requestId,
      detail: { messages: [{
        id: 'tool-lazy', providerId: 'tool-provider', kind: 'tool', threadId: 'root-thread',
        turnId: 'root-turn', name: 'CodexBash', command: 'npm test', result: '50 tests passed',
        input: { command: 'npm test' }, toolStatus: 'completed', hasDetail: true,
        detailLoaded: true, detailRevision: 2, createdAt: 2
      }] }
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(toolGroup).toHaveAttribute('open', '');
  await expect(toolGroup).toContainText('50 tests passed');

  await page.evaluate(() => applyCodexEvent({
    type: 'message-updated',
    message: {
      id: 'tool-lazy', providerId: 'tool-provider', kind: 'tool', threadId: 'root-thread',
      turnId: 'root-turn', name: 'CodexBash', command: 'npm test', toolStatus: 'running',
      hasDetail: true, detailRevision: 6, createdAt: 2, updatedAt: 6
    }
  }));
  await expect.poll(() => page.evaluate(() => window.__codexDetailRequests.length)).toBe(2);
  await page.evaluate(async () => {
    const request = window.__codexDetailRequests[1];
    applyCodexDetailResponse({
      requestId: request.requestId,
      detail: { messages: [{
        id: 'tool-lazy', providerId: 'tool-provider', kind: 'tool', threadId: 'root-thread',
        turnId: 'root-turn', name: 'CodexBash', command: 'npm test', result: '51 tests passed',
        input: { command: 'npm test' }, toolStatus: 'running', createdAt: 2, updatedAt: 6
      }] }
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(toolGroup).toContainText('51 tests passed');

  const subagentGroup = page.locator('.codex-subagent-group').first();
  await subagentGroup.locator(':scope > summary').click();
  await expect.poll(() => page.evaluate(() => window.__codexDetailRequests.length)).toBe(3);
  await page.evaluate(async () => {
    const request = window.__codexDetailRequests[2];
    applyCodexDetailResponse({
      type: 'codex-detail-response',
      requestId: request.requestId,
      detail: { threadId: 'agent-thread', messages: [{
        id: 'agent-message', kind: 'assistant', threadId: 'agent-thread', turnId: 'agent-turn',
        text: 'Subagent completed its investigation.', hasDetail: true,
        detailLoaded: true, detailRevision: 4, createdAt: 4
      }] }
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(subagentGroup).toHaveAttribute('open', '');
  await expect(subagentGroup).toContainText('Subagent completed its investigation.');

  await page.evaluate(() => applyCodexEvent({
    type: 'message-updated',
    message: {
      id: 'agent-message', kind: 'assistant', threadId: 'agent-thread', turnId: 'agent-turn',
      hasDetail: true, detailRevision: 8, createdAt: 4, updatedAt: 8
    }
  }));
  await expect.poll(() => page.evaluate(() => window.__codexDetailRequests.length)).toBe(4);
  await page.evaluate(async () => {
    const request = window.__codexDetailRequests[3];
    applyCodexDetailResponse({
      requestId: request.requestId,
      detail: { threadId: 'agent-thread', messages: [{
        id: 'agent-message', kind: 'assistant', threadId: 'agent-thread', turnId: 'agent-turn',
        text: 'Subagent received a running update.', createdAt: 4, updatedAt: 8
      }] }
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(subagentGroup).toContainText('Subagent received a running update.');
  await page.evaluate(() => {
    document.querySelector('.codex-subagent-group').open = false;
    applyCodexState({ activeSubagentCount: 1 });
  });
  const subagentJump = page.getByRole('button', { name: 'Jump to active subagent' });
  await expect(subagentJump).toBeVisible();
  await expect(subagentJump.locator('xpath=..')).toHaveAttribute('id', 'session-attention-rail');
  await subagentJump.click();
  await expect(subagentGroup).toHaveAttribute('open', '');
  expect(pageErrors).toEqual([]);
});

test('Codex unlocks resume controls after the server rejects recovery', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeSessionId = 'failing-resume';
    activeToolKey = 'codex';
    codexState = { ...codexState, status: 'idle', resuming: false };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    document.getElementById('codex-resume-panel').classList.add('active');
    window.fetch = async url => {
      if (String(url).includes('codex-resume-threads')) {
        return new Response(JSON.stringify({ success: true, items: [{
          id: 'retry-thread', questions: ['Retry conversation', 'Second question'], updatedAt: 100
        }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // 模拟 WebSocket 状态先于失败的 HTTP 响应到达。
      applyCodexState({ resuming: false, canAbort: false });
      return new Response(JSON.stringify({ error: 'thread already has an active writer' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    applyCodexState({});
  });

  await page.evaluate(() => selectCodexResumeThread('busy-thread'));

  await expect(page.locator('#codex-state-bar')).not.toContainText('Resuming conversation');
  await expect(page.locator('#codex-resume-panel')).toContainText('already has an active writer');
  await expect(page.locator('#codex-resume-btn')).toBeEnabled();
  await expect(page.locator('#codex-fork-btn')).toBeEnabled();
  await expect(page.locator('#codex-abort-btn')).toBeDisabled();

  await page.evaluate(() => toggleCodexResumePanel());
  await expect(page.locator('#codex-resume-panel .claude-resume-item')).toContainText('Retry conversation');
  expect(pageErrors).toEqual([]);
});

test('Codex shows per-turn context energy and context compaction controls', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    const now = Date.now();
    activeSessionId = 'test-codex-context';
    activeToolKey = 'codex';
    codexState = {
      ...codexState,
      status: 'idle',
      threadId: 'root-thread',
      canCompact: true,
      compacting: false
    };
    codexMessages = [
      { id: 'context-user', kind: 'user', text: 'Check the project', turnId: 'context-turn', createdAt: now - 4000 },
      { id: 'context-assistant', kind: 'assistant', text: 'The project looks good.', turnId: 'context-turn', createdAt: now - 1000, completedAtMs: now - 800 },
      { id: 'context-end', kind: 'turn-end', turnId: 'context-turn', createdAt: now - 700,
        context: { usedTokens: 45000, remainingTokens: 213000, contextWindow: 258000, remainingPercent: 83 } },
      { id: 'context-compaction', kind: 'compaction', providerId: 'compact-item', turnId: 'compact-turn',
        compactionStatus: 'completed', createdAt: now - 500, completedAtMs: now - 400 }
    ];
    codexPendingPermissions = [];
    window.__codexSent = null;
    currentSocket = {
      readyState: 1,
      send: data => { window.__codexSent = JSON.parse(data); }
    };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    applyCodexState(codexState);
    commitCodexChatRender();
  });

  const meter = page.locator('.codex-context-meter');
  await expect(meter).toHaveText('213K / 258K（83%）');
  await expect(meter).toHaveAttribute('style', /83%/);
  const meterColors = await meter.evaluate(element => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
    fill: getComputedStyle(element, '::before').backgroundColor
  }));
  expect(meterColors).toEqual({
    color: 'rgb(18, 95, 52)',
    background: 'rgb(239, 250, 243)',
    fill: 'rgb(188, 235, 201)'
  });
  await expect(page.locator('.codex-compaction-card')).toContainText('Context compacted');

  await page.locator('#codex-control-rail').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const compactButton = page.getByRole('button', { name: 'Compact' });
  await expect(compactButton).toBeInViewport();
  await expect(compactButton).toBeEnabled();
  await compactButton.click();
  await expect.poll(() => page.evaluate(() => window.__codexSent)).toEqual({ type: 'codex-compact' });
  await expect(compactButton).toBeDisabled();
  await expect(compactButton).toHaveText('Compacting');

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('codex-context-and-compaction.png'), fullPage: true });
});

test('Codex renders warning cards and paginates four-line prompt history with full-text copy', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/sessions/test-codex-prompts/codex-prompts**', async route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    const count = offset === 0 ? 30 : 5;
    const items = Array.from({ length: count }, (_, index) => {
      const itemIndex = offset + index;
      return {
        id: `prompt-${itemIndex}`,
        threadId: 'prompt-thread',
        text: itemIndex === 0
          ? 'Line one of the complete prompt.\nLine two stays visible.\nLine three stays visible.\nLine four stays visible.\nLine five is clamped.\nLine six must still be copied.'
          : `Historical prompt ${itemIndex + 1}`,
        createdAt: Date.now() - itemIndex * 1000
      };
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, items, offset, nextOffset: offset + count, total: 35, hasMore: offset + count < 35 })
    });
  });
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeSessionId = 'test-codex-prompts';
    activeToolKey = 'codex';
    codexState = { ...codexState, status: 'idle', threadId: 'prompt-thread' };
    codexMessages = [{
      id: 'model-warning',
      kind: 'event',
      level: 'warning',
      text: 'This session was recorded with model A but is resuming with model B.'
    }];
    copyTextToClipboard = async text => { window.__copiedPrompt = text; };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    applyCodexState(codexState);
    commitCodexChatRender();
  });

  const warning = page.locator('.codex-warning-card');
  await expect(warning).toContainText('recorded with model A');
  await expect(warning.locator('button')).toHaveCount(0);

  await page.locator('#codex-control-rail').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.locator('#codex-prompts-btn').click();
  const panel = page.locator('#codex-prompt-panel');
  await expect(panel).toHaveClass(/active/);
  await expect(panel.locator('.codex-prompt-item')).toHaveCount(30);
  await expect(panel.locator('.codex-prompt-header')).toContainText('30 / 35');
  const firstPrompt = panel.locator('.codex-prompt-text').first();
  await expect.poll(() => firstPrompt.evaluate(element => getComputedStyle(element).webkitLineClamp)).toBe('4');
  await panel.locator('.codex-prompt-copy').first().click();
  await expect.poll(() => page.evaluate(() => window.__copiedPrompt)).toContain('Line six must still be copied.');

  await panel.getByRole('button', { name: 'Load more' }).click();
  await expect(panel.locator('.codex-prompt-item')).toHaveCount(35);
  await expect(panel.locator('.codex-prompt-header')).toContainText('35 / 35');
  await expect(panel.getByRole('button', { name: 'Load more' })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('codex-warning-and-prompts.png'), fullPage: true });
});

test('Codex selects a skill with a removable floating bubble and sends structured skill input', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/sessions/test-codex-skills/codex-skills**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, skills: [
      {
        name: 'pdf',
        path: '/workspace/.agents/skills/pdf/SKILL.md',
        description: 'Create, inspect, and edit PDF documents.',
        enabled: true,
        scope: 'repo',
        interface: { displayName: 'PDF tools', shortDescription: 'Work reliably with PDF documents.' }
      },
      {
        name: 'review',
        path: '/workspace/.agents/skills/review/SKILL.md',
        description: 'Review repository changes.',
        enabled: true,
        scope: 'repo',
        interface: { displayName: 'Repository review', shortDescription: 'Review the current repository.' }
      },
      {
        name: 'pdf-personal',
        path: '/home/test/.codex/skills/pdf/SKILL.md',
        description: 'Personal PDF workflow.',
        enabled: true,
        scope: 'user',
        interface: { displayName: 'PDF tools', shortDescription: 'Use the personal PDF workflow.' }
      },
      {
        name: 'issues',
        path: '/opt/plugins/issues/skills/issues/SKILL.md',
        description: 'Analyze tracked issues.',
        enabled: true,
        scope: 'plugin',
        interface: { displayName: 'Issue analysis', shortDescription: 'Analyze issues from installed plugins.' }
      }
    ], errors: [] })
  }));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeSessionId = 'test-codex-skills';
    activeToolKey = 'codex';
    codexState = { ...codexState, status: 'running', threadId: 'skills-thread' };
    codexMessages = [];
    codexPendingPermissions = [];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    applyCodexState(codexState);
    commitCodexChatRender();
  });

  const workingBox = await page.locator('.codex-working-indicator').boundingBox();
  expect(workingBox).not.toBeNull();
  await page.evaluate(() => applyCodexState({ status: 'idle' }));
  await page.locator('#codex-control-rail').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const skillsButton = page.getByRole('button', { name: 'Skills' });
  await expect(skillsButton).toBeInViewport();
  const buttonBoxBefore = await skillsButton.boundingBox();
  await skillsButton.click();
  const skillPanel = page.locator('#codex-skill-panel');
  await expect(skillPanel).toHaveClass(/active/);
  await expect(skillPanel.getByRole('searchbox', { name: 'Search skills' })).toBeFocused();
  await expect(skillPanel.locator('.codex-skill-section-title > span:first-child')).toHaveText(['Current project', 'Personal', 'Other']);
  await expect(skillPanel.locator('.codex-skill-source')).toHaveText(['Project', 'Project', 'Personal', 'Plugin']);
  const projectPdfSkill = skillPanel.locator('[data-codex-skill-path="/workspace/.agents/skills/pdf/SKILL.md"]');
  await expect(projectPdfSkill.locator('.codex-skill-item-name > span:first-child')).toHaveText('pdf');
  await expect(projectPdfSkill).toContainText('Work reliably with PDF documents.');
  await expect(projectPdfSkill.locator('.codex-skill-full-name')).toHaveCount(0);
  await expect(projectPdfSkill.locator('.codex-skill-directory')).toHaveText('Dir · pdf');
  await expect(projectPdfSkill.locator('.codex-skill-directory')).toHaveAttribute('title', 'pdf');

  const search = skillPanel.getByRole('searchbox', { name: 'Search skills' });
  await search.evaluate(element => { window.__codexSkillSearchElement = element; });
  await search.fill('/opt/plugins');
  await expect.poll(() => page.evaluate(() => (
    window.__codexSkillSearchElement === document.getElementById('codex-skill-search')
    && document.activeElement === window.__codexSkillSearchElement
  ))).toBe(true);
  await expect(skillPanel.locator('.codex-skill-section-title > span:first-child')).toHaveText(['Search results']);
  await expect(skillPanel.locator('.codex-skill-item')).toHaveCount(1);
  await expect(skillPanel.locator('.codex-skill-item')).toContainText('issues');
  await search.fill('');
  await page.screenshot({ path: testInfo.outputPath('codex-skill-search.png'), fullPage: true });

  await skillPanel.locator('[data-codex-skill-path="/workspace/.agents/skills/pdf/SKILL.md"]').click();

  const bubble = page.locator('.codex-skill-bubble');
  await expect(bubble).toContainText('Skill · pdf');
  const bubbleBox = await bubble.boundingBox();
  const inputBox = await page.locator('#cmd-input').boundingBox();
  const buttonBoxAfter = await skillsButton.boundingBox();
  expect(Math.abs(bubbleBox.x - inputBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs((bubbleBox.y + bubbleBox.height) - inputBox.y)).toBeLessThanOrEqual(2);
  await expect(page.locator('#composer-skill-prefix')).toHaveClass(/active/);
  expect(buttonBoxAfter).toEqual(buttonBoxBefore);

  await bubble.getByRole('button', { name: 'Remove selected skill' }).click();
  await expect(bubble).toHaveCount(0);
  await skillsButton.click();
  await expect(skillPanel.locator('.codex-skill-section-title').first().locator('span').first()).toHaveText('Recently used');
  await expect(skillPanel.locator('.codex-skill-section').first().locator('.codex-skill-item')).toHaveCount(1);
  await skillPanel.locator('.codex-skill-section').first()
    .locator('[data-codex-skill-path="/workspace/.agents/skills/pdf/SKILL.md"]').click();
  await expect(bubble).toBeVisible();

  await page.evaluate(() => {
    currentSocket = { readyState: 1, send: value => { window.__codexSkillSent = JSON.parse(value); } };
  });
  await page.locator('#cmd-input').fill('Analyze the attached report');
  await page.locator('#send-btn').click();
  await expect.poll(() => page.evaluate(() => window.__codexSkillSent)).toEqual({
    type: 'codex-input',
    text: 'Analyze the attached report',
    attachmentIds: [],
    skills: [{ name: 'pdf', path: '/workspace/.agents/skills/pdf/SKILL.md' }]
  });
  await expect(bubble).toHaveCount(0);

  await page.evaluate(() => {
    codexMessages = [{
      id: 'resumed-skill-message',
      kind: 'user',
      text: 'Analyze the attached report',
      createdAt: Date.now(),
      skills: [{ name: 'pdf', path: '/workspace/.agents/skills/pdf/SKILL.md' }]
    }];
    commitCodexChatRender();
  });
  const messageBlock = page.locator('[data-codex-key="message-resumed-skill-message"]');
  const messageSkills = messageBlock.locator('.codex-message-skills');
  const messageBubble = messageBlock.locator('.codex-message.user');
  const messageMeta = messageBlock.locator('.codex-message-meta');
  await expect(messageMeta.locator('time')).toBeVisible();
  await expect(messageSkills.locator('.codex-message-skill')).toHaveText('Skill · pdf');
  const sentSkillBox = await messageSkills.boundingBox();
  const sentMessageBox = await messageBubble.boundingBox();
  expect(Math.abs(sentSkillBox.x - sentMessageBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs((sentSkillBox.y + sentSkillBox.height) - sentMessageBox.y)).toBeLessThanOrEqual(2);
  await expect.poll(() => messageBlock.evaluate(element => Array.from(element.children).map(child => child.className))).toEqual([
    'codex-message-skills', 'codex-message user claude-md', 'codex-message-meta'
  ]);
  await expect.poll(() => messageMeta.evaluate(element => Array.from(element.children).map(child => child.tagName))).toEqual(['TIME']);

  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('codex-skill-selection.png'), fullPage: true });
});

test('Claude approval stays inline and its bubble preserves reading state', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeToolKey = 'claude-code';
    claudeStatus = 'thinking';
    claudeState = { ...claudeState, status: 'thinking', pendingPermissionCount: 1 };
    claudePendingPermissions = [{
      id: 'claude-approval-1',
      toolUseId: 'claude-tool-1',
      toolName: 'Bash',
      title: 'Bash requires approval',
      reason: 'Allow this command to run?',
      input: { command: 'npm test' },
      status: 'pending'
    }];
    claudeMessages = [{
      id: 'claude-tool-message-1',
      kind: 'tool',
      name: 'Bash',
      toolUseId: 'claude-tool-1',
      input: { command: 'npm test' },
      createdAt: Date.now()
    }, ...Array.from({ length: 24 }, (_, index) => ({
      id: `claude-message-${index}`,
      kind: 'assistant',
      text: `Claude follow-up item ${index + 1}.\n\nExtra content keeps the approval above the reading position.`,
      createdAt: Date.now() + index + 1
    }))];

    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    commitClaudeChatRender();
    const chat = document.getElementById('claude-chat-container');
    chat.scrollTop = chat.scrollHeight;
  });

  const target = page.locator('[data-claude-permission-id="claude-approval-1"]');
  await expect(target).toHaveCount(1);
  await expect(target).not.toBeVisible();
  const claudeApprovalJump = page.getByRole('button', { name: 'Jump to pending Claude approval' });
  await expect(claudeApprovalJump.locator('xpath=..')).toHaveAttribute('id', 'session-attention-rail');
  await claudeApprovalJump.click();

  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/claude-approval-focus/);
  await expect(target).toBeInViewport();
  await expect(target.getByRole('button', { name: 'Allow command' })).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-approval-jump.png'), fullPage: true });
});

test('Claude shows one Working bubble and keeps controls in one freely scrolling row', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const layout = await page.evaluate(() => {
    activeToolKey = 'claude-code';
    claudeStatus = 'thinking';
    claudeState = { ...claudeState, status: 'thinking', canAbort: true, claudeSessionId: 'claude-current' };
    claudeMessages = [{ id: 'working-message', kind: 'assistant', text: 'Work in progress', createdAt: Date.now() }];
    claudePendingPermissions = [];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    commitClaudeChatRender();
    const controlIds = page => Array.from(page.children).map(child => child.id
      || child.querySelector('button')?.id || child.querySelector('select')?.id || '');
    const pages = document.querySelectorAll('.claude-control-page');
    const stateBar = document.getElementById('claude-state-bar');
    const indicator = document.querySelector('.claude-working-indicator');
    return {
      first: controlIds(pages[0]),
      second: controlIds(pages[1]),
      stateText: stateBar.textContent,
      indicatorPosition: indicator ? getComputedStyle(indicator).position : '',
      firstPageDisplay: getComputedStyle(pages[0]).display,
      secondPageDisplay: getComputedStyle(pages[1]).display,
      scrollSnapType: getComputedStyle(document.querySelector('.claude-control-rail')).scrollSnapType
    };
  });

  expect(layout.first).toEqual([
    'claude-model-picker-btn', 'claude-usage-btn', 'claude-context-btn', 'claude-abort-btn',
    'claude-resume-btn', 'claude-fork-btn'
  ]);
  expect(layout.second).toEqual(['claude-permission-picker-btn']);
  expect(layout.stateText).not.toContain('Working');
  expect(layout.indicatorPosition).toBe('sticky');
  expect(layout.firstPageDisplay).toBe('flex');
  expect(layout.secondPageDisplay).toBe('flex');
  expect(layout.scrollSnapType).toBe('none');
  await expect(page.getByRole('status', { name: 'Claude is working' })).toBeVisible();
  await expect(page.locator('.claude-working-indicator')).toHaveCount(1);
  await expect(page.getByText('Claude is working...', { exact: true })).toHaveCount(0);
  await expect(page.locator('.claude-status')).toHaveCount(0);
  await expect(page.locator('#claude-usage-btn')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Context' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('claude-primary-controls.png'), fullPage: true });
  await page.locator('.claude-control-rail').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByRole('button', { name: 'Permission' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('claude-secondary-controls.png'), fullPage: true });
});

test('responsive shell, bottom composer, and themes follow the new layout', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => localStorage.removeItem('glad-theme'));
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('glad-theme'))).toBe('dark');
  await page.locator('#settings-modal-overlay').click({ position: { x: 5, y: 5 } });

  await page.evaluate(() => {
    activeToolKey = 'claude-code';
    claudeStatus = 'idle';
    claudeState = { ...claudeState, status: 'idle', canAbort: false };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
  });

  const geometry = await page.evaluate(() => {
    const composer = document.getElementById('terminal-controls').getBoundingClientRect();
    const send = document.getElementById('send-btn').getBoundingClientRect();
    const attachmentButton = document.getElementById('attachment-btn');
    const scheduleButton = document.getElementById('schedule-send-btn');
    const railElement = document.querySelector('.claude-control-rail');
    const attachment = attachmentButton.getBoundingClientRect();
    const schedule = scheduleButton.getBoundingClientRect();
    const rail = railElement.getBoundingClientRect();
    const firstAction = document.getElementById('claude-model-picker-btn').getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      composerBottom: composer.bottom,
      composerTop: composer.top,
      attachmentToScheduleGap: schedule.left - attachment.right,
      scheduleToFirstActionGap: firstAction.left - schedule.right,
      railToSendGap: send.left - rail.right,
      actionTops: [attachment.top, schedule.top, firstAction.top, send.top],
      actionHeights: [attachment.height, schedule.height, firstAction.height, send.height],
      lobbyVisible: getComputedStyle(document.getElementById('lobby-view')).display !== 'none',
      backVisible: getComputedStyle(document.getElementById('back-btn')).visibility !== 'hidden',
      resizerVisible: getComputedStyle(document.getElementById('sidebar-resizer')).display !== 'none',
      iconCount: document.querySelectorAll('.claude-control-rail .action-icon').length,
      utilityButtonsInRail: attachmentButton.parentElement === railElement && scheduleButton.parentElement === railElement,
      railScrollWidth: railElement.scrollWidth,
      railClientWidth: railElement.clientWidth,
      railOverflowX: getComputedStyle(railElement).overflowX
    };
  });

  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.composerTop).toBeGreaterThan(geometry.viewportHeight / 2);
  expect(geometry.attachmentToScheduleGap).toBeGreaterThanOrEqual(7);
  expect(geometry.scheduleToFirstActionGap).toBeGreaterThanOrEqual(7);
  expect(geometry.railToSendGap).toBeGreaterThanOrEqual(10);
  expect(Math.max(...geometry.actionTops) - Math.min(...geometry.actionTops)).toBeLessThanOrEqual(1);
  expect(new Set(geometry.actionHeights.map(Math.round))).toEqual(new Set([40]));
  expect(geometry.iconCount).toBeGreaterThanOrEqual(7);
  expect(geometry.utilityButtonsInRail).toBe(true);
  expect(geometry.railOverflowX).toBe('auto');
  if (geometry.viewportWidth <= 480) expect(geometry.railScrollWidth).toBeGreaterThan(geometry.railClientWidth);
  await expect(page.locator('#attachment-btn use')).toHaveAttribute('href', '#icon-file');
  await expect(page.locator('#schedule-send-btn use')).toHaveAttribute('href', '#icon-schedule');
  await expect(page.locator('#icon-schedule circle')).toHaveCount(1);
  await expect(page.locator('#schedule-create-button use')).toHaveAttribute('href', '#icon-calendar');
  await expect(page.locator('#attach-image-btn')).toHaveCount(0);
  await expect(page.locator('#codex-terminal-switch')).toHaveCount(0);
  await page.locator('#attachment-btn').focus();
  await expect(page.locator('#composer-action-tooltip')).toHaveText('Attachment');
  await expect(page.locator('#composer-action-tooltip')).toBeVisible();
  await page.locator('#claude-model-picker-btn').focus();
  await expect(page.locator('#composer-action-tooltip')).toHaveText('Model');
  const touchTooltipState = await page.evaluate(() => {
    document.activeElement?.blur?.();
    hideComposerActionTooltip();
    const button = document.getElementById('attachment-btn');
    const box = button.getBoundingClientRect();
    const event = (type, x, pointerId = 71) => new PointerEvent(type, {
      bubbles: true, pointerType: 'touch', pointerId, clientX: x, clientY: box.y + box.height / 2
    });
    button.dispatchEvent(event('pointerdown', box.x + 10));
    button.dispatchEvent(event('pointermove', box.x + 35));
    button.dispatchEvent(event('pointerup', box.x + 35));
    const shownAfterSwipe = document.getElementById('composer-action-tooltip').classList.contains('visible');
    button.dispatchEvent(event('pointerdown', box.x + 10, 72));
    button.dispatchEvent(event('pointerup', box.x + 10, 72));
    return {
      shownAfterSwipe,
      shownAfterTap: document.getElementById('composer-action-tooltip').classList.contains('visible'),
      label: document.getElementById('composer-action-tooltip').textContent
    };
  });
  expect(touchTooltipState).toEqual({ shownAfterSwipe: false, shownAfterTap: true, label: 'Attachment' });
  if (geometry.viewportWidth >= 920) {
    expect(geometry.lobbyVisible).toBe(true);
    expect(geometry.backVisible).toBe(false);
    expect(geometry.resizerVisible).toBe(true);
  } else {
    expect(geometry.lobbyVisible).toBe(false);
    expect(geometry.backVisible).toBe(true);
    expect(geometry.resizerVisible).toBe(false);
  }

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(pageErrors).toEqual([]);
});

test('Claude combines model and effort and renders separate CLI usage and context cards', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    activeSessionId = 'test-claude';
    activeToolKey = 'claude-code';
    claudeStatus = 'idle';
    claudeState = { ...claudeState, status: 'idle', model: 'sonnet', effort: 'medium' };
    claudeMessages = [];
    claudePendingPermissions = [];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    currentSocket = { readyState: 1, send: value => { window.__claudeSent = JSON.parse(value); } };
  });

  const modelButton = page.locator('#claude-model-picker-btn');
  await modelButton.click();
  const picker = page.locator('#claude-picker-panel');
  await expect(picker).toHaveClass(/combined/);
  await expect(picker.locator('.claude-picker-column')).toHaveCount(2);
  await expect(picker.locator('.claude-picker-title')).toHaveText(['Model', 'Effort']);
  await page.screenshot({ path: testInfo.outputPath('claude-model-effort-picker.png'), fullPage: true });
  await picker.locator('.claude-picker-column').nth(1).getByRole('button', { name: 'High', exact: true }).click();
  await expect(page.locator('#claude-effort-select')).toHaveValue('high');
  await expect(picker).toBeVisible();
  await modelButton.click();

  const usageButton = page.locator('#claude-usage-btn');
  await usageButton.click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent)).toEqual({ type: 'claude-usage' });
  await expect(usageButton).toBeDisabled();
  await expect(usageButton).toHaveText('Loading');
  await page.evaluate(() => applyClaudeEvent({
    type: 'message',
    message: {
      id: 'usage-card-1',
      kind: 'usage',
      title: 'Claude usage',
      createdAt: Date.now(),
      usage: {
        source: 'claude-cli',
        session: {
          totalCostUsd: 1.25,
          apiDuration: '1s',
          wallDuration: '4.5s',
          linesAdded: 8,
          linesRemoved: 3,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
          models: [{
            model: 'deepseek-v4-pro[1m]',
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 0,
            costUsd: 1.25
          }]
        }
      }
    }
  }));

  const card = page.locator('.claude-usage-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('100 in · 20 out');
  await expect(card).toContainText('deepseek-v4-pro[1m]');
  await expect(card).toContainText('$1.25');
  await expect(usageButton).toBeEnabled();

  const contextButton = page.locator('#claude-context-btn');
  await contextButton.click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent)).toEqual({ type: 'claude-context' });
  await expect(contextButton).toBeDisabled();
  await expect(contextButton).toHaveText('Loading');
  await page.evaluate(() => applyClaudeEvent({
    type: 'message',
    message: {
      id: 'context-card-1',
      kind: 'context',
      title: 'Claude context',
      createdAt: Date.now(),
      context: {
        model: 'claude-sonnet-4-5-20250929',
        usedTokens: 36100,
        maxTokens: 200000,
        usedPercent: 18,
        remainingTokens: 163900,
        categories: [
          { label: 'System prompt', tokens: 2500, percent: '1.3%' },
          { label: 'Messages', tokens: 33600, percent: '16.8%' }
        ]
      }
    }
  }));
  const contextCard = page.locator('.claude-context-card');
  await expect(contextCard).toContainText('36.1K / 200.0K');
  await expect(contextCard).toContainText('18% used');
  await expect(contextCard).toContainText('163.9K tokens');
  await expect(contextButton).toBeEnabled();
  await expect(page.locator('#claude-usage-panel')).toHaveCount(0);
  await expect(page.locator('.claude-context-size-badge')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-model-effort-and-usage.png'), fullPage: true });
});

test('Claude conversation settles tool state and keeps resume controls usable', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/sessions/test-claude/claude-resume-sessions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      items: [{
        id: '11111111-1111-4111-8111-111111111111',
        updatedAt: Date.now(),
        questions: ['Latest maintenance question', 'Previous architecture question']
      }]
    })
  }));
  await page.goto('/', { waitUntil: 'networkidle' });

  const scrollBefore = await page.evaluate(() => {
    const now = Date.now();
    activeSessionId = 'test-claude';
    activeToolKey = 'claude-code';
    claudeStatus = 'idle';
    claudeState = {
      ...claudeState,
      status: 'idle',
      pendingPermissionCount: 0,
      claudeSessionId: null,
      resumeSessionId: null
    };
    claudePendingPermissions = [];
    claudeResumeItemsLoaded = false;
    claudeMessages = [
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `history-${index}`,
        kind: 'assistant',
        text: `Historical Claude response ${index + 1}.\n\nThis creates enough content to verify stable reading position.`,
        createdAt: now - 50000 + index
      })),
      { id: 'user-timed', kind: 'user', text: 'Run the test suite', turnId: 'turn-timed', createdAt: now - 3000 },
      { id: 'tool-timed', kind: 'tool', name: 'Bash', toolUseId: 'tool-timed', turnId: 'turn-timed', input: { command: 'npm test' }, createdAt: now - 2500, startedAtMs: now - 2500 },
      { id: 'result-timed', kind: 'tool-result', toolUseId: 'tool-timed', turnId: 'turn-timed', text: '31 tests passed', createdAt: now - 500, completedAtMs: now - 500 },
      { id: 'turn-end-timed', kind: 'turn-end', turnId: 'turn-timed', turnStatus: 'completed', durationMs: 2500, createdAt: now - 400 },
      { id: 'assistant-timed', kind: 'assistant', text: 'All tests passed.', turnId: 'turn-timed', createdAt: now - 350 }
    ];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    commitClaudeChatRender();
    const tool = document.querySelector('[data-claude-key="tool-tool-timed"]');
    tool.open = true;
    const chat = document.getElementById('claude-chat-container');
    chat.scrollTop = Math.min(180, Math.max(0, chat.scrollHeight - chat.clientHeight - 100));
    const before = chat.scrollTop;
    claudeMessages.push({ id: 'late-event', kind: 'event', text: 'Late state update', createdAt: now });
    commitClaudeChatRender();
    return before;
  });

  const tool = page.locator('[data-claude-key="tool-tool-timed"]');
  await expect(tool).toHaveAttribute('open', '');
  await expect(tool.locator('.claude-tool-status')).not.toHaveText('running');
  await expect(tool.locator('.claude-tool-duration')).toHaveText('2s');
  await expect(page.locator('.claude-message-time')).toHaveCount(20);
  await expect.poll(() => page.locator('#claude-chat-container').evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);

  const controls = page.locator('.claude-control-page').first();
  await expectInsideViewport(controls, page);
  const resumeButton = page.getByTitle('Choose a Claude session to resume');
  const forkButton = page.getByTitle('Fork a Claude session');
  await expect(resumeButton).toBeEnabled();
  await expect(forkButton).toBeEnabled();
  await resumeButton.click();
  const resumePanel = page.locator('#claude-resume-panel');
  await expect(resumePanel.getByText('Latest maintenance question')).toBeVisible();
  await expect(resumePanel.getByText('Previous architecture question')).toBeVisible();
  await resumeButton.click();
  await forkButton.click();
  const forkPanel = page.locator('#claude-fork-panel');
  await expect(forkPanel.getByText('Latest maintenance question')).toBeVisible();
  await expect(forkPanel.getByText('Previous architecture question')).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-history-and-resume.png'), fullPage: true });
});

test('Claude supports edit diffs, image sends, and session forks', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/sessions/test-claude/attachments/images/chunks', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, complete: true, attachment: { id: 'image-claude-1', name: 'image.png', size: 12 } })
  }));
  await page.route('**/api/sessions/test-claude/attachments/files/chunks', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, complete: true, attachment: { id: 'file-claude-1', name: 'notes.txt', size: 18, kind: 'file' } })
  }));
  await page.route('**/api/sessions/test-claude/claude-resume-sessions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, items: [{
      id: '22222222-2222-4222-8222-222222222222',
      updatedAt: Date.now(),
      questions: ['Fork this Claude work', 'Original request']
    }] })
  }));
  await page.route('**/api/sessions/test-claude/claude-fork', async route => {
    const body = route.request().postDataJSON();
    expect(body.claudeSessionId).toBe('22222222-2222-4222-8222-222222222222');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, id: 'test-claude', claudeSessionId: '33333333-3333-4333-8333-333333333333' })
    });
  });
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    const now = Date.now();
    activeSessionId = 'test-claude';
    activeToolKey = 'claude-code';
    claudeStatus = 'idle';
    claudeState = { ...claudeState, status: 'idle', claudeSessionId: 'claude-source', resumeSessionId: 'claude-source' };
    claudeMessages = [
      { id: 'edit-tool', kind: 'tool', name: 'Edit', toolUseId: 'edit-1', turnId: 'edit-turn', input: { file_path: 'lib/example.js', old_string: 'const oldValue = 1;', new_string: 'const newValue = 2;' }, createdAt: now - 2000, startedAtMs: now - 2000 },
      { id: 'edit-result', kind: 'tool-result', toolUseId: 'edit-1', turnId: 'edit-turn', text: 'Updated lib/example.js', createdAt: now - 500, completedAtMs: now - 500 },
      { id: 'edit-end', kind: 'turn-end', turnId: 'edit-turn', turnStatus: 'completed', durationMs: 1500, createdAt: now - 500 }
    ];
    claudePendingPermissions = [];
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    commitClaudeChatRender();
    currentSocket = { readyState: 1, send: value => { window.__claudeSent = JSON.parse(value); } };
  });

  const editTool = page.locator('[data-claude-key="tool-edit-tool"]');
  await editTool.locator(':scope > summary').click();
  await expect(editTool.locator('.codex-diff-line.del')).toContainText('-const oldValue = 1;');
  await expect(editTool.locator('.codex-diff-line.add')).toContainText('+const newValue = 2;');

  await page.locator('#attachment-file-input').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  });
  await expect(page.locator('.attachment-chip')).toContainText('diagram.png');
  await page.locator('#cmd-input').fill('Describe this diagram');
  await page.locator('#send-btn').click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent)).toEqual({
    type: 'claude-input', text: 'Describe this diagram', attachmentIds: ['image-claude-1']
  });
  await expect(page.locator('#send-btn')).toBeDisabled();
  await page.evaluate(() => applyClaudeState({ status: 'thinking', canAbort: true }, { providerStateReceived: true }));
  await expect(page.locator('#send-btn')).toBeDisabled();
  await page.evaluate(() => applyClaudeState({ status: 'idle', canAbort: false }, { providerStateReceived: true }));
  await expect(page.locator('#send-btn')).toBeEnabled();

  await page.locator('#attachment-file-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Review these notes')
  });
  await expect(page.locator('.attachment-chip.file')).toContainText('notes.txt');
  await page.locator('#cmd-input').fill('Review the attachment');
  await page.locator('#send-btn').click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent)).toEqual({
    type: 'claude-input', text: 'Review the attachment', attachmentIds: [], fileAttachmentIds: ['file-claude-1']
  });
  await page.evaluate(() => applyClaudeState({ status: 'idle', canAbort: false }, { providerStateReceived: true }));

  await page.evaluate(() => toggleClaudeForkPanel());
  await expect(page.getByText('Fork this Claude work')).toBeVisible();
  await page.getByText('Fork this Claude work').click();
  await expect.poll(() => page.evaluate(() => claudeState.claudeSessionId)).toBe('33333333-3333-4333-8333-333333333333');
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-p2-features.png'), fullPage: true });
});
