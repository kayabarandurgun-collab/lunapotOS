// Synthetic fixtures only; no live database or marketplace calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {panoramaApi} from '../src/panorama-api.js';
import {performanceReport} from '../src/performance-api.js';
import {offeringComposition} from '../src/sales-presentation.js';
import {salesAlerts} from '../src/sales-alerts.js';

const TODAY = '2026-10-04';
const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const composition = (ids = ['p1'], quantity = 1000) => offeringComposition({id: 'line', quantity_milli: 1000},
  ids.map(id => ({product_id: id, stock_unit: 'adet', quantity_milli: quantity})), new Map([['p1', 'Plant food'], ['p2', 'Soil']]));
const SINGLE = composition(), SET = composition(['p1', 'p2']);
function row(id, {cash = -10, date = TODAY, channel = 'hepsiburada', order = id, offering = SINGLE, item = {}, ...flags} = {}) {
  return {id, channel, order_no: order, delivered_on: date, occurred_on: date, status: 'delivered', cash_cents: cash,
    sales_items: [{...offering, line_ids: [id + '-line'], cash_cents: cash, units_milli: 1000, return_cash_cents: 0, ...item}], ...flags};
}
const losses = (n = 3, options = {}) => Array.from({length: n}, (_, i) => row('order-' + i, {date: shift(TODAY, i - n + 1), ...options}));
function analyze(rows, options = {}) {
  assert.equal(typeof salesAlerts, 'function', 'salesAlerts must be exported as a pure function');
  return salesAlerts(rows, {today: TODAY, ...options});
}
const price = result => result.alerts.filter(a => a.type === 'price');

// First red assertion also exercises the existing panorama implementation, before engine integration.
test('panorama exposes a separate recurring-sales contract even when empty', async () => {
  const f = appFixture(); try {
    const p = await panorama(f);
    assert.ok(p.sales_alerts, 'panorama must expose sales_alerts');
    assert.equal(p.sales_alerts.status, 'empty');
    assert.deepEqual(p.sales_alerts.alerts, []);
    assert.equal(p.sales_alerts.window_days, 30);
  } finally { f.close(); }
});

test('three distinct ten-kurus losses produce a signed, bounded price alert without mutating input', () => {
  const rows = losses(), original = structuredClone(rows), result = analyze(rows), [a] = price(result);
  assert.deepEqual(rows, original);
  assert.deepEqual([result.as_of, result.from, result.to, result.window_days, result.sample_limit, result.min_occurrences],
    [TODAY, '2026-09-05', TODAY, 30, 5, 3]);
  assert.equal(result.coverage.packages, 3); assert.equal(result.coverage.orders, 3);
  assert.equal(a.key, SINGLE.key); assert.equal(a.name, SINGLE.name); assert.equal(a.kind, 'single');
  assert.deepEqual(a.components, SINGLE.components);
  assert.equal(a.orders, 3); assert.equal(a.occurrences, 3);
  assert.equal(a.loss_cents, -30); assert.equal(a.net_cents, -30); assert.equal(a.estimated, false);
  assert.equal(a.samples.length, 3); assert.equal(a.samples[0].date, TODAY);
  assert.deepEqual(a.samples[0], {order_no: 'order-2', package_ids: ['order-2'], date: TODAY, cash_cents: -10, units_milli: 1000, kind: 'sale'});
  assert.deepEqual(a.package_ids, ['order-0', 'order-1', 'order-2']);
  assert.ok(a.reason_codes.includes('recurring_loss'));
  assert.deepEqual(analyze([...rows].reverse()), result, 'deterministic including shuffled input');
});

test('one/two isolated losses and exact zero never create price alerts', () => {
  for (const n of [0, 1, 2]) assert.equal(price(analyze(losses(n))).length, 0);
  assert.equal(price(analyze(losses(5, {cash: 0}))).length, 0);
});

test('latest recovery and nonnegative recent net both suppress price recommendations', () => {
  for (const cash of [0, 1, 100]) assert.equal(price(analyze([...losses(3).map(r => ({...r, delivered_on: shift(r.delivered_on, -1)})), row('recovered', {cash})])).length, 0);
  const rows = losses(3);
  rows.push(row('old-profit', {cash: 30, date: shift(TODAY, -3)}));
  assert.equal(price(analyze(rows)).length, 0, 'zero total is not a loss');
  rows.at(-1).sales_items[0].cash_cents = rows.at(-1).cash_cents = 31;
  assert.equal(price(analyze(rows)).length, 0);
});

