import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {sonOdemeMetni, odemeRozeti, odemeAyrintisi, kapatilanFaturalar, borcDurumu, planMetni} from '../public/business-ui.js';
import {statementBlocks, statementCsvRows, statementPrintHtml, settlementNote} from '../public/statement-document.js';

// "Ödediklerimi cari ekranında da görebilmeliyim."
// Ödeme yalnızca "Fatura ödemeleri" sekmesinde değil, cari listesinde, hesap hareketlerinde
// ve mutabakat ekstresinde de görünür: hangi yöntemle ödendi, notu ne, çekse vadesi ne zaman
// ve hangi faturayı ne kadar kapattı. Bu dosya yalnızca GÖRÜNÜMÜ sınar; para yazma yolu değişmez.

const FATURA_TARIHI = '2026-09-09';
const CEK_TARIHI = '2026-09-10';
const NAKIT_TARIHI = '2026-09-11';
const KART_TARIHI = '2026-09-12';

async function seed() {
 const f = appFixture(); await f.setup();
 const supplier = await f.ok('/ec/suppliers', {name: 'Torf Tedarikçisi', tax_id: '1234567890', contact: ''});
 const other = await f.ok('/ec/suppliers', {name: 'Ambalaj Tedarikçisi', tax_id: '1234567891', contact: ''});
 const product = (await f.ok('/ec/products', {name: 'Torf', sku: 'T-1', stock_unit: 'adet', min_stock: 0})).id;
 // Nakit, havale ve kartta para ANINDA çıkar: kasa/banka hesabı zorunludur. Yalnız çek vadelidir;
 // çekte hesap sonradan, para gerçekten çıktığı gün bağlanır.
 const kasa = await f.ok('/ec/ledger/accounts', {name: 'Ana Kasa', kind: 'cash'});
 const fatura = async (no, net, tax = 0, party = supplier.id) => {
  const id = (await f.ok('/ec/invoices', {
   supplier_id: party, invoice_no: no, invoice_date: FATURA_TARIHI, currency: 'TRY',
   lines: [{description: 'Torf', external_code: 'T', invoice_quantity: 1, invoice_unit: 'adet', product_id: product, stock_quantity: 1, net, tax}]
  })).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  return id;
 };
 // Tek ödemeyle kapanan iki fatura, çekle kapanan bir fatura, kısmi ödenen bir fatura
 // ve hiç ödeme görmemiş ikinci cari.
 const bir = await fatura('F-1', 1000, 200);   // 1.200,00 TL
 const iki = await fatura('F-2', 800, 0);      //   800,00 TL
 const cekli = await fatura('F-3', 500, 0);    //   500,00 TL
 const kismi = await fatura('F-4', 1000, 0);   // 1.000,00 TL
 const digerFatura = await fatura('F-9', 300, 0, other.id);

 const cek = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 500, occurred_on: CEK_TARIHI, method: 'cek', note: 'Ziraat çeki 123456', due_on: '2026-10-31', invoice_ids: [cekli]});
 const nakit = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 300, occurred_on: NAKIT_TARIHI, method: 'nakit', note: 'Kasadan elden', invoice_ids: [kismi], account_id: kasa.id});
 const kart = await f.ok('/ec/ledger/payments', {party_id: supplier.id, amount: 2000, occurred_on: KART_TARIHI, method: 'kart', note: 'Garanti Bonus', invoice_ids: [bir, iki], account_id: kasa.id});
 await f.ok('/ec/ledger/plans', {invoice_id: kismi, planned_on: '2026-09-30', note: 'Kalanını ay sonunda öderim'});

 return {f, supplier, other, kasa, bir, iki, cekli, kismi, digerFatura, cek, nakit, kart};
}

const ekstre = (f, party, auth) => f.req('/ec/statement?party_id=' + party + '&from=2026-09-01&to=2026-09-30', undefined, auth);
const satir = (statement, id) => statement.rows.find(r => r.id === id) || null;

