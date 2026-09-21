import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// Alış faturası cari borcu oluşturur; ödeme banka hesabı seçmeye zorlamadan girilir.
// Nakit, kart, havale ve çek ayrı ayrı kaydedilir; çek vadesiyle beklemeye alınır.
// Ödeme ile kapama tek yazma kümesindedir: ya ikisi birden yazılır ya hiçbiri.

const TARIH = '2026-09-09';

async function seed() {
 const f = appFixture(); await f.setup();
 const supplier = await f.ok('/ec/suppliers', {name: 'Torf Tedarikçisi', tax_id: '1234567890', contact: ''});
 const other = await f.ok('/ec/suppliers', {name: 'Ambalaj Tedarikçisi', tax_id: '1234567891', contact: ''});
 const product = (await f.ok('/ec/products', {name: 'Torf', sku: 'T-1', stock_unit: 'adet', min_stock: 0})).id;
 const taslak = async (no, net, tax = 0, party = supplier.id, date = TARIH) => (await f.ok('/ec/invoices', {
  supplier_id: party, invoice_no: no, invoice_date: date, currency: 'TRY',
  lines: [{description: 'Torf', external_code: 'T', invoice_quantity: 1, invoice_unit: 'adet', product_id: product, stock_quantity: 1, net, tax}]
 })).id;
 const fatura = async (...args) => {const id = await taslak(...args); await f.ok('/ec/invoices/' + id + '/post', {}); return id;};
 return {f, supplier, other, product, taslak, fatura};
}

const borc = (f, invoiceId) => f.sqlite.prepare('SELECT * FROM ec_party_entries WHERE source_key=?').get('invoice:' + invoiceId) || null;
const acik = (data, invoiceId) => (data.open_invoices || []).find(x => x.invoice_id === invoiceId) || null;

test('Muhasebeleşen alış faturası tam olarak bir kez cari borcu yazar; tamamlama işlemi mükerrer yazmaz', async () => {
 const {f, supplier, taslak, fatura} = await seed(); try {
  const invoice = await fatura('F-1', 1000, 200);
  const entry = borc(f, invoice);
  assert.ok(entry, 'muhasebeleşen fatura cari borcu oluşturmalı');
  assert.equal(entry.amount_cents, -120000, 'borç KDV dahil ve eksi işaretli olmalı');
  assert.equal(entry.occurred_on, TARIH, 'borcun tarihi fatura tarihi olmalı');
  assert.equal(entry.reference, 'F-1', 'referans fatura numarası olmalı');
  assert.match(entry.description, /Torf Tedarikçisi/, 'açıklama tedarikçiyi anmalı');
  assert.match(entry.description, /F-1/, 'açıklama fatura numarasını anmalı');
  assert.equal(entry.source, 'invoice');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_party_entries WHERE source='invoice'").get().n, 1, 'tek borç satırı olmalı');

  // Ikinci kez muhasebeleştirme reddedilir ve ikinci borç yazmaz.
  const tekrar = await f.req('/ec/invoices/' + invoice + '/post', {});
  assert.equal(tekrar.status, 409, 'muhasebeleşmiş fatura ikinci kez işlenmemeli');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_party_entries WHERE source='invoice'").get().n, 1);

  // Eski (canlıdaki gibi borcu yazılmamış) fatura: toplu tamamlama borcu oluşturur, ikinci çağrıda bir şey yapmaz.
  const eski = await fatura('F-2', 500, 100);
  f.sqlite.exec("DELETE FROM ec_payment_allocations WHERE positive_entry_id IN (SELECT id FROM ec_party_entries WHERE source_key='invoice:" + eski + "')");
  f.sqlite.exec('DROP TRIGGER IF EXISTS ec_party_entries_immutable_delete');
  f.sqlite.exec("DELETE FROM ec_party_entries WHERE source_key='invoice:" + eski + "'");
  assert.equal(borc(f, eski), null, 'test hazırlığı: borç silinmiş olmalı');

  const taslakKalan = await taslak('F-3', 900, 0);
  const ilk = await f.ok('/ec/ledger/invoice-debts', {});
  assert.equal(ilk.created, 1, 'yalnızca eksik olan fatura için borç yazılmalı');
  assert.equal(borc(f, eski).amount_cents, -60000);
  assert.equal(borc(f, taslakKalan), null, 'taslak fatura borç yazmamalı');

  const ikinci = await f.ok('/ec/ledger/invoice-debts', {});
  assert.equal(ikinci.created, 0, 'tekrar çalıştırmak yeni borç yazmamalı');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_party_entries WHERE source='invoice'").get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(supplier.id).n, -180000);
 } finally {f.close();}
});

