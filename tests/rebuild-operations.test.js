import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {scopedDB} from '../src/scoped-db.js';
import {ordersApi} from '../src/orders-api.js';
import {applyReportFees} from '../src/report-inbox-api.js';
import {purchaseDocumentApi} from '../src/purchase-document-api.js';

// Real schema and transactions; barriers model two requests that read before either writes.
function fixture(){
 const s=new DatabaseSync(':memory:');s.exec('PRAGMA foreign_keys=ON');
 for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())s.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const hooks={};
 const raw={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){const row=s.prepare(sql).get(...this.args)||null;if(hooks.read)await hooks.read(sql);return row;},all(){return {results:s.prepare(sql).all(...this.args)};},async run(){if(hooks.write)await hooks.write(sql);return s.prepare(sql).run(...this.args);}};},async batch(items){if(hooks.batch)await hooks.batch(items);s.exec('BEGIN');try{const r=items.map(i=>i.all());s.exec('COMMIT');return r;}catch(e){s.exec('ROLLBACK');throw e;}}};
 const env={DB:scopedDB(raw,'ec'),ROOT_DB:raw,WORKSPACE:'ec'};
 const call=(handler,path,body)=>handler(new Request('https://synthetic.test'+path,{method:'POST'}),env,path,async()=>body);
 const order=(external,extra={})=>call(ordersApi,'/api/orders',{channel:'trendyol',external_id:external,order_no:'same-order',occurred_on:'2026-10-03',lines:[{external_id:'line',name:'Torf',quantity:1,gross:120,vat_rate:20}],...extra});
 const doc=(path,body)=>call(purchaseDocumentApi,'/api/invoices/documents'+path,body);
 function invoice(id){s.exec("INSERT OR IGNORE INTO ec_suppliers(id,name,tax_id) VALUES('supplier','Sentetik','1234567890')");s.prepare("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,'supplier',?,'2026-10-03')").run(id,id);}
 function stored(id,uuid=''){s.prepare("INSERT INTO ec_purchase_documents(id,kind,filename,size_bytes,sha256,chunk_count,page_count,status,doc_uuid) VALUES(?,'pdf',?,20,?,1,4,'stored',?)").run(id,id+'.pdf',id.padEnd(64,'0'),uuid);}
 return {s,raw,hooks,order,doc,invoice,stored,act:(id,action,body)=>call(ordersApi,'/api/orders/'+id+'/'+action,body),close:()=>s.close()};
}
function barrier(n=2){let count=0,release;const gate=new Promise(r=>release=r);return async()=>{if(++count===n)release();await gate;};}
function packageBarrier(f){const wait=barrier();f.hooks.batch=async items=>{if(items[0]?.sql.startsWith('INSERT INTO ec_order_packages'))await wait();};}

