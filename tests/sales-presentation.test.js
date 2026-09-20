// Synthetic financial fixtures only. No live database, reports, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {performanceReport} from '../src/performance-api.js';
import {aggregateSales, offeringComposition, salesReturnSummary, pendingSalesSummary} from '../src/sales-presentation.js';
import {scrubAmounts} from '../src/permission-policy.js';

const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const env = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const sum = (xs, key) => xs.reduce((n, x) => n + x[key], 0);
function setup(f, vat = 0) {
  for (const [id, name] of [['p1', 'Genel Besin 225 ml'], ['p2', 'İkinci ürün'], ['p3', 'Üçüncü ürün']]) {
    f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,?)').run(id, name, id, 'adet');
    f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,?,0,0,0,100,100,100,500,1)').run(id, vat, 1000);
  }
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000000,value_cents=1000000000');
  for (const ch of ['trendyol', 'hepsiburada']) {
    f.sqlite.prepare("INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)").run(ch, ch, ch, ch);
    f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'test')")
      .run('pf-' + ch, ch, ch, JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: vat}));
    f.sqlite.prepare("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES(?,?,'finance','synthetic.xlsx',1,?,'2026-09-01T00:00','S','[]',1,1,'applied','test')")
      .run('file-' + ch, ch, (ch === 'trendyol' ? 'a' : 'b').repeat(64));
  }
}
function pack(f, id, lines = [{components: [{id: 'p1'}]}], {status = 'delivered', channel = 'trendyol', date = today, order = id, vat = 0} = {}) {
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id, channel, id, order, date);
  for (const [i, line] of lines.entries()) {
    const lid = id + '-l' + i, units = line.units ?? 1, revenue = line.components.reduce((n, c) => n + (c.revenue ?? 10000), 0);
    f.sqlite.prepare('INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,?,?,?,?)')
      .run(lid, id, lid, 'Mutable marketplace display name', units * 1000, revenue, Math.round(revenue * (10000 + vat) / 10000), vat);
    let shares = 10000;
    for (const [j, c] of line.components.entries()) {
      const cid = lid + '-c' + j, sid = cid + '-sale', q = (c.quantity ?? 1) * units * 1000;
      const share = j === line.components.length - 1 ? shares : Math.floor(10000 / line.components.length); shares -= share;
      const fee = c.shipping === undefined ? 0 : c.shipping;
      if (!['draft', 'reserved'].includes(status)) f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',?,?,?,0,?,0,?,?)")
        .run(sid, channel, sid, c.id, q, c.revenue ?? 10000, c.cost ?? 5000, fee, fee === null ? 'pending' : 'confirmed', date);
      f.sqlite.prepare('INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,?,?,?,?,?)')
        .run(cid, lid, c.id, q, share, ['draft', 'reserved'].includes(status) ? null : sid, 'adet');
    }
  }
  if (status !== 'draft') f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  if (!['draft', 'reserved'].includes(status)) f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date, id);
  if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date, id);
}
function returned(f, id, {line = 0, component = 0, ratio = 1, technical = false, date = today} = {}) {
  const sale = f.sqlite.prepare('SELECT * FROM ec_sale_entries WHERE id=?').get(id + '-l' + line + '-c' + component + '-sale');
  f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) VALUES(?,?,?,?,'return',?,?,?,?,0,0,0,'confirmed',1,?)")
    .run(sale.id + '-return', sale.channel, (technical ? 'DUZELTME-CIFT-' : 'RETURN-') + sale.id, sale.product_id, sale.id, sale.quantity_milli * ratio, -Math.round(sale.revenue_cents * ratio), -Math.round(sale.cost_cents * ratio), date);
}
function withholding(f, order, amount, channel = 'trendyol') {
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,'finance_event',?,'provider',?,'2026-09-01T00:00',?,1)")
    .run('w-' + order, channel, 'w-' + order, JSON.stringify({order_no: order, type: 'withholding', amount_cents: -amount}), 'file-' + channel);
}
const report = (f, options = {}) => performanceReport(env(f), {mode: 'delivered', from: day(-30), to: today, detay: true, ...options});
function reconciles(row) {
  for (const field of ['cash_cents', 'revenue_gross_cents', 'cost_gross_cents', 'withholding_cents']) {
    if (Number.isSafeInteger(row[field])) assert.equal(sum(row.sales_items, field), row[field], row.id + ': ' + field);
    else assert.ok(row.sales_items.every(i => i[field] === null), row.id + ': unknown ' + field);
  }
  for (const item of row.sales_items) if (Number.isSafeInteger(item.cash_cents)) assert.equal(item.sold_cash_cents + item.return_cash_cents, item.cash_cents);
  for (const u of row.urunler || []) assert.equal(u.single_cash_cents + u.multipack_cash_cents + u.bundle_cash_cents + u.return_cash_cents, u.cash_cents);
}

