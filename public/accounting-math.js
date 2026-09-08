export function cents(value) {
 if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e8) throw new Error('Tutar geçersiz.');
 return Math.round((value+Math.sign(value)*Number.EPSILON)*100);
}
export function milli(value) {
 if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e6||Math.abs(value*1000-Math.round(value*1000))>.000001) throw new Error('Miktar en fazla üç ondalıklı ve sıfırdan büyük olmalı.');
 return Math.round(value*1000);
}
export function contribution(entry) {
 if([entry.commission_cents,entry.shipping_cents,entry.other_cents].some(v=>v===null||v===undefined))return null;
 return entry.revenue_cents-entry.cost_cents-entry.commission_cents-entry.shipping_cents-entry.other_cents;
}
export function summary(entries,expenses) {
 const totals={revenue:0,cost:0,commission:0,shipping:0,other:0,expenses:0,paidExpenses:0,missing:0,unconfirmed:0,profit:null,estimatedProfit:null};
 for(const e of entries){totals.revenue+=e.revenue_cents;totals.cost+=e.cost_cents;totals.commission+=e.commission_cents??0;totals.shipping+=e.shipping_cents??0;totals.other+=e.other_cents??0;if(contribution(e)===null)totals.missing++;if(e.fees_status!=='confirmed')totals.unconfirmed++;}
 for(const e of expenses){totals.expenses+=e.amount_cents;if(e.paid)totals.paidExpenses+=e.amount_cents;}
 if(!totals.missing)totals.estimatedProfit=totals.revenue-totals.cost-totals.commission-totals.shipping-totals.other-totals.expenses;
 if(!totals.unconfirmed)totals.profit=totals.estimatedProfit;
 return totals;
}
