const { test, expect } = require('@playwright/test');

const image = { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64') };
const file = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Read this attachment') };
const panel = (page, id) => page.locator(`.workspace-tab-panel[data-target-id="${id}"]`);
async function conversation(page, id) {
  const frame = await panel(page, id).locator('iframe').elementHandle();
  return frame.contentFrame();
}
async function session(page, name, toolKey = 'codex') {
  const response = await page.request.post('/api/sessions', { data: { name, toolKey } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function connect(page, item) {
  await page.evaluate(item => joinSession(item.id, item.name, item.toolKey || 'codex'), item);
  const view = await conversation(page, item.id);
  await expect(view.locator('#send-btn')).toBeEnabled();
  return view;
}
async function group(page, member) {
  const response = await page.request.post('/api/rooms', { data: { name: 'Review group' } });
  expect(response.ok()).toBe(true);
  const room = await response.json();
  if (member) expect((await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: member.id } })).ok()).toBe(true);
  return room;
}
async function connectGroup(page, room) {
  await page.evaluate(id => openRoom(id), room.id);
  const view = await conversation(page, room.id);
  await expect(view.locator('#room-title')).toContainText('Review group');
  await expect(view.locator('#room-send-button')).toBeEnabled();
  return view;
}
async function cleanup(page, sessions, rooms = []) {
  for (const room of rooms) await page.request.delete(`/api/rooms/${room.id}`);
  for (const item of sessions) await page.request.delete(`/api/sessions/${item.id}`);
}
async function snapshot(page, id) { return (await page.request.get(`/api/sessions/${id}`)).json(); }

test.beforeEach(async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop workspace');
});

test('Connect opens persistent tabs, deduplicates them, and collapses only the sidebar', async ({ page }) => {
  const first = await session(page, 'First conversation');
  const second = await session(page, 'Second conversation');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator(`.session-card[data-session-id="${first.id}"] .btn-join`).click();
    const a = await conversation(page, first.id);
    await expect(a.locator('#send-btn')).toBeEnabled();
    await a.locator('#cmd-input').fill('Draft A');
    await a.locator('#attachment-file-input').setInputFiles(file);
    await expect(a.locator('.attachment-chip:not(.uploading)')).toHaveCount(1);
    await a.evaluate(() => { window.originalSocket = currentSocket; window.originalInput = document.getElementById('cmd-input'); });
    await page.locator(`.session-card[data-session-id="${second.id}"] .btn-join`).click();
    const b = await conversation(page, second.id);
    await expect(b.locator('#send-btn')).toBeEnabled();
    await b.locator('#cmd-input').fill('Draft B');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab', { name: /First conversation/ }).click();
    await expect(a.locator('#cmd-input')).toHaveValue('Draft A');
    await expect(a.locator('.attachment-chip')).toContainText('notes.txt');
    expect(await a.evaluate(() => currentSocket === originalSocket && document.getElementById('cmd-input') === originalInput)).toBe(true);
    await page.locator(`.session-card[data-session-id="${first.id}"] .btn-join`).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.locator('#lobby-collapse-button').click();
    await expect(page.locator('#lobby-view')).toBeHidden();
    await expect(page.locator('#tile-workspace')).toBeHidden();
    await expect(a.locator('#cmd-input')).toHaveValue('Draft A');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.locator('#lobby-collapse-button').click();
    await expect(page.locator('#lobby-view')).toBeVisible();
    await page.getByRole('tab', { name: /Second conversation/ }).click();
    await expect(b.locator('#cmd-input')).toHaveValue('Draft B');
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('workspace-tabs.png') });
  } finally { await cleanup(page, [first, second]); }
});

test('ordinary messages accept more than five images and eight files', async ({ page }) => {
  const item = await session(page, 'Unlimited attachments');
  try {
    await page.goto('/'); const view = await connect(page, item);
    const images = Array.from({ length: 7 }, (_, i) => ({ ...image, name: `image-${i}.png` }));
    const files = Array.from({ length: 10 }, (_, i) => ({ ...file, name: `notes-${i}.txt` }));
    await view.locator('#attachment-file-input').setInputFiles([...images, ...files]);
    await expect(view.locator('.attachment-chip:not(.uploading)')).toHaveCount(17);
    await view.locator('#cmd-input').fill('Read all seventeen attachments');
    await view.locator('#send-btn').click();
    await expect(view.locator('#cmd-input')).toHaveValue('');
    const state = await snapshot(page, item.id);
    expect(state.messages.find(message => message.kind === 'user').attachments).toHaveLength(17);
  } finally { await cleanup(page, [item]); }
});

