import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {partyProfileApi,partyFileDigest} from '../src/party-profile-api.js';
import {workbenchApi} from '../src/workbench-api.js';

// Bounded independent extension: all real migrations, synthetic in-memory SQLite only.
const owner={id:'review-owner',name:'Independent owner',owner:true};
const hasStatus=n=>e=>e.status===n;
function fixture(){
 const f=appFixture();
 for(const ns of ['ec','lp']){
  f.sqlite.prepare(`INSERT INTO ${ns}_suppliers(id,name) VALUES('shared',?),('other',?)`).run(ns+' shared',ns+' other');
  f.sqlite.prepare(`INSERT INTO ${ns}_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('shared','shared',?,'2026-09-10')`).run(ns+' invoice');
 }
 const invoke=(handler,path,body,ns='ec',user=owner)=>handler(new Request('https://review.test'+path,{method:body===undefined?'GET':'POST'}),{...f.env,DB:scopedDB(f.env.DB,ns),ROOT_DB:f.env.DB,WORKSPACE:ns,USER:user},path.split('?')[0],async()=>body);
 const profile=(path='/shared',body,ns='ec',user=owner)=>invoke(partyProfileApi,'/api/party-profiles'+path,body,ns,user);
 const workbench=(path='',body,ns='ec',user=owner)=>invoke(workbenchApi,'/api/workbench'+path,body,ns,user);
 const financialSnapshot=()=>Object.fromEntries(['ec','lp'].flatMap(ns=>['suppliers','purchase_invoices','party_entries','cash_transactions','stock_movements'].map(table=>[ns+'_'+table,f.sqlite.prepare('SELECT * FROM '+ns+'_'+table+' ORDER BY rowid').all()])));
 return {...f,profile,workbench,financialSnapshot};
}
async function upload(f,ns='ec'){
 const bytes=new TextEncoder().encode('%PDF-1.7\nCONFIDENTIAL-DOCKET-7531\n%%EOF');
 const meta={filename:'review.pdf',mime:'application/pdf',size_bytes:bytes.length,chunk_count:1,sha256:await partyFileDigest(bytes)};
 const file=await f.profile('/shared/attachments',meta,ns),path='/shared/attachments/'+file.id;
 await f.profile(path+'/chunk',{expected_revision:1,index:0,data:Buffer.from(bytes).toString('base64')},ns);
 await f.profile(path+'/seal',{expected_revision:2},ns);
 return {file,path,bytes,meta};
}

test('dossier review: real Worker denies raw financial dossier data and task feature laundering',async()=>{
 const f=fixture();try{
  await f.setup();
  await f.profile('/shared',{expected_revision:0,banks:[{bank_name:'SECRET BANK',iban:'TR330006100519786457841326'}],discount_bps:123,min_order_cents:7531});
  await f.profile('/shared/notes',{id:'private-note',expected_revision:0,body:'CONFIDENTIAL-7531'});
  const {file}=await upload(f);
  const privateTask=(await f.workbench('/tasks',{version:0,feature:'invoices',title:'PRIVATE-INVOICE-TASK',notes:'PRIVATE-INVOICE-NOTE'})).task;
  const account=await f.ok('/admin/users',{name:'Dossier reviewer',username:'dossier-reviewer',permissions:{ec:{ledger:'write',stock:'write',amounts:'none'},lp:{},delete_records:false}});
  assert.equal((await f.req('/auth/accept-invite',{token:account.invite_path.split('invite=')[1],password:'synthetic-dossier-password'})).status,200);
  const login=await f.req('/auth/login',{username:'dossier-reviewer',password:'synthetic-dossier-password'});assert.equal(login.status,200);
  const req=(path,body)=>f.req(path,body,login.cookie);
  const financialBefore=f.financialSnapshot();
  const read=await req('/ec/party-profiles/shared');assert.equal(read.status,200);assert.equal(read.data.profile.banks,null);assert.equal(read.data.profile.discount_bps,null);assert.equal(read.data.profile.min_order_cents,null);
  assert.doesNotMatch(JSON.stringify(read.data),/SECRET|7531|TR330006/);
  for(const path of ['/ec/party-profiles/shared/notes','/ec/party-profiles/shared/attachments','/ec/party-profiles/shared/attachments/'+file.id+'/part?index=0','/ec/party-profiles/shared/invoices','/lp/party-profiles/shared'])assert.equal((await req(path)).status,403,path);
  assert.equal((await req('/ec/party-profiles/shared',{expected_revision:1,banks:[]})).status,403);
  assert.equal((await req('/ec/party-profiles/shared',{expected_revision:1,trade_name:'Allowed metadata'})).status,200);
  const current=await f.profile();assert.equal(current.profile.banks[0].bank_name,'SECRET BANK');assert.equal(current.profile.min_order_cents,7531);
  const listing=await req('/ec/workbench');assert.equal(listing.status,200);assert.doesNotMatch(JSON.stringify(listing.data),/PRIVATE-INVOICE/);
  const key=encodeURIComponent(privateTask.task_key);
  assert.equal((await req('/ec/workbench/tasks/'+key+'/audit')).status,404);
  assert.equal((await req('/ec/workbench/tasks/'+key,{version:1,feature:'stock',notes:'Attempted takeover'})).status,404);
  assert.equal((await req('/ec/workbench/tasks',{version:0,feature:'invoices',title:'Forbidden'})).status,403);
  assert.equal((await req('/lp/workbench/tasks',{version:0,feature:'accounts',title:'Forbidden'})).status,403);
  const ownTask=await req('/ec/workbench/tasks',{version:0,feature:'stock',title:'Allowed stock task'});assert.equal(ownTask.status,200);
  assert.equal(ownTask.data.task.actor_id,account.id);
  assert.equal((await req('/ec/workbench/tasks/'+encodeURIComponent(ownTask.data.task.task_key),{version:1,status:'done',actor_id:'review-owner'})).status,400);
  assert.deepEqual(f.financialSnapshot(),financialBefore,'Dossier/task writes must not alter source financial/identity records');
 }finally{f.close();}
});

