// HAKEDİŞ–BANKA EŞLEŞTİRME. TEMSİLİ veri: gerçek Trendyol ödeme emri veya banka dosyası DEĞİLDİR.
//
// Kanıtlanan:
//  (a) Aday motoru hiçbir şey yazmaz (salt okunur).
//  (b) Onay parayı pazaryeri alacak hesabına ve oradan gerçek bankaya yazar; ANA KASA etkilenmez.
//  (c) Aynı banka satırı iki kez eşleşemez; aynı ödeme emri iki satıra yazılamaz.
//  (d) Belirsiz aday (aynı tutarlı birden çok ödeme emri) otomatik yazılmaz; öneri verilmez.
//  (e) Geri alma bakiyeyi başa döndürür, ham ekstre satırını SİLMEZ.
//  (f) Yetkisiz kullanıcı ne okuyabilir ne yazabilir.
//  (g) Hiç ekstre yokken uçlar boş ve anlaşılır yanıt verir.
//  (h) Kuruş farkı: deftere BANKA tutarı yazılır; fark açık onayla geçer, büyük fark reddedilir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {permit} from '../src/permission-policy.js';
import {parsePermissions} from '../public/permissions.js';

const HASH = a => String(a).repeat(64).slice(0, 64);
const GUN = '2026-09-10';

const personel = ec => ({owner: false, name: 'P', ec_access: Object.values(ec).includes('write') ? 'write' : 'read',
  lp_access: 'none', permissions: parsePermissions({ec, lp: {}})});

// Kaynak kutusu kaydı: src/connections-api.js finans normalizasyonunun ürettiği alanlar.
// credit/debt TL cinsinden ondalıklı sayıdır (kuruş değil) — motor kuruşa kendisi çevirir.
function odemeEmri(f, {external_id, payment_order_id, credit = 0, debt = 0, at = GUN + 'T09:00:00.000Z', provider = 'trendyol', seller = 'S1'}) {
  const payload = {external_id, reference: 'R-' + external_id, order_no: '', barcode: '', type: 'PaymentOrder',
    credit, debt, commission: null, seller_revenue: null, payment_order_id, source_updated_at: at,
    currency: 'TRY', interpretation: 'source_financial_record'};
  f.sqlite.prepare('INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), provider, seller, 'payments', external_id, 'fp-' + external_id + '-' + credit + '-' + debt, JSON.stringify(payload), at);
}

async function ekstre(f, satirlar, {ad = 'QNB TL', dosya = 'a'} = {}) {
  const hesap = await f.ok('/ec/bank/accounts', {name: ad, kind: 'bank'});
  const file = await f.ok('/ec/bank/files', {account_id: hesap.id, filename: 'ekstre.csv', sha256: HASH(dosya), size_bytes: 4096});
  await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: satirlar});
  await f.ok('/ec/bank/files/' + file.id + '/seal', {});
  return hesap;
}
const satir = (over = {}) => ({occurred_on: GUN, amount_cents: 251623, description: 'TRENDYOL ODEME',
  reference: 'DEK-1', counterparty: 'Trendyol', balance_cents: 1000000, ...over});

const bakiye = (f, ad) => f.sqlite.prepare(
  'SELECT COALESCE((SELECT SUM(t.amount_cents) FROM ec_cash_transactions t WHERE t.account_id=a.id),0) b FROM ec_cash_accounts a WHERE a.name=?').get(ad)?.b ?? null;
const sayac = f => ({
  cash: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n,
  accounts: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_accounts').get().n,
  matches: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bank_matches').get().n,
  entries: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n,
  lines: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bank_lines').get().n
});

test('(a) aday motoru salt okunurdur: tek satır bile yazmaz, tam eşleşmeyi önerir', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const once = sayac(f);
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.deepEqual(sayac(f), once, 'aday motoru hiçbir şey yazmamalı');
    assert.equal(aday.writes, false);
    assert.equal(aday.lines.length, 1);
    assert.equal(aday.lines[0].status, 'exact');
    assert.equal(aday.lines[0].suggestion.payment_order_id, 'PO-1');
    assert.equal(aday.lines[0].suggestion.net_cents, 251623);
    assert.equal(aday.lines[0].candidates.length, 1);
  } finally { f.close(); }
});

