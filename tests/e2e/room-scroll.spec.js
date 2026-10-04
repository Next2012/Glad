const { test, expect } = require('@playwright/test');
const { mockVisualViewport } = require('./helpers/visual-viewport');

function roomSnapshot() {
  return {
    id: 'scroll-room', historyId: 'scroll-history', name: 'Scroll regression', snapshotRevision: 1,
    members: [{ id: 'reviewer', displayName: 'Reviewer', toolKey: 'codex', toolName: 'Codex', status: 'running', available: true }],
    entries: Array.from({ length: 48 }, (_, index) => ({
      id: `entry-${index}`, sequence: index + 1, type: index % 2 ? 'session' : 'user',
      memberId: index % 2 ? 'reviewer' : undefined, status: index === 47 ? 'running' : 'completed',
      createdAt: 1700000000000 + index * 1000,
      text: `Message ${index + 1}\n\n` + `Paragraph ${index + 1} contains enough detail to span several lines and exercise folding.\n\n`.repeat(12)
    }))
  };
}

async function openScrollingRoom(page) {
  const room = roomSnapshot();
  let socket;
  await page.route('**/api/rooms/scroll-room', route => route.fulfill({ json: room }));
  await page.routeWebSocket('**/ws/rooms?roomId=scroll-room', ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'room-snapshot', room, timedInputs: [] }));
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(() => openRoom('scroll-room'));
  await expect(page.locator('#room-message-list .room-entry')).toHaveCount(48);
  await expect.poll(() => Boolean(socket)).toBe(true);
  return {
    room,
    async update(change) {
      change(room);
      room.snapshotRevision++;
      socket.send(JSON.stringify({ type: 'room-snapshot', room, timedInputs: [] }));
      await expect.poll(() => page.evaluate(() => activeRoom.snapshotRevision)).toBe(room.snapshotRevision);
    }
  };
}

async function readingPosition(page) {
  return page.locator('#room-message-list').evaluate(list => {
    const top = list.getBoundingClientRect().top;
    const entry = [...list.children].find(element => element.getBoundingClientRect().bottom > top);
    return { id: entry.dataset.roomEntryId, offset: entry.getBoundingClientRect().top - top, scrollTop: list.scrollTop };
  });
}

async function readMiddle(page) {
  await page.locator('#room-message-list').evaluate(list => {
    list.scrollTo({ top: (list.scrollHeight - list.clientHeight) * .6, behavior: 'instant' });
    window.scrollProbeEntry = [...list.children].find(entry => entry.getBoundingClientRect().top > list.getBoundingClientRect().top + 40);
  });
  return readingPosition(page);
}

async function expectSamePosition(page, before) {
  await expect.poll(() => readingPosition(page)).toEqual(before);
  // Detect delayed folding, smooth scrolling, or a stale animation callback.
  await page.waitForTimeout(250);
  expect(await readingPosition(page)).toEqual(before);
}

test('multiple references preserve message nodes, focus, expansion and reading position', async ({ page }) => {
  await openScrollingRoom(page);
  await readMiddle(page);
  const entryId = await page.evaluate(() => scrollProbeEntry.dataset.roomEntryId);
  const entry = page.locator(`[data-room-entry-id="${entryId}"]`);
  await entry.locator('.room-entry-bubble').click();
  await expect(entry).toHaveClass(/expanded/);
  const before = await readingPosition(page);
  await entry.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await page.waitForTimeout(650);
  await entry.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await expectSamePosition(page, before);
  await expect(page.locator('.room-context-chip.quote')).toHaveCount(1);
  expect(await page.evaluate(() => scrollProbeEntry.isConnected && scrollProbeEntry.querySelector('.room-entry-bubble').isConnected)).toBe(true);
  await expect(entry).toHaveClass(/expanded/);

  // Use the next visible message without asking Playwright to scroll it into view.
  await page.evaluate(() => scrollProbeEntry.nextElementSibling.querySelector('.room-selection-circle').click());
  await expectSamePosition(page, before);
  await expect(page.locator('.room-context-chip.quote')).toHaveCount(2);
  await page.locator('.room-context-chip.quote').first().click();
  await expectSamePosition(page, before);
  await expect(page.locator('.room-context-chip.quote')).toHaveCount(1);
});

