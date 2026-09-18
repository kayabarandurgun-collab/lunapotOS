// Sipariş listesi: kanal süzgeci ve SUNUCUDA sıralama (sayfalamadan önce). TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

test('Sipariş listesi tarihe, tutara göre iki yönde sıralanır; sıralama bütün sayfalara uygulanır; kanal sayıları ayrılır', async () => {
  const f = appFixture(); await f.setup(); try {
    const ac = (channel, no, date, gross) => f.ok('/ec/orders', {channel, external_id: 'P-' + no, order_no: no, occurred_on: date,
      lines: [{external_id: 'L-' + no, sku: 'SKU', name: 'Ürün', quantity: 1, gross, vat_rate: 20}]});
    await ac('trendyol', 'T1', '2026-07-01', 300);
    await ac('trendyol', 'T2', '2026-07-03', 100);
    await ac('trendyol', 'T3', '2026-07-02', 500);
    await ac('hepsiburada', 'H1', '2026-07-04', 50);
    const liste = async q => (await f.ok('/ec/orders?' + q)).packages.map(p => p.order_no);
    assert.deepEqual(await liste('channel=trendyol'), ['T2', 'T3', 'T1'], 'varsayılan: tarih yeniden eskiye');
    assert.deepEqual(await liste('channel=trendyol&sort=date_asc'), ['T1', 'T3', 'T2']);
    assert.deepEqual(await liste('channel=trendyol&sort=amount_desc'), ['T3', 'T1', 'T2']);
    assert.deepEqual(await liste('channel=trendyol&sort=amount_asc'), ['T2', 'T1', 'T3']);
    assert.deepEqual(await liste('sort=amount_asc&limit=2&page=1'), ['H1', 'T2'], 'sıralama sayfalamadan önce');
    assert.deepEqual(await liste('sort=amount_asc&limit=2&page=2'), ['T1', 'T3']);
    assert.deepEqual(await liste('sort=profit_desc&channel=hepsiburada'), ['H1'], 'kesintisi olmayan da listede kalır');
    const sayilar = (await f.ok('/ec/orders?channel=hepsiburada')).counts;
    assert.equal(sayilar.reduce((t, c) => t + c.count, 0), 1, 'Hepsiburada seçiliyken Trendyol sayılmaz');
    assert.equal((await f.req('/ec/orders?sort=kotu')).status, 400);
  } finally { f.close(); }
});