test('single and group tabs retain history anchors, expanded content, mentions and file drafts', async ({ page }) => {
  const item = await session(page, 'History conversation');
  const room = await group(page, item);
  try {
    await page.goto('/'); const a = await connect(page, item);
    for (let i = 0; i < 6; i++) {
      await a.locator('#cmd-input').fill(`Message ${i}: ` + 'A detailed paragraph for the reading-position regression. '.repeat(10));
      await a.locator('#send-btn').click();
      await expect(a.locator('#send-btn')).toBeEnabled();
      await expect(a.locator('.codex-message-block.user')).toHaveCount(i + 1);
      await a.waitForFunction(completed => codexState.status === 'idle'
        && codexMessages.filter(message => message.kind === 'turn-end').length >= completed, i + 1);
    }
    await a.locator('#codex-chat-container').evaluate(list => list.scrollTo({ top: 150, behavior: 'instant' }));
    const before = await a.locator('#codex-chat-container').evaluate(list => list.scrollTop);
    expect(before).toBeGreaterThan(0);
    const g = await connectGroup(page, room);
    await expect(page.locator('#lobby-view')).toBeVisible();
    await g.locator('#room-mention-button').click();
    await g.locator('.room-mention-option').click();
    await g.locator('.room-mention-picker-title button').click();
    await g.locator('#room-input').fill('Group draft');
    await g.locator('#room-file-input').setInputFiles(file);
    await page.getByRole('tab', { name: /History conversation/ }).click();
    await expect.poll(() => a.locator('#codex-chat-container').evaluate(list => list.scrollTop)).toBe(before);
    await page.locator('#lobby-collapse-button').click();
    await expect.poll(() => a.locator('#codex-chat-container').evaluate(list => list.scrollTop)).toBe(before);
    await page.locator('#lobby-collapse-button').click();
    await page.getByRole('tab', { name: /Review group/ }).click();
    await expect(g.locator('#room-input')).toHaveValue('Group draft');
    await expect(g.locator('#room-file-chips')).toContainText('notes.txt');
    await expect(g.locator('.room-context-chip.mention')).toHaveCount(1);
    await g.evaluate(() => openRoomSession(activeRoom.members[0].id));
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(panel(page, item.id)).toHaveClass(/selected/);
  } finally { await cleanup(page, [item], [room]); }
});

test('closing a running tab preserves execution and reconnect shows its completed result', async ({ page }) => {
  const item = await session(page, 'Background task');
  try {
    await page.goto('/'); const view = await connect(page, item);
    await view.locator('#cmd-input').fill('__GLAD_E2E_PLAN__');
    await view.locator('#send-btn').click();
    await expect(view.locator('#cmd-input')).toHaveValue('');
    expect((await snapshot(page, item.id)).status).toBe('running');
    await page.getByRole('button', { name: 'Close Background task tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.locator('#detail-empty')).toBeVisible();
    await expect.poll(async () => (await snapshot(page, item.id)).messages.some(message => message.kind === 'turn-end')).toBe(true);
    const reopened = await connect(page, item);
    await expect(reopened.locator('#codex-chat-container')).toContainText('Implementation and verification complete.');
  } finally { await cleanup(page, [item]); }
});

test('switching or closing a tab during queued uploads does not redirect or cancel the batch', async ({ page }) => {
  const first = await session(page, 'Uploading files'); const second = await session(page, 'Other session');
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { arrived = resolve; });
  try {
    await page.goto('/'); const a = await connect(page, first);
    await page.route(`**/api/sessions/${first.id}/attachments/files/chunks`, async route => {
      arrived(); await gate; await route.continue();
    });
    await a.locator('#attachment-file-input').setInputFiles(Array.from({ length: 10 }, (_, i) => ({ ...file, name: `queued-${i}.txt` })));
    await ready;
    const b = await connect(page, second);
    await page.getByRole('button', { name: 'Close Uploading files tab' }).click();
    expect(await a.evaluate(() => gladTabView.busy())).toBe(true);
    release();
    // Reopening while the transfer drains reuses the original mounted document.
    const reopened = await connect(page, first);
    expect(reopened).toBe(a);
    await expect(a.locator('.attachment-chip:not(.uploading)')).toHaveCount(10);
    expect(await b.evaluate(() => selectedFileAttachments.length)).toBe(0);
    const reopenedTab = page.getByRole('tab', { name: 'Uploading files' });
    await reopenedTab.focus(); await reopenedTab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Other session' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Other session' }).press('ArrowRight');
    await expect(reopenedTab).toHaveAttribute('aria-selected', 'true');
    await a.locator('#cmd-input').fill('Files belong to the first session');
    await a.locator('#send-btn').click();
    await expect(a.locator('#cmd-input')).toHaveValue('');
    expect((await snapshot(page, first.id)).messages.find(message => message.kind === 'user').attachments).toHaveLength(10);
    expect((await snapshot(page, second.id)).messages).toHaveLength(0);
  } finally { release(); await cleanup(page, [first, second]); }
});