test('(a2) aynı ödeme emrinin satırları tek transfer olarak toplanır; borç düşülür', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir({amount_cents: 300000})]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2000});
    odemeEmri(f, {external_id: 'T2', payment_order_id: 'PO-1', credit: 1100});
    odemeEmri(f, {external_id: 'T3', payment_order_id: 'PO-1', debt: 100});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines[0].status, 'exact');
    assert.equal(aday.lines[0].suggestion.net_cents, 300000, '2000 + 1100 − 100 = 3000,00 TL');
    assert.equal(aday.lines[0].suggestion.record_count, 3);
  } finally { f.close(); }
});

test('(b) onay parayı alacak hesabına ve gerçek bankaya yazar; ANA KASA etkilenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    await f.ok('/ec/ledger/accounts', {name: 'Ana Kasa', kind: 'cash'});
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const onay = await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id,
      provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});

    assert.equal(onay.matched_cents, 251623);
    assert.equal(onay.difference_cents, 0);
    assert.equal(bakiye(f, 'Ana Kasa'), 0, 'Ana Kasa hiç etkilenmemeli');
    assert.equal(bakiye(f, 'QNB TL'), 251623, 'para gerçek banka hesabına girdi');
    assert.equal(bakiye(f, 'Trendyol Alacağı'), 0, 'alacak hesabı kapandı: açıklanmamış para yok');
    // Üç kasa hareketi: alacağa giriş, alacaktan virman çıkışı, bankaya virman girişi.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n, 3);
    // Cari defteri hiç kıpırdamadı: bu bir cari ödemesi değil.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions WHERE party_entry_id IS NOT NULL').get().n, 0);
    // Alacak hesabı yeni bir kind değeri değil: kind='bank', role='marketplace_clearing'.
    const alacak = f.sqlite.prepare("SELECT kind,role,provider FROM ec_cash_accounts WHERE name='Trendyol Alacağı'").get();
    assert.deepEqual({...alacak}, {kind: 'bank', role: 'marketplace_clearing', provider: 'trendyol'});
    // Ham ekstre satırındaki ölü kolon yazılmadı.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bank_lines WHERE matched_party_id IS NOT NULL').get().n, 0);
  } finally { f.close(); }
});

test('(b2) alacak hesabı sessizce açılmaz: açık onay istenir', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const red = await f.req('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol', payment_order_id: 'PO-1'});
    assert.equal(red.status, 409);
    assert.equal(red.data.code, 'clearing_account_missing');
    assert.equal(red.data.suggested_name, 'Trendyol Alacağı');
    assert.equal(sayac(f).cash, 0, 'onay istenirken hiçbir şey yazılmadı');
  } finally { f.close(); }
});

test('(c) aynı banka satırı iki kez eşleşemez; aynı ödeme emri iki satıra yazılamaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir(), satir({reference: 'DEK-2', balance_cents: 1251623})]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const ilk = aday.lines[0].bank_line_id, ikinci = aday.lines[1].bank_line_id;
    await f.ok('/ec/bank/matches', {bank_line_id: ilk, provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});

    const tekrar = await f.req('/ec/bank/matches', {bank_line_id: ilk, provider: 'trendyol', payment_order_id: 'PO-1'});
    assert.equal(tekrar.status, 409, 'aynı ekstre satırı ikinci kez eşleşemez');
    const baskaSatir = await f.req('/ec/bank/matches', {bank_line_id: ikinci, provider: 'trendyol', payment_order_id: 'PO-1'});
    assert.equal(baskaSatir.status, 409, 'aynı ödeme emri ikinci banka satırına yazılamaz');
    assert.equal(bakiye(f, 'QNB TL'), 251623, 'para bir kez girdi');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_bank_matches WHERE status='confirmed'").get().n, 1);

    // Eşleşen satır ve ödeme emri aday listesinden düşer.
    const sonra = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(sonra.lines.length, 1);
    assert.equal(sonra.lines[0].bank_line_id, ikinci);
    assert.equal(sonra.lines[0].status, 'unmatched', 'kullanılmış ödeme emri yeniden önerilmez');
  } finally { f.close(); }
});

