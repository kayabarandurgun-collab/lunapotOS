import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';
const preview=process.env.DAILY_PREVIEW_URL;
test('daily workflows: direct actions, mobile menus, search, permissions and readable forms',{skip:!preview,timeout:180000},async t=>{
 const base=new URL(preview);assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const health=await (await fetch(new URL('/__preview/health',base))).json();assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const out=resolve('docs/ux-rebuild-2026-10-04/workflows');await mkdir(out,{recursive:true});
 async function run(width,role,callback){
  const ctx=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),writes=[],errors=[];
  await ctx.route('**/*',async r=>{const req=r.request();if(new URL(req.url()).origin!==base.origin||!['GET','HEAD'].includes(req.method())){writes.push(req.method()+' '+new URL(req.url()).pathname);return r.abort();}return r.continue();});
  const page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const go=async(path='/eticaret/#overview')=>{await page.goto(new URL('/__preview/start?role='+role+'&next='+encodeURIComponent(path),base).href);await page.waitForLoadState('networkidle');};
  const fits=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no document overflow');
  try{await callback(page,go,fits);assert.deepEqual(errors,[]);assert.deepEqual(writes,[],'opening and exploring workflows writes no business record');}finally{await ctx.close();}
 }
 try{
  for(const width of [320,390,1440])await t.test(width+'px owner daily entry points',()=>run(width,'owner',async(page,go,fits)=>{
   await go();await page.locator('[data-daily-home] [data-daily-task=intake]').waitFor();
   assert.equal(await page.locator('[data-daily-home] [data-daily-task]').count(),4);await fits();
   assert.equal(await page.locator('.daily-analysis[data-disclosure=trend][open]').count(),1,'real sales chart is immediately discoverable');
   assert.equal(await page.locator('.daily-analysis[data-disclosure=offerings][open]').count(),0,'secondary sales ranking remains optional');
   assert.ok((await page.locator('.ins-kpi-primary').boundingBox()).y<500,'cash result is visible without a long action-card scroll');
   await page.screenshot({path:resolve(out,'overview-'+width+'.png')});
   await page.locator('[data-daily-home] [data-daily-task=intake]').click();await page.locator('[data-wb-file]').waitFor();await fits();
   await page.screenshot({path:resolve(out,'reports-'+width+'.png')});
   await page.locator('[data-new-task]').click();await page.locator('.daily-task-dialog[open]').waitFor();
   await page.locator('.daily-task-dialog [data-daily-task=intake]').click();await page.locator('[data-wb-file]').waitFor();await fits();
   assert.match(await page.locator('[data-wb-file]').getAttribute('accept'),/pdf/);assert.match(await page.locator('[data-wb-file]').getAttribute('accept'),/xlsx/);
   await page.screenshot({path:resolve(out,'invoice-'+width+'.png')});
   // Real route lifecycle back/forward must return to the right screen.
   await go('/eticaret/#stock');await page.locator('.stock-tasks').waitFor();await fits();
   await page.screenshot({path:resolve(out,'stock-'+width+'.png')});
   await page.locator('[data-new-task]').click();await page.locator('.daily-task-dialog [data-daily-task=unbilled]').click();
   const form=page.locator('dialog[open] [data-ac-form=unbilled]');await form.waitFor();
   assert.match(await form.innerText(),/bu teslimatta|yeni gelen/i);assert.match(await form.innerText(),/geçici borç/);
   const product=form.locator('[name=product_id]').first();await product.selectOption({index:1});await form.locator('[name=quantity]').first().fill('5');
   assert.match(await form.locator('[data-unbilled-preview]').first().innerText(),/Yeni gelen: 5/);
   const size=await page.locator('dialog[open]').boundingBox();assert.ok(size.width<=width,'dialog fits phone');
   await page.screenshot({path:resolve(out,'unbilled-'+width+'.png')});
   await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
   await page.locator('[data-quick-nav]').click();await page.locator('.ui-command input').fill('faturasiz');
   const result=page.locator('.ui-command-result');assert.equal(await result.count(),1);assert.match(await result.innerText(),/Faturasız mal girişi/);
   await result.click();await page.locator('dialog[open] [data-ac-form=unbilled]').waitFor();await page.keyboard.press('Escape');
   if(width<801){assert.deepEqual(await page.locator('.mobile-dock a').evaluateAll(a=>a.map(n=>n.hash)),['#overview','#intake','#stock','#workbench']);await page.locator('[data-dock-menu]').click();await page.locator('#sidebar.open').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('[data-dock-menu]').getAttribute('aria-expanded'),'false');}
  }));
  await t.test('reader cannot discover write actions',()=>run(390,'reader',async(page,go,fits)=>{
   await go();await page.locator('[data-new-task]').click();assert.deepEqual(await page.locator('.daily-task-dialog [data-daily-task]').evaluateAll(a=>a.map(n=>n.dataset.dailyTask)),['warehouse']);await page.keyboard.press('Escape');
   await page.locator('[data-quick-nav]').click();await page.locator('.ui-command input').fill('faturasiz');assert.equal(await page.locator('.ui-command-result').count(),0);await page.keyboard.press('Escape');await fits();
  }));
  await t.test('application launcher offers direct daily work without selecting a workspace first',()=>run(390,'owner',async(page,go,fits)=>{
   await go('/');await page.locator('#quick-start [data-daily-task=intake]').waitFor();assert.equal(await page.locator('#quick-start [data-daily-task]').count(),4);await fits();
   await page.locator('#quick-start [data-daily-task=intake]').click();await page.locator('[data-wb-file]').waitFor();await fits();
  }));
 }finally{await browser.close();}
});
