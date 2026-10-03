import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';

// Read-only local preview. Every business POST and every external request is blocked.
const preview=process.env.REPORTS_ORDERS_PREVIEW_URL;
test('daily report upload and orders: intents, recovery, mobile detail and lifecycle',{skip:!preview,timeout:180000},async t=>{
 const base=new URL(preview);
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Installed Playwright required; no dependency download.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const withPage=async(run,{path='#reports',scenario='populated',role='owner',width=390,intercept=()=>false}={})=>{
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block',reducedMotion:'reduce'}),blocked=[],errors=[];
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==base.origin||!['GET','HEAD'].includes(request.method())){blocked.push(request.method()+' '+url.href);return route.abort();}
   if(await intercept(route,url))return;
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario,next:'/eticaret/'+path}),base).href);
   await run(page);
   assert.deepEqual(errors,[],'no unhandled page errors');assert.deepEqual(blocked,[],'no business writes or external requests');
  }finally{await context.close();}
 };
 const readyReports=async page=>{await page.locator('[data-rb="file"]').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-rb="file"]')?.disabled);};
 const readyOrders=async page=>{await page.locator('[data-order-list]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-order-list]')?.textContent.trim());};
 const go=async(page,hash)=>{await page.evaluate(hash=>{if(location.hash===hash)window.dispatchEvent(new HashChangeEvent('hashchange'));else location.hash=hash;},hash);};
 const noOverflow=async(page,selector)=>{
  const sizes=await page.locator(selector).evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));
  assert.ok(sizes.scroll<=sizes.width+2,selector+' horizontal overflow: '+JSON.stringify(sizes));
 };
 const screenshot=async(page,name)=>{if(process.env.REPORTS_ORDERS_SCREENSHOT_DIR){await mkdir(process.env.REPORTS_ORDERS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.REPORTS_ORDERS_SCREENSHOT_DIR,name+'.png'),fullPage:false});}};
 try{
  for(const width of [390,1440])await t.test(width+'px upload-first and repeated same-route intent',()=>withPage(async page=>{
   await readyReports(page);
   await page.waitForFunction(()=>document.activeElement?.matches('[data-rb="file"]'));
   assert.equal(new URL(page.url()).hash,'#reports?keep=1','consume upload only, preserve other parameters');
   const file=await page.locator('[data-rb="file"]').boundingBox();assert.ok(file.y+file.height<844,'file picker fits first viewport');
   assert.equal(await page.locator('[data-rb-source-settings]').getAttribute('open'),null,'source settings are progressive');
   assert.match(await page.locator('.rb-upload-card').innerText(),/Sipariş raporu:[\s\S]*Finans \/ hakediş raporu:/);
   await page.evaluate(()=>{window.__reportRoot=document.querySelector('.rb').parentElement;});
   await page.locator('[data-rb-tab="files"]').click();await page.locator('.rb h3').filter({hasText:'Yüklenen dosyalar'}).waitFor();
   await go(page,'#reports?action=upload&keep=1');await readyReports(page);
   assert.equal(await page.evaluate(()=>window.__reportRoot===document.querySelector('.rb').parentElement),true,'same route keeps mounted module');
   await page.locator('[data-rb="snapshot"]').evaluate(e=>{e.value='2026-09-25T10:00';e.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.locator('[data-rb-tab="files"]').click();
   await page.evaluate(()=>{history.replaceState(history.state,'','#reports?action=upload&keep=1');window.dispatchEvent(new HashChangeEvent('hashchange'));});
   await readyReports(page);assert.equal(await page.locator('[data-rb="snapshot"]').inputValue(),'2026-09-25T10:00');
   await noOverflow(page,'.rb');await screenshot(page,'reports-'+width);
  },{width,path:'#reports?action=upload&keep=1'}));

  await t.test('report GET failure offers retry instead of fake first-store onboarding',async()=>{
   let fails=true,count=0;
   await withPage(async page=>{
    await page.locator('[data-rb-act="reload"]').waitFor();assert.equal(await page.locator('[data-rb-form="store"]').count(),0);
    fails=false;await page.locator('[data-rb-act="reload"]').click();await readyReports(page);assert.equal(count,2);
   },{intercept:async(route,url)=>{if(url.pathname!=='/api/ec/reports')return false;count++;if(!fails)return false;await route.fulfill({status:503,json:{error:'Temsili bağlantı sorunu'}});return true;}});
  });

  await t.test('unknown source/type keeps selected file and asks only for missing information',()=>withPage(async page=>{
   await readyReports(page);
   await page.locator('[data-rb="file"]').setInputFiles({name:'ornek-rapor.csv',mimeType:'text/csv',buffer:Buffer.from('Kod,Adet\nORNEK,1\n')});
   const form=page.locator('[data-rb-form="source"]');await form.waitFor();
   assert.match(await page.locator('.rb-upload-card').innerText(),/ornek-rapor.csv[\s\S]*yeniden seçmen gerekmiyor/);
   await form.locator('[name="store"]').selectOption('preview-hepsiburada');await form.locator('button[type="submit"]').click();
   await form.locator('[name="kind"]').waitFor();assert.equal(await form.locator('[name="store"]').count(),0);
   await form.locator('[name="kind"]').selectOption('finance');await form.locator('button[type="submit"]').click();
   await page.locator('[data-rb-form="map"]').waitFor();assert.match(await page.locator('.rb-kind').innerText(),/Finans \/ hakediş/);
   await page.locator('[data-rb-tab="files"]').click();await go(page,'#reports?action=upload');
   await page.locator('[data-rb-form="map"]').waitFor();assert.match(await page.locator('.rb-kind').innerText(),/ornek-rapor.csv/);
   await noOverflow(page,'.rb');
  }));

  await t.test('first store, no files and no results have usable next steps',()=>withPage(async page=>{
   await page.locator('[data-rb-form="store"]').waitFor();assert.equal(await page.locator('[data-rb="file"]').count(),0);
   await page.locator('[data-rb-tab="files"]').click();await page.getByRole('heading',{name:'Henüz rapor yüklenmedi.'}).waitFor();
   await page.locator('.v2-empty [data-rb-tab="upload"]').click();await page.locator('[data-rb-form="store"]').waitFor();
   await go(page,'#orders');await readyOrders(page);assert.match(await page.locator('[data-order-list]').innerText(),/Henüz sipariş yok/);
   await page.locator('[data-order-list] [data-order="new"]').click();await page.locator('dialog[open]').waitFor();
   await page.keyboard.press('Escape');
  },{scenario:'empty'}));

  await t.test('advanced report tools stay accessible and dialog is removed on route departure',()=>withPage(async page=>{
   await readyReports(page);await page.locator('[data-rb-tab="orders"]').click();
   await page.locator('[data-rb="order-store"]').selectOption('preview-trendyol');
   const maintenance=page.locator('[data-rb-maintenance]');await maintenance.waitFor();
   await page.waitForFunction(()=>document.querySelector('[data-rb="order-store"]')?.disabled===false);
   assert.equal(await maintenance.getAttribute('open'),null);assert.equal(await page.locator('[data-rb-act="fees-preview"]').isVisible(),false);
   await maintenance.locator('summary').first().click();assert.equal(await page.locator('[data-rb-act="backfill"]').isVisible(),true);
   await page.locator('[data-rb-act="fees-preview"]').click();await page.waitForFunction(()=>document.querySelector('[data-rb="order-store"]')?.disabled===false);
   assert.notEqual(await maintenance.getAttribute('open'),null,'advanced panel stays open after rendering');
   const evidence=page.locator('[data-rb-act="evidence"]');
   assert.ok(await evidence.count()>0,'synthetic report has unmatched fee evidence');await evidence.first().click();
   await page.locator('dialog[open]').waitFor();await go(page,'#orders');await readyOrders(page);
   assert.equal(await page.locator('dialog[open]').count(),0,'body-owned report dialog removed on unmount');
  },{intercept:async(route,url)=>{
   if(url.pathname!=='/api/ec/reports/orders')return false;
   await route.fulfill({json:{total:1,page:1,page_size:100,statuses:[],results:[{group:'synthetic-evidence',order_no:'SENTETIK-KANIT',order_date:'2026-09-25',status:'Teslim edildi',lines:[],reported_net_cents:null,computed_net_cents:null,contribution_cents:null,contribution_missing:['Kesinti bekleniyor'],notes:[],bank_note:'Tahsilat doğrulanmadı',estimates:[],estimated_result_cents:null,fee_events:[{id:'synthetic-fee',label:'Komisyon',amount_cents:1200,invoice_line_id:null}]}]}});return true;
  }}));

  for(const width of [390,1440])await t.test(width+'px orders browse, correction and deep links',()=>withPage(async page=>{
   await readyOrders(page);await noOverflow(page,'.ol-daily');
   const button=page.locator('[data-order="detail"]').first(),id=await button.getAttribute('data-id');
   await button.focus();await page.keyboard.press('Enter');const dialog=page.locator('dialog.order-insights[open]');await dialog.locator('.order-sold').waitFor();
   assert.match(new URL(page.url()).hash,new RegExp('ac='+id));
   assert.equal(await dialog.getByRole('heading',{name:'Müşteri ve teslimat'}).isVisible(),true,'shipment details do not depend on expense evidence');
   const estimate=dialog.locator('details').filter({has:page.getByRole('heading',{name:'Bu paket için kâr planı'})});
   assert.equal(await estimate.getAttribute('open'),null,'optional estimate is collapsed');
   await dialog.locator('.order-sold .offering-components summary').first().click();
   await dialog.locator('[data-order="duzeltme"]').first().click();await page.getByRole('heading',{name:'Depodan çıkanı düzelt',exact:true}).waitFor();
   assert.equal(await page.locator('[data-duz-tur]').isVisible(),true);await noOverflow(page,'dialog[open] .form-body');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
   await page.waitForFunction(()=>!new URLSearchParams(location.hash.split('?')[1]).has('ac'));
   await go(page,'#orders?package='+id);await page.locator('dialog.order-insights .order-sold').waitFor();
   await noOverflow(page,'dialog[open] .form-body');await screenshot(page,'order-detail-'+width);
   await go(page,'#reports?action=upload');await readyReports(page);
   await page.waitForTimeout(80);assert.match(new URL(page.url()).hash,/^#reports/,'unmounted order close callback cannot navigate back');
  },{width,path:'#orders'}));

  await t.test('initial order failure retries and rapid searches keep last intent',async()=>{
   let fail=true;
   await withPage(async page=>{
    await page.locator('[data-order="reload"]').waitFor();fail=false;await page.locator('[data-order="reload"]').click();await readyOrders(page);
    await page.locator('dialog.order-insights .order-sold').waitFor();
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
    const input=page.locator('[data-ol-search] input');await input.fill('not-an-order');await page.locator('[data-ol-search]').evaluate(e=>e.requestSubmit());
    await page.waitForTimeout(50);await input.fill('SENTETIK');await page.locator('[data-ol-search]').evaluate(e=>e.requestSubmit());
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('q')==='SENTETIK');
    await page.waitForTimeout(450);assert.ok(await page.locator('[data-order="detail"]').count()>0,'late empty response cannot overwrite current list');
    await input.fill('no-match-ever');await input.press('Enter');await page.locator('[data-order="clear-filters"]').waitFor();
    await page.locator('[data-order="clear-filters"]').click();await page.waitForFunction(()=>document.querySelector('[data-order="detail"]'));
    assert.equal(await input.inputValue(),'');
   },{path:'#orders?package=preview-package-001',intercept:async(route,url)=>{
    if(url.pathname!=='/api/ec/orders')return false;
    if(fail){await route.fulfill({status:503,json:{error:'Temsili liste hatası'}});return true;}
    if(url.searchParams.get('q')==='not-an-order')await new Promise(r=>setTimeout(r,300));
    return false;
   }});
  });
 }finally{await browser.close();}
});
