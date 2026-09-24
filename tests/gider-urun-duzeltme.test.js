import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {modules} from '../public/permissions.js';
import {archivedHidden,selectProducts,productList} from '../public/product-list.js';

// YANLIŞ GİRİLEN KAYDIN DÜZELTİLMESİ.
// Defterde kayıt eklemek yetmez: yanlış tutar, yanlış tarih ya da yanlış kategori girilen genel
// gider düzeltilebilmeli; boşuna açılan ürün kartı kaldırılabilmeli. Muhasebe defteri olduğu için
// hiçbir şey körü körüne silinmez:
//  * Yazılmış gider SİLİNMEZ, ARŞİVLENİR. Kayıt yerinde kalır, listeden ve kâr hesabından düşer.
//    Referans mezar taşı olarak durduğu için sabit gider planı aynı ayı ikinci kez ÜRETEMEZ.
//  * Stok hareketinden, sayımdan veya alış faturasından DOĞAN gider elle düzeltilmez; kaynağından
//    düzeltilir.
//  * Hiçbir yerde kullanılmamış ürün kartı silinir; kullanılan kart silinmez, arşivlenir.

const ORIGIN='https://lunapot.test',OWNER='sentetik-sahip-parolasi',PERSONEL='sentetik-personel-parolasi';
const GUN='2026-09-08';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(items){sqlite.exec('BEGIN');try{const r=items.map(s=>s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'gider-urun-duzeltme-kurulum'};let cookie='';
 async function send(path,method='GET',body,auth){
  const response=await worker.fetch(new Request(ORIGIN+'/api'+path,{method,headers:{Origin:ORIGIN,'Content-Type':'application/json',Cookie:auth===undefined?cookie:auth},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
 }
 const post=(path,body,auth)=>send(path,'POST',body,auth);
 const del=(path,auth)=>send(path,'DELETE',undefined,auth);
 async function ok(path,body,auth){const r=body===undefined?await send(path,'GET',undefined,auth):await post(path,body,auth);if(r.status<200||r.status>=300)throw Error(path+' → '+JSON.stringify(r));return r.data;}
 async function setup(){const r=await post('/auth/setup',{token:env.SETUP_TOKEN,password:OWNER});assert.equal(r.status,200,JSON.stringify(r.data));cookie=r.cookie;}
 // Personel: yalnız verilen ekran yetkileriyle giriş yapar. 'delete_records' kalıcı silme onayıdır.
 async function personel(ec={},sil=false,kullanici='sentetik.personel'){
  const izin={ec:Object.fromEntries(Object.keys(modules.ec).map(k=>[k,ec[k]||'none'])),lp:Object.fromEntries(Object.keys(modules.lp).map(k=>[k,'none'])),delete_records:sil};
  const invite=await ok('/admin/users',{name:'Sentetik Ekip',username:kullanici,permissions:izin});
  assert.equal((await post('/auth/accept-invite',{token:invite.invite_path.split('=')[1],password:PERSONEL},'')).status,200);
  return (await post('/auth/login',{username:kullanici,password:PERSONEL},'')).cookie;
 }
 const defter=async()=>ok('/ec?from=2026-01-01&to=2026-12-31');
 const giderSatiri=id=>sqlite.prepare('SELECT * FROM ec_expenses WHERE id=?').get(id)||null;
 return {sqlite,send,post,del,ok,setup,personel,defter,giderSatiri,close:()=>sqlite.close()};
}
async function kurulum(){const f=fixture();await f.setup();return f;}
const gider=(f,body)=>f.ok('/ec/expenses',{reference:'GIDER-1',category:'advertising',amount:100,occurred_on:'2026-09-01',paid:false,notes:'Yanlış girildi',label:'Reklam',...body});
const urun=(f,body)=>f.ok('/ec/products',{name:'Torf 20 L',sku:'T20',stock_unit:'adet',min_stock:0,...body});

test('Yanlış girilen genel gider düzeltilir: tutar, tarih, kategori, ad, açıklama ve ödeme durumu',async()=>{
 const f=await kurulum();try{
  const g=await gider(f);
  await f.ok('/ec/expenses/'+g.id,{category:'rent',amount:250.5,occurred_on:'2026-09-05',paid:true,notes:'Depo kirası',label:'Kira'});
  const satir=f.giderSatiri(g.id);
  assert.equal(satir.amount_cents,25050,'tutar kuruşa çevrilip güncellenmeli');
  assert.equal(satir.occurred_on,'2026-09-05');
  assert.equal(satir.category,'rent');
  assert.equal(satir.label,'Kira');
  assert.equal(satir.notes,'Depo kirası');
  assert.equal(satir.paid,1,'ödenmedi kaydedilip sonra ödenen gider işaretlenebilmeli');
  assert.equal(satir.reference,'GIDER-1','referans defterin tekil anahtarıdır, düzeltmede değişmez');
  const liste=(await f.defter()).expenses.filter(x=>x.id===g.id);
  assert.equal(liste.length,1);assert.equal(liste[0].amount_cents,25050);
 }finally{f.close();}
});

test('Gider düzeltmesi geçersiz değer kabul etmez ve olmayan kayıt 404 verir',async()=>{
 const f=await kurulum();try{
  const g=await gider(f);
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'loss',amount:10,occurred_on:'2026-09-05',paid:false})).status,400,'sayım kaybı elle seçilemez');
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:-5,occurred_on:'2026-09-05',paid:false})).status,400,'eksi tutar olmaz');
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:10,occurred_on:'05.09.2026',paid:false})).status,400,'tarih biçimi denetlenmeli');
  assert.equal((await f.post('/ec/expenses/olmayan-kayit',{category:'rent',amount:10,occurred_on:'2026-09-05',paid:false})).status,404);
  assert.equal(f.giderSatiri(g.id).amount_cents,10000,'reddedilen düzeltme kaydı değiştirmemeli');
 }finally{f.close();}
});

