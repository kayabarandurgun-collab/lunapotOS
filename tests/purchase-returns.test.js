import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {accountingApi} from '../src/accounting.js';
import {purchaseReturnApi} from '../src/purchase-return-api.js';
import {purchaseSearchApi} from '../src/purchase-search-api.js';
import {attentionApi} from '../src/attention-api.js';
import {scopedDB} from '../src/scoped-db.js';
const date='2026-09-09';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()){
  const source=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
  if(file.startsWith('0019'))for(const q of unstable_splitSqlQuery(source))sqlite.exec(q);else sqlite.exec(source);
 }
 let beforeBatch=null;
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},run(){return sqlite.prepare(sql).run(...this.args);}};},async batch(items){const hook=beforeBatch;beforeBatch=null;hook?.();sqlite.exec('BEGIN');try{const r=items.map(s=>s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const call=(handler,path,body,ns='ec')=>handler(new Request('https://test.local'+path,{method:body===undefined?'GET':'POST'}),{DB:scopedDB(DB,ns),ROOT_DB:DB,WORKSPACE:ns},path.split('?')[0],async()=>body);
 const ac=(path='',body,ns)=>call(accountingApi,'/api/accounting'+path,body,ns);
 const action=(invoice,path,body,ns)=>call(purchaseReturnApi,'/api/invoices/'+invoice+'/'+path,body,ns);
 async function setup(quantity=10,net=100,tax=20){const s=(await ac('/suppliers',{name:'Tedarikçi',tax_id:'1234567890'})).id,p=(await ac('/products',{name:'Torf',sku:'TORF',stock_unit:'adet',min_stock:0})).id,i=(await ac('/invoices',{supplier_id:s,invoice_no:'ALIS-001',invoice_date:date,currency:'TRY',lines:[{description:'Torf',invoice_quantity:quantity,invoice_unit:'adet',product_id:p,stock_quantity:quantity,net,tax}]})).id;await ac('/invoices/'+i+'/post',{});const l=(await ac('/invoices/'+i)).lines[0].id;return {s,p,i,l};}
 const balance=p=>({...sqlite.prepare('SELECT quantity_milli,value_cents FROM ec_stock_balances WHERE product_id=?').get(p)});
 const party=s=>sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(s).n;
 const receive=(i,l,q,ref='TESLIM')=>ac('/invoices/'+i+'/receive',{occurred_on:date,reference:ref,lines:[{id:l,quantity:q}]});
 const ret=(i,l,q,ref='IADE')=>action(i,'returns',{occurred_on:date,reference:ref,reason:'Hasarlı ürün tedarikçiye gönderildi',lines:[{id:l,quantity:q}]});
 return {sqlite,call,ac,action,setup,balance,party,receive,ret,beforeNextBatch:fn=>{beforeBatch=fn;},close:()=>sqlite.close()};
}
const correction={occurred_on:date,reference:'DUZELT-1',reason:'Hatalı yerel kayıt düzeltmesi'};
test('Sayım kaydedilirken başka işlem stoğu değiştirirse eski sayım yeni hareketi ezmez',async()=>{
 const f=fixture();try{const {p,i,l}=await f.setup();await f.receive(i,l,10);
  f.beforeNextBatch(()=>f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES('concurrent',?,-1000,-1000,'sale','OTHER-OP','Concurrent movement',?)").run(p,date));
  await assert.rejects(()=>f.ac('/stock',{product_id:p,kind:'count',quantity:8,reference:'STALE-COUNT',notes:'Eski sayım',occurred_on:date}),e=>e.status===409&&e.message.includes('değişti'));
  assert.deepEqual(f.balance(p),{quantity_milli:9000,value_cents:9000});assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference='STALE-COUNT'").get().n,0);
 }finally{f.close();}
});
test('Kısmi alış iadesi stok/cariyi birlikte işler, tekrar ve aşım atomik engellenir; geri alma korunur',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup();await f.receive(i,l,10);
  const result=await f.ret(i,l,3);assert.deepEqual(f.balance(p),{quantity_milli:7000,value_cents:7000});assert.equal(f.party(s),-8400);
  await assert.rejects(()=>f.ret(i,l,3),e=>e.status===409);await assert.rejects(()=>f.ret(i,l,8,'OVER'),e=>e.status===409);assert.equal(f.party(s),-8400);
  await assert.rejects(()=>f.action(i,'returns',{lines:[{id:l,quantity:1}],...correction},'lp'),e=>e.status===403);
  const detail=await f.ac('/invoices/'+i);assert.equal(detail.returns.length,1);assert.equal(detail.status,'posted');assert.equal(detail.lines[0].received_milli,10000);
  await f.action(i,'returns/'+result.record_ids[0]+'/reverse',correction);assert.deepEqual(f.balance(p),{quantity_milli:10000,value_cents:10000});assert.equal(f.party(s),-12000);
  await assert.rejects(()=>f.action(i,'returns/'+result.record_ids[0]+'/reverse',{...correction,reference:'AGAIN'}),e=>e.status===409);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_purchase_returns'),/IMMUTABLE/);
 }finally{f.close();}
});
test('Ortalama stok maliyeti ile fatura iade bedeli farkı genel giderde görünür; son stok sıfır kalır',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup(10,100,20);await f.receive(i,l,10);
  await f.ac('/stock',{product_id:p,kind:'count',quantity:20,unit_cost:20,reference:'OTHER-LOT',notes:'Diğer alış maliyetli stok',occurred_on:date});
  const r=await f.ret(i,l,10);assert.deepEqual(f.balance(p),{quantity_milli:10000,value_cents:15000});assert.equal(f.party(s),0);
  let state=await f.ac('?from='+date+'&to='+date);assert.equal(state.expenses.find(e=>e.category==='purchase_variance').amount_cents,5000);
  await f.action(i,'returns/'+r.record_ids[0]+'/reverse',correction);state=await f.ac('?from='+date+'&to='+date);assert.equal(state.expenses.filter(e=>e.category==='purchase_variance').reduce((s,e)=>s+e.amount_cents,0),0);assert.equal(f.party(s),-12000);
 }finally{f.close();}
});
test('Kuruşlar üç kısmi iadede korunur',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup(3,1,.2);await f.receive(i,l,3);for(let n=0;n<3;n++)await f.ret(i,l,1,'R'+n);assert.deepEqual(f.balance(p),{quantity_milli:0,value_cents:0});assert.equal(f.party(s),0);
  assert.deepEqual({...f.sqlite.prepare('SELECT SUM(net_cents) net,SUM(tax_cents) tax FROM ec_purchase_returns').get()},{net:100,tax:20});
 }finally{f.close();}
});
test('Bedelsiz ürün iadesi stoktan düşer; sahte cari hareketi oluşturmaz',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup(2,0,0);await f.receive(i,l,2);await f.ret(i,l,2);assert.deepEqual(f.balance(p),{quantity_milli:0,value_cents:0});assert.equal(f.party(s),0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n,0);}finally{f.close();}
});
test('Siparişe ayrılan miktar iade edilemez; stok görünümü aynı rezervasyonu gösterir',async()=>{
 const f=fixture();try{const {p,i,l}=await f.setup();await f.receive(i,l,10);
  f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,source_fingerprint) VALUES('reserve-test','other','reserve-test','2026-09-09','local');INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,gross_cents,vat_bps,net_revenue_cents) VALUES('reserve-line','reserve-test','L','Torf',9000,10800,2000,9000);");
  f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit) VALUES('reserve-component','reserve-line',?,9000,10000,'adet')").run(p);
  f.sqlite.exec("UPDATE ec_order_packages SET status='reserved' WHERE id='reserve-test'");
  const stock=(await f.ac()).stock.find(x=>x.id===p);assert.equal(stock.reserved_milli,9000);assert.equal(stock.quantity_milli-stock.reserved_milli,1000);
  await assert.rejects(()=>f.ret(i,l,2),e=>e.status===409);assert.deepEqual(f.balance(p),{quantity_milli:10000,value_cents:10000});await f.ret(i,l,1);assert.equal(f.balance(p).quantity_milli,9000);
 }finally{f.close();}
});
test('Çok satırlı iadede tek bir hata hiçbir satırı işlemez; referans yarışı veritabanında da engellenir',async()=>{
 const f=fixture();try{const {s,p}=await f.setup(),p2=(await f.ac('/products',{name:'Perlit',sku:'PERLIT',stock_unit:'adet',min_stock:0})).id;
  const i=(await f.ac('/invoices',{supplier_id:s,invoice_no:'MULTI',invoice_date:date,currency:'TRY',lines:[p,p2].map(product_id=>({description:'Mal',invoice_quantity:2,invoice_unit:'adet',product_id,stock_quantity:2,net:20,tax:4}))})).id;
  await f.ac('/invoices/'+i+'/post',{});const lines=(await f.ac('/invoices/'+i)).lines;for(const l of lines)await f.receive(i,l.id,1,'HALF');
  await assert.rejects(()=>f.action(i,'returns',{...correction,lines:[{id:lines[0].id,quantity:1},{id:lines[1].id,quantity:2}]}),e=>e.status===409);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_purchase_returns').get().n,0);assert.equal(f.balance(p).quantity_milli,1000);
  await f.ret(i,lines[0].id,1,'SAME-REFERENCE');
  assert.throws(()=>f.sqlite.prepare("INSERT INTO ec_purchase_returns(id,line_id,quantity_milli,net_cents,tax_cents,cost_cents,operation_id,reference,occurred_on,reason) VALUES('race',?,1000,1000,200,1000,'different-operation','SAME-REFERENCE',?,'Concurrent retry')").run(lines[1].id,date),/PURCHASE_RETURN_REVERSED/);
  assert.equal(f.balance(p2).quantity_milli,1000);await assert.rejects(()=>f.action(i,'returns',{...correction,occurred_on:'2099-01-01',lines:[{id:lines[1].id,quantity:1}]}),e=>e.status===400);
 }finally{f.close();}
});
test('Yanlış mal teslimi geri alınınca bekleyen miktar açılır; cari sabit, yeniden teslim maliyeti tamdır',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup(3,1,.2);await f.receive(i,l,1,'R1');await f.receive(i,l,2,'R2');
  const detail=await f.ac('/invoices/'+i),receipt=detail.receipts.find(r=>r.reference==='R1');
  await f.action(i,'receipts/'+receipt.id+'/reverse',correction);assert.equal(f.party(s),-120);assert.deepEqual(f.balance(p),{quantity_milli:2000,value_cents:67});
  assert.equal((await f.ac('/invoices/'+i)).lines[0].received_milli,2000);const work=await f.call(attentionApi,'/api/attention');assert.equal(work.invoices.awaiting_receipt,1);
  await f.receive(i,l,1,'R3');assert.deepEqual(f.balance(p),{quantity_milli:3000,value_cents:100});await assert.rejects(()=>f.receive(i,l,1,'EXCESS'),e=>e.status===409);
  await assert.rejects(()=>f.action(i,'receipts/'+receipt.id+'/reverse',{...correction,reference:'DOUBLE'}),e=>e.status===409);
 }finally{f.close();}
});
test('Sonraki satış, tahsis veya tedarikçi iadesi varken tehlikeli ters kayıt engellenir',async()=>{
 const f=fixture();try{const {s,p,i,l}=await f.setup();await f.receive(i,l,10);
  const receipt=(await f.ac('/invoices/'+i)).receipts[0].id;
  await f.ac('/sales',{product_id:p,channel:'other',external_id:'S1',quantity:8,revenue:200,commission:0,shipping:0,other:0,fees_status:'confirmed',occurred_on:date});
  await assert.rejects(()=>f.ret(i,l,3),e=>e.status===409);await assert.rejects(()=>f.action(i,'receipts/'+receipt+'/reverse',correction),e=>e.status===409);assert.equal(f.party(s),-12000);
  const r=await f.ret(i,l,2);await assert.rejects(()=>f.action(i,'receipts/'+receipt+'/reverse',correction),e=>e.status===409);
  const entry='purchase-return:'+r.record_ids[0];f.sqlite.prepare('INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES(?,?,?,?,?)').run('alloc',entry,'invoice:'+i,2400,'ALLOC');
  await assert.rejects(()=>f.action(i,'returns/'+r.record_ids[0]+'/reverse',correction),e=>e.status===409&&e.message.includes('kapama'));assert.deepEqual(f.balance(p),{quantity_milli:0,value_cents:0});
 }finally{f.close();}
});
test('200den eski faturalar arama ve sayfalama ile bulunur; teslim ve çalışma alanı filtreleri tutarlı',async()=>{
 const f=fixture();try{const {s,i,l}=await f.setup();
  const ins=f.sqlite.prepare("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,?,?,?)");for(let n=0;n<210;n++)ins.run('fixture-'+n,s,'OLDER-'+String(n).padStart(3,'0'),date);
  const page=await f.call(purchaseSearchApi,'/api/purchases?page=5');assert.equal(page.total,211);assert.equal(page.invoices.length,11);
  const search=await f.call(purchaseSearchApi,'/api/purchases?q=OLDER-001');assert.equal(search.total,1);assert.equal(search.invoices[0].invoice_no,'OLDER-001');
  assert.equal((await f.call(purchaseSearchApi,'/api/purchases?status=awaiting')).total,1);await f.receive(i,l,10);assert.equal((await f.call(purchaseSearchApi,'/api/purchases?status=awaiting')).total,0);
  assert.equal((await f.call(purchaseSearchApi,'/api/purchases',undefined,'lp')).total,0);
  await assert.rejects(()=>f.call(purchaseSearchApi,'/api/purchases?page=-1'),e=>e.status===400);
 }finally{f.close();}
});
