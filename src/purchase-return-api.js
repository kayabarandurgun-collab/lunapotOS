import {milli} from '../public/accounting-math.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,label,max=500)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v||v>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}))fail('Geçerli, ileri tarihli olmayan işlem tarihi girin.');return v;};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
async function execute(db,statements){try{await db.batch(statements);}catch(e){const m=String(e.message);
 if(/PURCHASE_RETURN_QUANTITY/.test(m))fail('İade miktarı, bu faturadan teslim alınan ve henüz iade edilmemiş miktarı aşıyor.',409);
 if(/PURCHASE_RETURN_ALLOCATED/.test(m))fail('Önce Cariler ekranından bu iadeye bağlı belge kapamalarını geri alın.',409);
 if(/PURCHASE_RETURN_REVERSED|UNIQUE constraint/.test(m))fail('Bu işlem veya referans daha önce kaydedildi.',409);
 if(/PURCHASE_RETURN_VALUE/.test(m))fail('Stok veya iade tutarı değişti. Faturayı yenileyip tekrar deneyin.',409);
 if(/RECEIPT_REVERSAL_RETURN/.test(m))fail('Bu satırda tedarikçi iadesi var. Önce ilgili iade kaydını geri alın.',409);
 if(/RECEIPT_REVERSAL_COST|INVALID_STOCK_VALUE/.test(m))fail('Sonraki stok hareketleri nedeniyle bu teslimin maliyeti güvenle geri alınamıyor.',409);
 if(/STOCK_RESERVED|INSUFFICIENT_STOCK/.test(m))fail('Kullanılabilir stok yetersiz. Siparişlere ayrılmış veya satılmış ürünler çıkarılamaz.',409);
 if(/PURCHASE_RETURN_INVALID|RECEIPT_REVERSAL_INVALID/.test(m))fail('Fatura, teslim veya işlem tarihi bu kayıtla uyuşmuyor.',409);
 throw e;
}}
export async function purchaseReturnApi(request,env,path,readBody){
 const match=path.match(/^\/api\/invoices\/([\w-]+)\/(returns|returns\/([\w-]+)\/reverse|receipts\/([\w-]+)\/reverse)$/);
 if(!match)return null;
 if(env.WORKSPACE!=='ec')fail('Bu iade işlemi e-ticaret çalışma alanına aittir.',403);
 if(request.method!=='POST')fail('İşlem bulunamadı.',404);
 const operationId=crypto.randomUUID(),db=env.DB,invoiceId=match[1],invoice=await stmt(db,'SELECT * FROM purchase_invoices WHERE id=?',[invoiceId]).first();
 if(!invoice)fail('Fatura bu çalışma alanında bulunamadı.',404);
 if(invoice.status!=='posted')fail('Önce alış faturası muhasebeleştirilmeli.',409);
 const x=await readBody(request),reference=text(x.reference,'Belge / işlem referansı',200),reason=text(x.reason,'Gerekçe'),date=day(x.occurred_on),ids=[];
 if(date<invoice.invoice_date)fail('İşlem, alış faturası tarihinden önce olamaz.');
 let statements=[];
 if(match[2]==='returns'){
  if(!Array.isArray(x.lines)||!x.lines.length||x.lines.length>40||x.lines.some(l=>!l||typeof l!=='object')||new Set(x.lines.map(l=>l.id)).size!==x.lines.length)fail('İade edilecek satırları birer kez seçin.');
  // A reference identifies one complete submitted operation, even if retried with different lines.
  if(await stmt(db,'SELECT r.id FROM purchase_returns r JOIN purchase_lines l ON l.id=r.line_id WHERE l.invoice_id=? AND r.reference=? LIMIT 1',[invoiceId,reference]).first())fail('Bu referans daha önce işlendi.',409);
  const rows=(await stmt(db,"SELECT id FROM purchase_lines WHERE invoice_id=? AND line_type='product'",[invoiceId]).all()).results;
  for(const line of x.lines){
   if(!rows.some(r=>r.id===line.id))fail('Bu faturada stok ürün satırı bulunamadı.',404);
   let quantity;try{quantity=milli(line.quantity);}catch(e){fail(e.message);}
   const id=crypto.randomUUID();ids.push(id);
   statements.push(stmt(db,`INSERT INTO purchase_returns(id,line_id,quantity_milli,net_cents,tax_cents,cost_cents,operation_id,reference,occurred_on,reason)
    SELECT ?,l.id,?,CAST(ROUND(v.effective_net*(?+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_net,CAST(ROUND(v.effective_tax*(?+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_tax,CAST(ROUND(b.value_cents*1.0*?/MAX(b.quantity_milli,1.0)) AS INTEGER),?,?,?,? FROM purchase_lines l JOIN stock_balances b ON b.product_id=l.product_id JOIN purchase_line_limits v ON v.id=l.id WHERE l.id=?`,[id,quantity,quantity,quantity,quantity,operationId,reference,date,reason,line.id]));
  }
 }else if(match[3]){
  const original=await stmt(db,'SELECT r.* FROM purchase_returns r JOIN purchase_lines l ON l.id=r.line_id WHERE r.id=? AND l.invoice_id=?',[match[3],invoiceId]).first();if(!original)fail('İade kaydı bulunamadı.',404);
  const id=crypto.randomUUID();ids.push(id);
  statements.push(stmt(db,'INSERT INTO purchase_returns(id,line_id,quantity_milli,net_cents,tax_cents,cost_cents,operation_id,reference,occurred_on,reason,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,original.line_id,original.quantity_milli,original.net_cents,original.tax_cents,original.cost_cents,operationId,reference,date,reason,original.id]));
 }else{
  const receipt=await stmt(db,'SELECT g.id FROM goods_receipts g JOIN purchase_lines l ON l.id=g.line_id WHERE g.id=? AND l.invoice_id=?',[match[4],invoiceId]).first();if(!receipt)fail('Teslim kaydı bulunamadı.',404);
  const id=crypto.randomUUID();ids.push(id);statements.push(stmt(db,'INSERT INTO receipt_reversals(id,receipt_id,reference,occurred_on,reason) VALUES(?,?,?,?,?)',[id,receipt.id,reference,date,reason]));
 }
 statements.push(stmt(db,'INSERT INTO activity(id,description) VALUES(?,?)',[crypto.randomUUID(),'Alış belgesi stok/cari düzeltmesi: '+invoice.invoice_no+' · '+reference]));
 await execute(db,statements);return {id:invoiceId,record_ids:ids};
}
