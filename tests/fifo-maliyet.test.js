// SATIŞ MALİYETİ SATIŞ TARİHİNE GÖRE. Canlıda TY 11408249438: 13 Temmuz satışı, o gün stokta
// yalnız 100 TL'lik mal varken, sonradan girilen Ağustos alışının (110 TL) payıyla 101,19 TL
// maliyet yazılmıştı. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

async function kur(f) {
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await f.ok('/ec/products', {name: 'Torf 10 L', sku: 'SNT-T10', stock_unit: 'adet', min_stock: 0})).id;
  return {supplier, product};
}
async function alis(f, supplier, product, no, date, qty, unitNet) {
  const id = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: date, currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 10 L', external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, line_type: 'product', product_id: product, stock_quantity: qty}]})).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  const line = (await f.ok('/ec/invoices/' + id)).lines[0].id;
  await f.ok('/ec/invoices/' + id + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: line, quantity: qty}]});
}
const satis = (f, product, ref, date, qty = 1) => f.ok('/ec/sales', {channel: 'trendyol', external_id: ref, product_id: product, quantity: qty,
  revenue: 291.67 * qty, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: date});
const maliyet = (f, ref) => f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE external_id=?').get(ref).cost_cents;
const bakiye = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});

test('Geçmiş satış sonradan girilse de kendi tarihindeki malın maliyetini alır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'KRK-653', '2026-07-13', 2, 100);
    await alis(f, supplier, product, 'KRK-763', '2026-08-17', 5, 110);
    await satis(f, product, 'TEMMUZ', '2026-07-13');
    await satis(f, product, 'AGUSTOS-1', '2026-08-20');
    await satis(f, product, 'AGUSTOS-2', '2026-08-21');
    assert.equal(maliyet(f, 'TEMMUZ'), 10000, '13 Temmuz: stokta yalnız 100 TL mal vardı');
    assert.equal(maliyet(f, 'AGUSTOS-1'), 10000, 'Temmuz alışından kalan son adet');
    assert.equal(maliyet(f, 'AGUSTOS-2'), 11000, 'sonra Ağustos alışından');
    assert.deepEqual(bakiye(f, product), {q: 4000, v: 44000}, 'kalan 4 adet 110 TL');
  } finally { f.close(); }
});

test('Geçmiş tarihli alış sonradan girilince önceki satışların maliyeti düzelir; iade gerçek maliyetle döner', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'B', '2026-08-01', 2, 150);
    await satis(f, product, 'S1', '2026-08-05');
    await alis(f, supplier, product, 'A', '2026-07-01', 1, 90);            // sonradan girilen eski fatura
    assert.equal(maliyet(f, 'S1'), 9000, 'S1, 1 Temmuz alışının malını tüketti');
    const s1 = f.sqlite.prepare("SELECT id FROM ec_sale_entries WHERE external_id='S1'").get().id;
    await f.ok('/ec/sales/' + s1 + '/return', {external_id: 'IADE-S1', quantity: 1, revenue: 291.67, restock: true, occurred_on: '2026-08-06'});
    assert.equal(maliyet(f, 'IADE-S1'), -9000);
    assert.deepEqual(bakiye(f, product), {q: 3000, v: 39000}, '2 × 150 + iade 90');
  } finally { f.close(); }
});

test('Aynı gün iade edilen satışın malı sıfır değerle stoğa girmez; sonraki satış gerçek maliyeti alır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-09-02', 2, 1400);
    await satis(f, product, 'S1', '2026-09-02');
    const s1 = f.sqlite.prepare("SELECT id FROM ec_sale_entries WHERE external_id='S1'").get().id;
    await f.ok('/ec/sales/' + s1 + '/return', {external_id: 'DUZELTME-CIFT-S1', quantity: 1, revenue: 291.67, restock: true, occurred_on: '2026-09-02'});
    await satis(f, product, 'S2', '2026-09-03');
    await satis(f, product, 'S3', '2026-09-03');
    assert.equal(maliyet(f, 'S1'), 140000);
    assert.equal(maliyet(f, 'DUZELTME-CIFT-S1'), -140000);
    assert.equal(maliyet(f, 'S2'), 140000, 'sıfır değil');
    assert.equal(maliyet(f, 'S3'), 140000, 'sıfır değil');
  } finally { f.close(); }
});
