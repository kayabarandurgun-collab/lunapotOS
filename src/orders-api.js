import {cents,milli} from '../public/accounting-math.js';
import {resolveMapping} from './catalog-api.js';
import {ordersQuery} from './orders-query.js';
import {assertReportLinkFresh} from './report-link-guard.js';
const fail=(m,s=400)=>{throw Object.assign(new Error(m),{status:s});};
const id=()=>crypto.randomUUID();
const text=(v,label,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const opt=(v,max=200)=>v===null||v===undefined||v===''?'':text(v,'Bilgi',max);
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const integer=(v,label,max=10000000000)=>{if(!Number.isSafeInteger(v)||v<0||v>max)fail(label+' geçersiz.');return v;};
const money=v=>{if(v===null||v===undefined||v==='')return null;try{return integer(cents(v),'Tutar');}catch{fail('Tutar geçersiz.');}};
const qty=v=>{try{return milli(v);}catch{fail('Miktar en fazla üç ondalıklı ve sıfırdan büyük olmalı.');}};
const vat=v=>v===null||v===undefined||v===''?null:integer(Math.round(v*100),'KDV oranı',10000);
const statement=(db,sql,args=[])=>db.prepare(sql).bind(...args);
async function execute(db,items){try{return await db.batch(items);}catch(error){const m=String(error.message);if(/STOCK_RESERVED/.test(m))fail('Bu stok başka siparişler için ayrılmış.',409);if(/ORDER_INSUFFICIENT_STOCK|INSUFFICIENT_STOCK/.test(m))fail('Siparişin tamamını ayırmak için kullanılabilir stok yetersiz.',409);if(/ORDER_COMPONENT_LIMIT/.test(m))fail("Paket en fazla 20 stok bileşeni içerebilir.",409);if(/ORDER_UNIT_CHANGED/.test(m))fail("Stok birimi değişmiş. Bileşen eşleştirmesini yeniden doğrulayın.",409);if(/ORDER_UNMAPPED/.test(m))fail('Önce bütün sipariş satırlarını ürünlerle eşleştirin.',409);if(/ORDER_MISSING_AMOUNT/.test(m))fail('KDV hariç satış tutarı eksik. Tutarı veya doğrulanmış KDV oranını girin.',409);if(/ORDER_SOURCE_CHANGED/.test(m))fail('Kaynak sipariş değişmiş. Güncel kaydı inceleyip taslağı yenileyin.',409);if(/ORDER_REFRESH_BLOCKED|ORDER_REFRESH_AUDIT_LOCKED/.test(m))fail("Yalnızca stok ayrılmamış ve gönderilmemiş taslak yenilenebilir.",409);if(/ORDER_LOCKED|INVALID_ORDER_TRANSITION/.test(m))fail('Sipariş bu durumda değiştirilemez.',409);if(/UNIQUE constraint/.test(m))fail('Bu sipariş veya gönderi referansı daha önce kaydedildi.',409);if(/FOREIGN KEY/.test(m))fail('Kayıt bu çalışma alanında bulunamadı.',404);throw error;}}
function netAmount(gross,tax,net){if(gross!==null&&tax!==null){const calculated=Math.round(gross*10000/(10000+tax));if(net!==null&&Math.abs(net-calculated)>1)fail('Brüt tutar, KDV ve net tutar birbiriyle uyuşmuyor.');return net??calculated;}return net;}
function normalized(record){
 if(!Array.isArray(record.lines)||!record.lines.length||record.lines.length>10)fail('Ücretsiz işlem sınırı için paket 1–10 satır içermeli. Daha büyük paket kaynak kutusunda ayrıca incelenmeli.');
 const seen=new Set(),lines=record.lines.map(l=>{const external=text(l.external_id,'Sipariş satır kodu');if(seen.has(external))fail('Siparişte aynı satır kodu birden fazla var.');seen.add(external);
  const quantity=integer(l.quantity_milli,'Miktar',1000000000);if(!quantity)fail('Miktar sıfır olamaz.');
  const gross=l.gross_cents==null?null:integer(l.gross_cents,'Brüt tutar'),tax=l.vat_bps==null?null:integer(l.vat_bps,'KDV',10000),net=l.net_revenue_cents==null?null:integer(l.net_revenue_cents,'Net tutar');
  return {external_id:external,sku:opt(l.sku),name:text(l.name||l.sku||external,'Ürün adı',300),product_id:opt(l.product_id)||null,mapping_id:opt(l.mapping_id)||null,quantity_milli:quantity,gross_cents:gross,vat_bps:tax,net_revenue_cents:netAmount(gross,tax,net)};
 });
 return {external_id:text(record.external_id,'Paket kodu'),order_no:opt(record.order_no),occurred_on:day(record.occurred_on),external_status:opt(record.external_status),lines};
}
async function fingerprint(p){const value=JSON.stringify({order_no:p.order_no,occurred_on:p.occurred_on,lines:p.lines.map(({product_id,mapping_id,...l})=>l).sort((a,b)=>a.external_id.localeCompare(b.external_id))});const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');}
function componentSnapshots(line,components,mappingId){
 if(!components.length||components.length>20||components.reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000)fail('Set bileşenlerinin gelir payları toplamı %100 olmalı.',409);
 return components.map(c=>{const unit=integer(c.quantity_milli,'Bileşen miktarı',1000000000),share=integer(c.revenue_share_bps,'Gelir payı',10000);if(!unit)fail('Bileşen miktarı sıfır olamaz.');const multiplied=BigInt(unit)*BigInt(line.quantity_milli);if(multiplied%1000n!==0n||multiplied/1000n>1000000000n)fail('Sipariş miktarı stok birimine tam olarak dönüştürülemiyor veya miktar sınırını aşıyor.',409);return {id:id(),line_id:line.id,product_id:c.product_id,quantity_milli:Number(multiplied/1000n),revenue_share_bps:share,stock_unit:text(c.stock_unit,'Stok birimi',30),mapping_id:mappingId||null};});
}
async function mappedComponents(db,channel,line,explicit={},auto=false){
 if(explicit.mapping_id&&explicit.product_id)fail('Tek satırda eşleştirme veya doğrudan ürün seçin.');
 let resolved=null;
 if(explicit.mapping_id){const mapping=await statement(db,"SELECT * FROM catalog_mappings WHERE id=? AND active=1",[text(explicit.mapping_id,'Eşleştirme')]).first();if(!mapping||mapping.source!==channel||mapping.supplier_id!==''||mapping.source_unit!=='')fail('Eşleştirme bu satış kanalına ait değil veya kapalı.',409);resolved={mapping,components:(await statement(db,'SELECT c.*,p.stock_unit FROM catalog_mapping_components c JOIN products p ON p.id=c.product_id WHERE c.mapping_id=? ORDER BY c.id',[mapping.id]).all()).results};}
 else if(explicit.product_id){const p=await statement(db,'SELECT id,stock_unit FROM products WHERE id=?',[text(explicit.product_id,'Ürün')]).first();if(!p)fail('Ürün bu çalışma alanında bulunamadı.',404);if(['trendyol','hepsiburada'].includes(channel)&&p.stock_unit!=='adet')fail('Doğrudan pazaryeri adedi yalnızca adet stok birimine eşlenebilir. Kg/litre için açık bileşen dönüşümlü eşleştirme kullanın.',409);return componentSnapshots(line,[{product_id:p.id,stock_unit:p.stock_unit,quantity_milli:1000,revenue_share_bps:10000}],null);}
 else if(auto&&line.sku)resolved=await resolveMapping(db,{source:channel,external_code:line.sku,supplier_id:'',source_unit:''});
 if(!resolved)return [];
 return componentSnapshots(line,resolved.components,resolved.mapping.id);
}
const componentInsert=(db,components)=>statement(db,"INSERT INTO order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,mapping_id) SELECT json_extract(value,'$.id'),json_extract(value,'$.line_id'),json_extract(value,'$.product_id'),json_extract(value,'$.quantity_milli'),json_extract(value,'$.revenue_share_bps'),json_extract(value,'$.stock_unit'),json_extract(value,'$.mapping_id') FROM json_each(?)",[JSON.stringify(components)]);
const lineInsert=(db,packageId,lines)=>statement(db,"INSERT INTO order_lines(id,package_id,external_id,sku,name,product_id,quantity_milli,gross_cents,vat_bps,net_revenue_cents) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.external_id'),json_extract(value,'$.sku'),json_extract(value,'$.name'),json_extract(value,'$.product_id'),json_extract(value,'$.quantity_milli'),json_extract(value,'$.gross_cents'),json_extract(value,'$.vat_bps'),json_extract(value,'$.net_revenue_cents') FROM json_each(?)",[packageId,JSON.stringify(lines)]);
async function createPackage(env,channel,record){
 const db=env.DB,p=normalized(record),hash=await fingerprint(p),existing=await statement(db,'SELECT * FROM order_packages WHERE channel=? AND external_id=?',[channel,p.external_id]).first();
 if(['trendyol','hepsiburada'].includes(channel)&&p.lines.some(l=>l.quantity_milli%1000!==0))fail('Pazaryeri sipariş adedi tam sayı olmalı.');
 if(existing){const changed=existing.source_fingerprint!==hash;await execute(db,[statement(db,'UPDATE order_packages SET external_status=?,source_changed=CASE WHEN ?=1 THEN 1 ELSE source_changed END WHERE id=?',[p.external_status,changed?1:0,existing.id])]);return {id:existing.id,status:existing.status,existing:true,conflict:changed};}
 const key=id(),components=[];for(const l of p.lines){l.id=id();const rows=await mappedComponents(db,channel,l,l,true);components.push(...rows);l.product_id=rows.length===1?rows[0].product_id:null;}
 if(components.length>20)fail('Ücretsiz işlem sınırı için paket en fazla 20 stok bileşeni içerebilir.',409);
 const items=[statement(db,'INSERT INTO order_packages(id,channel,external_id,order_no,occurred_on,external_status,source_fingerprint) VALUES(?,?,?,?,?,?,?)',[key,channel,p.external_id,p.order_no,p.occurred_on,p.external_status,hash]),lineInsert(db,key,p.lines)];
 if(components.length)items.push(componentInsert(db,components));
 await execute(db,items);return {id:key,status:'draft',existing:false,conflict:false};
}
// Provider adapter passes explicit normalized source facts. This function never dispatches orders remotely.
export async function importOrders(env,provider,records){
 if(env.WORKSPACE!=='ec'||!['trendyol','hepsiburada'].includes(provider))fail('Sipariş aktarımı yalnızca e-ticaret alanında kullanılabilir.',403);
 if(!Array.isArray(records)||records.length>10||records.reduce((sum,r)=>sum+4+2*(Array.isArray(r.lines)?r.lines.length:0),0)>35)fail('Ücretsiz işlem sınırı: paketleri daha küçük aktarım gruplarına ayırın.',409);
 const result={created:0,existing:0,conflicts:0,package_ids:[]};
 for(const record of records){const p=await createPackage(env,provider,record);result[p.existing?'existing':'created']++;if(p.conflict)result.conflicts++;result.package_ids.push(p.id);}
 return result;
}
async function latestSource(db,p){
 if(p.channel!=='trendyol')fail('Doğrulanmış paket yenileme şu anda Trendyol kaynakları için hazır.',409);
 const source=await statement(db,"SELECT r.* FROM provider_records r JOIN provider_connections c ON c.provider=r.provider AND c.seller_id=r.seller_id WHERE r.provider=? AND r.kind='orders' AND r.external_id=? ORDER BY r.source_updated_at DESC,r.last_seen_at DESC,r.rowid DESC LIMIT 1",[p.channel,p.external_id]).first();
 if(!source)fail('Bu mağazaya ait doğrulanmış kaynak paketi bulunamadı. Bağlantılardan güncel siparişleri çekin.',409);
 if(!source.source_updated_at||!Number.isFinite(Date.parse(source.source_updated_at)))fail('Kaynağın güncelleme tarihi doğrulanamıyor.',409);
 let payload;try{payload=JSON.parse(source.payload_json);}catch{fail('Kaynak paketi okunamıyor.',409);}
 if(payload.external_id!==p.external_id||payload.currency!=='TRY'||payload.source_updated_at!==source.source_updated_at||!Array.isArray(payload.lines)||payload.lines.some(l=>l.currency!=='TRY'||!Number.isSafeInteger(l.quantity_milli)||l.quantity_milli%1000!==0))fail('Kaynak kimliği, para birimi veya miktar bilgileri doğrulanamıyor.',409);
 const data=normalized({...payload,lines:payload.lines.map(l=>({...l,product_id:null}))});
 return {source,data,hash:await fingerprint(data)};
}
export async function ordersApi(request,env,path,readBody){
 if(!path.startsWith('/api/orders'))return null;if(env.WORKSPACE!=='ec')fail('Siparişler e-ticaret çalışma alanına aittir.',403);
 const db=env.DB,method=request.method;
 if(path==='/api/orders'&&method==='GET'){
  const {scope,args,page,limit,offset}=ordersQuery(request.url);
  const pageSQL=scope+' ORDER BY occurred_on DESC,created_at DESC,rowid DESC LIMIT ? OFFSET ?',pageArgs=[...args,limit,offset];

  const [packages,lines,products,reservations,components]=(await db.batch([
   statement(db,'SELECT * FROM order_packages'+pageSQL,pageArgs),
   statement(db,'SELECT l.* FROM order_lines l WHERE package_id IN (SELECT id FROM order_packages'+pageSQL+')',pageArgs),
   db.prepare('SELECT p.id,p.name,p.sku,p.stock_unit,b.quantity_milli,b.value_cents,COALESCE((SELECT SUM(r.quantity_milli) FROM order_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0) reserved_milli FROM products p JOIN stock_balances b ON b.product_id=p.id ORDER BY p.name'),
   db.prepare('SELECT * FROM order_reservations WHERE released_on IS NULL'),
   statement(db,'SELECT c.*,p.name product_name,p.sku,p.stock_unit current_stock_unit FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN products p ON p.id=c.product_id WHERE l.package_id IN (SELECT id FROM order_packages'+pageSQL+') ORDER BY c.rowid',pageArgs)
  ])).map(r=>r.results);
  const counts=(await db.prepare('SELECT status,COUNT(*) count FROM order_packages GROUP BY status').all()).results;
  const total=(await statement(db,'SELECT COUNT(*) count FROM order_packages'+scope,args).first()).count;
  const stock=new Map(products.map(p=>[p.id,p.quantity_milli-p.reserved_milli]));
  return {packages:packages.slice(0,500).map(p=>{const ls=lines.filter(l=>l.package_id===p.id),lineIDs=new Set(ls.map(l=>l.id)),cs=components.filter(c=>lineIDs.has(c.line_id)),needs=new Map();for(const c of cs)needs.set(c.product_id,(needs.get(c.product_id)||0)+c.quantity_milli);const readiness=p.source_changed?'source_changed':ls.some(l=>cs.filter(c=>c.line_id===l.id).reduce((n,c)=>n+c.revenue_share_bps,0)!==10000)||cs.some(c=>c.stock_unit!==c.current_stock_unit)?'needs_mapping':ls.some(l=>l.net_revenue_cents===null)?'needs_amounts':p.status==='draft'&&[...needs].some(([product,q])=>(stock.get(product)||0)<q)?'needs_stock':'ready';return {...p,readiness};}),lines,components,products:products.map(p=>({...p,available_milli:p.quantity_milli-p.reserved_milli})),reservations,counts,truncated:offset+packages.length<total,pagination:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit)),has_more:offset+packages.length<total}};
 }
 const previewMatch=path.match(/^\/api\/orders\/([\w-]+)\/source$/);
 if(previewMatch&&method==='GET'){
  const p=await statement(db,'SELECT * FROM order_packages WHERE id=?',[previewMatch[1]]).first();if(!p)fail('Sipariş paketi bulunamadı.',404);
  const {source,data}=await latestSource(db,p);
  return {source_record_id:source.id,source_updated_at:source.source_updated_at,package:data,can_refresh:p.status==='draft',notice:'Onayla birlikte önceki taslak işlem geçmişine alınır. Ürün eşleşmeleri sıfırlanır; stok ayırmadan önce yeniden kontrol edilir.'};
 }
 if(method!=='POST')return null;const x=await readBody(request);
 if(path==='/api/orders'){
  if(!['trendyol','hepsiburada','other'].includes(x.channel))fail('Satış kanalı geçersiz.');
  if(!Array.isArray(x.lines))fail('Sipariş satırları gerekli.');
  return createPackage(env,x.channel,{...x,lines:x.lines.map(l=>({...l,quantity_milli:qty(l.quantity),gross_cents:money(l.gross),vat_bps:vat(l.vat_rate),net_revenue_cents:money(l.net_revenue)}))});
 }
 const match=path.match(/^\/api\/orders\/([\w-]+)\/(map|reserve|ship|deliver|cancel|refresh)$/);if(!match)return null;
 const key=match[1],action=match[2],p=await statement(db,'SELECT * FROM order_packages WHERE id=?',[key]).first();if(!p)fail('Sipariş paketi bulunamadı.',404);
 const lines=(await statement(db,'SELECT * FROM order_lines WHERE package_id=? ORDER BY rowid',[key]).all()).results;
 const components=(await statement(db,'SELECT c.*,p.stock_unit current_stock_unit FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN products p ON p.id=c.product_id WHERE l.package_id=? ORDER BY c.rowid',[key]).all()).results;
 if(action==='refresh'){
  if(p.status!=='draft')fail('Yalnızca stok ayrılmamış taslak yenilenebilir. Gönderilmiş veya iptal edilmiş kaydın geçmişi değiştirilmez.',409);
  if(x.confirm!==true)fail('Güncel kaynak satırlarını inceleyip yenilemeyi onaylayın.',409);
  const {source,data,hash}=await latestSource(db,p);if(x.source_record_id!==source.id)fail('Kaynak incelemeden sonra değişti. Güncel kaydı tekrar açın.',409);
  const already=await statement(db,'SELECT id FROM order_refresh_audit WHERE package_id=? AND source_record_id=? AND applied=1',[key,source.id]).first();if(already&&p.source_fingerprint===hash&&!p.source_changed)return {id:key,status:'draft',existing:true};
  const audit=id(),items=[statement(db,'INSERT INTO order_refresh_audit(id,package_id,source_record_id,old_package_json,old_lines_json,new_fingerprint,old_components_json) VALUES(?,?,?,?,?,?,?)',[audit,key,source.id,JSON.stringify(p),JSON.stringify(lines),hash,JSON.stringify(components)]),statement(db,'DELETE FROM order_line_components WHERE line_id IN (SELECT id FROM order_lines WHERE package_id=?)',[key]),statement(db,'DELETE FROM order_lines WHERE package_id=?',[key]),lineInsert(db,key,data.lines.map(l=>({...l,id:id(),product_id:null})))];
  items.push(statement(db,"UPDATE order_packages SET order_no=?,occurred_on=?,external_status=?,source_fingerprint=?,source_changed=0 WHERE id=? AND status='draft'",[data.order_no,data.occurred_on,data.external_status,hash,key]),statement(db,'UPDATE order_refresh_audit SET applied=1 WHERE id=?',[audit]));
  await execute(db,items);return {id:key,status:'draft',refreshed:true,source_record_id:source.id};
 }
 if(['reserve','ship'].includes(action)&&components.some(c=>c.stock_unit!==c.current_stock_unit))fail('Stok birimi eşleştirmeden sonra değişmiş. Bileşen dönüşümünü yeniden doğrulayın.',409);
 // Rapora bagli siparis: kaynak guncelligi fiziksel stok hareketinden once ZORUNLU olarak denetlenir.
 if(['reserve','ship'].includes(action))await assertReportLinkFresh(db,p,fail);
 if(action==='map'){
  if(p.status!=='draft')fail('Yalnızca taslak sipariş eşleştirilebilir.',409);
  if(!Array.isArray(x.lines)||!x.lines.length||x.lines.length>10)fail('Bir işlemde 1–10 satır eşleştirin.');
  const seen=new Set(),patches=[],newComponents=[];for(const mapping of x.lines){const line=lines.find(l=>l.id===mapping.id);if(!line||seen.has(mapping.id))fail('Sipariş satırı bulunamadı veya tekrar ediyor.',404);seen.add(mapping.id);
   if(!mapping.mapping_id&&!mapping.product_id)fail('Ürün veya kayıtlı eşleştirme seçin.');const rows=await mappedComponents(db,p.channel,line,mapping);newComponents.push(...rows);
   const tax=mapping.vat_rate===undefined?line.vat_bps:vat(mapping.vat_rate),net=mapping.net_revenue===undefined?null:money(mapping.net_revenue),finalNet=netAmount(line.gross_cents,tax,net??(mapping.vat_rate===undefined?line.net_revenue_cents:null));
   patches.push({id:line.id,product_id:rows.length===1?rows[0].product_id:null,vat_bps:tax,net_revenue_cents:finalNet});
  }
  if(newComponents.length+components.filter(c=>!seen.has(c.line_id)).length>20)fail('Paket en fazla 20 stok bileşeni içerebilir.',409);
  const items=[statement(db,'DELETE FROM order_line_components WHERE line_id IN (SELECT value FROM json_each(?))',[JSON.stringify([...seen])]),componentInsert(db,newComponents),statement(db,"WITH patch AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.product_id') product_id,json_extract(value,'$.vat_bps') vat_bps,json_extract(value,'$.net_revenue_cents') net_revenue_cents FROM json_each(?)) UPDATE order_lines SET product_id=(SELECT product_id FROM patch WHERE patch.id=order_lines.id),vat_bps=(SELECT vat_bps FROM patch WHERE patch.id=order_lines.id),net_revenue_cents=(SELECT net_revenue_cents FROM patch WHERE patch.id=order_lines.id) WHERE id IN (SELECT id FROM patch)",[JSON.stringify(patches)])];
  await execute(db,items);return {id:key,status:p.status};
 }
 if(action==='reserve'){
  if(p.status==='reserved')return {id:key,status:p.status,existing:true};
  const reserved=await execute(db,[statement(db,"UPDATE order_packages SET status='reserved' WHERE id=? AND report_link_hash IS ? RETURNING id",[key,p.report_link_hash??null])]);
  if(!reserved[0].results.length)fail('Siparişin kaynak bağlantısı bu sırada değişti. Kaydı yeniden inceleyin.',409);
  return {id:key,status:'reserved'};
 }
 if(action==='cancel'){
  if(p.status==='cancelled')return {id:key,status:p.status,existing:true};
  if(!['draft','reserved'].includes(p.status))fail('Gönderilen sipariş iptal edilemez; iade kaydı kullanın.',409);
  await execute(db,[statement(db,"UPDATE order_packages SET status='cancelled',cancel_reason=? WHERE id=?",[text(x.reason,'İptal nedeni',1000),key])]);return {id:key,status:'cancelled'};
 }
 if(action==='deliver'){
  const date=day(x.occurred_on);if(p.status==='delivered')return {id:key,status:p.status,existing:true};
  if(p.status!=='shipped')fail('Önce gönderim kaydı oluşturun.',409);if(date<p.shipped_on)fail('Teslim tarihi gönderimden önce olamaz.');
  await execute(db,[statement(db,"UPDATE order_packages SET status='delivered',delivered_on=? WHERE id=?",[date,key])]);return {id:key,status:'delivered'};
 }
 if(action==='ship'){
  const date=day(x.occurred_on),reference=text(x.reference,'Gönderi referansı');
  if(['shipped','delivered'].includes(p.status)){if(p.shipment_reference!==reference)fail('Bu paket farklı referansla zaten gönderilmiş.',409);return {id:key,status:p.status,existing:true};}
  if(p.status!=='reserved')fail('Önce sipariş için stok ayırın.',409);if(date<p.occurred_on)fail('Gönderim tarihi siparişten önce olamaz.');
  const items=[statement(db,"UPDATE order_packages SET status='shipped',shipped_on=?,shipment_reference=? WHERE id=? AND report_link_hash IS ? RETURNING id",[date,reference,key,p.report_link_hash??null])];
  if(components.length>20||lines.some(l=>components.filter(c=>c.line_id===l.id).reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000))fail('Sipariş bileşenleri eksik veya gelir payları geçersiz.',409);
  for(const l of lines){let share=0,allocated=0;for(const c of components.filter(c=>c.line_id===l.id)){share+=c.revenue_share_bps;const cumulative=Number((BigInt(l.net_revenue_cents)*BigInt(share)+5000n)/10000n),revenue=cumulative-allocated;allocated=cumulative;const sale=id();items.push(statement(db,"INSERT INTO sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on,notes) SELECT ?,?,?,product_id,'sale',?,?,CAST(ROUND(value_cents*?/MAX(quantity_milli,1.0)) AS INTEGER),NULL,NULL,NULL,'pending',?,? FROM stock_balances WHERE product_id=?",[sale,p.channel,'order:'+key+':'+c.id,c.quantity_milli,revenue,c.quantity_milli,date,'Paket '+p.external_id+' / '+reference+' / '+l.name,c.product_id]));items.push(statement(db,'UPDATE order_line_components SET sale_id=? WHERE id=?',[sale,c.id]));}}
  items.push(statement(db,'UPDATE order_lines SET sale_id=(SELECT MIN(sale_id) FROM order_line_components c WHERE c.line_id=order_lines.id HAVING COUNT(*)=1) WHERE package_id=?',[key]));
  const shipped=await execute(db,items);
  if(!shipped[0].results.length)fail('Siparişin kaynak bağlantısı bu sırada değişti. Kaydı yeniden inceleyin.',409);
  return {id:key,status:'shipped'};
 }
 return null;
}
