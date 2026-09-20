// Synthetic SQLite fixtures only; no remote database or writes outside the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {panoramaApi} from '../src/panorama-api.js';
import {urunKarlilikApi} from '../src/urun-karlilik-api.js';
import {tumSatirlar} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';

const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const ecEnv = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const panorama = (f, query = '') => panoramaApi(new Request('https://test.local/api/ec/panorama' + query), ecEnv(f), '/api/panorama');
const products = (f, query = '') => urunKarlilikApi(new Request('https://test.local/api/ec/urun-karlilik' + query), ecEnv(f), '/api/urun-karlilik');
const sum = (rows, field) => rows.filter(r => Number.isSafeInteger(r[field])).reduce((t, r) => t + r[field], 0);

function setup(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Tam adıyla Torf 10 L','T10','adet'),('p2','Perlit 5 L','P5','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1),('p2',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=10000000,value_cents=46000000');
  f.sqlite.exec(`INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by)
    VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{"fee_amounts_include_vat":true,"fee_vat_bps":2000}','test'),
    ('pf-ty','trendyol','finance','sig2',1,'{}','{"fee_amounts_include_vat":true,"fee_vat_bps":2000}','test')`);
}

function parcel(f, id, date, {channel = 'trendyol', product = 'p1', revenue = 11000, cost = 4600, order = 'O-' + id, status = 'delivered', occurred = date} = {}) {
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id, channel, 'E-' + id, order, occurred);
  f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Ürün',1000,?,?,2000)").run('l-' + id, id, 'L-' + id, revenue, Math.round(revenue * 1.2));
  f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',1000,?,?,1610,3000,500,'confirmed',?)").run('s-' + id, channel, 'S-' + id, product, revenue, cost, occurred);
  f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,?,1000,10000,?,'adet')").run('c-' + id, 'l-' + id, product, 's-' + id);
  f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(occurred, id);
  if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date, id);
}

test('analytics validates paired real calendar dates before any database access', async () => {
  const env = {WORKSPACE: 'ec', DB: {prepare() { throw Error('Should not query'); }}};
  const bad = ['?from=2026-01-01', '?to=2026-01-01', '?from=&to=', '?from=2026-02-30&to=2026-03-01',
    '?from=2026-01-02&to=2026-01-01', '?from=2026-1-01&to=2026-01-02',
    '?from=2026-01-01&from=2026-01-02&to=2026-01-03', '?from=2026-01-01&to=2026-01-02T00:00:00Z'];
  for (const [handler, path] of [[panoramaApi, '/api/panorama'], [urunKarlilikApi, '/api/urun-karlilik']]) {
    for (const query of bad) await assert.rejects(handler(new Request('https://test.local' + path + query), env, path), e => e.status === 400, path + query);
    await assert.rejects(handler(new Request('https://test.local' + path), {...env, WORKSPACE: 'lp'}, path), e => e.status === 403);
  }
});

test('custom interval is inclusive, presets stay intact, and revenue/cash/margin match the shared result engine', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'older', day(-20));
    parcel(f, 'before', day(-8));
    parcel(f, 'start', day(-7), {product: 'p2', revenue: 20000});
    parcel(f, 'end', day(-2), {revenue: 6000});
    parcel(f, 'today', today);
    const query = '?from=' + day(-7) + '&to=' + day(-2);
    const response = await panorama(f, query), selected = response.selected_period;
    assert.deepEqual(response.periods.map(p => p.key), ['1g', '7g', '14g', '30g', '90g', '180g', 'tum', 'custom']);
    assert.deepEqual(selected, response.periods.find(p => p.key === 'custom'));
    assert.equal(selected.packages, 2);
    assert.equal(selected.from, day(-7));
    assert.equal(selected.to, day(-2));
    assert.equal(selected.status, 'complete');
    const report = await tumSatirlar(ecEnv(f), {mode: 'delivered', from: day(-7), to: day(-2), detay: true});
    assert.equal(selected.revenue_gross_cents, sum(report.rows, 'revenue_gross_cents'));
    assert.equal(selected.cash_cents, sum(report.rows, 'cash_cents'));
    assert.equal(selected.margin_bps, Math.round(selected.cash_cents * 10000 / selected.revenue_gross_cents));
    assert.equal(selected.margin_packages, 2);
    assert.equal(selected.margin_missing, 0);
    assert.equal(selected.products.revenue_top[0].product_id, 'p2');
    assert.equal(selected.products.revenue_top[0].revenue_gross_cents, 24000);
    assert.equal(selected.products.revenue_top[0].name, 'Perlit 5 L');
    assert.equal(selected.gain_cents + selected.loss_cents, selected.cash_cents);
    assert.equal(response.periods.find(p => p.key === '1g').packages, 1);
    assert.equal(response.periods.find(p => p.key === '1g').from, today);
    assert.equal(response.periods.find(p => p.key === '7g').from, day(-6));
    const all = response.periods.find(p => p.key === 'tum');
    assert.equal(all.packages, 5);
    assert.equal(response.daily.reduce((t, g) => t + g.trendyol + g.hepsiburada, 0), all.cash_cents);
    assert.equal((await panorama(f)).selected_period, null);
  } finally { f.close(); }
});

