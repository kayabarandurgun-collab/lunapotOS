import {effectiveNet} from './purchase-adjustment-api.js';
import {cents} from '../public/accounting-math.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const id=()=>crypto.randomUUID();
const text=(x,label,max=200)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail(label+' alanını kontrol edin.');return x.trim();};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const amount=x=>{let n;try{n=cents(x);}catch{fail('Dağıtım tutarı geçersiz.');}if(!Number.isSafeInteger(n)||n<=0)fail('Dağıtım tutarı sıfırdan büyük olmalı.');return n;};
async function execute(db,items){try{return await db.batch(items);}catch(e){const m=String(e.message);if(m.includes('FEE_OVERALLOCATION')||m.includes('ADJUSTMENT_ALLOCATED_FEE'))fail('Toplam dağıtım, fatura satırının KDV hariç kalan tutarını aşıyor.',409);if(m.includes('FEE_TAKEOVER_REQUIRED'))fail('Bu satışta elle girilmiş kesinti var. Mevcut tutarı belge dağıtımıyla değiştirmeyi açıkça onaylayın.',409);if(m.includes('INVALID_FEE_SOURCE'))fail('İşlenmiş ve satış kesintisi olarak sınıflandırılmış fatura satırı seçin.',409);if(m.includes('INVALID_FEE_SALE')||m.includes('FOREIGN KEY'))fail('Satış veya fatura bu çalışma alanında bulunamadı.',404);if(m.includes('UNIQUE constraint'))fail('Aynı kaynak satırı bu satışa zaten dağıtıldı veya referans kullanıldı.',409);if(m.includes('IMMUTABLE_FEE_ALLOCATION'))fail('Bu dağıtım daha önce geri alınmış veya değiştirilemez.',409);throw e;}}

// Reviewed document allocation only: never interprets a provider Payment as an actual bank transfer.
export async function reconciliationApi(request,env,path,readBody){
 if(!path.startsWith('/api/reconciliation'))return null;if(!['ec','lp'].includes(env.WORKSPACE))fail('Çalışma alanı geçersiz.',403);
 const db=env.DB,method=request.method;
 if(path==='/api/reconciliation'&&method==='GET'){
  const results=await db.batch([
   db.prepare(`SELECT l.id,l.invoice_id,l.description,l.expense_category,${effectiveNet(env.WORKSPACE)} net_cents,l.tax_cents,i.invoice_no,i.invoice_date,s.name supplier_name,COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0) allocated_cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id JOIN suppliers s ON s.id=i.supplier_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee' ORDER BY i.invoice_date DESC,i.created_at DESC,l.rowid DESC LIMIT 1001`),
   db.prepare("SELECT s.*,p.name product_name,(SELECT SUM(amount_cents) FROM fee_allocations a WHERE a.sale_id=s.id AND a.component='shipping' AND a.reversed_at IS NULL) linked_shipping_cents,(SELECT SUM(amount_cents) FROM fee_allocations a WHERE a.sale_id=s.id AND a.component='commission' AND a.reversed_at IS NULL) linked_commission_cents,(SELECT SUM(amount_cents) FROM fee_allocations a WHERE a.sale_id=s.id AND a.component='other' AND a.reversed_at IS NULL) linked_other_cents FROM sale_entries s JOIN products p ON p.id=s.product_id WHERE s.kind='sale' ORDER BY s.occurred_on DESC,s.created_at DESC,s.rowid DESC LIMIT 1001"),
   db.prepare('SELECT a.*,i.invoice_no,l.description,s.external_id sale_reference,s.channel,p.name product_name FROM fee_allocations a JOIN purchase_lines l ON l.id=a.invoice_line_id JOIN purchase_invoices i ON i.id=l.invoice_id JOIN sale_entries s ON s.id=a.sale_id JOIN products p ON p.id=s.product_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1001'),
   db.prepare(`SELECT COALESCE(SUM(${effectiveNet(env.WORKSPACE)}-COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0)),0) pending_cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee'`)
  ]);
  const [feeLines,sales,allocations,totals]=results.map(r=>r.results);
  return {fee_lines:feeLines.slice(0,1000).map(l=>({...l,remaining_cents:l.net_cents-l.allocated_cents,component:['shipping','commission'].includes(l.expense_category)?l.expense_category:'other'})),sales:sales.slice(0,1000),allocations:allocations.slice(0,1000),pending_cents:totals[0].pending_cents,truncated:{fee_lines:feeLines.length>1000,sales:sales.length>1000,allocations:allocations.length>1000},vat_treatment:'invoice_net',notice:'Dağıtımlar faturanın KDV hariç tutarından yapılır. KDV cari borçta kalır; satış giderine ikinci kez eklenmez.'};
 }
 if(method!=='POST')return null;
 const x=await readBody(request);
 if(path==='/api/reconciliation/allocate'){
  const source=text(x.invoice_line_id,'Fatura satırı'),reference=x.reference?text(x.reference,'Referans'):id();
  if(!Array.isArray(x.lines)||!x.lines.length||x.lines.length>20)fail('Tek işlemde 1–20 satış seçin.');if(x.takeover!==undefined&&typeof x.takeover!=='boolean')fail('Mevcut kesintiyi değiştirme onayı geçersiz.');
  const line=await stmt(db,"SELECT l.*,i.status invoice_status FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE l.id=?",[source]).first();if(!line)fail('Fatura satırı bulunamadı.',404);if(line.invoice_status!=='posted'||line.line_type!=='expense'||line.expense_treatment!=='sales_fee')fail('Fatura satırı satış kesintisi olarak işlenmiş olmalı.',409);
  const component=['shipping','commission'].includes(line.expense_category)?line.expense_category:'other',seen=new Set(),ids=[],items=[];
  for(const l of x.lines){const sale=text(l.sale_id,'Satış');if(seen.has(sale))fail('Aynı satışı iki kez seçmeyin.');seen.add(sale);const key=id();ids.push(key);items.push(stmt(db,'INSERT INTO fee_allocations(id,invoice_line_id,sale_id,component,amount_cents,takeover,reference) VALUES(?,?,?,?,?,?,?)',[key,source,sale,component,amount(l.amount),x.takeover===true?1:0,reference+':'+sale]));}
  await execute(db,items);return {ids,invoice_line_id:source,component};
 }
 if(path==='/api/reconciliation/reverse'){
  const key=text(x.id,'Dağıtım'),reason=text(x.reason,'Geri alma nedeni',2000),existing=await stmt(db,'SELECT * FROM fee_allocations WHERE id=?',[key]).first();if(!existing)fail('Dağıtım bulunamadı.',404);if(existing.reversed_at)fail('Bu dağıtım zaten geri alınmış.',409);
  await execute(db,[stmt(db,'UPDATE fee_allocations SET reversed_at=CURRENT_TIMESTAMP,reversal_reason=? WHERE id=?',[reason,key])]);return {id:key,reversed:true};
 }
 return null;
}