test('Kısmi ödeme kalanı açık bırakır; banka hesabı seçmek zorunlu değildir', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-10', 1000, 200);
  const odeme = await f.ok('/ec/ledger/payments', {
   party_id: supplier.id, amount: 500, occurred_on: TARIH, method: 'nakit', note: 'Kasadan elden verdim'
  });
  assert.ok(odeme.id, 'ödeme kaydı oluşmalı');
  assert.equal(odeme.allocated_cents, 50000, 'ödeme açık borca yazılmalı');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n, 0, 'hesap seçilmediyse kasa hareketi yazılmamalı');
  const detay = f.sqlite.prepare('SELECT * FROM ec_party_payment_methods WHERE entry_id=?').get(odeme.id);
  assert.equal(detay.method, 'nakit');
  assert.equal(detay.note, 'Kasadan elden verdim');

  const data = await f.ok('/ec/ledger');
  const row = acik(data, invoice);
  assert.ok(row, 'açık fatura listelenmeli');
  assert.equal(row.debt_cents, 120000);
  assert.equal(row.paid_cents, 50000);
  assert.equal(row.remaining_cents, 70000);
  assert.equal(row.status, 'partial');
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(supplier.id).n, -70000);

  const kalan = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 700, occurred_on: TARIH, method: 'havale', note: 'Ziraat'});
  assert.equal(kalan.allocated_cents, 70000);
  assert.equal(acik(await f.ok('/ec/ledger'), invoice), null, 'tamamen ödenen fatura açık listede kalmamalı');
 } finally {f.close();}
});

test('Seçilen faturalar tek ödemeyle kapanır; seçilmeyen fatura açık kalır ve çift tıklama ikinci ödeme yazmaz', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const bir = await fatura('F-20', 100, 0), iki = await fatura('F-21', 200, 0), uc = await fatura('F-22', 300, 0);
  const govde = {party_id: supplier.id, amount: 300, occurred_on: TARIH, method: 'kart', note: 'Garanti Bonus kart', invoice_ids: [bir, iki]};
  const ilk = await f.ok('/ec/ledger/payments', govde);
  assert.equal(ilk.allocated_cents, 30000);
  assert.deepEqual([...ilk.closed_invoice_ids].sort(), [bir, iki].sort());

  const tekrar = await f.ok('/ec/ledger/payments', govde);
  assert.equal(tekrar.existing, true, 'aynı ödeme ikinci kez yazılmamalı');
  assert.equal(tekrar.id, ilk.id);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_party_payment_methods").get().n, 1, 'tek ödeme kaydı kalmalı');
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=? AND amount_cents>0').get(supplier.id).n, 30000);

  const data = await f.ok('/ec/ledger');
  assert.equal(acik(data, bir), null, 'ödenen fatura açık kalmamalı');
  assert.equal(acik(data, iki), null, 'ödenen fatura açık kalmamalı');
  assert.equal(acik(data, uc).remaining_cents, 30000, 'seçilmeyen fatura açık kalmalı');
 } finally {f.close();}
});

