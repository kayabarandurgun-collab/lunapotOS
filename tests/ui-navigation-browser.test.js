import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
import {navigationGroups,navigationHref} from '../public/workspace-navigation.js';

const preview=process.env.NAVIGATION_PREVIEW_URL;
const range='from=2026-09-01&to=2026-09-19';
const origin='http://127.0.0.1:8791';

test('navigation carries a valid commerce range without leaking filters or crossing workspaces',()=>{
 const current=origin+'/eticaret/#performance?view=sales&kind=bundle&'+range;
 for(const route of ['overview','performance','orders','stock','sales','ledger']){
  assert.equal(navigationHref('#'+route,current),'/eticaret/#'+route+'?'+range);
 }
 assert.equal(navigationHref('#performance?view=packages',current),'/eticaret/#performance?view=packages&'+range);
 for(const href of ['#reports','#pricing','/uretim/#dashboard','/access#account','/webmagaza/','https://example.test/eticaret/#orders'])assert.equal(navigationHref(href,current),href);
 for(const query of ['','from=2026-09-19','from=2026-09-19&to=2026-09-01','from=2026-02-30&to=2026-03-01','from=bad&to=2026-09-19']){
  assert.equal(navigationHref('#orders',origin+'/eticaret/#overview?'+query),'#orders');
 }
 assert.equal(navigationHref('/eticaret/#orders',origin+'/uretim/#dashboard?'+range),'/eticaret/#orders');
});

test('navigation requires an explicit workspace envelope and preserves existing permission aliases',()=>{
 const ec=Object.fromEntries(['overview','orders','reports','stock','settings'].map(k=>[k,k]));
 const lp=Object.fromEntries(['dashboard','recipes','barcodes','lots','settings'].map(k=>[k,k]));
 for(const user of [null,{}, {ec_access:'none',lp_access:'none'}]){
  assert.deepEqual(navigationGroups('ec',ec,user),[]);assert.deepEqual(navigationGroups('lp',lp,user),[]);
 }
 const staff={ec_access:'read',lp_access:'read',permissions:{ec:{orders:'read'},lp:{recipes:'read'}}};
 assert.deepEqual(navigationGroups('ec',ec,staff).flatMap(g=>g.routes),['overview','orders','reports']);
 assert.deepEqual(navigationGroups('lp',lp,staff).flatMap(g=>g.routes),['dashboard','recipes','barcodes','lots']);
});

