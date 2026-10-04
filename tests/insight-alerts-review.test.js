// Independent review: synthetic fixtures only, no network, deploy, or implementation changes.
// Defect regressions intentionally remain red until the owning implementation agent fixes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {aggregateSales, offeringComposition} from '../src/sales-presentation.js';
import {salesAlerts} from '../src/sales-alerts.js';
import {stockDemandQuery, stockAlert, replenishmentAlerts} from '../src/stock-alerts.js';
import {performanceReport} from '../src/performance-api.js';
import {panoramaApi} from '../src/panorama-api.js';
import {warehouseApi} from '../src/warehouse-api.js';
import {fiyatHesapApi} from '../src/fiyat-hesap-api.js';
import {scrubAmounts} from '../src/permission-policy.js';
import {insightCenterMarkup, alertPricingLink} from '../public/insight-alerts-ui.js';
import {alertOfferingMatches} from '../public/fiyat-hesap-ui.js';

const TODAY = '2026-10-04', CHANNEL = 'hepsiburada';
const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const composition = (components, units = 1000) => offeringComposition({id: 'line', quantity_milli: units},
  components.map(([product_id, quantity_milli, stock_unit = 'adet']) => ({product_id, quantity_milli, stock_unit})));
const SINGLE = composition([['p1', 1000]]), SET = composition([['p1', 1000], ['p2', 2000]]);
function row(id, {cash = -1, offset = 0, channel = CHANNEL, order = id, offering = SINGLE, item = {}, ...flags} = {}) {
  const r = {id, channel, order_no: order, status: 'delivered', delivered_on: shift(TODAY, offset),
    occurred_on: shift(TODAY, offset), cash_cents: cash, ...flags};
  r.sales_items = [{...offering, line_ids: [id + '-line'], cash_cents: cash, sold_cash_cents: cash,
    return_cash_cents: 0, units_milli: 1000, sold_units_milli: 1000, returned_units_milli: 0,
    revenue_gross_cents: 1000, cost_gross_cents: 1000, withholding_cents: 0, ...item}];
  // Use the actual aggregate shape carried by performanceReport, not an invented flat sale.
  r.sales_items = aggregateSales([r]).rows;
  return r;
}
const analyze = rows => salesAlerts(rows, {today: TODAY});
const ofType = (r, type = 'price') => r.alerts.filter(a => a.type === type);
const three = (options = {}) => [-2, -1, 0].map((offset, i) => row('order-' + i, {offset, ...options}));

