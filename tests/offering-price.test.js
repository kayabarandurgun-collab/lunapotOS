import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {renderFiyatResult} from '../public/fiyat-hesap-ui.js';
import {soldOffering,iadeOf} from '../public/orders-ui.js';

const date='2026-09-10';
async function fixture(){
 const f=appFixture();await f.setup();let sequence=0;
 f.sqlite.exec(`INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('fees','trendyol','finance','offering-fees',1,'{}','{"fee_amounts_include_vat":true,"fee_vat_bps":2000}','test')`);
 const product=async(name,cost,vat=2000)=>{const p=await f.ok('/ec/products',{name,sku:'SKU-'+(++sequence),stock_unit:'adet',min_stock:0});await f.ok('/ec/stock',{product_id:p.id,quantity:1000,unit_cost:cost/100,kind:'opening',reference:'OPEN-'+p.id,notes:'Synthetic',occurred_on:date});
 f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,?,90000,80000,0,100,100,100,500,1)').run(p.id,vat,cost);return p;};
 const a=await product('Torf',10000,2000),b=await product('Besin',5000,1000);
 const mapping=async(parts,name='Orkide bakım seti')=>f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'SET-'+(++sequence),external_name:name,components:parts});
 const mix=await mapping([{product_id:a.id,quantity_milli:1000,revenue_share_bps:5000},{product_id:b.id,quantity_milli:2000,revenue_share_bps:5000}]);
 const deliver=async(map,quantity=1,{vat=20,fees=true}={})=>{
  const code='ORDER-'+(++sequence);const o=await f.ok('/ec/orders',{channel:'trendyol',external_id:code,occurred_on:date,lines:[{external_id:code+'-L',name:'Gerçek satılan set',mapping_id:map.id,quantity,gross:1000*quantity,vat_rate:vat}]});
  await f.ok('/ec/orders/'+o.id+'/reserve',{});await f.ok('/ec/orders/'+o.id+'/ship',{occurred_on:date,reference:code});await f.ok('/ec/orders/'+o.id+'/deliver',{occurred_on:date});
  const sales=f.sqlite.prepare('SELECT c.sale_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=? ORDER BY c.rowid').all(o.id);
  if(fees)for(const [i,s] of sales.entries())await f.ok('/ec/sales/'+s.sale_id+'/fees',{commission:i===0?100:0,shipping:i===0?50:0,other:i===0?5:0,fees_status:'confirmed'});
  return o;
 };
 const quote=(id=mix.id,extra={})=>f.req('/ec/fiyat-hesap?'+new URLSearchParams({mapping_id:id,channel:'trendyol',qty:1,price:1000,target:50,packaging:10,other:5,...extra}));
 return {...f,a,b,mix,mapping,deliver,quote,product};
}
const computed=d=>d.senaryo||d;

test('mapped set sums each component gross cost, charges parcel expenses once and ignores revenue allocation',async()=>{
 const f=await fixture();try{
  await f.deliver(f.mix,2);
  const r=await f.quote(f.mix.id,{qty:2});assert.equal(r.status,200,JSON.stringify(r.data));const d=r.data;
  assert.equal(d.guven,'tahmini');assert.equal(d.sale_vat_bps,2000);assert.equal(d.kesinti.composition_match,true);
  assert.deepEqual(d.offering.components.map(c=>c.cost_gross_cents),[24000,22000]);assert.equal(d.cost_gross_cents,46000);
  assert.equal(d.fiyatla.maliyet,46000);assert.equal(d.fiyatla.kargo,6000);assert.equal(d.fiyatla.hizmet,600);
  assert.equal(d.fiyatla.paketleme,1000);assert.equal(d.fiyatla.diger,500);
  for(const x of [d.fiyatla,d.basabas,d.hedef])assert.equal(x.cebine,x.fiyat-x.maliyet-x.kargo-x.hizmet-x.komisyon-x.stopaj-x.paketleme-x.diger);
  assert.ok(d.basabas.cebine>=0);assert.ok(d.hedef.cebine>=5000);
  const second=await f.mapping([{product_id:f.a.id,quantity_milli:1000,revenue_share_bps:1},{product_id:f.b.id,quantity_milli:2000,revenue_share_bps:9999}]);await f.deliver(second,2);
  const changed=(await f.quote(second.id,{qty:2})).data;
  assert.deepEqual(changed.fiyatla,d.fiyatla);assert.deepEqual(changed.basabas,d.basabas);assert.deepEqual(changed.hedef,d.hedef);
  assert.equal(JSON.stringify(changed).includes('revenue_share'),false);
 }finally{f.close();}
});

