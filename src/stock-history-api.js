const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const day=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('Tarih geçersiz.');return value;};
export function stockHistoryQuery(url){
 const p=new URL(url).searchParams,product=p.get('product')||'',q=(p.get('q')||'').trim(),from=p.get('from')||'',to=p.get('to')||'',direction=p.get('direction')||'',page=Number(p.get('page')||1);
 if(!/^[\w-]{1,100}$/.test(product))fail('Ürün kartını seçin.');
 if(q.length>200)fail('Arama en fazla 200 karakter olmalı.');
 if(!['','in','out','value'].includes(direction))fail('Hareket türü geçersiz.');
 if(!Number.isSafeInteger(page)||page<1||page>1000000)fail('Sayfa bilgisi geçersiz.');
 const terms=[],args=[];
 if(from){terms.push('occurred_on>=?');args.push(day(from));}if(to){terms.push('occurred_on<=?');args.push(day(to));}if(from&&to&&from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 if(q){terms.push("(reference LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");const term='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';args.push(term,term);}
 if(direction)terms.push({in:'quantity_milli>0',out:'quantity_milli<0',value:'quantity_milli=0'}[direction]);
 return {product,page,limit:50,where:terms.length?' WHERE '+terms.join(' AND '):'',args};
}
export async function stockHistoryApi(request,env,path){
 if(path!=='/api/stock/history'||request.method!=='GET')return null;
 if(!['ec','lp'].includes(env.WORKSPACE))fail('Çalışma alanı geçersiz.',403);
 const {product,page,limit,where,args}=stockHistoryQuery(request.url),db=env.DB,ec=env.WORKSPACE==='ec';
 const card=await db.prepare(`SELECT p.id,p.name,p.sku,p.stock_unit,b.quantity_milli,b.value_cents,${ec?"COALESCE((SELECT SUM(r.quantity_milli) FROM order_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0)":'0'} reserved_milli FROM products p JOIN stock_balances b ON b.product_id=p.id WHERE p.id=?`).bind(product).first();
 if(!card)fail('Ürün bu çalışma alanında bulunamadı.',404);
 const cte=`WITH history AS (SELECT id,quantity_milli,value_cents,kind,reference,notes,occurred_on,created_at,${ec?"'manual'":'origin'} origin FROM stock_movements WHERE product_id=?${ec?` UNION ALL SELECT 'adjustment:'||a.id,0,iif(a.reversal_of IS NULL,-a.stock_cents,a.stock_cents),'adjustment',a.reference,a.reason,a.occurred_on,a.created_at,'adjustment' FROM purchase_adjustments a JOIN purchase_lines l ON l.id=a.line_id WHERE l.product_id=? AND a.stock_cents!=0`:''}) `;
 const values=[product,...(ec?[product]:[]),...args];
 const [summary,rows]=(await db.batch([
  db.prepare(cte+`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN quantity_milli>0 THEN quantity_milli ELSE 0 END),0) incoming_milli,COALESCE(SUM(CASE WHEN quantity_milli<0 THEN -quantity_milli ELSE 0 END),0) outgoing_milli,COALESCE(SUM(value_cents),0) value_change_cents FROM history`+where).bind(...values),
  db.prepare(cte+'SELECT * FROM history'+where+' ORDER BY occurred_on DESC,created_at DESC,id DESC LIMIT ? OFFSET ?').bind(...values,limit,(page-1)*limit)
 ])).map(r=>r.results);
 const totals=summary[0];
 return {product:card,rows,totals,pagination:{page,limit,total:totals.total,pages:Math.max(1,Math.ceil(totals.total/limit)),has_more:page*limit<totals.total},as_of:new Date().toISOString()};
}
