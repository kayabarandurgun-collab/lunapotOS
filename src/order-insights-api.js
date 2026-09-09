import {filterInsights} from './permission-policy.js';
import {compositionKey,parcelTemplateKey,useParcelTemplate} from './order-estimate-api.js';
import {packageProfit} from './package-profit.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const all=async q=>(await q.all()).results;
const text=(v,label,max=300,required=false)=>{if(v===undefined||v===null)v='';if(typeof v!=='string'||v.length>max||required&&!v.trim())fail(label+' alanını kontrol edin.');return v.trim();};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Taslak tarihi geçersiz.');return v;};
const integer=(v,name,max=10000000000)=>{if(!Number.isSafeInteger(v)||v<0||v>max)fail(name+' eksik veya geçersiz.');return v;};
const unpack=row=>row?{id:row.id,package_id:row.package_id,version:row.version,status:row.status,snapshot:JSON.parse(row.snapshot_json),created_at:row.created_at}:null;
async function orderData(env,key){
 const db=env.DB,p=await stmt(db,'SELECT * FROM order_packages WHERE id=?',[key]).first();if(!p)fail('Sipariş bu çalışma alanında bulunamadı.',404);
 const sourceRows=p.channel==='trendyol'?await all(stmt(db,"SELECT r.id,r.provider,r.fingerprint,r.source_updated_at,r.last_seen_at,r.payload_json FROM provider_records r JOIN provider_connections co ON co.provider=r.provider AND co.seller_id=r.seller_id WHERE r.provider=? AND r.kind='orders' AND r.external_id=? ORDER BY r.source_updated_at DESC,r.last_seen_at DESC,r.rowid DESC LIMIT 1",[p.channel,p.external_id])):[];
 const [lines,components,sales,drafts,purchases,feeEvidence]=await Promise.all([
  all(stmt(db,'SELECT * FROM order_lines WHERE package_id=? ORDER BY rowid',[key])),
  all(stmt(db,'SELECT c.*,pr.name product_name,pr.sku FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN products pr ON pr.id=c.product_id WHERE l.package_id=? ORDER BY l.rowid,c.rowid',[key])),
  all(stmt(db,'SELECT s.* FROM sale_entries s WHERE s.id IN (SELECT c.sale_id FROM order_line_components c JOIN order_lines l ON l.id=c.line_id WHERE l.package_id=?) OR s.parent_id IN (SELECT c.sale_id FROM order_line_components c JOIN order_lines l ON l.id=c.line_id WHERE l.package_id=?) ORDER BY s.occurred_on,s.rowid',[key,key])),
  all(stmt(db,'SELECT * FROM sales_invoice_drafts WHERE package_id=? ORDER BY version DESC LIMIT 20',[key])),
  all(stmt(db,"SELECT i.id invoice_id,i.invoice_no,i.uuid,i.invoice_date,s.name supplier_name,l.product_id,pr.name product_name,r.quantity_milli received_milli,r.value_cents,r.occurred_on receipt_date,r.reference receipt_reference FROM goods_receipts r JOIN purchase_lines l ON l.id=r.line_id JOIN purchase_invoices i ON i.id=l.invoice_id JOIN suppliers s ON s.id=i.supplier_id JOIN products pr ON pr.id=l.product_id WHERE l.product_id IN (SELECT c.product_id FROM order_line_components c JOIN order_lines ol ON ol.id=c.line_id WHERE ol.package_id=?) ORDER BY r.occurred_on DESC,r.created_at DESC,r.rowid DESC LIMIT 51",[key])),
  all(stmt(db,'SELECT a.id,a.sale_id,a.component,a.amount_cents,a.reversed_at,i.id invoice_id,i.invoice_no,i.invoice_date,l.description FROM fee_allocations a JOIN purchase_lines l ON l.id=a.invoice_line_id JOIN purchase_invoices i ON i.id=l.invoice_id WHERE a.sale_id IN (SELECT c.sale_id FROM order_line_components c JOIN order_lines ol ON ol.id=c.line_id WHERE ol.package_id=?) ORDER BY a.created_at DESC LIMIT 100',[key]))
 ]);
 let source=null,customer=null,sourceFacts=null;if(sourceRows.length){const row=sourceRows[0];try{const payload=JSON.parse(row.payload_json);customer=payload.customer||null;source={record_id:row.id,provider:row.provider,fingerprint:row.fingerprint,source_updated_at:row.source_updated_at,last_seen_at:row.last_seen_at,invoice:payload.invoice||null};sourceFacts={currency:payload.currency,external_status:payload.external_status,carrier:payload.carrier,package_gross:payload.package_gross,package_price:payload.package_price,package_seller_discount:payload.package_seller_discount,package_platform_discount:payload.package_platform_discount};}catch{source={record_id:row.id,provider:row.provider,error:'Kaynak ayrıntısı okunamadı.'};}}
 let parcelInput=null,parcelInputSource=null;
 if(!p.source_changed){
  const saved=await stmt(db,'SELECT * FROM order_estimate_inputs WHERE package_id=?',[p.id]).first();
  if(saved){if(saved.source_fingerprint===p.source_fingerprint&&saved.composition_key===compositionKey(lines,components)){parcelInput=JSON.parse(saved.input_json);parcelInputSource='package';}}
  else {const template=await stmt(db,'SELECT * FROM parcel_templates WHERE template_key=?',[parcelTemplateKey(p,lines,components)]).first();if(template){parcelInput=useParcelTemplate(JSON.parse(template.input_json),lines,components);parcelInputSource='identical_contents_template';}}
 }
 const profit=packageProfit(p,lines,components,sales),totals=profit.totals,allFees=field=>sales.every(s=>s[field]!==null&&s[field]!==undefined)?sales.reduce((sum,s)=>sum+s[field],0):null;
 const actualSummary={status:profit.status,reasons:profit.reasons,order_net_cents:lines.every(l=>l.net_revenue_cents!==null)?lines.reduce((sum,l)=>sum+l.net_revenue_cents,0):null,revenue_net_cents:sales.length?totals.revenue:null,cost_net_cents:sales.length?totals.cost:null,commission_cents:sales.length?allFees('commission_cents'):null,shipping_cents:sales.length?allFees('shipping_cents'):null,other_cents:sales.length?allFees('other_cents'):null,profit_cents:profit.profit_cents,estimated_profit_cents:profit.estimated_profit_cents,missing_fee_count:totals.missing,unconfirmed_count:totals.unconfirmed};
 return {package:p,lines,components,sales,parcel_input:parcelInput,parcel_input_source:parcelInputSource,actual_summary:actualSummary,customer,source,source_facts:sourceFacts,purchase_invoices:purchases.slice(0,50).map(r=>({...r,source:'recent_receipt_not_exact_lot'})),purchase_invoices_truncated:purchases.length>50,fee_evidence:feeEvidence,drafts:drafts.map(unpack),invoice_status:'draft_only',notices:['Alış belgeleri bu stok kartlarının son mal teslimleridir. Satış maliyeti ağırlıklı ortalamadır; kesin parti/fatura çıkışı olduğu iddia edilmez.','Yerel satış faturası taslağı resmî fatura değildir. EDM/GİB gönderimi yapılmaz.',...(p.channel==='hepsiburada'?['Hepsiburada kaynakları henüz paket düzeyinde doğrulanmadığından müşteri ayrıntısı otomatik eşleştirilmedi.']:[])]};
}
function billingData(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Fatura alıcısı gerekli.');
 const result={name:text(input.name,'Alıcı adı'),company:text(input.company,'Alıcı şirketi'),tax_id:text(input.tax_id,'VKN/TCKN',11),tax_office:text(input.tax_office,'Vergi dairesi'),address:text(input.address,'Fatura adresi',1000,true),district:text(input.district,'İlçe'),city:text(input.city,'İl',200,true),postal_code:text(input.postal_code,'Posta kodu',20),country:text(input.country,'Ülke kodu',2,true).toUpperCase()};
 if(!result.name&&!result.company)fail('Alıcı adı veya şirketi gerekli.');if(result.tax_id&&!/^\d{10,11}$/.test(result.tax_id))fail('VKN/TCKN 10 veya 11 rakam olmalı.');if(!/^[A-Z]{2}$/.test(result.country))fail('İki harfli ülke kodu gerekli.');return result;
}
export async function orderInsightsApi(request,env,path,readBody){
 const match=path.match(/^\/api\/orders\/([\w-]+)\/(insights|invoice-draft)$/);if(!match)return null;
 if(env.WORKSPACE!=='ec')fail('Sipariş ayrıntıları e-ticaret çalışma alanına aittir.',403);
 if(match[2]==='insights'&&request.method==='GET')return filterInsights(await orderData(env,match[1]),env.USER,env.WORKSPACE);
 if(match[2]!=='invoice-draft'||request.method!=='POST')return null;
 const x=await readBody(request),data=await orderData(env,match[1]),date=day(x.issue_date),billing=billingData(x.billing),notes=text(x.notes,'Notlar',2000);
 if(data.package.status==='cancelled'||data.package.source_changed)fail('İptal edilmiş veya kaynak değişikliği bekleyen siparişe taslak hazırlanamaz.',409);
 if(date<data.package.occurred_on)fail('Taslak tarihi siparişten önce olamaz.');
 const root=env.ROOT_DB||env.DB,issuer=await stmt(root,'SELECT legal_name,tax_id FROM workspace_settings WHERE workspace=?',['ec']).first();
 if(!issuer?.legal_name||!issuer?.tax_id)fail('Önce şirket unvanı ve vergi numarasını tamamlayın.',409);
 const lines=data.lines.map(l=>{
  const gross=integer(l.gross_cents,'Satır KDV dahil tutarı'),net=integer(l.net_revenue_cents,'Satır KDV hariç tutarı'),tax=integer(l.vat_bps,'Satır KDV oranı',10000);
  if(gross<net||Math.abs(Math.round(gross*10000/(10000+tax))-net)>1)fail('Sipariş satırının KDV ve tutarları uyuşmuyor.',409);
  return {external_id:l.external_id,name:l.name,sku:l.sku,quantity_milli:integer(l.quantity_milli,'Satır miktarı',1000000000),gross_cents:gross,net_cents:net,vat_cents:gross-net,vat_bps:tax};
 });
 if(!lines.length||lines.some(l=>l.quantity_milli===0))fail('Taslak satırları eksik.',409);
 const totals=lines.reduce((sum,l)=>({gross_cents:sum.gross_cents+l.gross_cents,net_cents:sum.net_cents+l.net_cents,vat_cents:sum.vat_cents+l.vat_cents}),{gross_cents:0,net_cents:0,vat_cents:0});
 const snapshot={label:'TASLAK — resmî fatura değildir',issue_date:date,currency:'TRY',issuer,billing,package:{id:data.package.id,channel:data.package.channel,external_id:data.package.external_id,order_no:data.package.order_no,occurred_on:data.package.occurred_on},lines,totals,notes,provenance:{source_record_id:data.source?.record_id??null,source_fingerprint:data.source?.fingerprint??null,source_updated_at:data.source?.source_updated_at??null,order_fingerprint:data.package.source_fingerprint},official_issued:false};
 const json=JSON.stringify(snapshot),fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json)))].map(v=>v.toString(16).padStart(2,'0')).join(''),db=env.DB;
 const old=await stmt(db,'SELECT * FROM sales_invoice_drafts WHERE package_id=? AND fingerprint=?',[data.package.id,fingerprint]).first();if(old)return {id:old.id,existing:true,draft:unpack(old)};
 const id=crypto.randomUUID();try{await stmt(db,'INSERT INTO sales_invoice_drafts(id,package_id,version,snapshot_json,fingerprint) SELECT ?,?,COALESCE(MAX(version),0)+1,?,? FROM sales_invoice_drafts WHERE package_id=?',[id,data.package.id,json,fingerprint,data.package.id]).run();}catch(error){if(!/UNIQUE/.test(error.message))throw error;const duplicate=await stmt(db,'SELECT * FROM sales_invoice_drafts WHERE package_id=? AND fingerprint=?',[data.package.id,fingerprint]).first();if(duplicate)return {id:duplicate.id,existing:true,draft:unpack(duplicate)};fail('Taslak sürümü aynı anda değişti; yeniden deneyin.',409);}
 return {id,existing:false,draft:unpack(await stmt(db,'SELECT * FROM sales_invoice_drafts WHERE id=?',[id]).first())};
}
