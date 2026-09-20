// Read-only offering presentation. The package result and immutable line components are authoritative.
const money = Number.isSafeInteger;
const sum = (xs, field) => xs.every(x => money(x[field])) ? xs.reduce((n, x) => n + x[field], 0) : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inc = (v, b) => money(v) && money(b) ? Math.round(v * (10000 + b) / 10000) : null;
const gcd = (a, b) => b ? gcd(b, a % b) : a;
const MONEY = ['revenue_gross_cents', 'cost_gross_cents', 'cash_cents', 'sold_cash_cents', 'return_cash_cents', 'withholding_cents'];
const NOTE = 'Stok bileşeni katkısıdır; tek başına satılan ürün kârı değildir. Kesintiler bağlı satış kayıtlarından, stopaj paket payından gelir.';

// Largest remainder, stable caller order, signed integer cents; even allocation when every weight is zero.
function allocate(total, weights) {
  if (!money(total)) return weights.map(() => null);
  if (!weights.length) return [];
  const ws = weights.some(w => w > 0) ? weights.map(w => Math.max(0, w)) : weights.map(() => 1);
  const denominator = ws.reduce((n, w) => n + BigInt(w), 0n), amount = BigInt(Math.abs(total));
  const parts = ws.map((w, i) => ({i, value: Number(amount * BigInt(w) / denominator), remainder: amount * BigInt(w) % denominator}));
  let left = Math.abs(total) - parts.reduce((n, p) => n + p.value, 0);
  for (const p of [...parts].sort((a, b) => compare(b.remainder, a.remainder) || a.i - b.i)) if (left-- > 0) p.value++;
  return parts.map(p => total < 0 ? -p.value : p.value);
}

export function offeringComposition(line, parts, names = new Map()) {
  const grouped = new Map();
  for (const c of parts) {
    const k = JSON.stringify([c.product_id, c.stock_unit]);
    const x = grouped.get(k) || {product_id: c.product_id, name: names.get(c.product_id) || c.product_id, quantity_milli: 0, stock_unit: c.stock_unit};
    x.quantity_milli += c.quantity_milli; grouped.set(k, x);
  }
  const components = [...grouped.values()].sort((a, b) => compare(a.product_id, b.product_id) || compare(a.stock_unit, b.stock_unit));
  const identity = components.map(c => {
    const n = c.quantity_milli * 1000, d = line.quantity_milli, g = gcd(n, d);
    c.quantity_milli = n / d;
    return [c.product_id, n / g, d / g, c.stock_unit];
  });
  const kind = components.length > 1 ? 'bundle' : components[0]?.stock_unit === 'adet' && components[0].quantity_milli > 1000 ? 'multipack' : 'single';
  return {key: components.length ? 'offering:v1:' + JSON.stringify(identity) : 'unmapped:v1:' + line.id,
    name: components.map(c => (c.quantity_milli === 1000 ? '' : (c.quantity_milli / 1000).toLocaleString('tr-TR') + ' × ') + c.name + (c.stock_unit === 'adet' ? '' : ' (' + c.stock_unit + ')')).join(' + ') || line.name || 'Eşlenmemiş satış satırı',
    kind, components};
}

