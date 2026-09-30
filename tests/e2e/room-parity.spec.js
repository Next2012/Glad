const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function createGroup(page, count = 1, options = {}) {
  const sessions = [];
  const response = await page.request.post('/api/rooms', { data: { name: options.name || 'Group parity' } });
  expect(response.ok()).toBe(true);
  const room = await response.json();
  for (let i = 0; i < count; i++) {
    const response = await page.request.post('/api/sessions', { data: {
      toolKey: 'codex', name: `Member ${i + 1}`, ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {})
    } });
    expect(response.ok()).toBe(true);
    const session = await response.json();
    sessions.push(session.id);
    expect((await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } })).ok()).toBe(true);
  }
  return { room, sessions, async cleanup() {
    await page.request.delete(`/api/rooms/${room.id}`);
    for (const id of sessions) await page.request.delete(`/api/sessions/${id}`);
  } };
}

async function connectGroup(page, id) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${id}"] .btn-join`).click();
  await expect(page.locator('#room-send-button')).toBeEnabled();
}

async function mentionMembers(page, count) {
  await page.locator('#room-mention-button').click();
  for (let i = 0; i < count; i++) await page.locator('.room-mention-option').nth(i).click();
  await page.locator('.room-mention-picker-title button').click();
}

test('group retries an uncertain send with the same ID and preserves the draft until accepted', async ({ page }) => {
  const group = await createGroup(page, 0);
  const bodies = [];
  try {
    await connectGroup(page, group.room.id);
    await page.route(`**/api/rooms/${group.room.id}/messages`, async route => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        const accepted = await route.fetch();
        expect(accepted.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#room-input').fill('A line');
    await page.locator('#room-input').press('Enter');
    await expect(page.locator('#room-input')).toHaveValue('A line\n');
    expect(bodies).toHaveLength(0);
    await page.locator('#room-input').fill('Keep exactly one message');
    await page.locator('#room-send-button').click();
    await expect(page.locator('#room-send-button')).toBeEnabled();
    await expect(page.locator('#room-input')).toHaveValue('Keep exactly one message');
    await page.locator('#room-send-button').click();
    await expect(page.locator('#room-input')).toHaveValue('');
    await expect(page.locator('.room-entry.user')).toHaveCount(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].clientMessageId).toBe(bodies[0].clientMessageId);
  } finally { await group.cleanup(); }
});

test('group preserves rejected input and gives a corrected send a fresh ID', async ({ page }) => {
  const group = await createGroup(page);
  const ids = [];
  try {
    await connectGroup(page, group.room.id);
    await mentionMembers(page, 1);
    page.on('request', request => {
      if (new URL(request.url()).pathname === `/api/rooms/${group.room.id}/messages` && request.method() === 'POST') ids.push(request.postDataJSON().clientMessageId);
    });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#room-input').fill('__GLAD_E2E_FAIL_SEND__ keep this draft');
    await page.locator('#room-send-button').click();
    await expect(page.locator('#room-send-button')).toBeEnabled();
    await expect(page.locator('#room-input')).toHaveValue('__GLAD_E2E_FAIL_SEND__ keep this draft');
    await expect(page.locator('.room-entry.session')).toContainText('forced send failure');
    await page.locator('#room-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__ corrected send');
    await page.locator('#room-send-button').click();
    await expect(page.locator('#room-input')).toHaveValue('');
    await expect(page.locator('.room-entry.session').last()).toContainText('root completed after child', { timeout: 10000 });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  } finally { await group.cleanup(); }
});

test('group timers can be edited and deleted and execute the selected members through live updates', async ({ page }) => {
  const group = await createGroup(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await connectGroup(page, group.room.id);
    await mentionMembers(page, 1);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => setGladTheme(value), theme);
      await page.locator('#room-input').fill(`Scheduled ${theme} message`);
      await page.locator('#room-schedule-send-btn').click();
      await expect(page.getByRole('group', { name: 'Group scheduled send' })).toBeVisible();
      await page.getByLabel('Group timer hours').selectOption('1');
      await page.getByLabel('Group timer minutes').selectOption('5');
      await page.locator('#room-timed-save-btn').click();
      const tag = page.locator('#room-timed-tag-rail .timed-tag');
      await expect(tag).toHaveCount(1);
      await expect(tag).toContainText(/1h \d{2}m/);
      await tag.click();
      await expect(page.locator('#room-input')).toHaveValue(`Scheduled ${theme} message`);
      await expect(page.locator('#room-context-chips')).toContainText('@Member 1');
      await page.getByLabel('Group timer minutes').selectOption('6');
      await page.locator('#room-timed-save-btn').click();
      await expect(page.locator('#room-timed-editor-actions')).toBeHidden();
      await tag.click();
      await page.locator('#room-timed-delete-btn').click();
      await expect(tag).toHaveCount(0);
      await page.locator('#room-schedule-send-btn').click();
    }
    const view = await (await page.request.get(`/api/rooms/${group.room.id}`)).json();
    const response = await page.request.post(`/api/rooms/${group.room.id}/timed-inputs`, { data: {
      text: '__GLAD_E2E_SUBAGENT_LIFECYCLE__ scheduled group message', sendAt: Date.now() + 1000,
      mentionedMemberIds: [view.members[0].id]
    } });
    expect(response.ok()).toBe(true);
    await expect(page.locator('#room-timed-tag-rail .timed-tag')).toHaveCount(1);
    await expect(page.locator('.room-entry.user')).toContainText('scheduled group message');
    await expect(page.locator('.room-entry.session')).toContainText('root completed after child', { timeout: 10000 });
    await expect(page.locator('#room-timed-tag-rail .timed-tag')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await group.cleanup(); }
});

