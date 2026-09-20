import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
const enabled=process.env.UI_OFFLINE_BROWSER==='1';
test('offline workspace shell recovers without caching API data or replaying writes',{skip:!enabled,timeout:120000},async t=>{
 const base=new URL(process.env.UI_OFFLINE_PREVIEW||'http://127.0.0.1:8791');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({serviceWorkers:'allow'}),page=await context.newPage();page.setDefaultTimeout(15000);
 const writes=[],errors=[];context.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.method()+' '+new URL(r.url()).pathname);});page.on('pageerror',e=>errors.push(e.message));
 const start=path=>page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:path}),base).href);
 try{
  await t.test('activation removes the previous shell and includes route chunks',async()=>{
   await page.goto(new URL('/__preview/health',base).href);
   await page.evaluate(async()=>{const old=await caches.open('lunapot-shell-v115-stok-satis-ekip');await old.put('/old-ui-fixture',new Response('old'));await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
   await page.waitForFunction(async()=>!(await caches.keys()).includes('lunapot-shell-v115-stok-satis-ekip'));
   const paths=await page.evaluate(async()=>{const key=(await caches.keys()).find(x=>x.startsWith('lunapot-shell-'));return (await (await caches.open(key)).keys()).map(r=>new URL(r.url).pathname);});
   assert.ok(paths.includes('/route-loader.js'));assert.ok(paths.includes('/lot-ui.js'));assert.ok(paths.includes('/reconciliation-ui.js'));
   assert.equal(paths.some(p=>p.startsWith('/api/')),false);
  });
  for(const path of ['/eticaret/#overview','/uretim/#dashboard'])await t.test(path+' reload offline offers an honest Turkish reconnect state',async()=>{
   await start(path);await page.locator('main h1').waitFor();
   await context.setOffline(true);await page.reload();
   await page.getByRole('button',{name:/Yeniden dene|Tekrar dene/}).first().waitFor();
   const body=await page.locator('body').innerText();assert.match(body,/bağlantı|Bağlantı|çevrimdışı|İnternet/);assert.doesNotMatch(body,/Failed to fetch|paneli yükleniyor|Sistem hazırlanıyor/);
   await context.setOffline(false);
   // Production also retries on the online event; click only if that recovery has not already replaced the button.
   await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>/Yeniden dene|Tekrar dene/.test(b.textContent))?.click());await page.locator('main h1').waitFor();
  });
  await t.test('missing deferred route chunk can recover after reconnection',async()=>{
   await start('/eticaret/#overview');await page.locator('main h1').waitFor();
   await page.evaluate(async()=>{for(const key of await caches.keys()){const cache=await caches.open(key);for(const req of await cache.keys())if(new URL(req.url).pathname==='/reconciliation-ui.js')await cache.delete(req);}});
   await context.setOffline(true);await page.evaluate(()=>location.hash='#reconciliation');
   await page.locator('[data-route-error]').waitFor();assert.match(await page.locator('[data-route-error]').innerText(),/İnternet bağlantısı yok/);
   await context.setOffline(false);await page.locator('[data-route-retry]').click();
   await page.locator('main h1').waitFor();assert.equal(await page.locator('[data-route-error]').count(),0);assert.match(page.url(),/#reconciliation$/);
  });
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(async()=>{for(const key of await caches.keys())for(const r of await (await caches.open(key)).keys())if(new URL(r.url).pathname.startsWith('/api/'))return true;return false;}),false);
 }finally{await context.setOffline(false);await context.close();await browser.close();}
});