test('Silinen gider arşivlenir: listeden düşer, kayıt durur, geri alınabilir',async()=>{
 const f=await kurulum();try{
  const g=await gider(f);
  assert.equal((await f.defter()).expenses.length,1);
  const sil=await f.del('/ec/expenses/'+g.id);
  assert.equal(sil.status,200,JSON.stringify(sil.data));
  assert.equal(sil.data.archived,true,'silme işlemi arşivleme olduğunu bildirmeli');
  assert.equal((await f.defter()).expenses.length,0,'arşivlenen gider kâr hesabından düşmeli');
  const satir=f.giderSatiri(g.id);
  assert.ok(satir,'muhasebe kaydı defterden yok edilmez');
  assert.ok(satir.archived_at,'arşiv zamanı yazılmalı');
  assert.equal((await f.del('/ec/expenses/'+g.id)).status,404,'ikinci silme yeni bir şey yapmaz');
  await f.ok('/ec/expenses/'+g.id+'/restore',{});
  assert.equal((await f.defter()).expenses.length,1,'geri alınan gider listeye döner');
  assert.equal(f.giderSatiri(g.id).archived_at,null);
 }finally{f.close();}
});

test('Arşivlenen gider düzeltilemez; önce geri alınır',async()=>{
 const f=await kurulum();try{
  const g=await gider(f);
  await f.del('/ec/expenses/'+g.id);
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:5,occurred_on:'2026-09-05',paid:false})).status,409);
 }finally{f.close();}
});

test('Arşivlenen sabit gider ayı üretimde geri gelmez',async()=>{
 const f=await kurulum();try{
  await f.ok('/ec/expense-schedules',{label:'Kira',category:'rent',amount:15000,day_of_month:1,starts_on:'2026-07-01'});
  assert.equal((await f.ok('/ec/expense-schedules/generate',{through:'2026-09-30'})).created,3);
  const temmuz=f.sqlite.prepare("SELECT id FROM ec_expenses WHERE occurred_on='2026-07-01'").get();
  await f.del('/ec/expenses/'+temmuz.id);
  assert.equal((await f.ok('/ec/expense-schedules/generate',{through:'2026-09-30'})).created,0,'arşivlenen ay ikinci kez ÜRETİLMEMELİ');
  assert.equal((await f.defter()).expenses.filter(x=>String(x.reference).startsWith('GIDER-PLAN-')).length,2);
 }finally{f.close();}
});

