import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// FATURASIZ MAL GİRİŞİ. Vadeli tedarikçi malı önce gönderir, faturayı vade gününde keser.
// Mal geldiğinde geçici olarak girilir: stok eksiye düşmez, cari borcu görünür.
// Gerçek fatura muhasebeleşince aynı mal İKİNCİ KEZ stoğa girmez ve borç iki kez durmaz.

const GELIS = '2026-09-10', FATURA_TARIHI = '2026-09-30';

async function seed() {
 const f = appFixture(); await f.setup();
 const supplier = await f.ok('/ec/suppliers', {name: 'Vadeli Torf A.Ş.', tax_id: '1234567890', contact: ''});
 const product = (await f.ok('/ec/products', {name: 'Torf 20 L', sku: 'T-20', stock_unit: 'adet', min_stock: 0})).id;
 return {f, supplier, product};
}

const stok = (f, product) => f.sqlite.prepare('SELECT quantity_milli q, value_cents v FROM ec_stock_balances WHERE product_id=?').get(product);
const bakiye = (f, party) => f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(party).n;

// 10 adet mal geldi, faturası yok: stok 10 olur, cari 10 adetlik borcu gösterir.
const gecici = (f, supplier, product, adet = 10, birim = 10000) => f.ok('/ec/ledger/provisional', {
 supplier_id: supplier, occurred_on: GELIS, reference: 'IRSALIYE-1', notes: 'Vade sonunda faturalanacak',
 lines: [{product_id: product, quantity: adet, unit_cost: birim / 100, vat_bps: 2000}]
});

// Fatura tutarları LİRA girilir (amount() kuruşa çevirir): 1000 TL + 200 TL KDV = 1.200 TL.
const gercekFatura = async (f, supplier, product, adet = 10, net = 1000) => {
 const invoice = (await f.ok('/ec/invoices', {
  supplier_id: supplier, invoice_no: 'F-2026-1', invoice_date: FATURA_TARIHI, currency: 'TRY',
  lines: [{description: 'Torf 20 L', external_code: 'T-20', invoice_quantity: adet, invoice_unit: 'adet',
   product_id: product, stock_quantity: adet, net, tax: Math.round(net * 0.2)}]
 })).id;
 await f.ok('/ec/invoices/' + invoice + '/post', {});
 // Mal teslimi ayrı adımdır; geçici sayım kapanışı burada çalışır.
 const line = f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(invoice).id;
 await f.ok('/ec/invoices/' + invoice + '/receive', {occurred_on: FATURA_TARIHI, reference: 'TESLIM-1', lines: [{id: line, quantity: adet}]});
 return invoice;
};

test('Faturasız mal girişi stoğu artırır ve cariye geçici borç yazar', async () => {
 const {f, supplier, product} = await seed(); try {
  const r = await gecici(f, supplier.id, product);
  assert.ok(r.id, 'geçici giriş kimliği dönmeli');

  assert.equal(stok(f, product).q, 10000, 'stok 10 adet olmalı');
  assert.equal(stok(f, product).v, 100000, 'stok değeri KDV hariç maliyet olmalı');

  const hareket = f.sqlite.prepare("SELECT * FROM ec_stock_movements WHERE reference LIKE 'GECICI-SAYIM-%'").all();
  assert.equal(hareket.length, 1, 'tek geçici sayım hareketi olmalı');
  assert.equal(hareket[0].kind, 'count', 'hareket sayım olmalı ki fatura gelince kapanabilsin');

  assert.equal(bakiye(f, supplier.id), -120000, 'cari borcu KDV dahil ve eksi işaretli olmalı');
  const entry = f.sqlite.prepare("SELECT * FROM ec_party_entries WHERE source_key='gecici:' || ?").get(r.id);
  assert.ok(entry, 'geçici borç gecici:<id> anahtarıyla yazılmalı');
 } finally { f.close(); }
});

test('Gerçek fatura gelince mal ikinci kez stoğa girmez ve borç iki kez durmaz', async () => {
 const {f, supplier, product} = await seed(); try {
  const r = await gecici(f, supplier.id, product);
  assert.equal(stok(f, product).q, 10000);
  assert.equal(bakiye(f, supplier.id), -120000);

  await gercekFatura(f, supplier.id, product);

  assert.equal(stok(f, product).q, 10000, 'ÇİFT GİRİŞ OLMAMALI: stok hâlâ 10 adet olmalı');
  assert.equal(bakiye(f, supplier.id), -120000, 'ÇİFT BORÇ OLMAMALI: cari yalnız bir kez borçlu olmalı');

  const kapanis = f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'provisional-close:%'").get().n;
  assert.ok(kapanis > 0, 'geçici sayım fatura kapanışıyla düşmeli');

  const kayit = f.sqlite.prepare('SELECT * FROM ec_provisional_receipts WHERE id=?').get(r.id);
  assert.ok(kayit.invoice_id, 'geçici giriş faturaya bağlanmalı');
  assert.ok(kayit.closed_on, 'kapanış tarihi yazılmalı');

  const ters = f.sqlite.prepare("SELECT COUNT(*) n FROM ec_party_entries WHERE source='reversal'").get().n;
  assert.equal(ters, 1, 'geçici borç tam olarak bir ters kayıtla kapanmalı');
  assert.ok(f.sqlite.prepare("SELECT 1 x FROM ec_party_entries WHERE source_key='invoice:' || ?").get(kayit.invoice_id), 'faturanın kendi borcu yazılmalı');
 } finally { f.close(); }
});

test('Kapanmış geçici giriş ikinci kez kapatılamaz', async () => {
 const {f, supplier, product} = await seed(); try {
  const r = await gecici(f, supplier.id, product);
  await gercekFatura(f, supplier.id, product);
  assert.throws(() => f.sqlite.prepare('UPDATE ec_provisional_receipts SET invoice_id=? WHERE id=?').run('baska', r.id),
   /PROVISIONAL_ALREADY_CLOSED|FOREIGN KEY/, 'kapalı kayıt yeniden kapatılamamalı');
 } finally { f.close(); }
});

test('Aynı referansla ikinci geçici giriş açılamaz', async () => {
 const {f, supplier, product} = await seed(); try {
  await gecici(f, supplier.id, product);
  const r = await f.req('/ec/ledger/provisional', {
   supplier_id: supplier.id, occurred_on: GELIS, reference: 'IRSALIYE-1', notes: '',
   lines: [{product_id: product, quantity: 5, unit_cost: 100, vat_bps: 2000}]
  });
  assert.equal(r.status, 409, 'aynı irsaliye referansı ikinci kez girilememeli');
  assert.equal(stok(f, product).q, 10000, 'reddedilen giriş stoğa dokunmamalı');
 } finally { f.close(); }
});
