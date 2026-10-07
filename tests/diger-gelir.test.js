import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// SATIŞ DIŞI GELİR (tazminat). Kargo kaybolan paketi tazmin ettiğinde para işletmeye giriyor ama
// yazacak yer yoktu: gelir yazan tek tablo ec_sale_entries ve o stoktan ürün düşüyor, ec_expenses
// de CHECK(amount_cents>=0) yüzünden gelir tutamıyor.
//
// BU DOSYANIN ASIL İŞİ aşağıdaki "uyarı korunur" testi. Gelir, eksi tutarlı bir gider satırı
// olarak yazılsaydı işletme sonucu overhead dizisini boş görmez (money-planning-api.js:178) ve
// "Bu dönemde genel gider kaydı yok" uyarısı sessizce kaybolurdu.

// İşletme sonucu bitiş tarihinin bugünden sonra olmasını reddediyor, o yüzden dönem bugüne göre
// kurulur; sabit tarih yazılsaydı test takvimle birlikte çürürdü.
const gun = fark => new Date(Date.now() + fark * 86400000).toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const GUN = gun(-1), ARALIK = '?from=' + gun(-5) + '&to=' + gun(0);
const gelir = (f, body) => f.ok('/ec/expenses/other-income', {reference: 'TAZMINAT-1', amount: 1920, occurred_on: GUN, ...body});
const sonuc = f => f.ok('/ec/business-result' + ARALIK);

test('tazminat kaydedilir ve defter yanıtında ayrı dizide durur', async () => {
 const f = appFixture(); await f.setup(); try {
  await gelir(f, {label: 'Kargo dosya 12345', kind: 'compensation'});
  const defter = await f.ok('/ec' + ARALIK);
  assert.equal(defter.other_income.length, 1);
  assert.equal(defter.other_income[0].amount_cents, 192000);
  assert.equal(defter.other_income[0].kind, 'compensation');
  assert.equal(defter.other_income[0].received, 0, 'tahsilat ayrı bir bilgi, varsayılan hayır');
  assert.ok(!defter.expenses.some(e => e.reference === 'TAZMINAT-1'), 'gelir gider listesine KARIŞMAMALI');
 } finally { f.close(); }
});

test('aynı referans ikinci kez yazılmaz', async () => {
 const f = appFixture(); await f.setup(); try {
  await gelir(f, {});
  const r = await f.req('/ec/expenses/other-income', {reference: 'TAZMINAT-1', amount: 500, occurred_on: GUN});
  assert.ok(r.status >= 400, 'tekil referans korunmalı');
  const defter = await f.ok('/ec' + ARALIK);
  assert.equal(defter.other_income.length, 1);
 } finally { f.close(); }
});

test('eksi ya da sıfır tutar kabul edilmez', async () => {
 const f = appFixture(); await f.setup(); try {
  for (const amount of [-5, 0]) {
   const r = await f.req('/ec/expenses/other-income', {reference: 'T-' + amount, amount, occurred_on: GUN});
   assert.ok(r.status >= 400, amount + ' reddedilmeli');
  }
 } finally { f.close(); }
});

test('tazminat işletme sonucuna eklenir', async () => {
 const f = appFixture(); await f.setup(); try {
  const once = await sonuc(f);
  assert.equal(once.summary.other_income_cents, 0);
  assert.equal(once.summary.other_income_records, 0);
  await gelir(f, {});
  const sonra = await sonuc(f);
  assert.equal(sonra.summary.other_income_cents, 192000);
  assert.equal(sonra.summary.other_income_records, 1);
  assert.equal(sonra.other_income.length, 1);
 } finally { f.close(); }
});

