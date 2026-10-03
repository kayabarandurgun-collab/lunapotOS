// Synthetic financial regression fixtures; no live reads, writes, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {performanceReport} from '../src/performance-api.js';
import {kesintiTahmincisi} from '../src/fee-history.js';

const DATE = '2026-09-20';
const sql = (f, s, ...args) => f.sqlite.prepare(s).run(...args);
function setup(f, vats = [2000, 2000, 2000, 2000]) {
  vats.forEach((vat, i) => {
    const id = 'p' + i;
    sql(f, 'INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,?)', id, 'Sentetik ürün ' + i, id, 'adet');
    if (vat !== null) sql(f, 'INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,10000,0,0,0,100,100,100,500,1)', id, vat);
  });
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=100000000,value_cents=1000000000');
  sql(f, "INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('fees','trendyol','finance','rebuild',1,'{}',?,'test')", JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: 2000}));
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','trendyol','st','Synthetic'); INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','finance','synthetic.xlsx',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-09-20T00:00','S','[]',1,1,'applied','test')");
}
function pack(f, id, parts, {status = 'delivered', separate = false, vat = 2000} = {}) {
  sql(f, "INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'trendyol',?,?,?,'draft','test')", id, id, id, DATE);
  const groups = separate ? parts.map(c => [c]) : [parts];
  groups.forEach((cs, i) => {
    const lid = id + '-l' + i, rev = cs.reduce((n, c) => n + (c.revenue ?? 20000), 0);
    sql(f, 'INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,1000,?,?,?)', lid, id, lid, 'Synthetic offering', rev, Math.round(rev * (10000 + vat) / 10000), vat);
    let remainder = 10000;
    cs.forEach((c, j) => {
      const cid = lid + '-c' + j, sid = cid + '-s', share = j === cs.length - 1 ? remainder : Math.floor(10000 / cs.length);
      remainder -= share;
      if (!['draft', 'reserved'].includes(status)) sql(f, "INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,'trendyol',?,?,'sale',1000,?,?,?,?,?,?,?)", sid, sid, c.id, c.revenue ?? 20000, c.cost ?? 10000, c.commission === undefined ? 0 : c.commission, c.shipping === undefined ? 0 : c.shipping, c.other === undefined ? 0 : c.other, c.fees_status || (c.shipping === null || c.other === null || c.commission === null ? 'pending' : 'confirmed'), DATE);
      sql(f, 'INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,?,1000,?,?,?)', cid, lid, c.id, share, ['draft', 'reserved'].includes(status) ? null : sid, 'adet');
    });
  });
  if (status !== 'draft') sql(f, "UPDATE ec_order_packages SET status='reserved' WHERE id=?", id);
  if (!['draft', 'reserved'].includes(status)) sql(f, "UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?", DATE, id);
  if (status === 'delivered') sql(f, "UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?", DATE, id);
}
function event(f, order, type, cents) {
  const id = order + '-' + type;
  sql(f, "INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,'st','finance_event',?,'provider',?,'2026-09-20T00:00','fl',1)", id, id, JSON.stringify({order_no: order, type, amount_cents: cents}));
}
const report = (f, options = {}) => performanceReport({...f.env, DB: scopedDB(f.env.DB, 'ec'), WORKSPACE: 'ec'}, {mode: 'delivered', from: DATE, to: DATE, detay: true, ...options});
const history = () => ({shipping: 0, other: 0, commissionRate: 0, withholdingRate: 0, source: 'content', n: 1, note: 'Sentetik doğrulanmış örnek.', uyum: 'ayni'});
const total = (xs, field) => xs.reduce((n, x) => n + x[field], 0);
function conserved(row) {
  for (const field of ['cash_cents', 'revenue_gross_cents', 'cost_gross_cents', 'withholding_cents']) if (Number.isSafeInteger(row[field])) assert.equal(total(row.sales_items, field), row[field], 'offering conservation: ' + field);
  if (row.urunler) assert.equal(total(row.urunler, 'cash_cents'), row.cash_cents, 'stock component conservation');
}

