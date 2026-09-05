const { test, expect } = require('@playwright/test');

async function titleSession(page, name) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', ...(name ? { name } : {}) } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await page.waitForFunction(() => currentSocket?.readyState === WebSocket.OPEN && activeSessionHydrated);
  return id;
}

test('Codex automatically titles unnamed windows and persists titles without leaking hidden turns', async ({ page }) => {
  const id = await titleSession(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.locator('#cmd-input').fill('检查项目为什么构建失败');
    await page.locator('#send-btn').click();
    await expect(page.locator('#session-title')).toHaveText('修复项目构建');
    const listing = await (await page.request.get(`/api/sessions/${id}/codex-resume-threads`)).json();
    expect(listing.items.find(item => item.id === 'thread-e2e').title).toBe('修复项目构建');
    expect(listing.items.some(item => item.id.startsWith('hidden-title'))).toBe(false);
    const history = await (await page.request.get(`/api/sessions/${id}/history`)).json();
    expect(history.text).not.toContain('Generate a concise');
    expect(history.text).not.toContain('修复项目构建');
    await expect.poll(() => page.evaluate(() => codexState.status)).toBe('idle');
    await expect.poll(() => page.evaluate(() => codexState.threadId)).toBe('thread-e2e');
    // Reconnect also gets the saved name from the initial snapshot.
    await page.evaluate(() => showLobby());
    await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('#session-title')).toHaveText('修复项目构建');
    if (page.viewportSize().width >= 920) {
      await page.evaluate(() => showLobby());
      await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
      const tile = page.locator(`.tile-session-window[data-session-id="${id}"]`);
      await expect(tile.locator('.tile-session-title-row strong')).toHaveText('修复项目构建');
      await page.request.patch(`/api/sessions/${id}`, { data: { name: '手动标题' } });
      await expect(tile.locator('.tile-session-title-row strong')).toHaveText('手动标题');
    }
    expect(errors).toEqual([]);
  } finally { await page.request.delete(`/api/sessions/${id}`); }
});

test('Codex manual naming wins during generation and title errors leave the chat usable', async ({ page }) => {
  const id = await titleSession(page);
  try {
    await page.locator('#cmd-input').fill('__GLAD_E2E_TITLE_SLOW__ 检查构建');
    await page.locator('#send-btn').click();
    await expect(page.locator('#session-title')).toContainText('__GLAD_E2E_TITLE_SLOW__');
    await page.waitForTimeout(350);
    await expect.poll(() => page.evaluate(() => codexState.status)).toBe('idle');
    await page.request.patch(`/api/sessions/${id}`, { data: { name: '用户指定名称' } });
    await page.waitForTimeout(1600);
    await expect(page.locator('#session-title')).toHaveText('用户指定名称');
    const listing = await (await page.request.get(`/api/sessions/${id}/codex-resume-threads`)).json();
    expect(listing.items.find(item => item.id === 'thread-e2e').title).toBe('用户指定名称');
  } finally { await page.request.delete(`/api/sessions/${id}`); }

  const failedId = await titleSession(page);
  try {
    await page.locator('#cmd-input').fill('__GLAD_E2E_TITLE_FAIL__ build');
    await page.locator('#send-btn').click();
    await expect(page.locator('#session-title')).toHaveText('__GLAD_E2E_TITLE_FAIL__ build');
    await page.waitForTimeout(350);
    await expect.poll(() => page.evaluate(() => codexState.status)).toBe('idle');
    await page.locator('#cmd-input').fill('继续');
    await expect(page.locator('#send-btn')).toBeEnabled();
  } finally { await page.request.delete(`/api/sessions/${failedId}`); }
});

test('Codex resume and fork fill unnamed history titles while respecting custom window names', async ({ page }) => {
  const id = await titleSession(page);
  try {
    await page.evaluate(() => selectCodexResumeThread('untitled-history-e2e'));
    await expect(page.locator('#session-title')).toHaveText('修复项目构建');
    const listing = await (await page.request.get(`/api/sessions/${id}/codex-resume-threads`)).json();
    expect(listing.items.find(item => item.id === 'untitled-history-e2e').title).toBe('修复项目构建');
  } finally { await page.request.delete(`/api/sessions/${id}`); }

  const forkId = await titleSession(page);
  try {
    await page.evaluate(() => selectCodexForkThread('untitled-history-e2e'));
    await expect(page.locator('#session-title')).toHaveText('修复项目构建');
    const listing = await (await page.request.get(`/api/sessions/${forkId}/codex-resume-threads`)).json();
    expect(listing.items.find(item => item.id === 'fork-of-untitled-history-e2e').title).toBe('修复项目构建');
    expect(listing.items.find(item => item.id === 'untitled-history-e2e')).toBeUndefined();
  } finally { await page.request.delete(`/api/sessions/${forkId}`); }

  const manualId = await titleSession(page, '我的工作窗口');
  try {
    await page.locator('#cmd-input').fill('检查构建');
    await page.locator('#send-btn').click();
    await expect.poll(async () => {
      const listing = await (await page.request.get(`/api/sessions/${manualId}/codex-resume-threads`)).json();
      return listing.items.find(item => item.id === 'thread-e2e')?.title;
    }).toBe('我的工作窗口');
    await expect(page.locator('#session-title')).toHaveText('我的工作窗口');
  } finally { await page.request.delete(`/api/sessions/${manualId}`); }
});