test('Tek ödemeyle kapanan iki fatura hem hareket listesinde hem ekstrede numarası ve tutarıyla görünür', async () => {
 const {f, supplier, kart} = await seed(); try {
  const data = await f.ok('/ec/ledger?party_id=' + supplier.id);
  const hareket = data.entries.find(e => e.id === kart.id);
  assert.ok(hareket, 'ödeme cari hareketleri arasında olmalı');
  assert.equal(hareket.payment_method, 'kart', 'ödeme yöntemi hareket satırında olmalı');
  assert.equal(hareket.payment_note, 'Garanti Bonus', 'ödeme notu hareket satırında olmalı');
  assert.ok(Array.isArray(hareket.closed_invoices), 'ödeme satırı kapattığı faturaları taşımalı');
  const kapanan = Object.fromEntries(hareket.closed_invoices.map(x => [x.invoice_no, x.amount_cents]));
  assert.deepEqual(kapanan, {'F-1': 120000, 'F-2': 80000}, 'her faturaya yazılan tutar ayrı görünmeli');

  const {status, data: ext} = await ekstre(f, supplier.id);
  assert.equal(status, 200);
  const ekstreSatir = satir(ext.statement, kart.id);
  assert.ok(ekstreSatir, 'ödeme ekstrede de olmalı');
  assert.equal(ekstreSatir.payment_method, 'kart');
  assert.equal(ekstreSatir.payment_note, 'Garanti Bonus');
  assert.deepEqual(Object.fromEntries(ekstreSatir.closed_invoices.map(x => [x.invoice_no, x.amount_cents])),
   {'F-1': 120000, 'F-2': 80000}, 'ekstre hangi borcun nasıl kapandığını anlatmalı');

  // Ekranda okunan metin: kısa rozet + not + hangi faturayı ne kadar kapattığı.
  assert.equal(odemeRozeti('kart'), 'Kart');
  assert.match(odemeAyrintisi(hareket), /^Kart · Garanti Bonus$/);
  const metin = kapatilanFaturalar(hareket);
  assert.match(metin, /F-1/); assert.match(metin, /1\.200,00/);
  assert.match(metin, /F-2/); assert.match(metin, /800,00/);
 } finally {f.close();}
});

test('Çek hareket listesinde ve ekstrede vadesiyle görünür', async () => {
 const {f, supplier, cek} = await seed(); try {
  const data = await f.ok('/ec/ledger?party_id=' + supplier.id);
  const hareket = data.entries.find(e => e.id === cek.id);
  assert.equal(hareket.payment_method, 'cek');
  assert.equal(hareket.payment_due_on, '2026-10-31', 'çekin vadesi hareket satırında olmalı');
  assert.equal(odemeRozeti('cek'), 'Çek');
  assert.match(odemeAyrintisi(hareket), /vade 31\.10\.2026$/);
  assert.match(odemeAyrintisi(hareket), /^Çek · Ziraat çeki 123456/);

  const {data: ext} = await ekstre(f, supplier.id);
  const ekstreSatir = satir(ext.statement, cek.id);
  assert.equal(ekstreSatir.payment_method, 'cek');
  assert.equal(ekstreSatir.payment_due_on, '2026-10-31', 'ekstrede de çek vadesi yazmalı');
  assert.equal(ekstreSatir.payment_note, 'Ziraat çeki 123456');
  assert.deepEqual(ekstreSatir.closed_invoices.map(x => x.invoice_no), ['F-3']);
 } finally {f.close();}
});

test('Kısmi ödenen fatura ödenen ve kalan tutarıyla, planlanan tarihiyle görünür', async () => {
 const {f, supplier, kismi} = await seed(); try {
  const data = await f.ok('/ec/ledger?party_id=' + supplier.id);
  const borc = data.entries.find(e => e.id === 'invoice:' + kismi);
  assert.ok(borc, 'fatura borcu hareket listesinde olmalı');
  assert.equal(borc.amount_cents, -100000);
  assert.equal(borc.paid_cents, 30000, 'borcun ne kadarının kapandığı satırda olmalı');
  assert.equal(borc.remaining_cents, 70000, 'kalan tutar satırda olmalı');
  assert.equal(borc.planned_on, '2026-09-30');
  assert.equal(planMetni(borc), 'Ödeyeceğim: 30.09.2026');
  const durum = borcDurumu(borc);
  assert.match(durum, /Ödenen/); assert.match(durum, /300,00/);
  assert.match(durum, /kalan/); assert.match(durum, /700,00/);

  const {data: ext} = await ekstre(f, supplier.id);
  const ekstreSatir = satir(ext.statement, 'invoice:' + kismi);
  assert.equal(ekstreSatir.paid_cents, 30000, 'ekstrede de ödenen tutar olmalı');
  assert.equal(ekstreSatir.remaining_cents, 70000, 'ekstrede de kalan tutar olmalı');
  assert.equal(ekstreSatir.planned_on, '2026-09-30', 'planlanan ödeme tarihi ekstrede de olmalı');
 } finally {f.close();}
});

