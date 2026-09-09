import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

async function seed(){
 const f=appFixture();await f.setup();
 const supplier=await f.ok('/ec/suppliers',{name:'İptal testi tedarikçisi',tax_id:'1234567890',contact:''});
 const product=await f.ok('/ec/products',{name:'Ürün','sku':'IPT-1',stock_unit:'adet',min_stock:0});
 const draft=(no,net)=>({supplier_id:supplier.id,invoice_no:no,invoice_date:'2026-09-09',currency:'TRY',lines:[{description:'Kalem',external_code:'',invoice_quantity:1,invoice_unit:'adet',product_id:product.id,stock_quantity:1,net,tax:0}]});
 return {f,supplier,product,draft};
}

test('İptal edilen taslağın belge numarası serbest kalır ve doğru fatura yeniden girilebilir',async()=>{
 const {f,draft}=await seed();try{
  const wrong=await f.ok('/ec/invoices',draft('F-100',10));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,1);

  await f.ok('/ec/invoices/'+wrong.id+'/cancel',{});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,0,'iptalde belge kaydı silinmeli');
  assert.equal(f.sqlite.prepare('SELECT status FROM ec_purchase_invoices WHERE id=?').get(wrong.id).status,'cancelled');
  assert.match(f.sqlite.prepare('SELECT invoice_no FROM ec_purchase_invoices WHERE id=?').get(wrong.id).invoice_no,/^F-100 \(iptal /,'iptal işareti numarayı serbest bırakmalı');

  const right=await f.ok('/ec/invoices',draft('F-100',250));
  assert.notEqual(right.id,wrong.id);
  assert.equal(f.sqlite.prepare('SELECT invoice_no FROM ec_purchase_invoices WHERE id=?').get(right.id).invoice_no,'F-100');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,1);

  await f.ok('/ec/invoices/'+right.id+'/post',{});
  assert.equal(f.sqlite.prepare('SELECT SUM(amount_cents) t FROM ec_party_entries').get().t,-25000,'yalnızca doğru fatura cariye yazılmalı');
 }finally{f.close();}
});

test('Aynı numara ikinci kez iptal edilebilir; muhasebeleşmiş fatura hâlâ tekrar girilemez',async()=>{
 const {f,draft}=await seed();try{
  const first=await f.ok('/ec/invoices',draft('F-200',10));
  await f.ok('/ec/invoices/'+first.id+'/cancel',{});
  const second=await f.ok('/ec/invoices',draft('F-200',20));
  await f.ok('/ec/invoices/'+second.id+'/cancel',{});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_purchase_invoices WHERE status='cancelled'").get().n,2,'iki iptal aynı numarada çakışmamalı');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,0);

  const third=await f.ok('/ec/invoices',draft('F-200',30));
  await f.ok('/ec/invoices/'+third.id+'/post',{});
  const repeat=await f.req('/ec/invoices',draft('F-200',30));
  assert.equal(repeat.status,409,'muhasebeleşmiş fatura ikinci kez işlenmemeli');

  const cancelPosted=await f.req('/ec/invoices/'+third.id+'/cancel',{});
  assert.equal(cancelPosted.status,409,'muhasebeleşmiş fatura iptal edilemez');
  assert.equal(f.sqlite.prepare('SELECT invoice_no FROM ec_purchase_invoices WHERE id=?').get(third.id).invoice_no,'F-200','iptal reddedilince numara değişmemeli');
 }finally{f.close();}
});

test('Bir alandaki iptal, diğer alanın belge kaydını silmez',async()=>{
 const f=appFixture();await f.setup();try{
  const ec=await f.ok('/ec/suppliers',{name:'Ortak tedarikçi',tax_id:'9876543210',contact:''});
  const lp=await f.ok('/lp/suppliers',{name:'Ortak tedarikçi',tax_id:'9876543210',contact:''});
  const ecProduct=await f.ok('/ec/products',{name:'EC ürün',sku:'EC-1',stock_unit:'adet',min_stock:0});
  f.sqlite.exec("INSERT INTO products(id,name,sku) VALUES('lp-1','LP ürün','LP-1')");
  const line=(id)=>[{description:'Kalem',external_code:'',invoice_quantity:1,invoice_unit:'adet',product_id:id,stock_quantity:1,net:10,tax:0}];

  const ecInvoice=await f.ok('/ec/invoices',{supplier_id:ec.id,invoice_no:'ORTAK-1',invoice_date:'2026-09-09',currency:'TRY',lines:line(ecProduct.id)});
  const blocked=await f.req('/lp/invoices',{supplier_id:lp.id,invoice_no:'ORTAK-1',invoice_date:'2026-09-09',currency:'TRY',lines:line('lp-1')});
  assert.equal(blocked.status,409,'aynı vergi numarası ve belge numarası iki alanda birden işlenmemeli');

  await f.ok('/ec/invoices/'+ecInvoice.id+'/cancel',{});
  const allowed=await f.req('/lp/invoices',{supplier_id:lp.id,invoice_no:'ORTAK-1',invoice_date:'2026-09-09',currency:'TRY',lines:line('lp-1')});
  assert.ok(allowed.status>=200&&allowed.status<300,'iptalden sonra diğer alan belgeyi işleyebilmeli, gelen '+allowed.status);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM document_registry WHERE workspace='lp'").get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM document_registry WHERE workspace='ec'").get().n,0);
 }finally{f.close();}
});
