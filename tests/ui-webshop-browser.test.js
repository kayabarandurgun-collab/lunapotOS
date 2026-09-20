import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.UI_WEBSHOP_BROWSER==='1';
test('webshop: request ownership, empty states and keyboard form recovery', {skip:!enabled,timeout:120000}, async t=>{
 const base=new URL(process.env.UI_WEBSHOP_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright and Chrome; never download dependencies.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const run=async(name,action)=>t.test(name,async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
  const errors=[],blocked=[],posts=[];let postHandler;
  await context.route('**/*',async route=>{
   const req=route.request();
   if(new URL(req.url()).origin!==base.origin){blocked.push(req.url());return route.abort();}
   if(!['GET','HEAD'].includes(req.method())){
    posts.push({path:new URL(req.url()).pathname,body:req.postDataJSON()});
    // Test callbacks fulfill writes in this browser only. Never forward them to the shared preview.
    if(postHandler)return postHandler(route,posts.at(-1));
    blocked.push(req.method()+' '+req.url());return route.abort();
   }
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  const loaded=()=>page.locator('#ws-app[aria-busy="false"]').waitFor();
  const start=async(view='orders',scenario='populated',role='owner',width=1440)=>{
   await page.setViewportSize({width,height:900});
   await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario,next:'/webmagaza/#'+view}),base).href);
   await loaded();
  };
  const nav=async view=>{
   if(!await page.locator('.ws-navigation').evaluate(el=>el.open))await page.locator('.ws-navigation > summary').click();
   await page.locator('#ws-nav a[href="#'+view+'"]').click();
  };
  const focused=selector=>page.waitForFunction(s=>document.activeElement?.matches(s),selector);
  const fits=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal document overflow');
  const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  const hold=async(path,{reject=false,query=null}={})=>{
   await page.evaluate(({path,reject,query})=>{
    const nativeFetch=window.fetch;window.__wsHolds??={};
    const state=window.__wsHolds[path]={started:false,ready:false,done:false,aborted:false};
    const gate=new Promise(resolve=>state.release=resolve);
    window.fetch=async(input,options={})=>{
     const url=new URL(typeof input==='string'?input:input.url,location.href);
     if(url.pathname!==path||(query!==null&&url.searchParams.get('q')!==query)||state.started)return nativeFetch(input,options);
     state.started=true;state.hasSignal=!!options.signal;
     options.signal?.addEventListener('abort',()=>state.aborted=true,{once:true});
     // Deliberately ignore abort in this fixture: generation checks must protect against late continuations too.
     const response=await nativeFetch(input,{...options,signal:undefined});state.ready=true;
     await gate;state.done=true;if(reject)throw Error('Late synthetic failure');return response;
    };
   },{path,reject,query});
  };
  const held=path=>page.waitForFunction(p=>window.__wsHolds[p].ready,path);
  const release=async path=>{
   await page.evaluate(p=>window.__wsHolds[p].release(),path);
   await page.waitForFunction(p=>window.__wsHolds[p].done,path);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  try{
   await action({page,start,nav,loaded,focused,fits,json,hold,held,release,posts,mockPost:handler=>postHandler=handler});
   assert.deepEqual(errors,[],'no uncaught browser errors');assert.deepEqual(blocked,[],'no external requests or unmocked writes');
  }finally{await context.close();}
 });
 try{
  for(const reject of [false,true])await run('stale catalog '+(reject?'failure':'success')+' cannot replace customers or clear its loading state',async({page,start,nav,loaded,hold,held,release})=>{
   await start();await hold('/api/webshop/catalog',{reject});await hold('/api/webshop/customers');
   await nav('catalog');await held('/api/webshop/catalog');
   assert.equal(await page.locator('#ws-app [data-order]').count(),0,'old order controls removed while catalog loads');
   await nav('customers');await held('/api/webshop/customers');
   assert.equal(await page.locator('#ws-app h1').innerText(),'Müşteriler');
   await release('/api/webshop/catalog');
   assert.equal(await page.locator('#ws-app').getAttribute('aria-busy'),'true');
   assert.equal(await page.locator('#ws-app h1').innerText(),'Müşteriler');
   assert.equal(await page.locator('#ws-error').isVisible(),false);
   assert.equal(await page.locator('#ws-app').evaluate(el=>el._items),undefined);
   assert.deepEqual(await page.evaluate(()=>({signal:__wsHolds['/api/webshop/catalog'].hasSignal,aborted:__wsHolds['/api/webshop/catalog'].aborted})),{signal:true,aborted:true});
   await release('/api/webshop/customers');await loaded();
   assert.equal(await page.locator('#ws-nav [aria-current]').getAttribute('href'),'#customers');
   assert.ok(await page.locator('#ws-app tbody tr').count()>0);
  });
  await run('same-view older search cannot overwrite a newer submission',async({page,start,nav,loaded,hold,held,release,focused})=>{
   await start();await hold('/api/webshop/orders',{query:'NO-SUCH-SYNTHETIC-ORDER'});
   await page.locator('[name="q"]').fill('NO-SUCH-SYNTHETIC-ORDER');await page.locator('[name="q"]').press('Enter');await held('/api/webshop/orders');
   await nav('customers');await loaded();await nav('orders');await loaded();
   await page.locator('[name="q"]').fill('');await page.locator('[name="q"]').press('Enter');await loaded();await focused('#ws-filter [name="q"]');
   const content=await page.locator('#ws-app').innerText();await release('/api/webshop/orders');
   assert.equal(await page.locator('#ws-app').innerText(),content);assert.equal(await page.locator('#ws-error').isVisible(),false);
  });
  await run('late second readiness read cannot overwrite the current catalog',async({page,start,nav,loaded,hold,held,release})=>{
   await start();await hold('/api/webshop/catalog/readiness');await nav('readiness');await held('/api/webshop/catalog/readiness');
   await nav('catalog');await loaded();const content=await page.locator('#ws-app').innerText();
   await release('/api/webshop/catalog/readiness');assert.equal(await page.locator('#ws-app').innerText(),content);
   assert.equal(await page.locator('#ws-app').evaluate(el=>el._ready),undefined);
  });
  await run('current catalog failure shows an honest empty error, then keyboard retry recovers',async({page,start,nav,loaded,json,focused})=>{
   await start();let fail=true;
   await page.route(base.origin+'/api/webshop/catalog',route=>fail?json(route,{error:'Synthetic catalog unavailable'},503):route.continue());
   await nav('catalog');await loaded();await focused('#ws-error');
   assert.equal(await page.locator('#ws-app h1').innerText(),'Ürünler ve test stoğu');
   assert.match(await page.locator('#ws-app .empty').innerText(),/Kayıtlar yüklenemedi/);
   assert.equal(await page.locator('#ws-app [data-order]').count(),0);
   fail=false;await page.locator('.empty [data-refresh]').focus();await page.keyboard.press('Enter');await loaded();
   assert.ok(await page.locator('[data-product]').count()>0);assert.equal(await page.locator('#ws-error').innerText(),'');await focused('#ws-app');
  });
  for(const width of [360,1440])for(const view of ['orders','customers'])await run(width+'px '+view+' search no-match and keyboard clear restore records',async({page,start,loaded,focused,fits})=>{
   await start(view,'populated','owner',width);const count=await page.locator('#ws-app tbody tr').count();assert.ok(count>0);
   await page.locator('[name="q"]').fill('NO-SUCH-SYNTHETIC-ENTRY');
   if(view==='orders')await page.locator('[name="status"]').selectOption('cancelled');
   await page.locator('[name="q"]').press('Enter');await loaded();
   assert.match(await page.locator('.empty').innerText(),/Bu filtrelerle kayıt bulunamadı/);
   assert.equal(await page.locator('.empty a[href^="/magaza"]').count(),0);
   await focused('#ws-filter [name="q"]');await fits();
   await page.locator('.empty [data-clear-filters]').focus();await page.keyboard.press('Enter');await loaded();await focused('#ws-filter [name="q"]');
   assert.equal(await page.locator('[name="q"]').inputValue(),'');
   if(view==='orders')assert.equal(await page.locator('[name="status"]').inputValue(),'');
   assert.equal(await page.locator('#ws-app tbody tr').count(),count);assert.equal(await page.locator('[data-clear-filters]').count(),0);await fits();
  });
  await run('status-only no-match is distinct from the first-use empty state',async({page,start,loaded,nav,json})=>{
   await start();
   // The preview's pending payment expires after 30 minutes and becomes cancelled.
   // Keep this empty-result UI scenario independent of the shared fixture's age.
   await page.route(base.origin+'/api/webshop/orders?*',route=>{
    const query=new URL(route.request().url()).searchParams;
    if(query.get('status')!=='cancelled')return route.continue();
    assert.equal(query.get('q'),'');return json(route,{orders:[],total:0});
   });
   await page.locator('[name="status"]').selectOption('cancelled');await page.locator('#ws-filter button[type="submit"]').click();await loaded();
   assert.match(await page.locator('.empty').innerText(),/Bu filtrelerle kayıt bulunamadı/);
   await start('orders','empty');assert.match(await page.locator('.empty').innerText(),/Henüz sipariş yok/);assert.equal(await page.locator('[data-clear-filters]').count(),0);
   await page.route(base.origin+'/api/webshop/customers?*',route=>json(route,{customers:[],total:0}));
   await nav('customers');await loaded();assert.match(await page.locator('.empty').innerText(),/Henüz müşteri hesabı yok/);
  });
  await run('empty catalog explains its state without a bare table',async({page,start,json})=>{
   await page.route(base.origin+'/api/webshop/catalog',route=>json(route,{items:[]}));await start('catalog');
   assert.match(await page.locator('.empty').innerText(),/Henüz katalog ürünü yok/);assert.equal(await page.locator('#ws-app table').count(),0);
  });
  await run('mobile navigation, breakpoints and skip link keep visible focus and the selected route',async({page,start,nav,loaded,focused,fits})=>{
   await start('catalog','populated','owner',360);
   await page.locator('.ws-navigation > summary').focus();await page.keyboard.press('Enter');
   await page.locator('#ws-nav a[href="#customers"]').focus();await page.keyboard.press('Enter');await loaded();await focused('#ws-app');
   assert.equal(await page.locator('.ws-navigation').evaluate(el=>el.open),false);
   await page.locator('.ws-skip').focus();await page.keyboard.press('Enter');await focused('#ws-app');
   assert.equal(new URL(page.url()).hash,'#customers');assert.equal(await page.locator('#ws-app h1').innerText(),'Müşteriler');
   await page.setViewportSize({width:1440,height:900});await page.locator('#ws-nav a[href="#customers"]').focus();
   await page.setViewportSize({width:360,height:900});await focused('.ws-navigation > summary');
   await page.setViewportSize({width:1440,height:900});await focused('#ws-nav a[aria-current]');await fits();
  });
  await run('slow order dialog can be dismissed with Escape; its late response cannot reopen it',async({page,start,hold,held,release,focused})=>{
   await start();const opener=page.locator('[data-order]').first(),id=await opener.getAttribute('data-order'),path='/api/webshop/orders/'+id;
   await hold(path);await opener.focus();await page.keyboard.press('Enter');await held(path);
   assert.equal(await page.locator('#ws-dialog').evaluate(el=>el.open),true);
   await page.keyboard.press('Escape');await focused('[data-order="'+id+'"]');await release(path);
   assert.equal(await page.locator('#ws-dialog').evaluate(el=>el.open),false);assert.equal(await page.locator('#ws-error').isVisible(),false);
  });
  await run('mobile product form retains failed edits, prevents duplicate posts and recovers focus after retry',async({page,start,mockPost,json,posts,focused,loaded,fits})=>{
   await start('catalog','populated','owner',360);const opener=page.locator('[data-product]').first(),id=await opener.getAttribute('data-product');
   let fail=true,releasePost;
   mockPost(async(route,request)=>{assert.equal(request.path,'/api/webshop/catalog/'+id);if(fail){await new Promise(resolve=>releasePost=resolve);return json(route,{error:'Synthetic save failure'},503)}return json(route,{ok:true});});
   await opener.focus();await page.keyboard.press('Enter');await page.locator('#ws-product [name="stock"]').fill('23');
   await page.locator('#ws-product [name="stock"]').press('Enter');await page.locator('#ws-product[aria-busy="true"]').waitFor();
   assert.equal(await page.locator('#ws-product button').isDisabled(),true);await page.locator('#ws-product [name="stock"]').press('Enter');
   assert.equal(posts.length,1);assert.equal(posts[0].body.stock,23);assert.ok(releasePost);releasePost();await focused('#ws-dialog-error');
   assert.equal(await page.locator('#ws-product [name="stock"]').inputValue(),'23');assert.equal(await page.locator('#ws-product button').isDisabled(),false);await fits();
   fail=false;await page.locator('#ws-product button').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>!document.querySelector('#ws-dialog').open);await loaded();await focused('[data-product="'+id+'"]');
   assert.equal(posts.length,2);assert.deepEqual(posts[1].body,posts[0].body);assert.equal(await page.locator('#ws-dialog-error').innerText(),'');
  });
  await run('pending save from a dismissed dialog cannot block another view or surface its late failure',async({page,start,mockPost,json,posts,nav,loaded,focused})=>{
   await start('catalog');let releasePost;
   mockPost(async route=>{await new Promise(resolve=>releasePost=resolve);return json(route,{error:'Old save failure'},503)});
   await page.locator('[data-product]').first().click();await page.locator('#ws-product button').click();await page.locator('#ws-product[aria-busy="true"]').waitFor();
   await page.keyboard.press('Escape');await nav('customers');await loaded();await page.locator('[name="q"]').fill('NO-MATCH');await page.locator('[name="q"]').press('Enter');await loaded();
   assert.match(await page.locator('.empty').innerText(),/Bu filtrelerle kayıt bulunamadı/);assert.equal(posts.length,1);assert.ok(releasePost);releasePost();
   await page.waitForResponse(r=>r.request().method()==='POST');await focused('#ws-filter [name="q"]');
   assert.equal(await page.locator('#ws-error').isVisible(),false);assert.equal(await page.locator('#ws-dialog-error').isVisible(),false);
  });
  await run('shipping fields use native validation only for shipping; saved order list refreshes on dialog close',async({page,start,mockPost,json,posts,focused,loaded})=>{
   await start();const opener=page.locator('#ws-app tbody tr').filter({hasText:'Hazırlanıyor'}).locator('[data-order]');
   assert.equal(await opener.count(),1);const id=await opener.getAttribute('data-order');await opener.click();await page.locator('#ws-status').waitFor();
   const carrier=page.locator('#ws-status [name="carrier"]'),tracking=page.locator('#ws-status [name="tracking"]');
   assert.equal(await carrier.evaluate(el=>el.required),true);await page.locator('#ws-status button').click();assert.equal(posts.length,0);await focused('#ws-status [name="carrier"]');
   await page.locator('#ws-status [name="status"]').selectOption('cancelled');assert.equal(await carrier.isDisabled(),true);assert.equal(await tracking.evaluate(el=>el.required),false);
   await page.locator('#ws-status [name="status"]').selectOption('shipped');await carrier.fill('Sentetik Kargo');await tracking.fill('SYNTHETIC-123');
   mockPost((route,request)=>{assert.equal(request.path,'/api/webshop/orders/'+id);return json(route,{ok:true});});
   await tracking.press('Enter');await page.waitForResponse(r=>r.request().method()==='GET'&&r.url()===base.origin+'/api/webshop/orders/'+id);
   assert.deepEqual(posts[0].body,{status:'shipped',carrier:'Sentetik Kargo',tracking:'SYNTHETIC-123'});
   await page.locator('#ws-status').waitFor();await focused('#ws-detail h2');const refreshed=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/webshop/orders');await page.keyboard.press('Escape');await refreshed;await loaded();await focused('[data-order="'+id+'"]');
  });
  for(const [view,kind] of [['contact','contact'],['requests','request']])await run(view+' failed status change restores the previous value; late failures stay in their view',async({page,start,mockPost,json,nav,loaded,focused})=>{
   if(view==='contact')await page.route(base.origin+'/api/webshop/contact?*',route=>json(route,{messages:[{id:'synthetic-contact',status:'open',topic:'Sentetik iletişim',message:'Yalnızca bu tarayıcıda test.',name:'Test',email:'test@example.test',created_at:'2026-09-20'}],total:1}));
   await start(view);const control=page.locator('[data-'+kind+']').first(),id=await control.getAttribute('data-'+kind),previous=await control.inputValue();
   let releasePost;
   mockPost(async(route,request)=>{assert.equal(request.path,'/api/webshop/'+view+'/'+id);await new Promise(resolve=>releasePost=resolve);return json(route,{error:'Synthetic status failure'},503);});
   await control.selectOption(previous==='closed'?'open':'closed');await page.locator('[data-'+kind+'][aria-busy="true"]').waitFor();
   assert.equal(await control.isDisabled(),true);assert.ok(releasePost);releasePost();await focused('#ws-error');
   assert.equal(await control.inputValue(),previous);assert.equal(await control.isDisabled(),false);
   releasePost=null;await control.selectOption(previous==='closed'?'open':'closed');await page.locator('[data-'+kind+'][aria-busy="true"]').waitFor();
   await nav('customers');await loaded();assert.ok(releasePost);const response=page.waitForResponse(r=>r.request().method()==='POST');releasePost();await response;
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.locator('#ws-error').isVisible(),false);assert.equal(await page.locator('#ws-app h1').innerText(),'Müşteriler');
  });
  await run('mapping form keeps component edits after an error and restores its opener after retry',async({page,start,mockPost,json,focused,loaded})=>{
   await start('readiness');const opener=page.locator('[data-map]').first(),id=await opener.getAttribute('data-map');let fail=true;
   mockPost((route,request)=>{assert.equal(request.path,'/api/webshop/catalog/'+id+'/components');assert.ok(Array.isArray(request.body.components));return json(route,fail?{error:'Synthetic mapping failure'}:{ok:true},fail?503:200)});
   await opener.click();await page.locator('#ws-map [name="q0"]').fill('2');await page.locator('#ws-map button').click();await focused('#ws-dialog-error');
   assert.equal(await page.locator('#ws-map [name="q0"]').inputValue(),'2');assert.equal(await page.locator('#ws-map button').isDisabled(),false);
   fail=false;await page.locator('#ws-map button').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#ws-dialog').open);
   await loaded();await focused('[data-map="'+id+'"]');
  });
  // Read fixtures model the result of a successful write entirely in this context.
  // Every POST is still fulfilled by mockPost; no business data reaches the preview.
  const delayedSave=async({page,start,mockPost,json},kind)=>{
   const config={product:{view:'catalog',attribute:'data-product',form:'#ws-product',read:'/api/webshop/catalog'},mapping:{view:'readiness',attribute:'data-map',form:'#ws-map',read:'/api/webshop/catalog/readiness'},status:{view:'orders',attribute:'data-order',form:'#ws-status',read:'/api/webshop/orders'}}[kind];
   let committed=false,id,releasePost,reads=0,quantity=2;
   let posted;const postStarted=new Promise(resolve=>posted=resolve);
   await page.route(base.origin+config.read+(kind==='status'?'?*':''),async route=>{
    reads++;const response=await route.fetch(),body=await response.json();
    if(committed){
     if(kind==='product')body.items.find(item=>item.id===id).stock=31;
     if(kind==='status')body.orders.find(order=>order.id===id).status='cancelled';
     if(kind==='mapping'){const candidate=body.candidates[0];body.items.find(item=>item.id===id).components=[{product_id:candidate.id,product_name:candidate.name,quantity_milli:quantity*1000,revenue_share_bps:10000}];}
    }
    await route.fulfill({response,json:body});
   });
   await start(config.view);
   const opener=kind==='status'?page.locator('#ws-app tbody tr').filter({hasText:'Hazırlanıyor'}).locator('[data-order]'):page.locator('['+config.attribute+']').first();
   id=await opener.getAttribute(config.attribute);
   const selector='['+config.attribute+'="'+id+'"]',row=page.locator('#ws-app tbody tr').filter({has:page.locator(selector)});
   mockPost(async(route,request)=>{
    assert.equal(request.path,kind==='status'?'/api/webshop/orders/'+id:'/api/webshop/catalog/'+id+(kind==='mapping'?'/components':''));
    await new Promise(resolve=>{releasePost=resolve;posted();});committed=true;await json(route,{ok:true});
   });
   const begin=async()=>{
    await opener.click();await page.locator(config.form).waitFor();
    if(kind==='product')await page.locator(config.form+' [name="stock"]').fill('31');
    if(kind==='status')await page.locator(config.form+' [name="status"]').selectOption('cancelled');
    if(kind==='mapping'){const options=await page.locator(config.form+' [name="p0"] option').evaluateAll(options=>options.map(option=>option.value).filter(Boolean));await page.locator(config.form+' [name="p0"]').selectOption(options[0]);await page.locator(config.form+' [name="q0"]').fill(String(quantity));}
    await page.locator(config.form+' button').click();await page.locator(config.form+'[aria-busy="true"]').waitFor();await postStarted;
   };
   const complete=async()=>{const response=page.waitForResponse(response=>response.request().method()==='POST');releasePost();await response;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
   const updated=async()=>{
    await page.waitForFunction(({selector,kind})=>{const cells=document.querySelector(selector)?.closest('tr')?.cells;return cells&&(kind==='product'?cells[2].textContent.trim()==='31':kind==='status'?cells[2].textContent.includes('İptal'):cells[1].textContent.includes('× 2'));},{selector,kind});
   };
   return {...config,id,selector,row,begin,complete,updated,reads:()=>reads};
  };
  for(const kind of ['product','mapping','status'])await run(kind+' delayed successful save after Escape refreshes the affected list',async tools=>{
   const {page,loaded,focused}=tools,save=await delayedSave(tools,kind);await save.begin();
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#ws-dialog').open);const reads=save.reads();
   await save.complete();await save.updated();await loaded();await focused(save.selector);
   assert.equal(save.reads(),reads+1);assert.equal(await page.locator('#ws-dialog').evaluate(dialog=>dialog.open),false);
   assert.equal(await page.locator('#ws-dialog-error').isVisible(),false);
  });
  for(const timing of ['while-away','after-return'])await run('successful product save '+timing+' survives navigation without replacing another view',async tools=>{
   const {page,nav,loaded,focused}=tools,save=await delayedSave(tools,'product');await save.begin();await page.keyboard.press('Escape');
   await nav('customers');await loaded();await page.locator('#ws-filter [name="q"]').fill('Preserve this search draft');await page.locator('#ws-filter [name="q"]').focus();
   if(timing==='while-away'){
    const reads=save.reads();await save.complete();assert.equal(await page.locator('#ws-app h1').innerText(),'Müşteriler');assert.equal(save.reads(),reads);
    assert.equal(await page.locator('#ws-filter [name="q"]').inputValue(),'Preserve this search draft');await focused('#ws-filter [name="q"]');
   }
   await nav('catalog');await loaded();if(timing==='after-return'){assert.equal(await save.row.locator('td').nth(2).innerText(),'24');await save.complete();}
   await save.updated();assert.equal(await page.locator('#ws-nav [aria-current]').getAttribute('href'),'#catalog');
  });
  for(const kind of ['product','mapping','status'])await run(kind+' successful old save preserves a newer dialog and refreshes after it closes',async tools=>{
   const {page,loaded,focused}=tools,save=await delayedSave(tools,kind);await save.begin();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#ws-dialog').open);
   // Cover both a different product and a newly opened form for the same mapping/order.
   const newerSelector=kind==='product'?'[data-product="'+await page.locator('[data-product]').nth(1).getAttribute('data-product')+'"]':save.selector;
   await page.locator(newerSelector).click();await page.locator(save.form).waitFor();
   const field=save.form+(kind==='product'?' [name="stock"]':kind==='mapping'?' [name="q0"]':' [name="carrier"]');
   await page.locator(field).fill(kind==='status'?'Keep newer shipment draft':'9');await page.locator(field).focus();const reads=save.reads();
   await save.complete();assert.equal(save.reads(),reads);assert.equal(await page.locator('#ws-dialog').evaluate(dialog=>dialog.open),true);
   assert.equal(await page.locator(field).inputValue(),kind==='status'?'Keep newer shipment draft':'9');await focused(field);
   await page.keyboard.press('Escape');await save.updated();await loaded();await focused(newerSelector);assert.equal(save.reads(),reads+1);
  });
  await run('a late write during an older catalog read cannot clear its pending refresh',async tools=>{
   const {page,hold,held,release,loaded}=tools,save=await delayedSave(tools,'product');await save.begin();await page.keyboard.press('Escape');
   await hold('/api/webshop/catalog');await page.locator('[data-refresh]').click();await held('/api/webshop/catalog');
   const reads=save.reads();await save.complete();assert.equal(save.reads(),reads);assert.equal(await page.locator('#ws-app').getAttribute('aria-busy'),'true');
   await release('/api/webshop/catalog');await save.updated();await loaded();assert.equal(save.reads(),reads+1);
  });
  await run('reader catalog keeps hidden amounts and has no edit controls',async({page,start})=>{
   await start('catalog','populated','reader');assert.equal(await page.locator('[data-product]').count(),0);assert.match(await page.locator('#ws-app tbody').innerText(),/Yetki kapalı/);
  });
 }finally{await browser.close();}
});
