const { test, expect } = require('@playwright/test');

function usageReport({ cost = 2, missing = [], refreshing = false, hasData = true, offlineOnly = false, lastError = '', revision = 1, settingsPending = false } = {}) {
  const models = missing.length ? missing.map(modelName => ({modelName,totalTokens:120,uncachedInputTokens:100,cachedInputTokens:0,outputTokens:20,estimatedCostUSD:null,missingPricing:true})) : [];
  if (cost !== null) models.unshift({modelName:'known-free',totalTokens:100,uncachedInputTokens:80,cachedInputTokens:0,outputTokens:20,estimatedCostUSD:0});
  if (cost > 0) models.push({modelName:'known-paid',totalTokens:100,uncachedInputTokens:80,cachedInputTokens:0,outputTokens:20,estimatedCostUSD:cost});
  const totals={totalTokens:models.reduce((sum,item)=>sum+item.totalTokens,0),uncachedInputTokens:200,cachedInputTokens:0,outputTokens:40,estimatedCostUSD:cost,unpricedModels:missing,pricingStatus:cost===null?'unavailable':missing.length?'partial':'complete'};
  return {source:{id:'codex',label:'Codex'},scope:'weekly',availablePeriods:['2026-10-05'],selectedPeriod:'2026-10-05',summary:{models,totals},days:[{period:'2026-10-08',models,totals}],generatedAt:hasData?`2026-10-08T01:0${revision}:00.000Z`:null,hasData,refreshing,offlineOnly,lastError,revision,settingsPending,engine:{name:'ccusage',version:'20.0.26',pricingMode:offlineOnly?'offline':'online-preferred'}};
}
async function openUsage(page) {
  await page.goto('/',{waitUntil:'networkidle'});
  await page.getByTitle('Usage dashboard').click();
  await page.getByRole('button',{name:/Codex.*Local token history/}).click();
}
async function mockSources(page) {
  await page.route('**/api/usage/sources*',route=>route.fulfill({json:{hasData:true,refreshing:false,offlineOnly:false,sources:[{id:'codex',label:'Codex',badge:'CX'}]}}));
}

test('usage distinguishes missing prices, partial estimates and a real zero cost',async ({page})=>{
  await mockSources(page);
  let data=usageReport({cost:2,missing:['gpt-6.1-sol']});
  await page.route('**/api/usage/report*',route=>route.fulfill({json:data}));
  await openUsage(page);
  await expect(page.locator('#usage-summary')).toContainText('Known-price estimate');
  await expect(page.locator('#usage-pricing-note')).toContainText('gpt-6.1-sol');
  await expect(page.locator('#usage-model-summary tbody tr').filter({hasText:'gpt-6.1-sol'})).toContainText('Unknown');
  await expect(page.locator('#usage-model-summary tbody tr').filter({hasText:'known-free'})).toContainText('$0');
  await expect(page.locator('#usage-engine-note')).toContainText('online-preferred pricing');
  data=usageReport({cost:null,missing:['gpt-6.1-sol']});
  await page.getByRole('button',{name:'Refresh usage',exact:true}).click();
  await expect(page.locator('#usage-summary')).toContainText('Cannot estimate');
  await expect(page.locator('#usage-model-summary')).not.toContainText('$0');
  data=usageReport({cost:0.0031,missing:['gpt-6.1-sol']});
  await page.getByRole('button',{name:'Refresh usage',exact:true}).click();
  await expect(page.locator('#usage-summary')).toContainText('0.0031');
  data=usageReport({cost:0});
  await page.getByRole('button',{name:'Refresh usage',exact:true}).click();
  await expect(page.locator('#usage-summary')).toContainText('Estimated cost');
  await expect(page.locator('#usage-summary')).toContainText('$0');
  await expect(page.locator('#usage-pricing-note')).toBeHidden();
});

test('cold usage polls until prewarm completes and later refresh failures keep the last report',async ({page})=>{
  let sourceReady=false,reportReady=false,fail=false;
  await page.route('**/api/usage/sources*',route=>route.fulfill({json:{hasData:sourceReady,refreshing:!sourceReady,offlineOnly:false,sources:sourceReady?[{id:'codex',label:'Codex',badge:'CX'}]:[]}}));
  let requests=0;
  await page.route('**/api/usage/report*',route=>{
    requests++;
    return route.fulfill({json:usageReport({cost:reportReady?7:4,refreshing:!reportReady,revision:reportReady?2:1,lastError:fail?'Invalid ccusage configuration: expected valid JSON':''})});
  });
  await page.goto('/',{waitUntil:'networkidle'});
  await page.getByTitle('Usage dashboard').click();
  await expect(page.locator('#usage-sources-list')).toContainText('first time');
  sourceReady=true;
  await page.getByRole('button',{name:/Codex.*Local token history/}).click();
  await expect(page.locator('#usage-dashboard')).toBeVisible();
  await expect(page.locator('#usage-summary')).toContainText('$4');
  await expect(page.locator('#usage-refresh-status')).toContainText('Updating');
  reportReady=true;
  await expect(page.locator('#usage-summary')).toContainText('$7');
  await expect(page.locator('#usage-refresh-status')).toBeHidden();
  const completeRequests=requests;
  await page.waitForTimeout(1200);
  expect(requests).toBe(completeRequests);
  fail=true;
  await page.getByRole('button',{name:'Refresh usage',exact:true}).click();
  await expect(page.locator('#usage-refresh-status')).toContainText('Invalid ccusage configuration: expected valid JSON');
  await expect(page.locator('#usage-summary')).toContainText('$7');
  await expect(page.locator('#usage-dashboard')).toBeVisible();
});

test('offline setting can change while refreshing and closing the panel stops polling',async ({page})=>{
  await mockSources(page);
  let offline=false,updating=false;
  let requests=0;
  const patches=[];
  await page.route('**/api/usage/settings',route=>{
    offline=route.request().postDataJSON().offlineOnly;patches.push(offline);updating=true;
    return route.fulfill({json:usageReport({offlineOnly:offline,refreshing:true,settingsPending:true})});
  });
  await page.route('**/api/usage/report*',route=>{
    requests++;
    return route.fulfill({json:usageReport({offlineOnly:offline,refreshing:updating,settingsPending:updating})});
  });
  await openUsage(page);
  await page.getByRole('checkbox',{name:'Only offline',exact:true}).check();
  await expect(page.locator('#usage-engine-note')).toContainText('offline pricing');
  await expect(page.locator('#usage-refresh-status')).toContainText('Updating');
  await page.getByRole('checkbox',{name:'Only offline',exact:true}).uncheck();
  expect(patches).toEqual([true,false]);
  await expect(page.locator('#usage-engine-note')).toContainText('online-preferred pricing');
  await page.evaluate(()=>showLobby());
  const closedRequests=requests;
  await page.waitForTimeout(1200);
  expect(requests).toBe(closedRequests);
});
