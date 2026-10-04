// Synthetic SQLite only. No live data, stock rewrites, migration or payment writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {panoramaApi} from '../src/panorama-api.js';
import {tumSatirlar} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';
import {dashboardFinancials, dashboardFinancialDay} from '../src/dashboard-summary.js';

const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const env = f => ({...f.env, ROOT_DB: f.env.DB, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const panorama = (f, query = '') => panoramaApi(new Request('https://test.local/api/ec/panorama' + query), env(f), '/api/panorama');
const report = (f, from, to) => tumSatirlar(env(f), {mode: 'delivered', from, to, detay: true});
const query = (from, to) => '?from=' + from + '&to=' + to;
const fields = {revenue: 'revenue_gross_cents', cost: 'cost_gross_cents', commission: 'commission_gross_cents', shipping: 'shipping_gross_cents', other: 'other_gross_cents', withholding: 'withholding_cents', cash: 'cash_cents'};
function setup(f) {
 f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p','Ürün','P','adet'); UPDATE ec_stock_balances SET quantity_milli=10000000,value_cents=40000000;");
 f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p',1000,0,0,0,0,100,100,100,500,1)");
 for (const [channel, code] of [['trendyol', 'TY'], ['hepsiburada', 'HB']]) {
  f.sqlite.prepare('INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)').run(channel,channel,code,code);
  f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'test')").run('pf-'+channel,channel,channel,JSON.stringify({fee_amounts_include_vat:true,fee_vat_bps:2000}));
  f.sqlite.prepare("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES(?,?,'finance','f.xlsx',10,?,'2026-01-01T10:00','S','[]',1,1,'applied','test')").run('fl-'+channel,channel,(code==='TY'?'a':'b').repeat(64));
 }
}
function parcel(f, id, date, {channel = 'trendyol', revenue = 10001, cost = 3333, commission = 1601, shipping = 3001, other = 501, order = id, status = 'delivered'} = {}) {
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id, channel, 'E-'+id, order, date);
 f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Set veya tekli ilan',1000,?,?,2000)").run('l-'+id,id,'L-'+id,revenue,Math.round(revenue*1.2));
 f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,'p','sale',1000,?,?,?,?,?,?,?)").run('s-'+id,channel,'S-'+id,revenue,cost,commission,shipping,other,[commission,shipping,other].some(x=>x===null)?'pending':'confirmed',date);
 f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,'p',1000,10000,?,'adet')").run('c-'+id,'l-'+id,'s-'+id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date,id);
 if(status==='delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date,id);
}
function refund(f, id, date, technical = false) {
 f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?").run('r-'+id,(technical?'DUZELTME-CIFT-':'IADE-')+id,date,'s-'+id);
}
function withholding(f, id, channel, order, cents) {
 f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,'finance_event',?,'provider',?,'2026-01-01T10:00',?,1)").run('w-'+id,channel,'W-'+id,JSON.stringify({order_no:order,type:'withholding',amount_cents:-cents}),'fl-'+channel);
}

test('dashboard: all-time, selected period, daily, channels reconcile to the shared package gross results without changing legacy daily', async () => {
 const f = appFixture(); try {
  setup(f); parcel(f,'old',day(-100)); parcel(f,'today',today); parcel(f,'hb',today,{channel:'hepsiburada',revenue:20001,cost:5501});
  withholding(f,'hb','hepsiburada','hb',217);
  const p = await panorama(f,query(today,today));
  for (const period of p.periods) {
   const {rows} = await report(f,period.from,period.to), financial = period.financials;
   for (const [key, field] of Object.entries(fields)) {
    const expected = rows.reduce((s,r)=>s+(key==='withholding'?-r[field]:r[field]),0);
    assert.equal(financial[key].total_cents,expected,period.key+': '+key);
    assert.equal(financial[key].recorded_cents+financial[key].estimated_cents,expected);
    assert.equal(financial[key].known_packages,rows.length);
    assert.equal(financial[key].missing_packages,0);
    assert.equal(financial.channels.trendyol[key].total_cents+financial.channels.hepsiburada[key].total_cents,expected);
   }
   assert.equal(financial.fees.total_cents,['commission','shipping','other','withholding'].reduce((s,k)=>s+financial[k].total_cents,0));
   assert.equal(financial.reconciliation_cents,0);
  }
  assert.equal(p.periods.find(x=>x.key==='tum').financials.packages,3);
  assert.equal(p.selected_period.financials.packages,2);
  const lifetime=p.periods.find(x=>x.key==='tum').financials;
  for(const key of ['revenue','cost','fees','cash']) assert.equal(p.financial_daily.reduce((s,d)=>s+d[key+'_cents'],0),lifetime[key].total_cents);
  assert.equal(p.financial_daily.length,101);
  assert.equal(p.daily.reduce((s,d)=>s+d.trendyol+d.hepsiburada,0),lifetime.cash.total_cents);
  const filtered=(await panorama(f,query(today,today)+'&channel=hepsiburada')).selected_period.financials;
  assert.equal(filtered.packages,1); assert.equal(filtered.channels.trendyol.packages,0);
  assert.equal(filtered.withholding.total_cents,217);
 } finally {f.close();}
});

