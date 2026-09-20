// Bounded independent review: synthetic in-memory data only; no network or live writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {performanceReport} from '../src/performance-api.js';
import {orderEstimateApi} from '../src/order-estimate-api.js';
import {aggregateSales, buildSalesPresentation, offeringComposition, salesReturnSummary} from '../src/sales-presentation.js';
import {salesModel} from '../public/performance-ui.js';

const date = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const environment = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const total = (xs, key) => xs.reduce((n, x) => n + x[key], 0);
const history = () => ({shipping: 0, other: 0, commissionRate: 0, withholdingRate: 0,
  source: 'content', n: 1, note: 'Synthetic known zero fees.'});
function fixture() {
  const f = appFixture();
  for (const id of ['a', 'b', 'c']) {
    f.sqlite.prepare("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,'adet')").run(id, id, id);
    f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,0,1000,0,0,0,100,100,100,100,1)').run(id);
  }
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=100000,value_cents=100000');
  f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('fees','trendyol','finance','synthetic',1,'{}',?,'test')")
    .run(JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: 0}));
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('p','trendyol','p','p',?,'draft','review')").run(date);
  return f;
}
function line(f, id, revenue, components, sku = id) {
  f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,sku,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,'p',?,?,?,1000,?,?,0)")
    .run(id, id, sku, id, revenue, revenue);
  for (const [n, product] of components.entries()) {
    f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit) VALUES(?,?,?,1000,?,'adet')")
      .run(id + '-c' + n, id, product, 10000 / components.length);
  }
}
const pending = f => performanceReport(environment(f), {mode: 'pending', from: date, to: date, detay: true, tahmin: history});

test('REVIEW: pending tariff keeps each offering commission even when total cash reconciles', async () => {
  const f = fixture();
  try {
    line(f, 'l1', 10000, ['a'], 'sku-a'); line(f, 'l2', 10000, ['b'], 'sku-b');
    f.sqlite.prepare("INSERT INTO ec_shipping_rates(id,label,channel,carrier,valid_from,valid_to,price_min_cents,billable_min_milli,desi_divisor,billable_step_milli,amount_cents,vat_bps,tax_included,source) VALUES('s','synthetic','trendyol','Test',?,?,0,0,3000,1000,0,0,0,'test')").run(date, date);
    for (const [sku, bps] of [['sku-a', 1000], ['sku-b', 3000]]) {
      f.sqlite.prepare("INSERT INTO ec_commission_rates(id,label,channel,sku,category,valid_from,valid_to,price_min_cents,rate_bps,base,vat_bps,tax_included,source) VALUES(?,?,'trendyol',?,'',?,?,0,?,'gross',0,0,'test')")
        .run(sku, sku, sku, date, date, bps);
    }
    const input = {category: '', carrier: 'Test', date, length_mm: 100, width_mm: 100, height_mm: 100,
      weight_grams: 100, packaging_cents: 0, other_cents: 0, withholding_bps: 0};
    const estimate = await orderEstimateApi(new Request('https://synthetic.test/api/orders/p/estimate', {method: 'POST'}),
      environment(f), '/api/orders/p/estimate', async () => input);
    assert.equal(estimate.quote.status, 'estimated');
    assert.deepEqual(estimate.quote.lines.map(q => q.commission_gross_cents), [1000, 3000]);
    const row = (await pending(f)).rows[0];
    assert.equal(row.cash_cents, 14000);
    assert.equal(total(row.sales_items, 'cash_cents'), row.cash_cents, 'package reconciliation alone passes');
    assert.equal(salesModel([row]).summary.reconciled, true, 'UI also considers the incorrect split reconciled');
    const actual = Object.fromEntries(row.sales_items.map(i => [i.line_ids[0], i.cash_cents]));
    assert.deepEqual(actual, {l1: 8000, l2: 6000}, 'known per-listing commissions must not become one blended rate');
    const compact = await performanceReport(environment(f), {mode: 'pending', from: date, to: date, tahmin: history});
    assert.deepEqual(compact.rows[0].sales_items, row.sales_items, 'compact endpoint preserves listing economics too');
    await orderEstimateApi(new Request('https://synthetic.test/api/orders/p/estimate', {method: 'POST'}),
      environment(f), '/api/orders/p/estimate', async () => ({...input, packaging_cents: 5, withholding_bps: 17}));
    const shared = (await pending(f)).rows[0];
    assert.equal(shared.cash_cents, 13961);
    assert.equal(total(shared.sales_items, 'cash_cents'), shared.cash_cents);
    assert.equal(total(shared.sales_items, 'withholding_cents'), -34);
    assert.deepEqual(Object.fromEntries(shared.sales_items.map(i => [i.line_ids[0], i.cash_cents])),
      {l1: 7980, l2: 5981}, 'only the five shared packaging cents split 3/2; each commission and withholding stays linked');
  } finally { f.close(); }
});

