import {cents} from '../public/accounting-math.js';
import {invoiceDebtStatement} from './accounting.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const id=()=>crypto.randomUUID();
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const text=(x,label,max=500)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail(label+' alanını kontrol edin.');return x.trim();};
const optional=(x,max=500)=>x===undefined||x===null||x===''?'':text(x,'Bilgi',max);
const day=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x)fail('Geçerli tarih girin.');return x;};
const money=x=>{let n;try{n=cents(x);}catch{fail('Geçerli bir tutar girin.');}if(!Number.isSafeInteger(n)||!n||Math.abs(n)>100000000000)fail('Tutar sıfır olamaz ve sınırı aşamaz.');return n;};
const milliQty=x=>{const n=Math.round(sayi(x)*1000);if(!Number.isFinite(n)||!Number.isSafeInteger(n)||n<=0||n>1000000000)fail('Miktar geçersiz.');return n;};
const sayi=x=>{if(typeof x==='number')return x;if(typeof x!=='string'||!x.trim())return NaN;const n=Number(x.trim().replace(',','.'));return Number.isFinite(n)?n:NaN;};
const costCents=x=>{const v=sayi(x);if(!Number.isFinite(v))fail('Birim maliyeti kontrol edin.');let n;try{n=cents(v);}catch{fail('Birim maliyeti kontrol edin.');}if(!Number.isSafeInteger(n)||n<0||n>100000000000)fail('Birim maliyet geçersiz.');return n;};
const vatBps=x=>{const n=x===undefined||x===null||x===''?2000:Number(x);if(!Number.isSafeInteger(n)||n<0||n>10000)fail('KDV oranı geçersiz.');return n;};
const positive=x=>{const n=money(x);if(n<0)fail('Tutar pozitif olmalı.');return n;};
async function execute(db,items){try{return await db.batch(items);}catch(error){const m=String(error.message);if(/CHEQUE_DUE_REQUIRED/.test(m))fail('Çek için vade tarihi girin.');if(/INVALID_DUE_DATE|INVALID_PLAN_DATE/.test(m))fail('Geçerli tarih girin.');if(/PAYMENT_ENTRY_REQUIRED/.test(m))fail('Ödeme yöntemi yalnızca ödeme hareketine yazılabilir.',409);if(/DEBT_ENTRY_REQUIRED/.test(m))fail('Planlanan ödeme tarihi yalnızca açık borca eklenebilir.',409);if(/OVER_ALLOCATION/.test(m))fail('Kapama tutarı belgenin kalan tutarını aşıyor.',409);if(/ENTRY_ALLOCATED/.test(m))fail('Önce bu hareketin belge kapamalarını geri alın.',409);if(/INVALID_ALLOCATION/.test(m))fail('Aynı cariye ait bir alacak ve bir borç hareketini seçin.',409);if(/REVERSAL|REVERSED_ENTRY/.test(m))fail('Bu hareket için ters kayıt oluşturulamaz.',409);if(/UNIQUE constraint/.test(m))fail('Bu referans veya kayıt daha önce işlendi.',409);if(/FOREIGN KEY/.test(m))fail('Seçilen kayıt bu çalışma alanında bulunamadı.',404);throw error;}}
async function requireParty(db,key){if(!await stmt(db,'SELECT id FROM suppliers WHERE id=?',[key]).first())fail('Cari bu çalışma alanında bulunamadı.',404);}
const entryInsert=(db,e)=>stmt(db,'INSERT INTO party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?)',[e.id,e.party_id,e.amount_cents,e.occurred_on,e.due_on||null,e.reference,e.description,e.source_key,e.source,e.reversal_of||null]);

