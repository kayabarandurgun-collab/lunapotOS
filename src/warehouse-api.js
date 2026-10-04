import {can} from '../public/permissions.js';
import {scrubAmounts} from './permission-policy.js';
import {physicalStock,stockTransitQuery} from './stock-availability.js';

export const warehouseFail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fail=warehouseFail;
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const rows=async(db,sql,args=[]) => (await stmt(db,sql,args).all()).results;
const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(label+' geçersiz.');return v;};
const text=(v,label,max=200)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const key=(v)=>{if(typeof v!=='string'||! /^[\w-]{1,100}$/.test(v))fail('Kayıt kimliği geçersiz.');return v;};
const optional=v=>v==null||v===''?'':text(v,'Not',1000);
const today=()=>new Date(Date.now()+3*3600000).toISOString().slice(0,10);
export function warehousePermission(env,write=false){
 if(!['ec','lp'].includes(env.WORKSPACE)||!can(env.USER,env.WORKSPACE,env.WORKSPACE==='ec'?'stock':'accounts',write))fail('Depo için '+(write?'yazma':'okuma')+' yetkisi gerekiyor.',403);
}
const reservedSql=`COALESCE((SELECT SUM(r.quantity_milli) FROM order_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0)+COALESCE((SELECT SUM(r.quantity_milli) FROM ws_stock_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0)`;
export async function warehouseStock(env,productId=''){
 const ec=env.WORKSPACE==='ec',db=env.DB;
 const statements=[stmt(db,`SELECT p.id,p.name,p.sku,p.stock_unit,p.category,p.min_stock_milli,p.archived_at,
 ${ec?'p.brand,p.supplier_id':"'' brand,NULL supplier_id"},b.quantity_milli,b.value_cents,
 ${ec?reservedSql:'NULL'} reserved_milli FROM products p JOIN stock_balances b ON b.product_id=p.id
 WHERE ${productId?'p.id=?':'(p.archived_at IS NULL OR b.quantity_milli!=0 OR b.value_cents!=0)'} ORDER BY p.name,p.id`,productId?[productId]:[])];
 if(ec)statements.push(db.prepare(stockTransitQuery));
 const [stock,transit=[]]=(await db.batch(statements)).map(r=>r.results);
 return physicalStock(stock,transit,env.WORKSPACE);
}
export function reorderProposal(product,config={},demand=0){
 const lead=config.lead_days??null,cover=config.cover_days??7,pack=config.pack_milli??(product.stock_unit==='adet'?1000:1);
 const daily=demand/30,known=Number.isSafeInteger(product.available_milli),target=lead===null?null:Math.max(product.min_stock_milli,Math.ceil(daily*(lead+cover)));
 const need=known&&target!==null?Math.max(0,target-product.available_milli):null;
 return {product_id:product.id,name:product.name,sku:product.sku,stock_unit:product.stock_unit,available_milli:product.available_milli,
  min_stock_milli:product.min_stock_milli,demand_30_milli:demand,daily_demand_milli:Math.round(daily),lead_days:lead,cover_days:cover,
  pack_milli:pack,config_revision:config.revision||0,notes:config.notes||'',target_milli:target,
  min_gap_milli:known?Math.max(0,product.min_stock_milli-product.available_milli):null,
  suggested_milli:need===null?null:Math.ceil(need/pack)*pack,
  reason:!known?'Kullanılabilir stok bilinmiyor.':lead===null?'Tedarik süresini girin; minimum stok açığı ayrıca gösterilir.':'Son 30 günün net sevk adedi × (tedarik süresi + hedef gün); minimum stok alt sınırdır.'};
}
export async function warehouseReplenishment(env,stock){
 if(env.WORKSPACE!=='ec')return {supported:false,proposals:[],sets:[],assumptions:[]};
 const [configs,demand,setRows]=(await env.DB.batch([
  env.DB.prepare('SELECT * FROM ec_warehouse_reorder_settings'),
  env.DB.prepare("SELECT product_id,MAX(0,SUM(iif(kind='sale',quantity_milli,-quantity_milli))) demand_milli FROM sale_entries WHERE occurred_on BETWEEN date('now','+3 hours','-29 days') AND date('now','+3 hours') GROUP BY product_id"),
  env.DB.prepare(`SELECT m.id,m.external_code,m.external_name,m.source,c.product_id,p.name,p.stock_unit,c.quantity_milli
   FROM catalog_mappings m JOIN catalog_mapping_components c ON c.mapping_id=m.id JOIN products p ON p.id=c.product_id
   WHERE m.active=1 AND m.source!='purchase' ORDER BY m.id,c.product_id`)
 ])).map(r=>r.results);
 const byConfig=new Map(configs.map(x=>[x.product_id,x])),byDemand=new Map(demand.map(x=>[x.product_id,x.demand_milli])),byProduct=new Map(stock.map(x=>[x.id,x]));
 const sets=new Map();
 for(const r of setRows){if(!sets.has(r.id))sets.set(r.id,{id:r.id,external_code:r.external_code,name:r.external_name||r.external_code,source:r.source,components:[]});
  const p=byProduct.get(r.product_id),available=p?.available_milli??null;
  sets.get(r.id).components.push({product_id:r.product_id,name:r.name,stock_unit:r.stock_unit,quantity_milli:r.quantity_milli,available_milli:available,capacity:available===null?null:Math.max(0,Math.floor(available/r.quantity_milli))});
 }
 return {supported:true,proposals:stock.map(p=>reorderProposal(p,byConfig.get(p.id),byDemand.get(p.id)||0)),
  sets:can(env.USER,'ec','catalog')?[...sets.values()].filter(s=>s.components.length>1||s.components.some(c=>c.quantity_milli!==1000)).map(s=>({...s,capacity:s.components.some(c=>c.capacity===null)?null:Math.min(...s.components.map(c=>c.capacity))})):[],
  assumptions:['Talep son 30 takvim gününün kayıtlı satış çıkışları eksi iadeleridir. Set bileşenleri satış defterinde zaten var; ikinci kez eklenmez.',
   'Tedarik süresi elle girilir. Hedef gün başlangıçta 7; ambalaj miktarı adet için 1, diğer birimler için 0,001 olarak başlar.',
   'Kullanılabilir = depoda − ayrılan. Kargodaki müşteri siparişi depodan zaten çıktı; tekrar düşülmez.',
   'Açık satın alma siparişlerinin doğrulanmış geliş tarihi bulunmadığından beklenen alışlar öneriden düşülmez. Sipariş vermeden önce gelen malları ve açık alışları kontrol edin.',
   'Set kapasiteleri alternatif senaryolardır. Ortak bileşen kullanan setlerin kapasiteleri toplanamaz. Bu ekran sipariş veya stok hareketi oluşturmaz.']};
}
const errors={WAREHOUSE_UNIT:['Güncel ürün birimi adet; sayım tam sayı olmalı.',400],WAREHOUSE_APPLIED:['Bu sayım uygulandı; düzenlenemez.',409],WAREHOUSE_REVISION:['Sayım başka bir cihazda değişti. Yenileyip tekrar deneyin.',409],WAREHOUSE_LINE_LOCKED:['Sayım satırı kilitli.',409],WAREHOUSE_REVIEW_REQUIRED:['Önce sayım farklarını gözden geçirin.',409],WAREHOUSE_REVIEW_EXPIRED:['Önizleme günü değişti. Farkları yeniden gözden geçirin.',409],WAREHOUSE_EMPTY:['En az bir ürünü sayın.',400],WAREHOUSE_STOCK_CHANGED:['Sayım sırasında stok veya maliyet değişti. İşaretli ürünleri yeniden sayıp kaydedin.',409],WAREHOUSE_COST_REQUIRED:['Sayım fazlası için KDV hariç birim maliyeti girin. Bilinmeyen maliyet sıfır değildir.',400],WAREHOUSE_RESERVED:['Sayılan miktar ayrılan siparişlerden az. Ayırmaları kontrol edin.',409],WAREHOUSE_VALUE_LIMIT:['Sayım tutarı sınırı aşıyor.',400]};
async function batch(db,items){try{return await db.batch(items);}catch(e){for(const [code,[message,status]] of Object.entries(errors))if(String(e.message).includes(code))fail(message,status);
 if(/STOCK_RESERVED|INSUFFICIENT_STOCK|INVALID_STOCK_VALUE/.test(e.message))fail('Stok veya ayrılan miktar işlemi engelledi. Sayımı yeniden kontrol edin.',409);
 if(/FOREIGN KEY/.test(e.message))fail('Kayıt bu çalışma alanında bulunamadı.',404);throw e;}}
