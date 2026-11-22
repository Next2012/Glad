const { test, expect } = require('@playwright/test');

const SESSION = 'agy-subagent-view-harness';
const PARENT = '11111111-1111-4111-8111-111111111111';
const NEXT_PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEXT_CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const API = `/api/sessions/${SESSION}/antigravity-subagents`;
const overviewSelector = '#antigravity-subagents .antigravity-subagent-overview';
const cardSelector = id => `#antigravity-subagents [data-agy-subagent-id="${id}"]`;

async function evidence(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled', scale: 'css' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

function item(id = CHILD, revision = 'native-revision-1', extra = {}) {
  return { id, parentId: PARENT, name: 'Native research worker', role: 'research', taskSummary: 'Inspect the recorded child transcript.', nativeStatus: 'SUBAGENT_STATE_ALIVE', activity: 'unknown', lastActivityAt: 1795320000000, revision, hasTranscript: true, depth: 1, ...extra };
}
function nativeMessage(id, kind, text, offset, extra = {}) {
  return { id, kind, text, threadId: CHILD, turnId: 'native-log', isRootTurn: false, streaming: false, nativeOffset: offset, nativePart: 0, createdAt: 1795320000000 + offset, timeSource: 'native', ...extra };
}
function baseHistory() {
  return [
    nativeMessage('child-user', 'user', 'Recorded child instruction', 100),
    nativeMessage('child-thinking', 'reasoning', 'Native child reasoning remains collapsed.', 110),
    nativeMessage('child-tool', 'tool', 'Native file read result.', 120, { title: 'Read source.go', name: 'read_file', providerId: 'native-child-tool', toolStatus: 'completed', status: 'completed', input: { path: 'source.go' } }),
    nativeMessage('child-answer', 'assistant', 'Stable child conclusion.\n\n```mermaid\nflowchart TD\nA[Inspect] --> B[Summarize]\n```', 130)
  ];
}
function directory(parent, items, revision = 'directory-1') {
  return { success: true, parentSessionId: parent, historyOnly: true, items, revision, warnings: [] };
}
function history(parent, child, messages, nextBefore = '') {
  return { success: true, parentSessionId: parent, sessionId: child, historyOnly: true, transcriptEpoch: 'native-file-epoch', messages, nextBefore, hasMore: Boolean(nextBefore), warnings: [] };
}
async function openOverview(page, count) {
  const overview = page.locator(overviewSelector);
  await expect(overview).toBeVisible();
  await expect(overview).not.toHaveAttribute('open', '');
  await expect(overview.locator(':scope > summary')).toContainText(`Native subagents (${count})`);
  await expect(overview.locator(':scope > summary')).toContainText('read-only');
  await overview.locator(':scope > summary').click();
  await expect(overview).toHaveAttribute('open', '');
}
async function openHarness(page, parent = PARENT, longParent = false) {
  await page.addInitScript(() => {
    localStorage.setItem('glad-theme', 'light');
    const originalFetch = window.fetch;
    window.__subagentAborts = [];
    window.fetch = function (input, options) {
      const url = typeof input === 'string' ? input : input.url;
      if (url?.includes('/antigravity-subagents') && options?.signal) options.signal.addEventListener('abort', () => window.__subagentAborts.push(url), { once: true });
      return originalFetch.call(window, input, options);
    };
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(({ session, parent, longParent }) => {
    window.gladAntigravitySubagents.reset();
    activeSessionId = session;
    activeToolKey = 'antigravity';
    activeSessionHydrated = true;
    antigravityPendingPermissions = [];
    antigravitySettingsPending = false;
    antigravityResumePending = false;
    antigravityMessages = [...(longParent ? Array.from({ length: 18 }, (_, index) => ({ id: `parent-earlier-${index}`, kind: 'assistant', text: `Earlier parent message ${index + 1}. ` + 'Recorded work remains in the parent conversation. '.repeat(12) })) : []), { id: 'parent-answer', kind: 'assistant', text: 'Parent conversation stays independent of native child history.' }];
    antigravityState = { ...createDefaultAntigravityState(), status: 'idle', nativeConversationId: parent, antigravitySessionId: parent, threadId: parent };
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    window.__subagentFrames = [];
    currentSocket = { readyState: WebSocket.OPEN, send: value => window.__subagentFrames.push(JSON.parse(value)) };
    setClaudeModeEnabled(false);
    applyAntigravityState(antigravityState);
    handleComposerSocketOpen();
  }, { session: SESSION, parent, longParent });
}
async function resetHarness(page) {
  await page.evaluate(() => { document.getElementById('terminal-view').classList.remove('active'); window.gladAntigravitySubagents.reset(); }).catch(() => {});
}

// The API is mocked at the read-only boundary. Rendering, native disclosures,
// visibility ownership, request cancellation and the actual AGY shell are real.
test('native subagent directory is lazy, honest about ALIVE, read-only and bounded on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = [];
  await page.route(`**${API}**`, async route => {
    const url = new URL(route.request().url());
    calls.push({ method: route.request().method(), path: url.pathname });
    if (url.pathname === API) return route.fulfill({ json: directory(PARENT, [
      item(CHILD, 'r1', { name: 'Native worker with a deliberately long task name that must wrap inside a narrow phone viewport' }),
      item(NEXT_CHILD, 'missing', { name: 'Known remote child', hasTranscript: false, depth: 2 }),
      ...Array.from({ length: 7 }, (_, index) => item(`cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, '0')}`, `extra-${index}`, { name: `Recorded child ${index + 3}`, nativeStatus: 'SUBAGENT_STATE_TERMINATED', activity: 'terminated' }))
    ]) });
    return route.fulfill({ json: history(PARENT, CHILD, baseHistory()) });
  });
  try {
    await openHarness(page, PARENT, true);
    const card = page.locator(cardSelector(CHILD));
    const missing = page.locator(cardSelector(NEXT_CHILD));
    await expect(page.locator('#antigravity-subagents .antigravity-subagent-group')).toHaveCount(9);
    const overview = page.locator(overviewSelector);
    await expect(overview).not.toHaveAttribute('open', '');
    expect(calls.filter(call => call.path !== API)).toHaveLength(0);
    await expect(page.locator('#antigravity-chat-container [data-agy-key="message-parent-answer"]')).toBeInViewport();
    const pinned = await page.locator('#antigravity-chat-container').evaluate(element => ({ scrollable: element.scrollHeight > element.clientHeight + 50, gap: element.scrollHeight - element.scrollTop - element.clientHeight }));
    expect(pinned.scrollable).toBe(true);
    expect(pinned.gap).toBeLessThanOrEqual(4);
    await evidence(page, testInfo, 'nine-native-subagents-overview-collapsed');
    await openOverview(page, 9);
    await expect(card).not.toHaveAttribute('open', '');
    await expect(card.locator('.antigravity-subagent-state')).toHaveText('Alive · activity unknown');
    expect(calls.filter(call => call.path !== API)).toHaveLength(0);
    await missing.locator(':scope > summary').click();
    await expect(missing.locator('.antigravity-subagent-note')).toContainText('transcript is not available');
    expect(calls.filter(call => call.path !== API)).toHaveLength(0);
    await missing.locator(':scope > summary').click();
    await card.locator(':scope > summary').click();
    await expect(card.locator('.antigravity-subagent-history')).toContainText('Recorded child instruction');
    await expect(card.locator('.antigravity-subagent-history')).toContainText('Stable child conclusion.');
    const work = card.locator('.antigravity-work-group');
    await expect(work).toHaveCount(1);
    await expect(work).not.toHaveAttribute('open', '');
    await expect(work.locator('.antigravity-reasoning')).not.toBeVisible();
    await expect(work.locator('.antigravity-tool')).not.toBeVisible();
    await expect(card.getByRole('button', { name: /^(send|stop|abort|interrupt|approve|deny|reject)(\s|$)/i })).toHaveCount(0);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.filter(call => call.path !== API)).toHaveLength(1);
    const bounds = await card.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.overflow).toBe(false);
    expect(await page.evaluate(() => window.__subagentFrames)).toEqual([]);
    await evidence(page, testInfo, 'native-subagent-read-only-phone');
  } finally { await resetHarness(page); }
});

