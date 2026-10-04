import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {moneyPlanningApi} from '../src/money-planning-api.js';
import {warehouseApi} from '../src/warehouse-api.js';
import {accountingApi} from '../src/accounting.js';
import {ledgerApi} from '../src/ledger-api.js';
import {purchaseAdjustmentApi} from '../src/purchase-adjustment-api.js';
import {tumSatirlar} from '../src/performance-api.js';

// Independent review: actual migration chain and SQLite, no network or persistent DB.
// Regression assertions describe correct behavior; an unresolved defect stays red.
const owner={owner:true,id:'review-owner'},date='2026-09-10';
const period='?from=2026-09-01&to=2026-09-30';
function fixture(){
 const f=appFixture();
 const env=(ns='ec',user=owner)=>({...f.env,DB:scopedDB(f.env.DB,ns),ROOT_DB:f.env.DB,WORKSPACE:ns,USER:user});
 const invoke=(handler,path,body,ns='ec',user=owner)=>handler(new Request('https://review.test'+path,{method:body===undefined?'GET':'POST'}),env(ns,user),path.split('?')[0],async()=>body);
 const money=(mode='calendar',query=period,ns='ec',user=owner)=>invoke(moneyPlanningApi,'/api/'+(mode==='calendar'?'money-calendar':'business-result')+query,undefined,ns,user);
 const warehouse=(path='',body,user=owner)=>invoke(warehouseApi,'/api/warehouse'+path,body,'ec',user);
 const ledger=(path,body,ns='ec')=>invoke(ledgerApi,'/api/ledger'+path,body,ns);
 const accounting=(path,body)=>invoke(accountingApi,'/api/accounting'+path,body);
 const product=(id,quantity=0,value=0,unit='adet')=>{
  f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,?)').run(id,id,id,unit);
  if(quantity)f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,?,'opening',?,?)").run('opening-'+id,id,quantity,value,'opening-'+id,'2026-09-01');
 };
 const create=ids=>warehouse('/sessions',{request_key:crypto.randomUUID(),title:'Independent review',product_ids:ids});
 const save=(s,lines)=>warehouse('/sessions/'+s.session.id+'/lines',{revision:s.session.revision,lines});
 const review=s=>warehouse('/sessions/'+s.session.id+'/review',{revision:s.session.revision});
 const apply=s=>warehouse('/sessions/'+s.session.id+'/apply',{revision:s.session.revision,review_token:s.session.review_token});
 return {...f,env,invoke,money,warehouse,ledger,accounting,product,create,save,review,apply};
}

function expenseInvoice(f,id,net,treatment='general',when=date,ns='ec'){
 f.sqlite.prepare(`INSERT OR IGNORE INTO ${ns}_suppliers(id,name) VALUES('supplier','Review supplier')`).run();
 f.sqlite.prepare(`INSERT INTO ${ns}_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,'supplier',?,?)`).run(id,id,when);
 f.sqlite.prepare(`INSERT INTO ${ns}_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,net_cents,tax_cents,line_type,expense_category,expense_treatment) VALUES(?,?,'Review service',1,'adet',?,0,'expense','shipping',?)`).run('line-'+id,id,net,treatment);
 f.sqlite.prepare(`UPDATE ${ns}_purchase_invoices SET status='posted' WHERE id=?`).run(id);
 return 'line-'+id;
}
function delivered(f,id,channel='trendyol'){
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,source_fingerprint) VALUES(?,?,?,?,?,'review')").run(id,channel,id,id,date);
 f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Review item',1000,10000,12000,2000)").run('line-'+id,id,'line-'+id);
 f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,'p','sale',1000,10000,4000,1000,500,100,'confirmed',?)").run('sale-'+id,channel,'sale-'+id,date);
 f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,'p',1000,10000,?,'adet')").run('component-'+id,'line-'+id,'sale-'+id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date,id);
 f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date,id);
}

