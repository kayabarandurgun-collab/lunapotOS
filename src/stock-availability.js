// Read-only physical availability. See docs/STOCK-MODEL-2026-09-20.md.
// Performance pending uses the same full-return and delivered DUZ twin exclusions.
// Physical stock includes all EC channels; reserved/draft packages are never transit.
// Exclusions only: caller chooses statuses, channels and dates. Alias is a code constant.
// Same component-linked sale / return semantics as performanceReport pending.
export function pendingPackageScopeSql(alias = 'p') {
 if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw Error('Invalid SQL alias');
 const sold = `(SELECT COALESCE(SUM(s.quantity_milli),0) FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id AND s.kind='sale' WHERE l.package_id=${alias}.id)`;
 const returned = `(SELECT COALESCE(SUM(r.quantity_milli),0) FROM sale_entries r WHERE r.kind='return' AND r.parent_id IN (SELECT c.sale_id FROM order_line_components c JOIN order_lines l ON l.id=c.line_id WHERE l.package_id=${alias}.id))`;
 return `NOT (${sold}>0 AND ${returned}>=${sold}) AND NOT (${alias}.status='shipped' AND EXISTS (
  SELECT 1 FROM order_packages d JOIN order_lines l ON l.package_id=d.id
  JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id
  WHERE d.status='delivered' AND d.channel=${alias}.channel AND d.order_no=${alias}.order_no
  AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%'))`;
}
export const stockTransitQuery = `
 WITH shipped AS (SELECT p.* FROM order_packages p WHERE p.status='shipped' AND ${pendingPackageScopeSql('p')})
 SELECT p.id package_id,p.source_changed,l.id line_id,c.id component_id,c.product_id,
 c.quantity_milli component_milli,c.stock_unit,pd.stock_unit current_stock_unit,
 s.id sale_id,s.product_id sale_product_id,s.quantity_milli sold_milli,
 COALESCE((SELECT SUM(r.quantity_milli) FROM sale_entries r WHERE r.parent_id=s.id AND r.kind='return'),0) returned_milli
 FROM shipped p LEFT JOIN order_lines l ON l.package_id=p.id
 LEFT JOIN order_line_components c ON c.line_id=l.id
 LEFT JOIN products pd ON pd.id=c.product_id
 LEFT JOIN sale_entries s ON s.id=c.sale_id AND s.kind='sale'`;

const integer = v => Number.isSafeInteger(v) ? v : null;
export function physicalStock(stock, transitRows, workspace = 'ec') {
 const totals = new Map(), issues = new Map(), globalIssues = new Set(), packages = new Map();
 const issue = (product, text) => {
  if (!product) { globalIssues.add(text); return; }
  if (!issues.has(product)) issues.set(product, new Set());
  issues.get(product).add(text);
 };
 for (const row of transitRows) {
  if (!packages.has(row.package_id)) packages.set(row.package_id, []);
  packages.get(row.package_id).push(row);
 }
 const countedSales = new Set();
 for (const rows of packages.values()) {
  // Do not let a fully returned component conceal an unmapped/missing sale line.
  if (rows.every(r => r.sale_id && r.returned_milli >= r.sold_milli)) continue;
  for (const r of rows) {
   if (!r.component_id) {
    issue(null, 'Gönderilmiş bir paketin ürün eşleşmesi eksik; kargodaki toplam tamamlanamadı.');
    continue;
   }
   if (r.source_changed) {
    // Changed source can also contain products absent from the stored snapshot.
    issue(null, 'Gönderilmiş bir paketin kaynak bilgisi değişmiş; kargodaki miktar doğrulanmalı.');
    continue;
   }
   if (!r.sale_id || r.sale_product_id !== r.product_id || r.stock_unit !== r.current_stock_unit || r.component_milli !== r.sold_milli) {
    issue(r.product_id, 'Gönderilmiş bileşenin satış / stok birimi bağlantısı eksik veya tutarsız.');
    continue;
   }
   if (countedSales.has(r.sale_id)) continue;
   countedSales.add(r.sale_id);
   totals.set(r.product_id, (totals.get(r.product_id) || 0) + Math.max(0, r.sold_milli - r.returned_milli));
  }
 }
 return stock.map(p => {
  const onHand = integer(p.quantity_milli), reserved = integer(p.reserved_milli);
  const notes = workspace === 'ec' ? [...new Set([...globalIssues, ...(issues.get(p.id) || [])])] : ['Bu çalışma alanında paket sevk miktarı izlenmiyor.'];
  const known = workspace === 'ec' ? totals.get(p.id) || 0 : null;
  return {...p, on_hand_milli: onHand, reserved_milli: reserved,
   available_milli: onHand === null || reserved === null ? null : onHand - reserved,
   in_transit_milli: notes.length ? null : known, in_transit_known_milli: known,
   in_transit_status: workspace !== 'ec' ? 'not_supported' : notes.length ? 'incomplete' : 'complete',
   in_transit_notes: notes};
 });
}
