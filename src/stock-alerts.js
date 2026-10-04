// Quantity-only replenishment evidence. Execute through scopedDB('ec'); never joins financial ledgers.
// Technical corrections restate the original sale day; customer restocks use their actual return day.
export const stockDemandQuery = `
WITH bounds AS (SELECT date('now','+3 hours') today,date('now','+3 hours','-6 days') last7,
 date('now','+3 hours','-13 days') previous7,date('now','+3 hours','-29 days') last30),
links AS (
 SELECT c.sale_id,l.package_id,c.product_id,c.quantity_milli,c.stock_unit FROM order_line_components c
 JOIN order_lines l ON l.id=c.line_id WHERE c.sale_id IS NOT NULL
 UNION
 SELECT l.sale_id,l.package_id,l.product_id,l.quantity_milli,p.stock_unit FROM order_lines l
 JOIN products p ON p.id=l.product_id WHERE l.sale_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM order_line_components c WHERE c.sale_id=l.sale_id)
),
checked_sales AS (
 SELECT s.id,s.product_id,s.quantity_milli,s.occurred_on,
  CASE WHEN s.occurred_on>bounds.today THEN 'future_sale'
   WHEN NOT EXISTS(SELECT 1 FROM stock_movements m WHERE m.kind='sale' AND m.reference=s.id
    AND m.product_id=s.product_id AND m.quantity_milli=-s.quantity_milli AND m.occurred_on=s.occurred_on) THEN 'missing_stock_movement'
   WHEN EXISTS(SELECT 1 FROM links c JOIN order_packages p ON p.id=c.package_id
    WHERE c.sale_id=s.id AND (p.status NOT IN ('shipped','delivered') OR p.shipped_on IS NULL OR p.shipped_on>bounds.today)) THEN 'unshipped_sale'
   WHEN EXISTS(SELECT 1 FROM ws_sale_links w JOIN ws_orders o ON o.id=w.order_id
    WHERE w.sale_id=s.id AND (o.is_test!=0 OR o.status NOT IN ('shipped','delivered'))) THEN 'unshipped_sale'
   WHEN EXISTS(SELECT 1 FROM links c JOIN products p ON p.id=c.product_id WHERE c.sale_id=s.id
    AND (c.product_id!=s.product_id OR c.quantity_milli!=s.quantity_milli OR c.stock_unit!=p.stock_unit)) THEN 'inconsistent_component'
   ELSE NULL END issue
 FROM sale_entries s CROSS JOIN bounds WHERE s.kind='sale'
),
checked_returns AS (
 SELECT r.id,r.parent_id,r.product_id,r.quantity_milli,r.occurred_on,r.restock,
  (r.external_id LIKE 'DUZELTME-CIFT-%' OR r.external_id LIKE 'DUZELTME-IKAME-%') technical,
  EXISTS(SELECT 1 FROM stock_movements m WHERE m.kind='return' AND m.reference=r.id
   AND m.product_id=r.product_id AND m.quantity_milli=r.quantity_milli AND m.occurred_on=r.occurred_on) stock_returned
 FROM sale_entries r CROSS JOIN bounds WHERE r.kind='return' AND r.occurred_on<=bounds.today
),
corrected_sales AS (
 SELECT s.*,MAX(0,s.quantity_milli-COALESCE((SELECT SUM(r.quantity_milli) FROM checked_returns r
  WHERE r.parent_id=s.id AND r.technical=1),0)) gross_milli
 FROM checked_sales s WHERE s.issue IS NULL
),
events AS (
 SELECT product_id,occurred_on,gross_milli,0 restocked_milli,0 nonrestocked_milli FROM corrected_sales WHERE gross_milli>0
 UNION ALL
 SELECT r.product_id,r.occurred_on,0,iif(r.restock=1 AND r.stock_returned,r.quantity_milli,0),
  iif(r.restock=0,r.quantity_milli,0) FROM checked_returns r JOIN corrected_sales s ON s.id=r.parent_id WHERE r.technical=0
),
history AS (
 SELECT e.product_id,MIN(CASE WHEN e.gross_milli>0 THEN e.occurred_on END) first_sale_on,
  MAX(CASE WHEN e.gross_milli>0 THEN e.occurred_on END) last_sale_on,
  SUM(iif(e.occurred_on>=b.last7,e.gross_milli,0)) gross_7_milli,
  SUM(iif(e.occurred_on BETWEEN b.previous7 AND date(b.last7,'-1 day'),e.gross_milli,0)) gross_previous_7_milli,
  SUM(iif(e.occurred_on>=b.last30,e.gross_milli,0)) gross_30_milli,
  SUM(iif(e.occurred_on>=b.last7,e.restocked_milli,0)) restocked_7_milli,
  SUM(iif(e.occurred_on BETWEEN b.previous7 AND date(b.last7,'-1 day'),e.restocked_milli,0)) restocked_previous_7_milli,
  SUM(iif(e.occurred_on>=b.last30,e.restocked_milli,0)) restocked_30_milli,
  SUM(iif(e.occurred_on>=b.last30,e.nonrestocked_milli,0)) nonrestocked_30_milli,
  COUNT(DISTINCT CASE WHEN e.occurred_on>=b.last7 AND e.gross_milli>0 THEN e.occurred_on END) active_sales_days_7,
  COUNT(DISTINCT CASE WHEN e.occurred_on BETWEEN b.previous7 AND date(b.last7,'-1 day') AND e.gross_milli>0 THEN e.occurred_on END) active_sales_days_previous_7,
  COUNT(DISTINCT CASE WHEN e.occurred_on>=b.last30 AND e.gross_milli>0 THEN e.occurred_on END) active_sales_days_30
 FROM events e CROSS JOIN bounds b GROUP BY e.product_id
),
issues AS (
 SELECT product_id,issue FROM checked_sales WHERE issue IS NOT NULL
 UNION ALL
 SELECT r.product_id,'future_return' FROM sale_entries r CROSS JOIN bounds b
 WHERE r.kind='return' AND r.restock=1 AND r.occurred_on>b.today
 UNION ALL
 SELECT r.product_id,'return_before_sale' FROM checked_returns r JOIN sale_entries s ON s.id=r.parent_id
 WHERE r.occurred_on<s.occurred_on
 UNION ALL
 SELECT r.product_id,'missing_return_movement' FROM checked_returns r
 WHERE (r.restock=1 AND NOT r.stock_returned) OR (r.technical=1 AND r.restock=0)
 UNION ALL
 SELECT c.product_id,'shipment_history_incomplete' FROM order_line_components c
 JOIN order_lines l ON l.id=c.line_id JOIN order_packages p ON p.id=l.package_id CROSS JOIN bounds b
 WHERE p.status IN ('shipped','delivered') AND p.shipped_on<=b.today
 AND (c.sale_id IS NULL OR p.source_changed=1)
),
issue_counts AS (SELECT product_id,COUNT(*) issue_count FROM issues GROUP BY product_id),
unmapped AS (
 SELECT COUNT(*) issue_count FROM order_packages p LEFT JOIN order_lines l ON l.package_id=p.id CROSS JOIN bounds b
 WHERE p.status IN ('shipped','delivered') AND p.shipped_on<=b.today
 AND NOT EXISTS(SELECT 1 FROM order_line_components c WHERE c.line_id=l.id)
 AND l.sale_id IS NULL
)
SELECT p.id product_id,v.id supplier_id,v.name supplier_name,b.today as_of,b.last7 from_7,b.previous7 from_previous_7,b.last30 from_30,
 h.first_sale_on,h.last_sale_on,
 CASE WHEN h.first_sale_on IS NULL THEN 0 ELSE MIN(30,CAST(julianday(b.today)-julianday(h.first_sale_on)+1 AS INTEGER)) END history_days,
 COALESCE(h.gross_7_milli,0) gross_7_milli,COALESCE(h.gross_previous_7_milli,0) gross_previous_7_milli,COALESCE(h.gross_30_milli,0) gross_30_milli,
 COALESCE(h.restocked_7_milli,0) restocked_7_milli,COALESCE(h.restocked_previous_7_milli,0) restocked_previous_7_milli,COALESCE(h.restocked_30_milli,0) restocked_30_milli,
 COALESCE(h.nonrestocked_30_milli,0) nonrestocked_30_milli,
 MAX(0,COALESCE(h.gross_7_milli-h.restocked_7_milli,0)) demand_7_milli,
 MAX(0,COALESCE(h.gross_previous_7_milli-h.restocked_previous_7_milli,0)) previous_7_milli,
 MAX(0,COALESCE(h.gross_30_milli-h.restocked_30_milli,0)) demand_30_milli,
 COALESCE(h.active_sales_days_7,0) active_sales_days_7,COALESCE(h.active_sales_days_previous_7,0) active_sales_days_previous_7,
 COALESCE(h.active_sales_days_30,0) active_sales_days_30,
 COALESCE(i.issue_count,0) issue_count,u.issue_count unmapped_shipment_count
FROM products p CROSS JOIN bounds b CROSS JOIN unmapped u LEFT JOIN history h ON h.product_id=p.id
LEFT JOIN issue_counts i ON i.product_id=p.id LEFT JOIN suppliers v ON v.id=p.supplier_id AND v.archived_at IS NULL
WHERE p.archived_at IS NULL ORDER BY p.name,p.id`;

