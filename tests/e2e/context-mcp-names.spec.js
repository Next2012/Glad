const { test, expect } = require('@playwright/test');

async function checkedJSON(response) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function createSession(page, toolKey, name) {
  return checkedJSON(await page.request.post('/api/sessions', { data: { toolKey, name } }));
}

async function createGroup(page, name) {
  return checkedJSON(await page.request.post('/api/rooms', { data: { name } }));
}

async function addMember(page, group, session) {
  return checkedJSON(await page.request.post(`/api/rooms/${group.id}/members`, {
    data: { sessionId: session.id }
  }));
}

async function getGroup(page, groupId) {
  return checkedJSON(await page.request.get(`/api/rooms/${groupId}`));
}

async function waitForIdle(page, sessionId) {
  await expect.poll(async () => {
    const sessions = await (await page.request.get('/api/sessions')).json();
    return sessions.find(session => session.id === sessionId)?.status;
  }).toBe('idle');
}

async function deleteFixtures(page, groups, sessions) {
  for (const group of groups) await page.request.delete(`/api/rooms/${group.id}`);
  for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
}

test('Claude group member queries real MCP summaries, details and C to B to A references', async ({ page }) => {
  test.setTimeout(60000);
  const group = await createGroup(page, 'Context MCP validation');
  const sessions = [];
  try {
    const worker = await createSession(page, 'claude-code', 'Worker');
    sessions.push(worker);
    const reader = await createSession(page, 'claude-code', 'Reader');
    sessions.push(reader);
    const workerMember = await addMember(page, group, worker);
    const readerMember = await addMember(page, group, reader);
    const send = async (text, memberId, sessionId, quotedEntryIds = []) => {
      await checkedJSON(await page.request.post(`/api/rooms/${group.id}/messages`, {
        data: { text, mentionedMemberIds: [memberId], quotedEntryIds }
      }));
      await waitForIdle(page, sessionId);
      const snapshot = await getGroup(page, group.id);
      return snapshot.entries.filter(entry => entry.type === 'session' && entry.memberId === memberId).at(-1);
    };
    const a = await send('A: establish architecture', workerMember.memberId, worker.id);
    const b = await send('B: review the previous decision', workerMember.memberId, worker.id, [a.id]);
    const c = await send('__GLAD_E2E_GROUP_QUERY__ C: inspect context', readerMember.memberId, reader.id, [b.id]);
    const prefix = 'GROUP_MCP_RESULT ';
    expect(c.text).toContain(prefix);
    const result = JSON.parse(c.text.slice(c.text.indexOf(prefix) + prefix.length));
    expect(result.summaries.turns).toHaveLength(2);
    expect(result.summaries.turns.every(turn => turn.sessionName === 'Worker')).toBe(true);
    expect(result.details.details).toHaveLength(2);
    expect(result.details.details[0].text).toContain('A: establish architecture');
    expect(result.references.nodes.some(node => node.entryId === a.id && node.available)).toBe(true);
    expect(result.references.nodes.some(node => node.entryId === b.id && node.triggerEntryId)).toBe(true);
    expect(result.references.nodes.some(node => node.quotedEntryIds?.includes(a.id))).toBe(true);
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(id => openRoom(id), group.id);
    await expect(page.locator('#room-view')).toBeVisible();
    await expect(page.locator('#room-message-list')).toContainText(prefix);
  } finally {
    await deleteFixtures(page, [group], sessions);
  }
});

