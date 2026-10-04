import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
test('business export preserves every selected table and allocation column within the query budget',async()=>{
 const f=appFixture();await f.setup();try{
  const supplier=await f.ok('/ec/suppliers',{name:'Bütçe Tedarikçisi',tax_id:'1234567890'});
  const product=await f.ok('/ec/products',{name:'Torf',sku:'BACKUP',stock_unit:'adet',min_stock:0});
  await f.ok('/ec/ledger/provisional',{supplier_id:supplier.id,occurred_on:'2026-09-20',reference:'BAK-IRS',notes:'Özgün metin: "tırnak" & kayıt',lines:[{product_id:product.id,quantity:3,unit_cost:100,vat_bps:2000}]});
  const invoice=await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:'BAK-INV',invoice_date:'2026-09-20',currency:'TRY',lines:[{description:'Torf',invoice_quantity:2,invoice_unit:'adet',product_id:product.id,stock_quantity:2,net:220,tax:44}]});
  await f.ok('/ec/invoices/'+invoice.id+'/post',{});
  const line=f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(invoice.id);
  await f.ok('/ec/invoices/'+invoice.id+'/receive',{occurred_on:'2026-09-20',reference:'BAK-DEL',lines:[{id:line.id,quantity:2}]});
  const prepare=f.env.DB.prepare.bind(f.env.DB);let queries=0;f.env.DB.prepare=sql=>{queries++;return prepare(sql);};
  const backup=await f.ok('/ec/settings/backup');assert.ok(queries<45,queries+' export queries');
  for(const table of ['ec_warehouse_sessions','ec_warehouse_count_lines','ec_workbench_tasks','ec_workbench_task_audit','ec_party_profiles','ec_party_profile_notes','ec_provisional_receipts','ec_provisional_receipt_lines','ec_provisional_allocations','ec_provisional_receipt_allocations','ec_provisional_movement_links'])assert.ok(Object.hasOwn(backup.tables,table),table+' retained');
  for(const [name,rows] of Object.entries(backup.tables))assert.deepEqual(rows,JSON.parse(JSON.stringify(f.sqlite.prepare('SELECT * FROM '+name).all())),name+' exact content');
 }finally{f.close();}
});
