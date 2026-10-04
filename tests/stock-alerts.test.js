import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseFixture} from './warehouse-fixture.test.js';
import {scopedDB} from '../src/scoped-db.js';
import {warehouseReplenishment, reorderProposal} from '../src/warehouse-api.js';
import {stockDemandQuery, stockAlert} from '../src/stock-alerts.js';

function fixture(t) {
 const f = warehouseFixture(); t.after(() => f.close());
 const day = offset => f.sqlite.prepare("SELECT date('now','+3 hours',?) d").get(`${offset} days`).d;
 const product = (id, qty = 100000, min = 0, unit = 'adet') => {
  f.product(id, unit === 'adet' ? qty : 0, 0);
  f.sqlite.prepare('UPDATE ec_products SET min_stock_milli=?,stock_unit=? WHERE id=?').run(min, unit, id);
  if (unit !== 'adet' && qty) f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,0,'opening',?,?)").run('open-'+id,id,qty,'open-'+id,day(-40));
 };
 const sale = (id, productId, qty = 1000, offset = 0, external = id) => {
  f.sqlite.prepare(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on)
   VALUES(?,'other',?,?,'sale',?,0,0,'confirmed',?)`).run(id, external, productId, qty, day(offset));
 };
 const returned = (id, parent, qty, {offset = 0, restock = true, external = id} = {}) => {
  f.sqlite.prepare(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,fees_status,restock,occurred_on)
   SELECT ?,'other',?,product_id,'return',id,?,0,0,'confirmed',?,? FROM ec_sale_entries WHERE id=?`)
   .run(id, external, qty, +restock, day(offset), parent);
 };
 const settings = (id, lead = 3, cover = 4, pack = 1000) =>
  f.sqlite.prepare('INSERT INTO ec_warehouse_reorder_settings(product_id,lead_days,cover_days,pack_milli) VALUES(?,?,?,?)').run(id, lead, cover, pack);
 const history = () => scopedDB(f.env.DB, 'ec').prepare(stockDemandQuery).all().results;
 const pace = (id, offsets = [-6,-5,-4,-3,-2,-1,0], quantity = 1000) => offsets.forEach((offset, i) => sale(id + '-sale-' + i, id, quantity, offset));
 const parcel = (id, productId, {status = 'shipped', qty = 1000, offset = 0, saleId = 'sale-' + id, legacy = false} = {}) => {
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,source_fingerprint) VALUES(?,'other',?,?,'fixture')").run(id,id,day(offset));
  f.sqlite.prepare(`INSERT INTO ec_order_lines(id,package_id,external_id,name,product_id,quantity_milli,net_revenue_cents,gross_cents,vat_bps,sale_id)
   VALUES(?,?,?,'Fixture line',?,?,0,0,2000,?)`).run('line-'+id,id,'line-'+id,legacy ? productId : null,qty,legacy ? saleId : null);
  if (!legacy) f.sqlite.prepare(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,sale_id)
   VALUES(?,?,?,?,10000,'adet',?)`).run('part-'+id,'line-'+id,productId,qty,saleId);
  if (status === 'cancelled') f.sqlite.prepare("UPDATE ec_order_packages SET status='cancelled' WHERE id=?").run(id);
  if (['reserved','shipped','delivered'].includes(status)) f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  if (['shipped','delivered'].includes(status)) f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(day(offset),id);
  if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(day(offset),id);
 };
 return {...f, day, product, sale, returned, settings, history, pace, parcel};
}
const alert = (response, id) => response.replenishment.alerts.find(a => a.product_id === id);

test('normal seven per week and five available means five days; supplier comes from the explicit product link', async t => {
 const f = fixture(t); f.product('normal', 12000); f.pace('normal'); f.settings('normal');
 f.sqlite.exec("INSERT INTO ec_suppliers(id,name,tax_id,contact) VALUES('tropikal','Tropikal','PRIVATE-TAX','PRIVATE-CONTACT'); UPDATE ec_products SET supplier_id='tropikal' WHERE id='normal'");
 const r = await f.call(''), a = alert(r, 'normal');
 assert.equal(a.available_milli, 5000); assert.equal(a.demand_7_milli, 7000); assert.equal(a.daily_demand_milli, 1000);
 assert.equal(a.weekly_demand_milli, 7000); assert.equal(a.days_remaining, 5); assert.equal(a.type, 'low'); assert.equal(a.urgency, 'soon');
 assert.equal(a.supplier_id, 'tropikal'); assert.equal(a.supplier_name, 'Tropikal'); assert.equal(a.supplier_source, 'product.supplier_id');
 assert.equal(a.suggested_milli, 2000); assert.equal(a.projection_basis, 'max_7_30'); assert.ok(a.reason_codes.includes('short_history'));
 assert.equal(a.active_sales_days_7, 7); assert.equal(a.history_days, 7); assert.equal(a.history_completeness, 'unverified');
 assert.equal(r.replenishment.proposals[0].daily_demand_milli, a.daily_demand_milli, 'public proposals share the dashboard forecast');
 assert.equal(r.replenishment.coverage.windows.current_7_from, f.day(-6));
 assert.equal(r.replenishment.coverage.windows.previous_7_from, f.day(-13));
 assert.equal(r.replenishment.coverage.windows.current_30_from, f.day(-29));
 assert.equal(r.replenishment.coverage.windows.through, f.day(0));
 assert.ok(!JSON.stringify(r.replenishment).includes('PRIVATE'));
});

test('urgent is strictly below lead; soon includes lead plus cover; no lead warns at seven days without quantity', async t => {
 const f = fixture(t);
 for (const [id, available, lead, cover] of [
  ['urgent',2000,3,4], ['at-lead',3000,3,4], ['at-cover',7000,3,4], ['above-cover',8000,3,4],
  ['no-lead',7000,null,4], ['no-lead-safe',8000,null,4]
 ]) { f.product(id, available + 7000); f.pace(id); f.settings(id,lead,cover,3000); }
 const r = await f.call('');
 assert.equal(alert(r,'urgent').type,'reorder'); assert.ok(alert(r,'urgent').reason_codes.includes('below_lead'));
 assert.equal(alert(r,'urgent').suggested_milli,6000, 'pack rounding from five units needed');
 assert.equal(alert(r,'at-lead').type,'low'); assert.equal(alert(r,'at-cover').type,'low');
 assert.equal(alert(r,'above-cover'),undefined); assert.equal(alert(r,'no-lead-safe'),undefined);
 assert.equal(alert(r,'no-lead').type,'low'); assert.equal(alert(r,'no-lead').suggested_milli,null);
 assert.ok(alert(r,'no-lead').reason_codes.includes('within_seven_days'));
 assert.ok(r.replenishment.notices.some(n=>n.code==='unknown_lead'));
});

test('minimum, zero and negative stock alert without inventing demand; kg packs remain quantities', async t => {
 const f = fixture(t);
 f.sqlite.prepare("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'").run();
 f.product('min',5000,5000); f.product('zero',0); f.product('negative',1000); f.sale('overdraw','negative',2000);
 f.product('kg',250,1000,'kg'); f.settings('kg',2,3,250);
 f.sqlite.prepare("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'").run();
 const r = await f.call('');
 for (const id of ['min','zero','negative']) assert.equal(alert(r,id).type,'low');
 assert.ok(alert(r,'min').reason_codes.includes('minimum_reached')); assert.equal(alert(r,'min').suggested_milli,null);
 assert.equal(alert(r,'zero').days_remaining,null); assert.equal(alert(r,'zero').daily_demand_milli,0);
 assert.equal(alert(r,'negative').available_milli,-1000); assert.equal(alert(r,'negative').days_remaining,0);
 assert.equal(alert(r,'kg').suggested_milli,750); assert.equal(alert(r,'kg').stock_unit,'kg');
});

test('exact nonoverlapping windows, zero days and dates beyond thirty days do not invent recent history', async t => {
 const f = fixture(t); f.product('windows');
 for (const [offset,qty] of [[-40,1000],[-30,2000],[-29,3000],[-14,4000],[-13,5000],[-7,6000],[-6,7000],[0,8000]]) f.sale('s'+offset,'windows',qty,offset);
 const h = f.history()[0];
 assert.equal(h.demand_7_milli,15000); assert.equal(h.previous_7_milli,11000); assert.equal(h.demand_30_milli,33000);
 assert.equal(h.active_sales_days_7,2); assert.equal(h.active_sales_days_previous_7,2); assert.equal(h.active_sales_days_30,6);
 assert.equal(h.first_sale_on,f.day(-40)); assert.equal(h.history_days,30);
 const p = (await f.call('')).stock[0], a = stockAlert(p,{},h);
 assert.equal(a.projection_basis,'average_30'); assert.equal(a.daily_demand_milli,1100);
 assert.equal(a.daily_previous_7_milli,1571.429); assert.equal(a.weekly_demand_milli,7700);
 f.product('only-old'); f.sale('old-window','only-old',9000,-20);
 const old = f.history().find(h=>h.product_id==='only-old');
 assert.equal(old.demand_7_milli,0); assert.equal(old.previous_7_milli,0); assert.equal(old.demand_30_milli,9000);
});

test('recent acceleration requires three distinct active days and at least a week of history', async t => {
 const f = fixture(t);
 for (const id of ['burst','new','repeat','slower']) f.product(id);
 f.sale('burst-old','burst',1000,-29); f.sale('burst-now','burst',14000);
 f.pace('new',[-2,-1,0],7000);
 f.pace('repeat',[-6,-3,0],7000);
 f.sale('slower-old','slower',70000,-29); f.pace('slower',[-6,-3,0],1000);
 const r = await f.call(''), hs = new Map(f.history().map(h=>[h.product_id,h]));
 const calc = id => stockAlert(r.stock.find(p=>p.id===id),{},hs.get(id));
 assert.equal(calc('burst').projection_basis,'average_30'); assert.equal(calc('burst').daily_demand_milli,500);
 assert.equal(calc('new').projection_basis,'average_30'); assert.equal(calc('new').daily_demand_milli,700);
 assert.equal(calc('new').history_days,3); assert.ok(calc('new').reason_codes.includes('short_history'));
 assert.equal(calc('repeat').projection_basis,'max_7_30'); assert.equal(calc('repeat').daily_demand_milli,3000);
 assert.equal(calc('slower').daily_demand_milli,2433.333, 'a slower recent week does not reduce the 30-day pace');
});

test('customer restocks reduce net consumption; nonrestock returns do not reduce demand (old-query regression)', async t => {
 const f = fixture(t); f.product('returns',12000); f.sale('sold','returns',10000,-8);
 f.returned('restocked','sold',2000,{offset:-2}); f.returned('nonrestocked','sold',3000,{offset:-1,restock:false});
 const r = await f.call(''), h = f.history()[0];
 const old = f.sqlite.prepare("SELECT MAX(0,SUM(iif(kind='sale',quantity_milli,-quantity_milli))) demand FROM ec_sale_entries").get().demand;
 assert.equal(old,5000); assert.equal(h.demand_30_milli,8000); assert.equal(h.previous_7_milli,10000);
 assert.equal(h.demand_7_milli,0); assert.equal(h.restocked_7_milli,2000); assert.equal(h.nonrestocked_30_milli,3000);
 assert.equal(r.stock[0].available_milli,4000); assert.equal(r.replenishment.proposals[0].demand_30_milli,8000);
 const a = stockAlert(r.stock[0],{},h); assert.ok(a.reason_codes.includes('net_demand_clamped'));
 assert.equal(alert(r,'returns'),undefined,'plentiful sparse history stays in coverage');
 assert.equal(a.gross_30_milli,10000); assert.equal(a.restocked_30_milli,2000);
});

test('DUZ double-import and substitution reversals restate original sales even across a window boundary', async t => {
 const f = fixture(t); f.product('duplicate'); f.product('original'); f.product('replacement');
 f.sale('actual','duplicate',7000,-8); f.sale('copy','duplicate',7000,-8);
 f.returned('undo-copy','copy',7000,{offset:0,external:'DUZELTME-CIFT-copy'});
 f.sale('original-sale','original',3000,-9); f.returned('substitution','original-sale',3000,{external:'DUZELTME-IKAME-original'});
 f.sale('replacement-sale','replacement',3000,0,'DUZELTME-EK-replacement');
 const h = new Map(f.history().map(h=>[h.product_id,h]));
 assert.equal(h.get('duplicate').gross_30_milli,7000); assert.equal(h.get('duplicate').previous_7_milli,7000);
 assert.equal(h.get('duplicate').restocked_7_milli,0); assert.equal(h.get('duplicate').active_sales_days_30,1);
 assert.equal(h.get('original').demand_30_milli,0); assert.equal(h.get('original').active_sales_days_30,0);
 assert.equal(h.get('replacement').demand_7_milli,3000, 'zero-revenue replacements consume actual stock');
 f.sale('older-copy','duplicate',2000,-40); f.returned('older-undo','older-copy',2000,{external:'DUZELTME-CIFT-old'});
 assert.equal(f.history().find(h=>h.product_id==='duplicate').demand_30_milli,7000, 'old duplicate reversal does not depress current demand');
});

test('mixed-set components count once; reservations reduce availability but customer transit is not subtracted again', async t => {
 const f = fixture(t); f.product('a',12000,10000); f.product('b',20000,20000);
 f.sqlite.exec(`INSERT INTO ec_catalog_mappings(id,source,match_value,external_code,external_name,version) VALUES('set','other','set','set','Mixed set',1);
 INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES('set-a','set','a',2000,5000),('set-b','set','b',1000,5000);
 UPDATE ec_catalog_mappings SET active=1 WHERE id='set'`);
 f.sale('sale-mixed-a','a',2000); f.sale('sale-mixed-b','b',1000);
 f.parcel('mixed','a',{status:'draft',qty:2000,saleId:'sale-mixed-a'});
 // Both physical components belong to the same listing line before it is shipped.
 f.sqlite.prepare(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,sale_id)
  VALUES('part-mixed-b','line-mixed','b',1000,0,'adet','sale-mixed-b')`).run();
 f.sqlite.exec("UPDATE ec_order_packages SET status='reserved' WHERE id='mixed'");
 f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id='mixed'").run(f.day(0));
 f.parcel('reserved','a',{status:'reserved',qty:5000,saleId:null});
 const r = await f.call(''), a = alert(r,'a'), b = alert(r,'b');
 assert.equal(a.demand_7_milli,2000); assert.equal(b.demand_7_milli,1000); assert.equal(a.on_hand_milli,10000);
 assert.equal(a.reserved_milli,5000); assert.equal(a.available_milli,5000);
 assert.equal(r.stock.find(p=>p.id==='a').in_transit_milli,2000);
 assert.equal(r.replenishment.sets[0].capacity,2);
 assert.equal(r.replenishment.proposals.find(p=>p.product_id==='a').demand_30_milli,2000);
});

