import {can} from '../public/permissions.js';
import {scrubAmounts} from './permission-policy.js';
import {provisionalReceipts} from './provisional-inventory.js';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const key=value=>{if(typeof value!=='string'||!/^[-\w:.]{1,120}$/.test(value))fail('Kayıt seçimi geçersiz.');return value;};
const object=x=>{if(!x||typeof x!=='object'||Array.isArray(x))fail('Bilgileri kontrol edin.');return x;};
const text=(value,max=200)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail('Metin geçersiz veya çok uzun.');return value.trim();};
const integer=(value,max)=>{if(value===null)return null;if(!Number.isSafeInteger(value)||value<0||value>max)fail('Geçerli bir tam sayı girin.');return value;};
const revision=x=>{if(!Number.isSafeInteger(x)||x<0)fail('Güncel kayıt sürümü gerekli.',428);return x;};
const conflict=()=>fail('Kayıt başka bir işlemde değişti. Güncel bilgileri yükleyip yeniden deneyin.',409);
const day=x=>{if(x===null||x==='')return null;if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x)fail('Tarihi kontrol edin.');return x;};
const own=(o,k)=>Object.hasOwn(o,k);
const all=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results;
const first=(db,sql,args=[]) => db.prepare(sql).bind(...args).first();
const live=a=>`${a}.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM party_entries rev WHERE rev.reversal_of=${a}.id)`;
const allocated=a=>`COALESCE((SELECT SUM(pa.amount_cents) FROM payment_allocations pa WHERE (pa.positive_entry_id=${a}.id OR pa.negative_entry_id=${a}.id) AND NOT EXISTS(SELECT 1 FROM allocation_reversals ar WHERE ar.allocation_id=pa.id)),0)`;
const planned=a=>`(SELECT pl.planned_on FROM party_entry_plans pl WHERE pl.entry_id=${a}.id ORDER BY pl.created_at DESC,pl.rowid DESC LIMIT 1)`;
const cashPaid=a=>`EXISTS(SELECT 1 FROM cash_transactions ct WHERE ct.party_entry_id=${a}.id AND ct.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM cash_transactions cr WHERE cr.reversal_of=ct.id))`;
const payment=a=>`(${a}.source IN ('cash','legacy_payment') OR EXISTS(SELECT 1 FROM party_payment_methods pm WHERE pm.entry_id=${a}.id))`;
const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
const defaults={revision:0,legal_name:'',trade_name:'',tax_office:'',contacts:[],addresses:[],banks:[],tags:[],payment_terms_days:null,discount_bps:null,lead_days:null,min_order_cents:null,responsible_staff_id:null,updated_at:null};
const jsonColumns=['contacts','addresses','banks','tags'];
const columns=['legal_name','trade_name','tax_office','contacts_json','addresses_json','banks_json','tags_json','payment_terms_days','discount_bps','lead_days','min_order_cents','responsible_staff_id'];
const expose=row=>{if(!row)return {...defaults};const out={...row};for(const k of jsonColumns){out[k]=JSON.parse(row[k+'_json']);delete out[k+'_json'];}return out;};
// Fixed namespace also covers these new tables before the parent's scopedDB registry is updated.
function profileDB(db,ns){return {prepare(sql){return db.prepare(sql.replace(/\b(party_profile_file_chunks|party_profile_files|party_profile_notes|party_profiles)\b/g,ns+'_$1'));},batch:items=>db.batch(items)};}
const page=url=>{const n=Number(url.searchParams.get('page')||1);if(!Number.isSafeInteger(n)||n<1||n>100000)fail('Sayfa geçersiz.');return n;};
async function paged(db,sql,args,url){const n=page(url),rows=await all(db,sql+' LIMIT ? OFFSET ?',[...args,51,(n-1)*50]);return {rows:rows.slice(0,50),page:n,has_more:rows.length>50};}
function array(value,label,parse,max=20){if(!Array.isArray(value)||value.length>max)fail(label+' en fazla '+max+' kayıt olabilir.');return value.map(parse);}
function record(x,fields){object(x);if(Object.keys(x).some(k=>!own(fields,k)))fail('Bilinmeyen alan.');return Object.fromEntries(Object.entries(fields).map(([k,max])=>[k,text(x[k]??'',max)]));}
function email(value){if(value&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))fail('E-posta adresini kontrol edin.');return value;}
function bank(x){const row=record(x,{label:100,bank_name:160,account_name:200,iban:34,currency:3});row.currency=row.currency||'TRY';if(row.currency!=='TRY')fail('Bu hesap TRY olmalı.');row.iban=row.iban.replace(/\s/g,'').toUpperCase();if(row.iban){if(!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(row.iban))fail('IBAN geçersiz.');let mod=0;for(const c of row.iban.slice(4)+row.iban.slice(0,4)){const digits=/\d/.test(c)?c:String(c.charCodeAt(0)-55);for(const d of digits)mod=(mod*10+Number(d))%97;}if(mod!==1||row.iban.startsWith('TR')&&row.iban.length!==26)fail('IBAN kontrolü başarısız.');}if(!row.bank_name&&!row.iban)fail('Banka adı veya IBAN girin.');return row;}
function patchProfile(x,previous,amounts){
 const allowed=['expected_revision',...Object.keys(defaults).filter(k=>!['revision','updated_at'].includes(k))];
 if(Object.keys(x).some(k=>!allowed.includes(k)))fail('Bilinmeyen cari alanı.');
 const out={...previous};
 for(const k of ['legal_name','trade_name','tax_office'])if(own(x,k))out[k]=text(x[k],k==='tax_office'?100:200);
 for(const k of ['payment_terms_days','lead_days'])if(own(x,k))out[k]=integer(x[k],3650);
 for(const k of ['discount_bps','min_order_cents','banks'])if(own(x,k)&&!amounts)fail('Bu bilgi için tutar yetkisi gerekli.',403);
 if(own(x,'discount_bps'))out.discount_bps=integer(x.discount_bps,10000);
 if(own(x,'min_order_cents'))out.min_order_cents=integer(x.min_order_cents,100000000000);
 if(own(x,'contacts'))out.contacts=array(x.contacts,'İletişim',v=>{const r=record(v,{name:160,role:100,phone:50,email:200});email(r.email);if(!r.name&&!r.phone&&!r.email)fail('İletişim bilgisini doldurun.');return r;});
 if(own(x,'addresses'))out.addresses=array(x.addresses,'Adres',v=>{const r=record(v,{label:100,address:1200});if(!r.address)fail('Adresi doldurun.');return r;},10);
 if(own(x,'banks'))out.banks=array(x.banks,'Banka',bank,10);
 if(own(x,'tags'))out.tags=[...new Set(array(x.tags,'Etiket',v=>{const t=text(v,50);if(!t)fail('Etiket boş olamaz.');return t;}))];
 if(own(x,'responsible_staff_id'))out.responsible_staff_id=x.responsible_staff_id===null?null:key(x.responsible_staff_id);
 return out;
}
function staffClause(ns){return `active=1 AND ${ns}_access IN ('read','write') AND (permissions_json IS NULL OR EXISTS(SELECT 1 FROM json_each(permissions_json,'$.${ns}') j WHERE j.value IN ('read','write') AND j.key!='amounts'))`;}
async function profileRead(db,root,ns,id,amounts){const p=expose(await first(db,'SELECT * FROM party_profiles WHERE party_id=?',[id]));p.responsible_staff=p.responsible_staff_id?await first(root,`SELECT id,name FROM staff_users WHERE id=? AND ${staffClause(ns)}`,[p.responsible_staff_id]):null;p.responsible_unavailable=!!p.responsible_staff_id&&!p.responsible_staff;if(!amounts){p.banks=null;p.discount_bps=null;p.min_order_cents=null;}return p;}
async function saveProfile(db,root,ns,id,x,user,amounts){
 revision(x.expected_revision);const previous=expose(await first(db,'SELECT * FROM party_profiles WHERE party_id=?',[id]));if(previous.revision!==x.expected_revision)conflict();
 const p=patchProfile(x,previous,amounts);
 if(p.responsible_staff_id&&!await first(root,`SELECT id FROM staff_users WHERE id=? AND ${staffClause(ns)}`,[p.responsible_staff_id]))fail('Sorumlu kişi bu çalışma alanında etkin olmalı.');
 const values=columns.map(c=>c.endsWith('_json')?JSON.stringify(p[c.slice(0,-5)]):p[c]);
 let result;
 if(x.expected_revision===0)result=await first(db,`INSERT INTO party_profiles(party_id,${columns.join(',')},updated_by) VALUES(?,${columns.map(()=>'?').join(',')},?) ON CONFLICT(party_id) DO NOTHING RETURNING revision`,[id,...values,user.id||'owner']);
 else result=await first(db,`UPDATE party_profiles SET ${columns.map(c=>c+'=?').join(',')},revision=revision+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE party_id=? AND revision=? RETURNING revision`,[...values,user.id||'owner',id,x.expected_revision]);
 if(!result)conflict();return {id,revision:result.revision};
}
async function summary(db,id,invoiceAccess,amounts,ns){
 const ledger=await first(db,`WITH entries AS(SELECT e.*,ABS(e.amount_cents)-${allocated('e')} remaining_cents,COALESCE(${planned('e')},e.due_on) payable_on FROM party_entries e WHERE e.party_id=? AND ${live('e')})
 SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM party_entries WHERE party_id=?) balance_cents,
 COALESCE(SUM(iif(amount_cents<0,remaining_cents,0)),0) open_payable_cents,COALESCE(SUM(iif(amount_cents>0,remaining_cents,0)),0) open_receivable_cents,
 COALESCE(SUM(iif(amount_cents<0 AND payable_on<?,remaining_cents,0)),0) overdue_cents,
 MIN(iif(amount_cents<0 AND remaining_cents>0,payable_on,NULL)) next_due_on,COUNT(*) active_entry_count FROM entries`,[id,id,today()]);
 const cheques=await first(db,`SELECT COUNT(*) pending_count,COALESCE(SUM(e.amount_cents),0) pending_cents FROM party_entries e JOIN party_payment_methods m ON m.entry_id=e.id WHERE e.party_id=? AND m.method='cek' AND ${live('e')} AND NOT ${cashPaid('e')}`,[id]);
 const last=await first(db,`SELECT e.id,e.occurred_on,e.amount_cents,m.method,m.due_on FROM party_entries e LEFT JOIN party_payment_methods m ON m.entry_id=e.id WHERE e.party_id=? AND e.amount_cents>0 AND ${live('e')} AND ${payment('e')} ORDER BY e.occurred_on DESC,e.created_at DESC,e.id DESC LIMIT 1`,[id]);
 const invoices=invoiceAccess?await first(db,`SELECT COUNT(*) total_count,SUM(iif(i.status='posted',1,0)) posted_count,MAX(iif(i.status='posted',i.invoice_date,NULL)) last_invoice_on FROM purchase_invoices i WHERE i.supplier_id=?`,[id]):null;
 const reminders=amounts?await first(db,"SELECT COUNT(*) pending_count,MIN(remind_on) next_on FROM party_profile_notes WHERE party_id=? AND status='open' AND remind_on IS NOT NULL",[id]):null;
 return {ledger,cheques,last_payment:last,invoices,reminders,provisional_supported:ns==='ec'&&invoiceAccess};
}
async function invoices(db,id,url){return paged(db,`SELECT i.id,i.invoice_no,i.invoice_date,i.status,
 (SELECT SUM(l.net_cents+l.tax_cents) FROM purchase_lines l WHERE l.invoice_id=i.id) total_cents,
 e.id entry_id,e.due_on,${planned('e')} planned_on,
 iif(${live('e')},-e.amount_cents,NULL) ledger_debt_cents,
 iif(${live('e')},${allocated('e')},NULL) settled_cents,
 iif(${live('e')},-e.amount_cents-${allocated('e')},NULL) remaining_cents
 FROM purchase_invoices i LEFT JOIN party_entries e ON e.source_key='invoice:'||i.id AND e.party_id=i.supplier_id
 WHERE i.supplier_id=? ORDER BY i.invoice_date DESC,i.id DESC`,[id],url);}