export function buildSalesPresentation(row, lines, parts, entries, {names = new Map(), feeVat, pending = false, componentCost = () => null, lineQuotes = []} = {}) {
  const sorted = [...lines].sort((a, b) => compare(a.id, b.id));
  const items = [], pieces = [];
  for (const line of sorted) {
    const cs = parts.filter(c => c.line_id === line.id).sort((a, b) => compare(a.id, b.id));
    const item = {...offeringComposition(line, cs, names), line_ids: [line.id], sold_units_milli: line.quantity_milli,
      returned_units_milli: 0, units_milli: line.quantity_milli, partial_return: false, component_returns: [],
      failed_delivery: !!row.teslim_edilemedi, has_returns: false, allocation_note: 'Tarihsel sipariş satırı bileşimi; nakit, bağlı satış ve iade kayıtları ile paket stopaj payından oluşur.'};
    const ratios = [];
    for (const c of cs) {
      const es = c.sale_id ? entries.filter(e => e.id === c.sale_id || e.parent_id === c.sale_id) : [];
      const returned = es.filter(e => e.kind === 'return' && !String(e.external_id || '').startsWith('DUZELTME-CIFT-')).reduce((n, e) => n + e.quantity_milli, 0);
      const corrected = es.filter(e => e.kind === 'return' && String(e.external_id || '').startsWith('DUZELTME-CIFT-')).reduce((n, e) => n + e.quantity_milli, 0);
      item.technical_correction ||= corrected > 0;
      ratios.push({n: returned + corrected, d: c.quantity_milli});
      if (returned) item.component_returns.push({product_id: c.product_id, stock_unit: c.stock_unit, quantity_milli: returned});
      const x = {id: c.id, item, product_id: c.product_id, qty_milli: c.quantity_milli - returned - corrected,
        revenue_gross_cents: null, cost_gross_cents: null, cash_cents: null, return_cash_cents: null};
      if (es.length && !pending) {
        const values = es.map(e => {
          const revenue = inc(e.revenue_cents, e.satir_kdv ?? line.vat_bps ?? e.vat_bps), cost = inc(e.cost_cents, e.vat_bps);
          const fees = ['commission_cents', 'shipping_cents', 'other_cents'].map(k => inc(e[k], feeVat));
          return {kind: e.kind, revenue_gross_cents: revenue, cost_gross_cents: cost,
            cash_cents: money(revenue) && money(cost) && fees.every(money) ? revenue - cost - fees.reduce((n, v) => n + v, 0) : null};
        });
        x.revenue_gross_cents = sum(values, 'revenue_gross_cents'); x.cost_gross_cents = sum(values, 'cost_gross_cents');
        x.cash_cents = sum(values, 'cash_cents'); x.return_cash_cents = sum(values.filter(v => v.kind === 'return'), 'cash_cents');
      } else if (pending) {
        const own = es.filter(e => e.kind === 'sale');
        x.revenue_weight = own.length ? sum(own, 'revenue_cents') : c.revenue_share_bps;
        x.cost_gross_cents = own.length ? sum(own.map(e => ({v: inc(e.cost_cents, e.vat_bps)})), 'v') : inc(componentCost(c), c.urun_kdv ?? line.vat_bps);
        x.return_cash_cents = 0;
      }
      pieces.push(x);
    }
    // No fractional complete sets: proportional returns must also represent whole offerings.
    const first = ratios[0], proportional = first && ratios.every(r => r.n * first.d === first.n * r.d);
    const returnedUnits = proportional ? line.quantity_milli * first.n / first.d : null;
    item.has_returns = item.component_returns.length > 0;
    if (item.has_returns || item.technical_correction) {
      const whole = money(returnedUnits) && (returnedUnits === line.quantity_milli || returnedUnits % 1000 === 0);
      item.returned_units_milli = whole ? returnedUnits : null;
      item.units_milli = whole ? line.quantity_milli - returnedUnits : null;
      item.partial_return = !whole || returnedUnits > 0 && returnedUnits < line.quantity_milli;
    }
    items.push(item);
  }
  if (pending) {
    const quotes = new Map(lineQuotes.map(q => [q.id, q]));
    const groups = sorted.map((line, i) => {
      const quote = quotes.get(line.id);
      return {pieces: pieces.filter(p => p.item === items[i]),
        gross_cents: quote?.price_cents ?? line.gross_cents ?? inc(line.net_revenue_cents, line.vat_bps),
        fixed_cents: !lineQuotes.length ? 0 : money(quote?.commission_gross_cents) && money(quote?.withholding_cents)
          ? quote.commission_gross_cents + quote.withholding_cents : null,
        withholding_cents: quote?.withholding_cents};
    });
    // Reconcile parcel VAT rounding between lines first. Component rounding stays inside its own line.
    const lineRevenue = allocate(row.revenue_gross_cents, groups.map(g => Math.max(0, g.gross_cents ?? 0)));
    groups.forEach((g, i) => {
      g.weights = g.pieces.map(p => Math.max(0, p.revenue_weight ?? 0));
      const shares = allocate(lineRevenue[i], g.weights);
      g.pieces.forEach((p, j) => { p.revenue_gross_cents = shares[j]; });
    });
    const costs = allocate(row.cost_gross_cents, pieces.map(p => Math.max(0, p.cost_gross_cents ?? 0)));
    pieces.forEach((p, i) => { p.cost_gross_cents = costs[i]; });
    const cost = sum(pieces, 'cost_gross_cents'), revenue = sum(pieces, 'revenue_gross_cents'), fixed = sum(groups, 'fixed_cents');
    const weights = lineRevenue.map(v => Math.max(0, v ?? 0));
    // Tariff commissions/withholding belong to their listing; only the remaining parcel costs are shared.
    const shared = allocate([row.cash_cents, cost, revenue, fixed].every(money) ? revenue - cost - row.cash_cents - fixed : null, weights);
    const withholding = allocate(row.withholding_cents, lineQuotes.length ? groups.map(g => g.withholding_cents ?? 0) : weights);
    groups.forEach((g, i) => {
      const deductions = allocate(money(shared[i]) && money(g.fixed_cents) ? shared[i] + g.fixed_cents : null, g.weights);
      const shares = allocate(withholding[i], g.weights);
      g.pieces.forEach((p, j) => {
        p.cash_cents = money(deductions[j]) ? p.revenue_gross_cents - p.cost_gross_cents - deductions[j] : null;
        p.withholding_cents = shares[j];
      });
    });
  } else {
    // Preserve the legacy component totals, including their product-level withholding rounding.
    const products = [...new Set(entries.map(e => e.product_id))];
    const productRevenue = products.map(id => pieces.filter(p => p.product_id === id).reduce((n, p) => n + (p.revenue_gross_cents ?? 0), 0));
    const denominator = productRevenue.reduce((n, v) => n + Math.max(0, v), 0) || 1;
    let remaining = row.withholding_cents;
    products.forEach((id, i) => {
      const amount = !money(remaining) ? null : i === products.length - 1 ? remaining : Math.round(-row.withholding_cents * Math.max(0, productRevenue[i]) / denominator) * -1;
      if (money(amount)) remaining -= amount;
      const ps = pieces.filter(p => p.product_id === id), shares = allocate(amount, ps.map(p => Math.max(0, p.revenue_gross_cents ?? 0)));
      ps.forEach((p, j) => { p.withholding_cents = shares[j]; p.cash_cents = money(p.cash_cents) && money(shares[j]) ? p.cash_cents + shares[j] : null; });
    });
  }
  for (const item of items) {
    const ps = pieces.filter(p => p.item === item), fullyReturned = item.units_milli === 0 && (item.has_returns || item.technical_correction);
    for (const p of ps) {
      // A failed/full return's residual expense belongs wholly to returns, even with zero net quantity.
      if (!money(row.cash_cents)) p.cash_cents = p.return_cash_cents = null;
      if (fullyReturned) p.return_cash_cents = p.cash_cents;
      p.sold_cash_cents = money(p.cash_cents) && money(p.return_cash_cents) ? p.cash_cents - p.return_cash_cents : null;
      for (const field of ['revenue_gross_cents', 'cost_gross_cents', 'withholding_cents']) if (!money(row[field])) p[field] = null;
    }
    for (const field of MONEY) item[field] = ps.length ? sum(ps, field) : null;
  }
  // One package may contain multiple lines with the same offering; retain historical line IDs.
  row.sales_items = aggregateSales([{...row, sales_items: items}], {limit: 5}).rows;
  row.urunler_role = 'stock_component_contribution';
  for (const u of row.urunler || row.urunler_eksik || []) {
    const ps = pieces.filter(p => p.product_id === u.product_id);
    u.role = 'stock_component_contribution'; u.allocation_note = NOTE;
    for (const kind of ['single', 'multipack', 'bundle']) u[kind + '_cash_cents'] = sum(ps.filter(p => p.item.kind === kind), 'sold_cash_cents');
    u.return_cash_cents = sum(ps, 'return_cash_cents');
    // Existing pending component allocations remain authoritative for the legacy view.
    if (pending && money(u.cash_cents)) {
      const buckets = ['single', 'multipack', 'bundle'];
      const base = buckets.map(k => sum(ps.filter(p => p.item.kind === k), 'sold_cash_cents'));
      const revenues = buckets.map(k => ps.filter(p => p.item.kind === k).reduce((n, p) => n + Math.max(0, p.revenue_gross_cents ?? 0), 0));
      const weights = revenues.some(v => v > 0) ? revenues : buckets.map(k => ps.filter(p => p.item.kind === k).length);
      const shares = allocate(u.cash_cents - base.reduce((n, v) => n + v, 0), weights);
      buckets.forEach((k, i) => { u[k + '_cash_cents'] = base[i] + shares[i]; }); u.return_cash_cents = 0;
    }
  }
  return row.sales_items;
}