test('Stok sayımından ve alış faturasından doğan gider elle düzeltilemez, silinemez',async()=>{
 const f=await kurulum();try{
  const p=await urun(f);
  await f.ok('/ec/stock',{product_id:p.id,quantity:10,unit_cost:20,kind:'opening',reference:'ACILIS',notes:'Açılış',occurred_on:GUN});
  await f.ok('/ec/stock',{product_id:p.id,quantity:8,kind:'count',reference:'SAYIM-1',notes:'İki torba eksik',occurred_on:GUN});
  const kayip=f.sqlite.prepare("SELECT * FROM ec_expenses WHERE category='loss'").get();
  assert.ok(kayip,'sayım farkı gideri oluşmalı');
  assert.equal((await f.post('/ec/expenses/'+kayip.id,{category:'other',amount:1,occurred_on:GUN,paid:false})).status,409);
  assert.equal((await f.del('/ec/expenses/'+kayip.id)).status,409);
  assert.equal(f.giderSatiri(kayip.id).archived_at,null,'kaynağa bağlı gider yerinde kalmalı');

  const s=await f.ok('/ec/suppliers',{name:'Kargo A.Ş.',tax_id:'1234567890'});
  const fatura=await f.ok('/ec/invoices',{supplier_id:s.id,invoice_no:'H-1',invoice_date:GUN,currency:'TRY',lines:[{description:'Nakliye hizmeti',invoice_quantity:1,invoice_unit:'adet',net:500,tax:100,line_type:'expense',expense_category:'shipping',expense_treatment:'general'}]});
  await f.ok('/ec/invoices/'+fatura.id+'/post',{});
  const faturaGideri=f.sqlite.prepare("SELECT * FROM ec_expenses WHERE reference LIKE 'invoice-%'").get();
  assert.ok(faturaGideri,'faturanın genel gider satırı gidere yazılmalı');
  assert.equal((await f.post('/ec/expenses/'+faturaGideri.id,{category:'other',amount:1,occurred_on:GUN,paid:false})).status,409);
  assert.equal((await f.del('/ec/expenses/'+faturaGideri.id)).status,409);
 }finally{f.close();}
});

test('Hiç kullanılmamış e-ticaret ürün kartı silinir',async()=>{
 const f=await kurulum();try{
  const p=await urun(f,{name:'Yanlışlıkla açılan kart',sku:'YANLIS-1'});
  assert.equal((await f.defter()).stock.length,1);
  const sil=await f.del('/ec/products/'+p.id);
  assert.equal(sil.status,200,JSON.stringify(sil.data));
  assert.equal((await f.defter()).stock.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_products').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_balances').get().n,0,'kartla birlikte boş bakiye satırı da gitmeli');
  assert.equal((await f.del('/ec/products/'+p.id)).status,404);
 }finally{f.close();}
});

test('Stok hareketi olan ürün silinemez; stok sıfırlanınca arşivlenir ve geri alınabilir',async()=>{
 const f=await kurulum();try{
  const p=await urun(f);
  await f.ok('/ec/stock',{product_id:p.id,quantity:10,unit_cost:20,kind:'opening',reference:'ACILIS',notes:'Açılış',occurred_on:GUN});
  const sil=await f.del('/ec/products/'+p.id);
  assert.equal(sil.status,409);
  assert.match(sil.data.error,/stok hareketi/i,'engelin nedeni Türkçe anlatılmalı');
  const erkenArsiv=await f.post('/ec/products/'+p.id+'/archive',{});
  assert.equal(erkenArsiv.status,409,'deposunda mal duran kart arşivlenip gizlenemez');
  assert.match(erkenArsiv.data.error,/sto[kğ]u/i,'engelin nedeni Türkçe anlatılmalı');

  await f.ok('/ec/stock',{product_id:p.id,quantity:0,kind:'count',reference:'SAYIM-SIFIR',notes:'Kart kapatılıyor',occurred_on:GUN});
  const arsiv=await f.post('/ec/products/'+p.id+'/archive',{});
  assert.equal(arsiv.status,200,JSON.stringify(arsiv.data));
  const defter=await f.defter();
  assert.ok(defter.stock.find(x=>x.id===p.id).archived_at,'kart arşiv damgası taşımalı');
  assert.equal(selectProducts(defter.stock,{}).length,0,'arşivlenen kart ürün listesinden düşer');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_movements WHERE product_id=?').get(p.id).n,2,'geçmiş hareketler korunur');
  assert.equal((await f.post('/ec/products/'+p.id+'/archive',{})).status,409,'zaten arşivli kart ikinci kez arşivlenmez');
  await f.ok('/ec/products/'+p.id+'/restore',{});
  assert.equal(selectProducts((await f.defter()).stock,{}).length,1,'geri alınan kart listeye döner');
 }finally{f.close();}
});