async function payments(db,id,url,invoiceAccess,amounts){
 const result=await paged(db,`SELECT e.id,e.occurred_on,e.amount_cents,e.reference,m.method,m.due_on,m.note,${cashPaid('e')} cash_recorded,
 ABS(e.amount_cents)-${allocated('e')} unallocated_cents FROM party_entries e LEFT JOIN party_payment_methods m ON m.entry_id=e.id
 WHERE e.party_id=? AND ${live('e')} AND ${payment('e')} ORDER BY e.occurred_on DESC,e.created_at DESC,e.id DESC`,[id],url);
 for(const row of result.rows){if(!amounts)row.note=null;row.closed_invoices=invoiceAccess?await all(db,`SELECT i.id,i.invoice_no,a.amount_cents FROM payment_allocations a JOIN party_entries n ON n.id=a.negative_entry_id JOIN purchase_invoices i ON n.source_key='invoice:'||i.id AND i.supplier_id=n.party_id WHERE a.positive_entry_id=? AND n.party_id=? AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id) ORDER BY i.invoice_date,i.id`,[row.id,id]):null;}
 return result;
}
async function products(db,id,url){const result=await paged(db,`SELECT l.id,l.product_id,p.name product_name,p.stock_unit,l.description,l.quantity_milli,l.invoice_quantity,l.invoice_unit,l.net_cents,l.tax_cents,i.id invoice_id,i.invoice_no,i.invoice_date FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id LEFT JOIN products p ON p.id=l.product_id WHERE i.supplier_id=? AND i.status='posted' AND l.line_type='product' ORDER BY i.invoice_date DESC,i.id DESC,l.id`,[id],url);
 for(const r of result.rows){r.unit_net_cents=r.quantity_milli>0?Number((BigInt(r.net_cents)*2000n+BigInt(r.quantity_milli))/(2n*BigInt(r.quantity_milli))):null;r.unit_gross_cents=r.quantity_milli>0?Number((BigInt(r.net_cents+r.tax_cents)*2000n+BigInt(r.quantity_milli))/(2n*BigInt(r.quantity_milli))):null;}
 return result;
}
async function provisional(db,id,url,ns){if(ns!=='ec')return {supported:false,rows:[],page:1,has_more:false};const selection=await paged(db,'SELECT entry_id FROM provisional_receipts WHERE supplier_id=? ORDER BY occurred_on DESC,id DESC',[id],url);return {...selection,supported:true,rows:selection.rows.length?await provisionalReceipts(db,{entryIds:selection.rows.map(r=>r.entry_id),limit:50}):[]};}