test('native revision append and older paging retain child Source, selection and unique message nodes', async ({ page }, testInfo) => {
  let revision = 1;
  let olderRequests = 0;
  let childRequests = 0;
  await page.route(`**${API}**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === API) return route.fulfill({ json: directory(PARENT, [item(CHILD, `r${revision}`)], `directory-${revision}`) });
    childRequests++;
    if (url.searchParams.has('before')) {
      olderRequests++;
      expect(url.searchParams.get('before')).toBe('earlier-native-page');
      return route.fulfill({ json: history(PARENT, CHILD, [nativeMessage('old-user', 'user', 'Earlier native instruction', 10), nativeMessage('old-answer', 'assistant', 'Earlier native answer', 20), baseHistory().at(-1)]) });
    }
    const messages = baseHistory();
    if (revision > 1) messages.push(nativeMessage('child-appended', 'assistant', 'A new native conclusion was appended.', 140));
    return route.fulfill({ json: history(PARENT, CHILD, messages, 'earlier-native-page') });
  });
  try {
    await openHarness(page);
    await expect(page.locator(overviewSelector)).toBeVisible();
    expect(childRequests).toBe(0);
    await openOverview(page, 1);
    const card = page.locator(cardSelector(CHILD));
    await expect(card).toBeVisible();
    await card.locator(':scope > summary').click();
    const answer = card.locator('[data-agy-key="message-child-answer"]');
    await expect(answer).toBeVisible();
    const source = answer.locator('.markdown-diagram-source');
    await expect(source).toHaveCount(1);
    await source.locator(':scope > summary').click();
    await expect(source).toHaveAttribute('open', '');
    await answer.evaluate(element => {
      window.__subagentStableNode = element;
      const paragraph = element.querySelector('.claude-md p');
      window.__subagentStableText = paragraph.firstChild;
      const range = document.createRange(); range.selectNodeContents(paragraph);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.__subagentSelection = selection.toString();
    });
    revision = 2;
    await page.evaluate(() => window.gladAntigravitySubagents.refresh());
    await expect(card.locator('[data-agy-key="message-child-appended"]')).toBeVisible();
    await expect(page.locator(overviewSelector)).toHaveAttribute('open', '');
    await expect(source).toHaveAttribute('open', '');
    expect(await answer.evaluate(element => ({ node: element === window.__subagentStableNode, text: element.querySelector('.claude-md p').firstChild === window.__subagentStableText, selection: getSelection().toString() === window.__subagentSelection }))).toEqual({ node: true, text: true, selection: true });
    await card.getByRole('button', { name: 'Load earlier records', exact: true }).click();
    await expect(card.locator('[data-agy-key="message-old-answer"]')).toBeVisible();
    expect(olderRequests).toBe(1);
    await expect(answer).toHaveCount(1);
    await expect(card.locator('[data-agy-key="message-child-appended"]')).toHaveCount(1);
    expect(await card.locator('.codex-message-block').evaluateAll(nodes => nodes.map(node => node.dataset.agyKey))).toEqual(['message-old-user', 'message-old-answer', 'message-child-user', 'message-child-answer', 'message-child-appended']);
    await expect(card.getByRole('button', { name: 'Load earlier records', exact: true })).toBeHidden();
    await expect(source).toHaveAttribute('open', '');
    expect(await page.evaluate(() => antigravityMessages.map(message => message.id))).toEqual(['parent-answer']);
    await evidence(page, testInfo, 'native-subagent-appended-history');
  } finally { await resetHarness(page); }
});

test('changing native root or hiding its view aborts child reads and rejects late old responses', async ({ page }, testInfo) => {
  let parent = PARENT;
  let releaseOld, releaseHidden;
  const oldHold = new Promise(resolve => { releaseOld = resolve; });
  const hiddenHold = new Promise(resolve => { releaseHidden = resolve; });
  let oldStarted = false, hiddenStarted = false, oldSettled = false, hiddenSettled = false, nextReads = 0;
  await page.route(`**${API}**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === API) return route.fulfill({ json: directory(parent, [item(parent === PARENT ? CHILD : NEXT_CHILD, parent, { parentId: parent })]) });
    const child = url.pathname.split('/').at(-1);
    if (child === CHILD) {
      oldStarted = true;
      await oldHold;
      await route.fulfill({ json: history(PARENT, CHILD, [nativeMessage('stale-old', 'assistant', 'STALE OLD ROOT CONTENT', 1)]) }).catch(() => {});
      oldSettled = true; return;
    }
    nextReads++;
    if (nextReads === 1) {
      hiddenStarted = true;
      await hiddenHold;
      await route.fulfill({ json: history(NEXT_PARENT, NEXT_CHILD, [nativeMessage('stale-hidden', 'assistant', 'STALE HIDDEN VIEW CONTENT', 1)]) }).catch(() => {});
      hiddenSettled = true; return;
    }
    return route.fulfill({ json: history(NEXT_PARENT, NEXT_CHILD, [nativeMessage('fresh-next', 'assistant', 'Fresh current native child content.', 1, { threadId: NEXT_CHILD })]) });
  });
  try {
    await openHarness(page);
    await expect(page.locator(overviewSelector)).toBeVisible();
    expect(oldStarted).toBe(false);
    await openOverview(page, 1);
    await page.locator(`${cardSelector(CHILD)} > summary`).click();
    await expect.poll(() => oldStarted).toBe(true);
    parent = NEXT_PARENT;
    await page.evaluate(parent => applyAntigravityState({ nativeConversationId: parent, antigravitySessionId: parent, threadId: parent }), NEXT_PARENT);
    await expect(page.locator(cardSelector(CHILD))).toHaveCount(0);
    await expect(page.locator(cardSelector(NEXT_CHILD))).toHaveCount(1);
    await expect(page.locator(overviewSelector)).not.toHaveAttribute('open', '');
    expect(hiddenStarted).toBe(false);
    await openOverview(page, 1);
    await expect(page.locator(cardSelector(NEXT_CHILD))).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__subagentAborts.some(url => url.includes('/aaaaaaaa-')))).toBe(true);
    releaseOld();
    await expect.poll(() => oldSettled).toBe(true);
    await expect(page.locator('#antigravity-chat-container')).not.toContainText('STALE OLD ROOT CONTENT');
    await page.locator(`${cardSelector(NEXT_CHILD)} > summary`).click();
    await expect.poll(() => hiddenStarted).toBe(true);
    await page.evaluate(() => document.getElementById('terminal-view').classList.remove('active'));
    await expect(page.locator('#antigravity-subagents')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__subagentAborts.some(url => url.includes('/bbbbbbbb-')))).toBe(true);
    releaseHidden();
    await expect.poll(() => hiddenSettled).toBe(true);
    await page.evaluate(() => document.getElementById('terminal-view').classList.add('active'));
    const next = page.locator(cardSelector(NEXT_CHILD));
    await expect(page.locator(overviewSelector)).toBeVisible();
    await expect(page.locator(overviewSelector)).not.toHaveAttribute('open', '');
    expect(nextReads).toBe(1);
    await openOverview(page, 1);
    await expect(next).toBeVisible();
    await expect(next).not.toHaveAttribute('open', '');
    await expect(page.locator('#antigravity-chat-container')).not.toContainText('STALE HIDDEN VIEW CONTENT');
    await next.locator(':scope > summary').click();
    await expect(next.locator('.antigravity-subagent-history')).toContainText('Fresh current native child content.');
    await expect(page.locator('#antigravity-chat-container')).not.toContainText('STALE OLD ROOT CONTENT');
    await expect(page.locator('#antigravity-chat-container')).not.toContainText('STALE HIDDEN VIEW CONTENT');
    expect(await page.evaluate(() => window.__subagentFrames)).toEqual([]);
    await evidence(page, testInfo, 'native-subagent-root-ownership');
  } finally { releaseOld(); releaseHidden(); await resetHarness(page); }
});