test('only the latest five distinct orders count, with deterministic same-day ties', () => {
  const rows = losses(8);
  rows[5].cash_cents = rows[5].sales_items[0].cash_cents = 1;
  rows[6].cash_cents = rows[6].sales_items[0].cash_cents = 1;
  const a = price(analyze(rows))[0];
  assert.equal(a.orders, 5); assert.equal(a.occurrences, 3); assert.equal(a.net_cents, -28); assert.equal(a.samples.length, 5);
  rows[4].cash_cents = rows[4].sales_items[0].cash_cents = 1;
  assert.equal(price(analyze(rows)).length, 0);
});

test('channels and canonical set/multipack identities stay separate; components are never standalone recommendations', () => {
  const setRows = losses(3, {offering: SET});
  const result = analyze([...setRows, ...losses(2, {channel: 'trendyol'}), ...losses(2).map(r => ({...r, id: 'single-' + r.id}))]);
  assert.equal(result.alerts.length, 1); assert.equal(result.alerts[0].key, SET.key); assert.equal(result.alerts[0].kind, 'bundle');
  assert.equal(result.alerts[0].components.length, 2);
  const both = analyze([...losses(), ...losses(3, {channel: 'trendyol'})]);
  assert.equal(price(both).length, 2); assert.notEqual(both.alerts[0].id, both.alerts[1].id);
  assert.equal(price(analyze(losses(3, {offering: composition(['p1'], 4000)})))[0].kind, 'multipack');
});

test('split packages, multiple lines and replayed rows never inflate order occurrences or money', () => {
  const one = row('one', {order: 'same'}), two = row('two', {order: 'same'}), three = row('three', {order: 'same'});
  assert.equal(price(analyze([one, two, three])).length, 0);
  const rows = losses(); rows.push(row('extra', {order: 'order-2', cash: 25}));
  assert.equal(price(analyze(rows)).length, 0, 'latest order recovered across split packages');
  const replay = losses(); replay.push(structuredClone(replay[0]));
  replay[1].sales_items.push(structuredClone(replay[1].sales_items[0]));
  const result = analyze(replay);
  assert.equal(result.alerts[0].loss_cents, -30); assert.equal(result.coverage.duplicate_packages, 1);
  assert.equal(result.coverage.duplicate_items, 1);
  const multi = losses();
  multi[0].sales_items.push({...multi[0].sales_items[0], line_ids: ['another-line'], cash_cents: 30});
  multi[0].cash_cents = 20;
  assert.equal(price(analyze(multi)).length, 0);
});

test('missing order numbers use tagged package identities, never collide with real order numbers', () => {
  const rows = [row('same-id', {order: null}), row('p2', {order: 'same-id'}), row('p3', {order: 'third'})];
  const a = price(analyze(rows))[0]; assert.equal(a.orders, 3); assert.ok(a.samples.some(s => s.order_no === null));
});

test('unknown newer clean orders stay in the latest-five sample and block confident price recommendations', () => {
  const rows = losses().map(r => ({...r, delivered_on: shift(r.delivered_on, -1)}));
  let result = analyze([...rows, row('new-unknown', {cash: null})]);
  assert.equal(price(result).length, 0); assert.equal(result.coverage.unknown_packages, 1);
  assert.equal(result.coverage.unknown_recent_orders, 1); assert.equal(result.coverage.price_blocked_offerings, 1);
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.complete, false);
  result = analyze([row('old-unknown', {cash: null, date: shift(TODAY, -10)}), ...losses(5)]);
  assert.equal(price(result).length, 1, 'older unknown falls outside the recent-five window');
  assert.equal(result.coverage.complete, false, 'historical coverage still reports the gap');
});

test('history fees, assumptions, estimated costs and unexplained estimated fees are insufficient evidence', () => {
  for (const flags of [{fees_from_history: true}, {assumptions_source: 'history'}, {cost_estimated: true}, {fees_estimated: true}]) {
    const result = analyze(losses(3, flags));
    assert.equal(price(result).length, 0, JSON.stringify(flags));
    assert.equal(result.coverage.insufficient_evidence_packages, 3); assert.equal(result.status, 'incomplete');
  }
});

test('profile cost VAT and withholding-only estimates are allowed with explicit labels', () => {
  for (const flags of [{cost_vat_estimated: true}, {fees_estimated: true, withholding_estimated: true}]) {
    const result = analyze(losses(3, flags)), a = price(result)[0];
    assert.equal(a.estimated, true); assert.equal(result.status, 'estimated');
    assert.ok(a.reason_codes.includes(flags.cost_vat_estimated ? 'cost_vat_estimated' : 'withholding_estimated'));
  }
  assert.equal(price(analyze(losses(3, {fees_estimated: true, withholding_estimated: true, fees_from_history: true}))).length, 0);
});

