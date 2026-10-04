import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {partyProfileApi,partyFileDigest,PARTY_FILE_CHUNK_BYTES} from '../src/party-profile-api.js';
import {scopedDB} from '../src/scoped-db.js';
const owner={owner:true,id:'owner'};
const reader=(ns,extra={})=>({id:'staff',ec_access:'write',lp_access:'write',permissions:{ec:{ledger:'read',amounts:'none',...ns==='ec'?extra:{}},lp:{ledger:'read',amounts:'none',...ns==='lp'?extra:{}}}});
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,4))<=66).sort())sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const DB={prepare(query){return {args:[],bind(...args){this.args=args;return this;},first(){return sql.prepare(query).get(...this.args)||null;},all(){return {results:sql.prepare(query).all(...this.args)};},run(){return {meta:sql.prepare(query).run(...this.args)};}};},async batch(items){sql.exec('BEGIN');try{const rows=items.map(i=>i.all());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 for(const ns of ['ec','lp']){sql.prepare(`INSERT INTO ${ns}_suppliers(id,name,tax_id) VALUES(?,?,?)`).run('party',ns+' Supplier','1234567890');sql.prepare(`INSERT INTO ${ns}_suppliers(id,name) VALUES(?,?)`).run('other','Other '+ns);}
 const call=(ns='ec',path='/party',body,user=owner,method=body===undefined?'GET':'POST')=>{const u=new URL('https://local.test/api/party-profiles'+path);return partyProfileApi(new Request(u,{method}),{DB:scopedDB(DB,ns),ROOT_DB:DB,WORKSPACE:ns,USER:user},u.pathname,async()=>body);};
 const entry=(ns,id,value,source='manual',party='party',due='2020-01-01')=>sql.prepare(`INSERT INTO ${ns}_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,party,value,'2026-01-01',due,id,'Test',source==='invoice'?'invoice:'+id:id,source);
 return {sql,DB,call,entry,close:()=>sql.close()};
}
const status=n=>e=>e.status===n;
for(const ns of ['ec','lp']){
 test(ns+': incremental metadata, identity reuse, empty != zero and namespace isolation',async()=>{const f=fixture();try{
  const initial=await f.call(ns);assert.equal(initial.profile.revision,0);assert.equal(initial.profile.min_order_cents,null);assert.equal(initial.summary.last_payment,null);
  const a=await f.call(ns,'/party',{expected_revision:0,legal_name:'Legal Ltd',trade_name:'Trade',tax_office:'Şişli',contacts:[{name:'Ayşe',email:'a@example.test'}],addresses:[{label:'Depo',address:'İstanbul'}],banks:[{bank_name:'Banka',iban:'TR330006100519786457841326'}],tags:['Torf','Torf'],payment_terms_days:30,lead_days:4,discount_bps:150,min_order_cents:9901});assert.equal(a.revision,1);
  await f.call(ns,'/party',{expected_revision:1,lead_days:0});const d=await f.call(ns);assert.equal(d.profile.legal_name,'Legal Ltd');assert.equal(d.profile.min_order_cents,9901);assert.equal(d.profile.lead_days,0);assert.deepEqual(d.profile.tags,['Torf']);assert.equal(d.party.name,ns+' Supplier');assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${ns}_suppliers`).get().n,2);
  const other=await f.call(ns==='ec'?'lp':'ec');assert.equal(other.profile.revision,0);assert.equal(other.profile.legal_name,'');
  await assert.rejects(f.call(ns,'/party',{expected_revision:1,legal_name:'stale'}),status(409));await assert.rejects(f.call(ns,'/party',{legal_name:'missing version'}),status(428));await assert.rejects(f.call(ns,'/party',{expected_revision:2,name:'duplicate'}),status(400));
  await assert.rejects(f.call(ns,'/party',{expected_revision:2,banks:[{iban:'TR000006100519786457841326'}]}),status(400));await assert.rejects(f.call(ns,'/party',{expected_revision:2,min_order_cents:1.5}),status(400));
  await assert.rejects(f.call(ns,'/missing',{expected_revision:0}),status(404));assert.equal((await f.call(ns)).profile.revision,2);
 }finally{f.close();}});
 test(ns+': concurrent profile saves have one winner; no partial fields',async()=>{const f=fixture();try{
  const results=await Promise.allSettled([f.call(ns,'/party',{expected_revision:0,legal_name:'A',tags:['A']}),f.call(ns,'/party',{expected_revision:0,legal_name:'B',tags:['B']})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);const p=(await f.call(ns)).profile;assert.deepEqual(p.tags,[p.legal_name]);
  const updates=await Promise.allSettled([f.call(ns,'/party',{expected_revision:1,legal_name:'C'}),f.call(ns,'/party',{expected_revision:1,legal_name:'D'})]);assert.equal(updates.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.call(ns)).profile.revision,2);
 }finally{f.close();}});
 test(ns+': staff workspace access checked by API and SQL; staff directory has no credentials',async()=>{const f=fixture();try{
  f.sql.exec("INSERT INTO staff_users(id,username,name,ec_access,lp_access) VALUES('ec-staff','ec-user','Ec Person','write','none'),('lp-staff','lp-user','Lp Person','none','read'); INSERT INTO staff_users(id,username,name,ec_access,lp_access,active) VALUES('inactive','hidden','Inactive','write','write',0)");
  const staff=await f.call(ns,'/staff');assert.deepEqual(staff.rows.map(r=>r.id),[ns+'-staff']);assert.deepEqual(Object.keys(staff.rows[0]).sort(),['id','name']);
  await assert.rejects(f.call(ns,'/party',{expected_revision:0,responsible_staff_id:ns==='ec'?'lp-staff':'ec-staff'}),status(400));await assert.rejects(f.call(ns,'/party',{expected_revision:0,responsible_staff_id:'inactive'}),status(400));
  await f.call(ns,'/party',{expected_revision:0,responsible_staff_id:ns+'-staff'});f.sql.prepare('UPDATE staff_users SET active=0 WHERE id=?').run(ns+'-staff');const p=(await f.call(ns)).profile;assert.equal(p.responsible_staff,null);assert.equal(p.responsible_unavailable,true);
  assert.throws(()=>f.sql.prepare(`UPDATE ${ns}_party_profiles SET responsible_staff_id='inactive',revision=revision+1 WHERE party_id='party'`).run(),/PROFILE_STAFF_ACCESS/);
  await assert.rejects(f.call(ns,'/party',{expected_revision:1,legal_name:'bad assignment'}),status(400));await f.call(ns,'/party',{expected_revision:1,responsible_staff_id:null});
 }finally{f.close();}});
 test(ns+': ledger totals include all pages, allocation reversals and uncashed cheques',async()=>{const f=fixture();try{
  f.entry(ns,'debt',-12000);f.entry(ns,'paid',5000,'legacy_payment');f.sql.prepare(`INSERT INTO ${ns}_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES('alloc','paid','debt',4000,'alloc')`).run();
  f.entry(ns,'cheque',2000,'cash');f.sql.prepare(`INSERT INTO ${ns}_party_payment_methods(entry_id,method,due_on,note) VALUES('cheque','cek','2026-01-02','Secret bank note')`).run();
  f.entry(ns,'foreign',-999999,'manual','other');
  for(let i=0;i<55;i++)f.entry(ns,'tiny-'+i,-100);
  let s=(await f.call(ns)).summary;assert.equal(s.ledger.balance_cents,-10500);assert.equal(s.ledger.open_payable_cents,13500);assert.equal(s.ledger.open_receivable_cents,3000);assert.equal(s.ledger.overdue_cents,13500);assert.equal(s.cheques.pending_cents,2000);
  f.sql.prepare(`INSERT INTO ${ns}_allocation_reversals(id,allocation_id,reason) VALUES('undo','alloc','Test')`).run();s=(await f.call(ns)).summary;assert.equal(s.ledger.open_payable_cents,17500);assert.equal(s.ledger.balance_cents,-10500);
  f.sql.prepare(`INSERT INTO ${ns}_cash_accounts(id,name,kind) VALUES('bank','Bank','bank')`).run();f.sql.prepare(`INSERT INTO ${ns}_cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description) VALUES('ct','bank','cheque',-2000,'2026-01-02','cash','Cheque paid')`).run();
  assert.equal((await f.call(ns)).summary.cheques.pending_cents,0);assert.equal((await f.call(ns,'/party/payments')).rows.find(r=>r.id==='cheque').cash_recorded,1);
 }finally{f.close();}});
 test(ns+': financial access, notes and IBAN cannot leak through dossier reads or writes',async()=>{const f=fixture();try{
  await f.call(ns,'/party',{expected_revision:0,banks:[{bank_name:'SECRET BANK',iban:'TR330006100519786457841326'}],discount_bps:123,min_order_cents:567});await f.call(ns,'/party/notes',{expected_revision:0,body:'SECRET AMOUNT 9988',remind_on:'2026-12-01'});f.entry(ns,'debt',-5000);
  const u=reader(ns,{ledger:'write'}),r=await f.call(ns,'/party',undefined,u);assert.equal(r.profile.banks,null);assert.equal(r.profile.discount_bps,null);assert.equal(r.profile.min_order_cents,null);assert.equal(r.summary.ledger.balance_cents,null);assert.equal(r.summary.invoices,null);assert.equal(r.summary.reminders,null);assert.doesNotMatch(JSON.stringify(r),/SECRET|9988|TR330006/);
  for(const path of ['/notes','/attachments','/invoices','/products','/provisional'])await assert.rejects(f.call(ns,'/party'+path,undefined,u),status(403));
  await assert.rejects(f.call(ns,'/party',{expected_revision:1,banks:[]},u),status(403));await assert.rejects(f.call(ns,'/party/notes',{expected_revision:0,body:'hide'},u),status(403));await assert.rejects(f.call(ns,'/party',{expected_revision:1,tax_office:'x'},reader(ns)),status(403));
  await f.call(ns,'/party',{expected_revision:1,tax_office:'Allowed'},u);assert.equal((await f.call(ns)).profile.banks[0].bank_name,'SECRET BANK');
  const invUser=reader(ns,{[ns==='ec'?'invoices':'accounts']:'read'});assert.equal((await f.call(ns,'/party/invoices',undefined,invUser)).rows.length,0);assert.equal((await f.call(ns,'/party',undefined,invUser)).summary.ledger.balance_cents,null);
 }finally{f.close();}});
 test(ns+': note reminders update with revision, cannot move across parties or revive archived cards',async()=>{const f=fixture();try{
  const n=await f.call(ns,'/party/notes',{id:'note',expected_revision:0,body:'Call supplier',remind_on:'2026-12-25'});assert.equal(n.revision,1);
  await f.call(ns,'/party/notes/note',{expected_revision:1,status:'done'});await assert.rejects(f.call(ns,'/party/notes/note',{expected_revision:1,body:'Stale'}),status(409));await assert.rejects(f.call(ns,'/other/notes/note',{expected_revision:2,status:'open'}),status(404));
  assert.equal((await f.call(ns,'/party/notes')).rows[0].body,'Call supplier');assert.equal((await f.call(ns)).summary.reminders.pending_count,0);
  await assert.rejects(f.call(ns,'/party/notes',{expected_revision:0,body:'bad',remind_on:'2026-02-30'}),status(400));f.sql.prepare(`UPDATE ${ns}_suppliers SET archived_at='2026-01-01' WHERE id='party'`).run();await assert.rejects(f.call(ns,'/party',{expected_revision:0,legal_name:'x'}),status(409));assert.ok((await f.call(ns)).party.archived_at);
 }finally{f.close();}});
}
test('invalid namespaces fail before SQL and sibling paths remain unhandled',async()=>{assert.equal(await partyProfileApi(new Request('https://x/'),{},'/api/party-profiles-other',async()=>({})),null);await assert.rejects(partyProfileApi(new Request('https://x/'),{WORKSPACE:'ec; DROP',USER:owner},'/api/party-profiles/party',async()=>({})),status(403));});
test('0066 migration passes the actual Wrangler splitter and preserves existing rows',async()=>{const f=fixture();try{const text=readFileSync(new URL('../migrations/0066_party_profiles.sql',import.meta.url),'utf8'),split=createRequire(import.meta.url)('wrangler').unstable_splitSqlQuery;const fresh=new DatabaseSync(':memory:');try{for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&Number(n.slice(0,4))<=65).sort())fresh.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));fresh.exec("INSERT INTO ec_suppliers(id,name) VALUES('existing','Existing'); INSERT INTO lp_suppliers(id,name) VALUES('existing','Existing LP')");for(const statement of split(text))fresh.exec(statement);assert.equal(fresh.prepare('SELECT name FROM ec_suppliers').get().name,'Existing');assert.equal(fresh.prepare('SELECT name FROM lp_suppliers').get().name,'Existing LP');assert.equal(fresh.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%party_profile%'").get().n,8);}finally{fresh.close();}}finally{f.close();}});

for(const ns of ['ec','lp'])test(ns+': D1 attachments resume, verify, seal and enforce permissions/scoping/concurrency',async()=>{const f=fixture();try{
 const bytes=new Uint8Array(PARTY_FILE_CHUNK_BYTES+100);bytes.set(new TextEncoder().encode('%PDF-1.7\nTest file'));const sha256=await partyFileDigest(bytes),meta={filename:'test.pdf',mime:'application/pdf',size_bytes:bytes.length,sha256,chunk_count:2};
 const file=await f.call(ns,'/party/attachments',meta);assert.equal(file.revision,1);const path='/party/attachments/'+file.id;
 await assert.rejects(f.call(ns,path+'/part?index=0'),status(409));await assert.rejects(f.call(ns,path+'/seal',{expected_revision:1}),status(409));
 await f.call(ns,path+'/chunk',{expected_revision:1,index:0,data:Buffer.from(bytes.slice(0,PARTY_FILE_CHUNK_BYTES)).toString('base64')});
 const resumed=await f.call(ns,'/party/attachments',meta);assert.equal(resumed.existing,true);assert.equal(resumed.id,file.id);assert.deepEqual(resumed.uploaded_indices,[0]);assert.equal(resumed.revision,2);
 await assert.rejects(f.call(ns,path+'/chunk',{expected_revision:1,index:1,data:Buffer.from(bytes.slice(PARTY_FILE_CHUNK_BYTES)).toString('base64')}),status(409));
 const last={expected_revision:2,index:1,data:Buffer.from(bytes.slice(PARTY_FILE_CHUNK_BYTES)).toString('base64')};const race=await Promise.allSettled([f.call(ns,path+'/chunk',last),f.call(ns,path+'/chunk',last)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${ns}_party_profile_file_chunks WHERE file_id=?`).get(file.id).n,2);
 const sealed=await f.call(ns,path+'/seal',{expected_revision:3});assert.equal(sealed.state,'sealed');assert.equal(sealed.revision,4);const parts=await Promise.all([0,1].map(i=>f.call(ns,path+'/part?index='+i)));assert.deepEqual(Buffer.concat(parts.map(p=>Buffer.from(p.data,'base64'))),Buffer.from(bytes));
 await assert.rejects(f.call(ns,path+'/chunk',{expected_revision:4,index:0,data:Buffer.from(bytes.slice(0,PARTY_FILE_CHUNK_BYTES)).toString('base64')}),status(409));
 await assert.rejects(f.call(ns,'/other/attachments/'+file.id+'/part?index=0'),status(404));await assert.rejects(f.call(ns==='ec'?'lp':'ec',path+'/part?index=0'),status(404));await assert.rejects(f.call(ns,path+'/part?index=0',undefined,reader(ns)),status(403));
 assert.throws(()=>f.sql.prepare(`UPDATE ${ns}_party_profile_file_chunks SET data_b64='AAAA' WHERE file_id=?`).run(file.id),/PROFILE_FILE_LOCKED/);
 assert.equal((await f.call(ns,'/party/attachments',meta)).id,file.id);assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${ns}_party_profile_files`).get().n,1);
 const bad=new TextEncoder().encode('<script>bad</script>'),badFile=await f.call(ns,'/party/attachments',{...meta,filename:'fake.pdf',size_bytes:bad.length,chunk_count:1,sha256:await partyFileDigest(bad)});await f.call(ns,'/party/attachments/'+badFile.id+'/chunk',{expected_revision:1,index:0,data:Buffer.from(bad).toString('base64')});await assert.rejects(f.call(ns,'/party/attachments/'+badFile.id+'/seal',{expected_revision:2}),status(400));
 await assert.rejects(f.call(ns,'/party/attachments',{...meta,mime:'image/svg+xml'}),status(400));await assert.rejects(f.call(ns,'/party/attachments',{...meta,filename:'../bad.pdf'}),status(400));
}finally{f.close();}});
for(const ns of ['ec','lp'])test(ns+': invoices and integer purchase prices are scoped, ledger-derived and paginated',async()=>{const f=fixture();try{
 const table=ns==='ec'?'ec_products':'products';f.sql.prepare(`INSERT INTO ${table}(id,name,sku) VALUES('product','Torf','TORF')`).run();
 for(let i=0;i<53;i++){
  f.sql.prepare(`INSERT INTO ${ns}_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,?,?,?)`).run('inv-'+i,i===52?'other':'party','INV-'+i,'2026-01-01');
  f.sql.prepare(`INSERT INTO ${ns}_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents) VALUES(?,?,?,3,'adet','product',3000,10001,1999)`).run('line-'+i,'inv-'+i,'Original purchase line');
  f.sql.prepare(`UPDATE ${ns}_purchase_invoices SET status='posted' WHERE id=?`).run('inv-'+i);
 }
 f.entry(ns,'pay',4000,'legacy_payment');f.sql.prepare(`INSERT INTO ${ns}_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES('allocation','pay','invoice:inv-0',4000,'ALLOC')`).run();
 const pages=await Promise.all([1,2].map(n=>f.call(ns,'/party/invoices?page='+n)));assert.equal(pages[0].rows.length,50);assert.equal(pages[0].has_more,true);assert.equal(pages[1].rows.length,2);const invoices=pages.flatMap(p=>p.rows);assert.equal(new Set(invoices.map(i=>i.id)).size,52);const zero=invoices.find(i=>i.id==='inv-0');assert.equal(zero.total_cents,12000);assert.equal(zero.ledger_debt_cents,12000);assert.equal(zero.settled_cents,4000);assert.equal(zero.remaining_cents,8000);assert.ok(invoices.every(i=>i.id!=='inv-52'));
 const prices=await f.call(ns,'/party/products');assert.equal(prices.rows[0].unit_net_cents,3334);assert.equal(prices.rows[0].unit_gross_cents,4000);assert.equal(prices.rows[0].product_name,'Torf');assert.equal((await f.call(ns)).summary.ledger.balance_cents,-620000);
 const pay=(await f.call(ns,'/party/payments')).rows[0];assert.equal(pay.closed_invoices[0].id,'inv-0');assert.equal(pay.closed_invoices[0].amount_cents,4000);
 const noInvoice=await f.call(ns,'/party/payments',undefined,reader(ns,{amounts:'read'}));assert.equal(noInvoice.rows[0].closed_invoices,null);
 const noAmounts=reader(ns,{[ns==='ec'?'invoices':'accounts']:'read'});const hidden=(await f.call(ns,'/party/products',undefined,noAmounts)).rows[0];assert.equal(hidden.unit_net_cents,null);assert.equal(hidden.quantity_milli,3000);
 const provisional=await f.call(ns,'/party/provisional');assert.equal(provisional.supported,ns==='ec');
}finally{f.close();}});
test('attachment quota permits resuming an existing file; active extensions and incorrect digests are rejected',async()=>{const f=fixture();try{
 const data=new TextEncoder().encode('%PDF-1.7\nbytes'),meta={filename:'proof.pdf',mime:'application/pdf',size_bytes:data.length,chunk_count:1,sha256:'0'.repeat(64)};
 await assert.rejects(f.call('ec','/party/attachments',{...meta,filename:'proof.html'}),status(400));
 const file=await f.call('ec','/party/attachments',meta);await f.call('ec','/party/attachments/'+file.id+'/chunk',{expected_revision:1,index:0,data:Buffer.from(data).toString('base64')});await assert.rejects(f.call('ec','/party/attachments/'+file.id+'/seal',{expected_revision:2}),status(409));
 for(let i=1;i<100;i++)f.sql.prepare("INSERT INTO ec_party_profile_files(id,party_id,filename,mime,size_bytes,sha256,chunk_count,created_by) VALUES(?,'party','test.pdf','application/pdf',100,?,1,'owner')").run('quota-'+i,i.toString(16).padStart(64,'0'));
 assert.equal((await f.call('ec','/party/attachments',meta)).id,file.id);
 await assert.rejects(f.call('ec','/party/attachments',{...meta,sha256:'f'.repeat(64)}),status(409));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_party_profile_files').get().n,100);
}finally{f.close();}});
