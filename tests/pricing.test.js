import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {quotePrice,findPriceFloor} from '../public/pricing-math.js';
import {pricingApi} from '../src/pricing-api.js';
import {scopedDB} from '../src/scoped-db.js';
const profile={product_id:'p',sku:'TORF',category:'Torf',vat_bps:2000,replacement_cost_cents:3000,packaging_cents:100,other_cents:0,withholding_bps:100,length_mm:200,width_mm:200,height_mm:200,weight_grams:2000,units_per_parcel:1};
const common={label:'Test tarifesi',channel:'trendyol',valid_from:'2026-09-01',valid_to:'2026-09-30',price_min_cents:0,price_max_cents:null,vat_bps:2000,tax_included:0,source:'Synthetic test only'};
const shipping={...common,id:'s',carrier:'TestKargo',billable_min_milli:0,billable_max_milli:null,desi_divisor:3000,billable_step_milli:1000,amount_cents:1000};
const commission={...common,id:'c',sku:'',category:'',rate_bps:1000,base:'gross'};
const fixture=overrides=>({profile:{...profile},shippingRates:[{...shipping}],commissionRates:[{...commission}],priceCents:12000,quantity:1,channel:'trendyol',carrier:'TestKargo',date:'2026-09-09',...overrides});

test('KDV dahil/hariç tarife aynı net katkıyı verir; stopaj yalnızca hakedişi azaltır',()=>{
 const a=quotePrice(fixture());assert.equal(a.status,'estimated');assert.equal(a.revenue_net_cents,10000);assert.equal(a.commission_net_cents,1200);assert.equal(a.commission_gross_cents,1440);assert.equal(a.shipping_gross_cents,1200);assert.equal(a.estimated_profit_cents,4700);assert.equal(a.withholding_cents,100);assert.equal(a.estimated_payout_cents,9260);assert.equal(a.billable_milli,3000);
 const b=quotePrice(fixture({shippingRates:[{...shipping,amount_cents:1200,tax_included:1}],commissionRates:[{...commission,rate_bps:1200,tax_included:1}]}));
 assert.equal(b.estimated_profit_cents,a.estimated_profit_cents);assert.equal(b.estimated_payout_cents,a.estimated_payout_cents);
 const c=quotePrice(fixture({profile:{...profile,withholding_bps:0}}));assert.equal(c.estimated_profit_cents,a.estimated_profit_cents);assert.equal(c.estimated_payout_cents,a.estimated_payout_cents+100);
 const netBase=quotePrice(fixture({commissionRates:[{...commission,base:'net'}]}));assert.equal(netBase.commission_net_cents,1000);
});
test('Eksik, süresi dolan veya çakışan tarife tahmin üretmez; doğrulanmış sıfır gider geçerlidir',()=>{
 assert.equal(quotePrice(fixture({profile:{...profile,other_cents:null}})).status,'incomplete');
 assert.equal(quotePrice(fixture({date:'2026-10-01'})).status,'incomplete');
 assert.equal(quotePrice(fixture({shippingRates:[]})).status,'incomplete');
 assert.equal(quotePrice(fixture({commissionRates:[commission,{...commission,id:'duplicate'}]})).status,'incomplete');
 assert.equal(quotePrice(fixture({quantity:2})).status,'incomplete');
 const zero=quotePrice(fixture({shippingRates:[{...shipping,amount_cents:0}],commissionRates:[{...commission,rate_bps:0}]}));assert.equal(zero.status,'estimated');assert.equal(zero.shipping_net_cents,0);assert.equal(zero.commission_net_cents,0);
 const specific=quotePrice(fixture({commissionRates:[commission,{...commission,id:'sku',sku:'torf',rate_bps:2000}]}));assert.equal(specific.commission_rate_id,'sku');
});
test('Fiyat baremi sıçramasında bütün aralıklar incelenir; bulunan taban bir kuruş hassasiyetinde doğrulanır',()=>{
 const input=fixture({profile:{...profile,vat_bps:0,replacement_cost_cents:1000,packaging_cents:0},shippingRates:[{...shipping,amount_cents:10000,price_max_cents:5000},{...shipping,id:'discounted',amount_cents:0,price_min_cents:5000}],commissionRates:[{...commission,rate_bps:0}],desiredProfitCents:0,maxPriceCents:20000});
 const floor=findPriceFloor(input);assert.equal(floor.status,'found');assert.equal(floor.price_cents,5000);assert.equal(quotePrice({...input,priceCents:4999}).estimated_profit_cents,-6001);assert.equal(floor.quote.estimated_profit_cents,4000);
 const normal=fixture({desiredProfitCents:1500,maxPriceCents:20000}),f=findPriceFloor(normal);assert.equal(f.status,'found');assert.ok(f.quote.estimated_profit_cents>=1500);assert.ok(quotePrice({...normal,priceCents:f.price_cents-1}).estimated_profit_cents<1500);
 assert.equal(findPriceFloor({...normal,maxPriceCents:100}).status,'impossible');
 const gap=findPriceFloor({...input,shippingRates:[{...shipping,amount_cents:0,price_min_cents:5000}]});assert.equal(gap.status,'incomplete');assert.equal(gap.price_cents,null);assert.equal(gap.candidate_price_cents,5000);
});
test('Taban fiyat parça parça değişen komisyonlarda kuruş taramasıyla aynı; negatif eğim de işlenir',()=>{
 for(let seed=1;seed<=12;seed++){
  const input=fixture({profile:{...profile,vat_bps:seed%3*1000,replacement_cost_cents:seed*7,packaging_cents:0},shippingRates:[{...shipping,amount_cents:seed*2,vat_bps:1000,tax_included:seed%2}],commissionRates:[{...commission,rate_bps:seed*600,price_max_cents:400},{...commission,id:'c2',rate_bps:10000-seed*400,price_min_cents:400}],desiredProfitCents:seed*3,maxPriceCents:1500});
  let expected=null;for(let p=0;p<=1500;p++){if(quotePrice({...input,priceCents:p}).estimated_profit_cents>=input.desiredProfitCents){expected=p;break;}}
  const result=findPriceFloor(input);assert.equal(result.price_cents,expected,'seed '+seed);assert.equal(result.status,expected===null?'impossible':'found');
 }
});
test('Zero-slope impossible tariffs do not scan millions of price cents',()=>{
 const input=fixture({profile:{...profile,replacement_cost_cents:1,packaging_cents:0},shippingRates:[{...shipping,amount_cents:0}],commissionRates:[{...commission,rate_bps:10000,base:'net',tax_included:0}],maxPriceCents:10000000,desiredProfitCents:0});
 assert.equal(findPriceFloor(input).status,'impossible');
});
function database(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0001_initial.sql','0002_accounting.sql','0003_accounting_audit.sql','0004_pricing.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const db={prepare(query){return {values:[],bind(...v){this.values=v;return this;},first(){return sql.prepare(query).get(...this.values)||null;},all(){return {results:sql.prepare(query).all(...this.values)};},run(){return sql.prepare(query).run(...this.values);}};}};
 sql.exec("INSERT INTO products(id,name,sku) VALUES('lp-p','Lunapot','SHARED'); INSERT INTO ec_products(id,name,sku) VALUES('ec-p','E-ticaret','SHARED');");
 return {sql,db};
}
test('Fiyat profilleri ve tarifeleri iki çalışma alanında ayrıdır; arşivler korunur, bozuk veriler reddedilir',async()=>{
 const {sql,db}=database();
 const call=(scope,path,body)=>pricingApi(new Request('https://test.local/api/pricing'+path,{method:body===undefined?'GET':'POST'}),{DB:scopedDB(db,scope),WORKSPACE:scope},'/api/pricing'+path,async()=>body);
 try{
  await call('ec','/profiles',{...profile,product_id:'ec-p'});
  assert.equal((await call('ec','')).profiles.length,1);assert.equal((await call('lp','')).profiles.length,0);
  await assert.rejects(()=>call('lp','/profiles',{...profile,product_id:'ec-p'}),/bulunamadı/);
  await assert.rejects(()=>call('ec','/profiles',{...profile,product_id:'ec-p',vat_bps:null}),/tam sayı/);
  const ship=await call('ec','/shipping',shipping);await call('ec','/commissions',commission);
  assert.equal((await call('lp','')).shippingRates.length,0);
  const estimate=await call('ec','/quote',{product_id:'ec-p',price_cents:12000,channel:'trendyol',carrier:'TestKargo',date:'2026-09-09'});assert.equal(estimate.quote.status,'estimated');
  await call('ec','/shipping/'+ship.id+'/archive',{});await call('ec','/shipping/'+ship.id+'/archive',{});
  assert.equal((await call('ec','')).shippingRates.length,1);assert.ok((await call('ec','')).shippingRates[0].archived_at);
  assert.equal((await call('ec','/quote',{product_id:'ec-p',price_cents:12000,channel:'trendyol',carrier:'TestKargo',date:'2026-09-09'})).quote.status,'incomplete');
  assert.throws(()=>sql.exec('DELETE FROM ec_shipping_rates'),/IMMUTABLE_TARIFF/);
  await assert.rejects(()=>call('ec','/shipping',{...shipping,valid_from:'2026-02-30'}),/Tarih/);
  await assert.rejects(()=>call('ec','/shipping',{...shipping,tax_included:null}),/KDV/);
 }finally{sql.close();}
});