test('Claude rename, individual resume, group resume and fork share session-owned names', async ({ page }) => {
  test.setTimeout(60000);
  const groups = [], sessions = [];
  try {
    const original = await createSession(page, 'claude-code', 'Original');
    sessions.push(original);
    await checkedJSON(await page.request.post(`/api/sessions/${original.id}/input`, {
      data: { text: 'Persist a Claude conversation' }
    }));
    await waitForIdle(page, original.id);
    const first = await createGroup(page, 'Name source');
    groups.push(first);
    await addMember(page, first, original);
    const native = (await getGroup(page, first.id)).members[0].nativeConversationId;
    expect(native).toMatch(/^[0-9a-f-]{36}$/);
    await checkedJSON(await page.request.patch(`/api/sessions/${original.id}`, {
      data: { name: 'Canonical renamed' }
    }));
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(session => joinSession(session.id, 'Stale window title', 'claude-code'), original);
    await expect(page.locator('#session-title')).toHaveText('Canonical renamed');
    await checkedJSON(await page.request.patch(`/api/sessions/${original.id}`, {
      data: { name: 'Renamed while connected' }
    }));
    await expect(page.locator('#session-title')).toHaveText('Renamed while connected');

    // Force reconstruction rather than reusing a live session.
    await page.request.delete(`/api/sessions/${original.id}`);
    const target = await createSession(page, 'claude-code', 'Temporary window');
    sessions.push(target);
    await checkedJSON(await page.request.post(`/api/sessions/${target.id}/claude-resume`, {
      data: { resumeSessionId: native }
    }));
    await expect.poll(async () => {
      const list = await (await page.request.get('/api/sessions')).json();
      return list.find(session => session.id === target.id)?.name;
    }).toBe('Renamed while connected');
    await page.request.delete(`/api/sessions/${target.id}`);

    const resumed = await createGroup(page, 'Resume target');
    groups.push(resumed);
    await checkedJSON(await page.request.post(`/api/rooms/${resumed.id}/resume`, {
      data: { sourceRoomId: first.id }
    }));
    const restored = (await getGroup(page, resumed.id)).members[0];
    sessions.push({ id: restored.sessionId });
    expect(restored.displayName).toBe('Renamed while connected');

    const forked = await createGroup(page, 'Fork target');
    groups.push(forked);
    await checkedJSON(await page.request.post(`/api/rooms/${forked.id}/fork`, {
      data: { sourceRoomId: first.id }
    }));
    await expect.poll(async () => (await getGroup(page, forked.id)).members[0]?.displayName)
      .toBe('Renamed while connected');
    const forkMember = (await getGroup(page, forked.id)).members[0];
    sessions.push({ id: forkMember.sessionId });
    await checkedJSON(await page.request.patch(`/api/sessions/${forkMember.sessionId}`, {
      data: { name: 'Fork owns this name' }
    }));
    expect((await getGroup(page, resumed.id)).members[0].displayName).toBe('Renamed while connected');
  } finally {
    await deleteFixtures(page, groups, sessions);
  }
});

test('supervisor wake reads sparse monitor turns through the real MCP process', async ({ page }) => {
  test.setTimeout(60000);
  const group = await createGroup(page, 'Monitor turns');
  const sessions = [];
  try {
    const director = await createSession(page, 'codex', 'Director');
    sessions.push(director);
    const worker = await createSession(page, 'claude-code', 'Monitor');
    sessions.push(worker);
    const directorMember = await addMember(page, group, director);
    const workerMember = await addMember(page, group, worker);
    for (let i = 1; i <= 3; i++) {
      await checkedJSON(await page.request.post(`/api/sessions/${worker.id}/input`, {
        data: { text: `Monitor round ${i}` }
      }));
      await waitForIdle(page, worker.id);
    }
    const created = await checkedJSON(await page.request.post(`/api/rooms/${group.id}/supervisors`, {
      data: {
        executorMemberId: directorMember.memberId,
        targets: [{ memberId: workerMember.memberId, read: true, send: false, stop: false }],
        intervalSeconds: 120,
        prompt: '__GLAD_E2E_SUPERVISOR__ __GLAD_E2E_TURN_QUERY__'
      }
    }));
    const taskPath = `/api/rooms/${group.id}/supervisors/${created.task.id}`;
    await checkedJSON(await page.request.post(`${taskPath}/trigger`, { data: { mode: 'configured' } }));
    await expect.poll(async () => (await (await page.request.get(taskPath)).json()).summary.lastRun?.status,
      { timeout: 20000 }).toBe('completed');
    const history = await (await page.request.get(`${taskPath}/history`)).json();
    const detail = await (await page.request.get(`${taskPath}/history/${history.items[0].id}`)).json();
    expect(detail.invocation.calls.filter(call => call.success).map(call => call.tool)).toEqual([
      'list_targets', 'read_session', 'session_turns', 'session_turn_details'
    ]);
  } finally {
    await deleteFixtures(page, [group], sessions);
  }
});
