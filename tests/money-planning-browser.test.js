import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';

const preview=process.env.MONEY_PREVIEW_URL;
test('money browser: responsive dates, drilldowns, read-only permission and route disposal',{skip:!preview,timeout:180000},async t=>{
  const base=new URL(preview);assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
  const health=await (await fetch(new URL('/__preview/health',base))).json();assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
  const {api}=await findPlaywright();assert.ok(api);const browser=await api.chromium.launch({headless:true,channel:'chrome'});
  const out=resolve('docs/system-upgrade-2026-10-04/money-browser');await mkdir(out,{recursive:true});
  async function run(width,role,callback,setup) {
    const context=await browser.newContext({viewport:{width,height:940},serviceWorkers:'block',reducedMotion:'reduce'}),errors=[],blocked=[],requests=[];
    await context.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base.origin || !['GET','HEAD'].includes(request.method())){blocked.push(request.method()+' '+url.pathname);return route.abort();}
      if(/money-calendar|business-result/.test(url.pathname))requests.push(url.pathname+url.search);
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(14000);page.on('pageerror',e=>errors.push(e.message));
    const go=async path=>{await page.goto(new URL('/__preview/start?scenario=populated&role='+role+'&next='+encodeURIComponent(path),base).href);await page.waitForLoadState('networkidle');};
    const fits=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'whole document fits viewport');
    try {await setup?.(context);await callback({page,go,fits,requests,context});assert.deepEqual(errors,[]);assert.deepEqual(blocked,[],'money views do not write business data');}finally{await context.close();}
  }
  try {
    for(const width of [320,390,1440])await t.test(width+'px calendar and result',()=>run(width,'owner',async({page,go,fits,requests})=>{
      await go('/eticaret/#money');await page.locator('.mp-metrics').waitFor();await fits();assert.equal(await page.locator('.mp-notice[role=alert]').count(),0);
      assert.match(await page.locator('.money-planning h1').innerText(),/Ödeme takvimi/);
      await page.locator('[data-money-filter=expected]').click();assert.equal(await page.locator('[data-money-filter=expected]').getAttribute('aria-pressed'),'true');
      const day=page.locator('[data-money-day]:not([disabled])').first();const chosen=await day.getAttribute('data-money-day');await day.click();assert.equal(await page.locator(`[data-money-day="${chosen}"]`).getAttribute('aria-pressed'),'true');
      await page.locator('[data-money-clear-day]').click();await page.locator('[data-money-month="-1"]').click();await page.locator('.mp-metrics').waitFor();
      assert.ok(requests.length>=2,'month navigation performs a fresh scoped read');await page.locator('[data-money-current]').click();await page.locator('.mp-metrics').waitFor();
      await page.screenshot({path:resolve(out,'money-calendar-'+width+'.png'),fullPage:true});
      const detail=page.locator('.mp-event details').first();if(await detail.count()){
        await detail.locator('summary').click();const target=detail.locator('a.mp-link');assert.match(await target.getAttribute('href'),/^#ledger\?/);await target.click();await page.waitForLoadState('networkidle');assert.match(page.url(),/#ledger\?/);
      }
      await go('/eticaret/#business-result');await page.locator('.mp-result-summary').waitFor();await fits();assert.equal(await page.locator('.mp-notice[role=alert]').count(),0);
      assert.match(await page.locator('.money-planning').innerText(),/KDV hariç/);assert.match(await page.locator('.money-planning').innerText(),/net kârı/);
      await page.locator('.mp-source-list').first().locator('summary').click();assert.ok(await page.locator('.mp-source-row').count()>0);
      await page.screenshot({path:resolve(out,'money-result-'+width+'.png'),fullPage:true});
      const source=page.locator('.mp-source-row a.mp-link').first();assert.match(await source.getAttribute('href'),/^#orders\?/);await source.click();await page.waitForLoadState('networkidle');assert.match(page.url(),/#orders\?/);
      await go('/#money');await page.locator('.mp-metrics').waitFor();assert.ok(requests.some(r=>r.startsWith('/api/lp/money-calendar')));await fits();
    }));
    await t.test('staff without amount permission cannot request combined money views',()=>run(390,'reader',async({go,requests,page})=>{
      await go('/eticaret/#money');assert.equal(await page.locator('.mp-metrics').count(),0);await go('/eticaret/#business-result');assert.equal(await page.locator('.mp-result-summary').count(),0);assert.equal(requests.length,0);
    }));
    await t.test('late result cannot replace the next mounted screen',async()=>{
      let release,received;
      const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{received=resolve;});
      await run(390,'owner',async({page})=>{
        await page.goto(new URL('/__preview/start?scenario=populated&role=owner&next='+encodeURIComponent('/eticaret/#money'),base).href);
        await started;await page.locator('.mp-loading').waitFor();
        await page.locator('a[href="#stock"]').first().evaluate(a=>a.click());await page.locator('.money-planning').waitFor({state:'detached'});release();await page.waitForLoadState('networkidle');assert.equal(await page.locator('.money-planning').count(),0);assert.match(page.url(),/#stock/);
      },async context=>{await context.route('**/api/ec/money-calendar?*',async route=>{const response=await route.fetch();received();await gate;try{await route.fulfill({response});}catch{ /* fetch is aborted by the disposer */ }});});
    });
  }finally{await browser.close();}
});

