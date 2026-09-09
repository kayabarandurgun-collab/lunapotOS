import {quotePrice,quoteParcel,findPriceFloor} from '../public/pricing-math.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const all=async q=>(await q.all()).results;
const incomplete=missing=>({quote:{status:'incomplete',missing},floor:{status:'incomplete',price_cents:null,missing},cost_basis:null});

// A parcel is one unit here, regardless of the number of physical stock components.
// Shipping is charged once and commission uses the external listing SKU.
export async function orderEstimateApi(request,env,path,readBody){
 const match=path.match(/^\/api\/orders\/([\w-]+)\/estimate$/);if(!match||request.method!=='POST')return null;
 if(env.WORKSPACE!=='ec')fail('Sipariş hesabı e-ticaret alanına aittir.',403);
 const db=env.DB,x=await readBody(request),p=await stmt(db,'SELECT * FROM order_packages WHERE id=?',[match[1]]).first();if(!p)fail('Sipariş bulunamadı.',404);
 const lines=await all(stmt(db,'SELECT * FROM order_lines WHERE package_id=?',[p.id]));
 const components=await all(stmt(db,'SELECT c.*,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id=?',[p.id]));
 const [shippingRates,commissionRates]=await Promise.all(['shipping_rates','commission_rates'].map(table=>all(db.prepare('SELECT * FROM '+table+' WHERE archived_at IS NULL LIMIT 1001'))));
 const result=estimatePackage(p,lines,components,x,shippingRates,commissionRates);
 if(result.quote.status==='estimated'){
  const settings=Object.fromEntries(['carrier','date','category','line_categories','length_mm','width_mm','height_mm','weight_grams','packaging_cents','other_cents','withholding_bps','desired_profit_cents','max_price_cents'].filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));
  const template={...settings,line_categories:lines.map(l=>({line_key:lineTemplateKey(l,components),category:x.line_categories?.find(c=>c.line_id===l.id)?.category??x.category}))};
  await db.batch([
   stmt(db,'INSERT INTO order_estimate_inputs(package_id,source_fingerprint,composition_key,input_json) VALUES(?,?,?,?) ON CONFLICT(package_id) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,composition_key=excluded.composition_key,input_json=excluded.input_json,updated_at=CURRENT_TIMESTAMP',[p.id,p.source_fingerprint,compositionKey(lines,components),JSON.stringify(settings)]),
   stmt(db,'INSERT INTO parcel_templates(template_key,input_json) VALUES(?,?) ON CONFLICT(template_key) DO UPDATE SET input_json=excluded.input_json,updated_at=CURRENT_TIMESTAMP',[parcelTemplateKey(p,lines,components),JSON.stringify(template)])
  ]);
 }
 return result;
}
export function compositionKey(lines,components){return JSON.stringify({lines:lines.map(l=>[l.id,l.sku,l.quantity_milli]).sort((a,b)=>a[0].localeCompare(b[0])),parts:components.map(c=>[c.id,c.line_id,c.product_id,c.quantity_milli,c.stock_unit,c.mapping_id]).sort((a,b)=>a[0].localeCompare(b[0]))});}
function lineTemplateKey(line,components){return JSON.stringify([line.sku,line.quantity_milli,components.filter(c=>c.line_id===line.id).map(c=>[c.product_id,c.quantity_milli,c.stock_unit]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);}
export function parcelTemplateKey(p,lines,components){return JSON.stringify([p.channel,lines.map(l=>lineTemplateKey(l,components)).sort()]);}
export function useParcelTemplate(input,lines,components){return {...input,line_categories:lines.map(l=>({line_id:l.id,category:input.line_categories.find(c=>c.line_key===lineTemplateKey(l,components))?.category??input.category}))};}
export function estimatePackage(p,lines,components,x,shippingRates,commissionRates,withFloor=true){
 if(p.source_changed)return incomplete(['Kaynak sipariş değişmiş. Güncel kayıt incelenmeden tahmin yapılmaz.']);
 if(p.status==='cancelled')return incomplete(['İptal edilmiş sipariş için yeni satış tahmini yapılmaz.']);

 if(!lines.length||lines.length>10)return incomplete(['Paket 1–10 ilan satırı içermeli.']);
 for(const line of lines){
  if(line.gross_cents===null||line.vat_bps===null)return incomplete([line.name+': KDV dahil tutar ve KDV oranı gerekli.']);
  if(line.net_revenue_cents===null||line.net_revenue_cents!==Math.round(line.gross_cents*10000/(10000+line.vat_bps)))return incomplete([line.name+': Brüt/net satış ve KDV kuruş yuvarlaması doğrulanamadı.']);
 }

 for(const line of lines){const parts=components.filter(c=>c.line_id===line.id);
  if(!parts.length)return incomplete([line.name+': Gerçek stok kartlarını veya set bağlantısını seçin.']);
  if(parts.reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000||parts.some(c=>c.stock_unit!==c.current_stock_unit))return incomplete([line.name+': Bileşen payları veya stok birimi doğrulanamıyor. Eşleştirmeyi kontrol edin.']);
 }
 const shipped=['shipped','delivered'].includes(p.status),missing=[];
 let cost=0;const costs=new Map();
 for(const c of components){
  const before=cost;
  if(shipped){if(c.sale_cost_cents===null)missing.push('Gönderimin sabitlenmiş ürün maliyeti eksik.');else cost+=c.sale_cost_cents;}
  else if(c.stock_quantity_milli<=0)missing.push('Bir bileşenin stok maliyeti bulunmuyor. Açılış veya mal teslimini kaydedin.');
  else if(![c.value_cents,c.quantity_milli,c.stock_quantity_milli].every(Number.isSafeInteger))missing.push('Stok maliyeti güvenli hesaplama sınırının dışında.');
  else cost+=Number((BigInt(c.value_cents)*BigInt(c.quantity_milli)*2n+BigInt(c.stock_quantity_milli))/(BigInt(c.stock_quantity_milli)*2n));
  costs.set(c.line_id,(costs.get(c.line_id)||0)+cost-before);
 }
 if(!Number.isSafeInteger(cost))missing.push('Toplam ürün maliyeti güvenli hesaplama sınırının dışında.');
 if(missing.length)return incomplete([...new Set(missing)]);
 if(typeof x.category!=='string'||x.category.length>100)fail('Komisyon kategorisini kontrol edin.');
 if(x.line_categories!==undefined&&(!Array.isArray(x.line_categories)||x.line_categories.length>10||x.line_categories.some(c=>!c||!lines.some(l=>l.id===c.line_id)||typeof c.category!=='string'||c.category.length>100)||new Set(x.line_categories.map(c=>c.line_id)).size!==x.line_categories.length))fail('Satır komisyon kategorilerini kontrol edin.');

 if(shippingRates.length>1000||commissionRates.length>1000)fail('Tarife sınırı aşıldı. Eski tarifeleri arşivleyin.',409);
 const line=lines[0],profile={sku:line.sku,category:x.category,vat_bps:line.vat_bps,replacement_cost_cents:cost,units_per_parcel:1};
 for(const key of ['length_mm','width_mm','height_mm','weight_grams','packaging_cents','other_cents','withholding_bps'])profile[key]=x[key];
 const input={profile,shippingRates,commissionRates,priceCents:line.gross_cents,quantity:1,channel:p.channel,carrier:x.carrier,date:x.date,desiredProfitCents:x.desired_profit_cents??0,maxPriceCents:x.max_price_cents??1000000};
 const quote=lines.length===1?quotePrice(input):quoteParcel({...input,lines:lines.map(l=>({id:l.id,name:l.name,price_cents:l.gross_cents,profile:{sku:l.sku,category:x.line_categories?.find(c=>c.line_id===l.id)?.category??x.category,vat_bps:l.vat_bps,replacement_cost_cents:costs.get(l.id)}}))});
 const floor=withFloor&&lines.length===1?findPriceFloor(input):{status:'incomplete',price_cents:null,missing:['Farklı ilanlardan oluşan pakette tek bir alt fiyat belirlenmez. Her ilanın fiyatını ve komisyon baremini Fiyat ve kâr ekranında ayrı kontrol edin.']};
 // A platform rounding difference must be reviewed before presenting an exact quote.
 if(quote.status==='estimated'){
  const delta=lines.reduce((sum,l)=>sum+l.net_revenue_cents,0)-quote.revenue_net_cents;
  if(delta!==0)return incomplete(['Siparişin kuruş yuvarlaması tarife tahmininden farklı. Net/brüt tutarı doğrulayın.']);
  quote.warnings.push('Bu paketin ölçüleri ve ek maliyetleri bu hesap için girildi; kalıcı tarife veya kesin kesinti kaydı değildir.');
 }
 return {quote,floor,cost_basis:shipped?'shipment_snapshot':'current_weighted_average',notice:'Tüm ilanların stok bileşenleri toplandı. Her ilanın komisyonu ayrı, paket kargosu bir kez hesaplandı. Genel işletme giderleri ayrıca değerlendirilir.'};
}
