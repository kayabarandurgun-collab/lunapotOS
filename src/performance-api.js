import {effectiveNet} from './purchase-adjustment-api.js';
import {summary} from '../public/accounting-math.js';
import {compositionKey,estimatePackage,parcelTemplateKey,useParcelTemplate} from './order-estimate-api.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const day=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const all=async s=>(await s.all()).results;
export async function performanceApi(request,env,path){
 if(path!=='/api/performance'||request.method!=='GET')return null;
 if(env.WORKSPACE!=='ec')fail('Kanal kârlılığı e-ticaret alanına aittir.',403);
 const url=new URL(request.url),today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
 const from=day(url.searchParams.get('from')||new Date(Date.parse(today)-30*86400000).toISOString().slice(0,10)),to=day(url.searchParams.get('to')||today);
 if(from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 const mode=url.searchParams.get('mode')||'delivered';if(!['delivered','pending'].includes(mode))fail('Rapor türü geçersiz.');
 const db=env.DB,packages=await all(db.prepare(`SELECT * FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND ${mode==='delivered'?"status='delivered' AND delivered_on BETWEEN ? AND ?":"status IN ('draft','reserved','shipped') AND occurred_on BETWEEN ? AND ?"} ORDER BY occurred_on DESC,id LIMIT 1001`).bind(from,to));
 if(packages.length>1000)fail('Bu aralıkta 1.000’den fazla paket var. Eksiksiz toplam için tarih aralığını daraltın.',409);
 const ids=JSON.stringify(packages.map(p=>p.id));
 const [lines,components,sales,inputs,shippingRates,commissionRates]=(await db.batch([
  db.prepare('SELECT * FROM order_lines WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT c.*,l.package_id,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT s.*,l.package_id FROM sale_entries s JOIN order_line_components c ON (s.id=c.sale_id OR s.parent_id=c.sale_id) JOIN order_lines l ON l.id=c.line_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT * FROM order_estimate_inputs WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT * FROM shipping_rates WHERE archived_at IS NULL LIMIT 1001'),
  db.prepare('SELECT * FROM commission_rates WHERE archived_at IS NULL LIMIT 1001')
 ])).map(r=>r.results);
 if(shippingRates.length>1000||commissionRates.length>1000)fail('Tarife sayısı sınırı aşıldı. Eski tarifeleri arşivleyin.',409);
 const group=items=>{const m=new Map();for(const r of items){const list=m.get(r.package_id)||[];list.push(r);m.set(r.package_id,list);}return m;};
 const lineMap=group(lines),partMap=group(components),saleMap=group(sales),inputMap=new Map(inputs.map(r=>[r.package_id,r]));
 const templateKeys=packages.filter(p=>!inputMap.has(p.id)).map(p=>parcelTemplateKey(p,lineMap.get(p.id)||[],partMap.get(p.id)||[]));
 const templates=mode==='pending'&&templateKeys.length?await all(db.prepare('SELECT * FROM parcel_templates WHERE template_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(templateKeys))):[];
 const templateMap=new Map(templates.map(t=>[t.template_key,t]));
 const rows=packages.map(p=>{
  const packageLines=lineMap.get(p.id)||[],parts=partMap.get(p.id)||[],entries=saleMap.get(p.id)||[];
  const row={id:p.id,channel:p.channel,order_no:p.order_no,external_id:p.external_id,status:p.status,occurred_on:p.occurred_on,delivered_on:p.delivered_on,profit_cents:null,missing:[],revenue_net_cents:null,cost_net_cents:null,shipping_cents:null,commission_cents:null,other_cents:null};
  if(p.source_changed){row.missing.push('Kaynak sipariş değişti; farkı inceleyin.');return row;}
  if(mode==='delivered'){
   const total=summary(entries,[]),originals=new Set(entries.filter(s=>s.kind==='sale').map(s=>s.id));
   if(!parts.length||parts.some(c=>!c.sale_id||!originals.has(c.sale_id))){row.missing.push('Teslimata bağlı stok ve satış kaydı eksik.');return row;}
   row.revenue_net_cents=total.revenue;row.cost_net_cents=total.cost;
   const fee=key=>entries.every(s=>s[key]!==null)?entries.reduce((sum,s)=>sum+s[key],0):null;
   row.shipping_cents=fee('shipping_cents');row.commission_cents=fee('commission_cents');row.other_cents=fee('other_cents');
   if(total.missing||total.unconfirmed)row.missing.push('Kargo, komisyon veya diğer kesintiler doğrulanmayı bekliyor.');else row.profit_cents=total.profit;
   row.returns=entries.filter(s=>s.kind==='return').length;
  }else{
   const direct=inputMap.get(p.id),template=templateMap.get(parcelTemplateKey(p,packageLines,parts)),saved=direct||template;
   if(!saved){row.missing.push('Sipariş özetinde paket ölçüsü ve giderleri bir kez tanımlayın.');return row;}
   if(direct&&(saved.source_fingerprint!==p.source_fingerprint||saved.composition_key!==compositionKey(packageLines,parts))){row.missing.push('Paket içeriği değişti; ölçü ve gider varsayımlarını yenileyin.');return row;}
   try{
    const stored=JSON.parse(saved.input_json),x=direct?stored:useParcelTemplate(stored,packageLines,parts),estimate=estimatePackage(p,packageLines,parts,{...x,date:p.shipped_on||today},shippingRates,commissionRates,false),q=estimate.quote;
    if(q.status!=='estimated'){row.missing=q.missing;return row;}
    Object.assign(row,{profit_cents:q.estimated_profit_cents,revenue_net_cents:q.revenue_net_cents,cost_net_cents:q.cost_net_cents,shipping_cents:q.shipping_net_cents,commission_cents:q.commission_net_cents,other_cents:q.packaging_net_cents+q.other_net_cents,assumptions_source:direct?'package':'identical_contents_template',assumptions_saved_at:saved.updated_at,tariff_date:p.shipped_on||today,cost_basis:estimate.cost_basis});
   }catch{row.missing.push('Kayıtlı paket varsayımları hesaplanamadı; sipariş özetinden yenileyin.');}
  }
  return row;
 });
 const pendingFees=mode==='delivered'?await db.prepare(`SELECT COALESCE(SUM(${effectiveNet(env.WORKSPACE)}-COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0)),0) cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee'`).first():{cents:0};
 const channels=['trendyol','hepsiburada'].map(channel=>{
  const items=rows.filter(r=>r.channel===channel),complete=items.filter(r=>r.profit_cents!==null);
  const subtotal=complete.reduce((sum,r)=>sum+r.profit_cents,0);
  return {channel,packages:items.length,calculated:complete.length,missing:items.length-complete.length,profit_cents:items.length&&complete.length===items.length?subtotal:null,calculated_profit_cents:complete.length?subtotal:null,losses:complete.filter(r=>r.profit_cents<0).length};
 });
 return {mode,from,to,unallocated_fee_cents:pendingFees.cents,as_of:new Date().toISOString(),channels,rows,notice:mode==='delivered'?'Teslim tarihi seçilen aralıktaki paketlerdir. Bu paketlere sonradan işlenen iadeler de dahildir. Yalnızca kesintileri doğrulanmış satışlar kesin hesaba girer.':'Sipariş tarihi seçilen aralıktaki hazırlık ve kargodaki paketlerdir. Kayıtlı paket varsayımlarıyla her açılışta yeniden hesaplanır; teslim edilenler dahil değildir.',cost_notice:'KDV hariç satış katkısıdır. Ürün maliyeti ve kaydedilen satış giderleri düşülür; ortak işletme giderleri ve gelir/kurumlar vergisi dahil değildir.'};
}