test('REVIEW: pending revenue penny reconciliation must stay within the original offering line', async () => {
  const f = fixture();
  try {
    line(f, 'l1', 10001, ['a', 'b']); line(f, 'l2', 10000, ['c']);
    const row = (await pending(f)).rows[0];
    assert.equal(row.revenue_gross_cents, 20001);
    assert.equal(total(row.sales_items, 'revenue_gross_cents'), 20001);
    assert.equal(salesModel([row]).summary.reconciled, true);
    const actual = Object.fromEntries(row.sales_items.map(i => [i.line_ids[0], i.revenue_gross_cents]));
    assert.deepEqual(actual, {l1: 10001, l2: 10000}, 'rounding a bundle split must not take a penny from another listing');
    assert.deepEqual(Object.fromEntries(row.sales_items.map(i => [i.line_ids[0], i.cash_cents])), {l1: 8001, l2: 9000});
    f.sqlite.exec('UPDATE ec_order_lines SET vat_bps=2000,gross_cents=ROUND(net_revenue_cents*1.2)');
    const vat = (await pending(f)).rows[0];
    assert.equal(vat.revenue_gross_cents, 24001);
    assert.deepEqual(Object.fromEntries(vat.sales_items.map(i => [i.line_ids[0], i.revenue_gross_cents])),
      {l1: 12001, l2: 12000}, 'known line gross boundaries survive odd component VAT cents');
    assert.equal(total(vat.sales_items, 'cash_cents'), vat.cash_cents);
  } finally { f.close(); }
});

function delivered({partial = false, failed = false, unknown = false, technical = false} = {}) {
  const line = {id: 'line', quantity_milli: 1000, vat_bps: 0};
  const part = {id: 'part', line_id: line.id, product_id: 'a', stock_unit: 'adet', quantity_milli: 4000, sale_id: 'sale'};
  const sale = {id: 'sale', parent_id: null, product_id: 'a', kind: 'sale', quantity_milli: 4000,
    revenue_cents: 10001, cost_cents: 6001, shipping_cents: unknown ? null : 101,
    commission_cents: 0, other_cents: 0, satir_kdv: 0, vat_bps: 0};
  const ret = {...sale, id: 'return', parent_id: 'sale', kind: 'return', external_id: technical ? 'DUZELTME-CIFT-review' : 'return',
    quantity_milli: partial ? 1000 : 4000, revenue_cents: partial ? -2500 : -10001,
    cost_cents: partial ? -1500 : -6001, shipping_cents: 0};
  const row = {id: 'p', channel: 'trendyol', delivered_on: date, teslim_edilemedi: failed,
    cash_cents: unknown ? null : partial ? 2896 : -104, revenue_gross_cents: partial ? 7501 : 0,
    cost_gross_cents: partial ? 4501 : 0, withholding_cents: -3};
  buildSalesPresentation(row, [line], [part], [sale, ret], {feeVat: 0});
  return row;
}

test('REVIEW control: partial component returns keep exact components and suppress whole offering quantities', () => {
  const row = delivered({partial: true}), item = row.sales_items[0];
  assert.equal(item.units_milli, null); assert.equal(item.returned_units_milli, null);
  assert.equal(item.sold_units_milli, 1000); assert.equal(item.component_returns[0].quantity_milli, 1000);
  assert.equal(item.partial_return, true); assert.equal(item.per_unit_cents, null);
  assert.equal(item.cash_cents, row.cash_cents);
  assert.equal(item.sold_cash_cents + item.return_cash_cents, item.cash_cents);
  assert.equal(aggregateSales([row]).rows[0].units_milli, null);
});

test('REVIEW control: failed full returns retain residual expenses and technical corrections stay out of return counts', () => {
  const failed = delivered({failed: true}), item = failed.sales_items[0];
  assert.equal(item.units_milli, 0); assert.equal(item.sold_cash_cents, 0);
  assert.equal(item.return_cash_cents, -104); assert.equal(item.cash_cents, -104);
  assert.deepEqual(salesReturnSummary([failed]), {failed_count: 1, returned_count: 0, failed_cash_cents: -104, returned_cash_cents: 0});
  const technical = delivered({technical: true});
  assert.equal(technical.sales_items[0].has_returns, false); assert.equal(technical.sales_items[0].technical_correction, true);
  assert.equal(salesReturnSummary([technical]).returned_count, 0);
});

test('REVIEW control: unknown fees are not ranked as zero and historical identity ignores renamed mappings', () => {
  const row = delivered({unknown: true});
  assert.equal(row.sales_items[0].cash_cents, null); assert.equal(aggregateSales([row]).top.length, 0);
  assert.equal(aggregateSales([row]).rows[0].calculated_cash_cents, null);
  const part = {product_id: 'a', stock_unit: 'adet', quantity_milli: 12000, mapping_id: 'old'};
  const before = offeringComposition({id: 'l', quantity_milli: 3000}, [part], new Map([['a', 'Old']]));
  const after = offeringComposition({id: 'new-line', quantity_milli: 1000},
    [{...part, quantity_milli: 4000, mapping_id: 'new', current_stock_unit: 'litre'}], new Map([['a', 'New']]));
  assert.equal(before.key, after.key); assert.notEqual(before.name, after.name);
});
