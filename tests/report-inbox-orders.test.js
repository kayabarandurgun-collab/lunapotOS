// Sipariş sonuçlarının aranması, sayfalanması ve sonradan tanımlanan eşleştirmenin tamamlanması.
// TEMSİLİ sütun adları: gerçek Trendyol/Hepsiburada başlıkları DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

const ORDER_COLUMNS = [
  {header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Kargo'}
];
const ORDER_MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo'};
const line = (order, pkg, lineId, barcode, status, date) =>
  [order, pkg, lineId, barcode, 'Ürün ' + barcode, 1, status, date, '240,00', '0,00'];

function seed(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('nova','Nova','NV','adet')");
  f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('o1','nova',10000,100000,'opening','A1','2026-08-01')");
  f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('nova',2000,0,0,0,0,100,100,100,500,1)").run();
}
async function fixture() {
  const f = appFixture(); await f.setup(); seed(f);
  const store = async (code = 'TY-1') => (await f.ok('/ec/reports/stores', {provider: 'trendyol', code, name: 'Mağaza ' + code})).id;
  async function upload(storeId, rows, snapshot, name) {
    const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: ORDER_COLUMNS, rows}]));
    const table = await readTable(bytes, {name});
    const created = await f.ok('/ec/reports/files', {store_id: storeId, kind: 'orders', filename: name, size_bytes: bytes.length,
      sha256: await sha256Hex(bytes), snapshot_at: snapshot, sheet: table.sheet, headers: table.headers, date1904: table.date1904,
      row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    await f.ok('/ec/reports/files/' + created.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    for (let i = 0; i < table.rows.length; i += 500) await f.ok('/ec/reports/files/' + created.id + '/rows', {rows: table.rows.slice(i, i + 500)});
    await f.ok('/ec/reports/files/' + created.id + '/seal', {});
    let r; do { r = await f.ok('/ec/reports/files/' + created.id + '/apply', {}); } while (!r.done);
    return created;
  }
  return {f, store, upload};
}

test('Sipariş sonuçları aranır, duruma göre süzülür ve gerçek toplamla sayfalanır', async () => {
  const {f, store, upload} = await fixture(); try {
    const s = await store();
    await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: ORDER_COLUMNS.map(c => c.header), mapping: ORDER_MAPPING, options: {}});
    // 120 sipariş: tek sayfadan fazlası görünebilmeli (sayfa 100).
    const rows = Array.from({length: 120}, (_, i) => line('S' + String(i).padStart(3, '0'), 'P' + i, 'L' + i, 'NOVA-1',
      i === 7 ? 'İptal' : 'Teslim edildi', '01.09.2026'));
    rows.push(line('ARANAN-1', 'PX', 'LX', 'ARANAN-BARKOD', 'Teslim edildi', '02.09.2026'));
    await upload(s, rows, '2026-09-03T10:00', 'siparisler.xlsx');

    const first = await f.ok('/ec/reports/orders?store_id=' + s);
    assert.equal(first.total, 121, 'toplam gerçek sipariş sayısı');
    assert.equal(first.page, 1);
    assert.equal(first.results.length, 100, 'ilk sayfa 100 sipariş');
    const second = await f.ok('/ec/reports/orders?store_id=' + s + '&page=2');
    assert.equal(second.results.length, 21, '100 siparişten fazlası görünür');
    assert.equal(second.total, 121);
    const firstOrders = new Set(first.results.map(r => r.order_no));
    assert.ok(second.results.every(r => !firstOrders.has(r.order_no)), 'sayfalar aynı siparişi tekrarlamaz');

    // Arama: sipariş no, barkod ve ürün adında geçer.
    const byOrder = await f.ok('/ec/reports/orders?store_id=' + s + '&q=ARANAN-1');
    assert.equal(byOrder.total, 1);
    assert.equal(byOrder.results[0].order_no, 'ARANAN-1');
    const byBarcode = await f.ok('/ec/reports/orders?store_id=' + s + '&q=aranan-barkod');
    assert.equal(byBarcode.total, 1, 'arama büyük/küçük harfe duyarsız');

    // Durum süzgeci ve seçenek listesi.
    assert.ok(first.statuses.includes('İptal') && first.statuses.includes('Teslim edildi'));
    const cancelled = await f.ok('/ec/reports/orders?store_id=' + s + '&status=' + encodeURIComponent('İptal'));
    assert.equal(cancelled.total, 1);
    assert.equal(cancelled.results[0].status, 'İptal');
  } finally { f.close(); }
});

test('Eksik ürün eşleştirmesi tamamlanırken kalan GERÇEK toplamı gösterir ve kaldığı yerden ilerler', async () => {
  const {f, store, upload} = await fixture(); try {
    const s = await store();
    await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: ORDER_COLUMNS.map(c => c.header), mapping: ORDER_MAPPING, options: {}});
    // Üçü aynı barkod (sonradan eşleştirilecek), biri hiç tanımlanmayacak.
    await upload(s, [line('S1', 'P1', 'L1', 'SONRA-1', 'Teslim edildi', '01.09.2026'),
      line('S2', 'P2', 'L2', 'SONRA-1', 'Teslim edildi', '01.09.2026'),
      line('S3', 'P3', 'L3', 'SONRA-1', 'Teslim edildi', '01.09.2026'),
      line('S4', 'P4', 'L4', 'HIC-YOK', 'Teslim edildi', '01.09.2026')], '2026-09-02T10:00', 'siparisler.xlsx');

    const before = await f.ok('/ec/reports/backfill-components', {store_id: s});
    assert.equal(before.filled, 0);
    assert.equal(before.remaining, 4, 'kalan, partideki artık değil gerçek toplam');
    assert.equal(before.done, true);
    assert.ok(before.next_cursor, 'kaldığı yeri işaretler');

    // Eşleştirme sonradan tanımlanır.
    f.sqlite.exec("INSERT INTO ec_catalog_mappings(id,source,match_by,match_value,external_code,active,version,created_at) VALUES('m1','trendyol','code','SONRA-1','SONRA-1',0,1,'2026-09-05 00:00:00')");
    f.sqlite.exec("INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES('c1','m1','nova',1000,10000)");
    f.sqlite.exec("UPDATE ec_catalog_mappings SET active=1 WHERE id='m1'");

    const run1 = await f.ok('/ec/reports/backfill-components', {store_id: s});
    assert.equal(run1.filled, 3, 'yalnız eşleşmesi bulunan kayıtlar dolduruldu');
    assert.equal(run1.remaining, 1, 'eşleşmesi olmayan kayıt kalır ve silinmez');

    // İkinci çağrı aynı kayıtları yeniden doldurmaz.
    const run2 = await f.ok('/ec/reports/backfill-components', {store_id: s});
    assert.equal(run2.filled, 0);
    assert.equal(run2.remaining, 1);
    const filled = f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE kind='order_line' AND components_json IS NOT NULL").get().n;
    assert.equal(filled, 3);
  } finally { f.close(); }
});
