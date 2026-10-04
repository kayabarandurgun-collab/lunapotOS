import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';
const base=process.env.INSIGHTS_PREVIEW;
test('smart alerts in real local Chrome: loss, stock, links, filtering, recovery and narrow layouts',{skip:!base,timeout:180000},async t=>{
 assert.equal(new URL(base).hostname,'127.0.0.1');const health=await (await fetch(base+'/__preview/health')).json();assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright(),browser=await api.chromium.launch({headless:true,channel:'chrome'});const out=resolve('docs/sales-alerts-2026-10-04/screens');await mkdir(out,{recursive:true});
 try{
 for(const width of [1440,390,320])await t.test(width+'px warnings and correct deep links',async()=>{
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  try{
   await page.goto(base+'/__preview/start?role=owner&scenario=insights&next='+encodeURIComponent('/eticaret/#overview'));
   const price=page.locator('[data-signal-card=price]').filter({hasText:'Tropikal'}),stock=page.locator('[data-signal-card=stock]').filter({hasText:'Tropikal'});
   await price.waitFor();await stock.waitFor();assert.match(await price.innerText(),/Hepsiburada/);assert.match(await stock.innerText(),/Tropikal — sentetik tedarikçi/);
   await page.locator('[data-insight-filter=stock]').click();assert.equal(await page.locator('[data-signal-card=price]').count(),0);assert.ok(await page.locator('[data-signal-card=stock]').count()>0);
   await stock.locator('a').filter({hasText:'Tedarik planını aç'}).click();await page.waitForURL(/#warehouse/);await page.locator('[data-wh-form=config][data-id=signal-food]').waitFor({state:'attached'});await page.locator('.wh-reorder-list summary').click();await page.locator('[data-wh-form=config][data-id=signal-food]').waitFor();assert.equal(await page.locator('[data-wh-form=config]').count(),1,'stock link narrows to product');
   await page.goto(base+'/eticaret/#overview');await price.waitFor();await price.locator('a').filter({hasText:'Fiyatı hesapla'}).click();await page.waitForURL(/#pricing/);await page.locator('[name=mapping_id]').waitFor();await page.waitForFunction(()=>document.querySelector('[name=mapping_id]')?.value);
   assert.equal(await page.locator('[data-fh-kanal=hepsiburada]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('[data-offering-content]').innerText(),/Tropikal/);
   await page.goto(base+'/eticaret/#overview');await price.waitFor();await price.locator('summary').click();await price.locator('.signal-evidence a').first().click();await page.waitForURL(/#orders/);assert.ok(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('ac'));await page.locator('dialog[open]').waitFor();
   await page.goto(base+'/eticaret/#overview?from=2000-01-01&to=2000-01-02');await price.waitFor();assert.match(await price.innerText(),/Son 5 iadesiz teslim/,'alerts independent of selected historical dates');
   await page.locator('[data-insight-filter=all]').click();await stock.waitFor();await page.evaluate(()=>document.fonts.ready);
   const dims=await page.evaluate(()=>({inner:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dims.scroll<=dims.inner+1,'no page overflow');
   if(width<760){const small=await page.locator('[data-insight-center] button,[data-insight-center] .signal-actions a,[data-insight-center] summary').evaluateAll(xs=>xs.filter(e=>e.getClientRects().length).map(e=>({text:e.textContent,box:e.getBoundingClientRect()})).filter(x=>x.box.height<43.5));assert.deepEqual(small,[]);}
   await page.locator('[data-insight-center]').screenshot({path:resolve(out,'alerts-'+width+'.png')});assert.deepEqual(errors,[]);
  }finally{await context.close();}
 });
 await t.test('stock source fails independently and retry recovers without hiding loss signals',async()=>{const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();let fail=true;await page.route('**/api/ec/warehouse',r=>fail?r.abort():r.continue());try{await page.goto(base+'/__preview/start?role=owner&scenario=insights&next='+encodeURIComponent('/eticaret/#overview'));await page.locator('[data-signal-card=price]').first().waitFor();await page.locator('[data-overview-retry=stock-alerts]').waitFor();assert.match(await page.locator('[data-insight-center]').innerText(),/Stok uyarıları alınamadı/);fail=false;await page.locator('[data-overview-retry=stock-alerts]').click();await page.locator('[data-signal-card=stock]').first().waitFor();}finally{await context.close();}});
 await t.test('sales alert retry has a distinct action and recovers the shared period source',async()=>{const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();let fail=true;await page.route('**/api/ec/panorama**',r=>fail?r.abort():r.continue());try{await page.goto(base+'/__preview/start?role=owner&scenario=insights&next='+encodeURIComponent('/eticaret/#overview'));await page.locator('[data-overview-retry=sales-alerts]').waitFor();assert.equal(await page.locator('[data-overview-retry=panorama]').count(),1);await page.locator('[data-signal-card=stock]').first().waitFor();fail=false;await page.locator('[data-overview-retry=sales-alerts]').click();await page.locator('[data-signal-card=price]').first().waitFor();assert.equal(await page.locator('[data-overview-retry=panorama]').count(),0);}finally{await context.close();}});
 }finally{await browser.close();}
});
