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

// ---------------------------------------------------------------------------
// B GRUBU — zarar/kâr eden paket SAYILARI. Tutar null'lanmasi yetmiyordu: "kac paket
// zarar etti" sorusunun cevabi sayinin kendisinde duruyor ve ekranda basiliydi.
// Paket, hesaplanabilen ve eksik SAYILARI is bilgisidir, kalir.
test('Zarar ve kar eden paket sayilari personele gitmez, paket sayilari kalir',()=>{
 const personel={owner:false,ec_access:'read',permissions:{ec:{performance:'read',amounts:'none'},lp:{}}};
 const o=scrubAmounts({
  periods:[{key:'tum',label:'Tüm zamanlar',packages:7,calculated:5,missing:2,losses:2,gains:3,loss_cents:-1200,gain_cents:4500}],
  pending:{packages:2,calculated:2,losses:1,gains:1},
  channels:[{channel:'trendyol',packages:4,calculated:4,cash_calculated:4,losses:1,cash_losses:1,profit_cents:900}],
 },personel,'ec');
 const p=o.periods[0];
 assert.equal(p.losses,null,'zarar eden paket sayisi gizlenmeli');
 assert.equal(p.gains,null,'kar eden paket sayisi gizlenmeli');
 assert.equal(p.loss_cents,null);assert.equal(p.gain_cents,null);
 assert.equal(p.label,'Tüm zamanlar','donem etiketi para degildir');
 assert.equal(p.packages,7,'paket sayisi para degildir');
 assert.equal(p.calculated,5,'hesaplanabilen paket sayisi para degildir');
 assert.equal(p.missing,2,'eksik paket sayisi para degildir');
 assert.equal(o.pending.losses,null);assert.equal(o.pending.gains,null);
 assert.equal(o.pending.packages,2,'kargodaki paket sayisi gorunur');
 assert.equal(o.channels[0].losses,null,'kanal basina zarar sayisi gizlenmeli');
 assert.equal(o.channels[0].cash_losses,null,'kanal basina nakit zarar sayisi gizlenmeli');
 assert.equal(o.channels[0].channel,'trendyol','kanal adi para degildir');
 assert.equal(o.channels[0].packages,4);assert.equal(o.channels[0].cash_calculated,4);
});

// Siparis listesinin kar/zarar SUZGECI, SAYILARI ve paraya gore SIRALAMASI sunucuda
// nakit sonuca gore calisiyordu ve yetki kontrolu yoktu (orders-api.js). Personel
// "Zarar edenler" diyerek zarar eden paketlerin TAMAMINI sayfa sayfa listeletiyordu.
// Tutar yetkisi olmayanda: sayilar null, suzgec yok sayilir, para sirasi tarihe duser.
async function siparisli(){
 const f=appFixture();await f.setup();
 f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet')");
 // KDV orani olmadan nakit sonuc hesaplanamaz; kar/zarar sayilari da bos cikar.
 f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
 f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4600000');
 // Kesinti KDV'si beyan edilmemisse nakit sonuc hesaplanmaz (orders-api.js nakitOzeti).
 f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-ty','trendyol','TY','TY')");
 f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-ty','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
 const paket=(id,gun,{satis=11000,maliyet=4600,kom=1610}={})=>{
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','trendyol','E-${id}','S-${id}','${gun}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Torf 10 L',1000,${satis},${Math.round(satis*1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','trendyol','X-${id}','p1','sale',1000,${satis},${maliyet},${kom},0,0,'confirmed','${gun}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','p1',1000,10000,'s-${id}','adet')`);
  for(const d of ['reserved','shipped'])f.sqlite.exec(`UPDATE ec_order_packages SET status='${d}'${d==='shipped'?",shipped_on='"+gun+"'":''} WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${gun}' WHERE id='${id}'`);
 };
 paket('kar','2026-09-10');                        // cebine kalan artida
 paket('zarar','2026-09-11',{maliyet:20000});      // cebine kalan ekside
 const staff=await f.ok('/admin/users',{name:'Sipariş',username:'siparis',
  permissions:{ec:{orders:'read',amounts:'none'},lp:{},delete_records:false}});
 await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'siparis-personel-sifresi'});
 const login=await f.req('/auth/login',{username:'siparis',password:'siparis-personel-sifresi'});
 return {f,cookie:login.cookie};
}

test('Siparis listesinin kar/zarar suzgeci ve para sirasi tutar yetkisi olmayanda calismaz',async()=>{
 const {f,cookie}=await siparisli();try{
  const hepsi=await f.req('/ec/orders',undefined,cookie);
  assert.equal(hepsi.status,200);
  assert.equal(hepsi.data.sonuc_counts,null,'kar/zarar paket sayilari gonderilmemeli');
  assert.equal(hepsi.data.packages.length,2,'siparisler gorunmeye devam etmeli');

  // SUZGEC YOK SAYILIR: 'zarar' secilse de liste daralmaz, yoksa personel zarar eden
  // paketlerin tam listesini enumere ederdi.
  const suzulmus=await f.req('/ec/orders?sonuc=zarar',undefined,cookie);
  assert.equal(suzulmus.status,200);
  assert.equal(suzulmus.data.packages.length,2,'sonuc suzgeci yok sayilmali');

  // PARA SIRASI TARIHE DUSER: dizilisin kendisi "en cok kaybettiren ustte" bilgisidir.
  const paraSirasi=await f.req('/ec/orders?sort=profit_asc',undefined,cookie);
  assert.equal(paraSirasi.status,200);
  assert.deepEqual(paraSirasi.data.packages.map(p=>p.id),['zarar','kar'],'tarih · yeniden eskiye sirasi');
  const tersi=await f.req('/ec/orders?sort=amount_desc',undefined,cookie);
  assert.deepEqual(tersi.data.packages.map(p=>p.id),['zarar','kar'],'tutara gore siralama da tarihe duser');
  for(const p of hepsi.data.packages)assert.equal(p.cash_result_cents??null,null,'paket tutari gizli kalmali');
 }finally{f.close();}
});

test('Yonetici siparis listesinde kar/zarar sayilarini, suzgeci ve para sirasini aynen gorur',async()=>{
 const {f}=await siparisli();try{
  const hepsi=await f.ok('/ec/orders');
  assert.deepEqual(hepsi.sonuc_counts,{hepsi:2,kar:1,zarar:1},'yoneticide sayilar gelmeli');
  assert.deepEqual((await f.ok('/ec/orders?sonuc=zarar')).packages.map(p=>p.id),['zarar'],'suzgec yoneticide calismali');
  assert.deepEqual((await f.ok('/ec/orders?sort=profit_asc')).packages.map(p=>p.id),['zarar','kar'],'en az kalan ustte');
  assert.deepEqual((await f.ok('/ec/orders?sort=profit_desc')).packages.map(p=>p.id),['kar','zarar'],'en cok kalan ustte');
 }finally{f.close();}
});
