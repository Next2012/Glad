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
    await expect(page.locator('#room-send-button')).toBeEnabled();
    await expect(page.locator('#room-view [aria-label="Tile groups"]')).toHaveCount(0);
    await expect(page.locator('#room-message-list > .room-entry')).toHaveCount(48);
    expect(await page.evaluate(() => activeRoom.totalEntries)).toBe(125);
    await expect(page.getByRole('button', {name:'Earlier messages',exact:true})).toHaveCount(0);
    await page.locator('#room-message-list').evaluate(list => list.scrollTo({top:0,behavior:'instant'}));
    await expect(page.locator('#room-message-list > .room-entry')).toHaveCount(96);
    const quoteId = await page.evaluate(() => activeRoom.entries[0].id);
    await page.evaluate(id => toggleRoomQuote(id),quoteId);
    const before = await page.evaluate(() => activeRoom.entries.map(entry => entry.id));
    expect((await page.request.post(`/api/rooms/${room.id}/messages`,{data:{text:'New live message'}})).ok()).toBe(true);
    await expect.poll(() => frames.filter(frame => frame.type==='room-delta').length).toBeGreaterThan(0);
    await expect(page.locator('#room-message-list > .room-entry')).toHaveCount(97);
    expect(await page.evaluate(() => activeRoom.entries.slice(0,-1).map(entry => entry.id))).toEqual(before);
    await expect(page.locator('.room-context-chip.quote')).toHaveCount(1);
    await page.getByRole('button',{name:'Preview 1',exact:true}).click();
    await expect(page.locator('.room-selection-preview-item')).toContainText('Message 29');
    await page.locator('#room-quotes-overlay .icon-btn').click();
    await page.locator('#room-input').fill('Use the earlier reference');
    await page.locator('#room-send-button').click();
    await expect(page.locator('#room-input')).toHaveValue('');
    await expect(page.locator('#room-message-list > .room-entry')).toHaveCount(98);
    const deltas = frames.filter(frame => frame.type==='room-delta');
    expect(deltas.every(frame => frame.room.entries.length<=2)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('paged-group.png')});
    await page.locator('.room-back-button').click();
    expect(await page.locator('#room-message-list').evaluate(list=>list.childElementCount)).toBe(0);
  } finally { await page.request.delete(`/api/rooms/${room.id}`); }
});

test('Claude status remains visible on refresh and reports errors with a retry', async ({ page }, testInfo) => {
  const response=await page.request.post('/api/sessions',{data:{toolKey:'claude-code',name:'Claude info validation'}});
  expect(response.ok()).toBe(true); const session=await response.json();
  try {
    await page.goto('/',{waitUntil:'networkidle'});
    await page.evaluate(session=>joinSession(session.id,'Claude info validation','claude-code'),session);
    await expect(page.locator('#claude-status-btn')).toBeEnabled();
    await page.locator('#claude-status-btn').click();
    const panel=page.locator('#claude-info-overlay');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.claude-status-card')).toContainText('198.8K');
    await page.getByRole('button',{name:'Close Claude status',exact:true}).click();
    expect((await page.request.post(`/api/sessions/${session.id}/input`,{data:{text:'__GLAD_E2E_CLAUDE_STATUS_FAIL__'}})).ok()).toBe(true);
    await expect.poll(async()=> (await(await page.request.get('/api/sessions')).json()).find(item=>item.id===session.id)?.status).toBe('idle');
    await page.locator('#claude-status-btn').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.claude-status-card')).toContainText('Fixture status failure');
    await expect(page.locator('#claude-info-retry')).toBeEnabled();
    await page.locator('#claude-info-retry').click();
    await expect(panel.locator('.claude-status-card')).toContainText('198.8K');
    await page.screenshot({path:testInfo.outputPath('claude-info.png')});
  } finally { await page.request.delete(`/api/sessions/${session.id}`); }
});

test('a Codex question wakes the supervisor, gets answered while running, and records history tool calls', async ({page})=>{
  test.setTimeout(60000);
  const room=await(await page.request.post('/api/rooms',{data:{name:'Question supervisor validation'}})).json();
  const sessions=[],members=[];
  try {
    for(const name of ['Director','Worker']){
      const response=await page.request.post('/api/sessions',{data:{toolKey:'codex',name}});
      expect(response.ok()).toBe(true); const session=await response.json(); sessions.push(session.id);
      expect((await page.request.post(`/api/rooms/${room.id}/members`,{data:{sessionId:session.id}})).ok()).toBe(true);
    }
    members.push(...(await(await page.request.get(`/api/rooms/${room.id}`)).json()).members);
    const response=await page.request.post(`/api/rooms/${room.id}/supervisors`,{data:{executorMemberId:members[0].id,targets:[{memberId:members[1].id,read:true,send:true,stop:false}],intervalSeconds:120,prompt:'__GLAD_E2E_SUPERVISOR_ANSWER__'}});
    expect(response.ok()).toBe(true); const task=(await response.json()).task;
    expect((await page.request.post(`/api/sessions/${sessions[1]}/input`,{data:{text:'__GLAD_E2E_ASYNC_QUESTION__'}})).ok()).toBe(true);
    const taskPath=`/api/rooms/${room.id}/supervisors/${task.id}`;
    await expect.poll(async()=> (await(await page.request.get(taskPath)).json()).summary.lastRun?.status,{timeout:20000}).toBe('completed');
    const history=await(await page.request.get(`${taskPath}/history`)).json();
    const detail=await(await page.request.get(`${taskPath}/history/${history.items[0].id}`)).json();
    const run=detail.invocation||detail;
    expect(run.calls.filter(call=>call.success).map(call=>call.tool)).toEqual(expect.arrayContaining(['read_session','answer_question','session_history','read_session_record']));
    expect(run.calls.some(call=>call.tool==='stop_session')).toBe(false);
    const output=await(await page.request.get(`/api/sessions/${sessions[1]}/output?history=true&limit=200`)).json();
    expect(output.pendingQuestions).toHaveLength(0);
    expect(output.messages.some(message=>message.kind==='question'&&message.questionStatus==='answered')).toBe(true);
    await page.goto('/',{waitUntil:'networkidle'});
    await page.evaluate(id=>openRoom(id),room.id);
    await expect(page.locator('#room-view')).toBeVisible();
  } finally {
    await page.request.delete(`/api/rooms/${room.id}`);
    for(const id of sessions) await page.request.delete(`/api/sessions/${id}`);
  }
});
