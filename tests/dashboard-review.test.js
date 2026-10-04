// Independent review regressions. Synthetic in-memory SQLite only; no live/network access.
// Regressions for review findings fixed before the dashboard release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {panoramaApi} from '../src/panorama-api.js';
import {tumSatirlar} from '../src/performance-api.js';
import {scrubAmounts} from '../src/permission-policy.js';
import {dashboardFinancials, dashboardFinancialDay} from '../src/dashboard-summary.js';
import {dashboardKpis, dashboardMoneyFlow, dashboardChannels, dashboardOutcomes, dashboardTrendBuckets, dashboardTrendMarkup} from '../public/dashboard-ui.js';
import {panoramaBuckets, panoramaDetailMarkup, mountPanorama} from '../public/panorama-ui.js';

const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const env = f => ({...f.env, ROOT_DB: f.env.DB, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const overview = (f, from = day(-6), to = today) => panoramaApi(new Request('https://test.local/api/ec/panorama?from=' + from + '&to=' + to), env(f), '/api/panorama');
const report = f => tumSatirlar(env(f), {mode: 'delivered', from: day(-6), to: today, detay: true});
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function setup(f) {
 f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('review-product','Synthetic product','REVIEW','adet'); UPDATE ec_stock_balances SET quantity_milli=100000,value_cents=400000;");
 f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('review-product',1000,0,0,0,0,100,100,100,500,1)");
 for (const channel of ['trendyol', 'hepsiburada']) {
  f.sqlite.prepare('INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)').run(channel,channel,channel,channel);
  f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'review')").run('profile-'+channel,channel,channel,JSON.stringify({fee_amounts_include_vat:true,fee_vat_bps:2000}));
 }
}
function parcel(f, id, date, {channel = 'trendyol', revenue = 10000, cost = 3000, commission = 1000, shipping = 1000, other = 0, order = id} = {}) {
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','review')").run(id,channel,'external-'+id,order,date);
 f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Synthetic listing',1000,?,?,2000)").run('line-'+id,id,'line-external-'+id,revenue,Math.round(revenue*1.2));
 f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,'review-product','sale',1000,?,?,?,?,?,'confirmed',?)").run('sale-'+id,channel,'sale-external-'+id,revenue,cost,commission,shipping,other,date);
 f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,'review-product',1000,10000,?,'adet')").run('component-'+id,'line-'+id,'sale-'+id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date,id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date,id);
}

// R1: The retained channel chart uses legacy daily, which omits uncalculable packages.
test('review R1: an unknown-cash day is not rendered as a known zero in the channel chart table', async () => {
 const f=appFixture(); try {
  setup(f); parcel(f,'unknown-day',day(-1),{cost:0}); parcel(f,'known-day',today);
  const data=await overview(f), p=data.selected_period;
  assert.equal(data.financial_daily.find(r=>r.date===day(-1)).cash_cents,null);
  const label=panoramaBuckets(data.daily,p).buckets.find(b=>b.from===day(-1)).label;
  const legacy=panoramaDetailMarkup(data,p).split('dash-legacy-chart')[1]?.split('data-dashboard-anchor="current"')[0]||'';
  const row=[...legacy.matchAll(/<tr>(.*?)<\/tr>/gs)].map(m=>m[1]).find(s=>s.includes('>'+label+'</td>'));
  assert.ok(!row || /Bilgi eksik|hesaplanabilen|Eksik kapsam/.test(row), 'unknown day currently renders as: '+text(row||''));
 } finally {f.close();}
});

// R2: Gross cost is an estimate even when net cost and all marketplace fees are recorded.
test('review R2: profile-VAT estimates reach period status and the cash record card', async () => {
 const f=appFixture(); try {
  setup(f);parcel(f,'vat-estimate',today);
  const data=await overview(f),p=data.selected_period, row=(await report(f)).rows[0];
  assert.equal(row.cost_gross_cents,3300); assert.equal(row.cost_gross_basis,'current_product_vat');
  assert.equal(row.cost_vat_estimated,true); assert.equal(p.financials.cost.estimated_packages,1);
  const html=panoramaDetailMarkup(data,p),record=html.match(/<a class="ins-record"[^>]*><span class="eyebrow">En çok cebine kalan[\s\S]*?<\/a>/)?.[0]||'';
  assert.deepEqual({status:p.status,recordEstimated:p.records.profit.estimated,label:/tahmin/i.test(record)},
   {status:'estimated',recordEstimated:true,label:true},'profile VAT is estimated, so a cash record cannot be presented as fully recorded');
 } finally {f.close();}
});

