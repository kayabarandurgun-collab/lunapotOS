import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {connectionsApi,syncProvider} from '../src/connections-api.js';

const key='ab'.repeat(32);
const credentials={seller_id:'11111111-2222-3333-4444-555555555555',key:'hb-api-user',secret:'hb-service-key',user_agent:'lunapot_dev'};

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){for(const table of ['catalog_mappings','catalog_mapping_components','order_line_components','provider_connections','provider_records','provider_cursors','integration_runs','order_packages','order_lines','products'])sql=sql.replace(new RegExp('\\b'+table+'\\b','g'),'ec_'+table);return {values:[],bind(...v){this.values=v;return this;},first(){return sqlite.prepare(sql).get(...this.values)||null;},all(){return {results:sqlite.prepare(sql).all(...this.values)};},run(){return sqlite.prepare(sql).run(...this.values);}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(i=>i.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,WORKSPACE:'ec',CREDENTIAL_KEY:key};
 const call=(path='',body)=>connectionsApi(new Request('https://test.local/api/connections'+path,{method:body===undefined?'GET':'POST'}),env,'/api/connections'+path.split('?')[0],async()=>body);
 return {sqlite,env,call};
}

// CANLI YANIT BİÇİMİ, 2026-09-25'te ölçüldü. Para alanları {value,currencyCode} nesnesidir;
// kayıt kendi değiştirme zamanını taşımaz, dört ayrı tarih taşır.
const hbFinansKaydi=(overrides={})=>({
 id:'TRX-1',transactionType:'Komisyon',transactionTypeCategory:'Kesinti',status:'Odendi',
 sku:'HBV0000123',productName:'Orkide Besini',packageNumber:'PKG-9',orderNumber:'ORD-9',
 invoiceNumber:'FTR-9',orderItemNumber:'OI-9',quantity:2,
 amount:{value:118.5,currencyCode:'TRY'},taxAmount:{value:18.5,currencyCode:'TRY'},netAmount:{value:100,currencyCode:'TRY'},
 orderDate:'2026-09-20T10:00:00',invoiceDate:'2026-09-23T10:00:00',dueDate:'2026-09-30T10:00:00',paymentDate:'2026-09-28T10:00:00',
 invoiceExplanation:'Komisyon bedeli',merchantId:'11111111-2222-3333-4444-555555555555',isInvoice:true,isIncome:false,
 ...overrides});

const sorgu={kind:'finance',from:'2026-09-23',to:'2026-09-23',page:0,preview:true};

test('HB finans kaydı {value,currencyCode} biçimindeki tutarla okunur; kayıt düşmez',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const sonuc=await syncProvider(f.env,'hepsiburada',sorgu,async()=>Response.json({items:[hbFinansKaydi()],totalCount:1}));
 assert.equal(sonuc.records.length,1,'kayıt şema hatasıyla düşmemeli');
 const r=sonuc.records[0];
 assert.equal(r.amount,118.5);
 assert.equal(r.currency,'TRY');
 assert.equal(r.tax_amount,18.5);
 assert.equal(r.net_amount,100);
 assert.equal(r.type,'Komisyon');
 assert.equal(r.type_category,'Kesinti');
 assert.equal(r.payment_status,'Odendi','durum alanı status adıyla geliyor');
 assert.equal(r.is_income,false);
});

test('eski {amount,currency} biçimi de kabul edilir; sağlayıcı geri dönerse sorgu düşmez',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const eski=hbFinansKaydi({amount:{amount:50,currency:'TRY'},taxAmount:null,netAmount:null,status:undefined,paymentStatus:'Bekliyor'});
 const sonuc=await syncProvider(f.env,'hepsiburada',sorgu,async()=>Response.json({items:[eski],totalCount:1}));
 assert.equal(sonuc.records.length,1);
 assert.equal(sonuc.records[0].amount,50);
 assert.equal(sonuc.records[0].currency,'TRY');
 assert.equal(sonuc.records[0].payment_status,'Bekliyor');
 assert.equal(sonuc.records[0].tax_amount,null,'gelmeyen tutar sıfır değil, bilinmiyor');
});

