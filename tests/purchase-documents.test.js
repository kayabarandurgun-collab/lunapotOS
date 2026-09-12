// Tedarikçi alış belgesi (PDF yükleme) ve "her faturada yeniden dağıtılan" çeşitler.
//
// TEMSİLİ veri: gerçek Tropikal faturası ve gerçek PDF düzeni DEĞİLDİR. Sütun/satır okuma
// gerçek belgeyle ayrıca doğrulanmalıdır. Buradaki testler kayıt kurallarını doğrular:
// belge tekilliği, borç/stok oluşmaması ve her faturada yeniden yapılan çeşit dağılımı.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {scopedDB} from '../src/scoped-db.js';
import {accountingApi} from '../src/accounting.js';
import {purchaseSplitApi} from '../src/purchase-split-api.js';
import {purchaseDocumentApi} from '../src/purchase-document-api.js';

function fixture() {
  const s = new DatabaseSync(':memory:');
  s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) { return {args: [], bind(...a) { this.args = a; return this; }, first() { return s.prepare(sql).get(...this.args) || null; }, all() { return {results: s.prepare(sql).all(...this.args)}; }, run() { return s.prepare(sql).run(...this.args); }}; },
    async batch(items) { s.exec('BEGIN'); try { const r = items.map(i => i.all()); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; } }
  };
  const call = (handler, ns, path, body, search = '') => handler(new Request('https://test.local' + path + search, {method: body === undefined ? 'GET' : 'POST'}),
    {DB: scopedDB(DB, ns), ROOT_DB: DB, WORKSPACE: ns}, path, async () => body);
  return {s, DB, call,
    ac: (path, body, ns = 'ec') => call(accountingApi, ns, '/api/accounting' + path, body),
    split: (path, body, ns = 'ec') => call(purchaseSplitApi, ns, '/api/invoices/' + path, body),
    doc: (path, body, ns = 'ec', search = '') => call(purchaseDocumentApi, ns, '/api/invoices' + path, body, search)};
}
const counts = f => ({
  invoices: f.s.prepare('SELECT COUNT(*) n FROM ec_purchase_invoices').get().n,
  stock: f.s.prepare('SELECT COUNT(*) n FROM ec_stock_movements').get().n,
  party: f.s.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n
});
const b64 = bytes => Buffer.from(bytes).toString('base64');
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
// Temsili "belge": gerçek bir PDF düzeni değil, yalnızca saklama ve tekillik kuralları için bayt dizisi.
const fileBytes = marker => new TextEncoder().encode('%PDF-1.4\n% temsili belge ' + marker + '\n%%EOF\n');

async function upload(f, marker, fields = {}) {
  const bytes = fileBytes(marker);
  const created = await f.doc('/documents', {kind: 'pdf', filename: marker + '.pdf', mime: 'application/pdf',
    size_bytes: bytes.length, sha256: await sha(bytes), chunk_count: 1, page_count: 1, text_layer: 1, ...fields});
  if (created.duplicate) return created;
  await f.doc('/documents/' + created.id + '/chunk', {index: 0, data: b64(bytes)});
  await f.doc('/documents/' + created.id + '/seal', {});
  return {...created, bytes};
}

