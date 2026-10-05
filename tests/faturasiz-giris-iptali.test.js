import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// FATURASIZ GİRİŞİN İPTALİ. Aynı teslimat iki kez girilirse mal stokta İKİ KEZ durur ve
// tedarikçiye borç bir kez FAZLA görünür. Kayıt silinemez (0065'teki IMMUTABLE_LEDGER
// tetikleri) ve cari ekranından ters kaydedilemez (0069: ters kayıt borcu siler ama malı
// rafta bırakır, sonra fatura gelince mal iki kez sayılır ve tedarikçi kilitlenir).
// Çözüm: girişin stok ve cari etkisini birebir geri alan YENİ kayıtlar (0070). Bu testler
// hem iptalin doğru çalıştığını hem de iptale KAPALI durumların reddedildiğini tutar.

const GELIS = '2026-09-20', FATURA_TARIHI = '2026-09-30';

async function seed() {
 const f = appFixture(); await f.setup();
 const supplier = await f.ok('/ec/suppliers', {name: 'Tropikal Benzeri A.Ş.', tax_id: '1234567890', contact: ''});
 const product = (await f.ok('/ec/products', {name: 'Perlit 10 L', sku: 'P-10', stock_unit: 'adet', min_stock: 0})).id;
 return {f, supplier, product};
}

const stok = (f, p) => f.sqlite.prepare('SELECT quantity_milli q, value_cents v FROM ec_stock_balances WHERE product_id=?').get(p);
const bakiye = (f, party) => f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(party).n;
const sayi = (f, sql, ...a) => f.sqlite.prepare(sql).get(...a);

// 10 adet, birim 100 TL, KDV %20 → stok 10 adet / 1.000 TL değer, cari borcu 1.200 TL.
const gecici = (f, supplier, product, reference, adet = 10) => f.ok('/ec/ledger/provisional', {
 supplier_id: supplier, occurred_on: GELIS, reference, notes: '',
 lines: [{product_id: product, quantity: adet, unit_cost: 100, vat_bps: 2000}]
});

const receiptId = (f, reference) => f.sqlite.prepare('SELECT id FROM ec_provisional_receipts WHERE reference=?').get(reference).id;
const iptal = (f, id, reason = 'Aynı teslimat iki kez girildi') =>
 f.req('/ec/ledger/provisional/' + id + '/iptal', {reason});

test('Aynı teslimat iki kez girilince iptal stoğu ve borcu tek girişe indirir', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, 'IRS-GERCEK');
  await gecici(f, supplier.id, product, '000003');
  assert.equal(stok(f, product).q, 20000, 'iki giriş malı iki kez saymış olmalı');
  assert.equal(bakiye(f, supplier.id), -240000, 'borç iki kez durmalı');

  const r = await iptal(f, receiptId(f, '000003'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provisional_status, 'cancelled');

  assert.equal(stok(f, product).q, 10000, 'mal tek kez kalmalı');
  assert.equal(stok(f, product).v, 100000, 'stok değeri de tek kez kalmalı');
  assert.equal(bakiye(f, supplier.id), -120000, 'borç tek girişe inmeli');
  // Eksi değerli 'count' hareketi ec_count_loss ile UYDURMA kayıp gideri yazıyordu;
  // iptal 'purchase' kullanır, bu yüzden gider satırı doğmaz.
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_expenses').n, 0, 'uydurma kayıp gideri yazılmamalı');
 } finally { f.close(); }
});

test('İptalden sonra gerçek fatura mal ikinci kez stoğa girmez', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, 'IRS-GERCEK');
  await gecici(f, supplier.id, product, '000003');
  await iptal(f, receiptId(f, '000003'));

  const invoice = (await f.ok('/ec/invoices', {supplier_id: supplier.id, invoice_no: 'F-1', invoice_date: FATURA_TARIHI, currency: 'TRY',
   lines: [{description: 'Perlit 10 L', external_code: 'P-10', invoice_quantity: 10, invoice_unit: 'adet',
    product_id: product, stock_quantity: 10, net: 1000, tax: 200}]})).id;
  await f.ok('/ec/invoices/' + invoice + '/post', {});
  const line = f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(invoice).id;
  await f.ok('/ec/invoices/' + invoice + '/receive', {occurred_on: FATURA_TARIHI, reference: 'TESLIM-1', lines: [{id: line, quantity: 10}]});

  assert.equal(stok(f, product).q, 10000, 'fatura malı ikinci kez eklememeli');
  assert.equal(bakiye(f, supplier.id), -120000, 'borç tek fatura kadar kalmalı');
  // Tahsis yalnız SAĞLAM girişe gitmeli; iptal edilen satır eligible=0 olduğu için görünmez.
  const tahsis = f.sqlite.prepare(`SELECT a.id FROM ec_provisional_allocations a
   JOIN ec_provisional_receipt_lines l ON l.id=a.provisional_line_id
   JOIN ec_provisional_receipts r ON r.id=l.receipt_id WHERE r.reference='000003'`).all();
  assert.equal(tahsis.length, 0, 'iptal edilen girişe tahsis yazılmamalı');
 } finally { f.close(); }
});

