import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// Cift tik, kopan baglanti ve tekrar denemede ayni referansin ikinci kez is kaydi olusturmadigini korur.
async function stocked(){
 const f=appFixture();await f.setup();
 const supplier=await f.ok('/ec/suppliers',{name:'Tekrar testi',tax_id:'1234567890',contact:''});
 const product=await f.ok('/ec/products',{name:'Ürün',sku:'REP-1',stock_unit:'adet',min_stock:0});
 const invoice=await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:'REP-F1',invoice_date:'2026-09-10',currency:'TRY',lines:[{description:'Kalem',external_code:'',invoice_quantity:100,invoice_unit:'adet',product_id:product.id,stock_quantity:100,net:1000,tax:200}]});
 const line=(await f.ok('/ec/invoices/'+invoice.id)).lines[0];
 return {f,product:product.id,invoice:invoice.id,line:line.id};
}

test('Aynı teslim referansı iki kez gönderilse de stok bir kez artar',async()=>{
 const {f,invoice,line}=await stocked();try{
  await f.ok('/ec/invoices/'+invoice+'/post',{});
  const body={reference:'TESLIM-1',occurred_on:'2026-09-10',lines:[{id:line,quantity:40}]};
  const first=await f.req('/ec/invoices/'+invoice+'/receive',body);
  const second=await f.req('/ec/invoices/'+invoice+'/receive',body);
  assert.equal(first.status,200);
  assert.ok(second.status>=400,'aynı teslim referansı ikinci kez kabul edilmemeli, gelen '+second.status);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_goods_receipts').get().n,1,'tek teslim kaydı olmalı');
  assert.equal(f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=(SELECT product_id FROM ec_purchase_lines WHERE id=?)').get(line).q,40000,'stok bir kez artmalı');
 }finally{f.close();}
});

test('Aynı referanslı sayım düzeltmesi tekrarlanınca stok ikinci kez kaymaz',async()=>{
 const {f,product,invoice,line}=await stocked();try{
  await f.ok('/ec/invoices/'+invoice+'/post',{});
  await f.ok('/ec/invoices/'+invoice+'/receive',{reference:'TESLIM-1',occurred_on:'2026-09-10',lines:[{id:line,quantity:100}]});
  const body={product_id:product,kind:'count',quantity:95,reference:'SAYIM-1',notes:'Depo sayımı',occurred_on:'2026-09-10'};
  const first=await f.req('/ec/stock',body);
  const second=await f.req('/ec/stock',body);
  assert.equal(first.status,200);
  assert.ok(second.status>=400,'aynı sayım referansı ikinci kez işlenmemeli, gelen '+second.status);
  assert.equal(f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(product).q,95000);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE kind='count'").get().n,1);
 }finally{f.close();}
});

test('Aynı referanslı üretim partisi tekrarlanınca hammadde ikinci kez tüketilmez',async()=>{
 const f=appFixture();await f.setup();try{
  f.sqlite.exec("INSERT INTO materials(id,name,unit,price) VALUES('rep-m','Reçine','kg',100);INSERT INTO products(id,name,sku) VALUES('rep-p','Mamul','REP-P');INSERT INTO recipes(id,product_id,yield_qty,waste_pct,labor,packaging,overhead) VALUES('rep-r','rep-p',10,0,0,0,0);INSERT INTO recipe_items(id,recipe_id,material_id,quantity,unit) VALUES('rep-i','rep-r','rep-m',2,'kg');");
  await f.ok('/lp/production/material-stock',{material_id:'rep-m',kind:'opening',quantity:100,unit_cost:50,reference:'ACILIS-1',notes:'Başlangıç',occurred_on:'2026-09-10'});
  const body={recipe_id:'rep-r',quantity:10,labor:0,packaging:0,overhead:0,reference:'PARTI-1',notes:'Üretim',occurred_on:'2026-09-10',items:[{material_id:'rep-m',quantity:20}]};
  const first=await f.req('/lp/production/jobs',body);
  const second=await f.req('/lp/production/jobs',body);
  assert.equal(first.status,200,JSON.stringify(first.data));
  assert.ok(second.status>=400,'aynı parti referansı ikinci kez açılmamalı, gelen '+second.status);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM lp_production_jobs').get().n,1);
  assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM lp_material_balances WHERE material_id='rep-m'").get().q,80000,'hammadde bir kez düşmeli');
  assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM lp_stock_balances WHERE product_id='rep-p'").get().q,10000,'mamul bir kez artmalı');
 }finally{f.close();}
});

test('Aynı sipariş satırı referansıyla satış iki kez kaydedilmez',async()=>{
 const {f,product,invoice,line}=await stocked();try{
  await f.ok('/ec/invoices/'+invoice+'/post',{});
  await f.ok('/ec/invoices/'+invoice+'/receive',{reference:'TESLIM-1',occurred_on:'2026-09-10',lines:[{id:line,quantity:100}]});
  const body={channel:'trendyol',external_id:'SIP-1',product_id:product,quantity:5,revenue:250,commission:25,shipping:20,other:0,fees_status:'confirmed',occurred_on:'2026-09-10',notes:''};
  const first=await f.req('/ec/sales',body);
  const second=await f.req('/ec/sales',body);
  assert.equal(first.status,200);
  assert.ok(second.status>=400,'aynı satış referansı ikinci kez işlenmemeli, gelen '+second.status);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(product).q,95000,'stok bir kez düşmeli');
 }finally{f.close();}
});
