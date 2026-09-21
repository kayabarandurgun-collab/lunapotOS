// İLAN BAŞLIĞI → STOK KARTI OTOMATİK EŞLEŞMESİ.
// Canlı Hepsiburada verisi: rapor satırında barkod ve satıcı stok kodu YOK; yalnız HB ilan kodu
// (HBCV…) ve pazarlama başlığı var. Eski kural (ad birebir aynı olacak) bu başlıkları hiç tutmadı;
// 6 paket "ürün eşleşmesi eksik" diye taslakta bekledi ve sahibi elle eşleştirmek zorunda kaldı.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12';
const STORE = 'store-HB-1';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
const stockOf = (f, id) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;

// Canlı başlıklar (birebir, raporun verdiği tek metin).
const KAKTUS_BASLIK = 'Tropikal Besin Takviyeli Kaktüs Toprağı  Sukulent Toprağı Teraryumlara Uygun 2,5 Lt Kaktüs Toprağı';
const ORKIDE_SET_BASLIK = 'Tropikal 3 Lt. Orkide Toprağı ve 500 Ml. Bitki Besini ile Hızlı Gelişim ve Güzel Çiçekler';

// Canlı stok kartları: 2 toprak + "bitki besini 500 ml" taşıyan 6 kart.
const KARTLAR = [
  ['Tropikal Kaktüs ve Sukulent Toprağı 2,5 L', 'TR-KAKTUS-25L'],
  ['Tropikal Orkide Toprağı 3 L', 'TR-ORKIDE-3L'],
  ['Tropikal Genel Bitki Besini 500 ml', 'TR-BES-GENEL'],
  ['Tropikal Kaktüs ve Sukulent Bitki Besini 500 ml', 'TR-BES-KAKTUS'],
  ['Tropikal Orkide Bitki Besini 500 ml', 'TR-BES-ORKIDE'],
  ['Tropikal Yaprak Temizleyici Bitki Besini 500 ml', 'TR-BES-YAPRAK'],
  ['Tropikal Yeşil Yapraklı Bitki Besini 500 ml', 'TR-BES-YESIL'],
  ['Tropikal Çiçek Açan Bitki Besini 500 ml', 'TR-BES-CICEK'],
];

function magaza(f) {
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', STORE, 'hepsiburada', 'HB-1', 'Hepsiburada mağazası');
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
    VALUES('file-HB-1',?,'orders','hb-siparis.xlsx',100,?,?,'[]',1,1,'applied')`, STORE, 'a'.repeat(64), '2026-09-12T10:00');
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
  return STORE;
}

let sira = 0;
/** Gerçek HB satırı: barcode ve seller_sku BOŞ; sku = HB ilan kodu, product_name = pazarlama başlığı. */
function satir(f, {paket, kod, baslik, adet = 1, durum = 'Kargolandı'}) {
  const n = ++sira;
  sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
    VALUES(?,?,'order_line',?,'composite',?,?,?,'file-HB-1',?)`,
    'rec-' + n, STORE, 'P:' + paket + ':' + kod,
    JSON.stringify({package_id: paket, order_no: 'SIP-' + paket, order_date: DATE, barcode: null, seller_sku: null,
      sku: kod, product_name: baslik, quantity: adet, gross: 50000, vat_bps: 2000, status: durum, delivered_date: ''}),
    '2026-09-12T10:00', '2026-09-12T10:00', n);
}

async function katalog(f) {
  const out = {};
  for (const [name, sku] of KARTLAR) {
    const p = await f.ok('/ec/products', {name, sku, stock_unit: 'adet', min_stock: 0, brand: 'Tropikal'});
    await f.ok('/ec/stock', {product_id: p.id, quantity: 10, unit_cost: 20, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Açılış'});
    out[sku] = p.id;
  }
  return out;
}

/** Bakımın yaptığı gibi: atlananları biriktirerek tükenene kadar çağırır. */
async function otomatik(f) {
  const skip = [], hepsi = {};
  for (let i = 0; i < 12; i++) {
    const r = await f.ok('/ec/reports/stock-link/auto', {store_id: STORE, skip});
    for (const x of r.results) { hepsi[x.package_id] = x; if (!x.done) skip.push(x.package_id); }
    if (!r.results.length) break;
  }
  return hepsi;
}
const bilesenler = (f, kod) => f.sqlite.prepare(`SELECT p.sku,c.quantity_milli,c.revenue_share_bps FROM ec_catalog_mapping_components c
  JOIN ec_catalog_mappings m ON m.id=c.mapping_id JOIN ec_products p ON p.id=c.product_id
  WHERE m.match_value=? AND m.active=1 ORDER BY p.sku`).all(kod)
  .map(r => ({sku: r.sku, quantity_milli: r.quantity_milli, revenue_share_bps: r.revenue_share_bps}));
const paketDurumu = (f, paket) => f.sqlite.prepare(`SELECT p.status FROM ec_order_packages p JOIN ec_report_records r ON r.erp_package_id=p.id
  WHERE json_extract(r.data_json,'$.package_id')=?`).get(paket)?.status;

test('Pazarlama başlığı: kartın bütün ayırt edici sözcükleri başlıkta geçiyorsa ve aday TEK ise kendiliğinden bağlanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-1', kod: 'HBCV00006H32VP', baslik: KAKTUS_BASLIK});

    const r = await otomatik(f);
    assert.ok(r['HBP-1']?.done, 'paket işlenmedi: ' + JSON.stringify(r['HBP-1']));
    assert.match(r['HBP-1'].done, /eşleştirildi/);
    assert.equal(paketDurumu(f, 'HBP-1'), 'shipped', 'paket taslaktan çıktı');
    assert.equal(stockOf(f, k['TR-KAKTUS-25L']), 9000, 'yalnız kaktüs toprağından 1 adet düştü');
    assert.equal(stockOf(f, k['TR-BES-KAKTUS']), 10000, 'besin kartına dokunulmadı');
    assert.deepEqual(bilesenler(f, 'HBCV00006H32VP'), [{sku: 'TR-KAKTUS-25L', quantity_milli: 1000, revenue_share_bps: 10000}]);
  } finally { f.close(); }
});