function fixture(t) {
  const f = appFixture(); t.after(() => f.close());
  const env = {...f.env, WORKSPACE: 'ec', USER: {owner: true}, DB: scopedDB(f.env.DB, 'ec')};
  const today = f.sqlite.prepare("SELECT date('now','+3 hours') d").get().d;
  const day = n => shift(today, n);
  for (const ch of ['trendyol', CHANNEL]) {
    f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'review')")
      .run(ch, ch, ch, JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: 0}));
  }
  function product(id, {qty = 100000, unit = 'adet', minimum = 0} = {}) {
    f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit,min_stock_milli) VALUES(?,?,?,?,?)').run(id, id, id, unit, minimum);
    f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,0,1000,0,0,0,100,100,100,500,1)').run(id);
    if (qty) f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,?,'opening',?,?)")
      .run('opening-' + id, id, qty, qty, 'opening-' + id, day(-60));
  }
  function sale(id, productId, {qty = 1000, offset = 0, channel = 'other', revenue = 0, cost = 0, shipping = 0} = {}) {
    f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',?,?,?,0,?,0,'confirmed',?)")
      .run(id, channel, id, productId, qty, revenue, cost, shipping, day(offset));
  }
  function parcel(id, {offset = 0, order = id, channel = CHANNEL, status = 'delivered', lines = [[{id: 'p1'}]]} = {}) {
    f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','review')").run(id, channel, id, order, day(offset));
    for (const [i, parts] of lines.entries()) {
      const lineId = id + '-l' + i, revenue = parts.reduce((n, c) => n + (c.revenue ?? 1000), 0);
      f.sqlite.prepare('INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,1000,?,?,0)')
        .run(lineId, id, lineId, 'Mutable listing', revenue, revenue);
      let remaining = 10000;
      for (const [j, c] of parts.entries()) {
        const saleId = lineId + '-c' + j, q = c.qty ?? 1000;
        const unit = f.sqlite.prepare('SELECT stock_unit FROM ec_products WHERE id=?').get(c.id).stock_unit;
        const share = j === parts.length - 1 ? remaining : Math.floor(10000 / parts.length); remaining -= share;
        sale(saleId, c.id, {qty: q, offset, channel, revenue: c.revenue ?? 1000, cost: c.cost ?? 1000, shipping: c.shipping ?? 1});
        f.sqlite.prepare('INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,?,?,?,?,?)')
          .run(saleId + '-component', lineId, c.id, q, share, saleId, unit);
      }
    }
    f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
    f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(day(offset), id);
    if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(day(offset), id);
  }
  function returned(id, parent, {offset = 0, restock = true, qty, external = id} = {}) {
    const s = f.sqlite.prepare('SELECT * FROM ec_sale_entries WHERE id=?').get(parent), q = qty ?? s.quantity_milli;
    f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) VALUES(?,?,?,?,'return',?,?,?,?,0,0,0,'confirmed',?,?)")
      .run(id, s.channel, external, s.product_id, s.id, q, -Math.round(s.revenue_cents * q / s.quantity_milli),
        restock ? -Math.round(s.cost_cents * q / s.quantity_milli) : 0, +restock, day(offset));
  }
  const settings = id => f.sqlite.prepare('INSERT INTO ec_warehouse_reorder_settings(product_id,lead_days,cover_days,pack_milli) VALUES(?,3,4,1000)').run(id);
  const history = () => env.DB.prepare(stockDemandQuery).all().results;
  const warehouse = () => warehouseApi(new Request('https://review.test/api/ec/warehouse'), env, '/api/warehouse');
  const panorama = () => panoramaApi(new Request('https://review.test/api/ec/panorama'), env, '/api/panorama');
  const report = () => performanceReport(env, {mode: 'delivered', from: day(-40), to: today, detay: true});
  const pace = id => [-6, -5, -4, -3, -2, -1, 0].forEach((offset, i) => sale(id + '-s' + i, id, {offset}));
  return {...f, env, today, day, product, sale, parcel, returned, settings, history, warehouse, panorama, report, pace};
}

test('R01 aggregate rows: one-cent losses require three distinct same-channel orders, not offering line counts', () => {
  const a = row('split-a', {order: 'one'}), b = row('split-b', {order: 'one'}), c = row('second');
  assert.equal(a.sales_items[0].packages, 1);
  assert.equal(ofType(analyze([a, b, c])).length, 0);
  assert.equal(ofType(analyze([a, b, c, row('third-other-channel', {channel: 'trendyol'})])).length, 0);
  const result = analyze([a, b, c, row('third')]), alert = ofType(result)[0];
  assert.equal(alert.orders, 3); assert.equal(alert.occurrences, 3); assert.equal(alert.net_cents, -4);
  assert.deepEqual(analyze([c, a, structuredClone(a), b, row('third')]).alerts, result.alerts);
});

test('R02 newest split order recovery suppresses stale price advice even when its negative parcel sorts first', () => {
  const history = three({offset: -3});
  const recovered = [row('00-loss', {cash: -50, order: 'recovered'}), row('99-profit', {cash: 51, order: 'recovered'})];
  assert.equal(ofType(analyze([...history, ...recovered])).length, 0);
  assert.equal(ofType(analyze([...history, ...recovered].reverse())).length, 0);
});

test('R03 select the last five orders after grouping many packages, preserving their entire signed totals', () => {
  const rows = [-5, -4, -3, -2, -1].map((offset, i) => row('older-' + i, {offset, cash: i < 3 ? -10 : 1}));
  for (let i = 0; i < 12; i++) rows.push(row('parcel-' + i, {order: 'latest', cash: -1}));
  const [a] = ofType(analyze(rows));
  assert.equal(a.orders, 5); assert.equal(a.occurrences, 3); assert.equal(a.net_cents, -30);
  assert.equal(a.samples.find(s => s.order_no === 'latest').package_ids.length, 12);
  assert.ok(!a.samples.some(s => s.order_no === 'older-0'));
});

test('R04 a later unknown aggregate occupies an order slot and cannot resurrect older losses', () => {
  const rows = three({offset: -7});
  rows.push(row('recovered-1', {offset: -2, cash: 100}), row('recovered-2', {offset: -1, cash: 100}),
    row('latest-unknown', {cash: null, item: {missing: 1}}));
  const r = analyze(rows);
  assert.equal(ofType(r).length, 0); assert.equal(r.status, 'incomplete'); assert.ok(r.coverage.unknown_recent_orders > 0);
});