test('order records sum split packages, isolate channels and exclude orders with an unknown package', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'split-a', today, {revenue: 14000, order: 'split'});
    parcel(f, 'split-b', today, {revenue: 14000, order: 'split'});
    parcel(f, 'single', today, {revenue: 24000});
    parcel(f, 'other-channel', today, {channel: 'hepsiburada', revenue: 10000, order: 'split'});
    parcel(f, 'unknown-a', today, {revenue: 50000, order: 'incomplete'});
    parcel(f, 'unknown-b', today, {revenue: 50000, order: 'incomplete', cost: 0});
    const p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.records.orders, 4);
    assert.equal(p.records.revenue.order_no, 'split');
    assert.equal(p.records.revenue.channel, 'trendyol');
    assert.equal(p.records.revenue.revenue_gross_cents, 33600);
    assert.deepEqual(p.records.revenue.package_ids.sort(), ['split-a', 'split-b']);
    assert.equal(p.records.profit.order_no, 'O-single');
    assert.equal(p.records.revenue_missing_orders, 1);
    assert.equal(p.records.profit_missing_orders, 1);
    assert.equal(p.revenue_missing, 1);
    assert.equal(p.status, 'incomplete');
  } finally { f.close(); }
});

test('unknown cost and VAT never become a zero-revenue margin or a winning record', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'known-loss', today, {revenue: 5000});
    parcel(f, 'unknown', today, {product: 'p2', revenue: 99999});
    f.sqlite.exec("DELETE FROM ec_price_profiles WHERE product_id='p2'");
    let p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.revenue_missing, 1);
    assert.equal(p.margin_packages, 1);
    assert.equal(p.margin_missing, 1);
    assert.equal(p.margin_bps, Math.round(p.margin_cash_cents * 10000 / p.margin_revenue_gross_cents));
    assert.ok(p.margin_bps < 0);
    assert.equal(p.records.profit.order_no, 'O-known-loss', 'an unknown zero must not beat a known loss');
    assert.equal(p.products.missing_packages, 1);
    f.sqlite.exec("DELETE FROM ec_price_profiles WHERE product_id='p1'");
    p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.revenue_gross_cents, null);
    assert.equal(p.revenue_missing, 2);
    assert.equal(p.margin_bps, null);
    assert.equal(p.calculated_cash_cents, null);
    assert.equal(p.records.revenue, null);
    assert.equal(p.records.profit, null);
    assert.deepEqual(p.products.revenue_top, []);
  } finally { f.close(); }
});

test('inventory is current book value with explicit VAT gaps, zero VAT and negative stock', async () => {
  const f = appFixture(); try {
    setup(f);
    f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=1000,value_cents=101 WHERE product_id='p1'");
    f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=1000,value_cents=200 WHERE product_id='p2'");
    f.sqlite.exec("UPDATE ec_price_profiles SET vat_bps=0 WHERE product_id='p2'");
    let inventory = (await panorama(f, '?from=2020-01-01&to=2020-01-02')).inventory;
    assert.equal(inventory.net_cents, 301);
    assert.equal(inventory.gross_cents, 321);
    assert.equal(inventory.scope, 'current');
    assert.equal(inventory.date_filter_applies, false);
    assert.equal(inventory.gross_estimated, true);
    assert.equal(inventory.missing_vat_products, 0);
    const unfiltered = (await panorama(f)).inventory;
    assert.equal(unfiltered.net_cents, inventory.net_cents);
    assert.equal(unfiltered.gross_cents, inventory.gross_cents);
    f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('missing-vat','Eksik KDV','M','adet'),('empty','Boş ürün','E','adet'),('negative','Eksi stok','N','adet')");
    f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=1000,value_cents=500 WHERE product_id='missing-vat'");
    f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
    f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=-1000,value_cents=0 WHERE product_id='negative'");
    inventory = (await panorama(f)).inventory;
    assert.equal(inventory.net_cents, 801);
    assert.equal(inventory.gross_cents, null);
    assert.equal(inventory.calculated_gross_cents, 321);
    assert.equal(inventory.missing_vat_products, 2);
    assert.equal(inventory.negative_products, 1);
    assert.equal(inventory.products, 4, 'empty product has no valued inventory and no VAT gap');
    assert.equal(inventory.partial, true);
  } finally { f.close(); }
});