test('mixed set fallback never treats a single-component exact quantity as whole-composition evidence',async()=>{
 const f=await fixture();try{
  const single=await f.mapping([{product_id:f.a.id,quantity_milli:1000,revenue_share_bps:10000}],'Tekli torf');await f.deliver(single);
  const r=(await f.quote(f.mix.id,{sale_vat_rate:20})).data;
  assert.equal(r.kesinti.adet_uyumu,'ayni');assert.equal(r.kesinti.composition_match,false);assert.equal(r.guven,'belirsiz');assert.equal(r.basabas,null);assert.ok(r.senaryo.basabas);assert.match(r.uyari,/setin tamamıyla aynı içerik/);
  assert.equal(r.senaryo.fiyatla.kargo,6000);assert.equal(r.senaryo.fiyatla.hizmet,600);
 }finally{f.close();}
});

test('multipack preserves strict quantity limits and does not multiply one historical shipping charge',async()=>{
 const f=await fixture();try{
  const double=await f.mapping([{product_id:f.a.id,quantity_milli:2000,revenue_share_bps:10000}],'Torf 2’li paket');await f.deliver(double);
  const exact=(await f.quote(double.id)).data;assert.equal(exact.guven,'tahmini');assert.equal(exact.offering.kind,'multipack');assert.equal(exact.fiyatla.maliyet,24000);
  const far=(await f.quote(double.id,{qty:100})).data;assert.equal(far.guven,'belirsiz');assert.equal(far.kesinti.adet_uyumu,'uzak');assert.equal(far.basabas,null);assert.equal(far.senaryo.fiyatla.kargo,6000);assert.equal(far.senaryo.fiyatla.maliyet,2400000);
  for(const qty of [0,101,1.5,-1])assert.equal((await f.quote(double.id,{qty})).status,400);
  const huge=await f.mapping([{product_id:f.a.id,quantity_milli:1000000000,revenue_share_bps:10000}]);assert.equal((await f.quote(huge.id,{qty:2})).status,409);
 }finally{f.close();}
});

test('mixed VAT needs observed sale VAT or an explicit scenario; no confident prices from component VAT',async()=>{
 const f=await fixture();try{
  const single=await f.mapping([{product_id:f.a.id,quantity_milli:1000,revenue_share_bps:10000}]);await f.deliver(single);
  let d=(await f.quote()).data;assert.equal(d.sale_vat_bps,null);assert.equal(d.sale_vat_source,'unknown');assert.equal(d.basabas,null);assert.equal(d.senaryo,null);assert.equal(d.cost_gross_cents,23000);
  d=(await f.quote(f.mix.id,{sale_vat_rate:10})).data;assert.equal(d.sale_vat_bps,1000);assert.equal(d.sale_vat_source,'scenario');assert.equal(d.basabas,null);assert.ok(d.senaryo.basabas);assert.match(d.uyari,/KDV oranı.*senaryodur/);
  await f.deliver(f.mix,1,{vat:20});await f.deliver(f.mix,2,{vat:10});d=(await f.quote()).data;assert.equal(d.sale_vat_bps,null);assert.equal(d.senaryo,null);
  for(const rate of [-1,101,'x',20.001])assert.equal((await f.quote(f.mix.id,{sale_vat_rate:rate})).status,400);
 }finally{f.close();}
});

