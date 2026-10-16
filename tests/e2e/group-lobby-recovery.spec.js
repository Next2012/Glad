const { test, expect } = require('@playwright/test');

for (const loader of ['loadRooms', 'loadSessions']) {
  test(`resuming A cannot resurrect closed B from a delayed ${loader} response`, async ({ page }) => {
    test.setTimeout(60000);
    const create = async name => {
      const response = await page.request.post('/api/rooms', { data: { name } });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const a = await create('Saved A');
    await page.request.delete(`/api/rooms/${a.id}`);
    const b = await create('Closed B');
    const destination = await create('Empty destination');
    let release;
    try {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.evaluate(id => openRoom(id), destination.id);
      await expect.poll(() => page.evaluate(id => sessionListRooms.some(room => room.id === id), b.id)).toBe(true);
      let captured;
      const started = new Promise(resolve => { captured = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      let holdNext = true;
      await page.route('**/api/rooms', async route => {
        if (route.request().method() !== 'GET' || !holdNext) return route.continue();
        holdNext = false;
        const response = await route.fetch();
        const body = await response.text();
        captured();
        await held;
        await route.fulfill({ response, body });
      });
      await page.evaluate(loader => { window.pendingLobbyRefresh = window[loader](); }, loader);
      await started;
      await page.request.delete(`/api/rooms/${b.id}`);
      await expect.poll(() => page.evaluate(id => sessionListRooms.some(room => room.id === id), b.id)).toBe(false);
      await page.locator('#room-history-resume').click();
      await page.locator(`.room-history-item[data-room-history-id="${a.id}"]`)
        .getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(page.locator('#room-title')).toHaveText('Saved A (0)');
      await expect.poll(() => page.evaluate(id => sessionListRooms.find(room => room.id === id)?.name, destination.id)).toBe('Saved A');
      release();
      await page.evaluate(() => window.pendingLobbyRefresh);
      expect(await page.evaluate(id => sessionListRooms.some(room => room.id === id), b.id)).toBe(false);
      await expect(page.locator(`.room-list-card[data-room-id="${b.id}"]`)).toHaveCount(0);
      await expect(page.locator(`.room-list-card[data-room-id="${destination.id}"] .room-list-name`)).toHaveText('Saved A');
      const active = await (await page.request.get('/api/rooms')).json();
      expect(active.filter(room => [a.id, b.id, destination.id].includes(room.id)))
        .toEqual([expect.objectContaining({ id: destination.id, historyId: a.id, name: 'Saved A' })]);
    } finally {
      release?.();
      for (const group of [a, b, destination]) await page.request.delete(`/api/rooms/${group.id}`);
    }
  });
}