test('future and unshipped sales are excluded and incomplete evidence is visible; future returns do not reduce demand', async t => {
 const f = fixture(t); f.product('future'); f.product('draft'); f.product('reserved'); f.product('cancelled'); f.product('future-ship');
 f.sale('future-sale','future',1000,1); f.sale('today-sale','future',2000); f.returned('future-return','today-sale',1000,{offset:1});
 for (const status of ['draft','reserved','cancelled']) {
  f.sale('sale-'+status,status,3000); f.parcel(status,status,{status,qty:3000});
 }
 f.sale('sale-future-ship','future-ship',4000); f.parcel('future-ship','future-ship',{qty:4000,offset:1});
 const r = await f.call(''), h = new Map(f.history().map(h=>[h.product_id,h]));
 assert.equal(h.get('future').demand_7_milli,2000);
 for (const id of ['draft','reserved','cancelled','future-ship']) assert.equal(h.get(id).demand_30_milli,0);
 assert.equal(r.replenishment.coverage.status,'incomplete');
 for (const a of r.replenishment.alerts) {
  assert.ok(a.reason_codes.includes('incomplete_history')); assert.equal(a.days_remaining,null); assert.equal(a.suggested_milli,null);
 }
});

test('unknown availability remains an explicit unknown alert even if a balance row is missing', async t => {
 const f = fixture(t); f.product('missing',0); f.sqlite.exec("DELETE FROM ec_stock_balances WHERE product_id='missing'");
 const r = await f.call(''); assert.equal(r.stock.length,1);
 const a = alert(r,'missing'); assert.equal(a.type,'unknown'); assert.equal(a.available_milli,null); assert.equal(a.suggested_milli,null);
 assert.ok(a.reason_codes.includes('unknown_available')); assert.equal(r.replenishment.coverage.unknown_available_products,1);
 assert.ok(r.replenishment.notices.some(n=>n.code==='unknown_available'));
 const direct = await warehouseReplenishment({DB:scopedDB(f.env.DB,'ec'),WORKSPACE:'ec',USER:{owner:true}},[{...r.stock[0],available_milli:NaN}]);
 assert.equal(direct.alerts[0].available_milli,null);
});

