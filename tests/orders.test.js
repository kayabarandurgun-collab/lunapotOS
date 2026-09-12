import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ordersApi,importOrders} from '../src/orders-api.js';
const date='2026-09-09';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0001_initial.sql','0002_accounting.sql','0003_accounting_audit.sql','0004_pricing.sql','0005_ledger.sql','0006_receipts_settings.sql','0007_orders.sql','0008_connections.sql','0010_order_refresh.sql','0011_catalog.sql','0012_order_components.sql','0039_order_report_link.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const raw={prepare(sql){return {values:[],bind(...a){this.values=a;return this;},first(){return sqlite.prepare(sql).get(...this.values)||null;},all(){return {results:sqlite.prepare(sql).all(...this.values)};}};},async batch(items){sqlite.exec('BEGIN');try{const results=items.map(i=>i.all());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const DB={...raw,prepare(sql){for(const table of ['catalog_mappings','catalog_mapping_components','order_line_components','order_packages','order_lines','order_reservations','order_refresh_audit','provider_records','provider_connections','products','stock_balances','sale_entries'])sql=sql.replace(new RegExp('\\b'+table+'\\b','g'),'ec_'+table);return raw.prepare(sql);}},env={DB,WORKSPACE:'ec'};
 const call=(path='',body)=>ordersApi(new Request('https://test.local/api/orders'+path,{method:body?'POST':'GET'}),env,'/api/orders'+path,async()=>body);
 function product(key,quantity=10,value=10000){sqlite.prepare('INSERT INTO ec_products(id,name,sku) VALUES(?,?,?)').run(key,key,key);if(quantity)sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,?, 'opening',?,?)").run('stock:'+key,key,quantity*1000,value,key,date);return key;}
 const order=(ref,lines)=>call('',{channel:'trendyol',external_id:ref,order_no:ref,occurred_on:date,lines});
 const line=(p,external='L1',quantity=1)=>({external_id:external,name:'Torf',product_id:p,quantity,gross:120,vat_rate:20});
 return {sqlite,env,call,product,order,line,close:()=>sqlite.close()};
}
test('Reviewed latest source refresh recovers changed draft, resets mappings and retains both histories',async()=>{
 const f=fixture();try{
  const p=f.product('REFRESH'),old={external_id:'REF-PKG',order_no:'REF-ORDER',occurred_on:date,external_status:'Created',currency:'TRY',source_updated_at:'2026-09-09T08:00:00.000Z',lines:[{external_id:'RL',sku:'SKU',name:'Torf',quantity_milli:1000,gross_cents:12000,vat_bps:2000,currency:'TRY'}]},current={...old,source_updated_at:'2026-09-09T09:00:00.000Z',lines:[{...old.lines[0],quantity_milli:2000,gross_cents:24000}]};
  f.sqlite.exec("INSERT INTO ec_provider_connections(provider,seller_id,encrypted_credentials) VALUES('trendyol','SELLER','encrypted-test-placeholder')");
  function source(key,payload,seller='SELLER'){f.sqlite.prepare('INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) VALUES(?,?,?,?,?,?,?,?)').run(key,'trendyol',seller,'orders',payload.external_id,key,JSON.stringify(payload),payload.source_updated_at);}
  source('source-old',old);const result=await importOrders(f.env,'trendyol',[old]),key=result.package_ids[0];const firstLine=(await f.call()).lines.find(l=>l.package_id===key);await f.call('/'+key+'/map',{lines:[{id:firstLine.id,product_id:p,vat_rate:20}]});
  source('source-current',current);await importOrders(f.env,'trendyol',[current]);assert.equal((await f.call()).packages.find(x=>x.id===key).source_changed,1);
  const preview=await f.call('/'+key+'/source');assert.equal(preview.can_refresh,true);assert.equal(preview.source_record_id,'source-current');assert.equal(preview.package.lines[0].quantity_milli,2000);
  await assert.rejects(f.call('/'+key+'/refresh',{confirm:false,source_record_id:'source-current'}),/onaylayın/);await assert.rejects(f.call('/'+key+'/refresh',{confirm:true,source_record_id:'source-old'}),/tekrar açın/);
  await f.call('/'+key+'/refresh',{confirm:true,source_record_id:'source-current',lines:[{product_id:'ATTACK',quantity:999}]});let state=await f.call();const line=state.lines.find(l=>l.package_id===key);assert.equal(line.quantity_milli,2000);assert.equal(line.product_id,null);assert.equal(line.net_revenue_cents,20000);assert.equal(state.packages.find(x=>x.id===key).source_changed,0);assert.equal(state.products[0].quantity_milli,10000);
  const audit=f.sqlite.prepare('SELECT * FROM ec_order_refresh_audit').get();assert.equal(audit.applied,1);assert.equal(JSON.parse(audit.old_components_json).length,1);assert.equal(JSON.parse(audit.old_lines_json)[0].product_id,p);assert.equal(JSON.parse(audit.old_lines_json)[0].quantity_milli,1000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provider_records').get().n,2);
  await f.call('/'+key+'/refresh',{confirm:true,source_record_id:'source-current'});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_refresh_audit').get().n,1);await assert.rejects(f.call('/'+key+'/reserve',{}),/eşleştirin/);
  await f.call('/'+key+'/map',{lines:[{id:line.id,product_id:p,vat_rate:20}]});await f.call('/'+key+'/reserve',{});await assert.rejects(f.call('/'+key+'/refresh',{confirm:true,source_record_id:'source-current'}),/taslak/);await f.call('/'+key+'/ship',{occurred_on:date,reference:'REFSHIP'});await assert.rejects(f.call('/'+key+'/refresh',{confirm:true,source_record_id:'source-current'}),/taslak/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,1);assert.throws(()=>f.sqlite.exec('DELETE FROM ec_order_refresh_audit'),/LOCKED/);
 }finally{f.close();}
});
test('Source refresh rejects malformed/cross-seller source and source revision changed after review',async()=>{
 const f=fixture();try{
  const packageData={external_id:'SOURCE',order_no:'ORDER',occurred_on:date,external_status:'Created',currency:'TRY',source_updated_at:'2026-09-09T08:00:00.000Z',lines:[{external_id:'L',name:'Torf',sku:'T',quantity_milli:1000,gross_cents:12000,vat_bps:2000,currency:'TRY'}]};
  const key=(await importOrders(f.env,'trendyol',[packageData])).package_ids[0];f.sqlite.exec("INSERT INTO ec_provider_connections(provider,seller_id,encrypted_credentials) VALUES('trendyol','CURRENT','placeholder')");
  const save=(id,payload,seller='CURRENT')=>f.sqlite.prepare('INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'trendyol',seller,'orders',packageData.external_id,id,JSON.stringify(payload),payload.source_updated_at);
  save('FOREIGN',packageData,'OTHER');await assert.rejects(f.call('/'+key+'/source'),/bulunamadı/);save('V1',packageData);assert.equal((await f.call('/'+key+'/source')).source_record_id,'V1');save('V2',{...packageData,source_updated_at:'2026-09-09T09:00:00.000Z'});await assert.rejects(f.call('/'+key+'/refresh',{confirm:true,source_record_id:'V1'}),/tekrar açın/);
  save('BAD',{...packageData,source_updated_at:'2026-09-09T10:00:00.000Z',currency:'USD'});await assert.rejects(f.call('/'+key+'/source'),/doğrulanamıyor/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_refresh_audit').get().n,0);
 }finally{f.close();}
});
test('Marketplace package counts cannot map to kg/L stock and bounded batches fit free execution',async()=>{
 const f=fixture();try{
  const p=f.product('BULK');f.sqlite.prepare("UPDATE ec_products SET stock_unit='kg' WHERE id=?").run(p);
  await assert.rejects(()=>f.order('WRONG-UNIT',[f.line(p)]),/adet stok birimine/);
  const draft=await f.order('UNMAPPED',[{external_id:'L',name:'Torf',quantity:1,gross:120,vat_rate:20}]);
  const l=(await f.call()).lines.find(l=>l.package_id===draft.id);
  await assert.rejects(()=>f.call('/'+draft.id+'/map',{lines:[{id:l.id,product_id:p}]}),/adet stok birimine/);
  f.sqlite.prepare("UPDATE ec_products SET stock_unit='adet' WHERE id=?").run(p);
  await f.call('/'+draft.id+'/map',{lines:[{id:l.id,product_id:p}]});
  f.sqlite.prepare("UPDATE ec_products SET stock_unit='L' WHERE id=?").run(p);
  await assert.rejects(()=>f.call('/'+draft.id+'/reserve',{}),/birimi eşleştirmeden/);
  await assert.rejects(()=>f.order('TOO-MANY',Array.from({length:11},(_,i)=>f.line(null,'L'+i))),/1–10/);
  await assert.rejects(()=>f.order('FRACTION',[f.line(null,'F',1.5)]),/tam sayı/);
  const source={external_id:'IMP',occurred_on:date,lines:[{external_id:'L',name:'T',quantity_milli:1000,gross_cents:12000,vat_bps:2000}]};
  await assert.rejects(()=>importOrders(f.env,'trendyol',Array.from({length:10},(_,i)=>({...source,external_id:'IMP'+i}))),/ücretsiz işlem sınırı/i);
 }finally{f.close();}
});
test('Reserve is physical-stock neutral, protects other sales/counts, ships once and delivers without sale duplication',async()=>{
 const f=fixture();try{
  const p=f.product('P',5,5000),first=await f.order('O1',[f.line(p,'L1',2),f.line(p,'L2',1)]),second=await f.order('O2',[f.line(p,'L3',3)]);
  await f.call('/'+first.id+'/reserve',{});let state=await f.call();assert.equal(state.products[0].quantity_milli,5000);assert.equal(state.products[0].reserved_milli,3000);assert.equal(state.products[0].available_milli,2000);
  await assert.rejects(f.call('/'+second.id+'/reserve',{}),/stok yetersiz/);
  assert.throws(()=>f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('count','P',-3000,-3000,'count','C','2026-09-09')"),/STOCK_RESERVED/);
  assert.throws(()=>f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('legacy','other','LEGACY','P','sale',3000,9000,3000,'pending','2026-09-09')"),/STOCK_RESERVED/);
  await f.call('/'+first.id+'/ship',{occurred_on:date,reference:'TRACK-1'});state=await f.call();assert.equal(state.products[0].quantity_milli,2000);assert.equal(state.products[0].reserved_milli,0);assert.equal(state.lines.filter(l=>l.package_id===first.id).every(l=>l.sale_id),true);
  const sales=f.sqlite.prepare('SELECT * FROM ec_sale_entries').all();assert.equal(sales.length,2);assert.equal(sales.reduce((s,e)=>s+e.cost_cents,0),3000);assert.equal(sales[0].commission_cents,null);assert.equal(sales[0].shipping_cents,null);assert.equal(sales[0].revenue_cents,10000);
  await f.call('/'+first.id+'/ship',{occurred_on:date,reference:'TRACK-1'});await f.call('/'+first.id+'/deliver',{occurred_on:date});await f.call('/'+first.id+'/deliver',{occurred_on:date});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,2);
  await assert.rejects(f.call('/'+first.id+'/cancel',{reason:'İptal'}),/iade/);
  await assert.rejects(f.call('/'+first.id+'/ship',{occurred_on:date,reference:'OTHER'}),/zaten/);
 }finally{f.close();}
});
test('Missing mapping/tax or net amounts block stock reservation, cancellation releases all reservations',async()=>{
 const f=fixture();try{
  const p=f.product('P'),order=await f.order('O',[{external_id:'L',name:'Torf',quantity:2,gross:120}]);
  assert.equal((await f.call()).packages[0].readiness,'needs_mapping');await assert.rejects(f.call('/'+order.id+'/reserve',{}),/eşleştirin/);
  const l=(await f.call()).lines[0];await f.call('/'+order.id+'/map',{lines:[{id:l.id,product_id:p}]});assert.equal((await f.call()).packages[0].readiness,'needs_amounts');await assert.rejects(f.call('/'+order.id+'/reserve',{}),/KDV/);
  await f.call('/'+order.id+'/map',{lines:[{id:l.id,product_id:p,vat_rate:20}]});assert.equal((await f.call()).lines[0].net_revenue_cents,10000);
  await f.call('/'+order.id+'/reserve',{});await f.call('/'+order.id+'/reserve',{});assert.equal((await f.call()).reservations.length,1);
  await assert.rejects(f.call('/'+order.id+'/map',{lines:[{id:l.id,product_id:p,vat_rate:10}]}),/taslak/);
  await f.call('/'+order.id+'/cancel',{reason:'Müşteri iptali'});const state=await f.call();assert.equal(state.reservations.length,0);assert.equal(state.products[0].quantity_milli,10000);assert.equal(state.products[0].available_milli,10000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);
  await assert.rejects(f.call('/'+order.id+'/reserve',{}),/bu durumda/);
 }finally{f.close();}
});
test('Provider imports are idempotent, preserve local state, flag commercial changes and reject wrong workspace',async()=>{
 const f=fixture();try{
  const record={external_id:'PK1',order_no:'ORDER1',occurred_on:date,external_status:'Created',lines:[{external_id:'SL1',sku:'T',name:'Torf',quantity_milli:1000,gross_cents:12000,vat_bps:null,net_revenue_cents:null}]};
  const first=await importOrders(f.env,'trendyol',[record]);assert.equal(first.created,1);assert.equal((await f.call()).lines[0].net_revenue_cents,null);
  let result=await importOrders(f.env,'trendyol',[{...record,external_status:'Delivered'}]);assert.equal(result.existing,1);assert.equal(result.conflicts,0);assert.equal((await f.call()).packages[0].status,'draft');assert.equal((await f.call()).packages[0].external_status,'Delivered');
  const p=f.product('P'),l=(await f.call()).lines[0];await f.call('/'+first.package_ids[0]+'/map',{lines:[{id:l.id,product_id:p,net_revenue:100}]});await f.call('/'+first.package_ids[0]+'/reserve',{});
  result=await importOrders(f.env,'trendyol',[{...record,lines:[{...record.lines[0],quantity_milli:2000}]}]);assert.equal(result.conflicts,1);assert.equal((await f.call()).lines[0].quantity_milli,1000);
  await assert.rejects(f.call('/'+first.package_ids[0]+'/ship',{occurred_on:date,reference:'SHIP'}),/Kaynak sipariş/);assert.equal((await f.call()).products[0].quantity_milli,10000);assert.equal((await f.call()).reservations.length,1);
  await assert.rejects(importOrders({...f.env,WORKSPACE:'lp'},'trendyol',[record]),/yalnızca/);
  await assert.rejects(f.order('BAD',[{external_id:'L',name:'X',quantity:1,gross:120,vat_rate:20,net_revenue:120}]),/uyuşmuyor/);
  await assert.rejects(f.order('FOREIGN',[f.line('NOT-EC')]),/bulunamadı/);
 }finally{f.close();}
});
test('Mixed products shipment rolls back on reference collision and rounding never overdraws cost',async()=>{
 const f=fixture();try{
  const p=f.product('P',3,1),q=f.product('Q',1,100),o=await f.order('MIX',[f.line(p,'1',1),f.line(p,'2',1),f.line(p,'3',1),f.line(q,'4',1)]);
  await f.call('/'+o.id+'/reserve',{});await f.call('/'+o.id+'/ship',{occurred_on:date,reference:'UNIQUE'});
  const state=await f.call();assert.equal(state.products.find(x=>x.id===p).value_cents,0);assert.equal(state.products.find(x=>x.id===q).value_cents,0);assert.equal(f.sqlite.prepare('SELECT SUM(cost_cents) n FROM ec_sale_entries').get().n,101);
  const p2=f.product('P2',1,100),other=await f.order('OTHER',[f.line(p2)]);await f.call('/'+other.id+'/reserve',{});
  await assert.rejects(f.call('/'+other.id+'/ship',{occurred_on:date,reference:'UNIQUE'}),/daha önce/);
  const after=await f.call();assert.equal(after.packages.find(x=>x.id===other.id).status,'reserved');assert.equal(after.products.find(x=>x.id===p2).reserved_milli,1000);assert.equal(after.products.find(x=>x.id===p2).quantity_milli,1000);
 }finally{f.close();}
});
