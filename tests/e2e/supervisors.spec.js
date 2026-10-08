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

test('group management icons stay in the header without overlapping the title on narrow screens', async ({ page }, testInfo) => {
  const group = await setup(page);
  try {
    for (const width of testInfo.project.name === 'MacBook Pro 16' ? [1728, 320, 375] : [320, 375, 440]) {
      await page.setViewportSize({ width, height: 956 });
      await expect(page.locator('.room-header-actions #room-supervisor-open')).toBeVisible();
      await expect(page.locator('.room-header-actions #room-members-open')).toBeVisible();
      await expect(page.locator('#room-supervisor-button')).toHaveCount(0);
      const layout = await page.locator('.room-header').evaluate(header => {
        const title = header.querySelector('#room-title').getBoundingClientRect();
        const actions = header.querySelector('.room-header-actions').getBoundingClientRect();
        const back = header.querySelector('.room-back-button').getBoundingClientRect();
        return { titleWidth:title.width, left:title.left, right:title.right, actionsLeft:actions.left, actionsRight:actions.right, backRight:back.right, viewport:innerWidth };
      });
      expect(layout.titleWidth).toBeGreaterThanOrEqual(80);
      expect(layout.left).toBeGreaterThanOrEqual(layout.backRight);
      expect(layout.right).toBeLessThanOrEqual(layout.actionsLeft);
      expect(layout.actionsRight).toBeLessThanOrEqual(layout.viewport);
    }
  } finally { await group.cleanup(); }
});

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

test('custom and configured run once use explicit modes and different end scopes', async ({ page }) => {
  const group = await setup(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const configured = '__GLAD_E2E_SUPERVISOR_END__ finish this check';
    const created = await (await page.request.post(`/api/rooms/${group.room.id}/supervisors`, { data: {
      executorMemberId:group.members[0].id, targets:[{memberId:group.members[1].id, read:true}], intervalSeconds:60, prompt:configured
    } })).json();
    const taskId = created.task.id;
    await page.getByRole('button', { name:'Supervisor', exact:true }).click();
    for (const mode of ['custom', 'configured']) {
      await page.getByLabel('More supervisor actions').click();
      await expect(page.locator('[data-supervisor-run-prompt]')).toHaveValue('');
      await page.locator('[data-supervisor-run-prompt]').fill(mode === 'custom' ? configured : '');
      await page.getByRole('button', { name:'Run once now', exact:true }).click();
      await expect.poll(async () => {
        const data = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors`)).json();
        return `${data.tasks[0]?.lastRun?.kind}:${data.tasks[0]?.lastRun?.status}`;
      }, { timeout:20000 }).toBe(`${mode === 'custom' ? 'custom' : 'check'}:completed`);
      const detail = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}`)).json();
      expect(detail.task.prompt).toBe(configured);
      expect(detail.task.enabled).toBe(mode === 'custom');
      const history = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}/history`)).json();
      const run = await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${taskId}/history/${history.items[0].id}`)).json();
      expect(run.invocation.prompt).toBe(configured);
      expect(run.invocation.summary).toContain(`End scope: ${mode === 'custom' ? 'invocation' : 'task'}`);
      expect(run.invocation.calls[0].tool).toBe('end_supervision');
      await expect(page.locator('.supervisor-task')).toContainText(mode === 'custom' ? 'Checks in' : 'Paused');
    }
    const snapshot = await (await page.request.get(`/api/rooms/${group.room.id}`)).json();
    expect(snapshot.entries.some(entry => entry.text?.includes('__GLAD_E2E_SUPERVISOR_END__') || entry.text?.includes('End scope:'))).toBe(false);
    expect(snapshot.hasUnreadCompletion).toBe(false);
    expect(errors).toEqual([]);
  } finally { await group.cleanup(); }
});

