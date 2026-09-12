// Stok başlangıç tarihi: kaydedilir, uydurulmaz ve rapor→stok köprüsünü açar.
// TEMSİLİ veri; gerçek işletme kaydı değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12';
const company = extra => ({legal_name: 'Sentetik İşletme', tax_id: '1234567890', ...extra});
const sql = (f, q, ...a) => f.sqlite.prepare(q).run(...a);

test('Stok başlangıç tarihi kaydedilir, boş bırakılabilir ve uydurulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    // Başlangıçta yok: tahmin edilmez.
    assert.equal((await f.ok('/ec/settings')).settings.inventory_start_date, null);

    await f.ok('/ec/settings', company({inventory_start_date: DATE}));
    assert.equal((await f.ok('/ec/settings')).settings.inventory_start_date, DATE);

    // Boş gönderim tarihi TEMİZLER; sessizce eski değeri korumaz.
    await f.ok('/ec/settings', company({inventory_start_date: ''}));
    assert.equal((await f.ok('/ec/settings')).settings.inventory_start_date, null);

    // Geçersiz ve gelecek tarih reddedilir.
    assert.equal((await f.req('/ec/settings', company({inventory_start_date: '12.09.2026'}))).status, 400);
    assert.equal((await f.req('/ec/settings', company({inventory_start_date: '2026-02-30'}))).status, 400);
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const rejected = await f.req('/ec/settings', company({inventory_start_date: future}));
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /gelecekte olamaz/i);
    assert.equal((await f.ok('/ec/settings')).settings.inventory_start_date, null, 'reddedilen tarih yazılmadı');
  } finally { f.close(); }
});

test('Tarih girilmeden geçmiş sipariş stoğa uygulanmaz; girilince taslak açılabilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await f.ok('/ec/products', {name: 'Sentetik şişe', sku: 'SYNTH-1', stock_unit: 'adet', min_stock: 0});
    await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening',
      reference: 'ACILIS', occurred_on: DATE, notes: 'Sentetik açılış'});
    await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'SYNTH-CODE',
      external_name: 'Sentetik', components: [{product_id: product.id, quantity_milli: 1000, revenue_share_bps: 10000}]});

    const store = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Sentetik mağaza'})).id;
    sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
      VALUES('file-1',?,'orders','r.xlsx',100,?,'2026-09-12T10:00','[]',1,1,'applied')`, store, 'f'.repeat(64));
    sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
      VALUES('rec-1',?,'order_line','L:L1','provider',?,'2026-09-12T10:00','2026-09-12T10:00','file-1',1)`,
      store, JSON.stringify({package_id: 'PK1', line_id: 'L1', order_no: 'O1', order_date: DATE,
        barcode: 'SYNTH-CODE', product_name: 'Sentetik', quantity: 2, gross: 48000, vat_bps: 2000, status: 'Teslim edildi'}));

    // Tarih yokken: engellenir, stok değişmez.
    const blocked = await f.ok('/ec/reports/stock-link/preview', {store_id: store, package_id: 'PK1'});
    assert.equal(blocked.outcome, 'blocked');
    assert.match(blocked.reason, /[Ss]tok başlangıç/);

    // Tarih girilince aynı paket aktarılabilir hâle gelir.
    await f.ok('/ec/settings', company({inventory_start_date: DATE}));
    const ready = await f.ok('/ec/reports/stock-link/preview', {store_id: store, package_id: 'PK1'});
    assert.equal(ready.outcome, 'draft');
    assert.equal(f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(product.id).quantity_milli,
      20000, 'önizleme stok değiştirmez');
  } finally { f.close(); }
});
