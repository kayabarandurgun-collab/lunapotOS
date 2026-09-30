// TEK SEFERLİK SİPARİŞ DÜZELTMESİ: "depodan gerçekte ne çıktı".
// Canlıdan gelen durum (29.09.2026): 10 L torf bitince o siparişlere 2 adet 5 L gönderildi.
// Kuralın özü: kalıcı ilan eşleşmesi DEĞİŞMEZ, ciro DEĞİŞMEZ, yalnız mal ve maliyet düzelir;
// ve bu düzeltme hiçbir ekranda "müşteri iade etti" diye okunmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ordersApi} from '../src/orders-api.js';
const date='2026-09-09';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0001_initial.sql','0002_accounting.sql','0003_accounting_audit.sql','0004_pricing.sql','0005_ledger.sql','0006_receipts_settings.sql','0007_orders.sql','0008_connections.sql','0009_reconciliation.sql','0010_order_refresh.sql','0011_catalog.sql','0012_order_components.sql','0033_report_inbox.sql','0039_order_report_link.sql','0041_report_link_invalidation.sql','0059_ilan_barkodu.sql','0061_siparis_urun_duzeltmesi.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const raw={prepare(sql){return {values:[],bind(...a){this.values=a;return this;},first(){return sqlite.prepare(sql).get(...this.values)||null;},all(){return {results:sqlite.prepare(sql).all(...this.values)};}};},async batch(items){sqlite.exec('BEGIN');try{const results=items.map(i=>i.all());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const DB={...raw,prepare(sql){for(const table of ['catalog_mappings','catalog_mapping_components','order_line_components','order_packages','order_lines','order_reservations','order_refresh_audit','provider_records','provider_connections','products','stock_balances','sale_entries','activity'])sql=sql.replace(new RegExp('\\b'+table+'\\b','g'),'ec_'+table);return raw.prepare(sql);}},env={DB,WORKSPACE:'ec'};
 const call=(path='',body)=>ordersApi(new Request('https://test.local/api/orders'+path,{method:body?'POST':'GET'}),env,'/api/orders'+path,async()=>body);
 function product(key,quantity=10,value=10000){sqlite.prepare('INSERT INTO ec_products(id,name,sku) VALUES(?,?,?)').run(key,key,key);if(quantity)sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,?,'opening',?,?)").run('stock:'+key,key,quantity*1000,value,key,date);return key;}
 const order=(ref,lines)=>call('',{channel:'trendyol',external_id:ref,order_no:ref,occurred_on:date,lines});
 const line=(p,external='L1',quantity=1)=>({external_id:external,name:'Torf',product_id:p,quantity,gross:120,vat_rate:20});
 const stock=id=>sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(id);
 const entries=()=>sqlite.prepare('SELECT * FROM ec_sale_entries ORDER BY rowid').all();
 const parts=()=>sqlite.prepare('SELECT * FROM ec_order_line_components ORDER BY rowid').all();
 // Gönderilmiş bir sipariş kurar; düzeltme yalnız bu aşamada açılır.
 async function gonderilmis(ref,p){
  const key=(await order(ref,[line(p)])).id;
  await call('/'+key+'/reserve',{});await call('/'+key+'/ship',{occurred_on:date,reference:ref+'-KARGO'});
  return key;
 }
 return {sqlite,env,call,product,order,line,stock,entries,parts,gonderilmis,close:()=>sqlite.close()};
}

test('İkame: siparişteki ürün rafa döner, gerçekte gönderilen düşer; ciro değişmez, kalıcı eşleşmeye dokunulmaz',async()=>{
 const f=fixture();try{
  const A=f.product('TORF-10L',10,10000),B=f.product('TORF-5L',10,5000);
  const key=await f.gonderilmis('SIP-1',A);
  assert.equal(f.stock(A).q,9000,'gönderimde 10 L düştü');
  const once=f.entries();assert.equal(once.length,1);
  const ciroOnce=once.reduce((t,e)=>t+e.revenue_cents,0);
  const asil=f.parts()[0];

  await f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:B,quantity:2}],reason:'10 L stokta bitti'});

  // MAL: 10 L raftan hiç çıkmadı, 2 adet 5 L çıktı.
  assert.equal(f.stock(A).q,10000,'10 L rafa geri kondu');
  assert.equal(f.stock(A).v,10000,'10 L stok değeri de geri geldi');
  assert.equal(f.stock(B).q,8000,'2 adet 5 L düştü');

  // PARA: ciro değişmedi, maliyet gerçekte gönderilen üründen.
  const sonra=f.entries();
  assert.equal(sonra.reduce((t,e)=>t+e.revenue_cents,0),ciroOnce,'ciro bir kez sayılır, düzeltme para taşımaz');
  assert.equal(sonra.reduce((t,e)=>t+e.cost_cents,0),1000,'maliyet yalnız 2 adet 5 L');

  // KALICI EŞLEŞME: hiç yazılmadı, düzeltme bileşeni hiçbir bağlantıya bağlı değil.
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_catalog_mappings').get().n,0,'kalıcı ilan bağlantısı kurulmadı');
  const yeni=f.parts().find(c=>c.correction_kind==='ikame');
  assert.equal(yeni.mapping_id,null);assert.equal(yeni.revenue_share_bps,0,'düzeltme bileşeni ciro taşımaz');
  assert.equal(yeni.replaces_component_id,asil.id);assert.equal(yeni.correction_note,'10 L stokta bitti');

  // Satırın gelir payı toplamı 10000'de kaldı: bozulsaydı paketin kârı hiç hesaplanmazdı.
  assert.equal(f.parts().filter(c=>c.line_id===asil.line_id).reduce((n,c)=>n+c.revenue_share_bps,0),10000);

  // TERS KAYIT müşteri iadesi değildir: listede "İade edildi" görünmez.
  const ters=sonra.find(e=>e.kind==='return');
  assert.ok(ters.external_id.startsWith('DUZELTME-IKAME-'));
  assert.equal(ters.revenue_cents,0,'para iade edilmedi');assert.equal(ters.restock,1);
  assert.equal(ters.commission_cents,0,'kesinti null bırakılsaydı kâr raporu paketi "eksik" sayardı');
  assert.equal(ters.fees_status,'confirmed');
  assert.equal((await f.call()).packages.find(x=>x.id===key).return_status,null,'iade rozeti çıkmaz');
 }finally{f.close();}
});