test('OP01: two concurrent imports cannot create two undeclared packages for one order',async()=>{
 const f=fixture();try{packageBarrier(f);const r=await Promise.allSettled([f.order('source-A'),f.order('source-B')]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected')?.reason.status,409);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n,1);assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_lines').get().n,1);
 }finally{f.close();}
});
test('OP01: concurrent retry of identical source returns one package id; declared splits still work',async()=>{
 const f=fixture();try{packageBarrier(f);const r=await Promise.all([f.order('same-source'),f.order('same-source')]);
 assert.equal(r[0].id,r[1].id);assert.equal(r.filter(x=>x.existing).length,1);delete f.hooks.batch;
 const split=await f.order('declared-second',{additional_package:true});assert.notEqual(split.id,r[0].id);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n,2);
 }finally{f.close();}
});
test('OP02: a page on another document is a conflict, never already linked in this document',async()=>{
 const f=fixture();try{f.invoice('invoice-A');f.invoice('invoice-B');f.stored('doc-A');f.stored('doc-B');
 await f.doc('/doc-A/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]});
 const r=await f.doc('/doc-B/pages',{pages:[{page_no:1,invoice_id:'invoice-A'},{page_no:2,invoice_id:'invoice-B'}]});
 assert.equal(r.already_linked,0);assert.equal(r.conflicts.length,1);assert.equal(r.created,1);
 assert.deepEqual(f.s.prepare("SELECT page_no,invoice_id FROM ec_purchase_document_pages WHERE document_id='doc-B'").all().map(x=>({...x})),[{page_no:2,invoice_id:'invoice-B'}]);
 }finally{f.close();}
});
test('OP03: concurrent document links cannot report success for an invoice that was not linked',async()=>{
 const f=fixture();try{f.invoice('invoice-A');f.invoice('invoice-B');f.stored('doc-A');const wait=barrier();
 f.hooks.read=async sql=>{if(sql==='SELECT id FROM ec_purchase_documents WHERE invoice_id=?')await wait();};
 const r=await Promise.allSettled([f.doc('/doc-A/link',{invoice_id:'invoice-A'}),f.doc('/doc-A/link',{invoice_id:'invoice-B'})]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected')?.reason.status,409);
 const winner=r.find(x=>x.status==='fulfilled').value;assert.equal(f.s.prepare("SELECT invoice_id FROM ec_purchase_documents WHERE id='doc-A'").get().invoice_id,winner.invoice_id);
 }finally{f.close();}
});
test('OP04: rejected replacement upload does not strip the original document identity',async()=>{
 const f=fixture();try{const uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';f.stored('doc-A',uuid);
 f.s.prepare("UPDATE ec_purchase_documents SET supplier_tax_id='1234567890',doc_no='INV001' WHERE id='doc-A'").run();
 const r=await f.doc('',{kind:'pdf',filename:'replacement.pdf',sha256:'b'.repeat(64),size_bytes:20,chunk_count:1,supplier_tax_id:'1234567890',doc_no:'INV001',doc_uuid:uuid});
 assert.equal(r.duplicate,true);assert.equal(f.s.prepare("SELECT doc_uuid FROM ec_purchase_documents WHERE id='doc-A'").get().doc_uuid,uuid);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_purchase_documents').get().n,1);
 }finally{f.close();}
});

test('OP01: losing mapped import leaves no component or reservation; cancelled and other-channel orders are independent',async()=>{
 const f=fixture();try{f.s.exec("INSERT INTO ec_products(id,name,sku) VALUES('product','Torf','SYNTH-TORF')");
 const lines=[{external_id:'line',name:'Torf',product_id:'product',quantity:1,gross:120,vat_rate:20}];packageBarrier(f);
 const result=await Promise.allSettled([f.order('mapped-A',{lines}),f.order('mapped-B',{lines})]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);delete f.hooks.batch;
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_line_components').get().n,1);assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_reservations').get().n,0);
 await f.order('other-channel',{channel:'hepsiburada',lines});f.s.exec("UPDATE ec_order_packages SET status='cancelled' WHERE channel='trendyol'");await f.order('replacement',{lines});
 assert.equal(f.s.prepare("SELECT COUNT(*) n FROM ec_order_packages WHERE status!='cancelled'").get().n,2);
 }finally{f.close();}
});
test('OP03: two documents cannot concurrently claim one invoice',async()=>{
 const f=fixture();try{f.invoice('invoice-A');f.stored('doc-A');f.stored('doc-B');const wait=barrier();
 f.hooks.read=async sql=>{if(sql==='SELECT id FROM ec_purchase_documents WHERE invoice_id=?')await wait();};
 const result=await Promise.allSettled([f.doc('/doc-A/link',{invoice_id:'invoice-A'}),f.doc('/doc-B/link',{invoice_id:'invoice-A'})]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected')?.reason.status,409);
 assert.equal(f.s.prepare("SELECT COUNT(*) n FROM ec_purchase_documents WHERE invoice_id='invoice-A'").get().n,1);
 }finally{f.close();}
});
test('OP04: failure after identity release rolls back both writes and leaves original bytes intact',async()=>{
 const f=fixture();try{const uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';f.stored('doc-A',uuid);
 // The second statement fails *after* UPDATE would release the old UUID.
 f.s.exec("CREATE TRIGGER synthetic_insert_failure BEFORE INSERT ON ec_purchase_documents WHEN NEW.filename='failed.pdf' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;");
 await assert.rejects(f.doc('',{kind:'pdf',filename:'failed.pdf',sha256:'c'.repeat(64),size_bytes:20,chunk_count:1,doc_uuid:uuid}),/synthetic storage failure/);
 const original=f.s.prepare("SELECT doc_uuid,sha256 FROM ec_purchase_documents WHERE id='doc-A'").get();assert.equal(original.doc_uuid,uuid);assert.equal(original.sha256,'doc-A'.padEnd(64,'0'));
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_purchase_documents').get().n,1);
 }finally{f.close();}
});
test('OP04: page-linked documents cannot surrender their invoice identity',async()=>{
 const f=fixture();try{const uuid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';f.stored('doc-A',uuid);f.invoice('invoice-A');
 await f.doc('/doc-A/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]});
 const r=await f.doc('',{kind:'pdf',filename:'replacement.pdf',sha256:'d'.repeat(64),size_bytes:20,chunk_count:1,doc_uuid:uuid});
 assert.equal(r.duplicate,true);assert.equal(r.reason,'ettn');assert.equal(f.s.prepare("SELECT doc_uuid FROM ec_purchase_documents WHERE id='doc-A'").get().doc_uuid,uuid);
 }finally{f.close();}
});
test('OP05: concurrent page-link retry returns actual outcome instead of a database error',async()=>{
 const f=fixture();try{f.stored('doc-A');f.invoice('invoice-A');const wait=barrier();
 f.hooks.batch=async items=>{if(items[0]?.sql.startsWith('INSERT INTO ec_purchase_document_pages'))await wait();};
 const r=await Promise.all([f.doc('/doc-A/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]}),f.doc('/doc-A/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]})]);
 assert.equal(r.reduce((n,x)=>n+x.created,0),1);assert.equal(r.reduce((n,x)=>n+x.already_linked,0),1);assert.equal(r.reduce((n,x)=>n+x.conflicts.length,0),0);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_purchase_document_pages').get().n,1);
 }finally{f.close();}
});
test('OP05: concurrent competing page links return a reviewable conflict without changing prior link',async()=>{
 const f=fixture();try{f.stored('doc-A');f.stored('doc-B');f.invoice('invoice-A');const wait=barrier();
 f.hooks.batch=async items=>{if(items[0]?.sql.startsWith('INSERT INTO ec_purchase_document_pages'))await wait();};
 const r=await Promise.all([f.doc('/doc-A/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]}),f.doc('/doc-B/pages',{pages:[{page_no:1,invoice_id:'invoice-A'}]})]);
 assert.equal(r.reduce((n,x)=>n+x.created,0),1);assert.equal(r.reduce((n,x)=>n+x.already_linked,0),0);assert.equal(r.reduce((n,x)=>n+x.conflicts.length,0),1);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_purchase_document_pages').get().n,1);
 }finally{f.close();}
});

async function feeFixture(){
 const f=fixture();f.s.exec("INSERT INTO ec_products(id,name,sku) VALUES('product','Torf','SYNTH-TORF'); INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('opening','product',10000,10000,'opening','opening','2026-10-03');");
 const pkg=await f.order('PK1',{lines:[{external_id:'L1',name:'Torf',product_id:'product',quantity:1,gross:500,vat_rate:20}]});
 await f.act(pkg.id,'reserve',{});await f.act(pkg.id,'ship',{occurred_on:'2026-10-03',reference:'SHIP1'});await f.act(pkg.id,'deliver',{occurred_on:'2026-10-03'});
 f.s.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('store','trendyol','SYNTH','Sentetik'); INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status) VALUES('file','store','orders','synthetic.xlsx',100,'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','2026-10-03T10:00','[]',4,1,'applied');");
 const rec=(id,kind,data,erp=null)=>f.s.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no,erp_package_id) VALUES(?,'store',?,?,'provider',?,'2026-10-03T10:00','2026-10-03T10:00','file',1,?)").run(id,kind,id,JSON.stringify(data),erp);
 rec('order','order_line',{package_id:'PK1',line_id:'L1',order_no:'same-order',order_date:'2026-10-03',delivered_date:'2026-10-03',product_name:'Torf',quantity:1,gross:50000,vat_bps:2000,status:'Teslim edildi'},pkg.id);
 for(const [type,amount] of [['commission',-8000],['cargo',-5000],['service',-1000]])rec(type,'finance_event',{event_id:type,order_no:'same-order',package_id:'PK1',type,amount_cents:amount,event_date:'2026-10-03'});
 f.sale=f.s.prepare("SELECT id FROM ec_sale_entries WHERE kind='sale'").get().id;
 f.newCommission=()=>f.s.exec("UPDATE ec_report_records SET version=version+1,data_json=json_set(data_json,'$.amount_cents',-3000) WHERE id='commission'");
 return f;
}
test('OP06: an older fee transfer cannot overwrite a newer transfer or create a false audit row',async()=>{
 const f=await feeFixture();try{let changed=false;
 f.hooks.batch=async items=>{if(!changed&&items.some(i=>i.sql.startsWith('UPDATE ec_sale_entries SET commission_cents='))){changed=true;f.newCommission();await applyReportFees(f.raw,'store',{commit:true});}};
 const error=await applyReportFees(f.raw,'store',{commit:true}).then(()=>null,e=>e);
 assert.equal(f.s.prepare('SELECT commission_cents FROM ec_sale_entries WHERE id=?').get(f.sale).commission_cents,3000);
 assert.equal(error?.status,409);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,1,'only the successful current transfer is audited');
 }finally{f.close();}
});
test('OP06: a source report changing during fee calculation prevents any stale financial write',async()=>{
 const f=await feeFixture();try{let changed=false;
 f.hooks.batch=async items=>{if(!changed&&items.some(i=>i.sql.startsWith('UPDATE ec_sale_entries SET commission_cents='))){changed=true;f.newCommission();}};
 const error=await applyReportFees(f.raw,'store',{commit:true}).then(()=>null,e=>e);
 assert.equal(f.s.prepare('SELECT commission_cents FROM ec_sale_entries WHERE id=?').get(f.sale).commission_cents,null);
 assert.equal(error?.status,409);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,0);
 }finally{f.close();}
});