test('Açık borcu aşan ödeme Türkçe uyarıyla reddedilir ve hiçbir kayıt bırakmaz', async () => {
 const {f, supplier, other, fatura} = await seed(); try {
  const invoice = await fatura('F-30', 100, 0);
  const fazla = await f.req('/ec/ledger/payments', {party_id: supplier.id, amount: 150, occurred_on: TARIH, method: 'nakit', note: ''});
  assert.ok(fazla.status >= 400, 'fazla ödeme kabul edilmemeli, gelen ' + fazla.status);
  assert.match(fazla.data.error, /borc/i, 'uyarı Türkçe ve borçtan bahsetmeli: ' + fazla.data.error);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries WHERE amount_cents>0').get().n, 0, 'reddedilen ödeme kayıt bırakmamalı');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_payment_methods').get().n, 0);

  const secili = await f.req('/ec/ledger/payments', {party_id: supplier.id, amount: 120, occurred_on: TARIH, method: 'nakit', note: '', invoice_ids: [invoice]});
  assert.ok(secili.status >= 400, 'seçili faturanın kalanını aşan ödeme reddedilmeli');

  const bos = await f.req('/ec/ledger/payments', {party_id: other.id, amount: 10, occurred_on: TARIH, method: 'nakit', note: ''});
  assert.ok(bos.status >= 400, 'açık borcu olmayan cariye ödeme yazılmamalı');
 } finally {f.close();}
});

test('Çek vadesiz kaydedilemez; kaydedilen çek borcu kapatır ve vadesiyle ayrı listelenir', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-40', 1000, 0);
  const vadesiz = await f.req('/ec/ledger/payments', {party_id: supplier.id, amount: 1000, occurred_on: TARIH, method: 'cek', note: 'Ziraat çeki'});
  assert.ok(vadesiz.status >= 400, 'vadesiz çek kabul edilmemeli');
  assert.match(vadesiz.data.error, /vade/i, 'uyarı vadeyi istemeli: ' + vadesiz.data.error);

  const cek = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 1000, occurred_on: TARIH, method: 'cek', note: 'Ziraat çeki 123456', due_on: '2026-10-31'});
  const data = await f.ok('/ec/ledger');
  assert.equal(acik(data, invoice), null, 'çek verilen fatura kapanmalı');
  const liste = data.cheques || [];
  assert.equal(liste.length, 1, 'verilen çek ayrı listelenmeli');
  assert.equal(liste[0].entry_id, cek.id);
  assert.equal(liste[0].due_on, '2026-10-31');
  assert.equal(liste[0].amount_cents, 100000);
  assert.equal(liste[0].party_name, 'Torf Tedarikçisi');
  assert.equal(liste[0].note, 'Ziraat çeki 123456');
 } finally {f.close();}
});

test('Ödeme yapmadan planlanan ödeme tarihi işaretlenir ve vadesi gelen listesine düşer', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-50', 400, 0);
  const plan = await f.ok('/ec/ledger/plans', {invoice_id: invoice, planned_on: '2026-09-30', note: 'Ay sonunda ödeyeceğim'});
  assert.ok(plan.id);

  const data = await f.ok('/ec/ledger');
  const row = acik(data, invoice);
  assert.equal(row.planned_on, '2026-09-30', 'planlanan tarih açık faturada görünmeli');
  assert.equal(row.remaining_cents, 40000, 'plan borcu kapatmamalı');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries WHERE amount_cents>0').get().n, 0, 'plan para hareketi yazmamalı');
  assert.ok((data.due_soon || []).some(x => x.entry_id === row.entry_id && x.due_on === '2026-09-30'), 'vadesi gelen listesinde olmalı');

  // Tarih değiştirilebilir; eski kayıt silinmez.
  await f.ok('/ec/ledger/plans', {invoice_id: invoice, planned_on: '2026-10-15', note: 'Ertelendi'});
  assert.equal(acik(await f.ok('/ec/ledger'), invoice).planned_on, '2026-10-15');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entry_plans').get().n, 2, 'plan geçmişi korunmalı');
 } finally {f.close();}
});

test('Ödeme geri alındığında fatura yeniden açık duruma döner', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-60', 250, 0);
  const odeme = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 250, occurred_on: TARIH, method: 'havale', note: 'Yanlış cariye'});
  assert.equal(acik(await f.ok('/ec/ledger'), invoice), null);

  const kapama = f.sqlite.prepare('SELECT id FROM ec_payment_allocations WHERE positive_entry_id=?').get(odeme.id);
  await f.ok('/ec/ledger/reverse', {allocation_id: kapama.id, reason: 'Yanlış fatura kapatıldı'});
  await f.ok('/ec/ledger/reverse', {entry_id: odeme.id, reason: 'Ödeme yanlış girildi', occurred_on: TARIH, reference: 'DUZELTME-1'});

  const data = await f.ok('/ec/ledger');
  assert.equal(acik(data, invoice).remaining_cents, 25000, 'ödeme geri alınınca fatura yeniden açılmalı');
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(supplier.id).n, -25000);
  assert.throws(() => f.sqlite.exec('DELETE FROM ec_party_entries'), /IMMUTABLE_LEDGER/);
  assert.throws(() => f.sqlite.exec("UPDATE ec_party_payment_methods SET method='nakit'"), /IMMUTABLE_LEDGER/);
 } finally {f.close();}
});