test('kaydın dört tarihi ayrı saklanır; değiştirme zamanı uydurulmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const sonuc=await syncProvider(f.env,'hepsiburada',sorgu,async()=>Response.json({items:[hbFinansKaydi()],totalCount:1}));
 const r=sonuc.records[0];
 assert.match(r.order_date,/^2026-09-20/);
 assert.match(r.invoice_date,/^2026-09-23/);
 assert.match(r.due_date,/^2026-09-30/);
 assert.match(r.payment_date,/^2026-09-28/);
 assert.equal(r.source_updated_at,null,'HB değiştirme zamanı vermiyor; fatura tarihi onun yerine geçmez');
});

test('tutarı gerçekten olmayan kayıt hâlâ reddedilir; sıfır kabul edilmez',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const tutarsiz=hbFinansKaydi({amount:{currencyCode:'TRY'}});
 await assert.rejects(()=>syncProvider(f.env,'hepsiburada',sorgu,async()=>Response.json({items:[tutarsiz],totalCount:1})),/tutar/i);
});

test('önizlemede hiçbir kaynak kaydı yazılmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 await syncProvider(f.env,'hepsiburada',sorgu,async()=>Response.json({items:[hbFinansKaydi()],totalCount:1}));
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n,0);
});

// PAKET DURUM UÇLARI. /orders yalnız paketlenmeyi bekleyenleri döndürdüğü için teslim edilen
// paketler oradan HİÇ gelmiyordu; teslim/kargo/teslim edilemedi ayrı uçlardadır.
const hbPaket=(overrides={})=>({
 id:'DLV-1',orderNumber:'ORD-77',packageNumber:'PKG-77',barcode:'BRK-77',
 merchantId:'11111111-2222-3333-4444-555555555555',deliveredDate:'2026-09-23T14:20:00',
 lastStatusUpdateDate:'2026-09-23T14:25:00',...overrides});
// CANLI YANIT BİÇİMİ (2026-09-25): sağlayıcı bu uçlarda PascalCase gönderiyor.
const hbPaketPascal=(overrides={})=>({
 Id:'6ab0dcf6-3e36-9905-de51-b36906060606',Barcode:'BRK-88',PackageNumber:'5519711229',
 OrderNumber:'ORD-88',OrderNumbers:['ORD-88','ORD-89'],MerchantId:'11111111-2222-3333-4444-555555555555',
 DeliveredDate:'2026-09-23T14:20:00',EtgbNo:'',HasInvoice:true,...overrides});

const paketSorgu=durum=>({kind:durum,from:'2026-09-23',to:'2026-09-23',page:0,preview:true});

test('teslim edilen paketler kendi ucundan okunur; paket numarası ve teslim günü saklanır',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 let istenen=null;
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('delivered'),async(url)=>{istenen=String(url);return Response.json({items:[hbPaket()],totalCount:1});});
 assert.match(istenen,/oms-external\.hepsiburada\.com\/packages\/merchantid\/[^/]+\/delivered/,'teslim ucu çağrılmalı');
 assert.doesNotMatch(istenen,/-sit\./,'canlı adres kullanılmalı, test ortamı değil');
 const r=sonuc.records[0];
 assert.equal(r.package_no,'PKG-77');
 assert.equal(r.order_no,'ORD-77');
 assert.equal(r.package_status,'delivered');
 assert.match(r.delivered_on,/^2026-09-23/);
});

test('kargoya verilen ve teslim edilemeyen paketler ayrı uçlara gider',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 for(const [durum,yol] of [['shipped','shipped'],['undelivered','undelivered']]){
  let istenen=null;
  const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu(durum),async(url)=>{istenen=String(url);return Response.json({items:[hbPaket()],totalCount:1});});
  assert.match(istenen,new RegExp('/packages/merchantid/[^/]+/'+yol),durum);
  assert.equal(sonuc.records[0].package_status,durum);
  assert.equal(sonuc.records[0].delivered_on,null,durum+': teslim günü yalnız teslim ucunda yazılır');
 }
});

test('teslim tarihi gelmeyen paket için tarih uydurulmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('delivered'),async()=>Response.json({items:[hbPaket({deliveredDate:null,deliveryDate:null})],totalCount:1}));
 assert.equal(sonuc.records[0].delivered_on,null);
 assert.equal(sonuc.records[0].package_no,'PKG-77','tarih yoksa bile paket kaydı düşmez');
});

