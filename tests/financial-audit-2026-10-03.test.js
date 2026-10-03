// 3 Ekim mali denetimi: yalnız sentetik, bellekte veritabanı; canlı veri kullanılmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {performanceReport} from '../src/performance-api.js';
import {otomatikEngelKarari} from '../public/purchase-document-ui.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
const one = (f, q, ...args) => f.sqlite.prepare(q).get(...args);
async function fixture() { const f = appFixture(); await f.setup(); return f; }
function supplier(f, numbers = []) {
  sql(f, "INSERT INTO ec_suppliers(id,name,tax_id) VALUES('s1','Sentetik tedarikçi','1234567890')");
  numbers.forEach((no, i) => sql(f, "INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date,currency) VALUES(?,'s1',?,?,'TRY')", 'hist-' + i, no, DATE));
}
const document = (overrides = {}) => ({kind: 'pdf', filename: 'sentetik.pdf', sha256: 'a'.repeat(64), size_bytes: 20,
  chunk_count: 1, supplier_tax_id: '1234567890', doc_no: 'ABC2026000000004', text_layer: false, ...overrides});
const gate = warning => otomatikEngelKarari({ocr: true, supplierId: 's1', formatWarning: warning || '',
  header: {invoice_no: 'ABC2026000000004', invoice_date: DATE, uncertain: ['invoice_no']},
  lines: [{description: 'Torf', invoice_quantity: 1, net: 100, tax: 20, uncertain: ['net']}], totals: {net: 100, tax: 20}});
const HISTORY = ['ABC2026000000001', 'ABC2026000000002', 'ABC2026000000003'];

for (const [name, history] of [['yok', []], ['iki fatura', HISTORY.slice(0, 2)], ['karışık kalıp', [HISTORY[0], HISTORY[1], 'XYZ2026000000003']]]) {
  test('FA01 OCR: numara geçmişi ' + name + ' ise otomatik kayıt için doğrulama sayılmaz', async () => {
    const f = await fixture(); try {
      supplier(f, history);
      const d = await f.ok('/ec/invoices/documents', document());
      assert.ok(d.id, 'belge saklanabilir; manuel işlem engellenmez');
      assert.notEqual(gate(d.format_warning), null, 'doğrulanamayan numara OCR kapısından geçmemeli');
    } finally { f.close(); }
  });
}
test('FA01 OCR: yarım yükleme yeniden denendiğinde biçim uyarısı kaybolmaz', async () => {
  const f = await fixture(); try {
    supplier(f, HISTORY);
    const body = document({doc_no: 'ABC20260000000044'});
    const first = await f.ok('/ec/invoices/documents', body);
    assert.match(first.format_warning, /FARKLI/);
    const retry = await f.ok('/ec/invoices/documents', body);
    assert.equal(retry.id, first.id);
    assert.equal(retry.resume, true);
    assert.notEqual(gate(retry.format_warning), null, 'tekrar çağrı kapıyı açmamalı');
  } finally { f.close(); }
});
test('FA01 OCR: üç aynı kalıpla eşleşme otomatik yolu açık tutar', async () => {
  const f = await fixture(); try {
    supplier(f, HISTORY);
    const d = await f.ok('/ec/invoices/documents', document());
    assert.equal(gate(d.format_warning), null);
  } finally { f.close(); }
});