test('a dense first native page keeps the newest bounded window and can move earlier or refresh', async ({ page }) => {
  const latest = Array.from({ length: 650 }, (_, index) => nativeMessage(`dense-${index}`, 'event', `Dense native record ${index}`, index));
  const older = Array.from({ length: 30 }, (_, index) => nativeMessage(`older-${index}`, 'event', `Earlier native record ${index}`, index - 30));
  let latestReads = 0, olderReads = 0;
  await page.route(`**${API}**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === API) return route.fulfill({ json: directory(PARENT, [item()]) });
    if (url.searchParams.get('before')) { olderReads++; return route.fulfill({ json: history(PARENT, CHILD, older) }); }
    latestReads++;
    return route.fulfill({ json: history(PARENT, CHILD, latest, 'earlier-records') });
  });
  try {
    await openHarness(page);
    await openOverview(page, 1);
    const card = page.locator(cardSelector(CHILD));
    await card.locator(':scope > summary').click();
    const records = card.locator('.antigravity-subagent-history [data-agy-key^="message-"]');
    await expect(records).toHaveCount(600);
    await expect(records.first()).toHaveAttribute('data-agy-key', 'message-dense-50');
    await expect(records.last()).toHaveAttribute('data-agy-key', 'message-dense-649');
    await expect(card.locator('.antigravity-subagent-note')).toContainText('newest 600 messages; 50 earlier messages were omitted');
    await expect(card.locator('.antigravity-subagent-note')).toContainText('Load earlier records');
    const before = card.locator('[data-agy-subagent-before]');
    await expect(before).toBeVisible();
    await before.click();
    await expect(records).toHaveCount(600);
    await expect(records.first()).toHaveAttribute('data-agy-key', 'message-older-0');
    await expect(records.last()).toHaveAttribute('data-agy-key', 'message-dense-619');
    await expect(card.locator('.antigravity-subagent-note')).toContainText('earlier 600 messages; 30 newer messages were omitted');
    await expect(before).toBeHidden();
    expect(olderReads).toBe(1);
    await card.locator('[data-agy-subagent-refresh]').click();
    await expect(records).toHaveCount(600);
    await expect(records.first()).toHaveAttribute('data-agy-key', 'message-dense-50');
    await expect(records.last()).toHaveAttribute('data-agy-key', 'message-dense-649');
    await expect(before).toBeVisible();
    expect(latestReads).toBe(2);
  } finally { await resetHarness(page); }
});