test('Arşiv gerçek stoğu gizlemez: mal geri gelen arşivli kart listede yeniden görünür',async()=>{
 const f=await kurulum();try{
  const p=await urun(f);
  await f.ok('/ec/products/'+p.id+'/archive',{});
  assert.equal(selectProducts((await f.defter()).stock,{}).length,0);
  await f.ok('/ec/stock',{product_id:p.id,quantity:4,unit_cost:20,kind:'count',reference:'IADE-GIRIS',notes:'İade döndü',occurred_on:GUN});
  const liste=selectProducts((await f.defter()).stock,{});
  assert.equal(liste.length,1,'deposunda mal duran arşivli kart gizlenmez');
  assert.ok(liste[0].archived_at,'kart arşivli olduğunu göstermeye devam eder');
 }finally{f.close();}
});

test('Satışı, ilan eşleşmesi veya fatura satırı olan ürün silinemez',async()=>{
 const f=await kurulum();try{
  const ilanli=await urun(f,{name:'İlana bağlı ürün',sku:'ILAN-1'});
  await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'TY-1',components:[{product_id:ilanli.id,quantity_milli:1000,revenue_share_bps:10000}]});
  const ilanSil=await f.del('/ec/products/'+ilanli.id);
  assert.equal(ilanSil.status,409);
  assert.match(ilanSil.data.error,/eşleşme/i);

  const faturali=await urun(f,{name:'Faturaya bağlı ürün',sku:'FAT-1'});
  const s=await f.ok('/ec/suppliers',{name:'Torf Tedarikçisi',tax_id:'1234567890'});
  const fatura=await f.ok('/ec/invoices',{supplier_id:s.id,invoice_no:'F-1',invoice_date:GUN,currency:'TRY',lines:[{description:'Torf',invoice_quantity:10,invoice_unit:'adet',net:300,tax:60,product_id:faturali.id,stock_quantity:10}]});
  assert.ok(fatura.id);
  const faturaSil=await f.del('/ec/products/'+faturali.id);
  assert.equal(faturaSil.status,409);
  assert.match(faturaSil.data.error,/fatura/i);
  // Taslak fatura henüz stok hareketi yazmadı; kart yine de arşivlenebilir.
  assert.equal((await f.post('/ec/products/'+faturali.id+'/archive',{})).status,200);
 }finally{f.close();}
});

test('Üretim alanında e-ticaret ürün silme ve arşiv uçları çalışmaz',async()=>{
 const f=await kurulum();try{
  const p=await urun(f);
  assert.equal((await f.del('/lp/products/'+p.id)).status,404);
  assert.equal((await f.post('/lp/products/'+p.id+'/archive',{})).status,404);
 }finally{f.close();}
});

