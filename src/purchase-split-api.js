import {milli} from '../public/accounting-math.js';
const fail=(m,s=400)=>{throw Object.assign(new Error(m),{status:s});};
const q=v=>{try{return milli(v);}catch(e){fail(e.message);}};
const round=(n,d)=>Number((n*2n+d)/(2n*d));
export async function purchaseSplitApi(request,env,path,readBody){
 const m=path.match(/^\/api\/invoices\/([\w-]+)\/(split|splits\/([\w-]+)\/undo)$/);if(!m||request.method!=='POST')return null;
 const db=env.DB,invoice=await db.prepare('SELECT * FROM purchase_invoices WHERE id=?').bind(m[1]).first();if(!invoice)fail('Fatura bulunamadı.',404);if(invoice.status!=='draft')fail('Çeşit dağılımı muhasebeleştirmeden önce yapılır.',409);
 try{
  if(m[3]){const s=await db.prepare('SELECT * FROM purchase_line_splits WHERE id=? AND invoice_id=?').bind(m[3],invoice.id).first();if(!s)fail('Dağılım bulunamadı.',404);if(s.status!=='active')fail('Bu dağılım zaten geri alındı.',409);await db.batch([db.prepare("UPDATE purchase_line_splits SET status='reversed' WHERE id=?").bind(s.id)]);return {id:invoice.id};}
  const x=await readBody(request),line=await db.prepare('SELECT * FROM purchase_lines WHERE id=? AND invoice_id=?').bind(x.line_id||'',invoice.id).first();if(!line)fail('Satır bulunamadı veya daha önce dağıtıldı.',409);
  if(line.line_type!=='product'||line.split_id)fail('Bu satır dağıtılamaz. Önce mevcut dağılımı geri alın.',409);
  if(x.equal_unit_cost!==true)fail('Bu dağılım aynı birim maliyetli çeşitler içindir.');
  if(typeof x.reason!=='string'||!x.reason.trim()||x.reason.length>500)fail('Çeşit adetlerinin kaynağını belirtin: irsaliye, tedarikçi dökümü veya mal kabul.');
  if(!Array.isArray(x.allocations)||x.allocations.length<2||x.allocations.length>20||new Set(x.allocations.map(a=>a?.product_id)).size!==x.allocations.length)fail('2–20 farklı stok ürünü seçin.');
  const products=(await db.prepare('SELECT id,name,stock_unit FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(x.allocations.map(a=>a.product_id))).all()).results;
  if(products.length!==x.allocations.length||new Set(products.map(p=>p.stock_unit)).size!==1)fail('Çeşitler bu çalışma alanında ve aynı stok biriminde olmalı.');
  const total=q(x.total_quantity),items=x.allocations.map(a=>({...a,quantity_milli:q(a.quantity)}));if(items.reduce((s,a)=>s+a.quantity_milli,0)!==total)fail('Çeşitlerin toplamı beklenen toplam stok miktarına eşit olmalı.');
  if(line.quantity_milli!==null&&line.quantity_milli!==total)fail('Toplam, satırın kayıtlı stok miktarıyla uyuşmuyor. Önce eşleştirmeyi düzeltin.');
  const sourceQty=q(line.invoice_quantity),den=BigInt(total);let cumulative=0,prevNet=0,prevTax=0,prevQty=0;
  const allocations=items.map(a=>{cumulative+=a.quantity_milli;const net=round(BigInt(line.net_cents)*BigInt(cumulative),den),tax=round(BigInt(line.tax_cents)*BigInt(cumulative),den),iq=round(BigInt(sourceQty)*BigInt(cumulative),den);const row={id:crypto.randomUUID(),product_id:a.product_id,name:products.find(p=>p.id===a.product_id).name,quantity_milli:a.quantity_milli,invoice_quantity:(iq-prevQty)/1000,net_cents:net-prevNet,tax_cents:tax-prevTax};prevNet=net;prevTax=tax;prevQty=iq;if(row.invoice_quantity<=0)fail('Fatura birimi bu kadar küçük çeşitlere dağıtılamıyor. Birim dönüşümünü kontrol edin.');return row;});
  const id=crypto.randomUUID();await db.batch([db.prepare('INSERT INTO purchase_line_splits(id,invoice_id,original_line_id,original_json,allocations_json,reason,stock_unit,total_quantity_milli) VALUES(?,?,?,?,?,?,?,?)').bind(id,invoice.id,line.id,JSON.stringify(line),JSON.stringify(allocations),x.reason.trim(),products[0].stock_unit,total)]);
  return {id:invoice.id,split_id:id};
 }catch(e){if(e.status)throw e;if(/SPLIT_|IMMUTABLE_|UNIQUE constraint/.test(e.message))fail('Dağılım kaydedilemedi: fatura değişmiş, dağıtılmış veya kilitlenmiş olabilir. Faturayı yenileyin.',409);throw e;}
}