test('review R1: count losses round fractional cents before writing stock and expense',async()=>{
 const f=fixture();try{
  f.product('round',10000,10009);
  let s=await f.create(['round']);s=await f.save(s,[{product_id:'round',counted_milli:8000}]);
  s=await f.review(s);const preview=s.lines[0].delta_value_cents;await f.apply(s);
  const movement=f.sqlite.prepare("SELECT value_cents FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get();
  const expense=f.sqlite.prepare("SELECT amount_cents FROM ec_expenses WHERE category='loss'").get();
  assert.deepEqual({preview,movement:movement.value_cents,expense:expense.amount_cents},{preview:-2002,movement:-2002,expense:2002});
 }finally{f.close();}
});

test('review R2: recount validates quantity using the current physical unit',async()=>{
 const f=fixture();try{
  f.product('unit',0,0,'kg');let s=await f.create(['unit']);
  s=await f.save(s,[{product_id:'unit',counted_milli:1500,unit_cost_cents:100}]);
  await f.accounting('/products/unit',{name:'unit',sku:'unit',stock_unit:'adet',min_stock:0});
  await assert.rejects(()=>f.review(s),e=>e.status===409);
  // Changing the unit is allowed before any movement. Recount must use the new unit.
  await assert.rejects(async()=>{
   s=await f.save(s,[{product_id:'unit',counted_milli:1500,unit_cost_cents:100,recount:true}]);
   s=await f.review(s);await f.apply(s);
  },e=>e.status===400||e.status===409,'A stale kg line must not post 1.5 adet after rebasing');
  assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='unit'").get().quantity_milli,0);
 }finally{f.close();}
});

test('review: service corrections and reversals affect their own period exactly once',async()=>{
 const f=fixture();try{
  const line=expenseInvoice(f,'general',10000);
  const adjustment=await f.invoke(purchaseAdjustmentApi,'/api/invoices/general/adjustments',{line_id:line,kind:'service',net:20,tax:0,stock_net:0,reference:'CREDIT',reason:'Review credit',occurred_on:'2026-09-11'});
  let r=await f.money('result');assert.equal(r.summary.overhead_cents,8000);assert.equal(r.summary.operating_result_cents,-8000);
  assert.equal((await f.money('result','?from=2026-09-10&to=2026-09-10')).summary.overhead_cents,10000);
  assert.equal((await f.money('result','?from=2026-09-11&to=2026-09-11')).summary.overhead_cents,-2000);
  await f.invoke(purchaseAdjustmentApi,'/api/invoices/general/adjustments/'+adjustment.adjustment_id+'/reverse',{reference:'REVERSE-CREDIT',reason:'Review reversal',occurred_on:'2026-09-12'});
  r=await f.money('result');assert.equal(r.summary.overhead_cents,10000);assert.equal(r.overhead.length,3);
 }finally{f.close();}
});

test('review: delivered package contribution includes costs once and unallocated sales fees block a final result',async()=>{
 const f=fixture();try{
  f.product('p',10000,40000);delivered(f,'marketplace');delivered(f,'other-channel','other');
  expenseInvoice(f,'general',1000);
  const authoritative=await tumSatirlar(f.env(),{mode:'delivered',from:'2026-09-01',to:'2026-09-30'});
  let r=await f.money('result');assert.equal(r.summary.packages,1);assert.equal(r.summary.contribution_cents,4400);
  assert.equal(r.summary.contribution_cents,authoritative.rows.reduce((n,p)=>n+p.profit_cents,0));
  assert.equal(r.summary.operating_result_cents,3400);
  expenseInvoice(f,'pending-fee',700,'sales_fee');
  r=await f.money('result');assert.equal(r.summary.overhead_cents,1000);assert.equal(r.summary.unallocated_fee_cents,700);assert.equal(r.status,'incomplete');assert.equal(r.summary.operating_result_cents,null);
 }finally{f.close();}
});

test('review: partial cash settlement and cheque payment do not duplicate expected debt',async()=>{
 const f=fixture();try{
  const p=(await f.ledger('/parties',{name:'Review party',kind:'supplier'})).id;
  const a=(await f.ledger('/accounts',{name:'Review bank',kind:'bank'})).id;
  const debt=(await f.ledger('/entries',{party_id:p,amount:-100,occurred_on:date,due_on:'2026-09-20',reference:'DEBT',description:'Review debt'})).id;
  const pay=await f.ledger('/cash',{party_id:p,account_id:a,direction:'payment',amount:30,occurred_on:date,reference:'PAY',description:'Partial payment'});
  await f.ledger('/allocations',{positive_entry_id:pay.party_entry_id,negative_entry_id:debt,amount:30,reference:'ALLOC-CASH'});
  const cheque=(await f.ledger('/payments',{party_id:p,amount:70,occurred_on:date,reference:'CHEQUE',method:'cek',due_on:'2026-09-20',note:'Review cheque'})).id;
  let r=await f.money();assert.equal(r.summary.expected.outgoing.amount_cents,7000);assert.equal(r.summary.recorded.outgoing.amount_cents,3000);assert.equal(r.rows.filter(x=>x.kind==='ledger').length,0);
  // Link a real outgoing bank transaction to the cheque entry.
  f.sqlite.prepare("INSERT INTO ec_cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description) VALUES('cleared',?,?,-7000,'2026-09-20','CLEAR','Cheque cleared')").run(a,cheque);
  r=await f.money();assert.equal(r.summary.expected.outgoing.amount_cents,0);assert.equal(r.summary.recorded.outgoing.amount_cents,10000);assert.equal(r.summary.recorded_net_cents,-10000);
 }finally{f.close();}
});

test('review: namespace isolation, all calendar pages, and read-only calculations',async()=>{
 const f=fixture();try{
  for(const ns of ['ec','lp'])f.sqlite.prepare(`INSERT INTO ${ns}_suppliers(id,name) VALUES('same-id',?)`).run(ns+' private party');
  const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES(?,'same-id',100,'2026-09-10','2026-09-20',?,'EC row','manual',?)");
  f.sqlite.exec('BEGIN');for(let n=0;n<501;n++){const id='row-'+String(n).padStart(4,'0');insert.run(id,id,id);}f.sqlite.exec('COMMIT');
  f.sqlite.exec("INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source,source_key) VALUES('row-0000','same-id',987654,'2026-09-10','2026-09-20','LP-SECRET','LP row','manual','lp-source')");
  const before=f.sqlite.prepare('SELECT total_changes() n').get().n;
  const ec=await f.money(),lp=await f.money('calendar',period,'lp');
  assert.equal(ec.summary.expected.incoming.amount_cents,50100);assert.equal(ec.rows.length,501);assert.equal(lp.summary.expected.incoming.amount_cents,987654);
  assert.ok(ec.rows.every(r=>r.party_name==='ec private party'));assert.ok(lp.rows.every(r=>r.party_name==='lp private party'));
  await f.money('result');assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,before);
 }finally{f.close();}
});

