import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const preview=process.env.OVERVIEW_PREVIEW_URL;
const paths={summary:'/api/ec',connections:'/api/ec/connections',settings:'/api/ec/settings',attention:'/api/ec/attention',panorama:'/api/ec/panorama'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const money=value=>new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(value/100);

// Opt-in, read-only, synthetic preview. The parent owns the server; no installs or live hosts.
test('local browser: overview independent recovery, period state and disposal',{skip:!preview,timeout:240000},async t=>{
 const base=new URL(preview);
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const response=await fetch(new URL('/__preview/health',base));assert.equal(response.status,200);
 const health=await response.json();assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright; do not download dependencies.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const from=days=>new Date(Date.parse(health.today)-(days-1)*86400000).toISOString().slice(0,10);
 const hash=days=>'#overview?channel=hepsiburada&donem='+days+'g&from='+from(days)+'&to='+health.today;
 const withPage=async(run,{scenario='populated',role='owner',width=390,hook,ignoreAbort=false,release}={})=>{
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
  const counts=Object.fromEntries(Object.keys(paths).map(k=>[k,0])),payloads={},errors=[],blocked=[],pending=new Set();
  await context.addInitScript(({ignoreAbort})=>{
   const nativeFetch=window.fetch;window.overviewRequests=[];window.overviewObservers=[];
   window.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.pathname.startsWith('/api/ec')){
     const entry={url:url.href,signal:options?.signal,done:false};window.overviewRequests.push(entry);
     try{return await nativeFetch(input,ignoreAbort?{...options,signal:undefined}:options);}finally{entry.done=true;}
    }
    return nativeFetch(input,options);
   };
   const Observer=window.ResizeObserver;
   window.ResizeObserver=class extends Observer{
    observe(target,options){if(target.matches('[data-pn-chart]')){this.overviewTarget=target;window.overviewObservers.push(this);}return super.observe(target,options);}
    disconnect(){this.overviewDisconnected=true;return super.disconnect();}
   };
  },{ignoreAbort});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==base.origin||!['GET','HEAD'].includes(request.method())){blocked.push(request.method()+' '+url.href);return route.abort();}
   const key=Object.keys(paths).find(k=>paths[k]===url.pathname);
   if(!key)return route.continue();
   counts[key]++;
   const work=(async()=>{
    if(await hook?.({route,url,key,counts,payloads}))return;
    const upstream=await route.fetch();const json=await upstream.json();payloads[key]=json;
    await route.fulfill({response:upstream,json});
   })();pending.add(work);
   try{await work;}finally{pending.delete(work);}
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const start=async()=>{await page.goto(new URL('/__preview/start?scenario='+scenario+'&role='+role+'&next='+encodeURIComponent('/eticaret/'+hash(30)),base).href);};
  const ready=async()=>{await page.locator('[data-panorama][aria-busy="false"]').waitFor();await page.locator('[data-overview-loading]').waitFor({state:'detached'});};
  try{await run({page,start,ready,counts,payloads,context});assert.deepEqual(errors,[],'no browser script errors');assert.deepEqual(blocked,[],'no external requests or mutations');}
  finally{release?.();await Promise.allSettled([...pending]);await context.close();}
 };
 try{
  for(const scenario of ['populated','missing','empty'])for(const failed of Object.keys(paths)){
   await t.test(scenario+' / '+failed+' failure and section-only recovery',async()=>{
    let fail=true;
    await withPage(async({page,start,ready,counts,payloads})=>{
     await start();await ready();
     assert.equal(await page.locator('.overview-heading h1').innerText(),'İşinin özeti');
     assert.equal(await page.locator('.attention-center').count(),1);
     assert.equal(await page.locator('[data-overview-retry="'+failed+'"]').count(),1);
     const retry=page.locator('[data-overview-retry="'+failed+'"]');
     assert.match(await retry.innerText(),/yeniden dene/);
     await retry.scrollIntoViewIfNeeded();
     assert.ok((await retry.boundingBox()).height>=40,'readable retry target');
     assert.equal(await page.locator('[data-panorama] .ins-kpis').count(),failed==='panorama'?0:1);
     if(failed!=='panorama'){
      const p=payloads.panorama.selected_period;
      const cash=p.calculated===0&&(p.packages>0||p.partial)?null:p.calculated_cash_cents??p.cash_cents;
      assert.equal(await page.locator('.ins-kpi-primary>strong').innerText(),cash===null?'Bilgi eksik':money(cash));
     }else assert.doesNotMatch(await page.locator('[data-panorama]').innerText(),/₺|Teslim yok|Bekleyen paket yok/);
     if(failed==='attention'){
      assert.match(await page.locator('.attention-center').innerText(),/İş listesi alınamadı/);
      assert.doesNotMatch(await page.locator('.attention-center').innerText(),/0 başlık|bekleyen iş bulunmadı/);
      assert.equal(await page.locator('.attention-center .attention-item').count(),0);
     }else assert.ok(await page.locator('.attention-center .attention-item').count()>0,'successful daily work survives');
     if(failed==='summary'){
      assert.match(await page.locator('[data-overview-stock]').innerText(),/Stok bilgisi alınamadı/);
      assert.doesNotMatch(await page.locator('[data-overview-stock]').innerText(),/0 kritik|0 ürün/);
      assert.equal(await page.locator('.attention-item[href="#reconciliation"]').count(),0);
     }
     if(failed==='settings'){
      assert.match(await page.locator('[data-overview-setup]').textContent(),/Şirket bilgisi alınamadı/);
      assert.equal(await page.locator('.attention-item[href="#settings"]').count(),0,'unknown settings do not fabricate a setup task');
     }
     if(failed==='connections'){
      assert.match(await page.locator('[data-overview-setup]').textContent(),/kanalların durumu bilinmiyor/);
      assert.equal(await page.locator('.attention-item[href="#integrations"]').count(),0,'unknown channels are not labelled unconfigured or successful');
     }
     await page.evaluate(()=>{window.savedWork=document.querySelector('.attention-center');window.savedKpis=document.querySelector('.ins-kpis');});
     const before={...counts};
     // Repeat one failed retry: the section remains unavailable, and no other endpoint reloads.
     if(scenario==='populated'){
      await retry.click();await ready();
      assert.equal(await retry.count(),1);
      for(const key of Object.keys(paths))assert.equal(counts[key],before[key]+(key===failed?1:0),key+' retry isolation');
     }
     const beforeSuccess={...counts};fail=false;await retry.click();await ready();await page.locator('[data-overview-retry]').waitFor({state:'detached'});
     for(const key of Object.keys(paths))assert.equal(counts[key],beforeSuccess[key]+(key===failed?1:0),key+' successful retry isolation');
     assert.equal(await page.evaluate(()=>window.savedWork===document.querySelector('.ins-work-grid .attention-center')),true,'same daily-work node is composed into panorama');
     if(failed!=='panorama')assert.equal(await page.evaluate(()=>window.savedKpis===document.querySelector('.ins-kpis')),true,'auxiliary retry leaves analytics intact');
     assert.equal(await page.locator('.attention-center').count(),1);assert.equal(await page.locator('.ins-kpis').count(),1);
     const hrefs=await page.locator('.attention-item').evaluateAll(items=>items.map(i=>i.getAttribute('href')));
     assert.equal(hrefs.length,new Set(hrefs).size,'no duplicate work items');
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'local recovery fits mobile viewport');
    },{scenario,hook:async({route,key})=>{if(key===failed&&fail){await route.fulfill({status:503,json:{error:'Sentetik geçici kesinti'}});return true;}}});
   });
  }
  for(const width of [390,1440])await t.test(width+'px / date controls, local choices, history and observer cleanup',()=>withPage(async({page,start,ready,counts})=>{
   await start();await ready();
   await page.locator('[data-product-view="revenue"]').click();await page.locator('[data-panorama-kind]').selectOption('bundle');
   for(const selector of ['.ins-attention-extra','.ins-records-section','.pn-table','.pn-calculation-note','.ins-period-comparison','.ins-date-disclosure','.pn-pending details'])await page.locator(selector).evaluate(el=>{el.open=true;});
   await page.evaluate(()=>{window.savedRoot=document.querySelector('#commerce-content');window.savedWork=document.querySelector('.attention-center');window.savedWorkMarkup=window.savedWork.innerHTML;});
   const before={...counts};
   await page.locator('[data-date-preset="7g"]').click();await page.waitForURL(url=>url.hash.includes('donem=7g'));await ready();
   for(const key of Object.keys(paths))assert.equal(counts[key],before[key]+(key==='panorama'?1:0),key+' date-only refresh');
   assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('channel'),'hepsiburada');
   const preserved=async()=>{
    assert.equal(await page.locator('[data-panorama-kind]').inputValue(),'bundle');
    assert.equal(await page.locator('[data-product-view="revenue"]').getAttribute('aria-selected'),'true');
    for(const selector of ['.ins-attention-extra','.ins-records-section','.pn-table','.pn-calculation-note','.ins-period-comparison','.ins-date-disclosure','.pn-pending details'])assert.equal(await page.locator(selector).evaluate(el=>el.open),true,selector+' remains open');
    assert.equal(await page.evaluate(()=>window.savedRoot===document.querySelector('#commerce-content')&&window.savedWork===document.querySelector('.attention-center')&&window.savedWork.innerHTML===window.savedWorkMarkup),true,'stable root and work DOM');
    assert.equal(await page.evaluate(()=>window.overviewObservers.filter(o=>!o.overviewDisconnected).length),1,'only current chart observer remains');
   };
   await preserved();
   await page.goBack();await page.waitForURL(url=>url.hash.includes('donem=30g'));await ready();await preserved();
   assert.equal(await page.locator('[data-date-form] [name="from"]').inputValue(),from(30));
   await page.goForward();await page.waitForURL(url=>url.hash.includes('donem=7g'));await ready();await preserved();
   assert.equal(await page.locator('[data-date-form] [name="from"]').inputValue(),from(7));
   assert.equal(new URLSearchParams((await page.locator('.pn-period').first().getAttribute('href')).split('?')[1]).get('channel'),'hepsiburada','comparison links retain channel');
   await page.locator('[data-product-view="revenue"]').focus();await page.keyboard.press('ArrowLeft');
   assert.equal(await page.locator('[data-product-view="profit"]').getAttribute('aria-selected'),'true','tab keyboard still works after rerenders');
   await page.evaluate(()=>{location.hash='#stock';});await page.locator('[data-panorama]').waitFor({state:'detached'});
   assert.equal(await page.evaluate(()=>window.overviewObservers.every(o=>o.overviewDisconnected)),true,'leaving the route disconnects every chart observer');
   assert.equal(await page.evaluate(()=>window.overviewRequests.every(r=>r.signal.aborted)),true,'leaving route aborts all owned request signals');
  },{width}));

  await t.test('period failure preserves work and choices; changing date does not retry failed metadata',async()=>{
   let failPeriod=false,failSettings=true;
   await withPage(async({page,start,ready,counts})=>{
    await start();await ready();
    await page.locator('[data-product-view="revenue"]').click();await page.locator('[data-panorama-kind]').selectOption('single');
    await page.locator('.ins-records-section').evaluate(el=>{el.open=true;});
    await page.locator('.ins-attention-extra').evaluate(el=>{el.open=true;});
    await page.evaluate(()=>{window.savedWork=document.querySelector('.attention-center');});
    const before={...counts};failPeriod=true;
    await page.evaluate(value=>{location.hash=value;},hash(7));await page.locator('[data-overview-retry="panorama"]').waitFor();await ready();
    assert.equal(counts.settings,before.settings,'a date change must not silently retry failed metadata');
    assert.equal(await page.locator('[data-overview-retry="settings"]').count(),1);
    assert.equal(await page.locator('.ins-kpis').count(),0,'old amounts are removed while the selected period is unavailable');
    assert.equal(await page.locator('.ins-attention-extra').evaluate(el=>el.open),true);
    await page.locator('.ins-date-disclosure').evaluate(el=>{el.open=true;});
    failPeriod=false;await page.locator('[data-overview-retry="panorama"]').click();await ready();
    assert.equal(await page.locator('[data-product-view="revenue"]').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('[data-panorama-kind]').inputValue(),'single');
    assert.equal(await page.locator('.ins-records-section').evaluate(el=>el.open),true);
    assert.equal(await page.locator('.ins-date-disclosure').evaluate(el=>el.open),true,'date disclosure changed during failure survives retry');
    assert.equal(await page.evaluate(()=>window.savedWork===document.querySelector('.ins-work-grid .attention-center')),true);
    failSettings=false;await page.locator('[data-overview-retry="settings"]').click();await ready();
    assert.equal(counts.panorama,before.panorama+2,'metadata recovery never reloads the recovered period');
   },{hook:async({route,key})=>{if(key==='settings'&&failSettings||key==='panorama'&&failPeriod){await route.fulfill({status:503,json:{error:'Sentetik kesinti'}});return true;}}});
  });

  await t.test('slow metadata does not delay available analytics or daily work',async()=>{
   const gate=deferred(),arrived=deferred();
   await withPage(async({page,start,ready})=>{
    await start();await arrived.promise;await page.locator('.ins-kpis').waitFor();await page.locator('.attention-item').first().waitFor();
    assert.equal(await page.locator('[data-overview-loading="settings"]').count(),1);
    assert.equal(await page.locator('.attention-center .v2-badge.success').count(),0);
    assert.equal(await page.locator('.attention-item[href="#settings"]').count(),0);
    await page.locator('.ins-date-disclosure').evaluate(el=>{el.open=true;});
    await page.evaluate(()=>{window.savedWork=document.querySelector('.attention-center');});
    gate.resolve();await ready();
    assert.equal(await page.evaluate(()=>window.savedWork===document.querySelector('.ins-work-grid .attention-center')),true);
   },{release:()=>gate.resolve(),hook:async({route,key})=>{if(key!=='settings')return;const upstream=await route.fetch();arrived.resolve();await gate.promise;await route.fulfill({response:upstream});return true;}});
  });

  for(const lateFailure of [false,true])await t.test('rapid dates / late '+(lateFailure?'failure':'success')+' cannot replace current result',async()=>{
   const gate=deferred(),arrived=deferred();
   try{await withPage(async({page,start,ready,counts})=>{
    await start();await ready();const before={...counts};
    await page.evaluate(value=>{location.hash=value;},hash(14));await arrived.promise;
    await page.evaluate(value=>{location.hash=value;},hash(7));await page.locator('.ins-kpis').waitFor();await ready();
    const current=await page.locator('[data-panorama]').innerHTML();
    gate.resolve();await page.waitForFunction(()=>window.overviewRequests.every(r=>r.done));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('[data-panorama]').innerHTML(),current,'late response does not replace analytics or add an error');
    assert.equal(await page.locator('[data-date-form] [name="from"]').inputValue(),from(7));
    assert.equal(await page.evaluate(from=>window.overviewRequests.find(r=>r.url.includes('/panorama?')&&new URL(r.url).searchParams.get('from')===from).signal.aborted,from(14)),true);
    for(const key of Object.keys(paths))assert.equal(counts[key],before[key]+(key==='panorama'?2:0),key+' rapid date isolation');
   },{ignoreAbort:true,release:()=>gate.resolve(),hook:async({route,key,url})=>{
    if(key!=='panorama'||url.searchParams.get('from')!==from(14))return;
    const upstream=await route.fetch();arrived.resolve();await gate.promise;
    await route.fulfill(lateFailure?{status:503,json:{error:'Eski dönemin geciken hatası'}}:{response:upstream});return true;
   }});}finally{gate.resolve();}
  });

  await t.test('route disposal ignores late period and auxiliary responses, detached controls are inactive',async()=>{
   const gate=deferred(),arrived=deferred();let holds=0;
   try{await withPage(async({page,start,counts})=>{
    await start();await arrived.promise;
    await page.evaluate(()=>{window.savedRoot=document.querySelector('#commerce-content');location.hash='#stock';});
    await page.locator('[data-panorama]').waitFor({state:'detached'});
    const oldMarkup=await page.evaluate(()=>window.savedRoot.innerHTML);
    gate.resolve();await page.waitForFunction(()=>window.overviewRequests.every(r=>r.done));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.savedRoot.innerHTML),oldMarkup,'late responses cannot mutate disposed DOM');
    assert.equal(await page.evaluate(()=>window.overviewRequests.filter(r=>!r.url.includes('/products')).slice(0,5).every(r=>r.signal.aborted)),true);
    const before=counts.panorama;await page.evaluate(()=>window.savedRoot.querySelector('[data-date-preset="7g"]').click());
    assert.equal(new URL(page.url()).hash,'#stock');assert.equal(counts.panorama,before);
   },{ignoreAbort:true,release:()=>gate.resolve(),hook:async({route,key})=>{
    if(!['settings','panorama'].includes(key))return;
    const upstream=await route.fetch();if(++holds===2)arrived.resolve();await gate.promise;await route.fulfill({response:upstream});return true;
   }});}finally{gate.resolve();}
  });

  for(const scenario of ['populated','missing','empty'])await t.test('reader retains staff home / '+scenario,()=>withPage(async({page,start,counts})=>{
   await start();await page.locator('.staff-modules').waitFor();await page.waitForLoadState('networkidle');
   assert.equal(await page.locator('[data-panorama],.ins-kpis,.attention-center').count(),0);
   assert.deepEqual(counts,Object.fromEntries(Object.keys(paths).map(k=>[k,0])),'no owner-only overview requests');
   await page.evaluate(value=>{location.hash=value;},hash(7));await page.locator('.staff-modules').waitFor();
   assert.deepEqual(counts,Object.fromEntries(Object.keys(paths).map(k=>[k,0])));
  },{role:'reader',scenario}));
 }finally{await browser.close();}
});