export const PARTY_FILE_CHUNK_BYTES=32768;
export const PARTY_FILE_MAX_BYTES=5*1024*1024;
const fileColumns='id,party_id,revision,filename,mime,size_bytes,sha256,chunk_count,state,created_at,sealed_at';
export async function partyFileDigest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function unbase64(value){if(typeof value!=='string'||value.length>43692||!value.length||value.length%4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('Dosya parçası geçersiz.');const binary=atob(value);if(btoa(binary)!==value)fail('Dosya parçası geçersiz.');return Uint8Array.from(binary,c=>c.charCodeAt(0));}
function signature(bytes,mime){return mime==='application/pdf'?new TextDecoder().decode(bytes.slice(0,5))==='%PDF-':mime==='image/png'?[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b):bytes[0]===255&&bytes[1]===216&&bytes[2]===255;}
async function fileAction(request,db,id,fileId,action,x,url,user){
 if(!fileId&&request.method==='GET')return paged(db,`SELECT ${fileColumns} FROM party_profile_files WHERE party_id=? ORDER BY created_at DESC,id DESC`,[id],url);
 if(!fileId&&request.method==='POST'){
  if(Object.keys(x).some(k=>!['filename','mime','size_bytes','sha256','chunk_count'].includes(k)))fail('Bilinmeyen dosya alanı.');
  const filename=text(x.filename,160);if(!filename||/[\\/\u0000-\u001f]/.test(filename))fail('Dosya adını kontrol edin.');
  if(!['application/pdf','image/png','image/jpeg'].includes(x.mime))fail('Yalnız PDF, PNG ve JPEG dosyaları yüklenebilir.');if(!({ 'application/pdf':/\.pdf$/i,'image/png':/\.png$/i,'image/jpeg':/\.jpe?g$/i }[x.mime]).test(filename))fail('Dosya uzantısı seçilen türle uyuşmuyor.');
  if(integer(x.size_bytes,PARTY_FILE_MAX_BYTES)===null||x.size_bytes<1||x.chunk_count!==Math.ceil(x.size_bytes/PARTY_FILE_CHUNK_BYTES)||typeof x.sha256!=='string'||! /^[0-9a-f]{64}$/.test(x.sha256))fail('Dosya boyutu veya özeti geçersiz.');
  const existing=await first(db,'SELECT '+fileColumns+' FROM party_profile_files WHERE party_id=? AND sha256=?',[id,x.sha256]);
  const saved=existing?null:await first(db,`INSERT INTO party_profile_files(id,party_id,filename,mime,size_bytes,sha256,chunk_count,created_by) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(party_id,sha256) DO NOTHING RETURNING ${fileColumns}`,[crypto.randomUUID(),id,filename,x.mime,x.size_bytes,x.sha256,x.chunk_count,user.id||'owner']);
  const f=saved||existing||await first(db,`SELECT ${fileColumns} FROM party_profile_files WHERE party_id=? AND sha256=?`,[id,x.sha256]);
  if(f.mime!==x.mime||f.size_bytes!==x.size_bytes||f.chunk_count!==x.chunk_count)conflict();
  return {...f,existing:!saved,uploaded_indices:(await all(db,'SELECT idx FROM party_profile_file_chunks WHERE file_id=? ORDER BY idx',[f.id])).map(r=>r.idx)};
 }
 const f=await first(db,`SELECT ${fileColumns} FROM party_profile_files WHERE id=? AND party_id=?`,[fileId,id]);if(!f)fail('Dosya bu caride bulunamadı.',404);
 if(action==='part'&&request.method==='GET'){
  if(f.state!=='sealed')fail('Dosya yüklemesi tamamlanmadı.',409);const index=Number(url.searchParams.get('index'));if(!url.searchParams.has('index')||!Number.isInteger(index)||index<0||index>=f.chunk_count)fail('Parça sırası geçersiz.');
  const chunk=await first(db,'SELECT data_b64 FROM party_profile_file_chunks WHERE file_id=? AND idx=?',[f.id,index]);if(!chunk)fail('Dosya parçası bulunamadı.',404);return {index,data:chunk.data_b64,mime:f.mime,filename:f.filename,chunk_count:f.chunk_count,size_bytes:f.size_bytes,sha256:f.sha256};
 }
 if(request.method!=='POST'||!['chunk','seal'].includes(action))fail('İstek bulunamadı.',404);
 if(revision(x.expected_revision)!==f.revision)conflict();if(f.state!=='uploading')fail('Tamamlanan dosya değiştirilemez.',409);
 if(action==='chunk'){
  if(!Number.isInteger(x.index)||x.index<0||x.index>=f.chunk_count)fail('Parça sırası geçersiz.');const bytes=unbase64(x.data);
  const expected=x.index===f.chunk_count-1?f.size_bytes-PARTY_FILE_CHUNK_BYTES*x.index:PARTY_FILE_CHUNK_BYTES;if(bytes.length!==expected)fail('Dosya parçasının boyutu yanlış.');
  const previous=await first(db,'SELECT data_b64 FROM party_profile_file_chunks WHERE file_id=? AND idx=?',[f.id,x.index]);if(previous){if(previous.data_b64!==x.data)conflict();return {id:f.id,revision:f.revision,existing:true};}
  const token=crypto.randomUUID();const result=await db.batch([
   db.prepare("UPDATE party_profile_files SET revision=revision+1,write_token=? WHERE id=? AND party_id=? AND revision=? AND state='uploading' RETURNING revision").bind(token,f.id,id,x.expected_revision),
   db.prepare('INSERT INTO party_profile_file_chunks(file_id,idx,data_b64) SELECT id,?,? FROM party_profile_files WHERE id=? AND write_token=?').bind(x.index,x.data,f.id,token)
  ]);if(!result[0].results?.length)conflict();return {id:f.id,revision:result[0].results[0].revision};
 }
 const chunks=await all(db,'SELECT idx,data_b64 FROM party_profile_file_chunks WHERE file_id=? ORDER BY idx',[f.id]);if(chunks.length!==f.chunk_count||chunks.some((c,i)=>c.idx!==i))fail('Dosya parçaları eksik.',409);
 const bytes=new Uint8Array(f.size_bytes);let offset=0;for(const c of chunks){const part=unbase64(c.data_b64);if(offset+part.length>bytes.length)fail('Dosya boyutu uyuşmuyor.',409);bytes.set(part,offset);offset+=part.length;}
 if(offset!==f.size_bytes||await partyFileDigest(bytes)!==f.sha256)fail('Dosyanın özeti uyuşmuyor.',409);if(!signature(bytes,f.mime))fail('Dosya içeriği seçilen türle uyuşmuyor.');
 const saved=await first(db,"UPDATE party_profile_files SET revision=revision+1,state='sealed',sealed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),write_token=NULL WHERE id=? AND party_id=? AND revision=? AND state='uploading' RETURNING revision",[f.id,id,x.expected_revision]);if(!saved)conflict();return {id:f.id,revision:saved.revision,state:'sealed'};
}

/** Authenticated worker supplies fixed WORKSPACE, scoped DB, ROOT_DB and USER. No money writes. */
export async function partyProfileApi(request,env,path,readBody){
 if(path!=='/api/party-profiles'&&!path.startsWith('/api/party-profiles/'))return null;
 const ns=env.WORKSPACE,user=env.USER;if(!['ec','lp'].includes(ns)||!user)fail('Çalışma alanı veya oturum geçersiz.',403);
 const write=request.method!=='GET';if(!can(user,ns,'ledger',write))fail('Cari bilgileri için yetkiniz yok.',403);
 const db=profileDB(env.DB,ns),root=env.ROOT_DB||env.DB,url=new URL(request.url),amounts=can(user,ns,'amounts'),invoiceAccess=can(user,ns,ns==='ec'?'invoices':'accounts');
 const safe=value=>scrubAmounts(value,user,ns);
 if(path==='/api/party-profiles/staff'&&request.method==='GET')return {rows:await all(root,`SELECT id,name FROM staff_users WHERE ${staffClause(ns)} ORDER BY name,id LIMIT 500`)};
 const match=path.match(/^\/api\/party-profiles\/([-\w:.]{1,120})(?:\/(invoices|payments|products|provisional|notes|attachments)(?:\/([-\w:.]{1,120})(?:\/(chunk|seal|part))?)?)?$/);if(!match)fail('İstek bulunamadı.',404);
 const [,id,section,item,action]=match;
 const party=await first(db,'SELECT id,name,tax_id,kind,contact,phone,email,address,archived_at FROM suppliers WHERE id=?',[id]);if(!party)fail('Cari bu çalışma alanında bulunamadı.',404);
 if(write&&party.archived_at)fail('Bu cari arşivde; önce cari listesinden geri alın.',409);
 if(['invoices','products','provisional'].includes(section)&&!invoiceAccess)fail('Alış bilgileri için yetkiniz yok.',403);
 if(['notes','attachments'].includes(section)&&!amounts)fail('Not ve dosyalar için tutar yetkisi gerekli.',403);
 let x=write?object(await readBody(request)):null;
 try{
  if(!section&&request.method==='GET')return safe({workspace:ns,party,profile:await profileRead(db,root,ns,id,amounts),summary:await summary(db,id,invoiceAccess,amounts,ns),capabilities:{write:can(user,ns,'ledger',true),amounts,invoices:invoiceAccess,invoice_write:can(user,ns,ns==='ec'?'invoices':'accounts',true),documents:amounts},as_of:new Date().toISOString()});
  if(!section&&request.method==='POST')return await saveProfile(db,root,ns,id,x,user,amounts);
  if(!item&&request.method==='GET'){
   if(section==='invoices')return safe(await invoices(db,id,url));
   if(section==='payments')return safe(await payments(db,id,url,invoiceAccess,amounts));
   if(section==='products')return safe(await products(db,id,url));
   if(section==='provisional'){const data=await provisional(db,id,url,ns);if(!amounts)data.rows=data.rows.map(({notes,...row})=>({...row,notes:null}));return safe(data);}
   if(section==='notes')return paged(db,'SELECT id,revision,body,remind_on,status,created_at,updated_at FROM party_profile_notes WHERE party_id=? ORDER BY created_at DESC,id DESC',[id],url);
  }
  if(section==='notes'&&request.method==='POST'&&!action){
   if(Object.keys(x).some(k=>!['expected_revision','body','remind_on','status','id'].includes(k)))fail('Bilinmeyen not alanı.');
   const prev=item?await first(db,'SELECT * FROM party_profile_notes WHERE id=? AND party_id=?',[item,id]):null;if(item&&!prev)fail('Not bu caride bulunamadı.',404);
   if(revision(x.expected_revision)!==(prev?.revision||0))conflict();
   const body=own(x,'body')?text(x.body,4000):prev?.body;if(!body)fail('Notu doldurun.');const remind=own(x,'remind_on')?day(x.remind_on):prev?.remind_on||null,status=x.status??prev?.status??'open';if(!['open','done'].includes(status))fail('Not durumu geçersiz.');
   const noteId=item||(x.id?key(x.id):crypto.randomUUID());
   const saved=item?await first(db,"UPDATE party_profile_notes SET body=?,remind_on=?,status=?,revision=revision+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND party_id=? AND revision=? RETURNING id,revision",[body,remind,status,user.id||'owner',noteId,id,x.expected_revision]):await first(db,'INSERT INTO party_profile_notes(id,party_id,body,remind_on,status,created_by,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id,revision',[noteId,id,body,remind,status,user.id||'owner',user.id||'owner']);
   if(!saved)conflict();return saved;
  }
  if(section==='attachments')return await fileAction(request,db,id,item,action,x,url,user);
  fail('İstek bulunamadı.',404);
 }catch(e){if(e.status)throw e;if(/PROFILE_STAFF_ACCESS/.test(e.message))fail('Sorumlu kişinin çalışma alanı yetkisi değişti.',409);if(/PROFILE_FILE_LIMIT/.test(e.message))fail('Bu cari için dosya sınırı doldu (100 dosya / 50 MB).',409);if(/PROFILE_CONFLICT|PROFILE_FILE_LOCKED|UNIQUE constraint/.test(e.message))conflict();throw e;}
}