test('dashboard: cost VAT is explicitly profile-based estimate, never silently copied from sale VAT or labelled historical invoices', async () => {
 const f=appFixture();try{
  setup(f); parcel(f,'one',today,{cost:3333});
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.cost.total_cents,3666,'cost profile 10%, sale 20%');
  assert.equal(x.cost.recorded_cents,0); assert.equal(x.cost.estimated_cents,3666); assert.equal(x.cost.estimated_packages,1);
  assert.equal(x.commission.estimated_packages,0,'estimated cost must not taint recorded commission');
  assert.equal(x.cash.estimated_packages,1); assert.equal(x.basis.cost_vat,'current_product_vat_estimate'); assert.equal(x.basis.paid,false);
  assert.match(x.notice,/geçmiş alış faturası toplamı değildir/);
  f.sqlite.exec("UPDATE ec_price_profiles SET vat_bps=2000 WHERE product_id='p'");
  const after=(await panorama(f)).periods[0].financials;
  assert.equal(after.cost.total_cents,4000); assert.equal(after.cost.estimated_packages,1,'changed profile is still an estimate');
 }finally{f.close();}
});

test('dashboard: only the missing fee is estimated; known commission and other fees stay recorded', async () => {
 const f=appFixture();try{
  setup(f); parcel(f,'history',day(-1));parcel(f,'estimated',today,{shipping:null});
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.shipping.total_cents,3601);assert.equal(x.shipping.recorded_cents,0);assert.equal(x.shipping.estimated_cents,3601);assert.equal(x.shipping.estimated_packages,1);
  assert.equal(x.commission.total_cents,1921);assert.equal(x.commission.recorded_cents,1921);assert.equal(x.commission.estimated_cents,0);assert.equal(x.commission.estimated_packages,0);
  assert.equal(x.other.recorded_cents,601);assert.equal(x.other.estimated_packages,0);
  assert.equal(x.fees.recorded_cents,2522);assert.equal(x.fees.estimated_cents,3601);assert.equal(x.reconciliation_cents,0);
 }finally{f.close();}
});

test('dashboard: withholding estimate does not turn real commission or shipping into estimates', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'one',today);
  f.sqlite.exec("UPDATE workspace_settings SET withholding_estimate_channels='trendyol',withholding_estimate_bps=100 WHERE workspace='ec'");
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.withholding.total_cents,100);assert.equal(x.withholding.estimated_cents,100);assert.equal(x.withholding.estimated_packages,1);
  assert.equal(x.shipping.estimated_packages,0);assert.equal(x.commission.estimated_packages,0);
  assert.equal(x.fees.estimated_cents,100);assert.equal(x.reconciliation_cents,0);
 }finally{f.close();}
});

test('dashboard: missing cost, missing VAT, no readable rows and an empty universe are distinct', async () => {
 const f=appFixture();try{
  const empty=(await panorama(f)).periods[0].financials;
  assert.equal(empty.cost.total_cents,0);assert.equal(empty.cost.known_cents,0);assert.equal(empty.packages,0);
  setup(f);parcel(f,'known',today);parcel(f,'no-cost',today,{cost:0});
  let x=(await panorama(f)).periods[0].financials;
  assert.equal(x.cost.total_cents,null);assert.equal(x.cost.known_cents,3666);assert.equal(x.cost.known_packages,1);assert.equal(x.cost.missing_packages,1);assert.equal(x.cash.total_cents,null);assert.equal(x.reconciliation_cents,null);
  f.sqlite.exec("DELETE FROM ec_price_profiles WHERE product_id='p'");
  x=(await panorama(f)).periods[0].financials;
  assert.equal(x.cost.total_cents,null);assert.equal(x.cost.known_cents,null);assert.equal(x.cost.known_packages,0);assert.equal(x.cost.missing_packages,2);
  assert.equal(x.fees.total_cents,12246);assert.equal(x.fees.known_cents,12246,'product VAT gap does not erase known marketplace fees');
 }finally{f.close();}
});

