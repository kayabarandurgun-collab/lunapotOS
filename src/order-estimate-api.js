import {quotePrice,findPriceFloor} from '../public/pricing-math.js';
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
 if(p.source_changed)return incomplete(['Kaynak sipariş değişmiş. Güncel kayıt incelenmeden tahmin yapılmaz.']);
 if(p.status==='cancelled')return incomplete(['İptal edilmiş sipariş için yeni satış tahmini yapılmaz.']);
 const lines=await all(stmt(db,'SELECT * FROM order_lines WHERE package_id=?',[p.id]));
 if(lines.length!==1)return incomplete(['Birden fazla ilan satırında komisyon dağılımı ve ortak paket bilgileri ayrıca doğrulanmalı.']);
 const line=lines[0];if(line.gross_cents===null||line.vat_bps===null)return incomplete(['Siparişin KDV dahil tutarı ve KDV oranı gerekli.']);
 if(line.net_revenue_cents===null||Math.abs(line.net_revenue_cents-Math.round(line.gross_cents*10000/(10000+line.vat_bps)))>1)return incomplete(['Brüt/net satış ve KDV ilişkisi doğrulanamadı.']);
 const components=await all(stmt(db,'SELECT c.*,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE c.line_id=?',[line.id]));
 if(!components.length)return incomplete(['İlanın gerçek stok kartlarını veya set bağlantısını seçin.']);
 if(components.reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000||components.some(c=>c.stock_unit!==c.current_stock_unit))return incomplete(['Bileşen payları veya stok birimi doğrulanamıyor. Eşleştirmeyi kontrol edin.']);
 const shipped=['shipped','delivered'].includes(p.status),missing=[];
 let cost=0;
 for(const c of components){
  if(shipped){if(c.sale_cost_cents===null)missing.push('Gönderimin sabitlenmiş ürün maliyeti eksik.');else cost+=c.sale_cost_cents;}
  else if(c.stock_quantity_milli<=0)missing.push('Bir bileşenin stok maliyeti bulunmuyor. Açılış veya mal teslimini kaydedin.');
  else if(![c.value_cents,c.quantity_milli,c.stock_quantity_milli].every(Number.isSafeInteger))missing.push('Stok maliyeti güvenli hesaplama sınırının dışında.');
  else cost+=Number((BigInt(c.value_cents)*BigInt(c.quantity_milli)*2n+BigInt(c.stock_quantity_milli))/(BigInt(c.stock_quantity_milli)*2n));
 }
 if(!Number.isSafeInteger(cost))missing.push('Toplam ürün maliyeti güvenli hesaplama sınırının dışında.');
 if(missing.length)return incomplete([...new Set(missing)]);
 if(typeof x.category!=='string'||x.category.length>100)fail('Komisyon kategorisini kontrol edin.');
 const [shippingRates,commissionRates]=await Promise.all(['shipping_rates','commission_rates'].map(table=>all(db.prepare('SELECT * FROM '+table+' WHERE archived_at IS NULL LIMIT 1001'))));
 if(shippingRates.length>1000||commissionRates.length>1000)fail('Tarife sınırı aşıldı. Eski tarifeleri arşivleyin.',409);
 const profile={sku:line.sku,category:x.category,vat_bps:line.vat_bps,replacement_cost_cents:cost,units_per_parcel:1};
 for(const key of ['length_mm','width_mm','height_mm','weight_grams','packaging_cents','other_cents','withholding_bps'])profile[key]=x[key];
 const input={profile,shippingRates,commissionRates,priceCents:line.gross_cents,quantity:1,channel:p.channel,carrier:x.carrier,date:x.date,desiredProfitCents:x.desired_profit_cents??0,maxPriceCents:x.max_price_cents??1000000};
 const quote=quotePrice(input),floor=findPriceFloor(input);
 // A platform rounding difference must be reviewed before presenting an exact quote.
 if(quote.status==='estimated'){
  const delta=line.net_revenue_cents-quote.revenue_net_cents;
  if(delta!==0)return incomplete(['Siparişin kuruş yuvarlaması tarife tahmininden farklı. Net/brüt tutarı doğrulayın.']);
  quote.warnings.push('Bu paketin ölçüleri ve ek maliyetleri bu hesap için girildi; kalıcı tarife veya kesin kesinti kaydı değildir.');
 }
 return {quote,floor,cost_basis:shipped?'shipment_snapshot':'current_weighted_average',notice:'Setin tüm stok bileşenlerinin maliyeti toplandı. Paket kargosu bir kez hesaplandı. Alt fiyat bu paket ve aynı maliyet varsayımları içindir; genel işletme giderleri ayrıca değerlendirilir.'};
}