// R3: An unknown result cannot establish that losses were zero.
test('review R3: all uncalculable packages do not establish a zero loss total', async () => {
 const f=appFixture(); try {
  setup(f);parcel(f,'unknown-loss',today,{cost:0});
  const p=(await overview(f)).selected_period;
  assert.equal(p.calculated,0);assert.equal(p.missing,1);assert.equal(p.financials.cash.total_cents,null);
  const loss=dashboardOutcomes(p).match(/<div class="dash-loss-detail">([\s\S]*?)<\/div>/)?.[1]||'';
  assert.match(text(loss),/Bilgi eksik|hesaplanamadı|Hesap eksik/,'loss card currently says: '+text(loss));
 } finally {f.close();}
});

// R4: A fallback package ID and a real order number belong to different identity domains.
test('review R4: missing-order fallback cannot merge an unrelated real order with the same identifier', async () => {
 const f=appFixture(); try {
  setup(f);parcel(f,'ORDER-COLLISION',today,{order:'',revenue:10000});
  parcel(f,'other-package',today,{order:'ORDER-COLLISION',revenue:20000});
  const p=(await overview(f)).selected_period;
  assert.equal(p.financials.packages,2);
  assert.deepEqual({orders:p.records.orders,packages:p.records.revenue.package_ids,total:p.records.revenue.revenue_gross_cents},
   {orders:2,packages:['other-package'],total:24000},'fallback package identity must not create an invented split-order record');
 } finally {f.close();}
});

const longDaily=()=>Array.from({length:420},(_,i)=>({date:new Date(Date.parse('2025-01-30')+i*86400000).toISOString().slice(0,10),revenue_cents:300,cost_cents:100,fees_cents:50,cash_cents:150,estimated_packages:1}));
// R5: Monthly grouping must be described by the grouping mode, not first bucket length.
test('review R5a: all-time monthly buckets keep their monthly label after a short first month', () => {
 const daily=longDaily(),p={key:'tum',from:daily[0].date,to:daily.at(-1).date};
 const buckets=dashboardTrendBuckets(daily,p);assert.equal(buckets[0].days,2);assert.equal(buckets[1].days,28);
 const label=dashboardTrendMarkup({financial_daily:daily},p).match(/class="dash-period-size">([^<]+)/)?.[1];
 assert.equal(label,'Aylık','420 daily records are grouped by month, regardless of the first two-day bucket');
});
test('review R5b: multi-year all-time chart rows identify their year', () => {
 const daily=longDaily(),p={key:'tum',from:daily[0].date,to:daily.at(-1).date};
 const buckets=dashboardTrendBuckets(daily,p),html=dashboardTrendMarkup({financial_daily:daily},p);
 const labels=[...html.matchAll(/<td data-label="Dönem">([^<]+)<\/td>/g)].map(m=>m[1]);
 assert.equal(labels.length,buckets.length);
 const ambiguous=buckets.map((b,i)=>({from:b.from,label:labels[i]})).filter(x=>!x.label.includes(x.from.slice(0,4)));
 assert.deepEqual(ambiguous,[],'all-time rows/readouts must distinguish the same month in different years');
});

