
import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.SALES_UI_BROWSER==='1';
test('sales UI local preview: desktop/mobile, filters, drilldowns, CSV, pending, hidden and empty states',{skip:!enabled,timeout:120000},async t=>{
 const base=new URL(process.env.SALES_UI_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const found=await findPlaywright();assert.ok(found.api,'Installed Playwright is required; never download dependencies.');
 const browser=await found.api.chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({acceptDownloads:true});
 const external=[],errors=[];
 await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==base.origin){external.push(route.request().url());return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const start=async(path,scenario='populated',role='owner')=>{
  await page.goto(base.origin+'/__preview/start?scenario='+scenario+'&role='+role+'&next='+encodeURIComponent('/eticaret/'+path));
 };
 const loaded=()=>page.locator('.insights-performance[aria-busy="false"]').waitFor();
 const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'document must fit viewport');
 try{
  for(const width of [360,390,1440])for(const scenario of ['populated','missing','empty']){
   await t.test(width+'px / '+scenario,async()=>{
    await page.setViewportSize({width,height:900});await start('#performance?view=sales',scenario);await loaded();
    await noOverflow();assert.equal(await page.locator('[data-view="sales"]').getAttribute('aria-pressed'),'true');
    assert.ok((await page.screenshot()).length>5000,'render produces an image');
    if(scenario==='empty'){assert.match(await page.locator('.sales-report').innerText(),/Bu dönemde satış kaydı yok/);return;}
    assert.ok(await page.locator('.sales-row').count()>0);
    const totals=await page.locator('.ins-report-kpis').innerText(),returns=await page.locator('.sales-return-summary').innerText();
    await page.selectOption('[name="kind"]','bundle');await page.locator('[data-performance-filter] button[type="submit"]').click();
    assert.equal(await page.locator('.ins-report-kpis').innerText(),totals);assert.equal(await page.locator('.sales-return-summary').innerText(),returns);
    assert.ok(page.url().includes('view=sales')&&page.url().includes('kind=bundle'));
    const rows=page.locator('.sales-row');assert.ok(await rows.count()>0,'seeded orchid kit present');
    await rows.first().locator(':scope > summary').click();assert.equal(await rows.first().locator('.sales-composition li').count(),3);
    assert.ok(await rows.first().locator('.sales-contributions article').count()>0);await noOverflow();
    await page.locator('[data-sales-reset]').click();
    await page.fill('[name="q"]','NO-SUCH-SYNTHETIC-OFFERING');await page.locator('[data-performance-filter] button[type="submit"]').click();
    assert.match(await page.locator('.sales-report').innerText(),/Bu seçimde satış biçimi bulunamadı/);
    assert.equal(await page.locator('.ins-report-kpis').innerText(),totals);
    await page.locator('[data-sales-reset]').click();
    await page.locator('[data-view="packages"]').click();assert.ok(await page.locator('.pf-row').count()>0);
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('[data-export]').click()]);
    const stream=await download.createReadStream();let text='';for await(const chunk of stream)text+=chunk;
    assert.match(text,/Sipariş/);assert.match(download.suggestedFilename(),/lunapot-packages-delivered/);
    await page.locator('[data-mode="pending"]').click();await loaded();
    const pending=await page.locator('.sales-pending-status').innerText();assert.match(pending,/Hazırlanan/);assert.match(pending,/Kargoda/);await noOverflow();
    await start('#overview',scenario);await page.locator('[data-sales-rankings]').waitFor();
    const kpi=await page.locator('.insights-panorama .ins-kpis').boundingBox(),date=await page.locator('.insights-panorama .ins-date-disclosure').boundingBox();
    assert.ok(kpi.y<date.y,'financial summary precedes date controls');await noOverflow();
    await page.selectOption('[data-panorama-kind]','multipack');assert.match(await page.locator('[data-product-panel="profit"]').innerText(),/Çoklu paket/);
    await page.locator('[data-product-view="profit"]').focus();await page.keyboard.press('End');
    assert.equal(await page.locator('[data-product-view="revenue"]').getAttribute('aria-selected'),'true');
   });
  }
  for(const width of [390,1440])await t.test(width+'px / reader hidden amounts',async()=>{
   await page.setViewportSize({width,height:900});await start('#performance?view=sales','populated','reader');await loaded();
   assert.equal((await page.locator('.ins-kpi-primary>strong').innerText()).trim(),'Bilgi eksik');
   for(const value of await page.locator('.sales-row>summary .sales-amounts dd').allTextContents())assert.equal(value.trim(),'Bilgi eksik');
   assert.doesNotMatch(await page.locator('.sales-return-summary').innerText(),/₺0,00/);await noOverflow();
  });
  await t.test('anonymous returns to login without sales values',async()=>{
   await start('#performance?view=sales','populated','anonymous');assert.equal(await page.locator('.sales-row').count(),0);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{await context.close();await browser.close();}
});
