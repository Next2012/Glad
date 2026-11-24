const { test, expect } = require('@playwright/test');
const { conversationView } = require('./helpers/conversation');
const file = { name: 'draft-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('A private draft attachment') };
async function create(page, name) {
  const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name } });
  expect(response.ok()).toBe(true); return response.json();
}
async function connect(page, item) {
  await page.evaluate(item => joinSession(item.id, item.name, 'codex'), item);
  const view = await conversationView(page); await expect(view.locator('#send-btn')).toBeEnabled(); return view;
}
async function back(page) { await page.locator('#back-btn').click(); }
async function cleanup(page, items) { for (const item of items) await page.request.delete(`/api/sessions/${item.id}`); }

test('mobile drafts and uploading attachments stay with their original conversation', async ({ page }) => {
  test.skip(page.viewportSize().width >= 920, 'Mobile main-document navigation');
  const a = await create(page, 'Owner A'), b = await create(page, 'Owner B');
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  const pattern = `**/api/sessions/${a.id}/attachments/files/chunks`;
  await page.route(pattern, async route => { arrived(); await gate; await route.continue(); });
  try {
    await page.goto('/'); await connect(page, a); await page.locator('#cmd-input').fill('Draft A');
    await page.locator('#attachment-file-input').setInputFiles(file); await ready;
    await back(page); await connect(page, b);
    await expect(page.locator('#cmd-input')).toHaveValue(''); await expect(page.locator('.attachment-chip')).toHaveCount(0);
    await page.locator('#cmd-input').fill('Draft B'); release();
    await back(page); await connect(page, a);
    await expect(page.locator('#cmd-input')).toHaveValue('Draft A');
    await expect(page.locator('.attachment-chip:not(.uploading)')).toHaveCount(1);
    await back(page); await connect(page, b); await expect(page.locator('#cmd-input')).toHaveValue('Draft B');
    await expect(page.locator('.attachment-chip')).toHaveCount(0);
  } finally { release(); await page.unroute(pattern); await cleanup(page, [a, b]); }
});

test('group drafts survive returning and a late error cannot overwrite a different group', async ({ page }) => {
  test.skip(page.viewportSize().width >= 920, 'Mobile main-document navigation');
  const rooms = [];
  for (const name of ['Draft group A', 'Draft group B']) { const response = await page.request.post('/api/rooms', { data: { name } }); rooms.push(await response.json()); }
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  try {
    await page.goto('/');
    for (const [index, room] of rooms.entries()) {
      await page.evaluate(id => openRoom(id), room.id); await expect(page.locator('#room-send-button')).toBeEnabled();
      await page.locator('#room-input').fill(`Group draft ${index}`); await page.locator('.room-back-button').click();
    }
    await page.evaluate(id => openRoom(id), rooms[0].id); await expect(page.locator('#room-input')).toHaveValue('Group draft 0');
    await page.locator('.room-back-button').click();
    const pattern = `**/api/rooms/${rooms[0].id}`;
    await page.route(pattern, async route => { arrived(); await gate; await route.fulfill({ status: 500, json: { error: 'Old group error' } }); });
    await page.evaluate(id => { void openRoom(id); }, rooms[0].id); await ready;
    await page.evaluate(id => openRoom(id), rooms[1].id); await expect(page.locator('#room-title')).toContainText('Draft group B');
    release(); await expect(page.locator('#room-input')).toHaveValue('Group draft 1');
    await expect(page.locator('#room-message-list')).not.toContainText('Old group error');
    await page.unroute(pattern);
  } finally { release(); for (const room of rooms) await page.request.delete(`/api/rooms/${room.id}`); }
});

test('crossing desktop and mobile widths reuses the mounted conversation and its draft', async ({ page }) => {
  const item = await create(page, 'Responsive owner');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 440, height: 956 }); await page.goto('/'); await connect(page, item);
    await page.locator('#cmd-input').fill('Draft across window sizes');
    await page.locator('#attachment-file-input').setInputFiles(file); await expect(page.locator('.attachment-chip:not(.uploading)')).toHaveCount(1);
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator('#desktop-workspace')).toHaveClass(/active/);
    const frame = await (await page.locator('.workspace-tab-panel.selected iframe').elementHandle()).contentFrame();
    await expect(frame.locator('#send-btn')).toBeEnabled();
    await expect(frame.locator('#cmd-input')).toHaveValue('Draft across window sizes'); await expect(frame.locator('.attachment-chip')).toHaveCount(1);
    await frame.evaluate(() => { window.retainedSocket = currentSocket; });
    await page.setViewportSize({ width: 440, height: 956 });
    await expect(frame.locator('#cmd-input')).toBeVisible(); await expect(page.locator('#workspace-mobile-back')).toBeVisible();
    await page.locator('#workspace-mobile-back').click(); await connect(page, item);
    expect(await frame.evaluate(() => currentSocket === window.retainedSocket)).toBe(true);
    expect(await page.evaluate(() => currentSocket === null && activeSessionId === null)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(frame.locator('#cmd-input')).toHaveValue('Draft across window sizes');
    expect(errors).toEqual([]);
  } finally { await cleanup(page, [item]); }
});

