// Hazırlanmış gerçek alış kayıtlarının aktarımı.
// TEMSİLİ veri: gerçek fatura içeriği DEĞİLDİR; kural davranışını doğrular.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const SHA = n => String(n).padStart(64, 'a');
const line = (product, quantity, net, vat, sku = null, status = 'pending') =>
  ({line_no: 1, source_product: product, quantity, unit: 'adet', net_cents: net, vat_cents: vat, vat_bps: 2000,
    mapping_status: status, product_sku: sku, mapping_reason: sku ? '' : 'Ürün kimliği teyit edilmeli.'});
const invoice = (vkn, no, lines, extra = {}) => ({
  source_file: 'tedarikci-tum-zamanlar.pdf', source_page: 1, supplier_vkn: vkn, invoice_no: no,
  ettn: extra.ettn ?? null, invoice_date: '2026-09-11',
  net_cents: lines.reduce((s, l) => s + l.net_cents, 0), vat_cents: lines.reduce((s, l) => s + l.vat_cents, 0),
  gross_cents: lines.reduce((s, l) => s + l.net_cents + l.vat_cents, 0), lines, ...extra
});
const body = (items, extra = {}) => ({kind: 'purchase_invoices', source_name: 'alis-kayitlari.json', sha256: SHA(1), items,
  suppliers: {'5160067031': 'Karakuş Tarım'}, ...extra});
const counts = f => ({
  invoices: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_purchase_invoices').get().n,
  party: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n,
  stock: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_movements').get().n
});

test('Önizleme hiçbir şey yazmaz; uygulama yalnız taslak açar, borç ve stok oluşturmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await f.ok('/ec/products', {name: 'Torf 80 L', sku: 'GG-TORF-COCO-80L', stock_unit: 'adet', min_stock: 0});
    assert.ok(product.id);
    const items = [invoice('5160067031', 'KRK-1', [line('Gartengold 80 L Torf', 2, 100000, 20000, 'GG-TORF-COCO-80L', 'proposed_exact_match')])];

    const before = counts(f);
    const preview = await f.ok('/ec/invoices/staged/preview', body(items));
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.counts.created, 1);
    assert.deepEqual(counts(f), before, 'önizleme yazmamalı');

    const applied = await f.ok('/ec/invoices/staged/apply', body(items));
    assert.equal(applied.counts.created, 1);
    assert.equal(counts(f).invoices, 1, 'taslak fatura açıldı');
    assert.equal(counts(f).party, 0, 'cari borç YAZILMADI');
    assert.equal(counts(f).stock, 0, 'stok hareketi YAZILMADI');
    assert.equal(f.sqlite.prepare('SELECT status FROM ec_purchase_invoices').get().status, 'draft');
    // Satır gerçek ürüne bağlandı ve kaynak belge nota işlendi.
    const saved = f.sqlite.prepare('SELECT product_id,quantity_milli FROM ec_purchase_lines').get();
    assert.equal(saved.product_id, product.id);
    assert.equal(saved.quantity_milli, 2000);
  } finally { f.close(); }
});

test('Aynı dosya ve aynı fatura ikinci kez uygulanmaz; sayılar çoğalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const items = [invoice('5160067031', 'KRK-1', [line('Torf', 1, 50000, 10000)]),
      invoice('5160067031', 'KRK-2', [line('Torf', 1, 50000, 10000)])];
    const first = await f.ok('/ec/invoices/staged/apply', body(items));
    assert.equal(first.counts.created, 2);
    assert.equal(counts(f).invoices, 2);

    // Aynı dosya tekrar: parti özeti tekil olduğu için reddedilir.
    const repeat = await f.req('/ec/invoices/staged/apply', body(items));
    assert.equal(repeat.status, 409);
    assert.equal(counts(f).invoices, 2, 'tekrar yükleme fatura çoğaltmadı');

    // Farklı dosya ama AYNI faturalar (örtüşen dönem): kaynak kimliğiyle atlanır.
    const overlapping = await f.ok('/ec/invoices/staged/apply', body([...items,
      invoice('5160067031', 'KRK-3', [line('Torf', 1, 50000, 10000)])], {sha256: SHA(2), source_name: 'ortusen.json'}));
    assert.equal(overlapping.counts.skipped, 2, 'daha önce aktarılan iki fatura atlandı');
    assert.equal(overlapping.counts.created, 1);
    assert.equal(counts(f).invoices, 3);
    assert.equal(counts(f).party, 0);
  } finally { f.close(); }
});