test('Kasa/banka hesabı seçilen ödeme aynı yazma kümesinde kasa hareketini de oluşturur', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-70', 300, 0);
  const hesap = await f.ok('/ec/ledger/accounts', {name: 'İşletme bankası', kind: 'bank'});
  const odeme = await f.ok('/ec/ledger/payments', {
   party_id: supplier.id, amount: 300, occurred_on: TARIH, method: 'havale', note: 'Ziraat EFT', account_id: hesap.id
  });
  const hareket = f.sqlite.prepare('SELECT * FROM ec_cash_transactions WHERE party_entry_id=?').get(odeme.id);
  assert.ok(hareket, 'hesap seçildiyse kasa hareketi yazılmalı');
  assert.equal(hareket.amount_cents, -30000, 'ödeme hesaptan çıkış olmalı');
  assert.equal(hareket.account_id, hesap.id);
  const data = await f.ok('/ec/ledger');
  assert.equal(data.accounts.find(a => a.id === hesap.id).balance_cents, -30000);
  assert.equal(acik(data, invoice), null);
 } finally {f.close();}
});

test('Cari yetkisi olmayan personel ödeme giremez; tutar yetkisi kapalıysa tutarlar gizlenir', async () => {
 const {f, supplier, fatura} = await seed(); try {
  await fatura('F-80', 100, 0);
  const faturaci = await f.ok('/admin/users', {name: 'Fatura', username: 'faturaci', permissions: {ec: {invoices: 'write', amounts: 'write'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: faturaci.invite_path.split('invite=')[1], password: 'fatura-personel-sifresi'});
  const faturaciCookie = (await f.req('/auth/login', {username: 'faturaci', password: 'fatura-personel-sifresi'})).cookie;
  for (const yol of ['/ec/ledger/payments', '/ec/ledger/invoice-debts', '/ec/ledger/plans']) {
   const red = await f.req(yol, {party_id: supplier.id, amount: 1, occurred_on: TARIH, method: 'nakit'}, faturaciCookie);
   assert.equal(red.status, 403, yol + ' cari yetkisi olmadan açık olmamalı');
  }

  const muhasebe = await f.ok('/admin/users', {name: 'Muhasebe', username: 'muhasebe', permissions: {ec: {ledger: 'write', amounts: 'none'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: muhasebe.invite_path.split('invite=')[1], password: 'muhasebe-personel-sifresi'});
  const muhasebeCookie = (await f.req('/auth/login', {username: 'muhasebe', password: 'muhasebe-personel-sifresi'})).cookie;
  const gorunum = await f.req('/ec/ledger', undefined, muhasebeCookie);
  assert.equal(gorunum.status, 200, 'cari yetkisi olan personel ekranı görmeli');
  for (const row of gorunum.data.open_invoices || []) {
   assert.equal(row.remaining_cents, null, 'tutar yetkisi kapalıysa kalan tutar gizlenmeli');
   assert.equal(row.debt_cents, null, 'tutar yetkisi kapalıysa borç gizlenmeli');
  }
 } finally {f.close();}
});

test('Alış faturası listesi ödeme durumunu ve planlanan tarihi taşır', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const odenen = await fatura('F-90', 100, 0), kismi = await fatura('F-91', 200, 0), acikFatura = await fatura('F-92', 300, 0);
  await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 100, occurred_on: TARIH, method: 'nakit', note: '', invoice_ids: [odenen]});
  await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 50, occurred_on: TARIH, method: 'kart', note: 'Bonus', invoice_ids: [kismi]});
  await f.ok('/ec/ledger/plans', {invoice_id: acikFatura, planned_on: '2026-09-30', note: 'Ay sonu'});

  const liste = await f.ok('/ec/purchases?status=posted');
  const bul = id => liste.invoices.find(x => x.id === id);
  assert.equal(bul(odenen).paid_cents, 10000);
  assert.equal(bul(odenen).debt_cents, 10000);
  assert.equal(bul(kismi).paid_cents, 5000);
  assert.equal(bul(kismi).debt_cents, 20000);
  assert.equal(bul(acikFatura).paid_cents, 0);
  assert.equal(bul(acikFatura).planned_on, '2026-09-30');
 } finally {f.close();}
});

