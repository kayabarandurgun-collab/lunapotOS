// Yanlış kurulmuş ÇEŞİT AİLESİ (ürün ailesi) temizlenebilmeli. Aile SİLİNMEZ: arşivlenir.
//
//   · Arşivli aile YENİ eşleştirmede seçilemez (liste, tedarikçi hatırlatması, çeşit dağılımı).
//   · Geçmiş fatura satırları, dağılım kayıtları ve stok hareketleri OLDUĞU GİBİ kalır.
//   · Arşivleme geri alınabilir; yanlışlıkla arşivlenen aile kullanıma dönebilir.
//   · Yetkisiz personel arşivleyemez; alış faturası yazma yetkisi gerekir.
//
// TEMSİLİ veri: gerçek tedarikçi faturası veya gerçek ürün kartı DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scopedDB} from '../src/scoped-db.js';
import {accountingApi} from '../src/accounting.js';
import {purchaseSplitApi} from '../src/purchase-split-api.js';
import {purchaseDocumentApi} from '../src/purchase-document-api.js';
import {permit} from '../src/permission-policy.js';
import {parsePermissions} from '../public/permissions.js';

function fixture() {
  const s = new DatabaseSync(':memory:');
  s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) { return {args: [], bind(...a) { this.args = a; return this; }, first() { return s.prepare(sql).get(...this.args) || null; }, all() { return {results: s.prepare(sql).all(...this.args)}; }, run() { return s.prepare(sql).run(...this.args); }}; },
    async batch(items) { s.exec('BEGIN'); try { const r = items.map(i => i.all()); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; } }
  };
  const call = (handler, ns, path, body) => handler(new Request('https://test.local' + path, {method: body === undefined ? 'GET' : 'POST'}),
    {DB: scopedDB(DB, ns), ROOT_DB: DB, WORKSPACE: ns}, path, async () => body);
  return {s, DB,
    ac: (path, body, ns = 'ec') => call(accountingApi, ns, '/api/accounting' + path, body),
    split: (path, body, ns = 'ec') => call(purchaseSplitApi, ns, '/api/invoices/' + path, body),
    doc: (path, body, ns = 'ec') => call(purchaseDocumentApi, ns, '/api/invoices' + path, body)};
}

/** Aynı boyun çeşitleri + tedarikçinin tek kalem yazdığı satır için hatırlatma. */
async function kurulum(f) {
  const supplier = (await f.ac('/suppliers', {name: 'Tropikal Tedarik'})).id;
  const variants = {};
  for (const name of ['A', 'B', 'C'])
    variants[name] = (await f.ac('/products', {name: 'Bitki besini 500 ml · ' + name, sku: 'BB500-' + name, stock_unit: 'adet', min_stock: 0})).id;
  const family = await f.doc('/families', {name: 'Bitki besini', size_label: '500 ml', stock_unit: 'adet', product_ids: Object.values(variants)});
  await f.doc('/families/link', {supplier_id: supplier, match_by: 'code', match_value: 'BB-500', source_unit: 'adet', family_id: family.id, units_per_invoice_unit: 1});
  return {supplier, variants, family};
}
const faturaAc = async (f, supplier, no, quantity, net, tax) =>
  (await f.ac('/invoices', {supplier_id: supplier, invoice_no: no, invoice_date: '2026-09-10', currency: 'TRY',
    lines: [{description: 'Bitki besini 500 ml', external_code: 'BB-500', invoice_quantity: quantity, invoice_unit: 'adet', net, tax}]})).id;