test('plentiful no-history stock is coverage only; brand is not supplier and archived stock stays out of replenishment', async t => {
 const f = fixture(t); f.product('unlinked',10000); f.product('archived',1000);
 f.sqlite.exec("UPDATE ec_products SET brand='Tropikal' WHERE id='unlinked'; UPDATE ec_products SET archived_at=CURRENT_TIMESTAMP WHERE id='archived'");
 const r = await f.call(''), a = stockAlert(r.stock.find(p=>p.id==='unlinked'),{},f.history()[0]);
 assert.equal(alert(r,'unlinked'),undefined); assert.equal(a.type,null); assert.equal(a.supplier_id,null); assert.equal(a.supplier_name,null); assert.equal(a.supplier_source,null);
 assert.equal(a.lead_days,null); assert.equal(a.suggested_milli,null); assert.equal(a.days_remaining,null);
 assert.ok(a.reason_codes.includes('no_history')); assert.equal(r.replenishment.coverage.no_history_products,1);
 assert.equal(alert(r,'archived'),undefined); assert.ok(!r.replenishment.proposals.some(p=>p.product_id==='archived'));
 assert.equal(r.replenishment.coverage.excluded_archived_products,1); assert.equal(r.stock.length,2,'archive balances remain visible for stock counts');
});

