import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {level} from '../public/permissions.js';

// Depocuya miktar ve sevk bilgisi verilir, alis maliyeti ve kar gizlenir.
async function warehouse(){
 const f=appFixture();await f.setup();
 const supplier=await f.ok('/ec/suppliers',{name:'Tedarikçi','tax_id':'1234567890',contact:''});
 const product=(await f.ok('/ec/products',{name:'Torf',sku:'T-1',stock_unit:'adet',min_stock:0})).id;
 const invoice=await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:'F-1',invoice_date:'2026-09-10',currency:'TRY',
  lines:[{description:'Torf',external_code:'T',invoice_quantity:100,invoice_unit:'adet',product_id:product,stock_quantity:100,net:2000,tax:400}]});
 const line=(await f.ok('/ec/invoices/'+invoice.id)).lines[0];
 await f.ok('/ec/invoices/'+invoice.id+'/post',{});
 await f.ok('/ec/invoices/'+invoice.id+'/receive',{reference:'T1',occurred_on:'2026-09-10',lines:[{id:line.id,quantity:100}]});
 await f.ok('/ec/sales',{channel:'trendyol',external_id:'S-1',product_id:product,quantity:10,revenue:500,commission:50,shipping:30,other:0,fees_status:'confirmed',occurred_on:'2026-09-10',notes:''});

 const staff=await f.ok('/admin/users',{name:'Depo',username:'depo',
  permissions:{ec:{stock:'read',orders:'read',amounts:'none'},lp:{},delete_records:false}});
 await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'depo-personel-sifresi'});
 const login=await f.req('/auth/login',{username:'depo',password:'depo-personel-sifresi'});
 return {f,product,cookie:login.cookie};
}

test('Tutar yetkisi kapalı personel miktarı görür, parayı görmez',async()=>{
 const {f,cookie}=await warehouse();try{
  const view=await f.req('/ec?from=2026-09-01&to=2026-09-30',undefined,cookie);
  assert.equal(view.status,200);
  const card=view.data.stock[0];
  assert.equal(card.quantity_milli,90000,'miktar görünmeli');
  assert.equal(card.value_cents,null,'stok değeri gizlenmeli');
  assert.equal(view.data.pending_fee_cents,null,'bekleyen kesinti tutarı gizlenmeli');
  for(const movement of view.data.movements)assert.equal(movement.value_cents,null,'hareket tutarı gizlenmeli');
  assert.ok(view.data.movements.some(m=>m.quantity_milli!==null),'hareket miktarı görünmeli');
 }finally{f.close();}
});

test('Gizlenen maliyet stok geçmişi, sipariş ayrıntısı ve rapor üzerinden sızmaz',async()=>{
 const {f,product,cookie}=await warehouse();try{
  const history=await f.req('/ec/stock/history?product='+product,undefined,cookie);
  assert.equal(history.status,200);
  assert.equal(history.data.totals.value_change_cents,null,'geçmiş toplam tutarı gizlenmeli');
  assert.ok(history.data.totals.incoming_milli>0,'giren miktar görünmeli');
  for(const row of history.data.rows)assert.equal(row.value_cents,null,'satır tutarı gizlenmeli');

  const performance=await f.req('/ec/performance?mode=delivered&from=2026-09-01&to=2026-09-30',undefined,cookie);
  if(performance.status===200)for(const channel of performance.data.channels||[])assert.equal(channel.profit_cents,null,'kanal kârı gizlenmeli');

  const pricing=await f.req('/ec/pricing',undefined,cookie);
  assert.ok(pricing.status===403||(pricing.data.profiles||[]).every(p=>p.replacement_cost_cents===null),'fiyat profili maliyeti sızmamalı');
 }finally{f.close();}
});

test('Üretim verisinde hammadde fiyatı ve ürün satış fiyatı gizlenir',async()=>{
 const f=appFixture();await f.setup();try{
  f.sqlite.exec("INSERT INTO materials(id,name,unit,price) VALUES('m1','Reçine','kg',120);INSERT INTO products(id,name,sku,sale_price) VALUES('p1','Saksı','P-1',450);");
  const staff=await f.ok('/admin/users',{name:'Üretim',username:'uretim',
   permissions:{ec:{},lp:{materials:'read',products:'read',amounts:'none'},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'uretim-personel-sifresi'});
  const login=await f.req('/auth/login',{username:'uretim',password:'uretim-personel-sifresi'});
  const data=await f.req('/data',undefined,login.cookie);
  assert.equal(data.status,200);
  const material=data.data.materials.find(m=>m.id==='m1');
  assert.equal(material.name,'Reçine','hammadde adı görünmeli');
  assert.equal(material.price,null,'hammadde fiyatı gizlenmeli');
  assert.equal(data.data.products.find(p=>p.id==='p1').sale_price,null,'satış fiyatı gizlenmeli');
 }finally{f.close();}
});

test('Yönetici ve tutar yetkisi olan personel parayı görmeye devam eder',async()=>{
 const {f}=await warehouse();try{
  const owner=await f.ok('/ec?from=2026-09-01&to=2026-09-30');
  assert.ok(owner.stock[0].value_cents>0,'yöneticide tutar görünmeli');

  const staff=await f.ok('/admin/users',{name:'Muhasebe',username:'muhasebe',
   permissions:{ec:{stock:'read',amounts:'read'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'muhasebe-personel-sifresi'});
  const login=await f.req('/auth/login',{username:'muhasebe',password:'muhasebe-personel-sifresi'});
  const view=await f.req('/ec?from=2026-09-01&to=2026-09-30',undefined,login.cookie);
  assert.ok(view.data.stock[0].value_cents>0,'tutar yetkisi verilen personelde tutar görünmeli');
 }finally{f.close();}
});

test('Eski kayıtlarda tutar anahtarı yoksa görünüm daralmaz; açık seçim geçerlidir',()=>{
 const legacy={ec_access:'read',permissions:{ec:{stock:'read'},lp:{},delete_records:false}};
 assert.equal(level(legacy,'ec','amounts'),'read','anahtarı olmayan eski kayıt eski davranışı korumalı');

 const explicit={ec_access:'read',permissions:{ec:{stock:'read',amounts:'none'},lp:{},delete_records:false}};
 assert.equal(level(explicit,'ec','amounts'),'none','yönetici kapattıysa kapalı kalmalı');

 const owner={owner:true};
 assert.equal(level(owner,'ec','amounts'),'write');

 const noAccess={ec_access:'none',permissions:{ec:{},lp:{},delete_records:false}};
 assert.equal(level(noAccess,'ec','amounts'),'none','alana erişimi olmayan tutar da görmez');
});

test('Tutar yetkisi yazma korumasını ve alan ayrımını değiştirmez',async()=>{
 const {f,cookie}=await warehouse();try{
  const write=await f.req('/ec/products',{name:'İzinsiz',sku:'X-9',stock_unit:'adet',min_stock:0},cookie);
  assert.equal(write.status,403,'salt okunur personel yazamamalı');
  const other=await f.req('/data',undefined,cookie);
  assert.equal(other.status,403,'erişimi olmayan çalışma alanı kapalı kalmalı');
 }finally{f.close();}
});
