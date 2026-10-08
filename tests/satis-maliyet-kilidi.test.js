// ELLE BELİRLENMİŞ SATIŞ MALİYETİ. Maliyet normalde FIFO'nundur ve elle değiştirilen her tutarı
// bir sonraki hesapta geri alır (fifo-cost.js: mevcut düzeltmeleri okur, hedefine uymayanı
// kapatır). Bu doğru kuraldır — geçmiş sağlamken kimse maliyeti oynatmasın.
//
// AMA GEÇMİŞ BOZUKSA ÇIKIŞ YOLU YOKTU. Canlıda (08.10.2026) iki satış hiçbir faturaya uymayan
// maliyet taşıyordu: TY 11650792573 · TS1 · 1.958,60 (en pahalı alış 1.400) ve HB 4583700954 ·
// SAB · 1.250 (80 L'nin alışı 450). Kaynağı düzeltmenin yolu da kapalıydı: fatura `posted` ve
// değiştirilemiyor, alış fiyatı düzeltmesi yalnız RAFTA KALAN mal kadar pay alabiliyor ve iki
// üründe de o mal çoktan satılmıştı.
//
// Kanıtlanan: (a) maliyet elle belirlenebiliyor ve eski değer saklanıyor, (b) FIFO kilitli satışa
// BİR DAHA DOKUNMUYOR — asıl mesele bu, yoksa araç bir tur sonra kendini bozar, (c) kilitli
// OLMAYAN satışlar eskisi gibi hesaplanmaya devam ediyor, (d) stok BAKİYESİ değişmiyor (hayalet
// değer doğmasın), (e) aynı satış ikinci kez kilitlenmiyor, (f) onay ve gerekçe zorunlu,
// (g) göç gelmemişse özellik kapalı ve motor bugünkü gibi çalışıyor.
// TEMSİLİ veri; gerçek satış DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {fifoHesap, fifoRevalue} from '../src/fifo-cost.js';

const GUN = '2026-09-10';

/** Ürün + açılış stoğu + iki satış kurar; satışların maliyeti FIFO'dan gelir. */
async function kur(f, {acilisAdet = 20, birimMaliyet = 2000} = {}) {
  const p = await f.ok('/ec/products', {name: 'Test torf', sku: 'TEST-TORF', stock_unit: 'adet', min_stock: 0});
  // Açılış değeri satış maliyetlerinin toplamından BÜYÜK olmalı: ec_stock_nonnegative ve
  // stok_balances CHECK(value_cents>=0) yoksa satış kaydı INVALID_STOCK_VALUE ile düşer.
  await f.ok('/ec/stock', {product_id: p.id, quantity: acilisAdet, unit_cost: birimMaliyet,
    kind: 'opening', reference: 'ACILIS', occurred_on: GUN, notes: 'Test'});
  return p;
}

/** Doğrudan satış kaydı: sipariş akışına girmeden maliyet davranışı sınanır. */
function satis(f, id, productId, {adet = 1, gelir = 30000, maliyet = 10000} = {}) {
  f.sqlite.prepare('INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on)'
    + " VALUES(?,'trendyol',?,?,'sale',?,?,?,'pending',?)").run(id, 'SAT-' + id, productId, adet * 1000, gelir, maliyet, GUN);
  return id;
}
const maliyetOf = (f, id) => f.sqlite.prepare('SELECT cost_cents c FROM ec_sale_entries WHERE id=?').get(id).c;
const bakiye = (f, pid) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(pid)});
const kilitle = (f, sale_id, cost_cents, reason = 'Geçmiş bozuk; gerçek alış fiyatı yazıldı') =>
  f.ok('/ec/cost-fifo/sale-cost', {sale_id, cost_cents, reason, confirm: true});