export function aggregateSales(packages, {limit = 5, channel = null, from = null, to = null} = {}) {
  const selected = packages.filter(p => (!channel || p.channel === channel) && (!from || (p.delivered_on || p.occurred_on) >= from) && (!to || (p.delivered_on || p.occurred_on) <= to)).sort((a, b) => compare(a.id, b.id));
  const map = new Map();
  for (const p of selected) for (const item of p.sales_items || []) {
    let x = map.get(item.key);
    if (!x) { x = {...item, units_milli: 0, sold_units_milli: 0, returned_units_milli: 0, component_returns: [],
      line_ids: [], package_ids: [], packages: 0, estimated: 0, missing: 0, partial_returns: 0, return_packages: 0, failed_delivery_packages: 0,
      calculated_cash_cents: 0, calculated: 0, return_package_ids: [], failed_delivery_package_ids: [], partial_return: false, has_returns: false, failed_delivery: false, technical_correction: false};
      for (const k of MONEY) x[k] = 0; map.set(item.key, x); }
    const fresh = !x.package_ids.includes(p.id);
    if (fresh) {
      x.package_ids.push(p.id); x.packages++;
      if (p.fees_estimated || p.cost_estimated || p.assumptions_source) x.estimated++;
    }
    for (const k of [...MONEY, 'units_milli', 'sold_units_milli', 'returned_units_milli']) x[k] = money(x[k]) && money(item[k]) ? x[k] + item[k] : null;
    x.calculated_cash_cents += money(item.cash_cents) ? item.cash_cents : 0;
    if (money(item.cash_cents)) x.calculated++;
    if (!money(item.cash_cents)) x.missing++;
    if (item.partial_return) x.partial_returns++;
    if (item.has_returns && !x.return_package_ids.includes(p.id)) x.return_package_ids.push(p.id);
    x.return_packages = x.return_package_ids.length;
    if (item.failed_delivery && !x.failed_delivery_package_ids.includes(p.id)) x.failed_delivery_package_ids.push(p.id);
    x.failed_delivery_packages = x.failed_delivery_package_ids.length;
    for (const k of ['partial_return', 'has_returns', 'failed_delivery', 'technical_correction']) x[k] ||= !!item[k];
    x.line_ids.push(...(item.line_ids || []));
    for (const c of item.component_returns || []) {
      const found = x.component_returns.find(a => a.product_id === c.product_id && a.stock_unit === c.stock_unit);
      if (found) found.quantity_milli += c.quantity_milli; else x.component_returns.push({...c});
    }
  }
  const rows = [...map.values()].sort((a, b) => compare(a.key, b.key));
  for (const x of rows) {
    x.line_ids.sort(compare); x.package_ids.sort(compare); x.return_package_ids.sort(compare); x.failed_delivery_package_ids.sort(compare);
    x.component_returns.sort((a, b) => compare(a.product_id, b.product_id) || compare(a.stock_unit, b.stock_unit));
    if (!x.calculated && x.missing) x.calculated_cash_cents = null;
    x.per_unit_cents = money(x.cash_cents) && x.units_milli > 0 && !x.partial_return ? Math.round(x.cash_cents * 1000 / x.units_milli) : null;
  }
  const ranked = rows.filter(x => money(x.cash_cents));
  const top = [...ranked].sort((a, b) => b.cash_cents - a.cash_cents || compare(a.key, b.key)).slice(0, limit);
  const bottom = [...ranked].sort((a, b) => a.cash_cents - b.cash_cents || compare(a.key, b.key)).slice(0, limit);
  const revenue_top = rows.filter(x => money(x.revenue_gross_cents)).sort((a, b) => b.revenue_gross_cents - a.revenue_gross_cents || compare(a.key, b.key)).slice(0, limit);
  return {rows, top, bottom, revenue_top, count: rows.length,
    return_packages: selected.filter(p => p.sales_items?.some(i => i.has_returns)).length,
    failed_delivery_packages: selected.filter(p => p.teslim_edilemedi).length,
    return_cash_cents: sum(rows, 'return_cash_cents'), missing_packages: selected.filter(p => !Array.isArray(p.sales_items) || p.sales_items.some(i => !money(i.cash_cents))).length};
}

