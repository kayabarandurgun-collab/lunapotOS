const fail=message=>{throw Object.assign(new Error(message),{status:400});};
export async function purchaseSearchApi(request,env,path){
 if(path!=='/api/purchases'||request.method!=='GET')return null;
 const params=new URL(request.url).searchParams,q=(params.get('q')||'').trim(),status=params.get('status')||'',page=Number(params.get('page')||1);
 // Sıralama: tarih (varsayılan yeniden eskiye) veya net alış tutarı. Sayfalama sıralamadan SONRA yapılır.
 const SIRA={'':'i.invoice_date DESC,i.created_at DESC,i.id DESC',date_asc:'i.invoice_date ASC,i.created_at ASC,i.id ASC',net_desc:'net_cents DESC,i.invoice_date DESC,i.id DESC',net_asc:'net_cents ASC,i.invoice_date DESC,i.id DESC'},sort=params.get('sort')||'';
 if(!Object.hasOwn(SIRA,sort))fail('Sıralama geçersiz.');
 if(q.length>200||!Number.isSafeInteger(page)||page<1||page>100000||!['','draft','posted','cancelled','awaiting'].includes(status))fail('Fatura arama veya sayfa bilgisi geçersiz.');
 const receipts=env.WORKSPACE==='ec'?'effective_receipts':'goods_receipts',cancelled=env.WORKSPACE==='ec'?'COALESCE((SELECT cancelled_milli FROM purchase_line_limits WHERE id=l.id),0)':'0';
 const pending=`EXISTS(SELECT 1 FROM purchase_lines l WHERE l.invoice_id=i.id AND l.line_type='product' AND l.quantity_milli-${cancelled}>COALESCE((SELECT SUM(g.quantity_milli) FROM ${receipts} g WHERE g.line_id=l.id),0))`;
 // Faturanın cari borcu ve o borca yapılan ödeme: listede "Ödendi / Kısmi / Açık" rozeti buradan çıkar.
 // Düzeltilmiş (ters kaydı yazılmış) borç sayılmaz; geri alınan kapama ödenmiş sayılmaz.
 const live="e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM party_entries x WHERE x.reversal_of=e.id)";
 const debt=`(SELECT -e.amount_cents FROM party_entries e WHERE e.source_key='invoice:'||i.id AND ${live})`;
 const paid=`COALESCE((SELECT SUM(a.amount_cents) FROM payment_allocations a JOIN party_entries e ON e.id=a.negative_entry_id WHERE e.source_key='invoice:'||i.id AND ${live} AND NOT EXISTS(SELECT 1 FROM allocation_reversals r WHERE r.allocation_id=a.id)),0)`;
 const planned=`(SELECT p.planned_on FROM party_entry_plans p JOIN party_entries e ON e.id=p.entry_id WHERE e.source_key='invoice:'||i.id AND ${live} ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)`;
 const where=['1=1'],args=[];
 if(q){where.push("(instr(lower(i.invoice_no),lower(?))>0 OR instr(lower(s.name),lower(?))>0 OR instr(lower(COALESCE(i.uuid,'')),lower(?))>0)");args.push(q,q,q);}
 if(status==='awaiting')where.push("i.status='posted' AND "+pending);else if(status){where.push('i.status=?');args.push(status);}
 const base=' FROM purchase_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE '+where.join(' AND '),db=env.DB;
 const result=await db.batch([
  db.prepare('SELECT COUNT(*) total'+base).bind(...args),
  db.prepare(`SELECT i.*,s.name supplier_name,(SELECT COALESCE(SUM(net_cents),0) FROM purchase_lines WHERE invoice_id=i.id) net_cents,(SELECT COALESCE(SUM(tax_cents),0) FROM purchase_lines WHERE invoice_id=i.id) tax_cents,${pending} awaiting_receipt,${debt} debt_cents,${paid} paid_cents,${planned} planned_on${base} ORDER BY ${SIRA[sort]} LIMIT 50 OFFSET ?`).bind(...args,(page-1)*50)
 ]);
 return {invoices:result[1].results,total:result[0].results[0].total,page,page_size:50};
}
