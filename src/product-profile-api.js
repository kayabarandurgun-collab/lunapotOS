import {can} from '../public/permissions.js';
import {scrubAmounts} from './permission-policy.js';
import {stockHistoryApi} from './stock-history-api.js';
import {warehousePermission,warehouseStock,warehouseReplenishment,warehouseFail as fail} from './warehouse-api.js';

// A physical-product dossier. Never selects customer, payment, party balance, or sale revenue fields.
export async function productProfileApi(request,env,path){
 if(path!=='/api/product-profile')return null;
 warehousePermission(env,false);if(request.method!=='GET')fail('Ürün dosyası yalnızca okunur.',405);
 const url=new URL(request.url),id=url.searchParams.get('id');if(!id||!/^[\w-]{1,100}$/.test(id))fail('Ürün seçin.');
 const stock=await warehouseStock(env,id);if(!stock.length)fail('Ürün bu çalışma alanında bulunamadı.',404);
 const historyUrl=new URL(request.url);historyUrl.searchParams.set('product',id);
 const history=await stockHistoryApi(new Request(historyUrl),env,'/api/stock/history');
 const purchaseAccess=can(env.USER,env.WORKSPACE,env.WORKSPACE==='ec'?'invoices':'accounts');
 let purchases=[],suppliers=[],primarySupplier=null,purchaseTotal=0;
 if(purchaseAccess){
  const ec=env.WORKSPACE==='ec';
  const [purchaseRows,supplierRows,totalRows]=(await env.DB.batch([
   env.DB.prepare(`SELECT l.id line_id,i.id invoice_id,i.invoice_no,i.invoice_date,s.id supplier_id,s.name supplier_name,
    l.quantity_milli,l.net_cents,l.tax_cents,
    ${ec?'v.effective_net-v.closed_net':'l.net_cents'} remaining_net_cents,
    ${ec?'l.quantity_milli-v.closed_milli':'l.quantity_milli'} remaining_quantity_milli,
    ${ec?'v.closed_milli':'0'} closed_milli,
    COALESCE((SELECT SUM(g.quantity_milli) FROM ${ec?'effective_receipts':'goods_receipts'} g WHERE g.line_id=l.id),0) received_milli
    FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id JOIN suppliers s ON s.id=i.supplier_id
    ${ec?'JOIN purchase_line_limits v ON v.id=l.id':''} WHERE l.product_id=? AND i.status='posted' AND l.line_type='product'
    ORDER BY i.invoice_date DESC,i.rowid DESC,l.rowid DESC LIMIT 51`).bind(id),
   env.DB.prepare(`SELECT DISTINCT s.id,s.name FROM suppliers s JOIN purchase_invoices i ON i.supplier_id=s.id JOIN purchase_lines l ON l.invoice_id=i.id WHERE l.product_id=? AND i.status='posted' AND l.line_type='product' ORDER BY s.name LIMIT 101`).bind(id),
   env.DB.prepare("SELECT COUNT(*) n FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE l.product_id=? AND i.status='posted' AND l.line_type='product'").bind(id)
  ])).map(r=>r.results);
  purchases=purchaseRows.map(l=>({...l,unit_cost_cents:l.remaining_quantity_milli>0?Math.round(l.remaining_net_cents*1000/l.remaining_quantity_milli):null}));
  suppliers=supplierRows;purchaseTotal=totalRows[0].n;
  if(stock[0].supplier_id)primarySupplier=await env.DB.prepare("SELECT id,name FROM suppliers WHERE id=? AND kind='supplier'").bind(stock[0].supplier_id).first();
 }
 let replenishment=null,sets=[];
 if(env.WORKSPACE==='ec'){
  const allStock=await warehouseStock(env);if(!allStock.some(p=>p.id===id))allStock.push(stock[0]);
  const r=await warehouseReplenishment(env,allStock);
  replenishment={...r.proposals.find(p=>p.product_id===id),assumptions:r.assumptions};
  sets=r.sets.filter(s=>s.components.some(c=>c.product_id===id));
 }
 return scrubAmounts({product:stock[0],history:{rows:history.rows,totals:history.totals,pagination:history.pagination},
  purchase_access:purchaseAccess,purchases:purchases.slice(0,50),purchase_total:purchaseTotal,purchases_truncated:purchases.length>50,
  suppliers:suppliers.slice(0,100),suppliers_truncated:suppliers.length>100,primary_supplier:primarySupplier,
  last_unit_cost_cents:purchases.find(p=>p.unit_cost_cents!==null)?.unit_cost_cents??null,
  links:history.links,sets,replenishment,as_of:new Date().toISOString()},env.USER,env.WORKSPACE);
}
