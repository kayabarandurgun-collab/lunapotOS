import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ledgerApi} from '../src/ledger-api.js';

const tables=['party_entries','payment_allocations','allocation_reversals','cash_accounts','cash_transactions','suppliers'];
const date='2026-09-09';
function fixture(beforeMigration){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_initial.sql','0002_accounting.sql','0003_accounting_audit.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 beforeMigration?.(sqlite);
 sqlite.exec(readFileSync(new URL('../migrations/0005_ledger.sql',import.meta.url),'utf8'));
 const raw={prepare(sql){return {args:[],bind(...a){this.args=a;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(x=>x.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 async function call(workspace,path='',body){const DB={...raw,prepare(sql){for(const table of tables)sql=sql.replace(new RegExp('\\b'+table+'\\b','g'),workspace+'_'+table);return raw.prepare(sql);}};return ledgerApi(new Request('https://test.local/api/ledger'+path,{method:body?'POST':'GET'}),{DB,WORKSPACE:workspace},'/api/ledger'+path,async()=>body);}
 const party=(workspace,name='Tedarikçi')=>call(workspace,'/parties',{name,kind:'supplier',tax_id:'1234567890'});
 const entry=(workspace,party,amount,reference)=>call(workspace,'/entries',{party_id:party,amount,reference,occurred_on:date,description:'Test hareketi'});
 return {sqlite,call,party,entry,close:()=>sqlite.close()};
}
test('Cari balances, allocations, and cash are isolated per workspace',async()=>{
 const f=fixture();try{
  const ec=(await f.party('ec')).id,lp=(await f.party('lp')).id;
  const positive=(await f.entry('ec',ec,100,'ALACAK')).id,negative=(await f.entry('ec',ec,-80,'BORC')).id;
  await f.entry('lp',lp,-30,'BORC');
  const a=(await f.call('ec','/allocations',{positive_entry_id:positive,negative_entry_id:negative,amount:60,reference:'KAPAMA'})).id;
  let state=await f.call('ec');assert.equal(state.parties[0].balance_cents,2000);assert.equal(state.entries.find(e=>e.id===positive).remaining_cents,4000);assert.equal(state.entries.find(e=>e.id===negative).remaining_cents,2000);
  assert.equal((await f.call('lp')).parties[0].balance_cents,-3000);
  await assert.rejects(f.call('ec','/allocations',{positive_entry_id:positive,negative_entry_id:negative,amount:21,reference:'ASIM'}),/kalan tutarını/);
  await assert.rejects(f.entry('lp',ec,1,'YABANCI'),/bulunamadı/);
  await assert.rejects(f.call('lp','/allocations',{positive_entry_id:positive,negative_entry_id:negative,amount:1,reference:'YABANCI'}),/Aynı cariye/);
  await assert.rejects(f.call('ec','/allocations',{positive_entry_id:negative,negative_entry_id:positive,amount:1,reference:'TERS'}),/Aynı cariye/);
  await assert.rejects(f.call('ec','/reverse',{entry_id:positive,reason:'Hata',occurred_on:date,reference:'REV'}),/Önce/);
  await f.call('ec','/reverse',{allocation_id:a,reason:'Yanlış eşleştirme'});
  await f.call('ec','/reverse',{entry_id:positive,reason:'Hatalı açılış',occurred_on:date,reference:'REV'});
  state=await f.call('ec');assert.equal(state.parties[0].balance_cents,-8000);assert.equal(state.entries.find(e=>e.id===positive).remaining_cents,0);
  await assert.rejects(f.call('ec','/reverse',{entry_id:positive,reason:'Tekrar',occurred_on:date,reference:'REV2'}),/ters kayıt/);
  const locked=state.allocations.find(x=>x.reference.startsWith('reverse:'));
  await assert.rejects(f.call('ec','/reverse',{allocation_id:locked.id,reason:'Açılamaz'}),/ters kayıt/);
 }finally{f.close();}
});
test('Cash records synchronize party entries and reverse atomically without external transfer',async()=>{
 const f=fixture();try{
  const p=(await f.party('ec')).id,a=(await f.call('ec','/accounts',{name:'Banka',kind:'bank'})).id;
  const debt=(await f.entry('ec',p,-200,'FATURA')).id;
  const cash=await f.call('ec','/cash',{account_id:a,party_id:p,direction:'payment',amount:70,occurred_on:date,reference:'ODEME',description:'Tedarikçiye ödeme kaydı'});
  let s=await f.call('ec');assert.equal(s.accounts[0].balance_cents,-7000);assert.equal(s.parties[0].balance_cents,-13000);
  const allocation=(await f.call('ec','/allocations',{positive_entry_id:cash.party_entry_id,negative_entry_id:debt,amount:70,reference:'ODEME-FATURA'})).id;
  await assert.rejects(f.call('ec','/reverse',{cash_transaction_id:cash.id,reason:'Yanlış',occurred_on:date,reference:'REV'}),/Önce/);
  s=await f.call('ec');assert.equal(s.cash_transactions.length,1);assert.equal(s.entries.length,2);
  await f.call('ec','/reverse',{allocation_id:allocation,reason:'Yanlış belge'});
  await assert.rejects(f.call('ec','/reverse',{entry_id:cash.party_entry_id,reason:'Yanlış',occurred_on:date,reference:'REV'}),/kasa\/banka/);
  await f.call('ec','/reverse',{cash_transaction_id:cash.id,reason:'İptal',occurred_on:date,reference:'REV'});
  s=await f.call('ec');assert.equal(s.accounts[0].balance_cents,0);assert.equal(s.parties[0].balance_cents,-20000);assert.equal(s.entries.find(e=>e.id===cash.party_entry_id).remaining_cents,0);
  await assert.rejects(f.call('ec','/cash',{account_id:a,party_id:p,direction:'payment',amount:70,occurred_on:date,reference:'ODEME',description:'Tekrar'}),/daha önce/);
  await assert.rejects(f.call('lp','/cash',{account_id:a,direction:'receipt',amount:1,occurred_on:date,reference:'X',description:'X'}),/bulunamadı/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_cash_transactions'),/IMMUTABLE_LEDGER/);
  assert.throws(()=>f.sqlite.exec('UPDATE ec_party_entries SET amount_cents=1'),/IMMUTABLE_LEDGER/);
 }finally{f.close();}
});
test('Legacy invoice and supplier payment backfill and triggers do not create bank transactions',async()=>{
 const f=fixture(db=>{
  db.exec("INSERT INTO ec_products(id,name,sku) VALUES('product','Torf','T'); INSERT INTO ec_suppliers(id,name) VALUES('supplier','Tedarikçi'); INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('invoice','supplier','F-1','2026-09-09'); INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents) VALUES('line','invoice','Torf',1,'adet','product',1000,10000,2000); UPDATE ec_purchase_invoices SET status='posted' WHERE id='invoice'; INSERT INTO ec_supplier_payments(id,supplier_id,reference,amount_cents,occurred_on) VALUES('paid','supplier','PAY-1',2000,'2026-09-09');");
 });try{
  let s=await f.call('ec');assert.equal(s.parties[0].balance_cents,-10000);assert.equal(s.entries.length,2);assert.equal(s.cash_transactions.length,0);
  f.sqlite.exec("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('invoice2','supplier','F-2','2026-09-09'); INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents) VALUES('line2','invoice2','Torf',1,'adet','product',1000,5000,1000); UPDATE ec_purchase_invoices SET status='posted' WHERE id='invoice2'; INSERT INTO ec_supplier_payments(id,supplier_id,reference,amount_cents,occurred_on) VALUES('paid2','supplier','PAY-2',1000,'2026-09-09'); INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('cancel','supplier','F-C','2026-09-09'); UPDATE ec_purchase_invoices SET status='cancelled' WHERE id='cancel';");
  s=await f.call('ec');assert.equal(s.parties[0].balance_cents,-15000);assert.equal(s.entries.length,4);assert.equal(s.cash_transactions.length,0);assert.equal((await f.call('lp')).entries.length,0);
  await assert.rejects(f.call('ec','/reverse',{entry_id:'invoice:invoice',reason:'Hata',occurred_on:date,reference:'REV'}),/kaynak belge/);
  assert.throws(()=>f.sqlite.exec('UPDATE ec_supplier_payments SET amount_cents=1'),/IMMUTABLE_LEDGER/);
 }finally{f.close();}
});
test('Same-sign, cross-party and invalid monetary input are rejected without partial writes',async()=>{
 const f=fixture();try{
  const p=(await f.party('ec')).id,q=(await f.call('ec','/parties',{name:'Başka cari',kind:'customer'})).id;
  const e=(await f.entry('ec',p,10,'A')).id,n=(await f.entry('ec',q,-10,'B')).id;
  await assert.rejects(f.call('ec','/allocations',{positive_entry_id:e,negative_entry_id:n,amount:1,reference:'X'}),/Aynı cariye/);
  await assert.rejects(f.entry('ec',p,0,'ZERO'),/sıfır/);
  await assert.rejects(f.entry('ec',p,'NaN','INVALID'),/Geçerli/);
  await assert.rejects(f.entry('ec',p,10,'A'),/daha önce/);
  assert.equal((await f.call('ec')).entries.length,2);
 }finally{f.close();}
});
