// Web mağaza siparişi ↔ e-ticaret stok ve satış defteri — CANLI GEÇİŞ YOLU.
//
// Paralel muhasebe yok. Pazaryeri sevkiyatıyla (src/orders-api.js, action 'ship') aynı desen:
//   · gelir KDV HARİÇ nettir; set bileşenlerine revenue_share_bps oranında, kuruş kaybı olmadan bölünür
//   · maliyet ec_stock_balances ortalamasından okunur; stok çıkışını ec_sale_stock tetiği yazar
//   · komisyon/kargo/diğer kesintiler bilinmediği için NULL ve fees_status='pending'
//   · sipariş ayırması aynı işlemde, satıştan ÖNCE serbest kalır (koruma tetiği çift saymasın)
//
// Test siparişleri (is_test=1) hiçbir yere yazılmaz: bu modül reddeder, veritabanı tetikleri de reddeder.
// Müşterinin ödediği kargo bedeli ürün kartına bağlanmadığı için burada deftere YAZILMAZ (açık karar).

const ledgerError = (message, status = 409) => Object.assign(new Error(message), {status});

function assertLive(order) {
  if (!order || order.is_test !== 0) throw ledgerError('Test siparişi gerçek stok ve satış defterine yazılmaz.');
}

/** Sipariş kalemlerinin eşlemesi: her kalem için bileşenler, tek KDV oranı ve geçerli gelir payları. */
// Kalemler verilmezse siparişin kayıtlı kalemleri okunur. Sipariş anında kalemler aynı işlemde
// eklendiği için ayırma, özetteki kalemlerle ({variant_id,qty,name,size}) çağrılır.
export async function itemPlan(db, orderId, givenItems) {
  const items = givenItems || (await db.prepare('SELECT id,variant_id,name,size,qty,price_cents FROM ws_order_items WHERE order_id=? ORDER BY id').bind(orderId).all()).results;
  const rows = (await db.prepare(
    'SELECT c.variant_id,c.product_id,c.quantity_milli,c.revenue_share_bps,pp.vat_bps FROM ws_variant_components c ' +
    'LEFT JOIN ec_price_profiles pp ON pp.product_id=c.product_id WHERE c.variant_id IN (SELECT value FROM json_each(?)) ORDER BY c.variant_id,c.product_id'
  ).bind(JSON.stringify([...new Set(items.map(i => i.variant_id))])).all()).results;
  return items.map(item => {
    const components = rows.filter(r => r.variant_id === item.variant_id);
    if (!components.length) throw ledgerError(`${item.name} ${item.size}: gerçek stok kartına bağlanmadı.`);
    const vats = [...new Set(components.map(c => c.vat_bps))];
    if (vats.length !== 1 || vats[0] === null || vats[0] === undefined) throw ledgerError(`${item.name} ${item.size}: bileşenlerin tek ve tanımlı bir KDV oranı olmalı.`);
    const shares = components.length === 1 ? [components[0].revenue_share_bps ?? 10000] : components.map(c => c.revenue_share_bps);
    if (shares.some(s => !Number.isInteger(s)) || shares.reduce((a, b) => a + b, 0) !== 10000)
      throw ledgerError(`${item.name} ${item.size}: set bileşenlerinin gelir payları toplamı %100 olmalı.`);
    return {item, vat_bps: vats[0], components: components.map((c, i) => ({...c, share_bps: shares[i]}))};
  });
}

/** KDV dahil brüt → KDV hariç net; pazaryeri netAmount ile aynı yuvarlama. */
export const netOf = (gross, vatBps) => Math.round(gross * 10000 / (10000 + vatBps));

/** Net geliri paylara böler; kümülatif yuvarlama sayesinde parçaların toplamı nete eşittir. */
export function splitRevenue(net, shares) {
  let share = 0, allocated = 0;
  return shares.map(s => {
    share += s;
    const cumulative = Number((BigInt(net) * BigInt(share) + 5000n) / 10000n), part = cumulative - allocated;
    allocated = cumulative;
    return part;
  });
}

/** Sipariş anında gerçek stok ayırması (canlı sipariş). Aynı karttaki kalemler birleştirilir. */
export async function reservationStatements(db, order, items) {
  assertLive(order);
  const need = new Map();
  for (const {item, components} of await itemPlan(db, order.id, items))
    for (const c of components) need.set(c.product_id, (need.get(c.product_id) || 0) + c.quantity_milli * item.qty);
  return [...need].map(([product, qty]) => db.prepare('INSERT INTO ws_stock_reservations(id,order_id,product_id,quantity_milli) VALUES(?,?,?,?)')
    .bind(crypto.randomUUID(), order.id, product, qty));
}

/** Sevkte satış kaydı: önce ayırma serbest, sonra her kalem × bileşen için satış ve bağ kaydı. */
export async function saleStatements(db, order, occurredOn) {
  assertLive(order);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn || '')) throw ledgerError('Sevk tarihi geçersiz.', 400);
  const statements = [db.prepare('UPDATE ws_stock_reservations SET released_on=CURRENT_TIMESTAMP WHERE order_id=? AND released_on IS NULL').bind(order.id)];
  for (const {item, vat_bps, components} of await itemPlan(db, order.id)) {
    const parts = splitRevenue(netOf(item.price_cents * item.qty, vat_bps), components.map(c => c.share_bps));
    components.forEach((c, i) => {
      const sale = crypto.randomUUID(), qty = c.quantity_milli * item.qty;
      statements.push(db.prepare(
        "INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on,notes) " +
        "SELECT ?,'other',?,product_id,'sale',?,?,CAST(ROUND(value_cents*?/MAX(quantity_milli,1.0)) AS INTEGER),NULL,NULL,NULL,'pending',?,? FROM ec_stock_balances WHERE product_id=?"
      ).bind(sale, 'web:' + order.number + ':' + item.id + ':' + c.product_id, qty, parts[i], qty, occurredOn, 'Web mağaza siparişi ' + order.number, c.product_id));
      statements.push(db.prepare('INSERT INTO ws_sale_links(id,order_id,order_item_id,product_id,sale_id) VALUES(?,?,?,?,?)')
        .bind(crypto.randomUUID(), order.id, item.id, c.product_id, sale));
    });
  }
  return statements;
}
