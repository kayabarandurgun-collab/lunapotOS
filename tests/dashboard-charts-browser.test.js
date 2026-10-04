import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {findPlaywright} from '../scripts/design-audit.mjs';
const base=process.env.DASHBOARD_CHARTS_PREVIEW;
const tl=v=>new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(v/100);
test('dashboard browser: authentic summaries, charts, scope, keyboard, mobile and empty data',{skip:!base,timeout:180000},async t=>{
 assert.equal(new URL(base).hostname,'127.0.0.1');
 const health=await (await fetch(base+'/__preview/health')).json();assert.equal(health.synthetic,true);assert.equal(health.network,'blocked');
 const {api}=await findPlaywright(),browser=await api.chromium.launch({headless:true,channel:'chrome'});
 const out=resolve('docs/dashboard-2026-10-04/charts');await mkdir(out,{recursive:true});
 try{
 for(const width of [1440,390,320])await t.test(width+'px populated chart interactions and direct links',async()=>{
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  try{
   await page.goto(base+'/__preview/start?role=owner&scenario=populated&next='+encodeURIComponent('/eticaret/#overview'));
   await page.locator('[data-dash-trend] svg').waitFor();await page.evaluate(()=>document.fonts.ready);
   const response=await context.request.get(base+'/api/ec/panorama'),data=await response.json(),p=data.periods.find(p=>p.key==='30g'),all=data.periods.find(p=>p.key==='tum');
   assert.ok(data.financial_daily.length);
   assert.equal(await page.locator('.ins-kpi').nth(2).locator(':scope > strong').innerText(),tl(p.financials.cost.total_cents));
   const allBefore=await page.locator('[data-lifetime-metric=commission] dd').innerText();assert.equal(allBefore,tl(all.financials.commission.total_cents));
   assert.match(await page.locator('.ins-kpi').nth(2).innerText(),/KDV dahil tahmini/);
   assert.equal(await page.locator('[data-dash-trend] .dash-line').count(),3);
   await page.locator('[data-dash-series=revenue_cents]').click();assert.equal(await page.locator('[data-dash-trend] .dash-line').count(),2);
   await page.locator('[data-dash-series=outflow_cents]').click();await page.locator('[data-dash-series=cash_cents]').click();
   assert.equal(await page.locator('[data-dash-series][aria-pressed=true]').count(),1,'last series cannot be removed');
   await page.locator('[data-dash-series=revenue_cents]').click();await page.locator('[data-dash-series=outflow_cents]').click();
   await page.locator('[data-dash-trend] svg').focus();await page.keyboard.press('Home');const first=await page.locator('[data-dash-readout]').innerText();await page.keyboard.press('End');assert.notEqual(await page.locator('[data-dash-readout]').innerText(),first);
   const hash=new URL(page.url()).hash;await page.locator('[data-dashboard-scroll=money-flow]').first().click();assert.equal(new URL(page.url()).hash,hash);
   await page.locator('.dash-financial-detail > summary').click();assert.match(await page.locator('.dash-financial-detail').innerText(),/Kayıt.*₺/s);
   await page.locator('.ins-date-disclosure').evaluate(el=>el.open=true);await page.locator('[data-date-preset="7g"]').click();await page.waitForURL(/donem=7g/);await page.locator('[data-dash-trend] svg').waitFor();
   assert.equal(await page.locator('[data-lifetime-metric=commission] dd').innerText(),allBefore,'lifetime independent of chosen period');
   const selected=data.periods.find(p=>p.key==='7g');assert.equal(await page.locator('.ins-kpi').nth(2).locator(':scope > strong').innerText(),tl(selected.financials.cost.total_cents));
   await page.locator('.dash-channel').first().click();await page.waitForURL(/#performance/);await page.locator('.ins-report-list').waitFor();
   assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('channel'),'trendyol');assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('from'),selected.from);
   await page.goto(base+'/eticaret/#overview');await page.locator('[data-dash-trend] svg').waitFor();await page.evaluate(()=>document.fonts.ready);
   const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width+1,'no horizontal page overflow');
   await page.screenshot({path:resolve(out,'dashboard-'+width+'.png'),fullPage:true});await page.screenshot({path:resolve(out,'fold-'+width+'.png')});
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 });
 await t.test('empty scope shows recorded zero amounts and no invented chart series',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();
  try{await page.goto(base+'/__preview/start?role=owner&scenario=empty&next='+encodeURIComponent('/eticaret/#overview'));await page.locator('.ins-kpis').waitFor();
   assert.equal(await page.locator('[data-dash-trend] svg').count(),0);assert.match(await page.locator('[data-dash-trend]').innerText(),/satış kaydı yok/);
   assert.equal(await page.locator('[data-lifetime-metric=cost] dd').innerText(),tl(0));
  }finally{await context.close();}
 });
 }finally{await browser.close();}
});
