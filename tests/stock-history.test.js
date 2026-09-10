import test from 'node:test';import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {stockHistoryQuery} from '../src/stock-history-api.js';
import {parsePermissions} from '../public/permissions.js';
test('Ürün geçmişi son 200 kayıt dışını arar; sayfa toplamları tüm eşleşmeleri ve iki panel ayrımını korur',async()=>{
 const f=appFixture();try{await f.setup();
 const p=(await f.ok('/ec/products',{name:'Test torf',sku:'TORF',stock_unit:'adet',min_stock:0})).id;
 const lp=(await f.ok('/products',{name:'Üretim kartı',sku:'LP',sale_price:0})).id;
 const insert=f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(?,?,?,?,?,?,?,?)");
 insert.run('old',p,1000,500,'opening','OLD-%_invoice','Önceki alış','2025-01-01');
 f.sqlite.exec('BEGIN');for(let i=0;i<255;i++)insert.run('new-'+String(i).padStart(3,'0'),p,1000,500,'count','new-'+i,'Sentetik sayım','2026-09-09');f.sqlite.exec('COMMIT');
 insert.run('out',p,-1000,-500,'count','out','Depoda doğrulanan sayım eksiği','2026-09-09');
 const first=await f.ok('/ec/stock/history?product='+p);assert.equal(first.rows.length,50);assert.equal(first.pagination.total,257);assert.equal(first.totals.incoming_milli,256000);assert.equal(first.totals.outgoing_milli,1000);assert.equal(first.product.quantity_milli,255000);
 const second=await f.ok('/ec/stock/history?product='+p+'&page=2');assert.ok(!second.rows.some(r=>first.rows.some(x=>x.id===r.id)));
 const old=await f.ok('/ec/stock/history?'+new URLSearchParams({product:p,q:'%_',from:'2025-01-01',to:'2025-12-31'}));assert.equal(old.rows[0].id,'old');assert.equal(old.totals.total,1);assert.equal(old.product.quantity_milli,255000,'Current stock is not historical filtered stock');
 const out=await f.ok('/ec/stock/history?product='+p+'&direction=out');assert.equal(out.rows.length,1);assert.equal(out.rows[0].quantity_milli,-1000);
 assert.equal((await f.req('/ec/stock/history?product='+lp)).status,404);assert.equal((await f.req('/lp/stock/history?product='+p)).status,404);assert.equal((await f.req('/ec/stock/history?product='+p,undefined,'')).status,401);
 assert.equal((await f.ok('/ec/stock/history?'+new URLSearchParams({product:p,q:"' OR 1=1 --"}))).rows.length,0);
 }finally{f.close();}
});
test('Alış fiyatı düzeltmesi geçmişte miktarı değiştirmeden görünür; stok okuma yetkisi yeterlidir',async()=>{
 const f=appFixture();try{await f.setup();
 const p=(await f.ok('/ec/products',{name:'Test torf',sku:'TORF',stock_unit:'adet',min_stock:0})).id;
 const supplier=(await f.ok('/ec/suppliers',{name:'Test tedarikçi'})).id;
 const invoice=(await f.ok('/ec/invoices',{supplier_id:supplier,invoice_no:'TEST-1',invoice_date:'2026-09-09',currency:'TRY',lines:[{description:'Torf',invoice_quantity:10,invoice_unit:'adet',product_id:p,stock_quantity:10,net:100,tax:20,line_type:'product'}]})).id;
 await f.ok('/ec/invoices/'+invoice+'/post',{});const line=(await f.ok('/ec/invoices/'+invoice)).lines[0].id;
 await f.ok('/ec/invoices/'+invoice+'/receive',{occurred_on:'2026-09-09',reference:'TEST-DELIVERY',lines:[{id:line,quantity:10}]});
 await f.ok('/ec/invoices/'+invoice+'/adjustments',{line_id:line,kind:'price',net:20,tax:4,stock_net:20,occurred_on:'2026-09-09',reference:'TEST-DISCOUNT',reason:'Belgeli fiyat farkı'});
 const history=await f.ok('/ec/stock/history?product='+p+'&direction=value');assert.equal(history.rows.length,1);assert.equal(history.rows[0].quantity_milli,0);assert.equal(history.rows[0].value_cents,-2000);assert.equal(history.product.value_cents,8000);
 const all=await f.ok('/ec/stock/history?product='+p);assert.equal(all.totals.value_change_cents,8000);assert.equal(all.totals.incoming_milli,10000);
 const staff=await f.ok('/admin/users',{username:'depo.test',name:'Depo görevlisi',permissions:parsePermissions({ec:{stock:'read'}})});
 await f.ok('/auth/accept-invite',{token:staff.invite_path.split('=')[1],password:'synthetic-staff-password'});
 const login=await f.req('/auth/login',{username:'depo.test',password:'synthetic-staff-password'});
 assert.equal((await f.req('/ec/stock/history?product='+p,undefined,login.cookie)).status,200);assert.equal((await f.req('/lp/stock/history?product='+p,undefined,login.cookie)).status,403);
 assert.equal((await f.req('/ec/stock/history?product='+p,{},login.cookie)).status,403);
 }finally{f.close();}
});
test('Üretim hammadde alış kartı ve depo hareketi aynı geçmişte bir kez görünür',async()=>{
 const f=appFixture();try{await f.setup();const material=(await f.ok('/materials',{name:'Polyester',unit:'kg',price:100})).id;
 f.sqlite.prepare("INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES('mat-open',?,10000,100000,'opening','start','Test açılış','2026-09-09')").run(material);
 const history=await f.ok('/lp/stock/history?product=raw-'+material);assert.equal(history.rows.length,1);assert.equal(history.product.quantity_milli,10000);assert.equal(history.totals.incoming_milli,10000);
 }finally{f.close();}
});
test('Stok geçmişi geçersiz ürün, tarih, yön ve sayfa parametrelerini reddeder',()=>{
 for(const values of [{product:''},{product:'x',from:'2026-02-30'},{product:'x',from:'2026-09-10',to:'2026-09-01'},{product:'x',page:0},{product:'x',page:1.5},{product:'x',direction:'secret'},{product:'x',q:'a'.repeat(201)}])assert.throws(()=>stockHistoryQuery('https://test?'+new URLSearchParams(values)),e=>e.status===400);
});