test('R05 split order at the 30-day boundary cannot discard its profitable sibling and become a loss', () => {
  const rows = [row('loss-a', {offset: -2}), row('loss-b', {offset: -1}),
    row('split-old-profit', {order: 'boundary-order', offset: -30, cash: 101}),
    row('split-current-loss', {order: 'boundary-order', cash: -100})];
  assert.equal(ofType(analyze(rows)).length, 0,
    'latest order is +1 overall; aggregate its sibling or mark the order incomplete before advising a price rise');
});

test('R06 unknown older sibling across the 30-day boundary cannot become known by date filtering', () => {
  const rows = [row('loss-a', {offset: -2}), row('loss-b', {offset: -1}),
    row('split-old-unknown', {order: 'boundary-order', offset: -30, cash: null}),
    row('split-current-loss', {order: 'boundary-order', cash: -1})];
  assert.equal(ofType(analyze(rows)).length, 0, 'unknown order total must not be presented as a confirmed recurring loss');
});

test('R07 real mixed-offering packages: returning one set component counts one set exception and never standalone component losses', async t => {
  const f = fixture(t); f.product('p1'); f.product('p2');
  for (let i = 0; i < 3; i++) {
    f.parcel('mixed-' + i, {offset: i - 2, lines: [[{id: 'p1'}, {id: 'p2', qty: 2000}], [{id: 'p1', revenue: 2000}]]});
    f.returned('return-' + i, 'mixed-' + i + '-l0-c1', {qty: 1000});
  }
  const report = await f.report(), r = salesAlerts(report.rows, {today: f.today});
  const [a] = ofType(r, 'returns'); assert.equal(ofType(r).length, 0); assert.equal(ofType(r, 'returns').length, 1);
  assert.equal(a.kind, 'bundle'); assert.equal(a.occurrences, 3); assert.equal(a.key, SET.key);
  assert.equal(a.components.length, 2); assert.equal(a.loss_cents, 0);
  const item = report.rows[0].sales_items.find(x => x.kind === 'bundle');
  assert.equal(item.return_packages, 1); assert.equal(item.partial_returns, 1); assert.equal(item.units_milli, null);
  assert.equal(report.rows[0].sales_items.find(x => x.kind === 'single').has_returns, false);
});

test('R08 actual panorama must not announce future customer returns as already recurring', async t => {
  const f = fixture(t); f.product('p1');
  for (let i = 0; i < 3; i++) {
    f.parcel('future-return-' + i, {offset: i - 2});
    f.returned('future-refund-' + i, 'future-return-' + i + '-l0-c0', {offset: 1});
  }
  const p = await f.panorama();
  assert.equal(ofType(p.sales_alerts, 'returns').length, 0, 'tomorrow is outside the current evidence window');
  assert.equal(ofType(p.sales_alerts, 'delivery').length, 0);
});

test('R09 real split packages with the same order number stay one order, while the same number on another channel stays separate', async t => {
  const f = fixture(t); f.product('p1');
  f.parcel('a', {order: 'shared'}); f.parcel('b', {order: 'shared'}); f.parcel('c', {order: 'second'});
  f.parcel('d', {order: 'shared', channel: 'trendyol'});
  const p = await f.panorama();
  assert.equal(ofType(p.sales_alerts).length, 0); assert.equal(p.sales_alerts.coverage.orders, 3);
});