test('alerts sort by remaining days then Turkish product name, with unknowns last', async t => {
 const f = fixture(t);
 for (const [id,name,available] of [['b','B',5000],['a','A',5000],['early','Z',1000]]) {
  f.product(id,available+7000); f.pace(id); f.settings(id); f.sqlite.prepare('UPDATE ec_products SET name=? WHERE id=?').run(name,id);
 }
 f.product('unknown',0); f.sqlite.exec("DELETE FROM ec_stock_balances WHERE product_id='unknown'");
 assert.deepEqual((await f.call('')).replenishment.alerts.map(a=>a.product_id),['early','a','b','unknown']);
});

test('quantity-only staff can read alerts, cannot read supplier financial data, and GET is SQL read-only', async t => {
 const f = fixture(t); f.product('staff',12000); f.pace('staff'); f.settings('staff');
 f.sqlite.exec("INSERT INTO ec_suppliers(id,name,tax_id,contact,email,phone,address) VALUES('vendor','Tropikal','secret-tax','secret-contact','secret-mail','secret-phone','secret-address'); UPDATE ec_products SET supplier_id='vendor' WHERE id='staff'");
 const reader = {ec_access:'read',permissions:{ec:{stock:'read',amounts:'none',catalog:'none',ledger:'none',sales:'none',orders:'none'}}};
 const sql = [], prepare = f.env.DB.prepare;
 f.env.DB.prepare = query => { sql.push(query); return prepare(query); };
 const before = f.sqlite.prepare('SELECT total_changes() n').get().n;
 f.sqlite.exec('PRAGMA query_only=ON');
 const r = await f.call('',undefined,'ec',reader); const a = alert(r,'staff');
 assert.equal(a.available_milli,5000); assert.equal(a.weekly_demand_milli,7000); assert.equal(a.supplier_name,'Tropikal');
 assert.equal(r.stock[0].value_cents,null); assert.deepEqual(r.replenishment.sets,[]);
 assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,before);
 assert.ok(sql.every(q=>/^\s*(SELECT|WITH)\b/i.test(q))); assert.ok(sql.length<=6,'bounded queries, not one query per product');
 assert.ok(!sql.some(q=>/panorama|party_entries|supplier_payments|purchase_invoices|performance/i.test(q)));
 assert.ok(!JSON.stringify(r).includes('secret-'));
 assert.ok(Object.keys(a).every(k=>!/cents|price|tax|contact|email|phone|address|balance/.test(k)));
 await assert.rejects(()=>f.call('',undefined,'ec',{ec_access:'read',permissions:{ec:{stock:'none'}}}),e=>e.status===403);
});