test('History keeps completions unread and background views flush their model only when selected', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tabs');
  const a = await create(page, 'Unread owner'), b = await create(page, 'Background owner');
  try {
    await page.goto('/'); await connect(page, a);
    const frame = await (await page.locator('.workspace-tab-panel.selected iframe').elementHandle()).contentFrame();
    await frame.locator('#cmd-input').fill('__GLAD_E2E_PLAN__'); await frame.locator('#send-btn').click();
    await expect(frame.locator('#cmd-input')).toHaveValue(''); await frame.locator('#nav-bar').getByTitle('History').click();
    expect(await frame.evaluate(() => isSessionCompletionVisible(activeSessionId))).toBe(false);
    await expect.poll(async () => (await (await page.request.get(`/api/sessions/${a.id}`)).json()).hasUnreadCompletion).toBe(true);
    await frame.evaluate(() => showTerminal());
    await expect.poll(async () => (await (await page.request.get(`/api/sessions/${a.id}`)).json()).hasUnreadCompletion).toBe(false);
    await connect(page, b);
    await frame.evaluate(() => applyCodexEvent({ type: 'message', message: { id: 'background-test', kind: 'assistant', text: 'Deferred background update', turnId: 'background-turn' } }));
    expect(await frame.evaluate(() => codexMessages.some(item => item.id === 'background-test'))).toBe(true);
    await expect(frame.locator('#codex-chat-container')).not.toContainText('Deferred background update');
    await connect(page, a); await expect(frame.locator('#codex-chat-container')).toContainText('Deferred background update');
  } finally { await cleanup(page, [a, b]); }
});

test('many attachments keep readable labels and contained remove buttons in both themes', async ({ page }, testInfo) => {
  const item = await create(page, 'Attachment layout');
  try {
    await page.goto('/'); const view = await connect(page, item);
    await view.locator('#attachment-file-input').setInputFiles(Array.from({ length: 17 }, (_, index) => ({ ...file, name: `review-notes-${index}.txt` })));
    await expect(view.locator('.attachment-chip:not(.uploading)')).toHaveCount(17);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { localStorage.setItem('glad-theme', theme); document.documentElement.dataset.theme = theme; }, theme);
      await view.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const geometry = await view.locator('#attachment-strip').evaluate(strip => ({
        overflowsPage: strip.getBoundingClientRect().right > innerWidth,
        chips: [...strip.children].map(chip => ({ label: chip.querySelector('.attachment-chip-name').clientWidth, contained: chip.querySelector('button').getBoundingClientRect().right <= chip.getBoundingClientRect().right + 1 }))
      }));
      expect(geometry.overflowsPage).toBe(false); expect(geometry.chips.every(item => item.label >= 48 && item.contained)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`workspace-${theme}.png`), fullPage: true });
    }
  } finally { await cleanup(page, [item]); }
});

test('closing and reopening during delayed attachment cleanup disconnects the retired view immediately', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tab disposal');
  const item = await create(page, 'Retirement owner');
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  const pattern = `**/api/sessions/${item.id}/attachments/files/*`;
  try {
    await page.goto('/'); const view = await connect(page, item);
    await view.locator('#attachment-file-input').setInputFiles(file); await expect(view.locator('.attachment-chip:not(.uploading)')).toHaveCount(1);
    await page.route(pattern, async route => { if (route.request().method() !== 'DELETE') return route.continue(); arrived(); await gate; await route.continue(); });
    await page.locator('.workspace-tab-close').click(); await ready;
    await connect(page, item);
    await expect.poll(async () => (await (await page.request.get(`/api/sessions/${item.id}/debug`)).json()).diagnostics.clients).toBe(1);
    await expect(page.getByRole('tab')).toHaveCount(1); release();
    await expect(page.locator('.workspace-tab-panel')).toHaveCount(1);
  } finally { release(); await page.unroute(pattern); await cleanup(page, [item]); }
});

test('a mobile background upload refreshes after its draft is handed to a desktop tab', async ({ page }) => {
  const a = await create(page, 'Upload handoff A'), b = await create(page, 'Upload handoff B');
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  const pattern = `**/api/sessions/${a.id}/attachments/files/chunks`;
  await page.route(pattern, async route => { arrived(); await gate; await route.continue(); });
  try {
    await page.setViewportSize({ width: 440, height: 956 }); await page.goto('/'); await connect(page, a);
    await page.locator('#attachment-file-input').setInputFiles(file); await ready;
    await back(page); await connect(page, b); await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator('#desktop-workspace')).toHaveClass(/active/);
    const view = await connect(page, a); await expect(view.locator('.attachment-chip.uploading')).toHaveCount(1);
    release(); await expect(view.locator('.attachment-chip:not(.uploading)')).toHaveCount(1);
    await expect(view.locator('#send-btn')).toBeEnabled();
  } finally { release(); await page.unroute(pattern); await cleanup(page, [a, b]); }
});

test('migrating a group member view clears its mobile return route', async ({ page }) => {
  const a = await create(page, 'Member migration'), b = await create(page, 'Ordinary conversation');
  const response = await page.request.post('/api/rooms', { data: { name: 'Member migration group' } }); const room = await response.json();
  await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: a.id } });
  try {
    await page.setViewportSize({ width: 440, height: 956 }); await page.goto('/'); await page.evaluate(id => openRoom(id), room.id);
    await expect(page.locator('#room-title')).toContainText('Member migration group');
    await page.evaluate(() => openRoomSession(activeRoom.members[0].id)); await expect(page.locator('#send-btn')).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 960 }); await expect(page.locator('#desktop-workspace')).toHaveClass(/active/);
    expect(await page.evaluate(() => window.gladRoomSessionReturn)).toBeNull();
    await page.setViewportSize({ width: 440, height: 956 }); await page.locator('#workspace-mobile-back').click(); await connect(page, b);
    await expect(page.locator('body')).not.toHaveClass(/room-session-open/); await back(page);
    await expect(page.locator('#lobby-view')).toBeVisible();
  } finally { await page.request.delete(`/api/rooms/${room.id}`); await cleanup(page, [a, b]); }
});