test('dossier review: identical dossier, note and task identities remain isolated across EC and LP',async()=>{
 const f=fixture();try{
  const before=f.financialSnapshot();
  for(const ns of ['ec','lp']){
   await f.profile('/shared',{expected_revision:0,legal_name:ns+' legal'},ns);
   await f.profile('/shared/notes',{expected_revision:0,id:'same-note',body:ns+' private note'},ns);
   const t=await f.workbench('/tasks/invoice_draft:shared',{version:0,notes:ns+' private task',status:'in_progress'},ns);assert.equal(t.task.version,1);
  }
  await f.profile('/shared/notes/same-note',{expected_revision:1,body:'ec edited'},'ec');
  await f.workbench('/tasks/invoice_draft:shared',{version:1,notes:'ec edited'},'ec');
  assert.equal((await f.profile('/shared',undefined,'lp')).profile.legal_name,'lp legal');
  assert.equal((await f.profile('/shared/notes',undefined,'lp')).rows[0].body,'lp private note');
  const lpAudit=await f.workbench('/tasks/invoice_draft:shared/audit',undefined,'lp');assert.equal(lpAudit.audit.length,1);assert.equal(lpAudit.audit[0].snapshot.notes,'lp private task');assert.equal(lpAudit.audit[0].snapshot.namespace,'lp');
  const ecAudit=await f.workbench('/tasks/invoice_draft:shared/audit');assert.equal(ecAudit.audit.length,2);assert.equal(ecAudit.audit[0].snapshot.namespace,'ec');
  const {file}=await upload(f,'ec');
  await assert.rejects(()=>f.profile('/shared/attachments/'+file.id+'/part?index=0',undefined,'lp'),hasStatus(404));
  await assert.rejects(()=>f.profile('/other/attachments/'+file.id+'/part?index=0'),hasStatus(404));
  await assert.rejects(()=>f.profile('/other/notes/same-note',{expected_revision:2,body:'Attempted move'}),hasStatus(404));
  assert.deepEqual(f.financialSnapshot(),before);
 }finally{f.close();}
});

test('dossier review: concurrent restricted and financial profile edits cannot overwrite protected fields',async()=>{
 const f=fixture();try{
  await f.profile('/shared',{expected_revision:0,min_order_cents:5000,banks:[{bank_name:'Protected bank'}]});
  const limited={id:'staff',ec_access:'write',lp_access:'none',permissions:{ec:{ledger:'write',amounts:'none'},lp:{}}};
  const writes=await Promise.allSettled([
   f.profile('/shared',{expected_revision:1,trade_name:'Limited editor'},'ec',limited),
   f.profile('/shared',{expected_revision:1,min_order_cents:6000,banks:[{bank_name:'New protected bank'}]})
  ]);
  assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes.find(r=>r.status==='rejected').reason.status,409);
  let current=(await f.profile()).profile;assert.equal(current.revision,2);
  if(writes[0].status==='fulfilled'){
   assert.equal(current.min_order_cents,5000);assert.equal(current.banks[0].bank_name,'Protected bank');
   await f.profile('/shared',{expected_revision:2,min_order_cents:6000,banks:[{bank_name:'New protected bank'}]});
  }else{
   assert.equal(current.min_order_cents,6000);assert.equal(current.banks[0].bank_name,'New protected bank');
   await f.profile('/shared',{expected_revision:2,trade_name:'Limited editor'},'ec',limited);
  }
  current=(await f.profile()).profile;assert.equal(current.revision,3);assert.equal(current.trade_name,'Limited editor');assert.equal(current.min_order_cents,6000);assert.equal(current.banks[0].bank_name,'New protected bank');
 }finally{f.close();}
});