for (const status of ['reserved', 'shipped']) test('FB01 ' + status + ': mixed purchase VAT uses each stock component; delivery does not invent a cost change', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [1000, 2000]);
    pack(f, 'pending', [{id: 'p0'}, {id: 'p1'}], {status, separate: true});
    const row = (await report(f, {mode: 'pending', tahmin: history})).rows[0];
    assert.equal(row.cost_net_cents, 20000);
    assert.equal(row.cost_gross_cents, 23000, '100 TL + 10% and 100 TL + 20% = 230 TL, not 240 TL');
    assert.equal(row.cash_cents, 25000); conserved(row);
    assert.equal(row.sales_items.find(i => i.components[0].product_id === 'p0').cost_gross_cents, 11000);
    assert.equal(row.sales_items.find(i => i.components[0].product_id === 'p1').cost_gross_cents, 12000);
    assert.equal(row.urunler.find(u => u.product_id === 'p0').cash_cents, 13000);
    assert.equal(row.urunler.find(u => u.product_id === 'p1').cash_cents, 12000);
    if (status === 'shipped') {
      sql(f, "UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id='pending'", DATE);
      const delivered = (await report(f)).rows[0];
      assert.equal(delivered.cost_gross_cents, row.cost_gross_cents); assert.equal(delivered.cash_cents, row.cash_cents); conserved(delivered);
    }
  } finally { f.close(); }
});

test('FB01: unknown purchase VAT stays unknown instead of borrowing the sale VAT', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [null]); pack(f, 'unknown-vat', [{id: 'p0'}], {status: 'shipped'});
    const row = (await report(f, {mode: 'pending', tahmin: history})).rows[0];
    assert.equal(row.cash_cents, null); assert.match(row.cash_note, /KDV/);
    assert.equal(row.sales_items[0].cash_cents, null);
  } finally { f.close(); }
});

test('FB02: estimated parcel fees conserve every cent across three stock components', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'fees', [0, 1, 2].map(i => ({id: 'p' + i, shipping: null, other: null})));
    const row = (await report(f, {tahmin: () => ({...history(), shipping: 2, other: 2})})).rows[0];
    assert.equal(row.shipping_cents, 2, 'three independently rounded shares must not turn 2 kuruş into 3');
    assert.equal(row.other_cents, 2); assert.equal(row.profit_cents, 30000 - 4); conserved(row);
    assert.equal(row.fees_from_history, true);
  } finally { f.close(); }
});

test('FB03: distributing 2 kuruş withholding to four equal offerings never creates a tax credit on the last item', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'stopaj', [0, 1, 2, 3].map(i => ({id: 'p' + i})), {separate: true}); event(f, 'stopaj', 'withholding', -2);
    const row = (await report(f)).rows[0]; conserved(row);
    assert.equal(row.withholding_cents, -2);
    assert.ok(row.sales_items.every(i => i.withholding_cents <= 0), JSON.stringify(row.sales_items.map(i => i.withholding_cents)));
    assert.ok(row.urunler.every(u => u.cash_cents <= 12000), 'withholding cannot increase any product cash result');
    assert.deepEqual(row.sales_items.map(i => i.withholding_cents).sort((a, b) => a - b), [-1, -1, 0, 0]);
  } finally { f.close(); }
});

test('FB04: legacy breakeven quote must not lose one kuruş after separate commission and withholding rounding', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [2000]); sql(f, "UPDATE ec_price_profiles SET replacement_cost_cents=39 WHERE product_id='p0'");
    pack(f, 'rate', [{id: 'p0', revenue: 10000, commission: 500}]); event(f, 'rate', 'sale', 12000); event(f, 'rate', 'withholding', -120);
    const r = await f.req('/ec/fiyat-hesap?product_id=p0&channel=trendyol&qty=1&price=0.50&target=0.94');
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.fiyatla.cebine, -1, 'the actual breakdown at 50 kuruş loses 1 kuruş');
    assert.ok(r.data.basabas.cebine >= 0, JSON.stringify(r.data.basabas));
    assert.ok(r.data.hedef.cebine >= 94, JSON.stringify(r.data.hedef));
    assert.equal(r.data.basabas.fiyat, 51, '51 kuruş reaches breakeven, 50 does not');
  } finally { f.close(); }
});