test('(d) aynı tutarlı iki ödeme emri belirsizdir: öneri verilmez, otomatik yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    odemeEmri(f, {external_id: 'T2', payment_order_id: 'PO-2', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines[0].status, 'ambiguous');
    assert.equal(aday.lines[0].suggestion, null, 'belirsizde öneri yok');
    assert.equal(aday.lines[0].candidates.length, 2, 'iki aday da gösterilir; seçimi kullanıcı yapar');
    assert.equal(sayac(f).cash, 0);
    // Kullanıcı açıkça seçerse yazılır; motor kendiliğinden seçmez.
    const onay = await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id,
      provider: 'trendyol', payment_order_id: 'PO-2', create_clearing_account: true});
    assert.equal(onay.payment_order_id, 'PO-2');
  } finally { f.close(); }
});

test('(d2) tarih penceresi dışındaki ödeme emri aday değildir', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23, at: '2026-08-01T09:00:00.000Z'});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines[0].status, 'unmatched');
    assert.equal(aday.lines[0].candidates.length, 0);
    const red = await f.req('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id,
      provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});
    assert.equal(red.status, 409, 'pencere dışı ödeme emri elle de yazılamaz');
  } finally { f.close(); }
});

test('(e) geri alma bakiyeyi başa döndürür; ham ekstre satırı silinmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const onay = await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id,
      provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});
    assert.equal(bakiye(f, 'QNB TL'), 251623);

    const geri = await f.ok('/ec/bank/matches/' + onay.id + '/reverse', {reason: 'Banka satırı başka bir ödemeye aitmiş.'});
    assert.equal(geri.status, 'reversed');
    assert.equal(bakiye(f, 'QNB TL'), 0, 'banka bakiyesi başa döndü');
    assert.equal(bakiye(f, 'Trendyol Alacağı'), 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bank_lines').get().n, 1, 'ham ekstre satırı silinmedi');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n, 6, 'ters kayıtlar eklendi, aslı silinmedi');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions WHERE reversal_of IS NOT NULL').get().n, 3);

    const iki = await f.req('/ec/bank/matches/' + onay.id + '/reverse', {reason: 'tekrar'});
    assert.equal(iki.status, 409, 'aynı eşleştirme iki kez geri alınamaz');

    // Geri alındıktan sonra aynı satır yeniden eşleşebilir.
    const yeniden = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(yeniden.lines[0].status, 'exact');
    await f.ok('/ec/bank/matches', {bank_line_id: yeniden.lines[0].bank_line_id, provider: 'trendyol', payment_order_id: 'PO-1'});
    assert.equal(bakiye(f, 'QNB TL'), 251623);
  } finally { f.close(); }
});

test('(f) yetkisiz kullanıcı hakediş eşleştirmesini ne okur ne yazar', () => {
  const gecer = (u, p, m = 'GET') => assert.doesNotThrow(() => permit(u, p, m), p + ' ' + m);
  const kapali = (u, p, m = 'GET') => assert.throws(() => permit(u, p, m), e => e.status === 403, p + ' ' + m);
  const yazan = personel({ledger: 'write'}), okuyan = personel({ledger: 'read'}), ilgisiz = personel({stock: 'write'});
  gecer(yazan, '/api/ec/bank/matches/candidates'); gecer(yazan, '/api/ec/bank/matches', 'POST');
  gecer(okuyan, '/api/ec/bank/matches/candidates');
  kapali(okuyan, '/api/ec/bank/matches', 'POST');                       // okuma yazmaya dönüşmez
  kapali(okuyan, '/api/ec/bank/matches/abc/reverse', 'POST');
  kapali(ilgisiz, '/api/ec/bank/matches/candidates');
  kapali(ilgisiz, '/api/ec/bank/matches', 'POST');
  kapali({...yazan, ec_access: 'none'}, '/api/ec/bank/matches/candidates');
  kapali(yazan, '/api/lp/bank/matches/candidates');                     // banka yalnız e-ticarette
  gecer({owner: true}, '/api/ec/bank/matches', 'POST');
});