test('missing shipment mapping warns instead of reporting an all-clear', async t => {
 const f = fixture(t); f.product('gap'); f.parcel('gap','gap',{saleId:null});
 const r = await f.call(''); assert.equal(alert(r,'gap').history_status,'incomplete');
 assert.equal(r.replenishment.coverage.incomplete_history_products,1);
 f.product('other');
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,source_fingerprint,status,shipped_on) VALUES('unmapped','other','unmapped',?,'fixture','shipped',?)").run(f.day(0),f.day(0));
 const incomplete = await f.call(''); assert.equal(incomplete.replenishment.coverage.unmapped_shipment_count,1);
 assert.ok(incomplete.replenishment.alerts.every(a=>a.reason_codes.includes('incomplete_history')));
});

test('partial technical reversals preserve only the physical remainder and genuine restock from an old sale uses return day', async t => {
 const f = fixture(t); f.product('partial'); f.sale('partial-sale','partial',5000,-9);
 f.returned('partial-duz','partial-sale',2000,{external:'DUZELTME-CIFT-partial'});
 f.returned('customer-restock','partial-sale',1000);
 f.sale('outside','partial',4000,-40); f.returned('outside-restock','outside',1000);
 const h = f.history()[0]; assert.equal(h.gross_previous_7_milli,3000); assert.equal(h.previous_7_milli,3000);
 assert.equal(h.gross_30_milli,3000); assert.equal(h.restocked_7_milli,2000); assert.equal(h.demand_30_milli,1000);
});

