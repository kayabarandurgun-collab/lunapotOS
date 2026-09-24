import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {modules} from '../public/permissions.js';
import {cardActions} from '../public/business-ui.js';

// YANLIŞ GİRİLEN CARİ ve KASA/BANKA HESABININ DÜZELTİLMESİ.
// Canlı denetimde iki eksik doğrulandı: her iki kartta da "ekle" vardı, "düzelt/sil" yoktu.
// Yanlış yazılan cari adı/VKN/telefon/adres ve yanlış açılan kasa hesabı defterde ilelebet
// kalıyordu. Bu dosya düzeltme, arşivleme ve silme kurallarını sınar:
//  * Defter kaydı körü körüne silinmez. Hareketi, faturası ya da belgesi olan cari SİLİNMEZ,
//    arşivlenir; hareketi olan kasa/banka hesabı da öyle.
//  * Hiçbir yerde kullanılmamış kart gerçekten silinir.
//  * Arşivli kart YENİ seçim listelerinde çıkmaz ama geçmiş hareketlerde ve bakiyede durur.
//  * Kalıcı silme, ekran yetkisine ek olarak "kalıcı kayıt silme" onayı ister.
// KAPSAM DIŞI: iki cariyi tek kayda indirgeyen cari birleştirme bu görevde yoktur.