test('group attachments exceed eight and continue dispatching after the tab closes', async ({ page }) => {
  const item = await session(page, 'Group receiver'); const room = await group(page, item);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  try {
    await page.goto('/'); const g = await connectGroup(page, room);
    await g.locator('#room-mention-button').click(); await g.locator('.room-mention-option').click();
    await g.locator('.room-mention-picker-title button').click();
    await g.locator('#room-file-input').setInputFiles(Array.from({ length: 10 }, (_, i) => ({ ...file, name: `group-${i}.txt` })));
    await expect(g.locator('#room-file-chips .file')).toHaveCount(10);
    await g.locator('#room-input').fill('Deliver ten files');
    await page.route(`**/api/sessions/${item.id}/attachments/files/chunks`, async route => { arrived(); await gate; await route.continue(); });
    await g.locator('#room-send-button').click(); await ready;
    await page.getByRole('button', { name: 'Close Review group tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    release();
    await expect.poll(async () => (await snapshot(page, item.id)).messages.find(message => message.kind === 'user')?.attachments?.length).toBe(10);
    await expect.poll(() => panel(page, room.id).count()).toBe(0);
  } finally { release(); await cleanup(page, [item], [room]); }
});

test('question replies accept more than five screenshots and retain answers across tab switches', async ({ page }) => {
  const item = await session(page, 'Question session'); const other = await session(page, 'Other question tab');
  try {
    await page.goto('/'); const view = await connect(page, item);
    await view.locator('#cmd-input').fill('__GLAD_E2E_ASYNC_QUESTION__'); await view.locator('#send-btn').click();
    const card = view.locator('#codex-chat-container .codex-question-card').last();
    await expect(card).toBeVisible();
    await card.locator('textarea').first().fill('1000'); await card.locator('textarea').nth(1).fill('2');
    await card.locator('input[type="file"]').setInputFiles(Array.from({ length: 7 }, (_, i) => ({ ...image, name: `answer-${i}.png` })));
    await expect(card.locator('.codex-question-image')).toHaveCount(7);
    await connect(page, other); await page.getByRole('tab', { name: /Question session/ }).click();
    await expect(card.locator('textarea').first()).toHaveValue('1000');
    await expect(card.locator('.codex-question-image')).toHaveCount(7);
    await card.getByRole('button', { name: 'Submit answer' }).click();
    await expect(card).toContainText('Answer sent');
  } finally { await cleanup(page, [item, other]); }
});

test('inactive tabs preserve unread completion and keyboard switching activates the existing view', async ({ page }) => {
  const first = await session(page, 'Unread task'); const second = await session(page, 'Active task');
  try {
    await page.goto('/'); const a = await connect(page, first);
    await a.locator('#cmd-input').fill('__GLAD_E2E_PLAN__'); await a.locator('#send-btn').click();
    await expect(a.locator('#cmd-input')).toHaveValue('');
    await connect(page, second);
    await expect.poll(async () => (await snapshot(page, first.id)).hasUnreadCompletion, { timeout: 10000 }).toBe(true);
    const tab = page.getByRole('tab', { name: /Active task/ }); await tab.focus(); await tab.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Unread task/ })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await snapshot(page, first.id)).hasUnreadCompletion).toBe(false);
  } finally { await cleanup(page, [first, second]); }
});