for (const [type, flags] of [['returns', {return_packages: 1}], ['delivery', {return_packages: 1, failed_delivery_packages: 1}], ['returns', {partial_returns: 1}]]) {
  test(type + ' recurrence reads aggregate flags and keeps normal orders in its last-five denominator: ' + JSON.stringify(flags), () => {
    const rows = losses(3, {item: {...flags, return_cash_cents: -20}}).map(r => ({...r, delivered_on: shift(r.delivered_on, -2)}));
    rows.push(row('normal-1', {date: shift(TODAY, -1), cash: 100}), row('normal-2', {cash: 100}));
    let result = analyze(rows), a = result.alerts[0];
    assert.equal(result.alerts.length, 1); assert.equal(a.type, type); assert.equal(a.orders, 5); assert.equal(a.occurrences, 3);
    assert.equal(a.loss_cents, -60); assert.equal(a.net_cents, 170); assert.equal(a.samples.length, 5);
    assert.equal(a.samples[0].kind, 'sale'); assert.equal(a.samples.at(-1).kind, type);
    rows.push(row('newer-normal', {cash: 100})); result = analyze(rows);
    assert.equal(result.alerts.length, 0, 'third normal displaces one old exception');
  });
}

test('returns and delivery each require three orders; repeated packages from one order do not suffice', () => {
  for (const item of [{has_returns: true}, {failed_delivery: true}]) {
    assert.equal(analyze(losses(2, {item})).alerts.length, 0);
    assert.equal(analyze(losses(4, {item, order: 'same'})).alerts.length, 0);
  }
  const rows = losses(3, {item: {has_returns: true, return_cash_cents: null}, cash: null});
  const a = analyze(rows).alerts[0]; assert.equal(a.type, 'returns'); assert.equal(a.net_cents, null); assert.equal(a.loss_cents, null);
});

test('exception and technical-correction packages exclude all their offerings from price evidence', () => {
  for (const flag of [{has_returns: true}, {failed_delivery: true}, {technical_correction: true}]) {
    const rows = losses();
    for (const r of rows) r.sales_items.push({...SET, ...flag, cash_cents: -20, return_cash_cents: -20, units_milli: 0, line_ids: [r.id + '-exception']});
    const result = analyze(rows); assert.equal(price(result).length, 0);
    assert.equal(result.coverage.excluded_price_packages, 3);
    if (flag.technical_correction) assert.equal(result.alerts.length, 0);
  }
});

test('30 calendar days include both edges, reject invalid dates, and exclude future/pending records', () => {
  const rows = [row('start', {date: '2026-09-05'}), row('middle', {date: '2026-09-20'}), row('end')];
  let result = analyze([...rows, row('old', {date: '2026-09-04'}), row('future', {date: '2026-10-05'}), row('pending', {status: 'shipped'})]);
  assert.equal(result.coverage.packages, 3); assert.equal(result.alerts[0].orders, 3);
  assert.equal(result.coverage.outside_window_packages, 2);
  result = analyze([...rows, row('invalid', {date: '2026-09-31'})]);
  assert.equal(result.coverage.invalid_date_packages, 1); assert.equal(price(result).length, 0);
  assert.throws(() => analyze([], {today: '2026-02-30'}), /today/);
});

test('partial reads and unallocated fees suppress price alerts but retain known exception repeats and honest coverage', () => {
  for (const options of [{partial: true}, {unallocatedFeeCents: 1}, {unallocatedFeeCents: -1}, {unallocatedFeeCents: NaN}]) {
    const result = analyze(losses(), options);
    assert.equal(price(result).length, 0); assert.equal(result.coverage.complete, false); assert.equal(result.status, 'incomplete');
    assert.ok(result.price_blocked_reason_codes.length);
    const exception = analyze(losses(3, {item: {return_packages: 1, return_cash_cents: -10}}), options);
    assert.equal(exception.alerts[0].type, 'returns');
  }
});

test('unmapped results have visible coverage and conservatively block their channel, not another channel', () => {
  const unmapped = row('unmapped', {sales_items: []});
  const result = analyze([...losses(), unmapped, ...losses(3, {channel: 'trendyol'})]);
  assert.equal(result.coverage.unmapped_packages, 1); assert.equal(result.coverage.complete, false);
  assert.deepEqual(price(result).map(a => a.channel), ['trendyol']);
  const noParts = row('no-parts'); noParts.sales_items[0].components = [];
  assert.equal(price(analyze([...losses(), noParts])).length, 0);
});

