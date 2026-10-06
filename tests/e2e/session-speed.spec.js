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
  await expect(badge).toHaveAttribute('title', /≈[\d,.]+ tok\/s/);
  const api=await(await page.request.get(`/api/sessions/${session.id}/speed?timezone=UTC`)).json();expect(api.items[0].outputTokens).toBe(100);expect(api.mean).toBeGreaterThan(0);expect(api.items[0].blockedMs).toBeGreaterThan(50);
  await badge.click();await expect(page.getByRole('dialog',{name:'Effective output speed',exact:true})).toBeVisible();
  await expect(page.locator('.speed-summary')).toContainText('1 / 1 included samples');
  await page.getByRole('tab',{name:'Hourly',exact:true}).click();await expect(page.locator('.speed-hours tbody tr')).toHaveCount(24);
  await page.getByRole('tab',{name:'Turns',exact:true}).click();await page.locator('.speed-turn summary').click();await expect(page.locator('.speed-turn dd').first()).toHaveText('100');
  await page.waitForTimeout(3300);await expect(page.locator('.speed-turn')).toHaveAttribute('open','');
  await page.getByRole('button',{name:'Same model',exact:true}).click();await expect(page.locator('.speed-scope-caption')).toContainText('matching service');
  const bounds=await page.locator('.session-speed-panel').evaluate(panel=>({scroll:panel.scrollWidth,width:panel.clientWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  await page.getByRole('button',{name:'Close speed statistics',exact:true}).click();await expect(page.locator('#session-speed-overlay')).toBeHidden();
  await page.reload({waitUntil:'networkidle'});await page.evaluate(id=>joinSession(id,'Speed tester','codex'),session.id);await expect(badge).toHaveAttribute('title', /≈[\d,.]+ tok\/s/);
 }finally{await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});


test('short latest reply uses secondary text; filtering changes both means without hiding history or changing the badge', async ({page}) => {
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
    const badge=page.locator('#session-speed-button');await expect(badge).toHaveText('3');await expect(badge).toHaveClass(/short-sample/);await expect(badge).toHaveAttribute('title',/≈3 tok\/s.*Short reply/);
    await badge.click();await expect(page.getByRole('dialog',{name:'Effective output speed',exact:true})).toBeVisible();
    const filter=page.getByRole('switch',{name:'Exclude samples under 50 tokens',exact:true});await expect(filter).not.toBeChecked();
    await expect(page.locator('.speed-latest-note')).toContainText('Short reply');await expect(page.locator('.speed-latest-speed')).toHaveText('Last completed turn · ≈3 tok/s');await expect(page.locator('.speed-summary')).toContainText('2 / 2 included samples');
    await filter.check();await expect(page.locator('.speed-summary')).toContainText('1 / 2 included samples · 1 short samples excluded');
    await expect(page.locator('.speed-turn')).toHaveCount(2);await expect(badge).toHaveText('3');
    await page.getByRole('tab',{name:'Hourly',exact:true}).click();await expect(page.locator('.speed-counts')).toHaveText('1 included · 1 short samples excluded');
    await filter.uncheck();await expect(page.locator('.speed-counts')).toHaveText('2 included · 0 short samples excluded');
    await page.getByRole('button',{name:'Same model',exact:true}).click();await filter.check();await expect(page.locator('.speed-counts')).toHaveText('1 included · 1 short samples excluded');
    await expect(badge).toHaveText('3');
    await page.getByRole('button',{name:'Close speed statistics',exact:true}).click();const count=requests;await page.waitForTimeout(3300);expect(requests).toBe(count);
    await badge.click();await expect(filter).not.toBeChecked();
  }finally{await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});

test('speed gauge remains readable and separate from History at 375px in both themes', async ({page}, testInfo) => {
  await page.setViewportSize({width:375,height:812});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'glad-gauge-e2e-'));
  const response=await page.request.post('/api/sessions',{data:{toolKey:'codex',name:'查看Glad更新及Token统计：长标题布局验证',workingDirectory:directory}});
  expect(response.ok()).toBe(true);const session=await response.json();
  try {
    await page.goto('/',{waitUntil:'networkidle'});
    await page.evaluate(async id=>{await joinSession(id,'查看Glad更新及Token统计：长标题布局验证','codex');await loadSessionSpeedBadge(id);},session.id);
    for (const theme of ['dark','light']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      for (const [rate,label] of [[null,'—'],[0,'0'],[0.4,'<1'],[12,'12'],[50,'50'],[100,'100'],[150,'150'],[999,'999'],[999.8,'999'],[1000,'1k+'],[1200,'1k+']]) {
        const geometry=await page.evaluate(({id,rate})=>{
          updateSessionSpeed(id,rate===null?null:{rate,shortSample:false});
          const button=document.getElementById('session-speed-button');
          const arc=button.querySelector('.speed-gauge-value'),number=button.querySelector('.speed-gauge-number');
          const rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
          const buttonRect=rect(button),titleRect=rect(document.getElementById('session-title')),history=rect(button.nextElementSibling);
          // Rasterize the computed colors so oklch and RGB use the same contrast check.
          const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
          const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data;return [0.2126,0.7152,0.0722].reduce((sum,w,i)=>{const v=rgb[i]/255;return sum+w*(v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);},0);};
          const contrast=color=>{const a=luminance(color),b=luminance(getComputedStyle(document.getElementById('nav-bar')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
          return {button:buttonRect,gauge:rect(button.querySelector('svg')),number:rect(number),title:titleRect,history,
            fill:button.style.getPropertyValue('--speed-fill'),hidden:arc.hasAttribute('hidden'),stroke:getComputedStyle(arc).stroke,
            arcContrast:contrast(getComputedStyle(arc).stroke),numberContrast:contrast(getComputedStyle(number).color),
            slow:getComputedStyle(button).getPropertyValue('--speed-slow').trim(),background:getComputedStyle(button).backgroundColor};
        },{id:session.id,rate});
        const badge=page.locator('#session-speed-button');await expect(badge).toHaveText(label);
        expect(geometry.button.width).toBe(44);expect(geometry.button.height).toBe(44);
        expect(geometry.gauge.width).toBe(32);expect(geometry.gauge.height).toBe(32);
        expect(geometry.number.width).toBeLessThanOrEqual(24);
        expect(geometry.number.x).toBeGreaterThan(geometry.gauge.x+3);
        expect(geometry.number.right).toBeLessThan(geometry.gauge.right-3);
        expect(geometry.button.right).toBeLessThanOrEqual(geometry.history.x-3);
        expect(geometry.title.width).toBeGreaterThan(100);
        expect(geometry.title.right).toBeLessThanOrEqual(geometry.button.x);
        expect(geometry.history.right).toBeLessThanOrEqual(375);
        expect(geometry.fill).toBe(String(Math.min(rate??0,100)));
        expect(geometry.hidden).toBe(!(rate>0));
        expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
        expect(geometry.slow).toBe(theme==='dark'?'#636366':'#8e8e93');
        expect(geometry.numberContrast).toBeGreaterThanOrEqual(4.5);
        if (rate>0) expect(geometry.arcContrast).toBeGreaterThanOrEqual(3);
        await expect(badge).toHaveAttribute('aria-label',rate===null?/No speed data/:/≈[\d,.]+ tok\/s/);
      }
      const short=await page.evaluate(id=>{
        const button=document.getElementById('session-speed-button');
        updateSessionSpeed(id,{rate:12,shortSample:false});const stroke=getComputedStyle(button.querySelector('.speed-gauge-value')).stroke;
        updateSessionSpeed(id,{rate:12,shortSample:true});
        return {stroke,shortStroke:getComputedStyle(button.querySelector('.speed-gauge-value')).stroke,numberColor:getComputedStyle(button.querySelector('.speed-gauge-number')).color,opacity:getComputedStyle(button).opacity};
      },session.id);
      expect(short.shortStroke).toBe(short.stroke);
      expect(short.numberColor).toBe(theme==='dark'?'rgb(142, 142, 147)':'rgb(102, 112, 133)');
      expect(short.opacity).toBe('1');
      await expect(page.locator('#session-speed-button')).toHaveAttribute('aria-label',/Short reply/);
      await page.locator('#nav-bar').screenshot({path:testInfo.outputPath(`speed-gauge-${theme}-short-375.png`)});
      await page.evaluate(id=>updateSessionSpeed(id,{rate:51,shortSample:false}),session.id);
      await page.locator('#nav-bar').screenshot({path:testInfo.outputPath(`speed-gauge-${theme}-375.png`)});
    }
    const badge=page.locator('#session-speed-button');
    await badge.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
    await expect(badge).toBeFocused();await expect(badge).toHaveCSS('outline-style','solid');
    await page.keyboard.press('Enter');await expect(page.locator('#session-speed-overlay')).toHaveClass(/active/);
    await expect(page.locator('.speed-method-note')).toContainText('Includes waiting for the first output');
    await page.keyboard.press('Escape');await expect(page.locator('#session-speed-overlay')).not.toHaveClass(/active/);
    const history=badge.locator('..').getByTitle('History',{exact:true});
    await history.click({position:{x:2,y:10}});await expect(page.locator('#history-view')).toHaveClass(/active/);
    await expect(page.locator('#session-speed-overlay')).not.toHaveClass(/active/);
  } finally {await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});

test('tiled and focused speed gauges share values and retain full click areas', async ({page}, testInfo) => {
  test.skip(testInfo.project.name!=='MacBook Pro 16','Tiled workspace is desktop only');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'glad-gauge-tile-e2e-'));
  const response=await page.request.post('/api/sessions',{data:{toolKey:'codex',name:'Gauge tile',workingDirectory:directory}});
  expect(response.ok()).toBe(true);const session=await response.json();
  try {
    await page.goto('/',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Collapse lobby and tile sessions'}).click();
    const tile=page.locator('.tile-session-window').filter({hasText:'Gauge tile'}),badge=tile.locator('.session-speed-badge');
    await expect(badge).toBeVisible();
    await tile.getByRole('button',{name:'Connect',exact:true}).click();
    await expect(page.locator('#terminal-view')).toHaveClass(/active/);
    await page.locator('#cmd-input').fill('__GLAD_E2E_SPEED__ complete a tiled sample');await page.locator('#send-btn').click();
    await expect(page.locator('#session-speed-button')).toHaveAttribute('title',/≈[\d,.]+ tok\/s/);
    await expect(badge).toHaveText(await page.locator('#session-speed-button').textContent());
    expect(await badge.innerHTML()).toBe(await page.locator('#session-speed-button').innerHTML());
    await page.getByRole('button',{name:'Return to tiled view'}).click();
    await expect(page.locator('body')).not.toHaveClass(/tile-focus-open/);await expect(badge).toBeVisible();
    // Resolve within the page so a live grid redraw cannot detach the measured node.
    const bounds=await page.evaluate(id=>{const button=document.querySelector(`.tile-session-window[data-session-id="${id}"] .session-speed-badge`);const b=button.getBoundingClientRect(),h=button.closest('header').getBoundingClientRect();return {width:b.width,height:b.height,top:b.top,bottom:b.bottom,headerTop:h.top,headerBottom:h.bottom,headerHeight:h.height};},session.id);
    expect(bounds.width).toBe(44);expect(bounds.height).toBe(44);expect(bounds.headerHeight).toBe(46);
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.headerTop);expect(bounds.bottom).toBeLessThanOrEqual(bounds.headerBottom);
    await page.screenshot({path:testInfo.outputPath('speed-gauge-tile.png')});
    await badge.click();await expect(page.locator('#session-speed-overlay')).toHaveClass(/active/);
  } finally {await page.request.delete(`/api/sessions/${session.id}`);fs.rmSync(directory,{recursive:true,force:true});}
});
