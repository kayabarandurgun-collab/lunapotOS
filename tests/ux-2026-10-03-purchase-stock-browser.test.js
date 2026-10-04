import test from 'node:test';
import assert from 'node:assert/strict';
import {filterAccounting,scrubAmounts} from '../src/permission-policy.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.UI_PURCHASE_STOCK_BROWSER==='1';
test('purchase and warehouse tasks: direct links, same route, permissions, cleanup and mobile',{skip:!enabled,timeout:120000},async t=>{
 const base=new URL(process.env.UI_PURCHASE_STOCK_PREVIEW||'http://127.0.0.1:18730');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Installed Playwright required.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 try{
  for(const width of [360,1280])await t.test('owner '+width,async()=>{
   const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),blocked=[],errors=[],captured=[];
   await context.route('**/*',r=>{const req=r.request(),u=new URL(req.url());
    if(u.origin===base.origin&&req.method()==='POST'&&['/api/ec/ledger/provisional','/api/ec/stock'].includes(u.pathname)){
     captured.push({path:u.pathname,body:req.postDataJSON()});return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'intercepted-ui-test'})});
    }
    if(u.origin!==base.origin||!['GET','HEAD'].includes(req.method())){blocked.push(req.method()+' '+u.pathname);return r.abort();}return r.continue();});
   const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
   const go=async hash=>{await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/eticaret/'+hash}),base).href);};
   try{
    await go('#invoices?action=upload');
    await page.locator('[data-pd="file"]').waitFor({state:'attached'});
    assert.equal(await page.locator('[data-pd="file"]').count(),1);
    await page.waitForFunction(()=>document.activeElement?.matches('[data-pd="file"]'));
    if(width===360)await page.screenshot({path:join(tmpdir(),'lunapot-purchase-stock-upload-360.png'),fullPage:true});
    assert.ok(!new URL(page.url()).hash.includes('action='));
    await page.locator('[data-pd="close"]').click();
    await page.locator('[data-ac="purchase-document"]').waitFor();
    assert.equal(await page.locator('[data-ac="purchase-document"]').isVisible(),true);
    // SR02: selecting the invoice action on its own route must leave keyboard focus
    // inside the asynchronously mounted picker, not on the header action/logout.
    for(let repeat=0;repeat<2;repeat++){
     await page.locator('[data-ac="purchase-document"]').click();
     await page.locator('[data-pd="file"]').waitFor({state:'attached'});
     await page.locator('.daily-task-dialog').waitFor({state:'detached'});
     await page.waitForFunction(()=>document.activeElement?.matches('[data-pd="file"]'));
     assert.equal(await page.locator('[data-pd="file"]').isVisible(),true);
     assert.equal(await page.locator('[data-pd="file"]').isEnabled(),true);
     const scroll=await page.evaluate(()=>scrollY);
     assert.equal(scroll,0,'focus transfer must not scroll to the picker');
     await page.keyboard.press('Tab');
     assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-pd="xml"]')),true,'Tab continues to XML inside the upload form');
     if(repeat===0){await page.locator('[data-pd="close"]').click();await page.locator('[data-ac="purchase-document"]').waitFor();}
    }
    await page.locator('[data-pd="manual"]').click();
    await page.locator('[data-ac-form="invoice"]').waitFor();
    await page.locator('[data-ac-form="invoice"] [data-ac="close"]').first().click();
    await page.evaluate(()=>{location.hash='#stock?action=unbilled';});
    const form=page.locator('[data-ac-form="unbilled"]');await form.waitFor();
    await form.locator('[name="product_id"]').selectOption({index:1});
    await form.locator('[name="quantity"]').fill('5');
    assert.match(await form.locator('[data-unbilled-preview]').innerText(),/Yeni gelen: 5/);
    assert.match(await form.innerText(),/stok 17 olur/);
    await form.locator('[data-ac="add-unbilled-line"]').click();assert.equal(await form.locator('[data-unbilled-line]').count(),2);
    await form.locator('[data-ac="remove-unbilled-line"]').last().click();assert.equal(await form.locator('[data-unbilled-line]').count(),1);
    const firstProduct=await form.locator('[name="product_id"]').inputValue();
    assert.ok(await form.locator('[name="unit_cost"]').getAttribute('required')!==null);
    const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth>innerWidth+1,dialog:[...document.querySelectorAll('dialog')].some(d=>d.scrollWidth>d.clientWidth+1)}));assert.deepEqual(overflow,{page:false,dialog:false});
    await form.locator('[name="supplier_id"]').selectOption({index:1});
    await form.locator('[name="reference"]').fill('UI-ONLY-NOT-SAVED');
    await form.locator('[name="unit_cost"]').fill('12.50');
    await form.locator('[name="vat_rate"]').fill('20');
    if(width===360)await page.screenshot({path:join(tmpdir(),'lunapot-purchase-stock-unbilled-360.png'),fullPage:false});
    await form.locator('[data-ac="add-unbilled-line"]').click();
    const duplicate=form.locator('[data-unbilled-line]').last();
    await duplicate.locator('[name="product_id"]').selectOption(firstProduct);
    await duplicate.locator('[name="quantity"]').fill('2');await duplicate.locator('[name="unit_cost"]').fill('12.50');await duplicate.locator('[name="vat_rate"]').fill('20');
    await form.locator('[type="submit"]').click();
    assert.match(await form.locator('.ac-form-error').innerText(),/Her ürünü bir kez/);assert.equal(captured.length,0);
    await duplicate.locator('[data-ac="remove-unbilled-line"]').click();
    await form.locator('[type="submit"]').click();await form.waitFor({state:'detached'});
    assert.equal(captured.length,1);assert.equal(captured[0].path,'/api/ec/ledger/provisional');
    assert.deepEqual(captured[0].body.lines,[{product_id:firstProduct,quantity:5,unit_cost:12.5,vat_bps:2000}]);
    await page.locator('[data-ac="unbilled"]').first().waitFor();
    await page.evaluate(id=>{location.hash='#stock?action=count&product='+encodeURIComponent(id);},firstProduct);
    const count=page.locator('[data-ac-form="stock"]');await count.waitFor();
    assert.equal(await count.locator('[name="kind"]').inputValue(),'count');
    assert.equal(await count.locator('[name="product_id"]').inputValue(),firstProduct);
    await count.locator('[name="quantity"]').fill('5');assert.match(await count.locator('[data-stock-count-preview]').innerText(),/Girilen sayım: 5/);
    await count.locator('[name="notes"]').fill('UI-ONLY-NOT-SAVED');
    await count.locator('[name="unit_cost"]').fill('12.50');
    if(width===360)await page.screenshot({path:join(tmpdir(),'lunapot-purchase-stock-count-360.png'),fullPage:false});
    await count.locator('[type="submit"]').click();await count.waitFor({state:'detached'});
    assert.equal(captured.length,2);assert.equal(captured[1].path,'/api/ec/stock');
    assert.equal(captured[1].body.kind,'count');assert.equal(captured[1].body.quantity,5);
    await page.locator('[data-ac="unbilled"]').first().waitFor();
    await page.evaluate(()=>{location.hash='#invoices';});await page.locator('[data-ac="purchase-document"]').waitFor();
    await page.evaluate(()=>{location.hash='#stock?action=unbilled';});await form.waitFor();
    assert.equal(await page.locator('dialog').count(),1,'disposed routes do not retain listeners or duplicate dialogs');
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[],'no business writes or external requests');
   }finally{await context.close();}
  });
  await t.test('stock writer without amount access never sees costs; ledger write alone unlocks incoming form',async()=>{
   for(const [stock,ledger] of [['write','none'],['write','write'],['read','write']]){
    const user={owner:false,name:'Depo personeli',ec_access:'write',lp_access:'none',permissions:{ec:{stock,ledger,amounts:'none'},lp:{}}};
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),writes=[];
    await context.route('**/*',async r=>{
     const req=r.request(),u=new URL(req.url());
     if(u.origin!==base.origin||!['GET','HEAD'].includes(req.method())){writes.push(req.url());return r.abort();}
     if(u.pathname==='/api/auth/status'){const response=await r.fetch(),json=await response.json();return r.fulfill({response,json:{...json,user}});}
     if(u.pathname==='/api/ec'||u.pathname.startsWith('/api/ec/')){
      const response=await r.fetch();if(!response.ok())return r.fulfill({response});
      let json=await response.json();if(u.pathname==='/api/ec')json=filterAccounting(json,user,'ec');
      return r.fulfill({response,json:scrubAmounts(json,user,'ec')});
     }
     return r.continue();
    });
    try{
     await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/eticaret/#stock'}),base).href);
     await page.locator('.product-tile').first().waitFor();
     const products=page.locator('.product-tile');assert.match(await products.first().innerText(),/Kullanılabilir fiziksel stok/);
     await products.first().locator('.product-details').first().locator('summary').click();
     assert.match(await products.first().innerText(),/Tutarları görme yetkin yok/);
     assert.doesNotMatch(await products.first().innerText(),/₺|TRY|\d+[,.]\d+\s*TL/);
     await products.first().locator('[data-ac="stock-history"]').click();
     await page.locator('.history-movement').first().waitFor();
     assert.doesNotMatch(await page.locator('.stock-history-dialog').innerText(),/₺|TRY|\d+[,.]\d+\s*TL/);
     assert.match(await page.locator('.stock-history-dialog').innerText(),/Eksik veri/);
     await page.locator('[data-history-close]').first().click();
     if(stock==='write'){
      await page.evaluate(()=>{location.hash='#stock?action=count';});
      await page.locator('[data-ac-form="stock"]').waitFor();assert.equal(await page.locator('[data-ac-form="stock"] [name="unit_cost"]').inputValue(),'');
      await page.locator('[data-ac-form="stock"] [data-ac="close"]').first().click();
     }
     await page.evaluate(()=>{location.hash='#stock?action=unbilled';});
     if(ledger==='none'){
      await page.locator('#ac-error:not([hidden])').waitFor();assert.equal(await page.locator('[data-ac-form="unbilled"]').count(),0);
     }else{
      await page.locator('[data-ac-form="unbilled"]').waitFor();
      assert.ok(await page.locator('[data-ac-form="unbilled"] [name="supplier_id"] option').count()>1,'supplier list comes from ledger without requiring invoices permission');
      assert.equal(await page.locator('[data-ac-form="unbilled"] [name="unit_cost"]').inputValue(),'');
      assert.equal(await page.locator('[data-ac-form="unbilled"] [type="submit"]').isEnabled(),true,'stock '+stock+' / ledger '+ledger+' must not be blocked by the route read-only guard');
     }
     assert.deepEqual(writes,[]);
    }finally{await context.close();}
   }
  });
  await t.test('actual stock appears before secondary filters and statistics at 320/390/1440',async t=>{
   for(const width of [320,390,1440]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();
    await context.route('**/*',r=>new URL(r.request().url()).origin===base.origin&&['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
    try{
     await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/eticaret/#stock'}),base).href);
     await page.locator('.product-available').first().waitFor();
     const box=await page.locator('.product-available').first().boundingBox();
     t.diagnostic('width '+width+': first physical quantity top='+Math.round(box.y)+', bottom='+Math.round(box.y+box.height));
     assert.ok(box.y<(width<600?800:600),'first physical quantity must be immediately reachable');
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
     assert.equal(await page.locator('.stock-refinements').getAttribute('open'),null);
     assert.equal(await page.locator('.stock-sales-context').getAttribute('open'),null);
     await page.screenshot({path:join(tmpdir(),'lunapot-purchase-stock-list-'+width+'.png'),fullPage:false});
     await page.locator('.stock-refinements>summary').click();
     await page.locator('[data-ac-form="stock-filters"] [name="view"]').selectOption('table');await page.locator('.product-table').first().waitFor();
     assert.notEqual(await page.locator('.stock-refinements').getAttribute('open'),null,'filter panel stays open while choosing filters');
     await page.locator('[data-ac-form="stock-filters"] [name="view"]').selectOption('cards');await page.locator('.product-available').first().waitFor();
     await page.locator('[data-ac-form="stock-filters"] [name="q"]').fill('no-such-physical-product');await page.locator('.product-empty').waitFor();
     await page.locator('[data-ac="stock-reset"]').click();await page.locator('.product-available').first().waitFor();
    }finally{await context.close();}
   }
  });
  await t.test('read-only task links fail closed',async()=>{
   const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),writes=[];
   await context.route('**/*',r=>{const req=r.request(),u=new URL(req.url());if(u.origin!==base.origin||!['GET','HEAD'].includes(req.method())){writes.push(req.url());return r.abort();}return r.continue();});
   for(const hash of ['#invoices?action=upload','#stock?action=unbilled','#stock?action=count']){
    await page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'reader',scenario:'populated',next:'/eticaret/'+hash}),base).href);
    await page.locator('#ac-error:not([hidden])').waitFor();
    assert.equal(await page.locator('dialog,[data-pd="file"]').count(),0);
   }
   assert.deepEqual(writes,[]);await context.close();
  });
 }finally{await browser.close();}
});