const ORIGIN='https://lunapot.test',OWNER='sentetik-sahip-parolasi',PERSONEL='sentetik-personel-parolasi';
const GUN='2026-09-09';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(items){sqlite.exec('BEGIN');try{const r=items.map(s=>s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'cari-hesap-duzeltme-kurulum'};let cookie='';
 async function send(path,method='GET',body,auth){
  const response=await worker.fetch(new Request(ORIGIN+'/api'+path,{method,headers:{Origin:ORIGIN,'Content-Type':'application/json',Cookie:auth===undefined?cookie:auth},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
 }
 const post=(path,body,auth)=>send(path,'POST',body,auth);
 const del=(path,auth)=>send(path,'DELETE',undefined,auth);
 async function ok(path,body,auth){const r=body===undefined?await send(path,'GET',undefined,auth):await post(path,body,auth);if(r.status<200||r.status>=300)throw Error(path+' → '+JSON.stringify(r));return r.data;}
 async function setup(){const r=await post('/auth/setup',{token:env.SETUP_TOKEN,password:OWNER});assert.equal(r.status,200,JSON.stringify(r.data));cookie=r.cookie;}
 // Personel: yalnız verilen ekran yetkileriyle girer. 'delete_records' kalıcı silme onayıdır.
 async function personel(ec={},sil=false,kullanici='sentetik.personel'){
  const izin={ec:Object.fromEntries(Object.keys(modules.ec).map(k=>[k,ec[k]||'none'])),lp:Object.fromEntries(Object.keys(modules.lp).map(k=>[k,'none'])),delete_records:sil};
  const invite=await ok('/admin/users',{name:'Sentetik Ekip',username:kullanici,permissions:izin});
  assert.equal((await post('/auth/accept-invite',{token:invite.invite_path.split('=')[1],password:PERSONEL},'')).status,200);
  return (await post('/auth/login',{username:kullanici,password:PERSONEL},'')).cookie;
 }
 const defter=()=>ok('/ec/ledger');
 const cari=key=>sqlite.prepare('SELECT * FROM ec_suppliers WHERE id=?').get(key)||null;
 const hesap=key=>sqlite.prepare('SELECT * FROM ec_cash_accounts WHERE id=?').get(key)||null;
 return {sqlite,send,post,del,ok,setup,personel,defter,cari,hesap,close:()=>sqlite.close()};
}

async function kurulum(){const f=fixture();await f.setup();return f;}
const yeniCari=(f,body)=>f.ok('/ec/ledger/parties',{name:'Torf Tedarikçisi',kind:'supplier',...body});
const yeniHesap=(f,body)=>f.ok('/ec/ledger/accounts',{name:'Ana Kasa',kind:'cash',...body});
// Muhasebeleşen alış faturası hem purchase_invoices hem party_entries satırı yazar: cari kullanımdadır.
async function faturaliCari(f,no='F-1'){
 const parti=await yeniCari(f,{name:'Torf Tedarikçisi',tax_id:'1234567890'});
 const urun=(await f.ok('/ec/products',{name:'Torf',sku:'T-1',stock_unit:'adet',min_stock:0})).id;
 const fatura=(await f.ok('/ec/invoices',{supplier_id:parti.id,invoice_no:no,invoice_date:GUN,currency:'TRY',
  lines:[{description:'Torf',external_code:'T',invoice_quantity:1,invoice_unit:'adet',product_id:urun,stock_quantity:1,net:1000,tax:200}]})).id;
 await f.ok('/ec/invoices/'+fatura+'/post',{});
 return {parti,urun,fatura};
}

test('Yanlış girilen cari düzeltilir: ad, tür, VKN, yetkili, telefon, e-posta ve adres',async()=>{
 const f=await kurulum();try{
  const p=await yeniCari(f,{name:'Torf Tedraikçisi',tax_id:'1234567890',phone:'0000',contact:'Yanlış Kişi',email:'yanlis@ornek.test',address:'Yanlış adres'});
  const sonuc=await f.ok('/ec/ledger/parties/'+p.id,{name:'Torf Tedarikçisi A.Ş.',kind:'customer',tax_id:'9876543210',
   contact:'Ayşe Yılmaz',phone:'0212 000 00 00',email:'muhasebe@ornek.test',address:'Organize Sanayi, İstanbul'});
  assert.equal(sonuc.id,p.id);
  const satir=f.cari(p.id);
  assert.equal(satir.name,'Torf Tedarikçisi A.Ş.','ad düzeltilebilmeli');
  assert.equal(satir.kind,'customer','cari türü düzeltilebilmeli');
  assert.equal(satir.tax_id,'9876543210','VKN düzeltilebilmeli');
  assert.equal(satir.contact,'Ayşe Yılmaz');
  assert.equal(satir.phone,'0212 000 00 00');
  assert.equal(satir.email,'muhasebe@ornek.test');
  assert.equal(satir.address,'Organize Sanayi, İstanbul');
  assert.equal(satir.archived_at,null,'düzeltme arşive atmaz');
  const d=await f.defter();
  assert.equal(d.parties.find(x=>x.id===p.id).name,'Torf Tedarikçisi A.Ş.','liste yeni adı göstermeli');

  // VKN boşaltılabilir; boş VKN tabloda NULL durur ki tekillik kısıtı ikinci boş kaydı engellemesin.
  await f.ok('/ec/ledger/parties/'+p.id,{name:'Torf Tedarikçisi A.Ş.',kind:'customer',tax_id:''});
  assert.equal(f.cari(p.id).tax_id,null,'VKN silinebilmeli');
 }finally{f.close();}
});

test('Cari düzeltmesi geçersiz değeri ve başkasının vergi numarasını kabul etmez; olmayan kayıt 404 verir',async()=>{
 const f=await kurulum();try{
  const a=await yeniCari(f,{name:'Torf Tedarikçisi',tax_id:'1234567890'});
  const b=await yeniCari(f,{name:'Ambalaj Tedarikçisi',tax_id:'1234567891'});
  assert.equal((await f.post('/ec/ledger/parties/'+a.id,{name:'',kind:'supplier'})).status,400,'boş ad kabul edilmemeli');
  assert.equal((await f.post('/ec/ledger/parties/'+a.id,{name:'Torf',kind:'baska'})).status,400,'tanınmayan tür kabul edilmemeli');
  assert.equal((await f.post('/ec/ledger/parties/'+a.id,{name:'Torf',kind:'supplier',tax_id:'12'})).status,400,'kısa VKN kabul edilmemeli');
  const cakisma=await f.post('/ec/ledger/parties/'+a.id,{name:'Torf',kind:'supplier',tax_id:'1234567891'});
  assert.equal(cakisma.status,409,'aynı VKN iki caride olamaz');
  assert.match(cakisma.data.error,/Ambalaj Tedarikçisi/,'hangi caride kayıtlı olduğu söylenmeli');
  assert.equal(f.cari(a.id).tax_id,'1234567890','reddedilen düzeltme kaydı bozmamalı');
  assert.equal(f.cari(b.id).name,'Ambalaj Tedarikçisi');
  assert.equal((await f.post('/ec/ledger/parties/olmayan-kayit',{name:'X',kind:'supplier'})).status,404);
 }finally{f.close();}
});

test('Vergi numarası değişince fatura mükerrer denetimi ve kayıtlı mutabakat için uyarı verilir',async()=>{
 const f=await kurulum();try{
  const {parti}=await faturaliCari(f);
  await f.ok('/ec/statement/documents',{party_id:parti.id,from:'2026-09-01',to:'2026-09-30'});
  const sonuc=await f.ok('/ec/ledger/parties/'+parti.id,{name:'Torf Tedarikçisi',kind:'supplier',tax_id:'9876543210'});
  assert.ok(Array.isArray(sonuc.warnings)&&sonuc.warnings.length,'kimlik alanı değişince uyarı dönmeli');
  assert.match(sonuc.warnings.join(' '),/VKN/,'uyarı VKN değişimini anmalı');
  assert.match(sonuc.warnings.join(' '),/mutabakat/i,'kayıtlı mutabakat belgesi için de uyarılmalı');
  assert.equal(f.cari(parti.id).tax_id,'9876543210','uyarı kaydı engellemez');

  // Yalnız telefon düzeltmesi kimlik değiştirmez: gereksiz uyarı üretilmez.
  const sade=await f.ok('/ec/ledger/parties/'+parti.id,{name:'Torf Tedarikçisi',kind:'supplier',tax_id:'9876543210',phone:'0212 111 11 11'});
  assert.deepEqual(sade.warnings,[],'kimlik değişmediyse uyarı olmamalı');
 }finally{f.close();}
});

test('Hareketi olan cari silinemez; arşivlenir, yeni kayıtta seçilemez, geçmişi durur',async()=>{
 const f=await kurulum();try{
  const {parti}=await faturaliCari(f);
  const sil=await f.del('/ec/ledger/parties/'+parti.id);
  assert.equal(sil.status,409,'defterde izi olan cari silinemez');
  assert.match(sil.data.error,/fatura|hareket/i,'hangi bağlantının engellediği söylenmeli');
  assert.match(sil.data.error,/arşiv/i,'kullanıcıya arşivleme önerilmeli');
  assert.ok(f.cari(parti.id),'reddedilen silme kaydı bırakmalı');

  const arsiv=await f.ok('/ec/ledger/parties/'+parti.id+'/archive',{});
  assert.equal(arsiv.archived,true);
  assert.ok(f.cari(parti.id).archived_at,'arşiv zamanı yazılmalı');
  assert.equal((await f.post('/ec/ledger/parties/'+parti.id+'/archive',{})).status,409,'zaten arşivli kayıt ikinci kez arşivlenmez');

  // Arşiv geçmişi gizlemez: bakiye ve hareketler yerinde durur.
  const d=await f.defter();
  const kart=d.parties.find(x=>x.id===parti.id);
  assert.ok(kart,'arşivli cari listeden silinmemeli');
  assert.ok(kart.archived_at,'liste arşiv işaretini taşımalı');
  assert.equal(kart.balance_cents,-120000,'arşivlenen carinin bakiyesi değişmemeli');
  assert.ok(d.entries.some(e=>e.party_id===parti.id),'geçmiş hareketler durmalı');

  // Yeni kayıt yazılamaz: hareket, ödeme ve kasa/banka bağlantısı reddedilir.
  const hareket=await f.post('/ec/ledger/entries',{party_id:parti.id,amount:100,occurred_on:GUN,reference:'CARI-1',description:'Deneme'});
  assert.equal(hareket.status,409,'arşivli cariye yeni hareket yazılamaz');
  assert.match(hareket.data.error,/arşiv/i);
  const kasa=await yeniHesap(f);
  assert.equal((await f.post('/ec/ledger/payments',{party_id:parti.id,amount:100,occurred_on:GUN,method:'nakit',account_id:kasa.id})).status,409,'arşivli cariye ödeme yazılamaz');
  assert.equal((await f.post('/ec/ledger/cash',{direction:'payment',amount:100,account_id:kasa.id,party_id:parti.id,occurred_on:GUN,reference:'PARA-1',description:'Deneme'})).status,409);

  // Ekstresi çıkmaya devam eder: geçmiş okunur kalmalı.
  const ekstre=await f.ok('/ec/statement?party_id='+parti.id+'&from=2026-09-01&to=2026-09-30');
  assert.equal(ekstre.statement.closing_cents,-120000,'arşivli carinin ekstresi bozulmamalı');

  await f.ok('/ec/ledger/parties/'+parti.id+'/restore',{});
  assert.equal(f.cari(parti.id).archived_at,null,'arşivden geri alınabilmeli');
  assert.equal((await f.post('/ec/ledger/entries',{party_id:parti.id,amount:100,occurred_on:GUN,reference:'CARI-2',description:'Deneme'})).status,200,'geri alınan cariye yeniden yazılabilmeli');
  assert.equal((await f.post('/ec/ledger/parties/'+parti.id+'/restore',{})).status,409,'arşivde olmayan kayıt geri alınmaz');
 }finally{f.close();}
});

test('Hiç kullanılmamış cari silinir; arşivli kayıt düzeltilmeden önce geri alınır',async()=>{
 const f=await kurulum();try{
  const p=await yeniCari(f,{name:'Yanlışlıkla Açılan Cari'});
  const sil=await f.del('/ec/ledger/parties/'+p.id);
  assert.equal(sil.status,200,'hiçbir yerde kullanılmayan cari silinebilmeli');
  assert.equal(sil.data.deleted,true);
  assert.equal(f.cari(p.id),null,'satır gerçekten kalkmalı');
  assert.equal((await f.defter()).parties.some(x=>x.id===p.id),false,'silinen cari listede kalmamalı');
  assert.equal((await f.del('/ec/ledger/parties/'+p.id)).status,404,'ikinci silme 404 vermeli');

  const arsivli=await yeniCari(f,{name:'Arşive Alınacak'});
  await f.ok('/ec/ledger/parties/'+arsivli.id+'/archive',{});
  const duzelt=await f.post('/ec/ledger/parties/'+arsivli.id,{name:'Yeni Ad',kind:'supplier'});
  assert.equal(duzelt.status,409,'arşivli kayıt düzeltilemez');
  assert.match(duzelt.data.error,/geri al/i,'önce geri alması söylenmeli');
  await f.ok('/ec/ledger/parties/'+arsivli.id+'/restore',{});
  assert.equal((await f.post('/ec/ledger/parties/'+arsivli.id,{name:'Yeni Ad',kind:'supplier'})).status,200);
  await f.ok('/ec/ledger/parties/'+arsivli.id+'/archive',{});
  assert.equal((await f.del('/ec/ledger/parties/'+arsivli.id)).status,200,'arşivdeyken de kullanılmayan kayıt silinebilir');
 }finally{f.close();}
});

test('Kasa/banka hesabının adı ve türü düzeltilir; aynı ad iki hesapta olamaz',async()=>{
 const f=await kurulum();try{
  const a=await yeniHesap(f,{name:'Ana Kasaa',kind:'cash'});
  const b=await yeniHesap(f,{name:'QNB TL',kind:'bank'});
  const sonuc=await f.ok('/ec/ledger/accounts/'+a.id,{name:'Ana Kasa',kind:'bank'});
  assert.equal(sonuc.id,a.id);
  assert.equal(f.hesap(a.id).name,'Ana Kasa','hesap adı düzeltilebilmeli');
  assert.equal(f.hesap(a.id).kind,'bank','hesap türü düzeltilebilmeli');
  assert.equal((await f.post('/ec/ledger/accounts/'+a.id,{name:'QNB TL',kind:'bank'})).status,409,'aynı ad ikinci hesapta olamaz');
  assert.equal(f.hesap(a.id).name,'Ana Kasa','reddedilen düzeltme kaydı bozmamalı');
  assert.equal((await f.post('/ec/ledger/accounts/'+a.id,{name:'Ana Kasa',kind:'kredi'})).status,400,'tanınmayan hesap türü kabul edilmemeli');
  assert.equal((await f.post('/ec/ledger/accounts/'+b.id,{name:'',kind:'bank'})).status,400);
  assert.equal((await f.post('/ec/ledger/accounts/olmayan-hesap',{name:'X',kind:'cash'})).status,404);
  const d=await f.defter();
  assert.equal(d.accounts.find(x=>x.id===a.id).name,'Ana Kasa');
 }finally{f.close();}
});

test('Hareketi olan hesap silinemez; arşivlenir, yeni ödemede seçilemez, geçmiş bakiyesi durur',async()=>{
 const f=await kurulum();try{
  const {parti}=await faturaliCari(f);
  const kasa=await yeniHesap(f,{name:'Ana Kasa',kind:'cash'});
  await f.ok('/ec/ledger/payments',{party_id:parti.id,amount:300,occurred_on:GUN,method:'nakit',note:'Elden',account_id:kasa.id});

  const sil=await f.del('/ec/ledger/accounts/'+kasa.id);
  assert.equal(sil.status,409,'hareketi olan hesap silinemez');
  assert.match(sil.data.error,/hareket/i,'engelleyen bağlantı söylenmeli');
  assert.match(sil.data.error,/arşiv/i);

  const arsiv=await f.ok('/ec/ledger/accounts/'+kasa.id+'/archive',{});
  assert.equal(arsiv.archived,true);
  assert.ok(f.hesap(kasa.id).archived_at);

  // Yeni ödeme ve tahsilat bu hesaba yazılamaz.
  const odeme=await f.post('/ec/ledger/payments',{party_id:parti.id,amount:100,occurred_on:GUN,method:'nakit',account_id:kasa.id});
  assert.equal(odeme.status,409,'arşivli hesap yeni ödemede seçilemez');
  assert.match(odeme.data.error,/arşiv/i);
  assert.equal((await f.post('/ec/ledger/cash',{direction:'payment',amount:50,account_id:kasa.id,occurred_on:GUN,reference:'PARA-9',description:'Deneme'})).status,409);

  // Geçmiş bozulmaz: hesap listede, bakiyesi ve hareketleri yerinde.
  const d=await f.defter();
  const kart=d.accounts.find(x=>x.id===kasa.id);
  assert.ok(kart,'arşivli hesap listeden silinmemeli');
  assert.ok(kart.archived_at,'liste arşiv işaretini taşımalı');
  assert.equal(kart.balance_cents,-30000,'arşivlenen hesabın bakiyesi değişmemeli');
  assert.ok(d.cash_transactions.some(t=>t.account_id===kasa.id&&t.account_name==='Ana Kasa'),'geçmiş kasa hareketi hesabın adıyla görünmeli');

  await f.ok('/ec/ledger/accounts/'+kasa.id+'/restore',{});
  assert.equal((await f.post('/ec/ledger/payments',{party_id:parti.id,amount:100,occurred_on:GUN,method:'nakit',account_id:kasa.id})).status,200,'geri alınan hesap yeniden seçilebilmeli');
 }finally{f.close();}
});

test('Hiç hareketi olmayan kasa/banka hesabı silinir',async()=>{
 const f=await kurulum();try{
  const kasa=await yeniHesap(f,{name:'Vadeli Kasa',kind:'cash'});
  const sil=await f.del('/ec/ledger/accounts/'+kasa.id);
  assert.equal(sil.status,200);
  assert.equal(sil.data.deleted,true);
  assert.equal(f.hesap(kasa.id),null);
  assert.equal((await f.defter()).accounts.some(x=>x.id===kasa.id),false);
  // Silinen hesabın adı serbest kalır: hesap adı tekildir, arşivlenseydi ad üzerinde kalırdı.
  assert.ok((await yeniHesap(f,{name:'Vadeli Kasa',kind:'bank'})).id);
 }finally{f.close();}
});

test('Üretim alanında da cari ve hesap düzeltilir, arşivlenir ve silinir',async()=>{
 const f=await kurulum();try{
  const p=await f.ok('/lp/ledger/parties',{name:'Üretim Tedarikçisi',kind:'supplier'});
  await f.ok('/lp/ledger/parties/'+p.id,{name:'Üretim Tedarikçisi Ltd.',kind:'supplier',phone:'0312 000 00 00'});
  assert.equal(f.sqlite.prepare('SELECT name FROM lp_suppliers WHERE id=?').get(p.id).name,'Üretim Tedarikçisi Ltd.');
  await f.ok('/lp/ledger/parties/'+p.id+'/archive',{});
  assert.ok(f.sqlite.prepare('SELECT archived_at a FROM lp_suppliers WHERE id=?').get(p.id).a);
  await f.ok('/lp/ledger/parties/'+p.id+'/restore',{});
  assert.equal((await f.del('/lp/ledger/parties/'+p.id)).status,200,'üretim alanında da kullanılmayan cari silinebilmeli');

  const h=await f.ok('/lp/ledger/accounts',{name:'Üretim Kasası',kind:'cash'});
  await f.ok('/lp/ledger/accounts/'+h.id,{name:'Üretim Ana Kasa',kind:'bank'});
  assert.equal(f.sqlite.prepare('SELECT kind FROM lp_cash_accounts WHERE id=?').get(h.id).kind,'bank');
  assert.equal((await f.del('/lp/ledger/accounts/'+h.id)).status,200);

  // Çalışma alanları ayrıdır: e-ticaret carisi üretim ucundan görünmez.
  const ec=await yeniCari(f,{name:'E-Ticaret Carisi'});
  assert.equal((await f.post('/lp/ledger/parties/'+ec.id,{name:'X',kind:'supplier'})).status,404);
  assert.equal((await f.del('/lp/ledger/parties/'+ec.id)).status,404);
 }finally{f.close();}
});

test('Aynı vergi numarasıyla ikinci kez eklemek arşivli cariyi sessizce diriltmez',async()=>{
 const f=await kurulum();try{
  const p=await yeniCari(f,{name:'Torf Tedarikçisi',tax_id:'1234567890'});
  await f.ok('/ec/ledger/parties/'+p.id+'/archive',{});
  const tekrar=await f.ok('/ec/ledger/parties',{name:'Torf Tedarikçisi',kind:'supplier',tax_id:'1234567890'});
  assert.equal(tekrar.id,p.id,'aynı VKN ikinci kayıt açmaz');
  assert.equal(tekrar.existing,true);
  assert.equal(tekrar.archived,true,'bulunan carinin arşivde olduğu bildirilmeli');
  assert.ok(f.cari(p.id).archived_at,'ekleme denemesi arşivi kaldırmamalı');
 }finally{f.close();}
});

test('Cari ve hesap düzeltmesi yetkiye bağlıdır; kalıcı silme ayrı onay ister',async()=>{
 const f=await kurulum();try{
  const p=await yeniCari(f,{name:'Torf Tedarikçisi',tax_id:'1234567890'});
  const kasa=await yeniHesap(f,{name:'Ana Kasa',kind:'cash'});

  // İlgisiz ekranı görebilen personel cari ve hesap kartına dokunamaz.
  const bos=await f.personel({orders:'read'},false,'sentetik.yetkisiz');
  assert.equal((await f.post('/ec/ledger/parties/'+p.id,{name:'X',kind:'supplier'},bos)).status,403);
  assert.equal((await f.post('/ec/ledger/parties/'+p.id+'/archive',{},bos)).status,403);
  assert.equal((await f.del('/ec/ledger/parties/'+p.id,bos)).status,403);
  assert.equal((await f.post('/ec/ledger/accounts/'+kasa.id,{name:'X',kind:'cash'},bos)).status,403);
  assert.equal((await f.del('/ec/ledger/accounts/'+kasa.id,bos)).status,403);

  // Cari defterini yalnızca OKUYAN personel düzeltemez.
  const okuyan=await f.personel({ledger:'read'},true,'sentetik.okuyan');
  assert.equal((await f.post('/ec/ledger/parties/'+p.id,{name:'X',kind:'supplier'},okuyan)).status,403);
  assert.equal((await f.post('/ec/ledger/parties/'+p.id+'/archive',{},okuyan)).status,403);
  assert.equal((await f.del('/ec/ledger/parties/'+p.id,okuyan)).status,403);

  // Defteri yazabilen personel düzeltir ve arşivler; kalıcı silme ayrı onay ister.
  const yazan=await f.personel({ledger:'write'},false,'sentetik.yazan');
  assert.equal((await f.post('/ec/ledger/parties/'+p.id,{name:'Torf Tedarikçisi A.Ş.',kind:'supplier',tax_id:'1234567890'},yazan)).status,200,'cariyi düzeltebilmeli');
  assert.equal((await f.post('/ec/ledger/accounts/'+kasa.id,{name:'Ana Kasa · Merkez',kind:'cash'},yazan)).status,200,'hesabı düzeltebilmeli');
  assert.equal((await f.post('/ec/ledger/parties/'+p.id+'/archive',{},yazan)).status,200,'arşivleme ekran yetkisiyle yapılır');
  assert.equal((await f.post('/ec/ledger/parties/'+p.id+'/restore',{},yazan)).status,200);
  assert.equal((await f.del('/ec/ledger/parties/'+p.id,yazan)).status,403,'kalıcı silme onayı olmadan silemez');
  assert.equal((await f.del('/ec/ledger/accounts/'+kasa.id,yazan)).status,403);
  assert.ok(f.cari(p.id),'reddedilen silme kaydı bırakmalı');

  const silebilen=await f.personel({ledger:'write'},true,'sentetik.silen');
  assert.equal((await f.del('/ec/ledger/parties/'+p.id,silebilen)).status,200,'onaylı personel kullanılmayan cariyi silebilmeli');
  assert.equal((await f.del('/ec/ledger/accounts/'+kasa.id,silebilen)).status,200);
 }finally{f.close();}
});

test('Cari ve hesap satırında düzelt, arşivle ve sil işlemleri görünür; arşivli satırda yerini geri alma alır',()=>{
 const etkin=cardActions('parties',{id:'c1',name:'Torf Tedarikçisi',archived_at:null});
 assert.match(etkin,/data-business="party-edit" data-id="c1"/,'cari satırında düzenleme olmalı');
 assert.match(etkin,/data-business="card-archive" data-id="parties:c1"/,'etkin cari arşivlenebilmeli');
 assert.match(etkin,/data-business="card-delete" data-id="parties:c1"/,'silme düğmesi bulunmalı');
 assert.doesNotMatch(etkin,/data-business="card-restore"/,'etkin kayıtta geri alma çıkmamalı');
 assert.match(etkin,/data-business="party-detail"/,'cari satırı hesabı incelemeyi korumalı');

 const arsivli=cardActions('parties',{id:'c1',name:'Torf Tedarikçisi',archived_at:'2026-09-09 10:00:00'});
 assert.match(arsivli,/data-business="card-restore" data-id="parties:c1"/,'arşivli kayıt geri alınabilmeli');
 assert.doesNotMatch(arsivli,/data-business="card-archive"/,'arşivli kayıt ikinci kez arşivlenmemeli');

 const hesap=cardActions('accounts',{id:'k1',name:'Ana Kasa',archived_at:null});
 assert.match(hesap,/data-business="account-edit" data-id="k1"/,'hesap satırında düzenleme olmalı');
 assert.match(hesap,/data-business="card-archive" data-id="accounts:k1"/);
 assert.doesNotMatch(hesap,/data-business="party-detail"/,'hesap satırında cari incelemesi olmamalı');
});
