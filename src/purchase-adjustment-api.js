import {cents,milli} from '../public/accounting-math.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,label,max=500)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v||v>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}))fail('Geçerli ve ileri tarihli olmayan işlem tarihi girin.');return v;};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
export const effectiveNet=ns=>ns==='ec'?'(SELECT effective_net FROM purchase_line_limits WHERE id=l.id)':'l.net_cents';
export const cancelledQuantity=ns=>ns==='ec'?'COALESCE((SELECT cancelled_milli FROM purchase_line_limits WHERE id=l.id),0)':'0';
export async function purchaseAdjustmentApi(request,env,path,readBody){
 const match=path.match(/^\/api\/invoices\/([\w-]+)\/adjustments(?:\/([\w-]+)\/reverse)?$/);if(!match)return null;
 if(env.WORKSPACE!=='ec')fail('Bu düzeltme e-ticaret çalışma alanına aittir.',403);if(request.method!=='POST')fail('İşlem bulunamadı.',404);
 const db=env.DB,invoice=await stmt(db,'SELECT * FROM purchase_invoices WHERE id=?',[match[1]]).first();if(!invoice)fail('Fatura bulunamadı.',404);if(invoice.status!=='posted')fail('Önce faturayı muhasebeleştirin.',409);
 const x=await readBody(request),reference=text(x.reference,'Düzeltme belgesi / referansı',200),reason=text(x.reason,'Düzeltme gerekçesi'),date=day(x.occurred_on),id=crypto.randomUUID(),operation=crypto.randomUUID();if(date<invoice.invoice_date)fail('Düzeltme tarihi faturadan önce olamaz.');
 let statement;
 if(match[2]){const old=await stmt(db,'SELECT a.* FROM purchase_adjustments a JOIN purchase_lines l ON l.id=a.line_id WHERE a.id=? AND l.invoice_id=?',[match[2],invoice.id]).first();if(!old)fail('Düzeltme bulunamadı.',404);
  statement=stmt(db,'INSERT INTO purchase_adjustments(id,line_id,kind,quantity_milli,net_cents,tax_cents,stock_cents,reference,operation_id,occurred_on,reason,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,old.line_id,old.kind,old.quantity_milli,old.net_cents,old.tax_cents,old.stock_cents,reference,operation,date,reason,old.id]);
 }else{
  const line=await stmt(db,'SELECT * FROM purchase_lines WHERE id=? AND invoice_id=?',[x.line_id,invoice.id]).first();if(!line)fail('Fatura satırı bulunamadı.',404);
  if(!['price','service','cancel'].includes(x.kind))fail('Düzeltme türünü seçin.');
  if(x.kind==='cancel'){let quantity;try{quantity=milli(x.quantity);}catch(e){fail(e.message);}
   statement=stmt(db,`INSERT INTO purchase_adjustments(id,line_id,kind,quantity_milli,net_cents,tax_cents,stock_cents,reference,operation_id,occurred_on,reason) SELECT ?,l.id,'cancel',?,CAST(ROUND(v.effective_net*(?+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_net,CAST(ROUND(v.effective_tax*(?+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_tax,0,?,?,?,? FROM purchase_lines l JOIN purchase_line_limits v ON v.id=l.id WHERE l.id=?`,[id,quantity,quantity,quantity,reference,operation,date,reason,line.id]);
  }else{let net,tax,stock;try{net=cents(x.net);tax=cents(x.tax);stock=cents(x.stock_net??0);}catch(e){fail(e.message);}
   statement=stmt(db,'INSERT INTO purchase_adjustments(id,line_id,kind,quantity_milli,net_cents,tax_cents,stock_cents,reference,operation_id,occurred_on,reason) VALUES(?,?,?,0,?,?,?,?,?,?,?)',[id,line.id,x.kind,net,tax,stock,reference,operation,date,reason]);
  }
 }
 try{await db.batch([statement,stmt(db,'INSERT INTO activity(id,description) VALUES(?,?)',[crypto.randomUUID(),'Alış düzeltmesi: '+invoice.invoice_no+' · '+reference])]);}catch(e){const m=String(e.message);
  if(/ADJUSTMENT_PARTY_ALLOCATED/.test(m))fail('Önce Cariler ekranından bu düzeltmenin belge kapamalarını geri alın.',409);
  if(/ADJUSTMENT_ALLOCATED_FEE/.test(m))fail('Kesinti satışlara dağıtılmış. Önce ilgili dağıtımı geri alın; sonra düzeltilmiş tutarı yeniden dağıtın.',409);
  if(/ADJUSTMENT_CANCEL_QUANTITY/.test(m))fail('İptal edilecek miktar, henüz teslim alınmamış miktarı aşıyor.',409);
  if(/ADJUSTMENT_CLOSED_LINE/.test(m))fail('Bu satırda iade veya teslim iptali var. Fiyat düzeltmesini değiştirmeden önce bunları geri alın.',409);
  if(/ADJUSTMENT_RECEIVE_FIRST/.test(m))fail('Stok maliyetine pay ayırmak için bu satırın tüm mal teslimi tamamlanmalı.',409);
  if(/ADJUSTMENT_STOCK_VALUE/.test(m))fail('Stok maliyeti için seçilen tutar eldeki stokla uyumlu değil. Stokta kalmayan payı dönem giderine ayırın.',409);
  if(/ADJUSTMENT_REVERSED|ADJUSTMENT_DUPLICATE|UNIQUE/.test(m))fail('Bu kayıt veya referans daha önce işlendi.',409);
  if(/ADJUSTMENT_EXCEEDS|ADJUSTMENT_INVALID|CHECK/.test(m))fail('Düzeltme türü, miktarı veya tutarı faturanın kalanıyla uyuşmuyor.',409);throw e;
 }
 return {id:invoice.id,adjustment_id:id};
}
