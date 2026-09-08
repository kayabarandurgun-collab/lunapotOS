import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {reconciliationApi} from '../src/reconciliation-api.js';
import {unstable_splitSqlQuery} from 'wrangler';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const raw={prepare(query){return {args:[],bind(...a){this.args=a;return this;},first(){return sql.prepare(query).get(...this.args)||null;},all(){return {results:sql.prepare(query).all(...this.args)};}};},async batch(items){sql.exec('BEGIN');try{const results=items.map(x=>x.all());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const call=(workspace,path='',body)=>{const DB={...raw,prepare(query){for(const table of ['fee_allocations','fee_audit','purchase_invoices','purchase_lines','sale_entries','suppliers'])query=query.replace(new RegExp('\\b'+table+'\\b','g'),workspace+'_'+table);if(workspace==='ec')query=query.replace(/\bproducts\b/g,'ec_products');return raw.prepare(query);}};return reconciliationApi(new Request('https://test.local/api/reconciliation'+path,{method:body?'POST':'GET'}),{DB,WORKSPACE:workspace},'/api/reconciliation'+path,async()=>body);};
 function seed(ns='ec'){
  const p=ns==='ec'?'ec_products':'products';sql.exec(`INSERT INTO ${p}(id,name,sku) VALUES('${ns}product','Torf','${ns}'); INSERT INTO ${ns}_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('${ns}stock','${ns}product',100000,10000,'opening','OPEN','2026-09-09'); INSERT INTO ${ns}_suppliers(id,name) VALUES('${ns}supplier','Kargo şirketi');`);
  for(const key of ['S1','S2'])sql.exec(`INSERT INTO ${ns}_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('${ns}${key}','trendyol','${key}','${ns}product','sale',1000,10000,100,'pending','2026-09-09');`);
 }
 function invoice(key,component='shipping',net=1000,ns='ec',treatment='sales_fee',posted=true){sql.exec(`INSERT INTO ${ns}_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('${key}','${ns}supplier','${key}','2026-09-09'); INSERT INTO ${ns}_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,net_cents,tax_cents,line_type,expense_category,expense_treatment) VALUES('${key}line','${key}','Hizmet',1,'adet',${net},200,'expense','${component}','${treatment}');`);if(posted)sql.exec(`UPDATE ${ns}_purchase_invoices SET status='posted' WHERE id='${key}'`);return key+'line';}
 const allocate=(source,lines,takeover=false,ns='ec')=>call(ns,'/allocate',{invoice_line_id:source,lines,takeover});
 return {sql,call,seed,invoice,allocate,close:()=>sql.close()};
}
test('Reconciliation migration survives actual Wrangler SQL splitting',()=>{
 const sql=new DatabaseSync(':memory:');try{sql.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<'0009').sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));const statements=unstable_splitSqlQuery(readFileSync(new URL('../migrations/0009_reconciliation.sql',import.meta.url),'utf8'));assert.equal(statements.length,18);for(const statement of statements)sql.exec(statement);assert.ok(sql.prepare("SELECT name FROM sqlite_master WHERE name='ec_fee_allocation_apply'").get());}finally{sql.close();}
});
test('Invoice net fees allocate across sales without duplicate expense or cash; over-allocation rolls back atomically',async()=>{
 const f=fixture();try{f.seed();const line=f.invoice('F1');let s=await f.call('ec');assert.equal(s.pending_cents,1000);assert.equal(s.fee_lines[0].tax_cents,200);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_expenses').get().n,0);assert.equal(f.sql.prepare('SELECT SUM(amount_cents) n FROM ec_party_entries').get().n,-1200);
  await assert.rejects(f.allocate(line,[{sale_id:'ecS1',amount:6},{sale_id:'ecS2',amount:5}]),/kalan tutarını/);s=await f.call('ec');assert.equal(s.allocations.length,0);assert.equal(s.sales[0].shipping_cents,null);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,0);
  await f.allocate(line,[{sale_id:'ecS1',amount:6},{sale_id:'ecS2',amount:4}]);s=await f.call('ec');assert.equal(s.pending_cents,0);assert.equal(s.sales.find(x=>x.id==='ecS1').shipping_cents,600);assert.equal(s.sales.find(x=>x.id==='ecS2').shipping_cents,400);assert.equal(s.sales[0].fees_status,'pending');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_expenses').get().n,0);
  const line2=f.invoice('F2','shipping',300);await f.allocate(line2,[{sale_id:'ecS1',amount:3}]);s=await f.call('ec');assert.equal(s.sales.find(x=>x.id==='ecS1').shipping_cents,900);assert.equal(s.allocations.length,3);
 }finally{f.close();}
});
test('Existing fee takeover is explicit, history preserved, linked fee locked and corrections audited',async()=>{
 const f=fixture();try{f.seed();f.sql.exec("UPDATE ec_sale_entries SET shipping_cents=500,commission_cents=0,other_cents=0,fees_status='confirmed' WHERE id='ecS1'");const source=f.invoice('F');
  await assert.rejects(f.allocate(source,[{sale_id:'ecS1',amount:10}]),/açıkça onaylayın/);const r=await f.allocate(source,[{sale_id:'ecS1',amount:10}],true);let state=await f.call('ec');assert.equal(state.sales.find(s=>s.id==='ecS1').shipping_cents,1000);assert.equal(state.sales.find(s=>s.id==='ecS1').fees_status,'confirmed');assert.equal(JSON.parse(f.sql.prepare('SELECT old_values FROM ec_fee_audit').get().old_values).shipping,500);
  assert.throws(()=>f.sql.exec("UPDATE ec_sale_entries SET shipping_cents=1 WHERE id='ecS1'"),/RECONCILED_FEE_LOCKED/);
  await assert.rejects(f.allocate(source,[{sale_id:'ecS1',amount:1}],true),/kalan tutarını|zaten/);
  await f.call('ec','/reverse',{id:r.ids[0],reason:'Yanlış sipariş eşleşmesi'});state=await f.call('ec');assert.equal(state.pending_cents,1000);assert.equal(state.sales.find(s=>s.id==='ecS1').shipping_cents,null);assert.equal(state.sales.find(s=>s.id==='ecS1').fees_status,'pending');assert.equal(state.allocations[0].reversal_reason,'Yanlış sipariş eşleşmesi');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,2);
  await f.allocate(source,[{sale_id:'ecS2',amount:10}]);await assert.rejects(f.call('ec','/reverse',{id:r.ids[0],reason:'Tekrar'}),/zaten/);assert.throws(()=>f.sql.exec('DELETE FROM ec_fee_allocations'),/IMMUTABLE_FEE_ALLOCATION/);
 }finally{f.close();}
});
test('All three actual components confirm fees; workspace and source classification are enforced',async()=>{
 const f=fixture();try{f.seed();f.seed('lp');const shipping=f.invoice('EC'),lp=f.invoice('LP','shipping',1000,'lp');
  await assert.rejects(f.allocate(shipping,[{sale_id:'lpS1',amount:1}]),/çalışma alanında/);await assert.rejects(f.allocate(lp,[{sale_id:'ecS1',amount:1}]),/bulunamadı/);
  await f.allocate(shipping,[{sale_id:'ecS1',amount:10}]);for(const component of ['commission','other'])await f.allocate(f.invoice(component,component,100),[{sale_id:'ecS1',amount:1}]);let s=await f.call('ec');assert.equal(s.sales.find(x=>x.id==='ecS1').fees_status,'confirmed');assert.equal((await f.call('lp')).allocations.length,0);
  await assert.rejects(f.allocate(f.invoice('G','shipping',1000,'ec','general'),[{sale_id:'ecS1',amount:1}]),/satış kesintisi/);
  await assert.rejects(f.allocate(f.invoice('D','shipping',1000,'ec','sales_fee',false),[{sale_id:'ecS1',amount:1}]),/işlenmiş/);
  await assert.rejects(f.allocate(lp,[{sale_id:'lpS1',amount:0}],false,'lp'),/sıfırdan büyük/);
 }finally{f.close();}
});