// Ödeme yöntemleri: hangi bankadan ödendiği DEĞİL, nasıl ödendiği sorulur. Kart/banka ayrıntısı serbest nottur.
const METHODS={nakit:'Nakit',kart:'Kart',havale:'Havale / EFT',cek:'Çek'};
const lira=value=>new Intl.NumberFormat('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value/100)+' TL';
// Hareketin ters kaydı yazılmışsa o hareket artık hesapta değildir; kapama ve ödeme için seçilemez.
const live=alias=>`${alias}.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM party_entries x WHERE x.reversal_of=${alias}.id)`;
const LIVE=live('e');
// "Ödediğim hareket": kasa/banka yoluyla yazılan ya da ödeme yöntemi işaretlenmiş artı hareket.
// Tedarikçi iadesi gibi borcu azaltan başka kayıtlar ödeme sayılmaz.
const PAYMENT=alias=>`${alias}.amount_cents>0 AND (${alias}.source='cash' OR EXISTS(SELECT 1 FROM party_payment_methods m WHERE m.entry_id=${alias}.id))`;
const ALLOCATED=side=>`COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE a.${side}_entry_id=e.id AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)),0)`;
const PLANNED='(SELECT p.planned_on FROM party_entry_plans p WHERE p.entry_id=e.id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)';
const invoiceStatus=row=>row.remaining_cents<=0?'paid':row.paid_cents>0?'partial':'open';
// Açık borçlar eskiden yeniye sıralanır: tutar belirtilip fatura seçilmediğinde en eski borç önce kapanır.
const openDebtSql=`SELECT e.id,e.party_id,e.amount_cents,e.occurred_on,e.reference,e.source_key,${ALLOCATED('negative')} allocated_cents FROM party_entries e WHERE e.party_id=? AND e.amount_cents<0 AND ${LIVE} ORDER BY e.occurred_on,e.created_at,e.rowid LIMIT 2000`;
const remainingOf=row=>-row.amount_cents-row.allocated_cents;
async function digestReference(parts){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(parts.join('|'))));
 return 'ODEME-'+[...bytes.slice(0,12)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

// The caller provides an authenticated, fixed-workspace DB. No external money transfer is performed.
export async function ledgerApi(request,env,path,readBody){
 if(!path.startsWith('/api/ledger'))return null;
 if(!['ec','lp'].includes(env.WORKSPACE))fail('Çalışma alanı geçersiz.',403);
 const db=env.DB,method=request.method;
 if(path==='/api/ledger'&&method==='GET'){
  const url=new URL(request.url),party=url.searchParams.get('party_id');if(party)await requireParty(db,party);
  // Cari hareket araması ve sayfalama sunucudadır; eski kayıtlar 500 sınırının ardında kalmaz.
  // Bakiyeler her zaman tam veriden hesaplanır, filtreden etkilenmez.
  const q=(url.searchParams.get('q')||'').trim(),from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',due=url.searchParams.get('due')||'',page=Number(url.searchParams.get('page')||1);
  // "Yalnızca ödemeler" süzgeci: sunucuda süzülür, yoksa sayfanın dışında kalan ödemeler görünmez.
  const kind=url.searchParams.get('kind')||'';
  if(q.length>200)fail('Arama en fazla 200 karakter olmalı.');
  if(!['','payments'].includes(kind))fail('Hareket süzgeci geçersiz.');
  if(!['','overdue','upcoming'].includes(due))fail('Vade seçimi geçersiz.');
  if(!Number.isSafeInteger(page)||page<1||page>1000000)fail('Sayfa bilgisi geçersiz.');
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
  const terms=[],args=[];
  if(party){terms.push('e.party_id=?');args.push(party);}
  if(from){terms.push('e.occurred_on>=?');args.push(day(from));}
  if(to){terms.push('e.occurred_on<=?');args.push(day(to));}
  if(from&&to&&from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
  if(q){terms.push("(e.reference LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");const term='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';args.push(term,term,term);}
  if(due==='overdue'){terms.push('e.due_on IS NOT NULL AND e.due_on<?');args.push(today);}
  if(due==='upcoming'){terms.push('e.due_on IS NOT NULL AND e.due_on>=?');args.push(today);}
  if(kind==='payments')terms.push('('+PAYMENT('e')+')');
  const where=terms.length?' WHERE '+terms.join(' AND '):'';
  const limit=200;
  const countRow=await stmt(db,`SELECT COUNT(*) total FROM party_entries e JOIN suppliers s ON s.id=e.party_id${where}`,args).first();
  const results=await db.batch([
   // Cari kartı: bakiyenin yanında toplam borç, kapatılan (ödenen) ve kalan da okunur.
   db.prepare(`SELECT s.*,COALESCE(SUM(e.amount_cents),0) balance_cents,(SELECT COALESCE(SUM(-d.amount_cents),0) FROM party_entries d WHERE d.party_id=s.id AND d.amount_cents<0 AND ${live('d')}) debt_cents,(SELECT COALESCE(SUM(a.amount_cents),0) FROM payment_allocations a JOIN party_entries d ON d.id=a.negative_entry_id WHERE d.party_id=s.id AND ${live('d')} AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)) paid_cents FROM suppliers s LEFT JOIN party_entries e ON e.party_id=s.id GROUP BY s.id ORDER BY s.name`),
   db.prepare('SELECT a.*,COALESCE(SUM(t.amount_cents),0) balance_cents FROM cash_accounts a LEFT JOIN cash_transactions t ON t.account_id=a.id GROUP BY a.id ORDER BY a.name'),
   stmt(db,`SELECT e.*,s.name party_name,COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE (a.positive_entry_id=e.id OR a.negative_entry_id=e.id) AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)),0) allocated_cents,(SELECT id FROM party_entries r WHERE r.reversal_of=e.id) reversed_by,${PLANNED} planned_on,(SELECT m.method FROM party_payment_methods m WHERE m.entry_id=e.id) payment_method,(SELECT m.note FROM party_payment_methods m WHERE m.entry_id=e.id) payment_note,(SELECT m.due_on FROM party_payment_methods m WHERE m.entry_id=e.id) payment_due_on FROM party_entries e JOIN suppliers s ON s.id=e.party_id${where} ORDER BY e.occurred_on DESC,e.created_at DESC,e.rowid DESC LIMIT ? OFFSET ?`,[...args,limit,(page-1)*limit]),
   db.prepare('SELECT a.*,p.party_id,r.id reversed_by,r.reason reversal_reason FROM payment_allocations a JOIN party_entries p ON p.id=a.positive_entry_id LEFT JOIN allocation_reversals r ON r.allocation_id=a.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 501'),
   db.prepare('SELECT t.*,a.name account_name,e.party_id,s.name party_name,(SELECT id FROM cash_transactions r WHERE r.reversal_of=t.id) reversed_by FROM cash_transactions t JOIN cash_accounts a ON a.id=t.account_id LEFT JOIN party_entries e ON e.id=t.party_entry_id LEFT JOIN suppliers s ON s.id=e.party_id ORDER BY t.occurred_on DESC,t.created_at DESC,t.rowid DESC LIMIT 501'),
   // Açık alış faturaları: hangi faturaya ne kadar ödendiği ve varsa "şu tarihte ödeyeceğim" notu.
   stmt(db,`SELECT e.id entry_id,substr(e.source_key,9) invoice_id,e.reference invoice_no,e.party_id,s.name party_name,e.occurred_on,-e.amount_cents debt_cents,${ALLOCATED('negative')} paid_cents,${PLANNED} planned_on,e.due_on FROM party_entries e JOIN suppliers s ON s.id=e.party_id WHERE e.source='invoice' AND e.source_key LIKE 'invoice:%' AND e.amount_cents<0 AND ${LIVE}${party?' AND e.party_id=?':''} ORDER BY e.occurred_on,e.created_at,e.rowid LIMIT 501`,party?[party]:[]),
   // Verilen çekler: borcu kapatır ama para hesaptan vadesinde çıkar.
   stmt(db,`SELECT e.id entry_id,e.party_id,s.name party_name,e.amount_cents,e.occurred_on,e.reference,m.due_on,m.note,(SELECT id FROM party_entries r WHERE r.reversal_of=e.id) reversed_by FROM party_payment_methods m JOIN party_entries e ON e.id=m.entry_id JOIN suppliers s ON s.id=e.party_id WHERE m.method='cek' AND e.reversal_of IS NULL${party?' AND e.party_id=?':''} ORDER BY m.due_on,e.occurred_on LIMIT 201`,party?[party]:[]),
   // "Son ödeme": her cari için TEK satır. max() ile seçilen satırın öbür sütunları da o satırdan gelir,
   // böylece kalabalık defterde bir carinin son ödemesi listenin sonunda kalıp kaybolmaz.
   db.prepare(`SELECT p.party_id,max(p.occurred_on||'#'||p.created_at||'#'||printf('%020d',p.rowid)) ordinal,p.id entry_id,p.occurred_on,p.amount_cents,p.reference,m.method,m.note,m.due_on FROM party_entries p LEFT JOIN party_payment_methods m ON m.entry_id=p.id WHERE ${PAYMENT('p')} AND ${live('p')} GROUP BY p.party_id`)
  ]);
  const [parties,accounts,entries,allocations,cash,invoiceRows,chequeRows,paymentRows]=results.map(r=>r.results);
  // Ödeme → kapattığı faturalar. Yalnızca bu sayfadaki ödemeler sorulur: liste eksik kalmaz, sınıra takılmaz.
  // Tutar yetkisi olmayan personelde amount_cents gizlenir, fatura numarası kalır.
  const paid=entries.filter(e=>e.amount_cents>0&&e.allocated_cents>0).map(e=>e.id);
  const closedRows=paid.length?(await stmt(db,`SELECT a.positive_entry_id,a.negative_entry_id,a.amount_cents,n.reference invoice_no,n.source_key,n.occurred_on invoice_on FROM payment_allocations a JOIN party_entries n ON n.id=a.negative_entry_id WHERE a.positive_entry_id IN (${paid.map(()=>'?').join(',')}) AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id) ORDER BY n.occurred_on,n.reference,a.rowid`,paid).all()).results:[];
  const closedBy=new Map();
  for(const row of closedRows){
   const list=closedBy.get(row.positive_entry_id)||[];
   list.push({entry_id:row.negative_entry_id,invoice_id:row.source_key&&row.source_key.startsWith('invoice:')?row.source_key.slice(8):null,invoice_no:row.invoice_no,occurred_on:row.invoice_on,amount_cents:row.amount_cents});
   closedBy.set(row.positive_entry_id,list);
  }
  // Ödemesi olmayan cari için uydurma kayıt üretilmez: last_payment null kalır, ekranda "Ödeme yok" yazar.
  const lastPayment=new Map();
  for(const row of paymentRows)lastPayment.set(row.party_id,{entry_id:row.entry_id,occurred_on:row.occurred_on,amount_cents:row.amount_cents,reference:row.reference,method:row.method||null,note:row.note||'',due_on:row.due_on||null});
  const invoices=invoiceRows.slice(0,500).map(r=>{const row={...r,remaining_cents:r.debt_cents-r.paid_cents};return {...row,status:invoiceStatus(row)};});
  const openInvoices=invoices.filter(r=>r.status!=='paid');
  const cheques=chequeRows.filter(c=>!c.reversed_by).slice(0,200);
  // "Vadesi gelen / geçen": kısa liste. Faturada planlanan ödeme tarihi ya da vade, çekte vade esas alınır.
  const dueSoon=[
   ...openInvoices.filter(r=>r.planned_on||r.due_on).map(r=>({kind:'invoice',entry_id:r.entry_id,invoice_id:r.invoice_id,party_id:r.party_id,party_name:r.party_name,reference:r.invoice_no,due_on:r.planned_on||r.due_on,planned:!!r.planned_on,amount_cents:r.remaining_cents})),
   ...cheques.filter(c=>c.due_on).map(c=>({kind:'cheque',entry_id:c.entry_id,invoice_id:null,party_id:c.party_id,party_name:c.party_name,reference:c.reference,due_on:c.due_on,planned:false,amount_cents:c.amount_cents}))
  ].sort((a,b)=>a.due_on<b.due_on?-1:a.due_on>b.due_on?1:0).slice(0,20).map(x=>({...x,overdue:x.due_on<today}));
  // Faturasız mal girişi ürün seçtirir; liste bu ekranda da gerekli.
  const products=(await stmt(db,'SELECT id,name,sku FROM products ORDER BY name LIMIT 2000').all()).results;
  return {products,parties:parties.map(p=>({...p,remaining_cents:p.debt_cents-p.paid_cents,last_payment:lastPayment.get(p.id)||null})),accounts,entries:entries.map(e=>{
   const row={...e,remaining_cents:Math.abs(e.amount_cents)-e.allocated_cents,closed_invoices:closedBy.get(e.id)||[]};
   // Ödenen tutar yalnızca borç satırında anlamlıdır; ödeme satırına sıfır yazılmaz.
   if(e.amount_cents<0)row.paid_cents=e.allocated_cents;
   return row;
  }),entry_pagination:{page,limit,total:countRow.total,pages:Math.max(1,Math.ceil(countRow.total/limit)),has_more:page*limit<countRow.total},entry_filters:{q,from,to,due,kind,party_id:party||''},allocations:allocations.slice(0,500),cash_transactions:cash.slice(0,500),open_invoices:openInvoices,cheques,due_soon:dueSoon,payment_methods:Object.entries(METHODS).map(([key,label])=>({key,label})),truncated:{entries:false,allocations:allocations.length>500,cash_transactions:cash.length>500,open_invoices:invoiceRows.length>500,cheques:chequeRows.length>200},currency:'TRY',balance_note:'Pozitif cari bakiye alacağınız; negatif bakiye borcunuzdur.',cheque_note:'Verilen çek cari borcunu kapatır; para hesabınızdan vadesinde çıkar, henüz tahsil edilmemiştir.'};
 }
 if(method!=='POST')return null;
 const x=await readBody(request),key=id();
 if(path==='/api/ledger/parties'){
  const kind=x.kind||'supplier';if(!['supplier','customer','marketplace','other'].includes(kind))fail('Cari türü geçersiz.');
  const tax=optional(x.tax_id,11);if(tax&&!/^\d{10,11}$/.test(tax))fail('VKN/TCKN 10 veya 11 rakam olmalı.');
  if(tax){const existing=await stmt(db,'SELECT id FROM suppliers WHERE tax_id=?',[tax]).first();if(existing)return {id:existing.id,existing:true};}
  await execute(db,[stmt(db,'INSERT INTO suppliers(id,name,kind,tax_id,contact,email,phone,address) VALUES(?,?,?,?,?,?,?,?)',[key,text(x.name,'Cari adı',200),kind,tax||null,optional(x.contact),optional(x.email,200),optional(x.phone,50),optional(x.address,1000)])]);return {id:key};
 }
 if(path==='/api/ledger/accounts'){
  if(!['cash','bank'].includes(x.kind))fail('Hesap türü kasa veya banka olmalı.');
  await execute(db,[stmt(db,'INSERT INTO cash_accounts(id,name,kind) VALUES(?,?,?)',[key,text(x.name,'Hesap adı',200),x.kind])]);return {id:key};
 }
 if(path==='/api/ledger/entries'){
  const party=text(x.party_id,'Cari');await requireParty(db,party);
  const reference=text(x.reference,'Referans',200),kind=x.kind||'manual';if(!['manual','opening'].includes(kind))fail('Hareket türü geçersiz.');
  await execute(db,[entryInsert(db,{id:key,party_id:party,amount_cents:money(x.amount),occurred_on:day(x.occurred_on),due_on:x.due_on?day(x.due_on):null,reference,description:text(x.description,'Açıklama',2000),source_key:'manual:'+optional(x.source_key||reference,200),source:kind})]);return {id:key};
 }
 if(path==='/api/ledger/cash'){
  if(!['receipt','payment'].includes(x.direction))fail('Tahsilat veya ödeme seçin.');
  const amount=positive(x.amount)*(x.direction==='receipt'?1:-1),account=text(x.account_id,'Kasa/banka'),reference=text(x.reference,'Referans',200),description=text(x.description,'Açıklama',2000),date=day(x.occurred_on);
  if(!await stmt(db,'SELECT id FROM cash_accounts WHERE id=?',[account]).first())fail('Kasa/banka hesabı bulunamadı.',404);
  const party=optional(x.party_id),entry=party?id():null,items=[];
  if(party){await requireParty(db,party);items.push(entryInsert(db,{id:entry,party_id:party,amount_cents:-amount,occurred_on:date,reference,description,source_key:'cash:'+reference,source:'cash'}));}
  items.push(stmt(db,'INSERT INTO cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description) VALUES(?,?,?,?,?,?,?)',[key,account,entry,amount,date,reference,description]));
  await execute(db,items);return {id:key,party_entry_id:entry};
 }
 // Fatura ödemesi. Kasa/banka hesabı ZORUNLU DEĞİLDİR: ödemenin nasıl yapıldığı (nakit/kart/havale/çek)
 // ve serbest not ("hangi kart, hangi banka") yeterlidir. Hesap verilirse kasa hareketi de aynı yazma
 // kümesinde oluşur. Ödeme ve kapamaları tek db.batch: ya hepsi yazılır ya hiçbiri.
 if(path==='/api/ledger/payments'){
  const party=text(x.party_id,'Cari');await requireParty(db,party);
  const amount=positive(x.amount),date=day(x.occurred_on),method=x.method;
  if(!Object.hasOwn(METHODS,method))fail('Ödemeyi nasıl yaptığınızı seçin: nakit, kart, havale veya çek.');
  const note=optional(typeof x.note==='string'?x.note.trim():x.note,200);
  const due=x.due_on===undefined||x.due_on===null||x.due_on===''?null:day(x.due_on);
  if(method==='cek'&&!due)fail('Çek için vade tarihi girin; çek vadesinde ödenecek.');
  const account=optional(x.account_id,200);
  if(x.invoice_ids!==undefined&&x.invoice_ids!==null&&!Array.isArray(x.invoice_ids))fail('Fatura seçimi geçersiz.');
  const invoiceIds=Array.isArray(x.invoice_ids)?x.invoice_ids.filter(v=>v!==undefined&&v!==null&&v!=='').map(String):[];
  if(invoiceIds.length>100)fail('Tek ödemede en fazla 100 fatura kapatılabilir.');
  if(new Set(invoiceIds).size!==invoiceIds.length)fail('Aynı fatura iki kez seçilemez.');
  // Aynı ödemenin iki kez gönderilmesi (çift tık, kopan bağlantı) ikinci kaydı oluşturmaz:
  // referans girdiden türetilir ve source_key tekildir. Kendi öneki vardır: kasa/banka
  // hareketinin ('cash:') referansıyla karışmaz.
  const reference=x.reference?text(x.reference,'Referans',120):await digestReference([party,String(amount),date,method,due||'',note,[...invoiceIds].sort().join(',')]);
  const sourceKey='odeme:'+reference;
  const already=await stmt(db,'SELECT id FROM party_entries WHERE source_key=?',[sourceKey]).first();
  if(already){
   const closed=(await stmt(db,'SELECT n.source_key,a.amount_cents FROM payment_allocations a JOIN party_entries n ON n.id=a.negative_entry_id WHERE a.positive_entry_id=? AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)',[already.id]).all()).results;
   return {id:already.id,existing:true,reference,allocated_cents:closed.reduce((sum,row)=>sum+row.amount_cents,0),closed_invoice_ids:closed.filter(r=>r.source_key.startsWith('invoice:')).map(r=>r.source_key.slice(8))};
  }
  const open=(await stmt(db,openDebtSql,[party]).all()).results.filter(row=>remainingOf(row)>0);
  let targets=open;
  if(invoiceIds.length){
   const byInvoice=new Map(open.map(row=>[row.source_key,row]));
   targets=invoiceIds.map(invoice=>{const row=byInvoice.get('invoice:'+invoice);if(!row)fail('Seçilen faturalardan birinin açık cari borcu bulunamadı. Fatura muhasebeleşmemiş ya da zaten ödenmiş olabilir.',409);return row;});
   targets.sort((a,b)=>a.occurred_on<b.occurred_on?-1:a.occurred_on>b.occurred_on?1:0);
  }
  const available=targets.reduce((sum,row)=>sum+remainingOf(row),0);
  if(!available)fail(invoiceIds.length?'Seçilen faturaların açık borcu kalmamış.':'Bu carinin açık borcu yok. Önce faturayı muhasebeleştirin ya da borcu elle girin.',409);
  if(amount>available)fail((invoiceIds.length?'Seçilen faturaların kalan borcu ':'Bu carinin açık borcu ')+lira(available)+'. Daha fazlasını ödeme olarak yazamayız; tutarı düşürün'+(invoiceIds.length?' ya da başka fatura seçin.':'.'),409);
  let left=amount;const picks=[];
  for(const row of targets){if(left<=0)break;const take=Math.min(remainingOf(row),left);if(take<=0)continue;picks.push({row,take});left-=take;}
  const label=METHODS[method],description='Ödeme · '+label+(method==='cek'?' · vade '+due:'')+(note?' · '+note:'');
  const items=[
   entryInsert(db,{id:key,party_id:party,amount_cents:amount,occurred_on:date,due_on:method==='cek'?due:null,reference,description,source_key:sourceKey,source:'cash'}),
   stmt(db,'INSERT INTO party_payment_methods(entry_id,method,note,due_on) VALUES(?,?,?,?)',[key,method,note,due])
  ];
  picks.forEach((pick,index)=>items.push(stmt(db,'INSERT INTO payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES(?,?,?,?,?)',[id(),key,pick.row.id,pick.take,reference+'#'+(index+1)])));
  if(account){
   if(!await stmt(db,'SELECT id FROM cash_accounts WHERE id=?',[account]).first())fail('Kasa/banka hesabı bulunamadı.',404);
   items.push(stmt(db,'INSERT INTO cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description) VALUES(?,?,?,?,?,?,?)',[id(),account,key,-amount,date,reference,description]));
  }
  await execute(db,items);
  return {id:key,reference,method,note,due_on:due,allocated_cents:amount-left,account_id:account||null,closed_invoice_ids:picks.filter(p=>p.row.source_key.startsWith('invoice:')&&remainingOf(p.row)===p.take).map(p=>p.row.source_key.slice(8))};
 }
 // Muhasebeleşmiş ama cari borcu yazılmamış eski faturaları tamamlar. Tekrar çalıştırmak güvenlidir:
 // borcu olan faturaya dokunmaz, taslak ve iptal faturayı hiç işlemez.
 if(path==='/api/ledger/invoice-debts'){
  const missing="SELECT i.id FROM purchase_invoices i JOIN purchase_lines l ON l.invoice_id=i.id WHERE i.status='posted' AND NOT EXISTS(SELECT 1 FROM party_entries e WHERE e.source_key='invoice:'||i.id) GROUP BY i.id HAVING SUM(l.net_cents+l.tax_cents)>0 ORDER BY i.invoice_date,i.rowid";
  const pending=(await db.prepare(missing+' LIMIT 1001').all()).results;
  if(!pending.length)return {created:0,created_cents:0,found:0,remaining:0};
  const take=pending.slice(0,200);
  await execute(db,take.map(row=>invoiceDebtStatement(db,row.id)));
  const written=await stmt(db,`SELECT COUNT(*) n,COALESCE(SUM(-amount_cents),0) total FROM party_entries WHERE source_key IN (${take.map(()=>'?').join(',')})`,take.map(row=>'invoice:'+row.id)).first();
  return {created:written.n,created_cents:written.total,found:pending.length,remaining:Math.max(0,pending.length-take.length)};
 }
 // "Bunu ay sonunda ödeyeceğim": açık borca planlanan ödeme tarihi. Para hareketi oluşturmaz.
 // Defter değişmez olduğu için hareketin kendisi güncellenmez; plan ayrı satır olarak eklenir, son satır geçerlidir.
 if(path==='/api/ledger/plans'){
  const planned=day(x.planned_on),note=optional(typeof x.note==='string'?x.note.trim():x.note,200);
  const entryId=optional(x.entry_id,200)||'invoice:'+text(x.invoice_id,'Fatura',200);
  const row=await stmt(db,`SELECT e.id,e.amount_cents,e.reversal_of,${ALLOCATED('negative')} allocated_cents,(SELECT id FROM party_entries r WHERE r.reversal_of=e.id) reversed_by FROM party_entries e WHERE e.id=?`,[entryId]).first();
  if(!row)fail('Bu fatura için cari borcu bulunamadı. Önce faturayı muhasebeleştirin.',404);
  if(row.amount_cents>=0)fail('Planlanan ödeme tarihi yalnızca borç hareketine eklenebilir.');
  if(row.reversal_of||row.reversed_by)fail('Düzeltilmiş hareket için ödeme tarihi planlanamaz.',409);
  if(remainingOf(row)<=0)fail('Bu borç kapanmış; planlanan ödeme tarihi gerekmiyor.',409);
  const planId='plan:'+entryId+':'+planned;
  const seen=await stmt(db,'SELECT id FROM party_entry_plans WHERE id=?',[planId]).first();
  if(seen)return {id:seen.id,entry_id:entryId,planned_on:planned,existing:true};
  await execute(db,[stmt(db,'INSERT INTO party_entry_plans(id,entry_id,planned_on,note) VALUES(?,?,?,?)',[planId,entryId,planned,note])]);
  return {id:planId,entry_id:entryId,planned_on:planned,remaining_cents:remainingOf(row)};
 }

 // FATURASIZ MAL GİRİŞİ. Vadeli tedarikçi malı önce gönderir, faturayı vade gününde keser.
 // Mal buradan girilir: stok 'GECICI-SAYIM-<referans>' sayımıyla artar, cariye geçici borç yazılır.
 // Gerçek fatura muhasebeleşince geçici borç ters kayıtla kapanır (accounting.js '/post'), teslim
 // yapılınca da geçici sayım provisionalClose ile düşer. Çift giriş bu yüzden oluşamaz: her iki taraf
 // da karşılığı doğduğu anda kapanır ve kapanış kayıtları tekildir.
 if(path==='/api/ledger/provisional'){
  // Gövde ve key yukarıda bir kez okunur (satır 113); ikinci readBody isteği kilitler.
  const party=text(x.supplier_id,'Tedarikçi');
  await requireParty(db,party);
  const date=day(x.occurred_on),reference=text(x.reference,'İrsaliye referansı',200),notes=optional(x.notes,1000);
  // ÖDEME VADESİ isteğe bağlıdır: girilirse cari hareketine yazılır, ekranda "Vade" olarak görünür
  // ve vadesi geçenler işaretlenir. Malın geliş tarihinden önce olamaz.
  const vade=x.due_on===undefined||x.due_on===null||x.due_on===''?null:day(x.due_on);
  if(vade&&vade<date)fail('Ödeme vadesi malın geldiği tarihten önce olamaz.');
  if(!Array.isArray(x.lines)||!x.lines.length)fail('En az bir ürün satırı girin.');
  if(x.lines.length>200)fail('Tek girişte en fazla 200 satır olabilir.');
  const seen=new Set(),rows=[];
  for(const line of x.lines){
   const product=text(line.product_id,'Ürün');
   if(seen.has(product))fail('Aynı ürün iki satırda olamaz; miktarları birleştirin.');
   seen.add(product);
   const qty=milliQty(line.quantity),unit=costCents(line.unit_cost),vat=vatBps(line.vat_bps);
   if(!await stmt(db,'SELECT product_id FROM stock_balances WHERE product_id=?',[product]).first())fail('Ürün bu çalışma alanında bulunamadı.',404);
   rows.push({product,qty,unit,vat,value:Math.round(qty*unit/1000)});
  }
  const brut=rows.reduce((t,r)=>t+Math.round(r.value*(10000+r.vat)/10000),0);
  if(brut<=0)fail('Girişin KDV dahil tutarı sıfırdan büyük olmalı.');
  // Cari satırı ÖNCE yazılır: başlık entry_id ile ona bağlı, ters sırada yabancı anahtar kırılır.
  const entry=id(),statements=[
   entryInsert(db,{id:entry,party_id:party,amount_cents:-brut,occurred_on:date,due_on:vade,reference,
    description:'Faturasız mal girişi · '+reference,source_key:'gecici:'+key,source:'manual'}),
   stmt(db,'INSERT INTO provisional_receipts(id,supplier_id,occurred_on,reference,notes,entry_id) VALUES(?,?,?,?,?,?)',[key,party,date,reference,notes,entry])];
  for(const r of rows){
   statements.push(stmt(db,'INSERT INTO stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(?,?,?,?,?,?,?,?)',
    [id(),r.product,r.qty,r.value,'count','GECICI-SAYIM-'+reference,'Faturasız mal girişi · fatura gelince kapanır',date]));
   statements.push(stmt(db,'INSERT INTO provisional_receipt_lines(id,receipt_id,product_id,quantity_milli,unit_cost_cents,vat_bps) VALUES(?,?,?,?,?,?)',
    [id(),key,r.product,r.qty,r.unit,r.vat]));
  }
  await execute(db,statements);
  return {id:key,amount_cents:-brut};
 }
 if(path==='/api/ledger/allocations'){
  await execute(db,[stmt(db,'INSERT INTO payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES(?,?,?,?,?)',[key,text(x.positive_entry_id,'Alacak hareketi'),text(x.negative_entry_id,'Borç hareketi'),positive(x.amount),text(x.reference,'Referans',200)])]);return {id:key};
 }
 if(path==='/api/ledger/reverse'){
  const reason=text(x.reason,'Ters kayıt nedeni',2000),selected=[x.allocation_id,x.entry_id,x.cash_transaction_id].filter(Boolean);if(selected.length!==1)fail('Ters kayıt için tek hareket seçin.');
  if(x.allocation_id){await execute(db,[stmt(db,'INSERT INTO allocation_reversals(id,allocation_id,reason) VALUES(?,?,?)',[key,text(x.allocation_id,'Kapama'),reason])]);return {id:key};}
  const date=day(x.occurred_on),reference=text(x.reference,'Referans',200),items=[];
  if(x.cash_transaction_id){
   const original=await stmt(db,'SELECT * FROM cash_transactions WHERE id=?',[x.cash_transaction_id]).first();if(!original)fail('Kasa/banka hareketi bulunamadı.',404);
   let reversalEntry=null;if(original.party_entry_id){const e=await stmt(db,'SELECT * FROM party_entries WHERE id=?',[original.party_entry_id]).first();reversalEntry=id();items.push(entryInsert(db,{...e,id:reversalEntry,amount_cents:-e.amount_cents,occurred_on:date,due_on:null,reference,description:reason,source_key:'reverse:'+e.id,source:'reversal',reversal_of:e.id}));}
   items.push(stmt(db,'INSERT INTO cash_transactions(id,account_id,party_entry_id,amount_cents,occurred_on,reference,description,reversal_of) VALUES(?,?,?,?,?,?,?,?)',[key,original.account_id,reversalEntry,-original.amount_cents,date,reference,reason,original.id]));
  }else{
   const e=await stmt(db,'SELECT * FROM party_entries WHERE id=?',[x.entry_id]).first();if(!e)fail('Cari hareketi bulunamadı.',404);
   // Kasa/banka kaydına bağlı hareket oradan geri alınır. Hesap seçilmeden girilen ödemenin
   // bağlı kasa kaydı yoktur; onun ters kaydı doğrudan burada yazılır.
   if(e.source==='cash'&&await stmt(db,'SELECT id FROM cash_transactions WHERE party_entry_id=?',[e.id]).first())fail('Bu hareketi bağlı kasa/banka kaydı üzerinden geri alın.',409);
   if(!['manual','opening','cash'].includes(e.source))fail('Belgeden oluşan hareket için kaynak belge düzeltme işlemi gerekir.',409);
   items.push(entryInsert(db,{...e,id:key,amount_cents:-e.amount_cents,occurred_on:date,due_on:null,reference,description:reason,source_key:'reverse:'+e.id,source:'reversal',reversal_of:e.id}));
  }
  await execute(db,items);return {id:key};
 }
 return null;
}
