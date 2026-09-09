// Counts cover the whole workspace, independently of paginated screen lists.
export async function attentionApi(request,env,path){
 if(path!=='/api/attention'||request.method!=='GET')return null;
 if(env.WORKSPACE!=='ec')throw Object.assign(new Error('İş listesi e-ticaret alanına aittir.'),{status:403});
 const day=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
 const next=new Date(Date.parse(day+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
 const queries=[
  `SELECT COUNT(*) total,
   COALESCE(SUM(source_changed=1 AND status!='cancelled'),0) changed,
   COALESCE(SUM(status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM order_line_components c WHERE c.line_id=l.id)!=10000)),0) unmapped,
   COALESCE(SUM(status='draft' AND EXISTS(SELECT 1 FROM order_lines l WHERE l.package_id=order_packages.id AND (l.net_revenue_cents IS NULL OR l.gross_cents IS NULL OR l.vat_bps IS NULL))),0) missing_amounts,
   COALESCE(SUM(status='reserved'),0) reserved FROM order_packages`,
  `SELECT COUNT(*) total,
   COALESCE(SUM(b.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM order_reservations r WHERE r.product_id=p.id AND r.released_on IS NULL),0)<=p.min_stock_milli),0) low,
   COALESCE(SUM(NOT EXISTS(SELECT 1 FROM stock_movements m WHERE m.product_id=p.id)),0) no_history
   FROM products p JOIN stock_balances b ON b.product_id=p.id`,
  `SELECT COALESCE(SUM(status='draft'),0) drafts,
   COALESCE(SUM(status='posted' AND EXISTS(SELECT 1 FROM purchase_lines l WHERE l.invoice_id=purchase_invoices.id AND l.line_type='product' AND l.quantity_milli-COALESCE((SELECT cancelled_milli FROM purchase_line_limits WHERE id=l.id),0)>COALESCE((SELECT SUM(g.quantity_milli) FROM effective_receipts g WHERE g.line_id=l.id),0))),0) awaiting_receipt FROM purchase_invoices`,
  `SELECT COUNT(*) total,
   COALESCE(SUM(fees_status!='confirmed' OR commission_cents IS NULL OR shipping_cents IS NULL OR other_cents IS NULL),0) unconfirmed,
   COALESCE(SUM(kind='sale' AND fees_status='confirmed' AND revenue_cents-cost_cents-commission_cents-shipping_cents-other_cents<0),0) losses FROM sale_entries`,
  `SELECT
   (SELECT COUNT(*) FROM shipping_rates WHERE archived_at IS NULL AND valid_from<=? AND valid_to>=?) shipping_active,
   (SELECT COUNT(*) FROM commission_rates WHERE archived_at IS NULL AND valid_from<=? AND valid_to>=?) commission_active,
   (SELECT COUNT(*) FROM shipping_rates WHERE archived_at IS NULL AND valid_from<=? AND valid_to BETWEEN ? AND ?) shipping_expiring,
   (SELECT COUNT(*) FROM commission_rates WHERE archived_at IS NULL AND valid_from<=? AND valid_to BETWEEN ? AND ?) commission_expiring`
 ];
 const results=await env.DB.batch(queries.map((sql,i)=>i===4?env.DB.prepare(sql).bind(day,day,day,day,day,day,next,day,day,next):env.DB.prepare(sql)));
 const [orders,stock,invoices,sales,tariffs]=results.map(r=>r.results[0]);
 return {as_of:day,scope:'all_time',orders,stock,invoices,sales,tariffs};
}