test('dossier review: a failed attachment chunk rolls its revision back and never exposes unsealed bytes',async()=>{
 const f=fixture();try{
  const bytes=new TextEncoder().encode('%PDF-1.7\nOriginal evidence\n%%EOF');
  const file=await f.profile('/shared/attachments',{filename:'evidence.pdf',mime:'application/pdf',size_bytes:bytes.length,chunk_count:1,sha256:await partyFileDigest(bytes)});
  const path='/shared/attachments/'+file.id,payload={expected_revision:1,index:0,data:Buffer.from(bytes).toString('base64')};
  f.sqlite.exec("CREATE TRIGGER review_fail_chunk BEFORE INSERT ON ec_party_profile_file_chunks BEGIN SELECT RAISE(ABORT,'REVIEW_CHUNK_FAILURE'); END");
  await assert.rejects(()=>f.profile(path+'/chunk',payload),/REVIEW_CHUNK_FAILURE/);
  const stored=f.sqlite.prepare('SELECT revision,write_token,state FROM ec_party_profile_files WHERE id=?').get(file.id);assert.equal(stored.revision,1);assert.equal(stored.write_token,null);assert.equal(stored.state,'uploading');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_profile_file_chunks').get().n,0);
  await assert.rejects(()=>f.profile(path+'/part?index=0'),hasStatus(409));
  f.sqlite.exec('DROP TRIGGER review_fail_chunk');
  await f.profile(path+'/chunk',payload);await f.profile(path+'/seal',{expected_revision:2});
  assert.deepEqual(Buffer.from((await f.profile(path+'/part?index=0')).data,'base64'),Buffer.from(bytes));
  await assert.rejects(()=>f.profile(path+'/chunk',{...payload,expected_revision:3}),hasStatus(409));
  assert.throws(()=>f.sqlite.prepare('DELETE FROM ec_party_profile_file_chunks WHERE file_id=?').run(file.id),/PROFILE_FILE_LOCKED/);
 }finally{f.close();}
});

test('dossier review: task audit failures roll back edits, and concurrent updates keep one complete snapshot',async()=>{
 const f=fixture();try{
  const task=(await f.workbench('/tasks',{version:0,feature:'stock',title:'Original task',notes:'Original note'})).task;
  const key=task.task_key;
  f.sqlite.exec("CREATE TRIGGER review_fail_audit BEFORE INSERT ON ec_workbench_task_audit WHEN NEW.version>1 BEGIN SELECT RAISE(ABORT,'REVIEW_AUDIT_FAILURE'); END");
  await assert.rejects(()=>f.workbench('/tasks/'+key,{version:1,title:'Lost title',notes:'Lost note',status:'done'}),/REVIEW_AUDIT_FAILURE/);
  let row=f.sqlite.prepare('SELECT * FROM ec_workbench_tasks WHERE task_key=?').get(key);assert.equal(row.version,1);assert.equal(row.title,'Original task');assert.equal(row.notes,'Original note');assert.equal(row.status,'open');
  assert.equal((await f.workbench('/tasks/'+key+'/audit')).audit.length,1);
  f.sqlite.exec('DROP TRIGGER review_fail_audit');
  const writes=await Promise.allSettled(['A','B'].map(v=>f.workbench('/tasks/'+key,{version:1,title:v,notes:v,status:'in_progress'})));
  assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);assert.equal(writes.find(r=>r.status==='rejected').reason.status,409);
  row=f.sqlite.prepare('SELECT * FROM ec_workbench_tasks WHERE task_key=?').get(key);
  const audit=(await f.workbench('/tasks/'+key+'/audit')).audit;assert.deepEqual(audit.map(a=>a.version),[2,1]);
  assert.equal(audit[0].snapshot.title,row.title);assert.equal(audit[0].snapshot.notes,row.title);assert.equal(row.notes,row.title);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_workbench_task_audit'),/IMMUTABLE_AUDIT/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_workbench_tasks'),/WORKBENCH_KEEP_HISTORY/);
 }finally{f.close();}
});

test('dossier review: source disappearance preserves its saved task and audit as unavailable',async()=>{
 const f=fixture();try{
  await f.workbench('/tasks/invoice_draft:shared',{version:0,notes:'Retain investigation',status:'in_progress'});
  f.sqlite.exec("DELETE FROM ec_purchase_invoices WHERE id='shared'");
  const row=(await f.workbench()).tasks.find(t=>t.task_key==='invoice_draft:shared');assert.ok(row);assert.equal(row.effective_status,'unavailable');assert.equal(row.notes,'Retain investigation');assert.equal(row.version,1);
  await assert.rejects(()=>f.workbench('/tasks/invoice_draft:shared',{version:1,status:'done'}),hasStatus(409));
  const history=await f.workbench('/tasks/invoice_draft:shared/audit');assert.equal(history.audit.length,1);assert.equal(history.audit[0].snapshot.notes,'Retain investigation');
 }finally{f.close();}
});