test('conflicting duplicate packages and unsafe integers cannot fabricate repeat warnings or financial totals', () => {
  const rows = losses(), duplicate = structuredClone(rows[0]); duplicate.sales_items[0].cash_cents = -11;
  assert.equal(price(analyze([...rows, duplicate])).length, 0);
  assert.equal(analyze([...rows, duplicate]).coverage.ambiguous_packages, 1);
  for (const cash of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, -0.1]) {
    assert.equal(price(analyze(losses(3, {cash}))).length, 0);
  }
  let result = analyze(losses(3, {cash: -Number.MAX_SAFE_INTEGER}));
  assert.equal(price(result).length, 0); assert.equal(result.coverage.complete, false);
  result = analyze(losses(3, {cash: -Number.MAX_SAFE_INTEGER, item: {has_returns: true, return_cash_cents: -Number.MAX_SAFE_INTEGER}}));
  assert.equal(result.alerts[0].net_cents, null); assert.equal(result.alerts[0].loss_cents, null);
  assert.doesNotThrow(() => JSON.stringify(result));
});

// Real panorama/performance computation through the existing disposable in-memory app fixture.
// Loading fixture schema does not migrate a local or live database.
const liveToday = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => shift(liveToday, n);
const env = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const panorama = (f, query = '') => panoramaApi(new Request('https://synthetic.test/api/panorama' + query), env(f), '/api/panorama');
function seed(f, vat = 0) {
  for (const id of ['p1', 'p2']) {
    f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,?)').run(id, id, id, 'adet');
    f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,1000,0,0,0,100,100,100,500,1)').run(id, vat);
  }
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=100000000,value_cents=100000000');
  for (const channel of ['trendyol', 'hepsiburada']) {
    f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'test')")
      .run(channel, channel, channel, JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: vat}));
  }
}
function parcel(f, id, {channel = 'hepsiburada', date = liveToday, order = id, set = false, shipping = 10, status = 'delivered', cost = 1000} = {}) {
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id, channel, id, order, date);
  const parts = set ? ['p1', 'p2'] : ['p1'];
  f.sqlite.prepare('INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,1000,?,?,0)')
    .run(id + '-l', id, id + '-l', 'Mutable name', 1000 * parts.length, 1000 * parts.length);
  for (const [i, product] of parts.entries()) {
    const sid = id + '-' + product;
    f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',1000,1000,?,0,?,0,?,?)")
      .run(sid, channel, sid, product, cost, i ? 0 : shipping, shipping === null ? 'pending' : 'confirmed', date);
    f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,?,1000,?,?,'adet')")
      .run(sid + '-c', id + '-l', product, 10000 / parts.length, sid);
  }
  f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date, id);
  if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date, id);
}
function refund(f, id, {technical = false, product = 'p1', date = liveToday} = {}) {
  const s = f.sqlite.prepare('SELECT * FROM ec_sale_entries WHERE id=?').get(id + '-' + product);
  f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) VALUES(?,?,?,?,'return',?,1000,?,?,0,0,0,'confirmed',1,?)")
    .run(s.id + '-r', s.channel, (technical ? 'DUZELTME-IKAME-' : 'RETURN-') + s.id, product, s.id, -s.revenue_cents, -s.cost_cents, date);
}

test('actual panorama uses loaded last-30-day rows independently of the custom period and respects channel', async () => {
  const f = appFixture(); try {
    seed(f);
    for (const channel of ['hepsiburada', 'trendyol']) for (let i = 0; i < 3; i++) parcel(f, channel + i, {channel, date: day(-i), set: true});
    parcel(f, 'old', {date: day(-30)}); parcel(f, 'future', {date: day(1)});
    const p = await panorama(f, '?from=' + day(-80) + '&to=' + day(-70) + '&channel=hepsiburada');
    assert.equal(p.selected_period.packages, 0);
    assert.equal(p.sales_alerts.from, day(-29)); assert.equal(p.sales_alerts.coverage.packages, 3);
    const [a] = p.sales_alerts.alerts; assert.equal(a.channel, 'hepsiburada'); assert.equal(a.kind, 'bundle');
    assert.equal(a.occurrences, 3); assert.equal(a.net_cents, -30); assert.equal(a.estimated, true);
    assert.ok(a.reason_codes.includes('cost_vat_estimated'));
    const rows = (await performanceReport(env(f), {mode: 'delivered', from: day(-30), to: liveToday, channel: 'hepsiburada'})).rows;
    assert.deepEqual(p.sales_alerts, salesAlerts(rows, {today: liveToday}));
    const future = await panorama(f, '?from=' + day(1) + '&to=' + day(1));
    assert.equal(future.sales_alerts.coverage.packages, 6);
  } finally { f.close(); }
});

