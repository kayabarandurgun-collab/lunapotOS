import {applyPurchaseMappings} from './purchase-mapping.js';
import {cents as rawCents,milli as rawMilli} from '../public/accounting-math.js';
import {integrationStatus,previewIntegration} from './integrations.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const cents=v=>{try{return rawCents(v);}catch(e){fail(e.message);}};
const milli=v=>{try{return rawMilli(v);}catch(e){fail(e.message);}};
const text=(v,label,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const optional=v=>typeof v==='string'?v.trim():'';
const invoiceKey=v=>v.replace(/\s+/g,'').toUpperCase();
function expenseTreatment(type,category,value){
 if(type!=='expense')return null;
 if(value!==undefined&&value!==null&&value!==''&&!['general','sales_fee'].includes(value))fail('Giderin nasıl işleneceğini seçin.');
 if(value==='general'||value==='sales_fee')return value;
 return ['shipping','commission'].includes(category)?null:'general';
}
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const localDay=(timestamp=Date.now())=>new Date(timestamp).toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
const amount=(v,negative=false)=>{const n=cents(v);if(!negative&&n<0)fail('Tutar negatif olamaz.');return n;};
const fee=(v,negative=false)=>v===null||v===undefined||v===''?null:amount(v,negative);
const id=()=>crypto.randomUUID();
const statement=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const log=(db,message)=>statement(db,'INSERT INTO activity(id,description) VALUES(?,?)',[id(),message]);
async function batch(db,items){try{return await db.batch(items);}catch(e){
 const message=String(e.message);
 if(message.includes('SPLIT_LOCKED'))fail('Çeşit dağılımını değiştirmek için önce dağılımı geri alın.',409);
 if(message.includes('PRODUCT_UNIT_LOCKED'))fail('Bağlantısı veya işlem geçmişi olan ürünün stok birimi değiştirilemez.',409);
 if(message.includes('INSUFFICIENT_STOCK'))fail('Stok yetersiz. Önce alış veya açılış stok hareketi girin.',409);
 if(message.includes('STOCK_RESERVED'))fail('Bu stok siparişlere ayrılmış veya çıkış miktarı eldeki stoktan fazla.',409);
 if(message.includes('RETURN_EXCEEDS_SALE')||message.includes('REFUND_EXCEEDS_SALE'))fail('Toplam iade, satış miktarını veya tutarını aşıyor.',409);
 if(message.includes('UNMAPPED_INVOICE'))fail('Tüm fatura satırlarını ürün ve stok miktarıyla eşleştirin.',409);
 if(message.includes('UNCLASSIFIED_FEE'))fail('Kargo ve komisyon satırlarının genel gider mi, satışlara dağıtılacak kesinti mi olduğunu seçin.',409);
 if(message.includes('RECONCILED_FEE_LOCKED'))fail('Bu kesinti faturaya bağlı. Düzeltmeyi kesinti eşleştirmesinden yapın.',409);
 if(message.includes('RECEIPT_'))fail('Teslim miktarı faturayı aşıyor veya fatura henüz muhasebeleştirilmedi.',409);
 if(message.includes('UNIQUE constraint'))fail('Bu referans veya fatura zaten kaydedilmiş. Aynı kayıt ikinci kez işlenmedi.',409);
 if(message.includes('INVOICE_ALREADY_HANDLED')||message.includes('IMMUTABLE_INVOICE'))fail('Bu fatura daha önce işlendi.',409);
 throw e;
}}
export async function accountingApi(request,env,path,readBody){
 const db=env.DB,url=new URL(request.url),method=request.method,receiptTable=env.WORKSPACE==='ec'?'effective_receipts':'goods_receipts';
 if(path.startsWith('/api/accounting/integrations')&&env.WORKSPACE!=='ec')fail('Bu bağlantılar e-ticaret çalışma alanına aittir.',403);
 if(path==='/api/accounting/products'&&method==='POST'&&env.WORKSPACE==='ec'){
  const x=await readBody(request),key=id();if(!['adet','kg','g','L','ml'].includes(x.stock_unit))fail('Stok birimi geçersiz.');
  await batch(db,[statement(db,'INSERT INTO products(id,name,sku,category,stock_unit,min_stock_milli) VALUES(?,?,?,?,?,?)',[key,text(x.name,'Ürün adı'),text(x.sku,'Ürün kodu'),optional(x.category).slice(0,100),x.stock_unit,x.min_stock===0?0:milli(x.min_stock)]),log(db,'E-ticaret ürünü eklendi')]);return {id:key};
 }
 const productMatch=path.match(/^\/api\/accounting\/products\/([\w-]+)$/);
 if(productMatch&&method==='POST'&&env.WORKSPACE==='ec'){
  const x=await readBody(request),key=productMatch[1],old=await statement(db,'SELECT * FROM products WHERE id=?',[key]).first();if(!old)fail('Ürün bulunamadı.',404);
  if(!['adet','kg','g','L','ml'].includes(x.stock_unit))fail('Stok birimi geçersiz.');
  if(old.stock_unit!==x.stock_unit&&(await statement(db,'SELECT id FROM stock_movements WHERE product_id=? LIMIT 1',[key]).first()||await statement(db,'SELECT id FROM purchase_lines WHERE product_id=? LIMIT 1',[key]).first()||await statement(db,'SELECT id FROM catalog_mapping_components WHERE product_id=? LIMIT 1',[key]).first()||await statement(db,'SELECT id FROM order_line_components WHERE product_id=? LIMIT 1',[key]).first()))fail('Hareketi, fatura veya ilan bağlantısı olan ürünün stok birimi değiştirilemez.',409);
  await batch(db,[statement(db,'UPDATE products SET name=?,sku=?,stock_unit=?,min_stock_milli=? WHERE id=?',[text(x.name,'Ürün adı'),text(x.sku,'Ürün kodu'),x.stock_unit,x.min_stock===0?0:milli(x.min_stock),key]),log(db,'E-ticaret ürünü güncellendi')]);return {id:key};
 }
 if(path==='/api/accounting/integrations'&&method==='GET')return {providers:integrationStatus(env),runs:(await db.prepare('SELECT * FROM integration_runs ORDER BY created_at DESC LIMIT 20').all()).results};
 if(path.startsWith('/api/accounting/integrations/')&&method==='POST')return previewIntegration(env,path.split('/').at(-1),await readBody(request));
 if(path==='/api/accounting'&&method==='GET'){
  const from=day(url.searchParams.get('from')||localDay(Date.now()-30*86400000)),to=day(url.searchParams.get('to')||localDay());if(from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
  const queries=[
   db.prepare(`SELECT p.id,p.name,p.sku,p.stock_unit,p.min_stock_milli,b.quantity_milli,b.value_cents,${env.WORKSPACE==='ec'?"COALESCE((SELECT SUM(r.quantity_milli) FROM order_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0)":'0'} reserved_milli FROM products p JOIN stock_balances b ON b.product_id=p.id ORDER BY p.name`),
   statement(db,'SELECT s.*,p.name product_name,p.sku FROM sale_entries s JOIN products p ON p.id=s.product_id WHERE s.occurred_on BETWEEN ? AND ? ORDER BY s.occurred_on DESC,s.created_at DESC LIMIT 5001',[from,to]),
   statement(db,'SELECT * FROM expenses WHERE occurred_on BETWEEN ? AND ? ORDER BY occurred_on DESC LIMIT 5001',[from,to]),
   db.prepare('SELECT s.*,COALESCE((SELECT SUM(l.net_cents+l.tax_cents) FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.supplier_id=s.id AND i.status=\'posted\'),0) purchase_cents,COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE supplier_id=s.id),0) paid_cents,COALESCE((SELECT SUM(amount_cents) FROM party_entries WHERE party_id=s.id),0) balance_cents FROM suppliers s ORDER BY name'),
   db.prepare('SELECT i.*,s.name supplier_name,COALESCE(SUM(l.net_cents),0) net_cents,COALESCE(SUM(l.tax_cents),0) tax_cents,COUNT(l.id) line_count FROM purchase_invoices i JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN purchase_lines l ON l.invoice_id=i.id GROUP BY i.id ORDER BY i.created_at DESC LIMIT 200'),
   db.prepare(`SELECT m.*,p.name product_name,p.stock_unit${env.WORKSPACE==='lp'?',p.inventory_kind':''} FROM stock_movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 200`),
   db.prepare("SELECT COALESCE(SUM(l.net_cents-COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0)),0) pending_fee_cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee'")
  ];
  const [stock,sales,expenses,suppliers,invoices,movements,pendingFees]=(await db.batch(queries)).map(q=>q.results);
  if(sales.length>5000||expenses.length>5000)fail('Bu aralıkta 5.000’den fazla kayıt var. Doğru toplam için tarih aralığını daraltın.');
  const adjustments=env.WORKSPACE==='ec'?(await statement(db,`SELECT id,reference,'purchase_variance' category,iif(reversal_of IS NULL,cost_cents-net_cents,net_cents-cost_cents) amount_cents,occurred_on,0 paid,reason notes FROM purchase_returns WHERE occurred_on BETWEEN ? AND ? AND cost_cents!=net_cents ORDER BY occurred_on DESC LIMIT 5001`,[from,to]).all()).results:[];
  if(adjustments.length>5000)fail('Çok fazla iade maliyet farkı var; tarih aralığını daraltın.',409);
  return {from,to,stock,sales,expenses:[...expenses,...adjustments],suppliers,invoices,movements,pending_fee_cents:pendingFees[0].pending_fee_cents};
 }
 if(path==='/api/accounting/suppliers'&&method==='POST'){
  const x=await readBody(request),key=id(),tax=optional(x.tax_id);if(tax&&!/^\d{10,11}$/.test(tax))fail('VKN/TCKN 10 veya 11 rakam olmalı.');
  if(tax){const existing=await statement(db,'SELECT id FROM suppliers WHERE tax_id=?',[tax]).first();if(existing)return {id:existing.id,existing:true};}
  await batch(db,[statement(db,'INSERT INTO suppliers(id,name,tax_id,contact) VALUES(?,?,?,?)',[key,text(x.name,'Tedarikçi adı'),tax||null,optional(x.contact).slice(0,500)]),log(db,'Tedarikçi eklendi')]);return {id:key};
 }
 if(path==='/api/accounting/payments'&&method==='POST'){
  const x=await readBody(request),key=id();await batch(db,[statement(db,'INSERT INTO supplier_payments(id,supplier_id,reference,amount_cents,occurred_on,notes) VALUES(?,?,?,?,?,?)',[key,text(x.supplier_id,'Tedarikçi'),text(x.reference,'Ödeme referansı'),amount(x.amount),day(x.occurred_on),optional(x.notes).slice(0,2000)]),log(db,'Tedarikçi ödeme kaydı eklendi')]);return {id:key};
 }
 if(path==='/api/accounting/stock'&&method==='POST'){
  const x=await readBody(request),product=text(x.product_id,'Ürün'),qty=x.quantity===0?0:milli(x.quantity),key=id(),kind=x.kind==='opening'?'opening':'count';
  const b=await statement(db,'SELECT * FROM stock_balances WHERE product_id=?',[product]).first();if(!b)fail('Ürün bulunamadı.',404);
  const reason=text(x.notes,'Hareket açıklaması',1000),reference=text(x.reference,'Referans'),date=day(x.occurred_on),unitCost=amount(x.unit_cost??0);
  if((kind==='opening'||qty>b.quantity_milli)&&(x.unit_cost===null||x.unit_cost===undefined||x.unit_cost===''))fail('Stoğa giren ürünün KDV hariç birim maliyetini girin.');
  if(kind==='opening'){
   if(qty<=0)fail('Açılış miktarı sıfırdan büyük olmalı.');
   await batch(db,[statement(db,"INSERT INTO stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT ?,product_id,?,?,'opening',?,?,? FROM stock_balances WHERE product_id=? AND NOT EXISTS(SELECT 1 FROM stock_movements WHERE product_id=?) RETURNING id",[key,qty,Math.round(qty*unitCost/1000),reference,reason,date,product,product])]);
   if(!await statement(db,'SELECT id FROM stock_movements WHERE id=?',[key]).first())fail('Bu üründe hareket var. Açılış yerine sayım düzeltmesini kullanın.',409);
  }else{
   if(qty===b.quantity_milli)fail('Sayım miktarı mevcut stokla aynı.');
   const result=await batch(db,[statement(db,"INSERT INTO stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT ?,product_id,?-quantity_milli,CASE WHEN ?>quantity_milli THEN CAST(ROUND((?-quantity_milli)*?/1000.0) AS INTEGER) ELSE -CAST(ROUND(value_cents*(quantity_milli-?)/MAX(quantity_milli,1.0)) AS INTEGER) END,'count',?,?,? FROM stock_balances WHERE product_id=? AND quantity_milli!=? AND quantity_milli=? AND value_cents=? RETURNING id",[key,qty,qty,qty,unitCost,qty,reference,reason,date,product,qty,b.quantity_milli,b.value_cents])]);
   if(!result[0].results.length)fail('Stok işlem sırasında değişti. Sayım ekranını yenileyin.',409);
  }return {id:key};
 }
 if(path==='/api/accounting/sales'&&method==='POST'){
  const x=await readBody(request),key=id(),product=text(x.product_id,'Ürün'),qty=milli(x.quantity),channel=x.channel;
  if(!await statement(db,'SELECT product_id FROM stock_balances WHERE product_id=?',[product]).first())fail('Bu çalışma alanında ürün bulunamadı.',404);
  if(!['trendyol','hepsiburada','other'].includes(channel))fail('Satış kanalı geçersiz.');
  const values=[key,channel,text(x.external_id,'Sipariş satırı referansı'),product,qty,amount(x.revenue),fee(x.commission),fee(x.shipping),fee(x.other),x.fees_status==='confirmed'?'confirmed':'pending',day(x.occurred_on),optional(x.notes).slice(0,2000)];
  const result=await batch(db,[statement(db,"INSERT INTO sale_entries(id,channel,external_id,product_id,quantity_milli,revenue_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on,notes,kind,cost_cents) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'sale',CAST(ROUND(value_cents*?/MAX(quantity_milli,1.0)) AS INTEGER) FROM stock_balances WHERE product_id=? RETURNING id",[...values,qty,product]),log(db,'Satış ve stok çıkışı kaydedildi')]);
  if(!result[0].results.length)fail('Ürün bulunamadı.',404);return {id:key};
 }
 const returnMatch=path.match(/^\/api\/accounting\/sales\/([\w-]+)\/return$/);
 if(returnMatch&&method==='POST'){
  const x=await readBody(request),key=id(),parent=returnMatch[1],qty=milli(x.quantity),restock=x.restock===true?1:0;
  const original=await statement(db,"SELECT id FROM sale_entries WHERE id=? AND kind='sale'",[parent]).first();if(!original)fail('Asıl satış bulunamadı.',404);
  await batch(db,[statement(db,"INSERT INTO sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on,notes) SELECT ?,channel,?,product_id,'return',id,?,-?,CASE WHEN ?=1 THEN -(CAST(ROUND(cost_cents*(COALESCE((SELECT SUM(quantity_milli) FROM sale_entries r WHERE r.parent_id=s.id),0)+?)/(quantity_milli*1.0)) AS INTEGER)-CAST(ROUND(cost_cents*COALESCE((SELECT SUM(quantity_milli) FROM sale_entries r WHERE r.parent_id=s.id),0)/(quantity_milli*1.0)) AS INTEGER)) ELSE 0 END,?,?,?, ?,?,?,? FROM sale_entries s WHERE id=?",[key,text(x.external_id,'İade referansı'),qty,amount(x.revenue),restock,qty,fee(x.commission,true),fee(x.shipping,true),fee(x.other,true),x.fees_status==='confirmed'?'confirmed':'pending',restock,day(x.occurred_on),optional(x.notes).slice(0,2000),parent]),log(db,'Satış iadesi kaydedildi')]);return {id:key};
 }
 const feeMatch=path.match(/^\/api\/accounting\/sales\/([\w-]+)\/fees$/);
 if(feeMatch&&method==='POST'){
  const x=await readBody(request),key=feeMatch[1],old=await statement(db,'SELECT * FROM sale_entries WHERE id=?',[key]).first();if(!old)fail('Satış bulunamadı.',404);
  const negative=old.kind==='return',values=[fee(x.commission,negative),fee(x.shipping,negative),fee(x.other,negative),x.fees_status==='confirmed'?'confirmed':'pending',key];
  await batch(db,[statement(db,'UPDATE sale_entries SET commission_cents=?,shipping_cents=?,other_cents=?,fees_status=? WHERE id=?',values),statement(db,'INSERT INTO fee_audit(id,sale_id,old_values,new_values) VALUES(?,?,?,?)',[id(),key,JSON.stringify({commission:old.commission_cents,shipping:old.shipping_cents,other:old.other_cents,status:old.fees_status}),JSON.stringify(values.slice(0,4))]),log(db,'Satış giderleri güncellendi')]);return {id:key};
 }
 if(path==='/api/accounting/expenses'&&method==='POST'){
  const x=await readBody(request),key=id();if(!['shipping','commission','advertising','rent','packaging','other'].includes(x.category))fail('Gider kategorisi geçersiz.');
  await batch(db,[statement(db,'INSERT INTO expenses(id,reference,category,amount_cents,occurred_on,paid,notes) VALUES(?,?,?,?,?,?,?)',[key,text(x.reference,'Gider referansı'),x.category,amount(x.amount),day(x.occurred_on),x.paid===true?1:0,optional(x.notes).slice(0,2000)]),log(db,'Genel gider kaydedildi')]);return {id:key};
 }
 const invoiceMatch=path.match(/^\/api\/accounting\/invoices\/([\w-]+)(?:\/(post|cancel|receive))?$/);
 if(invoiceMatch&&method==='GET'){
  const invoice=await statement(db,'SELECT * FROM purchase_invoices WHERE id=?',[invoiceMatch[1]]).first();if(!invoice)fail('Fatura bulunamadı.',404);
  const returns=env.WORKSPACE==='ec'?(await statement(db,'SELECT r.*,(SELECT id FROM purchase_returns x WHERE x.reversal_of=r.id) reversed_by FROM purchase_returns r JOIN purchase_lines l ON l.id=r.line_id WHERE l.invoice_id=? ORDER BY r.created_at,r.rowid',[invoice.id]).all()).results:[];
  const reversals=env.WORKSPACE==='ec'?(await statement(db,'SELECT x.* FROM receipt_reversals x JOIN goods_receipts g ON g.id=x.receipt_id JOIN purchase_lines l ON l.id=g.line_id WHERE l.invoice_id=?',[invoice.id]).all()).results:[];
  return {...invoice,returns,receipt_reversals:reversals,splits:(await statement(db,'SELECT * FROM purchase_line_splits WHERE invoice_id=? ORDER BY created_at',[invoice.id]).all()).results.map(s=>({...s,original:JSON.parse(s.original_json),allocations:JSON.parse(s.allocations_json)})),lines:(await statement(db,`SELECT l.*,COALESCE((SELECT SUM(quantity_milli) FROM ${receiptTable} WHERE line_id=l.id),0) received_milli FROM purchase_lines l WHERE invoice_id=? ORDER BY rowid`,[invoice.id]).all()).results,receipts:(await statement(db,'SELECT r.* FROM goods_receipts r JOIN purchase_lines l ON l.id=r.line_id WHERE l.invoice_id=? ORDER BY r.created_at',[invoice.id]).all()).results};
 }
 if(path==='/api/accounting/invoices'&&method==='POST'){
  const x=await readBody(request),key=id();if(x.currency!=='TRY')fail('Bu sürümde yalnızca TRY faturalar işlenir.');
  if(!Array.isArray(x.lines)||x.lines.length<1||x.lines.length>40)fail('Faturada 1–40 satır olmalı.');
  const supplier=text(x.supplier_id,'Tedarikçi'),party=await statement(db,'SELECT id,tax_id FROM suppliers WHERE id=?',[supplier]).first();if(!party)fail('Tedarikçi bulunamadı.');
  const rootDB=env.ROOT_DB||db,settings=await statement(rootDB,'SELECT * FROM workspace_settings WHERE workspace=?',[env.WORKSPACE]).first(),receiver=optional(x.receiver_tax_id);
  if(x.source==='xml'&&(!settings?.tax_id||receiver!==settings.tax_id))fail('Faturanın alıcı vergi numarası bu alanın şirketiyle eşleşmiyor. Önce Şirket ve yedek ekranını kontrol edin.',409);
  const invoiceNo=text(x.invoice_no,'Fatura numarası'),uuid=optional(x.uuid).toLowerCase();
  const registryKeys=[party.tax_id?'invoice:'+party.tax_id+':'+invoiceKey(invoiceNo):'manual:'+env.WORKSPACE+':'+supplier+':'+invoiceKey(invoiceNo)];
  if(uuid)registryKeys.push('uuid:'+uuid);
  const registered=await statement(rootDB,'SELECT workspace FROM document_registry WHERE document_key IN ('+registryKeys.map(()=>'?').join(',')+') LIMIT 1',registryKeys).first();
  if(registered)fail('Bu belge '+(registered.workspace==='ec'?'E-Ticaret':'Lunapot')+' alanında zaten kayıtlı. İkinci kez işlenmedi.',409);
  for(const line of x.lines)if(!line||typeof line!=='object')fail('Fatura satırı geçersiz.');
  const mappedLines=await applyPurchaseMappings(db,supplier,x.lines);
  const statements=[statement(db,'INSERT INTO purchase_invoices(id,supplier_id,invoice_no,uuid,invoice_date,currency,source,notes,receiver_tax_id) VALUES(?,?,?,?,?,?,?,?,?)',[key,supplier,text(x.invoice_no,'Fatura numarası'),optional(x.uuid)||null,day(x.invoice_date),'TRY',x.source==='xml'?'xml':'manual',optional(x.notes).slice(0,2000),receiver])];
  for(const registryKey of registryKeys)statements.push(statement(rootDB,'INSERT INTO document_registry(document_key,workspace,invoice_id) VALUES(?,?,?)',[registryKey,env.WORKSPACE,key]));
  for(const line of mappedLines){milli(line.invoice_quantity);const type=line.line_type==='expense'?'expense':'product',category=['shipping','commission','advertising','rent','packaging','other'].includes(line.expense_category)?line.expense_category:'other';statements.push(statement(db,'INSERT INTO purchase_lines(id,invoice_id,description,external_code,invoice_quantity,invoice_unit,product_id,quantity_milli,net_cents,tax_cents,line_type,expense_category,expense_treatment,catalog_mapping_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id(),key,text(line.description,'Satır açıklaması',300),optional(line.external_code).slice(0,100),line.invoice_quantity,text(line.invoice_unit,'Fatura birimi',30),type==='product'?line.product_id||null:null,type==='product'&&line.product_id?milli(line.stock_quantity):null,amount(line.net),amount(line.tax),type,category,expenseTreatment(type,category,line.expense_treatment),line.catalog_mapping_id||null]));}
  statements.push(log(db,'Alış faturası incelemeye alındı'));await batch(db,statements);return {id:key};
 }
 if(invoiceMatch&&method==='POST'){
  const [,key,action]=invoiceMatch,x=await readBody(request),existing=await statement(db,'SELECT status,supplier_id FROM purchase_invoices WHERE id=?',[key]).first();if(!existing)fail('Fatura bulunamadı.',404);
  if(action==='receive'){
   if(existing.status!=='posted')fail('Önce faturayı muhasebeleştirin.',409);
   if(!Array.isArray(x.lines)||!x.lines.length||x.lines.length>40||new Set(x.lines.map(l=>l.id)).size!==x.lines.length)fail('Teslim satırlarını kontrol edin.');
   const date=day(x.occurred_on),reference=text(x.reference,'Teslim referansı'),statements=[];
   const receiptLines=new Set((await statement(db,"SELECT id FROM purchase_lines WHERE invoice_id=? AND line_type='product'",[key]).all()).results.map(l=>l.id));
   for(const line of x.lines){const q=milli(line.quantity);if(!receiptLines.has(line.id))fail('Bu faturada ürün satırı bulunamadı.',404);
    statements.push(statement(db,`INSERT INTO goods_receipts(id,line_id,quantity_milli,value_cents,occurred_on,reference) SELECT ?,id,?,CAST(ROUND(net_cents*(?+COALESCE((SELECT SUM(quantity_milli) FROM ${receiptTable} WHERE line_id=l.id),0))/(quantity_milli*1.0)) AS INTEGER)-COALESCE((SELECT SUM(value_cents) FROM ${receiptTable} WHERE line_id=l.id),0),?,? FROM purchase_lines l WHERE id=?`,[id(),q,q,date,reference,line.id]));
   }await batch(db,[...statements,log(db,'Mal teslimi kaydedildi; eldeki stok güncellendi')]);return {id:key};
  }
  if(existing.status!=='draft')fail('Bu fatura daha önce işlendi.',409);
  if(action==='cancel'){await batch(db,[statement(db,"UPDATE purchase_invoices SET status='cancelled' WHERE id=? AND status='draft'",[key])]);return {id:key};}
  if(action==='post'){await batch(db,[statement(db,"UPDATE purchase_invoices SET status='posted' WHERE id=? AND status='draft'",[key]),log(db,'Alış faturası muhasebeleştirildi; mal teslimi bekleniyor')]);return {id:key};}
  if(!Array.isArray(x.lines)||x.lines.length>40)fail('Fatura eşleştirmesi geçersiz.');const lines=(await statement(db,'SELECT * FROM purchase_lines WHERE invoice_id=?',[key]).all()).results;
  if(lines.length!==x.lines.length||new Set(x.lines.map(l=>l.id)).size!==lines.length)fail('Tüm satırlar bir kez eşleştirilmeli.');
  for(const line of x.lines)if(!line||!lines.some(old=>old.id===line.id))fail('Satır bulunamadı.');
  const mappedLines=await applyPurchaseMappings(db,existing.supplier_id,x.lines.map(l=>({...lines.find(old=>old.id===l.id),...l})),{autoAssign:false,existing:lines});
  const statements=mappedLines.map(l=>{const type=l.line_type==='expense'?'expense':'product',category=['shipping','commission','advertising','rent','packaging','other'].includes(l.expense_category)?l.expense_category:'other';return statement(db,'UPDATE purchase_lines SET product_id=?,quantity_milli=?,line_type=?,expense_category=?,expense_treatment=?,catalog_mapping_id=? WHERE id=? AND invoice_id=?',[type==='product'?l.product_id||null:null,type==='product'&&l.product_id?milli(l.stock_quantity):null,type,category,expenseTreatment(type,category,l.expense_treatment),l.catalog_mapping_id||null,l.id,key]);});await batch(db,statements);return {id:key};
 }
 fail('İşlem bulunamadı.',404);
}