test('Cari listesi toplam borç, ödenen, kalan ve son ödemeyi taşır', async () => {
 const {f, supplier} = await seed(); try {
  const data = await f.ok('/ec/ledger');
  const cari = data.parties.find(p => p.id === supplier.id);
  assert.equal(cari.debt_cents, 350000, 'toplam borç bütün fatura borçlarının toplamı olmalı');
  assert.equal(cari.paid_cents, 280000, 'ödenen, borca yazılan kapama tutarı olmalı');
  assert.equal(cari.remaining_cents, 70000, 'kalan borç toplamdan ödeneni düşmeli');
  assert.ok(cari.last_payment, 'son ödeme cari satırında olmalı');
  assert.equal(cari.last_payment.occurred_on, KART_TARIHI, 'en son yapılan ödeme gösterilmeli');
  assert.equal(cari.last_payment.method, 'kart');
  assert.equal(cari.last_payment.note, 'Garanti Bonus');
  assert.equal(cari.last_payment.amount_cents, 200000);
  assert.equal(sonOdemeMetni(cari), '12.09.2026 · Kart · Garanti Bonus');
 } finally {f.close();}
});

test('Hiç ödeme yapılmamış cari "ödeme yok" der, uydurma 0,00 yazmaz', async () => {
 const {f, other} = await seed(); try {
  const data = await f.ok('/ec/ledger');
  const cari = data.parties.find(p => p.id === other.id);
  assert.equal(cari.debt_cents, 30000, 'borcu olan cari borcunu göstermeli');
  assert.equal(cari.paid_cents, 0, 'hiç kapama yoksa ödenen gerçekten sıfırdır');
  assert.equal(cari.remaining_cents, 30000);
  assert.equal(cari.last_payment, null, 'ödeme yoksa uydurma bir son ödeme kaydı üretilmemeli');
  assert.equal(sonOdemeMetni(cari), 'Ödeme yok');
  assert.doesNotMatch(sonOdemeMetni(cari), /0,00/, 'bilinmeyen tutar sıfır olarak yazılmamalı');
 } finally {f.close();}
});

test('Hesap hareketlerinde yalnızca ödemeleri gösteren hızlı süzgeç vardır', async () => {
 const {f, supplier, cek, nakit, kart} = await seed(); try {
  const hepsi = await f.ok('/ec/ledger?party_id=' + supplier.id);
  assert.ok(hepsi.entries.length > 3, 'süzgeçsiz listede borçlar da olmalı');

  const sadece = await f.ok('/ec/ledger?party_id=' + supplier.id + '&kind=payments');
  assert.deepEqual([...sadece.entries.map(e => e.id)].sort(), [cek.id, nakit.id, kart.id].sort(), 'yalnızca ödeme hareketleri gelmeli');
  assert.ok(sadece.entries.every(e => e.amount_cents > 0), 'süzgeç borç satırı bırakmamalı');
  assert.equal(sadece.entry_filters.kind, 'payments', 'seçilen süzgeç yanıtta bildirilmeli');
  assert.equal(sadece.entry_pagination.total, 3, 'sayfalama süzgece uymalı');
  assert.equal(hepsi.parties.find(p => p.id === supplier.id).remaining_cents,
   sadece.parties.find(p => p.id === supplier.id).remaining_cents, 'süzgeç bakiyeleri değiştirmemeli');

  const gecersiz = await f.req('/ec/ledger?party_id=' + supplier.id + '&kind=olmayan');
  assert.ok(gecersiz.status >= 400, 'tanınmayan süzgeç reddedilmeli');
 } finally {f.close();}
});

