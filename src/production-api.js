import {convert} from '../public/costs.js';
import {milli,cents} from '../public/accounting-math.js';
const fail=(m,s=400)=>{throw Object.assign(new Error(m),{status:s});};
const text=(v,n,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(n+' alanını kontrol edin.');return v.trim();};
const number=(fn,v)=>{try{return fn(v);}catch(e){fail(e.message);}};
const qty=v=>number(milli,v),money=v=>{const n=number(cents,v);if(n<0)fail('Maliyet negatif olamaz.');return n;};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v||v>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}))fail('Geçerli bir gerçekleşme tarihi girin; geleceğe stok hareketi yazılmaz.');return v;};
const prorate=(value,q,total)=>Number((BigInt(value)*BigInt(q)*2n+BigInt(total))/(BigInt(total)*2n));
export async function productionApi(request,env,path,readBody){
 if(!path.startsWith('/api/production'))return null;if(env.WORKSPACE!=='lp')fail('Üretim yalnızca Lunapot çalışma alanındadır.',403);
 const db=env.ROOT_DB||env.DB,method=request.method;
 if(path==='/api/production'&&method==='GET'){
  const [materials,recipes,items,jobs,movements]=(await db.batch([
   db.prepare('SELECT m.*,p.sku purchase_sku,b.quantity_milli,b.value_cents FROM materials m JOIN products p ON p.id=m.purchase_product_id JOIN lp_material_balances b ON b.material_id=m.id ORDER BY m.name'),
   db.prepare('SELECT r.*,p.name product_name,p.stock_unit FROM recipes r JOIN products p ON p.id=r.product_id ORDER BY p.name'),
   db.prepare('SELECT * FROM recipe_items'),db.prepare("SELECT * FROM lp_production_jobs WHERE status!='draft' ORDER BY created_at DESC,rowid DESC LIMIT 200"),
   db.prepare('SELECT v.*,m.name,m.unit FROM lp_material_movements v JOIN materials m ON m.id=v.material_id ORDER BY v.created_at DESC,v.rowid DESC LIMIT 200')
  ])).map(r=>r.results);return {materials,recipes:recipes.map(r=>({...r,items:items.filter(i=>i.recipe_id===r.id)})),jobs,movements};
 }
 const detail=path.match(/^\/api\/production\/jobs\/([\w-]+)$/);if(detail&&method==='GET'){
  const job=await db.prepare('SELECT * FROM lp_production_jobs WHERE id=?').bind(detail[1]).first();if(!job)fail('Üretim kaydı bulunamadı.',404);return {job,items:(await db.prepare('SELECT * FROM lp_production_items WHERE job_id=?').bind(job.id).all()).results};
 }
 if(method!=='POST')fail('Üretim işlemi bulunamadı.',404);const x=await readBody(request);
 try{
  if(path==='/api/production/material-stock'){
   if(!['opening','receipt','count'].includes(x.kind))fail('Hammadde hareketini seçin.');const material=text(x.material_id,'Hammadde'),b=await db.prepare('SELECT * FROM lp_material_balances WHERE material_id=?').bind(material).first();if(!b)fail('Hammadde bulunamadı.',404);
   const input=x.quantity===0?0:qty(x.quantity),q=x.kind==='count'?input-b.quantity_milli:input;if(!q)fail('Stok miktarı değişmiyor.');const value=q<0?-prorate(b.value_cents,-q,b.quantity_milli):prorate(money(x.unit_cost),q,1000),id=crypto.randomUUID();if(!Number.isSafeInteger(value))fail('Maliyet hesaplama sınırı aşıldı.');
   const result=await db.batch([db.prepare('INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT ?,material_id,?,?,?,?,?,? FROM lp_material_balances WHERE material_id=? AND quantity_milli=? AND value_cents=? RETURNING id').bind(id,q,value,x.kind,text(x.reference,'Belge / referans'),text(x.notes,'Açıklama',1000),day(x.occurred_on),material,b.quantity_milli,b.value_cents)]);
   if(!result[0].results.length)fail('Hammadde stoğu değişti. Ekranı yenileyip tekrar deneyin.',409);return {id};
  }
  if(path==='/api/production/jobs'){
   const recipe=await db.prepare('SELECT r.*,p.name product_name,p.stock_unit FROM recipes r JOIN products p ON p.id=r.product_id WHERE r.id=?').bind(text(x.recipe_id,'Reçete')).first();if(!recipe)fail('Reçete bulunamadı.',404);if(recipe.stock_unit!=='adet')fail('Üretim çıktısı adet birimli mamul kartına bağlanmalı.');
   const quantity=qty(x.quantity),date=day(x.occurred_on);if(quantity%1000)fail('Tamamlanan mamul adedini tam sayı girin.');
   const materials=(await db.prepare('SELECT i.*,m.name,m.unit stock_unit,b.quantity_milli,b.value_cents FROM recipe_items i JOIN materials m ON m.id=i.material_id JOIN lp_material_balances b ON b.material_id=m.id WHERE i.recipe_id=?').bind(recipe.id).all()).results;
   if(!materials.length||materials.length>200)fail('Reçetede 1–200 hammadde olmalı.');
   if(!Array.isArray(x.items)||x.items.length!==materials.length||new Set(x.items.map(i=>i?.material_id)).size!==materials.length||x.items.some(i=>!materials.some(m=>m.material_id===i?.material_id)))fail('Her reçete hammaddesinin gerçekleşen tüketimini bir kez girin.');
   const jobId=crypto.randomUUID(),factor=quantity/1000/recipe.yield_qty;
   const items=materials.map(m=>{const planned=qty(Math.round(convert(m.quantity,m.unit,m.stock_unit)*factor*(1+recipe.waste_pct/100)*1000)/1000),actual=qty(x.items.find(i=>i.material_id===m.material_id).quantity);if(m.quantity_milli<actual)fail(m.name+': hammadde stoğu yetersiz. Önce giriş veya açılış kaydedin.',409);return {id:crypto.randomUUID(),material_id:m.material_id,material_name:m.name,unit:m.stock_unit,planned_milli:planned,actual_milli:actual,cost_cents:prorate(m.value_cents,actual,m.quantity_milli),stock_quantity_milli:m.quantity_milli,stock_value_cents:m.value_cents};});
   const labor=money(x.labor),packaging=money(x.packaging),overhead=money(x.overhead),total=items.reduce((sum,i)=>sum+i.cost_cents,0)+labor+packaging+overhead;if(!Number.isSafeInteger(total))fail('Toplam maliyet hesaplama sınırı aşıldı.');
   await db.batch([
    db.prepare('INSERT INTO lp_production_jobs(id,reference,product_id,product_name,recipe_json,quantity_milli,labor_cents,packaging_cents,overhead_cents,total_cost_cents,occurred_on,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(jobId,text(x.reference,'Üretim / parti no'),recipe.product_id,recipe.product_name,JSON.stringify({...recipe,items:materials.map(m=>({material_id:m.material_id,quantity:m.quantity,unit:m.unit}))}),quantity,labor,packaging,overhead,total,date,text(x.notes,'Üretim açıklaması',1000)),
    db.prepare("INSERT INTO lp_production_items(id,job_id,material_id,material_name,unit,planned_milli,actual_milli,cost_cents,stock_quantity_milli,stock_value_cents) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.material_id'),json_extract(value,'$.material_name'),json_extract(value,'$.unit'),json_extract(value,'$.planned_milli'),json_extract(value,'$.actual_milli'),json_extract(value,'$.cost_cents'),json_extract(value,'$.stock_quantity_milli'),json_extract(value,'$.stock_value_cents') FROM json_each(?)").bind(jobId,JSON.stringify(items)),
    db.prepare("UPDATE lp_production_jobs SET status='posted' WHERE id=?").bind(jobId)
   ]);return {id:jobId,total_cost_cents:total};
  }
  const reverse=path.match(/^\/api\/production\/jobs\/([\w-]+)\/reverse$/);if(reverse){const job=await db.prepare('SELECT * FROM lp_production_jobs WHERE id=?').bind(reverse[1]).first();if(!job)fail('Üretim bulunamadı.',404);if(job.status!=='posted')fail('Bu üretim zaten geri alınmış.',409);await db.batch([db.prepare("UPDATE lp_production_jobs SET status='reversed',reversed_on=?,reversal_reason=? WHERE id=?").bind(day(x.occurred_on),text(x.reason,'Düzeltme nedeni',1000),job.id)]);return {id:job.id};}
  fail('Üretim işlemi bulunamadı.',404);
 }catch(e){if(e.status)throw e;if(/UNIQUE constraint/.test(e.message))fail('Bu referans daha önce işlendi; ikinci kez stok hareketi oluşturulmadı.',409);if(/MATERIAL_|PRODUCTION_|INSUFFICIENT_STOCK|INVALID_STOCK_VALUE|STOCK_RESERVED|IMMUTABLE_/.test(e.message))fail('İşlem tamamlanmadı. Stok değişmiş, yetersiz veya siparişlere ayrılmış olabilir. Ekranı yenileyin; mevcut hareketler korundu.',409);throw e;}
}
