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
import {attentionApi} from './attention-api.js';
const encoder = new TextEncoder();
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const hex = bytes => Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,'0')).join('');
const hash = async value => hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
async function passwordHash(password,salt) {
 const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256));
}
function equal(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false; let n=0; for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i); return n===0; }
const str=(v,name,max=200)=> {if(typeof v!=='string'||!v.trim()||v.length>max)fail(name+' alanını kontrol edin.');return v.trim();};
const optional=(v,max=500)=>{if(v===undefined)return '';if(typeof v!=='string'||v.length>max)fail('Metin çok uzun veya geçersiz.');return v.trim();};
const num=(v,name,min=0,max=1e9)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(name+' geçersiz.');return v;};
const validateUnits=(quantity,from,to)=>{try{return convert(quantity,from,to);}catch{fail('Uyumsuz veya geçersiz ölçü birimi.');}};
const now=()=>Math.floor(Date.now()/1000);
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const activity=(db,description)=>db.prepare('INSERT INTO activity(id,description) VALUES(?,?)').bind(crypto.randomUUID(),description);
async function body(request){if(Number(request.headers.get('content-length'))>64000)fail('İstek çok büyük.',413);const raw=await request.text();if(raw.length>64000)fail('İstek çok büyük.',413);try{return JSON.parse(raw);}catch{fail('Geçersiz veri.');}}
async function session(request,db){const token=request.headers.get('Cookie')?.match(/(?:^|; )lunapot_session=([a-f0-9]{64})(?:;|$)/)?.[1];return token&&await db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token),now()).first();}
async function api(request,env,path){
 const db=env.DB;if(!db)fail('Veritabanı bağlantısı henüz kurulmadı.',503);
 if(!['GET','HEAD'].includes(request.method)) {
   if(request.headers.get('Origin')!==new URL(request.url).origin)fail('İstek kaynağı doğrulanamadı.',403);
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail('JSON veri gerekli.',415);
 }
 if(path==='/api/auth/status'&&request.method==='GET') {
   const admin=await db.prepare('SELECT id FROM admin WHERE id=1').first();
   return json({authenticated:!!(await session(request,db)),initialized:!!admin});
 }
 if((path==='/api/auth/login'||path==='/api/auth/setup')&&request.method==='POST') {
   const input=await body(request); const key=await hash(request.headers.get('CF-Connecting-IP')||'local');
   await db.prepare('DELETE FROM login_limits WHERE reset_at<?').bind(now()).run();
   const attempt=await db.prepare('INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(key,now()+900).first();
   if(attempt.attempts>10)fail('Çok fazla deneme. 15 dakika sonra tekrar deneyin.',429);
   let admin=await db.prepare('SELECT * FROM admin WHERE id=1').first();
   if(path.endsWith('/setup')) {
     if(admin)fail('İlk kurulum daha önce tamamlandı.',409);
     if(!env.SETUP_TOKEN||!equal(input.token,env.SETUP_TOKEN))fail('Kurulum anahtarı geçersiz.',403);
     const password=str(input.password,'Şifre',200); if(password.length<12)fail('En az 12 karakterlik bir şifre seçin.');
     const salt=crypto.randomUUID();
     try{await db.prepare('INSERT INTO admin(id,salt,password_hash) VALUES(1,?,?)').bind(salt,await passwordHash(password,salt)).run();}catch{fail('İlk kurulum tamamlanmış. Giriş yapın.',409);}
   } else {
     if(!admin)fail('Önce ilk kurulum tamamlanmalı.',403);
     if(typeof input.password!=='string'||input.password.length>200||!equal(await passwordHash(input.password,admin.salt),admin.password_hash))fail('Şifre hatalı.',401);
   }
   const token=hex(crypto.getRandomValues(new Uint8Array(32)));
   await db.batch([db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').bind(await hash(token),now()+604800),db.prepare('DELETE FROM login_limits WHERE key=?').bind(key)]);
   const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
   return json({ok:true},200,{'Set-Cookie':`lunapot_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`});
 }
 if(!await session(request,db))fail('Lütfen giriş yapın.',401);
 const workspace=path.match(/^\/api\/(ec|lp)(\/.*)?$/);
 if(workspace){
  const scoped={...env,DB:scopedDB(db,workspace[1]),ROOT_DB:db,WORKSPACE:workspace[1]},subpath=workspace[2]||'';
  for(const handler of [performanceApi,attentionApi,orderInsightsApi,orderEstimateApi,catalogApi,pricingApi,ledgerApi,settingsApi,ordersApi,connectionsApi,reconciliationApi]){const result=await handler(request,scoped,'/api'+subpath,body);if(result!==null)return json(result);}
  return json(await accountingApi(request,scoped,'/api/accounting'+subpath,body));
 }
 if(path==='/api/auth/logout'&&request.method==='POST') {
   const s=await session(request,db);await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(s.token_hash).run();
   return json({ok:true},200,{'Set-Cookie':'lunapot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure'});
 }
 if(path==='/api/data'&&request.method==='GET') {
   const results=await db.batch(['SELECT * FROM products ORDER BY updated_at DESC','SELECT * FROM materials ORDER BY name','SELECT * FROM recipes ORDER BY updated_at DESC','SELECT * FROM recipe_items','SELECT * FROM activity ORDER BY created_at DESC LIMIT 10'].map(sql=>db.prepare(sql)));
   const [products,materials,recipes,items,activity]=results.map(r=>r.results);
   return json({products,materials,recipes:recipes.map(r=>({...r,items:items.filter(i=>i.recipe_id===r.id)})),activity});
 }
 const match=path.match(/^\/api\/(materials|products|recipes)(?:\/([\w-]{1,80}))?$/);if(!match)fail('Bulunamadı.',404);
 const [,kind,id]=match;
 if(request.method==='DELETE'&&id) {
   const record=await db.prepare(`SELECT * FROM ${kind} WHERE id=?`).bind(id).first();if(!record)fail('Kayıt bulunamadı.',404);
   const deletions=[];
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
   if(id){const old=await db.prepare('SELECT unit FROM materials WHERE id=?').bind(id).first();if(old.unit!==unit&&await db.prepare('SELECT id FROM recipe_items WHERE material_id=? LIMIT 1').bind(id).first())fail('Reçetede kullanılan hammaddenin alış birimini değiştiremezsiniz.',409);}
   statements.push(db.prepare('INSERT INTO materials(id,name,unit,price,supplier,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit=excluded.unit,price=excluded.price,supplier=excluded.supplier,updated_at=excluded.updated_at').bind(recordId,name,unit,price,optional(input.supplier),timestamp));
   statements.push(activity(db,`${name} ${id?'güncellendi':'eklendi'}`));
 } else if(kind==='products') {
   const name=str(input.name,'Ürün adı'),sku=str(input.sku,'Ürün kodu',80);
   statements.push(db.prepare('INSERT INTO products(id,name,sku,category,sale_price,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,category=excluded.category,sale_price=excluded.sale_price,updated_at=excluded.updated_at').bind(recordId,name,sku,optional(input.category,100),num(input.sale_price,'Satış fiyatı'),timestamp));
   statements.push(activity(db,`${name} ${id?'güncellendi':'eklendi'}`));
 } else {
   const productId=str(input.product_id,'Ürün',80);if(!await db.prepare('SELECT id FROM products WHERE id=?').bind(productId).first())fail('Ürün bulunamadı.');
   if(!Array.isArray(input.items)||input.items.length<1||input.items.length>40)fail('Reçetede 1–40 hammadde olmalı.');
   const materials=(await db.prepare('SELECT id,unit FROM materials').all()).results,seen=new Set();
   for(const item of input.items){if(!item||typeof item!=='object')fail('Hammadde satırı geçersiz.');const m=materials.find(m=>m.id===item.material_id);if(!m||seen.has(m.id))fail('Hammadde eksik veya birden fazla eklenmiş.');seen.add(m.id);num(item.quantity,'Miktar',0.000001);validateUnits(item.quantity,item.unit,m.unit);}
   statements.push(db.prepare('INSERT INTO recipes(id,product_id,yield_qty,waste_pct,labor,packaging,overhead,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,yield_qty=excluded.yield_qty,waste_pct=excluded.waste_pct,labor=excluded.labor,packaging=excluded.packaging,overhead=excluded.overhead,notes=excluded.notes,updated_at=excluded.updated_at').bind(recordId,productId,num(input.yield_qty,'Üretim adedi',0.000001),num(input.waste_pct,'Fire oranı',0,100),num(input.labor,'İşçilik'),num(input.packaging,'Paketleme'),num(input.overhead,'Diğer giderler'),optional(input.notes,2000),timestamp));
   statements.push(db.prepare('DELETE FROM recipe_items WHERE recipe_id=?').bind(recordId));
   for(const item of input.items)statements.push(db.prepare('INSERT INTO recipe_items(id,recipe_id,material_id,quantity,unit) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),recordId,item.material_id,item.quantity,item.unit));
   statements.push(activity(db,'Ürün reçetesi '+(id?'güncellendi':'eklendi')));
 }
 try{await db.batch(statements);}catch(error){if(/UNIQUE constraint/.test(error.message))fail('Aynı ad/kod veya ürüne ait reçete zaten var.',409);throw error;}
 return json({id:recordId},id?200:201);
}
export default {async fetch(request,env) {
 let response;
 try {const path=new URL(request.url).pathname;if(path.startsWith('/api/'))response=await api(request,env,path);else if(path==='/uretim'||path==='/uretim/'){const assetURL=new URL(request.url);assetURL.pathname='/production';response=await env.ASSETS.fetch(new Request(assetURL,request));}else if(path==='/eticaret'||path==='/eticaret/'){const assetURL=new URL(request.url);assetURL.pathname='/ecommerce';response=await env.ASSETS.fetch(new Request(assetURL,request));}else response=await env.ASSETS.fetch(request);}
 catch(error){response=json({error:error.status?error.message:'İşlem tamamlanamadı. Bağlantıyı kontrol edip tekrar deneyin.'},error.status||500);}
 const headers=new Headers(response.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('X-Frame-Options','DENY');
 headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
 return new Response(response.body,{status:response.status,headers});
}};
