import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';

// KAYIP KARGO. Kargo paketi kaybettiğinde pazaryeri bunu iade olarak raporluyor ve 15 dakikalık
// bakım turu /returns-apply'ı confirm:true ile kendiliğinden çağırıyor. O uç her iadede
// restock:true geçiyordu, yani kimse bir şeye basmadan mal RAFA GERİ KONUYORDU. Mal kayıpken raf
// boş kalır ve panel fazla gösterir — 06.10.2026'da temizlenen hayalet stoğun kargo tarafından
// doğan hâli. İşaret paket başınadır ve elle konur: raporda "kayboldu" diye bir alan yok.

const PAKET = (id, status) => [id, 'trendyol', 'EXT-' + id, 'SIP-' + id, '2026-10-01', status, '', 'fp-' + id];
const ekle = (f, id, status) => f.sqlite.prepare(
  'INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,external_status,source_fingerprint)'
  + ' VALUES(?,?,?,?,?,?,?,?)').run(...PAKET(id, status));
// better-sqlite3 prototipsiz nesne döndürüyor; deepStrictEqual prototipi de karşılaştırıyor.
const oku = (f, id) => ({...f.sqlite.prepare('SELECT goods_lost,goods_lost_note FROM ec_order_packages WHERE id=?').get(id)});

test('göç kayıp işareti sütunlarını açar ve varsayılan 0 olur', async () => {
 const f = appFixture(); await f.setup(); try {
  ekle(f, 'P1', 'shipped');
  assert.deepEqual(oku(f, 'P1'), {goods_lost: 0, goods_lost_note: ''}, 'işaret konmadan paket normal iade davranışında kalmalı');
 } finally { f.close(); }
});

test('kargoya verilmiş paket kayıp işaretlenir, neden saklanır', async () => {
 const f = appFixture(); await f.setup(); try {
  ekle(f, 'P1', 'shipped');
  const r = await f.ok('/ec/orders/P1/kayip', {lost: true, reason: 'Kargo dosya 12345'});
  assert.equal(r.goods_lost, 1);
  assert.deepEqual(oku(f, 'P1'), {goods_lost: 1, goods_lost_note: 'Kargo dosya 12345'});
 } finally { f.close(); }
});

test('işaret kaldırılınca neden de silinir', async () => {
 const f = appFixture(); await f.setup(); try {
  ekle(f, 'P2', 'delivered');
  await f.ok('/ec/orders/P2/kayip', {lost: true, reason: 'Kargo dosya 999'});
  const r = await f.ok('/ec/orders/P2/kayip', {lost: false});
  assert.equal(r.goods_lost, 0);
  assert.deepEqual(oku(f, 'P2'), {goods_lost: 0, goods_lost_note: ''});
 } finally { f.close(); }
});

// Henüz kargoya verilmemiş pakette işaretin anlamı yok: mal hâlâ rafta, iade de doğmaz.
test('gönderilmemiş paket kayıp işaretlenemez', async () => {
 const f = appFixture(); await f.setup(); try {
  for (const durum of ['draft', 'reserved', 'cancelled']) {
   ekle(f, 'D-' + durum, durum);
   const r = await f.req('/ec/orders/D-' + durum + '/kayip', {lost: true});
   assert.equal(r.status, 409, durum + ' durumunda reddedilmeli');
   assert.equal(oku(f, 'D-' + durum).goods_lost, 0);
  }
 } finally { f.close(); }
});

// Otomatik iade aktarımının restock kararı bu işarete bağlı. Tam rapor senaryosu kurmak yerine
// bağlantı kaynaktan doğrulanır: restock artık sabit true DEĞİL.
const aktarim = readFileSync(new URL('../src/report-stock-link-api.js', import.meta.url), 'utf8');

test('otomatik iade aktarımı kayıp pakette malı rafa koymaz', () => {
 assert.ok(!aktarim.includes('revenue: l.revenue_cents / 100, restock: true'), 'restock sabit true kalmamalı');
 assert.ok(aktarim.includes('restock: !kayip'), 'restock kayıp işaretine bağlanmalı');
 assert.ok(aktarim.includes('goods_lost=1'), 'kayıp paketler veritabanından okunmalı');
 assert.ok(aktarim.includes('Paket KAYIP işaretli: mal rafa geri konmadı'), 'iade notu durumu söylemeli');
});

const ui = readFileSync(new URL('../public/orders-ui.js', import.meta.url), 'utf8');

test('işaret yalnız kargodaki pakette görünür ve geri alınabilir', () => {
 assert.ok(ui.includes("['shipped','delivered'].includes(p.status)?btn(p.goods_lost?'Kayıp işaretini kaldır':'Kargoda kayboldu','kayip'"), 'düğme duruma bağlı olmalı');
 assert.ok(ui.includes('Bu paket kayıp işaretli.'), 'işaretli pakette açıklama yazmalı');
});
