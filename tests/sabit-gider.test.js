import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// SABİT GENEL GİDER. Kira, elektrik, yakıt her ay aynı tutarla tekrarlıyor; bir kez tanımlanır,
// ayın gideri üretilir. Üretim TEKRAR GÜVENLİDİR: aynı ay ikinci kez yazılmaz.

const plan = (f, body) => f.ok('/ec/expense-schedules', {
 label: 'Kira', category: 'rent', amount: 15000, day_of_month: 1,
 starts_on: '2026-07-01', notes: 'Depo kirası', ...body
});
const uret = (f, through) => f.ok('/ec/expense-schedules/generate', {through});
const giderler = f => f.sqlite.prepare('SELECT reference,label,category,amount_cents,occurred_on FROM ec_expenses ORDER BY occurred_on').all();

test('Sabit gider tanımlanır ve geçmiş aylar tek seferde üretilir', async () => {
 const f = appFixture(); await f.setup(); try {
  const p = await plan(f);
  assert.ok(p.id, 'plan kimliği dönmeli');

  const r = await uret(f, '2026-09-30');
  assert.equal(r.created, 3, 'Temmuz, Ağustos ve Eylül üretilmeli');

  const rows = giderler(f);
  assert.deepEqual(rows.map(x => x.occurred_on), ['2026-07-01', '2026-08-01', '2026-09-01']);
  assert.equal(rows[0].amount_cents, 1500000, 'tutar kuruşa çevrilmeli');
  assert.equal(rows[0].label, 'Kira', 'gider adı yazılmalı');
  assert.equal(rows[0].category, 'rent');
  assert.match(rows[0].reference, /^GIDER-PLAN-.+-2026-07$/, 'referans plan ve aya bağlı olmalı');
 } finally { f.close(); }
});

test('Üretim tekrar çalıştırılınca aynı ay ikinci kez yazılmaz', async () => {
 const f = appFixture(); await f.setup(); try {
  await plan(f);
  assert.equal((await uret(f, '2026-09-30')).created, 3);
  assert.equal((await uret(f, '2026-09-30')).created, 0, 'ikinci üretim hiçbir şey yazmamalı');
  assert.equal(giderler(f).length, 3, 'ÇİFT GİDER OLMAMALI');

  // Ay ilerleyince yalnız yeni ay eklenir.
  assert.equal((await uret(f, '2026-10-31')).created, 1, 'yalnız Ekim eklenmeli');
  assert.equal(giderler(f).length, 4);
 } finally { f.close(); }
});

test('Bitiş tarihi ve arşiv üretimi durdurur', async () => {
 const f = appFixture(); await f.setup(); try {
  const biten = await plan(f, {label: 'Geçici depo', ends_on: '2026-08-31'});
  assert.equal((await uret(f, '2026-12-31')).created, 2, 'bitiş ayından sonrası üretilmemeli');

  await f.ok('/ec/expense-schedules/' + biten.id + '/archive', {});
  assert.equal((await uret(f, '2026-12-31')).created, 0, 'arşivlenen plan üretmemeli');
 } finally { f.close(); }
});

test('Ayın günü 1-28 dışında olamaz ve tutar sıfır geçmez', async () => {
 const f = appFixture(); await f.setup(); try {
  for (const bad of [0, 29, 31]) {
   const r = await f.req('/ec/expense-schedules', {label: 'X', category: 'other', amount: 100, day_of_month: bad, starts_on: '2026-07-01'});
   assert.equal(r.status, 400, 'ayın günü ' + bad + ' reddedilmeli');
  }
  const sifir = await f.req('/ec/expense-schedules', {label: 'X', category: 'other', amount: 0, day_of_month: 5, starts_on: '2026-07-01'});
  assert.equal(sifir.status, 400, 'sıfır tutarlı sabit gider olmamalı');
 } finally { f.close(); }
});