test('actual panorama splits customer returns from failed delivery and omits technical corrections', async () => {
  const f = appFixture(); try {
    seed(f);
    for (let i = 0; i < 3; i++) {
      parcel(f, 'returned-' + i, {date: day(-i), set: true}); refund(f, 'returned-' + i);
      parcel(f, 'failed-' + i, {date: day(-i), channel: 'trendyol', status: 'shipped'}); refund(f, 'failed-' + i);
      parcel(f, 'technical-' + i, {date: day(-i)}); refund(f, 'technical-' + i, {technical: true});
    }
    const result = (await panorama(f)).sales_alerts;
    assert.deepEqual(result.alerts.map(a => a.type).sort(), ['delivery', 'returns']);
    const a = result.alerts.find(a => a.type === 'returns'); assert.equal(a.kind, 'bundle'); assert.equal(a.occurrences, 3);
    assert.equal(result.coverage.technical_correction_packages, 3);
    assert.equal(result.alerts.find(a => a.type === 'delivery').loss_cents, -30);
  } finally { f.close(); }
});

test('actual panorama keeps unknown-cost and history-estimated newer orders in evidence coverage', async () => {
  const f = appFixture(); try {
    seed(f); for (let i = 1; i <= 3; i++) parcel(f, 'known-' + i, {date: day(-i)});
    parcel(f, 'unknown-cost', {cost: 0});
    let result = (await panorama(f)).sales_alerts;
    assert.equal(price(result).length, 0); assert.equal(result.coverage.unknown_packages, 1);
    // Separate offering/channel with actual recorded history available for fee estimation.
    for (let i = 1; i <= 3; i++) parcel(f, 'ty-' + i, {date: day(-i), channel: 'trendyol'});
    parcel(f, 'history-fees', {channel: 'trendyol', shipping: null});
    result = (await panorama(f, '?channel=trendyol')).sales_alerts;
    assert.equal(price(result).length, 0); assert.equal(result.coverage.insufficient_evidence_packages, 1);
  } finally { f.close(); }
});

for (const [offset, expected] of [[-150, false], [-100, true]]) {
  test('actual panorama read failure is partial only when its 92-day chunk intersects last 30: ' + offset, async () => {
    const f = appFixture(); try {
      seed(f); parcel(f, 'old', {date: day(offset)});
      for (let i = 0; i < 3; i++) parcel(f, 'recent-' + i, {date: day(-i)});
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      f.env.DB.prepare = sql => {
        const s = prepare(sql);
        if (sql.startsWith('SELECT *') && sql.includes("status='delivered'") && sql.includes('delivered_on BETWEEN')) {
          const all = s.all.bind(s); s.all = () => { if (s.args[0] === day(offset)) throw Error('Synthetic chunk failure'); return all(); };
        }
        return s;
      };
      const p = await panorama(f);
      assert.equal(p.coverage.complete, false); assert.equal(p.sales_alerts.partial, expected);
      assert.equal(price(p.sales_alerts).length, 0, 'any historical failure can hide a sibling');
      assert.equal(p.sales_alerts.coverage.history_partial, true);
    } finally { f.close(); }
  });
}

test('actual panorama propagates its already-loaded unallocated fee result without additional queries', async () => {
  const f = appFixture(); try {
    seed(f); for (let i = 0; i < 3; i++) parcel(f, 'recent-' + i, {date: day(-i)});
    const prepare = f.env.DB.prepare.bind(f.env.DB); let feeReads = 0;
    f.env.DB.prepare = sql => {
      const s = prepare(sql);
      if (sql.includes("l.expense_treatment='sales_fee'")) { feeReads++; s.first = () => ({cents: 1}); }
      return s;
    };
    const p = await panorama(f);
    assert.equal(p.unallocated_fee_cents, 1); assert.equal(p.sales_alerts.unallocated_fee_cents, 1);
    assert.equal(price(p.sales_alerts).length, 0); assert.equal(feeReads, 1, 'alerts reuse the panorama result');
  } finally { f.close(); }
});
test('unknown clean units and unexplained offering estimates are visible evidence gaps', () => {
  for (const item of [{units_milli: null}, {units_milli: 0}, {estimated: 1}]) {
    const result = analyze(losses(3, {item}));
    assert.equal(price(result).length, 0); assert.equal(result.coverage.complete, false); assert.equal(result.status, 'incomplete');
  }
});