const rounded = n => Math.round(n * 1000) / 1000;
const reasonNotices = {
 unknown_available: 'Kullanılabilir stok hesaplanamıyor; depodaki miktarı ve ayırmaları kontrol edin.',
 incomplete_history: 'Satış / sevk geçmişinde tutarsızlık var; kalan gün ve sipariş miktarı hesaplanmadı.',
 no_history: 'Geçerli kayıtlı satış geçmişi yok.',
 short_history: 'Satış geçmişi 30 günden kısa; tahmin sınırlı veriye dayanıyor.',
 sparse_activity: 'Düzenli satış hızı için yeterli ayrı satış günü yok; 30 günlük ortalama esas alındı.',
 no_recent_demand: 'Son 30 günde net stok tüketimi görünmüyor.',
 unknown_supplier: 'Ürüne etkin bir tedarikçi bağlayın; arşivli kayıt veya marka adı tedarikçiyi doğrulamaz.',
 unknown_lead: 'Tedarik süresi eksik; sipariş miktarı için depo ayarını tamamlayın.',
 net_demand_clamped: 'Stoğa dönen iadelerin çıkışı aştığı dönemde net talep sıfırla sınırlandı.',
 out_of_stock: 'Kullanılabilir stok tükendi veya eksiye düştü.',
 below_lead: 'Bu hızla stok tedarik süresinden önce tükenebilir.',
 within_seven_days: 'Bu hızla stok en fazla 7 gün yeter.',
 within_lead_and_cover: 'Stok, tedarik süresi ve hedef gün toplamının eşiğinde veya altında.',
 minimum_reached: 'Kullanılabilir stok minimum stok eşiğinde veya altında.'
};