test('product profitability filters result dates and pending order dates while preserving default scope', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'old', day(-20), {product: 'p2'});
    parcel(f, 'delivered', day(-2), {occurred: day(-40)});
    parcel(f, 'pending-in', day(-3), {status: 'shipped'});
    parcel(f, 'pending-out', day(-20), {status: 'shipped', product: 'p2'});
    const query = '?from=' + day(-3) + '&to=' + day(-2);
    const result = await products(f, query);
    assert.equal(result.from, day(-3));
    assert.equal(result.to, day(-2));
    assert.deepEqual(result.date_basis, {delivered: 'delivered_on', pending: 'occurred_on'});
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].product_id, 'p1');
    assert.equal(result.rows[0].paket, 2);
    const delivered = (await tumSatirlar(ecEnv(f), {mode: 'delivered', from: day(-3), to: day(-2), detay: true})).rows;
    const pending = (await tumSatirlar(ecEnv(f), {mode: 'pending', from: day(-3), to: day(-2), detay: true})).rows;
    assert.equal(result.rows[0].teslim_kar_cents, sum(delivered, 'cash_cents'));
    assert.equal(result.rows[0].kargoda_kar_cents, sum(pending, 'cash_cents'));
    assert.equal(result.rows[0].ciro_cents, sum([...delivered, ...pending], 'revenue_gross_cents'));
    assert.equal((await products(f)).rows.reduce((t, r) => t + r.paket, 0), 4);
    assert.deepEqual((await products(f, '?from=2020-01-01&to=2020-01-02')).rows, []);
  } finally { f.close(); }
});

test('more than 1000 same-day results are read exactly once with cursor pagination', async () => {
  const f = appFixture(); try {
    setup(f);
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < 1005; i++) parcel(f, 'bulk-' + String(i).padStart(4, '0'), today);
    f.sqlite.exec('COMMIT');
    const query = '?from=' + today + '&to=' + today;
    const p = (await panorama(f, query)).selected_period;
    assert.equal(p.packages, 1005);
    assert.equal(p.cash_cents, 1005 * 1548);
    assert.equal(p.revenue_gross_cents, 1005 * 13200);
    assert.equal(p.records.orders, 1005);
    assert.equal(p.products.revenue_top[0].packages, 1005);
    const u = (await products(f, query)).rows[0];
    assert.equal(u.paket, 1005);
    assert.equal(u.kar_cents, p.cash_cents);
    assert.equal(u.ciro_cents, p.revenue_gross_cents);
  } finally { f.close(); }
});

