const { test, expect } = require('@playwright/test');
const { conversationView } = require('./helpers/conversation');

async function group(request, providers = ['codex','claude-code']) {
  const room = await (await request.post('/api/rooms',{data:{name:'Group Supervisor'}})).json();
  const sessions=[];
  for(let i=0;i<providers.length;i++) {
    const response=await request.post('/api/sessions',{data:{toolKey:providers[i],name:i?'Worker':'Director'}});
    expect(response.ok()).toBe(true);const session=await response.json();sessions.push(session.id);
    expect((await request.post(`/api/rooms/${room.id}/members`,{data:{sessionId:session.id}})).ok()).toBe(true);
  }
  const snapshot=await(await request.get(`/api/rooms/${room.id}`)).json();
  return {room,sessions,members:snapshot.members,async cleanup(){await request.delete(`/api/rooms/${room.id}`);for(const id of sessions)await request.delete(`/api/sessions/${id}`);}};
}
async function call(request, sessionId, tool, args) {
  const key=Math.random().toString(36).slice(2);
  const response=await request.post(`/api/sessions/${sessionId}/input`,{data:{text:'__GLAD_GROUP_CALL__'+JSON.stringify({key,tool,args})}});
  expect(response.ok()).toBe(true);
  let result;
  await expect.poll(async()=>{
    const output=await(await request.get(`/api/sessions/${sessionId}/output?history=true&limit=200`)).json();
    const message=output.messages.find(message=>message.kind==='assistant'&&message.text?.startsWith('GROUP_CONTROL_RESULT ')&&message.text.includes(key));
    if(message)result=JSON.parse(message.text.slice('GROUP_CONTROL_RESULT '.length));
    return Boolean(result);
  },{timeout:20000}).toBe(true);
  await expect.poll(async()=>(await(await request.get('/api/sessions')).json()).find(session=>session.id===sessionId)?.status).toBe('idle');
  return result;
}
async function select(request,g,memberId,expected='',replace=false) {
  return request.put(`/api/rooms/${g.room.id}/supervisor`,{data:{memberId,expectedCurrentMemberId:expected,replace}});
}

test('Supervisor switches are available before messages, unique, synchronized, and leave Context in selection', async({page},testInfo)=>{
 const g=await group(page.request);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try {
  await page.goto('/',{waitUntil:'networkidle'});await page.evaluate(id=>openRoom(id),g.room.id);
  let view=await conversationView(page);await view.locator('#room-members-open').click();
  const first=view.locator(`[data-room-supervisor="${g.members[0].id}"]`),second=view.locator(`[data-room-supervisor="${g.members[1].id}"]`);
  await expect(first).toHaveAttribute('aria-pressed','false');await first.click();await expect(first).toHaveAttribute('aria-pressed','true');
  page.once('dialog',dialog=>dialog.dismiss());await second.click();await expect(first).toHaveAttribute('aria-pressed','true');
  page.once('dialog',dialog=>dialog.accept());await second.click();await expect(second).toHaveAttribute('aria-pressed','true');await expect(first).toHaveAttribute('aria-pressed','false');
  expect((await select(page.request,g,g.members[0].id,'',true)).status()).toBe(409);
  // Another client switches the role; the open Members list must follow WS updates.
  expect((await select(page.request,g,g.members[0].id,g.members[1].id,true)).ok()).toBe(true);
  await expect(first).toHaveAttribute('aria-pressed','true');
  await view.locator('#members-close').click();
  expect((await page.request.post(`/api/rooms/${g.room.id}/messages`,{data:{text:'Inspect the workspace',mentionedMemberIds:[g.members[0].id]}})).ok()).toBe(true);
  await expect(view.locator('.room-entry.session')).toHaveCount(1);
  await expect(view.locator(`.room-entry [data-room-supervisor="${g.members[0].id}"]`)).toHaveAttribute('aria-pressed','true');
  await expect(view.locator('.room-entry.session.running')).toHaveCount(0);
  await view.locator('.room-entry.session').evaluate(element=>toggleRoomQuote(element.dataset.roomEntryId));
  await expect(view.locator('#room-selection-context')).toBeVisible();await view.locator('#room-selection-context').click();await expect(view.locator('#room-context-overlay')).toBeVisible();
  await view.locator('#room-context-overlay .icon-btn').click();await view.locator('#room-selection-cancel').click();
  await expect(view.locator('#room-supervisor-open')).toHaveCount(0);await expect(view.locator('#room-supervisor-overlay')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('supervisor-group.png')});
  const overflow=await view.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(overflow).toBe(false);expect(errors).toEqual([]);
 } finally {await g.cleanup();}
});