test('dashboard: a failed 92-day chunk makes total and that chart interval unknown, not a zero', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'old',day(-100));parcel(f,'today',today);
  const prepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('SELECT *')&&sql.includes("status='delivered'")&&sql.includes('delivered_on BETWEEN')){const all=s.all.bind(s);s.all=()=>{if(s.args[0]===day(-100))throw Error('Synthetic read outage');return all();};}return s;};
  const p=await panorama(f,query(day(-100),today)),x=p.selected_period.financials;
  assert.equal(x.coverage.complete,false);assert.equal(x.cost.total_cents,null);assert.equal(x.cost.known_cents,3666);assert.equal(x.cost.missing_packages,null);assert.equal(x.packages,null);
  assert.equal(p.periods[0].financials.cost.total_cents,3666,'today remains readable');
  const old=p.financial_daily.find(d=>d.date===day(-100));
  assert.equal(old.partial,true);assert.equal(old.revenue_cents,null);assert.equal(old.cost_cents,null);assert.equal(old.fees_cents,null);assert.equal(old.cash_cents,null);assert.equal(old.packages,null);
  assert.equal(p.financial_daily.at(-1).partial,false);
  const none=dashboardFinancials([],{partial:true});assert.equal(none.cost.total_cents,null);assert.equal(none.cost.known_cents,null);assert.equal(none.cost.recorded_cents,null);
 }finally{f.close();}
});

test('dashboard: failed delivery returns net revenue and cost to zero but retains real shipping; DUZ twin counted once', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'failed',day(-2),{status:'shipped'});refund(f,'failed',today);
  let x=(await panorama(f)).periods[0].financials;
  assert.equal(x.revenue.total_cents,0);assert.equal(x.cost.total_cents,0);assert.equal(x.shipping.total_cents,3601);assert.equal(x.cash.total_cents,-6123);assert.equal(x.reconciliation_cents,0);
  parcel(f,'original',day(-1),{status:'shipped',order:'twin',commission:null,shipping:null,other:null});
  parcel(f,'copy',today,{order:'twin'});refund(f,'copy',today,true);withholding(f,'twin','trendyol','twin',201);
  x=(await panorama(f)).periods[0].financials;
  assert.equal(x.packages,2,'failed return + one economic twin');assert.equal(x.withholding.total_cents,201);assert.equal(x.revenue.total_cents,12001);assert.equal(x.cost.total_cents,3666);assert.equal(x.reconciliation_cents,0);
 }finally{f.close();}
});

test('dashboard: fee subtotal is the joint known-package scope, never a mixture of separately known fee totals', () => {
 const common={channel:'trendyol',revenue_gross_cents:12000,cost_gross_cents:4000,other_gross_cents:100,withholding_cents:-10,cash_cents:null};
 const x=dashboardFinancials([{...common,commission_gross_cents:200,shipping_gross_cents:null},{...common,commission_gross_cents:null,shipping_gross_cents:300}]);
 assert.equal(x.commission.known_cents,200);assert.equal(x.shipping.known_cents,300);assert.equal(x.fees.known_cents,null);assert.equal(x.fees.total_cents,null);assert.equal(x.fees.missing_packages,2);
 const d=dashboardFinancialDay(today,[{...common,commission_gross_cents:200,shipping_gross_cents:null}]);assert.equal(d.fees_cents,null);assert.equal(d.revenue_cents,12000);
});

test('dashboard: future custom-period results appear in the financial series and never contaminate today/all-time', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'past',day(-1));parcel(f,'future',day(1));
  const p=await panorama(f,query(today,day(2)));
  assert.equal(p.selected_period.financials.packages,1);assert.equal(p.periods.find(x=>x.key==='tum').financials.packages,1);
  assert.equal(p.financial_daily.at(-1).date,day(1));assert.equal(p.financial_daily.at(-1).cost_cents,3666);
  assert.equal(p.financial_daily.filter(d=>d.date>today).length,1,'only real future records, no huge synthetic empty future range');
 }finally{f.close();}
});

