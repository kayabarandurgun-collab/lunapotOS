// Rapor Kutusu → sipariş → stok köprüsü.
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR. Stok kuralları doğrulanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);

/** Rapor dosyası + kayıtları doğrudan yazar (yükleme akışı ayrıca test ediliyor). */
function store(f, {provider = 'trendyol', code = 'TY-1'} = {}) {
  const id = 'store-' + code;
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', id, provider, code, 'Mağaza ' + code);
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
    VALUES(?,?,'orders','rapor.xlsx',100,?,?,'[]',1,1,'applied')`, 'file-' + code, id, 'f'.repeat(64), '2026-09-12T10:00');
  return id;
}
function record(f, storeId, code, data, n) {
  sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
    VALUES(?,?,'order_line',?,'provider',?,?,?,?,?)`,
    'rec-' + code + '-' + n, storeId, 'L:' + data.line_id, JSON.stringify(data), '2026-09-12T10:00', '2026-09-12T10:00', 'file-' + code, n);
}
const startDate = (f, date) => sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', date, 'ec');
const line = (over = {}) => ({package_id: 'PK1', line_id: 'L1', order_no: 'O1', order_date: DATE,
  barcode: '785457868', product_name: '4 adet 225 ml', quantity: 2, gross: 50000, vat_bps: 2000, status: 'Teslim edildi', ...over});
const stockOf = (f, id) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;

/** Dörtlü paket ilanı: 1 ilan = 4 şişe. */
async function fourPack(f) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  return product;
}

test('Önizleme yazmaz; stok başlangıcı girilmeden geçmiş sipariş uygulanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);

    const blocked = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(blocked.outcome, 'blocked', 'stok başlangıç tarihi yokken aktarılamaz');
    assert.equal(blocked.stock_write, false);

    startDate(f, DATE);
    const ready = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(ready.outcome, 'draft');
    assert.equal(ready.order.lines.length, 1);
    assert.equal(ready.order.lines[0].quantity, 2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0, 'önizleme sipariş açmadı');
  } finally { f.close(); }
});

test('Aktarım tek taslak sipariş açar; stok ancak gönderimde bir kez düşer, tekrar aktarım çoğaltmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);

    // Paketin tamamı doğrulanmadan aktarılmaz.
    assert.equal((await f.req('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1'})).status, 409);

    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.applied, true);
    assert.equal(applied.stock_write, false, 'aktarım stok yazmaz');
    assert.equal(stockOf(f, product.id), 20000, 'stok henüz değişmedi');

    // Stok yalnız sipariş adımlarında değişir: 2 ilan × 4 şişe = 8.
    await f.ok('/ec/orders/' + applied.package_id + '/reserve', {});
    await f.ok('/ec/orders/' + applied.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-1'});
    assert.equal(stockOf(f, product.id), 12000, '2 paket × 4 şişe bir kez düştü');

    // Aynı paketi yeniden aktarmak ikinci sipariş veya ikinci çıkış yaratmaz.
    const again = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(again.applied, false);
    assert.equal(again.outcome, 'existing');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 1);
    assert.equal(stockOf(f, product.id), 12000, 'tekrar aktarım stoğu çoğaltmadı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n, 1);
  } finally { f.close(); }
});

test('KDV oranı bilinmeyen pakette stok ayrılamaz; kural gevşetilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', {...line(), vat_bps: undefined}, 1);
    startDate(f, DATE);
    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.applied, true, 'taslak açılır');
    const reserve = await f.req('/ec/orders/' + applied.package_id + '/reserve', {});
    assert.equal(reserve.status, 409, 'KDV hariç tutar bilinmeden stok ayrılmaz');
    assert.match(reserve.data.error, /tutarı eksik/i);
    assert.equal(stockOf(f, product.id), 20000, 'stok değişmedi');
  } finally { f.close(); }
});

test('Stok başlangıcından eski sipariş bugünkü stoktan düşülmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line({order_date: '2026-07-01'}), 1);
    startDate(f, DATE);
    const result = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(result.outcome, 'historical');
    assert.equal(result.applied, false);
    assert.equal(stockOf(f, product.id), 20000);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0);
  } finally { f.close(); }
});

test('İptal/iade, eksik kimlik ve çelişkili sipariş incelemede kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    startDate(f, DATE);

    record(f, s, 'TY-1', line({package_id: 'PK-IADE', line_id: 'LI', status: 'İade Edildi'}), 1);
    const refund = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-IADE'});
    assert.equal(refund.outcome, 'review');
    assert.ok(refund.issues.some(i => /yeni satışa çevrilmez/.test(i)));

    record(f, s, 'TY-1', {package_id: 'PK-EKSIK', order_no: 'O9', order_date: DATE, barcode: '785457868', quantity: 1, status: 'Teslim edildi'}, 2);
    const missing = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-EKSIK'});
    assert.equal(missing.outcome, 'review');
    assert.ok(missing.issues.some(i => /Kalem kimliği eksik/.test(i)));

    // Aynı pakette iki farklı sipariş numarası
    record(f, s, 'TY-1', line({package_id: 'PK-CELISKI', line_id: 'LC1', order_no: 'A'}), 3);
    record(f, s, 'TY-1', line({package_id: 'PK-CELISKI', line_id: 'LC2', order_no: 'B'}), 4);
    const conflict = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-CELISKI'});
    assert.equal(conflict.outcome, 'review');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0);
  } finally { f.close(); }
});

test('Aynı paket numarası iki mağazada karışmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const a = store(f, {code: 'TY-1'}), b = store(f, {code: 'TY-2'});
    record(f, a, 'TY-1', line(), 1);
    record(f, b, 'TY-2', line({line_id: 'L2'}), 1);
    startDate(f, DATE);

    const first = await f.ok('/ec/reports/stock-link/apply', {store_id: a, package_id: 'PK1', complete_package_confirmed: true});
    const second = await f.ok('/ec/reports/stock-link/apply', {store_id: b, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(first.applied, true);
    assert.equal(second.applied, true);
    assert.notEqual(first.package_id, second.package_id, 'iki mağaza ayrı sipariş açar');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 2);
  } finally { f.close(); }
});

test('Aktarılabilir paketler listelenir ve bağlanan paket işaretlenir', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);
    let list = await f.ok('/ec/reports/stock-link/candidates?store_id=' + s);
    assert.equal(list.inventory_start_date, DATE);
    assert.equal(list.candidates.length, 1);
    assert.equal(list.candidates[0].linked, false);

    await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    list = await f.ok('/ec/reports/stock-link/candidates?store_id=' + s);
    assert.equal(list.candidates[0].linked, true, 'bağlanan paket işaretli');
  } finally { f.close(); }
});