test('Gider ve ürün düzeltmesi yetkiye bağlıdır; kalıcı silme ayrı onay ister',async()=>{
 const f=await kurulum();try{
  const g=await gider(f);
  const p=await urun(f);
  // Yalnız ilgisiz bir ekranı görebilen personel: gider ve ürün kartına dokunamaz.
  const bos=await f.personel({orders:'read'},false,'sentetik.yetkisiz');
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:5,occurred_on:GUN,paid:false},bos)).status,403);
  assert.equal((await f.del('/ec/expenses/'+g.id,bos)).status,403);
  assert.equal((await f.del('/ec/products/'+p.id,bos)).status,403);
  assert.equal((await f.post('/ec/products/'+p.id+'/archive',{},bos)).status,403);

  const kisitli=await f.personel({expenses:'write',stock:'write'},false,'sentetik.kisitli');
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:5,occurred_on:GUN,paid:false},kisitli)).status,200,'gideri düzeltebilmeli');
  assert.equal((await f.del('/ec/expenses/'+g.id,kisitli)).status,403,'kalıcı silme onayı olmadan silemez');
  assert.equal((await f.del('/ec/products/'+p.id,kisitli)).status,403);
  assert.equal((await f.post('/ec/products/'+p.id+'/archive',{},kisitli)).status,200,'arşivleme ekran yetkisiyle yapılır');

  // Arsivlenen gider listesi de ekranin kendi yetkisinden gecer.
  assert.equal((await f.send('/ec/expenses/archived','GET',undefined,bos)).status,403,'gider yetkisi olmayan arşivi okuyamaz');
  assert.equal((await f.send('/ec/expenses/archived','GET',undefined,kisitli)).status,200);
  const okuyan=await f.personel({expenses:'read',stock:'read'},true,'sentetik.okuyan');
  assert.equal((await f.send('/ec/expenses/archived','GET',undefined,okuyan)).status,200,'okuma yetkisi arşivi görmeye yeter');
  assert.equal((await f.post('/ec/expenses/'+g.id+'/restore',{},okuyan)).status,403,'okuma yetkisi geri alamaz');
  assert.equal((await f.post('/ec/expenses/'+g.id,{category:'rent',amount:5,occurred_on:GUN,paid:false},okuyan)).status,403);
  assert.equal((await f.del('/ec/expenses/'+g.id,okuyan)).status,403);
 }finally{f.close();}
});

// URUN LISTESI ISLEM DUGMELERI. Arsivleme ve silme ayri islemlerdir; ikisi de onay penceresi acar
// (data-ac kancasi). Uretim alaninda (editable:false) kart kaldirma dugmesi hic cizilmez.
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const helpers={esc,money:v=>v==null?'Tutar bilinmiyor':(v/100).toFixed(2)+' TL',qty:v=>String(v/1000)};
const kart=(extra={})=>({id:'A',name:'Torf',sku:'T20',brand:'Tropikal',category:'Besin',stock_unit:'adet',min_stock_milli:0,quantity_milli:0,on_hand_milli:0,reserved_milli:0,available_milli:0,in_transit_milli:0,in_transit_known_milli:0,in_transit_status:'complete',in_transit_notes:[],value_cents:0,vat_bps:2000,average_purchase_cents:null,...extra});

test('Ürün listesi arşivleme ve silme düğmelerini onaylı akışa bağlar',()=>{
 const data={sales:[],suppliers:[],productStats:null};
 for(const stockView of ['cards','table']){
  const html=productList([kart()],data,{stockView},{...helpers,editable:true});
  for(const parca of ['data-ac="archive-product"','data-ac="delete-product"','data-ac="edit-product"'])assert.ok(html.includes(parca),parca);
  assert.ok(!html.includes('data-ac="restore-product"'));
  const arsivli=productList([kart({archived_at:'2026-09-08 10:00:00',quantity_milli:4000,on_hand_milli:4000,available_milli:4000,value_cents:8000})],data,{stockView},{...helpers,editable:true});
  assert.ok(arsivli.includes('data-ac="restore-product"'),'arşivli kartta geri alma düğmesi olmalı');
  assert.ok(!arsivli.includes('data-ac="delete-product"'),'arşivli kartta silme düğmesi çıkmaz');
  assert.match(arsivli,/Arşivli/,'arşiv durumu ekranda yazılır');
  const uretim=productList([kart()],data,{stockView},{...helpers,editable:false});
  assert.ok(!uretim.includes('data-ac="archive-product"')&&!uretim.includes('data-ac="delete-product"'),'üretim alanında kart kaldırma yok');
 }
});

test('Arşiv süzgeci yalnız boş deposu olan kartı gizler',()=>{
 assert.equal(archivedHidden(kart()),false,'arşivlenmemiş kart gizlenmez');
 assert.equal(archivedHidden(kart({archived_at:'2026-09-08'})),true);
 assert.equal(archivedHidden(kart({archived_at:'2026-09-08',quantity_milli:1000,on_hand_milli:1000})),false,'malı olan arşivli kart gizlenmez');
 assert.equal(archivedHidden(kart({archived_at:'2026-09-08',value_cents:500})),false,'değeri olan arşivli kart gizlenmez');
 assert.equal(archivedHidden(kart({archived_at:'2026-09-08',quantity_milli:null,on_hand_milli:null})),false,'miktarı bilinmeyen kart gizlenmez');
});
