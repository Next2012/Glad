const { test, expect } = require('@playwright/test');

async function checkedJSON(response) {
  const data = await response.json();
  expect(response.ok(), JSON.stringify(data)).toBe(true);
  return data;
}

async function createGroup(page, name) {
  return checkedJSON(await page.request.post('/api/rooms', { data: { name } }));
}

test('only the latest question and answer per session load in full; old replies expand on demand', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const group = await createGroup(page, 'Lazy conversation history');
  const sessions = [];
  try {
    for (const name of ['Alpha', 'Beta']) {
      const session = await checkedJSON(await page.request.post('/api/sessions', {
        data: { toolKey: 'claude-code', name }
      }));
      sessions.push(session);
      await checkedJSON(await page.request.post(`/api/rooms/${group.id}/members`, { data: { sessionId: session.id } }));
      for (const text of ['__GLAD_E2E_LONG_REPLY__ old question\nline 2\nline 3\nHidden question ending', `${name} latest question\nline 2\nline 3\nLatest question ending`]) {
        await checkedJSON(await page.request.post(`/api/sessions/${session.id}/input`, { data: { text } }));
        await expect.poll(async () => (await (await page.request.get('/api/sessions')).json())
          .find(item => item.id === session.id)?.status).toBe('idle');
      }
    }
    const snapshot = await checkedJSON(await page.request.get(`/api/rooms/${group.id}`));
    expect(snapshot.entries.filter(entry => entry.defaultExpanded)).toHaveLength(4);
    expect(snapshot.entries.filter(entry => entry.textDeferred)).toHaveLength(4);
    const oldAnswer = snapshot.entries.find(entry => entry.type === 'session' && entry.textDeferred);
    expect(oldAnswer.text).not.toContain('Hidden answer ending');
    const textReads = [];
    page.on('request', request => { if (request.url().includes(`/entries/${oldAnswer.id}/text?`)) textReads.push(request.url()); });
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(id => openRoom(id), group.id);
    await expect(page.locator('#room-message-list .room-entry.expanded')).toHaveCount(4);
    await expect(page.locator('#room-message-list .room-entry.deferred')).toHaveCount(4);
    expect(textReads).toHaveLength(0);
    const old = page.locator(`[data-room-entry-id="${oldAnswer.id}"]`);
    const previewHeight = await old.locator('.room-entry-text').evaluate(text => ({ height: text.clientHeight, line: parseFloat(getComputedStyle(text).lineHeight) }));
    expect(previewHeight.height).toBeLessThanOrEqual(previewHeight.line * 3 + 1);
    await old.locator('.room-entry-bubble').click();
    await expect(old).toHaveClass(/expanded/);
    await expect(old).not.toHaveClass(/deferred/);
    await expect(old).toContainText('Hidden answer ending');
    expect(textReads.length).toBeGreaterThan(1);
    expect(await page.evaluate(() => activeRoom.entries.length)).toBe(8);
    await old.locator('.room-entry-bubble').click();
    await expect(old).not.toHaveClass(/expanded/);
    const reads = textReads.length;
    await old.locator('.room-entry-bubble').click();
    await expect(old).toContainText('Hidden answer ending');
    expect(textReads).toHaveLength(reads);
    await page.screenshot({ path: testInfo.outputPath('lazy-group-message.png') });
    // Native history gives Claude turns their persisted IDs. A same-session
    // Resume must replace those old projections instead of duplicating them.
    await checkedJSON(await page.request.post(`/api/sessions/${sessions[0].id}/claude-resume`, {
      data: { resumeSessionId: snapshot.members[0].nativeConversationId }
    }));
    await expect(page.locator('#room-message-list .room-entry')).toHaveCount(8);
    await expect(page.locator(`[data-room-entry-id="${oldAnswer.id}"]`)).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/rooms/${group.id}`);
    for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
  }
});

test('existing sessions stay available in the same open picker after each addition', async ({ page }) => {
  const group = await createGroup(page, 'Keep session picker open');
  const sessions = [];
  try {
    for (let i = 1; i <= 3; i++) sessions.push(await checkedJSON(await page.request.post('/api/sessions', {
      data: { toolKey: 'claude-code', name: `Add continuously ${i}` }
    })));
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(id => openRoom(id), group.id);
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await page.getByRole('button', { name: 'Add running session', exact: true }).click();
    const picker = page.locator('#room-session-picker');
    for (let i = 1; i <= 3; i++) {
      await picker.getByRole('button', { name: new RegExp(`Add continuously ${i}`) }).click();
      await expect(page.locator('#room-members-list .room-manage-member')).toHaveCount(i);
      await expect(picker.getByRole('button', { name: new RegExp(`Add continuously ${i}`) })).toHaveCount(0);
      await expect(page.locator('#room-members-overlay')).toHaveClass(/active/);
      if (i < 3) await expect(picker.getByRole('button', { name: new RegExp(`Add continuously ${i + 1}`) })).toBeVisible();
    }
    await expect(picker).toContainText('Every running session is already in this group.');
  } finally {
    await page.request.delete(`/api/rooms/${group.id}`);
    for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
  }
});

test('resuming a loaded session replaces history and allows loading earlier pages again', async ({ page }) => {
  test.setTimeout(60000);
  const group = await createGroup(page, 'History after Resume');
  const session = await checkedJSON(await page.request.post('/api/sessions', {
    data: { toolKey: 'claude-code', name: 'History source' }
  }));
  try {
    await checkedJSON(await page.request.post(`/api/rooms/${group.id}/members`, { data: { sessionId: session.id } }));
    for (let i = 0; i < 28; i++) {
      await checkedJSON(await page.request.post(`/api/sessions/${session.id}/input`, { data: { text: `Question ${i}` } }));
      await expect.poll(async () => (await (await page.request.get('/api/sessions')).json())
        .find(item => item.id === session.id)?.status).toBe('idle');
    }
    const snapshot = await checkedJSON(await page.request.get(`/api/rooms/${group.id}`));
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.evaluate(id => openRoom(id), group.id);
    const entries = page.locator('#room-message-list > .room-entry');
    await expect(entries).toHaveCount(48);
    await page.locator('#room-message-list').evaluate(list => list.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(entries).toHaveCount(56);
    await expect.poll(() => page.evaluate(() => activeRoom.hasBefore)).toBe(false);
    await checkedJSON(await page.request.post(`/api/sessions/${session.id}/claude-resume`, {
      data: { resumeSessionId: snapshot.members[0].nativeConversationId }
    }));
    await expect(entries).toHaveCount(48);
    await expect.poll(() => page.evaluate(() => activeRoom.hasBefore)).toBe(true);
    await page.locator('#room-message-list').evaluate(list => list.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(entries).toHaveCount(56);
    await expect.poll(() => page.evaluate(() => activeRoom.hasBefore)).toBe(false);
  } finally {
    await page.request.delete(`/api/rooms/${group.id}`);
    await page.request.delete(`/api/sessions/${session.id}`);
  }
});
