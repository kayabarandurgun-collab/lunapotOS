import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// KASA/BANKA BAĞI. Hesap seçilmeden yazılan ödeme cari borcunu kapatıyor ama parayı hiçbir
// hesaptan düşmüyordu; kasa olduğundan fazla görünüyordu. Artık iki kural var:
//  1) Parası ANINDA çıkan yöntemlerde (nakit, havale/EFT, kart) kasa/banka hesabı ZORUNLUDUR.
//     Kart da buraya dahildir: kart ödemesi fiilen ödeme günü kasadan düşülüyor, hesabı isteğe
//     bağlı bırakmak canlıda kasasız kart ödemeleri doğurmuştu.
//  2) Yalnız ÇEK vadelidir: para vade gününde çıkar. Çıktığı gün var olan ödemeye kasa hareketi
//     BAĞLANIR. Bağlama /ledger/cash ucunda party_entry_id ile yapılır: yeni cari hareketi AÇILMAZ,
//     borç ikinci kez kapanmaz, mükerrer kasa çıkışı yazılmaz.

const TARIH = '2026-09-09';
const VADE = '2026-10-31';

async function seed() {
 const f = appFixture(); await f.setup();
 const supplier = await f.ok('/ec/suppliers', {name: 'Torf Tedarikçisi', tax_id: '1234567890', contact: ''});
 const product = (await f.ok('/ec/products', {name: 'Torf', sku: 'T-1', stock_unit: 'adet', min_stock: 0})).id;
 const kasa = await f.ok('/ec/ledger/accounts', {name: 'Ana Kasa', kind: 'cash'});
 const fatura = async (no, net, tax = 0) => {
  const id = (await f.ok('/ec/invoices', {
   supplier_id: supplier.id, invoice_no: no, invoice_date: TARIH, currency: 'TRY',
   lines: [{description: 'Torf', external_code: 'T', invoice_quantity: 1, invoice_unit: 'adet', product_id: product, stock_quantity: 1, net, tax}]
  })).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  return id;
 };
 // Çekle ödenmiş fatura: borç kapalı, para henüz kasadan çıkmadı. Bağlamanın doğal örneği budur.
 const cekli = async (no = 'F-CEK', tutar = 1000) => {
  await fatura(no, tutar, 0);
  return f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: tutar, occurred_on: TARIH, method: 'cek', note: 'Ziraat çeki 123456', due_on: VADE});
 };
 return {f, supplier, kasa, fatura, cekli};
}

const sayi = (f, sql, ...args) => f.sqlite.prepare(sql).get(...args).n;

test('Var olan ödemeye kasa hareketi bağlanır; yeni cari hareketi açılmaz', async () => {
 const {f, supplier, kasa, cekli} = await seed(); try {
  const cek = await cekli('F-1', 1000);
  const hareketSayisi = sayi(f, 'SELECT COUNT(*) n FROM ec_party_entries');
  const bakiye = sayi(f, 'SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?', supplier.id);

  const baglama = await f.ok('/ec/ledger/cash', {
   account_id: kasa.id, party_entry_id: cek.id, direction: 'payment', amount: 1000,
   occurred_on: VADE, reference: 'CEK-TAHSIL-1', description: 'Çek vadesinde kasadan ödendi'
  });
  assert.equal(baglama.party_entry_id, cek.id, 'kasa hareketi var olan ödemeye bağlanmalı');
  const hareket = f.sqlite.prepare('SELECT * FROM ec_cash_transactions WHERE id=?').get(baglama.id);
  assert.ok(hareket, 'kasa hareketi yazılmalı');
  assert.equal(hareket.party_entry_id, cek.id);
  assert.equal(hareket.amount_cents, -100000, 'ödeme kasadan çıkış olmalı');
  assert.equal(hareket.account_id, kasa.id);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_party_entries'), hareketSayisi, 'bağlama yeni cari hareketi açmamalı');
  assert.equal(sayi(f, 'SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?', supplier.id), bakiye, 'bağlama cari bakiyesini değiştirmemeli');

  const data = await f.ok('/ec/ledger');
  assert.equal(data.accounts.find(a => a.id === kasa.id).balance_cents, -100000, 'para kasadan düşmeli');
  assert.equal((data.open_invoices || []).length, 0, 'borç ikinci kez açılmamalı, fatura kapalı kalmalı');
  const satir = data.cash_transactions.find(t => t.id === baglama.id);
  assert.equal(satir.party_id, supplier.id, 'kasa hareketi cariyle birlikte görünmeli');
 } finally {f.close();}
});