test('conflicting duplicate exception flags are not known repeats', () => {
  const rows = losses(3, {item: {has_returns: true, return_cash_cents: -10}});
  const duplicates = rows.map(r => ({...structuredClone(r), sales_items: [{...r.sales_items[0], has_returns: false}]}));
  const result = analyze([...rows, ...duplicates]);
  assert.equal(result.alerts.length, 0); assert.equal(result.coverage.ambiguous_packages, 3);
});

test('contradictory fee metadata cannot turn undocumented fees into a confirmed price warning', () => {
  const result = analyze(losses(3, {fees_estimated: true, withholding_estimated: true,
    financial_parts: {shipping: {estimated: true, estimated_cents: 10}}}));
  assert.equal(price(result).length, 0); assert.equal(result.coverage.insufficient_evidence_packages, 3);
});

test('real nonzero cost VAT and withholding-only estimates preserve the price warning label', async () => {
  const f = appFixture(); try {
    seed(f, 2000);
    f.sqlite.exec("UPDATE workspace_settings SET withholding_estimate_channels='trendyol',withholding_estimate_bps=100 WHERE workspace='ec'");
    for (let i = 0; i < 3; i++) parcel(f, 'vat-' + i, {channel: 'trendyol', date: day(-i)});
    const result = (await panorama(f)).sales_alerts, [a] = price(result);
    assert.ok(a); assert.equal(a.estimated, true);
    assert.ok(a.reason_codes.includes('cost_vat_estimated')); assert.ok(a.reason_codes.includes('withholding_estimated'));
    assert.equal(result.coverage.insufficient_evidence_packages, 0);
    const rows = (await performanceReport(env(f), {mode: 'delivered', from: day(-29), to: liveToday})).rows;
    assert.equal(a.net_cents, rows.reduce((n, r) => n + r.cash_cents, 0));
  } finally { f.close(); }
});

test('pending/future read failures do not mark the independent last-30-day alert window partial', async () => {
  const f = appFixture(); try {
    seed(f); for (let i = 0; i < 3; i++) parcel(f, 'ok-' + i, {date: day(-i)});
    parcel(f, 'future-only', {date: day(1)});
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const s = prepare(sql);
      if (sql.startsWith('SELECT *') && sql.includes('FROM ec_order_packages WHERE')) {
        const all = s.all.bind(s);
        s.all = () => {
          if (sql.includes("status IN ('draft','reserved','shipped')") || s.args[0] === day(1)) throw Error('Synthetic out-of-window failure');
          return all();
        };
      }
      return s;
    };
    const p = await panorama(f, '?from=' + day(1) + '&to=' + day(1));
    assert.equal(p.pending.partial, true); assert.equal(p.selected_period.partial, true);
    assert.equal(p.sales_alerts.partial, false); assert.equal(price(p.sales_alerts).length, 1);
    assert.equal(p.sales_alerts.coverage.history_partial, false);
  } finally { f.close(); }
});
test('UI coverage totals count distinct affected orders, not packages or offering occurrences', () => {
  const unknown = row('unknown-a', {order: 'unknown', cash: null});
  unknown.sales_items.push({...unknown.sales_items[0], ...SET, line_ids: ['another-offering']});
  const result = analyze([unknown, row('unknown-b', {order: 'unknown', cash: null}),
    row('estimated-a', {order: 'estimated', cost_estimated: true}), row('estimated-b', {order: 'estimated', cost_estimated: true})]);
  assert.equal(result.coverage.orders, 2); assert.equal(result.coverage.unknown_packages, 2);
  assert.equal(result.coverage.unknown_orders, 1); assert.equal(result.coverage.ineligible_orders, 2);
  assert.equal(result.coverage.unknown_recent_orders, 1);
  const blocked = analyze(losses(), {unallocatedFeeCents: 1});
  assert.equal(blocked.coverage.unknown_orders, 0); assert.equal(blocked.coverage.ineligible_orders, 3);
  const exceptions = analyze(losses(3, {item: {has_returns: true, return_cash_cents: -10}}));
  assert.equal(exceptions.coverage.ineligible_orders, 0, 'known exceptions are not incomplete evidence');
  assert.equal(exceptions.coverage.excluded_price_orders, 3);
});
test('exception evidence remains labelled when a normal result or exception amount is unknown', () => {
  const rows = losses(3, {item: {has_returns: true, return_cash_cents: -10}}).map(r => ({...r, delivered_on: shift(r.delivered_on, -1)}));
  const normal = row('new-normal', {cash: null});
  const result = analyze([...rows, normal]);
  assert.equal(result.alerts[0].samples[0].kind, 'sale', 'kind classifies the event, not availability of its amount');
  assert.equal(result.alerts[0].samples[0].cash_cents, null);
  const unknownEffects = analyze(losses(3, {item: {has_returns: true, return_cash_cents: null}}));
  assert.equal(unknownEffects.alerts[0].loss_cents, null); assert.equal(unknownEffects.coverage.unknown_orders, 3);
  assert.equal(unknownEffects.alerts[0].net_cents, -30, 'known offering cash remains available');
  assert.equal(unknownEffects.coverage.complete, false);
});