test('R10 price deeplink resolves real active channel mappings by canonical content, despite reordered components and renamed listings', async t => {
  const f = fixture(t); f.product('p1'); f.product('p2');
  for (const [id, channel, q] of [['right', CHANNEL, 2000], ['wrong-channel', 'trendyol', 2000], ['wrong-size', CHANNEL, 1000]]) {
    f.sqlite.prepare("INSERT INTO ec_catalog_mappings(id,source,match_value,external_code,external_name,version) VALUES(?,?,?,?,?,1)")
      .run(id, channel, id, id, 'Renamed listing ' + id);
    f.sqlite.prepare('INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES(?,?,?,?,5000)')
      .run(id + '-p2', id, 'p2', q);
    f.sqlite.prepare('INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES(?,?,?,?,5000)')
      .run(id + '-p1', id, 'p1', 1000);
    f.sqlite.prepare('UPDATE ec_catalog_mappings SET active=1 WHERE id=?').run(id);
  }
  const [a] = ofType(analyze(three({offering: SET})));
  const link = alertPricingLink(a), params = new URLSearchParams(link.split('?')[1]);
  assert.ok(link.startsWith('#pricing?')); assert.equal(params.get('offering_key'), SET.key);
  const options = await fiyatHesapApi(new Request('https://review.test/api/ec/fiyat-hesap?mode=options'), f.env, '/api/fiyat-hesap');
  assert.deepEqual(options.offerings.filter(o => alertOfferingMatches(o, params.get('offering_key'), params.get('channel'))).map(o => o.id), ['right']);
  assert.equal(alertOfferingMatches({...options.offerings.find(o => o.id === 'right'),
    components: [{product_id: 'p1', quantity_milli: 1000, stock_unit: 'kg'}, {product_id: 'p2', quantity_milli: 2000, stock_unit: 'adet'}]}, SET.key, CHANNEL), false);
});

test('R11 rational canonical keys round-trip quantities without collapsing a multipack to one stock item', () => {
  for (const n of [1, 2, 4, 17]) {
    const canonical = composition([['p1', n * 3000]], 3000);
    assert.equal(alertOfferingMatches({channel: CHANNEL, components: [{product_id: 'p1', quantity_milli: n * 1000, stock_unit: 'adet'}]}, canonical.key, CHANNEL), true);
    if (n !== 1) assert.equal(alertOfferingMatches({channel: CHANNEL, components: [{product_id: 'p1', quantity_milli: 1000, stock_unit: 'adet'}]}, canonical.key, CHANNEL), false);
  }
});

test('R12 amount-denied staff get no sales_alerts object, names, kinds, occurrence counts or samples over the actual worker API', async t => {
  const f = fixture(t); f.product('p1');
  for (let i = 0; i < 3; i++) f.parcel('private-loss-' + i, {offset: i - 2});
  await f.setup();
  const owner = await f.ok('/ec/panorama'); assert.ok(owner.sales_alerts.alerts.length > 0, 'positive control: owner sees the signal');
  const staff = await f.ok('/admin/users', {name: 'Review reader', username: 'review-reader',
    permissions: {ec: {performance: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
  const accept = await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'review-only-password'});
  assert.equal(accept.status, 200);
  const login = await f.req('/auth/login', {username: 'review-reader', password: 'review-only-password'}); assert.equal(login.status, 200);
  const r = await f.req('/ec/panorama', undefined, login.cookie);
  assert.equal(r.status, 200); assert.equal(r.data.sales_alerts, null);
  assert.equal(JSON.stringify(r.data).includes('recurring_loss'), false);
  assert.equal(JSON.stringify(r.data).includes('sales-alert:v1:'), false);
  const nested = {sales_alerts: owner.sales_alerts, wrapper: {sales_alerts: owner.sales_alerts}, quantity_milli: 5000};
  const scrubbed = scrubAmounts(nested, {ec_access: 'read', permissions: {ec: {amounts: 'none'}}}, 'ec');
  assert.equal(scrubbed.sales_alerts, null); assert.equal(scrubbed.wrapper.sales_alerts, null);
  assert.equal(scrubbed.quantity_milli, 5000); assert.ok(owner.sales_alerts.alerts.length > 0, 'scrubbing does not mutate owner evidence');
});

test('R13 non-restocking refunds preserve physical demand; a real restock changes it once on its actual day', async t => {
  const f = fixture(t); f.product('p1', {qty: 20000}); f.pace('p1'); f.settings('p1');
  f.returned('refund-only', 'p1-s0', {restock: false});
  let h = f.history()[0]; assert.equal(h.demand_7_milli, 7000); assert.equal(h.nonrestocked_30_milli, 1000);
  let a = (await f.warehouse()).replenishment.alerts.find(a => a.product_id === 'p1');
  // Availability is ample; inspect the pure projection if the low-stock filter correctly omits it.
  const w = await f.warehouse(); a ||= stockAlert(w.stock[0], {lead_days: 3, cover_days: 4}, h);
  assert.equal(a.available_milli, 13000); assert.equal(a.daily_demand_milli, 1000);
  f.returned('physical-restock', 'p1-s1');
  h = f.history()[0]; assert.equal(h.demand_7_milli, 6000); assert.equal(h.restocked_7_milli, 1000);
  assert.equal((await f.warehouse()).stock[0].available_milli, 14000);
});

test('R14 future returns cannot silently inflate present availability and extend the stock runway', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  const before = await f.warehouse(); assert.equal(before.stock[0].available_milli, 5000);
  f.returned('tomorrow-stock', 'p1-s0', {offset: 1});
  const after = await f.warehouse(), h = f.history()[0];
  assert.equal(h.demand_7_milli, 7000, 'future restock must not lower current demand');
  const a = stockAlert(after.stock[0], {lead_days: 3, cover_days: 4}, h);
  assert.ok(after.stock[0].available_milli === 5000 || (a.days_remaining === null && a.suggested_milli === null && after.replenishment.coverage.status === 'incomplete'),
    'exclude future stock credit, or disclose incomplete availability; a confident six-day projection is incorrect');
});

test('R15 a restock dated before its parent sale must invalidate projected days and purchase quantity', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  f.returned('impossible-return', 'p1-s6', {offset: -1});
  const w = await f.warehouse(), h = f.history()[0];
  const a = stockAlert(w.stock[0], {lead_days: 3, cover_days: 4}, h);
  assert.equal(a.history_status, 'incomplete', 'return before the physical sale is contradictory evidence, not clean demand');
  assert.equal(a.days_remaining, null); assert.equal(a.suggested_milli, null);
});