test('review: real Worker sessions enforce money intersections and redact count values',async()=>{
 const f=fixture();try{
  await f.setup();f.product('secret',10000,987654);let s=await f.create(['secret']);s=await f.save(s,[{product_id:'secret',counted_milli:9000}]);
  const account=await f.ok('/admin/users',{name:'Independent reviewer',username:'independent-reviewer',permissions:{ec:{stock:'read',ledger:'read',performance:'read',expenses:'read',amounts:'none'},lp:{},delete_records:false}});
  const invite=await f.req('/auth/accept-invite',{token:account.invite_path.split('invite=')[1],password:'synthetic-review-password'});assert.equal(invite.status,200);
  const login=await f.req('/auth/login',{username:'independent-reviewer',password:'synthetic-review-password'});assert.equal(login.status,200);
  for(const path of ['/ec/money-calendar','/ec/business-result','/lp/money-calendar','/lp/warehouse/sessions/'+s.session.id])assert.equal((await f.req(path,undefined,login.cookie)).status,403,path);
  const detail=await f.req('/ec/warehouse/sessions/'+s.session.id,undefined,login.cookie);assert.equal(detail.status,200);
  assert.equal(detail.data.lines[0].snapshot_value_cents,null);assert.equal(detail.data.lines[0].delta_value_cents,null);assert.equal(detail.data.summary.delta_value_cents,null);
  assert.equal(detail.data.lines[0].snapshot_quantity_milli,10000);assert.ok(!JSON.stringify(detail.data).includes('987654'));
  const write=await f.req('/ec/warehouse/sessions/'+s.session.id+'/review',{revision:s.session.revision},login.cookie);assert.equal(write.status,403);
 }finally{f.close();}
});