export function stockAlert(product, config = {}, history) {
 const h = history || {}, reasons = [];
 const known = Number.isSafeInteger(product.available_milli), available = known ? product.available_milli : null;
 const lead = config.lead_days ?? null, cover = config.cover_days ?? 7;
 const pack = config.pack_milli ?? (product.stock_unit === 'adet' ? 1000 : 1);
 const minimum = product.min_stock_milli ?? 0;
 const incomplete = !history || h.issue_count > 0 || h.unmapped_shipment_count > 0;
 const demand7 = h.demand_7_milli ?? 0, previous7 = h.previous_7_milli ?? 0, demand30 = h.demand_30_milli ?? 0;
 const recentEligible = h.history_days >= 7 && h.active_sales_days_7 >= 3;
 // Do not turn a single bulk shipment, or a few new-history days, into a weekly trend.
 const daily = recentEligible ? Math.max(demand30 / 30, demand7 / 7) : demand30 / 30;
 const days = known && !incomplete && daily > 0 ? Math.max(0, available) / daily : null;
 if (!known) reasons.push('unknown_available');
 if (incomplete) reasons.push('incomplete_history');
 if (!h.first_sale_on) reasons.push('no_history');
 else if (h.history_days < 30) reasons.push('short_history');
 if ((h.active_sales_days_30 ?? 0) < 3) reasons.push('sparse_activity');
 if (daily === 0) reasons.push('no_recent_demand');
 if (!h.supplier_id) reasons.push('unknown_supplier');
 if (lead === null) reasons.push('unknown_lead');
 if (h.restocked_7_milli > h.gross_7_milli || h.restocked_30_milli > h.gross_30_milli || h.restocked_previous_7_milli > h.gross_previous_7_milli) reasons.push('net_demand_clamped');
 let type = null, urgency = null;
 if (!known) type = 'unknown';
 else if (available <= 0) {
  type = lead === null ? 'low' : 'reorder'; urgency = 'urgent'; reasons.push('out_of_stock');
 } else if (days !== null && lead !== null && days < lead) {
  type = 'reorder'; urgency = 'urgent'; reasons.push('below_lead');
 } else if (days !== null && days <= (lead === null ? 7 : lead + cover)) {
  type = 'low'; urgency = 'soon'; reasons.push(lead === null ? 'within_seven_days' : 'within_lead_and_cover');
 }
 if (known && minimum > 0 && available <= minimum) {
  if (!type) { type = 'low'; urgency = 'soon'; }
  reasons.push('minimum_reached');
 }
 // History limitations alone are coverage notices, not replenishment cards for plentiful stock.
 if (!type && incomplete) type = 'unknown';
 const target = lead === null || incomplete ? null : Math.max(minimum, Math.ceil(daily * (lead + cover)));
 return {
  product_id: product.id, name: product.name, sku: product.sku, stock_unit: product.stock_unit,
  type, urgency, supplier_id: h.supplier_id ?? null, supplier_name: h.supplier_name ?? null,
  supplier_source: h.supplier_id ? 'product.supplier_id' : null,
  available_milli: available, on_hand_milli: product.on_hand_milli ?? null, reserved_milli: product.reserved_milli ?? null,
  daily_demand_milli: rounded(daily), weekly_demand_milli: rounded(daily * 7),
  daily_7_milli: rounded(demand7 / 7), daily_previous_7_milli: rounded(previous7 / 7), daily_30_milli: rounded(demand30 / 30),
  demand_7_milli: demand7, previous_7_milli: previous7, demand_30_milli: demand30,
  gross_7_milli: h.gross_7_milli ?? 0, gross_previous_7_milli: h.gross_previous_7_milli ?? 0, gross_30_milli: h.gross_30_milli ?? 0,
  restocked_7_milli: h.restocked_7_milli ?? 0, restocked_previous_7_milli: h.restocked_previous_7_milli ?? 0,
  restocked_30_milli: h.restocked_30_milli ?? 0, nonrestocked_30_milli: h.nonrestocked_30_milli ?? 0,
  days_remaining: days === null ? null : rounded(days), lead_days: lead, cover_days: cover, pack_milli: pack,
  min_stock_milli: minimum, target_milli: target,
  suggested_milli: !known || target === null ? null : Math.ceil(Math.max(0, target - available) / pack) * pack,
  projection_basis: recentEligible ? 'max_7_30' : 'average_30', recent_rate_eligible: recentEligible,
  history_status: incomplete ? 'incomplete' : !h.first_sale_on ? 'none' : h.history_days < 30 ? 'short' : 'recorded',
  history_completeness: 'unverified', history_days: h.history_days ?? 0,
  first_sale_on: h.first_sale_on ?? null, last_sale_on: h.last_sale_on ?? null,
  active_sales_days_7: h.active_sales_days_7 ?? 0, active_sales_days_previous_7: h.active_sales_days_previous_7 ?? 0,
  active_sales_days_30: h.active_sales_days_30 ?? 0, reason_codes: reasons,
  alert_notice: reasons.map(code => reasonNotices[code]).join(' ')
 };
}