test('R16 a backdated refund of an older sale reduces only its actual return-day window', () => {
  const f = appFixture();
  try {
    const day = n => f.sqlite.prepare("SELECT date('now','+3 hours',?) d").get(n + ' days').d;
    f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p','p','p','adet'); UPDATE ec_stock_balances SET quantity_milli=50000,value_cents=50000");
    f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('old','other','old','p','sale',4000,0,0,'confirmed',?)").run(day(-20));
    f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,fees_status,restock,occurred_on) VALUES('backdated','other','backdated','p','return','old',1000,0,0,'confirmed',1,?)").run(day(-10));
    const h = scopedDB(f.env.DB, 'ec').prepare(stockDemandQuery).all().results[0];
    assert.equal(h.restocked_7_milli, 0); assert.equal(h.restocked_previous_7_milli, 1000);
    assert.equal(h.demand_30_milli, 3000); assert.equal(h.issue_count, 0);
  } finally { f.close(); }
});

test('R17 mixed-unit set consumption, archived products and transit retain separate physical quantities', async t => {
  const f = fixture(t); f.product('bottle', {qty: 12000}); f.product('soil', {qty: 5000, unit: 'kg'}); f.product('archived', {qty: 5000});
  f.sqlite.exec("UPDATE ec_products SET archived_at=CURRENT_TIMESTAMP WHERE id='archived'");
  for (let i = 0; i < 3; i++) f.parcel('set-' + i, {offset: i - 2, status: 'shipped',
    lines: [[{id: 'bottle', qty: 2000, cost: 0}, {id: 'soil', qty: 250, cost: 0}]]});
  const w = await f.warehouse(), rows = new Map(w.stock.map(x => [x.id, x])), h = new Map(f.history().map(x => [x.product_id, x]));
  assert.equal(h.get('bottle').demand_30_milli, 6000); assert.equal(h.get('soil').demand_30_milli, 750);
  assert.equal(rows.get('bottle').available_milli, 6000); assert.equal(rows.get('bottle').in_transit_milli, 6000);
  assert.equal(rows.get('soil').available_milli, 4250); assert.equal(rows.get('soil').in_transit_milli, 750);
  assert.equal(h.has('archived'), false); assert.ok(!w.replenishment.alerts.some(x => x.product_id === 'archived'));
  assert.equal(w.replenishment.coverage.excluded_archived_products, 1);
});

test('R18 a replenishment receipt immediately clears the low-stock recommendation, without changing measured sales pace', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  const before = await f.warehouse(); assert.equal(before.replenishment.alerts.find(a => a.product_id === 'p1').days_remaining, 5);
  f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('recovery','p1',20000,20000,'purchase','recovery',?)").run(f.day(0));
  const after = await f.warehouse();
  assert.equal(after.stock[0].available_milli, 25000); assert.equal(f.history()[0].demand_7_milli, 7000);
  assert.ok(!after.replenishment.alerts.some(a => a.product_id === 'p1'));
  assert.equal(after.replenishment.proposals.find(a => a.product_id === 'p1').suggested_milli, 0);
});

