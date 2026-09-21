const { test, expect } = require('@playwright/test');

async function openClaudeHarness(page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    activeSessionId = 'claude-parity';
    activeToolKey = 'claude-code';
    claudeMessages = [];
    claudePendingPermissions = [];
    claudeStatus = 'idle';
    claudeState = {
      ...claudeState,
      status: 'idle', model: 'haiku', effort: 'low', canCompact: true,
      commands: [
        { name: 'review', description: 'Review changes', type: 'command' },
        { name: 'project-skill', description: 'Project workflow', type: 'skill' }
      ]
    };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(true);
    applyClaudeState(claudeState);
    window.__claudeSent = [];
    currentSocket = { readyState: WebSocket.OPEN, send: value => window.__claudeSent.push(JSON.parse(value)) };
    handleComposerSocketOpen();
  });
}

test('Claude and Codex use one continuous action rail without legacy pages', async ({ page }) => {
  await openClaudeHarness(page);
  await expect(page.locator('.claude-control-page, .codex-control-page')).toHaveCount(0);
  const claudeIds = [
    'claude-model-picker-btn', 'claude-status-btn', 'claude-abort-btn', 'claude-resume-btn', 'claude-fork-btn',
    'claude-prompts-btn', 'claude-compact-btn', 'claude-permission-picker-btn', 'claude-skills-btn', 'claude-commands-btn'
  ];
  const claudeGeometry = await page.evaluate(ids => ids.map(id => {
    const box = document.getElementById(id).getBoundingClientRect();
    return { id, top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
  }), claudeIds);
  expect(new Set(claudeGeometry.map(item => item.top)).size).toBe(1);
  expect(new Set(claudeGeometry.map(item => item.width))).toEqual(new Set([40]));
  expect(new Set(claudeGeometry.map(item => item.height))).toEqual(new Set([40]));
  await expect(page.locator('#claude-usage-btn, #claude-context-btn')).toHaveCount(0);
  await page.evaluate(() => applyClaudeState({ permissionMode: 'plan' }));
  const modePill = page.locator('#session-attention-rail > .session-attention-pill.mode:first-child');
  await expect(modePill).toHaveText('Plan mode');
  await expect(page.locator('#claude-state-bar')).not.toContainText('Plan mode');

  await page.evaluate(() => {
    activeToolKey = 'codex';
    setClaudeModeEnabled(false);
    applyCodexState({ status: 'idle', canCompact: true, models: [] });
  });
  await expect(page.locator('#codex-control-rail > .agent-control-group')).toHaveCount(2);
  const codexTops = await page.locator('#codex-control-rail .agent-control-group > *').evaluateAll(elements =>
    elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(new Set(codexTops).size).toBe(1);
});

test('Claude renders structured questions, tasks, subagents and status cards', async ({ page }) => {
  await openClaudeHarness(page);
  await page.evaluate(() => {
    const now = Date.now();
    claudeMessages = [
      { id: 'question-1', kind: 'question', questionStatus: 'pending', createdAt: now, questions: [{
        header: 'Database', question: 'Which database?', multiSelect: false,
        options: [{ label: 'SQLite', description: 'Local' }, { label: 'Postgres', description: 'Server' }]
      }] },
      { id: 'plan-1', kind: 'task-plan', planTurnStatus: 'running', createdAt: now, plan: [
        { id: '1', step: 'Inspect code', status: 'completed' },
        { id: '2', step: 'Implement change', activeForm: 'Implementing change', status: 'inProgress' }
      ] },
      { id: 'agent-tool', kind: 'tool', name: 'Agent', toolUseId: 'agent-1', input: { description: 'Review architecture', subagent_type: 'reviewer' }, createdAt: now },
      { id: 'bash-tool', kind: 'tool', name: 'Bash', toolUseId: 'bash-1', input: { command: 'git status' }, createdAt: now },
      { id: 'agent-message', kind: 'assistant', parentToolUseId: 'agent-1', text: 'Reviewing modules.', createdAt: now },
      { id: 'bash-result', kind: 'tool-result', toolUseId: 'bash-1', text: 'clean', createdAt: now, completedAtMs: now },
      { id: 'assistant-final', kind: 'assistant', turnId: 'turn-1', text: 'Done.', createdAt: now },
      { id: 'turn-end', kind: 'turn-end', turnId: 'turn-1', turnStatus: 'completed', createdAt: now,
        context: { contextWindow: 200000, remainingTokens: 198800, remainingPercent: 99 } }
    ];
    claudePendingPermissions = [{
      id: 'permission-1', status: 'pending', toolUseId: 'bash-1', toolName: 'Bash', title: 'Run tests',
      input: { command: 'go test ./...' }, suggestions: [{ type: 'addRules', destination: 'session' }]
    }];
    commitClaudeChatRender();
  });

  await expect(page.locator('.claude-question-card')).toContainText('Which database?');
  await page.getByRole('button', { name: /SQLite/ }).click();
  await page.locator('.claude-question-card').getByRole('button', { name: 'Submit answer' }).click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent.find(item => item.type === 'claude-user-input')))
    .toMatchObject({ type: 'claude-user-input', id: 'question-1', answers: { 'Which database?': 'SQLite' } });

  await expect(page.locator('.agent-task-card')).toContainText('1/2');
  await expect(page.locator('.codex-subagent-group')).toContainText('Subagent working');
  await expect(page.locator('.claude-work-group-compact')).toHaveCount(1);
  await expect(page.locator('.codex-context-meter')).toContainText('199K / 200K');
  await expect(page.locator('#session-attention-rail')).toContainText('awaiting answer');
  await expect(page.locator('#session-attention-rail')).toContainText('agent running');

  await page.evaluate(() => applyClaudeEvent({ type: 'message', message: {
    id: 'status-1', kind: 'status', title: 'Claude status', usage: { totalCostUsd: 0.01, inputTokens: 100, outputTokens: 20,
      rateLimits: [{ kind: 'session', usedPercent: 3, resetsAt: '2026-09-21T05:20:00Z' }] },
    context: { model: 'haiku', usedTokens: 1200, maxTokens: 200000, usedPercent: 1, remainingTokens: 198800 }
  } }));
  await expect(page.locator('.claude-status-card')).toContainText('haiku');
  await expect(page.locator('.claude-status-card')).toContainText('198.8K tokens');
  await expect(page.locator('.claude-status-card')).toContainText('97% left');

  await page.getByRole('button', { name: 'Jump to pending Claude approval' }).click();
  await page.locator('[data-claude-permission-id="permission-1"]').getByRole('button', { name: 'Allow & remember' }).click();
  await expect.poll(() => page.evaluate(() => window.__claudeSent.find(item => item.type === 'claude-permission')))
    .toMatchObject({ type: 'claude-permission', id: 'permission-1', action: 'allow-remember', approved: true });
});

