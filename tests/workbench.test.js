import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {scopedDB} from '../src/scoped-db.js';
import {workbenchApi} from '../src/workbench-api.js';
import {detectIntake,intakeChoices,imageInvoicePdf} from '../public/workbench-ui.js';
import {PDFDocument} from 'pdf-lib';
import {xlsxBytes} from '../public/doc-engine.js';

const owner={id:'owner',name:'Yönetici',owner:true};
function fixture(){
 const s=new DatabaseSync(':memory:');s.exec('PRAGMA foreign_keys=ON');
 // Only the immutable base and this module's migration: sibling migrations are tested by parent.
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&(f<='0065_provisional_allocations.sql'||f==='0068_workbench.sql')).sort()){
  const sql=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
  if(name==='0068_workbench.sql')for(const part of unstable_splitSqlQuery(sql))s.exec(part);else s.exec(sql);
 }
 const DB={prepare(sql){return{args:[],bind(...args){this.args=args;return this;},first(){return s.prepare(sql).get(...this.args)||null;},all(){return{results:s.prepare(sql).all(...this.args)};},run(){return s.prepare(sql).run(...this.args);}};},async batch(items){s.exec('BEGIN');try{const r=items.map(x=>x.all());s.exec('COMMIT');return r;}catch(e){s.exec('ROLLBACK');throw e;}}};
 const call=(path='',body,ns='ec',user=owner)=>workbenchApi(new Request('https://test.local/api/'+ns+'/workbench'+path,{method:body===undefined?'GET':'POST'}),{DB:scopedDB(DB,ns),ROOT_DB:DB,WORKSPACE:ns,USER:user},'/api/workbench'+path,async()=>body);
 return{s,DB,call,close:()=>s.close()};
}
function seed(f){
 for(const ns of ['ec','lp']){
  f.s.prepare('INSERT INTO '+ns+"_suppliers(id,name) VALUES('supplier','Gerçek kayıttaki tedarikçi')").run();
  f.s.prepare('INSERT INTO '+ns+"_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('invoice','supplier','F-1','2026-09-01')").run();
 }
 f.s.exec("INSERT INTO staff_users(id,username,name,ec_access,lp_access) VALUES('staff','unique-login','Ayşe','write','read'),('disabled','disabled-login','Eski kişi','write','none'); UPDATE staff_users SET active=0 WHERE id='disabled'");
 f.s.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('store','trendyol','S1','Mağaza'); INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status,created_at) VALUES('report','store','orders','pazar.xlsx',100,'" + 'a'.repeat(64) + "','2026-09-01','[]',1,1,'received','2026-09-01')");
 f.s.exec("INSERT INTO ec_report_reviews(id,store_id,file_id,row_no,kind,record_key,reason,incoming_json) VALUES('review','store','report',1,'order_line','key','missing_required','{}')");
 f.s.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,source_fingerprint) VALUES('package','other','P-1','O-1','2026-09-01','finger'); INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli) VALUES('line','package','L-1','Ürün',1000)");
}
const permission=(features,ns='ec',access='write')=>({id:'staff',name:'Ayşe',[ns+'_access']:access,permissions:{[ns]:features}});