test('R19 brand-only stock never manufactures a vendor; unknown history cannot become verified all-clear', async t => {
  const f = fixture(t); f.product('p1', {qty: 1000, minimum: 2000}); f.sqlite.exec("UPDATE ec_products SET brand='NOT-A-SUPPLIER' WHERE id='p1'");
  const w = await f.warehouse(), a = w.replenishment.alerts.find(a => a.product_id === 'p1');
  assert.ok(a, 'the real minimum-stock shortfall, not absent history alone, merits a quantity alert');
  assert.equal(a.supplier_id, null); assert.equal(a.supplier_name, null); assert.equal(a.suggested_milli, null);
  assert.equal(a.days_remaining, null); assert.ok(a.reason_codes.includes('no_history'));
  assert.equal(w.replenishment.coverage.history_completeness, 'unverified');
  assert.doesNotMatch(insightCenterMarkup({sales: {data: analyze([])}, stock: {data: w}}), /NOT-A-SUPPLIER için tedarik/);
});

test('R20 incomplete stock coverage must not render the checked-all-clear empty state', () => {
  const html = insightCenterMarkup({sales: {data: analyze([])}, stock: {data: {
    alerts: [], coverage: {status: 'incomplete', history_completeness: 'unverified'},
    notices: [{code: 'incomplete_history', message: 'Sevk / stok hareketi bağlantısı eksik.'}]
  }}});
  const empty = html.match(/<p class="signal-empty">([^<]*)<\/p>/)?.[1];
  assert.ok(empty); assert.doesNotMatch(empty, /Kontrol edilen kayıtlarda uyarı eşiğine ulaşan durum yok/);
  assert.match(html, /(?:stok|sevk)[^<]*eksik/i);
});

test('R21 estimated-fee suppression must be visible instead of claiming the assessed sales are all clear', () => {
  const sales = analyze(three({fees_estimated: true, fees_from_history: true}));
  assert.equal(sales.status, 'incomplete'); assert.equal(sales.coverage.insufficient_evidence_packages, 3);
  assert.equal(ofType(sales).length, 0);
  const html = insightCenterMarkup({sales: {data: sales}, stock: {data: {alerts: [], coverage: {status: 'empty'}}}});
  const empty = html.match(/<p class="signal-empty">([^<]*)<\/p>/)?.[1];
  assert.ok(empty); assert.doesNotMatch(empty, /Kontrol edilen kayıtlarda uyarı eşiğine ulaşan durum yok/);
  assert.match(html, /Bazı satışlar eksik veya tahmini kayıtlar nedeniyle fiyat önerisine alınmadı/);
});

test('R22 a known incomplete shipment suppresses days and quantities in both the alert and its linked replenishment proposal', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  f.parcel('changed-source', {status: 'shipped', lines: [[{id: 'p1', cost: 0}]]});
  f.sqlite.exec("UPDATE ec_order_packages SET source_changed=1 WHERE id='changed-source'; UPDATE ec_warehouse_reorder_settings SET lead_days=30 WHERE product_id='p1'");
  const w = await f.warehouse(), a = w.replenishment.alerts.find(a => a.product_id === 'p1'), p = w.replenishment.proposals.find(a => a.product_id === 'p1');
  assert.equal(a.history_status, 'incomplete'); assert.equal(a.days_remaining, null); assert.equal(a.suggested_milli, null);
  assert.equal(p.suggested_milli, null, 'following the alert must not restore a definite purchase quantity from the same rejected history');
});

test('R23 partial input to the pure stock evaluator remains visible even without a matching history row', () => {
  const result = replenishmentAlerts([{id: 'missing', name: 'Missing', sku: 'missing', available_milli: 5000,
    stock_unit: 'adet', min_stock_milli: 0}], [{product_id: 'missing', lead_days: 3}], []);
  assert.equal(result.coverage.status, 'incomplete');
  const a = stockAlert({id: 'missing', name: 'Missing', available_milli: 5000, stock_unit: 'adet'}, {lead_days: 3});
  assert.equal(a.days_remaining, null); assert.equal(a.suggested_milli, null); assert.ok(result.notices.some(n => n.code === 'incomplete_history'));
});