test('Aile arşivlenir: yeni eşleştirmede seçilemez, geçmiş kayıtlar bozulmaz, geri alınabilir', async () => {
  const f = fixture(); try {
    const {supplier, variants, family} = await kurulum(f);

    // 1) GEÇMİŞ: aile daha kullanımdayken bir fatura dağıtılıp stoğa girsin.
    const inv1 = await faturaAc(f, supplier, 'TRP-1', 30, 300, 60);
    const line1 = (await f.ac('/invoices/' + inv1)).lines[0];
    await f.split(inv1 + '/split', {line_id: line1.id, total_quantity: 30, family_id: family.id, equal_unit_cost: true,
      reason: 'İrsaliye TRP-1', allocations: [{product_id: variants.A, quantity: 10}, {product_id: variants.B, quantity: 20}]});
    const once = await f.ac('/invoices/' + inv1);
    await f.ac('/invoices/' + inv1 + '/post', {});
    await f.ac('/invoices/' + inv1 + '/receive', {reference: 'TESLIM-1', occurred_on: '2026-09-10', lines: once.lines.map(l => ({id: l.id, quantity: l.quantity_milli / 1000}))});
    const stok = id => f.s.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;
    assert.equal(stok(variants.A), 10000);

    // 2) ARŞİVLE: aile yanlış kurulmuş; kullanıcı temizliyor.
    const arsiv = await f.doc('/families/' + family.id + '/archive', {});
    assert.equal(arsiv.archived, true);
    assert.equal(arsiv.links, 1, 'kaç tedarikçi hatırlatmasının düşeceği söylenir');
    assert.equal(arsiv.splits, 1, 'kaç geçmiş dağılımın aileye bağlı kaldığı söylenir');
    assert.match(arsiv.notice, /Geçmiş/);
    assert.ok(f.s.prepare('SELECT archived_at FROM ec_product_families WHERE id=?').get(family.id).archived_at, 'archived_at doldurulur');

    // 3) YENİ EŞLEŞTİRMEDE YOK: ne listede, ne tedarikçi hatırlatmasında.
    const liste = await f.doc('/families');
    assert.deepEqual(liste.families.map(x => x.id), [], 'arşivli aile seçim listesinde çıkmaz');
    assert.deepEqual(liste.links, [], 'arşivli ailenin tedarikçi hatırlatması uygulanmaz');
    assert.equal(liste.archived.length, 1, 'arşiv ayrı listede görünür (geri alınabilsin)');
    assert.equal(liste.archived[0].id, family.id);
    assert.equal(liste.archived[0].members.length, 3, 'arşivli ailenin üyeleri de görünür');

    // 4) YENİ DAĞILIM VE YENİ HATIRLATMA KAPALI.
    const inv2 = await faturaAc(f, supplier, 'TRP-2', 12, 120, 24);
    const line2 = (await f.ac('/invoices/' + inv2)).lines[0];
    await assert.rejects(f.split(inv2 + '/split', {line_id: line2.id, total_quantity: 12, family_id: family.id, equal_unit_cost: true,
      reason: 'Arşivli aileye dağıtım', allocations: [{product_id: variants.A, quantity: 12}]}),
    e => e.status === 409 && /arşiv/i.test(e.message), 'arşivli aileye yeni çeşit dağılımı yapılamaz');
    await assert.rejects(f.doc('/families/link', {supplier_id: supplier, match_by: 'code', match_value: 'BB-750', source_unit: 'adet', family_id: family.id, units_per_invoice_unit: 1}),
      e => e.status === 409 && /arşiv/i.test(e.message), 'arşivli aile için yeni hatırlatma kurulamaz');

    // 5) GEÇMİŞ BOZULMAZ: satırlar, dağılım kaydı ve stok aynen durur.
    const sonra = await f.ac('/invoices/' + inv1);
    assert.deepEqual(sonra.lines.map(l => [l.product_id, l.net_cents, l.tax_cents]), once.lines.map(l => [l.product_id, l.net_cents, l.tax_cents]));
    assert.equal(sonra.splits.length, 1, 'geçmiş dağılım kaydı durur');
    assert.equal(sonra.splits[0].original.description, 'Bitki besini 500 ml');
    assert.equal(f.s.prepare('SELECT family_id FROM ec_purchase_line_splits WHERE invoice_id=?').get(inv1).family_id, family.id, 'geçmiş dağılım aileye bağlı kalır');
    assert.equal(stok(variants.A), 10000);
    assert.equal(stok(variants.B), 20000);

    // 6) GERİ ALINABİLİR: arşivden çıkınca yeniden kullanılır.
    const geri = await f.doc('/families/' + family.id + '/restore', {});
    assert.equal(geri.archived, false);
    assert.equal(f.s.prepare('SELECT archived_at FROM ec_product_families WHERE id=?').get(family.id).archived_at, null);
    const liste2 = await f.doc('/families');
    assert.deepEqual(liste2.families.map(x => x.id), [family.id]);
    assert.deepEqual(liste2.archived, []);
    assert.equal(liste2.links.length, 1, 'hatırlatma geri döner');
    const ok = await f.split(inv2 + '/split', {line_id: line2.id, total_quantity: 12, family_id: family.id, equal_unit_cost: true,
      reason: 'İrsaliye TRP-2', allocations: [{product_id: variants.C, quantity: 12}]});
    assert.ok(ok.split_id, 'arşivden çıkan aileye yeniden dağıtılabilir');
  } finally { f.s.close(); }
});

