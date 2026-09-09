import test from 'node:test';
import assert from 'node:assert/strict';
import {priceDecision} from '../src/price-decision.js';
import {decisionTotals,renderDecisionOverview} from '../public/decision-overview.js';
const common={channel:'trendyol',valid_from:'2026-09-01',valid_to:'2026-09-30',price_min_cents:0,price_max_cents:null,vat_bps:0,tax_included:0,source:'Synthetic fixture; not a marketplace tariff'};
const ship={...common,id:'low',carrier:'Test',billable_min_milli:0,billable_max_milli:null,desi_divisor:3000,billable_step_milli:1000,amount_cents:2000};
const input=()=>({profile:{sku:'TORF',category:'Torf',vat_bps:0,replacement_cost_cents:5000,packaging_cents:0,other_cents:0,withholding_bps:0,length_mm:100,width_mm:100,height_mm:100,weight_grams:1000,units_per_parcel:1},shippingRates:[{...ship,price_max_cents:20000},{...ship,id:'high',price_min_cents:20000,amount_cents:5000}],commissionRates:[{...common,id:'commission',sku:'',category:'',rate_bps:1000,base:'gross'}],priceCents:19999,quantity:1,channel:'trendyol',carrier:'Test',date:'2026-09-09',desiredProfitCents:3000,maxPriceCents:100000});
test('Price decision separates break-even and target and exposes a shipping price cliff',()=>{
 const r=priceDecision(input());assert.equal(r.break_even.status,'found');assert.equal(r.floor.status,'found');assert.ok(r.break_even.price_cents<r.floor.price_cents);assert.ok(r.break_even.quote.estimated_profit_cents>=0);assert.ok(r.floor.quote.estimated_profit_cents>=3000);
 assert.equal(priceDecision({...input(),priceCents:r.break_even.price_cents-1}).quote.estimated_profit_cents,-1);
 assert.equal(r.cliffs.length,1);assert.equal(r.cliffs[0].price_cents,20000);assert.ok(r.cliffs[0].profit_drop_cents>2900);
 assert.ok(r.scenarios.some(s=>s.price_cents===19999));assert.ok(r.scenarios.some(s=>s.price_cents===20000));assert.equal(r.tariffs.shipping.id,'low');assert.equal(r.cost_basis,'saved_product_profile');
});
test('Missing, expired, foreign-channel and missing-product prices stay unknown',()=>{
 for(const patch of [{shippingRates:[]},{date:'2026-10-01'},{channel:'hepsiburada'},{profile:undefined}]){
  const r=priceDecision({...input(),...patch});assert.equal(r.quote.status,'incomplete');assert.notEqual(r.break_even.status,'found');assert.notEqual(r.floor.status,'found');assert.deepEqual(r.cliffs,[]);assert.ok(r.scenarios.some(s=>s.price_cents===19999&&s.status==='incomplete'));
 }
});
test('Decision overview never presents a partial sum as completed net profit',()=>{
 const report={rows:[{profit_cents:10000},{profit_cents:-3000}],unallocated_fee_cents:0,channels:[]};
 assert.deepEqual(decisionTotals(report),{profit:10000,loss:3000,net:7000,calculated:2,total:2});
 assert.equal(decisionTotals({...report,rows:[...report.rows,{profit_cents:null}]}).net,null);assert.equal(decisionTotals({...report,unallocated_fee_cents:1}).net,null);assert.equal(decisionTotals({...report,rows:[]}).net,null);
 const html=renderDecisionOverview(report,[{name:'<img onerror=alert(1)>',quantity_milli:1000,reserved_milli:1000,min_stock_milli:0,stock_unit:'adet'}]);assert.ok(html.includes('&lt;img'));assert.ok(html.includes('#performance?mode=pending'));assert.ok(html.includes('1 kritik / tükenen'));
});
