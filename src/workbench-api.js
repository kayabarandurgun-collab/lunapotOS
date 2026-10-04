import {can, modules} from '../public/permissions.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const validKey = value => /^[a-z_]+:[\w-]{1,100}$/.test(value || '');
const dateValue = (value, label) => {
 if (value === null || value === '') return null;
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) fail(label + ' geçersiz.');
 return value;
};
const cleanText = (value, max, label, required = false) => {
 if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(label + ' alanını kontrol edin.');
 return value.trim();
};
export const workbenchFeatures = (user, ns, write = false) => Object.keys(modules[ns] || {}).filter(k => k !== 'amounts' && can(user, ns, k, write));
const allowed = (user, ns, feature, write = false) => feature !== 'amounts' && !!modules[ns]?.[feature] && can(user, ns, feature, write);
const action = (type, label, href, extra = {}) => ({type, label, href, ...extra});

// Each source includes both active and inactive records: a capped list never "resolves" a task.
function sources(ns) {
 const invoices = ns === 'ec' ? 'invoices' : 'accounts';
 const invoiceHref = row => '#' + (ns === 'ec' ? 'invoices' : 'accounts') + '?q=' + encodeURIComponent(row.label);
 const specs = {
  invoice_document: {feature:invoices,title:'Yüklenen belgeyi tamamla',detail:'Belge saklandı; fatura kaydına henüz bağlanmadı. Özgün dosyadan kaldığın işleme dön.',
   sql:"SELECT *,invoice_id IS NULL AND (linked_count=0 OR expected_count IS NULL OR linked_count<expected_count) AND (status='stored' OR status='receiving' AND occurred_on<datetime('now','-1 hour')) active FROM (SELECT d.id,d.filename label,d.created_at occurred_on,d.status,d.invoice_id,NULLIF(json_array_length(d.extracted_json,'$.invoices'),0) expected_count,(SELECT COUNT(*) FROM purchase_document_pages p WHERE p.document_id=d.id) linked_count FROM purchase_documents d)",
   table:'purchase_documents',action:row=>row.linked_count>0?action('link','Bağlı faturaları kontrol et',ns==='ec'?'#documents':'#accounts',{id:row.id}):action(row.status==='receiving'?'invoice_upload':'invoice_document',row.status==='receiving'?'Aynı belgeyi seç':'Saklanan belgeyi aç','#intake',{id:row.id,status:row.status})},
  invoice_draft: {feature: invoices, title: 'Alış faturasını kontrol et', detail: 'Belge, ürün eşleşmeleri ve tutarları incele; kayıtlı fatura üzerinden tamamla.',
   sql: "SELECT id,invoice_no label,invoice_date occurred_on,status='draft' active FROM purchase_invoices",
   table: 'purchase_invoices', action: row => action('invoice', 'Faturayı incele', invoiceHref(row), {id:row.id, invoice_no:row.label})},
  invoice_receipt: {feature: invoices, title: 'Mal teslimini tamamla', detail: 'Muhasebeleşmiş faturanın henüz teslim alınmayan miktarını kontrol et.',
   sql: "SELECT i.id,i.invoice_no label,i.invoice_date occurred_on,i.status='posted' AND EXISTS(SELECT 1 FROM purchase_lines l WHERE l.invoice_id=i.id AND l.line_type='product' AND l.quantity_milli-COALESCE((SELECT cancelled_milli FROM purchase_line_limits WHERE id=l.id),0)>COALESCE((SELECT SUM(g.quantity_milli) FROM effective_receipts g WHERE g.line_id=l.id),0)) active FROM purchase_invoices i",
   table: 'purchase_invoices', action: row => action('invoice', 'Teslimatı incele', invoiceHref(row), {id:row.id, invoice_no:row.label})}
 };
 if(ns==='lp')specs.invoice_receipt.sql=specs.invoice_receipt.sql.replace('COALESCE((SELECT cancelled_milli FROM purchase_line_limits WHERE id=l.id),0)','0').replaceAll('effective_receipts','goods_receipts');
 if (ns === 'ec') Object.assign(specs, {
  report_file: {feature:'orders', title:'Rapor işlemini tamamla', detail:'Yarım kalan dosyayı yeniden seç veya alınmış raporun işleme durumunu kontrol et.',
   sql:"SELECT id,filename label,created_at occurred_on,status,((status='receiving' AND created_at<datetime('now','-1 hour')) OR status IN ('received','applying')) active FROM ec_report_files",
   table:'ec_report_files', action:row=>action(row.status==='receiving'?'report_upload':'report_file',row.status==='receiving'?'Aynı dosyayı seç':'Raporu kontrol et','#reports',{id:row.id,status:row.status})},
  report_review: {feature:'orders',title:'Rapor satırını incele',detail:'Kaynak satırdaki belirsizliği mevcut inceleme ekranında çöz.',
   sql:"SELECT r.id,f.filename||' · Satır '||r.row_no label,r.created_at occurred_on,r.reason,r.status='open' active FROM ec_report_reviews r JOIN ec_report_files f ON f.id=r.file_id",
   table:'ec_report_reviews',action:row=>action('report_review','Satırı incele','#reports',{id:row.id})},
  order_mapping: {feature:'orders',title:'Sipariş ürünlerini eşleştir',detail:'Paketteki her satırı gerçek stok ürününe veya kayıtlı sete bağla.',
   sql:"SELECT p.id,p.order_no||' · '||p.external_id label,p.occurred_on,p.status='draft' AND (NOT EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=p.id) OR EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=p.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM order_line_components c WHERE c.line_id=l.id)!=10000)) active FROM order_packages p",
   table:'order_packages',action:row=>action('link','Paketi eşleştir','#orders?ac='+encodeURIComponent(row.id)+'&watch=unmapped')},
  order_amounts: {feature:'orders',title:'Sipariş tutarlarını tamamla',detail:'Boş tutar sıfır sayılmaz. KDV ve net satış tutarını kaynak belgeyle kontrol et.',
   sql:"SELECT p.id,p.order_no||' · '||p.external_id label,p.occurred_on,p.status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=p.id AND (l.net_revenue_cents IS NULL OR l.gross_cents IS NULL OR l.vat_bps IS NULL)) active FROM order_packages p",
   table:'order_packages',action:row=>action('link','Paket tutarlarını aç','#orders?ac='+encodeURIComponent(row.id)+'&watch=missing_amounts')},
  order_changed: {feature:'orders',title:'Değişen siparişi karşılaştır',detail:'Kaynak değişikliği çözülmeden yeni stok işlemi yapılmaz.',
   sql:"SELECT id,order_no||' · '||external_id label,occurred_on,source_changed=1 AND status!='cancelled' active FROM order_packages",
   table:'order_packages',action:row=>action('link','Kaynak kaydını aç','#orders?ac='+encodeURIComponent(row.id)+'&watch=source_changed')}
 });
 return specs;
}
function sourceTask(kind, spec, row) {
 return {task_key:kind+':'+row.id, source_kind:kind, source_id:row.id, feature:spec.feature,
  title:kind==='invoice_document'&&row.linked_count>0?'Birleşik belgedeki faturaları kontrol et':spec.title, source_label:row.label, detail:kind==='invoice_document'&&row.linked_count>0?(row.expected_count===null?'Fatura sayısı doğrulanamadı; sayfa bağlantılarını kontrol et.':row.expected_count+' faturadan '+row.linked_count+' tanesi bağlı. Kalan faturaların kaydını ve belge bağlantılarını kontrol et.'):spec.detail, source_active:row.active===1, source_known:true,
  occurred_on:row.occurred_on, action:spec.action(row)};
}
function present(task, user, ns, day) {
 const isSource=task.source_kind!=='custom', unavailable=isSource&&!task.source_known;
 const canEmbed=allowed(user,ns,task.feature,true)&&can(user,ns,'amounts');
 const effective_status=unavailable?'unavailable':isSource&&!task.source_active?'resolved':task.snooze_until&&task.snooze_until>day?'snoozed':task.status||'open';
 return {...task, action:!canEmbed&&task.action?.href==='#intake'?null:task.action, effective_status, can_write:allowed(user,ns,task.feature,true), can_embed:canEmbed,
  overdue:!!task.due_on&&task.due_on<day&&!['done','resolved','snoozed','unavailable'].includes(effective_status)};
}
async function resolveTask(env, key, saved, specs) {
 if (saved?.source_kind==='custom') return {...saved,source_active:null,source_known:true,action:null};
 const split=key.indexOf(':'),kind=key.slice(0,split),sourceId=key.slice(split+1),spec=specs[kind];
 if (!spec) return null;
 const row=await env.DB.prepare('SELECT * FROM ('+spec.sql+') WHERE id=?').bind(sourceId).first();
 if (!row && !saved) return null;
 return {...(saved||{task_key:key,source_kind:kind,source_id:sourceId,feature:spec.feature,title:spec.title,notes:'',version:0,status:'open',due_on:null,assignee_id:null,assignee_name:null,snooze_until:null}),
  ...(row?sourceTask(kind,spec,row):{source_known:false,source_active:null,action:null})};
}
async function staffDirectory(env, ns, reader) {
 const rows=(await env.ROOT_DB.prepare("SELECT id,name,ec_access,lp_access,permissions_json FROM staff_users WHERE active=1 ORDER BY name,id").all()).results;
 const readerFeatures=workbenchFeatures(reader,ns);
 return rows.map(row=>({id:row.id,name:row.name,features:readerFeatures.filter(feature=>allowed({...row,permissions:parse(row.permissions_json)},ns,feature))})).filter(row=>row.features.length);
}
async function list(env, ns, user, specs, tasksTable, day) {
 const visible=workbenchFeatures(user,ns);
 const selected=Object.entries(specs).filter(([,s])=>visible.includes(s.feature));
 const result=await env.DB.batch([
  env.DB.prepare('SELECT * FROM '+tasksTable+' WHERE feature IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC,task_key LIMIT 1001').bind(JSON.stringify(visible)),
  ...selected.flatMap(([,s])=>[
   env.DB.prepare('SELECT * FROM ('+s.sql+') WHERE active=1 ORDER BY occurred_on,id LIMIT 201'),
   env.DB.prepare('SELECT COUNT(*) count FROM ('+s.sql+') WHERE active=1')])
 ]);
 const saved=result[0].results.slice(0,1000), byKey=new Map(), source_counts={};
 let limited=result[0].results.length>1000;
 for(let i=0;i<selected.length;i++){
  const [kind,spec]=selected[i],rows=result[1+i*2].results;
  source_counts[kind]=result[2+i*2].results[0].count;
  if(rows.length>200)limited=true;
  for(const row of rows.slice(0,200)){
   const task=sourceTask(kind,spec,row);
   byKey.set(task.task_key,{...task,notes:'',version:0,status:'open',due_on:null,assignee_id:null,assignee_name:null,snooze_until:null});
  }
 }
 // Saved sources outside the first source page are checked by identity, never inferred closed.
 const missing=saved.filter(t=>t.source_kind!=='custom'&&!byKey.has(t.task_key)&&specs[t.source_kind]);
 if(missing.length){
  const groups=Object.entries(specs).map(([kind,spec])=>({kind,spec,tasks:missing.filter(t=>t.source_kind===kind)})).filter(g=>g.tasks.length);
  const found=await env.DB.batch(groups.map(g=>env.DB.prepare('SELECT * FROM ('+g.spec.sql+') WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(g.tasks.map(t=>t.source_id)))));
  groups.forEach((group,i)=>{
   const rows=new Map(found[i].results.map(row=>[row.id,row]));
   for(const t of group.tasks){const row=rows.get(t.source_id);byKey.set(t.task_key,{...t,...(row?sourceTask(t.source_kind,group.spec,row):{source_known:false,source_active:null,action:null})});}
  });
 }
 for(const t of saved){
  const source=byKey.get(t.task_key);
  byKey.set(t.task_key,t.source_kind==='custom'?{...t,source_known:true,source_active:null,action:null}:{...t,...source,notes:t.notes,version:t.version,status:t.status,due_on:t.due_on,assignee_id:t.assignee_id,assignee_name:t.assignee_name,snooze_until:t.snooze_until});
 }
 const tasks=[...byKey.values()].map(t=>present(t,user,ns,day)).sort((a,b)=>
  Number(b.overdue)-Number(a.overdue)||(a.due_on||'9999').localeCompare(b.due_on||'9999')||a.task_key.localeCompare(b.task_key));
 return {as_of:day,namespace:ns,tasks,source_counts,limited,limit_notice:limited?'Her kaynak için ilk 200 açık iş ve son 1000 kayıtlı görev gösteriliyor. Tüm kayıtlar ilgili kaynak ekranında.':null,
  features:visible.map(key=>({key,label:modules[ns][key][0],write:allowed(user,ns,key,true)}))};
}

/** Canonical scoped handler. USER must come from the authenticated worker, never the request body. */
export async function workbenchApi(request, env, path, body = () => request.json()) {
 if(path!=='/api/workbench'&&!path.startsWith('/api/workbench/'))return null;
 const ns=env.WORKSPACE,user=env.USER;
 if(!['ec','lp'].includes(ns)||!user||!workbenchFeatures(user,ns).length)fail('Bu çalışma alanına erişiminiz yok.',403);
 const db=env.DB,tasksTable=ns+'_workbench_tasks',auditTable=ns+'_workbench_task_audit',day=today(),specs=sources(ns);
 const sub=path.slice('/api/workbench'.length),method=request.method;
 if(sub===''&&method==='GET')return list(env,ns,user,specs,tasksTable,day);
 if(sub==='/staff'&&method==='GET')return {staff:await staffDirectory(env,ns,user)};
 const match=sub.match(/^\/tasks\/([^/]+)(\/audit)?$/);
 if(match){
  let key;try{key=decodeURIComponent(match[1]);}catch{fail('Görev seçimi geçersiz.');}
  if(!validKey(key))fail('Görev seçimi geçersiz.');
  const saved=await db.prepare('SELECT * FROM '+tasksTable+' WHERE task_key=?').bind(key).first();
  const feature=saved?.feature||specs[key.split(':')[0]]?.feature;
  if(!feature||!allowed(user,ns,feature))fail('Görev bulunamadı.',404);
  const task=await resolveTask(env,key,saved,specs);
  if(!task)fail('Görev bulunamadı.',404);
  if(match[2]&&method==='GET')return {task_key:key,audit:(await db.prepare('SELECT version,actor_id,actor_name,snapshot_json,created_at FROM '+auditTable+' WHERE task_key=? ORDER BY version DESC LIMIT 100').bind(key).all()).results.map(r=>({...r,snapshot:parse(r.snapshot_json),snapshot_json:undefined}))};
  if(!match[2]&&['POST','PATCH'].includes(method)){
   if(!allowed(user,ns,feature,true))fail('Bu iş için işlem yapma yetkisi gerekir.',403);
   const input=await body(request);
   if(!input||typeof input!=='object'||Array.isArray(input))fail('Görev bilgisi geçersiz.');
   if(!Number.isSafeInteger(input.version)||input.version!==(saved?.version||0))fail('Bu görev başka bir ekranda değişti. Listeyi yenileyin.',409);
   if(task.source_kind!=='custom'&&(!task.source_known||!task.source_active))fail('Kaynak iş artık açık değil. Listeyi yenileyin.',409);
   const next=await changes(input,task,env,ns,user,day);
   return persist(next,saved,env,ns,tasksTable,user,specs,day);
  }
 }
 if(sub==='/tasks'&&method==='POST'){
  const input=await body(request);
  if(!input||typeof input!=='object'||Array.isArray(input)||!allowed(user,ns,input.feature,true))fail('Bu bölümde görev oluşturma yetkiniz yok.',403);
  if(input.version!==0)fail('Yeni görev sürümü 0 olmalıdır.',409);
  const sourceId=crypto.randomUUID(),task={task_key:'custom:'+sourceId,source_kind:'custom',source_id:sourceId,feature:input.feature,
   title:cleanText(input.title,180,'Görev adı',true),notes:'',status:'open',assignee_id:null,assignee_name:null,due_on:null,snooze_until:null,version:0};
  const next=await changes(input,task,env,ns,user,day);
  return persist(next,null,env,ns,tasksTable,user,specs,day);
 }
 fail('İşlem bulunamadı.',404);
}
async function changes(input, task, env, ns, user, day) {
 const accepted=new Set(['version','feature','title','notes','status','assignee_id','due_on','snooze_until']);
 if(Object.keys(input).some(k=>!accepted.has(k)))fail('Bilinmeyen görev alanı.');
 if(input.feature!==undefined&&input.feature!==task.feature)fail('Görev bölümü değiştirilemez.');
 const next={...task};
 if(input.title!==undefined){if(task.source_kind!=='custom')fail('Kaynak işin adı kayıttan gelir.');next.title=cleanText(input.title,180,'Görev adı',true);}
 if(input.notes!==undefined)next.notes=cleanText(input.notes,2000,'Not');
 if(input.status!==undefined){
  if(!['open','in_progress','done'].includes(input.status))fail('Görev durumu geçersiz.');
  if(input.status==='done'&&task.source_kind!=='custom')fail('Kaynak hata çözülmeden görev tamamlanamaz. Kaydı düzeltin veya açıkça erteleyin.',409);
  next.status=input.status;
 }
 if(input.due_on!==undefined)next.due_on=dateValue(input.due_on,'Tarih');
 if(input.snooze_until!==undefined){
  next.snooze_until=dateValue(input.snooze_until,'Erteleme tarihi');
  if(next.snooze_until&&next.snooze_until<=day)fail('Erteleme tarihi bugünden sonra olmalıdır.');
 }
 if(next.status==='done')next.snooze_until=null;
 if(input.assignee_id!==undefined){
  if(input.assignee_id===null||input.assignee_id===''){next.assignee_id=null;next.assignee_name=null;}
  else{
   const people=await staffDirectory(env,ns,user),person=people.find(p=>p.id===input.assignee_id&&p.features.includes(task.feature));
   if(!person)fail('Bu bölümde yetkili, etkin bir ekip üyesi seçin.');
   next.assignee_id=person.id;next.assignee_name=person.name;
  }
 }
 return next;
}
async function persist(next, saved, env, ns, table, user, specs, day) {
 const actorId=user.id|| (user.owner?'owner':''),actorName=user.name|| (user.owner?'Yönetici':'Ekip üyesi');
 if(!actorId)fail('Oturum kimliği eksik.',403);
 const args=[next.title,next.notes,next.assignee_id,next.assignee_name,next.due_on,next.status,next.snooze_until,actorId,actorName];
 let result;
 try{
  if(saved)result=await env.DB.prepare('UPDATE '+table+' SET title=?,notes=?,assignee_id=?,assignee_name=?,due_on=?,status=?,snooze_until=?,actor_id=?,actor_name=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE task_key=? AND version=? RETURNING *').bind(...args,next.task_key,saved.version).first();
  else result=await env.DB.prepare('INSERT INTO '+table+'(title,notes,assignee_id,assignee_name,due_on,status,snooze_until,actor_id,actor_name,task_key,source_kind,source_id,feature,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(task_key) DO NOTHING RETURNING *').bind(...args,next.task_key,next.source_kind,next.source_id,next.feature).first();
 }catch(error){
  if(/WORKBENCH_VERSION|UNIQUE constraint/.test(error.message))fail('Görev değişti. Listeyi yenileyin.',409);
  throw error;
 }
 if(!result)fail('Görev başka bir ekranda değişti. Listeyi yenileyin.',409);
 return {task:present(await resolveTask(env,next.task_key,result,specs),user,ns,day)};
}