test('Set başlığı: "ve" ile ayrılan iki ürün tek tek çözülür, iki bileşenli bağlantı kurulur', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-2', kod: 'HBCV00001V0IQJ', baslik: ORKIDE_SET_BASLIK});

    const r = await otomatik(f);
    assert.ok(r['HBP-2']?.done, 'set paketi işlenmedi: ' + JSON.stringify(r['HBP-2']));
    const c = bilesenler(f, 'HBCV00001V0IQJ');
    assert.deepEqual(c.map(x => x.sku), ['TR-BES-ORKIDE', 'TR-ORKIDE-3L'], 'orkide toprağı + orkide bitki besini');
    assert.deepEqual(c.map(x => x.quantity_milli), [1000, 1000], 'her bileşen birer adet');
    assert.equal(c.reduce((s, x) => s + x.revenue_share_bps, 0), 10000, 'paylar tam %100');
    // "Güzel Çiçekler" sözü "Çiçek Açan" kartını aday yapmaz; ayırt edici sözcüğün tamamı aranır.
    assert.equal(stockOf(f, k['TR-BES-CICEK']), 10000, 'çiçek açan besin kartına dokunulmadı');
    assert.equal(stockOf(f, k['TR-BES-GENEL']), 10000, 'genel besin kartına dokunulmadı');
    assert.equal(stockOf(f, k['TR-ORKIDE-3L']), 9000, 'orkide toprağı bir kez düştü');
    assert.equal(stockOf(f, k['TR-BES-ORKIDE']), 9000, 'orkide besini bir kez düştü');
  } finally { f.close(); }
});

test('Belirsiz başlık eşleşmez: sebebi Türkçe söylenir, sipariş taslakta kalır, uydurma bağlantı kurulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-3', kod: 'HBCV00000BELIRSIZ', baslik: '500 ml bitki besini'});

    const r = await otomatik(f);
    assert.ok(r['HBP-3']?.skipped, 'belirsiz başlık aktarılmamalı');
    assert.match(r['HBP-3'].reason, /eşleşmedi/, 'sebep Türkçe ve anlaşılır: ' + r['HBP-3'].reason);
    assert.equal(paketDurumu(f, 'HBP-3'), 'draft');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_catalog_mappings WHERE match_value='HBCV00000BELIRSIZ'").get().n, 0);
    for (const sku of Object.keys(k)) assert.equal(stockOf(f, k[sku]), 10000, sku + ' stoğu değişmedi');

    // Birden çok kart uyuyorsa da hiçbir şey kurulmaz; aday adları sebebe yazılır ki sahibi seçebilsin.
    await f.ok('/ec/products', {name: 'Orkide Toprağı', sku: 'TR-ORKIDE-SADE', stock_unit: 'adet', min_stock: 0, brand: ''});
    satir(f, {paket: 'HBP-3B', kod: 'HBCV00000COKADAY', baslik: 'Tropikal Orkide Toprağı 3 Lt'});
    const iki = await otomatik(f);
    assert.ok(iki['HBP-3B']?.skipped);
    assert.match(iki['HBP-3B'].reason, /Birden çok stok kartı/, iki['HBP-3B'].reason);
    assert.match(iki['HBP-3B'].reason, /Tropikal Orkide Toprağı 3 L.*Orkide Toprağı/, 'aday adları söylenir');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_catalog_mappings WHERE match_value='HBCV00000COKADAY'").get().n, 0);
  } finally { f.close(); }
});

test('Başlıktaki çokluk bileşen miktarına yazılır: 2’li paket 2 adet düşer', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-4', kod: 'HBCV00000COKLU', baslik: 'Tropikal Orkide Toprağı 3 Lt 2’li Paket'});

    const r = await otomatik(f);
    assert.ok(r['HBP-4']?.done, JSON.stringify(r['HBP-4']));
    assert.deepEqual(bilesenler(f, 'HBCV00000COKLU'), [{sku: 'TR-ORKIDE-3L', quantity_milli: 2000, revenue_share_bps: 10000}]);
    assert.equal(stockOf(f, k['TR-ORKIDE-3L']), 8000, '1 satış × 2 adet düştü');
  } finally { f.close(); }
});