test('OP06: a concurrent manual fee correction is preserved even when the report revision is unchanged',async()=>{
 const f=await feeFixture();try{let changed=false;
 f.hooks.batch=async items=>{if(!changed&&items.some(i=>i.sql.startsWith('UPDATE ec_sale_entries SET commission_cents='))){changed=true;f.s.prepare("UPDATE ec_sale_entries SET commission_cents=1200,shipping_cents=3400,other_cents=500,fees_status='confirmed' WHERE id=?").run(f.sale);}};
 await assert.rejects(applyReportFees(f.raw,'store',{commit:true}),e=>e.status===409);
 assert.deepEqual({...f.s.prepare('SELECT commission_cents,shipping_cents,other_cents FROM ec_sale_entries WHERE id=?').get(f.sale)},{commission_cents:1200,shipping_cents:3400,other_cents:500});
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,0);
 }finally{f.close();}
});
test('Shipping guard: source changes after validation roll back stock and sale writes together',async()=>{
 const f=fixture();try{f.s.exec("INSERT INTO ec_products(id,name,sku) VALUES('product','Torf','SYNTH-TORF'); INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('opening','product',10000,10000,'opening','opening','2026-10-03');");
 const pkg=await f.order('PK1',{lines:[{external_id:'L1',name:'Torf',product_id:'product',quantity:1,gross:500,vat_rate:20}]});await f.act(pkg.id,'reserve',{});
 let changed=false;f.hooks.batch=async items=>{if(!changed&&items.some(i=>i.sql.startsWith("UPDATE ec_order_packages SET status='shipped'"))){changed=true;f.s.prepare("UPDATE ec_order_packages SET report_link_hash='new-source-hash' WHERE id=?").run(pkg.id);}};
 await assert.rejects(f.act(pkg.id,'ship',{occurred_on:'2026-10-03',reference:'SHIP1'}),e=>e.status===409);
 assert.equal(f.s.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get('product').quantity_milli,10000);
 assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n,0);assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_order_reservations WHERE released_on IS NULL').get().n,1);
 assert.equal(f.s.prepare('SELECT status FROM ec_order_packages WHERE id=?').get(pkg.id).status,'reserved');
 }finally{f.close();}
});
