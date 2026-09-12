// Aynı dosya partisi sürdürülürken deneme geçmişi append-only olmalı ve parti sayaçları
// BİRİKMEMELİ. Codex incelemesi: "yeniden denemeyle eski review sayısı birikip dosya satır
// sayısını aşmasın." TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const SHA = 'a'.repeat(64);
const line = (net, vat) => ({line_no: 1, source_product: 'Torf', quantity: 1, unit: 'adet',
  net_cents: net, vat_cents: vat, vat_bps: 2000, mapping_status: 'pending', product_sku: null});
const invoice = (vkn, no) => ({source_file: 'tedarikci.pdf', source_page: 1, supplier_vkn: vkn, invoice_no: no,
  ettn: null, invoice_date: '2026-09-11', net_cents: 50000, vat_cents: 10000, gross_cents: 60000, lines: [line(50000, 10000)]});
const body = (items, suppliers) => ({kind: 'purchase_invoices', source_name: 'ayni-dosya.json', sha256: SHA, items, suppliers});

test('Aynı dosya sürdürülür: sayaçlar birikmez, her deneme ayrı ve silinemez kayıt olur', async () => {
  const f = appFixture(); await f.setup(); try {
    // Biri bilinen, biri adı eksik iki tedarikçi.
    const items = [invoice('5160067031', 'KRK-1'), invoice('9340990552', 'YSK-1')];

    const first = await f.ok('/ec/invoices/staged/apply', body(items, {'5160067031': 'Karakuş Ltd'}));
    assert.equal(first.counts.created, 1);
    assert.equal(first.counts.review, 1);
    assert.equal(first.attempt_no, 1);

    // Aynı dosya, aynı özet: eksik ad hâlâ yok. Sayaçlar BİRİKMEMELİ.
    const second = await f.ok('/ec/invoices/staged/apply', body(items, {'5160067031': 'Karakuş Ltd'}));
    assert.equal(second.attempt_no, 2);
    assert.equal(second.counts.review, 1, 'inceleme sayısı birikmedi');
    assert.equal(second.counts.skipped, 1, 'daha önce açılan fatura atlandı');

    const {batches} = await f.ok('/ec/invoices/staged/batches');
    assert.equal(batches.length, 1, 'aynı dosya için tek parti');
    const batch = batches[0];
    assert.equal(batch.item_count, 2);
    // Parti sayaçları DOSYANIN GÜNCEL durumu; satır sayısını aşmamalı.
    const total = batch.counts.created + batch.counts.skipped + batch.counts.review + batch.counts.failed;
    assert.equal(total, batch.item_count, 'güncel durum toplamı satır sayısına eşit');
    assert.equal(batch.attempts.length, 2, 'her deneme ayrı kayıt');
    assert.deepEqual(batch.attempts.map(a => a.attempt_no), [1, 2]);
    assert.ok(batch.attempts.every(a => a.started_at && a.finished_at), 'başlangıç ve bitiş saklanır');

    // Ad verilince aynı dosya tamamlanabilir; yine birikme yok.
    const third = await f.ok('/ec/invoices/staged/apply', body(items, {'5160067031': 'Karakuş Ltd', '9340990552': 'Seçkin Ltd'}));
    assert.equal(third.attempt_no, 3);
    assert.equal(third.counts.created, 1);
    assert.equal(third.counts.review, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_purchase_invoices').get().n, 2, 'fatura çoğalmadı');

    const after = (await f.ok('/ec/invoices/staged/batches')).batches[0];
    assert.equal(after.counts.created + after.counts.skipped + after.counts.review + after.counts.failed, 2);
    assert.equal(after.attempts.length, 3);

    // Deneme geçmişi değiştirilemez.
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_import_attempts'), /IMMUTABLE_LEDGER/);
    assert.throws(() => f.sqlite.exec("UPDATE ec_import_attempts SET actor='x'"), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});