test('run once preserves rejected drafts, rejects a queued run and clears it on pause', async ({ page }) => {
  const group = await setup(page);
  try {
    const configured = 'Configured recurring check';
    const created = await (await page.request.post(`/api/rooms/${group.room.id}/supervisors`, { data: {
      executorMemberId:group.members[0].id, targets:[{memberId:group.members[1].id, read:true}], intervalSeconds:60, prompt:configured
    } })).json();
    const path = `/api/rooms/${group.room.id}/supervisors/${created.task.id}`;
    await page.request.post(`/api/sessions/${group.sessions[0]}/input`, { data:{text:'__GLAD_E2E_STUCK_ABORT__ hold director'} });
    await page.getByRole('button', { name:'Supervisor', exact:true }).click();
    await page.getByLabel('More supervisor actions').click();
    await page.locator('[data-supervisor-run-prompt]').fill('Keep this rejected draft');
    const tasksURL = `/api/rooms/${group.room.id}/supervisors`;
    const before = await (await page.request.get(tasksURL)).json();
    await page.route(`**${tasksURL}`, route => route.fulfill({ json: before }));
    // A competing request queues while this form is open.
    expect((await page.request.post(`${path}/trigger`, { data:{mode:'custom', prompt:'First queued message'} })).ok()).toBe(true);
    await page.getByRole('button', { name:'Run once now', exact:true }).click();
    await expect(page.locator('[data-supervisor-run-error]')).toContainText('queued run once');
    await expect(page.locator('[data-supervisor-run-prompt]')).toHaveValue('Keep this rejected draft');
    await page.unroute(`**${tasksURL}`);
    await page.evaluate(() => loadSupervisorTasks());
    const queued = await (await page.request.get(path)).json();
    expect(queued.task.runOncePrompt).toBe('First queued message');
    await expect(page.getByRole('button', { name:'Run once now', exact:true })).toBeDisabled();
    await page.getByRole('checkbox', { name:'Enable monitoring' }).uncheck();
    await expect.poll(async () => (await (await page.request.get(path)).json()).task.runOnce).toBe(false);
    expect((await (await page.request.get(path)).json()).task.runOncePrompt).toBeUndefined();
    await expect(page.locator('[data-supervisor-run-prompt]')).toHaveValue('Keep this rejected draft');
    await page.locator('[data-supervisor-run-prompt]').fill('Actually deliver this once');
    await page.getByRole('button', { name:'Run once now', exact:true }).click();
    await expect(page.locator('.supervisor-task')).toContainText('waiting for executor');
    await page.request.post(`/api/sessions/${group.sessions[0]}/abort`, { data:{} });
    await expect.poll(async () => (await (await page.request.get(path)).json()).summary.lastRun?.status, { timeout:20000 }).toBe('completed');
    const done = await (await page.request.get(path)).json();
    expect(done.task.enabled).toBe(false);
    expect(done.task.prompt).toBe(configured);
    const run = await (await page.request.get(`${path}/history/${done.summary.lastRun.id}`)).json();
    expect(run.invocation.prompt).toBe('Actually deliver this once');
    expect(run.invocation.kind).toBe('custom');
  } finally { await group.cleanup(); }
});

test('run once preserves its custom draft when the task starts running while the form is open', async ({ page }) => {
  const group = await setup(page);
  try {
    const created = await (await page.request.post(`/api/rooms/${group.room.id}/supervisors`, { data: {
      executorMemberId:group.members[0].id, targets:[{memberId:group.members[1].id, read:true}], intervalSeconds:60, prompt:'Periodic prompt'
    } })).json();
    const path = `/api/rooms/${group.room.id}/supervisors/${created.task.id}`;
    await page.getByRole('button', { name:'Supervisor', exact:true }).click();
    await page.getByLabel('More supervisor actions').click();
    await page.locator('[data-supervisor-run-prompt]').fill('Retain my draft after the active-run error');
    const tasksURL = `/api/rooms/${group.room.id}/supervisors`;
    const before = await (await page.request.get(tasksURL)).json();
    await page.route(`**${tasksURL}`, route => route.fulfill({ json: before }));
    expect((await page.request.post(`${path}/trigger`, { data:{mode:'custom', prompt:'__GLAD_E2E_STUCK_ABORT__ competing run'} })).ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(path)).json()).summary.lastRun?.status).toBe('running');
    await page.getByRole('button', { name:'Run once now', exact:true }).click();
    await expect(page.locator('[data-supervisor-run-error]')).toContainText('active invocation');
    await expect(page.locator('[data-supervisor-run-prompt]')).toHaveValue('Retain my draft after the active-run error');
    await page.unroute(`**${tasksURL}`);
    await page.evaluate(() => loadSupervisorTasks());
    await expect(page.getByRole('button', { name:'Run once now', exact:true })).toBeDisabled();
    expect((await page.request.post(`${path}/stop`)).ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(path)).json()).summary.lastRun?.status, { timeout:15000 }).toBe('stopped');
  } finally { await group.cleanup(); }
});

