const { conversationView, closeConversation } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

test('long groups load earlier pages on scroll, retain references, and append live messages', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const room = await (await page.request.post('/api/rooms', { data:{name:'Long group validation'} })).json();
  const frames = [];
  page.on('websocket', socket => {
    if (socket.url().includes(`roomId=${room.id}`)) socket.on('framereceived', frame => {
      try { frames.push(JSON.parse(frame.payload)); } catch (_) { /* control frame */ }
    });
  });
  try {
    for (let i=0;i<125;i++) {
      const response = await page.request.post(`/api/rooms/${room.id}/messages`, { data:{text:`Message ${i}\n`+'Long conversation content. '.repeat(160)} });
      expect(response.ok()).toBe(true);
    }
    await page.goto('/', {waitUntil:'networkidle'});
    await page.evaluate(id => openRoom(id), room.id);
    await expect((await conversationView(page)).locator('#room-send-button')).toBeEnabled();
    await expect.poll(() => frames.some(frame => frame.type === 'room-snapshot')).toBe(true);
    await expect((await conversationView(page)).locator('#room-view [aria-label="Tile groups"]')).toHaveCount(0);
    await expect((await conversationView(page)).locator('#room-message-list > .room-entry')).toHaveCount(48);
    expect(await (await conversationView(page)).evaluate(() => activeRoom.totalEntries)).toBe(125);
    await expect((await conversationView(page)).getByRole('button', {name:'Earlier messages',exact:true})).toHaveCount(0);
    await (await conversationView(page)).locator('#room-message-list').evaluate(list => list.scrollTo({top:0,behavior:'instant'}));
    await expect((await conversationView(page)).locator('#room-message-list > .room-entry')).toHaveCount(96);
    const quoteId = await (await conversationView(page)).evaluate(() => activeRoom.entries[0].id);
    await (await conversationView(page)).evaluate(id => toggleRoomQuote(id),quoteId);
    const before = await (await conversationView(page)).evaluate(() => activeRoom.entries.map(entry => entry.id));
    expect((await page.request.post(`/api/rooms/${room.id}/messages`,{data:{text:'New live message'}})).ok()).toBe(true);
    await expect.poll(() => frames.filter(frame => frame.type==='room-delta').length).toBeGreaterThan(0);
    await expect((await conversationView(page)).locator('#room-message-list > .room-entry')).toHaveCount(97);
    expect(await (await conversationView(page)).evaluate(() => activeRoom.entries.slice(0,-1).map(entry => entry.id))).toEqual(before);
    await expect((await conversationView(page)).locator('.room-context-chip.quote')).toHaveCount(1);
    await (await conversationView(page)).getByRole('button',{name:'Preview 1',exact:true}).click();
    await expect((await conversationView(page)).locator('.room-selection-preview-item')).toContainText('Message 29');
    await (await conversationView(page)).locator('#room-quotes-overlay .icon-btn').click();
    await (await conversationView(page)).locator('#room-input').fill('Use the earlier reference');
    await (await conversationView(page)).locator('#room-send-button').click();
    await expect((await conversationView(page)).locator('#room-input')).toHaveValue('');
    await expect((await conversationView(page)).locator('#room-message-list > .room-entry')).toHaveCount(98);
    const deltas = frames.filter(frame => frame.type==='room-delta');
    expect(deltas.every(frame => frame.room.entries.length<=2)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('paged-group.png')});
    await closeConversation(page, '.room-back-button');
    expect(await (await conversationView(page)).locator('#room-message-list').evaluate(list=>list.childElementCount)).toBe(0);
  } finally { await page.request.delete(`/api/rooms/${room.id}`); }
});

test('Claude status remains visible on refresh and reports errors with a retry', async ({ page }, testInfo) => {
  const response=await page.request.post('/api/sessions',{data:{toolKey:'claude-code',name:'Claude info validation'}});
  expect(response.ok()).toBe(true); const session=await response.json();
  try {
    await page.goto('/',{waitUntil:'networkidle'});
    await page.evaluate(session=>joinSession(session.id,'Claude info validation','claude-code'),session);
    await expect((await conversationView(page)).locator('#claude-status-btn')).toBeEnabled();
    await (await conversationView(page)).locator('#claude-status-btn').click();
    const panel=(await conversationView(page)).locator('#claude-info-overlay');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.claude-status-card')).toContainText('198.8K');
    await (await conversationView(page)).getByRole('button',{name:'Close Claude status',exact:true}).click();
    expect((await page.request.post(`/api/sessions/${session.id}/input`,{data:{text:'__GLAD_E2E_CLAUDE_STATUS_FAIL__'}})).ok()).toBe(true);
    await expect.poll(async()=> (await(await page.request.get('/api/sessions')).json()).find(item=>item.id===session.id)?.status).toBe('idle');
    await (await conversationView(page)).locator('#claude-status-btn').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.claude-status-card')).toContainText('Fixture status failure');
    await expect((await conversationView(page)).locator('#claude-info-retry')).toBeEnabled();
    await (await conversationView(page)).locator('#claude-info-retry').click();
    await expect(panel.locator('.claude-status-card')).toContainText('198.8K');
    await page.screenshot({path:testInfo.outputPath('claude-info.png')});
  } finally { await page.request.delete(`/api/sessions/${session.id}`); }
});
