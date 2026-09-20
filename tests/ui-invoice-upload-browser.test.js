import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

// Opt-in regression against the parent's synthetic preview; no uploads, writes or external traffic.
const enabled=process.env.UI_INVOICE_UPLOAD_BROWSER==='1';
test('invoice upload recovers a cached failed ESM job through an explicit page reload',{skip:!enabled,timeout:60000},async t=>{
 const base=new URL(process.env.UI_INVOICE_UPLOAD_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright and Chrome; do not download dependencies.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 try{
  for(const [path,asset] of [
   ['/eticaret/#invoices','/purchase-document-ui.js'],
   ['/eticaret/#invoices','/pdf-read.js'],
   ['/uretim/#accounts','/purchase-document-ui.js']
  ])await t.test(path+' / first 503 for '+asset,async()=>{
   const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
   let failAsset=true,attempts=0,documents=0;
   const blocked=[],errors=[];
   await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base.origin||!['GET','HEAD'].includes(request.method())){
     blocked.push(request.method()+' '+url.href);return route.abort();
    }
    if(request.isNavigationRequest()&&url.pathname===(path.startsWith('/uretim/')?'/uretim/':'/eticaret/'))documents++;
    if(url.pathname===asset){
     attempts++;
     if(failAsset)return route.fulfill({status:503,contentType:'text/javascript',body:'Temporarily unavailable'});
    }
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
   const invoiceList=async()=>{
    if(path.startsWith('/uretim/'))await page.locator('[data-ac="view"][data-id="invoices"]').click();
    await page.locator('[data-ac="purchase-document"]').waitFor();
   };
   try{
    await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:path}),base).href);
    await invoiceList();assert.equal(attempts,0,'document parser stays lazy until upload is opened');
    const originalURL=page.url();
    await page.locator('[data-ac="purchase-document"]').click();await page.locator('[data-upload-retry]').waitFor();
    assert.equal(attempts,1);assert.equal(await page.locator('[data-pd="file"]').count(),0);
    assert.equal(await page.locator('[data-upload-retry]').innerText(),'Sayfayı yenile');
    assert.match(await page.locator('#ac-view').innerText(),/Sayfayı yeniledikten sonra Faturalar bölümünden PDF fatura yükle/);
    assert.equal(await page.locator('[data-upload-back]').isVisible(),true,'returning to the list remains available');

    failAsset=false;
    const initialDocuments=documents;
    await page.evaluate(()=>{window.__invoiceUploadOldDocument=true;});
    await page.locator('[data-upload-retry]').focus();
    await Promise.all([page.waitForEvent('domcontentloaded'),page.keyboard.press('Enter')]);
    await invoiceList();
    assert.equal(page.url(),originalURL,'reload preserves the workspace and route');
    assert.equal(documents,initialDocuments+1,'retry performs a real document navigation');
    assert.equal(await page.evaluate(()=>window.__invoiceUploadOldDocument),undefined,'the failed module map belongs to the old document');
    assert.equal(attempts,1,'reload still leaves the parser lazy until explicitly reopened');

    await page.locator('[data-ac="purchase-document"]').click();
    await page.locator('[data-pd="file"]').waitFor({state:'attached'});
    assert.equal(attempts,2,'restored module/dependency is fetched again after the reload');
    assert.equal(await page.locator('[data-pd="file"]').isEnabled(),true);
    assert.equal(await page.locator('[data-pd="manual"]').isEnabled(),true);
    assert.equal(await page.locator('[data-upload-retry]').count(),0);
    assert.deepEqual(errors,[],'no uncaught script errors');assert.deepEqual(blocked,[],'no uploads, business writes or external requests');
   }finally{await context.close();}
  });
 }finally{await browser.close();}
});