test('unprovided package expenses are an explicit absent-zero scenario; known zero remains known',async()=>{
 const f=await fixture();try{
  await f.deliver(f.mix);let d=(await f.quote(f.mix.id,{packaging:'',other:''})).data;
  assert.equal(d.guven,'belirsiz');assert.equal(d.gider.paketleme,null);assert.equal(d.gider.diger,null);assert.equal(d.basabas,null);assert.equal(d.senaryo.fiyatla.paketleme,0);assert.match(d.uyari,/0 sayıldı/);
  d=(await f.quote(f.mix.id,{packaging:0,other:0})).data;assert.equal(d.guven,'tahmini');assert.equal(d.fiyatla.paketleme,0);assert.equal(d.fiyatla.diger,0);
 }finally{f.close();}
});

test('unknown component cost, missing fee history and unknown fee VAT remain null rather than free',async()=>{
 const f=await fixture();try{
  let d=(await f.quote(f.mix.id,{sale_vat_rate:20})).data;assert.equal(d.senaryo,null);assert.equal(d.kesinti.kargo,null);
  await f.deliver(f.mix);f.sqlite.prepare('DELETE FROM ec_price_profiles WHERE product_id=?').run(f.b.id);
  d=(await f.quote()).data;assert.equal(d.cost_gross_cents,null);assert.equal(d.offering.components[1].cost_gross_cents,null);assert.equal(d.fiyatla,null);assert.equal(d.senaryo,null);
  f.sqlite.exec('DELETE FROM ec_report_profiles');d=(await f.quote()).data;assert.equal(d.kesinti.kargo,null);assert.equal(d.basabas,null);assert.match(d.uyari,/kesinti KDV/);
 }finally{f.close();}
});

test('posted purchase fallback uses each actual net-plus-tax cost once without needing a price profile',async()=>{
 const f=await fixture();try{
  await f.deliver(f.mix);const supplier=await f.ok('/ec/suppliers',{name:'Supplier',tax_id:'1234567890',contact:''});
  const invoice=await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:'MIX-COST',invoice_date:date,currency:'TRY',lines:[{description:'Besin',invoice_quantity:3,invoice_unit:'adet',product_id:f.b.id,stock_quantity:3,net:99,tax:9.9}]});await f.ok('/ec/invoices/'+invoice.id+'/post',{});
  f.sqlite.prepare('DELETE FROM ec_price_profiles WHERE product_id=?').run(f.b.id);
  const d=(await f.quote()).data,c=d.offering.components[1];assert.equal(c.cost_source,'posted_purchase');assert.equal(c.cost_vat_bps,1000);assert.equal(c.unit_cost_gross_cents,3630);assert.equal(c.cost_gross_cents,7260);assert.equal(d.cost_gross_cents,19260);
 }finally{f.close();}
});