test('Cari ekranının okuduğu alanlar yanıtta birebir bulunur', async () => {
 const {f, supplier, fatura} = await seed(); try {
  const invoice = await fatura('F-95', 500, 0);
  await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 100, occurred_on: TARIH, method: 'kart', note: 'Bonus'});
  await f.ok('/ec/ledger/plans', {invoice_id: invoice, planned_on: '2026-09-30', note: 'Ay sonu'});
  const cekFatura = await fatura('F-96', 200, 0);
  await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 200, occurred_on: TARIH, method: 'cek', note: 'Çek 1', due_on: '2026-12-31', invoice_ids: [cekFatura]});

  const data = await f.ok('/ec/ledger');
  const row = acik(data, invoice);
  for (const key of ['entry_id','invoice_id','invoice_no','party_id','party_name','occurred_on','debt_cents','paid_cents','remaining_cents','planned_on','status']) assert.ok(key in row, 'açık faturada eksik alan: ' + key);
  for (const key of ['entry_id','party_id','party_name','amount_cents','occurred_on','due_on','note']) assert.ok(key in data.cheques[0], 'çekte eksik alan: ' + key);
  for (const key of ['kind','entry_id','party_id','party_name','reference','due_on','overdue','amount_cents']) assert.ok(key in data.due_soon[0], 'vade satırında eksik alan: ' + key);
  assert.deepEqual(data.payment_methods.map(m => m.key), ['nakit','kart','havale','cek']);
  const hareket = data.entries.find(e => e.payment_method === 'kart');
  assert.equal(hareket.payment_note, 'Bonus');
  assert.equal(data.entries.find(e => e.id === row.entry_id).planned_on, '2026-09-30');
  const liste = await f.ok('/ec/purchases?status=posted');
  for (const key of ['debt_cents','paid_cents','planned_on']) assert.ok(key in liste.invoices[0], 'fatura listesinde eksik alan: ' + key);
 } finally {f.close();}
});

test('Üretim alanında da aynı ödeme akışı çalışır ve alanlar birbirine karışmaz', async () => {
 const f = appFixture(); await f.setup(); try {
  const supplier = await f.ok('/lp/suppliers', {name: 'Reçine Tedarikçisi', tax_id: '2234567890', contact: ''});
  f.sqlite.exec("INSERT INTO products(id,name,sku) VALUES('lp-odeme','Mamul','LP-ODEME')");
  const invoice = (await f.ok('/lp/invoices', {
   supplier_id: supplier.id, invoice_no: 'LP-1', invoice_date: TARIH, currency: 'TRY',
   lines: [{description: 'Reçine', external_code: 'R', invoice_quantity: 1, invoice_unit: 'kg', product_id: 'lp-odeme', stock_quantity: 1, net: 400, tax: 80}]
  })).id;
  await f.ok('/lp/invoices/' + invoice + '/post', {});
  assert.equal(f.sqlite.prepare('SELECT amount_cents n FROM lp_party_entries WHERE source_key=?').get('invoice:' + invoice).n, -48000);

  const odeme = await f.ok('/lp/ledger/payments', {party_id: supplier.id, amount: 480, occurred_on: TARIH, method: 'cek', note: 'Vadeli çek', due_on: '2026-11-30'});
  assert.equal(f.sqlite.prepare('SELECT method FROM lp_party_payment_methods WHERE entry_id=?').get(odeme.id).method, 'cek');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_payment_methods').get().n, 0, 'alanlar birbirine karışmamalı');
  assert.equal((await f.ok('/lp/ledger')).cheques.length, 1);
  assert.equal((await f.ok('/ec/ledger')).cheques.length, 0);
 } finally {f.close();}
});