test('Kurulan bağlantı hatırlanır: aynı ilanın ikinci siparişi yeniden çözülmeden bağlanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-5', kod: 'HBCV00006H32VP', baslik: KAKTUS_BASLIK});
    await otomatik(f);
    const surum = f.sqlite.prepare("SELECT id,version FROM ec_catalog_mappings WHERE match_value='HBCV00006H32VP' AND active=1").get();

    satir(f, {paket: 'HBP-6', kod: 'HBCV00006H32VP', baslik: KAKTUS_BASLIK, adet: 3});
    const r = await otomatik(f);
    assert.ok(r['HBP-6']?.done, JSON.stringify(r['HBP-6']));
    assert.deepEqual(f.sqlite.prepare("SELECT id,version FROM ec_catalog_mappings WHERE match_value='HBCV00006H32VP' AND active=1").get(), surum,
      'ikinci satış yeni bağlantı sürümü yaratmaz');
    assert.equal(stockOf(f, k['TR-KAKTUS-25L']), 6000, '1 + 3 adet düştü');
  } finally { f.close(); }
});

test('Geriye dönük: yeni yükleme olmadan, taslakta bekleyen eski paket bakım turunda eşleşip gönderilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    satir(f, {paket: 'HBP-7', kod: 'HBCV00001V0IQJ', baslik: ORKIDE_SET_BASLIK});
    // Eski kuralla açılmış taslak: satırın hiç bileşeni yok, "ürün eşleşmesi eksik".
    const acilan = await f.ok('/ec/reports/stock-link/apply', {store_id: STORE, package_id: 'HBP-7',
      complete_package_confirmed: true, line_identity_from_package_sku: true});
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?')
      .get(acilan.package_id).n, 0, 'taslak eşleşmesiz açıldı');

    const r = await otomatik(f);
    assert.ok(r['HBP-7']?.done, 'bekleyen taslak alınmadı: ' + JSON.stringify(r['HBP-7']));
    assert.equal(paketDurumu(f, 'HBP-7'), 'shipped');
    assert.equal(stockOf(f, k['TR-ORKIDE-3L']), 9000);
    assert.equal(stockOf(f, k['TR-BES-ORKIDE']), 9000);
  } finally { f.close(); }
});

test('Otomatik eşleşme görünür ve geri alınabilir; sahibinin kurduğu bağlantı hiç değiştirilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const k = await katalog(f); magaza(f);
    // Sahibinin elle kurduğu bağlantı.
    const elle = await f.ok('/ec/catalog/mappings', {source: 'hepsiburada', match_by: 'code', external_code: 'HBCV00000ELLE',
      external_name: 'Elle kurulmuş ilan', components: [{product_id: k['TR-BES-GENEL'], quantity_milli: 1000, revenue_share_bps: 10000}]});
    satir(f, {paket: 'HBP-8', kod: 'HBCV00000ELLE', baslik: KAKTUS_BASLIK});
    satir(f, {paket: 'HBP-9', kod: 'HBCV00006H32VP', baslik: KAKTUS_BASLIK});
    await otomatik(f);

    const katalogGorunumu = await f.ok('/ec/catalog');
    const oto = katalogGorunumu.mappings.find(m => m.match_value === 'HBCV00006H32VP');
    assert.ok(oto, 'otomatik bağlantı listede');
    assert.equal(oto.auto_matched, 1, 'ekran otomatik eşleşmeyi rozetle gösterebilsin');
    const sahibin = katalogGorunumu.mappings.find(m => m.id === elle.id);
    assert.equal(sahibin.auto_matched, 0, 'sahibinin kurduğu bağlantı otomatik damgası almaz');
    assert.equal(sahibin.active, 1, 'sahibinin bağlantısı üzerine yazılmadı');
    // Sahibinin bağlantısı, başlık başka kartı gösterse de olduğu gibi uygulandı.
    assert.equal(stockOf(f, k['TR-BES-GENEL']), 9000, 'elle kurulan bağlantı uygulandı');

    // Geri alma: sahibi yeni sürümle değiştirince otomatik damgası düşer.
    const yeni = await f.ok('/ec/catalog/mappings', {source: 'hepsiburada', match_by: 'code', external_code: 'HBCV00006H32VP',
      external_name: oto.external_name, replaces_id: oto.id,
      components: [{product_id: k['TR-BES-ORKIDE'], quantity_milli: 1000, revenue_share_bps: 10000}]});
    const sonra = await f.ok('/ec/catalog');
    assert.equal(sonra.mappings.find(m => m.id === yeni.id).auto_matched, 0, 'sahibinin düzelttiği sürüm otomatik sayılmaz');

    const ui = readFileSync(new URL('../public/catalog-ui.js', import.meta.url), 'utf8');
    assert.match(ui, /auto_matched/, 'ekran alanı okuyor');
    assert.match(ui, /otomatik eşleşti/, 'Türkçe rozet metni');
  } finally { f.close(); }
});
