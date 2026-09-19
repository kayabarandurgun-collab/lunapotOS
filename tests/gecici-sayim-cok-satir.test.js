// AYNI ÜRÜN FATURADA İKİ SATIR. Mal fatura gelmeden rafta sayıldı (geçici sayım +8), 10 adet satıldı
// (2'si stoksuz: açık maliyet). Ay sonu faturası aynı ürünü iki satırda 5+5 getirir. Teslimin 8'i sayımı
// kapatır, fazladan gelen 2 adet stoksuz satılmış 2 adedin maliyetini kapatmalı. Eskiden her satır
// sayımın tamamını (8) ayrı ayrı "yeni mal değil" sayıyordu: 5+5 ayrıldı, açık satış açık kaldı. TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

test('Aynı ürün faturada iki satırsa sayım bir kez kapanır, fazlası stoksuz satışın maliyetini kapatır', async () => {
  const f = appFixture(); await f.setup(); try {
    f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Tropikal', tax_id: '9340990552'})).id;
    const product = (await f.ok('/ec/products', {name: 'Orkide Toprağı 3 L', sku: 'SNT-OT3', stock_unit: 'adet', min_stock: 0})).id;
    await f.ok('/ec/stock', {product_id: product, quantity: 8, unit_cost: 100, kind: 'count', reference: 'GECICI-SAYIM-OT3', notes: 'Fatura ay sonunda', occurred_on: '2026-09-02'});
    await f.ok('/ec/sales', {channel: 'trendyol', external_id: 'S10', product_id: product, quantity: 10, revenue: 2500, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: '2026-09-03'});
    const sale = f.sqlite.prepare("SELECT id FROM ec_sale_entries WHERE external_id='S10'").get().id;
    assert.equal(f.sqlite.prepare('SELECT open_milli-settled_milli n FROM ec_open_costs WHERE sale_id=?').get(sale).n, 2000, '2 adet stoksuz satıldı');
    const inv = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'AYSONU-OT3', uuid: '', invoice_date: '2026-09-30', currency: 'TRY', source: 'pdf', notes: '',
      lines: [1, 2].map(i => ({description: 'Orkide Toprağı 3 L #' + i, external_code: '', invoice_quantity: 5, invoice_unit: 'adet', net: 600, tax: 120, line_type: 'product', product_id: product, stock_quantity: 5}))})).id;
    await f.ok('/ec/invoices/' + inv + '/post', {});
    const lines = (await f.ok('/ec/invoices/' + inv)).lines;
    await f.ok('/ec/invoices/' + inv + '/receive', {occurred_on: '2026-09-30', reference: 'TESLIM-OT3', lines: lines.map(l => ({id: l.id, quantity: 5}))});
    const o = f.sqlite.prepare('SELECT open_milli,settled_milli,settled_cents FROM ec_open_costs WHERE sale_id=?').get(sale);
    assert.equal(o.settled_milli, o.open_milli, 'fazladan gelen 2 adet açık satışı kapattı');
    assert.equal(o.settled_cents, 24000, '2 adet × 120 TL fatura fiyatı');
    const kapanis = f.sqlite.prepare("SELECT COALESCE(-SUM(quantity_milli),0) n FROM ec_stock_movements WHERE product_id=? AND reference LIKE 'provisional-close:%'").get(product).n;
    assert.equal(kapanis, 8000, 'sayım tam bir kez (8) kapandı');
    assert.equal(f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(product).q, 0, 'rafta mal kalmadı');
    // FIFO aynı sonucu onaylar: 10 adetin tamamı faturanın fiyatı (120 TL), stokta değer kalmaz, kuyruk boşalır.
    for (let i = 0; i < 3; i++) await f.ok('/ec/cost-fifo', {});
    assert.equal(f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE id=?').get(sale).cost_cents, 120000, '10 × 120 TL');
    assert.deepEqual({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(product)}, {q: 0, v: 0});
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cost_dirty').get().n, 0);
  } finally { f.close(); }
});
