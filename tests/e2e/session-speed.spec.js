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
  await badge.click();await expect(page.getByRole('dialog',{name:'Generation speed',exact:true})).toBeVisible();
  await expect(page.locator('.speed-summary')).toContainText('1 / 1 valid samples');
  await page.getByRole('tab',{name:'Hourly',exact:true}).click();await expect(page.locator('.speed-hours tbody tr')).toHaveCount(24);
  await page.getByRole('tab',{name:'Turns',exact:true}).click();await page.locator('.speed-turn summary').click();await expect(page.locator('.speed-turn dd').first()).toHaveText('100');
  await page.waitForTimeout(3300);await expect(page.locator('.speed-turn')).toHaveAttribute('open','');
  await page.getByRole('button',{name:'Same model',exact:true}).click();await expect(page.locator('.speed-scope-caption')).toContainText('matching service');
  const bounds=await page.locator('.session-speed-panel').evaluate(panel=>({scroll:panel.scrollWidth,width:panel.clientWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  await page.getByRole('button',{name:'Close speed statistics',exact:true}).click();await expect(page.locator('#session-speed-overlay')).toBeHidden();
  await page.reload({waitUntil:'networkidle'});await page.evaluate(id=>joinSession(id,'Speed tester','codex'),session.id);await expect(badge).toContainText('≈');
 }finally{await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});
