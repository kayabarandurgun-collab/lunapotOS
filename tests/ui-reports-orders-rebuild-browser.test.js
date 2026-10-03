import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';
const preview=process.env.REPORTS_ORDERS_PREVIEW_URL;
const output=process.env.REPORTS_ORDERS_SCREENSHOT_DIR;

test('rebuilt report and order workbenches expose real work in the first viewport',{skip:!preview,timeout:180000},async t=>{
 const base=new URL(preview);assert.equal(base.origin,'http://127.0.0.1:18731');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const shot=async(page,name)=>{if(!output)return;await mkdir(output,{recursive:true});await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});await page.screenshot({path:join(output,name+'.png'),fullPage:false});};
 const visit=async(width,hash,run,intercept=()=>false,role='owner')=>{
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),blocked=[],errors=[];
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==base.origin){blocked.push(req.url());return route.abort();}if(await intercept(route,url))return;if(!['GET','HEAD'].includes(req.method())){blocked.push(req.method()+' '+url.pathname);return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  try{await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario:'populated',next:'/eticaret/'+hash}),base).href);await run(page);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);}
  finally{await context.close();}
 };
 const ready=async page=>{await page.locator('[data-rb="file"]').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-rb="file"]')?.disabled);};
 const fit=async(page,selector)=>{assert.equal(await page.locator(selector).evaluate(e=>e.scrollWidth<=e.clientWidth+2),true,selector+' fits viewport');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true,'whole page fits viewport');};
 try{
  for(const width of [320,390,1440])await t.test(width+'px upload and recent files form one visible workspace',()=>visit(width,'#reports',async page=>{
   await ready(page);await fit(page,'.rb-document-workbench');
   const picker=await page.locator('.rb-drop').boundingBox(),recent=await page.locator('.rb-files h3').first().boundingBox();
   assert.ok(picker.y+picker.height<640,'upload target ends before first-fold file area');assert.ok(recent.y<800,'recent-file heading visible without hunting');
   const context=page.locator('[data-rb-context]');assert.equal((await context.getAttribute('open'))!==null,width>879,'guidance is contextual desktop / folded mobile');
   assert.equal(await page.locator('[data-rb="file"]').evaluate(e=>getComputedStyle(e).opacity),'0','native picker uses the accessible full drop surface');
   assert.ok(await page.locator('.rb-file-row').count()>0,'recent files shown next to upload workflow');
   await shot(page,'rebuild-reports-'+width);
   await page.locator('.rb-tabs [data-rb-tab="files"]').click();await page.locator('[data-rb-form="files"]').waitFor();
   const form=page.locator('[data-rb-form="files"]');await form.locator('[name="q"]').fill('DOES-NOT-EXIST');await form.locator('button').click();
   await page.getByRole('heading',{name:'Bu aramada dosya yok.'}).waitFor();assert.equal(await page.locator('.rb-file-row').count(),0);
   await page.locator('[data-rb-act="clear-files"]').click();assert.ok(await page.locator('.rb-file-row').count()>0);await fit(page,'.rb-files');
   await shot(page,'rebuild-files-'+width);
  }));
  for(const width of [320,390,1440])await t.test(width+'px orders reveal packages before expanded filters',()=>visit(width,'#orders',async page=>{
   const first=page.locator('[data-ol-row]').first();await first.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-order-list]')?.closest('[aria-busy=true]'));
   assert.equal(await page.locator('[data-ol-more]').getAttribute('open'),null);
   const row=await first.boundingBox();assert.ok(row.y<640,'first package visible before scrolling');assert.ok((await first.locator('.ol-order-id').innerText()).trim());await fit(page,'.ol-workbench');
   await shot(page,'rebuild-orders-'+width);
   if(width<=760){const channel=page.locator('[data-ol-channel-select]');assert.equal(await channel.isVisible(),true);await channel.selectOption('other');await page.waitForFunction(()=>location.hash.includes('channel=other'));await channel.selectOption('');await page.waitForFunction(()=>!location.hash.includes('channel='));}
   else {await page.locator('[data-ol-kanal="trendyol"]').click();await page.waitForFunction(()=>location.hash.includes('channel=trendyol'));await page.locator('[data-ol-kanal=""]').click();}
   await page.locator('[data-ol-durum="shipped"]').click();await page.waitForFunction(()=>location.hash.includes('status=shipped'));await page.waitForFunction(()=>!document.querySelector('[data-order-list]')?.closest('[aria-busy=true]'));
   assert.match(await page.locator('[data-ol-current-scope]').innerText(),/Kargoda/);
   await page.locator('[data-ol-more]>summary').click();await page.locator('[data-ol-sonuc-sec="zarar"]').click();await page.waitForFunction(()=>location.hash.includes('sonuc=zarar'));
   await fit(page,'.ol-workbench');
  }));
  await t.test('read-only staff can browse the workbench but cannot upload or create orders',()=>visit(390,'#reports',async page=>{
   await page.locator('[data-rb="file"]').waitFor();await page.waitForFunction(()=>document.querySelector('.rb')?.parentElement.getAttribute('aria-busy')==='false');
   assert.equal(await page.locator('[data-rb="file"]').isDisabled(),true);
   await page.locator('.rb-tabs [data-rb-tab="files"]').click();await page.locator('[data-rb-form="files"]').waitFor();assert.equal(await page.locator('[data-rb-form="files"] button').isEnabled(),true);
   await page.evaluate(()=>{location.hash='#orders';});await page.locator('[data-ol-row]').first().waitFor();
   assert.equal(await page.locator('[data-order="new"]').isDisabled(),true);assert.equal(await page.locator('[data-order="detail"]').first().isEnabled(),true);
  },()=>false,'reader'));
  await t.test('pending files offer retry and keep the actual processing error on screen',async()=>{
   let attempts=0;
   const files=[{id:'rebuild-pending',filename:'bekleyen-finans.xlsx',provider:'trendyol',store_name:'Sentetik mağaza',kind:'finance',status:'applying',row_count:120,applied_row:35,snapshot_at:'2026-10-03T12:00',attempts:2,last_error:'Sentetik: kesinti satırını doğrulayın',next_attempt_at:'2026-10-04 12:30:00',counts:{new:30,review:5}}, {id:'rebuild-done',filename:'tamamlanan-siparisler.xlsx',provider:'hepsiburada',store_name:'Sentetik mağaza',kind:'orders',status:'applied',row_count:42,applied_row:42,snapshot_at:'2026-10-03T11:00',sample_verified:1,counts:{new:42}}];
   await visit(390,'#reports',async page=>{
    await ready(page);await page.locator('[data-rb-act="pending-files"]').click();
    assert.equal(await page.locator('.rb-file-row').count(),1);assert.equal(await page.locator('[data-rb-file="rebuild-done"]').count(),0);
    const pending=page.locator('[data-rb-file="rebuild-pending"]');await pending.locator('.rb-file-detail>summary').click();
    assert.match(await pending.innerText(),/35 \/ 120/);assert.match(await pending.innerText(),/kesinti satırını doğrulayın/);
    await pending.locator('[data-rb-act="apply"]').click();await page.locator('.rb-alert.error').waitFor();
    assert.match(await page.locator('.rb-alert.error').innerText(),/Temsili bağlantı hatası/);assert.equal(attempts,1);assert.equal(await page.locator('[data-rb-act="apply"]').isEnabled(),true);
    assert.equal(await page.locator('[data-rb-form="files"] [name="status"]').inputValue(),'pending');
    await fit(page,'.rb-document-workbench');await shot(page,'rebuild-report-error-390');
   },async(route,url)=>{
    if(url.pathname==='/api/ec/reports'&&route.request().method()==='GET'){const res=await route.fetch(),data=await res.json();await route.fulfill({response:res,json:{...data,files}});return true;}
    if(url.pathname==='/api/ec/reports/files/rebuild-pending/apply'){assert.equal(route.request().method(),'POST');attempts++;await route.fulfill({status:503,json:{error:'Temsili bağlantı hatası. Dosyan kayıtlı; tekrar deneyebilirsin.'}});return true;}
    return false;
   });
  });
 }finally{await browser.close();}
});
