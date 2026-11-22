const { test, expect } = require('@playwright/test');

function referenceReport({ partial = false, free = false, invalid = false } = {}) {
  const modelName = free ? 'custom-free' : 'gemini-4-neon';
  const amount = invalid ? null : free ? 0 : 18.15;
  const known = { modelName, uncachedInputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 1000000, totalTokens: 3000000, estimatedCostUSD: amount, missingPricing: invalid, pricingStatus: invalid ? 'unavailable' : 'complete' };
  const unknown = { modelName: 'unknown-exact-model', uncachedInputTokens: 333333, cachedInputTokens: 333333, outputTokens: 333334, totalTokens: 1000000, estimatedCostUSD: null, missingPricing: true, pricingStatus: 'unavailable' };
  const models = partial ? [known, unknown] : [known];
  const totals = { totalTokens: partial ? 4000000 : 3000000, uncachedInputTokens: partial ? 1333333 : 1000000, cachedInputTokens: partial ? 1333333 : 1000000, outputTokens: partial ? 1333334 : 1000000, estimatedCostUSD: amount, pricingStatus: invalid ? 'unavailable' : partial ? 'partial' : 'complete', unpricedModels: partial ? [unknown.modelName] : invalid ? [modelName] : [] };
  const coverage = { pricedTokens: invalid ? 0 : 3000000, totalTokens: totals.totalTokens, fullyPricedSamples: invalid ? 0 : 1, tokenKnownSamples: partial ? 2 : 1, unpricedReasons: invalid ? { 'invalid-pricing-configuration': 1 } : partial ? { 'unknown-exact-model': 1 } : {} };
  const basis = invalid ? 'unavailable' : free ? 'user-override' : 'google-developer-api-standard-reference';
  return { source: { id: 'antigravity', label: 'Antigravity' }, hasData: true, refreshing: false, generatedAt: '2026-11-22T12:00:00Z', scope: 'weekly', selectedPeriod: '2026-11-16', availablePeriods: ['2026-11-16'], summary: { models, totals }, days: [{ period: '2026-11-22', models, totals }], pricingBasis: basis, pricingCoverage: coverage, engine: { name: 'Antigravity ACP', pricingMode: 'reference' }, engineNote: 'Selected-model API price reference, not actual spending or AI credits. Prices use the completion date in UTC.', lastError: invalid ? 'Invalid Antigravity pricing configuration: required rate is missing' : '' };
}

test('Antigravity reference pricing keeps unknown usage visible and applies zero or invalid override states', async ({ page }, testInfo) => {
  let report = referenceReport();
  await page.route('**/api/usage/sources*', route => route.fulfill({ json: { hasData: true, refreshing: false, sources: [{ id: 'antigravity', label: 'Antigravity', badge: 'AG', description: 'Usage recorded by Glad' }] } }));
  await page.route('**/api/usage/report*', route => route.fulfill({ json: report }));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByTitle('Usage dashboard').click();
  await page.getByRole('button', { name: /Antigravity.*Usage recorded by Glad/ }).click();
  await expect(page.locator('#usage-summary')).toContainText('API price reference');
  await expect(page.locator('#usage-summary')).toContainText('$18.15');
  await expect(page.locator('#usage-pricing-note')).toContainText('3,000,000 of 3,000,000');
  await expect(page.locator('#usage-engine-note')).toContainText('not actual spending');
  await expect(page.getByRole('checkbox', { name: 'Only offline', exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('antigravity-api-reference.png'), animations: 'disabled', scale: 'css' });

  report = referenceReport({ partial: true });
  await page.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await expect(page.locator('#usage-summary')).toContainText('Partial API price reference');
  await expect(page.locator('#usage-summary')).toContainText('$18.15');
  await expect(page.locator('#usage-pricing-note')).toContainText('3,000,000 of 4,000,000');
  await expect(page.locator('#usage-pricing-note')).toContainText('unknown-exact-model');
  await expect(page.locator('#usage-model-summary tbody tr').filter({ hasText: 'unknown-exact-model' })).toContainText('Unknown');
  await expect(page.locator('#usage-model-summary tfoot')).toContainText('4,000,000');
  await expect(page.locator('#usage-daily-table tbody')).toContainText('4,000,000');
  await page.screenshot({ path: testInfo.outputPath('antigravity-partial-reference.png'), animations: 'disabled', scale: 'css' });

  report = referenceReport({ free: true });
  await page.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await expect(page.locator('#usage-summary')).toContainText('$0');
  await expect(page.locator('#usage-summary')).not.toContainText('Cannot estimate');
  await expect(page.locator('#usage-engine-note')).toContainText('user-configured flat references');

  report = referenceReport({ invalid: true });
  await page.getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await expect(page.locator('#usage-summary')).toContainText('Cannot estimate');
  await expect(page.locator('#usage-model-summary')).not.toContainText('$0');
  await expect(page.locator('#usage-model-summary tfoot')).toContainText('3,000,000');
  await expect(page.locator('#usage-refresh-status')).toContainText('Invalid Antigravity pricing configuration');
});
