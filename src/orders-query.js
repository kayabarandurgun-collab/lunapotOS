const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const date=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail('Tarih geçersiz.');return value;};
// Bind all user values. Search applies before paging, including old packages.
export function ordersQuery(url,today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'})){
 const p=new URL(url).searchParams,selected=p.get('package');
 if(selected){if(!/^[\w-]{1,100}$/.test(selected))fail('Paket kimliği geçersiz.');return {scope:' WHERE id=?',args:[selected],page:1,limit:1,offset:0};}
 const clauses=[],args=[],add=(sql,...values)=>{clauses.push(sql);args.push(...values);};
 const q=(p.get('q')||'').trim(),channel=p.get('channel')||'',status=p.get('status')||'',watch=p.get('watch')||'',from=p.get('from')||'',to=p.get('to')||'';
 if(q.length>200)fail('Arama en fazla 200 karakter olmalı.');
 if(channel&&!['trendyol','hepsiburada','other'].includes(channel))fail('Kanal geçersiz.');
 if(status&&!['draft','reserved','shipped','delivered','cancelled'].includes(status))fail('Sipariş durumu geçersiz.');
 if(watch&&!['source_changed','unmapped','missing_amounts','long_shipping'].includes(watch))fail('Takip filtresi geçersiz.');
 if(q){const term='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';add("(external_id LIKE ? ESCAPE '\\' OR order_no LIKE ? ESCAPE '\\' OR shipment_reference LIKE ? ESCAPE '\\')",term,term,term);}
 if(channel)add('channel=?',channel);if(status)add('status=?',status);
 if(from)add('occurred_on>=?',date(from));if(to)add('occurred_on<=?',date(to));if(from&&to&&from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 if(watch==='source_changed')add("source_changed=1 AND status!='cancelled'");
 if(watch==='unmapped')add("status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM order_line_components c WHERE c.line_id=l.id)!=10000)");
 if(watch==='missing_amounts')add("status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (l.net_revenue_cents IS NULL OR l.gross_cents IS NULL OR l.vat_bps IS NULL))");
 if(watch==='long_shipping')add("status='shipped' AND shipped_on<=?",new Date(Date.parse(date(today))-7*86400000).toISOString().slice(0,10));
 const page=Number(p.get('page')||1),limit=Number(p.get('limit')||500);
 if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(limit)||limit<1||limit>500)fail('Sayfa bilgisi geçersiz.');
 return {scope:clauses.length?' WHERE '+clauses.map(c=>'('+c+')').join(' AND '):'',args,page,limit,offset:(page-1)*limit};
}
