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

test('approval bubble expands and jumps to its pending request', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(() => {
    activeToolKey = 'codex';
    codexState = {
      ...codexState,
      status: 'waiting_approval',
      presentation: 'structured',
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
    commitCodexChatRender();
    renderCodexStateBar();
    const chat = document.getElementById('codex-chat-container');
    chat.scrollTop = chat.scrollHeight;
  });

  const target = page.locator('[data-codex-permission-id="approval-command-1"]');
  await expect(target).toHaveCount(1);
  await expect(target).not.toBeVisible();
  await page.getByRole('button', { name: 'Jump to pending approval' }).click();

  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/codex-approval-focus/);
  await expect.poll(() => target.evaluate(element => {
    const parents = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parents.push(parent.open);
    }
    return parents.length > 0 && parents.every(Boolean);
  })).toBe(true);
  await expect(target).toBeInViewport();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('approval-jump.png'), fullPage: true });
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
      presentation: 'structured',
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
  await page.getByRole('button', { name: 'Jump to pending Claude approval' }).click();

  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/claude-approval-focus/);
  await expect(target).toBeInViewport();
  await expect(target.getByRole('button', { name: 'Allow command' })).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-approval-jump.png'), fullPage: true });
});

test('Claude shows one Working bubble and keeps primary controls on the first page', async ({ page }, testInfo) => {
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
      indicatorPosition: indicator ? getComputedStyle(indicator).position : ''
    };
  });

  expect(layout.first).toEqual([
    'claude-model-picker-btn', 'claude-usage-btn', 'claude-context-btn', 'claude-abort-btn',
    'claude-resume-btn', 'claude-fork-btn'
  ]);
  expect(layout.second).toEqual(['claude-permission-picker-btn']);
  expect(layout.stateText).not.toContain('Working');
  expect(layout.indicatorPosition).toBe('sticky');
  await expect(page.getByRole('status', { name: 'Claude is working' })).toBeVisible();
  await expect(page.locator('.claude-working-indicator')).toHaveCount(1);
  await expect(page.getByText('Claude is working...', { exact: true })).toHaveCount(0);
  await expect(page.locator('.claude-status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Usage' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Context' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('claude-primary-controls.png'), fullPage: true });
  await page.locator('.claude-control-rail').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(page.getByRole('button', { name: 'Permission' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('claude-secondary-controls.png'), fullPage: true });
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

  await page.locator('#image-file-input').setInputFiles({
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

  await page.evaluate(() => toggleClaudeForkPanel());
  await expect(page.getByText('Fork this Claude work')).toBeVisible();
  await page.getByText('Fork this Claude work').click();
  await expect.poll(() => page.evaluate(() => claudeState.claudeSessionId)).toBe('33333333-3333-4333-8333-333333333333');
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('claude-p2-features.png'), fullPage: true });
});
