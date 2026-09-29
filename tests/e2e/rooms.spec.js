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
  await expect(quotedReply.locator(':scope > .room-quote-button')).toHaveCount(0);
  await expect(quotedReply.locator('.room-entry-author .room-quote-button .room-quote-icon-plus')).toBeVisible();
  await expect(quotedReply.getByRole('button', { name: 'Add to references' })).toBeVisible();
  await quotedReply.getByRole('button', { name: 'Add to references' }).click();
  await expect(page.locator('.room-context-chip.quote')).toBeVisible();
  await quotedReply.getByRole('button', { name: 'Remove from references' }).click();
  await expect(page.locator('.room-context-chip.quote')).toHaveCount(0);
  await quotedReply.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await page.waitForTimeout(650);
  await quotedReply.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await expect(page.locator('.room-context-chip.quote')).toBeVisible();
  await expect(page.getByRole('button', { name: /Preview 1/ })).toBeVisible();
  await page.getByRole('button', { name: /Preview 1/ }).click();
  await expect(page.locator('#room-quotes-overlay')).toBeVisible();
  await expect(page.locator('#room-quotes-title')).toHaveText('Selected messages');
  await expect(page.locator('.room-selection-preview-item')).toContainText('root completed after child');
  await expect(page.locator('.room-selection-preview-item .room-entry-reference')).toHaveCount(0);
  await page.locator('#room-quotes-overlay .icon-btn').click();
  const firstUserMessage = page.locator('.room-entry.user').first();
  await expect(firstUserMessage.locator(':scope > .room-quote-button')).toHaveCount(0);
  await expect(firstUserMessage.locator('.room-entry-author .room-quote-button')).toBeVisible();
  const userLayout = await firstUserMessage.evaluate(entry => {
    const column = entry.querySelector('.room-entry-column').getBoundingClientRect();
    const quote = entry.querySelector('.room-quote-button').getBoundingClientRect();
    const author = entry.querySelector('.room-entry-author').getBoundingClientRect();
    return { columnRatio: column.width / entry.getBoundingClientRect().width, quoteOnHeader: quote.top >= author.top && quote.bottom <= author.bottom + 1 };
  });
  expect(userLayout.columnRatio).toBeGreaterThan(.98);
  expect(userLayout.quoteOnHeader).toBe(true);
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
    expect(forkedRoom.entries).toHaveLength(6);
    expect(forkedRoom.members[0].available).toBe(true);
    expect(forkedRoom.members[0].sessionId).toBe(session.id);
    expect(forkedRoom.members[0].nativeConversationId).toContain('fork-of-');

    await page.request.delete(`/api/sessions/${session.id}`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#lobby-tab-rooms').click();
    await page.locator(`.room-list-card[data-room-id="${room.id}"] .btn-join`).click();
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
  await expect(page.locator('#room-members-overlay .room-modal-back')).toBeVisible();
  await page.locator('#room-members-overlay .room-modal-back').click();
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
