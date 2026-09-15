// Rapordaki kesintiler → satış kayıtları köprüsü.
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR. Fatura olmadan kesinti aktarımı doğrulanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12', TESLIM = '2026-09-14';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);

function store(f, {provider = 'trendyol', code = 'TY-1'} = {}) {
  const id = 'store-' + code;
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', id, provider, code, 'Mağaza ' + code);
  sql(f, "INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)" +
    " VALUES(?,?,'orders','rapor.xlsx',100,?,?,'[]',1,1,'applied')", 'file-' + code, id, 'f'.repeat(64), '2026-09-12T10:00');
  return id;
}
const rec = (f, storeId, kind, recordKey, data, n) =>
  sql(f, "INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)" +
    " VALUES(?,?,?,?,'provider',?,?,?,'file-TY-1',?)",
  'rec-' + n, storeId, kind, recordKey, JSON.stringify(data), '2026-09-12T10:00', '2026-09-12T10:00', n);

const orderLine = (over = {}) => ({package_id: 'PK1', line_id: 'L1', order_no: 'O1', order_date: DATE, delivered_date: TESLIM,
  barcode: '785457868', product_name: '4 adet 225 ml', quantity: 2, gross: 50000, vat_bps: 2000, status: 'Teslim edildi', ...over});
const feeOf = (f, saleId) => ({...f.sqlite.prepare('SELECT commission_cents,shipping_cents,other_cents,fees_status FROM ec_sale_entries WHERE id=?').get(saleId)});

/** Teslim edilmiş, ERP'ye bağlanmış, kesintileri raporda duran bir paket kurar. */
async function delivered(f, {teslimTarihi = TESLIM, kargo = true} = {}) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  const s = store(f);
  rec(f, s, 'order_line', 'L:L1', orderLine(teslimTarihi ? {} : {delivered_date: undefined, status: 'Kargoda'}), 1);
  // Pazaryerinin kendi hesap raporundaki kesintiler: eksi işaretli gelirler.
  rec(f, s, 'finance_event', 'F:K1', {event_id: 'K1', order_no: 'O1', package_id: 'PK1', type: 'commission', amount_cents: -8000, event_date: TESLIM}, 2);
  if (kargo) rec(f, s, 'finance_event', 'F:K2', {event_id: 'K2', order_no: 'O1', package_id: 'PK1', type: 'cargo', amount_cents: -5000, event_date: TESLIM}, 3);
  rec(f, s, 'finance_event', 'F:K3', {event_id: 'K3', order_no: 'O1', package_id: 'PK1', type: 'service', amount_cents: -1000, event_date: TESLIM}, 4);
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
  const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
  await f.ok('/ec/orders/' + applied.package_id + '/reserve', {});
  await f.ok('/ec/orders/' + applied.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-1'});
  if (teslimTarihi) await f.ok('/ec/orders/' + applied.package_id + '/deliver', {occurred_on: teslimTarihi});
  const sale = f.sqlite.prepare("SELECT id FROM ec_sale_entries WHERE kind='sale'").get().id;
  return {product, s, sale, packageId: applied.package_id};
}

test('Kesintiler rapordan satış kayıtlarına FATURA OLMADAN aktarılır; önizleme yazmaz; ikinci aktarım değiştirmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {s, sale} = await delivered(f);
    assert.deepEqual(feeOf(f, sale), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'});

    const onizleme = await f.ok('/ec/reports/apply-fees?store_id=' + s);
    assert.equal(onizleme.sale_entries_changed, 1);
    assert.deepEqual(onizleme.totals, {commission: 8000, shipping: 5000, other: 1000}, 'rapordaki eksi tutar deftere artı kesinti olur');
    assert.equal(feeOf(f, sale).commission_cents, null, 'önizleme hiçbir şey yazmadı');

    // Onaysız istek geçmez.
    assert.equal((await f.req('/ec/reports/apply-fees', {store_id: s})).status, 400);

    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: s, confirm: true});
    assert.equal(yazildi.sale_entries_changed, 1);
    assert.deepEqual(feeOf(f, sale), {commission_cents: 8000, shipping_cents: 5000, other_cents: 1000, fees_status: 'confirmed'},
      'üç bileşen de rapordan bilindiği için kesinleşmiş sayılır');

    // Aynı rapor tekrar aktarılırsa: yazma SET'tir, toplama değil.
    const tekrar = await f.ok('/ec/reports/apply-fees', {store_id: s, confirm: true});
    assert.equal(tekrar.sale_entries_changed, 0, 'ikinci aktarım hiçbir kaydı değiştirmedi');
    assert.deepEqual(feeOf(f, sale), {commission_cents: 8000, shipping_cents: 5000, other_cents: 1000, fees_status: 'confirmed'});
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n, 1, 'denetim izi de çoğalmadı');
  } finally { f.close(); }
});

test('Aktarım stok, satış tutarı ve fatura oluşturmaz; yalnızca kesinti alanlarını doldurur', async () => {
  const f = appFixture(); await f.setup(); try {
    const {s, sale} = await delivered(f);
    const say = () => ['ec_stock_movements', 'ec_sale_entries', 'ec_purchase_invoices', 'ec_fee_allocations']
      .map(t => f.sqlite.prepare('SELECT COUNT(*) n FROM ' + t).get().n);
    const gelir = () => f.sqlite.prepare('SELECT revenue_cents,cost_cents FROM ec_sale_entries WHERE id=?').get(sale);
    const once = say(), gelirOnce = gelir();
    await f.ok('/ec/reports/apply-fees', {store_id: s, confirm: true});
    assert.deepEqual(say(), once, 'stok hareketi, satış kaydı, fatura ve gider dağıtımı sayısı değişmedi');
    assert.deepEqual(gelir(), gelirOnce, 'satış tutarı ve maliyet değişmedi');
  } finally { f.close(); }
});

test('Teslim edilmemiş pakete kesinti yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    // Rapor kayıtları değiştirilemez (REPORT_RECORD_VERSION); paket baştan teslimsiz kurulur.
    const {s, sale, packageId} = await delivered(f, {teslimTarihi: null});
    const sonuc = await f.ok('/ec/reports/apply-fees?store_id=' + s);
    assert.equal(sonuc.sale_entries_changed, 0);
    assert.ok(sonuc.skipped.some(x => /Teslim edilmedi/.test(x.reason)), 'gerekçe bildirilir');
    assert.equal(feeOf(f, sale).commission_cents, null);
    assert.ok(packageId);
  } finally { f.close(); }
});

test('Komisyon veya kargo raporda yoksa sıfır yazılmaz; paket atlanır', async () => {
  const f = appFixture(); await f.setup(); try {
    // Rapor kayıtları silinemez (IMMUTABLE_LEDGER); paket baştan kargo kesintisiz kurulur.
    const {s, sale} = await delivered(f, {kargo: false});
    const sonuc = await f.ok('/ec/reports/apply-fees?store_id=' + s);
    assert.equal(sonuc.sale_entries_changed, 0);
    assert.ok(sonuc.skipped.some(x => /kargo kesintisi yok/.test(x.reason)));
    assert.equal(feeOf(f, sale).shipping_cents, null, 'bilinmeyen kesinti 0 sayılmadı');
  } finally { f.close(); }
});