test('Arşiv durumu tekrarlanmaz; bilinmeyen aile arşivlenemez; arşivdeki ad geri alınmadan kullanılamaz', async () => {
  const f = fixture(); try {
    const {family} = await kurulum(f);
    await assert.rejects(f.doc('/families/' + family.id + '/restore', {}), e => e.status === 409, 'arşivde olmayan aile geri alınamaz');
    await f.doc('/families/' + family.id + '/archive', {});
    await assert.rejects(f.doc('/families/' + family.id + '/archive', {}), e => e.status === 409, 'iki kez arşivlenmez');
    await assert.rejects(f.doc('/families/yok-boyle-bir-aile/archive', {}), e => e.status === 404);

    // Ad + boy tekilliği arşivde de durur: sessizce ikinci bir aile açılmaz, yol gösterilir.
    const urun = (await f.ac('/products', {name: 'Bitki besini 500 ml · Z', sku: 'BB500-Z', stock_unit: 'adet', min_stock: 0})).id;
    await assert.rejects(f.doc('/families', {name: 'Bitki besini', size_label: '500 ml', stock_unit: 'adet', product_ids: [urun]}),
      e => e.status === 409 && /arşiv/i.test(e.message), 'aynı ad arşivdeyse kullanıcıya geri alması söylenir');
  } finally { f.s.close(); }
});

test('Arşivleme alış faturası yazma yetkisi ister; okuyan veya ilgisiz personel yapamaz', () => {
  const yaz = {owner: false, name: 'Y', ec_access: 'write', lp_access: 'read', permissions: parsePermissions({ec: {invoices: 'write'}, lp: {}})};
  const oku = {owner: false, name: 'O', ec_access: 'read', lp_access: 'read', permissions: parsePermissions({ec: {invoices: 'read'}, lp: {}})};
  const ilgisiz = {owner: false, name: 'I', ec_access: 'read', lp_access: 'read', permissions: parsePermissions({ec: {orders: 'read'}, lp: {}})};
  for (const yol of ['/api/ec/invoices/abc/archive', '/api/ec/invoices/abc/restore'].map(p => p.replace('/invoices/', '/invoices/families/'))) {
    assert.doesNotThrow(() => permit(yaz, yol, 'POST'), yol + ' yazma yetkisiyle açık olmalı');
    assert.throws(() => permit(oku, yol, 'POST'), e => e.status === 403, yol + ' okuma yetkisi yazmaya dönüşmemeli');
    assert.throws(() => permit(ilgisiz, yol, 'POST'), e => e.status === 403, yol + ' ilgisiz personele kapalı olmalı');
  }
  // Üretim alanında aynı uç cari/muhasebe yetkisine bağlıdır.
  const uretim = {owner: false, name: 'U', ec_access: 'none', lp_access: 'write', permissions: parsePermissions({ec: {}, lp: {accounts: 'write'}})};
  assert.doesNotThrow(() => permit(uretim, '/api/lp/invoices/families/abc/archive', 'POST'));
  assert.throws(() => permit({...uretim, permissions: parsePermissions({ec: {}, lp: {accounts: 'read'}})}, '/api/lp/invoices/families/abc/archive', 'POST'), e => e.status === 403);
});

test('Arayüzde arşivleme düğmesi onay sorar ve arşivi geri almayı sunar', () => {
  const src = readFileSync(new URL('../public/purchase-document-ui.js', import.meta.url), 'utf8');
  assert.match(src, /data-pd="archive-family"/, 'satır eşleştirme adımında arşivleme düğmesi olmalı');
  assert.match(src, /data-pd="restore-family"/, 'arşivden çıkarma düğmesi olmalı');
  assert.match(src, /confirm\(/, 'arşivleme onay sormadan çalışmamalı');
  const kanca = /if \(a === 'archive-family'\)[\s\S]{0,400}?confirm\(/;
  assert.match(src, kanca, 'arşivleme tıklaması önce onay istemeli');
  assert.match(src, /api\('\/invoices\/families\/'/, 'arşiv ucu aile kimliğiyle çağrılmalı');
  assert.match(src, /'\/archive'/, 'arşivleme ucu çağrılmalı');
  assert.match(src, /'\/restore'/, 'arşivden çıkarma ucu çağrılmalı');
  assert.match(src, /archivedFamilies/, 'arşivli aileler ayrı tutulmalı; seçim listesine karışmamalı');
});

// Bu ekran dosyası testlerde hiç AYRIŞTIRILMIYOR: bozuk bir metin dizisi ancak canlıda,
// kullanıcı alış faturası yüklerken patlardı. Söz dizimi burada bir kez doğrulanır.
test('Alış belgesi ekranının söz dizimi geçerli', () => {
  for (const dosya of ['purchase-document-ui.js', 'purchase-match.js'])
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../public/' + dosya, import.meta.url))],
      {stdio: 'pipe'}), dosya + ' ayrıştırılamıyor');
});
