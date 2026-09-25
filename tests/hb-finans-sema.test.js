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