test('dashboard: read-only staff without amount permission cannot recover totals through summaries, daily or provenance', async () => {
 const f=appFixture();await f.setup();try{
  setup(f);parcel(f,'one',today);
  const staff=await f.ok('/admin/users',{name:'Dashboard reader',username:'dashboard-reader',permissions:{ec:{performance:'read',amounts:'none'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'reader-dashboard-password'});
  const cookie=(await f.req('/auth/login',{username:'dashboard-reader',password:'reader-dashboard-password'})).cookie;
  const r=await f.req('/ec/panorama',undefined,cookie);assert.equal(r.status,200);
  let checked=0;const visit=v=>{if(!v||typeof v!=='object')return;for(const[k,n]of Object.entries(v)){if(k.endsWith('_cents')){assert.equal(n,null,k);checked++;}else visit(n);}};
  visit(r.data.periods.map(p=>p.financials));visit(r.data.financial_daily);assert.ok(checked>100);
  assert.equal(r.data.periods[0].financials.packages,1);assert.equal(r.data.financial_daily[0].packages,1);
 }finally{f.close();}
});

test('dashboard: integer-cent overflow never produces a rounded financial total', () => {
 const row={channel:'trendyol',revenue_gross_cents:Number.MAX_SAFE_INTEGER,cost_gross_cents:0,commission_gross_cents:0,shipping_gross_cents:0,other_gross_cents:0,withholding_cents:0,cash_cents:Number.MAX_SAFE_INTEGER};
 const x=dashboardFinancials([row,row]);assert.equal(x.revenue.total_cents,null);assert.equal(x.revenue.known_cents,null);assert.equal(x.cash.total_cents,null);assert.equal(x.reconciliation_cents,null);assert.equal(x.fees.total_cents,0);
});

test('dashboard coverage: unknown cost keeps recorded commission, shipping, other and revenue independently available', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'unknown-cost',today,{cost:0});withholding(f,'known','trendyol','unknown-cost',99);
  const row=(await report(f,today,today)).rows[0];
  assert.equal(row.cash_cents,null,'legacy cash guard remains');assert.equal(row.cost_gross_cents,undefined,'legacy gross field remains absent');
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.cost.total_cents,null);assert.equal(x.cost.missing_packages,1);
  assert.equal(x.commission.total_cents,1921);assert.equal(x.commission.recorded_cents,1921);assert.equal(x.commission.missing_packages,0);
  assert.equal(x.shipping.total_cents,3601);assert.equal(x.other.total_cents,601);assert.equal(x.withholding.total_cents,99);assert.equal(x.fees.total_cents,6222);
  assert.equal(x.revenue.total_cents,12001);assert.equal(x.cash.total_cents,null);assert.equal(x.reconciliation_cents,null);
  assert.equal((await panorama(f)).financial_daily[0].fees_cents,6222);
 }finally{f.close();}
});

test('dashboard coverage: absent shipping without history leaves only shipping and joint cash/fees unknown', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'no-shipping',today,{shipping:null});
  const row=(await report(f,today,today)).rows[0];assert.equal(row.cash_cents,null);assert.equal(row.commission_gross_cents,undefined,'existing output fields are unchanged');
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.shipping.total_cents,null);assert.equal(x.shipping.missing_packages,1);assert.equal(x.commission.total_cents,1921);assert.equal(x.other.total_cents,601);
  assert.equal(x.commission.estimated_packages,0);assert.equal(x.cost.total_cents,3666);assert.equal(x.cost.estimated_packages,1);assert.equal(x.revenue.total_cents,12001);
  assert.equal(x.fees.total_cents,null);assert.equal(x.cash.total_cents,null);assert.equal(x.reconciliation_cents,null);
 }finally{f.close();}
});

test('dashboard coverage: unsafe changed package sources still expose no partial monetary metadata', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'changed',today);f.sqlite.exec("UPDATE ec_order_packages SET source_changed=1 WHERE id='changed'");
  const row=(await report(f,today,today)).rows[0];assert.equal(row.financial_parts,undefined);
  const x=(await panorama(f)).periods[0].financials;assert.equal(x.commission.total_cents,null);assert.equal(x.revenue.total_cents,null);assert.equal(x.cost.total_cents,null);
 }finally{f.close();}
});

test('dashboard coverage: a cost-VAT gap does not hide fees estimated from real package history', async () => {
 const f=appFixture();try{
  setup(f);parcel(f,'history',day(-1));parcel(f,'vat-gap',today,{shipping:null});
  f.sqlite.exec("DELETE FROM ec_price_profiles WHERE product_id='p'");
  const row=(await report(f,today,today)).rows[0];assert.equal(row.cash_cents,null,'legacy cash remains unknown');
  const x=(await panorama(f)).periods[0].financials;
  assert.equal(x.cost.total_cents,null);assert.equal(x.shipping.total_cents,3601);assert.equal(x.shipping.estimated_cents,3601);assert.equal(x.shipping.estimated_packages,1);
  assert.equal(x.commission.total_cents,1921);assert.equal(x.commission.recorded_cents,1921);assert.equal(x.fees.total_cents,6123);assert.equal(x.cash.total_cents,null);
 }finally{f.close();}
});