test('paket numarası olmayan kayıt reddedilir; eşleşmesiz paket yazılmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 await assert.rejects(()=>syncProvider(f.env,'hepsiburada',paketSorgu('delivered'),async()=>Response.json({items:[hbPaket({packageNumber:null,packageNo:null})],totalCount:1})),/paket numarası/i);
});

test('HB tarih aralığı bir günü aşamaz; paket uçlarında da aynı sınır',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 await assert.rejects(()=>syncProvider(f.env,'hepsiburada',{...paketSorgu('delivered'),to:'2026-09-25'},async()=>Response.json({items:[],totalCount:0})),/en fazla 1 gün/);
});

// SESSİZ BOŞ OKUMA. Sağlayıcı bu uçlarda PascalCase gönderiyor; kod camelCase arayınca kayıt
// SAYISI doğru görünüyor ama sipariş numarası, barkod ve teslim tarihi boş okunuyordu. Teslim
// tarihi boş olan paket hiçbir zaman işaretlenemez: veri geldi sanılıp işe yaramaz kayıt yazılırdı.
test('PascalCase alan adları okunur; teslim tarihi ve sipariş numarası boş kalmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('delivered'),async()=>Response.json({items:[hbPaketPascal()],totalCount:1}));
 const r=sonuc.records[0];
 assert.equal(r.package_no,'5519711229');
 assert.equal(r.order_no,'ORD-88','sipariş numarası boş kalmamalı');
 assert.equal(r.barcode,'BRK-88','barkod boş kalmamalı');
 assert.match(r.delivered_on,/^2026-09-23/,'teslim tarihi okunmalı');
 assert.equal(r.has_invoice,true);
 assert.deepEqual(r.order_numbers,['ORD-88','ORD-89'],'paketteki bütün siparişler saklanmalı');
});

test('kargo ucu kendi tarih alanını kullanır; teslim günü yazılmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const kargo=hbPaketPascal({DeliveredDate:undefined,ShippedDate:'2026-09-22T09:00:00',Deci:3,HasInvoice:undefined});
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('shipped'),async()=>Response.json({items:[kargo],totalCount:1}));
 const r=sonuc.records[0];
 assert.match(r.shipped_on,/^2026-09-22/);
 assert.equal(r.delivered_on,null,'kargo kaydı teslim sayılmaz');
 assert.equal(r.deci,3);
 assert.equal(r.has_invoice,null,'gelmeyen bayrak false değil, bilinmiyor');
});

test('kayıt yokken items null gelir; bu şema hatası değil boş sonuçtur',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 // Canlı yanıt (2026-09-25): teslim edilemeyen paket yokken uç items yerine null gönderiyor.
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('undelivered'),async()=>Response.json({totalCount:0,limit:50,offset:0,pageCount:0,items:null}));
 assert.deepEqual(sonuc.records,[],'boş sonuç kabul edilmeli');
 assert.equal(sonuc.hasMore,false);
});

test('totalCount demeden gelen bozuk yanıt hâlâ reddedilir',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 for(const bozuk of [{items:null},{items:'liste'},{beklenmeyen:1}])
  await assert.rejects(()=>syncProvider(f.env,'hepsiburada',paketSorgu('undelivered'),async()=>Response.json(bozuk)),/şeması doğrulanamadı/,JSON.stringify(bozuk));
});

test('paket uçlarına tarih ve sayfalama parametreleri gider',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 let istenen=null;
 await syncProvider(f.env,'hepsiburada',paketSorgu('undelivered'),async(url)=>{istenen=new URL(url);return Response.json({totalCount:0,items:null});});
 for(const ad of ['limit','offset','begindate','enddate'])
  assert.ok(istenen.searchParams.has(ad),ad+' gönderilmeli');
 assert.equal(istenen.searchParams.get('limit'),'50');
});

test('tarihi gelmeyen paket kaydı yazılır ama tarih uydurulmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 const sonuc=await syncProvider(f.env,'hepsiburada',paketSorgu('delivered'),async()=>Response.json({items:[hbPaketPascal({DeliveredDate:null})],totalCount:1}));
 assert.equal(sonuc.records[0].delivered_on,null);
 assert.equal(sonuc.records[0].source_updated_at,null);
 assert.equal(sonuc.records[0].package_no,'5519711229');
});