test('overflowed exception summaries expose affected distinct orders to the incomplete UI notice', () => {
  const result = analyze(losses(3, {cash: -Number.MAX_SAFE_INTEGER, item: {has_returns: true, return_cash_cents: -Number.MAX_SAFE_INTEGER}}));
  assert.equal(result.coverage.ineligible_orders, 3); assert.equal(result.coverage.complete, false);
  assert.equal(result.alerts[0].loss_cents, null); assert.equal(result.alerts[0].net_cents, null);
});
test('date-only ties cannot hide an unknown order, a latest-day recovery, or a decisive boundary gain', () => {
  const sameDay = Array.from({length: 5}, (_, i) => row('a-' + i));
  let result = analyze([...sameDay, row('z-unknown', {cash: null})]);
  assert.equal(price(result).length, 0); assert.equal(result.coverage.unknown_recent_orders, 1);
  result = analyze([...sameDay, row('z-estimate', {fees_from_history: true})]);
  assert.equal(price(result).length, 0);
  result = analyze([...sameDay, row('z-recovery', {cash: 1})]);
  assert.equal(price(result).length, 0, 'latest within the day is unknowable, and may have recovered');
  const boundary = [row('latest'), ...Array.from({length: 4}, (_, i) => row('a-old-' + i, {date: shift(TODAY, -1)}))];
  assert.equal(price(analyze([...boundary, row('z-old-gain', {date: shift(TODAY, -1), cash: 1000})])).length, 0);
  assert.equal(price(analyze([...sameDay, row('z-loss')])).length, 1, 'all-loss ties still establish the trend');
});
test('price tie decisions are permutation invariant for latest-day recovery and unknown fifth-order boundaries', () => {
  const cases = [
    [row('a-loss'), row('b-loss'), row('c-loss'), row('z-profit', {cash: 1})],
    [row('latest'), ...Array.from({length: 4}, (_, i) => row('old-' + i, {date: shift(TODAY, -1)})), row('z-unknown', {date: shift(TODAY, -1), cash: null})],
    [row('latest'), ...Array.from({length: 4}, (_, i) => row('old-' + i, {date: shift(TODAY, -1)})), row('z-profit', {date: shift(TODAY, -1), cash: 1})]
  ];
  for (const rows of cases) {
    const original = analyze(rows);
    assert.equal(price(original).length, 0); assert.equal(original.coverage.complete, false);
    assert.ok(original.coverage.ineligible_orders > 0);
    for (const permutation of [[...rows].reverse(), [...rows.slice(1), rows[0]], [...rows.slice(2), ...rows.slice(0, 2)]])
      assert.deepEqual(analyze(permutation), original);
  }
  assert.equal(price(analyze([row('a'), row('b'), row('c')])).length, 1);
});
test('window selection uses the complete historical order, including old known or unknown siblings', () => {
  const current = [row('a', {date: shift(TODAY, -2)}), row('b', {date: shift(TODAY, -1)}), row('c', {order: 'split'})];
  let result = analyze([...current, row('old-profit', {date: shift(TODAY, -30), order: 'split', cash: 20})]);
  assert.equal(price(result).length, 0); assert.equal(result.coverage.historical_sibling_packages, 1);
  result = analyze([...current, row('old-unknown', {date: shift(TODAY, -30), order: 'split', cash: null})]);
  assert.equal(price(result).length, 0); assert.equal(result.coverage.unknown_orders, 1);
  const rows = [...current, row('old-loss', {date: shift(TODAY, -30), order: 'split', cash: -5})];
  result = analyze(rows);
  assert.equal(price(result)[0].net_cents, -35);
  assert.deepEqual(price(result)[0].samples[0].package_ids, ['c', 'old-loss']);
  assert.equal(price(result)[0].samples[0].date, TODAY);
  assert.deepEqual(analyze([...rows].reverse()), result);
});

