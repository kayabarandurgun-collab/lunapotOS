import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
import {formatRecipeAmount} from '../public/recipe-studio.js';

const hidden='Tutarları görme yetkin yok';
test('recipe amount labels distinguish permission, missing data and known zero',()=>{
 const reader={lp_access:'read',permissions:{lp:{amounts:'none'}}};
 assert.equal(formatRecipeAmount(null,reader),hidden);
 assert.equal(formatRecipeAmount(12345,reader),hidden,'even a supplied value cannot reach display text');
 assert.equal(formatRecipeAmount(null,{owner:true}),'Bilinmiyor');
 assert.equal(formatRecipeAmount(undefined,{owner:true}),'Bilinmiyor');
 assert.match(formatRecipeAmount(0,{owner:true}),/0,00/);
 assert.match(formatRecipeAmount(12.5,{owner:true}),/12,50/);
 const legacy={lp_access:'read',permissions:{lp:{recipes:'read'}}};
 assert.match(formatRecipeAmount(12.5,legacy),/12,50/,'keep the existing legacy permission semantics');
});

test('form states: invoice access, filtered results, costs and recipe draft dismissal',{skip:process.env.UI_FORM_STATES_BROWSER!=='1',timeout:180000},async t=>{
 const base=new URL(process.env.UI_FORM_STATES_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Installed Playwright is required; no browser downloads.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const blocked=[],errors=[];
 async function visit(path,{role='owner',scenario='populated',width=1280,setup}={}){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const request=route.request();
   if(new URL(request.url()).origin!==base.origin||!['GET','HEAD'].includes(request.method())){blocked.push(request.method()+' '+request.url());return route.abort();}
   return route.continue();
  });
  if(setup)await setup(context);
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario,next:path}),base).href);
  return {page,context};
 }
 const focusIs=(page,selector)=>page.waitForFunction(selector=>document.activeElement?.matches(selector),selector);
 const noDialogs=page=>page.waitForFunction(()=>!document.querySelector('dialog[open]'));
 const editor=page=>page.locator('dialog.recipe-studio');
 const confirm=page=>page.locator('dialog.recipe-discard-confirm');
 async function openRecipe(page){const opener=page.locator('[data-edit="recipes"]').first();await opener.focus();await opener.press('Enter');await editor(page).waitFor();return opener;}
 try{
  for(const ns of ['ec','lp'])await t.test(ns+' reader: import affordance explains access and existing invoices remain readable',async()=>{
   const {page,context}=await visit(ns==='ec'?'/eticaret/#invoices':'/uretim/#accounts',{role:'reader'});
   try{
    if(ns==='lp')await page.locator('[data-ac="view"][data-id="invoices"]').click();
    await page.locator('#invoice-readonly-help').waitFor();
    assert.match(await page.locator('#invoice-readonly-help').innerText(),/yalnızca faturaları görüntüleyebilir/);
    for(const selector of ['[data-ac="purchase-document"]','[data-ac="invoice"]','#ac-xml',...(ns==='ec'?['[data-ac="staged-import"]']:[])]){
     assert.equal(await page.locator(selector).isDisabled(),true);
     assert.equal(await page.locator(selector).getAttribute('aria-describedby'),'invoice-readonly-help');
    }
    if(ns==='lp'){await page.locator('#ac-view .empty').waitFor();return;} // This preview has no production purchase invoices.
    const amounts=page.locator('#ac-view tbody tr').first();await amounts.waitFor();
    assert.match(await amounts.innerText(),new RegExp(hidden));assert.doesNotMatch(await amounts.innerText(),/Eksik veri|₺|TRY/);
    await amounts.locator('[data-ac="review-invoice"]').click();
    const detail=page.locator('#ac-dialog');await detail.waitFor();
    assert.match(await detail.innerText(),new RegExp(hidden));assert.doesNotMatch(await detail.innerText(),/₺|TRY/);
    assert.match(await detail.innerText(),/Teslim|teslim/);
   }finally{await context.close();}
  });
  await t.test('owner: PDF/XML and child manual entry stay available',async()=>{
   const {page,context}=await visit('/eticaret/#invoices');
   try{
    await page.locator('[data-ac="purchase-document"]').click();
    await page.locator('[data-pd="file"]').waitFor({state:'attached'});
    for(const selector of ['[data-pd="file"]','[data-pd="xml"]','[data-pd="manual"]'])assert.equal(await page.locator(selector).isDisabled(),false);
    await page.locator('[data-pd="manual"]').click();await page.locator('[data-ac-form="invoice"]').waitFor();
    assert.equal(await page.locator('[data-ac-form="invoice"] [type="submit"]').isEnabled(),true);
   }finally{await context.close();}
  });
  await t.test('invoice no-match query and status reset restore records and focus; true empty stays distinct',async()=>{
   const {page,context}=await visit('/eticaret/#invoices');
   try{
    const rows=page.locator('#ac-view tbody tr');await rows.first().waitFor();const before=await rows.count();
    const filters=page.locator('[data-ac-form="invoice-filters"]');await filters.locator('[name="q"]').fill('NO-MATCH-SYNTHETIC-FORMS');
    await filters.locator('[name="status"]').selectOption('cancelled');await filters.locator('[type="submit"]').click();
    await page.locator('[data-ac="invoice-reset"]').waitFor();
    assert.match(await page.locator('#ac-view .empty').innerText(),/Bu filtrelerle kayıt bulunamadı/);
    assert.doesNotMatch(await page.locator('#ac-view .empty').innerText(),/Henüz/);
    await page.locator('[data-ac="invoice-reset"]').click();await rows.first().waitFor();assert.equal(await rows.count(),before);
    assert.equal(await filters.locator('[name="q"]').inputValue(),'');assert.equal(await filters.locator('[name="status"]').inputValue(),'');
    await focusIs(page,'[data-ac-form="invoice-filters"] [name="q"]');
   }finally{await context.close();}
   const empty=await visit('/eticaret/#invoices',{scenario:'empty'});
   try{await empty.page.locator('#ac-view .empty').waitFor();assert.match(await empty.page.locator('#ac-view .empty').innerText(),/Henüz fatura yok/);assert.equal(await empty.page.locator('[data-ac="invoice-reset"]').count(),0);}finally{await empty.context.close();}
  });
  await t.test('owner missing invoice amounts stay missing; zero is a value',async()=>{
   const {page,context}=await visit('/eticaret/#invoices',{setup:async c=>c.route('**/api/ec/purchases?*',async route=>{
    const response=await route.fetch(),body=await response.json();body.invoices[0].net_cents=null;body.invoices[0].tax_cents=0;
    await route.fulfill({response,json:body});
   })});
   try{
    const row=page.locator('#ac-view tbody tr').first();await row.waitFor();assert.match(await row.locator('td').nth(3).innerText(),/Eksik veri/);assert.match(await row.locator('td').nth(4).innerText(),/0,00/);assert.doesNotMatch(await row.innerText(),new RegExp(hidden));
    await context.route('**/api/ec/invoices/*',async route=>{const response=await route.fetch(),body=await response.json();body.lines[0].net_cents=null;await route.fulfill({response,json:body});});
    await row.locator('[data-ac="review-invoice"]').click();await page.locator('#ac-dialog').waitFor();assert.equal(await page.locator('#ac-dialog .result-row strong').first().innerText(),'Eksik veri');
   }finally{await context.close();}
  });
  await t.test('production reader cost and detail labels hide amounts while preserving quantities',async()=>{
   const {page,context}=await visit('/uretim/#production',{role:'reader'});
   try{
    const row=page.locator('main tbody tr').first();await row.waitFor();const cell=row.locator('td').nth(3);
    assert.equal(await cell.innerText(),hidden);assert.match(await row.locator('td').nth(2).innerText(),/10 adet/);
    await row.locator('[data-production="detail"]').click();const dialog=page.locator('dialog[open]');await dialog.waitFor();
    assert.match(await dialog.innerText(),new RegExp(hidden));assert.doesNotMatch(await dialog.innerText(),/₺|TRY/);
   }finally{await context.close();}
  });
  await t.test('production owner missing cost and known zero stay distinct',async()=>{
   const {page,context}=await visit('/uretim/#production',{setup:async c=>c.route('**/api/lp/production',async route=>{
    const response=await route.fetch(),body=await response.json();body.jobs[0].total_cost_cents=null;body.jobs[1].total_cost_cents=0;await route.fulfill({response,json:body});
   })});
   try{const rows=page.locator('main tbody tr');await rows.first().waitFor();assert.match(await rows.nth(0).locator('td').nth(3).innerText(),/Bilinmiyor/);assert.match(await rows.nth(1).locator('td').nth(3).innerText(),/0,00/);assert.doesNotMatch(await rows.nth(0).innerText(),new RegExp(hidden));}finally{await context.close();}
  });
  for(const width of [390,1280])await t.test(width+'px recipe Escape: layered modal, continue focus, draft retained, explicit discard',async()=>{
   const {page,context}=await visit('/uretim/#recipes',{width});
   try{
    const opener=await openRecipe(page),quantity=editor(page).locator('[data-ingredient-quantity]').first(),saved=await quantity.inputValue();
    await quantity.fill('123.456');await quantity.press('Escape');await confirm(page).waitFor();
    assert.equal(await page.locator('dialog[open]').count(),2);assert.equal(await confirm(page).evaluate(d=>d.matches(':modal')),true);
    assert.equal(await confirm(page).getAttribute('aria-labelledby'),'recipe-discard-title');assert.equal(await confirm(page).getAttribute('aria-describedby'),'recipe-discard-description');
    await focusIs(page,'[data-studio="continue"]');await quantity.evaluate(q=>q.focus());await focusIs(page,'[data-studio="continue"]');
    await page.keyboard.press('Shift+Tab');assert.ok(await page.evaluate(()=>document.activeElement===document.body||!!document.activeElement.closest('.recipe-discard-confirm')));
    await page.keyboard.press('Escape');await confirm(page).waitFor({state:'detached'});await focusIs(page,'[data-ingredient-quantity]');assert.equal(await quantity.inputValue(),'123.456');
    await quantity.press('Escape');await confirm(page).waitFor();await page.locator('[data-studio="continue"]').click();await focusIs(page,'[data-ingredient-quantity]');assert.equal(await quantity.inputValue(),'123.456');
    await quantity.press('Escape');await confirm(page).waitFor();await page.locator('[data-studio="discard"]').click();await noDialogs(page);assert.equal(await opener.evaluate(b=>b===document.activeElement),true);
    await openRecipe(page);assert.equal(await editor(page).locator('[data-ingredient-quantity]').first().inputValue(),saved);
    await page.keyboard.press('Escape');await noDialogs(page);assert.equal(await opener.evaluate(b=>b===document.activeElement),true);
   }finally{await context.close();}
  });
  await t.test('recipe X/native close/native requestClose protect notes and ingredient removal; reverting is clean',async()=>{
   const {page,context}=await visit('/uretim/#recipes');
   try{
    await openRecipe(page);const notes=editor(page).locator('[name="notes"]'),original=await notes.inputValue();
    await notes.fill('Synthetic draft notes');await editor(page).locator('[data-studio="close"]').click();await confirm(page).waitFor();
    await page.locator('[data-studio="continue"]').click();await focusIs(page,'.recipe-studio [data-studio="close"]');assert.equal(await notes.inputValue(),'Synthetic draft notes');
    await notes.focus();await editor(page).evaluate(d=>d.close());await confirm(page).waitFor();await page.locator('[data-studio="continue"]').click();await focusIs(page,'.recipe-studio [name="notes"]');assert.equal(await notes.inputValue(),'Synthetic draft notes');
    await editor(page).evaluate(d=>d.requestClose());await confirm(page).waitFor();await page.locator('[data-studio="continue"]').click();
    await notes.fill(original);await editor(page).locator('[data-studio-search]').fill('Synthetic search that is not a draft change');
    await editor(page).locator('[data-studio="close"]').click();await noDialogs(page);
    await openRecipe(page);const count=await editor(page).locator('[data-ingredient]').count();await editor(page).locator('[data-remove-material]').first().click();
    await page.keyboard.press('Escape');await confirm(page).waitFor();await page.locator('[data-studio="continue"]').click();assert.equal(await editor(page).locator('[data-ingredient]').count(),count-1);
    await page.keyboard.press('Escape');await confirm(page).waitFor();await page.locator('[data-studio="discard"]').click();await noDialogs(page);
   }finally{await context.close();}
  });
  await t.test('recipe backdrop dismissal protects a changed unit and unchanged draft closes immediately',async()=>{
   const {page,context}=await visit('/uretim/#recipes');
   try{
    await openRecipe(page);const dialog=editor(page),units=dialog.locator('[data-ingredient-unit]').first();
    const choices=await units.locator('option').evaluateAll(options=>options.map(option=>option.value)),original=await units.inputValue();
    await units.selectOption(choices.find(value=>value!==original));
    const bounds=await dialog.boundingBox();assert.ok(bounds.x>0);await page.mouse.click(bounds.x/2,bounds.y+20);await confirm(page).waitFor();
    await page.locator('[data-studio="continue"]').click();assert.notEqual(await units.inputValue(),original);
    await units.selectOption(original);await page.mouse.click(bounds.x/2,bounds.y+20);await noDialogs(page);
   }finally{await context.close();}
  });
  await t.test('reader upload adapter never mounts disabled file/manual controls',async()=>{
   const {page,context}=await visit('/eticaret/#invoices',{role:'reader'});
   try{
    await page.locator('#invoice-readonly-help').waitFor();
    await page.evaluate(async()=>{
     const {mountInvoiceUpload}=await import('/invoice-upload-ui.js');const {user}=await fetch('/api/auth/status').then(r=>r.json());
     const root=document.createElement('section');root.id='upload-adapter-fixture';document.querySelector('#ac-view').append(root);
     mountInvoiceUpload(root,'ec',{user,onClose:()=>{root.textContent='Returned to invoice list';}});
    });
    const surface=page.locator('#upload-adapter-fixture');assert.match(await surface.innerText(),/yalnızca görüntülenebilir/);
    assert.equal(await surface.locator('input[type="file"],[data-pd="manual"]').count(),0);
    await surface.locator('[data-upload-back]').click();assert.equal(await surface.innerText(),'Returned to invoice list');
   }finally{await context.close();}
  });
  await t.test('invoice filter failure is an error rather than an empty business state',async()=>{
   const {page,context}=await visit('/eticaret/#invoices',{setup:async c=>c.route('**/api/ec/purchases?*',route=>new URL(route.request().url()).searchParams.get('q')==='FAIL-SYNTHETIC'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Sentetik liste hatası'})}):route.fallback())});
   try{
    await page.locator('#ac-view tbody tr').first().waitFor();const filters=page.locator('[data-ac-form="invoice-filters"]');
    await filters.locator('[name="q"]').fill('FAIL-SYNTHETIC');await filters.locator('[type="submit"]').click();
    await page.locator('#ac-error').waitFor();assert.match(await page.locator('#ac-error').innerText(),/Sentetik liste hatası/);assert.equal(await page.locator('#ac-view .empty').count(),0);
   }finally{await context.close();}
  });
  await t.test('recipe pending/failed save keeps the draft and a successful save closes without discard confirmation',async()=>{
   const {page,context}=await visit('/uretim/#recipes');
   try{
    await page.locator('[data-edit="recipes"]').first().waitFor();
    await page.evaluate(async()=>{
     const {openRecipeStudio}=await import('/recipe-studio.js'),data=await fetch('/api/data').then(r=>r.json());
     const root=document.querySelector('#modal-root');let succeed=false;
     window.formSaveCalls=0;window.formDoneCalls=0;
     openRecipeStudio(root,data,data.recipes[0],{user:{owner:true},save:async()=>{window.formSaveCalls++;if(!succeed)await new Promise((resolve,reject)=>{window.rejectFormSave=()=>{succeed=true;reject(Error('Sentetik kaydetme hatası'));};});},done:()=>{window.formDoneCalls++;}});
    });
    const notes=editor(page).locator('[name="notes"]');await notes.fill('Unsaved synthetic draft');await editor(page).locator('[type="submit"]').click();
    await page.waitForFunction(()=>!!window.rejectFormSave);assert.equal(await editor(page).locator('form').getAttribute('aria-busy'),'true');
    await page.keyboard.press('Escape');assert.equal(await editor(page).isVisible(),true);assert.equal(await confirm(page).count(),0);
    assert.equal(await editor(page).locator('[data-studio="close"]').isDisabled(),true);assert.equal(await editor(page).isVisible(),true);
    await page.evaluate(()=>window.rejectFormSave());await page.waitForFunction(()=>document.querySelector('[data-studio-error]')?.textContent==='Sentetik kaydetme hatası');
    assert.equal(await notes.inputValue(),'Unsaved synthetic draft');assert.equal(await editor(page).locator('[type="submit"]').isEnabled(),true);
    await notes.press('Escape');await confirm(page).waitFor();await page.locator('[data-studio="continue"]').click();await focusIs(page,'.recipe-studio [name="notes"]');
    await editor(page).locator('[type="submit"]').click();await noDialogs(page);assert.equal(await page.evaluate(()=>window.formSaveCalls),2);assert.equal(await page.evaluate(()=>window.formDoneCalls),1);
   }finally{await context.close();}
  });
  assert.deepEqual(errors,[],'no browser script exceptions');assert.deepEqual(blocked,[],'no external or write requests attempted');
 }finally{await browser.close();}
});