async function session(db,id){const row=await stmt(db,'SELECT * FROM ec_warehouse_sessions WHERE id=?',[id]).first();if(!row)fail('Sayım bulunamadı.',404);return row;}
async function detail(db,id){
 const [headers,lines]=(await db.batch([stmt(db,'SELECT * FROM ec_warehouse_sessions WHERE id=?',[id]),stmt(db,'SELECT * FROM ec_warehouse_count_review WHERE session_id=? ORDER BY product_name,product_id',[id])])).map(r=>r.results);
 if(!headers.length)fail('Sayım bulunamadı.',404);
 const header=headers[0],counted=lines.filter(l=>l.counted_milli!==null),changed=counted.filter(l=>l.delta_milli!==0);
 const {request_json,edit_token,...safeHeader}=header;
 return {session:safeHeader,lines,summary:{total:lines.length,counted:counted.length,uncounted:lines.length-counted.length,changed:changed.length,
  conflicts:counted.filter(l=>l.conflict).length,missing_cost:changed.filter(l=>l.delta_value_cents===null).length,
  delta_value_cents:changed.some(l=>l.delta_value_cents===null)?null:changed.reduce((t,l)=>t+l.delta_value_cents,0)}};
}
export async function warehouseApi(request,env,path,readBody=r=>r.json()){
 if(!/^\/api\/warehouse(?:\/|$)/.test(path))return null;
 const write=request.method!=='GET';warehousePermission(env,write);
 if(!['GET','POST'].includes(request.method))fail('İşlem desteklenmiyor.',405);
 if(env.WORKSPACE!=='ec'){
  if(path==='/api/warehouse'&&!write)return {supported:false,reason:'Kayıtlı çoklu sayım şu anda e-ticaret deposunda kullanılabilir. Üretim ve hammadde sayımı mevcut ekranlardan yapılır.'};
  fail('Bu depo işlemi yalnızca e-ticaret alanındadır.',400);
 }
 const db=env.DB,output=x=>scrubAmounts(x,env.USER,'ec');
 if(path==='/api/warehouse'&&!write){
  const stock=await warehouseStock(env),replenishment=await warehouseReplenishment(env,stock);
  const sessions=await rows(db,`SELECT s.id,s.title,s.status,s.revision,s.created_at,s.updated_at,s.applied_at,COUNT(l.product_id) total,SUM(l.counted_milli IS NOT NULL) counted
   FROM ec_warehouse_sessions s LEFT JOIN ec_warehouse_count_lines l ON l.session_id=s.id GROUP BY s.id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 201`);
  return output({supported:true,stock,sessions:sessions.slice(0,200),sessions_truncated:sessions.length>200,replenishment,as_of:new Date().toISOString()});
 }
 if(path==='/api/warehouse/sessions'&&write){
  const x=await readBody(request),requestKey=key(x.request_key),title=text(x.title,'Sayım adı',120);
  let ids=null;if(x.product_ids!==undefined){if(!Array.isArray(x.product_ids)||!x.product_ids.length||x.product_ids.length>3000)fail('1–3000 fiziksel ürün seçin.');ids=[...new Set(x.product_ids.map(key))].sort();}
  const fingerprint=JSON.stringify({title,product_ids:ids}),old=await stmt(db,'SELECT id,request_json FROM ec_warehouse_sessions WHERE request_key=?',[requestKey]).first();
  if(old){if(old.request_json!==fingerprint)fail('İstek anahtarı başka bir sayım için kullanıldı.',409);return output(await detail(db,old.id));}
  const count=await stmt(db,`SELECT COUNT(*) n FROM products p JOIN stock_balances b ON b.product_id=p.id WHERE ${ids?'p.id IN (SELECT value FROM json_each(?))':'p.archived_at IS NULL OR b.quantity_milli!=0 OR b.value_cents!=0'}`,ids?[JSON.stringify(ids)]:[]).first();
  if(count.n<1||count.n>3000)fail('Bir sayımda 1–3000 fiziksel ürün olabilir.');if(ids&&count.n!==ids.length)fail('Seçilen ürün bu depoda bulunamadı; set ilanları sayılmaz.',404);
  const id=crypto.randomUUID();
  await batch(db,[stmt(db,`INSERT INTO ec_warehouse_sessions(id,request_key,request_json,title,created_by) VALUES(?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`,[id,requestKey,fingerprint,title,String(env.USER?.id||'owner')]),
   stmt(db,`INSERT INTO ec_warehouse_count_lines(session_id,product_id,product_name,sku,stock_unit,snapshot_quantity_milli,snapshot_value_cents,snapshot_revision)
    SELECT ?,p.id,p.name,p.sku,p.stock_unit,b.quantity_milli,b.value_cents,v.revision FROM products p JOIN stock_balances b ON b.product_id=p.id
    JOIN ec_warehouse_stock_versions v ON v.product_id=p.id WHERE EXISTS(SELECT 1 FROM ec_warehouse_sessions WHERE id=?) AND (${ids?'p.id IN (SELECT value FROM json_each(?))':'p.archived_at IS NULL OR b.quantity_milli!=0 OR b.value_cents!=0'})`,[id,id,...(ids?[JSON.stringify(ids)]:[])])]);
  const saved=await stmt(db,'SELECT id,request_json FROM ec_warehouse_sessions WHERE request_key=?',[requestKey]).first();
  if(saved.request_json!==fingerprint)fail('İstek anahtarı başka bir sayım için kullanıldı.',409);
  return output(await detail(db,saved.id));
 }
 const configMatch=path.match(/^\/api\/warehouse\/settings\/([\w-]+)$/);
 if(configMatch&&write){const product=key(configMatch[1]),x=await readBody(request),revision=integer(x.revision,0,1e9,'Sürüm');
  const lead=x.lead_days===null?null:integer(x.lead_days,0,365,'Tedarik günü'),cover=integer(x.cover_days,0,365,'Hedef gün'),pack=integer(x.pack_milli,1,1e9,'Ambalaj miktarı');
  const p=await stmt(db,'SELECT stock_unit FROM products WHERE id=?',[product]).first();if(!p)fail('Ürün bulunamadı.',404);if(p.stock_unit==='adet'&&pack%1000)fail('Adet ambalajı tam sayı olmalı.');
  const r=await batch(db,[stmt(db,`INSERT INTO ec_warehouse_reorder_settings(product_id,lead_days,cover_days,pack_milli,notes,revision)
   SELECT ?,?,?,?,?,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM ec_warehouse_reorder_settings WHERE product_id=?)
   ON CONFLICT(product_id) DO UPDATE SET lead_days=excluded.lead_days,cover_days=excluded.cover_days,pack_milli=excluded.pack_milli,notes=excluded.notes,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE revision=? RETURNING product_id`,[product,lead,cover,pack,optional(x.notes),revision,product,revision])]);
  if(!r[0].results.length)fail('Tedarik ayarı başka cihazda değişti. Yenileyin.',409);return {product_id:product};
 }
 const match=path.match(/^\/api\/warehouse\/sessions\/([\w-]+)(?:\/(lines|review|apply))?$/);
 if(!match)fail('Depo işlemi bulunamadı.',404);
 const id=key(match[1]),action=match[2];
 if(!action&&!write)return output(await detail(db,id));
 if(!write||!action)fail('Depo işlemi bulunamadı.',404);
 const x=await readBody(request),revision=integer(x.revision,0,1e9,'Sayım sürümü'),s=await session(db,id);
 if(action==='apply'&&s.status==='applied'){
  if(x.review_token!==s.review_token)fail('Uygulanan sayımın onay anahtarı farklı.',409);
  return output({...await detail(db,id),repeated:true});
 }
 if(s.status==='applied')fail('Bu sayım uygulandı; düzenlenemez.',409);
 if(s.revision!==revision)fail('Sayım başka cihazda değişti. Yenileyin.',409);
 if(action==='lines'){
  if(!Array.isArray(x.lines)||x.lines.length<1||x.lines.length>200)fail('Tek kayıtta 1–200 satır düzenlenebilir.');
  const savedLines=await rows(db,'SELECT l.product_id,l.stock_unit,p.stock_unit current_stock_unit FROM ec_warehouse_count_lines l JOIN products p ON p.id=l.product_id WHERE l.session_id=?',[id]);
  const units=new Map(savedLines.map(l=>[l.product_id,l])),seen=new Set(),token=crypto.randomUUID();
  const items=[stmt(db,"UPDATE ec_warehouse_sessions SET revision=revision+1,edit_token=?,status='draft',review_token=NULL,reviewed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=? AND status!='applied' RETURNING id",[token,id,revision])];
  for(const l of x.lines){const product=key(l.product_id);if(!units.has(product))fail('Ürün bu sayımda bulunamadı.',404);if(seen.has(product))fail('Aynı ürün iki kez gönderilemez.');seen.add(product);
   const qty=l.counted_milli===null?null:integer(l.counted_milli,0,1e9,'Sayılan miktar');if(qty!==null&&(l.recount?units.get(product).current_stock_unit:units.get(product).stock_unit)==='adet'&&qty%1000)fail('Adet sayımı tam sayı olmalı.');
   const cost=l.unit_cost_cents==null?null:integer(l.unit_cost_cents,0,1e9,'Birim maliyet');
   if(Object.hasOwn(l,'unit_cost_cents')&&!can(env.USER,'ec','amounts'))fail('Birim maliyet girmek için tutar yetkisi gerekiyor.',403);
   if(l.recount!==undefined&&typeof l.recount!=='boolean')fail('Yeniden sayım seçimi geçersiz.');
   if(l.recount&&qty===null)fail('Yeniden sayılan miktarı girin.');
   const rebase=l.recount?`,snapshot_quantity_milli=(SELECT quantity_milli FROM stock_balances WHERE product_id=?),snapshot_value_cents=(SELECT value_cents FROM stock_balances WHERE product_id=?),snapshot_revision=(SELECT revision FROM ec_warehouse_stock_versions WHERE product_id=?),stock_unit=(SELECT stock_unit FROM products WHERE id=?)`:'';
   items.push(stmt(db,`UPDATE ec_warehouse_count_lines SET counted_milli=?,unit_cost_cents=iif(?,?,unit_cost_cents),notes=?,counted_at=iif(? IS NULL,NULL,CURRENT_TIMESTAMP)${rebase}
    WHERE session_id=? AND product_id=? AND EXISTS(SELECT 1 FROM ec_warehouse_sessions WHERE id=? AND edit_token=?)`,[qty,Object.hasOwn(l,'unit_cost_cents')?1:0,cost,optional(l.notes),qty,...(l.recount?[product,product,product,product]:[]),id,product,id,token]));
  }
  const r=await batch(db,items);if(!r[0].results.length)fail('Sayım başka cihazda değişti. Yenileyin.',409);
 }else if(action==='review'){
  const token=crypto.randomUUID();const r=await batch(db,[stmt(db,"UPDATE ec_warehouse_sessions SET status='reviewed',revision=revision+1,review_token=?,occurred_on=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=? AND status!='applied' RETURNING id",[token,today(),id,revision])]);
  if(!r[0].results.length)fail('Sayım değişti; yeniden kontrol edin.',409);
 }else{
  const token=key(x.review_token);if(s.status!=='reviewed'||s.review_token!==token)fail('Önce farkları gözden geçirin.',409);
  const r=await batch(db,[stmt(db,"UPDATE ec_warehouse_sessions SET status='applied',revision=revision+1,applied_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=? AND review_token=? AND status='reviewed' RETURNING id",[id,revision,token])]);
  if(!r[0].results.length){const latest=await session(db,id);if(latest.status==='applied'&&latest.review_token===token)return output({...await detail(db,id),repeated:true});fail('Sayım başka cihazda değişti. Yenileyin.',409);}
 }
 return output(await detail(db,id));
}
