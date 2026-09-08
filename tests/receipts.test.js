import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {accountingApi} from '../src/accounting.js';
import {ledgerApi} from '../src/ledger-api.js';
import {settingsApi} from '../src/settings-api.js';
import {scopedDB} from '../src/scoped-db.js';

const date='2026-09-09';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let queries=0;
 const DB={prepare(query){return {args:[],bind(...args){this.args=args;return this;},first(){queries++;return sqlite.prepare(query).get(...this.args)||null;},all(){queries++;return {results:sqlite.prepare(query).all(...this.args)};},run(){queries++;return sqlite.prepare(query).run(...this.args);}};},async batch(items){sqlite.exec('BEGIN');try{const rows=items.map(s=>s.all());sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const request=(handler,scope,path,body)=>handler(new Request('https://test.local'+path,{method:body===undefined?'GET':'POST'}),{DB:scopedDB(DB,scope),ROOT_DB:DB,WORKSPACE:scope},path.split('?')[0],async()=>body);
 const accounting=(scope,path='',body)=>request(accountingApi,scope,'/api/accounting'+path,body);
 const ledger=(scope,path='',body)=>request(ledgerApi,scope,'/api/ledger'+path,body);
 const settings=(scope,path='',body)=>request(settingsApi,scope,'/api/settings'+path,body);
 const supplier=async(scope='ec',tax='1234567890')=>(await accounting(scope,'/suppliers',{name:'Test Tedarikçisi',tax_id:tax})).id;
 const product=async()=>(await accounting('ec','/products',{name:'Test torf',sku:'TEST',stock_unit:'adet',min_stock:0})).id;
 return {sqlite,accounting,ledger,settings,supplier,product,queryCount:()=>queries,resetQueries:()=>{queries=0;},close:()=>sqlite.close()};
}
const invoice=(supplier,overrides={})=>({supplier_id:supplier,invoice_no:'F-001',invoice_date:date,currency:'TRY',lines:[{description:'Ürün',invoice_quantity:3,invoice_unit:'adet',net:1,tax:.2}],...overrides});
const fee=(category,treatment)=>({description:'Hizmet bedeli',invoice_quantity:1,invoice_unit:'adet',net:100,tax:20,line_type:'expense',expense_category:category,...(treatment?{expense_treatment:treatment}:{})});

test('İş verisi ihracı alanları ve sırları ayırır; ücretsiz sorgu ve satır sınırları içinde kalır',async()=>{
 const f=fixture();try{
  await f.supplier('ec');await f.product();await f.supplier('lp','0987654321');
  f.sqlite.exec("INSERT INTO products(id,name,sku) VALUES('LP-EXPORT','Lunapot örneği','LP-EXPORT'); INSERT INTO ec_provider_connections(provider,seller_id,encrypted_credentials) VALUES('trendyol','123','PRIVATE-CREDENTIAL-CIPHERTEXT');");
  for(const ns of ['ec','lp']){
   f.resetQueries();const backup=await f.settings(ns,'/backup');
   assert.equal(backup.workspace,ns);assert.ok(f.queryCount()<45,'Export query count '+f.queryCount());
   assert.ok(!Object.keys(backup.tables).some(n=>n.startsWith(ns==='ec'?'lp_':'ec_')));
   assert.ok(!Object.keys(backup.tables).some(n=>/connections|cursors|records|admin|sessions/.test(n)));
   assert.ok(!JSON.stringify(backup).includes('PRIVATE-CREDENTIAL'));
   assert.equal(backup.tables[ns==='ec'?'ec_products':'products'].length,1);
  }
  f.sqlite.exec("WITH RECURSIVE items(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM items WHERE n<25001) INSERT INTO ec_activity(id,description) SELECT 'overflow-'||n,'Synthetic export cap' FROM items;");
  f.resetQueries();await assert.rejects(()=>f.settings('ec','/backup'),e=>e.status===409&&e.message.includes('25.000'));assert.equal(f.queryCount(),2,'Oversize export must stop before fetching table contents');
 }finally{f.close();}
});
test('UTC gün değişmeden Türkiye gece yarısı satışları varsayılan döneme dahildir',async()=>{
 const f=fixture(),NativeDate=globalThis.Date;
 try{
  const now=NativeDate.parse('2026-09-08T21:30:00.000Z');
  globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  const product=await f.product();
  await f.accounting('ec','/stock',{product_id:product,quantity:2,unit_cost:20,kind:'opening',reference:'TZ-OPEN',notes:'Saat dilimi testi',occurred_on:'2026-09-09'});
  await f.accounting('ec','/sales',{product_id:product,external_id:'TZ-SALE',channel:'trendyol',quantity:1,revenue:100,commission:0,shipping:0,other:0,fees_status:'confirmed',occurred_on:'2026-09-09'});
  const state=await f.accounting('ec');assert.equal(state.to,'2026-09-09');assert.equal(state.from,'2026-08-10');assert.equal(state.sales.length,1);assert.equal(state.sales[0].external_id,'TZ-SALE');
 }finally{globalThis.Date=NativeDate;f.close();}
});

test('Fatura cari borcu oluşturur; kısmi mal teslimi stok ve yuvarlamayı doğru işler',async()=>{
 const f=fixture();try{
  const supplier=await f.supplier(),product=await f.product();
  const inv=await f.accounting('ec','/invoices',invoice(supplier,{lines:[{description:'Ürün',invoice_quantity:3,invoice_unit:'adet',net:1,tax:.2,product_id:product,stock_quantity:3}]}));
  let detail=await f.accounting('ec','/invoices/'+inv.id),line=detail.lines[0].id;
  await assert.rejects(f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'EARLY',lines:[{id:line,quantity:1}]}),e=>e.status===409);
  await f.accounting('ec','/invoices/'+inv.id+'/post',{});
  assert.equal(f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances').get().quantity_milli,0);
  assert.equal((await f.ledger('ec')).parties[0].balance_cents,-120);
  await f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'R1',lines:[{id:line,quantity:1}]});
  assert.equal(f.sqlite.prepare('SELECT value_cents FROM ec_stock_balances').get().value_cents,33);
  await assert.rejects(f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'R1',lines:[{id:line,quantity:1}]}),e=>e.status===409);
  await f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'R2',lines:[{id:line,quantity:2}]});
  assert.deepEqual({...f.sqlite.prepare('SELECT quantity_milli,value_cents FROM ec_stock_balances').get()},{quantity_milli:3000,value_cents:100});
  await assert.rejects(f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'OVER',lines:[{id:line,quantity:1}]}),e=>e.status===409);
  await assert.rejects(f.accounting('lp','/invoices/'+inv.id),e=>e.status===404);
  detail=await f.accounting('ec','/invoices/'+inv.id);assert.equal(detail.lines[0].received_milli,3000);assert.equal(detail.receipts.length,2);
 }finally{f.close();}
});