test('options and quotes honor pricing access without catalog access and recursively redact every amount',async()=>{
 const f=await fixture();try{
  await f.deliver(f.mix);
  const staff=await f.ok('/admin/users',{name:'Price reader',username:'price.reader',permissions:{ec:{pricing:'read',amounts:'none'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'synthetic-price-reader'});const login=await f.req('/auth/login',{username:'price.reader',password:'synthetic-price-reader'});
  assert.equal((await f.req('/ec/catalog',undefined,login.cookie)).status,403);
  const options=await f.req('/ec/fiyat-hesap?mode=options',undefined,login.cookie);assert.equal(options.status,200);assert.equal(options.data.offerings[0].id,f.mix.id);assert.equal(options.data.offerings[0].components.length,2);assert.equal(JSON.stringify(options.data).includes('revenue_share'),false);
  const path='/ec/fiyat-hesap?'+new URLSearchParams({mapping_id:f.mix.id,qty:1,packaging:0,other:0,price:1000,target:50});
  const hidden=await f.req(path,undefined,login.cookie);assert.equal(hidden.status,200);assert.equal(hidden.data.cost_gross_cents,null);assert.equal(hidden.data.fiyatla.fiyat,null);assert.equal(hidden.data.fiyatla.cebine,null);assert.equal(hidden.data.kesinti.komisyon_orani,null);
  for(const c of hidden.data.offering.components){assert.equal(c.cost_gross_cents,null);assert.equal(c.unit_cost_gross_cents,null);assert.ok(c.total_quantity_milli>0);}
  const assertHidden=x=>{if(!x||typeof x!=='object')return;for(const [key,value] of Object.entries(x)){if(/_cents$/.test(key))assert.equal(value,null,key);else assertHidden(value);}};assertHidden(hidden.data);
  assert.doesNotMatch(renderFiyatResult(hidden.data),/0,00\s*₺|0,00\s*TL/);
  const denied=await f.ok('/admin/users',{name:'No price',username:'no.price',permissions:{ec:{orders:'read',amounts:'none'},lp:{},delete_records:false}});await f.req('/auth/accept-invite',{token:denied.invite_path.split('invite=')[1],password:'synthetic-no-price'});const no=await f.req('/auth/login',{username:'no.price',password:'synthetic-no-price'});assert.equal((await f.req('/ec/fiyat-hesap?mode=options',undefined,no.cookie)).status,403);
  assert.equal((await f.req('/lp/fiyat-hesap?mode=options')).status,403);
 }finally{f.close();}
});

test('archived mappings, wrong channel and ambiguous selection cannot produce quotes',async()=>{
 const f=await fixture();try{
  assert.equal((await f.quote(f.mix.id,{channel:'hepsiburada'})).status,400);assert.equal((await f.quote(f.mix.id,{product_id:f.a.id})).status,400);
  await f.ok('/ec/catalog/mappings/'+f.mix.id+'/archive',{});assert.equal((await f.quote()).status,404);assert.equal((await f.req('/ec/fiyat-hesap?mode=options')).data.offerings.length,0);
 }finally{f.close();}
});

test('offering identity uses actual component-to-sold-unit ratios, preserves sold names and does not fabricate sets',()=>{
 const line={id:'line',name:'İlan',quantity_milli:2000};
 const parts=[{line_id:'line',product_id:'a',product_name:'Besin',stock_unit:'adet',quantity_milli:8000}];
 let o=soldOffering(line,parts);assert.equal(o.kind,'multipack');assert.equal(o.label,'4 adetlik paket');assert.equal(o.name,'4 adet Besin');
 o=soldOffering({...line,name:'Orkide üçlüsü'},[{...parts[0],quantity_milli:2000}]);assert.equal(o.kind,'single');assert.equal(o.name,'Orkide üçlüsü');assert.equal(o.label,'Tekli ürün');
 o=soldOffering({...line,name:'Bakım seti'},[...parts,{line_id:'line',product_id:'b',product_name:'Torf',stock_unit:'adet',quantity_milli:2000}]);assert.equal(o.kind,'bundle');assert.equal(o.name,'Bakım seti');
 assert.equal(soldOffering({...line,name:'3’lü set'},[]).kind,'unknown');
});

test('partial return is classified per original sale instead of adding unlike component quantities',()=>{
 const sale=[{id:'a',kind:'sale',quantity_milli:1000},{id:'b',kind:'sale',quantity_milli:10000}];
 assert.equal(iadeOf([...sale,{kind:'return',parent_id:'b',quantity_milli:10000}]),'kismi');
 assert.equal(iadeOf([...sale,{kind:'return',parent_id:'b',quantity_milli:10000},{kind:'return',parent_id:'a',quantity_milli:1000}]),'tam');
 assert.equal(iadeOf([...sale,{kind:'return',parent_id:'not-in-order',quantity_milli:100000}]),null);
});