async function staff(f, ns, amounts) {
  const username = 'audit-' + ns + '-' + amounts;
  const u = await f.ok('/admin/users', {name: 'Denetim', username,
    permissions: {ec: ns === 'ec' ? {invoices: 'write', amounts} : {}, lp: ns === 'lp' ? {accounts: 'write', amounts} : {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: u.invite_path.split('invite=')[1], password: 'synthetic-audit-password'});
  return (await f.req('/auth/login', {username, password: 'synthetic-audit-password'})).cookie;
}
for (const ns of ['ec', 'lp']) test('FA02 ' + ns + ': tutar kapalıyken özgün belge ve ham alanlar okunamaz; belge listesi açık kalır', async () => {
  const f = await fixture(); try {
    const d = await f.ok('/' + ns + '/invoices/documents', document({extracted: {text: 'Toplam 987,65 TL', net: 987.65, tax: 197.53}}));
    await f.ok('/' + ns + '/invoices/documents/' + d.id + '/chunk', {index: 0, data: Buffer.from('Toplam 987,65 TL').toString('base64')});
    const hidden = await staff(f, ns, 'none'), visible = await staff(f, ns, 'read');
    assert.equal((await f.req('/' + ns + '/invoices/documents', undefined, hidden)).status, 200);
    for (const suffix of ['', '/part?index=0']) {
      const path = '/' + ns + '/invoices/documents/' + d.id + suffix;
      assert.equal((await f.req(path, undefined, hidden)).status, 403, 'ham içerik tutar izni ister: ' + path);
      assert.equal((await f.req(path, undefined, visible)).status, 200, 'tutar izni olan belgeyi okuyabilmeli');
    }
    const other = ns === 'ec' ? 'lp' : 'ec';
    assert.equal((await f.req('/' + other + '/invoices/documents/' + d.id, undefined, hidden)).status, 403);
    assert.equal((await f.req('/' + other + '/invoices/documents/' + d.id)).status, 404, 'yönetici de başka alandan bu belgeyi okuyamaz');
  } finally { f.close(); }
});
test('FA02 OCR: tutar izni yoksa ham metin üreten model çağrılmadan reddedilir', async () => {
  const f = await fixture(); try {
    const cookie = await staff(f, 'ec', 'none');
    f.env.AI = {run: async () => ({text: 'Sentetik fatura toplamı 987,65 TL'})}; f.env.OCR_TIMEOUT_MS = 5;
    assert.equal((await f.req('/ec/invoices/documents/ocr', {images: ['YQ==']}, cookie)).status, 403);
  } finally { f.close(); }
});

async function product(f, key, name, vat = 2000) {
  const p = await f.ok('/ec/products', {name, sku: key, stock_unit: 'adet', min_stock: 0, brand: 'Denetim'});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 10, unit_cost: 10, kind: 'opening', reference: key, occurred_on: DATE, notes: 'Sentetik açılış'});
  sql(f, 'INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,1000,0,0,0,100,100,100,500,1)', p.id, vat);
  return p.id;
}
for (const kind of ['ikame', 'ilave']) test('FA03 ' + kind + ': satılan ilan ve adedi korunur; fiziksel bileşen maliyeti hesaba katılır', async () => {
  const f = await fixture(); try {
    const a = await product(f, 'A', 'Denetim Torf 10 L'), b = await product(f, 'B', 'Denetim Torf 5 L');
    const p = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'AUDIT', order_no: 'AUDIT', occurred_on: DATE,
      lines: [{external_id: 'LINE', name: 'Denetim Torf 10 L', product_id: a, quantity: 1, gross: 120, vat_rate: 20}]});
    await f.ok('/ec/orders/' + p.id + '/reserve', {});
    await f.ok('/ec/orders/' + p.id + '/ship', {occurred_on: DATE, reference: 'AUDIT-SHIP'});
    await f.ok('/ec/orders/' + p.id + '/deliver', {occurred_on: DATE});
    const c = one(f, 'SELECT c.* FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?', p.id);
    await f.ok('/ec/sales/' + c.sale_id + '/fees', {commission: 0, shipping: 0, other: 0, fees_status: 'confirmed'});
    sql(f, "INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','finance','audit',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','test')");
    const read = async () => (await performanceReport({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')},
      {mode: 'delivered', from: DATE, to: DATE, detay: true})).rows.find(r => r.id === p.id);
    const before = await read();
    await f.ok('/ec/orders/' + p.id + '/duzeltme', {line_id: c.line_id, component_id: c.id, kind,
      items: [{product_id: b, quantity: 2}], reason: 'Test: gerçekte gönderilen ürün'});
    const after = await read();
    assert.equal(after.sales_items[0].key, before.sales_items[0].key, 'tek ürün ikame/hediye yüzünden set ilanına dönüşmemeli');
    assert.equal(after.sales_items[0].units_milli, 1000, 'ikame bir müşteri iadesi değildir');
    assert.equal(after.sales_items[0].returned_units_milli, 0);
    assert.equal(after.sales_items[0].partial_return, false);
    assert.equal(after.sales_items[0].return_cash_cents, 0, 'teknik maliyet ters kaydı müşteri iadesi kazancı sayılmaz');
    assert.equal(after.revenue_gross_cents, before.revenue_gross_cents);
    assert.equal(after.cost_gross_cents, kind === 'ikame' ? 2400 : 3600);
    assert.equal(after.sales_items[0].cash_cents, after.cash_cents);
    assert.equal(one(f, 'SELECT quantity_milli n FROM ec_stock_balances WHERE product_id=?', a).n, kind === 'ikame' ? 10000 : 9000);
    assert.equal(one(f, 'SELECT quantity_milli n FROM ec_stock_balances WHERE product_id=?', b).n, 8000);
  } finally { f.close(); }
});

for (const salesVat of [2000, 800]) test('FA04 KDV ' + salesVat + ': otomatik ilan eşleşmesi satış ayarını ezmez; tekrar stok yazmaz', async () => {
  const f = await fixture(); try {
    const p = await product(f, 'AUDIT-TORF', 'Denetim Torf 10 L', 1000);
    sql(f, "INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','hepsiburada','AUDIT','Denetim')");
    sql(f, "UPDATE workspace_settings SET inventory_start_date=?,sales_vat_bps=? WHERE workspace='ec'", DATE, salesVat);
    sql(f, "INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status) VALUES('fl','st','orders','sentetik.xlsx',1,?,'2026-09-12T10:00','[]',1,1,'applied')", 'f'.repeat(64));
    sql(f, "INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no) VALUES('rec','st','order_line','P:PK:HBCV-AUDIT','composite',?,'2026-09-12T10:00','2026-09-12T10:00','fl',1)", JSON.stringify({package_id: 'PK', order_no: 'AUDIT', order_date: DATE, barcode: null, seller_sku: null, sku: 'HBCV-AUDIT', product_name: 'Denetim Torf 10 L', quantity: 1, gross: 24000, vat_bps: 1000, status: 'Kargolandı', delivered_date: ''}));
    const result = await f.ok('/ec/reports/stock-link/auto', {store_id: 'st', skip: []});
    assert.ok(result.results.some(r => r.done), JSON.stringify(result));
    const line = one(f, 'SELECT l.* FROM ec_order_lines l JOIN ec_report_records r ON r.erp_package_id=l.package_id WHERE r.id=?', 'rec');
    assert.equal(line.vat_bps, salesVat, 'satış KDV ayarı yetkilidir; oran koda gömülü değildir');
    assert.equal(line.net_revenue_cents, Math.round(24000 * 10000 / (10000 + salesVat)), 'brüt aynı kalır; net ayardaki orandan gelir');
    const count = one(f, 'SELECT COUNT(*) n FROM ec_sale_entries').n;
    await f.ok('/ec/reports/stock-link/auto', {store_id: 'st', skip: []});
    assert.equal(one(f, 'SELECT COUNT(*) n FROM ec_sale_entries').n, count);
    assert.equal(one(f, 'SELECT quantity_milli n FROM ec_stock_balances WHERE product_id=?', p).n, 9000);
  } finally { f.close(); }
});