test('Fatura UUID ve vergi numarası/fatura no ile iki alanda tekilleşir; başarısız kayıt atomiktir',async()=>{
 const f=fixture();try{
  const ec=await f.supplier(),lp=await f.supplier('lp');
  await f.accounting('ec','/invoices',invoice(ec,{uuid:'UUID-SAMPLE',invoice_no:' f-001 '}));
  await assert.rejects(f.accounting('lp','/invoices',invoice(lp,{invoice_no:'F-001'})),e=>e.status===409);
  await assert.rejects(f.accounting('lp','/invoices',invoice(lp,{uuid:'uuid-sample',invoice_no:'Different'})),e=>e.status===409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,2);
  await assert.rejects(f.accounting('ec','/invoices',invoice(ec,{uuid:'ROLLBACK',invoice_no:'F-002',lines:[{description:'Hatalı',invoice_quantity:1,invoice_unit:'adet',net:1,tax:0,product_id:'missing',stock_quantity:1}]})));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM document_registry WHERE document_key='uuid:rollback'").get().n,0);
  await f.accounting('ec','/invoices',invoice(ec,{uuid:'ROLLBACK',invoice_no:'F-002'}));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_purchase_invoices').get().n,2);
 }finally{f.close();}
});

test('Komisyon/kargo kararı zorunlu; satış kesintisi AP oluşturur fakat genel gideri tekrar artırmaz',async()=>{
 const f=fixture();try{
  const supplier=await f.supplier();
  const inv=await f.accounting('ec','/invoices',invoice(supplier,{lines:[fee('shipping')]}));
  await assert.rejects(f.accounting('ec','/invoices/'+inv.id+'/post',{}),e=>e.status===409&&/kargo|komisyon/i.test(e.message));
  assert.equal((await f.ledger('ec')).parties[0].balance_cents,0);
  const detail=await f.accounting('ec','/invoices/'+inv.id);
  await f.accounting('ec','/invoices/'+inv.id,{lines:[{id:detail.lines[0].id,line_type:'expense',expense_category:'shipping',expense_treatment:'sales_fee'}]});
  await f.accounting('ec','/invoices/'+inv.id+'/post',{});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_expenses').get().n,0);
  assert.equal((await f.ledger('ec')).parties[0].balance_cents,-12000);
  assert.equal((await f.accounting('ec')).pending_fee_cents,10000);
  assert.equal((await f.accounting('lp')).pending_fee_cents,0);
  await assert.rejects(f.accounting('ec','/invoices/'+inv.id+'/receive',{occurred_on:date,reference:'BAD',lines:[{id:detail.lines[0].id,quantity:1}]}),e=>e.status===404);
  const general=await f.accounting('ec','/invoices',invoice(supplier,{invoice_no:'F-002',lines:[fee('commission','general')]}));
  await f.accounting('ec','/invoices/'+general.id+'/post',{});
  assert.equal(f.sqlite.prepare('SELECT SUM(amount_cents) n FROM ec_expenses').get().n,10000);
  const rent=await f.accounting('ec','/invoices',invoice(supplier,{invoice_no:'F-003',lines:[fee('rent')]}));
  await f.accounting('ec','/invoices/'+rent.id+'/post',{});
  assert.equal(f.sqlite.prepare('SELECT SUM(amount_cents) n FROM ec_expenses').get().n,20000);
  await assert.rejects(f.accounting('ec','/invoices',invoice(supplier,{invoice_no:'F-004',lines:[fee('shipping','invalid')]})),e=>e.status===400);
 }finally{f.close();}
});

