// Stoğun eksiye düşmesi KAPALI gelir. Kullanıcı açıkça beyan ederse açılır: kaydı olmayan
// bir alıştan satılmış mal varsa, eksi bakiye bu boşluğu gizlemek yerine görünür kılar.
// Beyan edilmeden davranış hiç değişmez ve stok DEĞERİ her durumda eksiye düşemez.
// Kontrol tetikleyicide olduğu için hareket doğrudan yazılarak sınanır; API'nin sayım ucu
// delta değil sayılan miktar ister, oradan sınamak yanlış şeyi ölçerdi.
// TEMSİLİ veri; gerçek kayıt değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-14';
const bakiye = (f, id) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;
const deger = (f, id) => f.sqlite.prepare('SELECT value_cents FROM ec_stock_balances WHERE product_id=?').get(id).value_cents;
const beyan = (f, v) => f.sqlite.prepare('UPDATE workspace_settings SET allow_negative_stock=? WHERE workspace=?').run(v, 'ec');

const hareket = (f, productId, qtyMilli, valueCents, id) =>
  f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(?,?,?,?,'sale',?,?,?)")
    .run(id, productId, qtyMilli, valueCents, id, 'Kaydı olmayan alıştan satış', DATE);

/** 2 adet stoğu olan ürün: açılış 2 adet, birim maliyet 10 TL. */
async function urun(f) {
  const p = await f.ok('/ec/products', {name: 'Yeşil yapraklı 500 ml', sku: 'TR-YESIL-500ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 2, unit_cost: 10, kind: 'opening',
    reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  return p;
}

test('Beyan yokken stok eksiye düşemez ve bakiye değişmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await urun(f);
    assert.equal(bakiye(f, p.id), 2000);
    assert.throws(() => hareket(f, p.id, -5000, 0, 'mv-red'), /INSUFFICIENT_STOCK|STOCK_RESERVED/);
    assert.equal(bakiye(f, p.id), 2000, 'reddedilen hareket bakiyeye dokunmadı');
  } finally { f.close(); }
});

test('Beyan varken eksiye düşer: eksik alış gizlenmez, eksi bakiye olarak görünür', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await urun(f);
    beyan(f, 1);
    hareket(f, p.id, -5000, 0, 'mv-eksi');
    assert.equal(bakiye(f, p.id), -3000, '2 adet vardı, 5 satıldı: bakiye -3');
    assert.equal(deger(f, p.id), 2000, 'değer sıfırın altına inmedi');
  } finally { f.close(); }
});

test('Beyan açıkken bile stok DEĞERİ eksiye düşemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await urun(f);
    beyan(f, 1);
    assert.throws(() => hareket(f, p.id, -1000, -999999, 'mv-deger'), /INVALID_STOCK_VALUE/);
  } finally { f.close(); }
});

test('Ayar varsayılan olarak kapalıdır ve üretim alanı hiç etkilenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const v = f.sqlite.prepare("SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'").get();
    assert.equal(v.allow_negative_stock, 0, 'varsayılan kapalı');
    const lp = f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='lp_stock_nonnegative'").get();
    assert.ok(lp && !/allow_negative_stock/.test(lp.sql), 'üretim alanının koruması değişmedi');
  } finally { f.close(); }
});
