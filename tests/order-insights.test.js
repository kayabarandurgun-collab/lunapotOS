import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {orderInsightsApi} from '../src/order-insights-api.js';
import {ordersApi} from '../src/orders-api.js';
import {catalogApi} from '../src/catalog-api.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let queries=0;const raw={prepare(query){return {v:[],bind(...v){this.v=v;return this;},first(){queries++;return sql.prepare(query).get(...this.v)||null;},all(){queries++;return {results:sql.prepare(query).all(...this.v)};},run(){queries++;return sql.prepare(query).run(...this.v);}};},async batch(items){sql.exec('BEGIN');try{const result=items.map(i=>i.all());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const tables=['sales_invoice_drafts','catalog_mappings','catalog_mapping_components','catalog_mapping_audit','order_line_components','order_packages','order_lines','order_reservations','sale_entries','stock_balances','provider_records','provider_connections','goods_receipts','purchase_lines','purchase_invoices','suppliers','fee_allocations','products'];
 const DB={...raw,prepare(query){for(const t of tables)query=query.replace(new RegExp('\\b'+t+'\\b','g'),'ec_'+t);return raw.prepare(query);}},env={DB,ROOT_DB:raw,WORKSPACE:'ec'};
 const call=(id,action='insights',body)=>orderInsightsApi(new Request('https://test.local/api/orders/'+id+'/'+action,{method:body===undefined?'GET':'POST'}),env,'/api/orders/'+id+'/'+action,async()=>body);
 const orders=(path,body)=>ordersApi(new Request('https://test.local/api/orders'+path,{method:body===undefined?'GET':'POST'}),env,'/api/orders'+path,async()=>body);
 sql.exec("INSERT INTO ec_products(id,name,sku) VALUES('p','Torf','TORF'),('b','Çuval','BAG'); INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('open-p','p',10000,10000,'opening','open-p','2026-09-09'),('open-b','b',10000,1000,'opening','open-b','2026-09-09'); UPDATE workspace_settings SET legal_name='TEST Şirket',tax_id='1234567890' WHERE workspace='ec';");
 const create=()=>orders('',{channel:'trendyol',external_id:'PKG1',order_no:'ORDER1',occurred_on:'2026-09-09',lines:[{external_id:'LINE1',sku:'SET',name:'TEST Set',quantity:1,gross:120.01,vat_rate:20}]});
 const saveMapping=()=>catalogApi(new Request('https://test.local/api/catalog/mappings',{method:'POST'}),env,'/api/catalog/mappings',async()=>({source:'trendyol',external_code:'SET',components:[{product_id:'p',quantity_milli:2000,revenue_share_bps:9500},{product_id:'b',quantity_milli:1000,revenue_share_bps:500}]}));
 return {sql,env,call,orders,create,saveMapping,queryCount:()=>queries,reset:()=>{queries=0;},close:()=>sql.close()};
}
const billing={name:'TEST Alıcı',company:'',tax_id:'',tax_office:'',address:'TEST Cadde 1',district:'Kadıköy',city:'İstanbul',country:'TR',postal_code:'34000'};
test('Order detail conserves bundle sales, keeps unknown profit unknown and labels receipt evidence honestly',async()=>{
 const f=fixture();try{
  await f.saveMapping();const p=await f.create();let detail=await f.call(p.id);assert.equal(detail.components.length,2);assert.equal(detail.actual_summary.profit_cents,null);assert.equal(detail.actual_summary.status,'not_shipped');assert.equal(detail.actual_summary.order_net_cents,10001);
  f.sql.exec("INSERT INTO ec_suppliers(id,name) VALUES('sup','TEST Tedarikçi'); INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('inv','sup','TEST-INVOICE','2026-09-09'); INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents) VALUES('pl','inv','TEST Torf',2,'C62','p',2000,2000,400); UPDATE ec_purchase_invoices SET status='posted' WHERE id='inv'; INSERT INTO ec_goods_receipts(id,line_id,quantity_milli,value_cents,occurred_on,reference) VALUES('rec','pl',2000,2000,'2026-09-09','TEST-RECEIPT');");
  await f.orders('/'+p.id+'/reserve',{});await f.orders('/'+p.id+'/ship',{occurred_on:'2026-09-09',reference:'TEST-SHIP'});f.reset();detail=await f.call(p.id);
  assert.ok(f.queryCount()<=8);assert.equal(detail.sales.length,2);assert.equal(detail.sales.reduce((sum,s)=>sum+s.revenue_cents,0),10001);assert.equal(detail.actual_summary.revenue_net_cents,10001);assert.equal(detail.actual_summary.cost_net_cents,2100);assert.equal(detail.actual_summary.shipping_cents,null);assert.equal(detail.actual_summary.profit_cents,null);assert.equal(detail.actual_summary.status,'pending');assert.equal(detail.purchase_invoices[0].source,'recent_receipt_not_exact_lot');assert.equal(detail.purchase_invoices[0].invoice_no,'TEST-INVOICE');assert.equal(detail.invoice_status,'draft_only');
  await assert.rejects(()=>orderInsightsApi(new Request('https://test.local'),{...f.env,WORKSPACE:'lp'},'/api/orders/'+p.id+'/insights',async()=>({})),/e-ticaret/);await assert.rejects(()=>f.call('other-workspace'),/bulunamadı/);
 }finally{f.close();}
});
test('Local invoice drafts are idempotent, immutable, conserved snapshots without stock or ledger mutations',async()=>{
 const f=fixture();try{
  const p=await f.create(),before=f.sql.prepare('SELECT quantity_milli,value_cents FROM ec_stock_balances ORDER BY product_id').all();const body={issue_date:'2026-09-09',billing,notes:'TEST belge'};
  const one=await f.call(p.id,'invoice-draft',body),repeat=await f.call(p.id,'invoice-draft',body);assert.equal(one.id,repeat.id);assert.equal(repeat.existing,true);assert.equal(one.draft.version,1);assert.equal(one.draft.snapshot.official_issued,false);assert.deepEqual(one.draft.snapshot.totals,{gross_cents:12001,net_cents:10001,vat_cents:2000});assert.equal(one.draft.status,'draft');
  const changed=await f.call(p.id,'invoice-draft',{...body,billing:{...billing,address:'TEST Yeni Adres'}});assert.equal(changed.draft.version,2);assert.equal((await f.call(p.id)).drafts[1].snapshot.billing.address,billing.address);
  assert.deepEqual(f.sql.prepare('SELECT quantity_milli,value_cents FROM ec_stock_balances ORDER BY product_id').all(),before);assert.equal(f.sql.prepare('SELECT count(*) n FROM ec_sale_entries').get().n,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM ec_party_entries').get().n,0);assert.throws(()=>f.sql.exec('DELETE FROM ec_sales_invoice_drafts'),/IMMUTABLE/);assert.throws(()=>f.sql.exec("UPDATE ec_sales_invoice_drafts SET status='issued'"),/IMMUTABLE/);
  await assert.rejects(()=>f.call(p.id,'invoice-draft',{...body,billing:{...billing,address:''}}),/adres/);f.sql.exec("UPDATE workspace_settings SET tax_id='' WHERE workspace='ec'");await assert.rejects(()=>f.call(p.id,'invoice-draft',body),/şirket/);
 }finally{f.close();}
});
test('Drafts refuse unknown amounts and changed source; detail customer comes only from current merchant',async()=>{
 const f=fixture();try{
  const p=await f.create();f.sql.exec("INSERT INTO ec_provider_connections(provider,seller_id,encrypted_credentials) VALUES('trendyol','CURRENT','placeholder')");
  const source=(id,seller,customer,time)=>f.sql.prepare('INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'trendyol',seller,'orders','PKG1',id,JSON.stringify({customer,currency:'TRY'}),time);
  source('own','CURRENT',{name:'TEST Own'},'2026-09-09T08:00:00Z');source('foreign','FOREIGN',{name:'Never display'},'2026-09-09T10:00:00Z');assert.equal((await f.call(p.id)).customer.name,'TEST Own');assert.equal((await f.call(p.id)).source.record_id,'own');
  const body={issue_date:'2026-09-09',billing};f.sql.exec("UPDATE ec_order_lines SET gross_cents=NULL WHERE package_id='"+p.id+"'");await assert.rejects(()=>f.call(p.id,'invoice-draft',body),/tutarı/);assert.equal(f.sql.prepare('SELECT count(*) n FROM ec_sales_invoice_drafts').get().n,0);
  f.sql.prepare('UPDATE ec_order_packages SET source_changed=1 WHERE id=?').run(p.id);await assert.rejects(()=>f.call(p.id,'invoice-draft',body),/kaynak değişikliği/);
 }finally{f.close();}
});
