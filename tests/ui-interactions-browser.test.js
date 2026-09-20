import test from 'node:test';
import assert from 'node:assert/strict';
import {findPlaywright} from '../scripts/design-audit.mjs';

const enabled=process.env.UI_INTERACTIONS_BROWSER==='1';
// Opt-in only; no form submission, real accounts, external requests or business writes.
test('keyboard interactions: mobile drawer, responsive focus, skip link and native dialogs', {skip:!enabled,timeout:120000}, async t=>{
 const base=new URL(process.env.UI_INTERACTIONS_PREVIEW||'http://127.0.0.1:8791');
 assert.equal(base.protocol,'http:');assert.equal(base.hostname,'127.0.0.1');assert.equal(base.pathname,'/');
 assert.equal(base.username+base.password+base.search+base.hash,'');
 const health=await fetch(new URL('/__preview/health',base),{redirect:'error',signal:AbortSignal.timeout(10000)}).then(r=>r.json());
 assert.equal(health.local_preview,true);assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright();assert.ok(api,'Use installed Playwright and Chrome; do not download dependencies.');
 const browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});
 const blocked=[],errors=[];
 await context.route('**/*',route=>{
  const request=route.request();
  if(new URL(request.url()).origin!==base.origin||!['GET','HEAD'].includes(request.method())){
   blocked.push(request.method()+' '+request.url());return route.abort();
  }
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 page.setDefaultTimeout(6000);
 const header='#commerce-menu,[data-action="menu"]',dock='[data-dock-menu]',close='[data-workspace-close]';
 const focused=selector=>page.waitForFunction(selector=>document.activeElement?.matches(selector),selector);
 const start=async(path='/eticaret/#stock',width=390,role='owner',scenario='populated')=>{
  await page.setViewportSize({width,height:844});
  await page.goto(new URL('/__preview/start?'+new URLSearchParams({role,scenario,next:path}),base).href);
  await page.locator('#sidebar .workspace-identity').waitFor({state:'attached'});
  await page.waitForFunction(()=>document.querySelector('main')?.tabIndex===-1&&document.querySelector('[data-dock-menu]')?.hasAttribute('aria-expanded'));
 };
 const open=async selector=>{
  await page.locator(selector).focus();await page.keyboard.press('Enter');await focused(close);
  assert.equal(await page.locator(header).getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator(dock).getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator(dock).getAttribute('aria-controls'),'sidebar');
 };
 try{
  for(const width of [360,390,800])for(const path of ['/eticaret/#stock','/uretim/#materials'])await t.test(width+'px '+path+' menu focus and navigation',async()=>{
   await start(path,width);
   assert.equal(await page.locator('#sidebar').evaluate(s=>s.inert),true);
   await page.locator(header).focus();
   await page.locator('#sidebar a').first().evaluate(a=>a.focus());await focused(header);
   for(let n=0;n<8;n++){
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#sidebar')),false,'closed menu must not receive Tab focus');
   }
   await open(header);
   // Real tab boundaries: the account link is the final exposed sidebar control.
   await page.locator('#sidebar .workspace-identity').focus();await page.keyboard.press('Tab');await focused(close);
   await page.keyboard.press('Shift+Tab');await focused('#sidebar .workspace-identity');
   await page.keyboard.press('Escape');await focused(header);
   assert.equal(await page.locator('#sidebar').evaluate(s=>s.inert),true);
   assert.equal(await page.locator('.ui-menu-shade').isVisible(),false);
   await open(dock);await page.keyboard.press('Escape');await focused(dock);
   await open(dock);await page.locator(close).click();await focused(dock);
   await open(dock);await page.locator('.ui-menu-shade').click({position:{x:width-8,y:400}});await focused(dock);
   await open(header);
   await page.locator(path.startsWith('/eticaret')?'#sidebar a[href="#overview"]':'#sidebar a.nav-link[href="#dashboard"]').click();
   await focused('main');
   await page.waitForFunction(()=>document.querySelector('#sidebar')?.inert===true);
   assert.equal(await page.locator(header).getAttribute('aria-expanded'),'false');
  });
  for(const [role,scenario] of [['reader','populated'],['owner','missing'],['owner','empty']])await t.test(role+' / '+scenario+' drawer',async()=>{
   await start('/eticaret/#stock',390,role,scenario);await open(dock);await page.keyboard.press('Escape');await focused(dock);
  });
  await t.test('hidden, disabled and negative-tabindex descendants do not break the loop',async()=>{
   await start();await open(header);
   // Deliberate DOM-only fixtures exercise CSS-hidden and disabled controls without changing app data.
   await page.locator('#sidebar').evaluate(s=>{
    s.insertAdjacentHTML('beforeend','<div data-keyboard-fixture><button data-hidden-fixture>Hidden by CSS</button><div hidden><a href="#stock">Hidden parent</a></div><fieldset disabled><button>Disabled by fieldset</button></fieldset><a tabindex="-1" href="#stock">Not a tab stop</a></div>');
    s.querySelector('[data-hidden-fixture]').style.visibility='hidden';
   });
   await page.locator('#sidebar .workspace-identity').focus();await page.keyboard.press('Tab');await focused(close);
   await page.keyboard.press('Shift+Tab');await focused('#sidebar .workspace-identity');
   await page.locator('[data-keyboard-fixture]').evaluate(el=>el.remove());await page.keyboard.press('Escape');await focused(header);
  });
  await t.test('breakpoint changes leave focus visible and release the desktop menu',async()=>{
   await start();await open(header);await page.setViewportSize({width:801,height:900});
   await page.waitForFunction(()=>!document.querySelector('#sidebar').inert&&!document.body.classList.contains('ui-menu-open'));
   assert.equal(await page.evaluate(()=>document.activeElement.checkVisibility({visibilityProperty:true})),true);
   await page.locator('#sidebar .workspace-identity').focus();await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#sidebar')),false,'desktop navigation is not trapped');
   await page.locator('#sidebar .workspace-identity').focus();await page.setViewportSize({width:800,height:844});await focused(header);
   assert.equal(await page.locator('#sidebar').evaluate(s=>s.inert),true);
  });
  await t.test('desktop skip link focuses the main landmark',async()=>{
   await start('/eticaret/#stock',1440);await page.locator('.ui-skip-link').focus();await page.keyboard.press('Enter');await focused('main');
   assert.equal(await page.locator('#sidebar').evaluate(s=>s.inert),false);
  });
  for(const width of [390,1440])await t.test(width+'px existing native dialogs retain names, Escape and focus return',async()=>{
   for(const [path,opener] of [
    ['/eticaret/#stock','[data-ac="product"]'],
    ['/eticaret/#stock','[data-ac="stock"]'],
    ['/uretim/#materials','[data-action="new-material"]'],
    ['/uretim/#recipes','[data-action="new-recipe"]'],
    ['/eticaret/#stock','[data-quick-nav]'],
    ['/eticaret/#stock','.workspace-switch']
   ]){
    await start(path,width);await page.locator(opener).focus();await page.keyboard.press('Enter');
    const dialog=page.locator('dialog[open]');await dialog.waitFor();
    const semantics=await dialog.evaluate(d=>({modal:d.matches(':modal'),ownsFocus:d.contains(document.activeElement),label:d.getAttribute('aria-label'),names:(d.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>{const h=document.getElementById(id);return {text:h?.textContent.trim(),visible:!!h?.checkVisibility({visibilityProperty:true})};})}));
    assert.equal(semantics.modal,true);assert.equal(semantics.ownsFocus,true);
    assert.ok(semantics.label||semantics.names.length>0,'dialog has an accessible name');
    for(const name of semantics.names){assert.ok(name.text);assert.equal(name.visible,true,'label references visible content');}
    // Native modal behavior may cycle via browser chrome; underlying app controls remain inert.
    await page.locator(opener).evaluate(b=>b.focus());assert.equal(await dialog.evaluate(d=>d.contains(document.activeElement)),true);
    await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement===document.body||!!document.activeElement.closest('dialog[open]')));
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await focused(opener);
   }
  });
  await t.test('a native quick-navigation dialog owns focus above the open mobile drawer',async()=>{
   await start();await open(dock);await page.keyboard.press('Control+k');
   await page.locator('dialog[open] input').waitFor();await focused('dialog[open] input');
   await page.keyboard.press('Tab');assert.equal(await page.locator('dialog[open]').evaluate(d=>d.contains(document.activeElement)),true);
   await page.keyboard.press('Escape');await focused(close);
   assert.equal(await page.locator(header).getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');await focused(dock);
  });
  assert.deepEqual(errors,[],'no page script errors');assert.deepEqual(blocked,[],'no external or write requests attempted');
 }finally{await context.close();await browser.close();}
});
