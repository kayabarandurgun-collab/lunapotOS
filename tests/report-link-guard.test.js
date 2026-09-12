// Gerçek dosya yüklemesinden başlayan, ÖNİZLEMEYİ ATLAYAN yol.
// İncelemenin istediği bu: koruma isteğe bağlı bir ekran ziyaretine bağlı olamaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

const DATE = '2026-09-12';
const COLUMNS = ['Sipariş', 'Paket', 'Kalem', 'Kod', 'Ürün', 'Adet', 'Durum', 'Tarih', 'Tutar', 'Kargo'].map(header => ({header}));
const MAPPING = {order_no: 'Sipariş', package_id: 'Paket', line_id: 'Kalem', barcode: 'Kod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Tarih', gross: 'Tutar', cargo_package: 'Kargo'};
const stockOf = (f, id) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;

async function setup(f) {
  const product = await f.ok('/ec/products', {name: 'Tek şişe', sku: 'SYNTH-SINGLE', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening',
    reference: 'ACILIS', occurred_on: DATE, notes: 'Sentetik açılış'});
  const mapping = await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'SYNTH-4PACK',
    external_name: '4lü paket', components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  f.sqlite.prepare("UPDATE workspace_settings SET inventory_start_date=? WHERE workspace='ec'").run(DATE);
  const store = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Sentetik mağaza'})).id;
  await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders',
    headers: COLUMNS.map(c => c.header), mapping: MAPPING, options: {}});
  return {product, store, mappingId: mapping.id};
}

/** Gerçek yükleme yolu: xlsx üret → dosya aç → parça → satır → mühürle → uygula. */
async function upload(f, store, row, snapshot, name) {
  const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: COLUMNS, rows: [row]}]));
  const table = await readTable(bytes, {name});
  const file = await f.ok('/ec/reports/files', {store_id: store, kind: 'orders', filename: name, size_bytes: bytes.length,
    sha256: await sha256Hex(bytes), snapshot_at: snapshot, sheet: table.sheet, headers: table.headers,
    date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
  await f.ok('/ec/reports/files/' + file.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
  await f.ok('/ec/reports/files/' + file.id + '/rows', {rows: table.rows});
  await f.ok('/ec/reports/files/' + file.id + '/seal', {});
  let r; do { r = await f.ok('/ec/reports/files/' + file.id + '/apply', {}); } while (!r.done);
  return r;
}
/** Rapor dosyasinda KDV sutunu yok: eksik tutar gercek akista bu adimda tamamlanir. */
async function completeAmounts(f, packageId, mappingId) {
  const line = f.sqlite.prepare('SELECT id FROM ec_order_lines WHERE package_id=?').get(packageId);
  await f.ok('/ec/orders/' + packageId + '/map', {lines: [{id: line.id, mapping_id: mappingId, vat_rate: 20}]});
}
const row = (qty, status, gross) => ['O1', 'PK1', 'L1', 'SYNTH-4PACK', '4lü paket', qty, status, '12.09.2026', gross, '0,00'];

test('Gerçek yüklemeden sonra adet değişirse, önizleme AÇILMADAN rezervasyon engellenir', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product, store} = await setup(f);
    await upload(f, store, row(2, 'Hazırlanıyor', '480,00'), '2026-09-12T10:00', 'ilk.xlsx');
    const linked = await f.ok('/ec/reports/stock-link/apply', {store_id: store, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(linked.applied, true);

    // Yeni rapor adedi 3 yapıyor. Önizleme HİÇ açılmıyor.
    const changed = await upload(f, store, row(3, 'Hazırlanıyor', '720,00'), '2026-09-12T12:00', 'ikinci.xlsx');
    assert.equal(changed.counts.updated, 1);

    const reserve = await f.req('/ec/orders/' + linked.package_id + '/reserve', {});
    assert.equal(reserve.status, 409, 'koruma ekran ziyaretine bağlı olamaz');
    assert.match(reserve.data.error, /raporu değişti/i);
    assert.equal(stockOf(f, product.id), 20000, 'stok değişmedi');
  } finally { f.close(); }
});

test('Gerçek yüklemeden sonra iptal gelirse, rezerve paket sevk edilemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product, store, mappingId} = await setup(f);
    await upload(f, store, row(2, 'Hazırlanıyor', '480,00'), '2026-09-12T10:00', 'ilk.xlsx');
    const linked = await f.ok('/ec/reports/stock-link/apply', {store_id: store, package_id: 'PK1', complete_package_confirmed: true});
    await completeAmounts(f, linked.package_id, mappingId);
    await f.ok('/ec/orders/' + linked.package_id + '/reserve', {});

    await upload(f, store, row(2, 'İptal Edildi', '480,00'), '2026-09-12T12:00', 'iptal.xlsx');
    const ship = await f.req('/ec/orders/' + linked.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-1'});
    assert.equal(ship.status, 409, 'iptal olmuş paket sevk edilemez');
    assert.equal(stockOf(f, product.id), 20000, 'fiziksel stok düşmedi');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n, 0, 'satış kaydı oluşmadı');
  } finally { f.close(); }
});

test('Kaynak değişmediyse gerçek yükleme yolundan rezervasyon ve sevk çalışır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product, store, mappingId} = await setup(f);
    await upload(f, store, row(2, 'Hazırlanıyor', '480,00'), '2026-09-12T10:00', 'ilk.xlsx');
    const linked = await f.ok('/ec/reports/stock-link/apply', {store_id: store, package_id: 'PK1', complete_package_confirmed: true});

    // Kaynak değişmedi: eksik tutar tamamlanır, rezervasyon ve sevk durmamalı.
    await completeAmounts(f, linked.package_id, mappingId);
    await f.ok('/ec/orders/' + linked.package_id + '/reserve', {});
    await f.ok('/ec/orders/' + linked.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-2'});
    assert.equal(stockOf(f, product.id), 12000, '2 ilan × 4 şişe bir kez düştü');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n, 1);
  } finally { f.close(); }
});

test('Rapora bağlı olmayan sipariş bu denetimden etkilenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product} = await setup(f);
    const order = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'ELLE-1', order_no: 'M1', occurred_on: DATE,
      lines: [{external_id: 'L1', sku: 'SYNTH-4PACK', name: '4lü paket', quantity: 1, gross: 240, vat_rate: 20}]});
    await f.ok('/ec/orders/' + order.id + '/reserve', {});
    await f.ok('/ec/orders/' + order.id + '/ship', {occurred_on: DATE, reference: 'ELLE-SEVK'});
    assert.equal(stockOf(f, product.id), 16000, 'elle açılan sipariş normal işler');
  } finally { f.close(); }
});