test('empty warehouse exposes coverage and notice metadata without invented dates or demand', async t => {
 const f = fixture(t), r = await f.call('');
 assert.deepEqual(r.replenishment.alerts,[]); assert.equal(r.replenishment.coverage.status,'empty');
 assert.equal(r.replenishment.coverage.evaluated_products,0); assert.ok(r.replenishment.notice.length>0);
 assert.ok(r.replenishment.notices.some(n=>n.code==='no_active_products'));
});

test('changed shipment source and unit mismatches retain explicit incomplete-history notices', async t => {
 const f = fixture(t); f.product('changed'); f.product('unit');
 f.sale('sale-changed','changed',1000); f.parcel('changed','changed');
 f.sqlite.exec("UPDATE ec_order_packages SET source_changed=1 WHERE id='changed'");
 f.sale('sale-unit','unit',1000); f.parcel('unit','unit',{status:'draft'});
 f.sqlite.exec("UPDATE ec_order_line_components SET stock_unit='kg' WHERE id='part-unit'");
 const r = await f.call('');
 for (const id of ['changed','unit']) {
  assert.equal(alert(r,id).history_status,'incomplete'); assert.equal(alert(r,id).days_remaining,null);
  assert.equal(alert(r,id).suggested_milli,null);
 }
});

test('legacy line sales cannot bypass unshipped-package exclusion', async t => {
 const f = fixture(t); f.product('legacy'); f.sale('legacy-sale','legacy',2000);
 f.parcel('legacy','legacy',{legacy:true,status:'draft',qty:2000,saleId:'legacy-sale'});
 assert.equal(f.history()[0].demand_30_milli,0); assert.equal(alert(await f.call(''),'legacy').history_status,'incomplete');
});