test('İptal edilen giriş tedarikçinin sonraki faturalarını kilitlemez', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  await iptal(f, receiptId(f, '000003'));
  // Eski legacy korumaları yalnız eligible=0'a bakıyordu; iptal edilen satır muaf tutulmazsa
  // bu post PROVISIONAL_LEGACY_UNLINKED ile reddedilirdi ve panelden çıkış yolu kalmazdı.
  const invoice = (await f.ok('/ec/invoices', {supplier_id: supplier.id, invoice_no: 'F-2', invoice_date: FATURA_TARIHI, currency: 'TRY',
   lines: [{description: 'Perlit 10 L', external_code: 'P-10', invoice_quantity: 10, invoice_unit: 'adet',
    product_id: product, stock_quantity: 10, net: 1000, tax: 200}]})).id;
  const post = await f.req('/ec/invoices/' + invoice + '/post', {});
  assert.equal(post.status, 200, 'iptal sonrası fatura muhasebeleşebilmeli: ' + JSON.stringify(post.data));
  const line = f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(invoice).id;
  const rec = await f.req('/ec/invoices/' + invoice + '/receive', {occurred_on: FATURA_TARIHI, reference: 'TESLIM-2', lines: [{id: line, quantity: 10}]});
  assert.equal(rec.status, 200, 'teslim de yapılabilmeli: ' + JSON.stringify(rec.data));
  assert.equal(stok(f, product).q, 10000, 'mal normal alış olarak bir kez girmeli');
 } finally { f.close(); }
});

test('Aynı giriş ikinci kez iptal edilemez', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  const id = receiptId(f, '000003');
  assert.equal((await iptal(f, id)).status, 200);
  const ikinci = await iptal(f, id);
  assert.equal(ikinci.status, 409);
  assert.match(ikinci.data.error, /zaten iptal/i);
  assert.equal(stok(f, product).q, 0, 'mal yalnız bir kez geri çekilmeli');
 } finally { f.close(); }
});

test('Faturalanmış giriş iptal edilemez', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, 'IRS-1');
  const invoice = (await f.ok('/ec/invoices', {supplier_id: supplier.id, invoice_no: 'F-3', invoice_date: FATURA_TARIHI, currency: 'TRY',
   lines: [{description: 'Perlit 10 L', external_code: 'P-10', invoice_quantity: 10, invoice_unit: 'adet',
    product_id: product, stock_quantity: 10, net: 1000, tax: 200}]})).id;
  await f.ok('/ec/invoices/' + invoice + '/post', {});
  const r = await iptal(f, receiptId(f, 'IRS-1'));
  assert.equal(r.status, 409);
  assert.equal(stok(f, product).q, 10000, 'reddedilen iptal stoğa dokunmamalı');
 } finally { f.close(); }
});

test('Malı raftan çıkmış giriş iptal edilemez', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003', 2);
  // Mal satıldı: geri çekmek stoğu eksiye düşürürdü, hayalet eksik yaratırdı.
  await f.ok('/ec/sales', {channel: 'trendyol', external_id: 'S-1', product_id: product, quantity: 2,
   revenue: 500, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: '2026-09-25', notes: ''});
  const r = await iptal(f, receiptId(f, '000003'));
  assert.equal(r.status, 409, 'satılmış mal geri çekilemez: ' + JSON.stringify(r.data));
 } finally { f.close(); }
});

