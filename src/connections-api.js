// Read-only provider connectors. Source inbox != reconciled ledger or bank payment.
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const rows=async statement=>(await statement.all()).results;
const providers=['trendyol','hepsiburada','edm'];
const caps={trendyol:['orders','sale','return','deductions','payments'],hepsiburada:['orders','finance','commissions'],edm:[]};
const names={trendyol:'Trendyol',hepsiburada:'Hepsiburada',edm:'EDM'};
const encoder=new TextEncoder(),decoder=new TextDecoder();
const short=v=>typeof v==='string'||typeof v==='number'?String(v).slice(0,200):'';
const externalID=v=>{if(typeof v==='number'&&!Number.isSafeInteger(v)||!['number','string'].includes(typeof v)||!String(v).trim()||String(v).length>200)fail('Sağlayıcı kayıt kimliği kayıpsız okunamadı.',502);return String(v);};
const numeric=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const money=v=>numeric(v)===null?null:Math.round(v*100);
const rate=v=>numeric(v)===null?null:Math.round(v*100);
const text=(v,label,max=500)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\r\n\x00]/.test(v))fail(label+' eksik/geçersiz.');return v.trim();};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const integer=(v,max=10000)=>{if(!Number.isInteger(v)||v<0||v>max)fail('Sayfa/limit geçersiz.');return v;};
const iso=v=>{if(typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=40){const date=new Date(v);if(Number.isFinite(date.getTime()))return date.toISOString();}return null;};
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
function keyBytes(value){try{const bytes=/^[a-f\d]{64}$/i.test(value||'')?Uint8Array.from(value.match(/../g),h=>parseInt(h,16)):Uint8Array.from(atob(value||''),c=>c.charCodeAt(0));if(bytes.length!==32)throw Error();return bytes;}catch{fail('Sunucuda güvenli bağlantı kasası henüz kurulmadı (CREDENTIAL_KEY).',409);}}
const encryptionReady=env=>{try{keyBytes(env.CREDENTIAL_KEY);return true;}catch{return false;}};
async function cipherKey(env){return crypto.subtle.importKey('raw',keyBytes(env.CREDENTIAL_KEY),'AES-GCM',false,['encrypt','decrypt']);}
export async function encryptCredentials(env,provider,seller,credentials){
 const iv=crypto.getRandomValues(new Uint8Array(12)),aad=encoder.encode('ec:'+provider+':'+seller);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await cipherKey(env),encoder.encode(JSON.stringify(credentials)));
 return 'v1.'+b64(iv)+'.'+b64(encrypted);
}
export async function decryptCredentials(env,provider,seller,value){
 const key=await cipherKey(env);
 try{const [version,a,b]=value.split('.');if(version!=='v1')throw Error();const iv=Uint8Array.from(atob(a),c=>c.charCodeAt(0)),data=Uint8Array.from(atob(b),c=>c.charCodeAt(0));return JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode('ec:'+provider+':'+seller)},key,data)));}catch{fail('Bağlantı kasası açılamadı. Sunucu anahtarı ve bağlantı ayarları kontrol edilmeli.',409);}
}
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function range(input,maxDays){const from=day(input.from),to=day(input.to),start=Date.parse(from+'T00:00:00+03:00'),end=Date.parse(to+'T23:59:59.999+03:00');if(end<start||end-start>maxDays*86400000)fail('Tarih aralığı en fazla '+maxDays+' gün olabilir.');return {from,to,start,end};}
function makeRequest(provider,credentials,input){
 const kind=input.kind,page=integer(input.page??0,provider==='trendyol'&&kind==='orders'?199:10000),limit=50;
 if(!caps[provider]?.includes(kind))fail(provider==='edm'?'EDM canlı SOAP adresi ve servis hakkı doğrulanmadı. Alış faturalarında UBL XML içe aktarımı kullanılabilir.':'Bu veri türü desteklenmiyor.',409);
 let url,query={kind,page},window;
 if(provider==='trendyol'){
  window=range(input,kind==='orders'?14:15);query={...query,from:window.from,to:window.to};
  if(kind==='orders')url=new URL('https://apigw.trendyol.com/integration/order/sellers/'+credentials.seller_id+'/v2/orders');
  else {const types={sale:['settlements','Sale'],return:['settlements','Return'],deductions:['otherfinancials','DeductionInvoices'],payments:['otherfinancials','PaymentOrder']};url=new URL('https://apigw.trendyol.com/integration/finance/che/sellers/'+credentials.seller_id+'/'+types[kind][0]);url.searchParams.set('transactionType',types[kind][1]);}
  for(const [k,v] of Object.entries({startDate:window.start,endDate:window.end,page,size:limit}))url.searchParams.set(k,String(v));
  if(kind==='orders'){url.searchParams.set('orderByField','PackageLastModifiedDate');url.searchParams.set('orderByDirection','ASC');}
 }else if(kind==='commissions'){
  // Activated only with the documented query/response contract below.
  const skus=input.skus;if(!Array.isArray(skus)||skus.length<1||skus.length>50)fail('Komisyon sorgusu için 1–50 HB SKU girin.');
  query.skus=[...new Set(skus.map(v=>text(v,'HB SKU',100)))].sort();
  if(query.skus.some(sku=>sku.includes(',')))fail('Her SKU ayrı girilmeli; SKU içinde virgül olamaz.');
  url=new URL('https://listing-external.hepsiburada.com/commissions/merchantid/'+credentials.seller_id);
  if(page!==0)fail('SKU komisyon sorgusu tek sayfadır. Başka SKU grubu seçin.');
  url.searchParams.set('skuList',query.skus.join(','));
 }else{
  window=range(input,14);query={...query,from:window.from,to:window.to};
  url=new URL((kind==='orders'?'https://oms-external.hepsiburada.com/orders/merchantid/':'https://mpfinance-external.hepsiburada.com/transactions/merchantid/')+credentials.seller_id);
  if(kind==='orders'){url.searchParams.set('begindate',window.from+' 00:00');url.searchParams.set('enddate',window.to+' 23:59');url.searchParams.set('offset',String(page*limit));url.searchParams.set('limit',String(limit));}
  else {url.searchParams.set('RecordDateStart',window.from+'T00:00:00');url.searchParams.set('RecordDateEnd',window.to+'T23:59:59');url.searchParams.set('Offset',String(page*limit));url.searchParams.set('Limit',String(limit));}
 }
 return {url,query,page,limit};
}
function normalizeTY(kind,payload,page){
 if(!payload||typeof payload!=='object')fail('Trendyol yanıt şeması doğrulanamadı.',502);
 if(!Array.isArray(payload.content)||!Number.isInteger(payload.totalPages)||payload.totalPages<0||payload.content.length>50)fail('Trendyol yanıt şeması veya sayfa boyutu doğrulanamadı.',502);
 if(payload.content.length&&(payload.totalPages===0||page>=payload.totalPages)||payload.page!==undefined&&payload.page!==page)fail('Trendyol sayfa bilgileri tutarsız; kapsam tamamlandı kabul edilmedi.',502);
 if(kind==='orders'&&payload.totalElements>10000)fail('Trendyol 10.000 paket sınırı aşıldı. Tarih aralığını daraltın; bu sayfa kaydedilmedi.',409);
 if(kind==='orders'&&(!Number.isInteger(payload.totalElements)||payload.totalElements<0||payload.totalPages>200))fail('Trendyol toplam kayıt kapsamı doğrulanamadı. Tarih aralığını daraltın.',502);
 if(kind==='orders'&&payload.content.length&&payload.totalElements<page*50+payload.content.length)fail('Trendyol toplam kayıt ve sayfa içeriği tutarsız.',502);
 const records=payload.content.map(r=>{
  if(kind==='orders'){
   if(!Array.isArray(r.lines)||!r.lines.length||r.lines.length>80)fail('Sipariş paketi 1–80 kalem içermeli; kaynak kapsamı inceleme gerektiriyor.',502);
   const updated=iso(r.lastModifiedDate),created=iso(r.orderDate),currency=short(r.currencyCode);
   const lines=r.lines.map(l=>{if(!Number.isInteger(l.quantity)||l.quantity<=0||l.quantity>10000)fail('Sipariş satır miktarı geçersiz.',502);const unit=numeric(l.lineUnitPrice),platformDiscount=numeric(l.lineTyDiscount);return {external_id:externalID(l.lineId),sku:short(l.stockCode),barcode:short(l.barcode),name:short(l.productName),quantity_milli:l.quantity*1000,gross_cents:unit===null||platformDiscount!==0?null:money(unit*l.quantity),vat_bps:rate(l.vatRate),commission_bps:rate(l.commission),currency:short(l.currencyCode||currency),seller_discount:numeric(l.lineSellerDiscount),platform_discount:platformDiscount,amounts_need_review:platformDiscount!==0};});
   if(new Set(lines.map(l=>l.external_id)).size!==lines.length)fail('Siparişte aynı satır kimliği tekrar ediyor.',502);
   return {external_id:externalID(r.shipmentPackageId??r.id),order_no:externalID(r.orderNumber),occurred_on:created?new Date(Date.parse(created)+3*3600000).toISOString().slice(0,10):null,external_status:short(r.shipmentPackageStatus??r.status),source_updated_at:updated,currency,carrier:short(r.cargoProviderName),package_gross: numeric(r.packageGrossAmount),package_price:numeric(r.packageTotalPrice),package_seller_discount:numeric(r.packageSellerDiscount),package_platform_discount:numeric(r.packageTyDiscount),lines};
  }
  if(!short(r.id))fail('Finans kaydında dış kimlik yok.',502);
  return {external_id:externalID(r.id),reference:short(r.orderNumber||r.receiptId),order_no:short(r.orderNumber),barcode:short(r.barcode),type:short(r.transactionType),credit:numeric(r.credit),debt:numeric(r.debt),commission:numeric(r.commissionAmount),seller_revenue:numeric(r.sellerRevenue),payment_order_id:short(r.paymentOrderId),source_updated_at:iso(r.lastModifiedDate||r.transactionDate),currency:short(r.currency),interpretation:'source_financial_record'};
 });
 return {records,hasMore:page+1<payload.totalPages,totalPages:payload.totalPages};
}
function normalizeHB(kind,payload,page,limit){
 if(!payload||typeof payload!=='object')fail('Hepsiburada yanıt şeması doğrulanamadı.',502);
 const list=Array.isArray(payload)?payload:Array.isArray(payload.items)?payload.items:Array.isArray(payload.data)?payload.data:null;
 if(!list||list.length>limit)fail('Hepsiburada yanıt şeması doğrulanamadı; kayıt oluşturulmadı.',502);
 const records=list.map(r=>{
  if(kind==='commissions'){
   const sku=externalID(r.hepsiburadaSku??r.sku),commission=numeric(r.commissionRate);if(commission===null||commission<0||commission>100)fail('HB komisyon yanıtı ürün/oran eşleşmesi doğrulanamadı.',502);
   return {external_id:sku,sku,merchant_sku:short(r.merchantSku),commission_rate:commission,commission_bps:rate(commission),source_updated_at:null,tax_basis:'unverified',validity:'current_observation_only'};
  }
  if(kind==='orders'){
   const id=externalID(r.id??r.lineItemId);if(!id)fail('HB sipariş kalem kimliği eksik.',502);
   return {external_id:id,order_no:short(r.orderNumber),package_id:short(r.packageId),sku:short(r.merchantSKU??r.merchantSku),hb_sku:short(r.sku),quantity:numeric(r.quantity),total_price:numeric(r.totalPrice?.amount),currency:short(r.totalPrice?.currency),commission:numeric(r.commission?.amount),vat:numeric(r.vat),external_status:short(r.status),source_updated_at:iso(r.lastUpdatedDate??r.orderDate),interpretation:'pending_order_line_requires_package_mapping'};
  }
  const id=externalID(r.id??r.transactionId);if(!short(r.transactionType??r.type)||numeric(r.amount?.amount??r.amount)===null)fail('HB finans kaydının kimlik/tür/tutar şeması doğrulanamadı.',502);
  return {external_id:id,type:short(r.transactionType??r.type),order_no:short(r.orderNumber),package_no:short(r.packageNumber),sku:short(r.sku),amount:numeric(r.amount?.amount??r.amount),currency:short(r.amount?.currency??r.currency),payment_status:short(r.paymentStatus),source_updated_at:iso(r.transactionDate??r.date),interpretation:'unreconciled_financial_record_not_bank_transfer'};
 });
 const total=Number.isInteger(payload.totalCount)?payload.totalCount:null;
 if(total!==null&&(total<0||list.length&&total<page*limit+list.length))fail('Hepsiburada toplam kayıt ve sayfa içeriği tutarsız.',502);
 return {records,hasMore:kind==='commissions'?false:total===null?list.length===limit:(page+1)*limit<total,totalPages:kind==='commissions'?1:total===null?null:Math.ceil(total/limit)};
}
async function safeJSON(response){
 if(!response.ok){if(response.status===429)fail('Sağlayıcı istek sınırı doldu; daha sonra yeniden deneyin.',429);if([401,403].includes(response.status))fail('Sağlayıcı API erişimi doğrulanamadı. Kimlik bilgilerini kontrol edin.',502);fail('Sağlayıcı isteği tamamlayamadı (HTTP '+response.status+').',502);}
 const reader=response.body.getReader(),chunks=[];let count=0;
 while(true){const {value,done}=await reader.read();if(done)break;count+=value.byteLength;if(count>2000000){await reader.cancel();fail('Yanıt güvenli işleme sınırını aştı.',502);}chunks.push(value);}
 const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return JSON.parse(decoder.decode(bytes));}catch{fail('Sağlayıcı JSON yanıtı okunamadı.',502);}
}
export async function syncProvider(env,provider,input,fetcher=fetch,orderImporter=null){
 if(env.WORKSPACE!=='ec')fail('Bu bağlantılar yalnızca e-ticaret alanında kullanılabilir.',403);
 if(!providers.includes(provider))fail('Sağlayıcı bulunamadı.',404);
 if(provider==='edm')fail('EDM üretim SOAP adresi ve servis yetkisi doğrulanmadı. Şimdilik UBL XML içe aktarımını kullanın.',409);
 const db=env.DB,connection=await stmt(db,'SELECT * FROM provider_connections WHERE provider=?',[provider]).first();if(!connection)fail('Önce güvenli bağlantı ayarlarını kaydedin.',409);
 const credentials=await decryptCredentials(env,provider,connection.seller_id,connection.encrypted_credentials),spec=makeRequest(provider,credentials,input);
 const queryJSON=JSON.stringify({...spec.query,page:undefined}),queryKey=await hash(queryJSON);
 const cursor=await stmt(db,'SELECT next_page FROM provider_cursors WHERE provider=? AND seller_id=? AND kind=? AND query_key=?',[provider,connection.seller_id,input.kind,queryKey]).first();
 if(spec.page>(cursor?.next_page??0))fail('Sayfaları sırayla çekin; önceki kaynak sayfaları henüz alınmadı.',409);
 try{
  let response;try{response=await fetcher(spec.url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Basic '+btoa(credentials.key+':'+credentials.secret),'User-Agent':credentials.user_agent,Accept:'application/json'}});}catch{fail('Sağlayıcı bağlantısı tamamlanamadı; zaman aşımı veya ağ sorunu olabilir.',502);}
  const payload=await safeJSON(response);
  if(provider==='trendyol'&&input.kind==='orders'&&Array.isArray(payload?.content)&&payload.content.some(r=>r.supplierId!==undefined&&String(r.supplierId)!==connection.seller_id||Array.isArray(r.lines)&&r.lines.some(l=>l.sellerId!==undefined&&String(l.sellerId)!==connection.seller_id)))fail('Kaynak siparişin satıcı kimliği bu bağlantıyla eşleşmiyor.',502);
  const result=provider==='trendyol'?normalizeTY(input.kind,payload,spec.page):normalizeHB(input.kind,payload,spec.page,spec.limit);
  if(new Set(result.records.map(r=>r.external_id)).size!==result.records.length)fail('Aynı sayfada mükerrer kaynak kimliği var; kapsam inceleme gerektiriyor.',502);
  const missingSkus=provider==='hepsiburada'&&input.kind==='commissions'?spec.query.skus.filter(sku=>!result.records.some(r=>r.sku===sku)):[];
  const prior=result.records.length?await rows(stmt(db,'SELECT external_id,fingerprint,source_updated_at FROM (SELECT external_id,fingerprint,source_updated_at,ROW_NUMBER() OVER(PARTITION BY external_id ORDER BY source_updated_at DESC,last_seen_at DESC,rowid DESC) rn FROM provider_records WHERE provider=? AND seller_id=? AND kind=? AND external_id IN (SELECT value FROM json_each(?))) WHERE rn=1',[provider,connection.seller_id,input.kind,JSON.stringify(result.records.map(r=>r.external_id))])):[];
  const priorMap=new Map(prior.map(r=>[r.external_id,r]));
  const localOrders=provider==='trendyol'&&input.kind==='orders'&&result.records.length?await rows(stmt(db,'SELECT external_id FROM order_packages WHERE channel=? AND external_id IN (SELECT value FROM json_each(?))',[provider,JSON.stringify(result.records.map(r=>r.external_id))])):[];
  const localOrderIDs=new Set(localOrders.map(r=>r.external_id));
  const statements=[],sourceRows=[],newOrders=[];let unchanged=0,changed=0,reviewOnlyOrders=0,deferredOrders=0,oversizedOrders=0,importQueryBudget=35;
  for(const r of result.records){
   const json=JSON.stringify(r),fingerprint=await hash(json),existing=priorMap.get(r.external_id);
   if(existing?.fingerprint===fingerprint)unchanged++;else if(existing)changed++;
   const outdated=existing?.source_updated_at&&(!r.source_updated_at||r.source_updated_at<existing.source_updated_at);
   sourceRows.push({id:crypto.randomUUID(),external_id:r.external_id,fingerprint,payload_json:json,source_updated_at:r.source_updated_at});
   if(provider==='trendyol'&&input.kind==='orders'){
    if(existing?.fingerprint===fingerprint&&localOrderIDs.has(r.external_id))continue;
    const queriesNeeded=2+2*r.lines.length;
    if(!outdated&&r.source_updated_at&&r.currency==='TRY'&&r.occurred_on&&r.lines.every(l=>l.currency==='TRY')){
     if(r.lines.length>10){oversizedOrders++;reviewOnlyOrders++;}
     else if(queriesNeeded<=importQueryBudget){newOrders.push(r);importQueryBudget-=queriesNeeded;}else deferredOrders++;
    }
    else reviewOnlyOrders++;
   }
  }
  if(sourceRows.length)statements.push(stmt(db,"INSERT INTO provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at) SELECT json_extract(value,'$.id'),?,?,?,json_extract(value,'$.external_id'),json_extract(value,'$.fingerprint'),json_extract(value,'$.payload_json'),json_extract(value,'$.source_updated_at') FROM json_each(?) WHERE 1 ON CONFLICT(provider,seller_id,kind,external_id,fingerprint) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP",[provider,connection.seller_id,input.kind,JSON.stringify(sourceRows)]));
  statements.push(stmt(db,'INSERT INTO provider_cursors(provider,seller_id,kind,query_key,query_json,next_page,has_more) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,seller_id,kind,query_key) DO UPDATE SET has_more=CASE WHEN excluded.next_page>=provider_cursors.next_page THEN excluded.has_more ELSE provider_cursors.has_more END,next_page=MAX(provider_cursors.next_page,excluded.next_page),last_success_at=CURRENT_TIMESTAMP',[provider,connection.seller_id,input.kind,queryKey,queryJSON,spec.page+1,result.hasMore?1:0]));
  statements.push(stmt(db,'UPDATE provider_connections SET last_success_at=CURRENT_TIMESTAMP,last_error=NULL WHERE provider=?',[provider]));
  statements.push(stmt(db,'INSERT INTO integration_runs(id,provider,kind,status,record_count,message) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),provider,input.kind,'inbox',result.records.length,'Kaynak kayıtları alındı; finans ve stok işlemleri otomatik yapılmadı.']));
  await db.batch(statements);
  let orders=null,orderImportWarning=null;
  if(newOrders.length){try{const importer=orderImporter||(await import('./orders-api.js')).importOrders;orders=await importer(env,provider,newOrders);}catch{orderImportWarning='Kaynaklar saklandı; sipariş taslaklarına aktarım tamamlanamadı. Aynı sayfayı yeniden çekebilirsiniz.';}}
  const warnings=[...(orderImportWarning?[orderImportWarning]:[]),...(reviewOnlyOrders?[reviewOnlyOrders+' sipariş kaynak kutusunda kaldı; paket büyüklüğü, tarih, para birimi veya kaynak sürümü inceleme gerektiriyor.']:[]),...(oversizedOrders?[oversizedOrders+' paket 10 satır sınırını aşıyor; bunları yeniden çekmek taslak oluşturmaz.']:[]),...(deferredOrders?[deferredOrders+' paket ücretsiz işlem sınırı nedeniyle kaynak kutusunda. Aynı sayfayı yeniden çekerek sıradaki taslakları aktarın.']:[]),...(missingSkus.length?[missingSkus.length+' istenen SKU için komisyon yanıtı yok; eksik oran sıfır kabul edilmedi.']:[])];
  return {...result,page:spec.page,next_page:spec.page+1,unchanged,changed,orders,orderImportWarning,reviewOnlyOrders,deferredOrders,oversizedOrders,missing_skus:missingSkus,warnings,message:'Kaynak kayıtlarıdır. Finans/kargo/komisyon henüz muhasebeyle mutabık değildir. Fiyat veya stok pazaryerine gönderilmedi.'+(warnings.length?' '+warnings.join(' '):'')};
 }catch(error){
  const safe=error.status?error.message:'Bağlantı işleme hatası; kaynak sayfa tamamlanmadı.';
  await stmt(db,'UPDATE provider_connections SET last_error=? WHERE provider=?',[safe,provider]).run();
  await stmt(db,'INSERT INTO integration_runs(id,provider,kind,status,record_count,message) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),provider,input.kind||'unknown','error',0,safe]).run();
  if(error.status)throw error;fail(safe,502);
 }
}
export async function connectionsApi(request,env,path,readBody){
 if(!path.startsWith('/api/connections'))return null;
 if(env.WORKSPACE!=='ec')fail('Bu bağlantılar yalnızca e-ticaret alanında kullanılabilir.',403);
 const db=env.DB,method=request.method,url=new URL(request.url);
 if(path==='/api/connections'&&method==='GET'){
  const data=await rows(db.prepare('SELECT provider,seller_id,configured_at,last_success_at,last_error FROM provider_connections'));
  return {encryption_ready:encryptionReady(env),providers:providers.map(id=>{const r=data.find(x=>x.provider===id);return {id,name:names[id],configured:!!r,account_hint:r?'…'+r.seller_id.slice(-4):null,capabilities:caps[id],last_success_at:r?.last_success_at??null,last_error:r?.last_error??null,stale:!r?.last_success_at||Date.now()-Date.parse(r.last_success_at+'Z')>86400000,description:id==='edm'?'Üretim SOAP adresi ve servis hakkı doğrulanmadı. UBL XML içe aktarımı kullanılabilir.':id==='hepsiburada'?'Güncel ürün komisyonu gözlemi, sipariş kalemleri ve finans kaynak kayıtları; gelecek hafta tarifesi garantisi yok.':'Sipariş V2 ve finans kaynak kayıtları. Gelecek kampanya tarifesi için tarihli tarife girin.'};}),runs:await rows(db.prepare('SELECT * FROM integration_runs ORDER BY created_at DESC LIMIT 20')),cursors:await rows(db.prepare('SELECT provider,kind,query_json,next_page,has_more,last_success_at FROM provider_cursors ORDER BY last_success_at DESC LIMIT 30'))};
 }
 if(path==='/api/connections/records'&&method==='GET'){
  const provider=url.searchParams.get('provider'),kind=url.searchParams.get('kind'),page=integer(Number(url.searchParams.get('page')||0));if(!providers.includes(provider)||!caps[provider].includes(kind))fail('Sağlayıcı/veri türü seçin.');
  const records=await rows(stmt(db,'SELECT id,external_id,payload_json,source_updated_at,first_seen_at,last_seen_at FROM provider_records WHERE provider=? AND kind=? ORDER BY last_seen_at DESC,id LIMIT 51 OFFSET ?',[provider,kind,page*50]));return {records:records.slice(0,50).map(r=>({...r,payload:JSON.parse(r.payload_json),payload_json:undefined})),page,hasMore:records.length>50,message:'Her değişen kaynak sürümü saklanır; bu liste muhasebe ekstresi değildir.'};
 }
 const match=path.match(/^\/api\/connections\/(trendyol|hepsiburada|edm)\/(configure|sync)$/);if(!match||method!=='POST')return null;
 const provider=match[1],x=await readBody(request);
 if(match[2]==='sync')return syncProvider(env,provider,x);
 if(provider==='edm')fail('EDM üretim SOAP adresi/servis sözleşmesi henüz doğrulanmadı; parola kaydedilmedi. UBL XML içe aktarımını kullanabilirsiniz.',409);
 keyBytes(env.CREDENTIAL_KEY);
 const seller=text(x.seller_id,'Satıcı kimliği',100);if(provider==='trendyol'?!/^\d+$/.test(seller):!/^[a-f\d-]{32,36}$/i.test(seller))fail('Satıcı kimliği biçimi geçersiz.');
 const credentials={seller_id:seller,key:text(x.key,'API kullanıcı/anahtar',500),secret:text(x.secret,'API şifresi',1000),user_agent:text(x.user_agent,'User-Agent',200)};
 if(!/^[\x20-\x7e]+$/.test(credentials.key+credentials.secret+credentials.user_agent)||credentials.key.includes(':'))fail('API kimlik bilgisi/Header biçimi geçersiz.');
 const old=await stmt(db,'SELECT seller_id FROM provider_connections WHERE provider=?',[provider]).first();if(old&&old.seller_id!==seller)fail('Bağlantı farklı mağazaya taşınamaz; verilerin karışmaması için ayrı mağaza çalışma alanı gerekir.',409);
 const encrypted=await encryptCredentials(env,provider,seller,credentials);
 await stmt(db,'INSERT INTO provider_connections(provider,seller_id,encrypted_credentials) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,configured_at=CURRENT_TIMESTAMP,last_success_at=NULL,last_error=NULL',[provider,seller,encrypted]).run();
 return {configured:true,provider,message:'Kimlik bilgileri şifrelenerek kaydedildi. Bağlantı henüz sınanmadı.'};
}