test('sold offerings retain the 25-bottle / five 4-packs / five mixed sets / failed-return evidence', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    pack(f, 'four', [{units: 5, components: [{id: 'p1', quantity: 4, revenue: 100000, cost: 80000, shipping: 13278}]}]);
    pack(f, 'mixed', [{units: 5, components: [
      {id: 'p1', revenue: 21558, cost: 20000, shipping: 6091},
      {id: 'p2', revenue: 20000, cost: 25000, shipping: 1000},
      {id: 'p3', revenue: 15000, cost: 18000, shipping: 1880}]},
      {components: [{id: 'p2', revenue: 10000, cost: 5000}]}]);
    pack(f, 'failed', [{components: [{id: 'p1', quantity: 4, revenue: 20000, cost: 15000, shipping: 5248}]}], {status: 'shipped'});
    returned(f, 'failed');
    const r = await report(f); r.rows.forEach(reconciles);
    const product = r.rows.flatMap(p => p.urunler).filter(p => p.product_id === 'p1');
    assert.equal(sum(product, 'qty_milli'), 25000); assert.equal(sum(product, 'revenue_gross_cents'), 121558); assert.equal(sum(product, 'cash_cents'), -3059);
    assert.equal(sum(product, 'multipack_cash_cents'), 6722); assert.equal(sum(product, 'bundle_cash_cents'), -4533); assert.equal(sum(product, 'return_cash_cents'), -5248);
    const mixed = r.rows.find(p => p.id === 'mixed');
    assert.equal(mixed.sales_items.find(i => i.kind === 'bundle').cash_cents, -15413);
    assert.equal(mixed.cash_cents, -10413); assert.notEqual(mixed.cash_cents, mixed.sales_items.find(i => i.kind === 'bundle').cash_cents);
    const failed = r.rows.find(p => p.id === 'failed').sales_items[0];
    assert.equal(failed.units_milli, 0); assert.equal(failed.cash_cents, -5248); assert.equal(failed.sold_cash_cents, 0);
    const sales = aggregateSales(r.rows); assert.equal(sum(sales.rows, 'cash_cents'), sum(r.rows, 'cash_cents'));
    assert.equal(sales.rows.find(i => i.kind === 'multipack').units_milli, 5000);
    assert.deepEqual(salesReturnSummary(r.rows), {failed_count: 1, returned_count: 0, failed_cash_cents: -5248, returned_cash_cents: 0});
    assert.equal(sales.return_packages, 1); assert.equal(sales.failed_delivery_packages, 1); assert.equal(sales.return_cash_cents, -5248);
    const panorama = await f.ok('/ec/panorama');
    assert.deepEqual(panorama.periods.find(p => p.key === 'tum').sales, sales);
    const products = await f.ok('/ec/urun-karlilik');
    assert.deepEqual(products.sales.rows, sales.rows); assert.equal(products.rows.find(p => p.product_id === 'p1').role, 'stock_component_contribution');
  } finally { f.close(); }
});

test('standalone + same product inside bundle in one package preserve line cash and odd VAT/withholding cents', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f, 2000);
    pack(f, 'odd', [{components: [{id: 'p1', revenue: 101, cost: 23, shipping: 7}]},
      {components: [{id: 'p1', revenue: 103, cost: 29, shipping: 11}, {id: 'p2', revenue: 107, cost: 31, shipping: 13}, {id: 'p3', revenue: 109, cost: 37, shipping: 17}]}], {vat: 2000});
    withholding(f, 'odd', 5);
    const row = (await report(f)).rows[0]; reconciles(row);
    assert.equal(row.sales_items.length, 2); assert.deepEqual(new Set(row.sales_items.map(i => i.kind)), new Set(['single', 'bundle']));
    assert.equal(row.sales_items.find(i => i.kind === 'single').revenue_gross_cents, 121);
    assert.equal(sum(row.sales_items, 'withholding_cents'), -5);
    const compact = (await report(f, {detay: false})).rows[0]; assert.deepEqual(compact.sales_items, row.sales_items);
    const again = await report(f); assert.deepEqual(again.rows[0].sales_items, row.sales_items);
  } finally { f.close(); }
});