test('Aynı ödemeye ikinci kasa hareketi bağlanmaz; mükerrer kasa çıkışı yazılmaz', async () => {
 const {f, kasa, cekli} = await seed(); try {
  const cek = await cekli('F-2', 500);
  await f.ok('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: cek.id, direction: 'payment', amount: 500, occurred_on: VADE, reference: 'CEK-TAHSIL-2', description: 'Çek ödendi'});
  const ikinci = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: cek.id, direction: 'payment', amount: 500, occurred_on: VADE, reference: 'CEK-TAHSIL-2-TEKRAR', description: 'Yanlışlıkla ikinci kez'});
  assert.equal(ikinci.status, 409, 'bağlı kasa hareketi olan ödemeye ikinci kez bağlanmamalı');
  assert.match(ikinci.data.error, /kasa\/banka/i, 'uyarı Türkçe ve kasa hareketinden bahsetmeli: ' + ikinci.data.error);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 1, 'ikinci kasa hareketi yazılmamalı');
  assert.equal((await f.ok('/ec/ledger')).accounts.find(a => a.id === kasa.id).balance_cents, -50000);
 } finally {f.close();}
});

test('Kasa tutarı cari hareketiyle eşleşmezse bağlama reddedilir ve iki tutar da söylenir', async () => {
 const {f, kasa, cekli} = await seed(); try {
  const cek = await cekli('F-3', 1000);
  const eksik = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: cek.id, direction: 'payment', amount: 900, occurred_on: VADE, reference: 'CEK-TAHSIL-3', description: 'Eksik tutar'});
  assert.equal(eksik.status, 400, 'tutar uyuşmazlığı kabul edilmemeli');
  assert.match(eksik.data.error, /1\.000,00/, 'uyarı hareketin tutarını söylemeli: ' + eksik.data.error);
  assert.match(eksik.data.error, /900,00/, 'uyarı girilen tutarı söylemeli: ' + eksik.data.error);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 0, 'reddedilen bağlama kayıt bırakmamalı');

  const ters = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: cek.id, direction: 'receipt', amount: 1000, occurred_on: VADE, reference: 'CEK-TAHSIL-3-TERS', description: 'Yanlış yön'});
  assert.equal(ters.status, 400, 'ödemeye tahsilat bağlanmamalı');
  assert.match(ters.data.error, /çıkış/i, 'uyarı yönü söylemeli: ' + ters.data.error);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 0);
 } finally {f.close();}
});

test('Cari ile var olan hareket birlikte seçilemez; olmayan hareket bulunamaz', async () => {
 const {f, supplier, kasa, cekli} = await seed(); try {
  const cek = await cekli('F-4', 200);
  const ikisi = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_id: supplier.id, party_entry_id: cek.id, direction: 'payment', amount: 200, occurred_on: VADE, reference: 'CEK-TAHSIL-4', description: 'İkisi birden'});
  assert.equal(ikisi.status, 400, 'cari ve var olan hareket birlikte gönderilmemeli');
  assert.match(ikisi.data.error, /cari/i, 'uyarı Türkçe olmalı: ' + ikisi.data.error);

  const yok = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: 'olmayan-hareket', direction: 'payment', amount: 200, occurred_on: VADE, reference: 'CEK-TAHSIL-4B', description: 'Olmayan hareket'});
  assert.equal(yok.status, 404, 'olmayan hareket bulunamadı demeli');

  const elle = (await f.ok('/ec/ledger/entries', {party_id: supplier.id, amount: 50, occurred_on: TARIH, reference: 'ELLE-1', description: 'Elle girilen alacak'})).id;
  const uygunsuz = await f.req('/ec/ledger/cash', {account_id: kasa.id, party_entry_id: elle, direction: 'payment', amount: 50, occurred_on: TARIH, reference: 'CEK-TAHSIL-4C', description: 'Elle harekete bağlama'});
  assert.equal(uygunsuz.status, 409, 'elle girilen harekete kasa hareketi bağlanmamalı');
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 0);
 } finally {f.close();}
});