// Positive controls for the explicit risk areas; failures below should remain isolated.
test('review control: cost gaps preserve independent recorded fees and unknown channel margins', async () => {
 const f=appFixture();try {
  setup(f);parcel(f,'missing-cost',today,{cost:0});const p=(await overview(f)).selected_period;
  assert.equal(p.financials.revenue.total_cents,12000);assert.equal(p.financials.commission.recorded_cents,1200);
  assert.equal(p.financials.shipping.recorded_cents,1200);assert.equal(p.financials.fees.total_cents,2400);
  assert.equal(p.financials.cost.total_cents,null);assert.equal(p.margin_bps,null);
  assert.doesNotMatch(dashboardChannels(p),/%0 kalan/);
  assert.doesNotMatch(dashboardMoneyFlow(p),/viewBox="0 0 600 26"/);
 }finally{f.close();}
});
test('review control: margin uses shared known revenue/cash scope and weights amounts, not package percentages', async () => {
 const f=appFixture();try {
  setup(f);parcel(f,'small',today,{revenue:10000,cost:1000});parcel(f,'large',today,{revenue:90000,cost:80000});parcel(f,'unknown',today,{revenue:50000,cost:0});
  const p=(await overview(f)).selected_period;
  const rows=(await report(f)).rows.filter(r=>Number.isSafeInteger(r.cash_cents)&&Number.isSafeInteger(r.revenue_gross_cents));
  const cash=rows.reduce((n,r)=>n+r.cash_cents,0),revenue=rows.reduce((n,r)=>n+r.revenue_gross_cents,0);
  assert.equal(p.margin_bps,Math.round(cash*10000/revenue));assert.equal(p.margin_packages,2);assert.equal(p.margin_missing,1);
  assert.notEqual(p.margin_bps,Math.round(rows.reduce((n,r)=>n+r.cash_cents/r.revenue_gross_cents,0)/2*10000));
  assert.match(dashboardKpis(p),/1 paket kapsam dışında/);
 }finally{f.close();}
});
test('review control: allocation chart requires exact identity and never invents missing or negative shares', () => {
 const row={channel:'trendyol',revenue_gross_cents:12000,cost_gross_cents:3300,commission_gross_cents:1200,shipping_gross_cents:1200,other_gross_cents:0,withholding_cents:0,cash_cents:6300,cost_gross_basis:'current_product_vat'};
 const period={key:'custom',from:today,to:today};
 const valid=dashboardMoneyFlow({...period,financials:dashboardFinancials([row])});assert.match(valid,/viewBox="0 0 600 26"/);
 for(const change of [{cash_cents:6301},{cash_cents:-1},{cost_gross_cents:null},{shipping_gross_cents:-1}])
  assert.doesNotMatch(dashboardMoneyFlow({...period,financials:dashboardFinancials([{...row,...change}])}),/viewBox="0 0 600 26"/);
});
test('review control: all-time bucket selection covers every source day and marks unread spans unknown', () => {
 const daily=longDaily(),p={key:'tum',from:daily[0].date,to:daily.at(-1).date};
 let buckets=dashboardTrendBuckets(daily,p);
 assert.equal(buckets[0].from,p.from);assert.equal(buckets.at(-1).to,p.to);
 assert.equal(buckets.reduce((n,b)=>n+b.revenue_cents,0),420*300);
 daily[150]=dashboardFinancialDay(daily[150].date,[],{partial:true});buckets=dashboardTrendBuckets(daily,p);
 const gap=buckets.find(b=>b.from<=daily[150].date&&b.to>=daily[150].date);
 assert.equal(gap.cash_cents,null);assert.equal(gap.outflow_cents,null);assert.equal(gap.revenue_cents,null);
});
test('review control: nested financial provenance and shared aliases remain confidential after worker redaction', async () => {
 const f=appFixture();try {
  setup(f);parcel(f,'private-amount',today);const data=await overview(f);
  assert.equal(data.selected_period,data.periods.at(-1));
  const hidden=scrubAmounts(data,{owner:false,permissions:{ec:{performance:'read',amounts:'none'}}},'ec');
  let checked=0;
  const visit=(v,path='$')=>{if(!v||typeof v!=='object')return;for(const[k,item]of Object.entries(v)){
   if(/_cents$|^margin_bps$/.test(k)){assert.equal(item,null,path+'.'+k);checked++;}else visit(item,path+'.'+k);
  }};
  visit(hidden);assert.ok(checked>300);assert.equal(hidden.selected_period,hidden.periods.at(-1));
  assert.equal(hidden.selected_period.financials.packages,1);assert.equal(data.selected_period.financials.cost.total_cents,3300);
  for(const r of hidden.daily)assert.deepEqual([r.trendyol,r.hepsiburada],[null,null]);
 }finally{f.close();}
});

test('review control: overview all-time selection ignores an unrelated selected custom period', async () => {
 const f=appFixture(),previous=Object.getOwnPropertyDescriptor(globalThis,'location');try {
  setup(f);parcel(f,'old-history',day(-100));parcel(f,'recent',today);
  const data=await overview(f,today,today),all=data.periods.find(p=>p.key==='tum');
  assert.equal(data.selected_period.packages,1);assert.equal(all.packages,2);
  Object.defineProperty(globalThis,'location',{configurable:true,value:{hash:'#overview?donem=tum'}});
  const root={innerHTML:'',setAttribute(){},classList:{add(){}},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){},removeEventListener(){}};
  const dispose=mountPanorama(root,data);
  const revenue=root.innerHTML.match(/<article class="ins-kpi"><span>Ciro[\s\S]*?<strong>([^<]+)<\/strong>/)?.[1];
  assert.equal(revenue,'₺240,00','selected overview must use lifetime revenue, not the today-only custom period');
  const trend=root.innerHTML.match(/<section class="dash-card dash-trend"[\s\S]*?<\/section>/)?.[0]||'';
  const buckets=dashboardTrendBuckets(data.financial_daily,all);
  assert.equal([...trend.matchAll(/<td data-label="Dönem">/g)].length,buckets.length);
  assert.equal(buckets[0].from,day(-100));dispose();
 }finally{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;f.close();}
});