test('Tutar yetkisi kapalı personel ödeme yöntemini, tarihini ve fatura numarasını görür; tutarları görmez', async () => {
 const {f, supplier, kart, kismi} = await seed(); try {
  const staff = await f.ok('/admin/users', {name: 'Cari', username: 'cari', permissions: {ec: {ledger: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'cari-personel-sifresi'});
  const cookie = (await f.req('/auth/login', {username: 'cari', password: 'cari-personel-sifresi'})).cookie;

  const view = await f.req('/ec/ledger?party_id=' + supplier.id, undefined, cookie);
  assert.equal(view.status, 200, 'cari yetkisi olan personel ekranı görmeli');
  const hareket = view.data.entries.find(e => e.id === kart.id);
  assert.equal(hareket.payment_method, 'kart', 'yöntem görünmeli');
  assert.equal(hareket.occurred_on, KART_TARIHI, 'tarih görünmeli');
  assert.deepEqual(hareket.closed_invoices.map(x => x.invoice_no).sort(), ['F-1', 'F-2'], 'fatura numaraları görünmeli');
  for (const row of hareket.closed_invoices) assert.equal(row.amount_cents, null, 'kapama tutarı gizlenmeli');
  const borc = view.data.entries.find(e => e.id === 'invoice:' + kismi);
  assert.equal(borc.paid_cents, null, 'ödenen tutar gizlenmeli');
  assert.equal(borc.remaining_cents, null, 'kalan tutar gizlenmeli');
  assert.equal(borc.planned_on, '2026-09-30', 'planlanan ödeme tarihi görünmeye devam etmeli');

  const cari = view.data.parties.find(p => p.id === supplier.id);
  assert.equal(cari.debt_cents, null, 'toplam borç gizlenmeli');
  assert.equal(cari.paid_cents, null, 'ödenen gizlenmeli');
  assert.equal(cari.remaining_cents, null, 'kalan gizlenmeli');
  assert.equal(cari.last_payment.method, 'kart', 'son ödemenin yöntemi görünmeli');
  assert.equal(cari.last_payment.occurred_on, KART_TARIHI, 'son ödemenin tarihi görünmeli');
  assert.equal(cari.last_payment.amount_cents, null, 'son ödemenin tutarı gizlenmeli');
  assert.equal(sonOdemeMetni(cari), '12.09.2026 · Kart · Garanti Bonus', 'tutar olmadan da son ödeme okunabilmeli');

  const ext = await ekstre(f, supplier.id, cookie);
  assert.equal(ext.status, 200);
  const ekstreSatir = satir(ext.data.statement, kart.id);
  assert.equal(ekstreSatir.payment_method, 'kart');
  assert.deepEqual(ekstreSatir.closed_invoices.map(x => x.invoice_no).sort(), ['F-1', 'F-2']);
  for (const row of ekstreSatir.closed_invoices) assert.equal(row.amount_cents, null, 'ekstrede de kapama tutarı gizlenmeli');
  assert.equal(satir(ext.data.statement, 'invoice:' + kismi).paid_cents, null, 'ekstrede ödenen tutar gizlenmeli');
 } finally {f.close();}
});

test('Yazdırılan mutabakat mektubu her borcun nasıl kapandığını anlatır', async () => {
 const {f, supplier, kart, cek, kismi} = await seed(); try {
  const live = await f.ok('/ec/statement?party_id=' + supplier.id + '&from=2026-09-01&to=2026-09-30');
  const belge = {party: live.party, workspace: live.workspace, statement: live.statement, difference: live.difference, meta: {}, notice: live.notice};
  const tablo = statementBlocks(belge).find(b => b.type === 'table');
  const referansi = id => live.statement.rows.find(r => r.id === id).reference;
  const aciklama = id => tablo.rows.find(row => row[2] === referansi(id))[3];

  assert.match(aciklama(kart.id), /Kart · Garanti Bonus/, 'ödeme yöntemi ve notu belgede olmalı');
  assert.match(aciklama(kart.id), /kapattığı fatura: F-1 ₺1\.200,00, F-2 ₺800,00/, 'hangi faturayı ne kadar kapattığı belgede olmalı');
  assert.match(aciklama(cek.id), /Çek · Ziraat çeki 123456 · vade 31\.10\.2026/, 'çekin vadesi belgede olmalı');
  assert.match(aciklama('invoice:' + kismi), /ödenen ₺300,00 · kalan ₺700,00/, 'kısmi ödenen borcun kalanı belgede olmalı');
  assert.match(aciklama('invoice:' + kismi), /ödeyeceğim 30\.09\.2026/, 'planlanan ödeme tarihi belgede olmalı');

  assert.match(statementPrintHtml(belge), /kapattığı fatura: F-1/, 'yazdırma çıktısı da aynı bilgiyi taşımalı');
  const csv = statementCsvRows(belge);
  assert.equal(csv[0].at(-1), 'Ödeme / kapama', 'CSV ayrı bir ödeme sütunu taşımalı');
  assert.equal(csv[0].indexOf('Bakiye TL'), 6, 'sayı sütunlarının yeri korunmalı');
  assert.ok(csv.slice(1).some(row => /F-1/.test(String(row.at(-1)))), 'CSV kapanan faturayı yazmalı');

  // Bilinmeyen sıfır değildir: tutarı gizli satırda numara kalır, uydurma tutar yazılmaz.
  const gizli = settlementNote({payment_method: 'kart', payment_note: 'Garanti Bonus', closed_invoices: [{invoice_no: 'F-1', amount_cents: null}]});
  assert.equal(gizli, 'Kart · Garanti Bonus · kapattığı fatura: F-1');
  assert.equal(settlementNote({description: 'Alış faturası'}), '', 'ödeme bilgisi yoksa hiçbir şey uydurulmaz');
 } finally {f.close();}
});

test('Dar ekranda satır taşmaz: uzun not ve çok fatura kısaltılır, hiçbiri gizlenmez', () => {
 const cok = {payment_method: 'havale', payment_note: 'Ziraat Bankası EFT · muhasebe onaylı · dekont numarası 998877665544332211',
  closed_invoices: [1,2,3,4,5].map(n => ({invoice_no: 'F-' + n, amount_cents: n * 10000}))};
 const kisa = odemeAyrintisi(cok);
 assert.equal(odemeRozeti('havale'), 'Havale-EFT', 'havale kısa rozette tire ile yazılır');
 assert.ok(kisa.length <= 60, 'hareket satırındaki ödeme ayrıntısı kısa kalmalı: ' + kisa);
 assert.match(kisa, /^Havale-EFT · Ziraat/);
 assert.match(kisa, /…$/, 'kesilen not üç nokta ile biter');

 const liste = kapatilanFaturalar(cok);
 assert.match(liste, /F-1/); assert.match(liste, /F-3/);
 assert.match(liste, /ve 2 fatura daha$/, 'kalan faturalar sayıyla anılır, sessizce düşürülmez');
 assert.doesNotMatch(liste, /F-5 /, 'dar ekranda ilk üç fatura yazılır');

 // Belge çıktısında kısaltma yoktur: yazdırılan mektup hepsini yazar.
 const tam = settlementNote(cok);
 assert.match(tam, /dekont numarası 998877665544332211/);
 assert.match(tam, /F-5 ₺500,00/);
 assert.doesNotMatch(tam, /fatura daha/);
 assert.match(settlementNote(cok, true), /ve 2 fatura daha/, 'ekrandaki ekstre satırı kısaltır');
});

test('Her carinin son ödemesi kendi hesabından gelir; başka carinin ödemesi karışmaz', async () => {
 const {f, other, kasa, digerFatura} = await seed(); try {
  // Bu cariye ötekilerden ESKİ tarihli tek bir ödeme yazılır.
  await f.ok('/ec/ledger/payments', {party_id: other.id, amount: 100, occurred_on: '2026-09-01', method: 'havale', note: 'Ziraat EFT', invoice_ids: [digerFatura], account_id: kasa.id});
  const parties = (await f.ok('/ec/ledger')).parties;
  const ikinci = parties.find(p => p.id === other.id);
  assert.equal(ikinci.last_payment.occurred_on, '2026-09-01', 'eski tarihli ödeme kendi carisinde görünmeli');
  assert.equal(ikinci.last_payment.method, 'havale');
  assert.equal(ikinci.paid_cents, 10000);
  assert.equal(ikinci.remaining_cents, 20000);
  assert.equal(sonOdemeMetni(ikinci), '01.09.2026 · Havale-EFT · Ziraat EFT');
  assert.equal(parties.filter(p => p.last_payment).length, 2, 'her cari için en çok bir son ödeme satırı olmalı');
 } finally {f.close();}
});