// Opt-in: use the running isolated synthetic preview; never launch a server, submit a form or install dependencies.
test('local browser: navigation discovery, permissions, current page, keyboard and date ranges',{skip:!preview,timeout:180000},async t=>{
 const base=new URL(preview);
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const response=await fetch(new URL('/__preview/health',base));assert.equal(response.status,200);
 const health=await response.json();assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright; do not download packages.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const withPage=async(width,run,{restricted=false}={})=>{
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'}),writes=[],external=[],errors=[];
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==base.origin){external.push(url.href);return route.abort();}
   if(!['GET','HEAD'].includes(request.method())){writes.push(request.method()+' '+url.pathname);return route.abort();}
   // Browser-only response fixture exercises a narrower assigned role without mutating users or permissions.
   if(restricted&&url.pathname==='/api/auth/status'){
    const upstream=await route.fetch(),status=await upstream.json();
    return route.fulfill({response:upstream,json:{...status,user:{...status.user,owner:false,ec_access:'read',lp_access:'none',permissions:{ec:{orders:'read'},lp:{}}}}});
   }
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const start=async(path,role='owner',scenario='populated')=>{
   await page.goto(new URL('/__preview/start?role='+role+'&scenario='+scenario+'&next='+encodeURIComponent(path),base).href);
   await page.waitForLoadState('networkidle');
  };
  try{await run(page,start);assert.deepEqual(writes,[],'no writes attempted');assert.deepEqual(external,[],'no external requests');assert.deepEqual(errors,[],'no browser script errors');}
  finally{await context.close();}
 };
 const open=async page=>{await page.locator('[data-quick-nav]').focus();await page.keyboard.press('Control+k');await page.locator('.ui-command[open]').waitFor();assert.equal(await page.locator('.ui-command input').evaluate(el=>el===document.activeElement),true);};
 const close=async page=>{await page.keyboard.press('Escape');await page.locator('.ui-command').waitFor({state:'detached'});};
 try{
  for(const role of ['owner','reader'])for(const width of [390,1440]){
   await t.test(role+' / '+width+'px / production, commerce, launcher, access and webshop',()=>withPage(width,async(page,start)=>{
    await start('/uretim/#dashboard',role);
    await page.locator('.workspace-identity').waitFor({state:'attached'});
    await open(page);
    assert.equal(await page.locator('.ui-command-result[aria-current] span').innerText(),'Genel durum');
    assert.equal(await page.locator('.ui-command-result[href="/access#account"] span').innerText(),'Hesabım');
    assert.equal(await page.locator('.ui-command-result[href="/uretim/#settings"]').count(),role==='owner'?1:0);
    assert.equal(await page.locator('.ui-command-result[href="/uretim/#materials"]').count(),1,'collapsed groups remain searchable');
    await page.keyboard.press('ArrowDown');assert.equal(await page.locator('.ui-command-result').first().evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('ArrowUp');assert.equal(await page.locator('.ui-command input').evaluate(el=>el===document.activeElement),true);
    await page.locator('.ui-command input').fill('RECETELER');assert.equal(await page.locator('.ui-command-result span').innerText(),'Reçeteler');
    await page.locator('.ui-command input').fill('no-such-screen');assert.equal(await page.locator('.ui-command-result').count(),0);assert.equal(await page.locator('.ui-command [role=status]').innerText(),'0 ekran');
    await page.keyboard.press('Enter');assert.equal(new URL(page.url()).hash,'#dashboard');
    await close(page);assert.equal(await page.locator('[data-quick-nav]').evaluate(el=>el===document.activeElement),true);
    await page.locator('[data-quick-nav]').click();await page.locator('.ui-command input').fill('receteler');await page.keyboard.press('Enter');await page.waitForURL('**/#recipes');
    await page.locator('#sidebar a[href="#recipes"][aria-current]').waitFor({state:'attached'});
    assert.equal(await page.locator('.mobile-dock a[href="#materialstock"]').getAttribute('aria-label'),'Hammadde deposu');

    await start('/eticaret/#overview?'+range,role);await open(page);
    await page.locator('.ui-command input').fill('siparisler');await page.keyboard.press('Enter');
    await page.waitForURL(url=>url.hash==='#orders?'+range);
    await page.locator('#sidebar a[href="#orders"][aria-current]').waitFor({state:'attached'});
    assert.equal(await page.locator('.mobile-dock a[href="#stock"]').getAttribute('aria-label'),'Depomdaki ürünler');
    assert.equal(await page.locator('.mobile-dock a[href="#performance"] span').innerText(),'Satış ve kâr');
    if(width<800)await page.locator('.mobile-dock a[href="#performance"]').click();
    else await page.locator('#sidebar a[href="#performance"]').click();
    await page.waitForURL(url=>url.hash==='#performance?'+range);
    await page.waitForLoadState('networkidle');await open(page);
    await page.evaluate(range=>{location.hash='stock?'+range;},range);
    await page.locator('#sidebar a[href="#stock"][aria-current]').waitFor({state:'attached'});
    assert.equal(await page.locator('.ui-command-result[aria-current] span').innerText(),'Depomdaki ürünler');
    assert.equal(await page.locator('.ui-command-result[href*="#orders?"]').getAttribute('href'),'/eticaret/#orders?'+range);
    await close(page);

    await start('/',role);await open(page);
    assert.equal(await page.locator('.ui-command-result[href="/webmagaza/"] span').innerText(),'Web Mağaza');
    if(role==='owner')assert.equal(await page.locator('.ui-command-result[href="/access"] span').innerText(),'Ekip ve yetkiler');
    else assert.equal(await page.locator('.ui-command-result[href="/access"]').count(),0);
    await close(page);
    await page.locator('.workspace-switch').click();
    assert.equal(await page.locator('.workspace-switch-list a[aria-current]').getAttribute('href'),'/');
    assert.equal(await page.locator('.workspace-switch-list a[href="/access"] strong').innerText(),role==='owner'?'Ekip ve erişim':'Hesabım');
    await page.keyboard.press('Escape');await page.locator('.workspace-switch-dialog').waitFor({state:'detached'});

    await start('/access#account',role);assert.equal(await page.locator('#account').count(),1);
    assert.equal(await page.locator('.access-sections a[href="#team"]').count(),role==='owner'?1:0);
    assert.ok(await page.locator('.access-topbar a[href="/"]').count()>0,'account has a return path');
    await start('/webmagaza/#orders',role);
    assert.equal(await page.locator('#ws-nav a[aria-current]').getAttribute('href'),'#orders');
    if(width<800&&!await page.locator('.ws-navigation').evaluate(el=>el.open))await page.locator('.ws-navigation>summary').click();
    assert.equal(await page.locator('#ws-nav a[href="#outbox"]').isVisible(),role==='owner');
    await page.locator('.workspace-switch').click();
    assert.equal(await page.locator('.workspace-switch-list a[aria-current]').getAttribute('href'),'/webmagaza/');
    await page.keyboard.press('Escape');await page.locator('.workspace-switch-dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('.workspace-switch').evaluate(el=>el===document.activeElement),true);
   }));
  }
  for(const scenario of ['missing','empty'])await t.test(scenario+' / 360px search and range',()=>withPage(360,async(page,start)=>{
   await start('/eticaret/#overview?'+range,'owner',scenario);await open(page);
   assert.equal(await page.locator('.ui-command-result[aria-current] span').innerText(),'Genel durum');
   assert.equal(await page.locator('.ui-command-result[href*="#orders?"]').getAttribute('href'),'/eticaret/#orders?'+range);
   assert.equal(await page.locator('.ui-command').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'search fits narrow viewport');
   await page.locator('.ui-command input').fill('siparisler');await page.keyboard.press('Enter');await page.waitForURL(url=>url.hash==='#orders?'+range);
  }));
  await t.test('restricted browser fixture exposes only assigned destinations, including collapsed aliases',()=>withPage(390,async(page,start)=>{
   await start('/eticaret/#overview','reader');await open(page);
   const routes=await page.locator('.ui-command-result[href^="/eticaret/#"]').evaluateAll(links=>links.map(a=>a.hash));
   assert.deepEqual(routes,['#overview','#orders','#reports']);
   await close(page);
   assert.deepEqual(await page.locator('.mobile-dock a').evaluateAll(links=>links.map(a=>a.hash)),['#overview','#orders']);
   await page.locator('.workspace-switch').click();
   assert.deepEqual(await page.locator('.workspace-switch-list a').evaluateAll(links=>links.map(a=>a.getAttribute('href'))),['/','/eticaret/#overview','/access']);
   await page.keyboard.press('Escape');await page.locator('.workspace-switch-dialog').waitFor({state:'detached'});
   await start('/','reader');await open(page);
   assert.equal(await page.locator('.ui-command-result[href="/uretim/#dashboard"],.ui-command-result[href="/webmagaza/"]').count(),0);
   await close(page);
  },{restricted:true}));
 }finally{await browser.close();}
});