test('Tedarikçi adı yoksa kayıt uydurulmaz; inceleme olarak bırakılır', async () => {
  const f = appFixture(); await f.setup(); try {
    const items = [invoice('9340990552', 'YSK-1', [line('Klasmann TS1', 6, 700000, 140000)])];
    const preview = await f.ok('/ec/invoices/staged/preview', body(items));
    assert.equal(preview.counts.review, 1);
    assert.deepEqual(preview.missing_suppliers, ['9340990552']);

    const applied = await f.ok('/ec/invoices/staged/apply', body(items));
    assert.equal(applied.counts.review, 1);
    assert.equal(applied.counts.created, 0);
    assert.equal(counts(f).invoices, 0, 'adı bilinmeyen tedarikçi için fatura açılmadı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_suppliers').get().n, 0, 'hayalî tedarikçi oluşturulmadı');

    // Kullanıcı adı verince aynı kayıt aktarılabilir.
    const named = await f.ok('/ec/invoices/staged/apply', body(items,
      {sha256: SHA(3), suppliers: {'9340990552': 'Seçkin Tarım'}}));
    assert.equal(named.counts.created, 1);
    assert.equal(f.sqlite.prepare('SELECT name FROM ec_suppliers').get().name, 'Seçkin Tarım');
  } finally { f.close(); }
});

test('Eşleşmesi olmayan satır bağlanmaz ve fatura kesinleştirilemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const items = [invoice('5160067031', 'KRK-9', [
      line('Bilinmeyen ürün', 3, 30000, 6000),
      line('Tropikal 500 ml besin', 60, 60000, 12000, null, 'variant_allocation_required')])];
    const applied = await f.ok('/ec/invoices/staged/apply', body(items));
    assert.equal(applied.counts.created, 1);
    assert.equal(applied.counts.pending_lines, 2, 'iki satır eşleşme bekliyor');
    const lines = f.sqlite.prepare('SELECT product_id,quantity_milli FROM ec_purchase_lines').all();
    assert.equal(lines.length, 2);
    assert.ok(lines.every(l => l.product_id === null && l.quantity_milli === null), 'kimliksiz satır ürüne bağlanmadı');

    const id = f.sqlite.prepare('SELECT id FROM ec_purchase_invoices').get().id;
    await assert.rejects(f.ok('/ec/invoices/' + id + '/post', {}), /eşleştirin|UNMAPPED/i);
    assert.equal(counts(f).party, 0, 'eksik eşleşmede borç yazılmadı');
  } finally { f.close(); }
});

test('Tutarsız kaynak belge sessizce düzeltilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const bad = invoice('5160067031', 'KRK-X', [line('Torf', 1, 50000, 10000)]);
    bad.gross_cents = 99999;
    assert.equal((await f.req('/ec/invoices/staged/preview', body([bad]))).status, 400);
    const badLines = invoice('5160067031', 'KRK-Y', [line('Torf', 1, 50000, 10000)]);
    badLines.net_cents = 40000; badLines.gross_cents = 50000;
    assert.equal((await f.req('/ec/invoices/staged/preview', body([badLines]))).status, 400);
    assert.equal(counts(f).invoices, 0);
  } finally { f.close(); }
});

test('Aktarım partileri denetim için saklanır', async () => {
  const f = appFixture(); await f.setup(); try {
    await f.ok('/ec/invoices/staged/apply', body([invoice('5160067031', 'KRK-5', [line('Torf', 1, 50000, 10000)])]));
    const {batches} = await f.ok('/ec/invoices/staged/batches');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].item_count, 1);
    assert.equal(batches[0].counts.created, 1);
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_import_items'), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});