test('ledger sale without a physical stock movement is incomplete, not ordinary consumption', async t => {
 const f = fixture(t); f.product('missing-movement');
 // Corrupt only this in-memory fixture to simulate legacy data with an absent stock posting.
 f.sqlite.exec('DROP TRIGGER ec_sale_stock'); f.sale('not-posted','missing-movement',9000);
 const h = f.history()[0]; assert.equal(h.demand_30_milli,0); assert.equal(h.issue_count,1);
 const a = alert(await f.call(''),'missing-movement'); assert.equal(a.type,'unknown'); assert.equal(a.days_remaining,null);
});

test('future-dated physical return is excluded and marks already-restored availability as uncertain for prediction', async t => {
 const f = fixture(t); f.product('future-return',12000); f.pace('future-return'); f.settings('future-return');
 f.returned('future-physical-return','future-return-sale-0',1000,{offset:1});
 const a = alert(await f.call(''),'future-return');
 assert.equal(a.demand_7_milli,7000); assert.equal(a.restocked_7_milli,0);
 assert.equal(a.available_milli,6000); assert.equal(a.history_status,'incomplete'); assert.equal(a.days_remaining,null); assert.equal(a.suggested_milli,null);
});

test('plentiful short, sparse and absent history stays in coverage instead of standalone unknown cards', async t => {
 const f = fixture(t); f.product('sparse-70',79000); f.sale('sparse-70-sale','sparse-70',9000,-5);
 f.product('sparse-75',79000); f.sale('sparse-75-sale','sparse-75',4000,-5);
 f.product('no-sales-170',170000);
 const r = await f.call('');
 assert.deepEqual(r.replenishment.alerts,[]);
 assert.equal(r.replenishment.coverage.short_history_products,2); assert.equal(r.replenishment.coverage.sparse_activity_products,3);
 assert.equal(r.replenishment.coverage.no_history_products,1); assert.equal(r.replenishment.coverage.unknown_supplier_products,3);
 assert.equal(r.replenishment.coverage.unknown_lead_products,3); assert.ok(r.replenishment.coverage.notice.length>0);
 assert.equal(r.replenishment.notice,r.replenishment.coverage.notice);
 for (const p of r.replenishment.proposals) assert.equal(p.suggested_milli,null);
});

test('risk cards have readable Turkish notices while unknown lead keeps the suggestion null', async t => {
 const f = fixture(t); f.product('risk',12000); f.pace('risk');
 const a = alert(await f.call(''),'risk');
 assert.equal(a.days_remaining,5); assert.equal(a.type,'low'); assert.equal(a.suggested_milli,null);
 assert.match(a.alert_notice,/en fazla 7 gün/); assert.match(a.alert_notice,/Tedarik süresi eksik/);
 assert.ok(a.reason_codes.includes('within_seven_days')); assert.equal(typeof a.alert_notice,'string');
});

test('public proposals share surge forecasts with dashboard alerts while preserving settings and the legacy helper', async t => {
 const f = fixture(t); f.product('surge',30000,1000); f.sale('surge-old','surge',1000,-29);
 f.pace('surge',[-6,-5,-4,-3,-2,-1,0],3000);
 await f.call('/settings/surge',{revision:0,lead_days:4,cover_days:3,pack_milli:3000,notes:'Warehouse configuration note'});
 const r = await f.call(''), a = alert(r,'surge'), p = r.replenishment.proposals.find(p=>p.product_id==='surge');
 const legacy = reorderProposal(r.stock.find(p=>p.id==='surge'),{lead_days:4,cover_days:3,pack_milli:3000},22000);
 assert.equal(legacy.suggested_milli,0, 'standalone legacy export retains its 30-day calculation');
 assert.equal(a.daily_demand_milli,3000); assert.equal(a.target_milli,21000); assert.equal(a.suggested_milli,15000);
 for (const field of ['daily_demand_milli','weekly_demand_milli','days_remaining','target_milli','suggested_milli','projection_basis','history_status']) {
  assert.equal(p[field],a[field],field+' must match the dashboard');
 }
 assert.equal(p.demand_30_milli,22000); assert.equal(p.demand_7_milli,21000);
 assert.equal(p.lead_days,4); assert.equal(p.cover_days,3); assert.equal(p.pack_milli,3000);
 assert.equal(p.min_stock_milli,1000); assert.equal(p.min_gap_milli,0);
 assert.equal(p.config_revision,1); assert.equal(p.notes,'Warehouse configuration note');
 assert.match(p.reason,/7 ve 30/); assert.match(p.reason,/minimum/i);
});