test('FB05: filled but unconfirmed fees must not train a supposedly real delivered-history estimate', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [2000]); pack(f, 'unconfirmed', [{id: 'p0', shipping: 10000, fees_status: 'pending'}]);
    const estimate = await kesintiTahmincisi(f.env.DB);
    assert.equal(estimate('trendyol', [{product_id: 'p0', quantity_milli: 1000}]), null);
    sql(f, "UPDATE ec_sale_entries SET fees_status='confirmed' WHERE id='unconfirmed-l0-c0-s'");
    const confirmed = await kesintiTahmincisi(f.env.DB);
    assert.equal(confirmed('trendyol', [{product_id: 'p0', quantity_milli: 1000}]).shipping, 10000);
  } finally { f.close(); }
});
async function tariff(f, id) {
  const common = {label: 'Synthetic', channel: 'trendyol', valid_from: '2026-01-01', valid_to: '2026-12-31', price_min_cents: 0, price_max_cents: null, vat_bps: 2000, tax_included: false, source: 'Synthetic'};
  await f.ok('/ec/pricing/shipping', {...common, carrier: 'Test', billable_min_milli: 0, billable_max_milli: null, desi_divisor: 3000, billable_step_milli: 1000, amount_cents: 0});
  await f.ok('/ec/pricing/commissions', {...common, sku: '', category: '', rate_bps: 0, base: 'gross'});
  const quote = await f.ok('/ec/orders/' + id + '/estimate', {category: '', carrier: 'Test', date: DATE, length_mm: 100, width_mm: 100, height_mm: 100, weight_grams: 1000, packaging_cents: 0, other_cents: 0, withholding_bps: 0});
  assert.equal(quote.quote.status, 'estimated', JSON.stringify(quote)); return quote;
}
for (const status of ['reserved', 'shipped']) test('FB01 tariff ' + status + ': known mixed purchase VAT remains component-specific in saved scenarios', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [1000, 2000]); pack(f, 'tariff', [{id: 'p0'}, {id: 'p1'}], {status, separate: true});
    await tariff(f, 'tariff'); const row = (await report(f, {mode: 'pending'})).rows[0];
    assert.equal(row.cost_gross_cents, 23000); assert.equal(row.cash_cents, 25000); conserved(row);
    assert.equal(row.sales_items.find(i => i.components[0].product_id === 'p0').cost_gross_cents, 11000);
  } finally { f.close(); }
});

test('FB02: a known part of a parcel fee is subtracted before distributing the unknown remainder', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'partial-fees', [{id: 'p0', shipping: 7}, {id: 'p1', shipping: null}]);
    const row = (await report(f, {tahmin: () => ({...history(), shipping: 10})})).rows[0];
    assert.equal(row.shipping_cents, 10, 'known 7 plus unknown estimate 3, not 7+5'); conserved(row);
    assert.equal(f.sqlite.prepare("SELECT shipping_cents FROM ec_sale_entries WHERE id='partial-fees-l0-c1-s'").get().shipping_cents, null, 'the estimate never mutates the immutable ledger');
  } finally { f.close(); }
});

test('FB02: an actual fee larger than history is retained without inventing a negative missing fee', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'high-fees', [{id: 'p0', shipping: 15}, {id: 'p1', shipping: null}]);
    const row = (await report(f, {tahmin: () => ({...history(), shipping: 10})})).rows[0];
    assert.equal(row.shipping_cents, 15); assert.equal(row.fees_estimated, true); conserved(row);
  } finally { f.close(); }
});
for (const status of ['reserved', 'shipped']) test('FB01 tariff guard ' + status + ': explicit unknown-VAT scenario keeps its assumption and component allocations', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [null, 2000]); pack(f, 'tariff-unknown', [{id: 'p0'}, {id: 'p1'}], {status, separate: true});
    await tariff(f, 'tariff-unknown'); const row = (await report(f, {mode: 'pending'})).rows[0];
    assert.match(row.cash_note, /varsayımı/); assert.equal(row.cost_gross_cents, 24000); conserved(row);
    assert.ok(row.sales_items.every(i => i.cost_gross_cents === 12000), 'the unknown VAT scenario must not move its whole cost onto another offering');
  } finally { f.close(); }
});

test('FB01 tariff guard: a zero-valued current stock lot does not switch to a replacement price in the cash breakdown', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, [2000]); sql(f, "UPDATE ec_stock_balances SET value_cents=0 WHERE product_id='p0'");
    pack(f, 'tariff-zero', [{id: 'p0'}], {status: 'reserved'}); await tariff(f, 'tariff-zero');
    const row = (await report(f, {mode: 'pending'})).rows[0];
    assert.equal(row.cost_net_cents, 0); assert.equal(row.cost_gross_cents, 0); conserved(row);
  } finally { f.close(); }
});