test('partial component returns never invent fractional sets and zero-quantity complete returns remain ranked', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    pack(f, 'partial-set', [{components: [{id: 'p1'}, {id: 'p2'}, {id: 'p3'}]}]); returned(f, 'partial-set', {component: 1});
    pack(f, 'partial-pack', [{components: [{id: 'p1', quantity: 4}]}]); returned(f, 'partial-pack', {ratio: 0.25});
    pack(f, 'complete', [{components: [{id: 'p3', shipping: 501}]}]); returned(f, 'complete');
    pack(f, 'one-of-two', [{units: 2, components: [{id: 'p2', quantity: 4}]}]); returned(f, 'one-of-two', {ratio: 0.5});
    const r = await report(f); r.rows.forEach(reconciles);
    for (const id of ['partial-set', 'partial-pack']) {
      const i = r.rows.find(p => p.id === id).sales_items[0];
      assert.equal(i.units_milli, null); assert.equal(i.returned_units_milli, null); assert.equal(i.sold_units_milli, 1000);
      assert.equal(i.partial_return, true); assert.equal(i.component_returns[0].quantity_milli, 1000); assert.equal(i.per_unit_cents, null);
    }
    assert.equal(r.rows.find(p => p.id === 'one-of-two').sales_items[0].units_milli, 1000);
    const complete = aggregateSales(r.rows).rows.find(i => i.components.length === 1 && i.components[0].product_id === 'p3');
    assert.equal(complete.units_milli, 0); assert.equal(complete.cash_cents, -501); assert.equal(complete.return_cash_cents, -501);
  } finally { f.close(); }
});

test('historical composition key ignores mutable names/mapping versions and normalizes per sold unit', () => {
  const component = {id: 'c', product_id: 'p1', stock_unit: 'adet', quantity_milli: 20000, mapping_id: 'v1'};
  const original = offeringComposition({id: 'l', quantity_milli: 5000}, [component], new Map([['p1', 'Eski isim']]));
  const renamed = offeringComposition({id: 'l2', quantity_milli: 1000}, [{...component, quantity_milli: 4000, mapping_id: 'v999', current_stock_unit: 'litre'}], new Map([['p1', 'Yeni isim']]));
  assert.equal(original.key, renamed.key); assert.notEqual(original.name, renamed.name); assert.equal(original.kind, 'multipack');
  assert.notEqual(original.key, offeringComposition({id: 'l', quantity_milli: 1000}, [{...component, quantity_milli: 1000}]).key);
  assert.notEqual(original.key, offeringComposition({id: 'l', quantity_milli: 5000}, [{...component, stock_unit: 'litre'}]).key);
  assert.notEqual(original.key, offeringComposition({id: 'l', quantity_milli: 5000}, [{...component, product_id: 'p2'}]).key);
});

test('zero fees remain known, missing cost/fees stay null; new monetary fields are recursively hidden', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    pack(f, 'known'); pack(f, 'unknown-cost', [{components: [{id: 'p2', cost: 0}]}]);
    // Distinct channel has no usable history, so missing fees cannot be estimated.
    pack(f, 'unknown-fees', [{components: [{id: 'p3', shipping: null}]}], {channel: 'hepsiburada'});
    const r = await report(f); r.rows.forEach(reconciles);
    assert.equal(r.rows.find(p => p.id === 'known').sales_items[0].cash_cents, 5000);
    for (const id of ['unknown-cost', 'unknown-fees']) assert.equal(r.rows.find(p => p.id === id).sales_items[0].cash_cents, null);
    const legacy = (await f.ok('/ec/urun-karlilik')).rows.find(p => p.product_id === 'p2');
    assert.equal(legacy.ciro_cents, null); assert.equal(legacy.hesaplanan_kar_cents, null); assert.equal(legacy.teslim_kar_cents, null);
    const agg = aggregateSales(r.rows); assert.equal(agg.count, 3); assert.equal(agg.top.length, 1); assert.equal(agg.rows.find(i => i.components[0].product_id === 'p2').calculated_cash_cents, null);
    const hidden = scrubAmounts({r, agg}, {ec_access: 'read', permissions: {ec: {amounts: 'none'}}}, 'ec');
    let amounts = 0;
    const visit = value => { if (!value || typeof value !== 'object') return; for (const [k, v] of Object.entries(value)) { if (k.endsWith('_cents')) { amounts++; assert.equal(v, null, k); } else visit(v); } };
    visit(hidden); assert.ok(amounts > 50); assert.equal(hidden.r.rows[0].sales_items[0].components[0].quantity_milli, 1000);
  } finally { f.close(); }
});