test('Claude action panels expose prompts, skills and commands', async ({ page }) => {
  await openClaudeHarness(page);
  await page.evaluate(() => {
    claudeMessages = [{ id: 'user-1', kind: 'user', text: 'Inspect the auth flow', createdAt: Date.now() }];
    applyClaudeState(claudeState);
  });
  await page.locator('#claude-prompts-btn').click();
  await expect(page.locator('#claude-prompt-panel')).toContainText('Inspect the auth flow');
  await page.locator('#claude-prompts-btn').click();

  await page.locator('#claude-skills-btn').click();
  await expect(page.locator('#claude-skill-panel')).toContainText('/project-skill');
  await page.locator('#claude-skill-panel').getByText('/project-skill').click();
  await expect(page.locator('#composer-skill-prefix')).toContainText('project-skill');

  await page.locator('#claude-commands-btn').click();
  await expect(page.locator('#claude-command-panel')).toContainText('/review');
});

test('Claude history supports sorting, pagination and preview before switching', async ({ page }) => {
  await page.route('**/api/sessions/claude-parity/claude-resume-sessions*', async route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      success: true,
      items: offset ? [{ id: '22222222-2222-4222-8222-222222222222', createdAt: 1000, updatedAt: 2000, questions: ['Older session'] }]
        : [{ id: '11111111-1111-4111-8111-111111111111', createdAt: 3000, updatedAt: 4000, questions: ['Recent session', 'Earlier prompt'] }],
      nextOffset: offset ? -1 : 20,
      hasMore: !offset
    }) });
  });
  await page.route('**/api/sessions/claude-parity/claude-session-preview*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, messages: [{ kind: 'user', text: 'Preview request' }, { kind: 'assistant', text: 'Preview response' }] })
  }));
  await openClaudeHarness(page);
  await page.locator('#claude-resume-btn').click();
  const panel = page.locator('#claude-resume-panel');
  await expect(panel.getByText('Recent session')).toBeVisible();
  await expect(panel.getByText('Earlier prompt')).toBeVisible();
  await panel.getByRole('button', { name: /Recent session/ }).click();
  await expect(panel).toContainText('Preview request');
  await panel.getByRole('button', { name: 'Load more' }).click();
  await expect(panel.getByText('Older session')).toBeVisible();
  await panel.getByLabel('Claude history sort').selectOption('created_at');
  await expect(panel.getByText('Recent session')).toBeVisible();
});