test('Mal geri çekilmeden borç kapatılamaz', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  const head = f.sqlite.prepare("SELECT id,entry_id,occurred_on,reference FROM ec_provisional_receipts WHERE reference='000003'").get();
  // Yalnız cari kaydını yazmaya çalışmak: borç silinir, mal rafta kalır. Tetik buna izin vermez.
  assert.throws(() => f.sqlite.prepare(
   `INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
    VALUES('iptal-yarim',?,120000,?,?,'yarim','gecici-iptal:'||?,'manual')`)
   .run(head.id ? f.sqlite.prepare("SELECT party_id FROM ec_party_entries WHERE id=?").get(head.entry_id).party_id : null,
    head.occurred_on, head.reference, head.id), /PROVISIONAL_CANCEL_INCOMPLETE|CANCEL/);
  assert.equal(stok(f, product).q, 10000, 'stok bozulmamalı');
  assert.equal(bakiye(f, supplier.id), -120000, 'borç kapanmamalı');
 } finally { f.close(); }
});

test('İptal kaydı sayım hareketinin tam aynası olmak zorundadır', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  const ref = 'GECICI-IPTAL-000003';
  const dene = (q, v, kind = 'purchase', on = GELIS) => () => f.sqlite.prepare(
   `INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
    VALUES(lower(hex(randomblob(16))),?,?,?,?,?,'deneme',?)`).run(product, q, v, kind, ref, on);
  assert.throws(dene(-5000, -100000), /CANCEL/, 'yarım miktar reddedilmeli');
  assert.throws(dene(-10000, -50000), /CANCEL/, 'yanlış değer reddedilmeli');
  assert.throws(dene(10000, 100000), /CANCEL/, 'artı miktar reddedilmeli');
  assert.throws(dene(-10000, -100000, 'count'), /CANCEL|LOSS/, 'sayım türü reddedilmeli');
  assert.throws(dene(-10000, -100000, 'purchase', '2026-09-21'), /CANCEL/, 'yanlış tarih reddedilmeli');
  assert.equal(stok(f, product).q, 10000, 'hiçbiri stoğa dokunmamalı');
 } finally { f.close(); }
});

test('Cari ekranı iptal edilen girişi iptal olarak gösterir', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  await iptal(f, receiptId(f, '000003'));
  const view = await f.ok('/ec/ledger');
  const row = (view.entries || []).find(e => String(e.source_key || '').startsWith('gecici:'));
  assert.ok(row, 'faturasız giriş satırı bulunmalı');
  assert.equal(row.provisional_status, 'cancelled', 'durum iptal olmalı, "bağı kontrol edilmeli" değil');
  assert.equal(row.provisional_remaining_cents, 0, 'kalan geçici borç sıfır olmalı');
 } finally { f.close(); }
});

test('İptalin cari kaydı geri alınamaz', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  await iptal(f, receiptId(f, '000003'));
  const entry = f.sqlite.prepare("SELECT id FROM ec_party_entries WHERE source_key LIKE 'gecici-iptal:%'").get().id;
  // Ters kayıt borcu geri getirirdi ama mal stoktan çıkmış durumda: izin verilmez.
  const r = await f.req('/ec/ledger/reverse', {entry: entry, reason: 'deneme'});
  assert.equal(r.status >= 400, true, 'iptal kaydı ters kaydedilememeli: ' + JSON.stringify(r.data));
  assert.equal(bakiye(f, supplier.id), 0, 'bakiye bozulmamalı');
 } finally { f.close(); }
});

test('İptalden sonra düzeltilmiş referansla yeniden girilebilir', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product, '000003');
  await iptal(f, receiptId(f, '000003'));
  const ayni = await f.req('/ec/ledger/provisional', {supplier_id: supplier.id, occurred_on: GELIS, reference: '000003', notes: '',
   lines: [{product_id: product, quantity: 10, unit_cost: 100, vat_bps: 2000}]});
  assert.equal(ayni.status, 409, 'aynı referans yeniden kullanılamaz');
  const duzeltilmis = await f.req('/ec/ledger/provisional', {supplier_id: supplier.id, occurred_on: GELIS, reference: '6093012405584', notes: '',
   lines: [{product_id: product, quantity: 10, unit_cost: 100, vat_bps: 2000}]});
  assert.equal(duzeltilmis.status, 200, 'düzeltilmiş referans girilebilmeli: ' + JSON.stringify(duzeltilmis.data));
  assert.equal(stok(f, product).q, 10000);
 } finally { f.close(); }
});