test('R24 date-only same-day recovery prevents asserting that the latest order was a loss', () => {
  const rows = [
    row('a-loss', {cash: -100}), row('b-loss', {cash: -100}), row('c-loss', {cash: -100}),
    row('z-profitable', {cash: 1})
  ];
  assert.equal(ofType(analyze(rows)).length, 0,
    'four same-day deliveries include a profit; lexical IDs cannot prove which order was latest');
  assert.equal(ofType(analyze([...rows].reverse())).length, 0);
});

test('R25 last-five membership cannot discard a same-day large profit merely because its order ID sorts sixth', () => {
  const rows = [
    row('a-loss', {cash: -100}), row('b-loss', {cash: -100}), row('c-loss', {cash: -100}),
    row('d-profit', {cash: 1}), row('e-profit', {cash: 1}), row('z-large-profit', {cash: 1000})
  ];
  assert.equal(ofType(analyze(rows)).length, 0,
    'possible last-five samples have positive net; a UUID tie-break is not evidence for negative net');
});

test('R26 a mixed-result tie at the fifth-order cutoff blocks recurrence even when the latest loss is known', () => {
  const rows = [row('newest-loss'), row('second-loss', {offset: -1}),
    row('a-boundary-loss', {offset: -2, cash: -100}),
    row('b-boundary-win', {offset: -2, cash: 1}),
    row('c-boundary-win', {offset: -2, cash: 1}),
    row('z-boundary-win', {offset: -2, cash: 1000})];
  assert.equal(ofType(analyze(rows)).length, 0,
    'a valid ordering puts all three wins in the last five and leaves only two losses');
});

test('R27 actual panorama cannot lose the older profitable fragment of a split order at the 30-day boundary', async t => {
  const f = fixture(t); f.product('p1');
  f.parcel('ordinary-a', {offset: -2}); f.parcel('ordinary-b', {offset: -1});
  f.parcel('split-earlier', {offset: -30, order: 'boundary', lines: [[{id: 'p1', revenue: 1101, shipping: 0}]]});
  f.parcel('split-later', {order: 'boundary', lines: [[{id: 'p1', shipping: 100}]]});
  const p = await f.panorama();
  assert.equal(ofType(p.sales_alerts).length, 0, 'latest distinct order nets +1 once both authoritative parcels are considered');
});

test('R28 a future technical correction cannot restate current demand or silently restore current available stock', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  f.returned('future-technical', 'p1-s0', {offset: 1, external: 'DUZELTME-CIFT-future'});
  const w = await f.warehouse(), h = f.history()[0], a = stockAlert(w.stock[0], {lead_days: 3, cover_days: 4}, h);
  assert.equal(h.demand_7_milli, 7000); assert.equal(h.restocked_7_milli, 0);
  assert.ok(w.stock[0].available_milli === 5000 || a.days_remaining === null && a.suggested_milli === null,
    'technical prefix must not bypass future-movement uncertainty');
});

test('R29 reversing a stale duplicate sale restores physical stock without subtracting its units from current demand again', async t => {
  const f = fixture(t); f.product('p1', {qty: 21000}); f.pace('p1'); f.settings('p1');
  f.sale('old-copy', 'p1', {qty: 9000, offset: -40});
  assert.equal((await f.warehouse()).stock[0].available_milli, 5000);
  f.returned('undo-old-copy', 'old-copy', {external: 'DUZELTME-CIFT-old-copy'});
  const h = f.history()[0], w = await f.warehouse();
  assert.equal(h.demand_7_milli, 7000); assert.equal(h.demand_30_milli, 7000);
  assert.equal(h.restocked_7_milli, 0); assert.equal(h.active_sales_days_7, 7);
  assert.equal(w.stock[0].available_milli, 14000);
  assert.ok(!w.replenishment.alerts.some(a => a.product_id === 'p1' && ['low', 'reorder'].includes(a.type)));
});

test('R30 a technical correction predating its parent sale is contradictory evidence, even if its stock movement exists', async t => {
  const f = fixture(t); f.product('p1', {qty: 12000}); f.pace('p1'); f.settings('p1');
  f.returned('impossible-technical', 'p1-s6', {offset: -1, external: 'DUZELTME-IKAME-backdated'});
  const w = await f.warehouse(), h = f.history()[0], a = stockAlert(w.stock[0], {lead_days: 3, cover_days: 4}, h);
  assert.equal(a.history_status, 'incomplete');
  assert.equal(a.days_remaining, null); assert.equal(a.suggested_milli, null);
});