test('Aynı belge ikinci kez yüklenemez; yükleme borç veya stok oluşturmaz, özgün belge saklanır', async () => {
  const f = fixture(); try {
    const before = counts(f);
    const first = await upload(f, 'fatura-a', {supplier_tax_id: '1234567890', doc_no: 'TRP2026000001', doc_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
    assert.ok(first.id);
    assert.equal(f.s.prepare('SELECT status FROM ec_purchase_documents WHERE id=?').get(first.id).status, 'stored');

    // 1) Aynı dosya (aynı özet), farklı dosya adıyla bile olsa.
    const sameFile = await f.doc('/documents', {kind: 'pdf', filename: 'baska-ad.pdf', size_bytes: first.bytes.length,
      sha256: await sha(first.bytes), chunk_count: 1, text_layer: 1});
    assert.equal(sameFile.duplicate, true);
    assert.equal(sameFile.reason, 'sha256');

    // 2) Farklı dosya, aynı ETTN.
    const sameEttn = await upload(f, 'fatura-b', {doc_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
    assert.equal(sameEttn.duplicate, true);
    assert.equal(sameEttn.reason, 'ettn');

    // 3) Farklı dosya, aynı tedarikçi VKN + fatura no.
    const sameNo = await upload(f, 'fatura-c', {supplier_tax_id: '1234567890', doc_no: 'TRP2026000001'});
    assert.equal(sameNo.duplicate, true);
    assert.equal(sameNo.reason, 'invoice_no');

    // Özgün belge geri okunabilir ve hiçbir mali kayıt oluşmadı.
    const part = await f.doc('/documents/' + first.id + '/part', undefined, 'ec', '?index=0');
    assert.equal(Buffer.from(part.data, 'base64').toString(), Buffer.from(first.bytes).toString());
    assert.deepEqual(counts(f), before, 'yükleme borç, stok veya fatura oluşturmamalı');
    assert.throws(() => f.s.exec("DELETE FROM ec_purchase_documents WHERE id='" + first.id + "'"), /IMMUTABLE_LEDGER/);
  } finally { f.s.close(); }
});

test('Taranmış belge satır uydurmaz; metin katmanı yok olarak saklanır', async () => {
  const f = fixture(); try {
    const doc = await upload(f, 'taranmis', {text_layer: 0, warnings: ['Metin katmanı yok; OCR hizmeti bulunmuyor.']});
    const detail = await f.doc('/documents/' + doc.id);
    assert.equal(detail.text_layer, 0);
    assert.deepEqual(detail.extracted, {}, 'okunamayan belgeden satır türetilmez');
    assert.match(detail.notice, /elle girin/);
  } finally { f.s.close(); }
});

/** Tropikal: aynı boyun altı çeşidi; fatura tek kalem yazıyor, adetler her belgede yeniden giriliyor. */
async function tropikal(f) {
  const supplier = (await f.ac('/suppliers', {name: 'Tropikal Tedarik'})).id;
  const variants = {};
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F'])
    variants[name] = (await f.ac('/products', {name: 'Bitki besini 500 ml · ' + name, sku: 'BB500-' + name, stock_unit: 'adet', min_stock: 0})).id;
  const family = await f.doc('/families', {name: 'Bitki besini', size_label: '500 ml', stock_unit: 'adet', product_ids: Object.values(variants)});
  await f.doc('/families/link', {supplier_id: supplier, match_by: 'code', match_value: 'BB-500', source_unit: 'adet', family_id: family.id, units_per_invoice_unit: 1});
  return {supplier, variants, family};
}
const invoiceOf = async (f, supplier, no, quantity, net, tax) =>
  (await f.ac('/invoices', {supplier_id: supplier, invoice_no: no, invoice_date: '2026-09-10', currency: 'TRY',
    lines: [{description: 'Bitki besini 500 ml', external_code: 'BB-500', invoice_quantity: quantity, invoice_unit: 'adet', net, tax}]})).id;

test('Tropikal: her faturada çeşit dağılımı yeniden yapılır; önceki adetler uygulanmaz, toplamlar korunur', async () => {
  const f = fixture(); try {
    const {supplier, variants, family} = await tropikal(f);

    // 1. fatura: 60 adet → A 10, B 20, C 30.
    const inv1 = await invoiceOf(f, supplier, 'TRP-1', 60, 600, 120);
    const line1 = (await f.ac('/invoices/' + inv1)).lines[0];
    await f.split(inv1 + '/split', {line_id: line1.id, total_quantity: 60, family_id: family.id, equal_unit_cost: true,
      reason: 'İrsaliye dökümü TRP-1', allocations: [{product_id: variants.A, quantity: 10}, {product_id: variants.B, quantity: 20}, {product_id: variants.C, quantity: 30}]});
    const after1 = await f.ac('/invoices/' + inv1);
    assert.equal(after1.lines.length, 3);
    assert.equal(after1.lines.reduce((s, l) => s + l.net_cents, 0), 60000, 'net kuruş toplamı korunur');
    assert.equal(after1.lines.reduce((s, l) => s + l.tax_cents, 0), 12000, 'KDV kuruşu korunur');
    assert.equal(after1.splits[0].original.description, 'Bitki besini 500 ml', 'asıl fatura satırı saklanır');
    await f.ac('/invoices/' + inv1 + '/post', {});
    await f.ac('/invoices/' + inv1 + '/receive', {reference: 'TESLIM-1', occurred_on: '2026-09-10', lines: after1.lines.map(l => ({id: l.id, quantity: l.quantity_milli / 1000}))});

    // 2. fatura: AYNI satır, 24 adet → A 6, D 18. Önceki 10/20/30 veya oranı otomatik uygulanmaz.
    const inv2 = await invoiceOf(f, supplier, 'TRP-2', 24, 240, 48);
    const line2 = (await f.ac('/invoices/' + inv2)).lines[0];
    assert.equal(line2.product_id, null, 'aile satırı tek bir stok kartına otomatik bağlanmaz');
    await f.split(inv2 + '/split', {line_id: line2.id, total_quantity: 24, family_id: family.id, equal_unit_cost: true,
      reason: 'İrsaliye dökümü TRP-2', allocations: [{product_id: variants.A, quantity: 6}, {product_id: variants.D, quantity: 18}]});
    const after2 = await f.ac('/invoices/' + inv2);
    assert.equal(after2.lines.length, 2, 'yalnız alınan çeşitler; altı çeşidin tümü zorunlu değil');
    assert.equal(after2.lines.reduce((s, l) => s + l.net_cents, 0), 24000);
    await f.ac('/invoices/' + inv2 + '/post', {});
    await f.ac('/invoices/' + inv2 + '/receive', {reference: 'TESLIM-2', occurred_on: '2026-09-10', lines: after2.lines.map(l => ({id: l.id, quantity: l.quantity_milli / 1000}))});

    // Her çeşit ayrı stok kartı ve ayrı hareket: A 10+6, B 20, C 30, D 18, E/F hiç.
    const stock = id => f.s.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;
    assert.equal(stock(variants.A), 16000, 'iki faturadan gelen A toplanır');
    assert.equal(stock(variants.B), 20000);
    assert.equal(stock(variants.C), 30000);
    assert.equal(stock(variants.D), 18000);
    assert.equal(stock(variants.E), 0, 'alınmayan çeşit stoğa girmez');

    // Cari borç fatura başına bir kez: 720 + 288.
    assert.equal(f.s.prepare('SELECT SUM(amount_cents) n FROM ec_party_entries').get().n, -(72000 + 28800));
    // Tekrar teslim stokları çoğaltmaz.
    await assert.rejects(f.ac('/invoices/' + inv2 + '/receive', {reference: 'TESLIM-2B', occurred_on: '2026-09-10',
      lines: after2.lines.map(l => ({id: l.id, quantity: l.quantity_milli / 1000}))}), e => e.status === 409);
    assert.equal(stock(variants.D), 18000, 'ikinci teslim denemesi stoğu artırmadı');
    // Hatırlanan bağlantıda adet yok: yalnız aile ve birim dönüşümü saklanır.
    const link = f.s.prepare('SELECT * FROM ec_purchase_family_links').get();
    assert.deepEqual(Object.keys(link).filter(k => /quantity|adet|allocation/i.test(k)), [], 'çeşit adetleri hatırlanmaz');
  } finally { f.s.close(); }
});

test('Tek çeşit de dağıtılabilir; aile dışı çeşit ve eksik/fazla dağıtım reddedilir', async () => {
  const f = fixture(); try {
    const {supplier, variants, family} = await tropikal(f);
    const other = (await f.ac('/products', {name: 'Bitki besini 1 lt · A', sku: 'BB1000-A', stock_unit: 'adet', min_stock: 0})).id;

    const inv = await invoiceOf(f, supplier, 'TRP-3', 12, 120, 24);
    const line = (await f.ac('/invoices/' + inv)).lines[0];
    // Benzer isimli FARKLI hacim aynı aileye bağlanamaz.
    await assert.rejects(f.split(inv + '/split', {line_id: line.id, total_quantity: 12, family_id: family.id, equal_unit_cost: true,
      reason: 'Yanlış hacim', allocations: [{product_id: other, quantity: 12}]}), e => e.status === 409);
    // Eksik dağıtım kesinleştirilemez.
    await assert.rejects(f.split(inv + '/split', {line_id: line.id, total_quantity: 12, family_id: family.id, equal_unit_cost: true,
      reason: 'Eksik', allocations: [{product_id: variants.A, quantity: 5}]}), e => e.status === 400);
    // Tek çeşit alınmışsa 1 ürüne dağıtım yapılabilir.
    const done = await f.split(inv + '/split', {line_id: line.id, total_quantity: 12, family_id: family.id, equal_unit_cost: true,
      reason: 'Tamamı A çeşidi', allocations: [{product_id: variants.A, quantity: 12}]});
    assert.ok(done.split_id);
    const after = await f.ac('/invoices/' + inv);
    assert.equal(after.lines.length, 1);
    assert.equal(after.lines[0].product_id, variants.A);
    assert.equal(after.lines[0].net_cents, 12000);
    assert.equal(after.lines[0].tax_cents, 2400);
  } finally { f.s.close(); }
});

test('Belge fatura kaydına bağlanır; ikinci belge aynı faturaya bağlanamaz', async () => {
  const f = fixture(); try {
    const supplier = (await f.ac('/suppliers', {name: 'Tropikal Tedarik'})).id;
    const invoice = await invoiceOf(f, supplier, 'TRP-9', 1, 10, 2);
    const doc = await upload(f, 'baglanacak');
    const linked = await f.doc('/documents/' + doc.id + '/link', {invoice_id: invoice});
    assert.equal(linked.invoice_id, invoice);
    assert.equal(f.s.prepare('SELECT status FROM ec_purchase_documents WHERE id=?').get(doc.id).status, 'linked');
    const second = await upload(f, 'ikinci');
    await assert.rejects(f.doc('/documents/' + second.id + '/link', {invoice_id: invoice}), e => e.status === 409);
    await assert.rejects(f.doc('/documents/' + doc.id + '/link', {invoice_id: invoice}), e => e.status === 409);
  } finally { f.s.close(); }
});
