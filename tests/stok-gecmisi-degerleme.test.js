// STOK GEÇMİŞİ, FIFO DÜZELTMELERİNİ DE GÖSTERİR. Geçmiş tarihli alış sonradan girilince FIFO satışın
// maliyetini düzeltme kaydıyla (ec_cost_revaluations) değiştirir ve fark stok değerine geçer. Döküm bu
// satırları göstermezse "değer değişimi" toplamı ürün kartındaki stok değeriyle tutmaz. TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

async function alis(f, supplier, product, no, date, qty, unitNet) {
  const id = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: date, currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 10 L', external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, line_type: 'product', product_id: product, stock_quantity: qty}]})).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  const line = (await f.ok('/ec/invoices/' + id)).lines[0].id;
  await f.ok('/ec/invoices/' + id + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: line, quantity: qty}]});
}

test('Stok geçmişinin değer toplamı FIFO düzeltmesinden sonra da stok değerine eşit', async () => {
  const f = appFixture(); await f.setup(); try {
    f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
    const product = (await f.ok('/ec/products', {name: 'Torf 10 L', sku: 'SNT-T10', stock_unit: 'adet', min_stock: 0})).id;
    await alis(f, supplier, product, 'B', '2026-08-01', 2, 150);
    await f.ok('/ec/sales', {channel: 'trendyol', external_id: 'S1', product_id: product, quantity: 1, revenue: 291.67, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: '2026-08-05'});
    await alis(f, supplier, product, 'A', '2026-07-01', 1, 90);   // sonradan girilen eski fatura → S1 maliyeti 90'a iner
    await f.ok('/ec/cost-fifo', {});
    const n = f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cost_revaluations').get().n;
    assert.ok(n > 0, 'senaryo FIFO düzeltmesi üretmeli');
    const h = await f.ok('/ec/stock/history?product=' + product);
    assert.equal(h.totals.value_change_cents, h.product.value_cents, 'döküm toplamı = stok değeri');
    assert.ok(h.rows.some(r => r.kind === 'cost_revaluation'), 'düzeltme satırı dökümde görünür');
  } finally { f.close(); }
});
