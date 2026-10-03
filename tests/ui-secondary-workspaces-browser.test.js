import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.UI_SECONDARY_WORKSPACES_BROWSER==='1';
test('secondary workspaces preserve permissions, unknown amounts, keyboard use and mobile forms',{skip:!enabled,timeout:180000},async t=>{
 const base=new URL(process.env.UI_SECONDARY_WORKSPACES_PREVIEW||'http://127.0.0.1:18730');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.synthetic,true);assert.equal(health.local_preview,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Installed Playwright required.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'}),errors=[],blocked=[];
 async function visit(path,{role='owner',width=360,setup}={}){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>{
   const request=route.request();
   if(new URL(request.url()).origin!==base.origin||!['GET','HEAD'].includes(request.method())){blocked.push(request.method()+' '+request.url());return route.abort();}
   return route.continue();
  });
  if(setup)await setup(context);
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario:'populated',next:path}),base).href);
  return {page,context};
 }
 const focused=(page,selector)=>page.waitForFunction(s=>document.activeElement?.matches(s),selector);
 const noOverflow=async page=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-wide horizontal scrolling');
 const row={description:'Sentetik saksı',unit:'adet',quantity_milli:2000,unit_price_cents:10000,discount_bps:0,vat_bps:2000,net_cents:20000,vat_cents:4000,total_cents:24000};
 const offer={id:'secondary-offer',kind:'quote',status:'draft',effective_status:'draft',party_id:'secondary-party',party_name:'Sentetik tedarikçi',title:'Deneme teklifi',document_no:'TKL-SENTETIK-1',revision:1,issue_date:health.today,valid_until:'2099-12-31',net_cents:20000,vat_cents:4000,total_cents:24000,derived:[],origin:null,superseded_by:null,snapshot:{title:'Deneme teklifi',party:{name:'Sentetik tedarikçi'},issue_date:health.today,valid_until:'2099-12-31',terms:'',totals:{rows:[row],net_cents:20000,vat_cents:4000,total_cents:24000}}};
 const mockOffers=async context=>context.route('**/api/ec/offers**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/'+offer.id)?offer:{offers:[offer]}}));
 try{
  await t.test('production reader can inspect records but cannot start stock or reversal writes',async()=>{
   const {page,context}=await visit('/uretim/#production',{role:'reader'});
   try{
    await page.locator('[data-production=new]').waitFor();assert.equal(await page.locator('[data-production=new]').isDisabled(),true);
    assert.match(await page.locator('#production-readonly-help').innerText(),/yalnızca görüntüleyebilirsin/);
    await page.locator('[data-production=detail]').first().click();await page.locator('dialog').waitFor();
    assert.equal(await page.locator('[data-production=reverse]').isDisabled(),true);
    assert.match(await page.locator('dialog').innerText(),/Tutarları görme yetkin yok/);
    await page.keyboard.press('Escape');
    await page.locator('[data-production-search]').fill('KESINLIKLE-BULUNMAYAN');
    await page.getByText('Bu filtrelerle üretim bulunamadı.',{exact:true}).waitFor();
    assert.equal(await page.locator('main .v2-empty').getByText('Henüz kayıt yok.').count(),0);
    await noOverflow(page);
    await page.goto(new URL('/uretim/#materialstock',base).href);
    await page.locator('[data-production=material]').first().waitFor();assert.equal(await page.locator('[data-production=material]').first().isDisabled(),true);
    assert.equal(await page.locator('details').filter({has:page.locator('summary').getByText('Hammadde hareketleri · son 200 kayıt')}).getAttribute('open'),null);
   }finally{await context.close();}
  });
  await t.test('production owner retains optional lot defaults and readable mobile form',async()=>{
   const {page,context}=await visit('/uretim/#production');
   try{
    await page.locator('[data-production=new]').click();await page.locator('[data-production-form=job]').waitFor();
    assert.equal(await page.locator('[name=create_lot]').isChecked(),true);
    const details=page.locator('.production-lot details');assert.equal(await details.getAttribute('open'),null);
    await details.locator('summary').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('[name=lot_code]').isVisible(),true);
    assert.equal(await page.locator('[name=quantity]').getAttribute('inputmode'),'decimal');
    await noOverflow(page);
   }finally{await context.close();}
  });
  await t.test('new recipe hides optional costs and keeps material selection keyboard focus',async()=>{
   const {page,context}=await visit('/uretim/#recipes');
   try{
    await page.locator('[data-edit=recipes]').first().waitFor();
    await page.evaluate(async()=>{
     const {openRecipeStudio}=await import('/recipe-studio.js');
     const root=document.createElement('div');document.body.append(root);
     openRecipeStudio(root,{products:[{id:'p',name:'Deneme saksı'}],recipes:[],materials:[{id:'m',name:'Kil',unit:'kg',price:2,quantity_milli:5000}]},null,{user:{owner:true},save:async x=>{window.secondaryRecipe=x;},done:()=>{}});
    });
    assert.equal(await page.locator('.studio-extras').getAttribute('open'),null);
    const choice=page.locator('[data-material-choice=m]');await choice.focus();await page.keyboard.press('Space');await focused(page,'[data-material-choice=m]');
    assert.equal(await page.locator('[data-ingredient-quantity]').getAttribute('aria-label'),'Kil miktarı');
    assert.equal(await page.locator('[data-ingredient-unit]').getAttribute('aria-label'),'Kil birimi');
    await page.locator('[data-ingredient-quantity]').fill('2');await noOverflow(page);
    await page.locator('[data-studio-form] [type=submit]').click();await page.waitForFunction(()=>!!window.secondaryRecipe);
    assert.deepEqual(await page.evaluate(()=>({labor:window.secondaryRecipe.labor,packaging:window.secondaryRecipe.packaging,quantity:window.secondaryRecipe.items[0].quantity})),{labor:0,packaging:0,quantity:2});
   }finally{await context.close();}
  });
  await t.test('missing production stock and costs are never presented as zero',async()=>{
   const {page,context}=await visit('/uretim/#production',{setup:async context=>{
    await context.route('**/api/lp/production',async route=>{const response=await route.fetch(),data=await response.json();data.materials.forEach(m=>{m.quantity_milli=null;});data.recipes.forEach(r=>{r.labor=null;});await route.fulfill({response,json:data});});
   }});
   try{
    await page.locator('[data-production=new]').click();await page.locator('[data-production-form=job]').waitFor();
    assert.match(await page.locator('[data-production-plan]').innerText(),/Stok bilgisi eksik/);assert.doesNotMatch(await page.locator('[data-production-plan]').innerText(),/0 adet/);
    assert.equal(await page.locator('[name=labor]').inputValue(),'');
    assert.doesNotMatch(await page.locator('[data-production-inputs]').innerText(),/stok yetersiz/);
   }finally{await context.close();}
  });
  await t.test('offer load failure is recoverable and does not leave controls disabled',async()=>{
   let reads=0;const {page,context}=await visit('/eticaret/#offers',{setup:async context=>{
    await context.route('**/api/ec/offers',route=>{reads++;return route.fulfill({status:reads===1?503:200,json:reads===1?{error:'Sentetik yükleme hatası'}:{offers:[offer]}});});
   }});
   try{
    await page.getByText('Sentetik yükleme hatası',{exact:true}).waitFor();await page.locator('[data-offer=retry]').click();await page.locator('[data-offer=open]').waitFor();
    assert.equal(reads,2);assert.equal(await page.locator('[data-offer=open]').isEnabled(),true);assert.equal(await page.locator('[data-offer-retry]').isVisible(),false);
   }finally{await context.close();}
  });
  await t.test('offer-only reader needs no ledger access and sees neither write actions nor amounts',async()=>{
   let ledgerReads=0;
   const {page,context}=await visit('/eticaret/#offers',{setup:async context=>{
    await mockOffers(context);
    await context.route('**/api/auth/status',async route=>{const response=await route.fetch(),data=await response.json();data.user={...data.user,owner:false,ec_access:'read',lp_access:'none',permissions:{ec:{offers:'read',amounts:'none'},lp:{}}};await route.fulfill({response,json:data});});
    await context.route('**/api/ec/ledger**',route=>{ledgerReads++;return route.fulfill({status:403,json:{error:'Cari yetkisi yok'}});});
   }});
   try{
    await page.locator('[data-offer=open]').waitFor();assert.equal(ledgerReads,0);
    assert.equal(await page.locator('[data-offer=new][data-id=quote]').isDisabled(),true);
    assert.match(await page.locator('[data-offer-body]').innerText(),/Tutarları görme yetkin yok/);
    await page.locator('[data-offer-search]').fill('ESLESMEYEN');await page.getByText('Bu aramada belge bulunamadı.',{exact:true}).waitFor();
    await page.locator('[data-offer=search-reset]').click();await focused(page,'[data-offer-search]');
    await page.locator('[data-offer=open]').click();await page.locator('[data-offer=edit]').waitFor();
    assert.equal(await page.locator('[data-offer=edit]').isDisabled(),true);assert.equal(ledgerReads,0);
    assert.doesNotMatch(await page.locator('[data-offer-body]').innerText(),/₺/);await noOverflow(page);
   }finally{await context.close();}
  });
  await t.test('offer drafts retain rows, recalculate totals, switch document type and freeze during save',async()=>{
   let posts=0,payload,release,reached;const held=new Promise(resolve=>{release=resolve}),sent=new Promise(resolve=>{reached=resolve});
   const {page,context}=await visit('/eticaret/#offers',{setup:async context=>{
    await context.route('**/api/ec/offers',async route=>{
     if(route.request().method()==='GET')return route.fallback();
     posts++;payload=route.request().postDataJSON();reached();await held;return route.fulfill({status:503,json:{error:'Sentetik kayıt hatası'}});
    });
   }});
   try{
    await page.locator('[data-offer-search]').waitFor();await page.locator('[data-offer=new][data-id=quote]').click();
    const form=page.locator('[data-offer-form=save]');await form.waitFor();
    const party=await form.locator('[name=party_id] option').nth(1).getAttribute('value');await form.locator('[name=party_id]').selectOption(party);
    await form.locator('[name=title]').fill('Mobil teklif');await form.locator('[name=description]').fill('Sentetik saksı');
    assert.match(await page.locator('[data-offer-totals]').innerText(),/tamamla/);
    await form.locator('[name=unit_price]').fill('100');assert.match(await page.locator('[data-offer-totals]').innerText(),/120,00/);
    await page.locator('[data-offer=line-add]').click();await focused(page,'[data-offer-lines] tr:last-child [name=description]');
    assert.equal(await form.locator('[name=title]').inputValue(),'Mobil teklif');assert.equal(await form.locator('[name=unit_price]').first().inputValue(),'100');
    await page.locator('[data-offer=line-remove][data-id="1"]').click();await focused(page,'[data-offer=line-add]');
    await form.locator('[name=kind]').selectOption('contract');assert.equal(await form.locator('[name=valid_until]').count(),0);
    await form.locator('[name=kind]').selectOption('quote');assert.equal(await form.locator('[name=valid_until]').inputValue()!=='',true);
    await noOverflow(page);await form.locator('[type=submit]').click();await sent;
    assert.equal(posts,1);assert.equal(payload.lines[0].unit_price_cents,10000);assert.equal(payload.title,'Mobil teklif');
    assert.equal(await form.locator('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)').count(),0);
    release();await page.getByText('Sentetik kayıt hatası',{exact:true}).waitFor();assert.equal(await form.locator('[name=title]').inputValue(),'Mobil teklif');assert.equal(await form.locator('[type=submit]').isEnabled(),true);
   }finally{release();await context.close();}
  });
  await t.test('a saved offer stays visible when the subsequent list refresh fails',async()=>{
   let reads=0,posts=0;const {page,context}=await visit('/eticaret/#offers',{setup:async context=>{
    await context.route('**/api/ec/offers',route=>{
     if(route.request().method()==='POST'){posts++;return route.fulfill({json:offer});}
     reads++;return route.fulfill({status:reads===2?503:200,json:reads===2?{error:'Liste yenilenemedi'}:{offers:[offer]}});
    });
   }});
   try{
    await page.locator('[data-offer-search]').waitFor();await page.locator('[data-offer=new][data-id=quote]').click();
    const form=page.locator('[data-offer-form=save]');await form.waitFor();
    await form.locator('[name=party_id]').selectOption(await form.locator('[name=party_id] option').nth(1).getAttribute('value'));
    await form.locator('[name=title]').fill('Kaydedilecek teklif');await form.locator('[name=description]').fill('Saksı');await form.locator('[name=unit_price]').fill('100');
    await form.locator('[type=submit]').click();await page.getByText('Liste yenilenemedi',{exact:true}).waitFor();
    assert.equal(await form.count(),0);assert.equal(posts,1);assert.match(await page.locator('[data-offer-body]').innerText(),new RegExp(offer.document_no));
    await page.locator('[data-offer=retry]').click();await page.waitForFunction(()=>!document.querySelector('[data-offer-retry]')?.checkVisibility());
    assert.equal(posts,1);assert.equal(await page.locator('[data-offer=edit]').isEnabled(),true);
   }finally{await context.close();}
  });
  await t.test('editing an offer keeps missing price and rates blank instead of inventing zero',async()=>{
   const unknown=structuredClone(offer);unknown.snapshot.totals.rows[0]={...row,unit_price_cents:null,discount_bps:null,vat_bps:null};
   const {page,context}=await visit('/eticaret/#offers',{setup:async context=>context.route('**/api/ec/offers**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/'+offer.id)?unknown:{offers:[offer]}}))});
   try{
    await page.locator('[data-offer=open]').click();await page.locator('[data-offer=edit]').click();
    const form=page.locator('[data-offer-form=save]');await form.waitFor();
    for(const name of ['unit_price','discount','vat'])assert.equal(await form.locator('[name='+name+']').inputValue(),'');
    assert.equal(await form.evaluate(form=>form.checkValidity()),false);assert.match(await form.locator('[data-offer-totals]').innerText(),/henüz hesaplanamıyor/);
    assert.equal(await form.locator('[name=party_id] option:checked').innerText(),offer.party_name);
   }finally{await context.close();}
  });
  await t.test('payment totals preserve missing values and every supplier remains reachable',async()=>{
   const {page,context}=await visit('/eticaret/#ledger?tab=odemeler',{setup:async context=>{
    await context.route('**/api/ec/ledger**',async route=>{
     const response=await route.fetch(),data=await response.json(),original=data.open_invoices[0];assert.ok(original);
     data.open_invoices=Array.from({length:31},(_,index)=>({...original,entry_id:'test-entry-'+index,party_id:'test-party-'+index,party_name:'Tedarikçi '+String(index+1).padStart(2,'0'),invoice_no:'SENTETIK-'+index,remaining_cents:index===0?null:0}));
     data.cheques=[{party_name:'Deneme',amount_cents:null}];await route.fulfill({response,json:data});
    });
   }});
   try{
    await page.locator('[data-business=pay-all][data-id=test-party-30]').waitFor();
    assert.equal(await page.locator('[data-business=pay-all]').count(),31);
    const stat=page.locator('.v2-stat').filter({hasText:'Toplam açık borcum'});assert.match(await stat.innerText(),/Bilgi eksik/);
    assert.match(await page.locator('.v2-stat').filter({hasText:'Verilen çek'}).innerText(),/Bilgi eksik/);
    assert.match(await page.locator('.v2-card').filter({hasText:'Tedarikçi 02 · borcum'}).locator('h2').innerText(),/0,00/);
    const maintenance=page.locator('details').filter({has:page.locator('[data-business=invoice-debts]')});assert.equal(await maintenance.getAttribute('open'),null);
    assert.equal(await page.locator('[data-business=provisional]').isVisible(),true);await noOverflow(page);
   }finally{await context.close();}
  });
  await t.test('ledger advanced filters stay visible when active and reset restores focus and URL',async()=>{
   const {page,context}=await visit('/eticaret/#ledger?tab=entries&from=2026-01-01&to=2026-12-31');
   try{
    const form=page.locator('[data-business-form=filter]');await form.waitFor();assert.equal(await form.locator('details').getAttribute('open'),'');
    assert.match(await form.locator('summary').innerText(),/etkin/);
    await page.locator('[data-business=filter-reset]').click();await focused(page,'[data-business-form=filter] [name=q]');
    assert.equal(await form.locator('[name=from]').inputValue(),'');assert.equal(await form.locator('details').getAttribute('open'),null);assert.equal(new URL(page.url()).hash.includes('from='),false);
    await noOverflow(page);
   }finally{await context.close();}
  });
  await t.test('staff wizard opens relevant permissions and communicates manual changes without granting money or deletion',async()=>{
   const {page,context}=await visit('/access');
   try{
    await page.locator('[data-new-employee]').first().click();const form=page.locator('[data-form=create]');
    await form.locator('[name=name]').fill('Yeni Çalışan');await form.locator('[name=username]').fill('calisan.03');
    assert.equal(await form.locator('[name=username]').getAttribute('aria-describedby'),'staff-username-help');
    await form.locator('[data-wizard-step="0"] [data-wizard-next]').click();await form.locator('[data-preset=production]').click();
    assert.equal(await form.locator('[data-preset=production]').getAttribute('aria-pressed'),'true');
    await form.locator('[data-wizard-step="1"] [data-wizard-next]').click();
    const lp=form.locator('[data-permission-group=lp]'),ec=form.locator('[data-permission-group=ec]');assert.equal(await lp.getAttribute('open'),'');assert.equal(await ec.getAttribute('open'),null);
    assert.match(await lp.locator('[data-permission-summary]').innerText(),/^5 \/ /);assert.equal(await form.locator('[name=money_lp]').isChecked(),false);assert.equal(await form.locator('[name=delete_records]').isChecked(),false);
    await lp.locator('[name=permit_lp_recipes]').selectOption('none');assert.match(await lp.locator('[data-permission-summary]').innerText(),/^4 \/ /);
    assert.equal(await form.locator('[data-preset=production]').getAttribute('aria-pressed'),'false');
    assert.match(await form.locator('[data-preset-description]').textContent(),/kişiye özel/);await noOverflow(page);
   }finally{await context.close();}
  });
  assert.deepEqual(errors,[],'No uncaught browser errors');assert.deepEqual(blocked,[],'No real writes or external requests');
 }finally{await browser.close();}
});