test('inline cards keep input nodes, caret, drafts and keyboard access across refresh and navigation', async ({ page }) => {
  await mockVisualViewport(page);
  const group = await setup(page);
  try {
    const config = { executorMemberId:group.members[0].id, targets:[{memberId:group.members[1].id, read:true}], intervalSeconds:120, prompt:'Configured check' };
    const ids=[];
    for (let i=0;i<2;i++) ids.push((await (await page.request.post(`/api/rooms/${group.room.id}/supervisors`, { data:config })).json()).task.id);
    await page.getByRole('button', { name:'Supervisor', exact:true }).click();
    const first=page.locator(`[data-supervisor-id="${ids[0]}"]`), second=page.locator(`[data-supervisor-id="${ids[1]}"]`);
    await first.getByLabel('More supervisor actions').click();
    const input=first.locator('[data-supervisor-run-prompt]');
    await input.fill('Keep this draft while status changes');
    await input.evaluate(field => { window.inlineInputProbe=field; field.focus(); field.setSelectionRange(2,5); field.dispatchEvent(new CompositionEvent('compositionstart')); });
    const inputTop=await input.evaluate(field=>field.getBoundingClientRect().top);
    await page.request.patch(`/api/rooms/${group.room.id}/supervisors/${ids[0]}`, { data:{...config,prompt:'Updated configured check'} });
    await page.evaluate(() => loadSupervisorTasks());
    expect(await input.evaluate(field => field===window.inlineInputProbe && document.activeElement===field && field.selectionStart===2 && field.selectionEnd===5)).toBe(true);
    expect(await input.evaluate(field=>field.getBoundingClientRect().top)).toBe(inputTop);
    await expect(input).toHaveValue('Keep this draft while status changes');
    let submissions=0;
    page.on('request', request => { if (request.url().endsWith('/trigger')) submissions++; });
    await input.dispatchEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true});
    expect(submissions).toBe(0);
    await input.evaluate(field => field.dispatchEvent(new CompositionEvent('compositionend')));
    await second.getByLabel('More supervisor actions').click();
    await expect(first.locator('.supervisor-menu')).not.toHaveAttribute('open','');
    await expect(second.locator('.supervisor-menu')).toHaveAttribute('open','');
    await first.getByLabel('More supervisor actions').click();
    await expect(input).toHaveValue('Keep this draft while status changes');
    await first.getByRole('checkbox',{name:'Enable monitoring'}).uncheck();
    await expect(input).toHaveValue('Keep this draft while status changes');
    await input.fill('Keyboard draft');
    await input.focus(); await input.press('End'); await input.press('Enter');
    await expect(input).toHaveValue('Keyboard draft\n');
    await page.evaluate(() => window.setTestVisualViewport({height:520,offsetTop:40,scale:1}));
    await expect.poll(() => first.locator('[data-supervisor-run-submit]').evaluate(button => button.getBoundingClientRect().bottom)).toBeLessThanOrEqual(560);
    await input.press('Control+Enter');
    await expect(input).toHaveValue('');
    await expect(first.locator('.supervisor-menu')).not.toHaveAttribute('open','');
    expect(submissions).toBe(1);
  } finally { await group.cleanup(); }
});

test('accepted inline submit preserves a newer draft written while the request is pending', async ({ page }) => {
  const group=await setup(page);
  try {
    const created=await (await page.request.post(`/api/rooms/${group.room.id}/supervisors`,{data:{executorMemberId:group.members[0].id,targets:[{memberId:group.members[1].id,read:true}],intervalSeconds:120,prompt:'Configured'}})).json();
    await page.getByRole('button',{name:'Supervisor',exact:true}).click();
    await page.getByLabel('More supervisor actions').click();
    const input=page.locator('[data-supervisor-run-prompt]');
    await input.fill('Submitted content');
    let release;
    const hold=new Promise(resolve => {release=resolve;});
    let submitted;
    const arrived=new Promise(resolve => {submitted=resolve;});
    await page.route(`**/supervisors/${created.task.id}/trigger`,async route => {
      const response=await route.fetch(); submitted(); await hold; await route.fulfill({response});
    });
    await page.getByRole('button',{name:'Run once now',exact:true}).click();
    await arrived;
    await input.fill('New content for a later check');
    release();
    await expect(page.locator('[data-supervisor-run-reason]')).not.toContainText('Submitting');
    await expect(input).toHaveValue('New content for a later check');
    await expect(page.locator('.supervisor-menu')).toHaveAttribute('open','');
    await expect.poll(async () => (await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${created.task.id}/history`)).json()).items.length).toBeGreaterThan(0);
    const history=await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${created.task.id}/history`)).json();
    const run=await (await page.request.get(`/api/rooms/${group.room.id}/supervisors/${created.task.id}/history/${history.items[0].id}`)).json();
    expect(run.invocation.prompt).toBe('Submitted content');
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
    await expect(page.locator('#members-back')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Close members', exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: 'Back to members', exact: true }).click();
    await expect(page.locator('#room-members-home')).toBeVisible();
    await expect(page.locator('#room-members-title')).toHaveText('Group members');
    await expect(page.locator('.room-modal-overlay.active')).toHaveCount(1);
    await expect(page.locator('#members-back')).toBeHidden();
    await page.getByRole('button', { name: 'Close members', exact: true }).click();
    await expect(page.locator('#room-members-overlay')).not.toHaveClass(/active/);
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
