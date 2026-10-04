import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFinancials} from '../src/dashboard-summary.js';
import {dashboardKpis,dashboardMoneyFlow,dashboardLifetime,dashboardChannels,dashboardTrendBuckets,metricNote,metricAmount} from '../public/dashboard-ui.js';
const period={key:'custom',from:'2026-09-01',to:'2026-09-30',packages:1,calculated:1,profit_ex_vat_cents:10000};
const row={channel:'trendyol',revenue_gross_cents:30000,cost_gross_cents:10000,commission_gross_cents:3000,shipping_gross_cents:5000,other_gross_cents:1000,withholding_cents:-1000,cash_cents:10000,cost_gross_basis:'current_product_vat'};
test('dashboard UI: read failures retain explicit partial label and unknown is distinct from a known zero',()=>{
 const f=dashboardFinancials([row],{partial:true});
 assert.match(metricNote(f.commission),/Kapsam eksik.*hesaplanabilen/);
 assert.equal(metricAmount(f.commission),3000);
 assert.equal(metricAmount({total_cents:null,known_cents:null}),null);
 assert.equal(metricAmount({total_cents:0,known_cents:0}),0);
 assert.equal(metricNote({total_cents:null,known_cents:null,missing_packages:0}),'Bilgi eksik');
 assert.doesNotMatch(dashboardMoneyFlow({...period,financials:f}),/<svg/);
});
test('dashboard UI: expense segments reconcile exactly, loss/refunds and unknown never become clipped positive shares',()=>{
 const p={...period,financials:dashboardFinancials([row])};
 const html=dashboardMoneyFlow(p);
 assert.match(html,/viewBox="0 0 600 26"/);
 const widths=[...html.matchAll(/width="([\d.]+)" height="26"/g)].map(m=>+m[1]);
 assert.equal(widths.reduce((a,b)=>a+b,0),600);
 for(const changed of [{cash_cents:-10000},{cost_gross_cents:null},{other_gross_cents:-100},{cash_cents:9999}])assert.doesNotMatch(dashboardMoneyFlow({...period,financials:dashboardFinancials([{...row,...changed}])}),/viewBox="0 0 600 26"/);
 assert.match(html,/Kayıtlı ve tahmini tutarları ayır/);
 assert.match(html,/alış KDV|Alış KDV/);assert.match(html,/geçmiş fatura toplamı değildir/);
});
test('dashboard UI: lifetime does not copy the selected period and scope stays explicit',()=>{
 const lifetime={...period,key:'tum',from:'2025-01-01',financials:dashboardFinancials([row,row])};
 const html=dashboardLifetime({periods:[{...period,financials:dashboardFinancials([row])},lifetime]});
 assert.match(html,/₺600,00/);assert.match(html,/from=2025-01-01/);assert.match(html,/Üstteki tarih filtresinden bağımsız/);
 const kpis=dashboardKpis({...period,financials:dashboardFinancials([row])});
 assert.match(kpis,/KDV dahil tahmini/);assert.match(kpis,/KDV’si ürün kartındaki oranla tahmini/);
 assert.doesNotMatch(dashboardLifetime({periods:[]}),/₺0,00/);
});
test('dashboard UI: period/channel drilldown preserves date; unknown channel margin is not zero',()=>{
 const html=dashboardChannels({...period,financials:dashboardFinancials([{...row,cost_gross_cents:null,cash_cents:null}])});
 assert.match(html,/from=2026-09-01/);assert.match(html,/channel=trendyol/);assert.match(html,/channel=hepsiburada/);
 assert.match(html,/Marj hesaplanamadı/);assert.doesNotMatch(html,/%0 kalan/);
});
test('dashboard UI: daily, weekly and monthly buckets conserve amounts and propagate missing fees without masking known revenue',()=>{
 const daily=Array.from({length:420},(_,i)=>({date:new Date(Date.parse('2025-01-01')+i*86400000).toISOString().slice(0,10),revenue_cents:300,cost_cents:100,fees_cents:50,cash_cents:150,estimated_packages:1}));
 for(const n of [15,90,420]){
  const rows=daily.slice(0,n),p={from:rows[0].date,to:rows.at(-1).date},b=dashboardTrendBuckets(rows,p);
  assert.equal(b.reduce((s,r)=>s+r.revenue_cents,0),n*300);assert.equal(b.reduce((s,r)=>s+r.outflow_cents,0),n*150);
  assert.equal(b.reduce((s,r)=>s+r.cash_cents,0),n*150);assert.equal(b.reduce((s,r)=>s+r.estimated_packages,0),n);
 }
 daily[0].fees_cents=null;
 const b=dashboardTrendBuckets(daily.slice(0,90),{from:daily[0].date,to:daily[89].date});
 assert.equal(b[0].outflow_cents,null);assert.ok(b[0].revenue_cents>0);
 assert.deepEqual(dashboardTrendBuckets(daily,{from:'2030-01-01',to:'2030-12-31'}),[]);
});