// Narrowly selectable follow-up; does not rerun the larger overview matrix.
test('local browser: overview network failures use readable fallback',{skip:!preview,timeout:30000},async()=>{
 const base=new URL(preview);assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');
 assert.equal(base.pathname,'/');assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({serviceWorkers:'block'}),counts={},errors=[],blocked=[];
 let mode='network';
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==base.origin||!['GET','HEAD'].includes(request.method())){blocked.push(url.href);return route.abort();}
  if(Object.values(paths).includes(url.pathname))counts[url.pathname]=(counts[url.pathname]||0)+1;
  if([paths.settings,paths.panorama].includes(url.pathname)){
   if(mode==='network')return route.abort('failed');
   if(mode==='server')return route.fulfill({status:503,json:{error:'Kaynak geçici olarak kullanılamıyor.'}});
  }
  return route.continue();
 });
 try{
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/__preview/start?role=owner&scenario=populated&next='+encodeURIComponent('/eticaret/#overview'),base).href);
  await page.locator('[data-overview-retry="settings"]').waitFor();await page.locator('[data-overview-retry="panorama"]').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-overview-loading]'));
  for(const selector of ['[data-overview-unavailable="settings"]','[data-panorama] .notice']){
   const text=await page.locator(selector).innerText();assert.doesNotMatch(text,/Failed to fetch/);assert.match(text,/Sunucuya ulaşılamadı\. Bağlantını kontrol edip yeniden dene\./);
  }
  assert.ok(await page.locator('.attention-item').count()>0);
  const before={...counts};mode='server';await page.locator('[data-overview-retry="settings"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-overview-unavailable="settings"]')?.textContent.includes('Kaynak geçici olarak kullanılamıyor.'));
  assert.equal(counts[paths.settings],before[paths.settings]+1,'server messages remain intact and retry only their section');
  for(const key of ['summary','connections','attention','panorama'])assert.equal(counts[paths[key]],before[paths[key]]);
  mode='success';await page.locator('[data-overview-retry="settings"]').click();await page.locator('[data-overview-unavailable="settings"]').waitFor({state:'detached'});
  await page.locator('[data-overview-retry="panorama"]').click();await page.locator('.ins-kpis').waitFor();
  assert.equal(await page.locator('[data-overview-retry]').count(),0);assert.equal(await page.locator('.ins-work-grid .attention-center').count(),1);
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 }finally{await context.close();await browser.close();}
});
