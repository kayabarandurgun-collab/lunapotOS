import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {findPlaywright} from '../scripts/design-audit.mjs';
const preview=process.env.REBUILD_STOCK_PREVIEW;
test('rebuild stock and purchase: compact folds, full numbers, preserved sort and record workbench',{skip:!preview,timeout:90000},async t=>{
 const base=new URL(preview);assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();const browser=await api.chromium.launch({headless:true,channel:'chrome'});const out='docs/ux-2026-10-03/rebuild-stock-purchase';await mkdir(out,{recursive:true});
 try{for(const width of [320,390,1440])await t.test('fold '+width,async()=>{
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage(),blocked=[],errors=[];
  await context.route('**/*',r=>{const req=r.request();if(new URL(req.url()).origin!==base.origin||!['GET','HEAD'].includes(req.method())){blocked.push(req.method()+' '+req.url());return r.abort();}return r.continue();});page.on('pageerror',e=>errors.push(e.message));
  const go=async hash=>page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/eticaret/'+hash}),base).href);
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  try{
   await go('#stock');await page.locator('.stock-ledger-row').first().waitFor();await noOverflow();
   const fold=await page.locator('.stock-physical dd').first().boundingBox();assert.ok(fold.y<(width===320?590:550),'physical shelf quantity visible in first fold');
   const first=page.locator('.stock-ledger-row').first();assert.equal(await first.locator('.stock-amount').first().evaluate(e=>getComputedStyle(e).whiteSpace),'nowrap');
   await page.screenshot({path:out+'/stock-'+width+'.png',fullPage:false});
   await page.locator('.stock-refinements>summary').click();await page.locator('[name="sort"]').selectOption('quantity');
   const shown=await page.locator('.stock-ledger-row').evaluateAll(rows=>rows.map(r=>({id:r.dataset.stockProduct,quantity:r.querySelector('.stock-physical dd').textContent})));const data=await context.request.get(new URL('/api/ec',base).href).then(r=>r.json());const byId=new Map(data.stock.map(p=>[p.id,p.on_hand_milli]));assert.ok(shown.every((r,i)=>!i||byId.get(shown[i-1].id)>=byId.get(r.id)));
   await go('#invoices');await page.locator('.invoice-intake').waitFor();await noOverflow();assert.equal(await page.locator('.invoice-filter-options').getAttribute('open'),null);await page.screenshot({path:out+'/invoices-'+width+'.png',fullPage:false});
   await page.locator('.invoice-filter-options>summary').click();await page.locator('[name="status"]').selectOption('draft');const prior=await page.locator('[data-ac-form="invoice-filters"]').elementHandle();await page.locator('[data-ac-form="invoice-filters"] [type="submit"]').click();await page.waitForFunction(el=>!el.isConnected,prior);await prior.dispose();assert.equal(await page.locator('[name="status"]').inputValue(),'draft');await noOverflow();
   await page.locator('[data-ac="purchase-document"]').click();await page.locator('[data-pd="file"]').waitFor({state:'attached'});assert.equal(await page.locator('.pd-steps li').count(),3);assert.equal(await page.locator('.pd-steps [aria-current="step"]').innerText().then(t=>t.includes('Dosya seç')),true);await noOverflow();
   await page.screenshot({path:out+'/upload-'+width+'.png',fullPage:false});await page.locator('[data-pd="manual"]').click();await page.locator('[data-ac-form="invoice"]').waitFor();await noOverflow();await page.locator('[data-ac-form="invoice"] [data-ac="close"]').first().click();
   assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }finally{await context.close();}
 });
 await t.test('large quantities retain every digit on 390px',async()=>{const context=await browser.newContext({viewport:{width:390,height:1000},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();await context.route('**/*',async r=>{const req=r.request(),u=new URL(req.url());if(u.origin!==base.origin||!['GET','HEAD'].includes(req.method()))return r.abort();if(u.pathname==='/api/ec'){const response=await r.fetch(),json=await response.json();for(const p of json.stock){p.quantity_milli=p.on_hand_milli=123456789000;p.available_milli=123456788000;p.reserved_milli=1000;}return r.fulfill({response,json});}return r.continue();});try{await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/eticaret/#stock'}),base).href);const qty=page.locator('.stock-physical dd').first();await qty.waitFor();assert.equal(await qty.innerText(),'123.456.789');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await qty.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await page.screenshot({path:out+'/stock-large-390.png',fullPage:false});}finally{await context.close();}});
 }finally{await browser.close();}
});