test('(f2) yetkisiz istek gerçek yolda da 403 alır ve hiçbir şey yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const line = aday.lines[0].bank_line_id;
    const davet = await f.ok('/admin/users', {name: 'Depocu', username: 'depocu',
      permissions: {ec: {stock: 'write'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: davet.invite_path.split('invite=')[1], password: 'synthetic-staff-password'});
    const giris = await f.req('/auth/login', {username: 'depocu', password: 'synthetic-staff-password'});
    assert.equal(giris.status, 200, JSON.stringify(giris));
    const once = sayac(f);
    // Aynı istek yönetici olarak geçerdi; fark yalnızca yetkidir.
    const r = await f.req('/ec/bank/matches', {bank_line_id: line, provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true}, giris.cookie);
    assert.equal(r.status, 403);
    assert.deepEqual(sayac(f), once, 'yetkisiz istek hiçbir şey yazmadı');
  } finally { f.close(); }
});

test('(g) hiç ekstre yokken ekran ve uçlar boş ama anlaşılır yanıt verir', async () => {
  const f = appFixture(); await f.setup(); try {
    const bos = await f.ok('/ec/bank/matches/candidates');
    assert.deepEqual(bos.lines, []);
    assert.deepEqual(bos.accounts, []);
    assert.equal(bos.clearing_account, null);
    assert.equal(bos.writes, false);
    assert.ok(bos.notice);
    const liste = await f.ok('/ec/bank/matches');
    assert.deepEqual(liste.matches, []);
    assert.deepEqual(liste.clearing_accounts, []);
    assert.equal(liste.unexplained_cents, 0);
    // Ekstresi olmayan hesap seçilirse de boş ve hatasız.
    const hesap = await f.ok('/ec/bank/accounts', {name: 'QNB TL', kind: 'bank'});
    const tek = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.deepEqual(tek.lines, []);
    assert.equal(tek.payment_orders.total, 0);
    assert.equal(sayac(f).cash, 0);
  } finally { f.close(); }
});

test('(h) kuruş farkı: deftere BANKA tutarı yazılır, fark açık onayla geçer, büyük fark reddedilir', async () => {
  const f = appFixture(); await f.setup(); try {
    // Banka 2516,00 yatırmış; Trendyol 2516,23 bildirmiş → 23 kuruş fark.
    const hesap = await ekstre(f, [satir({amount_cents: 251600})]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines[0].status, 'near', 'kuruş farkı tam eşleşme sayılmaz');
    assert.equal(aday.lines[0].suggestion, null, 'kuruş farklı aday ÖNERİLMEZ');
    // Fark işareti "banka − pazaryeri": eksi değer bankanın daha az yatırdığını söyler.
    assert.equal(aday.lines[0].candidates[0].difference_cents, -23);

    const line = aday.lines[0].bank_line_id;
    const onaysiz = await f.req('/ec/bank/matches', {bank_line_id: line, provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});
    assert.equal(onaysiz.status, 409);
    assert.equal(onaysiz.data.code, 'amount_difference');
    assert.equal(sayac(f).cash, 0);

    const onay = await f.ok('/ec/bank/matches', {bank_line_id: line, provider: 'trendyol', payment_order_id: 'PO-1',
      create_clearing_account: true, accept_difference: true});
    assert.equal(onay.matched_cents, 251600, 'deftere BANKA tutarı yazıldı');
    assert.equal(onay.reported_cents, 251623, 'pazaryerinin bildirdiği tutar kanıt olarak saklandı');
    assert.equal(onay.difference_cents, -23);
    assert.equal(bakiye(f, 'QNB TL'), 251600);
    assert.equal(bakiye(f, 'Trendyol Alacağı'), 0);
  } finally { f.close(); }
});