for(const provider of ['codex','claude-code','antigravity']) {
 test(`${provider} uses all five group controls through authenticated stdio MCP`,async({page})=>{
  test.setTimeout(90000);const g=await group(page.request,[provider,'antigravity']);const request=page.request;
  const args={roomId:g.room.id,memberId:g.members[1].id};
  try {
   expect((await select(request,g,g.members[0].id)).ok()).toBe(true);
   let result=await call(request,g.sessions[0],'room_read_member',args);expect(result.isError).toBe(false);expect(result.result.available).toBe(true);
   expect(result.tools).toEqual(expect.arrayContaining(['room_read_member','room_start_member','room_stop_member','room_approve_member','room_answer_member']));expect(result.tools).not.toContain('list_targets');
   result=await call(request,g.sessions[0],'room_start_member',{...args,text:'agy-approval'});expect(result.isError).toBe(false);
   result=await call(request,g.sessions[0],'room_read_member',args);const permission=result.result.pendingPermissions[0];expect(permission).toBeTruthy();
   result=await call(request,g.sessions[0],'room_approve_member',{...args,permissionId:permission.id,decision:'allow',optionId:'allow-always-exact'});expect(result.isError).toBe(true);
   result=await call(request,g.sessions[0],'room_approve_member',{...args,permissionId:permission.id,decision:'allow'});expect(result.isError).toBe(false);
   await expect.poll(async()=>(await(await request.get('/api/sessions')).json()).find(session=>session.id===g.sessions[1])?.status).toBe('idle');
   result=await call(request,g.sessions[0],'room_start_member',{...args,text:'agy-question'});expect(result.isError).toBe(false);
   result=await call(request,g.sessions[0],'room_read_member',args);const question=result.result.pendingQuestions[0];expect(question).toBeTruthy();
   result=await call(request,g.sessions[0],'room_answer_member',{...args,questionId:question.id,answers:{destination:'Local',count:'2',enabled:'true'}});expect(result.isError).toBe(false);
   await expect.poll(async()=>(await(await request.get('/api/sessions')).json()).find(session=>session.id===g.sessions[1])?.status).toBe('idle');
   result=await call(request,g.sessions[0],'room_start_member',{...args,text:'agy-long'});expect(result.isError).toBe(false);
   result=await call(request,g.sessions[0],'room_read_member',args);expect(result.result.canAccept).toBe(false);const turnId=result.result.currentTurnId;
   result=await call(request,g.sessions[0],'room_stop_member',{...args,expectedTurnId:turnId});expect(result.isError).toBe(false);
   const snapshot=await(await request.get(`/api/rooms/${g.room.id}`)).json();expect(snapshot).not.toHaveProperty('actions');
   const output=await(await request.get(`/api/sessions/${g.sessions[1]}/output?history=true&limit=200`)).json();expect(output.messages.filter(message=>message.kind==='event').map(message=>message.roomActionSource?.kind)).toEqual(expect.arrayContaining(['approve_member','answer_member','stop_member']));
   expect(snapshot.entries.some(entry=>entry.senderMemberId===g.members[0].id)).toBe(true);
   expect((await select(request,g,'',g.members[0].id)).ok()).toBe(true);
   result=await call(request,g.sessions[0],'room_read_member',args);expect(result.isError).toBe(true);
  } finally {await g.cleanup();}
 });
}

test('Supervisor answers Claude questions and approves native Claude requests without upgrading permissions',async({page})=>{
 test.setTimeout(60000);const g=await group(page.request,['codex','claude-code']);const request=page.request;const args={roomId:g.room.id,memberId:g.members[1].id};
 try {
  expect((await select(request,g,g.members[0].id)).ok()).toBe(true);
  let result=await call(request,g.sessions[0],'room_start_member',{...args,text:'claude-question-probe'});expect(result.isError).toBe(false);
  result=await call(request,g.sessions[0],'room_read_member',args);const question=result.result.pendingQuestions[0];expect(question).toBeTruthy();
  result=await call(request,g.sessions[0],'room_answer_member',{...args,questionId:question.id,answers:{'Which database?':'SQLite'}});expect(result.isError).toBe(false);
  await expect.poll(async()=>(await(await request.get('/api/sessions')).json()).find(session=>session.id===g.sessions[1])?.status).toBe('idle');
  result=await call(request,g.sessions[0],'room_start_member',{...args,text:'claude-approval-probe'});expect(result.isError).toBe(false);
  result=await call(request,g.sessions[0],'room_read_member',args);const permission=result.result.pendingPermissions[0];expect(permission).toBeTruthy();
  result=await call(request,g.sessions[0],'room_approve_member',{...args,permissionId:permission.id,decision:'allow'});expect(result.isError).toBe(false);
  await expect.poll(async()=>(await(await request.get('/api/sessions')).json()).find(session=>session.id===g.sessions[1])?.status).toBe('idle');
  const output=await(await request.get(`/api/sessions/${g.sessions[1]}/output?history=true&limit=200`)).json();expect(output.messages.some(message=>message.text==='Claude permission: allow')).toBe(true);
  const meta=await(await request.get(`/api/sessions/${g.sessions[1]}/metadata`)).json();expect(meta.settings.permissionMode).not.toBe('bypassPermissions');expect(meta.settings.permissionMode).not.toBe('acceptEdits');
 }finally{await g.cleanup();}
});
