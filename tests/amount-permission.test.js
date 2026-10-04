import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {level} from '../public/permissions.js';
import {scrubAmounts} from '../src/permission-policy.js';
import worker from '../src/worker.js';

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

// Denetim bulgulari: tutar yetkisi olmayan personel bir kisim parayi DOGRUDAN okuyordu.
// Gizleme anahtar bazli calistigi icin rapor alan adlari (sale/net_payout), ham JSON metni,
// tahmin satiri, recete gider kolonlari ve serbest metne gomulu tutarlar suzgecten kurtuluyordu.
// Genel ad kumesi kullanilamaz: ayni adlar baska yanitlarda TUR ETIKETIDIR (kinds.sale,
// categories.packaging, basis.withholding), bu yuzden gizleme kapsayici/sema bazlidir.
// Asagidaki testler ikisini birlikte tutar: para gider, etiket kalir.
test('Rapor alan adlari yalniz rapor kapsayicisinda gizlenir, tur etiketleri bozulmaz',()=>{
 const personel={owner:false,ec_access:'read',permissions:{ec:{orders:'read',amounts:'none'},lp:{}}};
 const o=scrubAmounts({
  totals:{sale:123456,refund:-500,cargo:7000,service:300,withholding:120,other_fee:50,net_payout:99999,n:12},
  reviews:[{row:3,incoming:{sale:5000,net_payout:4200},prior:{sale:4000}}],
  kinds:{sale:'Satis finans kayitlari',packaging:'Ambalaj'},
  basis:{withholding:'deduction_positive'},
 },personel,'ec');
 for(const key of ['sale','refund','cargo','service','withholding','other_fee','net_payout'])assert.equal(o.totals[key],null,key+' gizlenmeli');
 assert.equal(o.totals.n,12,'satir sayisi para degildir');
 assert.equal(o.reviews[0].incoming.sale,null);assert.equal(o.reviews[0].incoming.net_payout,null);
 assert.equal(o.reviews[0].prior.sale,null);assert.equal(o.reviews[0].row,3);
 assert.equal(o.kinds.sale,'Satis finans kayitlari','tur etiketi para degildir');
 assert.equal(o.kinds.packaging,'Ambalaj');
 assert.equal(o.basis.withholding,'deduction_positive','sema metadatasi para degildir');
});

test('Tahmin satiri, recete giderleri ve dondurulmus recete metni personele gitmez',()=>{
 const personel={owner:false,lp_access:'read',permissions:{ec:{},lp:{recipes:'write',amounts:'none'}}};
 const o=scrubAmounts({
  results:[{estimates:[{type:'commission',basis:'rapor',value:1550,low:1400,high:1700}]}],
  recipes:[{id:'r1',product_id:'p1',yield_qty:2,waste_pct:5,labor:250,packaging:40,overhead:10,notes:'not'}],
  jobs:[{id:'j1',recipe_json:'{"labor":250}',quantity_milli:5000,status:'posted'}],
 },personel,'lp');
 const est=o.results[0].estimates[0];
 assert.equal(est.value,null);assert.equal(est.low,null);assert.equal(est.high,null);
 assert.equal(est.type,'commission','kesinti turu para degildir');
 for(const key of ['labor','packaging','overhead'])assert.equal(o.recipes[0][key],null,key+' gizlenmeli');
 assert.equal(o.recipes[0].yield_qty,2,'uretim adedi para degildir');
 assert.equal(o.recipes[0].waste_pct,5);
 assert.equal(o.jobs[0].recipe_json,null,'metnin ici acilamadigi icin tamami gizlenir');
 assert.equal(o.jobs[0].quantity_milli,5000);
});

test('Serbest metne gomulu tutar maskelenir, siparis numarasi ve adet bozulmaz',()=>{
 const personel={owner:false,ec_access:'read',permissions:{ec:{orders:'read',amounts:'none'},lp:{}}};
 const o=scrubAmounts({
  results:[{notes:['Raporun bildirdigi hakedis (1.023,75 TL) toplamla (998,50 TL) uyusmuyor.','Siparis 1872497924 paketi 9935461 kaleminde.']}],
  skipped:[{reason:'Tutar 12.450,00 TL oldugu icin atlandi'}],
 },personel,'ec');
 assert.doesNotMatch(o.results[0].notes[0],/1\.023,75|998,50/,'tutar metinden silinmeli');
 assert.match(o.results[0].notes[0],/hakedis/,'isletme anlami korunmali');
 assert.equal(o.results[0].notes[1],'Siparis 1872497924 paketi 9935461 kaleminde.','numaralar dokunulmaz');
 assert.doesNotMatch(o.skipped[0].reason,/12\.450,00/);
 assert.match(o.skipped[0].reason,/atlandi/);
});

