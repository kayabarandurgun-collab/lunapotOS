// FA05: tek tahsis defteri. Yalnız EC; stok/cari satırları hiçbir zaman güncellenmez.
export function provisionalClose(db, invoiceId, productId, date, reference) {
  return db.prepare(`INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
    SELECT 'provisional-close:'||p.receipt_id||':'||p.movement_id,p.product_id,-p.quantity_milli,
      -MAX(0,MIN(p.value_cents,b.value_cents-COALESCE(SUM(p.value_cents) OVER(ORDER BY p.source_date,p.source_order,p.receipt_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))),
      'purchase',p.reference,'Faturasız malın tahsisli teslimi kapandı',?
    FROM ec_provisional_closure_plan p JOIN ec_stock_balances b ON b.product_id=p.product_id
    WHERE p.invoice_id=? AND p.product_id=? AND p.receipt_reference=?
      AND NOT EXISTS(SELECT 1 FROM ec_stock_movements m WHERE m.kind='purchase' AND m.product_id=p.product_id AND m.reference=p.reference)`)
    .bind(date, invoiceId, productId, reference);
}

export async function provisionalReceipts(db, {entryIds, id, limit = 200} = {}) {
  if (entryIds && !entryIds.length) return [];
  const where = id ? 'WHERE r.id=?' : entryIds ? 'WHERE r.entry_id IN (SELECT value FROM json_each(?))' : '';
  const args = id ? [id] : entryIds ? [JSON.stringify(entryIds)] : [];
  const receipts = (await db.prepare(`SELECT r.*,e.amount_cents FROM ec_provisional_receipts r
    LEFT JOIN ec_party_entries e ON e.id=r.entry_id ${where} ORDER BY r.occurred_on DESC,r.rowid DESC LIMIT ?`).bind(...args, limit).all()).results;
  if (!receipts.length) return [];
  const lines = (await db.prepare(`SELECT v.*,p.name product_name,p.stock_unit FROM ec_provisional_line_balances v
    JOIN ec_products p ON p.id=v.product_id WHERE v.receipt_id IN (SELECT value FROM json_each(?)) ORDER BY v.receipt_order,v.id`)
    .bind(JSON.stringify(receipts.map(r => r.id))).all()).results;
  return receipts.map(r => {
    const own = lines.filter(l => l.receipt_id === r.id);
    const unknown = !own.length || own.some(l => !l.eligible);
    const status = unknown ? 'legacy_unlinked' : own.every(l => !l.remaining_to_invoice_milli) ? 'invoiced'
      : own.some(l => l.invoiced_milli > 0) ? 'partial' : 'open';
    const released = own.reduce((n, l) => n + l.released_cents, 0);
    return {...r, provisional_status: status, released_cents: unknown ? null : released,
      remaining_cents: unknown || r.amount_cents == null ? null : -r.amount_cents - released,
      notice: unknown ? 'Eski girişin stok hareketi bağı doğrulanmış değil; otomatik fatura kapanışı yapılmaz.' : null,
      lines: own.map(l => ({id: l.id, product_id: l.product_id, product_name: l.product_name, stock_unit: l.stock_unit,
        movement_id: l.movement_id, quantity_milli: l.quantity_milli,
        invoiced_milli: l.eligible ? l.invoiced_milli : null, received_milli: l.eligible ? l.received_milli : null,
        remaining_to_invoice_milli: l.eligible ? l.remaining_to_invoice_milli : null,
        remaining_to_receive_milli: l.eligible ? l.remaining_to_receive_milli : null,
        released_cents: l.eligible ? l.released_cents : null, remaining_cents: l.eligible ? l.remaining_cents : null}))};
  });
}
