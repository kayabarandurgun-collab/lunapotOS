import test from 'node:test';import assert from 'node:assert/strict';
import {warehouseFixture} from './warehouse-fixture.test.js';
import {productProfileApi} from '../src/product-profile-api.js';
import {scopedDB} from '../src/scoped-db.js';

test('product dossier returns actual EC stock, purchases, supplier identity and corrected unit cost without customer finances',async()=>{
 const f=warehouseFixture();try{await f.setup();f.product('a');f.product('b');const supplier=(await f.ok('/ec/suppliers',{name:'Tedarikçi <A>',tax_id:'1234567890',contact:'private-contact'})).id;
 const invoice=(await f.ok('/ec/invoices',{supplier_id:supplier,invoice_no:'ALIS-1',invoice_date:'2026-09-01',currency:'TRY',lines:[{description:'Mal',invoice_quantity:10,invoice_unit:'adet',product_id:'a',stock_quantity:10,net:100,tax:20,line_type:'product'}]})).id;
 await f.ok('/ec/invoices/'+invoice+'/post',{});const line=(await f.ok('/ec/invoices/'+invoice)).lines[0].id;
 await f.ok('/ec/invoices/'+invoice+'/receive',{occurred_on:'2026-09-01',reference:'MAL-1',lines:[{id:line,quantity:10}]});
 await f.ok('/ec/invoices/'+invoice+'/adjustments',{line_id:line,kind:'price',net:20,tax:4,stock_net:20,occurred_on:'2026-09-01',reference:'INDIRIM',reason:'Alış fiyatı düzeltmesi'});
 f.sqlite.prepare('UPDATE ec_products SET supplier_id=? WHERE id=?').run(supplier,'a');
 const changes=f.sqlite.prepare('SELECT total_changes() n').get().n,p=await f.profile('a');assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(p.product.on_hand_milli,10000);assert.equal(p.product.value_cents,8000);assert.equal(p.purchases[0].received_milli,10000);assert.equal(p.last_unit_cost_cents,800);assert.equal(p.primary_supplier.name,'Tedarikçi <A>');assert.equal(p.history.totals.value_change_cents,8000);
 const json=JSON.stringify(p);for(const forbidden of ['private-contact','1234567890','balance_cents','revenue_cents','customer_name','customer_email'])assert.ok(!json.includes(forbidden),forbidden);
 const stockOnly={ec_access:'read',permissions:{ec:{stock:'read',amounts:'read'}}};const limited=await f.profile('a','ec',stockOnly);assert.equal(limited.purchase_access,false);assert.deepEqual(limited.purchases,[]);assert.deepEqual(limited.suppliers,[]);assert.equal(limited.last_unit_cost_cents,null);assert.equal(limited.product.value_cents,8000);
 const noAmounts={ec_access:'read',permissions:{ec:{stock:'read',invoices:'read',amounts:'none'}}};const hidden=await f.profile('a','ec',noAmounts);assert.equal(hidden.purchases[0].net_cents,null);assert.equal(hidden.last_unit_cost_cents,null);assert.equal(hidden.product.value_cents,null);
 }finally{f.close();}
});

test('product profile LP reads actual receiving ledger, reports unsupported transit and never falls across namespaces',async()=>{
 const f=warehouseFixture();try{await f.setup();f.product('same',10000,50000);f.sqlite.exec("INSERT INTO products(id,name,sku) VALUES('same','Üretim ürünü','LP-SAME');INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('lpm','same',3000,12000,'opening','LP-OPEN','2026-09-01')");
 const lp=await f.profile('same','lp');assert.equal(lp.product.name,'Üretim ürünü');assert.equal(lp.product.on_hand_milli,3000);assert.equal(lp.product.value_cents,12000);assert.equal(lp.product.in_transit_milli,null);assert.equal(lp.product.reserved_milli,null);assert.equal(lp.replenishment,null);assert.equal(lp.history.rows.length,1);assert.equal(lp.history.rows[0].reference,'LP-OPEN');
 const ec=await f.profile('same');assert.equal(ec.product.value_cents,50000);assert.equal(ec.product.name,'Ürün same');
 f.product('only-ec');await assert.rejects(()=>f.profile('only-ec','lp'),e=>e.status===404);
 const staff={lp_access:'read',permissions:{lp:{products:'read',accounts:'none'}}};await assert.rejects(()=>f.profile('same','lp',staff),e=>e.status===403);
 const res=()=>productProfileApi(new Request('https://test/api/ec/product-profile?id=same',{method:'POST'}),{DB:scopedDB(f.env.DB,'ec'),WORKSPACE:'ec',USER:{owner:true}},'/api/product-profile');await assert.rejects(res,e=>e.status===405);
 }finally{f.close();}
});

test('hidden gain costs are preserved by quantity-only edits and current-unit changes during recount roll back atomically',async()=>{
 const f=warehouseFixture();try{f.product('a');let s=await f.create(['a']);s=await f.save(s,[{product_id:'a',counted_milli:1000,unit_cost_cents:500}]);
 const noAmounts={ec_access:'write',permissions:{ec:{stock:'write',amounts:'none'}}};s=await f.call('/sessions/'+s.session.id+'/lines',{revision:s.session.revision,lines:[{product_id:'a',counted_milli:2000}]},'ec',noAmounts);assert.equal(s.lines[0].unit_cost_cents,null);
 assert.equal((await f.call('/sessions/'+s.session.id)).lines[0].unit_cost_cents,500);
 await assert.rejects(()=>f.call('/sessions/'+s.session.id+'/lines',{revision:s.session.revision,lines:[{product_id:'a',counted_milli:2000,unit_cost_cents:null}]},'ec',noAmounts),e=>e.status===403);
 f.product('unit');f.sqlite.exec("UPDATE ec_products SET stock_unit='kg' WHERE id='unit'");let r=await f.create(['unit']);r=await f.save(r,[{product_id:'unit',counted_milli:1500,unit_cost_cents:100}]);
 const original=f.env.DB.batch;let changed=false;f.env.DB.batch=async items=>{if(!changed){changed=true;f.sqlite.exec("UPDATE ec_products SET stock_unit='adet' WHERE id='unit'");}return original(items);};
 await assert.rejects(()=>f.save(r,[{product_id:'unit',counted_milli:1500,unit_cost_cents:100,recount:true}]),e=>e.status===400);f.env.DB.batch=original;
 assert.equal((await f.call('/sessions/'+r.session.id)).session.revision,r.session.revision);assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='unit'").get().quantity_milli,0);
 }finally{f.close();}
});

test('archived zero-stock dossier keeps explicit unknown lead time and valid reorder fields',async()=>{
 const f=warehouseFixture();try{f.product('archived');f.sqlite.exec("UPDATE ec_products SET archived_at=CURRENT_TIMESTAMP WHERE id='archived'");const p=await f.profile('archived');assert.equal(p.replenishment.lead_days,null);assert.equal(p.replenishment.suggested_milli,null);assert.equal(p.replenishment.product_id,'archived');assert.match(p.replenishment.reason,/Arşivlenmiş ürün/);assert.equal(p.replenishment.target_milli,null);}finally{f.close();}
});
