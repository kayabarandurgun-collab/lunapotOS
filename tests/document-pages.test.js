// Bir belge BİRDEN ÇOK faturayı içerebilir: tedarikçi "tüm zamanlar" dökümünü tek PDF verir,
// pazaryeri satış faturaları da birleşik dosyalarda gelir. Belge kaydındaki bire bir invoice_id
// bunu karşılamıyordu; sayfa düzeyinde bağlantı bu boşluğu kapatır.
// TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {sha256Hex} from '../public/xlsx-read.js';

const DATE = '2026-09-11';
const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const b64 = Buffer.from(bytes).toString('base64');

/** Belgeyi gerçek yoldan yükler: kayıt → parça → mühür. */
async function storeDoc(f, base, body) {
  const doc = await f.ok(base, body);
  await f.ok(base + '/' + doc.id + '/chunk', {index: 0, data: b64});
  const sealed = await f.ok(base + '/' + doc.id + '/seal', {});
  assert.equal(sealed.status, 'stored');
  return doc.id;
}

async function invoice(f, supplierId, no) {
  return (await f.ok('/ec/invoices', {supplier_id: supplierId, invoice_no: no, uuid: '', invoice_date: DATE,
    currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf', external_code: '', invoice_quantity: 1, invoice_unit: 'adet',
      net: 100, tax: 20, line_type: 'product'}]})).id;
}

test('Tek belgedeki her fatura kendi sayfasına bağlanır; üstüne yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Tedarik', tax_id: '9340990552'})).id;
    const first = await invoice(f, supplier, 'SNT-1'), second = await invoice(f, supplier, 'SNT-2');
    const doc = await storeDoc(f, '/ec/invoices/documents', {kind: 'pdf', filename: 'tum-zamanlar.pdf',
      sha256: await sha256Hex(bytes), size_bytes: bytes.length, chunk_count: 1, page_count: 3});

    const linked = await f.ok('/ec/invoices/documents/' + doc + '/pages',
      {pages: [{page_no: 1, invoice_id: first}, {page_no: 2, invoice_id: second}]});
    assert.equal(linked.created, 2, 'iki fatura tek belgeye bağlandı');
    assert.equal(linked.conflicts.length, 0);

    // Aynı istek yeniden: ikinci kayıt açılmaz, hata da verilmez.
    const again = await f.ok('/ec/invoices/documents/' + doc + '/pages',
      {pages: [{page_no: 1, invoice_id: first}, {page_no: 2, invoice_id: second}]});
    assert.equal(again.created, 0);
    assert.equal(again.already_linked, 2);

    // Dolu sayfaya başka fatura, ya da bağlı faturayı başka sayfaya taşıma: sessizce yazılmaz.
    const clash = await f.ok('/ec/invoices/documents/' + doc + '/pages', {pages: [{page_no: 1, invoice_id: second}]});
    assert.equal(clash.created, 0);
    assert.equal(clash.conflicts.length, 1);
    const moved = await f.ok('/ec/invoices/documents/' + doc + '/pages', {pages: [{page_no: 3, invoice_id: first}]});
    assert.equal(moved.created, 0, 'bağlı fatura başka sayfaya taşınmadı');
    assert.equal(moved.conflicts.length, 1);

    const listed = await f.ok('/ec/invoices/documents/' + doc + '/pages');
    assert.equal(listed.pages.length, 2);
    assert.deepEqual(listed.pages.map(p => p.page_no), [1, 2]);
    assert.deepEqual(listed.pages.map(p => p.invoice_no), ['SNT-1', 'SNT-2']);

    // Belgede olmayan sayfa reddedilir.
    const beyond = await f.req('/ec/invoices/documents/' + doc + '/pages', {pages: [{page_no: 9, invoice_id: first}]});
    assert.equal(beyond.status, 400);

    // Sayfa bağlantısı kanıttır: silinemez, değiştirilemez.
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_purchase_document_pages'), /IMMUTABLE_LEDGER/);
    assert.throws(() => f.sqlite.exec('UPDATE ec_purchase_document_pages SET page_no=7'), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});

