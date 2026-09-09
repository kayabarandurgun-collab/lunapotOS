import {priceDecision} from './price-decision.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,name,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(name+' gerekli/geçersiz.');return v.trim();};
const integer=(v,name,min=0,max=100000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(name+' tam sayı olmalı; izin verilen aralık dışında.');return v;};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const bool=v=>{if(![0,1,true,false].includes(v))fail('KDV dahil/hariç açıkça seçilmeli.');return v?1:0;};
const channel=v=>{if(!['trendyol','hepsiburada','other'].includes(v))fail('Kanal geçersiz.');return v;};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const all=async(db,sql)=> (await db.prepare(sql).all()).results;
const boundedRows=async(db,table)=>{const rows=await all(db,'SELECT * FROM '+table+' ORDER BY created_at DESC LIMIT 1001');if(rows.length>1000)fail('Tarife listesi sınırı aşıldı; arşiv/filtre düzenlemesi gerekli.',409);return rows;};
function common(x){
 const r={label:text(x.label,'Tarife adı'),channel:channel(x.channel),valid_from:day(x.valid_from),valid_to:day(x.valid_to),price_min_cents:integer(x.price_min_cents,'Alt fiyat',0,10000000),price_max_cents:x.price_max_cents===null?null:integer(x.price_max_cents,'Üst fiyat',1,10000001),vat_bps:integer(x.vat_bps,'KDV',0,10000),tax_included:bool(x.tax_included),source:text(x.source,'Tarife kaynağı',500)};
 if(r.valid_to<r.valid_from||r.price_max_cents!==null&&r.price_max_cents<=r.price_min_cents)fail('Tarife aralığı geçersiz.');return r;
}
async function state(db){
 const [profiles,shippingRates,commissionRates,products]=await Promise.all([
 all(db,'SELECT pp.*,p.sku,p.category,p.name product_name FROM price_profiles pp JOIN products p ON p.id=pp.product_id'),
 boundedRows(db,'shipping_rates'),boundedRows(db,'commission_rates'),all(db,'SELECT id,name,sku,category FROM products ORDER BY name')
 ]);return {profiles,shippingRates,commissionRates,products};
}
export async function pricingApi(request,env,path,readBody){
 if(!['ec','lp'].includes(env.WORKSPACE))fail('Çalışma alanı geçersiz.',403);
 const db=env.DB,method=request.method;
 if(path==='/api/pricing'&&method==='GET')return state(db);
 if(path==='/api/pricing/profiles'&&method==='POST'){
  const x=await readBody(request),r={product_id:text(x.product_id,'Ürün',100)};
  if(!await stmt(db,'SELECT id FROM products WHERE id=?',[r.product_id]).first())fail('Bu çalışma alanında ürün bulunamadı.',404);
  for(const key of ['vat_bps','withholding_bps'])r[key]=integer(x[key],key,0,10000);
  for(const key of ['replacement_cost_cents','packaging_cents','other_cents'])r[key]=integer(x[key],key);
  for(const key of ['length_mm','width_mm','height_mm'])r[key]=integer(x[key],key,1,10000);
  for(const key of ['weight_grams','units_per_parcel'])r[key]=integer(x[key],key,1,1000000);
  const keys=Object.keys(r);
  await stmt(db,'INSERT INTO price_profiles('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+') ON CONFLICT(product_id) DO UPDATE SET '+keys.filter(k=>k!=='product_id').map(k=>k+'=excluded.'+k).join(',')+",updated_at=CURRENT_TIMESTAMP",Object.values(r)).run();
  return {product_id:r.product_id};
 }
 if(['/api/pricing/shipping','/api/pricing/commissions'].includes(path)&&method==='POST'){
  const x=await readBody(request),r={id:crypto.randomUUID(),...common(x)},shipping=path.endsWith('/shipping');
  if(shipping){
   r.carrier=text(x.carrier,'Kargo şirketi',100);
   for(const key of ['billable_min_milli','amount_cents'])r[key]=integer(x[key],key);
   r.billable_max_milli=x.billable_max_milli===null?null:integer(x.billable_max_milli,'Üst desi',1);
   if(r.billable_max_milli!==null&&r.billable_max_milli<=r.billable_min_milli)fail('Desi aralığı geçersiz.');
   for(const key of ['desi_divisor','billable_step_milli'])r[key]=integer(x[key],key,1,1000000);
  }else{
   r.sku=x.sku?text(x.sku,'Ürün kodu',100):'';r.category=x.category?text(x.category,'Kategori',100):'';
   r.rate_bps=integer(x.rate_bps,'Komisyon',0,10000);if(!['gross','net'].includes(x.base))fail('Komisyon matrahı seçilmeli.');r.base=x.base;
  }
  const keys=Object.keys(r),table=shipping?'shipping_rates':'commission_rates';
  await stmt(db,'INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')',Object.values(r)).run();return {id:r.id};
 }
 const archive=path.match(/^\/api\/pricing\/(shipping|commissions)\/([\w-]+)\/archive$/);
 if(archive&&method==='POST'){
  const table=archive[1]==='shipping'?'shipping_rates':'commission_rates',row=await stmt(db,'SELECT id,archived_at FROM '+table+' WHERE id=?',[archive[2]]).first();
  if(!row)fail('Tarife bulunamadı.',404);if(!row.archived_at)await stmt(db,'UPDATE '+table+' SET archived_at=CURRENT_TIMESTAMP WHERE id=?',[archive[2]]).run();return {id:row.id,archived:true};
 }
 if(path==='/api/pricing/quote'&&method==='POST'){
  const x=await readBody(request),data=await state(db),profile=data.profiles.find(p=>p.product_id===x.product_id);
  const input={profile,shippingRates:data.shippingRates,commissionRates:data.commissionRates,priceCents:x.price_cents,quantity:x.quantity??1,channel:x.channel,carrier:x.carrier,date:x.date,desiredProfitCents:x.desired_profit_cents??0,maxPriceCents:x.max_price_cents??1000000};
  return priceDecision(input);
 }
 return null;
}