test('public proposals suppress incomplete-history quantities exactly like dashboard alerts even with a configured minimum', async t => {
 const f = fixture(t); f.product('incomplete',12000,10000); f.pace('incomplete'); f.settings('incomplete',3,4,1000);
 f.parcel('missing-sale','incomplete',{saleId:null});
 const r = await f.call(''), a = alert(r,'incomplete'), p = r.replenishment.proposals.find(p=>p.product_id==='incomplete');
 assert.equal(a.history_status,'incomplete'); assert.equal(a.suggested_milli,null);
 assert.equal(reorderProposal(r.stock[0],{lead_days:3,cover_days:4,pack_milli:1000},7000).suggested_milli,5000);
 for (const field of ['target_milli','suggested_milli','days_remaining']) {
  assert.equal(a[field],null); assert.equal(p[field],null,field+' cannot become a known estimate in the warehouse');
 }
 assert.equal(p.daily_demand_milli,a.daily_demand_milli); assert.equal(p.min_gap_milli,5000);
 assert.equal(p.history_status,'incomplete'); assert.ok(p.reason_codes.includes('incomplete_history'));
 assert.match(p.reason,/hesaplanmadı/);
});

test('returns before their parent sale invalidate both views; valid older-sale returns retain chronology', async t => {
 const f = fixture(t);
 for (const [id,external,offset] of [['customer','RETURN-before-sale',-1],['technical','DUZELTME-IKAME-before-sale',-1],['valid','RETURN-valid',0]]) {
  f.product(id,12000); f.pace(id); f.settings(id); f.returned('return-'+id,id+'-sale-6',1000,{external,offset});
 }
 const r = await f.call('');
 for (const id of ['customer','technical']) {
  const a=alert(r,id), p=r.replenishment.proposals.find(p=>p.product_id===id);
  assert.equal(a.history_status,'incomplete'); assert.equal(p.history_status,'incomplete');
  for (const row of [a,p]) { assert.equal(row.days_remaining,null); assert.equal(row.target_milli,null); assert.equal(row.suggested_milli,null); }
 }
 const valid = r.replenishment.proposals.find(p=>p.product_id==='valid');
 assert.equal(valid.history_status,'short'); assert.notEqual(valid.days_remaining,null); assert.notEqual(valid.suggested_milli,null);
});

test('archived suppliers are unavailable for new replenishment advice without changing the product identity', async t => {
 const f = fixture(t); f.product('vendor-product',12000); f.pace('vendor-product'); f.settings('vendor-product');
 assert.ok(f.sqlite.prepare('PRAGMA table_info(ec_suppliers)').all().some(c=>c.name==='archived_at'));
 f.sqlite.exec("INSERT INTO ec_suppliers(id,name,archived_at) VALUES('old-vendor','Tropikal',CURRENT_TIMESTAMP); UPDATE ec_products SET supplier_id='old-vendor' WHERE id='vendor-product'");
 const r=await f.call(''), a=alert(r,'vendor-product'), p=r.replenishment.proposals[0];
 assert.equal(r.stock[0].supplier_id,'old-vendor','stored product link remains unchanged');
 for (const row of [a,p]) { assert.equal(row.supplier_id,null); assert.equal(row.supplier_name,null); assert.equal(row.supplier_source,null); assert.ok(row.reason_codes.includes('unknown_supplier')); }
 assert.equal(r.replenishment.coverage.unknown_supplier_products,1); assert.match(a.alert_notice,/etkin bir tedarikçi/);
 f.sqlite.exec("UPDATE ec_suppliers SET archived_at=NULL WHERE id='old-vendor'");
 const restored=alert(await f.call(''),'vendor-product'); assert.equal(restored.supplier_name,'Tropikal'); assert.equal(restored.supplier_source,'product.supplier_id');
});
