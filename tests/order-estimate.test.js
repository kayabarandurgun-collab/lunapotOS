import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {scopedDB} from '../src/scoped-db.js';
import {ordersApi} from '../src/orders-api.js';
import {catalogApi} from '../src/catalog-api.js';
import {pricingApi} from '../src/pricing-api.js';
import {accountingApi} from '../src/accounting.js';
import {performanceApi} from '../src/performance-api.js';
import {attentionApi} from '../src/attention-api.js';
import {attentionItems} from '../public/attention-ui.js';
import {orderEstimateApi} from '../src/order-estimate-api.js';
const date='2026-09-09';
const dimensions={category:'',carrier:'Kargo',date,length_mm:300,width_mm:300,height_mm:300,weight_grams:2000,packaging_cents:500,other_cents:200,withholding_bps:0,desired_profit_cents:5000};
test('Channel performance excludes undelivered orders from actuals, separates missing fees and includes later returns once',async()=>{
 const f=await fixture();try{
  const report=(mode='delivered',from=date,to=date)=>performanceApi(new Request('https://test.local/api/ec/performance?'+new URLSearchParams({mode,from,to})),f.env,'/api/performance');
  const p=await f.create('ACTUAL');await f.estimate(p.id);await f.order('/'+p.id+'/reserve',{});await f.order('/'+p.id+'/ship',{occurred_on:date,reference:'ACTUAL-SHIP'});
  const sales=f.sql.prepare("SELECT * FROM ec_sale_entries WHERE kind='sale'").all();for(const s of sales)await f.ac('/sales/'+s.id+'/fees',{commission:10,shipping:5,other:2,fees_status:'confirmed'});
  assert.equal((await report()).channels[0].packages,0,'shipped actual fees must not appear in delivered totals');
  const pending=await report('pending');assert.equal(pending.channels[0].packages,1);assert.equal(pending.channels[0].profit_cents,14700);assert.equal(pending.rows[0].cost_basis,'shipment_snapshot');
  await f.order('/'+p.id+'/deliver',{occurred_on:date});let r=await report();assert.equal(r.channels[0].profit_cents,18600);assert.equal((await report('pending')).channels[0].packages,0);
  const hb=await f.order('',{channel:'hepsiburada',external_id:'HB-ONLY',occurred_on:date,lines:[{external_id:'HB-L',sku:'HB-A',product_id:f.a,name:'HB adı farklı',quantity:1,gross:120,vat_rate:20}]});await f.order('/'+hb.id+'/reserve',{});await f.order('/'+hb.id+'/ship',{occurred_on:date,reference:'HB-SHIP'});await f.order('/'+hb.id+'/deliver',{occurred_on:date});
  r=await report();assert.equal(r.channels[0].profit_cents,18600);assert.equal(r.channels[1].packages,1);assert.equal(r.channels[1].profit_cents,null);assert.equal(r.channels[1].missing,1);
  const a=sales.find(s=>s.product_id===f.a);await f.ac('/sales/'+a.id+'/return',{external_id:'LATER-RETURN',quantity:1,revenue:37.5,commission:0,shipping:10,other:0,fees_status:'confirmed',restock:true,occurred_on:'2026-09-10'});
  r=await report();assert.equal(r.channels[0].profit_cents,14850);assert.equal(r.rows.find(x=>x.channel==='trendyol').returns,1);assert.equal((await report('delivered','2026-09-10','2026-09-10')).rows.length,0);
  await f.ac('/sales/'+a.id+'/fees',{commission:null,shipping:5,other:2,fees_status:'pending'});r=await report();assert.equal(r.channels[0].profit_cents,null);assert.equal(r.channels[0].calculated,0);
 }finally{f.close();}
});
test('Pending performance recalculates tariffs and refuses changed composition or absent assumptions',async()=>{
 const f=await fixture();try{
  const report=()=>performanceApi(new Request('https://test.local/api/ec/performance?mode=pending&from='+date+'&to='+date),f.env,'/api/performance');
  const p=await f.create('PENDING');let r=await report();assert.equal(r.channels[0].missing,1);
  await f.estimate(p.id);r=await report();assert.equal(r.channels[0].profit_cents,14700);
  f.sql.prepare('UPDATE ec_order_packages SET source_changed=1 WHERE id=?').run(p.id);r=await report();assert.equal(r.channels[0].profit_cents,null);assert.match(r.rows[0].missing.join(' '),/Kaynak sipariş/);
  f.sql.prepare('UPDATE ec_order_packages SET source_changed=0 WHERE id=?').run(p.id);f.sql.prepare('UPDATE ec_order_line_components SET quantity_milli=quantity_milli+1000 WHERE product_id=?').run(f.a);r=await report();assert.match(r.rows[0].missing.join(' '),/Paket içeriği/);
  await assert.rejects(performanceApi(new Request('https://test.local/api/lp/performance'),{...f.env,WORKSPACE:'lp'},'/api/performance'),e=>e.status===403);
 }finally{f.close();}
});
test('Learned parcel assumptions reuse only identical channel, listing, quantity and stock contents',async()=>{
 const f=await fixture();try{
  const first=await f.create('LEARN');await f.estimate(first.id);
  const twin=await f.create('TWIN');const different=await f.create('DIFFERENT-QTY',[{...f.line,quantity:1}]);
  const report=()=>performanceApi(new Request('https://test.local/api/ec/performance?mode=pending&from='+date+'&to='+date),f.env,'/api/performance');
  let r=await report(),row=r.rows.find(x=>x.id===twin.id);assert.equal(row.profit_cents,14700);assert.equal(row.assumptions_source,'identical_contents_template');assert.equal(r.rows.find(x=>x.id===different.id).profit_cents,null);
  // Tariffs are re-evaluated, not copied from the historical calculation.
  f.sql.prepare('UPDATE ec_shipping_rates SET archived_at=CURRENT_TIMESTAMP WHERE id=?').run(f.ship.id);r=await report();assert.equal(r.rows.find(x=>x.id===twin.id).profit_cents,null);assert.match(r.rows.find(x=>x.id===twin.id).missing.join(' '),/kargo tarifesi eksik/);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);
 }finally{f.close();}
});
test('Mixed parcel applies each listing VAT/commission and the total-price shipping bracket exactly once',async()=>{
 const f=await fixture(40000);try{
  const ship=await f.pricing('/shipping',{label:'Büyük paket tutarı',channel:'trendyol',valid_from:'2026-01-01',valid_to:'2026-12-31',price_min_cents:40000,price_max_cents:null,vat_bps:2000,tax_included:false,source:'Test sözleşmesi',carrier:'Kargo',billable_min_milli:0,billable_max_milli:null,desi_divisor:3000,billable_step_milli:1000,amount_cents:5000});
  const second={external_id:'SECOND',sku:'DIFFERENT',name:'Farklı ürün',product_id:f.a,quantity:1,gross:110,vat_rate:10};
  const p=await f.create('MIXED',[f.line,second]);f.reset();const result=await f.estimate(p.id),q=result.quote;
  assert.equal(q.status,'estimated');assert.equal(q.lines.length,2);assert.equal(q.price_cents,47000);assert.equal(q.revenue_net_cents,40000);assert.equal(q.cost_net_cents,9000);assert.equal(q.shipping_net_cents,5000);assert.equal(q.shipping_rate_id,ship.id);assert.equal(q.commission_net_cents,9100);assert.equal(q.packaging_net_cents,500);assert.equal(q.other_net_cents,200);assert.equal(q.estimated_profit_cents,16200);assert.equal(q.estimated_payout_cents,30080);assert.equal(result.floor.price_cents,null);assert.ok(f.queries()<=8);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);
  const broken=await f.create('MISSING-MAPPING',[f.line,{...second,product_id:undefined,sku:'UNMAPPED'}]);assert.equal((await f.estimate(broken.id)).quote.status,'incomplete');
  const noVat=await f.create('MISSING-VAT',[f.line,{...second,vat_rate:null}]);assert.equal((await f.estimate(noVat.id)).quote.status,'incomplete');
  f.sql.prepare("UPDATE ec_commission_rates SET archived_at=CURRENT_TIMESTAMP WHERE sku=''").run();assert.equal((await f.estimate(p.id)).quote.status,'incomplete');
 }finally{f.close();}
});
test('Attention counts reservations, missing mapping, partial receipts and unsettled fees without mixing workspaces',async()=>{
 const f=await fixture();try{
  const get=()=>f.invoke(attentionApi,'/api/attention');
  let a=await get();assert.equal(a.stock.total,2);assert.equal(a.stock.no_history,0);assert.equal(a.orders.total,0);
  const emptyItems=attentionItems(a,{providers:[{id:'trendyol',name:'Trendyol',configured:false}]},{legal_name:'',tax_id:''});assert.ok(emptyItems.some(x=>x.title.includes('henüz bağlı değil')));
  await f.create('UNMAPPED',[{...f.line,sku:'UNKNOWN'}]);
  const reserved=await f.create('RESERVED');await f.order('/'+reserved.id+'/reserve',{});
  f.sql.prepare('UPDATE ec_products SET min_stock_milli=7000 WHERE id=?').run(f.a);
  a=await get();assert.equal(a.orders.unmapped,1);assert.equal(a.orders.reserved,1);assert.equal(a.stock.low,1);
  await f.order('/'+reserved.id+'/ship',{occurred_on:date,reference:'SHIP-ATTENTION'});a=await get();assert.equal(a.orders.reserved,0);assert.equal(a.sales.unconfirmed,2);
  const supplier=(await f.ac('/suppliers',{name:'Tedarikçi',tax_id:'1234567890'})).id;
  const invoice=await f.ac('/invoices',{supplier_id:supplier,invoice_no:'PARTIAL',invoice_date:date,currency:'TRY',lines:[{description:'A',invoice_quantity:10,invoice_unit:'adet',net:100,tax:20,product_id:f.a,stock_quantity:10}]});
  assert.equal((await get()).invoices.drafts,1);await f.ac('/invoices/'+invoice.id+'/post',{});assert.equal((await get()).invoices.awaiting_receipt,1);
  const details=await f.ac('/invoices/'+invoice.id);await f.ac('/invoices/'+invoice.id+'/receive',{reference:'HALF',occurred_on:date,lines:[{id:details.lines[0].id,quantity:4}]});assert.equal((await get()).invoices.awaiting_receipt,1);
  await f.ac('/invoices/'+invoice.id+'/receive',{reference:'REST',occurred_on:date,lines:[{id:details.lines[0].id,quantity:6}]});assert.equal((await get()).invoices.awaiting_receipt,0);
  f.sql.prepare("INSERT INTO products(id,name,sku) VALUES('LP-ONLY','Lunapot ürünü','LP')").run();assert.equal((await get()).stock.total,2);
  await assert.rejects(f.invoke(attentionApi,'/api/attention',undefined,{...f.env,WORKSPACE:'lp'}),e=>e.status===403);
 }finally{f.close();}
});
async function fixture(shippingMax=null){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let queries=0;const raw={prepare(query){return {args:[],bind(...a){this.args=a;return this;},first(){queries++;return sql.prepare(query).get(...this.args)||null;},all(){queries++;return {results:sql.prepare(query).all(...this.args)};},run(){queries++;return sql.prepare(query).run(...this.args);}};},async batch(items){sql.exec('BEGIN');try{const result=items.map(x=>x.all());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:scopedDB(raw,'ec'),ROOT_DB:raw,WORKSPACE:'ec'};
 const invoke=(handler,path,body,custom=env)=>handler(new Request('https://test.local'+path,{method:body===undefined?'GET':'POST'}),custom,path,async()=>body);
 const order=(path='',body)=>invoke(ordersApi,'/api/orders'+path,body),pricing=(path,body)=>invoke(pricingApi,'/api/pricing'+path,body),ac=(path,body)=>invoke(accountingApi,'/api/accounting'+path,body);
 const a=(await ac('/products',{name:'Gerçek A',sku:'REAL-A',stock_unit:'adet',min_stock:0})).id,b=(await ac('/products',{name:'Gerçek B',sku:'REAL-B',stock_unit:'adet',min_stock:0})).id;
 for(const [p,cost] of [[a,10],[b,20]])await ac('/stock',{product_id:p,kind:'opening',reference:'OPEN-'+p,quantity:10,unit_cost:cost,occurred_on:date,notes:'Test açılışı'});
 await invoke(catalogApi,'/api/catalog/mappings',{source:'trendyol',external_code:'EXTERNAL-SET',external_name:'2 A + 1 B seti',source_unit:'',components:[{product_id:a,quantity_milli:2000,revenue_share_bps:5000},{product_id:b,quantity_milli:1000,revenue_share_bps:5000}]});
 const common={label:'Test tarifesi',channel:'trendyol',valid_from:'2026-01-01',valid_to:'2026-12-31',price_min_cents:0,price_max_cents:null,vat_bps:2000,tax_included:false,source:'Test sözleşmesi'};
 const ship=await pricing('/shipping',{...common,price_max_cents:shippingMax,carrier:'Kargo',billable_min_milli:0,billable_max_milli:null,desi_divisor:3000,billable_step_milli:1000,amount_cents:3000});
 const commission=await pricing('/commissions',{...common,sku:'EXTERNAL-SET',category:'',rate_bps:1000,base:'gross'});
 await pricing('/commissions',{...common,sku:'REAL-A',category:'',rate_bps:8000,base:'gross'});await pricing('/commissions',{...common,sku:'',category:'',rate_bps:5000,base:'gross'});
 const line={external_id:'LINE',sku:'EXTERNAL-SET',name:'Satıştaki set adı',quantity:2,gross:360,vat_rate:20};
 const create=(external='PKG',lines=[line])=>order('',{channel:'trendyol',external_id:external,occurred_on:date,lines});
 const estimate=(id,body=dimensions,custom=env)=>invoke(orderEstimateApi,'/api/orders/'+id+'/estimate',body,custom);
 return {sql,env,invoke,order,ac,pricing,create,estimate,a,b,ship,commission,line,reset(){queries=0;},queries:()=>queries,close:()=>sql.close()};
}
test('Bundle estimate uses 2A+1B twice, charges one shipment and external SKU commission with a verified package floor',async()=>{
 const f=await fixture();try{
  const p=await f.create();f.reset();const result=await f.estimate(p.id),q=result.quote;assert.equal(q.status,'estimated');assert.equal(result.cost_basis,'current_weighted_average');assert.equal(q.revenue_net_cents,30000);assert.equal(q.cost_net_cents,8000);assert.equal(q.shipping_net_cents,3000);assert.equal(q.shipping_rate_id,f.ship.id);assert.equal(q.commission_net_cents,3600);assert.equal(q.commission_rate_id,f.commission.id);assert.equal(q.estimated_profit_cents,14700);assert.equal(q.estimated_payout_cents,28080);assert.equal(result.floor.status,'found');assert.ok(f.queries()<=8,'bounded server request leaves ample authentication headroom');
  let expected=0;while(Math.round(expected/1.2)-Math.round(expected*.1)-11700<5000)expected++;assert.equal(result.floor.price_cents,expected);assert.ok(result.floor.quote.estimated_profit_cents>=5000);assert.ok(Math.round((expected-1)/1.2)-Math.round((expected-1)*.1)-11700<5000);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n,0);
 }finally{f.close();}
});
test('Missing dimensions, changed source and other workspace never produce misleading profit',async()=>{
 const f=await fixture();try{
  const p=await f.create();let result=await f.estimate(p.id,{...dimensions,length_mm:undefined});assert.equal(result.quote.status,'incomplete');assert.equal(result.floor.price_cents,null);
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
