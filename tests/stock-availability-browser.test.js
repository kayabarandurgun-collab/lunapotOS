import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
// Opt-in: main owns and starts the isolated local preview. This test starts no server and saves no form.
const preview=process.env.STOCK_PREVIEW_URL;
test('local browser: owner/reader physical stock, table, count preview, CSV and EC ledger labels at mobile/desktop widths', {skip:!preview}, async()=>{
 const base=new URL(preview);
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 const health=await (await fetch(new URL('/__preview/health',base))).json();
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'installed Playwright required');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const q=v=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:3}).format(v/1000);
 try{for(const role of ['owner','reader'])for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:960}});
  try{
   const writes=[];
   await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base.origin)return route.abort();
    if(url.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(request.method())){writes.push(url.pathname);return route.abort();}
    return route.continue();
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(new URL('/__preview/start?role='+role+'&next='+encodeURIComponent('/eticaret/#stock'),base).href);
   await page.locator('.stock-physical-card').first().waitFor();
   const response=await context.request.get(new URL('/api/ec',base).href);assert.equal(response.status(),200);
   const data=await response.json();assert.equal(await page.locator('.stock-physical-card').count(),data.stock.length);
   for(const p of data.stock){
    assert.equal(p.on_hand_milli,p.quantity_milli);assert.equal(p.available_milli,p.on_hand_milli-p.reserved_milli);
    const card=page.locator('.stock-physical-card').filter({has:page.locator('[data-ac="stock-history"][data-id="'+p.id+'"]')});
    assert.equal((await card.locator('.product-available strong').innerText()).replace(/\s+/g,' ').trim(),q(p.available_milli)+' '+p.stock_unit);
    const physical=await card.locator('.stock-physical dd').allTextContents();assert.equal(physical[0],q(p.on_hand_milli));assert.equal(physical[1],q(p.reserved_milli));assert.ok(physical[2].startsWith(p.in_transit_milli===null?'Bilinmiyor':q(p.in_transit_milli)));
    if(role==='reader')for(const [key,value] of Object.entries(p))if(key.endsWith('_cents'))assert.equal(value,null,key);
   }
   const sort=await page.locator('[data-ac-form="stock-filters"] [name=sort] option').allTextContents();assert.ok(!sort.some(x=>/kâr/.test(x)));assert.ok(sort.includes('Kargodaki miktar ↓'));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'stock document overflow '+role+' '+width);
   if(role==='owner'){
    const p=data.stock.find(p=>p.reserved_milli>0);assert.ok(p,'preview should have physically reserved product');
    await page.locator('[data-ac="stock"]').click();await page.locator('dialog[open]').waitFor();
    await page.locator('dialog [name=kind]').selectOption('count');await page.locator('dialog [name=product_id]').selectOption(p.id);
    await page.locator('dialog [name=quantity]').fill(String(p.on_hand_milli/1000-1));
    const output=await page.locator('[data-stock-count-preview]').innerText();assert.ok(output.includes('Kayıtlı depo: '+q(p.on_hand_milli)));assert.ok(output.includes('Fark: -1 '+p.stock_unit));
    const dialog=await page.locator('dialog').innerText();for(const s of ['Setleri değil','gönderilmemiş ürünler DAHİL','gönderilmiş paketler HARİÇ','Kargodaki miktarı eklemeyin'])assert.ok(dialog.includes(s),s);
    assert.equal(await page.locator('dialog [name=reference]').getAttribute('required'),'');assert.equal(await page.locator('dialog [name=notes]').getAttribute('required'),'');
    await page.locator('dialog [data-ac="close"]').first().click();
   }else{
    const countButton=page.locator('[data-ac="stock"]');assert.ok(await countButton.count()===0||!await countButton.isVisible()||await countButton.isDisabled(),'reader cannot enter a stock count');
   }
   await page.locator('[data-ac-form="stock-filters"] [name=view]').selectOption('table');await page.locator('.product-table').first().waitFor();
   assert.ok((await page.locator('.product-table thead').first().innerText()).includes('Kargoda · depodan çıktı'));
   // A download is read-only; inspect its stream without writing any artifact to disk.
   const downloadEvent=page.waitForEvent('download');await page.locator('[data-ac="stock-csv"]').click();const download=await downloadEvent;
   const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const csv=Buffer.concat(chunks).toString('utf8');
   assert.ok(csv.includes('Kargoda bilgi durumu'));assert.ok(csv.includes('Stok maliyeti TL · KDV dahil'));assert.ok(!csv.includes('Toplam kâr'));
   await page.goto(new URL('/eticaret/#sales',base).href);await page.locator('#ac-view h1').waitFor();assert.equal(await page.locator('#ac-view h1').innerText(),'Satış ve kesinti kayıtları');
   const sales=await page.locator('#ac-view').innerText();assert.ok(sales.includes('Set bileşenine ayrılan pay'));assert.ok(sales.includes('Kayıt katkısı'));assert.ok(!sales.includes('Katkı kârı'));
   if(role==='owner'){
    await page.goto(new URL('/uretim/#accounts',base).href);await page.locator('[data-ac="view"][data-id="sales"]').click();await page.locator('#ac-view h1').waitFor();
    assert.equal(await page.locator('#ac-view h1').innerText(),'Satışlar ve kârlılık');assert.ok((await page.locator('#ac-view').innerText()).includes('Katkı kârı'));
   }
   assert.deepEqual(errors,[],'no browser script errors');assert.deepEqual(writes,[],'never submit a ledger write');
  }finally{await context.close();}
 }}finally{await browser.close();}
});
