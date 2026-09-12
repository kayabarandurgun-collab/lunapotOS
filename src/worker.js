import {storeApi,webshopAdminApi,demoEnabled} from './webshop-api.js';
import {stockHistoryApi} from './stock-history-api.js';
import {partyStatementApi} from './party-statement-api.js';
import {offersApi} from './offers-api.js';
import {barcodeApi} from './barcode-api.js';
import {lotApi} from './lot-api.js';
import {loginLimitSubjects} from './login-limits.js';
import {filterProductionData,scrubAmounts} from './permission-policy.js';
import {purchaseAdjustmentApi} from './purchase-adjustment-api.js';
import {hash,hex,passwordHash,equal,currentSession,owner,authorize,accessApi,acceptInvite} from './access-api.js';
import {convert} from '../public/costs.js';
import {accountingApi} from './accounting.js';
import {scopedDB} from './scoped-db.js';
import {pricingApi} from './pricing-api.js';
import {ledgerApi} from './ledger-api.js';
import {settingsApi} from './settings-api.js';
import {ordersApi} from './orders-api.js';
import {connectionsApi} from './connections-api.js';
import {orderInsightsApi} from './order-insights-api.js';
import {orderEstimateApi} from './order-estimate-api.js';
import {catalogApi} from './catalog-api.js';
import {reconciliationApi} from './reconciliation-api.js';
import {performanceApi} from './performance-api.js';
import {productionApi} from './production-api.js';
import {purchaseSearchApi} from './purchase-search-api.js';
import {purchaseReturnApi} from './purchase-return-api.js';
import {purchaseSplitApi} from './purchase-split-api.js';
import {purchaseDocumentApi} from './purchase-document-api.js';
import {attentionApi} from './attention-api.js';
import {reportInboxApi} from './report-inbox-api.js';
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const str=(v,name,max=200)=> {if(typeof v!=='string'||!v.trim()||v.length>max)fail(name+' alanını kontrol edin.');return v.trim();};
const optional=(v,max=500)=>{if(v===undefined)return '';if(typeof v!=='string'||v.length>max)fail('Metin çok uzun veya geçersiz.');return v.trim();};
const num=(v,name,min=0,max=1e9)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(name+' geçersiz.');return v;};
const validateUnits=(quantity,from,to)=>{try{return convert(quantity,from,to);}catch{fail('Uyumsuz veya geçersiz ölçü birimi.');}};
const now=()=>Math.floor(Date.now()/1000);
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const activity=(db,description)=>db.prepare('INSERT INTO activity(id,description) VALUES(?,?)').bind(crypto.randomUUID(),description);
// Rapor Kutusu dosya parçası ve satır partileri daha büyük olabilir; sınır yalnızca bu iki uçta yükselir.
const bodyLimit=request=>/^\/api\/ec\/reports\/files\/[\w-]{1,100}\/(chunk|rows)$/.test(new URL(request.url).pathname)||/^\/api\/(ec|lp)\/invoices\/documents\/[\w-]{1,100}\/chunk$/.test(new URL(request.url).pathname)?1000000:64000;
async function body(request){const limit=bodyLimit(request);if(Number(request.headers.get('content-length'))>limit)fail('İstek çok büyük.',413);const raw=await request.text();if(raw.length>limit)fail('İstek çok büyük.',413);try{return JSON.parse(raw);}catch{fail('Geçersiz veri.');}}
const session=currentSession;
// Tek bayt aralığı ("bytes=a-b", "bytes=a-", "bytes=-n"). Çoklu aralık desteklenmez; tam dosya döner.
export async function videoRange(request,response){
 const range=request.headers.get('Range');
 const base=new Headers(response.headers);base.set('Accept-Ranges','bytes');
 if(!range)return new Response(response.body,{status:200,headers:base});
 const bytes=new Uint8Array(await response.arrayBuffer()),size=bytes.length;
 const match=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
 if(!match||(!match[1]&&!match[2])){base.set('Content-Length',String(size));return new Response(bytes,{status:200,headers:base});}
 let start,end;
 if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){
  const bad=new Headers(base);bad.set('Content-Range',`bytes */${size}`);bad.delete('Content-Length');
  return new Response(null,{status:416,headers:bad});
 }
 base.set('Content-Range',`bytes ${start}-${end}/${size}`);base.set('Content-Length',String(end-start+1));
 return new Response(bytes.slice(start,end+1),{status:206,headers:base});
}
async function api(request,env,path){
 const db=env.DB;if(!db)fail('Veritabanı bağlantısı henüz kurulmadı.',503);
 // iyzico geri dönüşü (form) ve bildirimi (webhook) başka kaynaktan gelir; Origin/JSON denetimi
 // bu iki uca uygulanamaz. Bu uçlarda tek güven kaynağı, sunucunun sağlayıcıya yaptığı imzalı sorgudur.
 const providerCallback=path==='/api/store/payment/callback'||path==='/api/store/payment/webhook';
 if(!['GET','HEAD'].includes(request.method)&&!providerCallback) {
   if(request.headers.get('Origin')!==new URL(request.url).origin)fail('İstek kaynağı doğrulanamadı.',403);
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail('JSON veri gerekli.',415);
 }
 if(path==='/api/store'||path.startsWith('/api/store/'))return storeApi(request,env,path,body);
 if(path==='/api/auth/status'&&request.method==='GET') {
   const admin=await db.prepare('SELECT id FROM admin WHERE id=1').first();
   const current=await session(request,db);return json({authenticated:!!current,initialized:!!admin,user:current?.user||null});
 }
 if((path==='/api/auth/login'||path==='/api/auth/setup'||path==='/api/auth/accept-invite')&&request.method==='POST') {
   const input=await body(request);
   await db.prepare('DELETE FROM login_limits WHERE reset_at<?').bind(now()).run();
   const limits=await Promise.all(loginLimitSubjects(path,input,request.headers.get('CF-Connecting-IP')||'local').map(async limit=>({...limit,key:await hash(limit.subject)})));
   for(const limit of limits) {
     const attempt=await db.prepare('INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(limit.key,now()+900).first();
     if(attempt.attempts>limit.max)fail('Çok fazla deneme. 15 dakika sonra tekrar deneyin.',429);
   }
   if(path==='/api/auth/accept-invite')return json(await acceptInvite(db,input));
   const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';let staff=null;
   let admin=await db.prepare('SELECT * FROM admin WHERE id=1').first();
   if(path.endsWith('/setup')) {
     if(admin)fail('İlk kurulum daha önce tamamlandı.',409);
     if(!env.SETUP_TOKEN||!equal(input.token,env.SETUP_TOKEN))fail('Kurulum anahtarı geçersiz.',403);
     const password=str(input.password,'Şifre',200); if(password.length<12)fail('En az 12 karakterlik bir şifre seçin.');
     const salt=crypto.randomUUID();
     try{await db.prepare('INSERT INTO admin(id,salt,password_hash) VALUES(1,?,?)').bind(salt,await passwordHash(password,salt)).run();}catch{fail('İlk kurulum tamamlanmış. Giriş yapın.',409);}
   } else {
     if(!admin)fail('Önce ilk kurulum tamamlanmalı.',403);
     if(username&&username!=='admin'&&username!=='owner')staff=await db.prepare('SELECT * FROM staff_users WHERE username=? AND active=1 AND password_hash IS NOT NULL').bind(username).first();
     const account=username&&username!=='admin'&&username!=='owner'?staff:admin;
     const candidate=typeof input.password==='string'&&input.password.length<=200?await passwordHash(input.password,account?.salt||admin.salt):'';
     if(!account||!equal(candidate,account.password_hash))fail('Kullanıcı adı veya şifre hatalı.',401);
   }
   const token=hex(crypto.getRandomValues(new Uint8Array(32)));
   await db.batch([db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),db.prepare('INSERT INTO sessions(token_hash,expires_at,staff_id) VALUES(?,?,?)').bind(await hash(token),now()+604800,staff?.id||null),db.prepare('DELETE FROM login_limits WHERE key=?').bind(limits[1].key)]);
   const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
   return json({ok:true},200,{'Set-Cookie':`lunapot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`});
 }
 const current=await session(request,db);if(!current)fail('Lütfen giriş yapın.',401);authorize(current.user,path,request.method);
 if(path.startsWith('/api/webshop/'))return json(scrubAmounts(await webshopAdminApi(request,env,path,body,current.user),current.user,'ec'));
 const accessResult=await accessApi(request,env,path,body,current.user);if(accessResult!==null)return json(accessResult);
 const workspace=path.match(/^\/api\/(ec|lp)(\/.*)?$/);
 if(workspace){
  const scoped={...env,DB:scopedDB(db,workspace[1]),ROOT_DB:db,WORKSPACE:workspace[1],USER:current.user},subpath=workspace[2]||'';
  for(const handler of [purchaseDocumentApi,reportInboxApi,lotApi,barcodeApi,offersApi,partyStatementApi,stockHistoryApi,productionApi,purchaseAdjustmentApi,purchaseSearchApi,purchaseReturnApi,purchaseSplitApi,performanceApi,attentionApi,orderInsightsApi,orderEstimateApi,catalogApi,pricingApi,ledgerApi,settingsApi,ordersApi,connectionsApi,reconciliationApi]){const result=await handler(request,scoped,'/api'+subpath,body);if(result!==null)return json(scrubAmounts(result,current.user,workspace[1]));}
  return json(scrubAmounts(await accountingApi(request,scoped,'/api/accounting'+subpath,body),current.user,workspace[1]));
 }
 if(path==='/api/auth/logout'&&request.method==='POST') {
   const s=await session(request,db);await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(s.token_hash).run();
   return json({ok:true},200,{'Set-Cookie':'lunapot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure'});
 }
 if(path==='/api/data'&&request.method==='GET') {
   const results=await db.batch(["SELECT * FROM products WHERE inventory_kind='finished' ORDER BY updated_at DESC",'SELECT m.*,b.quantity_milli,b.value_cents,p.sku purchase_sku FROM materials m LEFT JOIN lp_material_balances b ON b.material_id=m.id LEFT JOIN products p ON p.id=m.purchase_product_id ORDER BY m.name','SELECT * FROM recipes ORDER BY updated_at DESC','SELECT * FROM recipe_items','SELECT * FROM activity ORDER BY created_at DESC LIMIT 10'].map(sql=>db.prepare(sql)));
   const [products,materials,recipes,items,activity]=results.map(r=>r.results);
   return json(scrubAmounts(filterProductionData({products,materials,recipes:recipes.map(r=>({...r,items:items.filter(i=>i.recipe_id===r.id)})),activity},current.user),current.user,'lp'));
 }
 const match=path.match(/^\/api\/(materials|products|recipes)(?:\/([\w-]{1,80}))?$/);if(!match)fail('Bulunamadı.',404);
 const [,kind,id]=match;
 if(request.method==='DELETE'&&id) {
   const record=await db.prepare(`SELECT * FROM ${kind} WHERE id=?`).bind(id).first();if(!record)fail('Kayıt bulunamadı.',404);
   if(kind==='products'&&record.inventory_kind==='material')fail('Bu kart bir hammaddeye bağlı. Hammadde kartından işlem yapın.',409);
   const deletions=[];
   if(kind==='materials')deletions.push(db.prepare('DELETE FROM lp_material_balances WHERE material_id=? AND quantity_milli=0 AND value_cents=0').bind(id));
   if(kind==='materials'&&await db.prepare('SELECT id FROM lp_material_movements WHERE material_id=? LIMIT 1').bind(id).first())fail('Stok geçmişi olan hammadde silinemez.',409);
   if(kind==='materials'&&await db.prepare('SELECT id FROM recipe_items WHERE material_id=? LIMIT 1').bind(id).first())fail('Bu hammadde bir reçetede kullanılıyor. Önce reçeteden çıkarın.',409);
   if(kind==='products'){
    if(await db.prepare('SELECT id FROM lp_stock_movements WHERE product_id=? LIMIT 1').bind(id).first()||await db.prepare('SELECT id FROM lp_purchase_lines WHERE product_id=? LIMIT 1').bind(id).first())fail('Stok veya muhasebe kaydı olan ürün silinemez.',409);
    deletions.push(db.prepare('DELETE FROM lp_stock_balances WHERE product_id=? AND quantity_milli=0 AND value_cents=0').bind(id));
   }
   await db.batch([...deletions,db.prepare(`DELETE FROM ${kind} WHERE id=?`).bind(id),activity(db,`${record.name||'Reçete'} silindi`)]);return json({ok:true});
 }
 if(!['POST','PUT'].includes(request.method)|| (request.method==='PUT'&&!id)|| (request.method==='POST'&&id))fail('İşlem desteklenmiyor.',405);
 const input=await body(request),recordId=id||crypto.randomUUID(),timestamp=new Date().toISOString();
 if(id&&!await db.prepare(`SELECT id FROM ${kind} WHERE id=?`).bind(id).first())fail('Kayıt bulunamadı.',404);
 let statements=[];
 if(kind==='materials') {
   const name=str(input.name,'Hammadde adı'),unit=str(input.unit,'Birim',10),price=num(input.price,'Birim fiyat');validateUnits(1,unit,unit);
   if(id){const old=await db.prepare('SELECT unit FROM materials WHERE id=?').bind(id).first();if(old.unit!==unit&&await db.prepare('SELECT id FROM lp_material_movements WHERE material_id=? LIMIT 1').bind(id).first())fail('Stok geçmişi olan hammaddenin birimi değiştirilemez.',409);if(old.unit!==unit&&await db.prepare('SELECT id FROM recipe_items WHERE material_id=? LIMIT 1').bind(id).first())fail('Reçetede kullanılan hammaddenin alış birimini değiştiremezsiniz.',409);}
   statements.push(db.prepare('INSERT INTO materials(id,name,unit,price,supplier,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit=excluded.unit,price=excluded.price,supplier=excluded.supplier,updated_at=excluded.updated_at').bind(recordId,name,unit,price,optional(input.supplier),timestamp));
   statements.push(activity(db,`${name} ${id?'güncellendi':'eklendi'}`));
 } else if(kind==='products') {
   if(id&&(await db.prepare('SELECT inventory_kind FROM products WHERE id=?').bind(id).first())?.inventory_kind==='material')fail('Hammadde kartını Hammaddeler ekranından düzenleyin.',409);
   const name=str(input.name,'Ürün adı'),sku=str(input.sku,'Ürün kodu',80);
   statements.push(db.prepare('INSERT INTO products(id,name,sku,category,sale_price,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,sale_price=excluded.sale_price,updated_at=excluded.updated_at').bind(recordId,name,sku,optional(input.category,100),num(input.sale_price,'Satış fiyatı'),timestamp));
   statements.push(activity(db,`${name} ${id?'güncellendi':'eklendi'}`));
 } else {
   const productId=str(input.product_id,'Ürün',80);if(!await db.prepare("SELECT id FROM products WHERE id=? AND inventory_kind='finished'").bind(productId).first())fail('Ürün bulunamadı.');
   if(!Array.isArray(input.items)||input.items.length<1||input.items.length>200)fail('Reçetede 1–200 hammadde olmalı.');
   const materials=(await db.prepare('SELECT id,unit FROM materials').all()).results,seen=new Set();
   for(const item of input.items){if(!item||typeof item!=='object')fail('Hammadde satırı geçersiz.');const m=materials.find(m=>m.id===item.material_id);if(!m||seen.has(m.id))fail('Hammadde eksik veya birden fazla eklenmiş.');seen.add(m.id);num(item.quantity,'Miktar',0.000001);validateUnits(item.quantity,item.unit,m.unit);}
   statements.push(db.prepare('INSERT INTO recipes(id,product_id,yield_qty,waste_pct,labor,packaging,overhead,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,yield_qty=excluded.yield_qty,waste_pct=excluded.waste_pct,labor=excluded.labor,packaging=excluded.packaging,overhead=excluded.overhead,notes=excluded.notes,updated_at=excluded.updated_at').bind(recordId,productId,num(input.yield_qty,'Üretim adedi',0.000001),num(input.waste_pct,'Fire oranı',0,100),num(input.labor,'İşçilik'),num(input.packaging,'Paketleme'),num(input.overhead,'Diğer giderler'),optional(input.notes,2000),timestamp));
   statements.push(db.prepare('DELETE FROM recipe_items WHERE recipe_id=?').bind(recordId));
   statements.push(db.prepare("INSERT INTO recipe_items(id,recipe_id,material_id,quantity,unit) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.material_id'),json_extract(value,'$.quantity'),json_extract(value,'$.unit') FROM json_each(?)").bind(recordId,JSON.stringify(input.items.map(i=>({...i,id:crypto.randomUUID()})))));
   statements.push(activity(db,'Ürün reçetesi '+(id?'güncellendi':'eklendi')));
 }
 try{await db.batch(statements);}catch(error){if(/UNIQUE constraint/.test(error.message))fail('Aynı ad/kod veya ürüne ait reçete zaten var.',409);throw error;}
 return json({id:recordId},id?200:201);
}
export default {async fetch(request,env) {
 let response;
 try {const path=new URL(request.url).pathname;
  // Musteri magazasi henuz satisa acilmadi. Dosyalar yayin paketinde bulunsa da canli
  // muhasebe adresinde SUNULMAZ; yalnizca yerel demo ortaminda acilir. Boylece paketin
  // icinde durmasi "magaza yayinda" anlamina gelmez.
  if((path==='/magaza'||path.startsWith('/magaza/'))&&!demoEnabled(request,env))response=json({error:'Web mağaza henüz satışa açılmadı.'},404);
  else if(path.startsWith('/api/'))response=await api(request,env,path);else if(path==='/webmagaza'||path==='/webmagaza/'){const assetURL=new URL(request.url);assetURL.pathname='/webshop';response=await env.ASSETS.fetch(new Request(assetURL,request));}else if(path==='/uretim'||path==='/uretim/'){const assetURL=new URL(request.url);assetURL.pathname='/production';response=await env.ASSETS.fetch(new Request(assetURL,request));}else if(path==='/eticaret'||path==='/eticaret/'){const assetURL=new URL(request.url);assetURL.pathname='/ecommerce';response=await env.ASSETS.fetch(new Request(assetURL,request));}else response=await env.ASSETS.fetch(request);}
 catch(error){response=json({error:error.status?error.message:'İşlem tamamlanamadı. Bağlantıyı kontrol edip tekrar deneyin.'},error.status||500);}
 // Video için bayt aralığı: iPhone Safari kısmi yanıt (206) almadan videoyu oynatmaz ve ileri saramaz.
 // Statik dosya katmanı aralık isteğine tam dosyayla (200) dönüyordu; burada tek aralık kesilir.
 if(response.status===200&&(response.headers.get('Content-Type')||'').startsWith('video/'))response=await videoRange(request,response);
 const headers=new Headers(response.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('X-Frame-Options','DENY');
 headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
 return new Response(response.body,{status:response.status,headers});
}};
