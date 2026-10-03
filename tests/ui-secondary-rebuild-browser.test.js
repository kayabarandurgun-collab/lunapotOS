import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {findPlaywright} from '../scripts/design-audit.mjs';
const enabled=process.env.UI_SECONDARY_REBUILD_BROWSER==='1';
test('secondary rebuild: focused navigation and legible workbenches', {skip:!enabled,timeout:120000}, async t=>{
 const base='http://127.0.0.1:18731';
 const health=await fetch(base+'/__preview/health').then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const out='docs/ux-rebuild-2026-10-04/secondary';await mkdir(out,{recursive:true});const results=[];
 try{for(const width of [360,1440])await t.test(width+'px records, section navigation, editor return and test operations',async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});const errors=[],blocked=[];
  await context.route('**/*',route=>{const r=route.request();if(new URL(r.url()).origin!==base||!['GET','HEAD'].includes(r.method())){blocked.push(r.method()+' '+r.url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>{await page.evaluate(()=>document.fonts.ready);const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert.ok(layout.scrollWidth<=width+1, name+' overflow');await page.screenshot({path:out+'/'+name+'-'+width+'.png',fullPage:true});results.push({name,width,...layout});};
  try{
   await page.goto(base+'/__preview/start?scenario=populated&role=owner&next='+encodeURIComponent('/uretim/#production'));
   await page.locator('.production-jobs tbody tr').first().waitFor();assert.match(await page.locator('.production-jobs tbody td').first().innerText(),/\S/);await shot('production');
   await page.goto(base+'/uretim/#materialstock');await page.locator('.production-materials tbody tr').first().waitFor();assert.equal(await page.locator('.production-scan').getAttribute('open'),null);await shot('materials');
   await page.goto(base+'/access');await page.locator('.access-team tbody tr').first().waitFor();await page.waitForFunction(()=>document.querySelector('#recovery')?.hidden===true);await shot('team');
   await page.locator('[data-edit]').first().click();assert.equal(await page.locator('#team').isVisible(),false);assert.equal(await page.locator('[data-form=edit]').isVisible(),true);await shot('team-edit');
   await page.locator('[data-team-back]').first().click();assert.equal(await page.locator('#team').isVisible(),true);assert.equal(await page.locator('[data-form=edit]').count(),0);assert.equal(await page.locator('[data-edit]').first().evaluate(el=>el===document.activeElement),true);
   await page.locator('.access-sections a[href="#account"]').click();assert.equal(await page.locator('#account').isVisible(),true);assert.equal(await page.locator('#team').isVisible(),false);
   await page.locator('.access-sections a[href="#team"]').click();await page.locator('[data-edit]').first().click();await page.locator('.access-sections a[href="#team"]').click();assert.equal(await page.locator('#team').isVisible(),true);assert.equal(await page.locator('#edit-area').isVisible(),false);
   await page.locator('[data-new-employee]').first().click();assert.equal(await page.locator('#create-team').isVisible(),true);assert.equal(await page.locator('#team').isVisible(),false);await page.locator('#create-team [data-team-back]').click();assert.equal(await page.locator('#team').isVisible(),true);
   await page.goto(base+'/webmagaza/#overview');await page.locator('#ws-app[aria-busy=false] .ws-operations').waitFor();assert.equal(await page.locator('.test-banner').isVisible(),true);assert.equal(await page.locator('.ws-operation').count(),3);assert.match(await page.locator('.ws-operations').innerText(),/Gerçek satış kapalı/);await shot('webshop');
   await page.locator('.ws-operation[href="#orders"]').click();await page.locator('#ws-app[aria-busy=false] [data-order]').first().waitFor();await shot('webshop-orders');
   assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }finally{await context.close();}
 });await writeFile(out+'/layout.json',JSON.stringify(results,null,2));}finally{await browser.close();}
});
