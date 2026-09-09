const fail=message=>{throw Object.assign(new Error(message),{status:400});};
export async function purchaseSearchApi(request,env,path){
 if(path!=='/api/purchases'||request.method!=='GET')return null;
 const params=new URL(request.url).searchParams,q=(params.get('q')||'').trim(),status=params.get('status')||'',page=Number(params.get('page')||1);
 if(q.length>200||!Number.isSafeInteger(page)||page<1||page>100000||!['','draft','posted','cancelled','awaiting'].includes(status))fail('Fatura arama veya sayfa bilgisi geçersiz.');
 const receipts=env.WORKSPACE==='ec'?'effective_receipts':'goods_receipts';
 const pending=`EXISTS(SELECT 1 FROM purchase_lines l WHERE l.invoice_id=i.id AND l.line_type='product' AND l.quantity_milli>COALESCE((SELECT SUM(g.quantity_milli) FROM ${receipts} g WHERE g.line_id=l.id),0))`;
 const where=['1=1'],args=[];
 if(q){where.push("(instr(lower(i.invoice_no),lower(?))>0 OR instr(lower(s.name),lower(?))>0 OR instr(lower(COALESCE(i.uuid,'')),lower(?))>0)");args.push(q,q,q);}
 if(status==='awaiting')where.push("i.status='posted' AND "+pending);else if(status){where.push('i.status=?');args.push(status);}
 const base=' FROM purchase_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE '+where.join(' AND '),db=env.DB;
 const result=await db.batch([
  db.prepare('SELECT COUNT(*) total'+base).bind(...args),
  db.prepare(`SELECT i.*,s.name supplier_name,(SELECT COALESCE(SUM(net_cents),0) FROM purchase_lines WHERE invoice_id=i.id) net_cents,(SELECT COALESCE(SUM(tax_cents),0) FROM purchase_lines WHERE invoice_id=i.id) tax_cents,${pending} awaiting_receipt${base} ORDER BY i.invoice_date DESC,i.created_at DESC,i.id DESC LIMIT 50 OFFSET ?`).bind(...args,(page-1)*50)
 ]);
 return {invoices:result[1].results,total:result[0].results[0].total,page,page_size:50};
}
