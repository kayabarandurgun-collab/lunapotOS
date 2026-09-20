import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
import {createRouteLoader,createSessionOwner} from '../public/route-loader.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const rootStub=()=>({isConnected:true,innerHTML:'',setAttribute(){},removeAttribute(){}});

test('route generations reject late mounts/errors and keep the active disposer and hash hook',async()=>{
 const router=createRouteLoader(),root=rootStub(),pending=deferred(),old=router.begin();
 let staleMounts=0,disposals=0,hashes=0;
 const first=old.mount(root,()=>pending.promise,()=>{staleMounts++;});
 const current=router.begin(),dispose=()=>{disposals++;};dispose.onHash=()=>{hashes++;};
 await current.mount(root,async()=>({}),()=>{root.innerHTML='Current';return dispose;});
 pending.resolve({});await first;
 assert.equal(root.innerHTML,'Current');assert.equal(staleMounts,0);
 assert.equal(router.onHash(),true);assert.equal(hashes,1);
 const failing=deferred(),next=router.begin();assert.equal(disposals,1);assert.equal(router.onHash(),false);
 const failure=next.mount(root,()=>failing.promise,()=>{throw Error('must not mount');});
 router.begin();root.innerHTML='Access denied';failing.reject(Error('late failure'));await failure;
 assert.equal(root.innerHTML,'Access denied');assert.equal(disposals,1);
});

test('a disconnected root never mounts, and reentrant mounting cleans up its own resources',async()=>{
 const router=createRouteLoader(),root=rootStub(),pending=deferred();let mounts=0,disposals=0;
 const loading=router.begin().mount(root,()=>pending.promise,()=>{mounts++;});root.isConnected=false;pending.resolve({});await loading;assert.equal(mounts,0);
 root.isConnected=true;
 await router.begin().mount(root,async()=>({}),()=>{router.begin();return ()=>{disposals++;};});
 assert.equal(disposals,1);router.begin();assert.equal(disposals,1);
});

test('session ownership aborts old requests independently of route changes',()=>{
 const session=createSessionOwner(),first=session.begin(),same=session.capture();
 assert.equal(first.isCurrent(),true);assert.equal(same.signal,first.signal);
 const next=session.begin();assert.equal(first.signal.aborted,true);assert.equal(same.isCurrent(),false);
 assert.throws(first.check,{name:'AbortError'});assert.equal(next.isCurrent(),true);next.check();
});

