import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.UI_FOUNDATION_BROWSER==='1';
test('shared lists release observers, preserve controls and adapt to touch layouts',{skip:!enabled,timeout:120000},async t=>{
 const base=new URL(process.env.UI_FOUNDATION_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const health=await fetch(new URL('/__preview/health',base)).then(r=>r.json());
 assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api);
 const browser=await api.chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',route=>new URL(route.request().url()).origin===base.origin&&['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());
 await page.addInitScript(()=>{
  const Native=window.ResizeObserver;window.__listObservers=[];
  window.ResizeObserver=class extends Native{
   constructor(callback){super(callback);this.tracked={targets:[],disconnected:false};window.__listObservers.push(this.tracked);}
   observe(target,options){this.tracked.targets.push(new WeakRef(target));this.tracked.disconnected=false;return super.observe(target,options);}
   disconnect(){this.tracked.targets=[];this.tracked.disconnected=true;return super.disconnect();}
  };
 });
 const start=path=>page.goto(new URL('/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:path}),base).href);
 try{
  await t.test('leaving tables disconnects their subscriptions',async()=>{
   await start('/uretim/#products');await page.locator('main table[data-list-tools="true"]').first().waitFor();
   for(let n=0;n<5;n++){
    await page.evaluate(()=>location.hash='#dashboard');await page.locator('main h1').waitFor();
    await page.waitForFunction(()=>!window.__listObservers.some(o=>o.targets.some(w=>w.deref()&&!w.deref().isConnected)));
    await page.evaluate(()=>location.hash='#products');await page.locator('main table[data-list-tools="true"]').first().waitFor();
   }
   assert.ok(await page.evaluate(()=>window.__listObservers.filter(o=>o.disconnected).length)>=5);
   assert.equal(await page.evaluate(()=>window.__listObservers.flatMap(o=>o.targets).filter(w=>w.deref()&&!w.deref().isConnected).length),0);
  });
  await t.test('search reset, sorting, detached/reinserted table and opt-outs',async()=>{
   await page.route('**/__ui_list_fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/workspace-design.css"></head><body class="workspace-redesign"><div class="workspace"><main><h1>Liste denemesi</h1><section id="fixture"><div class="table-wrap"><table><thead><tr><th>Ürün</th><th>Tutar</th></tr></thead><tbody>'+Array.from({length:10},(_,i)=>'<tr><td>Ürün '+i+'</td><td>'+(i===9?'Eksik veri':'₺'+i+',00')+'</td></tr>').join('')+'</tbody></table></div></section><table data-list-tools="off"><thead><tr><th>Kapalı</th><th>Alan</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></main></div><script type="module" src="/ui-shell.js"></script></body></html>'}));
   await page.goto(new URL('/__ui_list_fixture',base).href);
   const search=page.locator('#fixture input[type=search]');await search.waitFor();
   await search.fill('bulunmayacak');await page.locator('#fixture .list-empty').waitFor({state:'visible'});
   assert.equal(await page.locator('#fixture tbody tr:not([hidden])').count(),0);
   assert.equal(await page.locator('#fixture .list-count').textContent(),'0 / 10 kayıt');
   await page.locator('#fixture .list-empty button').click();assert.equal(await search.inputValue(),'');
   assert.equal(await page.locator('#fixture tbody tr:not([hidden])').count(),10);
   await page.locator('#fixture .list-sort-select select').selectOption('1:desc');
   assert.equal(await page.locator('#fixture tbody tr').first().locator('td').first().textContent(),'Ürün 8');
   assert.equal(await page.locator('#fixture tbody tr').last().locator('td').first().textContent(),'Ürün 9');
   await page.evaluate(()=>{const old=document.querySelector('#fixture .table-wrap'),next=document.createElement('div');next.className='table-wrap';next.dataset.movedHost='true';old.after(next);next.append(old.querySelector('table'));old.remove();});
   await page.waitForFunction(()=>document.querySelector('[data-moved-host]').previousElementSibling?.classList.contains('list-tools'));
   assert.equal(await page.locator('#fixture .list-tools').count(),1);
   await page.evaluate(()=>{window.__movedTable=document.querySelector('#fixture table');window.__movedTable.remove();});
   await page.waitForFunction(()=>document.querySelectorAll('#fixture .list-tools').length===0);
   await page.evaluate(()=>document.querySelector('#fixture .table-wrap').append(window.__movedTable));
   await search.waitFor();assert.equal(await page.locator('#fixture .list-tools').count(),1);
   assert.equal(await page.locator('#fixture .list-sort').count(),2);
   assert.equal(await page.locator('table[data-list-tools="off"] .list-sort').count(),0);
   await page.locator('#fixture .table-wrap').evaluate(el=>el.style.width='100px');
   await page.waitForFunction(()=>document.querySelector('#fixture table').classList.contains('lt-stack'));
   await page.locator('#fixture .table-wrap').evaluate(el=>el.style.width='100%');
   await page.waitForFunction(()=>!document.querySelector('#fixture table').classList.contains('lt-stack'));
  });
  await t.test('stock, order, report and production filters keep mobile field and button sizes',async()=>{
   for(const width of [360,390,800,1440])for(const path of ['/eticaret/#stock','/eticaret/#orders','/eticaret/#reports','/uretim/#materials']){
    await page.setViewportSize({width,height:1000});await start(path);
    await page.locator('main h1').waitFor();
    await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')!=='true');
    await page.locator(path.includes('#stock')?'[data-ac-form=product-filters],.stock-filters-compact':path.includes('#orders')?'.ol-toolbar':path.includes('#reports')?'main .page-heading':'main .toolbar').first().waitFor();
    const sizes=await page.locator('main .ac-filters :is(input:not([type=checkbox]),select,button),main .ol-toolbar :is(input,select,button),main .list-tools :is(input,select,button)').evaluateAll(nodes=>nodes.filter(n=>n.checkVisibility()).map(n=>({tag:n.tagName,label:n.getAttribute('aria-label')||n.name||n.textContent.trim(),height:n.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize)})));
    if(!path.includes('#reports'))assert.ok(sizes.length>0,path+' must measure mounted filters');
    for(const item of sizes){assert.ok(item.height>=(width<=800?44:38),JSON.stringify({path,width,...item}));if(width<=800&&['INPUT','SELECT'].includes(item.tag))assert.ok(item.font>=16,JSON.stringify({path,width,...item}));}
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' '+width+' horizontal overflow');
   }
  });
  assert.deepEqual(errors,[]);
 }finally{await context.close();await browser.close();}
});
