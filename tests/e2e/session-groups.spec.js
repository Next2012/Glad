const { test, expect } = require('@playwright/test');

test('session groups collapse, share cards, update live, and return ungrouped sessions to the main list', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const sessions = [];
  const groups = [];
  async function createSession(name) {
    const response = await page.request.post('/api/sessions', { data: { toolKey: 'codex', name } });
    expect(response.ok()).toBe(true);
    const session = await response.json(); sessions.push(session); return session;
  }
  async function createGroup(name) {
    const response = await page.request.post('/api/rooms', { data: { name } });
    expect(response.ok()).toBe(true);
    const group = await response.json(); groups.push(group); return group;
  }
  async function add(group, session) {
    const response = await page.request.post(`/api/rooms/${group.id}/members`, { data: { sessionId: session.id } });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    return { id: result.memberId };
  }
  const mainCard = id => page.locator(`.session-standalone-list .session-card[data-session-id="${id}"]`);
  const groupSection = id => page.locator(`.session-group[data-room-id="${id}"]`);
  try {
    const independent = await createSession('Independent session');
    const shared = await createSession('Shared session');
    const member = await createSession('Group only session');
    const first = await createGroup('Session group one');
    const second = await createGroup('Session group two');
    const firstShared = await add(first, shared);
    const firstMember = await add(first, member);
    const secondShared = await add(second, shared);
    await page.goto('/', { waitUntil: 'networkidle' });
    const bar = page.locator('#session-groups-bar');
    const toggle = page.locator('#session-groups-toggle');
    await expect(mainCard(independent.id)).toBeVisible();
    await expect(mainCard(shared.id)).toHaveCount(0);
    await expect(mainCard(member.id)).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#session-groups-content')).toBeHidden();
    expect(await bar.evaluate(element => element === element.parentElement.lastElementChild)).toBe(true);
    await toggle.click();
    await groupSection(first.id).locator('.session-group-toggle').click();
    await groupSection(second.id).locator('.session-group-toggle').click();
    const sharedCards = page.locator(`#session-groups-bar .session-card[data-session-id="${shared.id}"]`);
    await expect(sharedCards).toHaveCount(2);
    await expect(sharedCards.first()).toBeVisible();
    page.once('dialog', dialog => dialog.accept('Shared renamed'));
    await sharedCards.first().getByRole('button', { name: 'Rename session' }).click();
    await expect(sharedCards.locator('.session-name')).toHaveText(['Shared renamed', 'Shared renamed']);
    await page.evaluate(() => loadSessions());
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(groupSection(first.id).locator('.session-group-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: testInfo.outputPath('session-groups.png') });

    expect((await page.request.delete(`/api/rooms/${first.id}/members/${firstShared.id}`)).ok()).toBe(true);
    await expect(groupSection(first.id).locator(`[data-session-id="${shared.id}"]`)).toHaveCount(0);
    await expect(sharedCards).toHaveCount(1);
    await expect(mainCard(shared.id)).toHaveCount(0);
    expect((await page.request.delete(`/api/rooms/${second.id}/members/${secondShared.id}`)).ok()).toBe(true);
    await expect(mainCard(shared.id)).toBeVisible();

    await toggle.click();
    const running = await page.request.post(`/api/rooms/${first.id}/messages`, { data: {
      text: '__GLAD_E2E_PLAN_HOLD__', mentionedMemberIds: [firstMember.id]
    } });
    expect(running.ok()).toBe(true);
    await expect(toggle.locator('.session-group-signal.running')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((await page.request.post(`/api/rooms/${first.id}/abort`)).ok()).toBe(true);
    await expect(toggle.locator('.session-group-signal.running')).toHaveCount(0);

    await toggle.click();
    await groupSection(first.id).getByRole('button', { name: 'Connect', exact: true }).first().click();
    await expect(page.locator('#room-view')).toBeVisible();
    expect(await page.locator('.room-action-rail > button').evaluateAll(buttons => buttons.map(button => button.id))).toEqual([
      'room-mention-button', 'room-attachment-button', 'room-schedule-send-btn',
      'room-abort-button', 'room-history-resume', 'room-history-fork'
    ]);
    await expect(page.locator('.room-header-actions #room-supervisor-open')).toBeVisible();
    await expect(page.locator('.room-header-actions #room-members-open')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('group-toolbar.png') });
    await page.locator('.room-back-button').click();
    expect((await page.request.delete(`/api/rooms/${first.id}`)).ok()).toBe(true);
    // API deletion is observed by the lobby's ten-second polling cycle.
    await expect(mainCard(member.id)).toBeVisible({ timeout: 15000 });
    await expect(groupSection(first.id)).toHaveCount(0, { timeout: 15000 });
    const history = await (await page.request.get('/api/room-history')).json();
    expect(JSON.stringify(history)).toContain(first.id);
    expect((await page.request.delete(`/api/sessions/${shared.id}`)).ok()).toBe(true);
    await page.evaluate(() => loadSessions());
    await expect(page.locator(`.session-card[data-session-id="${shared.id}"]`)).toHaveCount(0);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    for (const group of groups) await page.request.delete(`/api/rooms/${group.id}`);
    for (const session of sessions) await page.request.delete(`/api/sessions/${session.id}`);
  }
});
