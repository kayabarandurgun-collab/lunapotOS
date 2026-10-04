import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFileSync,mkdirSync} from 'node:fs';import {resolve,extname,sep} from 'node:path';
import {warehouseFixture} from './warehouse-fixture.test.js';import {findPlaywright} from '../scripts/design-audit.mjs';import {fifoRevalue} from '../src/fifo-cost.js';

test('390px real browser + Worker + SQLite: create, save, resume, filter, review, apply, dossier and disposal',{skip:process.env.WAREHOUSE_BROWSER!=='1',timeout:120000},async()=>{
 const f=warehouseFixture();await f.setup();f.product('a',10000,10000);f.product('b',10000,10000);f.product('c',3000,3000);await fifoRevalue(f.env.DB,100);
 const root=resolve('public'),owner={owner:true,id:'owner'},network=globalThis.fetch;globalThis.fetch=async()=>{throw Error('WAREHOUSE_TEST_EXTERNAL_NETWORK_BLOCKED');};
 let server,browser;const errors=[],requests=[];
 try{
  let serial=Promise.resolve();server=createServer((req,res)=>{serial=serial.then(async()=>{
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/'){
    const user=url.searchParams.has('reader')?{ec_access:'read',permissions:{ec:{stock:'read',amounts:'none'}}}:owner;
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end('<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/warehouse.css"><style>body{margin:0;padding:16px;font-family:Arial,sans-serif}main{max-width:1200px;margin:auto}button,input,select{font:inherit}</style><main id="root"></main><script type="module">import{mountWarehouse}from"/warehouse-ui.js";import{mountProductProfile}from"/product-profile-ui.js";const user='+JSON.stringify(user)+';function mount(){window.disposeWarehouse?.();const r=document.querySelector("#root");r.replaceChildren();window.disposeWarehouse=(location.hash.startsWith("#product")?mountProductProfile:mountWarehouse)(r,"ec",user)}mount();window.addEventListener("hashchange",mount)</script></html>');return;
   }
   if(url.pathname.startsWith('/api/')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;requests.push({path:url.pathname,method:req.method});const r=await f.req(url.pathname.slice(4)+url.search,body);res.writeHead(r.status,{'Content-Type':'application/json'});res.end(JSON.stringify(r.data));return;}
   const file=resolve(root,'.'+url.pathname);if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
   try{const data=readFileSync(file);res.writeHead(200,{'Content-Type':extname(file)==='.css'?'text/css':'text/javascript','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end();}
  }).catch(e=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const {api}=await findPlaywright();assert.ok(api);browser=await api.chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  const idle=()=>page.waitForFunction(()=>document.querySelector('#root')?.getAttribute('aria-busy')==='false');
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.goto(base+'/#warehouse');await idle();await page.locator('[data-wh-form="create"] [name="title"]').fill('Telefon denemesi');await page.getByRole('button',{name:'Sayımı başlat',exact:true}).click();await idle();assert.equal(await page.locator('[data-wh-product]').count(),3);
  const row=id=>page.locator('[data-wh-product="'+id+'"]');
  await row('a').locator('[name="quantity"]').fill('9');await row('b').locator('[name="quantity"]').fill('12');
  await row('a').getByRole('button',{name:'Miktarı kaydet'}).click();await idle();assert.equal(await row('b').locator('[name="quantity"]').inputValue(),'12','saving another row retains unsaved edits');
  await row('b').getByRole('button',{name:'Miktarı kaydet'}).click();await idle();await page.getByRole('button',{name:'Farkları gözden geçir'}).click();await idle();assert.match(await page.locator('.wh-feedback').innerText(),/maliyet/);
  await row('b').locator('[name="cost"]').fill('10');await row('b').getByRole('button',{name:'Miktarı kaydet'}).click();await idle();
  const saved=page.url();assert.match(saved,/#warehouse\?session=/);await page.reload();await idle();assert.equal(await row('a').locator('[name="quantity"]').inputValue(),'9');assert.equal(await row('b').locator('[name="quantity"]').inputValue(),'12');
  await page.locator('[data-wh-form="filter"] select').selectOption('uncounted');await page.locator('[data-wh-form="filter"] [type="submit"]').click();assert.equal(await page.locator('[data-wh-product]').count(),1);assert.equal(await page.locator('[data-wh-product]').getAttribute('data-wh-product'),'c');
  await page.locator('[data-wh-form="filter"] select').selectOption('all');await page.locator('[data-wh-form="filter"] [name="q"]').fill('Ürün b');await page.locator('[data-wh-form="filter"] [type="submit"]').click();assert.equal(await page.locator('[data-wh-product]').count(),1);assert.equal(await row('b').count(),1);
  await page.locator('[data-wh-form="filter"] [name="q"]').fill('');await page.locator('[data-wh-form="filter"] [type="submit"]').click();await page.getByRole('button',{name:'Farkları gözden geçir'}).click();await idle();await page.locator('[data-wh-review]').waitFor();await noOverflow();
  mkdirSync('docs/system-upgrade-2026-10-04/warehouse-artifacts',{recursive:true});await page.screenshot({path:'docs/system-upgrade-2026-10-04/warehouse-artifacts/count-review-390.png',fullPage:true});
  await page.getByRole('button',{name:'Onayla ve stoğa işle'}).click();await idle();await page.getByRole('heading',{name:'Sayım stoğa işlendi'}).waitFor();
  assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='a'").get().quantity_milli,9000);assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='b'").get().quantity_milli,12000);assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='c'").get().quantity_milli,3000);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,2);
  await row('a').getByRole('link',{name:'Ürün a'}).click();await idle();await page.getByRole('heading',{name:'Stok hareketleri',exact:true}).waitFor();assert.match(await page.locator('.product-profile').innerText(),/Sayım farkı/);await noOverflow();await page.screenshot({path:'docs/system-upgrade-2026-10-04/warehouse-artifacts/product-390.png',fullPage:true});
  await page.getByRole('link',{name:'Depo sayımı',exact:true}).click();await idle();await page.getByRole('button',{name:'Tedarik önerileri',exact:true}).click();await noOverflow();
  const config=page.locator('[data-wh-form="config"][data-id="a"]');await config.locator('xpath=..').locator('summary').click();await config.locator('[name="lead"]').fill('5');await config.getByRole('button',{name:'Ayarları kaydet'}).click();await idle();assert.equal(f.sqlite.prepare("SELECT lead_days FROM ec_warehouse_reorder_settings WHERE product_id='a'").get().lead_days,5);
  await page.screenshot({path:'docs/system-upgrade-2026-10-04/warehouse-artifacts/replenishment-390.png',fullPage:true});
  for(const width of [320,1440]){await page.setViewportSize({width,height:900});await noOverflow();}
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),{});const before=requests.length;await page.evaluate(()=>{window.disposeWarehouse();document.querySelector('#root').innerHTML='<p>Disposed</p>';});await page.waitForTimeout(50);assert.equal(await page.locator('#root').innerText(),'Disposed');assert.equal(requests.length,before);
  await page.goto(base+'/?reader#warehouse');await idle();assert.equal(await page.locator('[data-wh-form="create"]').count(),0);assert.deepEqual(errors,[]);
 }finally{globalThis.fetch=network;await browser?.close();if(server)await new Promise(r=>server.close(r));f.close();}
});