export function replenishmentAlerts(stock, configs, histories) {
 const byConfig = new Map(configs.map(c => [c.product_id, c]));
 const byHistory = new Map(histories.map(h => [h.product_id, h]));
 const active = stock.filter(p => !p.archived_at);
 const evaluated = active.map(p => stockAlert(p, byConfig.get(p.id), byHistory.get(p.id)));
 // Public warehouse proposals and dashboard alerts share one evaluated forecast.
 // Keep the standalone legacy reorderProposal export compatible; do not use it here.
 const proposals = evaluated.map(p => {
  const config = byConfig.get(p.product_id) || {};
  const basis = p.projection_basis === 'max_7_30'
   ? 'Son 7 ve 30 takvim gününün günlük net tüketim ortalamalarının büyüğü kullanılır; son haftada en az 3 ayrı satış günü vardır.'
   : 'Tekrarlanan yakın dönem satışları yeterli olmadığından son 30 takvim gününün günlük net tüketim ortalaması kullanılır.';
  return {...p, config_revision: config.revision || 0, notes: config.notes || '',
   min_gap_milli: p.available_milli === null ? null : Math.max(0, p.min_stock_milli - p.available_milli),
   reason: basis + ' Hedef, günlük hız × (tedarik süresi + hedef gün); minimum stok alt sınırdır. ' + p.alert_notice};
 });
 const count = reason => evaluated.filter(p => p.reason_codes.includes(reason)).length;
 const alerts = evaluated.filter(p => p.type).sort((a, b) =>
  (a.days_remaining ?? Infinity) - (b.days_remaining ?? Infinity) ||
  a.name.localeCompare(b.name, 'tr') || a.product_id.localeCompare(b.product_id));
 const coverage = {
  status: count('unknown_available') || count('incomplete_history') ? 'incomplete' : active.length ? 'limited' : 'empty',
  history_completeness: 'unverified', as_of: histories[0]?.as_of ?? null,
  windows: {current_7_from: histories[0]?.from_7 ?? null, previous_7_from: histories[0]?.from_previous_7 ?? null,
   current_30_from: histories[0]?.from_30 ?? null, through: histories[0]?.as_of ?? null},
  evaluated_products: active.length, excluded_archived_products: stock.length - active.length, alert_count: alerts.length,
  unknown_available_products: count('unknown_available'), incomplete_history_products: count('incomplete_history'),
  no_history_products: count('no_history'), short_history_products: count('short_history'), sparse_activity_products: count('sparse_activity'),
  no_recent_demand_products: count('no_recent_demand'), unknown_supplier_products: count('unknown_supplier'), unknown_lead_products: count('unknown_lead'),
  unmapped_shipment_count: histories[0]?.unmapped_shipment_count ?? 0
 };
 const notices = [
  {code: 'recorded_history_only', message: 'Tahmin yalnız kayıtlı fiziksel satış çıkışlarına dayanır; aktarım kapsamının tam olduğu doğrulanamaz. Satışsız gün, kesin olarak talep yok demek değildir.'},
  {code: 'projection_method', message: 'En az 7 günlük geçmiş ve son 7 günde en az 3 ayrı satış günü varsa günlük hız 7 ve 30 günlük ortalamaların büyüğüdür; aksi halde 30 günlük ortalama kullanılır. Günler takvim günüdür.'}
 ];
 for (const [code, message] of [
  ['unknown_available', 'Bazı ürünlerin kullanılabilir stoğu bilinmiyor; stok sayımını kontrol edin.'],
  ['incomplete_history', 'Sevk / stok hareketi bağlantısı eksik veya tarih tutarsız; ilgili ürünlerin gün ve sipariş miktarı tahmini gösterilmez.'],
  ['no_history', 'Bazı ürünlerde geçerli satış geçmişi yok; sıfır talep sonucu çıkarılamaz.'],
  ['short_history', 'Bazı ürünlerde ilk kayıtlı satış 30 günden yeni; günlük ortalamalar yine tam 7 / 30 güne bölünür ve düşük kalabilir.'],
  ['sparse_activity', 'Az sayıda satış günü olan ürünlerde düzenli hız doğrulanamadı.'],
  ['unknown_supplier', 'Bazı ürünlerin etkin tedarikçi bağlantısı yok; arşivli kayıt veya marka adı sipariş kaynağı olarak kabul edilmez.'],
  ['unknown_lead', 'Tedarik süresi eksik ürünlerde 7 gün ve minimum stok eşiğiyle uyarı verilir; kesin sipariş miktarı için depo ayarlarını tamamlayın.']
 ]) if (count(code)) notices.push({code, message, product_count: count(code)});
 if (!active.length) notices.push({code: 'no_active_products', message: 'Değerlendirilecek aktif stok kartı yok.'});
 const notice = notices.map(n => n.message).join(' ');
 return {proposals, alerts, coverage: {...coverage, notice}, notices, notice};
}
