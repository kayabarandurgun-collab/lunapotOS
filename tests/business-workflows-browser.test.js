import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {findPlaywright} from '../scripts/design-audit.mjs';
const preview=process.env.BUSINESS_PREVIEW_URL;
test('integrated business screens: loaded data, headings fit, query navigation and mobile layout',{skip:!preview,timeout:180000},async t=>{
 const base=new URL(preview);assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const health=await (await fetch(new URL('/__preview/health',base))).json();assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const out='docs/system-upgrade-2026-10-04/business-screens';mkdirSync(out,{recursive:true});
 try{for(const width of [320,390,1440])await t.test(width+'px full application',async()=>{
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'});const errors=[],failures=[],writes=[];
  await context.route('**/*',route=>{const r=route.request();if(new URL(r.url()).origin!==base.origin)return route.abort();if(!['GET','HEAD'].includes(r.method())){writes.push(r.method()+' '+new URL(r.url()).pathname);return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failures.push(r.status()+' '+new URL(r.url()).pathname);});
  try{
   await page.goto(new URL('/__preview/start?role=owner&scenario=populated&next=/eticaret/',base).href);await page.waitForLoadState('networkidle');
   const ledger=await (await context.request.get(new URL('/api/ec/ledger',base).href)).json();const party=ledger.parties[0];assert.ok(party);
   const routes=[['/eticaret/#intake','.wb-heading'],['/eticaret/#workbench','.wb-heading'],['/eticaret/#warehouse','.wh-heading'],['/eticaret/#money','.mp-header'],['/eticaret/#business-result','.mp-header'],['/eticaret/#party?id='+party.id,'.pp-header'],['/eticaret/#product?id=preview-product-1','.wh-heading'],['/uretim/#intake','.wb-heading'],['/uretim/#workbench','.wb-heading'],['/uretim/#money','.mp-header']];
   for(const [path,selector] of routes){
    await page.goto(new URL(path,base).href);await page.waitForLoadState('networkidle');await page.locator(selector).waitFor();
    if(path.includes('#business-result'))await page.getByRole('heading',{name:'İşletme sonucu',exact:true}).waitFor();
    if(path.includes('#product'))await page.locator('.wh-metrics').first().waitFor();
    await page.waitForFunction(sel=>{const e=document.querySelector(sel);return e?.getBoundingClientRect().height>0;},selector);
    const layout=await page.evaluate(sel=>{const el=document.querySelector(sel);const h=el.getBoundingClientRect();return{height:h.height,position:getComputedStyle(el).position,overflow:[...el.children].filter(c=>c.getBoundingClientRect().height).map(c=>c.getBoundingClientRect().bottom-h.bottom).filter(n=>n>2),page:document.documentElement.scrollWidth<=innerWidth+1};},selector);
    assert.ok(layout.height>0,path);assert.equal(layout.position,'static',path+' content heading must scroll normally');assert.deepEqual(layout.overflow,[],path+' heading encloses its actions and description');assert.equal(layout.page,true,path+' fits viewport');
    const alerts=await page.locator('main [role="alert"]:visible').allTextContents();assert.deepEqual(alerts.filter(s=>s.trim()),[],path+' has no loading error');
    await page.screenshot({path:out+'/'+width+'-'+path.replace(/[^a-z0-9]+/gi,'-').slice(1,85)+'.png',fullPage:true});
   }
   // Same-route query changes must reload the selected period rather than retain the old screen.
   await page.goto(new URL('/eticaret/#money?from=2026-09-01&to=2026-09-30',base).href);await page.waitForLoadState('networkidle');
   await page.evaluate(()=>{location.hash='money?from=2026-08-01&to=2026-08-31';});await page.waitForLoadState('networkidle');
   await page.waitForFunction(()=>document.querySelector('[data-money-range] [name=from]')?.value==='2026-08-01');
   assert.deepEqual(failures,[],'all module assets and API calls succeed');assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  }finally{await context.close();}
 });}finally{await browser.close();}
});