test('Stok kartı bağlı ilanları ve setleri yalnızca eşleştirme yetkisi olana verir',async()=>{
 const f=appFixture();await f.setup();try{
  const a=(await f.ok('/ec/products',{name:'Bileşen A',sku:'BA-1',stock_unit:'adet',min_stock:0})).id;
  const b=(await f.ok('/ec/products',{name:'Bileşen B',sku:'BB-1',stock_unit:'adet',min_stock:0})).id;
  const supplier=await f.ok('/ec/suppliers',{name:'Tedarikçi A',tax_id:'1234567890',contact:''});
  await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'SET-1',
   components:[{product_id:a,quantity_milli:2000,revenue_share_bps:6000},{product_id:b,quantity_milli:1000,revenue_share_bps:4000}]});
  await f.ok('/ec/catalog/mappings',{source:'purchase',supplier_id:supplier.id,external_code:'MARKA-A',source_unit:'adet',
   components:[{product_id:a,quantity_milli:1000,revenue_share_bps:10000}]});

  const owner=await f.ok('/ec/stock/history?product='+a);
  assert.equal(owner.links.length,2,'yönetici iki bağlantıyı da görmeli');
  const set=owner.links.find(l=>l.external_code==='SET-1');
  assert.equal(set.component_count,2,'set iki bileşenli olmalı');
  assert.equal(set.quantity_milli,2000,'bu üründen set başına 2 adet düşmeli');
  const purchase=owner.links.find(l=>l.external_code==='MARKA-A');
  assert.equal(purchase.supplier_name,'Tedarikçi A');

  const staff=await f.ok('/admin/users',{name:'Depo',username:'depo',permissions:{ec:{stock:'read'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'depo-personel-sifresi'});
  const login=await f.req('/auth/login',{username:'depo',password:'depo-personel-sifresi'});
  const limited=await f.req('/ec/stock/history?product='+a,undefined,login.cookie);
  assert.equal(limited.status,200,'stok yetkisi olan personel kartı açabilmeli');
  assert.deepEqual(limited.data.links,[],'eşleştirme yetkisi olmayana bağlantı verilmemeli');
  assert.ok(limited.data.rows,'stok hareketleri yine dönmeli');
 }finally{f.close();}
});
