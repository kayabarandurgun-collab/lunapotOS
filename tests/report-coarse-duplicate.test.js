// Aynı gider iki ayrı rapordan gelebilir: biri paket no ve tarih taşır, diğeri taşımaz.
// Bileşik anahtar bu alanları içerdiği için iki AYRI kayıt oluşur ve tutar iki kez sayılırdı.
// Kanıtlanan: ayrıntısı eksik olan kopya HESAPTA sayılmaz (ham kayıt silinmez),
// ama gerçekten ayrı iki gider — aynı tutarlı iki paket kargosu — birleştirilmez.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

const ORDER_COLUMNS = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Teslim Tarihi'}];
const ORDER_MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', delivered_date: 'Teslim Tarihi'};
const line = (order, pkg, lineId, gross) => [order, pkg, lineId, 'NOVA-1', 'Ürün', 1, 'Teslim edildi', '01.09.2026', gross, '05.09.2026'];

// KABA finans biçimi: paket no ve tarih sütunu YOK.
const KABA_COLS = [{header: 'Sipariş No'}, {header: 'İşlem Tipi'}, {header: 'Tutar'}];
const KABA_MAP = {order_no: 'Sipariş No', event_type: 'İşlem Tipi', amount: 'Tutar'};
// AYRINTILI biçim: paket no ve tarih var.
const INCE_COLS = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'İşlem Tipi'}, {header: 'Tarih'}, {header: 'Tutar'}];
const INCE_MAP = {order_no: 'Sipariş No', package_id: 'Paket No', event_type: 'İşlem Tipi', event_date: 'Tarih', amount: 'Tutar'};
const TIP = {type_map: {Komisyon: 'commission', Kargo: 'cargo'}, fee_amounts_include_vat: false};

function seed(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('nova','Nova','NV','adet')");
  f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('o1','nova',100000,1000000,'opening','A1','2026-08-01')");
  f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('nova',2000,0,0,0,0,100,100,100,500,1)").run();
  f.sqlite.exec("INSERT INTO ec_catalog_mappings(id,source,match_by,match_value,external_code,active,version,created_at) VALUES('m','trendyol','code','NOVA-1','NOVA-1',0,1,'2026-01-01 00:00:00')");
  f.sqlite.exec("INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES('c','m','nova',1000,10000)");
  f.sqlite.exec("UPDATE ec_catalog_mappings SET active=1 WHERE id='m'");
}

async function fixture() {
  const f = appFixture(); await f.setup(); seed(f);
  const store = async () => (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'})).id;
  const profile = (kind, columns, mapping, options = {}) => f.ok('/ec/reports/profiles',
    {provider: 'trendyol', kind, headers: columns.map(c => c.header), mapping, options});
  async function upload(storeId, kind, columns, rows, snapshot, name) {
    const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns, rows}]));
    const table = await readTable(bytes, {name});
    const c = await f.ok('/ec/reports/files', {store_id: storeId, kind, filename: name, size_bytes: bytes.length,
      sha256: await sha256Hex(bytes), snapshot_at: snapshot, sheet: table.sheet, headers: table.headers,
      date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    await f.ok('/ec/reports/files/' + c.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + c.id + '/rows', {rows: table.rows});
    await f.ok('/ec/reports/files/' + c.id + '/seal', {});
    let r; do { r = await f.ok('/ec/reports/files/' + c.id + '/apply', {}); } while (!r.done);
    return r;
  }
  return {f, store, profile, upload};
}

test('Aynı gider kaba ve ayrıntılı raporda gelirse bir kez sayılır; ham kayıt silinmez', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', '240,00')], '2026-09-01T10:00', 'sip.xlsx');

    await profile('finance', KABA_COLS, KABA_MAP, {...TIP, undated: true});
    await upload(s, 'finance', KABA_COLS, [['S1', 'Komisyon', '-48,00']], '2026-09-03T10:00', 'kaba.xlsx');
    const tek = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(tek.contribution_cents, 20000 - 10000 - 4800, 'tek rapor: 200 − 100 maliyet − 48 komisyon');

    // AYNI komisyon, bu kez paket no ve tarih ile. İki ayrı kayıt oluşur (anahtarlar farklı)...
    await profile('finance', INCE_COLS, INCE_MAP, TIP);
    await upload(s, 'finance', INCE_COLS, [['S1', 'P1', 'Komisyon', '03.09.2026', '-48,00']], '2026-09-04T10:00', 'ince.xlsx');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE kind='finance_event' AND json_extract(data_json,'$.type')='commission'").get().n,
      2, 'iki ham kayıt da duruyor; defter silinmedi');

    // ...ama hesapta komisyon BİR kez sayılır.
    const iki = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(iki.contribution_cents, tek.contribution_cents, 'komisyon ikinci kez düşülmedi');
    assert.ok(iki.notes.some(n => /iki raporda birden/.test(n)), 'durum kullanıcıya not olarak söylendi');
  } finally { f.close(); }
});