test('Genel durumun tedarikçi bakiyesi yeni kasa/banka ödemesi ve ters kayıtla tutarlıdır',async()=>{
 const f=fixture();try{
  const supplier=await f.supplier();
  const inv=await f.accounting('ec','/invoices',invoice(supplier,{lines:[fee('rent')]}));await f.accounting('ec','/invoices/'+inv.id+'/post',{});
  const account=await f.ledger('ec','/accounts',{name:'Test banka',kind:'bank'});
  const cash=await f.ledger('ec','/cash',{account_id:account.id,party_id:supplier,direction:'payment',amount:120,occurred_on:date,reference:'PAY-120',description:'Test ödeme'});
  assert.equal((await f.accounting('ec','?from=2026-01-01&to=2026-12-31')).suppliers[0].balance_cents,0);
  await f.ledger('ec','/reverse',{cash_transaction_id:cash.id,occurred_on:date,reference:'REVERSE',reason:'Test düzeltmesi'});
  assert.equal((await f.accounting('ec','?from=2026-01-01&to=2026-12-31')).suppliers[0].balance_cents,-12000);
  assert.equal((await f.ledger('ec')).parties[0].balance_cents,-12000);
 }finally{f.close();}
});

test('Eski faturalar 0006 geçişinde her iki kimlikle kayda alınır ve teslimler korunur',()=>{
 const sqlite=new DatabaseSync(':memory:');try{
  sqlite.exec('PRAGMA foreign_keys=ON');for(const file of ['0001_initial.sql','0002_accounting.sql','0003_accounting_audit.sql','0005_ledger.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  sqlite.exec("INSERT INTO ec_products(id,name,sku) VALUES('p','Torf','P');INSERT INTO ec_suppliers(id,name,tax_id) VALUES('s','Tedarikçi','1234567890');INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,uuid,invoice_date) VALUES('i','s',' f-001 ','OLD-UUID','2026-09-09');INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents) VALUES('l','i','Torf',1,'adet','p',1000,100,20);UPDATE ec_purchase_invoices SET status='posted' WHERE id='i';");
  sqlite.exec(readFileSync(new URL('../migrations/0006_receipts_settings.sql',import.meta.url),'utf8'));
  assert.deepEqual(sqlite.prepare('SELECT document_key FROM document_registry ORDER BY document_key').all().map(x=>x.document_key),['invoice:1234567890:F-001','uuid:old-uuid']);
  assert.equal(sqlite.prepare('SELECT quantity_milli FROM ec_goods_receipts').get().quantity_milli,1000);
  assert.equal(sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances').get().quantity_milli,1000);
 }finally{sqlite.close();}
});

test('Şirket ayarları ayrıdır; XML alıcısı eşleşmeden kayıt oluşmaz ve işlenmiş şirket değişmez',async()=>{
 const f=fixture();try{
  const supplier=await f.supplier();
  await f.settings('ec','',{legal_name:'E-ticaret şirketi',tax_id:'1111111111'});
  await f.settings('lp','',{legal_name:'Lunapot şirketi',tax_id:'2222222222'});
  assert.equal((await f.settings('ec')).settings.tax_id,'1111111111');assert.equal((await f.settings('lp')).settings.tax_id,'2222222222');
  const xml=invoice(supplier,{source:'xml',uuid:'XML-IDENTITY',receiver_tax_id:'2222222222',lines:[fee('rent')]});
  await assert.rejects(f.accounting('ec','/invoices',xml),e=>e.status===409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM document_registry').get().n,0);
  const inv=await f.accounting('ec','/invoices',{...xml,receiver_tax_id:'1111111111'});await f.accounting('ec','/invoices/'+inv.id+'/post',{});
  await assert.rejects(f.settings('ec','',{legal_name:'Başka şirket',tax_id:'3333333333'}),e=>e.status===409);
  await f.settings('lp','',{legal_name:'Lunapot yeni unvan',tax_id:'3333333333'});
  assert.equal((await f.settings('ec')).settings.tax_id,'1111111111');assert.equal((await f.settings('lp')).settings.tax_id,'3333333333');
 }finally{f.close();}
});