test('closing before send acknowledgement keeps the transport until acceptance', async ({ page }) => {
  const item = await session(page, 'Awaiting acknowledgement');
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { arrived = resolve; });
  try {
    await page.routeWebSocket(url => url.pathname === '/ws' && url.searchParams.get('sessionId') === item.id, ws => {
      const server = ws.connectToServer();
      server.onMessage(async message => {
        if (JSON.parse(String(message)).type === 'send-result') { arrived(); await gate; }
        ws.send(message);
      });
    });
    await page.goto('/'); const view = await connect(page, item);
    await view.locator('#cmd-input').fill('__GLAD_E2E_PLAN__'); await view.locator('#send-btn').click(); await ready;
    await page.getByRole('button', { name: 'Close Awaiting acknowledgement tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    expect(await view.evaluate(() => composerSendInFlight() && currentSocket.readyState === WebSocket.OPEN)).toBe(true);
    release();
    await expect.poll(() => panel(page, item.id).count()).toBe(0);
    await expect.poll(async () => (await snapshot(page, item.id)).messages.some(message => message.kind === 'turn-end')).toBe(true);
    expect((await snapshot(page, item.id)).messages.filter(message => message.kind === 'user')).toHaveLength(1);
  } finally { release(); await cleanup(page, [item]); }
});

test('group history keeps its expanded message and reading anchor while background messages arrive', async ({ page }) => {
  const item = await session(page, 'Group anchor peer'); const room = await group(page, item);
  const reading = view => view.locator('#room-message-list').evaluate(list => {
    const top = list.getBoundingClientRect().top;
    const entry = [...list.children].find(entry => entry.getBoundingClientRect().bottom > top);
    return { id: entry.dataset.roomEntryId, offset: Math.round(entry.getBoundingClientRect().top - top) };
  });
  try {
    for (let i = 0; i < 18; i++) expect((await page.request.post(`/api/rooms/${room.id}/messages`, { data: { text: `Group message ${i}. ` + 'Detailed group history paragraph. '.repeat(40) } })).ok()).toBe(true);
    await page.goto('/'); const view = await connectGroup(page, room);
    await expect(view.locator('.room-entry.user')).toHaveCount(18);
    await view.locator('.room-entry.user').nth(7).locator('.room-entry-bubble').click();
    await expect(view.locator('.room-entry.user').nth(7)).toHaveClass(/expanded/);
    await view.locator('#room-message-list').evaluate(list => list.scrollTo({ top: (list.scrollHeight - list.clientHeight) * .45, behavior: 'instant' }));
    const before = await reading(view);
    await connect(page, item);
    expect((await page.request.post(`/api/rooms/${room.id}/messages`, { data: { text: 'A new background group message' } })).ok()).toBe(true);
    await expect(view.locator('.room-entry.user')).toHaveCount(19);
    await page.getByRole('tab', { name: /Review group/ }).click();
    await expect.poll(() => reading(view)).toEqual(before);
    await expect(view.locator('.room-entry.user').nth(7)).toHaveClass(/expanded/);
    await page.screenshot({ path: test.info().outputPath('group-tabs.png') });
  } finally { await cleanup(page, [item], [room]); }
});

test('Codex, Claude and Antigravity tabs keep separate drafts and connections', async ({ page }) => {
  const items = [];
  try {
    for (const toolKey of ['codex', 'claude-code', 'antigravity']) items.push({ ...await session(page, `Provider ${toolKey}`, toolKey), toolKey });
    await page.goto('/'); const views = [];
    for (const item of items) {
      const view = await connect(page, item); views.push(view);
      await view.locator('#cmd-input').fill(`Draft for ${item.toolKey}`);
      await view.evaluate(() => { window.originalSocket = currentSocket; });
    }
    for (let i = 0; i < items.length; i++) {
      await page.getByRole('tab', { name: `Provider ${items[i].toolKey}` }).click();
      await expect(views[i].locator('#cmd-input')).toHaveValue(`Draft for ${items[i].toolKey}`);
      expect(await views[i].evaluate(() => currentSocket === originalSocket && currentSocket.readyState === WebSocket.OPEN)).toBe(true);
    }
    await page.getByRole('button', { name: 'Close Provider claude-code tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'Provider antigravity' })).toHaveAttribute('aria-selected', 'true');
  } finally { await cleanup(page, items); }
});

test('multiple group tabs preserve their independent drafts and pending local files', async ({ page }) => {
  const first = await group(page); const second = await group(page);
  try {
    expect((await page.request.patch(`/api/rooms/${second.id}`, { data: { name: 'Another group' } })).ok()).toBe(true);
    await page.goto('/'); const a = await connectGroup(page, first);
    await a.locator('#room-input').fill('Draft for group A');
    await a.locator('#room-file-input').setInputFiles(Array.from({ length: 10 }, (_, i) => ({ ...file, name: `local-${i}.txt` })));
    await page.evaluate(id => openRoom(id), second.id);
    const b = await conversation(page, second.id);
    await expect(b.locator('#room-title')).toContainText('Another group');
    await b.locator('#room-input').fill('Draft for group B');
    await page.getByRole('tab', { name: /Review group/ }).click();
    await expect(a.locator('#room-input')).toHaveValue('Draft for group A');
    await expect(a.locator('#room-file-chips .file')).toHaveCount(10);
    await page.getByRole('tab', { name: /Another group/ }).click();
    await expect(b.locator('#room-input')).toHaveValue('Draft for group B');
    await expect(b.locator('#room-file-chips .file')).toHaveCount(0);
  } finally { await cleanup(page, [], [first, second]); }
});

test('group attention opens the member approval in its session tab', async ({ page }) => {
  const item = await session(page, 'Approval member'); const room = await group(page, item);
  try {
    await page.goto('/'); const view = await connectGroup(page, room);
    await view.locator('#room-mention-button').click(); await view.locator('.room-mention-option').click();
    await view.locator('.room-mention-picker-title button').click();
    await view.locator('#room-input').fill('__GLAD_E2E_APPROVAL__ group permission');
    await view.locator('#room-send-button').click();
    await expect.poll(async () => (await snapshot(page, item.id)).status).toBe('waiting_approval');
    await view.evaluate(() => openRoomAttention(activeRoom.members[0].id));
    const memberView = await conversation(page, item.id);
    await expect(panel(page, item.id)).toHaveClass(/selected/);
    const approval = memberView.locator('#codex-chat-container [data-codex-permission-id]');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect.poll(async () => (await snapshot(page, item.id)).status).toBe('idle');
    await page.getByRole('tab', { name: /Review group/ }).click();
    await expect(view.locator('#room-title')).toContainText('Review group');
  } finally { await cleanup(page, [item], [room]); }
});

test('keyboard navigation reveals the whole active tab including its close button after horizontal scrolling', async ({ page }) => {
  const items = [];
  try {
    await page.setViewportSize({ width: 1024, height: 900 });
    for (let i = 0; i < 4; i++) items.push(await session(page, `Conversation ${i} with a long descriptive title`));
    await page.goto('/');
    for (const item of items) await connect(page, item);
    const list = page.locator('#workspace-tab-list');
    expect(await list.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await list.evaluate(element => { element.scrollLeft = 0; });
    const first = page.getByRole('tab').first();
    await first.focus(); await first.press('End');
    const last = page.getByRole('tab').last();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => last.evaluate(button => {
      const item = button.parentElement.getBoundingClientRect();
      const list = document.getElementById('workspace-tab-list').getBoundingClientRect();
      return item.left >= list.left - 1 && item.right <= list.right + 1;
    })).toBe(true);
  } finally { await cleanup(page, items); }
});

test('installed iOS desktop tabs reserve the system top edge only in the host page', async ({ page }) => {
  const item = await session(page, 'PWA conversation');
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    });
    await page.goto('/'); const view = await connect(page, item);
    await expect(page.locator('html')).toHaveClass(/ios-standalone/);
    await expect(page.locator('#pwa-top-edge')).toBeVisible();
    await expect(view.locator('html')).not.toHaveClass(/ios-standalone/);
    await expect(view.locator('#pwa-top-edge')).toBeHidden();
    await expect(view.locator('#app-shell')).toHaveCSS('padding-top', '0px');
    expect(await view.locator('#nav-bar').evaluate(element => element.getBoundingClientRect().top)).toBe(0);
  } finally { await cleanup(page, [item]); }
});
