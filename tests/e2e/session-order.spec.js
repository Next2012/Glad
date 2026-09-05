const { test, expect } = require('@playwright/test');

async function mockSessions(page, count) {
  let records = Array.from({ length: count }, (_, index) => ({
    id: `sort-${index}`, name: `Session ${index + 1}`, tool: 'Codex', toolKey: 'codex',
    status: 'idle', startTime: 1700000000000 + index, workingDirectory: '/workspace/reorder'
  }));
  await page.route('**/api/sessions', route => route.fulfill({ json: records }));
  await page.route('**/api/sessions/*/timed-inputs', route => route.fulfill({ json: { success: true, items: [] } }));
  await page.route('**/api/sessions/*/completion/read', route => route.fulfill({ json: { success: true } }));
  await page.addInitScript(() => {
    window.__sortSocketsCreated = 0;
    window.WebSocket = class {
      static OPEN = 1;
      constructor(url) {
        window.__sortSocketsCreated++;
        this.readyState = 0;
        const id = new URL(url).searchParams.get('sessionId');
        setTimeout(() => {
          if (this.readyState === 3) return;
          this.readyState = 1;
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: 'codex-snapshot', snapshot: {
            id, name: `Session ${Number(id.split('-')[1]) + 1}`, messages: [], pendingPermissions: [],
            state: { status: 'idle', threadId: id }
          } }) });
        }, 0);
      }
      send() {}
      close() { this.readyState = 3; }
    };
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#sessions-list .session-card')).toHaveCount(count);
  return { remove: id => { records = records.filter(record => record.id !== id); } };
}

async function gesture(page, testInfo) {
  if (!testInfo.project.use.hasTouch) return {
    start: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); },
    move: (x, y) => page.mouse.move(x, y), end: () => page.mouse.up()
  };
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
  });
  return { start: (x, y) => touch('touchStart', x, y), move: (x, y) => touch('touchMove', x, y), end: () => touch('touchEnd') };
}

const lobbyIds = page => page.locator('#sessions-list .session-card').evaluateAll(cards => cards.map(card => card.dataset.sessionId));
const tileIds = page => page.locator('#tile-grid .tile-session-window').evaluateAll(cards => cards.map(card => card.dataset.sessionId));