test('review: cash reversals retain their own period and net schedules never inflate gross cash',async()=>{
 const f=fixture();try{
  const account=(await f.ledger('/accounts',{name:'Review bank',kind:'bank'})).id;
  const receipt=await f.ledger('/cash',{account_id:account,direction:'receipt',amount:50,occurred_on:'2026-09-10',reference:'RECEIPT',description:'Unlinked bank receipt'});
  await f.ledger('/reverse',{cash_transaction_id:receipt.id,reason:'Review reversal',occurred_on:'2026-09-11',reference:'REVERSE-RECEIPT'});
  f.sqlite.exec("INSERT INTO ec_expense_schedules(id,label,category,amount_cents,day_of_month,starts_on) VALUES('rent-plan','Rent','rent',2500,20,'2026-09-01')");
  let r=await f.money();assert.equal(r.summary.recorded_net_cents,0);
  assert.equal((await f.money('calendar','?from=2026-09-10&to=2026-09-10')).summary.recorded_net_cents,5000);
  assert.equal((await f.money('calendar','?from=2026-09-11&to=2026-09-11')).summary.recorded_net_cents,-5000);
  assert.equal(r.summary.expected.outgoing.amount_cents,null);assert.equal(r.summary.expected.outgoing.net_only_cents,2500);
  f.sqlite.exec("INSERT INTO ec_expenses(id,reference,category,amount_cents,occurred_on,paid,label) VALUES('rent-record','GIDER-PLAN-rent-plan-2026-09','rent',2500,'2026-09-20',0,'Rent')");
  r=await f.money();assert.equal(r.rows.filter(x=>x.reference==='GIDER-PLAN-rent-plan-2026-09').length,1);assert.equal(r.summary.expected.outgoing.net_only_cents,2500);
  const limited={ec_access:'read',lp_access:'none',permissions:{ec:{ledger:'read',amounts:'read',expenses:'none'},lp:{}}};
  r=await f.money('calendar',period,'ec',limited);assert.equal(r.access.expenses,false);assert.ok(r.rows.every(x=>!['expense','schedule'].includes(x.kind)));
 }finally{f.close();}
});

test('review: reservations created after count review still block application atomically',async()=>{
 const f=fixture();try{
  f.product('reserved',10000,10000);let s=await f.create(['reserved']);s=await f.save(s,[{product_id:'reserved',counted_milli:8000}]);s=await f.review(s);
  f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,source_fingerprint) VALUES('reserve-package','other','reserve-package','2026-09-10','review'); INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,gross_cents,vat_bps,net_revenue_cents) VALUES('reserve-line','reserve-package','reserve-line','Review',9000,10800,2000,9000); INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit) VALUES('reserve-component','reserve-line','reserved',9000,10000,'adet'); UPDATE ec_order_packages SET status='reserved' WHERE id='reserve-package';");
  await assert.rejects(()=>f.apply(s),e=>e.status===409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,0);
  assert.equal((await f.warehouse('/sessions/'+s.session.id)).session.status,'reviewed');
 }finally{f.close();}
});

test('review R3: irrelevant lifetime payments cannot exhaust a one-day calendar row budget',async()=>{
 const f=fixture();try{
  f.sqlite.exec("INSERT INTO ec_suppliers(id,name) VALUES('history','Historical supplier')");
  const insert=f.sqlite.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source,source_key) VALUES(?,'history',100,'2026-01-01',?,'Historical payment','legacy_payment',?)");
  f.sqlite.exec('BEGIN');for(let n=0;n<25001;n++){const id='history-'+String(n).padStart(6,'0');insert.run(id,id,id);}f.sqlite.exec('COMMIT');
  const r=await f.money('calendar','?from=2026-09-20&to=2026-09-20');
  assert.equal(r.rows.length,0);assert.equal(r.summary.expected.incoming.amount_cents,0);assert.equal(r.summary.expected.outgoing.amount_cents,0);
 }finally{f.close();}
});
