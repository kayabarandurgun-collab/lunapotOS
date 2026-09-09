import {quotePrice,findPriceFloor} from '../public/pricing-math.js';
export function priceDecision(input){
 const quote=quotePrice(input),floor=findPriceFloor(input),breakEven=input.desiredProfitCents===0?floor:findPriceFloor({...input,desiredProfitCents:0});
 const max=input.maxPriceCents??1000000,p=input.profile,active=r=>!r.archived_at&&r.channel===input.channel&&r.valid_from<=input.date&&r.valid_to>=input.date;
 const relevant=[...(input.shippingRates||[]).filter(r=>active(r)&&r.carrier===input.carrier),...(input.commissionRates||[]).filter(r=>active(r)&&(!r.sku||r.sku.toLowerCase()===String(p?.sku).toLowerCase())&&(!r.category||r.category===p?.category))];
 const boundaries=[...new Set(relevant.flatMap(r=>[r.price_min_cents,r.price_max_cents]).filter(v=>Number.isSafeInteger(v)&&v>0&&v<=max))].sort((a,b)=>Math.abs(a-input.priceCents)-Math.abs(b-input.priceCents)).slice(0,2).sort((a,b)=>a-b);
 const points=new Map();const add=(price,label)=>{if(Number.isSafeInteger(price)&&price>=0&&price<=max){const old=points.get(price);points.set(price,old?old+' · '+label:label);}};
 add(input.priceCents,'Seçtiğin fiyat');if(breakEven.status==='found')add(breakEven.price_cents,'Zarar etmeme sınırı');if(floor.status==='found')add(floor.price_cents,'Hedef kâr fiyatı');
 for(const b of boundaries){add(b-1,'Barem öncesi');add(b,'Yeni barem');}
 const scenarios=[...points].sort(([a],[b])=>a-b).map(([price,label])=>({label,price_cents:price,...quotePrice({...input,priceCents:price})}));
 const cliffs=boundaries.map(boundary=>{const before=quotePrice({...input,priceCents:boundary-1}),after=quotePrice({...input,priceCents:boundary});return before.status==='estimated'&&after.status==='estimated'&&after.estimated_profit_cents<before.estimated_profit_cents?{price_cents:boundary,profit_drop_cents:before.estimated_profit_cents-after.estimated_profit_cents}:null;}).filter(Boolean);
 return {quote,floor,break_even:breakEven,scenarios,cliffs,tariffs:{commission:(input.commissionRates||[]).find(r=>r.id===quote.commission_rate_id)||null,shipping:(input.shippingRates||[]).find(r=>r.id===quote.shipping_rate_id)||null},cost_basis:'saved_product_profile'};
}