test('group stops all running members and acknowledges completion only while visible', async ({ page }) => {
  const group = await createGroup(page, 2);
  try {
    await connectGroup(page, group.room.id);
    await mentionMembers(page, 2);
    await page.locator('#room-input').fill('__GLAD_E2E_PLAN_HOLD__ stop both members');
    await page.locator('#room-send-button').click();
    await expect(page.getByRole('button', { name: 'Stop group', exact: true })).toBeEnabled();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#room-input').fill('Keep the next draft while running');
    await page.locator('#room-input').press('Shift+Enter');
    await expect(page.locator('#room-input')).toHaveValue('Keep the next draft while running');
    await expect(page.locator('.room-entry.user')).toHaveCount(1);
    await page.getByRole('button', { name: 'Stop group', exact: true }).click();
    await expect(page.locator('#room-send-button')).toBeEnabled();
    const first = await (await page.request.get(`/api/rooms/${group.room.id}`)).json();
    expect(first.members.every(member => member.status === 'idle')).toBe(true);

    await mentionMembers(page, 2);
    await page.locator('#room-input').fill('__GLAD_E2E_PLAN_HOLD__ finish while hidden');
    await page.locator('#room-send-button').click();
    await page.locator('.room-back-button').click();
    const response = await page.request.post(`/api/rooms/${group.room.id}/abort`);
    expect(response.ok()).toBe(true);
    const card = page.locator(`.room-list-card[data-room-id="${group.room.id}"]`);
    await expect(card.locator('.completion-dot')).toHaveCount(1);
    await card.locator('.btn-join').click();
    await expect.poll(async () => (await (await page.request.get(`/api/rooms/${group.room.id}`)).json()).hasUnreadCompletion).toBe(false);
  } finally { await group.cleanup(); }
});