// Opt in to the existing isolated synthetic server. No server launch, writes, or external requests.
const preview=process.env.ROUTING_PREVIEW_URL;
test('local browser: lazy routes, stale imports, disposal, retry and existing access gates',{skip:!preview,timeout:240000},async t=>{
 const base=new URL(preview);assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await (await fetch(new URL('/__preview/health',base))).json();
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright only.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const withPage=async(run,intercept=()=>false,mockAuth=null)=>{
  const context=await browser.newContext({serviceWorkers:'block'}),requests=[],writes=[],external=[],errors=[];
  await context.addInitScript(()=>{
   window.__routeSignals=[];
   const add=EventTarget.prototype.addEventListener;
   EventTarget.prototype.addEventListener=function(type,listener,options){
    if(this instanceof HTMLElement&&['content','commerce-content'].includes(this.id)&&options?.signal)window.__routeSignals.push({root:this,signal:options.signal,connected:this.isConnected});
    return add.call(this,type,listener,options);
   };
  });
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());requests.push(url.pathname);
   if(url.origin!==base.origin){external.push(url.href);return route.abort();}
   if(!['GET','HEAD'].includes(request.method())){
    // Auth writes in lifecycle cases are fulfilled in this disposable browser only, never forwarded.
    if(mockAuth&&request.method()==='POST'&&['/api/auth/logout','/api/auth/login','/api/auth/setup'].includes(url.pathname)){await route.fulfill({status:200,json:await mockAuth(url.pathname)});return;}
    writes.push(request.method()+' '+url.pathname);return route.abort();
   }
   if(await intercept(route,url))return;
   return route.continue();
  });
  const page=await context.newPage(),pending=new Set();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>pending.add(request));page.on('requestfinished',request=>pending.delete(request));page.on('requestfailed',request=>pending.delete(request));
  const settled=async()=>{const deadline=Date.now()+10000;do{if(pending.size)await page.waitForTimeout(25);else await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));if(Date.now()>deadline)assert.fail('Requests did not settle: '+[...pending].map(r=>r.url()).join(', '));}while(pending.size);};
  const start=async(path,role='owner',scenario='populated')=>{await page.goto(new URL('/__preview/start?role='+role+'&scenario='+scenario+'&next='+encodeURIComponent(path),base).href);};
  const ready=async()=>{await page.locator('main h1').first().waitFor();await page.locator('[data-route-loading]').waitFor({state:'detached'});await settled();};
  const go=async hash=>{await page.evaluate(hash=>new Promise(resolve=>{if(location.hash==='#'+hash){resolve();return;}window.addEventListener('hashchange',()=>queueMicrotask(resolve),{once:true});location.hash=hash;}),hash);};
  try{await run({page,start,ready,go,requests,settled});assert.deepEqual(errors,[],'no uncaught page errors');assert.deepEqual(writes,[],'no business writes');assert.deepEqual(external,[],'local network only');}
  finally{await context.close();}
 };
 const gate=pathname=>{
  const seen=deferred(),release=deferred();let used=false;
  return {seen:seen.promise,release:release.resolve,async intercept(route,url){if(url.pathname!==pathname||used)return false;used=true;seen.resolve();const fail=await release.promise;if(fail)await route.abort('failed');else await route.continue();return true;}};
 };
 const rememberRoot=page=>page.evaluate(()=>{window.__activeRouteRoot=document.querySelector('main');});
 const assertDisposed=async page=>{
  const signals=await page.evaluate(()=>window.__routeSignals.filter(s=>s.root===window.__activeRouteRoot).map(s=>s.signal.aborted));
  assert.ok(signals.length>0,'the real mounted module registered abortable root handlers');assert.ok(signals.every(Boolean),'every departed view handler was aborted');
  assert.equal(await page.evaluate(()=>window.__routeSignals.some(s=>!s.connected)),false,'no detached root was ever mounted');
 };
 try{
  for(const [workspace,home] of [['uretim','dashboard'],['eticaret','overview']])for(const role of ['owner','reader','anonymous']){
   await t.test(workspace+' / '+role+' opens without unrelated features',()=>withPage(async({page,start,ready,requests})=>{
    await start('/'+workspace+'/#'+home,role);
    if(role==='anonymous'){await page.locator('form input[name=password]').waitFor();await page.waitForLoadState('networkidle');}else await ready();
    const unrelated=['/accounting-ui.js','/report-inbox-ui.js','/orders-ui.js','/sales-document-ui.js','/purchase-document-ui.js','/pdf-read.js','/xlsx-read.js','/offers-ui.js'];
    for(const path of unrelated)assert.equal(requests.includes(path),false,path+' stays deferred');
    if(role!=='owner')for(const path of ['/operations-ui.js','/production-ui.js'])assert.equal(requests.includes(path),false,path+' stays deferred on login/staff home');
    const graph=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.endsWith('.js')));
    t.diagnostic(workspace+' '+role+': '+graph.length+' JS resources, '+graph.reduce((sum,r)=>sum+r.decodedBodySize,0)+' decoded bytes (service worker blocked)');
   }));
  }
  for(const phase of ['logout pending','login visible']){
   await t.test('R1: old production data cannot return while '+phase,async()=>{
    let loggedOut=false;const logoutSeen=deferred(),releaseLogout=deferred();
    await withPage(async({page,start,ready,go,settled})=>{
     await start('/uretim/#products');await ready();
     await page.evaluate(()=>{
      const original=window.fetch;window.fetch=async(input,options)=>{
       const response=await original(input,options);
       if(new URL(input,location.href).pathname!=='/api/data')return response;
       const body=await response.json();window.heldDataSignal=options.signal;
       response.json=()=>new Promise(resolve=>{window.releaseOldData=()=>resolve(body);});return response;
      };
     });
     await page.locator('[data-action="refresh"]').click();await page.waitForFunction(()=>!!window.releaseOldData);
     await page.locator('[data-action="logout"]').click();await logoutSeen.promise;
     assert.equal(await page.locator('#content').count(),0,'old records removed before logout finishes');
     assert.equal(await page.evaluate(()=>window.heldDataSignal.aborted),true,'the session read is cancelled immediately');
     await go('materials');assert.equal(await page.locator('#content').count(),0,'hash changes cannot render an unauthenticated workspace');
     if(phase==='login visible'){releaseLogout.resolve();await page.locator('#login-form').waitFor();}
     await page.evaluate(()=>window.releaseOldData());if(phase==='login visible')await settled();else await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     assert.equal(await page.locator('#content').count(),0,'late data cannot re-create the workspace');
     if(phase==='logout pending'){releaseLogout.resolve();await page.locator('#login-form').waitFor();}
     assert.equal(await page.locator('#login-form').count(),1);
    },async(route,url)=>{
     if(url.pathname!=='/api/auth/status'||!loggedOut)return false;
     await route.fulfill({status:200,json:{authenticated:false,initialized:true,user:null}});return true;
    },async path=>{assert.equal(path,'/api/auth/logout');loggedOut=true;logoutSeen.resolve();await releaseLogout.promise;return {ok:true};});
   });
  }
  await t.test('R1: a same-session refresh may finish on the newly selected production route',()=>withPage(async({page,start,ready,go})=>{
   await start('/uretim/#products');await ready();
   await page.evaluate(()=>{
    const original=window.fetch;window.fetch=async(input,options)=>{
     const response=await original(input,options);if(new URL(input,location.href).pathname!=='/api/data')return response;
     const body=await response.json();body.materials[0].name='Güncel sentetik hammadde';window.sameSessionSignal=options.signal;
     response.json=()=>new Promise(resolve=>{window.releaseSameSessionData=()=>resolve(body);});return response;
    };
   });
   await page.locator('[data-action="refresh"]').click();await page.waitForFunction(()=>!!window.releaseSameSessionData);
   await go('materials');await page.locator('main h1').waitFor();assert.equal(await page.evaluate(()=>window.sameSessionSignal.aborted),false);
   await page.evaluate(()=>window.releaseSameSessionData());await page.getByText('Güncel sentetik hammadde',{exact:true}).waitFor();
   assert.equal(new URL(page.url()).hash,'#materials');assert.equal(await page.locator('main h1').innerText(),'Hammadde kartları');
  }));
  for(const [workspace,route,entry,retry,away] of [['uretim','production','/app.js:','[data-action="retry"]','materials'],['eticaret','orders','/ecommerce.js:','#commerce-retry','catalog']]){
   for(const completion of ['failure','unauthenticated success']){
    await t.test('R2: '+workspace+' obsolete startup '+completion+' cannot replace/dispose the newest view',()=>withPage(async({page,start,ready,go,settled})=>{
     await page.addInitScript(({entry,completion})=>{
      const original=window.fetch;let fixture;window.entryStatusCalls=0;
      window.fetch=async function(input,options){
       const caller=new Error().stack||'';
       if(new URL(input,location.href).pathname!=='/api/auth/status'||!caller.includes(entry))return original(input,options);
       const call=++window.entryStatusCalls;
       if(call===1){fixture=await (await original(input,options)).json();throw new TypeError('Synthetic initial status failure');}
       if(call===2){window.oldStartupSignal=options.signal;return new Promise((resolve,reject)=>{window.finishOldStartup=()=>completion==='failure'?reject(new Error('Synthetic stale startup failure')):resolve(new Response(JSON.stringify({...fixture,authenticated:false,user:null}),{status:200,headers:{'Content-Type':'application/json'}}));});}
       return new Response(JSON.stringify(fixture),{status:200,headers:{'Content-Type':'application/json'}});
      };
     },{entry,completion});
     await start('/'+workspace+'/#'+route);await page.locator('[data-startup-error]').waitFor();
     await page.locator(retry).click();await page.waitForFunction(()=>!!window.finishOldStartup);
     assert.equal(await page.locator(retry).isDisabled(),true,'retry is disabled while pending');
     await page.locator(retry).evaluate(el=>el.click());assert.equal(await page.evaluate(()=>window.entryStatusCalls),2,'disabled click does not start a duplicate request');
     await page.evaluate(()=>window.dispatchEvent(new Event('online')));await ready();await rememberRoot(page);
     const heading=await page.locator('main h1').innerText();assert.equal(await page.evaluate(()=>window.oldStartupSignal.aborted),true);
     await page.evaluate(()=>window.finishOldStartup());await settled();
     assert.equal(await page.locator('main h1').innerText(),heading);assert.equal(await page.locator('[data-startup-error]').count(),0);
     assert.equal(await page.evaluate(()=>document.querySelector('main')===window.__activeRouteRoot),true);
     assert.equal(await page.evaluate(()=>window.__routeSignals.some(s=>s.root===window.__activeRouteRoot&&s.signal.aborted)),false,'stale result does not dispose the successful mount');
     await go(away);await ready();await assertDisposed(page);
    }));
   }
   for(const completion of ['failure','success']){
    await t.test(workspace+' stale manual login '+completion+' cannot change current identity or UI',()=>withPage(async({page,start,ready,settled})=>{
     await page.addInitScript(({entry,completion})=>{
      const original=window.fetch;let fixture;window.loginStatusCalls=0;window.useAuthenticatedStatus=false;
      window.fetch=async function(input,options){
       const caller=new Error().stack||'',path=new URL(input,location.href).pathname;
       if(!caller.includes(entry))return original(input,options);
       if(path==='/api/auth/status'){
        window.loginStatusCalls++;fixture||=(await (await original(input,options)).json());
        return new Response(JSON.stringify(window.useAuthenticatedStatus?fixture:{...fixture,authenticated:false,user:null}),{status:200,headers:{'Content-Type':'application/json'}});
       }
       if(path==='/api/auth/login'){
        window.oldLoginSignal=options.signal;
        return new Promise((resolve,reject)=>{window.finishOldLogin=()=>completion==='failure'?reject(new Error('Synthetic stale login failure')):resolve(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));});
       }
       return original(input,options);
      };
     },{entry,completion});
     await start('/'+workspace+'/#'+route);const form=page.locator(workspace==='uretim'?'#login-form':'#commerce-login');await form.waitFor();
     await form.locator('[name="password"]').fill('browser-only-synthetic');await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>!!window.finishOldLogin);
     await page.evaluate(()=>{window.useAuthenticatedStatus=true;window.dispatchEvent(new Event('online'));});await ready();await rememberRoot(page);
     assert.equal(await page.evaluate(()=>window.oldLoginSignal.aborted),true);
     const count=await page.evaluate(()=>window.loginStatusCalls);await page.evaluate(()=>window.finishOldLogin());await settled();
     assert.equal(await page.evaluate(()=>window.loginStatusCalls),count,'obsolete login cannot start another identity read');
     assert.equal(await page.evaluate(()=>document.querySelector('main')===window.__activeRouteRoot),true);assert.equal(await page.locator('[data-startup-error],#login-form,#commerce-login').count(),0);
    }));
   }
  }
  for(const [workspace,home,failingPath] of [['uretim','dashboard','/api/auth/status'],['uretim','dashboard','/api/data'],['eticaret','overview','/api/auth/status']]){
   await t.test(workspace+' cold '+failingPath+' failure is Turkish and retry recovers',async()=>{
    let failing=true;
    await withPage(async({page,start,ready})=>{
     await start('/'+workspace+'/#'+home);await page.locator('[data-startup-error]').waitFor();
     const text=await page.locator('[data-startup-error]').innerText();assert.match(text,/Sunucuya ulaşılamıyor/);assert.doesNotMatch(text,/Failed to fetch|NetworkError|TypeError|yükleniyor/i);
     failing=false;await page.locator('[data-startup-error] button').click();await ready();assert.equal(await page.locator('[data-startup-error]').count(),0);
    },async(route,url)=>{if(url.pathname!==failingPath||!failing)return false;await route.abort('failed');return true;});
   });
  }
  for(const [workspace,home] of [['uretim','dashboard'],['eticaret','overview']]){
   await t.test(workspace+' cold offline API state is honest and reconnect retry works',async()=>{
    let offline=true;
    await withPage(async({page,start,ready})=>{
     await page.addInitScript(()=>Object.defineProperty(Navigator.prototype,'onLine',{get:()=>false,configurable:true}));
     await start('/'+workspace+'/#'+home);await page.locator('[data-startup-error]').waitFor();assert.match(await page.locator('[data-startup-error]').innerText(),/İnternet bağlantısı yok/);
     offline=false;await page.evaluate(()=>Object.defineProperty(Navigator.prototype,'onLine',{get:()=>true,configurable:true}));
     await page.locator('[data-startup-error] button').click();await ready();assert.equal(await page.locator('[data-startup-error]').count(),0);
    },async(route,url)=>{if(!offline||url.pathname!=='/api/auth/status')return false;await route.abort('internetdisconnected');return true;});
   });
  }
  for(const [name,file] of [['lots','lot-ui.js'],['barcodes','barcode-ui.js'],['offers','offers-ui.js']]){
   await t.test('production '+name+' delayed import cannot steal production cleanup',async()=>{
    const hold=gate('/'+file);
    await withPage(async({page,start,ready,go,requests})=>{
     await start('/uretim/#dashboard');await ready();await go(name);await hold.seen;
     await page.locator('[data-route-loading]').waitFor();await go('production');await page.locator('[data-production="new"]').waitFor();await rememberRoot(page);
     hold.release();await ready();assert.match(await page.locator('main h1').innerText(),/Üretim/);
     await go('materials');await ready();await assertDisposed(page);
     assert.equal(requests.some(path=>path==='/api/lp/lots'),false,'stale lots view never starts its reads');
    },hold.intercept);
   });
  }
  for(const [workspace,home,first,firstFile,second,secondFile] of [['uretim','dashboard','lots','lot-ui.js','barcodes','barcode-ui.js'],['eticaret','overview','reports','report-inbox-ui.js','orders','orders-ui.js']]){
   await t.test(workspace+' reverse completion preserves the latest view and disposer',async()=>{
    const early=gate('/'+firstFile),late=gate('/'+secondFile);
    await withPage(async({page,start,ready,go})=>{
     await start('/'+workspace+'/#'+home);await ready();await go(first);await early.seen;await go(second);await late.seen;late.release();
     await page.locator('main h1').waitFor();await page.locator('[data-route-loading]').waitFor({state:'detached'});await rememberRoot(page);
     const title=await page.locator('main h1').innerText();early.release();await ready();assert.equal(await page.locator('main h1').innerText(),title);
     await go(home);await ready();await assertDisposed(page);
    },async(route,url)=>await early.intercept(route,url)||await late.intercept(route,url));
   });
   await t.test(workspace+' stale import rejection leaves the current view and busy state intact',async()=>{
    const hold=gate('/'+firstFile);
    await withPage(async({page,start,ready,go})=>{
     await start('/'+workspace+'/#'+home);await ready();await go(first);await hold.seen;await go(second);await page.locator('main h1').waitFor();await page.locator('[data-route-loading]').waitFor({state:'detached'});await rememberRoot(page);
     const title=await page.locator('main h1').innerText();hold.release(true);await ready();assert.equal(await page.locator('main h1').innerText(),title);assert.equal(await page.locator('[data-route-error]').count(),0);assert.notEqual(await page.locator('main').getAttribute('aria-busy'),'true');
     await go(home);await ready();await assertDisposed(page);
    },hold.intercept);
   });
  }
  for(const [workspace,route,file] of [['uretim','lots','lot-ui.js'],['eticaret','reports','report-inbox-ui.js'],['eticaret','documents','pdf-read.js']]){
   await t.test(workspace+' '+route+' failed chunk retries the same deep link',async()=>{
    let failed=false;
    await withPage(async({page,start,ready})=>{
     await start('/'+workspace+'/#'+route);await page.locator('[data-route-error]').waitFor();assert.match(await page.locator('[data-route-error]').innerText(),/yüklenemedi/);
     await page.locator('[data-route-retry]').click();await ready();assert.equal(new URL(page.url()).hash,'#'+route);assert.equal(await page.locator('[data-route-error]').count(),0);
    },async(route,url)=>{if(url.pathname!=='/'+file||failed)return false;failed=true;await route.abort('failed');return true;});
   });
  }
  for(const [workspace,allowed,home] of [['uretim','production','dashboard'],['eticaret','orders','overview']]){
   await t.test(workspace+' reader allowed → denied → home keeps access gates and disposes',()=>withPage(async({page,start,ready,go,requests})=>{
    await start('/'+workspace+'/#'+allowed,'reader');await ready();await rememberRoot(page);
    assert.equal(await page.locator(workspace==='uretim'?'[data-production="new"]':'[data-order="new"]').first().isDisabled(),true);
    await go('settings');await page.locator('.access-denied').waitFor();await assertDisposed(page);assert.equal(requests.includes('/operations-ui.js'),false,'denied route does not download its module');
    await go(home);await ready();await page.locator('.staff-modules').waitFor();
   }));
  }
  await t.test('commerce forwards same-route hash changes without remounting orders',()=>withPage(async({page,start,ready,go,settled})=>{
   await start('/eticaret/#orders');await ready();await rememberRoot(page);
   await go('orders?from=2026-09-01&to=2026-09-19');await settled();
   assert.equal(await page.evaluate(()=>window.__activeRouteRoot===document.querySelector('main')),true);
   assert.equal(await page.evaluate(()=>window.__routeSignals.filter(s=>s.root===window.__activeRouteRoot).some(s=>s.signal.aborted)),false);
   await go('catalog');await ready();await assertDisposed(page);
  }));
  await t.test('real history Back: dirty recipe cancellation preserves the entry and repeated Back can discard',()=>withPage(async({page,start,ready,go})=>{
   await start('/uretim/#products');await ready();await go('recipes');await ready();await rememberRoot(page);
   await page.locator('[data-edit="recipes"]').first().click();await page.locator('.recipe-studio[open]').waitFor();
   const original=await page.locator('.recipe-studio [name="notes"]').inputValue();
   await page.locator('.recipe-studio [name="notes"]').fill('Unsaved history draft');
   await page.goBack();await page.locator('.recipe-discard-confirm[open]').waitFor();
   assert.equal(await page.evaluate(()=>document.querySelector('main')===window.__activeRouteRoot),true);
   await page.locator('[data-studio="continue"]').click();await page.waitForURL('**/#recipes');
   assert.equal(await page.locator('.recipe-studio [name="notes"]').inputValue(),'Unsaved history draft');
   await page.goBack();await page.locator('.recipe-discard-confirm[open]').waitFor();
   assert.equal(new URL(page.url()).hash,'#products','Back still targets the actual previous entry after cancel');
   await page.locator('[data-studio="discard"]').click();await page.locator('main h1').filter({hasText:'Ürün kataloğu'}).waitFor();await ready();
   assert.equal(await page.locator('.recipe-studio,.recipe-discard-confirm').count(),0);
   await page.goForward();await ready();assert.equal(new URL(page.url()).hash,'#recipes');
   await page.locator('[data-edit="recipes"]').first().click();assert.equal(await page.locator('.recipe-studio [name="notes"]').inputValue(),original);
  }));
  await t.test('dirty recipe honors only the latest of two Back requests',()=>withPage(async({page,start,ready,go})=>{
   await start('/uretim/#products');await ready();await go('materials');await ready();await go('recipes');await ready();
   await page.locator('[data-edit="recipes"]').first().click();await page.locator('.recipe-studio [name="notes"]').fill('Latest route decision');
   await page.goBack();await page.locator('.recipe-discard-confirm[open]').waitFor();assert.equal(new URL(page.url()).hash,'#materials');
   await page.goBack();await page.waitForURL('**/#products');assert.equal(await page.locator('.recipe-discard-confirm[open]').count(),1);
   await page.locator('[data-studio="discard"]').click();await page.locator('main h1').filter({hasText:'Ürün kataloğu'}).waitFor();await ready();
   assert.equal(new URL(page.url()).hash,'#products');assert.equal(await page.locator('main h1').innerText(),'Ürün kataloğu');
  }));
  await t.test('two pending hash destinations keep distinct history positions on cancel',()=>withPage(async({page,start,ready,go})=>{
   await start('/uretim/#recipes');await ready();await page.locator('[data-edit="recipes"]').first().click();await page.locator('.recipe-studio [name="notes"]').fill('Preserve route history');
   await go('products');await page.locator('.recipe-discard-confirm[open]').waitFor();await go('materials');
   await page.locator('[data-studio="continue"]').click();await page.waitForURL('**/#recipes');assert.equal(await page.locator('.recipe-studio [name="notes"]').inputValue(),'Preserve route history');
   await page.goForward();await page.waitForURL('**/#products');await page.locator('.recipe-discard-confirm[open]').waitFor();
   await page.locator('[data-studio="discard"]').click();await page.locator('main h1').filter({hasText:'Ürün kataloğu'}).waitFor();await ready();
   await page.goForward();await page.locator('main h1').filter({hasText:'Hammadde kartları'}).waitFor();await ready();assert.equal(new URL(page.url()).hash,'#materials');
  }));
  await t.test('offline and online refresh preserve the recipe host/draft and apply deferred data only after close',()=>withPage(async({page,start,ready,settled})=>{
   await start('/uretim/#recipes');await ready();await rememberRoot(page);await page.locator('[data-edit="recipes"]').first().click();
   const notes=page.locator('.recipe-studio [name="notes"]');await notes.fill('Draft across network changes');
   await page.evaluate(()=>{
    window.savedStudioHost=document.querySelector('#modal-root');
    Object.defineProperty(Navigator.prototype,'onLine',{get:()=>false,configurable:true});window.dispatchEvent(new Event('offline'));
   });
   assert.equal(await page.evaluate(()=>document.querySelector('#modal-root')===window.savedStudioHost),true);assert.equal(await notes.inputValue(),'Draft across network changes');
   assert.equal(await page.locator('.recipe-discard-confirm').count(),0);assert.match(await page.locator('.connection').innerText(),/Çevrimdışı/);
   await page.evaluate(()=>{
    const original=window.fetch;window.fetch=async(input,options)=>{
     const response=await original(input,options);if(new URL(input,location.href).pathname!=='/api/data')return response;
     const body=await response.json(),product=body.products.find(p=>p.id===body.recipes[0].product_id);product.name='Yenilenmiş sentetik reçete ürünü';
     response.json=()=>new Promise(resolve=>{window.releaseOnlineRecipeData=()=>resolve(body);});return response;
    };
    Object.defineProperty(Navigator.prototype,'onLine',{get:()=>true,configurable:true});window.dispatchEvent(new Event('online'));
   });
   await page.waitForFunction(()=>!!window.releaseOnlineRecipeData);await page.evaluate(()=>window.releaseOnlineRecipeData());await settled();
   assert.equal(await page.evaluate(()=>document.querySelector('#modal-root')===window.savedStudioHost&&document.querySelector('main')===window.__activeRouteRoot),true);
   assert.equal(await notes.inputValue(),'Draft across network changes');assert.equal(await page.locator('.recipe-discard-confirm').count(),0);
   assert.match(await page.locator('.connection').innerText(),/Çevrimiçi/);assert.equal(await page.getByRole('heading',{name:'Yenilenmiş sentetik reçete ürünü',exact:true}).count(),0);
   await page.locator('[data-studio="close"]').click();await page.locator('.recipe-discard-confirm[open]').waitFor();await page.locator('[data-studio="discard"]').click();
   await page.getByRole('heading',{name:'Yenilenmiş sentetik reçete ürünü',exact:true}).waitFor();assert.equal(await page.locator('.recipe-studio').count(),0);
  }));
  await t.test('session teardown disposes a pending recipe save and ignores its late callback',async()=>{
   let loggedOut=false;
   await withPage(async({page,start,ready,go,settled})=>{
    await start('/uretim/#products');await ready();await go('recipes');await ready();
    await page.evaluate(async()=>{
     const {openRecipeStudio}=await import('/recipe-studio.js'),data=await fetch('/api/data').then(r=>r.json());window.studioDone=0;
     openRecipeStudio(document.querySelector('#modal-root'),data,data.recipes[0],{user:{owner:true},save:()=>new Promise(resolve=>{window.finishDetachedSave=resolve;}),done:()=>{window.studioDone++;}});
    });
    await page.locator('.recipe-studio [name="notes"]').fill('Pending session draft');await page.locator('.recipe-studio [type="submit"]').click();await page.waitForFunction(()=>!!window.finishDetachedSave);
    await page.goBack();await page.waitForURL('**/#recipes');assert.equal(await page.locator('.recipe-studio[open]').count(),1);assert.equal(await page.locator('.recipe-discard-confirm').count(),0,'busy save refuses departure without a discard decision');
    // An authoritative session end can occur while the native modal makes the header inert.
    await page.locator('[data-action="logout"]').evaluate(button=>button.click());await page.locator('#login-form').waitFor();
    await page.evaluate(()=>window.finishDetachedSave());await settled();assert.equal(await page.evaluate(()=>window.studioDone),0);assert.equal(await page.locator('.recipe-studio,#content').count(),0);
   },async(route,url)=>{if(url.pathname!=='/api/auth/status'||!loggedOut)return false;await route.fulfill({status:200,json:{authenticated:false,initialized:true,user:null}});return true;},async path=>{assert.equal(path,'/api/auth/logout');loggedOut=true;return {ok:true};});
  });
  for(const suppliedAmounts of [false,true]){
   await t.test('production reader labels hidden amounts on products, materials, recipes and calculator'+(suppliedAmounts?' even with supplied values':''),()=>withPage(async({page,start,ready,go})=>{
    await start('/uretim/#products','reader');await ready();const hidden='Tutarları görme yetkin yok';
    const sales=await page.locator('[data-label="Kayıtlı satış"]').allTextContents();assert.ok(sales.length>0);assert.ok(sales.every(value=>value.includes(hidden)));
    await go('materials');await ready();const prices=await page.locator('main tbody tr td:nth-child(3)').allTextContents();assert.ok(prices.length>0);assert.ok(prices.every(value=>value.includes(hidden)&&!value.includes('Bilinmiyor')));
    await go('recipes');await ready();const costs=await page.locator('.recipe-price strong').allTextContents();assert.ok(costs.length>0);assert.ok(costs.every(value=>value===hidden));assert.match(await page.locator('.recipe-card .muted').first().innerText(),/adet üretim/);
    await go('costs');await ready();assert.equal(await page.locator('#calculation').innerText(),hidden);assert.equal(await page.locator('#cost-lines').innerText(),'');
    assert.doesNotMatch(await page.locator('main').innerText(),/987\.654|₺/);
   },async(route,url)=>{
    if(!suppliedAmounts||url.pathname!=='/api/data')return false;
    const response=await route.fetch(),data=await response.json();
    data.products.forEach(p=>{p.sale_price=987654.32;});data.materials.forEach(m=>{m.price=987654.32;});data.recipes.forEach(r=>{for(const key of ['labor','packaging','overhead'])r[key]=987654.32;});
    await route.fulfill({response,json:data});return true;
   }));
  }
  for(const [label,value] of [['missing',null],['zero',0]]){
   await t.test('production owner '+label+' amounts stay distinct from hidden permission',()=>withPage(async({page,start,ready,go})=>{
    await start('/uretim/#recipes');await ready();const prices=await page.locator('.recipe-price strong').allTextContents();assert.ok(prices.length>0);
    if(value===null)assert.ok(prices.every(text=>text==='Bilinmiyor'));else assert.ok(prices.every(text=>text.includes('0,00')));
    await go('costs');await ready();const calculation=await page.locator('#calculation').innerText();assert.doesNotMatch(calculation,/Tutarları görme yetkin yok/);
    if(value===null)assert.match(calculation,/Maliyet için gerekli fiyat bilgisi eksik/);else assert.match(calculation,/0,00/);
   },async(route,url)=>{
    if(url.pathname!=='/api/data')return false;
    const response=await route.fetch(),data=await response.json();data.materials.forEach(m=>{m.price=value;});data.recipes.forEach(r=>{for(const key of ['labor','packaging','overhead'])r[key]=value;});
    await route.fulfill({response,json:data});return true;
   }));
  }
  await t.test('empty recipes expose missing prerequisites and creation focuses recovery links',()=>withPage(async({page,start,ready,go})=>{
   await start('/uretim/#recipes','owner','empty');await ready();const region=page.locator('[data-recipe-prerequisites]');await region.waitFor();
   await page.locator('[data-action="new-recipe"]').first().click();assert.equal(await region.evaluate(el=>el===document.activeElement),true);
   assert.equal(await region.locator('a[href="#products"]').count(),1);assert.equal(await region.locator('a[href="#materials"]').count(),1);
   await region.locator('a[href="#products"]').click();await page.waitForURL('**/#products');await ready();assert.equal(await page.locator('main h1').innerText(),'Ürün kataloğu');
   await go('recipes');await ready();await page.locator('[data-recipe-prerequisites] a[href="#materials"]').click();await page.waitForURL('**/#materials');await ready();assert.equal(await page.locator('main h1').innerText(),'Hammadde kartları');
  }));
  for(const [workspace,routes] of [['uretim',['dashboard','production','products','recipes','costs','materials','materialstock','barcodes','lots','accounts','catalog','ledger','offers','reconciliation','settings','ai']],['eticaret',['overview','performance','orders','reports','pricing','stock','catalog','invoices','documents','sales','reconciliation','ledger','bank','offers','expenses','integrations','settings']]]){
   await t.test(workspace+' all owner routes and fallback mount their existing views',()=>withPage(async({page,start,ready,go})=>{
    await start('/'+workspace+'/#'+routes[0]);await ready();
    for(const route of routes.slice(1)){await go(route);await ready();assert.equal(await page.locator('[data-route-error]').count(),0,route);assert.ok((await page.locator('main').innerText()).length>30,route);}
    await go('unknown-route');await ready();assert.match(await page.locator('main h1').innerText(),workspace==='uretim'?/Üretim masası/:/İşinin özeti/);
   }));
  }
 }finally{await browser.close();}
});