test('selection captures author clicks, keeps zero selections, and cancel preserves the draft', async ({ page }) => {
  const stream = await openScrollingRoom(page);
  await readMiddle(page);
  const entryId = await page.evaluate(() => scrollProbeEntry.dataset.roomEntryId);
  const entry = page.locator(`[data-room-entry-id="${entryId}"]`);
  await page.locator('#room-input').fill('Keep this draft');
  await entry.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await page.waitForTimeout(650);
  await entry.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 20, clientY: 20 });
  await expect(entry).toHaveClass(/selected/);
  await entry.locator('.room-entry-author').click();
  await expect(entry).not.toHaveClass(/selected/);
  await expect(page.locator('#room-selection-count')).toHaveText('0 selected');
  await expect(page.locator('#room-selection-preview')).toBeDisabled();
  await expect(page.locator('#room-selection-cancel')).toBeVisible();
  await entry.locator('.room-entry-author').click();
  await expect(entry).toHaveClass(/selected/);
  await stream.update(room => { room.entries.push({ id: 'new-live-message', type: 'user', status: 'completed', text: 'A new message', createdAt: Date.now() }); });
  await expect(page.locator('[data-room-entry-id="new-live-message"] .room-selection-circle')).toBeVisible();
  await page.locator('#room-selection-cancel').click();
  await expect(page.locator('#room-view')).not.toHaveClass(/room-selecting/);
  await expect(page.locator('#room-input')).toHaveValue('Keep this draft');
  await expect(page.locator('.room-context-chip.quote')).toHaveCount(0);
});

test('streamed snapshots keep history still and preserve anchors when earlier content changes', async ({ page }) => {
  const stream = await openScrollingRoom(page);
  await readMiddle(page);
  const entryId = await page.evaluate(() => scrollProbeEntry.dataset.roomEntryId);
  await page.locator(`[data-room-entry-id="${entryId}"] .room-entry-bubble`).click();
  await page.evaluate(() => { window.scrollProbeBubble = scrollProbeEntry.querySelector('.room-entry-bubble'); });
  const before = await readingPosition(page);
  for (let i = 0; i < 6; i++) {
    await stream.update(room => { room.entries.at(-1).text += `\n\nStreaming paragraph ${i}`; });
    await expectSamePosition(page, before);
    expect(await page.evaluate(() => scrollProbeEntry.isConnected)).toBe(true);
    expect(await page.evaluate(() => scrollProbeBubble.isConnected)).toBe(true);
  }
  await stream.update(room => { room.entries[0].text = 'Shortened earlier message'; });
  const after = await readingPosition(page);
  expect(after.id).toBe(before.id);
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
  expect(after.scrollTop).toBeLessThan(before.scrollTop);
  await stream.update(room => { room.entries.unshift({ ...room.entries[0], id: 'inserted-history', text: 'Inserted historical message' }); });
  const inserted = await readingPosition(page);
  expect(inserted.id).toBe(before.id);
  expect(Math.abs(inserted.offset - before.offset)).toBeLessThan(1);
});

test('following the bottom works and manual scrolling immediately stops following', async ({ page }) => {
  const stream = await openScrollingRoom(page);
  await page.locator('[data-room-entry-id="entry-47"] .room-entry-bubble').click();
  await page.locator('#room-message-list').evaluate(list => list.scrollTo({ top: list.scrollHeight, behavior: 'instant' }));
  for (let i = 0; i < 6; i++) {
    await stream.update(room => { room.entries.at(-1).text += '\n\nAnother paragraph in the expanded live response. '.repeat(5); });
    await expect.poll(() => page.locator('#room-message-list').evaluate(list => list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThan(2);
  }
  const before = await readMiddle(page);
  await stream.update(room => { room.entries.at(-1).text += '\n\nAn update after scrolling away'; });
  await expectSamePosition(page, before);
});

test('revision-only events retain rendered diagrams and message nodes', async ({ page }) => {
  const stream = await openScrollingRoom(page);
  const original = await readMiddle(page);
  await stream.update(room => { room.entries[1].text = '```mermaid\ngraph TD\n A[Start] --> B[Finish]\n```'; });
  await expect(page.locator('[data-room-entry-id="entry-1"] .markdown-diagram-output svg')).toBeVisible();
  const before = await readingPosition(page);
  expect(before.id).toBe(original.id);
  expect(Math.abs(before.offset - original.offset)).toBeLessThan(1);
  await page.evaluate(() => { window.scrollProbeDiagram = document.querySelector('[data-room-entry-id="entry-1"] svg'); });
  await stream.update(() => {});
  await expectSamePosition(page, before);
  expect(await page.evaluate(() => scrollProbeEntry.isConnected && scrollProbeDiagram.isConnected)).toBe(true);
});

test('keyboard viewport changes preserve history and bottom following', async ({ page }) => {
  await mockVisualViewport(page, { iosStandalone: true });
  await openScrollingRoom(page);
  const before = await readMiddle(page);
  await page.evaluate(() => setTestVisualViewport({ height: 600, offsetTop: 40, scale: 1 }));
  await expectSamePosition(page, before);
  await page.evaluate(() => {
    const list = document.getElementById('room-message-list');
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    setTestVisualViewport({ height: 500, offsetTop: 60, scale: 1 });
  });
  await expect.poll(() => page.locator('#room-message-list').evaluate(list => list.scrollHeight - list.clientHeight - list.scrollTop)).toBeLessThan(2);
});
