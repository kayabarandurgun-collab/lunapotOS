import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {scopedDB} from '../src/scoped-db.js';
import {ordersApi} from '../src/orders-api.js';
import {catalogApi} from '../src/catalog-api.js';
import {pricingApi} from '../src/pricing-api.js';
import {accountingApi} from '../src/accounting.js';
import {orderEstimateApi} from '../src/order-estimate-api.js';
const date='2026-09-09';
const dimensions={category:'',carrier:'Kargo',date,length_mm:300,width_mm:300,height_mm:300,weight_grams:2000,packaging_cents:500,other_cents:200,withholding_bps:0,desired_profit_cents:5000};
async function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let queries=0;const raw={prepare(query){return {args:[],bind(...a){this.args=a;return this;},first(){queries++;return sql.prepare(query).get(...this.args)||null;},all(){queries++;return {results:sql.prepare(query).all(...this.args)};},run(){queries++;return sql.prepare(query).run(...this.args);}};},async batch(items){sql.exec('BEGIN');try{const result=items.map(x=>x.all());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:scopedDB(raw,'ec'),ROOT_DB:raw,WORKSPACE:'ec'};
 const invoke=(handler,path,body,custom=env)=>handler(new Request('https://test.local'+path,{method:body===undefined?'GET':'POST'}),custom,path,async()=>body);
 const order=(path='',body)=>invoke(ordersApi,'/api/orders'+path,body),pricing=(path,body)=>invoke(pricingApi,'/api/pricing'+path,body),ac=(path,body)=>invoke(accountingApi,'/api/accounting'+path,body);
 const a=(await ac('/products',{name:'Gerçek A',sku:'REAL-A',stock_unit:'adet',min_stock:0})).id,b=(await ac('/products',{name:'Gerçek B',sku:'REAL-B',stock_unit:'adet',min_stock:0})).id;
 for(const [p,cost] of [[a,10],[b,20]])await ac('/stock',{product_id:p,kind:'opening',reference:'OPEN-'+p,quantity:10,unit_cost:cost,occurred_on:date,notes:'Test açılışı'});
 await invoke(catalogApi,'/api/catalog/mappings',{source:'trendyol',external_code:'EXTERNAL-SET',external_name:'2 A + 1 B seti',source_unit:'',components:[{product_id:a,quantity_milli:2000,revenue_share_bps:5000},{product_id:b,quantity_milli:1000,revenue_share_bps:5000}]});
 const common={label:'Test tarifesi',channel:'trendyol',valid_from:'2026-01-01',valid_to:'2026-12-31',price_min_cents:0,price_max_cents:null,vat_bps:2000,tax_included:false,source:'Test sözleşmesi'};
 const ship=await pricing('/shipping',{...common,carrier:'Kargo',billable_min_milli:0,billable_max_milli:null,desi_divisor:3000,billable_step_milli:1000,amount_cents:3000});
 const commission=await pricing('/commissions',{...common,sku:'EXTERNAL-SET',category:'',rate_bps:1000,base:'gross'});
 await pricing('/commissions',{...common,sku:'REAL-A',category:'',rate_bps:8000,base:'gross'});await pricing('/commissions',{...common,sku:'',category:'',rate_bps:5000,base:'gross'});
 const line={external_id:'LINE',sku:'EXTERNAL-SET',name:'Satıştaki set adı',quantity:2,gross:360,vat_rate:20};
 const create=(external='PKG',lines=[line])=>order('',{channel:'trendyol',external_id:external,occurred_on:date,lines});
 const estimate=(id,body=dimensions,custom=env)=>invoke(orderEstimateApi,'/api/orders/'+id+'/estimate',body,custom);
 return {sql,env,invoke,order,ac,create,estimate,a,b,ship,commission,line,reset(){queries=0;},queries:()=>queries,close:()=>sql.close()};
}
test('Bundle estimate uses 2A+1B twice, charges one shipment and external SKU commission with a verified package floor',async()=>{
 const f=await fixture();try{
  const p=await f.create();f.reset();const result=await f.estimate(p.id),q=result.quote;assert.equal(q.status,'estimated');assert.equal(result.cost_basis,'current_weighted_average');assert.equal(q.revenue_net_cents,30000);assert.equal(q.cost_net_cents,8000);assert.equal(q.shipping_net_cents,3000);assert.equal(q.shipping_rate_id,f.ship.id);assert.equal(q.commission_net_cents,3600);assert.equal(q.commission_rate_id,f.commission.id);assert.equal(q.estimated_profit_cents,14700);assert.equal(q.estimated_payout_cents,28080);assert.equal(result.floor.status,'found');assert.ok(f.queries()<=8,'bounded server request leaves ample authentication headroom');
  let expected=0;while(Math.round(expected/1.2)-Math.round(expected*.1)-11700<5000)expected++;assert.equal(result.floor.price_cents,expected);assert.ok(result.floor.quote.estimated_profit_cents>=5000);assert.ok(Math.round((expected-1)/1.2)-Math.round((expected-1)*.1)-11700<5000);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n,0);
 }finally{f.close();}
});
test('Missing dimensions, mixed external lines, changed source and other workspace never produce misleading profit',async()=>{
 const f=await fixture();try{
  const p=await f.create();let result=await f.estimate(p.id,{...dimensions,length_mm:undefined});assert.equal(result.quote.status,'incomplete');assert.equal(result.floor.price_cents,null);
  const multi=await f.create('MULTI',[f.line,{...f.line,external_id:'LINE-2'}]);result=await f.estimate(multi.id);assert.equal(result.quote.status,'incomplete');assert.match(result.quote.missing.join(' '),/Birden fazla ilan/);
  f.sql.prepare('UPDATE ec_order_packages SET source_changed=1 WHERE id=?').run(p.id);result=await f.estimate(p.id);assert.equal(result.quote.status,'incomplete');assert.match(result.quote.missing.join(' '),/Kaynak sipariş/);
  await assert.rejects(f.estimate(p.id,dimensions,{...f.env,WORKSPACE:'lp'}),e=>e.status===403);await assert.rejects(f.estimate('missing'),e=>e.status===404);
  const unlinked=await f.create('UNKNOWN',[{...f.line,sku:'UNKNOWN'}]);assert.equal((await f.estimate(unlinked.id)).quote.status,'incomplete');
 }finally{f.close();}
});
test('Shipment snapshot cost remains fixed after an expensive new purchase while a new draft uses new weighted stock cost',async()=>{
 const f=await fixture();try{
  const p=await f.create();await f.order('/'+p.id+'/reserve',{});await f.order('/'+p.id+'/ship',{occurred_on:date,reference:'SHIP'});let before=await f.estimate(p.id);assert.equal(before.cost_basis,'shipment_snapshot');assert.equal(before.quote.cost_net_cents,8000);
  const supplier=(await f.ac('/suppliers',{name:'Yeni alım tedarikçisi',tax_id:'1234567890'})).id;
  const invoice=await f.ac('/invoices',{supplier_id:supplier,invoice_no:'NEW-COST',invoice_date:date,currency:'TRY',lines:[{description:'Gerçek A',invoice_quantity:10,invoice_unit:'adet',net:1000,tax:200,product_id:f.a,stock_quantity:10}]});await f.ac('/invoices/'+invoice.id+'/post',{});const details=await f.ac('/invoices/'+invoice.id);await f.ac('/invoices/'+invoice.id+'/receive',{reference:'ARRIVED',occurred_on:date,lines:[{id:details.lines[0].id,quantity:10}]});
  const historical=await f.estimate(p.id);assert.equal(historical.quote.cost_net_cents,8000);assert.equal(historical.quote.estimated_profit_cents,before.quote.estimated_profit_cents);assert.equal(historical.cost_basis,'shipment_snapshot');
  const fresh=await f.create('FRESH');const current=await f.estimate(fresh.id);assert.equal(current.cost_basis,'current_weighted_average');assert.equal(current.quote.cost_net_cents,30500);assert.ok(current.quote.estimated_profit_cents<historical.quote.estimated_profit_cents);
 }finally{f.close();}
});
test('Changed stock unit or invalid component revenue shares stop an estimate before tariffs are applied',async()=>{
 const f=await fixture();try{
  const p=await f.create();assert.throws(()=>f.sql.prepare("UPDATE ec_products SET stock_unit='kg' WHERE id=?").run(f.a),/PRODUCT_UNIT_LOCKED/);
  // Simulate legacy corruption in this isolated test to exercise the read-side guard too.
  f.sql.exec('DROP TRIGGER ec_product_unit_history_guard');f.sql.prepare("UPDATE ec_products SET stock_unit='kg' WHERE id=?").run(f.a);let result=await f.estimate(p.id);assert.equal(result.quote.status,'incomplete');assert.match(result.quote.missing.join(' '),/stok birimi/);f.sql.prepare("UPDATE ec_products SET stock_unit='adet' WHERE id=?").run(f.a);
  f.sql.prepare('UPDATE ec_order_line_components SET revenue_share_bps=4000 WHERE product_id=?').run(f.a);result=await f.estimate(p.id);assert.equal(result.quote.status,'incomplete');assert.equal(result.floor.price_cents,null);
 }finally{f.close();}
});
