// Salt okunur dashboard özeti. Tek parasal kaynak performanceReport paket satırlarıdır.
// Satış, maliyet ve kesintiler zaten KDV dahil kuruştur; burada yeniden KDV hesaplanmaz.
const safe = Number.isSafeInteger;
const CHANNELS = ['trendyol', 'hepsiburada'];
const METRICS = ['revenue', 'cost', 'commission', 'shipping', 'other', 'withholding', 'fees', 'cash'];
const FIELDS = {revenue: 'revenue_gross_cents', cost: 'cost_gross_cents', commission: 'commission_gross_cents',
  shipping: 'shipping_gross_cents', other: 'other_gross_cents', withholding: 'withholding_cents', cash: 'cash_cents'};
const sum = values => { const n = values.reduce((s, v) => s + BigInt(v), 0n); return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : null; };

function parts(row) {
  const out = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const detail = row.financial_parts?.[key], n = row[field];
    const value = safe(n) ? (key === 'withholding' ? -n : n) : safe(detail?.total_cents) ? detail.total_cents : null;
    if (value === null) { out[key] = null; continue; }
    if (detail && safe(detail.recorded_cents) && safe(detail.estimated_cents) && detail.recorded_cents + detail.estimated_cents === value) {
      out[key] = {value, recorded: detail.recorded_cents, estimatedValue: detail.estimated_cents, estimated: !!detail.estimated};
      continue;
    }
    let estimated = false, recorded = value;
    if (key === 'cost') {
      // Tarihsel alış-parti KDV kaydı mevcut değil. Profil KDV'siyle büyütülen maliyet
      // belgeden doğrulanmış sayılmaz. Net sıfır maliyet (tam stok iadesi) de sıfır kalır.
      estimated = !!row.cost_estimated || value !== 0 && row.cost_gross_basis !== 'historical_purchase_vat';
    } else if (['commission', 'shipping', 'other'].includes(key)) {
      estimated = !!(row.fees_from_history || row.assumptions_source || row.fees_estimated && !row.withholding_estimated);
    } else if (key === 'withholding') estimated = !!(row.withholding_estimated || row.assumptions_source);
    else if (key === 'cash') estimated = !!(row.fees_estimated || row.cost_estimated || row.assumptions_source || row.cost_vat_estimated || safe(row.cost_gross_cents) && row.cost_gross_cents !== 0 && row.cost_gross_basis !== 'historical_purchase_vat');
    if (estimated) recorded = 0;
    out[key] = {value, recorded, estimatedValue: value - recorded, estimated};
  }
  const fees = ['commission', 'shipping', 'other', 'withholding'].map(k => out[k]);
  out.fees = fees.every(Boolean) ? {value: sum(fees.map(f => f.value)), recorded: sum(fees.map(f => f.recorded)),
    estimatedValue: sum(fees.map(f => f.estimatedValue)), estimated: fees.some(f => f.estimated)} : null;
  return out;
}

function metrics(rows, partial) {
  const list = rows.map(parts), out = {};
  for (const key of METRICS) {
    const known = list.map(p => p[key]).filter(p => p && safe(p.value) && safe(p.recorded) && safe(p.estimatedValue));
    const knownTotal = known.length || !rows.length && !partial ? sum(known.map(p => p.value)) : null;
    const knownSplit = values => known.length || !rows.length && !partial ? sum(values) : null;
    out[key] = {total_cents: !partial && known.length === rows.length ? knownTotal : null,
      known_cents: knownTotal, known_packages: known.length, missing_packages: partial ? null : rows.length - known.length,
      estimated_packages: known.filter(p => p.estimated).length,
      recorded_cents: knownSplit(known.map(p => p.recorded)), estimated_cents: knownSplit(known.map(p => p.estimatedValue))};
  }
  const missing = list.filter(p => METRICS.some(k => !p[k] || !safe(p[k].value) || !safe(p[k].recorded) || !safe(p[k].estimatedValue))).length;
  return {packages: partial ? null : rows.length, ...out,
    coverage: {complete: !partial, read_packages: rows.length, missing_packages: partial ? null : missing,
      estimated_packages: list.filter(p => METRICS.some(k => p[k]?.estimated)).length}};
}

export function dashboardFinancials(rows, {partial = false} = {}) {
  const out = metrics(rows, partial);
  return {...out, channels: Object.fromEntries(CHANNELS.map(channel => [channel, metrics(rows.filter(r => r.channel === channel), partial)])),
    reconciliation_cents: ['revenue', 'cost', 'fees', 'cash'].every(k => safe(out[k].total_cents))
      ? sum([out.revenue.total_cents, -out.cost.total_cents, -out.fees.total_cents, -out.cash.total_cents]) : null,
    basis: {scope: 'result_packages', date: 'delivery_or_failed_return', amounts: 'vat_inclusive', cost_vat: 'current_product_vat_estimate',
      fees: 'recorded_and_estimated_marketplace_deductions', withholding: 'deduction_positive', refunds: 'net_of_returns', paid: false},
    notice: 'Teslim edilen ve teslim edilemeyip dönen paketler; sonradan işlenen iadeler düşülmüştür. Ürün maliyeti KDV dahil tahmindir: alış KDV’si ürün kartındaki güncel oranla hesaplanır, geçmiş alış faturası toplamı değildir. Kesintiler kayıt/tahmin ayrımıyla gösterilir; banka ödemesi değildir. Stopaj gider değil, nakit kesintisidir. Ortak işletme giderleri hariç.'};
}

export function dashboardFinancialDay(date, rows, {partial = false} = {}) {
  const f = metrics(rows, partial);
  return {date, revenue_cents: f.revenue.total_cents, cost_cents: f.cost.total_cents, fees_cents: f.fees.total_cents,
    cash_cents: f.cash.total_cents, packages: f.packages, missing_packages: f.coverage.missing_packages,
    estimated_packages: f.coverage.estimated_packages, partial};
}