test('Bölünmüş satış belgesi özgün sayfa numarasını korur ve sipariş bağı bir kez kurulur', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await f.ok('/ec/products', {name: 'Tek şişe', sku: 'SYNTH-SINGLE', stock_unit: 'adet', min_stock: 0});
    await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'SYNTH-1',
      external_name: 'Tekli', components: [{product_id: product.id, quantity_milli: 1000, revenue_share_bps: 10000}]});
    const order = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'PK-1', order_no: '11408249438',
      occurred_on: DATE, lines: [{external_id: 'L1', sku: 'SYNTH-1', name: 'Tekli', quantity: 1, gross: 350, vat_rate: 20}]});

    // 42 MB'lık birleşik dosya sınır nedeniyle bölünerek yüklenir: bu bölüm özgün 46–47. sayfalar.
    const doc = await storeDoc(f, '/ec/sales/documents', {kind: 'pdf', provider: 'trendyol',
      filename: 'tum-siparisler-bolum2.pdf', sha256: await sha256Hex(bytes), size_bytes: bytes.length,
      chunk_count: 1, page_count: 2, origin_filename: 'tüm siparişler sayfa1.pdf',
      origin_first_page: 46, origin_last_page: 47});

    const pages = await f.ok('/ec/sales/documents/' + doc + '/pages', {pages: [
      {page_no: 1, invoice_no: 'TEA2026000000046', order_no: '11408249438', gross: 350},
      {page_no: 2, invoice_no: 'TEA2026000000047', order_no: '11408249439', gross: 120}]});
    assert.equal(pages.created, 2);

    const saved = f.sqlite.prepare('SELECT page_no,origin_page_no,invoice_no,gross_cents FROM ec_sales_document_pages ORDER BY page_no').all();
    assert.deepEqual(saved.map(r => r.origin_page_no), [46, 47], 'özgün sayfa numarası korundu');
    assert.equal(saved[0].gross_cents, 35000, 'tutar kuruşa çevrildi');

    // Sipariş belgeden sonra sisteme girmiş olabilir: bağlantı sonradan kurulur.
    const link = await f.ok('/ec/sales/documents/' + doc + '/pages/link', {links: [{page_no: 1, package_id: order.id}]});
    assert.equal(link.linked, 1);
    const twice = await f.ok('/ec/sales/documents/' + doc + '/pages/link', {links: [{page_no: 1, package_id: order.id}]});
    assert.equal(twice.already_linked, 1, 'ikinci kez bağlanmadı');

    // Bağlı sayfa başka siparişe TAŞINMAZ.
    const other = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'PK-2', order_no: '11408249439',
      occurred_on: DATE, lines: [{external_id: 'L9', sku: 'SYNTH-1', name: 'Tekli', quantity: 1, gross: 120, vat_rate: 20}]});
    const moved = await f.ok('/ec/sales/documents/' + doc + '/pages/link', {links: [{page_no: 1, package_id: other.id}]});
    assert.equal(moved.linked, 0);
    assert.equal(moved.conflicts.length, 1);

    // Aynı dosya ikinci kez yüklenmez.
    const dup = await f.ok('/ec/sales/documents', {kind: 'pdf', provider: 'trendyol', filename: 'kopya.pdf',
      sha256: await sha256Hex(bytes), size_bytes: bytes.length, chunk_count: 1, page_count: 2});
    assert.equal(dup.duplicate, true, 'kopya dosya ikinci satış sayılmaz');

    // Belge ve sayfa kaydı silinemez.
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_sales_document_pages'), /IMMUTABLE_LEDGER/);
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_sales_documents'), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});

test('Bildirilen özgün sayfa aralığı bölümün sayfa sayısıyla tutmalı', async () => {
  const f = appFixture(); await f.setup(); try {
    const r = await f.req('/ec/sales/documents', {kind: 'pdf', provider: 'trendyol', filename: 'yanlis.pdf',
      sha256: await sha256Hex(bytes), size_bytes: bytes.length, chunk_count: 1, page_count: 2,
      origin_first_page: 46, origin_last_page: 60});
    assert.equal(r.status, 400, 'çelişkili aralık reddedildi');
  } finally { f.close(); }
});

// Fatura penceresi özgün belgeyi açabilsin: ayrıntıda hangi belge ve kaçıncı sayfa olduğu gelir.
test('Fatura ayrıntısı bağlı özgün belgeyi ve sayfasını söyler; belgesiz faturada boş', async () => {
  const f = appFixture(); await f.setup(); try {
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Tedarik', tax_id: '9340990552'})).id;
    const first = await invoice(f, supplier, 'SNT-1'), second = await invoice(f, supplier, 'SNT-2');
    const doc = await storeDoc(f, '/ec/invoices/documents', {kind: 'pdf', filename: 'tum-zamanlar.pdf',
      sha256: await sha256Hex(bytes), size_bytes: bytes.length, chunk_count: 1, page_count: 3});
    await f.ok('/ec/invoices/documents/' + doc + '/pages', {pages: [{page_no: 2, invoice_id: first}]});
    const detay = await f.ok('/ec/invoices/' + first);
    assert.deepEqual({id: detay.document.id, page_no: detay.document.page_no, chunk_count: detay.document.chunk_count, page_count: detay.document.page_count},
      {id: doc, page_no: 2, chunk_count: 1, page_count: 3});
    assert.equal((await f.ok('/ec/invoices/' + second)).document, null, 'belgesi olmayan faturada düğme çıkmaz');
    // Parça yetkili kullanıcıya verilir (pencere bunu okur).
    const parca = await f.ok('/ec/invoices/documents/' + doc + '/part?index=0');
    assert.equal(parca.data, b64);
  } finally { f.close(); }
});