test('empty and all-returned periods have no fictitious margin, and return losses use the result engine', async () => {
  const f = appFixture(); try {
    let p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.margin_bps, null);
    assert.equal(p.revenue_gross_cents, 0);
    assert.equal(p.records.revenue, null);
    setup(f);
    parcel(f, 'returned', today);
    f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on)
      SELECT 'r-returned',channel,'RETURN-returned',product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,'${today}' FROM ec_sale_entries WHERE id='s-returned'`);
    p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.revenue_gross_cents, 0);
    assert.equal(p.cash_cents, -6132);
    assert.equal(p.margin_bps, null, 'no division by zero or treating a full return as missing');
    assert.equal(p.revenue_missing, 0);
    assert.equal(p.records.profit.cash_cents, -6132);
  } finally { f.close(); }
});


test('estimated fees keep their shared-engine value and incomplete product revenue is not ranked as complete', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'sample', day(-1));
    parcel(f, 'estimate', today);
    f.sqlite.exec("UPDATE ec_sale_entries SET shipping_cents=NULL,fees_status='pending' WHERE id='s-estimate'");
    let p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.status, 'estimated');
    assert.equal(p.estimated, 1);
    assert.equal(p.records.profit.estimated, true);
    assert.equal(p.margin_bps, Math.round(1548 * 10000 / 13200));
    parcel(f, 'same-product-unknown', today, {cost: 0});
    p = (await panorama(f)).periods.find(p => p.key === '1g');
    assert.equal(p.status, 'incomplete');
    assert.equal(p.products.top[0].cash_cents, 1548, 'legacy calculated cash ranking is preserved');
    assert.equal(p.products.top[0].revenue_missing, 1);
    assert.deepEqual(p.products.revenue_top, [], 'partial product revenue is not a complete ranking candidate');
  } finally { f.close(); }
});

test('failed history chunk marks its exact custom scope incomplete while current cards remain available', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'old-chunk', day(-100));
    parcel(f, 'new-chunk', today);
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT *') && sql.includes("status='delivered'") && sql.includes('delivered_on BETWEEN')) {
        const all = statement.all.bind(statement);
        statement.all = () => {
          if (statement.args[0] === day(-100)) throw Error('Synthetic history read failure');
          return all();
        };
      }
      return statement;
    };
    const result = await panorama(f, '?from=' + day(-100) + '&to=' + day(-99));
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.missing.length, 1);
    assert.equal(result.selected_period.partial, true);
    assert.equal(result.selected_period.status, 'incomplete');
    assert.equal(result.selected_period.revenue_gross_cents, null);
    assert.equal(result.selected_period.calculated_cash_cents, null);
    assert.equal(result.selected_period.margin_bps, null);
    assert.equal(result.selected_period.records.partial, true);
    const current = result.periods.find(p => p.key === '1g');
    assert.equal(current.partial, false);
    assert.equal(current.cash_cents, 1548);
    assert.equal(current.status, 'complete');
  } finally { f.close(); }
});

test('future custom range uses bounded cursor reads, preserves current presets, and analytics writes nothing', async () => {
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'future', day(1));
    let queries = 0;
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = sql => { queries++; return prepare(sql); };
    const changes = f.sqlite.prepare('SELECT total_changes() n').get().n;
    const result = await panorama(f, '?from=' + day(1) + '&to=9999-12-31');
    assert.equal(result.selected_period.packages, 1);
    assert.equal(result.selected_period.cash_cents, 1548);
    assert.equal(result.selected_period.prev_cash_cents, null);
    assert.equal(result.periods.find(p => p.key === 'tum').packages, 0);
    assert.equal(result.first_delivered, null);
    assert.deepEqual(result.daily, [{date: day(1), trendyol: 1548, hepsiburada: 0, packages: 1}]);
    assert.ok(queries < 70, 'distant to date must not create thousands of empty chunk queries: ' + queries);
    assert.equal((await products(f, '?from=' + day(1) + '&to=' + day(1))).rows[0].kar_cents, 1548);
    assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n, changes);
  } finally { f.close(); }
});

test('amount permissions redact new money and margin fields including the shared selected-period object', async () => {
  const {scrubAmounts} = await import('../src/permission-policy.js');
  const f = appFixture(); try {
    setup(f);
    parcel(f, 'visible-result', today);
    const result = await panorama(f, '?from=' + today + '&to=' + today);
    const user = {owner: false, ec_access: 'read', permissions: {ec: {performance: 'read', amounts: 'none'}}};
    const hidden = scrubAmounts(result, user, 'ec');
    assert.equal(hidden.selected_period.margin_bps, null);
    assert.equal(hidden.periods.find(p => p.key === 'custom').margin_bps, null);
    assert.equal(hidden.selected_period.revenue_gross_cents, null);
    assert.equal(hidden.selected_period.records.profit.cash_cents, null);
    assert.equal(hidden.inventory.net_cents, null);
    assert.equal(hidden.inventory.gross_cents, null);
    assert.equal(hidden.selected_period.packages, 1);
    assert.equal(scrubAmounts(result, {owner: true}, 'ec'), result);
    assert.equal(result.selected_period.margin_bps, Math.round(1548 * 10000 / 13200), 'redaction must not mutate source');
  } finally { f.close(); }
});

test('daily channel money is masked through aliases without erasing channel metadata or counts', async () => {
  const {scrubAmounts} = await import('../src/permission-policy.js');
  const user = {owner: false, ec_access: 'read', permissions: {ec: {performance: 'read', amounts: 'none'}}};
  const shared = {date: today, packages: 2, trendyol: 65432, hepsiburada: -1200};
  const zero = {date: day(-1), packages: 0, trendyol: 0, hepsiburada: 0};
  const mixed = {date: day(-2), packages: 1, trendyol: null, hepsiburada: 123};
  const payload = {
    // Alias precedes daily: first traversal must already mask it.
    selected_day: shared, daily: [shared, zero, mixed], repeated: {day: shared},
    channels: {trendyol: {name: 'Trendyol', packages: 2, cash_cents: 65432}, hepsiburada: {name: 'Hepsiburada', packages: 1}},
    counts: {trendyol: 2, hepsiburada: 1},
    labels: {date: today, packages: 2, trendyol: 'Trendyol', hepsiburada: 'Hepsiburada'},
    statuses: {date: today, packages: 2, trendyol: {connected: true}, hepsiburada: {connected: false}},
    dated_metadata: {date: today, trendyol: 7, hepsiburada: 8},
    margin_bps: 1500
  };
  const hidden = scrubAmounts(payload, user, 'ec');
  for (const row of [...hidden.daily, hidden.selected_day, hidden.repeated.day]) {
    assert.equal(row.trendyol, null);
    assert.equal(row.hepsiburada, null);
  }
  assert.equal(hidden.selected_day, hidden.daily[0]);
  assert.equal(hidden.repeated.day, hidden.daily[0]);
  assert.equal(hidden.daily[0].date, today);
  assert.equal(hidden.daily[0].packages, 2);
  assert.equal(hidden.daily[1].packages, 0);
  assert.deepEqual(hidden.counts, payload.counts);
  assert.deepEqual(hidden.labels, payload.labels);
  assert.deepEqual(hidden.statuses, payload.statuses);
  assert.deepEqual(hidden.dated_metadata, payload.dated_metadata);
  assert.equal(hidden.channels.trendyol.name, 'Trendyol');
  assert.equal(hidden.channels.trendyol.packages, 2);
  assert.equal(hidden.channels.trendyol.cash_cents, null);
  assert.equal(hidden.margin_bps, null, 'preserve margin integration');
  assert.equal(shared.trendyol, 65432, 'original object is unchanged');
  assert.equal(zero.trendyol, 0);
  assert.equal(scrubAmounts(payload, {owner: true}, 'ec'), payload);
  assert.equal(scrubAmounts(payload, {...user, permissions: {ec: {performance: 'read', amounts: 'read'}}}, 'ec'), payload);
});

test('real panorama request masks daily cash for amount-restricted staff and preserves authorized results', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    parcel(f, 'ty-positive', today);
    parcel(f, 'hb-loss', today, {channel: 'hepsiburada', revenue: 5000});
    const url = '/ec/panorama?from=' + today + '&to=' + today;
    const owner = await f.ok(url);
    assert.equal(owner.daily.at(-1).trendyol, 1548);
    assert.equal(owner.daily.at(-1).hepsiburada, -5652);
    let sequence = 0;
    const login = async ec => {
      const username = 'analytics-staff-' + (++sequence), password = 'synthetic-analytics-password-' + sequence;
      const staff = await f.ok('/admin/users', {name: username, username, permissions: {ec, lp: {}, delete_records: false}});
      const accepted = await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password});
      assert.equal(accepted.status, 200);
      const session = await f.req('/auth/login', {username, password});
      assert.equal(session.status, 200);
      assert.ok(session.cookie);
      return session.cookie;
    };
    const limited = await login({performance: 'read', amounts: 'none'});
    const response = await f.req(url, undefined, limited);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.daily.length, owner.daily.length);
    for (let i = 0; i < response.data.daily.length; i++) {
      assert.equal(response.data.daily[i].trendyol, null);
      assert.equal(response.data.daily[i].hepsiburada, null);
      assert.equal(response.data.daily[i].date, owner.daily[i].date);
      assert.equal(response.data.daily[i].packages, owner.daily[i].packages);
    }
    assert.equal(response.data.selected_period.margin_bps, null);
    assert.equal(response.data.selected_period.cash_cents, null);
    assert.equal(response.data.selected_period.channels.trendyol.packages, 1);
    assert.equal(response.data.selected_period.records.profit.channel, 'trendyol');
    assert.equal(response.data.selected_period.records.profit.cash_cents, null);
    const allowed = await login({performance: 'read', amounts: 'read'});
    const authorized = await f.req(url, undefined, allowed);
    assert.equal(authorized.status, 200);
    assert.deepEqual(authorized.data.daily, owner.daily);
    assert.equal(authorized.data.selected_period.margin_bps, owner.selected_period.margin_bps);
    const noReport = await login({stock: 'read', amounts: 'none'});
    assert.equal((await f.req(url, undefined, noReport)).status, 403);
  } finally { f.close(); }
});

test('public performance cursor rejects duplicated, malformed and oversized values before database reads', async () => {
  const {performanceApi} = await import('../src/performance-api.js');
  const env = {WORKSPACE: 'ec', DB: {prepare() { throw Error('Invalid cursor must not query database'); }}};
  const base = 'https://test.local/api/ec/performance?from=' + today + '&to=' + today + '&';
  for (const query of ['cursor=a&cursor=b', 'cursor=&cursor=', 'cursor=' + 'a'.repeat(201),
    'cursor=%20', 'cursor=a%0Ab', 'cursor=%00', 'cursor=%FF', 'cursor=a%2Fb', 'cursor=%22', 'cursor=%7B%7D']) {
    await assert.rejects(performanceApi(new Request(base + query), env, '/api/performance'),
      e => e.status === 400 && /imleci/.test(e.message), query.slice(0, 70));
  }
});

test('public performance cursor pages 1005 same-day results without gaps while absent cursor keeps legacy 409', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    const ids = [];
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < 1005; i++) {
      const id = 'public-' + String(i).padStart(4, '0'); ids.push(id);
      parcel(f, id, today, {channel: i % 2 ? 'hepsiburada' : 'trendyol', revenue: i % 3 ? 11000 : 5000});
    }
    parcel(f, 'out-of-scope', day(-2));
    f.sqlite.exec('COMMIT');
    const scope = new URLSearchParams({mode: 'delivered', from: today, to: today});
    const legacy = await f.req('/ec/performance?' + scope);
    assert.equal(legacy.status, 409, 'no cursor preserves legacy package limit');
    const rows = [], seen = new Set(), pageSizes = [];
    let cursor = '';
    do {
      const query = new URLSearchParams(scope); query.set('cursor', cursor);
      const response = await f.req('/ec/performance?' + query);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.mode, 'delivered');
      assert.equal(response.data.from, today);
      assert.equal(response.data.to, today);
      assert.ok(Object.hasOwn(response.data, 'sonraki_imlec'));
      pageSizes.push(response.data.rows.length);
      assert.ok(response.data.rows.length <= 1000);
      for (const row of response.data.rows) {
        assert.ok(!seen.has(row.id), 'duplicate economic package: ' + row.id);
        seen.add(row.id); rows.push(row);
      }
      const next = response.data.sonraki_imlec;
      assert.ok(next === null || typeof next === 'string' && next > cursor, 'cursor advances or ends explicitly');
      if (next !== null) assert.match(next, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      cursor = next;
      assert.ok(pageSizes.length <= 3, 'bounded traversal');
    } while (cursor !== null);
    assert.deepEqual(pageSizes, [1000, 5]);
    assert.deepEqual([...seen].sort(), ids);
    const internal = await tumSatirlar(ecEnv(f), {mode: 'delivered', from: today, to: today});
    assert.deepEqual(rows, internal.rows, 'public pages preserve every shared-engine economic field');
    assert.equal(sum(rows, 'cash_cents'), sum(internal.rows, 'cash_cents'));
    assert.equal(sum(rows, 'revenue_gross_cents'), sum(internal.rows, 'revenue_gross_cents'));
    assert.equal(sum(rows, 'profit_cents'), sum(internal.rows, 'profit_cents'));
    const afterEnd = await f.ok('/ec/performance?' + scope + '&cursor=' + ids.at(-1));
    assert.deepEqual(afterEnd.rows, []);
    assert.equal(afterEnd.sonraki_imlec, null);
    const malformed = await f.req('/ec/performance?' + scope + '&cursor=%00');
    assert.equal(malformed.status, 400, 'real route returns validation error');
  } finally { f.close(); }
});

test('public performance cursor also starts pending pages and accepts a 200-character identifier boundary', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    parcel(f, 'history', day(-1));
    parcel(f, 'pending-a', today, {status: 'shipped'});
    const scope = new URLSearchParams({mode: 'pending', from: today, to: today});
    const legacy = await f.ok('/ec/performance?' + scope);
    const first = await f.ok('/ec/performance?' + scope + '&cursor=');
    assert.deepEqual(first.rows, legacy.rows);
    assert.equal(first.mode, 'pending');
    assert.equal(first.rows.length, 1);
    assert.equal(first.sonraki_imlec, null);
    const empty = await f.ok('/ec/performance?' + scope + '&cursor=' + 'z'.repeat(200));
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.sonraki_imlec, null);
  } finally { f.close(); }
});