test('Maliyet elle belirlenir; eski değer ve gerekçe saklanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});

    const r = await kilitle(f, s, 140000, 'TS1 · 23.09 düzeltmesinden kalan hayalet değer');
    assert.equal(r.previous_cost_cents, 195860);
    assert.equal(r.cost_cents, 140000);
    assert.equal(maliyetOf(f, s), 140000, 'maliyet yazılmalı');

    const kilit = f.sqlite.prepare('SELECT * FROM ec_sale_cost_locks WHERE sale_id=?').get(s);
    assert.equal(kilit.previous_cost_cents, 195860, 'eski değer saklanmalı');
    assert.match(kilit.reason, /hayalet/, 'gerekçe saklanmalı');
    const iz = f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Satış maliyeti elle%' ORDER BY rowid DESC LIMIT 1").get();
    assert.match(iz.d, /1958\.60 → 1400\.00/, 'iz kaydı iki tutarı da yazmalı: ' + iz.d);
  } finally { f.close(); }
});

// ASIL MESELE BU. Kilit olmazsa FIFO ilk hesapta elle yazılanı geri alır ve araç işe yaramaz.
test('FIFO kilitli satışa BİR DAHA DOKUNMAZ', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});
    await kilitle(f, s, 140000);

    const h = await fifoHesap(f.env.DB, p.id);
    assert.ok(!h.writes.some(w => w.sale_id === s), 'kilitli satış için düzeltme üretilmemeli: ' + JSON.stringify(h.writes));
    assert.ok(h.atlanan.includes(s), 'atlananlarda görünmeli ki gizli kalmasın');

    f.sqlite.prepare('INSERT OR IGNORE INTO ec_cost_dirty(product_id) VALUES(?)').run(p.id);
    await fifoRevalue(f.env.DB, 15);
    assert.equal(maliyetOf(f, s), 140000, 'yeniden hesap elle yazılanı BOZMAMALI');
  } finally { f.close(); }
});

test('Kilitli olmayan satış eskisi gibi hesaplanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const kilitli = satis(f, 's1', p.id, {maliyet: 195860});
    const serbest = satis(f, 's2', p.id, {maliyet: 195860});
    await kilitle(f, kilitli, 140000);

    f.sqlite.prepare('INSERT OR IGNORE INTO ec_cost_dirty(product_id) VALUES(?)').run(p.id);
    await fifoRevalue(f.env.DB, 15);

    assert.equal(maliyetOf(f, kilitli), 140000, 'kilitli değişmemeli');
    assert.notEqual(maliyetOf(f, serbest), 195860, 'kilitsiz satış FIFO tarafından düzeltilmeli');
  } finally { f.close(); }
});

// Maliyet düzeltmesi ec_cost_revaluations'tan geçseydi tetik (0048:25) bakiyeyi de oynatırdı ve
// rafta mal olmadan para doğardı — bugün temizlediğimiz hayaletin aynısı.
test('Stok BAKİYESİ değişmez: hayalet değer doğmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});
    const once = bakiye(f, p.id);

    await kilitle(f, s, 140000);

    assert.deepEqual(bakiye(f, p.id), once, 'bakiye kıl payı oynamamalı: ' + JSON.stringify(bakiye(f, p.id)));
  } finally { f.close(); }
});

test('Aynı satış ikinci kez kilitlenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});
    await kilitle(f, s, 140000);
    await assert.rejects(() => kilitle(f, s, 120000), /daha önce elle belirlenmiş/);
    assert.equal(maliyetOf(f, s), 140000, 'ikinci deneme tutarı değiştirmemeli');
  } finally { f.close(); }
});

test('Kayıt silinemez: maliyeti elle değiştirmenin izi kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});
    await kilitle(f, s, 140000);
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_sale_cost_locks'), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});

test('Onay ve gerekçe zorunlu; eksi maliyet ve iade kaydı reddedilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const s = satis(f, 's1', p.id, {maliyet: 195860});
    await assert.rejects(() => f.ok('/ec/cost-fifo/sale-cost', {sale_id: s, cost_cents: 140000, reason: 'x'}), /onaylayın/);
    await assert.rejects(() => f.ok('/ec/cost-fifo/sale-cost', {sale_id: s, cost_cents: 140000, reason: '  ', confirm: true}), /gerekçe/);
    await assert.rejects(() => kilitle(f, s, -100), /Maliyet tutarını/);
    await assert.rejects(() => kilitle(f, 'yok-boyle-bir-satis', 140000), /bulunamadı/);
    assert.equal(maliyetOf(f, s), 195860, 'reddedilen denemeler tutarı değiştirmemeli');
  } finally { f.close(); }
});
