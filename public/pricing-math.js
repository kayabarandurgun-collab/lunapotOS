// All monetary inputs are integer kuruş. Quotes are estimates, never settled profit.
const whole = (v,min=0,max=100000000) => Number.isSafeInteger(v)&&v>=min&&v<=max;
const dateOK=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const active=(r,date)=>!r.archived_at&&dateOK(r.valid_from)&&dateOK(r.valid_to)&&r.valid_from<=date&&r.valid_to>=date;
const bracket=(r,p)=>p>=r.price_min_cents&&(r.price_max_cents===null||p<r.price_max_cents);
const included=v=>v===true||v===1;
function fee(amount,vat,taxIncluded){const net=taxIncluded?Math.round(amount*10000/(10000+vat)):amount;return {net,gross:taxIncluded?amount:amount+Math.round(amount*vat/10000)};}
function validate(input){
 const p=input.profile,missing=[];
 if(!p)return ['Ürünün fiyat profili yok.'];
 for(const key of ['vat_bps','withholding_bps'])if(!whole(p[key],0,10000))missing.push(key+' eksik veya geçersiz.');
 for(const key of ['replacement_cost_cents','packaging_cents','other_cents'])if(!whole(p[key]))missing.push(key+' eksik veya geçersiz.');
 for(const key of ['length_mm','width_mm','height_mm'])if(!whole(p[key],1,10000))missing.push(key+' eksik veya geçersiz.');
 for(const key of ['weight_grams','units_per_parcel'])if(!whole(p[key],1,1000000))missing.push(key+' eksik veya geçersiz.');
 if(!whole(input.quantity??1,1,1000000)||(input.quantity??1)!==p.units_per_parcel)missing.push('Paket ölçüleri bu adede ait değil.');
 if(!dateOK(input.date))missing.push('Geçerli hesap tarihi gerekli.');
 if(!['trendyol','hepsiburada','other'].includes(input.channel)||!input.carrier)missing.push('Kanal ve kargo şirketi gerekli.');
 return missing;
}
function choose(input,price,shippingPrice=price){
 const {profile:p,date,channel,carrier}=input;
 let commissions=(input.commissionRates||[]).filter(r=>active(r,date)&&r.channel===channel&&bracket(r,price)&&(!r.sku||r.sku.toLowerCase()===String(p.sku).toLowerCase())&&(!r.category||r.category===p.category));
 const rank=r=>(r.sku?2:0)+(r.category?1:0);
 if(commissions.length){const best=Math.max(...commissions.map(rank));commissions=commissions.filter(r=>rank(r)===best);}
 const shipping=(input.shippingRates||[]).filter(r=>active(r,date)&&r.channel===channel&&r.carrier===carrier&&bracket(r,shippingPrice)).map(r=>{
  const desi=p.length_mm*p.width_mm*p.height_mm/1000/r.desi_divisor;
  const raw=Math.max(desi,p.weight_grams/1000)*1000;
  return {rate:r,billable:Math.ceil(raw/r.billable_step_milli)*r.billable_step_milli};
 }).filter(x=>x.billable>=x.rate.billable_min_milli&&(x.rate.billable_max_milli===null||x.billable<x.rate.billable_max_milli));
 const missing=[];
 if(commissions.length!==1)missing.push(commissions.length?'Birden fazla komisyon tarifesi çakışıyor.':'Bu tarih/fiyat için komisyon tarifesi eksik.');
 if(shipping.length!==1)missing.push(shipping.length?'Birden fazla kargo tarifesi çakışıyor.':'Bu tarih/fiyat/paket için kargo tarifesi eksik.');
 if(missing.length)return {missing};
 const c=commissions[0],s=shipping[0].rate;
 if(!whole(c.rate_bps,0,10000)||!whole(c.vat_bps,0,10000)||!['net','gross'].includes(c.base)||![0,1,true,false].includes(c.tax_included))missing.push('Komisyon tarifesinin vergi bilgileri geçersiz.');
 if(!whole(s.amount_cents)||!whole(s.vat_bps,0,10000)||![0,1,true,false].includes(s.tax_included)||!whole(s.desi_divisor,1,1000000)||!whole(s.billable_step_milli,1,1000000))missing.push('Kargo tarifesinin ölçü/vergi bilgileri geçersiz.');
 return {missing,c,s,billable:shipping[0].billable};
}
function evaluate(input,price,rates){
 const p=input.profile,quantity=input.quantity??1,net=Math.round(price*10000/(10000+p.vat_bps));
 const commissionBase=rates.c.base==='gross'?price:net;
 const commission=fee(Math.round(commissionBase*rates.c.rate_bps/10000),rates.c.vat_bps,included(rates.c.tax_included));
 const shipping=fee(rates.s.amount_cents,rates.s.vat_bps,included(rates.s.tax_included));
 const cost=p.replacement_cost_cents*quantity,withholding=Math.round(net*p.withholding_bps/10000);
 return {status:'estimated',missing:[],price_cents:price,revenue_net_cents:net,output_vat_cents:price-net,cost_net_cents:cost,packaging_net_cents:p.packaging_cents,other_net_cents:p.other_cents,commission_net_cents:commission.net,commission_gross_cents:commission.gross,shipping_net_cents:shipping.net,shipping_gross_cents:shipping.gross,estimated_profit_cents:net-cost-p.packaging_cents-p.other_cents-commission.net-shipping.net,withholding_cents:withholding,estimated_payout_cents:price-commission.gross-shipping.gross-withholding,billable_milli:rates.billable,shipping_rate_id:rates.s.id,commission_rate_id:rates.c.id,warnings:['Tahmini katkı kârıdır; sabit işletme giderleri, gelir/kurumlar vergisi ve sonradan oluşan iadeler dahil değildir.','Tahmini hakediş, pazaryeri dışındaki ürün/ambalaj giderlerini düşmez. Stopaj gider değil, ayrı nakit kesintisidir.']};
}
export function quotePrice(input){
 const missing=validate(input);if(!whole(input.priceCents,0,10000000))missing.push('Satış fiyatı geçersiz.');
 if(missing.length)return {status:'incomplete',missing};
 const rates=choose(input,input.priceCents);if(rates.missing.length)return {status:'incomplete',missing:rates.missing};
 return evaluate(input,input.priceCents,rates);
}
// Each listing keeps its own VAT and commission band. The completed parcel has
// one shipping band (based on its full price), one packaging cost and one weight.
export function quoteParcel(input){
 const lines=input.lines;
 if(!Array.isArray(lines)||!lines.length||lines.length>10)return {status:'incomplete',missing:['Paket 1–10 ilan satırı içermeli.']};
 const total=lines.reduce((sum,l)=>sum+l.price_cents,0),missing=[],quotes=[];
 if(!whole(total,0,10000000))return {status:'incomplete',missing:['Paket satış toplamı geçersiz.']};
 for(const line of lines){
  const item={...input,quantity:1,priceCents:line.price_cents,profile:{...input.profile,...line.profile,units_per_parcel:1,packaging_cents:0,other_cents:0}};
  const errors=validate(item);if(!whole(line.price_cents,0,10000000))errors.push('Satış fiyatı geçersiz.');
  if(errors.length){missing.push(...errors.map(e=>(line.name||line.id)+': '+e));continue;}
  const rates=choose(item,line.price_cents,total);
  if(rates.missing.length){missing.push(...rates.missing.map(e=>(line.name||line.id)+': '+e));continue;}
  quotes.push({...evaluate(item,line.price_cents,rates),id:line.id,name:line.name,sku:line.profile.sku});
 }
 for(const key of ['packaging_cents','other_cents'])if(!whole(input.profile?.[key]))missing.push(key+' eksik veya geçersiz.');
 if(missing.length)return {status:'incomplete',missing:[...new Set(missing)]};
 const result={...quotes[0],price_cents:total,lines:quotes};
 for(const key of ['revenue_net_cents','output_vat_cents','cost_net_cents','commission_net_cents','commission_gross_cents','withholding_cents'])result[key]=quotes.reduce((sum,q)=>sum+q[key],0);
 result.packaging_net_cents=input.profile.packaging_cents;result.other_net_cents=input.profile.other_cents;
 result.estimated_profit_cents=result.revenue_net_cents-result.cost_net_cents-result.commission_net_cents-result.shipping_net_cents-result.packaging_net_cents-result.other_net_cents;
 result.estimated_payout_cents=total-result.commission_gross_cents-result.shipping_gross_cents-result.withholding_cents;
 result.commission_rate_id=null;
 result.warnings=[...result.warnings,'Komisyon ve KDV ilan satırı bazında; kargo, ambalaj ve diğer paket giderleri paket başına bir kez hesaplandı.'];
 return result;
}
export function findPriceFloor(input){
 const missing=validate(input),max=input.maxPriceCents??1000000,target=input.desiredProfitCents??0;
 if(!whole(max,1,10000000)||!whole(target,0,100000000))missing.push('Arama üst sınırı/hedef kâr geçersiz.');
 if(missing.length)return {status:'incomplete',price_cents:null,missing};
 // Enumerate every tariff interval. A global binary search is invalid when fees jump.
 const boundaries=new Set([0,max+1]);
 for(const r of [...(input.shippingRates||[]),...(input.commissionRates||[])])for(const b of [r.price_min_cents,r.price_max_cents])if(whole(b,1,max))boundaries.add(b);
 const points=[...boundaries].sort((a,b)=>a-b),gaps=[];let checkedCents=0;
 for(let i=0;i<points.length-1;i++){
  const low=points[i],high=points[i+1]-1,r=choose(input,low);
  if(r.missing.length){gaps.push(...r.missing);continue;}
  const p=input.profile,rev=10000/(10000+p.vat_bps),commBase=r.c.base==='gross'?1:rev;
  const comm=commBase*r.c.rate_bps/10000*(included(r.c.tax_included)?10000/(10000+r.c.vat_bps):1);
  const slope=rev-comm,fixed=p.replacement_cost_cents*(input.quantity??1)+p.packaging_cents+p.other_cents+fee(r.s.amount_cents,r.s.vat_bps,included(r.s.tax_included)).net;
  if(r.c.rate_bps===10000&&(r.c.base==='net'||p.vat_bps===0)&&(!included(r.c.tax_included)||r.c.vat_bps===0)&&-fixed<target)continue;
  // Total rounding deviation is <= 2 kuruş (revenue + commission base/fee).
  // Start at the optimistic feasible bound, then verify integer cents exactly.
  let start=low,end=high;
  if(slope>0)start=Math.max(low,Math.ceil((target+fixed-2)/slope));
  else if(slope<0)end=Math.min(high,Math.floor((target+fixed-2)/slope));
  else if(-fixed+2<target)continue;
  for(let price=start;price<=end;price++){
   if(++checkedCents>2048)return {status:'incomplete',price_cents:null,missing:['Tarifenin kuruş yuvarlaması çok geniş arama gerektiriyor. Arama üst sınırını daraltın; doğrulanmamış alt fiyat gösterilmedi.'],max_price_cents:max};
   const q=evaluate(input,price,r);
   if(q.estimated_profit_cents>=target)return gaps.length?{status:'incomplete',price_cents:null,candidate_price_cents:price,missing:[...new Set(gaps)],max_price_cents:max}:{status:'found',price_cents:price,quote:q,missing:[],max_price_cents:max};
  }
 }
 return {status:gaps.length?'incomplete':'impossible',price_cents:null,missing:[...new Set(gaps)],max_price_cents:max};
}
