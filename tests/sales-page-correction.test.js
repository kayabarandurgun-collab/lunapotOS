// Mühürlü sayfa kaydı yanlış yazıldığında ne olur?
// Satır silinemez ve değiştirilemez; UNIQUE(document_id,page_no) yüzünden aynı sayfa için
// düzeltilmiş ikinci bir satır da açılamaz. Bu yüzden düzeltme yanına yazılır: yanlış kayıt
// yerinde kalır (ne yazıldığı görünür), doğru değer düzeltme tablosunda durur, liste doğruyu gösterir.
// TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {sha256Hex} from '../public/xlsx-read.js';

const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const b64 = Buffer.from(bytes).toString('base64');

async function storeDoc(f) {
  const doc = await f.ok('/ec/sales/documents', {kind: 'pdf', provider: 'trendyol',
    filename: 'tum-siparisler-parca.pdf', sha256: await sha256Hex(bytes), size_bytes: bytes.length,
    chunk_count: 1, page_count: 2});
  await f.ok('/ec/sales/documents/' + doc.id + '/chunk', {index: 0, data: b64});
  await f.ok('/ec/sales/documents/' + doc.id + '/seal', {});
  return doc.id;
}

test('Yanlış yazılmış sayfa kaydı silinmeden düzeltilir ve liste doğruyu gösterir', async () => {
  const f = appFixture(); await f.setup(); try {
    const doc = await storeDoc(f);
    // Yanlış yazım: fatura ve sipariş numarası hatalı.
    await f.ok('/ec/sales/documents/' + doc + '/pages', {pages: [
      {page_no: 1, invoice_no: 'TEA2026000000012', order_no: '11447154337', gross: 1833},
      {page_no: 2, invoice_no: 'TEA2026000000014', order_no: '11446249637', gross: 432.55}]});

    // Gerekçesiz düzeltme kabul edilmez: gerekçesiz düzeltme üstünü örtmektir.
    const gerekcesiz = await f.req('/ec/sales/documents/' + doc + '/pages/correct',
      {reason: 'yanlış', corrections: [{page_no: 1, invoice_no: 'TEA2026000000013', order_no: '11446218659', gross: 407.55}]});
    assert.equal(gerekcesiz.status, 400);

    const d = await f.ok('/ec/sales/documents/' + doc + '/pages/correct', {
      reason: 'Sayfa gövdesi kaynak dosyadan okunmadan elle yazılmıştı; kaynaktan düzeltildi.',
      corrections: [{page_no: 1, invoice_no: 'TEA2026000000013', order_no: '11446218659', gross: 407.55}]});
    assert.equal(d.corrected, 1);
    assert.equal(d.conflicts.length, 0);

    // Yanlış satır YERİNDE durur: ne yazıldığı kaybolmaz.
    const ham = f.sqlite.prepare('SELECT invoice_no,order_no FROM ec_sales_document_pages WHERE page_no=1').get();
    assert.equal(ham.invoice_no, 'TEA2026000000012', 'mühürlü satır değişmedi');
    const kayit = f.sqlite.prepare('SELECT wrong_invoice_no,invoice_no,reason FROM ec_sales_document_page_corrections').get();
    assert.equal(kayit.wrong_invoice_no, 'TEA2026000000012');
    assert.equal(kayit.invoice_no, 'TEA2026000000013');
    assert.ok(kayit.reason.length >= 10);

    // Liste DOĞRU değeri gösterir, yanlışı da ayrıca bildirir.
    const listed = await f.ok('/ec/sales/documents/' + doc + '/pages');
    const s1 = listed.pages.find(p => p.page_no === 1);
    assert.equal(s1.invoice_no, 'TEA2026000000013', 'okuma tarafı düzeltilmiş değeri verir');
    assert.equal(s1.order_no, '11446218659');
    assert.equal(s1.corrected, 1);
    assert.equal(s1.wrong_invoice_no, 'TEA2026000000012');
    const s2 = listed.pages.find(p => p.page_no === 2);
    assert.equal(s2.invoice_no, 'TEA2026000000014', 'düzeltilmeyen sayfa olduğu gibi kalır');
    assert.ok(!s2.corrected);

    // Düzeltme de mühürlüdür: ikinci kez düzeltilemez, silinemez, değiştirilemez.
    const ikinci = await f.ok('/ec/sales/documents/' + doc + '/pages/correct', {
      reason: 'İkinci düzeltme denemesi; kabul edilmemelidir.',
      corrections: [{page_no: 1, invoice_no: 'TEA2026000000099', order_no: '1', gross: 1}]});
    assert.equal(ikinci.corrected, 0);
    assert.equal(ikinci.conflicts.length, 1);
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_sales_document_page_corrections'), /IMMUTABLE_LEDGER/);
    assert.throws(() => f.sqlite.exec("UPDATE ec_sales_document_page_corrections SET invoice_no='X'"), /IMMUTABLE_LEDGER/);

    // Belgede olmayan sayfa düzeltilemez; aynı değerle "düzeltme" yazılmaz.
    const yok = await f.ok('/ec/sales/documents/' + doc + '/pages/correct', {
      reason: 'Belgede olmayan sayfa için düzeltme denemesi.',
      corrections: [{page_no: 9, invoice_no: 'TEA2026000000099', order_no: '1', gross: 1}]});
    assert.equal(yok.corrected, 0);
    assert.equal(yok.conflicts.length, 1);
    const ayni = await f.ok('/ec/sales/documents/' + doc + '/pages/correct', {
      reason: 'Aynı değerle düzeltme denemesi; kayıt açılmamalı.',
      corrections: [{page_no: 2, invoice_no: 'TEA2026000000014', order_no: '11446249637', gross: 432.55}]});
    assert.equal(ayni.corrected, 0);
    assert.equal(ayni.unchanged, 1);
  } finally { f.close(); }
});
