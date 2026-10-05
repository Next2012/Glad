const {test,expect}=require('@playwright/test');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
test('speed badge precedes History, shows live completed rate and loads turn/hour statistics',async({page})=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'glad-speed-e2e-'));
 const response=await page.request.post('/api/sessions',{data:{toolKey:'codex',name:'Speed tester',workingDirectory:directory}});expect(response.ok()).toBe(true);const session=await response.json();
 try {
  await page.goto('/',{waitUntil:'networkidle'});await page.evaluate(id=>joinSession(id,'Speed tester','codex'),session.id);
  const badge=page.locator('#session-speed-button');await expect(badge).toHaveText('—');
  expect(await badge.evaluate(button=>button.nextElementSibling.title)).toBe('History');
  await page.locator('#cmd-input').fill('__GLAD_E2E_SPEED__ complete one sample');await page.locator('#send-btn').click();
  await expect(badge).toContainText('≈');
  const api=await(await page.request.get(`/api/sessions/${session.id}/speed?timezone=UTC`)).json();expect(api.items[0].outputTokens).toBe(100);expect(api.mean).toBeGreaterThan(0);expect(api.items[0].blockedMs).toBeGreaterThan(50);
  await badge.click();await expect(page.getByRole('dialog',{name:'Effective output speed',exact:true})).toBeVisible();
  await expect(page.locator('.speed-summary')).toContainText('1 / 1 included samples');
  await page.getByRole('tab',{name:'Hourly',exact:true}).click();await expect(page.locator('.speed-hours tbody tr')).toHaveCount(24);
  await page.getByRole('tab',{name:'Turns',exact:true}).click();await page.locator('.speed-turn summary').click();await expect(page.locator('.speed-turn dd').first()).toHaveText('100');
  await page.waitForTimeout(3300);await expect(page.locator('.speed-turn')).toHaveAttribute('open','');
  await page.getByRole('button',{name:'Same model',exact:true}).click();await expect(page.locator('.speed-scope-caption')).toContainText('matching service');
  const bounds=await page.locator('.session-speed-panel').evaluate(panel=>({scroll:panel.scrollWidth,width:panel.clientWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  await page.getByRole('button',{name:'Close speed statistics',exact:true}).click();await expect(page.locator('#session-speed-overlay')).toBeHidden();
  await page.reload({waitUntil:'networkidle'});await page.evaluate(id=>joinSession(id,'Speed tester','codex'),session.id);await expect(badge).toContainText('≈');
 }finally{await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});


test('short latest reply is dimmed; filtering changes both means without hiding history or changing the badge', async ({page}) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'glad-speed-e2e-'));
  const session=await(await page.request.post('/api/sessions',{data:{toolKey:'codex',name:'Short reply',workingDirectory:directory}})).json();
  const row={id:'latest-short',rate:3,shortSample:true,outputTokens:10,model:'test-model',status:'completed',quality:'estimated',wallMs:4000,blockedMs:500,observedMs:3500,endedAt:Date.now()};
  let requests=0;
  await page.route(`**/api/sessions/${session.id}/speed?*`,async route=>{
    requests++;const exclude=new URL(route.request().url()).searchParams.get('excludeShort')==='true';
    await route.fulfill({json:{success:true,last:row,items:[row,{...row,id:'earlier-long',rate:80,outputTokens:50,shortSample:false}],mean:exclude?80:41.5,validCount:exclude?1:2,sampleCount:2,shortCount:1,excludedCount:exclude?1:0,excludeShort:exclude,timezone:'UTC',hours:[{label:'10-05 12:00',count:exclude?1:2,excludedCount:exclude?1:0,sampleCount:2,mean:exclude?80:41.5}]}});
  });
  try {
    await page.goto('/',{waitUntil:'networkidle'});await page.evaluate(id=>joinSession(id,'Short reply','codex'),session.id);
    await page.evaluate(({id,row})=>updateSessionSpeed(id,row),{id:session.id,row});
    const badge=page.locator('#session-speed-button');await expect(badge).toHaveText('≈3');await expect(badge).toHaveClass(/short-sample/);await expect(badge).toHaveAttribute('title',/Short reply/);
    await badge.click();await expect(page.getByRole('dialog',{name:'Effective output speed',exact:true})).toBeVisible();
    const filter=page.getByRole('switch',{name:'Exclude samples under 50 tokens',exact:true});await expect(filter).not.toBeChecked();
    await expect(page.locator('.speed-latest-note')).toContainText('Short reply');await expect(page.locator('.speed-summary')).toContainText('2 / 2 included samples');
    await filter.check();await expect(page.locator('.speed-summary')).toContainText('1 / 2 included samples · 1 short samples excluded');
    await expect(page.locator('.speed-turn')).toHaveCount(2);await expect(badge).toHaveText('≈3');
    await page.getByRole('tab',{name:'Hourly',exact:true}).click();await expect(page.locator('.speed-counts')).toHaveText('1 included · 1 short samples excluded');
    await filter.uncheck();await expect(page.locator('.speed-counts')).toHaveText('2 included · 0 short samples excluded');
    await page.getByRole('button',{name:'Same model',exact:true}).click();await filter.check();await expect(page.locator('.speed-counts')).toHaveText('1 included · 1 short samples excluded');
    await expect(badge).toHaveText('≈3');
    await page.getByRole('button',{name:'Close speed statistics',exact:true}).click();const count=requests;await page.waitForTimeout(3300);expect(requests).toBe(count);
    await badge.click();await expect(filter).not.toBeChecked();
  }finally{await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});