export function pendingSalesSummary(rows) {
  if (!Array.isArray(rows)) {
    const unknown = () => ({packages: null, calculated: null, missing: null, cash_cents: null, calculated_cash_cents: null, revenue_gross_cents: null});
    return {preparing: unknown(), shipped: unknown()};
  }
  const summarize = list => {
    const known = list.filter(r => money(r.cash_cents));
    return {packages: list.length, calculated: known.length, missing: list.length - known.length,
      cash_cents: sum(list, 'cash_cents'), calculated_cash_cents: known.length || !list.length ? sum(known, 'cash_cents') : null,
      revenue_gross_cents: sum(list, 'revenue_gross_cents')};
  };
  return {preparing: summarize(rows.filter(r => ['draft', 'reserved'].includes(r.status))), shipped: summarize(rows.filter(r => r.status === 'shipped'))};
}

// Mutually exclusive package counts; amounts are signed return effects, not absolute expenses.
export function salesReturnSummary(rows) {
  const failed = rows.filter(r => r.teslim_edilemedi);
  const returned = rows.filter(r => !r.teslim_edilemedi && r.sales_items?.some(i => i.has_returns));
  const cash = list => sum(list.map(r => ({cash_cents: Array.isArray(r.sales_items) && r.sales_items.length ? sum(r.sales_items, 'return_cash_cents') : null})), 'cash_cents');
  return {failed_count: failed.length, returned_count: returned.length,
    failed_cash_cents: cash(failed), returned_cash_cents: cash(returned)};
}
