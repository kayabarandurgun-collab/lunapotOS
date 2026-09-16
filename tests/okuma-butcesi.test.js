// D1 ücretsiz katmanında günlük SATIR OKUMA sınırı var; dolunca panel tamamen 500 verir.
// Gözlemden tahmin PAKET BAŞINA çağrılır ama sorguları MAĞAZAYA bağlıdır: her pakette
// yeniden çalıştırılırsa aynı satırlar yüzlerce kez okunur ve kota tek sayfada biter.
// Kanıtlanan: paket sayısı artınca okunan satır sayısı ORANTILI artmaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {orderResults} from '../src/report-inbox-api.js';

function fixture(paketSayisi) {
  const sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  let okunan = 0, sorgu = 0;
  const say = rows => { sorgu++; okunan += rows.length; return rows; };
  const DB = {
    prepare(q) {
      return {v: [], bind(...v) { this.v = v; return this; },
        first() { sorgu++; const r = sql.prepare(q).get(...this.v) || null; okunan += r ? 1 : 0; return r; },
        all() { return {results: say(sql.prepare(q).all(...this.v))}; },
        run() { sorgu++; return sql.prepare(q).run(...this.v); }};
    },
    async batch(items) { return items.map(i => i.all()); }
  };
  sql.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Ürün','U1','adet')");
  sql.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,10,10,10,100,1)");
  sql.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('o1','p1',1000000,4600000,'opening','A','2026-07-01')");
  sql.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','trendyol','TY','Mağaza')");
  sql.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','orders','sig',1,'{}','{}','t')");
  sql.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,profile_id,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'a'.repeat(64) + "','2026-09-06T10:00','S','[]',1,1,'applied','pf','t')");
  const ekle = sql.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,components_json) VALUES(?,'st','order_line',?,'provider',?,'2026-09-06T10:00','fl',?,?)");
  const bilesen = JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]});
  for (let i = 0; i < paketSayisi; i++)
    // Teslim edilmiş ama KESİNTİSİ OLMAYAN paket: tahmin bloğu tam da bu durumda çalışır.
    ekle.run('r' + i, 'L:' + i, JSON.stringify({order_no: 'S' + i, package_id: 'P' + i, barcode: 'U1', quantity: 1,
      status: 'Teslim edildi', order_date: '2026-09-01', delivered_date: '2026-09-05', gross: 13200}), i + 1, bilesen);
  return {DB, sayac: () => ({okunan, sorgu}), sifirla: () => { okunan = 0; sorgu = 0; }, close: () => sql.close()};
}

test('Paket sayısı 10 kat artınca okunan satır 10 kat artmaz', async () => {
  const az = fixture(5); let kucuk;
  try { await orderResults(az.DB, 'st', {limit: 100, withEstimates: true}); kucuk = az.sayac(); } finally { az.close(); }

  const cok = fixture(50); let buyuk;
  try { await orderResults(cok.DB, 'st', {limit: 100, withEstimates: true}); buyuk = cok.sayac(); } finally { cok.close(); }

  // Ölçüt PAKET BAŞINA maliyettir. Mağaza başına bir kez okunduğunda bu maliyet SABİT kalır;
  // paket başına tarama geri gelirse paket sayısıyla birlikte büyür (karesel maliyet).
  const kucukBirim = kucuk.okunan / 5, buyukBirim = buyuk.okunan / 50;
  assert.ok(buyukBirim <= kucukBirim * 1.5,
    'paket başına okuma büyüdü: 5 pakette ' + kucukBirim.toFixed(1) + ', 50 pakette ' + buyukBirim.toFixed(1) +
    ' satır (paket başına tarama geri gelmiş olabilir)');
  assert.ok(buyuk.sorgu / 50 <= kucuk.sorgu / 5,
    'paket başına sorgu sayısı büyüdü: ' + kucuk.sorgu + ' → ' + buyuk.sorgu);
});