test('İlave: parasız ürün stoktan düşer ve maliyete girer, ciroya girmez',async()=>{
 const f=fixture();try{
  const A=f.product('TORF-20L',10,10000),H=f.product('BESIN',10,2000);
  const key=await f.gonderilmis('SIP-2',A);
  const ciroOnce=f.entries().reduce((t,e)=>t+e.revenue_cents,0),satir=f.parts()[0].line_id;

  await f.call('/'+key+'/duzeltme',{line_id:satir,kind:'ilave',items:[{product_id:H,quantity:1}],reason:'özür hediyesi'});

  assert.equal(f.stock(A).q,9000,'siparişteki ürün aynen çıkmış kalır');
  assert.equal(f.stock(H).q,9000,'hediye stoktan düştü');
  const sonra=f.entries();
  assert.equal(sonra.filter(e=>e.kind==='return').length,0,'ilavede ters kayıt yoktur');
  assert.equal(sonra.reduce((t,e)=>t+e.revenue_cents,0),ciroOnce,'hediye ciroya girmez');
  assert.equal(sonra.reduce((t,e)=>t+e.cost_cents,0),1200,'10 L maliyeti 1000 + hediye 200');
  const h=f.parts().find(c=>c.correction_kind==='ilave');
  assert.equal(h.revenue_share_bps,0);assert.equal(h.replaces_component_id,null);
  assert.equal(f.parts().filter(c=>c.line_id===satir).reduce((n,c)=>n+c.revenue_share_bps,0),10000);
 }finally{f.close();}
});

test('Düzeltme yalnız gönderilmiş siparişte, sebep zorunlu, aynı ürün iki kez ikame edilemez',async()=>{
 const f=fixture();try{
  const A=f.product('TORF-40L',10,10000),B=f.product('TORF-2L',10,5000);
  // TASLAK: düzeltme açılmaz, kullanıcı eşleştirme ekranına yönlendirilir.
  const taslak=(await f.order('SIP-3',[f.line(A)])).id,taslakParca=f.parts()[0];
  await assert.rejects(f.call('/'+taslak+'/duzeltme',{line_id:taslakParca.line_id,kind:'ikame',component_id:taslakParca.id,items:[{product_id:B,quantity:1}],reason:'x'}),/gönderilmiş siparişler için/);

  const key=await f.gonderilmis('SIP-4',A),asil=f.parts().find(c=>c.line_id!==taslakParca.line_id);
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:B,quantity:1}],reason:''}),/Düzeltme sebebi/);
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[],reason:'x'}),/1–5 ürün/);
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:'YOK',quantity:1}],reason:'x'}),/bulunamadı/);
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:B,quantity:1},{product_id:B,quantity:1}],reason:'x'}),/iki kez/);

  await f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:B,quantity:1}],reason:'bitti'});
  // İKİNCİ İKAME YASAK: aynı mal iki kez rafa geri konmaz.
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:asil.id,items:[{product_id:B,quantity:1}],reason:'yine'}),/zaten bir ikame/);
  // Düzeltme bileşeninin kendisi ikame edilemez.
  const yeni=f.parts().find(c=>c.correction_kind==='ikame');
  await assert.rejects(f.call('/'+key+'/duzeltme',{line_id:asil.line_id,kind:'ikame',component_id:yeni.id,items:[{product_id:A,quantity:1}],reason:'x'}),/zaten bir düzeltme/);
  assert.equal(f.stock(A).q,10000);assert.equal(f.stock(B).q,9000);
 }finally{f.close();}
});
