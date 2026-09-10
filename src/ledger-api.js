import {cents} from '../public/accounting-math.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const id=()=>crypto.randomUUID();
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const text=(x,label,max=500)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail(label+' alanını kontrol edin.');return x.trim();};
const optional=(x,max=500)=>x===undefined||x===null||x===''?'':text(x,'Bilgi',max);
const day=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString().slice(0,10)!==x)fail('Geçerli tarih girin.');return x;};
const money=x=>{let n;try{n=cents(x);}catch{fail('Geçerli bir tutar girin.');}if(!Number.isSafeInteger(n)||!n||Math.abs(n)>100000000000)fail('Tutar sıfır olamaz ve sınırı aşamaz.');return n;};
const positive=x=>{const n=money(x);if(n<0)fail('Tutar pozitif olmalı.');return n;};
async function execute(db,items){try{return await db.batch(items);}catch(error){const m=String(error.message);if(/OVER_ALLOCATION/.test(m))fail('Kapama tutarı belgenin kalan tutarını aşıyor.',409);if(/ENTRY_ALLOCATED/.test(m))fail('Önce bu hareketin belge kapamalarını geri alın.',409);if(/INVALID_ALLOCATION/.test(m))fail('Aynı cariye ait bir alacak ve bir borç hareketini seçin.',409);if(/REVERSAL|REVERSED_ENTRY/.test(m))fail('Bu hareket için ters kayıt oluşturulamaz.',409);if(/UNIQUE constraint/.test(m))fail('Bu referans veya kayıt daha önce işlendi.',409);if(/FOREIGN KEY/.test(m))fail('Seçilen kayıt bu çalışma alanında bulunamadı.',404);throw error;}}
async function requireParty(db,key){if(!await stmt(db,'SELECT id FROM suppliers WHERE id=?',[key]).first())fail('Cari bu çalışma alanında bulunamadı.',404);}
const entryInsert=(db,e)=>stmt(db,'INSERT INTO party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?)',[e.id,e.party_id,e.amount_cents,e.occurred_on,e.due_on||null,e.reference,e.description,e.source_key,e.source,e.reversal_of||null]);

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
  if(q.length>200)fail('Arama en fazla 200 karakter olmalı.');
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
  const where=terms.length?' WHERE '+terms.join(' AND '):'';
  const limit=200;
  const countRow=await stmt(db,`SELECT COUNT(*) total FROM party_entries e JOIN suppliers s ON s.id=e.party_id${where}`,args).first();
  const results=await db.batch([
   db.prepare('SELECT s.*,COALESCE(SUM(e.amount_cents),0) balance_cents FROM suppliers s LEFT JOIN party_entries e ON e.party_id=s.id GROUP BY s.id ORDER BY s.name'),
   db.prepare('SELECT a.*,COALESCE(SUM(t.amount_cents),0) balance_cents FROM cash_accounts a LEFT JOIN cash_transactions t ON t.account_id=a.id GROUP BY a.id ORDER BY a.name'),
   stmt(db,`SELECT e.*,s.name party_name,COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE (a.positive_entry_id=e.id OR a.negative_entry_id=e.id) AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)),0) allocated_cents,(SELECT id FROM party_entries r WHERE r.reversal_of=e.id) reversed_by FROM party_entries e JOIN suppliers s ON s.id=e.party_id${where} ORDER BY e.occurred_on DESC,e.created_at DESC,e.rowid DESC LIMIT ? OFFSET ?`,[...args,limit,(page-1)*limit]),
   db.prepare('SELECT a.*,p.party_id,r.id reversed_by,r.reason reversal_reason FROM payment_allocations a JOIN party_entries p ON p.id=a.positive_entry_id LEFT JOIN allocation_reversals r ON r.allocation_id=a.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 501'),
   db.prepare('SELECT t.*,a.name account_name,e.party_id,s.name party_name,(SELECT id FROM cash_transactions r WHERE r.reversal_of=t.id) reversed_by FROM cash_transactions t JOIN cash_accounts a ON a.id=t.account_id LEFT JOIN party_entries e ON e.id=t.party_entry_id LEFT JOIN suppliers s ON s.id=e.party_id ORDER BY t.occurred_on DESC,t.created_at DESC,t.rowid DESC LIMIT 501')
  ]);
  const [parties,accounts,entries,allocations,cash]=results.map(r=>r.results);
  return {parties,accounts,entries:entries.map(e=>({...e,remaining_cents:Math.abs(e.amount_cents)-e.allocated_cents})),entry_pagination:{page,limit,total:countRow.total,pages:Math.max(1,Math.ceil(countRow.total/limit)),has_more:page*limit<countRow.total},entry_filters:{q,from,to,due,party_id:party||''},allocations:allocations.slice(0,500),cash_transactions:cash.slice(0,500),truncated:{entries:false,allocations:allocations.length>500,cash_transactions:cash.length>500},currency:'TRY',balance_note:'Pozitif cari bakiye alacağınız; negatif bakiye borcunuzdur.'};
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
   if(e.source==='cash')fail('Bu hareketi bağlı kasa/banka kaydı üzerinden geri alın.',409);
   if(!['manual','opening'].includes(e.source))fail('Belgeden oluşan hareket için kaynak belge düzeltme işlemi gerekir.',409);
   items.push(entryInsert(db,{...e,id:key,amount_cents:-e.amount_cents,occurred_on:date,due_on:null,reference,description:reason,source_key:'reverse:'+e.id,source:'reversal',reversal_of:e.id}));
  }
  await execute(db,items);return {id:key};
 }
 return null;
}