test('(h2) büyük fark hiçbir onayla geçmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir({amount_cents: 251623})]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 3000});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines[0].status, 'unmatched', '1 TL üstü fark aday bile değildir');
    const red = await f.req('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol',
      payment_order_id: 'PO-1', create_clearing_account: true, accept_difference: true});
    assert.equal(red.status, 409);
    assert.equal(sayac(f).cash, 0);
  } finally { f.close(); }
});

test('(i) para çıkışı, olmayan satır ve olmayan ödeme emri eşleştirilemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir(), satir({reference: 'DEK-X', amount_cents: -45000, description: 'KARGO ODEMESI'})]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    assert.equal(aday.lines.length, 1, 'para çıkışı hakediş adayı değildir');
    const cikis = f.sqlite.prepare('SELECT id FROM ec_bank_lines WHERE amount_cents<0').get().id;
    const red = await f.req('/ec/bank/matches', {bank_line_id: cikis, provider: 'trendyol', payment_order_id: 'PO-1', create_clearing_account: true});
    assert.equal(red.status, 409);
    const yok = await f.req('/ec/bank/matches', {bank_line_id: 'olmayan-satir', provider: 'trendyol', payment_order_id: 'PO-1'});
    assert.equal(yok.status, 404);
    const emirYok = await f.req('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol', payment_order_id: 'PO-YOK'});
    assert.equal(emirYok.status, 404);
    assert.equal(sayac(f).cash, 0);
  } finally { f.close(); }
});

test('(j) eşleştirme listesi alacak bakiyesini ve açıklanmamış parayı gösterir', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol',
      payment_order_id: 'PO-1', create_clearing_account: true});
    const liste = await f.ok('/ec/bank/matches');
    assert.equal(liste.matches.length, 1);
    assert.equal(liste.matches[0].status, 'confirmed');
    assert.equal(liste.matches[0].account_name, 'QNB TL');
    assert.equal(liste.clearing_accounts.length, 1);
    assert.equal(liste.clearing_accounts[0].balance_cents, 0);
    assert.equal(liste.clearing_accounts[0].in_cents, 251623);
    assert.equal(liste.unexplained_cents, 0);
  } finally { f.close(); }
});

test('(k) eşleştirmenin kasa hareketi cari defterinden tek tek geri alınamaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    const onay = await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol',
      payment_order_id: 'PO-1', create_clearing_account: true});
    const hareket = f.sqlite.prepare('SELECT clearing_in_id FROM ec_bank_matches WHERE id=?').get(onay.id).clearing_in_id;
    const r = await f.req('/ec/ledger/reverse', {cash_transaction_id: hareket, reason: 'yanlış', occurred_on: GUN, reference: 'TERS-1'});
    assert.equal(r.status, 409, 'virman çiftinin tek bacağı ayrı geri alınamaz');
    assert.equal(bakiye(f, 'QNB TL'), 251623);
  } finally { f.close(); }
});

test('(l) pazaryeri alacak hesabına elle kasa hareketi yazılamaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const hesap = await ekstre(f, [satir()]);
    odemeEmri(f, {external_id: 'T1', payment_order_id: 'PO-1', credit: 2516.23});
    const aday = await f.ok('/ec/bank/matches/candidates?account_id=' + hesap.id + '&provider=trendyol');
    await f.ok('/ec/bank/matches', {bank_line_id: aday.lines[0].bank_line_id, provider: 'trendyol',
      payment_order_id: 'PO-1', create_clearing_account: true});
    const alacak = f.sqlite.prepare("SELECT id FROM ec_cash_accounts WHERE role='marketplace_clearing'").get().id;
    const cari = await f.ok('/ec/ledger/parties', {name: 'Tedarikçi A'});
    const r = await f.req('/ec/ledger/cash', {direction: 'payment', amount: 100, account_id: alacak,
      party_id: cari.id, reference: 'ELLE-1', description: 'elle', occurred_on: GUN});
    assert.equal(r.status, 409, 'alacak hesabı elle para hareketine kapalı');
    assert.equal(bakiye(f, 'Trendyol Alacağı'), 0);
  } finally { f.close(); }
});