test('date/channel filters agree across performance, panorama and product sales aggregates', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'today-ty'); pack(f, 'old-ty', undefined, {date: day(-10)}); pack(f, 'today-hb', undefined, {channel: 'hepsiburada'});
    const query = '?from=' + today + '&to=' + today + '&channel=trendyol';
    const r = await f.ok('/ec/performance' + query); assert.deepEqual(r.rows.map(p => p.id), ['today-ty']);
    const expected = aggregateSales(r.rows);
    const panorama = await f.ok('/ec/panorama' + query), product = await f.ok('/ec/urun-karlilik' + query);
    assert.deepEqual(panorama.selected_period.sales, expected); assert.deepEqual(product.sales.rows, expected.rows);
    const all = (await report(f)).rows; assert.deepEqual(aggregateSales(all, {from: today, to: today, channel: 'trendyol'}), expected);
    assert.equal((await f.req('/ec/performance?channel=bad')).status, 400);
  } finally { f.close(); }
});

test('pending scope is 125 shipped minus 3 returns and 6 delivered twins = 116, plus 8 preparing', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'history');
    for (let n = 0; n < 125; n++) pack(f, 'shipped-' + n, undefined, {status: 'shipped', order: 'order-' + n});
    for (let n = 0; n < 3; n++) returned(f, 'shipped-' + n);
    for (let n = 3; n < 9; n++) { pack(f, 'copy-' + n, undefined, {order: 'order-' + n}); returned(f, 'copy-' + n, {technical: true}); }
    for (let n = 0; n < 8; n++) pack(f, 'preparing-' + n, undefined, {status: 'reserved'});
    const pending = await report(f, {mode: 'pending'});
    assert.equal(pending.rows.length, 124); assert.equal(pending.shipped.packages, 116); assert.equal(pending.preparing.packages, 8);
    pending.rows.forEach(reconciles);
    assert.equal(pending.shipped.cash_cents + pending.preparing.cash_cents, sum(pending.rows, 'cash_cents'));
    const paged = await report(f, {mode: 'pending', max: 2, imlec: ''}); assert.equal(paged.rows.length, 2); assert.ok(paged.sonraki_imlec);
    const delivered = await report(f); assert.equal(delivered.rows.filter(p => p.twin_of).length, 6);
    for (const row of delivered.rows) { reconciles(row); if (row.twin_of) assert.equal(row.sales_items[0].has_returns, false); }
    assert.equal(delivered.channels.find(c => c.channel === 'trendyol').awaiting_delivery, 116);
    const panorama = await f.ok('/ec/panorama'); assert.equal(panorama.pending.shipped.packages, 116); assert.equal(panorama.pending.preparing.packages, 8);
    const product = await f.ok('/ec/urun-karlilik'); assert.equal(product.pending.shipped.packages, 116); assert.equal(product.pending.preparing.packages, 8);
  } finally { f.close(); }
});


test('multiple identical lines aggregate once while return package counts and source cash remain distinct', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    pack(f, 'repeat', [{components: [{id: 'p1'}]}, {components: [{id: 'p1', shipping: 301}]}]);
    returned(f, 'repeat', {line: 1});
    const r = await report(f), row = r.rows[0]; reconciles(row);
    assert.equal(row.sales_items.length, 1); const item = row.sales_items[0];
    assert.equal(item.line_ids.length, 2); assert.equal(item.packages, 1); assert.equal(item.return_packages, 1);
    assert.equal(item.units_milli, 1000); assert.equal(item.sold_units_milli, 2000); assert.equal(item.sold_cash_cents, 5000); assert.equal(item.return_cash_cents, -301);
    assert.deepEqual(salesReturnSummary(r.rows), {failed_count: 0, returned_count: 1, failed_cash_cents: 0, returned_cash_cents: -301});
  } finally { f.close(); }
});

test('shipped estimates with missing purchase costs and unavailable pending scopes stay unknown', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f); pack(f, 'history');
    pack(f, 'pending-unknown', [{components: [{id: 'p1', cost: 0}]}], {status: 'shipped'});
    const r = await report(f, {mode: 'pending'}); assert.equal(r.rows.length, 1);
    reconciles(r.rows[0]); assert.equal(r.rows[0].cash_cents, null); assert.equal(r.shipped.cash_cents, null);
    assert.equal(r.shipped.calculated_cash_cents, null); assert.equal(r.preparing.cash_cents, 0);
    assert.equal(pendingSalesSummary(null).shipped.packages, null); assert.equal(pendingSalesSummary(null).preparing.cash_cents, null);
  } finally { f.close(); }
});