// HB TESLİM ONAYI. Yerel HB paketlerinin kimliği rapor yolundan geliyor (RPT-…) ve HB'nin paket
// numarasıyla kesişmiyor; eşleşme sipariş numarasından kurulur. Yanlış paketi teslim işaretlemek
// kârı yanlış pakete ve yanlış güne yazar, o yüzden belirsizlikte hiçbir şey yapılmaz.
const paketEkle=(f,{id,order_no,status})=>f.sqlite.prepare(
 "INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint,shipment_reference,shipped_on) VALUES(?,'hepsiburada',?,?,'2026-09-20',?,'fp-'||?,?,'2026-09-21')")
 .run(crypto.randomUUID(),id,order_no,status,id,'SVK-'+id);

const teslimSorgu={kind:'delivered',from:'2026-09-23',to:'2026-09-23',page:0,preview:false};

test('siparişin kargoda tek paketi varsa HB teslim tarihiyle işaretlenir',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 paketEkle(f,{id:'RPT-aaa',order_no:'ORD-88',status:'shipped'});
 const sonuc=await syncProvider(f.env,'hepsiburada',teslimSorgu,async()=>Response.json({items:[hbPaketPascal()],totalCount:1}));
 assert.equal(sonuc.deliveredMarked,1,JSON.stringify(sonuc.warnings));
 const p=f.sqlite.prepare("SELECT status,delivered_on FROM ec_order_packages WHERE external_id='RPT-aaa'").get();
 assert.equal(p.status,'delivered');
 assert.equal(p.delivered_on,'2026-09-23','teslim günü HB tarihinden gelmeli');
});

test('aynı siparişin kargoda iki paketi varsa hiçbiri işaretlenmez',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 paketEkle(f,{id:'RPT-bbb',order_no:'ORD-88',status:'shipped'});
 paketEkle(f,{id:'RPT-ccc',order_no:'ORD-88',status:'shipped'});
 const sonuc=await syncProvider(f.env,'hepsiburada',teslimSorgu,async()=>Response.json({items:[hbPaketPascal({OrderNumbers:['ORD-88']})],totalCount:1}));
 assert.equal(sonuc.deliveredMarked,0);
 assert.ok(sonuc.ambiguousDeliveries>0,'belirsizlik sayılmalı');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_order_packages WHERE status='delivered'").get().n,0);
});

test('teslim tarihi gelmeyen HB paketi işaretlenmez; tarih uydurulmaz',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 paketEkle(f,{id:'RPT-ddd',order_no:'ORD-88',status:'shipped'});
 const sonuc=await syncProvider(f.env,'hepsiburada',teslimSorgu,async()=>Response.json({items:[hbPaketPascal({DeliveredDate:null,OrderNumbers:['ORD-88']})],totalCount:1}));
 assert.equal(sonuc.deliveredMarked,0);
 assert.ok(sonuc.undatedDeliveries>0);
 assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE external_id='RPT-ddd'").get().status,'shipped');
});

test('kargoda olmayan paket zorlanmaz; teslim edilmiş paket ikinci kez işaretlenmez',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 paketEkle(f,{id:'RPT-eee',order_no:'ORD-88',status:'reserved'});
 const sonuc=await syncProvider(f.env,'hepsiburada',teslimSorgu,async()=>Response.json({items:[hbPaketPascal({OrderNumbers:['ORD-88']})],totalCount:1}));
 assert.equal(sonuc.deliveredMarked,0,'ayrılmış paket teslim edilmiş sayılmaz');
 assert.equal(sonuc.ambiguousDeliveries,0,'olağan hâl belirsizlik diye bildirilmez');
 assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE external_id='RPT-eee'").get().status,'reserved');
});

test('önizlemede teslim işaretlemesi yazılmaz, yalnız sayılır',async()=>{
 const f=fixture();
 await f.call('/hepsiburada/configure',credentials);
 paketEkle(f,{id:'RPT-fff',order_no:'ORD-88',status:'shipped'});
 const sonuc=await syncProvider(f.env,'hepsiburada',{...teslimSorgu,preview:true},async()=>Response.json({items:[hbPaketPascal()],totalCount:1}));
 assert.equal(sonuc.deliveredMarked,1,'önizleme ne olacağını söylemeli');
 assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE external_id='RPT-fff'").get().status,'shipped','önizlemede yazılmamalı');
});