test('Yonetici ve tutar yetkisi olan personel bu alanlari aynen gorur',()=>{
 const yanit={totals:{sale:123456,net_payout:99999},recipes:[{yield_qty:1,waste_pct:0,labor:250,packaging:40,overhead:10}],
  jobs:[{recipe_json:'{"labor":250}'}],results:[{notes:['Fark 25,25 TL'],estimates:[{type:'c',basis:'r',value:5}]}]};
 for(const kullanici of [{owner:true},{owner:false,lp_access:'read',ec_access:'read',permissions:{ec:{orders:'read',amounts:'read'},lp:{recipes:'read',amounts:'read'}}}]){
  const o=scrubAmounts(yanit,kullanici,'ec');
  assert.equal(o.totals.sale,123456);assert.equal(o.recipes[0].labor,250);
  assert.equal(o.jobs[0].recipe_json,'{"labor":250}');
  assert.equal(o.results[0].notes[0],'Fark 25,25 TL');assert.equal(o.results[0].estimates[0].value,5);
 }
});

// Gizleme tek basina yetmez: gider alanlari null dondugu icin personelin kaydi onlari
// SIFIRLAMAMALI. Arayuz kutulari hic basmaz, sunucu da gonderilmeyen alanda saklanani korur.
test('Tutar yetkisi olmayan personel receteyi duzenler ama giderleri sifirlayamaz',async()=>{
 const f=appFixture();await f.setup();
 try{
  const product=(await f.ok('/products',{name:'Mamul',sku:'M-1',stock_unit:'adet',sale_price:100,inventory_kind:'finished'})).id;
  const material=(await f.ok('/materials',{name:'Torf',unit:'kg',price:5,supplier:''})).id;
  const recipe=(await f.ok('/recipes',{product_id:product,yield_qty:1,waste_pct:0,labor:250,packaging:40,overhead:10,notes:'',
   items:[{material_id:material,quantity:2,unit:'kg'}]})).id;
  const staff=await f.ok('/admin/users',{name:'Uretim',username:'uretimci',
   permissions:{ec:{},lp:{recipes:'write',materials:'read',products:'read',amounts:'none'},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'uretim-personel-sifresi'});
  const cookie=(await f.req('/auth/login',{username:'uretimci',password:'uretim-personel-sifresi'})).cookie;

  const gorunum=await f.req('/data',undefined,cookie);
  assert.equal(gorunum.status,200);
  const gizli=gorunum.data.recipes.find(r=>r.id===recipe);
  assert.equal(gizli.labor,null,'gider personele gizli');
  assert.equal(gizli.yield_qty,1,'uretim adedi gorunur');

  const origin='https://lunapot.test';
  const put=async(path,body,auth)=>{
   const r=await worker.fetch(new Request(origin+'/api'+path,{method:'PUT',
    headers:{Origin:origin,'Content-Type':'application/json',Cookie:auth},body:JSON.stringify(body)}),f.env);
   return {status:r.status,data:await r.json().catch(()=>null)};
  };
  const kayit=await put('/recipes/'+recipe,{product_id:product,yield_qty:1,waste_pct:0,notes:'personel duzenledi',
   items:[{material_id:material,quantity:3,unit:'kg'}]},cookie);
  assert.equal(kayit.status,200,'personel receteyi kaydedebilmeli: '+JSON.stringify(kayit.data));
  const sonra=(await f.req('/data')).data.recipes.find(r=>r.id===recipe);
  assert.equal(sonra.labor,250,'iscilik korunmali');
  assert.equal(sonra.packaging,40,'ambalaj korunmali');
  assert.equal(sonra.overhead,10,'diger gider korunmali');
  assert.equal(sonra.items.find(i=>i.material_id===material).quantity,3,'personelin miktar degisikligi uygulanmali');
 }finally{f.close();}
});
