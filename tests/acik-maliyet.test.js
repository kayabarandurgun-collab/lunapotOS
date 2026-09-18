// AÇIK MALİYET. Tedarikçi faturayı ay sonunda keser; mal ondan önce satılır ve stok eksiye iner.
// Eskiden bu satışın maliyeti 0 yazılıyor (mal bedava sayılıyor), sonra gelen alışın bütün değeri
// kalan birkaç adede yükleniyor, birim maliyet şişiyordu. Kullanıcı bunu kapatmak için sahte
// sayım girmek zorunda kalıyordu. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {appFixture} from './helpers/app-fixture.js';

const D = '2026-09-01';

async function kur(f) {
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await f.ok('/ec/products', {name: 'Torf 210 L', sku: 'SNT-TS1', stock_unit: 'adet', min_stock: 0})).id;
  return {supplier, product};
}
async function alis(f, supplier, product, no, date, qty, unitNet) {
  const id = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: date, currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 210 L', external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, line_type: 'product', product_id: product, stock_quantity: qty}]})).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  const line = (await f.ok('/ec/invoices/' + id)).lines[0].id;
  await f.ok('/ec/invoices/' + id + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: line, quantity: qty}]});
}
const satis = (f, product, ref, date, qty = 1) => f.ok('/ec/sales', {channel: 'trendyol', external_id: ref, product_id: product, quantity: qty,
  revenue: 2500 * qty, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: date});
const bakiye = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});
const maliyet = (f, ref) => f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE external_id=?').get(ref).cost_cents;

test('Stokta olmayan mal satılınca maliyet 0 değil, son alış fiyatından tahmin; fatura gelince gerçeğe çekilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'YSK-1', D, 5, 1400);
    for (let i = 1; i <= 7; i++) await satis(f, product, 'S' + i, '2026-09-02');   // 5 stoktan, 2 stoksuz
    assert.deepEqual(bakiye(f, product), {q: -2000, v: 0}, 'stok eksiye indi, değer eksiye inmedi');
    assert.equal(maliyet(f, 'S5'), 140000, 'stoktaki son adet stok değerinden');
    assert.equal(maliyet(f, 'S6'), 140000, 'stoksuz satış: son alış fiyatından TAHMİN, sıfır değil');
    assert.equal(maliyet(f, 'S7'), 140000);

    // Ay sonu faturası farklı fiyatla gelir: açık satışlar GERÇEK fiyata çekilir, kalan stok şişmez.
    await alis(f, supplier, product, 'YSK-2', '2026-09-30', 6, 1500);
    assert.equal(maliyet(f, 'S6'), 150000, 'gerçek fiyat');
    assert.equal(maliyet(f, 'S7'), 150000);
    assert.deepEqual(bakiye(f, product), {q: 4000, v: 600000}, '4 adet × 1.500: birim maliyet şişmedi');
    const kapanis = f.sqlite.prepare('SELECT COUNT(*) n,SUM(value_cents) v FROM ec_cost_settlements').get();
    assert.deepEqual({...kapanis}, {n: 2, v: 300000});
    // Kapanış değiştirilemez kayıttır.
    assert.throws(() => f.sqlite.exec('DELETE FROM ec_cost_settlements'), /IMMUTABLE_LEDGER/);
    // Toplam korunur: alınan 11 adetin değeri = satılan 7'nin maliyeti + eldeki 4'ün değeri.
    const cogs = f.sqlite.prepare("SELECT SUM(cost_cents) c FROM ec_sale_entries WHERE kind='sale'").get().c;
    assert.equal(cogs + bakiye(f, product).v, 5 * 140000 + 6 * 150000);
  } finally { f.close(); }
});

test('Hiç alışı olmayan ürünün stoksuz satışında tahmin uydurulmaz; ilk alışta kendiliğinden kapanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await satis(f, product, 'S1', D);
    assert.equal(maliyet(f, 'S1'), 0);
    assert.equal(f.sqlite.prepare('SELECT estimate_cents FROM ec_open_costs').get().estimate_cents, null, 'tahmin yok: bilinmiyor');
    await alis(f, supplier, product, 'YSK-1', '2026-09-03', 3, 1200);
    assert.equal(maliyet(f, 'S1'), 120000);
    assert.deepEqual(bakiye(f, product), {q: 2000, v: 240000});
  } finally { f.close(); }
});

test('Stoksuz satılan mal iade edilirse stoğa hiç çıkmamış tahmin değeri eklenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'YSK-1', D, 1, 1400);
    await satis(f, product, 'S1', '2026-09-02');
    const open = await satis(f, product, 'S2', '2026-09-02', 2);                     // 2 adet stoksuz
    await f.ok('/ec/sales/' + open.id + '/return', {external_id: 'IADE-S2', quantity: 1, revenue: 2500, restock: true, occurred_on: '2026-09-03'});
    assert.deepEqual(bakiye(f, product), {q: -1000, v: 0}, 'iade edilen adet açık kısımdan düştü, sahte değer girmedi');
    assert.deepEqual({...f.sqlite.prepare('SELECT open_milli,estimate_cents FROM ec_open_costs').get()}, {open_milli: 1000, estimate_cents: 140000});
    await alis(f, supplier, product, 'YSK-2', '2026-09-30', 3, 1500);
    assert.deepEqual(bakiye(f, product), {q: 2000, v: 300000}, 'kalan açık adet gerçek fiyatla kapandı, stok 2 × 1.500');
  } finally { f.close(); }
});

test('0047 geçişi Wrangler ayrıştırıcısından eksiksiz geçer', () => {
  const sql = readFileSync(new URL('../migrations/0047_open_cost.sql', import.meta.url), 'utf8');
  const parts = unstable_splitSqlQuery(sql);
  const triggers = parts.filter(q => /CREATE TRIGGER/i.test(q));
  assert.equal(triggers.length, 6);
  for (const t of triggers) assert.match(t.trim(), /END;?$/, 'tetik gövdesi bölünmedi: ' + t.slice(0, 60));
});
