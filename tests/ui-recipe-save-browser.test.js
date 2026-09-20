import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';
const enabled=process.env.UI_RECIPE_SAVE_BROWSER==='1';
test('recipe saves freeze the submitted draft and restore failed edits',{skip:!enabled,timeout:60000},async t=>{
 const origin='http://127.0.0.1:8791',health=await fetch(origin+'/__preview/health').then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright(),browser=await api.chromium.launch({headless:true,channel:'chrome'});
 try{for(const fail of [false,true])await t.test(fail?'failure restores controls and draft':'success keeps the submitted snapshot immutable',async()=>{
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let release,reached,posts=0,payload;
  const held=new Promise(resolve=>{release=resolve}),sent=new Promise(resolve=>{reached=resolve});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin&&['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
  await context.route('**/api/recipes/*',async r=>{
   if(r.request().method()!=='PUT')return r.fallback();posts++;payload=r.request().postDataJSON();reached();await held;
   return r.fulfill({status:fail?503:200,json:fail?{error:'Deneme kaydı tamamlanamadı.'}:{ok:true}});
  });
  try{
   await page.goto(origin+'/__preview/start?'+new URLSearchParams({role:'owner',scenario:'populated',next:'/uretim/#recipes'}));
   await page.locator('[data-edit=recipes]').first().click();await page.locator('.recipe-studio textarea[name=notes]').fill('GONDERILEN-TASLAK');
   const controls=await page.locator('.recipe-studio :is(input,textarea,select,button)').evaluateAll(nodes=>nodes.map(n=>n.disabled));
   await page.locator('.recipe-studio button[type=submit]').click();await sent;
   assert.equal(payload.notes,'GONDERILEN-TASLAK');assert.equal(posts,1);
   assert.equal(await page.locator('.recipe-studio :is(input,textarea,select,button):not(:disabled)').count(),0);
   await page.keyboard.press('Escape');assert.equal(await page.locator('.recipe-studio').count(),1);
   assert.equal(await page.locator('.recipe-discard-confirm').count(),0);
   release();
   if(fail){
    await page.getByText('Deneme kaydı tamamlanamadı.',{exact:true}).waitFor();
    assert.equal(await page.locator('.recipe-studio textarea[name=notes]').inputValue(),'GONDERILEN-TASLAK');
    assert.deepEqual(await page.locator('.recipe-studio :is(input,textarea,select,button)').evaluateAll(nodes=>nodes.map(n=>n.disabled)),controls);
    await page.locator('.recipe-studio textarea[name=notes]').fill('TEKRAR-DUZENLENDI');await page.keyboard.press('Escape');await page.locator('.recipe-discard-confirm').waitFor();
   }else await page.locator('.recipe-studio').waitFor({state:'detached'});
  }finally{release();await context.close();}
 });}finally{await browser.close();}
});


test('late recipe metadata cannot reopen inputs during save and is applied after failure',{skip:!enabled,timeout:60000},async()=>{
 const origin='http://127.0.0.1:8791',health=await fetch(origin+'/__preview/health').then(r=>r.json());assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright(),browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let release,reached;
 const held=new Promise(resolve=>{release=resolve}),sent=new Promise(resolve=>{reached=resolve});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin&&['GET','HEAD'].includes(r.request().method())?r.continue():r.abort());
 await context.route('**/__recipe-fixture',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="fixture"></div>'}));
 await context.route('**/api/auth/status',async r=>{reached();await held;return r.fulfill({json:{user:{owner:true}}});});
 try{
  await page.goto(origin+'/__recipe-fixture');
  await page.evaluate(async()=>{
   const {openRecipeStudio}=await import('/recipe-studio.js');
   const data={products:[{id:'p1',name:'Saksı'}],recipes:[],materials:[{id:'m1',name:'Hammadde',unit:'kg',price:12,quantity_milli:5000},{id:'m2',name:'İkinci',unit:'kg',price:2,quantity_milli:5000}]};
   openRecipeStudio(document.querySelector('#fixture'),data,{product_id:'p1',yield_qty:1,items:[{material_id:'m1',quantity:1,unit:'kg'}]},{save:payload=>{window.submitted=payload;return new Promise((resolve,reject)=>{window.failSave=()=>reject(Error('Yerel deneme hatası'));});},done:()=>{}});
  });
  await sent;await page.locator('.recipe-studio button[type=submit]').click();
  await page.waitForFunction(()=>!!window.submitted);
  release();await page.waitForResponse(r=>r.url().endsWith('/api/auth/status'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.recipe-studio :is(input,textarea,select,button):not(:disabled)').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.submitted.items.map(i=>i.material_id)),['m1']);
  await page.evaluate(()=>window.failSave());await page.getByText('Yerel deneme hatası',{exact:true}).waitFor();
  assert.equal(await page.locator('.recipe-studio :is(input,textarea,select,button):disabled').count(),0);
  assert.match(await page.locator('[data-library]').innerText(),/12,00/);
  await page.locator('[data-material-choice=m2]').check();assert.equal(await page.locator('[data-ingredient=m2]').count(),1);
 }finally{release();await context.close();await browser.close();}
});