test('group history is sortable and loads bounded pages', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'History paging runs once');
  const group = await createGroup(page, 0);
  const ids = [];
  try {
    for (let i = 0; i < 41; i++) {
      const saved = await (await page.request.post('/api/rooms', { data: { name: `Paged group ${i}` } })).json();
      ids.push(saved.id);
      await page.request.delete(`/api/rooms/${saved.id}`);
    }
    await connectGroup(page, group.room.id);
    await page.locator('#room-history-resume').click();
    await expect(page.locator('.room-history-item')).toHaveCount(20);
    await page.locator('#room-history-panel').getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(page.locator('.room-history-item')).toHaveCount(40);
    const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/room-history' && new URL(request.url()).searchParams.get('sort') === 'created_at');
    await page.getByLabel('Group history sort').selectOption('created_at');
    await request;
    await expect(page.locator('.room-history-item')).toHaveCount(20);
    const idsOnPage = await page.locator('.room-history-item').evaluateAll(items => items.map(item => item.dataset.roomHistoryId));
    expect(new Set(idsOnPage).size).toBe(20);
  } finally {
    await group.cleanup();
    for (const id of ids) await page.request.delete(`/api/rooms/${id}`);
  }
});

test('group tiles receive live messages and open the group without enabling reordering', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Group tiling runs on desktop');
  const group = await createGroup(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#lobby-collapse-button').click();
    const tile = page.locator(`.tile-group-window[data-room-id="${group.room.id}"]`);
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tile-chat-surface')).toContainText('This group is empty');
    const view = await (await page.request.get(`/api/rooms/${group.room.id}`)).json();
    await page.request.post(`/api/rooms/${group.room.id}/messages`, { data: {
      text: '__GLAD_E2E_SUBAGENT_LIFECYCLE__ live tiled group message', mentionedMemberIds: [view.members[0].id], clientMessageId: 'tile-live-message'
    } });
    await expect(tile.locator('.tile-chat-surface')).toContainText('root completed after child', { timeout: 10000 });
    await expect(tile.locator('.tile-session-header')).toHaveAttribute('title', 'Group chat');
    await tile.locator('.btn-join').click();
    await expect(page.locator('#room-title')).toHaveText('Group parity (1)');
    await expect(page.locator('#room-input')).toBeVisible();
    await page.locator('#tile-return-button').click();
    await expect(tile).toBeVisible();
    await expect(page.locator('#room-view')).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await group.cleanup(); }
});

for (const operation of ['resume', 'fork']) {
  test(`group can cancel an in-progress ${operation} without changing the empty group`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Provider recovery cancellation runs once');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glad-room-recovery-e2e-'));
    const source = await createGroup(page, 1, { workingDirectory: directory, name: 'Slow saved group' });
    const current = await createGroup(page, 0, { name: 'Empty destination' });
    try {
      const view = await (await page.request.get(`/api/rooms/${source.room.id}`)).json();
      await page.request.post(`/api/rooms/${source.room.id}/messages`, { data: { text: 'seed saved group', mentionedMemberIds: [view.members[0].id] } });
      await expect.poll(async () => (await (await page.request.get(`/api/rooms/${source.room.id}`)).json()).members[0].status).toBe('idle');
      await page.request.delete(`/api/sessions/${source.sessions[0]}`);
      await page.request.delete(`/api/rooms/${source.room.id}`);
      await connectGroup(page, current.room.id);
      await page.locator(`#room-history-${operation}`).click();
      const item = page.locator(`.room-history-item[data-room-history-id="${source.room.id}"]`);
      await item.getByRole('button', { name: operation === 'resume' ? 'Resume' : 'Fork', exact: true }).click();
      await expect(page.locator('#room-run-status')).toContainText(operation === 'resume' ? 'Restoring' : 'Forking');
      page.on('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Cancel group recovery', exact: true }).click();
      await expect(page.locator('#room-send-button')).toBeEnabled({ timeout: 10000 });
      const unchanged = await (await page.request.get(`/api/rooms/${current.room.id}`)).json();
      expect(unchanged.historyId).toBe(current.room.id);
      expect(unchanged.members).toEqual([]);
      expect(unchanged.entries).toEqual([]);
    } finally {
      await current.cleanup(); await source.cleanup(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