test('lobby requires a three-second hold, then saves order across refresh and views', async ({ page }, testInfo) => {
  await mockSessions(page, 5);
  const drag = await gesture(page, testInfo);
  const first = await page.locator('#sessions-list .session-card').first().boundingBox();
  await drag.start(first.x + 24, first.y + 28);
  await page.waitForTimeout(2600);
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  await expect(page.locator('body')).toHaveClass(/session-reordering/, { timeout: 1200 });
  // Polling must not destroy the held card or interrupt pointer capture.
  await page.evaluate(() => { window.__heldSortCard = document.querySelector('.reorder-source'); });
  await page.evaluate(() => loadSessions());
  expect(await page.evaluate(() => window.__heldSortCard === document.querySelector('.reorder-source'))).toBe(true);
  const target = await page.locator('[data-session-id="sort-2"]').boundingBox();
  await drag.move(target.x + 24, target.y + target.height - 6);
  await expect.poll(() => lobbyIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3', 'sort-4']);
  await drag.end();
  await expect(page.locator('.session-reorder-ghost')).toHaveCount(0);
  await page.reload({ waitUntil: 'networkidle' });
  await expect.poll(() => lobbyIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3', 'sort-4']);
  await page.evaluate(() => loadSessions());
  await expect.poll(() => lobbyIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3', 'sort-4']);
  if (page.viewportSize().width >= 920) {
    await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
    await expect.poll(() => tileIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3']);
  }
});

test('long lobby lists auto-scroll at the edge during dragging', async ({ page }, testInfo) => {
  test.setTimeout(30000);
  await mockSessions(page, 18);
  const drag = await gesture(page, testInfo);
  const first = await page.locator('[data-session-id="sort-0"]').boundingBox();
  await drag.start(first.x + 24, first.y + 28);
  await expect(page.locator('body')).toHaveClass(/session-reordering/, { timeout: 4000 });
  const scroller = await page.locator('#lobby').boundingBox();
  const x = first.x + 24;
  const bottom = Math.min(page.viewportSize().height, scroller.y + scroller.height) - 4;
  await drag.move(x, bottom);
  await expect.poll(() => page.locator('#lobby').evaluate(element => element.scrollTop), { timeout: 5000 }).toBeGreaterThan(500);
  await expect.poll(async () => {
    const box = await page.locator('#sessions-list [data-session-id="sort-17"]').boundingBox();
    return box.y + box.height <= bottom + 4;
  }, { timeout: 10000 }).toBe(true);
  const last = await page.locator('#sessions-list [data-session-id="sort-17"]').boundingBox();
  await drag.move(x, Math.min(bottom, last.y + last.height - 2));
  await expect.poll(async () => (await lobbyIds(page)).at(-1)).toBe('sort-0');
  await page.screenshot({ path: testInfo.outputPath('long-list-reordering.png'), fullPage: true });
  await drag.end();
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  await expect.poll(async () => JSON.parse(await page.evaluate(() => localStorage.getItem('glad-session-order'))).at(-1)).toBe('sort-0');
  // The reverse direction must scroll back through the same long container.
  const moved = await page.locator('#sessions-list [data-session-id="sort-0"]').boundingBox();
  await drag.start(moved.x + 24, moved.y + 28);
  await expect(page.locator('body')).toHaveClass(/session-reordering/, { timeout: 4000 });
  await drag.move(x, Math.max(0, scroller.y) + 4);
  await expect.poll(() => page.locator('#lobby').evaluate(element => element.scrollTop), { timeout: 10000 }).toBe(0);
  await expect.poll(async () => (await lobbyIds(page))[0]).toBe('sort-0');
  await drag.end();
});

test('ordinary scrolling, action buttons and cancelled drags do not save an order', async ({ page }, testInfo) => {
  await mockSessions(page, 12);
  const drag = await gesture(page, testInfo);
  const first = await page.locator('[data-session-id="sort-0"]').boundingBox();
  await drag.start(first.x + 24, first.y + 60);
  await drag.move(first.x + 24, first.y - 30);
  await drag.end();
  await expect(page.locator('.reorder-pressing')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  if (testInfo.project.use.hasTouch) {
    await expect.poll(() => page.locator('#lobby').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => localStorage.getItem('glad-session-order'))).toBeNull();
  await page.reload({ waitUntil: 'networkidle' });
  const connect = page.locator('[data-session-id="sort-0"]').getByRole('button', { name: 'Connect' });
  await connect.click();
  await expect(page.locator('#terminal-view')).toHaveClass(/active/);
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  expect(await page.evaluate(() => localStorage.getItem('glad-session-order'))).toBeNull();
  await page.evaluate(() => showLobby());
  await page.locator('#lobby').evaluate(element => { element.scrollTop = 0; });
  const card = await page.locator('#sessions-list [data-session-id="sort-0"]').boundingBox();
  await drag.start(card.x + 24, card.y + 28);
  await expect(page.locator('body')).toHaveClass(/session-reordering/, { timeout: 4000 });
  await page.keyboard.press('Escape');
  await drag.end();
  await expect(page.locator('.session-reorder-ghost')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('glad-session-order'))).toBeNull();
});

test('removing a held session cancels dragging safely', async ({ page }, testInfo) => {
  const fixture = await mockSessions(page, 4);
  const drag = await gesture(page, testInfo);
  const card = await page.locator('[data-session-id="sort-0"]').boundingBox();
  await drag.start(card.x + 24, card.y + 28);
  await expect(page.locator('body')).toHaveClass(/session-reordering/, { timeout: 4000 });
  fixture.remove('sort-0');
  await page.evaluate(() => loadSessions());
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  await expect(page.locator('.session-reorder-ghost')).toHaveCount(0);
  await drag.end();
  await expect.poll(() => lobbyIds(page)).toEqual(['sort-1', 'sort-2', 'sort-3']);
});

test('tile headers reorder immediately without reconnecting previews or changing other pages', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tiled workspace only');
  await mockSessions(page, 8);
  await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
  await expect.poll(() => tileIds(page)).toEqual(['sort-0', 'sort-1', 'sort-2', 'sort-3']);
  const sockets = await page.evaluate(() => window.__sortSocketsCreated);
  const source = await page.locator('#tile-grid [data-session-id="sort-0"] .tile-session-heading').boundingBox();
  const target = await page.locator('#tile-grid [data-session-id="sort-2"] .tile-session-heading').boundingBox();
  await page.mouse.move(source.x + 24, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(target.x + 24, target.y + 12);
  await expect(page.locator('body')).toHaveClass(/session-reordering/);
  await expect.poll(() => tileIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3']);
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
  expect(await page.evaluate(() => window.__sortSocketsCreated)).toBe(sockets);
  await page.getByRole('button', { name: 'Next session page' }).click();
  await expect.poll(() => tileIds(page)).toEqual(['sort-4', 'sort-5', 'sort-6', 'sort-7']);
  await page.getByRole('button', { name: 'Restore lobby' }).click();
  await expect.poll(() => lobbyIds(page)).toEqual(['sort-1', 'sort-2', 'sort-0', 'sort-3', 'sort-4', 'sort-5', 'sort-6', 'sort-7']);
});

test('tile reorder preserves remaining sessions when another card disappears during drag', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tiled workspace only');
  const fixture = await mockSessions(page, 8);
  await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
  await expect.poll(() => tileIds(page)).toEqual(['sort-0', 'sort-1', 'sort-2', 'sort-3']);
  const source = await page.locator('#tile-grid [data-session-id="sort-0"] .tile-session-heading').boundingBox();
  const target = await page.locator('#tile-grid [data-session-id="sort-3"] .tile-session-heading').boundingBox();
  await page.mouse.move(source.x + 24, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(target.x + 24, target.y + 12);
  await expect.poll(() => tileIds(page)).toEqual(['sort-1', 'sort-2', 'sort-3', 'sort-0']);
  fixture.remove('sort-1');
  await page.evaluate(() => loadSessions());
  await page.mouse.up();
  await expect.poll(() => tileIds(page)).toEqual(['sort-2', 'sort-3', 'sort-0', 'sort-4']);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('glad-session-order'))))
    .toEqual(['sort-2', 'sort-3', 'sort-0', 'sort-4', 'sort-5', 'sort-6', 'sort-7']);
  // Header action buttons remain normal actions, never reorder handles.
  await page.locator('#tile-grid [data-session-id="sort-2"]').getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('body')).toHaveClass(/tile-focus-open/);
  await expect(page.locator('body')).not.toHaveClass(/session-reordering/);
});

test('latest session response wins while a tile reorder is active', async ({ page }) => {
  test.skip(page.viewportSize().width < 920, 'Desktop tiled workspace only');
  await mockSessions(page, 8);
  await page.getByRole('button', { name: 'Collapse lobby and tile sessions' }).click();
  await expect.poll(() => tileIds(page)).toEqual(['sort-0', 'sort-1', 'sort-2', 'sort-3']);

  const stale = Array.from({ length: 8 }, (_, index) => ({
    id: `sort-${index}`, name: `Session ${index + 1}`, tool: 'Codex', toolKey: 'codex',
    status: 'idle', startTime: 1700000000000 + index, workingDirectory: '/workspace/reorder'
  }));
  const fresh = [...stale.filter(item => item.id !== 'sort-1'), {
    id: 'sort-new', name: 'New session', tool: 'Codex', toolKey: 'codex', status: 'idle',
    startTime: 1700000009000, workingDirectory: '/workspace/reorder'
  }];
  await page.unroute('**/api/sessions');
  let requests = 0;
  let releaseStale;
  await page.route('**/api/sessions', async route => {
    requests++;
    if (requests === 1) {
      await new Promise(resolve => { releaseStale = resolve; });
      return route.fulfill({ json: stale });
    }
    return route.fulfill({ json: fresh });
  });

  const source = await page.locator('#tile-grid [data-session-id="sort-0"] .tile-session-heading').boundingBox();
  const target = await page.locator('#tile-grid [data-session-id="sort-3"] .tile-session-heading').boundingBox();
  await page.mouse.move(source.x + 24, source.y + 12);
  await page.mouse.down();
  await page.mouse.move(target.x + 24, target.y + 12);
  await expect(page.locator('body')).toHaveClass(/session-reordering/);
  await page.evaluate(() => { window.__staleSessionLoad = loadSessions(); });
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => loadSessions());
  await expect.poll(() => requests).toBe(2);
  releaseStale();
  await page.evaluate(() => window.__staleSessionLoad);
  await page.mouse.up();

  await expect.poll(() => page.locator('#sessions-list .session-card').evaluateAll(cards => cards.map(card => card.dataset.sessionId)))
    .toEqual(['sort-2', 'sort-3', 'sort-0', 'sort-4', 'sort-5', 'sort-6', 'sort-7', 'sort-new']);
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('glad-session-order')));
  expect(saved).toEqual(['sort-2', 'sort-3', 'sort-0', 'sort-4', 'sort-5', 'sort-6', 'sort-7', 'sort-new']);
  expect(saved).not.toContain('sort-1');
});
