const { conversationView } = require('./helpers/conversation');
const { test, expect } = require('@playwright/test');

async function saveEvidence(page, testInfo, name) {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: false, animations: 'disabled', scale: 'css' });
  await testInfo.attach(name, { path: artifactPath, contentType: 'image/png' });
}

async function createAntigravitySession(page) {
  const created = await page.request.post('/api/sessions', { data: { toolKey: 'antigravity', name: 'Antigravity metrics' } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator(`.session-card[data-session-id="${id}"]`).getByRole('button', { name: 'Connect' }).click();
  await (await conversationView(page)).waitForFunction(() => activeSessionHydrated && antigravityState.status === 'idle');
  return id;
}

async function completeMetricsTurn(page) {
  await (await conversationView(page)).locator('#cmd-input').fill('agy-metrics');
  await (await conversationView(page)).locator('#send-btn').click();
  await expect((await conversationView(page)).locator('#antigravity-chat-container')).toContainText('AGY metrics fixture completed');
  await (await conversationView(page)).waitForFunction(() => antigravityState.status === 'idle');
}

test('Antigravity native output updates the speed badge, statistics and reconnect metadata', async ({ page }, testInfo) => {
  const id = await createAntigravitySession(page);
  try {
    await completeMetricsTurn(page);
    const response = await page.request.get(`/api/sessions/${id}/speed?timezone=UTC`);
    expect(response.ok()).toBe(true);
    const report = await response.json();
    expect(report.last).toMatchObject({ provider: 'antigravity', outputTokens: 80, model: 'gemini-3.1-pro', status: 'completed' });
    expect(report.last.rate).toBeGreaterThan(0);
    expect(Number.isFinite(report.last.rate)).toBe(true);
    expect(report.last.observedMs).toBeGreaterThan(0);
    const badge = (await conversationView(page)).locator('#session-speed-button');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', /≈[\d,.]+ tok\/s/);
    expect(await badge.evaluate(button => button.nextElementSibling.title)).toBe('History');
    await saveEvidence(page, testInfo, 'antigravity-speed-badge');
    await badge.click();
    const dialog = (await conversationView(page)).getByRole('dialog', { name: 'Effective output speed', exact: true });
    await expect(dialog).toBeVisible();
    const sample = (await conversationView(page)).locator(`.speed-turn[data-speed-sample="${report.last.id}"]`);
    await expect(sample).toContainText('gemini-3.1-pro');
    await sample.locator(':scope > summary').click();
    await expect(sample.locator('dd').first()).toHaveText('80');
    await expect(sample).toContainText('Thinking tokens (included in output)');
    await expect(sample.locator('dt').filter({ hasText: /^Cached input tokens$/ })).toBeVisible();
    await expect((await conversationView(page)).locator('.speed-latest-speed')).toContainText('tok/s');
    await (await conversationView(page)).getByRole('tab', { name: 'Hourly', exact: true }).click();
    await expect((await conversationView(page)).locator('.speed-hours tbody tr')).toHaveCount(24);
    const modelScope = (await conversationView(page)).getByRole('button', { name: 'Same model', exact: true });
    await expect(modelScope).toBeEnabled();
    await modelScope.click();
    await expect((await conversationView(page)).locator('.speed-scope-caption')).toContainText('gemini-3.1-pro');
    const bounds = await (await conversationView(page)).locator('.session-speed-panel').evaluate(panel => {
      const box = panel.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: innerWidth, content: panel.scrollWidth, width: panel.clientWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
    await saveEvidence(page, testInfo, 'antigravity-speed-statistics');
    await (await conversationView(page)).getByRole('button', { name: 'Close speed statistics', exact: true }).click();

    const metadata = await (await page.request.get(`/api/sessions/${id}/metadata`)).json();
    expect(metadata.speed.id).toBe(report.last.id);
    await (await conversationView(page)).evaluate(() => { window.__metricsPreviousSocket = currentSocket; currentSocket.close(); });
    await (await conversationView(page)).waitForFunction(() => currentSocket !== window.__metricsPreviousSocket && currentSocket?.readyState === WebSocket.OPEN);
    await expect.poll(async () => (await conversationView(page)).evaluate(() => antigravityState.lastSpeed?.id)).toBe(report.last.id);
    await expect(badge).toHaveAttribute('title', /≈[\d,.]+ tok\/s/);
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(id => joinSession(id, 'Antigravity metrics', 'antigravity'), id);
    await (await conversationView(page)).waitForFunction(() => activeSessionHydrated && antigravityState.status === 'idle');
    await expect(badge).toHaveAttribute('title', /≈[\d,.]+ tok\/s/);
    await expect.poll(async () => (await conversationView(page)).evaluate(() => antigravityState.lastSpeed?.id)).toBe(report.last.id);
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('Antigravity native model and thinking choices synchronize with compact status and quota', async ({ page }, testInfo) => {
  const id = await createAntigravitySession(page);
  try {
    const modelTrigger = (await conversationView(page)).locator('#antigravity-model-btn');
    await modelTrigger.click();
    const panel = (await conversationView(page)).locator('#antigravity-model-panel');
    await expect(panel).toBeVisible();
    await expect(modelTrigger).toHaveAttribute('aria-expanded', 'true');
    const model = panel.locator('[data-agy-config-choice="model"][data-agy-value="claude-sonnet-4.6"]');
    const changed = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/sessions/${id}/antigravity-settings`));
    await model.click();
    expect((await changed).ok()).toBe(true);
    await expect(model).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('select[data-agy-config="model"]')).toBeHidden();
    await expect(panel.locator('select[data-agy-config="model"]')).toHaveValue('claude-sonnet-4.6');
    const thinking = panel.locator('[data-agy-config-choice="thought_level"][data-agy-value="low"]');
    const thinkingChanged = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/sessions/${id}/antigravity-settings`));
    await thinking.click();
    expect((await thinkingChanged).ok()).toBe(true);
    await expect(thinking).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('select[data-agy-config="thought_level"]')).toHaveValue('low');
    await saveEvidence(page, testInfo, 'antigravity-model-thinking-choices');
    await modelTrigger.click();
    await expect(panel).not.toBeVisible();
    await expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');

    await (await conversationView(page)).locator('#antigravity-status-btn').click();
    const status = (await conversationView(page)).locator('#antigravity-chat-container .antigravity-status').last();
    await expect(status).toHaveClass(/codex-status-card/);
    await expect(status.locator(':scope > .antigravity-status-summary')).toBeVisible();
    if (!await status.evaluate(card => card.open)) await status.locator(':scope > summary').click();
    await expect(status.locator('.antigravity-status-body')).toBeVisible();
    await expect(status.locator('.antigravity-quota-row')).toContainText('75% remaining');
    await expect(status.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '75');
    await saveEvidence(page, testInfo, 'antigravity-native-status-quota');
    await status.locator(':scope > summary').click();
    await expect(status.locator('.antigravity-status-body')).not.toBeVisible();
    await expect((await conversationView(page)).locator('#send-btn')).toBeVisible();
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('Antigravity observed tokens appear as their own usage provider and retain unknown pricing', async ({ page }, testInfo) => {
  const id = await createAntigravitySession(page);
  try {
    await completeMetricsTurn(page);
    await expect.poll(async () => {
      const response = await page.request.get('/api/usage/sources');
      if (!response.ok()) return false;
      const report = await response.json();
      return report.sources?.some(source => source.id === 'antigravity' && source.label === 'Antigravity') || false;
    }).toBe(true);
    let report;
    await expect.poll(async () => {
      const response = await page.request.get('/api/usage/report?source=antigravity&scope=weekly');
      if (!response.ok()) return false;
      report = await response.json();
      return (report.summary?.models?.find(model => model.modelName === 'gemini-3.1-pro')?.outputTokens || 0) >= 80;
    }).toBe(true);
    expect(report.source).toMatchObject({ id: 'antigravity', label: 'Antigravity' });
    const nativeModel = report.summary.models.find(model => model.modelName === 'gemini-3.1-pro');
    expect(nativeModel.cachedInputTokens).toBeGreaterThanOrEqual(20);
    expect(nativeModel.uncachedInputTokens).toBeGreaterThanOrEqual(100);
    expect(nativeModel.totalTokens).toBeGreaterThanOrEqual(200);
    expect(nativeModel.totalTokens).toBe(nativeModel.uncachedInputTokens + nativeModel.cachedInputTokens + nativeModel.outputTokens);
    expect(nativeModel.estimatedCostUSD).toBeNull();
    expect(report.summary.totals.estimatedCostUSD).toBeNull();

    const pricingPreference = await (await conversationView(page)).evaluate(() => usageState.offlineOnly);
    await page.evaluate(() => showLobby());
    await page.getByTitle('Usage dashboard').click();
    const provider = page.locator('#usage-sources-list .usage-source-item').filter({ hasText: 'Antigravity' });
    await expect(provider).toBeVisible();
    await saveEvidence(page, testInfo, 'antigravity-usage-provider');
    await provider.click();
    await expect(page.locator('#usage-source-title')).toHaveText('Antigravity Usage');
    await expect(page.locator('#usage-dashboard')).toBeVisible();
    const row = page.locator('#usage-model-summary tbody tr').filter({ hasText: 'gemini-3.1-pro' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').last()).toHaveText('Unknown');
    await expect(row).not.toContainText('$0');
    await expect(page.locator('#usage-summary')).toContainText('Cannot estimate');
    await expect(page.locator('#usage-token-chart .usage-chart-row')).not.toHaveCount(0);
    await expect(page.locator('#usage-cost-panel')).toBeHidden();
    await expect(page.locator('#usage-engine-note')).toContainText(/Antigravity|ACP/);
    await expect(page.locator('#usage-engine-note')).toContainText('native history is not backfilled');
    await expect(page.locator('#usage-engine-note')).not.toContainText('ccusage');
    await expect(page.locator('#usage-offline-only').locator('..')).toBeHidden();
    expect(await (await conversationView(page)).evaluate(() => usageState.offlineOnly)).toBe(pricingPreference);
    await saveEvidence(page, testInfo, 'antigravity-usage-dashboard-weekly');
    const monthly = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/usage/report' && url.searchParams.get('source') === 'antigravity' && url.searchParams.get('scope') === 'monthly';
    });
    await page.locator('#usage-scope-monthly').click();
    expect((await monthly).ok()).toBe(true);
    await expect(page.locator('#usage-scope-monthly')).toHaveClass(/active/);
    await expect(row).toBeVisible();
    await expect(page.locator('#usage-source-title')).toHaveText('Antigravity Usage');
    // A completed empty response must show its coverage, rather than stay in
    // the loading state when the only observed records lack token counters.
    await page.route('**/api/usage/report?*', route => route.fulfill({ json: {
      ...report, hasData: true, usageAvailable: false, availablePeriods: [], selectedPeriod: null,
      summary: { models: [], totals: { totalTokens: null, estimatedCostUSD: null } }, days: [], excludedSamples: 2
    } }));
    await (await conversationView(page)).getByRole('button', { name: 'Refresh usage', exact: true }).click();
    await expect(page.locator('#usage-loading')).toBeHidden();
    await expect(page.locator('#usage-model-summary')).toContainText('No usage in this period.');
    await expect(page.locator('#usage-engine-note')).toContainText('2 records with incomplete token counts');
  } finally {
    await page.request.delete(`/api/sessions/${id}`);
  }
});

test('an old Antigravity settings response cannot finish a newer request after A to B to A navigation', async ({ page }) => {
  const requests = [];
  await page.route('**/api/sessions/epoch-a/antigravity-settings', route => { requests.push(route); });
  await page.goto('/', { waitUntil: 'networkidle' });
  const initialEpoch = await (await conversationView(page)).evaluate(() => {
    activeToolKey = 'antigravity';
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('terminal-view').classList.add('active');
    setClaudeModeEnabled(false);
    // Use the real session initializer while replacing only native transport.
    connectAntigravitySocket = () => {
      currentSocket = { readyState: WebSocket.OPEN, send: () => {} };
      handleComposerSocketOpen();
    };
    window.__epochOptions = [{ id: 'model', category: 'model', name: 'Model', currentValue: 'initial', options: [
      { value: 'initial', name: 'Initial model' }, { value: 'obsolete', name: 'Obsolete model' },
      { value: 'latest', name: 'Latest model' }
    ] }];
    window.__visitEpochSession = sessionId => {
      activeSessionId = sessionId;
      initAntigravitySession(sessionId);
      activeSessionHydrated = true;
      applyAntigravityState({ status: 'idle', configOptions: JSON.parse(JSON.stringify(window.__epochOptions)), epochLabel: 'current-visit' });
    };
    window.__visitEpochSession('epoch-a');
    return antigravitySessionEpoch;
  });
  await (await conversationView(page)).locator('#antigravity-model-btn').click();
  await (await conversationView(page)).evaluate(() => { window.__oldEpochSettings = updateAntigravitySetting('model', 'obsolete'); });
  await expect.poll(() => requests.length).toBe(1);
  await expect.poll(async () => (await conversationView(page)).evaluate(() => antigravitySettingsPending)).toBe(true);
  await (await conversationView(page)).evaluate(() => {
    window.__visitEpochSession('epoch-b');
    window.__visitEpochSession('epoch-a');
    window.__latestEpochSettings = updateAntigravitySetting('model', 'latest');
  });
  await expect.poll(() => requests.length).toBe(2);
  expect(await (await conversationView(page)).evaluate(() => antigravitySessionEpoch)).toBe(initialEpoch + 2);
  await (await conversationView(page)).locator('#antigravity-model-btn').click();
  const latestChoice = (await conversationView(page)).locator('#antigravity-model-panel [data-agy-config-choice="model"][data-agy-value="latest"]');
  await expect(latestChoice).toBeDisabled();
  await (await conversationView(page)).locator('#cmd-input').focus();
  expect(requests[0].request().postDataJSON()).toEqual({ model: 'obsolete' });
  expect(requests[1].request().postDataJSON()).toEqual({ model: 'latest' });
  const options = await (await conversationView(page)).evaluate(() => window.__epochOptions);
  await requests[0].fulfill({ json: { success: true, state: {
    status: 'idle', epochLabel: 'obsolete-response', configOptions: options.map(option => ({ ...option, currentValue: 'obsolete' }))
  } } });
  await (await conversationView(page)).evaluate(() => window.__oldEpochSettings);
  expect(await (await conversationView(page)).evaluate(() => ({ pending: antigravitySettingsPending, label: antigravityState.epochLabel, model: antigravityState.configOptions[0].currentValue })))
    .toEqual({ pending: true, label: 'current-visit', model: 'initial' });
  await expect(latestChoice).toBeDisabled();
  await expect((await conversationView(page)).locator('#send-btn')).toBeDisabled();
  await expect((await conversationView(page)).locator('#cmd-input')).toBeFocused();
  await requests[1].fulfill({ json: { success: true, state: {
    status: 'idle', epochLabel: 'latest-response', configOptions: options.map(option => ({ ...option, currentValue: 'latest' }))
  } } });
  await (await conversationView(page)).evaluate(() => window.__latestEpochSettings);
  expect(await (await conversationView(page)).evaluate(() => ({ pending: antigravitySettingsPending, label: antigravityState.epochLabel, model: antigravityState.configOptions[0].currentValue })))
    .toEqual({ pending: false, label: 'latest-response', model: 'latest' });
  await expect(latestChoice).toBeEnabled();
  await expect(latestChoice).toHaveAttribute('aria-pressed', 'true');
  await expect((await conversationView(page)).locator('#antigravity-model-panel [data-agy-config="model"]')).toHaveValue('latest');
  await expect((await conversationView(page)).locator('#send-btn')).toBeEnabled();
});