test('future-return metadata prevents present exception alerts and cannot resurrect older price losses', async () => {
  const f = appFixture(); try {
    seed(f);
    for (let i = 0; i < 3; i++) {
      parcel(f, 'old-loss-' + i, {date: day(-10 - i)});
      parcel(f, 'future-refund-' + i, {date: day(-i), cost: 500});
      refund(f, 'future-refund-' + i, {date: day(1)});
    }
    const report = await performanceReport(env(f), {mode: 'delivered', from: day(-30), to: liveToday});
    for (const r of report.rows.filter(r => r.id.startsWith('future-refund-'))) {
      assert.equal(r.latest_customer_return_on, day(1));
      assert.equal(r.cash_cents, -10, 'shared financial computation is not restated');
      assert.equal(r.sales_items[0].return_cash_cents, -10);
    }
    const result = (await panorama(f)).sales_alerts;
    assert.deepEqual(result.alerts, []); assert.equal(result.coverage.future_customer_return_packages, 3);
    assert.equal(result.coverage.unknown_orders, 3); assert.equal(result.status, 'incomplete');
  } finally { f.close(); }
});
test('exception cutoff ties cannot choose three events by lexical order from mixed same-day statuses', () => {
  for (const type of ['returns', 'delivery']) {
    const flags = type === 'returns' ? {has_returns: true} : {failed_delivery: true};
    const rows = [...Array.from({length: 3}, (_, i) => row('a-event-' + i, {item: {...flags, return_cash_cents: -10}})),
      ...Array.from({length: 3}, (_, i) => row('z-normal-' + i, {cash: 100}))];
    const result = analyze(rows);
    assert.equal(result.alerts.filter(a => a.type === type).length, 0);
    assert.ok(result.coverage.ambiguous_exception_windows > 0); assert.equal(result.coverage.complete, false);
    assert.ok(result.coverage.ineligible_orders > 0);
    assert.deepEqual(analyze([...rows].reverse()), result);
    assert.equal(analyze(rows.slice(0, 3)).alerts.filter(a => a.type === type).length, 1);
  }
});
test('historical-read guard blocks price with explicit coverage even when current window or observed rows are complete', () => {
  for (const rows of [losses(), []]) {
    const result = analyze(rows, {historyPartial: true});
    assert.equal(price(result).length, 0); assert.equal(result.partial, false);
    assert.equal(result.coverage.history_partial, true); assert.equal(result.coverage.complete, false);
    assert.equal(result.status, 'incomplete'); assert.equal(result.coverage.ineligible_orders, rows.length);
    assert.ok(result.price_blocked_reason_codes.includes('historical_read_failure'));
  }
});

test('actual panorama historical-read guard prevents hidden older profitable/unknown siblings without changing current totals', async () => {
  for (const cost of [500, 0]) {
    const f = appFixture(); try {
      seed(f); parcel(f, 'hidden-sibling', {date: day(-180), order: 'recent-0', cost});
      for (let i = 0; i < 3; i++) parcel(f, 'recent-' + i, {date: day(-i)});
      const complete = await panorama(f);
      assert.equal(price(complete.sales_alerts).length, 0);
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      f.env.DB.prepare = sql => {
        const s = prepare(sql);
        if (sql.startsWith('SELECT *') && sql.includes("status='delivered'") && sql.includes('delivered_on BETWEEN')) {
          const all = s.all.bind(s); s.all = () => { if (s.args[0] === day(-180)) throw Error('Synthetic hidden sibling failure'); return all(); };
        }
        return s;
      };
      const p = await panorama(f), current = p.periods.find(x => x.key === '30g');
      assert.equal(p.sales_alerts.partial, false, 'current 30-day read itself succeeded');
      assert.equal(p.sales_alerts.coverage.history_partial, true); assert.equal(price(p.sales_alerts).length, 0);
      assert.equal(p.sales_alerts.coverage.ineligible_orders, 3);
      assert.ok(p.sales_alerts.price_blocked_reason_codes.includes('historical_read_failure'));
      assert.deepEqual(current, complete.periods.find(x => x.key === '30g'), 'existing current report totals and coverage remain unchanged');
      assert.equal(current.cash_cents, -30); assert.equal(current.partial, false);
    } finally { f.close(); }
  }
});