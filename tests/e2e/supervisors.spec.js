const { test, expect } = require('@playwright/test');
const { mockVisualViewport } = require('./helpers/visual-viewport');

async function setup(page) {
  const room = await (await page.request.post('/api/rooms', { data: { name: 'Supervisor integration' } })).json();
  const sessions = [], members = [];
  for (const name of ['Director', 'Worker']) {
    const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name } });
    expect(response.ok()).toBe(true);
    const session = await response.json(); sessions.push(session.id);
    const member = await (await page.request.post(`/api/rooms/${room.id}/members`, { data: { sessionId: session.id } })).json();
    members.push(member.member || member);
  }
  const snapshot = await (await page.request.get(`/api/rooms/${room.id}`)).json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(id => openRoom(id), room.id);
  return { room, sessions, members: snapshot.members, async cleanup() {
    await page.request.delete(`/api/rooms/${room.id}`);
    for (const id of sessions) await page.request.delete(`/api/sessions/${id}`);
  } };
}

test('supervisor UI creates, invokes real MCP tools, records history, edits and deletes a task', async ({ page }) => {
  test.setTimeout(60000);
  const group = await setup(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Supervisors' })).toBeVisible();
    await expect(page.locator('#supervisor-editor-view')).toBeHidden();
    await expect(page.locator('#supervisor-session-control')).toHaveCount(0);
    await page.getByRole('button', { name: '＋ New', exact: true }).click();
    await page.locator('#supervisor-editor-view').getByRole('button', { name: /Session/ }).click();
    await page.locator(`[data-choose-executor="${group.members[0].id}"]`).click();
    await expect(page.locator(`.supervisor-target[data-member-id="${group.members[0].id}"]`)).toBeHidden();
    const target = page.locator(`.supervisor-target[data-member-id="${group.members[1].id}"]`);
    await target.locator('.supervisor-target-enabled').check();
    await expect(target.locator('[data-permission="read"]')).toBeChecked();
    await expect(target.locator('[data-permission="stop"]')).toBeChecked();
    await expect(target.locator('[data-permission="send"]')).toBeChecked();
    await expect(target.locator('.supervisor-permissions')).toBeHidden();
    await page.locator('#supervisor-prompt').fill('__GLAD_E2E_SUPERVISOR__ inspect and direct the worker');
    await page.getByRole('button', { name: 'Save & start', exact: true }).click();
    await expect(page.locator('.supervisor-task')).toHaveCount(1);
    await expect(page.locator('#supervisor-editor-view')).toBeHidden();
    const taskId = await page.locator('.supervisor-task').getAttribute('data-supervisor-id');
    await page.getByRole('checkbox', { name: 'Enable monitoring' }).uncheck();
    await expect(page.locator('.supervisor-task')).toContainText('Paused');
    await page.getByLabel('More supervisor actions').click();
    // Visible actions must be clickable without scrolling a clipped popup.
    expect(await page.getByRole('button', { name: 'Delete', exact: true }).evaluate(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
    await page.getByRole('button', { name: 'Run once now', exact: true }).click();
    await expect.poll(async () => {
      const data = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors`)).json();
      return data.tasks[0]?.lastRun?.status;
    }, { timeout: 20000 }).toBe('completed');
    const data = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors`)).json();
    expect(data.tasks[0].enabled).toBe(false);
    expect(data.tasks[0].invocations).toBeUndefined();
    expect(data.serverNow).toBeGreaterThan(0);
    const invocation = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}/history/${data.tasks[0].lastRun.id}`)).json();
    expect(invocation.invocation.calls.map(call => call.tool)).toEqual(['list_targets', 'read_session', 'send_to_session']);
    expect(invocation.invocation.calls.every(call => call.success)).toBe(true);
    const snapshot = await (await page.request.get(`/api/rooms/${group.room.id}`)).json();
    expect(snapshot.entries.some(entry => entry.text?.includes('__GLAD_E2E_SUPERVISOR__'))).toBe(false);
    expect(snapshot.entries.some(entry => entry.text?.includes('Supervisor requested worker implementation'))).toBe(true);
    expect(snapshot.entries.find(entry => entry.type === 'user').senderMemberId).toBe(group.members[0].id);
    expect(snapshot.hasUnreadCompletion).toBe(false);
    await page.locator('.supervisor-card-open').click();
    await expect(page.locator('#supervisor-history')).toContainText('Completed');
    await expect(page.locator('#supervisor-history .supervisor-run-content')).not.toContainText('read_session');
    await page.locator('.supervisor-history-row > summary').click();
    await expect(page.locator('#supervisor-history')).toContainText('read_session');
    await page.getByRole('button', { name: 'Edit configuration', exact: true }).click();
    await target.locator('.supervisor-permission-open').click();
    await page.locator('#supervisor-permission-send').uncheck();
    await page.getByRole('button', { name: 'Back to editor', exact: true }).click();
    await page.locator('[data-supervisor-interval="60"]').click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const edited = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}`)).json();
    expect(edited.task.targets[0].send).toBe(false);
    expect(edited.task.intervalSeconds).toBe(60);
    expect(edited.task.enabled).toBe(false);
    await page.getByLabel('More supervisor actions').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator(`[data-supervisor-id="${taskId}"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await group.cleanup(); }
});

test('live output and individual abort work while another room member remains available', async ({ page }) => {
  test.setTimeout(60000);
  const group = await setup(page);
  try {
    const start = await page.request.post(`/api/sessions/${group.sessions[1]}/input`, { data: { text: '__GLAD_E2E_STUCK_ABORT__ hold this worker', clientMessageId: 'worker-hold-input' } });
    expect(start.status()).toBe(202);
    const output = await (await page.request.get(`/api/sessions/${group.sessions[1]}/output`)).json();
    expect(output.status).toBe('running');
    expect(output.canAccept).toBe(false);
    const busySend = await page.request.post(`/api/sessions/${group.sessions[1]}/input`, { data: { text: 'must not queue' } });
    expect(busySend.status()).toBe(409);
    const send = await page.request.post(`/api/rooms/${group.room.id}/messages`, { data: { text: 'Ask the idle director', mentionedMemberIds: [group.members[0].id], quotedEntryIds: [], clientMessageId: 'director-idle-input' } });
    expect(send.status()).toBe(202);
    const stopped = await page.request.post(`/api/sessions/${group.sessions[1]}/abort`, { data: {} });
    expect(stopped.status()).toBe(202);
    await expect.poll(async () => (await (await page.request.get(`/api/sessions/${group.sessions[1]}/output`)).json()).canAccept, { timeout: 15000 }).toBe(true);
    const restart = await page.request.post(`/api/sessions/${group.sessions[1]}/input`, { data: { text: 'Continue after stop', clientMessageId: 'worker-restart-input' } });
    expect(restart.status()).toBe(202);
  } finally { await group.cleanup(); }
});

test('Members controls navigate in the same panel and supervisor editor keeps its draft', async ({ page }) => {
  test.setTimeout(60000);
  const group = await setup(page);
  try {
    await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await page.getByRole('button', { name: '＋ New', exact: true }).click();
    await page.locator('#supervisor-prompt').fill('An unfinished editor draft');
    await page.waitForTimeout(2500);
    await expect(page.locator('#supervisor-prompt')).toHaveValue('An unfinished editor draft');
    await expect(page.locator('#supervisor-list-view')).toBeHidden();
    await page.getByRole('button', { name: 'Back to supervisors', exact: true }).click();
    await page.getByRole('button', { name: 'Close supervisors' }).click();
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await page.getByRole('button', { name: 'Controls', exact: true }).last().click();
    await expect(page.locator('#room-members-home')).toBeHidden();
    await expect(page.locator('#room-member-controls')).toBeVisible();
    await expect(page.locator('#room-members-title')).toHaveText('Worker');
    await expect(page.locator('.room-modal-overlay.active')).toHaveCount(1);
    await expect(page.locator('#member-start')).toBeEnabled();
    await page.locator('#member-command').fill('Start this worker from Members');
    await page.locator('#member-start').click();
    await expect(page.locator('#member-command')).toHaveValue('');
    await page.locator('#room-members-overlay').getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('#member-control-output')).toContainText('Start this worker from Members');
    await page.locator('#room-members-overlay').getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#room-members-home')).toBeVisible();
    await expect(page.locator('#room-members-title')).toHaveText('Group members');
    await expect(page.locator('.room-modal-overlay.active')).toHaveCount(1);
  } finally { await group.cleanup(); }
});


test('grouped editor preserves drafts and independent permissions, with Stop requiring Read', async ({ page }) => {
  const group = await setup(page);
  try {
    await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await page.getByRole('button', { name: '＋ New', exact: true }).click();
    await page.locator('#supervisor-prompt').fill('Keep this draft while navigating permissions');
    const target = page.locator(`.supervisor-target[data-member-id="${group.members[1].id}"]`);
    await target.locator('.supervisor-target-enabled').check();
    await target.locator('.supervisor-permission-open').click();
    await expect(page.locator('.room-modal-overlay.active')).toHaveCount(1);
    await expect(page.locator('#supervisor-editor-view')).toBeHidden();
    await page.locator('#supervisor-permission-read').uncheck();
    await expect(page.locator('#supervisor-permission-stop')).not.toBeChecked();
    await expect(page.locator('#supervisor-permission-help')).toContainText('Stop disabled');
    await page.locator('#supervisor-permission-stop').check();
    await expect(page.locator('#supervisor-permission-read')).toBeChecked();
    await expect(page.locator('#supervisor-permission-help')).toContainText('Read enabled');
    await page.locator('#supervisor-permission-send').uncheck();
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'Back to editor', exact: true }).click();
    await expect(target.locator('.supervisor-permission-summary')).toHaveText('Read + Stop');
    await expect(page.locator('#supervisor-prompt')).toHaveValue('Keep this draft while navigating permissions');
    await expect(page.locator('.supervisor-advanced')).toHaveCount(0);
    const metrics = await page.locator('#supervisor-save').evaluate(button => {
      const box = button.getBoundingClientRect(), panel = document.querySelector('.room-supervisor-modal').getBoundingClientRect();
      return { height:box.height, width:box.width, panelWidth:panel.width, bottom:box.bottom, panelBottom:panel.bottom, inputFont:parseFloat(getComputedStyle(document.querySelector('#supervisor-prompt')).fontSize) };
    });
    expect(metrics.height).toBeGreaterThanOrEqual(52);
    expect(metrics.width).toBeGreaterThan(metrics.panelWidth - 50);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.panelBottom);
    expect(metrics.inputFont).toBeGreaterThanOrEqual(16);
    await page.getByRole('button', { name: 'Save & start', exact: true }).click();
    const summary = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors`)).json();
    const taskId = summary.tasks[0].id;
    const config = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}`)).json();
    expect(config.task.targets[0]).toMatchObject({ read:true, stop:true, send:false });
    const invalid = await page.request.patch(`/api/rooms/${group.room.id}/supervisors/${taskId}`, { data: { ...config.task, targets:[{memberId:group.members[1].id, read:false, stop:true, send:false}] } });
    expect(invalid.ok()).toBe(false);
    expect((await invalid.json()).error).toContain('Stop permission requires Read');
    await page.locator('.supervisor-menu > summary').click();
    await page.getByRole('button', {name:'Edit', exact:true}).click();
    await target.locator('.supervisor-permission-open').click();
    await expect(page.locator('#supervisor-permission-send')).not.toBeChecked();
    await expect(page.locator('#supervisor-permission-stop')).toBeChecked();
  } finally { await group.cleanup(); }
});


test('supervisor editor keeps its save action and focused field above a panned keyboard viewport', async ({ page }) => {
  await mockVisualViewport(page);
  const group = await setup(page);
  try {
    await page.getByRole('button', {name:'Supervisor', exact:true}).click();
    await page.getByRole('button', {name:'＋ New', exact:true}).click();
    await page.locator('#supervisor-prompt').fill('A long prompt. '.repeat(150));
    await page.evaluate(() => window.setTestVisualViewport({height:420, offsetTop:60, scale:1}));
    await expect.poll(() => page.locator('#supervisor-save').evaluate(button => button.getBoundingClientRect().bottom)).toBeLessThanOrEqual(480);
    await expect.poll(() => page.locator('#supervisor-prompt').evaluate(field => {
      const rect=field.getBoundingClientRect(), header=document.querySelector('.room-supervisor-modal > header').getBoundingClientRect();
      const footer=document.querySelector('.supervisor-form-actions').getBoundingClientRect();
      return rect.top >= header.bottom - 1 && rect.bottom <= footer.top + 1;
    })).toBe(true);
    await expect(page.locator('#supervisor-prompt')).toHaveValue('A long prompt. '.repeat(150));
    await page.evaluate(() => window.setTestVisualViewport({height:innerHeight, offsetTop:0, scale:1}));
    await expect(page.locator('#supervisor-save')).toBeVisible();
  } finally {await group.cleanup();}
});
