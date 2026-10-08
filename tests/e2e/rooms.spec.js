const { test, expect } = require('@playwright/test');

test('group chat adds sessions, dispatches mentions, quotes replies, and opens the full mini session', async ({ page }) => {
  test.setTimeout(60000);

  const sessionResponse = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Room reviewer' } });
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();
  const roomResponse = await page.request.post('/api/rooms', { data: { name: 'Architecture room' } });
  expect(roomResponse.ok()).toBe(true);
  const room = await roomResponse.json();
  const memberResponse = await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } });
  expect(memberResponse.ok()).toBe(true);

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await expect(page.locator('#room-title')).toHaveText('Architecture room (1)');
  await expect(page.locator('#lobby-view')).toBeHidden();
  const groupHeaderHeight = await page.locator('.room-header').evaluate(element => element.getBoundingClientRect().height);
  const titleCenterOffset = await page.locator('#room-title').evaluate(element => {
    const box = element.getBoundingClientRect();
    return Math.abs((box.left + box.width / 2) - innerWidth / 2);
  });
  expect(titleCenterOffset).toBeLessThan(2);

  await page.locator('#room-mention-button').click();
  await expect(page.locator('.room-mention-option')).toContainText('Room reviewer');
  await page.locator('.room-mention-option').click();
  await page.locator('.room-mention-picker-title button').click();
  await expect(page.locator('.room-context-chip.mention')).toContainText('@Room reviewer');
  await page.locator('#room-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__ discuss this');
  await page.locator('#room-send-button').click();
  await expect(page.locator('.room-entry.user')).toContainText('discuss this');
  await expect(page.locator('.room-entry.session')).toContainText('root completed after child', { timeout: 15000 });
  await expect(page.locator('.room-entry.session .room-provider-label')).toHaveText('Codex');
  await expect(page.locator('.room-entry.user').first()).not.toHaveClass(/collapsible/);
  await page.locator('#room-input').fill('This is a deliberately long room message. '.repeat(30));
  await page.locator('#room-send-button').click();
  const longUserMessage = page.locator('.room-entry.user').last();
  await expect(longUserMessage).toHaveClass(/collapsible/);
  await longUserMessage.locator('.room-entry-bubble').click();
  await expect(longUserMessage).toHaveClass(/expanded/);
  const replyLayout = await page.locator('.room-entry.session').first().evaluate(entry => {
    const bubble = entry.querySelector('.room-entry-bubble').getBoundingClientRect();
    const column = entry.querySelector('.room-entry-column').getBoundingClientRect();
    const avatar = entry.querySelector('.room-entry-avatar').getBoundingClientRect();
    const author = entry.querySelector('.room-entry-author').getBoundingClientRect();
    return { bubbleRatio: bubble.width / column.width, avatarOnHeader: avatar.top >= author.top && avatar.bottom <= author.bottom + 1 };
  });
  expect(replyLayout.bubbleRatio).toBeGreaterThan(.98);
  expect(replyLayout.avatarOnHeader).toBe(true);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await expect(page.locator('.room-entry.session')).toContainText('root completed after child');
  await page.locator('#room-history-resume').click();
  const historyItem = page.locator('.room-history-item').filter({ hasText: 'Architecture room' }).first();
  await expect(historyItem.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(historyItem.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(historyItem.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0);
  await historyItem.getByRole('button', { name: 'Preview' }).click();
  await expect(historyItem.locator('.room-history-preview')).toContainText('discuss this');
  await page.locator('#room-history-panel > header .icon-btn').click();
  await page.locator('#room-history-fork').click();
  const forkHistoryItem = page.locator('.room-history-item').filter({ hasText: 'Architecture room' }).first();
  await expect(forkHistoryItem.getByRole('button', { name: 'Fork', exact: true })).toBeVisible();
  await expect(forkHistoryItem.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await page.locator('#room-history-panel > header .icon-btn').click();

  const quotedReply = page.locator('.room-entry.session').first();
  await expect(page.locator('.room-quote-button')).toHaveCount(0);
  await page.locator('#room-title').hover();
  await expect(quotedReply.locator('.room-selection-circle')).toBeHidden();
  await quotedReply.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await page.waitForTimeout(650);
  await quotedReply.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await expect(page.locator('.room-context-chip.quote')).toBeVisible();
  await expect(page.locator('#room-selection-cancel')).toBeVisible();
  await expect(page.locator('.room-selected-preview-button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Preview 1/ })).toBeVisible();
  await page.getByRole('button', { name: /Preview 1/ }).click();
  await expect(page.locator('#room-quotes-overlay')).toBeVisible();
  await expect(page.locator('#room-quotes-title')).toHaveText('Selected messages');
  await expect(page.locator('.room-selection-preview-item')).toContainText('root completed after child');
  await expect(page.locator('.room-selection-preview-item .room-entry-reference')).toHaveCount(0);
  await page.locator('#room-quotes-overlay .icon-btn').click();
  const firstUserMessage = page.locator('.room-entry.user').first();
  await expect(firstUserMessage.locator('.room-selection-circle')).toBeVisible();
  const userLayout = await firstUserMessage.evaluate(entry => {
    const column = entry.querySelector('.room-entry-column').getBoundingClientRect();
    const circle = entry.querySelector('.room-selection-circle').getBoundingClientRect();
    return { gutter: column.left - entry.getBoundingClientRect().left, circleBeforeMessage: circle.right < column.left };
  });
  expect(userLayout.gutter).toBeGreaterThanOrEqual(44);
  expect(userLayout.circleBeforeMessage).toBe(true);
  await page.locator('#room-mention-button').click();
  await page.locator('.room-mention-option').click();
  await page.locator('.room-mention-picker-title button').click();
  await page.locator('#room-file-input').setInputFiles({
    name: 'room-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('temporary room attachment')
  });
  await expect(page.locator('#room-file-chips')).toContainText('room-notes.txt');
  await page.locator('#room-input').fill('Review the quoted result');
  await page.locator('#room-send-button').click();
  await expect(page.locator('.room-entry.user').last()).toContainText('Review the quoted result');
  await expect(page.locator('.room-entry.user').last()).toContainText('Chat history');
  await page.locator('.room-entry.user').last().locator('.room-entry-reference').click();
  await expect(page.locator('#room-quotes-overlay')).toBeVisible();
  await expect(page.locator('.room-forward-item')).toContainText('root completed after child');
  await page.locator('.room-forward-item').click();
  await expect(page.locator('#room-quotes-overlay')).toBeHidden();
  await expect(page.locator('.room-entry-jump')).toBeVisible();

  await page.locator('button.room-entry-avatar').first().click();
  await expect(page.locator('body')).toHaveClass(/room-session-open/);
  await expect(page.locator('#terminal-view')).toBeVisible();
  await expect(page.locator('#cmd-input')).toBeVisible();
  await expect(page.locator('#attachment-btn')).toBeVisible();
  await expect(page.locator('.codex-message-block.user').last()).toContainText('room-notes.txt');
  await page.locator('#nav-bar').getByTitle('History').click();
  await expect(page.locator('#history-view')).toBeVisible();
  await expect(page.locator('#room-view')).toHaveClass(/active/);
  await page.locator('#history-view').getByRole('button', { name: /Terminal/ }).click();
  await expect(page.locator('#terminal-view')).toBeVisible();
  await page.locator('#nav-bar').getByTitle('Git').click();
  await expect(page.locator('#git-view')).toBeVisible();
  await page.locator('#git-view').getByRole('button', { name: /Terminal/ }).click();
  await expect(page.locator('#terminal-view')).toBeVisible();
  const miniLayout = await page.evaluate(() => {
    const chat = document.getElementById('codex-chat-container').getBoundingClientRect();
    const controls = document.getElementById('terminal-controls').getBoundingClientRect();
    const nav = document.getElementById('nav-bar').getBoundingClientRect();
    return { chatTop: chat.top, controlsTop: controls.top, navHeight: nav.height };
  });
  expect(miniLayout.controlsTop).toBeGreaterThan(miniLayout.chatTop);
  expect(Math.abs(miniLayout.navHeight - groupHeaderHeight)).toBeLessThan(1);
  const assistantCount = await page.locator('.codex-message.assistant').count();
  await page.locator('#cmd-input').fill('__GLAD_E2E_SUBAGENT_LIFECYCLE__ direct mini message');
  await page.locator('#send-btn').click();
  await expect(page.locator('.codex-message.assistant')).toHaveCount(assistantCount + 1, { timeout: 15000 });
  await expect(page.locator('.codex-message.assistant').last()).toContainText('root completed after child');
  await page.locator('#nav-bar').getByTitle('History').click();
  await expect(page.locator('#history-view')).toBeVisible();
  await expect(page.locator('#room-session-close')).toHaveCount(0);
  await page.locator('#history-view').getByRole('button', { name: /Terminal/ }).click();
  await page.locator('#back-btn').click();
  await expect(page.locator('#room-view')).toBeVisible();
  await expect(page.locator('#history-view')).toBeHidden();
  await expect(page.locator('.room-entry.user').last()).toContainText('direct mini message');
  await expect(page.locator('.room-entry.session').last()).toContainText('root completed after child');

  let resumedSessionId = null;
  if (page.viewportSize().width > 1000) {
    const operation = await (await page.request.get(`/api/rooms/${room.id}/operation-status`)).json();
    expect(operation.members[0].canFork).toBe(true);
    const forkResponse = await page.request.post(`/api/rooms/${room.id}/fork`, {
      data: { excludedMemberIds: [] }
    });
    expect(forkResponse.ok()).toBe(true);
    const forked = await forkResponse.json();
    expect(forked.id).toBe(room.id);
    const forkedRoom = await (await page.request.get(`/api/rooms/${room.id}`)).json();
    expect(forkedRoom.name).toBe('Architecture room');
    expect(forkedRoom.entries).toHaveLength(7);
    expect(forkedRoom.members[0].available).toBe(true);
    expect(forkedRoom.members[0].sessionId).not.toBe(session.id);
    const forkSessionId = forkedRoom.members[0].sessionId;
    const originalRoom = await (await page.request.get(`/api/room-history/${room.id}`)).json();
    expect(originalRoom.members[0].sessionId).toBe(session.id);
    expect(originalRoom.members[0].nativeConversationId).not.toContain('fork-of-');
    expect(forkedRoom.historyId).not.toBe(room.id);
    expect(forkedRoom.members[0].nativeConversationId).toContain('fork-of-');

    await page.request.delete(`/api/sessions/${forkSessionId}`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#lobby-tab-rooms').click();
    await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
    const unavailableRoom = await (await page.request.get(`/api/rooms/${room.id}`)).json();
    expect(unavailableRoom.members[0].available).toBe(false);
    await page.locator('#room-history-resume').click();
    await page.locator(`.room-history-item[data-room-history-id="${forkedRoom.historyId}"]`).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(async () => {
      const current = await (await page.request.get(`/api/rooms/${room.id}`)).json();
      return current.members[0].available;
    }, { timeout: 15000 }).toBe(true);
    const resumedRoom = await (await page.request.get(`/api/rooms/${room.id}`)).json();
    expect(resumedRoom.members[0].available).toBe(true);
    expect(resumedRoom.members[0].sessionId).not.toBe(session.id);
    resumedSessionId = resumedRoom.members[0].sessionId;
  }

  await page.request.delete(`/api/rooms/${room.id}`);
  if (resumedSessionId) await page.request.delete(`/api/sessions/${resumedSessionId}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('group dynamically projects pre-join history and opens neighboring turns with details', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Native history projection runs once');
  const session = await (await page.request.post('/api/sessions', {
    data: { toolKey: 'codex', name: 'History source' }
  })).json();
  for (const text of [
    '__GLAD_E2E_SUBAGENT_LIFECYCLE__ first before group',
    '__GLAD_E2E_SUBAGENT_LIFECYCLE__ second before group'
  ]) {
    const sent = await page.request.post(`/api/sessions/${session.id}/input`, { data: { text } });
    expect(sent.ok()).toBe(true);
    await expect.poll(async () => {
      const snapshot = await (await page.request.get(`/api/sessions/${session.id}`)).json();
      return snapshot.status;
    }, { timeout: 15000 }).toBe('idle');
  }
  const room = await (await page.request.post('/api/rooms', { data: { name: 'Projected history' } })).json();
  const member = await (await page.request.post(`/api/rooms/${room.id}/members`, {
    data: { sessionId: session.id }
  })).json();
  let projected;
  await expect.poll(async () => {
    projected = await (await page.request.get(`/api/rooms/${room.id}`)).json();
    return projected.entries.length;
  }).toBe(4);
  expect(projected.entries.every(entry => entry.historical)).toBe(true);
  expect(projected.entries[0].mentionedMemberIds).toEqual([member.memberId]);

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await expect(page.locator('.room-entry.user').first()).toContainText('@History source');
  await page.locator('.room-entry.session').first().getByRole('button', { name: 'Context' }).click();
  await expect(page.locator('#room-context-overlay')).toBeVisible();
  await expect(page.locator('.room-context-turn')).toHaveCount(2);
  await expect(page.locator('.room-context-turn.anchor')).toContainText('first before group');
  await expect(page.locator('.room-context-turn').last()).toContainText('second before group');
  await page.locator('.room-context-turn.anchor .room-turn-details-button').click();
  await expect(page.locator('.room-context-turn.anchor .room-turn-details')).toContainText('Assistant message');

  await page.request.delete(`/api/rooms/${room.id}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('new empty groups survive returning and reloading alongside existing groups', async ({ page }) => {
  const sessions = [];
  const roomIds = [];
  try {
    for (const name of ['test1', 'test2']) {
      const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name } });
      expect(response.ok()).toBe(true);
      sessions.push(await response.json());
    }
    const oldRoom = await (await page.request.post('/api/rooms', { data: { name: '111' } })).json();
    roomIds.push(oldRoom.id);
    for (const session of sessions) {
      const response = await page.request.post(`/api/rooms/${oldRoom.id}/members`, { data: { sessionId: session.id } });
      expect(response.ok()).toBe(true);
    }
    const before = await (await page.request.get('/api/rooms')).json();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.locator('#lobby-tab-rooms').click();
    const oldCard = page.locator(`.room-list-card[data-room-id="${oldRoom.id}"]`);
    await expect(oldCard).toContainText('111');
    await expect(oldCard).toContainText('2 sessions');
    await page.evaluate(() => Promise.all([createRoomFromLobby(), createRoomFromLobby()]));
    await expect(page.locator('#room-title')).toHaveText('New group (0)');
    const newId = await page.evaluate(() => activeRoomId);
    roomIds.push(newId);
    expect(newId).not.toBe(oldRoom.id);
    expect(await (await page.request.get('/api/rooms')).json()).toHaveLength(before.length + 1);

    await page.locator('.room-back-button').click();
    const newCard = page.locator(`.room-list-card[data-room-id="${newId}"]`);
    await expect(newCard).toBeVisible();
    await expect(newCard).toContainText('New group');
    await expect(newCard).toContainText('0 sessions');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#lobby-tab-rooms').click();
    await expect(newCard).toBeVisible();
    await expect(oldCard).toContainText('2 sessions');
    await newCard.locator('.btn-join').click();
    await expect(page.locator('#room-title')).toHaveText('New group (0)');
    // Reloading an open empty group triggers pagehide, another former cleanup path.
    await page.reload({ waitUntil: 'networkidle' });
    const newRoom = await (await page.request.get(`/api/rooms/${newId}`)).json();
    expect(newRoom.members).toEqual([]);
    expect(newRoom.entries).toEqual([]);
    expect(await (await page.request.get('/api/rooms')).json()).toHaveLength(before.length + 1);
    await page.locator('#lobby-tab-rooms').click();
    await expect(newCard).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await newCard.getByRole('button', { name: 'Delete group', exact: true }).click();
    await expect(newCard).toHaveCount(0);
    expect((await page.request.get(`/api/rooms/${newId}`)).status()).toBe(404);
    const archived = await (await page.request.get(`/api/room-history/${newId}`)).json();
    expect(archived.members).toEqual([]);
    expect(archived.entries).toEqual([]);
    await expect(oldCard).toContainText('2 sessions');
  } finally {
    for (const id of roomIds) await page.request.delete(`/api/rooms/${id}`);
    for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
  }
});

test('group history previews are read only and resume and fork switch the current group', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Saved group lifecycle runs once');
  const roomIds = [];
  const sessionIds = [];
  try {
    const session = await (await page.request.post('/api/sessions', {
      data: { toolKey: 'codex', name: 'Saved member' }
    })).json();
    sessionIds.push(session.id);
    const source = await (await page.request.post('/api/rooms', { data: { name: 'Saved group' } })).json();
    roomIds.push(source.id);
    await page.request.post(`/api/rooms/${source.id}/members`, { data: { sessionId: session.id } });
    const sourceView = await (await page.request.get(`/api/rooms/${source.id}`)).json();
    await page.request.post(`/api/rooms/${source.id}/messages`, {
      data: { text: '__GLAD_E2E_SUBAGENT_LIFECYCLE__ saved group question', mentionedMemberIds: [sourceView.members[0].id] }
    });
    await expect.poll(async () => {
      const current = await (await page.request.get(`/api/rooms/${source.id}`)).json();
      return current.entries.at(-1)?.status;
    }).toBe('completed');
    await page.request.delete(`/api/rooms/${source.id}`);
    await page.request.delete(`/api/sessions/${session.id}`);
    const sessionsBeforePreview = await (await page.request.get('/api/sessions')).json();
    expect((await page.request.get('/api/rooms')).ok()).toBe(true);
    expect((await (await page.request.get('/api/rooms')).json()).some(item => item.id === source.id)).toBe(false);

    const operations = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/rooms\/[^/]+\/(resume|fork)$/.test(new URL(request.url()).pathname)) operations.push(request.url());
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'New group chat', exact: true }).click();
    await expect(page.locator('#room-title')).toHaveText('New group (0)');
    const runtimeId = await page.evaluate(() => activeRoomId);
    roomIds.push(runtimeId);
    expect(operations).toEqual([]);
    await page.locator('#room-history-resume').click();
    const savedItem = page.locator(`.room-history-item[data-room-history-id="${source.id}"]`);
    await savedItem.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(savedItem.locator('.room-history-preview')).toContainText('saved group question');
    expect(await page.evaluate(() => activeRoomId)).toBe(runtimeId);
    expect(await (await page.request.get('/api/sessions')).json()).toEqual(sessionsBeforePreview);
    expect(operations).toEqual([]);

    await savedItem.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('#room-title')).toHaveText('Saved group (1)');
    expect(await page.evaluate(() => activeRoomId)).toBe(runtimeId);
    const resumed = await (await page.request.get(`/api/rooms/${runtimeId}`)).json();
    expect(resumed.historyId).toBe(source.id);
    expect(resumed.members[0].available).toBe(true);
    sessionIds.push(resumed.members[0].sessionId);
    const original = await (await page.request.get(`/api/room-history/${source.id}`)).json();

    await page.locator('#room-history-fork').click();
    await savedItem.getByRole('button', { name: 'Fork', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/rooms/${runtimeId}`)).json()).historyId).not.toBe(source.id);
    const forked = await (await page.request.get(`/api/rooms/${runtimeId}`)).json();
    expect(await page.evaluate(() => activeRoomId)).toBe(runtimeId);
    expect(forked.members[0].sessionId).not.toBe(original.members[0].sessionId);
    expect(forked.members[0].nativeConversationId).not.toBe(original.members[0].nativeConversationId);
    sessionIds.push(forked.members[0].sessionId);
    const preserved = await (await page.request.get(`/api/room-history/${source.id}`)).json();
    expect(preserved.members).toEqual(original.members);
    expect(preserved.entries).toEqual(original.entries);
    await page.locator('.room-back-button').click();
    await page.locator('#lobby-tab-rooms').click();
    await expect(page.locator(`.room-list-card[data-room-id="${runtimeId}"]`)).toBeVisible();
    await expect(page.locator(`.room-list-card[data-room-id="${source.id}"]`)).toHaveCount(0);
  } finally {
    for (const id of roomIds) await page.request.delete(`/api/rooms/${id}`);
    for (const id of sessionIds) await page.request.delete(`/api/sessions/${id}`);
  }
});

test('a new group imports the complete history of an existing member session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Complete session history runs once');
  const session = await (await page.request.post('/api/sessions', {
    data: { toolKey: 'codex', name: 'Shared history' }
  })).json();
  const originRoom = await (await page.request.post('/api/rooms', { data: { name: 'Origin group' } })).json();
  const originMember = await (await page.request.post(`/api/rooms/${originRoom.id}/members`, {
    data: { sessionId: session.id }
  })).json();
  const groupSend = await page.request.post(`/api/rooms/${originRoom.id}/messages`, { data: {
    text: '__GLAD_E2E_SUBAGENT_LIFECYCLE__ origin-only message',
    mentionedMemberIds: [originMember.memberId], quotedEntryIds: []
  }});
  expect(groupSend.ok()).toBe(true);
  await expect.poll(async () => {
    const room = await (await page.request.get(`/api/rooms/${originRoom.id}`)).json();
    return room.entries.at(-1)?.text || '';
  }, { timeout: 15000 }).toContain('root completed after child');

  const newRoom = await (await page.request.post('/api/rooms', { data: { name: 'Separate group' } })).json();
  await page.request.post(`/api/rooms/${newRoom.id}/members`, { data: { sessionId: session.id } });
  let separate = await (await page.request.get(`/api/rooms/${newRoom.id}`)).json();
  expect(separate.entries).toHaveLength(2);
  expect(separate.entries[0].text).toContain('origin-only message');
  expect(separate.entries[1].text).toContain('root completed after child');

  const direct = await page.request.post(`/api/sessions/${session.id}/input`, {
    data: { text: '__GLAD_E2E_SUBAGENT_LIFECYCLE__ direct shared history' }
  });
  expect(direct.ok()).toBe(true);
  await expect.poll(async () => {
    separate = await (await page.request.get(`/api/rooms/${newRoom.id}`)).json();
    return separate.entries.length;
  }, { timeout: 15000 }).toBe(4);
  expect(separate.entries[2].text).toContain('direct shared history');
  expect(separate.entries[3].text).toContain('root completed after child');
  const origin = await (await page.request.get(`/api/rooms/${originRoom.id}`)).json();
  expect(origin.entries).toHaveLength(4);

  await page.request.delete(`/api/rooms/${newRoom.id}`);
  await page.request.delete(`/api/rooms/${originRoom.id}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('landscape tablet gives the room the full canvas and keeps mini-session composer at the bottom', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPad Air 7', 'Landscape room layout runs once');
  await page.setViewportSize({ width: 1024, height: 700 });
  const session = await (await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Landscape reviewer' } })).json();
  const room = await (await page.request.post('/api/rooms', { data: { name: 'Landscape room' } })).json();
  const member = await (await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } })).json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await expect(page.locator('#lobby-view')).toBeHidden();
  const roomLayout = await page.evaluate(() => {
    const roomView = document.getElementById('room-view').getBoundingClientRect();
    const composer = document.querySelector('.room-composer').getBoundingClientRect();
    const controls = ['room-attachment-button', 'room-mention-button', 'room-history-resume', 'room-history-fork', 'room-send-button']
      .map(id => document.getElementById(id).getBoundingClientRect());
    const input = document.getElementById('room-input').getBoundingClientRect();
    const toolbar = document.querySelector('.room-toolbar-row').getBoundingClientRect();
    const rail = getComputedStyle(document.querySelector('.room-action-rail'));
    return {
      roomWidth: roomView.width, composerBottom: composer.bottom, viewportHeight: innerHeight,
      controlBottoms: controls.map(box => box.bottom), buttonHeights: controls.map(box => box.height),
      inputBottom: input.bottom, toolbarTop: toolbar.top, railOverflowX: rail.overflowX,
      firstActionId: document.querySelector('.room-action-rail').firstElementChild.id
    };
  });
  expect(roomLayout.roomWidth).toBeGreaterThan(980);
  expect(Math.abs(roomLayout.viewportHeight - roomLayout.composerBottom)).toBeLessThan(2);
  expect(Math.max(...roomLayout.controlBottoms) - Math.min(...roomLayout.controlBottoms)).toBeLessThan(1);
  expect(new Set(roomLayout.buttonHeights.map(Math.round)).size).toBe(1);
  expect(roomLayout.toolbarTop).toBeGreaterThanOrEqual(roomLayout.inputBottom);
  expect(roomLayout.railOverflowX).toBe('auto');
  expect(roomLayout.firstActionId).toBe('room-mention-button');
  await expect(page.locator('#room-member-strip')).toHaveCount(0);
  await page.locator('#room-mention-button').click();
  const pickerWidth = await page.locator('#room-mention-picker').evaluate(element => element.getBoundingClientRect().width);
  expect(pickerWidth).toBeLessThanOrEqual(362);
  await page.locator('.room-mention-picker-title button').click();
  await page.evaluate(memberId => openRoomSession(memberId), member.memberId);
  const mini = await page.evaluate(() => {
    const dialog = document.getElementById('terminal-view').getBoundingClientRect();
    const chat = document.getElementById('codex-chat-container').getBoundingClientRect();
    const controls = document.getElementById('terminal-controls').getBoundingClientRect();
    return { dialogTop: dialog.top, dialogBottom: dialog.bottom, chatTop: chat.top, controlsTop: controls.top };
  });
  expect(mini.dialogTop).toBeGreaterThan(20);
  expect(mini.dialogBottom).toBeLessThan(680);
  expect(mini.controlsTop).toBeGreaterThan(mini.chatTop);
  await page.request.delete(`/api/rooms/${room.id}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('group timeline surfaces member permission requests and opens the approval session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'MacBook Pro 16', 'Permission projection runs once');
  const session = await (await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Approval reviewer' } })).json();
  const room = await (await page.request.post('/api/rooms', { data: { name: 'Approval room' } })).json();
  await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await page.locator('#room-mention-button').click();
  await page.locator('.room-mention-option').click();
  await page.locator('.room-mention-picker-title button').click();
  await page.locator('#room-input').fill('__GLAD_E2E_APPROVAL__ group permission');
  await page.locator('#room-send-button').click();
  await expect(page.locator('.room-attention-pill')).toContainText('Permission required', { timeout: 10000 });
  await expect(page.locator('.room-entry-attention')).toContainText('Permission required');
  const runningAvatar = page.locator('.room-entry-avatar .room-avatar-running');
  await expect(runningAvatar).toBeVisible();
  expect(await runningAvatar.evaluate(element => getComputedStyle(element).animationName)).toContain('room-avatar-flow');
  await page.locator('.room-entry-attention').click();
  const approval = page.locator('#codex-chat-container [data-codex-permission-id]');
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.locator('#back-btn').click();
  await expect(page.locator('.room-attention-pill')).toHaveCount(0, { timeout: 10000 });
  await page.request.delete(`/api/rooms/${room.id}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('group and member names are editable without leaving the room and user messages have avatars', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iPhone 17 Pro Max', 'Identity controls run once on mobile');
  const session = await (await page.request.post('/api/sessions', { data: { toolKey: 'codex', name: 'Alpha' } })).json();
  const room = await (await page.request.post('/api/rooms', { data: { name: 'Original group' } })).json();
  const member = await (await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } })).json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#lobby-tab-rooms').click();
  await expect(page.locator(`.room-list-card[data-room-id="${room.id}"]`)).toHaveClass(/session-card/);
  await expect(page.locator(`.room-list-card[data-room-id="${room.id}"] .serverchan-toggle`)).toBeVisible();
  page.once('dialog', dialog => dialog.accept('Renamed group'));
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .room-list-edit`).click();
  await expect(page.locator(`.room-list-card[data-room-id="${room.id}"] .room-list-name`)).toHaveText('Renamed group');
  await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
  await page.getByRole('button', { name: 'Members' }).click();
  const membersCenterOffset = await page.locator('.room-members-modal').evaluate(element => {
    const box = element.getBoundingClientRect();
    return Math.abs((box.top + box.height / 2) - innerHeight / 2);
  });
  expect(membersCenterOffset).toBeLessThan(2);
  page.once('dialog', dialog => dialog.accept('审阅者'));
  await page.locator('.room-manage-member').getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.room-manage-member strong')).toHaveText('审阅者');
  await expect(page.locator('#members-back')).toBeHidden();
  await page.getByRole('button', { name: 'Close members', exact: true }).click();
  await page.locator('#room-input').fill('User avatar message');
  await page.locator('#room-send-button').click();
  const userEntry = page.locator('.room-entry.user').last();
  await expect(userEntry.locator('.room-entry-avatar.user')).toBeVisible();
  await expect(userEntry.locator('.room-entry-avatar.user .room-avatar')).toHaveText('Y');
  await page.evaluate(memberId => openRoomSession(memberId), member.memberId);
  await expect(page.locator('#back-btn')).toHaveText('');
  await expect(page.locator('#back-btn')).toHaveAttribute('aria-label', 'Back');
  await page.locator('#back-btn').click();
  await expect(page.locator('#room-view')).toBeVisible();
  await page.request.delete(`/api/rooms/${room.id}`);
  await page.request.delete(`/api/sessions/${session.id}`);
});
