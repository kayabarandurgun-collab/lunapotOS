import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {moneyPlanningApi} from '../src/money-planning-api.js';
import {scopedDB} from '../src/scoped-db.js';
import {ledgerApi} from '../src/ledger-api.js';
import {bankApi} from '../src/bank-api.js';
import {bankMatchApi} from '../src/bank-match-api.js';
import {tumSatirlar} from '../src/performance-api.js';
import {todayInIstanbul} from '../public/date-range.js';

const DATE='2026-09-10', RANGE='from=2026-09-01&to=2026-09-30';
const owner={owner:true};
const staff=(ns,permissions) => ({owner:false,ec_access:'none',lp_access:'none',[ns+'_access']:'read',permissions:{[ns]:permissions}});
function fixture() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  // Freeze base financial schema: sibling agents own later additive migrations. 0074 is named
  // explicitly because businessResult now reads ec_other_income (compensation income kept out of
  // the overhead array on purpose), and the table has to exist for the result to be computed.
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql') && (parseInt(f,10)<=65 || f==='0074_diger_gelir.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const queries=[];
  const raw={prepare(sql){queries.push(sql);return {args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args) || null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(s=>s.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const env=(ns,user=owner)=>({DB:scopedDB(raw,ns),ROOT_DB:raw,WORKSPACE:ns,USER:user});
  const api=async(ns,path,body,user=owner) => {
    const req=new Request('https://test.local/api'+path,{method:body===undefined?'GET':'POST'}),normal='/api'+path.split('?')[0];
    const handler=path.startsWith('/ledger')?ledgerApi:path.startsWith('/bank/matches')?bankMatchApi:path.startsWith('/bank')?bankApi:moneyPlanningApi;
    return handler(req,env(ns,user),normal,async()=>body);
  };
  const calendar=(ns='ec',query=RANGE,user=owner)=>api(ns,'/money-calendar?'+query,undefined,user);
  const result=(query=RANGE,user=owner)=>api('ec','/business-result?'+query,undefined,user);
  const party=(ns='ec',id='party')=>{sqlite.prepare(`INSERT INTO ${ns}_suppliers(id,name,kind) VALUES(?,?,'supplier')`).run(id,ns+' '+id);return id;};
  const entry=(ns,id,amount,{due='2026-09-20',partyId='party',date=DATE,source='manual'}={})=>sqlite.prepare(`INSERT INTO ${ns}_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,partyId,amount,date,due,id,'Kayıt '+id,source+':'+id,source);
  return {sqlite,queries,env,api,calendar,result,party,entry,close:()=>sqlite.close()};
}
function seedSales(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku) VALUES('product','Torf','TORF'); UPDATE ec_stock_balances SET quantity_milli=20000000,value_cents=100000000; INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('product',2000,0,0,0,0,100,100,100,500,1); INSERT INTO ec_report_stores(id,provider,code,name) VALUES('ty','trendyol','TY','Trendyol'); INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('finance-profile','trendyol','finance','signature',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','test')");
}
function packet(f,id,{date=DATE,delivered=true,revenue=20000,cost=5000,commission=3000,shipping=1000,other=500,channel='trendyol'}={}) {
  const db=f.sqlite;
  db.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id,channel,'external-'+id,'order-'+id,date);
  db.prepare('INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,1000,?,?,2000)').run('line-'+id,id,'extline-'+id,'Torf',revenue,Math.round(revenue*1.2));
  db.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,'product','sale',1000,?,?,?,?,?,'confirmed',?)").run('sale-'+id,channel,'sale-ext-'+id,revenue,cost,commission,shipping,other,date);
  db.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,'product',1000,10000,?,'adet')").run('comp-'+id,'line-'+id,'sale-'+id);
  db.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  db.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date,id);
  if(delivered)db.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date,id);
}
function invoice(f,id,{type='expense',treatment='general',net=10000,tax=2000,date=DATE}={}) {
  f.sqlite.prepare('INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,?,?,?)').run(id,'party','invoice-'+id,date);
  f.sqlite.prepare('INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,net_cents,tax_cents,line_type,expense_category,expense_treatment,product_id,quantity_milli) VALUES(?,?,?,1,?,?,?,?,?,?,?,?)').run('invoice-line-'+id,id,'Test '+id,'adet',net,tax,type,treatment==='sales_fee'?'shipping':'rent',type==='expense'?treatment:null,type==='product'?'product':null,type==='product'?1000:null);
  f.sqlite.prepare("UPDATE ec_purchase_invoices SET status='posted' WHERE id=?").run(id);
}
function expense(f,id,amount=1000,date=DATE) {f.sqlite.prepare("INSERT INTO ec_expenses(id,reference,category,label,amount_cents,occurred_on,paid) VALUES(?,?,'rent','Kira',?,?,0)").run(id,'GIDER-'+id,amount,date);}

for(const ns of ['ec','lp']) test(ns+': active allocations, reversals, latest planned date and separate unknown date',async()=>{
  const f=fixture();try {
    f.party(ns);f.entry(ns,'debt',-10000);f.entry(ns,'credit',6000);f.entry(ns,'no-date',-7500,{due:null});
    await f.api(ns,'/ledger/allocations',{positive_entry_id:'credit',negative_entry_id:'debt',amount:60,reference:'allocation'});
    await f.api(ns,'/ledger/plans',{entry_id:'debt',planned_on:'2026-09-22'});
    await f.api(ns,'/ledger/plans',{entry_id:'debt',planned_on:'2026-09-25'});
    let c=await f.calendar(ns);let d=c.rows.find(r=>r.entry_id==='debt');
    assert.equal(d.amount_cents,4000);assert.equal(d.date,'2026-09-25');assert.equal(d.due_on,'2026-09-20');assert.equal(d.overdue,true);
    assert.equal(c.rows.find(r=>r.entry_id==='no-date').bucket,'undated');assert.equal(c.summary.expected.outgoing.amount_cents,4000);
    const allocation=f.sqlite.prepare(`SELECT id FROM ${ns}_payment_allocations WHERE reference='allocation'`).get();
    await f.api(ns,'/ledger/reverse',{allocation_id:allocation.id,reason:'Yanlış eşleştirme'});
    c=await f.calendar(ns);assert.equal(c.rows.find(r=>r.entry_id==='debt').amount_cents,10000);assert.equal(c.summary.expected.incoming.amount_cents,6000);
    await f.api(ns,'/ledger/reverse',{entry_id:'credit',occurred_on:DATE,reference:'reverse-credit',reason:'Hatalı kayıt'});
    c=await f.calendar(ns);assert.equal(c.summary.expected.incoming.amount_cents,0);assert.ok(!c.rows.some(r=>r.entry_id==='credit'));
  }finally{f.close();}
});

for(const ns of ['ec','lp']) test(ns+': issued cheque closes debt once, payout removes due without a new receivable',async()=>{
  const f=fixture();try {
    f.party(ns);f.entry(ns,'debt',-10000);
    const payment=await f.api(ns,'/ledger/payments',{party_id:'party',amount:100,occurred_on:DATE,method:'cek',due_on:'2026-09-20',reference:'cheque'});
    let c=await f.calendar(ns);assert.equal(c.rows.length,1);assert.equal(c.rows[0].kind,'cheque');assert.equal(c.summary.expected.outgoing.amount_cents,10000);assert.equal(c.summary.recorded.outgoing.amount_cents,0);
    const account=await f.api(ns,'/ledger/accounts',{name:'Banka',kind:'bank'});
    const payout=await f.api(ns,'/ledger/cash',{account_id:account.id,party_entry_id:payment.id,direction:'payment',amount:100,occurred_on:'2026-09-20',reference:'cheque-payout',description:'Çek ödendi'});
    c=await f.calendar(ns);assert.ok(!c.rows.some(r=>r.kind==='cheque'));assert.equal(c.summary.expected.outgoing.amount_cents,0);assert.equal(c.summary.recorded.outgoing.amount_cents,10000);assert.equal(c.summary.expected.incoming.amount_cents,0);
    assert.equal(c.rows[0].state,'recorded','A bank-account label alone is not statement confirmation');
    const a=f.sqlite.prepare(`SELECT id FROM ${ns}_payment_allocations WHERE positive_entry_id=?`).get(payment.id);
    await f.api(ns,'/ledger/reverse',{allocation_id:a.id,reason:'Ödeme geri alınıyor'});
    await f.api(ns,'/ledger/reverse',{cash_transaction_id:payout.id,reason:'Yanlış ödeme',occurred_on:'2026-09-21',reference:'cash-reverse'});
    c=await f.calendar(ns);assert.equal(c.summary.recorded_net_cents,0);assert.equal(c.summary.expected.outgoing.amount_cents,10000);assert.ok(!c.rows.some(r=>r.kind==='cheque'));
  }finally{f.close();}
});

test('calendar is read only, workspace isolated, paginates beyond old ledger cutoffs and keeps prior due dates',async()=>{
  const f=fixture();try {
    f.party();f.party('lp');f.entry('lp','foreign',-99000000);
    f.sqlite.exec('BEGIN');for(let i=0;i<1002;i++)f.entry('ec','debt-'+String(i).padStart(4,'0'),-100,{due:i===0?'2026-08-15':'2026-09-20'});f.sqlite.exec('COMMIT');
    const before=f.sqlite.prepare('SELECT total_changes() n').get().n;
    const c=await f.calendar();assert.equal(c.rows.length,1002);assert.equal(c.summary.expected.outgoing.amount_cents,100100);assert.equal(c.rows.filter(r=>r.bucket==='overdue_outside_period').length,1);
    assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n,before);assert.ok(c.rows.every(r=>r.party_name==='ec party'));
  }finally{f.close();}
});

test('unknown dates stay separate; supplied invalid, duplicate, excessive, channel and future-result ranges reject',async()=>{
  const f=fixture();try {
    f.party();f.entry('ec','bad-date',-500,{due:null,date:'2026-02-30'});
    assert.equal((await f.calendar()).rows[0].date,null);
    for(const q of ['from=2026-02-30&to=2026-03-01','from=2026-09-30&to=2026-09-01','from=2026-09-01&from=2026-09-02&to=2026-09-30','from=2020-01-01&to=2026-01-01',RANGE+'&channel=trendyol','from=&to=2026-09-30'])await assert.rejects(f.calendar('ec',q),e=>e.status===400);
    await assert.rejects(f.result('from=2099-01-01&to=2099-01-31'),e=>e.status===400);
    assert.equal((await f.result('')).to,todayInIstanbul(),'default result range resolves a date string');
  }finally{f.close();}
});

test('expense schedule values stay net/unknown gross and generated/paid/archived months do not duplicate',async()=>{
  const f=fixture();try {
    f.sqlite.exec("INSERT INTO ec_expense_schedules(id,label,category,amount_cents,day_of_month,starts_on) VALUES('plan','Ofis','rent',10000,15,'2026-08-01')");
    let c=await f.calendar();assert.equal(c.rows.length,1);assert.equal(c.rows[0].kind,'schedule');assert.equal(c.rows[0].amount_cents,null);assert.equal(c.summary.expected.outgoing.amount_cents,null);assert.equal(c.summary.expected.outgoing.net_only_cents,10000);
    f.sqlite.exec("INSERT INTO ec_expenses(id,reference,category,amount_cents,occurred_on) VALUES('generated','GIDER-PLAN-plan-2026-09','rent',10000,'2026-09-15')");
    c=await f.calendar();assert.equal(c.rows.length,1);assert.equal(c.rows[0].kind,'expense');assert.equal(c.summary.expected.outgoing.net_only_cents,10000);
    f.sqlite.exec("UPDATE ec_expenses SET paid=1 WHERE id='generated'");
    c=await f.calendar();assert.equal(c.rows.length,0);assert.equal(c.summary.recorded.outgoing.amount_cents,0,'Paid checkbox is not a cash transaction');
    f.sqlite.exec("UPDATE ec_expenses SET archived_at=CURRENT_TIMESTAMP,paid=0 WHERE id='generated'");assert.equal((await f.calendar()).rows.length,0);
    expense(f,'manual',500);c=await f.calendar();assert.equal(c.rows[0].date,null,'Expense occurrence is not a known due date');
    f.party();seedSales(f);invoice(f,'rent');c=await f.calendar();assert.equal(c.rows.filter(r=>r.kind==='expense').length,1,'Invoice expense is represented only by its gross party debt');
    assert.equal(c.rows.find(r=>r.entry_id==='invoice:rent').amount_cents,12000);
  }finally{f.close();}
});

test('API checks source permission intersections before SQL, excludes subsidiary expenses, ignores readBody as user',async()=>{
  const f=fixture();try {
    const ledgerOnly=staff('ec',{ledger:'read',amounts:'read'});
    f.queries.length=0;let c=await f.calendar('ec',RANGE,ledgerOnly);assert.equal(c.access.expenses,false);assert.ok(!f.queries.some(q=>/ec_expenses|ec_expense_schedules|ec_report_records|ec_provider_records/.test(q)));
    f.queries.length=0;
    for(const user of [undefined,staff('ec',{ledger:'read',amounts:'none'}),staff('ec',{expenses:'read',amounts:'read'})]) {
      const env=f.env('ec');env.USER=user;
      await assert.rejects(moneyPlanningApi(new Request('https://test.local/?'+RANGE),env,'/api/money-calendar',()=>({owner:true})),e=>e.status===403);
    }
    for(const user of [ledgerOnly,staff('ec',{performance:'read',amounts:'read'}),staff('ec',{performance:'read',expenses:'read',amounts:'none'})])await assert.rejects(f.result(RANGE,user),e=>e.status===403);
    await assert.rejects(f.api('lp','/business-result?'+RANGE),e=>e.status===403);assert.equal(f.queries.length,0);
    await assert.rejects(f.api('ec','/money-calendar',{}),e=>e.status===405);
    assert.equal(await moneyPlanningApi(new Request('https://test.local/'),{},'/api/unrelated'),null);
  }finally{f.close();}
});

test('bank statement match contributes one actual receipt; report statements alone do not create expected income; reversal retains dated net',async()=>{
  const f=fixture();try {
    const account=await f.api('ec','/bank/accounts',{name:'Banka',kind:'bank'});
    const file=await f.api('ec','/bank/files',{account_id:account.id,filename:'test.csv',sha256:'a'.repeat(64),size_bytes:1024});
    await f.api('ec','/bank/files/'+file.id+'/lines',{lines:[{occurred_on:DATE,amount_cents:251623,description:'Trendyol ödeme',reference:'bank-ref',counterparty:'Trendyol',balance_cents:300000}]});
    await f.api('ec','/bank/files/'+file.id+'/seal',{});
    const payload={external_id:'payment',type:'PaymentOrder',credit:2516.23,debt:0,payment_order_id:'PO-1',source_updated_at:DATE+'T09:00:00Z',currency:'TRY'};
    f.sqlite.prepare("INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) VALUES('record','trendyol','seller','payments','payment','fp',?,?)").run(JSON.stringify(payload),payload.source_updated_at);
    assert.equal((await f.calendar()).rows.length,0,'Neither uploaded statement nor payout report becomes another guaranteed receivable');
    const line=f.sqlite.prepare('SELECT id FROM ec_bank_lines').get();
    const match=await f.api('ec','/bank/matches',{bank_line_id:line.id,provider:'trendyol',payment_order_id:'PO-1',create_clearing_account:true});
    let c=await f.calendar();assert.equal(c.rows.length,1);assert.equal(c.rows[0].state,'bank_confirmed');assert.equal(c.summary.recorded.incoming.amount_cents,251623);assert.equal(c.summary.bank_confirmed_incoming_cents,251623);assert.equal(c.summary.recorded.outgoing.amount_cents,0);
    await f.api('ec','/bank/matches/'+match.id+'/reverse',{reason:'Yanlış eşleştirme',occurred_on:'2026-09-12'});
    c=await f.calendar();assert.equal(c.rows.length,2);assert.equal(c.summary.recorded_net_cents,0);assert.equal(c.summary.bank_confirmed_incoming_cents,0);
    c=await f.calendar('ec','from=2026-09-10&to=2026-09-10');assert.equal(c.summary.recorded_net_cents,251623,'Later reversal does not rewrite the original transaction date');
  }finally{f.close();}
});

test('operating result uses shared net contribution, original invoice expense and dated correction once; no purchase/cash double count',async()=>{
  const f=fixture();try {
    seedSales(f);f.party();packet(f,'delivered');packet(f,'not-delivered',{delivered:false});packet(f,'out-of-period',{date:'2026-08-10'});
    expense(f,'manual',1000);invoice(f,'rent');invoice(f,'goods',{type:'product',net:80000,tax:16000});
    f.sqlite.exec("INSERT INTO ec_purchase_adjustments(id,line_id,kind,net_cents,tax_cents,stock_cents,reference,operation_id,occurred_on,reason) VALUES('credit','invoice-line-rent','service',2000,400,0,'CREDIT','operation','2026-09-11','Kira indirimi')");
    const account=await f.api('ec','/ledger/accounts',{name:'Kasa',kind:'cash'});
    await f.api('ec','/ledger/cash',{account_id:account.id,direction:'payment',amount:300,occurred_on:DATE,reference:'withdrawal',description:'Para çekimi'});
    const r=await f.result();assert.equal(r.summary.packages,1);assert.equal(r.summary.contribution_cents,10500);assert.equal(r.summary.overhead_cents,9000);assert.equal(r.summary.operating_result_cents,1500);assert.equal(r.status,'recorded');
    assert.equal(r.overhead.filter(e=>e.source==='expense').length,2);assert.equal(r.overhead.filter(e=>e.source==='adjustment').length,1);
    const shared=await tumSatirlar(f.env('ec'),{mode:'delivered',from:'2026-09-01',to:'2026-09-30'});assert.equal(r.summary.contribution_cents,shared.rows.reduce((t,p)=>t+p.profit_cents,0));
    const accountTotal=f.sqlite.prepare('SELECT SUM(amount_cents) n FROM ec_cash_transactions').get().n;assert.equal(accountTotal,-30000);
    f.sqlite.exec("INSERT INTO ec_purchase_adjustments(id,line_id,kind,net_cents,tax_cents,stock_cents,reference,operation_id,occurred_on,reason,reversal_of) VALUES('reverse-credit','invoice-line-rent','service',2000,400,0,'CREDIT-REVERSE','operation2','2026-09-12','İndirim iptali','credit')");
    const reversed=await f.result();assert.equal(reversed.summary.overhead_cents,11000);assert.equal(reversed.summary.operating_result_cents,-500);
    const later=await f.result('from=2026-09-11&to=2026-09-11');assert.equal(later.summary.overhead_cents,-2000,'Dated correction is not silently assigned to original invoice day');
  }finally{f.close();}
});

test('missing costs and unallocated fees cannot yield a finalized result; no overhead does not claim profit',async()=>{
  const f=fixture();try {
    seedSales(f);packet(f,'zero-cost',{cost:0});expense(f,'rent');
    let r=await f.result();assert.equal(r.status,'incomplete');assert.equal(r.summary.operating_result_cents,null);assert.equal(r.summary.calculated_result_cents,null);assert.equal(r.summary.missing_packages,1);
  }finally{f.close();}
  const g=fixture();try {
    seedSales(g);packet(g,'a');let r=await g.result();assert.equal(r.status,'overhead_missing');assert.equal(r.summary.operating_result_cents,null);assert.equal(r.summary.calculated_contribution_cents,10500);
    expense(g,'rent');g.party();invoice(g,'sales-fee',{treatment:'sales_fee',net:1000,tax:200});
    r=await g.result();assert.equal(r.status,'incomplete');assert.equal(r.summary.unallocated_fee_cents,1000);assert.equal(r.summary.overhead_cents,1000);assert.equal(r.summary.operating_result_cents,null);assert.equal(r.summary.calculated_result_cents,9500);
  }finally{g.close();}
});

test('archived expenses and their service credits do not leak into overhead',async()=>{
  const f=fixture();try {
    seedSales(f);packet(f,'a');f.party();invoice(f,'rent');expense(f,'archived',9999);
    f.sqlite.exec("UPDATE ec_expenses SET archived_at=CURRENT_TIMESTAMP WHERE id IN ('archived','invoice-invoice-line-rent')");
    f.sqlite.exec("INSERT INTO ec_purchase_adjustments(id,line_id,kind,net_cents,tax_cents,reference,operation_id,occurred_on,reason) VALUES('credit','invoice-line-rent','service',2000,400,'CREDIT','operation','2026-09-11','Kira indirimi')");
    const r=await f.result();assert.equal(r.summary.overhead_cents,0);assert.equal(r.status,'overhead_missing');
  }finally{f.close();}
});

test('shared performance pagination covers more than 1000 same-day packages without adding page totals',async()=>{
  const f=fixture();try {
    seedSales(f);expense(f,'rent',100);
    f.sqlite.exec('BEGIN');for(let i=0;i<1003;i++)packet(f,'p'+String(i).padStart(5,'0'));f.sqlite.exec('COMMIT');
    const r=await f.result();assert.equal(r.summary.packages,1003);assert.equal(r.summary.contribution_cents,1003*10500);assert.equal(r.summary.operating_result_cents,1003*10500-100);assert.equal(new Set(r.packages.map(p=>p.id)).size,1003);
  }finally{f.close();}
});



test('estimated shared package rows retain their estimate flag and exact cents in the operating result',async()=>{
  const f=fixture();try {
    seedSales(f);packet(f,'known');packet(f,'estimated',{commission:null,shipping:null,other:null});expense(f,'rent',1000);
    const shared=await tumSatirlar(f.env('ec'),{mode:'delivered',from:'2026-09-01',to:'2026-09-30'});
    const r=await f.result();assert.equal(r.status,'estimated');assert.equal(r.summary.estimated_packages,1);assert.equal(r.summary.operating_result_cents,shared.rows.reduce((t,p)=>t+p.profit_cents,0)-1000);
  }finally{f.close();}
});

test('future-dated cash records are not received cash and a moved payment plan preserves the overdue original due date',async()=>{
  const f=fixture();try {
    f.party();f.entry('ec','debt',-1000,{due:'2026-08-01'});
    await f.api('ec','/ledger/plans',{entry_id:'debt',planned_on:'2027-01-15'});
    const c=await f.calendar();assert.equal(c.rows[0].bucket,'overdue_outside_period');assert.equal(c.rows[0].date,'2027-01-15');assert.equal(c.rows[0].overdue,true);assert.equal(c.summary.expected.outgoing.amount_cents,0);
    const future=new Date(Date.parse(todayInIstanbul())+86400000).toISOString().slice(0,10),account=await f.api('ec','/ledger/accounts',{name:'Kasa',kind:'cash'});
    await f.api('ec','/ledger/cash',{account_id:account.id,direction:'receipt',amount:10,occurred_on:future,reference:'future',description:'İleri tarihli kayıt'});
    const next=await f.calendar('ec','from='+future+'&to='+future);assert.equal(next.rows.find(r=>r.kind==='cash').group,'future_record');assert.equal(next.summary.recorded.incoming.amount_cents,0);
  }finally{f.close();}
});