test('Gerçekten ayrı iki gider birleştirilmez: iki paketin aynı tutarlı kargosu', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await upload(s, 'orders', ORDER_COLUMNS,
      [line('S1', 'P1', 'L1', '240,00'), line('S1', 'P2', 'L2', '240,00')], '2026-09-01T10:00', 'sip.xlsx');

    // İki paket, ikisi de 46,49 kargo. İkisi de paket no taşıdığı için aynı ayrıntı düzeyinde.
    await profile('finance', INCE_COLS, INCE_MAP, TIP);
    await upload(s, 'finance', INCE_COLS, [
      ['S1', 'P1', 'Kargo', '03.09.2026', '-46,49'],
      ['S1', 'P2', 'Kargo', '03.09.2026', '-46,49']], '2026-09-03T10:00', 'ince.xlsx');

    const {results} = await f.ok('/ec/reports/orders?store_id=' + s);
    const kargo = results.map(r => r.fees.filter(x => x.type === 'cargo').reduce((t, x) => t + x.actual_cents, 0));
    assert.deepEqual(kargo.sort(), [-4649, -4649], 'iki gerçek kargo da sayıldı');
  } finally { f.close(); }
});

test('İki rapor aynı paketin hakedişini söylerse tutarlar TOPLANMAZ; en yeni rapor geçerlidir', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', '240,00')], '2026-09-01T10:00', 'sip.xlsx');

    // Aynı paket için iki finans raporu: eski 130,00 diyor, yeni 120,00.
    const NET_COLS = [{header: 'Sipariş No'}, {header: 'İşlem Tipi'}, {header: 'Tutar'}, {header: 'Net'}];
    const NET_MAP = {order_no: 'Sipariş No', event_type: 'İşlem Tipi', amount: 'Tutar', net_payout: 'Net'};
    await profile('finance', NET_COLS, NET_MAP, {...TIP, undated: true});
    await upload(s, 'finance', NET_COLS, [['S1', 'Komisyon', '-48,00', '130,00']], '2026-09-03T10:00', 'eski.xlsx');
    const tek = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(tek.reported_net_cents, 13000);

    const YENI_COLS = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'İşlem Tipi'}, {header: 'Tarih'}, {header: 'Tutar'}, {header: 'Net'}];
    const YENI_MAP = {order_no: 'Sipariş No', package_id: 'Paket No', event_type: 'İşlem Tipi', event_date: 'Tarih', amount: 'Tutar', net_payout: 'Net'};
    await profile('finance', YENI_COLS, YENI_MAP, TIP);
    await upload(s, 'finance', YENI_COLS, [['S1', 'P1', 'Kargo', '04.09.2026', '-30,00', '120,00']], '2026-09-04T10:00', 'yeni.xlsx');

    const iki = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(iki.reported_net_cents, 12000, '130 + 120 = 250 TOPLANMADI; en yeni rapor geçerli');
    assert.ok(iki.notes.some(n => /Bildirilen hakediş raporlara göre değişiyor/.test(n)), 'çelişki kullanıcıya söylendi');
  } finally { f.close(); }
});

test('Artı gelen gider kalemi sessizce kâra yazılmaz; not düşülür', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', '240,00')], '2026-09-01T10:00', 'sip.xlsx');
    // "İndirim" sütunu gider alanına eşlenmiş ve ARTI geliyor: kârı yükseltiyor.
    await profile('finance', INCE_COLS, INCE_MAP, TIP);
    await upload(s, 'finance', INCE_COLS, [['S1', 'P1', 'Kargo', '03.09.2026', '48,99']], '2026-09-03T10:00', 'ince.xlsx');
    const p = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(p.fees.find(x => x.type === 'cargo').actual_cents, 4899, 'rapordaki tutar değiştirilmedi');
    assert.ok(p.notes.some(n => /ARTI geldi/.test(n)), 'artı gelen kalem işaretlendi');
  } finally { f.close(); }
});

test('Aynı tür gider iki raporda paketsiz ve farklı tutarla gelirse toplanmaz, kâr hesaplanmaz', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', '240,00')], '2026-09-01T10:00', 'sip.xlsx');

    await profile('finance', KABA_COLS, KABA_MAP, {...TIP, undated: true});
    await upload(s, 'finance', KABA_COLS, [['S1', 'Kargo', '-112,80']], '2026-09-03T10:00', 'a.xlsx');
    const tek = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(tek.contribution_cents, 20000 - 10000 - 11280, 'tek rapor varken kâr hesaplanır');

    // İkinci rapor aynı siparişe FARKLI tutarda kargo diyor, paket numarası yok.
    const B_COLS = [{header: 'Sipariş'}, {header: 'Tip'}, {header: 'Tutar'}];
    const B_MAP = {order_no: 'Sipariş', event_type: 'Tip', amount: 'Tutar'};
    await profile('finance', B_COLS, B_MAP, {...TIP, undated: true});
    await upload(s, 'finance', B_COLS, [['S1', 'Kargo', '-211,19']], '2026-09-04T10:00', 'b.xlsx');

    const iki = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(iki.contribution_cents, null, '112,80 + 211,19 sessizce toplanmadı');
    assert.ok(iki.contribution_missing.some(n => /toplanmadı, kâr hesaplanmadı/.test(n)), 'sebebi yazıldı');
  } finally { f.close(); }
});