// EN ÖNEMLİ TEST. Tek başına bir gelir satırı "gider kaydı var" anlamına GELMEZ.
test('yalnız gelir varken "genel gider kaydı yok" uyarısı korunur', async () => {
 const f = appFixture(); await f.setup(); try {
  const once = await sonuc(f);
  await gelir(f, {});
  const sonra = await sonuc(f);
  assert.equal(sonra.status, once.status, 'gelir tek başına durumu değiştirmemeli');
  assert.equal(sonra.summary.overhead_records, 0, 'gelir gider sayısına eklenmemeli');
  assert.equal(sonra.summary.overhead_cents, once.summary.overhead_cents, 'gelir gider toplamını düşürmemeli');
  assert.match(sonra.completeness_notice, /genel gider kaydı yok/, 'uyarı yerinde kalmalı');
  assert.ok(!sonra.expense_categories.some(c => c.category === 'compensation'), 'gelir gider kategorisi sayılmamalı');
 } finally { f.close(); }
});

// Arşivleme (DELETE) fixture'ın istek yardımcısıyla çağrılamıyor (yalnız GET/POST); arşivin
// ETKİSİ sınanıyor: arşivli satır ne defter listesine ne dönem sonucuna girer.
test('arşivlenen gelir listeden ve dönem sonucundan düşer', async () => {
 const f = appFixture(); await f.setup(); try {
  const {id} = await gelir(f, {});
  assert.equal((await sonuc(f)).summary.other_income_cents, 192000);
  f.sqlite.prepare("UPDATE ec_other_income SET archived_at=? WHERE id=?").run(gun(0), id);
  assert.equal((await f.ok('/ec' + ARALIK)).other_income.length, 0);
  assert.equal((await sonuc(f)).summary.other_income_cents, 0);
  assert.equal((await sonuc(f)).summary.other_income_records, 0);
 } finally { f.close(); }
});

// Dönem dışındaki gelir o döneme yazılmaz.
test('gelir yalnız kendi dönemine girer', async () => {
 const f = appFixture(); await f.setup(); try {
  await f.ok('/ec/expenses/other-income', {reference: 'TAZMINAT-ESKI', amount: 100, occurred_on: gun(-60)});
  assert.equal((await sonuc(f)).summary.other_income_cents, 0);
  assert.equal((await f.ok('/ec' + ARALIK)).other_income.length, 0);
 } finally { f.close(); }
});

// GÖÇ GELMEDEN KOD YAYINA ÇIKARSA PANEL DÜŞMEMELİ. 07.10.2026'da tam bu oldu: kod gitti, 0074
// göçü Cloudflare D1 yetkisi (hata 7403) yüzünden uygulanamadı ve ana defter ile işletme sonucu
// 500 verdi. Yani EK bir gelir özelliği panelin yarısını kapattı. Artık tablo yoksa özellik
// kapalı sayılır; başka hiçbir veritabanı hatası yutulmaz.
test('tablo yoksa ana defter ve işletme sonucu çalışmaya devam eder', async () => {
 const f = appFixture(); await f.setup(); try {
  f.sqlite.exec('DROP TABLE ec_other_income');
  const defter = await f.req('/ec' + ARALIK);
  assert.equal(defter.status, 200, 'ana defter göç olmadan da açılmalı');
  assert.deepEqual(defter.data.other_income, [], 'özellik kapalı: boş liste');
  const sonuc = await f.req('/ec/business-result' + ARALIK);
  assert.equal(sonuc.status, 200, 'işletme sonucu göç olmadan da hesaplanmalı');
  assert.equal(sonuc.data.summary.other_income_cents, 0);
  assert.equal(sonuc.data.summary.other_income_records, 0);
 } finally { f.close(); }
});

// Yutma dar olmalı: gerçek bir veritabanı arızası sessiz kalmamalı.
test('tablo dışı veritabanı hatası yutulmaz', async () => {
 const f = appFixture(); await f.setup(); try {
  f.sqlite.exec('DROP TABLE ec_expenses');
  const defter = await f.req('/ec' + ARALIK);
  assert.ok(defter.status >= 500, 'gider tablosunun yokluğu gizlenmemeli');
 } finally { f.close(); }
});