test('0068 executes through Wrangler splitter; both namespaces detect real source issues without business writes',async()=>{
 const f=fixture();try{
  seed(f);
  const before=f.s.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n;
  const ec=await f.call(),lp=await f.call('',undefined,'lp');
  assert.deepEqual(new Set(ec.tasks.map(t=>t.source_kind)),new Set(['invoice_draft','report_file','report_review','order_mapping','order_amounts']));
  assert.deepEqual(lp.tasks.map(t=>t.source_kind),['invoice_draft']);
  assert.equal(ec.tasks.find(t=>t.source_kind==='order_amounts').source_active,true,'null amounts are detected');
  assert.match(ec.tasks.find(t=>t.source_kind==='order_mapping').action.href,/#orders\?ac=package/);
  assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_workbench_tasks').get().n,0,'GET has no writes');
  assert.equal(f.s.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n,before,'no financial writer');
 }finally{f.close();}
});
test('assignment uses active root staff, snapshots names, requires source feature access; directory is minimal',async()=>{
 const f=fixture();try{
  seed(f);
  const dir=await f.call('/staff');
  assert.deepEqual(dir.staff.map(x=>x.name),['Ayşe']);assert.deepEqual(Object.keys(dir.staff[0]).sort(),['features','id','name']);
  const saved=await f.call('/tasks/invoice_draft:invoice',{version:0,assignee_id:'staff',due_on:'2026-11-04',notes:'Belgeyi kontrol et',status:'in_progress'});
  assert.equal(saved.task.assignee_name,'Ayşe');assert.equal(saved.task.version,1);
  await assert.rejects(f.call('/tasks/invoice_draft:invoice',{version:1,assignee_id:'disabled'}),/etkin/);
  f.s.prepare("UPDATE staff_users SET permissions_json=? WHERE id='staff'").run(JSON.stringify({ec:{stock:'read'},lp:{accounts:'read'}}));
  await assert.rejects(f.call('/tasks/invoice_draft:invoice',{version:1,assignee_id:'staff'}),/yetkili/);
  const history=await f.call('/tasks/invoice_draft:invoice/audit');
  assert.equal(history.audit[0].snapshot.assignee_name,'Ayşe');
  assert.equal(history.audit[0].snapshot.namespace,'ec');assert.equal(history.audit[0].actor_id,'owner');
 }finally{f.close();}
});
test('custom tasks persist due/status/snooze in each namespace; concurrency conflicts do not add audit records',async()=>{
 const f=fixture();try{
  seed(f);
  const ec=(await f.call('/tasks',{version:0,feature:'invoices',title:'Belge iste',due_on:'2026-12-01',assignee_id:'staff'})).task;
  const lp=(await f.call('/tasks',{version:0,feature:'accounts',title:'Üretim hatırlatması'},'lp')).task;
  assert.equal((await f.call('',undefined,'ec')).tasks.some(t=>t.task_key===lp.task_key),false);
  await assert.rejects(f.call('/tasks/'+ec.task_key,{version:1,status:'done'},'lp'),e=>e.status===404);
  const completed=(await f.call('/tasks/'+ec.task_key,{version:1,status:'done',notes:'İstendi'})).task;
  assert.equal(completed.effective_status,'done');
  await assert.rejects(f.call('/tasks/'+ec.task_key,{version:1,status:'open'}),e=>e.status===409);
  assert.equal((await f.call('/tasks/'+ec.task_key+'/audit')).audit.length,2);
  await assert.rejects(f.call('/tasks/'+ec.task_key,{version:2,due_on:'2026-02-30'}),/geçersiz/);
  await assert.rejects(f.call('/tasks/'+ec.task_key,{version:2,snooze_until:'2020-01-01'}),/bugünden sonra/);
  assert.throws(()=>f.s.prepare("UPDATE ec_workbench_tasks SET version=99 WHERE task_key=?").run(ec.task_key),/WORKBENCH_VERSION/);
  assert.throws(()=>f.s.exec('UPDATE ec_workbench_task_audit SET actor_name=\'Değiştir\''),/IMMUTABLE_AUDIT/);
  assert.throws(()=>f.s.exec('DELETE FROM lp_workbench_tasks'),/WORKBENCH_KEEP_HISTORY/);
 }finally{f.close();}
});
test('unresolved financial sources cannot be marked done; snooze is explicit and source resolution/reopening remains authoritative',async()=>{
 const f=fixture();try{
  seed(f);
  await assert.rejects(f.call('/tasks/report_file:report',{version:0,status:'done'}),e=>e.status===409);
  const t=(await f.call('/tasks/report_file:report',{version:0,status:'in_progress',snooze_until:'2099-01-01'})).task;
  assert.equal(t.effective_status,'snoozed');assert.equal(t.source_active,true);
  f.s.exec("UPDATE ec_report_files SET status='applied' WHERE id='report'");
  assert.equal((await f.call()).tasks.find(t=>t.task_key==='report_file:report').effective_status,'resolved');
  await assert.rejects(f.call('/tasks/report_file:report',{version:1,notes:'Hala açık'}),e=>e.status===409);
  // The existing source state is authoritative even when it becomes actionable again.
  f.s.exec("UPDATE ec_report_files SET status='applying' WHERE id='report'");
  assert.equal((await f.call()).tasks.find(t=>t.task_key==='report_file:report').effective_status,'snoozed');
  const reopened=(await f.call('/tasks/report_file:report',{version:1,snooze_until:null})).task;
  assert.equal(reopened.effective_status,'in_progress');
  assert.throws(()=>f.s.exec("UPDATE ec_workbench_tasks SET status='done',version=version+1 WHERE task_key='report_file:report'"),/CHECK/);
 }finally{f.close();}
});
test('permission boundaries hide unauthorized sources and forbid writes by read-only or cross-workspace users',async()=>{
 const f=fixture();try{
  seed(f);
  const reader=permission({invoices:'read',amounts:'none'},'ec','read'),data=await f.call('',undefined,'ec',reader);
  assert.deepEqual(data.tasks.map(t=>t.source_kind),['invoice_draft']);assert.equal(data.tasks[0].can_write,false);assert.equal(data.tasks[0].can_embed,false);
  await assert.rejects(f.call('/tasks/invoice_draft:invoice',{version:0,notes:'X'},'ec',reader),e=>e.status===403);
  await assert.rejects(f.call('/tasks/report_file:report/audit',undefined,'ec',reader),e=>e.status===404);
  await assert.rejects(f.call('',undefined,'lp',reader),e=>e.status===403);
  await assert.rejects(f.call('/tasks',{feature:'amounts',version:0,title:'X'},'ec',permission({amounts:'write'})),e=>e.status===403);
  const writer=permission({invoices:'write',amounts:'none'});
  assert.equal((await f.call('/tasks/invoice_draft:invoice',{version:0,status:'in_progress'},'ec',writer)).task.actor_id,'staff');
 }finally{f.close();}
});
test('capped detected-source list does not falsely resolve persisted tasks beyond first 200; exact source count is returned',async()=>{
 const f=fixture();try{
  seed(f);
  f.s.exec("UPDATE ec_purchase_invoices SET invoice_date='2099-01-01' WHERE id='invoice'");
  await f.call('/tasks/invoice_draft:invoice',{version:0,notes:'Son belge'});
  const stmt=f.s.prepare("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,'supplier',?,'2026-01-01')");
  for(let i=0;i<205;i++)stmt.run('early-'+i,'EARLY-'+i);
  const data=await f.call(),saved=data.tasks.find(t=>t.task_key==='invoice_draft:invoice');
  assert.equal(data.limited,true);assert.equal(data.source_counts.invoice_draft,206);assert.equal(saved.effective_status,'open');
  assert.equal(saved.notes,'Son belge');assert.equal(saved.version,1);
 }finally{f.close();}
});
test('intake sniffs real content, restricts permission choices and refuses unsupported/empty/legacy files',async()=>{
 assert.deepEqual(intakeChoices(owner,'lp'),['invoice']);
 const pdf=new File(['%PDF-1.4\n%%EOF'],'renamed.csv',{type:'text/csv'});
 assert.equal((await detectIntake(pdf,'ec',owner)).format,'pdf');
 const xml=new File(['<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>'],'belge.xml');
 assert.equal((await detectIntake(xml,'lp',owner)).type,'invoice');
 const xlsx=new File([xlsxBytes([{name:'R',columns:[{header:'Barkod'},{header:'Adet'},{header:'Paket No'}],rows:[['A','1','P']]}])],'pazar.xlsx');
 assert.equal((await detectIntake(xlsx,'ec',owner)).reportKind,'orders');
 const ambiguous=new File(['Alan;Bilgi\nA;B'],'rapor.csv');
 assert.equal((await detectIntake(ambiguous,'ec',owner)).ambiguous,true);
 await assert.rejects(detectIntake(xlsx,'lp',owner),/e-ticaret/);
 await assert.rejects(detectIntake(pdf,'ec',permission({invoices:'read',amounts:'read'})),/yetki/);
 await assert.rejects(detectIntake(new File([],'empty.pdf'),'ec',owner),/Boş/);
 await assert.rejects(detectIntake(new File(['<html>login</html>'],'x.xlsx'),'ec',owner),/web sayfası/);
 await assert.rejects(detectIntake(new File(['unrecognized'],'x.exe'),'ec',owner),/desteklenmiyor/);
 await assert.rejects(detectIntake(new File([Uint8Array.of(208,207,17,224)],'x.xls'),'ec',owner),/XLS/);
});
test('image intake preserves original bytes in deterministic PDF attachment accepted by existing reader',async()=>{
 const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 const first=await imageInvoicePdf(png,'png','fatura.png',{PDFDocument}),second=await imageInvoicePdf(png,'png','baska-ad.png',{PDFDocument});
 assert.deepEqual(first,second,'same image generates same dedupe hash');
 const doc=await PDFDocument.load(first);
 assert.equal(doc.getPageCount(),1);assert.match(Buffer.from(first).toString('latin1'),/EmbeddedFile/);
 assert.equal((await detectIntake(new File([png],'fatura.png'),'ec',owner)).format,'png');
});

test('integrated worker routes preserve body-reader contract, populated LP reads, source status and optimistic edits',async()=>{
 const {appFixture}=await import('./helpers/app-fixture.js');const f=appFixture();try{
  await f.setup();
  for(const ns of ['ec','lp']){
   f.sqlite.exec("INSERT INTO "+ns+"_suppliers(id,name) VALUES('wb-supplier','Tedarikçi'); INSERT INTO "+ns+"_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('wb-invoice','wb-supplier','WB-INV','2026-09-01')");
   const listed=await f.req('/'+ns+'/workbench');assert.equal(listed.status,200);assert.ok(listed.data.tasks.some(t=>t.task_key==='invoice_draft:wb-invoice'));
   const created=await f.req('/'+ns+'/workbench/tasks',{version:0,feature:ns==='ec'?'invoices':'accounts',title:'Gerçek worker görevi',notes:'',assignee_id:null,due_on:'2026-11-06',snooze_until:null,status:'open'});
   assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.task.version,1);
   const key=encodeURIComponent(created.data.task.task_key);
   assert.equal((await f.req('/'+ns+'/workbench/tasks/'+key,{version:1,status:'done'})).status,200);
   assert.equal((await f.req('/'+ns+'/workbench/tasks/'+key,{version:1,status:'open'})).status,409);
   assert.equal((await f.req('/'+ns+'/workbench/tasks/invoice_draft%3Awb-invoice',{version:0,status:'done'})).status,409);
   assert.equal((await f.req('/'+ns+'/workbench/tasks/'+key+'/audit')).data.audit.length,2);
  }
 }finally{f.close();}
});
test('saved document source exists in both namespaces and only resolves when actually linked; recent receiving is not stale',async()=>{
 const f=fixture();try{
  seed(f);
  for(const ns of ['ec','lp']){
   const put=f.s.prepare('INSERT INTO '+ns+"_purchase_documents(id,kind,filename,size_bytes,sha256,chunk_count,status,created_at) VALUES(?,'pdf','Belge.pdf',10,?,1,?,?)");
   put.run('stored','b'.repeat(64),'stored','2026-09-01');put.run('recent','c'.repeat(64),'receiving','2099-01-01');put.run('stale','d'.repeat(64),'receiving','2026-09-01');
   const list=await f.call('',undefined,ns),tasks=list.tasks.filter(t=>t.source_kind==='invoice_document');
   assert.equal(tasks.length,2);assert.equal(tasks.find(t=>t.source_id==='stored').action.type,'invoice_document');assert.equal(tasks.find(t=>t.source_id==='stale').action.type,'invoice_upload');
   await f.call('/tasks/invoice_document:stored',{version:0,status:'in_progress'},ns);
   f.s.exec('UPDATE '+ns+"_purchase_documents SET invoice_id='invoice',status='linked' WHERE id='stored'");
   const current=(await f.call('',undefined,ns)).tasks.find(t=>t.task_key==='invoice_document:stored');assert.equal(current.effective_status,'resolved');
  }
 }finally{f.close();}
});
test('concurrent metadata edits preserve exactly one winning version and complete immutable snapshots',async()=>{
 const f=fixture();try{
  seed(f);await f.call('/tasks/invoice_draft:invoice',{version:0,status:'open'});
  const results=await Promise.allSettled([f.call('/tasks/invoice_draft:invoice',{version:1,notes:'A'}),f.call('/tasks/invoice_draft:invoice',{version:1,notes:'B'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  const history=(await f.call('/tasks/invoice_draft:invoice/audit')).audit;assert.deepEqual(history.map(a=>a.version),[2,1]);
  assert.equal(history[1].snapshot.notes,'');assert.ok(['A','B'].includes(history[0].snapshot.notes));
 }finally{f.close();}
});

test('partially linked multi-invoice documents stay open, unknown totals do not become zero or resolved',async()=>{
 const f=fixture();try{
  seed(f);
  f.s.exec("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('invoice2','supplier','F-2','2026-09-01');");
  f.s.prepare("INSERT INTO ec_purchase_documents(id,kind,filename,size_bytes,sha256,chunk_count,page_count,status,extracted_json) VALUES('multi','pdf','Birleşik.pdf',10,?,1,3,'stored',?)").run('e'.repeat(64),JSON.stringify({invoices:['F-1','F-2']}));
  await f.call('/tasks/invoice_document:multi',{version:0,status:'in_progress'});
  f.s.exec("INSERT INTO ec_purchase_document_pages(id,document_id,page_no,invoice_id) VALUES('page1','multi',1,'invoice')");
  let row=(await f.call()).tasks.find(t=>t.task_key==='invoice_document:multi');assert.equal(row.effective_status,'in_progress');assert.equal(row.action.type,'link');assert.match(row.detail,/2 faturadan 1/);
  f.s.exec("UPDATE ec_purchase_documents SET extracted_json='{}' WHERE id='multi'");
  row=(await f.call()).tasks.find(t=>t.task_key==='invoice_document:multi');assert.equal(row.source_active,true);assert.match(row.detail,/doğrulanamadı/);
  f.s.prepare("UPDATE ec_purchase_documents SET extracted_json=? WHERE id='multi'").run(JSON.stringify({invoices:['F-1','F-2']}));
  f.s.exec("INSERT INTO ec_purchase_document_pages(id,document_id,page_no,invoice_id) VALUES('page2','multi',2,'invoice2')");
  assert.equal((await f.call()).tasks.find(t=>t.task_key==='invoice_document:multi').effective_status,'resolved');
 }finally{f.close();}
});