test('Parası anında çıkan ödemede kasa/banka hesabı zorunludur', async () => {
 const {f, supplier, kasa, fatura} = await seed(); try {
  await fatura('F-5', 1000, 0);
  for (const method of ['nakit','havale']) {
   const hesapsiz = await f.req('/ec/ledger/payments', {party_id: supplier.id, amount: 100, occurred_on: TARIH, method, note: 'Hesapsız'});
   assert.equal(hesapsiz.status, 400, method + ' ödemesi hesapsız kabul edilmemeli');
   assert.match(hesapsiz.data.error, /kasa|banka/i, 'uyarı hesabı istemeli: ' + hesapsiz.data.error);
  }
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_party_entries WHERE amount_cents>0'), 0, 'reddedilen ödeme kayıt bırakmamalı');
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_party_payment_methods'), 0);

  const nakit = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 100, occurred_on: TARIH, method: 'nakit', note: 'Kasadan elden', account_id: kasa.id});
  assert.equal(f.sqlite.prepare('SELECT amount_cents n FROM ec_cash_transactions WHERE party_entry_id=?').get(nakit.id).n, -10000, 'hesap seçilen ödeme kasadan düşmeli');
 } finally {f.close();}
});

test('Yalnız çekte hesap isteğe bağlı kalır: para vade gününde çıkar', async () => {
 const {f, supplier, fatura} = await seed(); try {
  await fatura('F-6', 1000, 0);
  const cek = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 1000, occurred_on: TARIH, method: 'cek', note: 'Çek 123456', due_on: VADE});
  assert.ok(cek.id, 'çek hesapsız kaydedilebilmeli: para vade gününde çıkacak');
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 0, 'para henüz çıkmadığı için kasa hareketi olmamalı');
  assert.equal(sayi(f, 'SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries'), 0, 'borç kapanmış olmalı');
 } finally {f.close();}
});

// KURAL DEĞİŞTİ: kart artık vadeli sayılmıyor. Kart ödemesi fiilen ödeme günü kasadan düşülüyor
// (canlıdaki dört kart ödemesinin dördü de Ana Kasa'ya yazılmış); hesabı isteğe bağlı bırakmak
// kasasız kart ödemeleri doğurmuştu. Artık hesapsız kart ödemesi reddedilir, hesaplısı kasadan düşer.
test('Kart ödemesi hesapsız reddedilir; hesap seçilince para kasadan düşer', async () => {
 const {f, supplier, kasa, fatura} = await seed(); try {
  await fatura('F-7', 1000, 0);
  const hesapsiz = await f.req('/ec/ledger/payments', {party_id: supplier.id, amount: 600, occurred_on: TARIH, method: 'kart', note: 'Garanti Bonus kart'});
  assert.equal(hesapsiz.status, 400, 'kart ödemesi hesapsız kabul edilmemeli');
  assert.match(hesapsiz.data.error, /kasa|banka/i, 'uyarı Türkçe ve hesabı istemeli: ' + hesapsiz.data.error);
  assert.match(hesapsiz.data.error, /Kart/, 'uyarı hangi yöntemi anlattığını söylemeli: ' + hesapsiz.data.error);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_party_entries WHERE amount_cents>0'), 0, 'reddedilen ödeme kayıt bırakmamalı');
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_party_payment_methods'), 0);
  assert.equal(sayi(f, 'SELECT COUNT(*) n FROM ec_cash_transactions'), 0);

  const kart = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 600, occurred_on: TARIH, method: 'kart', note: 'Garanti Bonus kart', account_id: kasa.id});
  assert.equal(f.sqlite.prepare('SELECT amount_cents n FROM ec_cash_transactions WHERE party_entry_id=?').get(kart.id).n, -60000, 'kart ödemesinde de para kasadan çıkmalı');
  assert.equal((await f.ok('/ec/ledger')).accounts.find(a => a.id === kasa.id).balance_cents, -60000, 'kasa bakiyesi kart ödemesi kadar düşmeli');
  assert.equal(sayi(f, 'SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries'), -40000, 'kalan borç açık kalmalı');
 } finally {f.close();}
});
