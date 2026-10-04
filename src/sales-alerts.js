// Read-only recurrence analysis of authoritative performanceReport.sales_items.
// Money is signed integer kurus. Never derive a new profit or a target selling price here.
const WINDOW_DAYS = 30, SAMPLE_LIMIT = 5, MIN_OCCURRENCES = 3, DAY = 86400000;
const CHANNELS = ['hepsiburada', 'trendyol'];
const integer = Number.isSafeInteger;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
  && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
const sorted = values => [...new Set(values)].sort(compare);
const identity = v => v !== null && v !== undefined && String(v).trim() !== '' ? String(v) : null;
const orderIdentity = (r, index) => {
  const order = identity(r.order_no), id = identity(r.id);
  return JSON.stringify([r.channel, order ? 'order' : id ? 'package' : 'row', order ?? id ?? index]);
};
const hasReturn = i => !!(i.has_returns || i.partial_return || i.return_packages > 0 || i.partial_returns > 0);
const hasDelivery = i => !!(i.failed_delivery || i.failed_delivery_packages > 0);
const mapped = i => typeof i.key === 'string' && i.key.startsWith('offering:v1:') && Array.isArray(i.components)
  && i.components.length > 0 && ['single', 'multipack', 'bundle'].includes(i.kind);
const sum = values => {
  if (!values.every(integer)) return null;
  const value = values.reduce((n, v) => n + BigInt(v), 0n);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : null;
};
// Stable comparison makes duplicate detection independent of object field order.
const signature = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort(compare).map(k => [k, v[k]])) : v);
const costVatEstimate = r => !!r.cost_vat_estimated || integer(r.financial_parts?.cost?.total_cents)
  && r.financial_parts.cost.total_cents !== 0 && r.cost_gross_basis !== 'historical_purchase_vat';
function evidence(r) {
  const reasons = [];
  if (costVatEstimate(r)) reasons.push('cost_vat_estimated');
  if (r.withholding_estimated) reasons.push('withholding_estimated');
  if (r.fees_from_history) reasons.push('fees_from_history');
  if (r.assumptions_source) reasons.push('assumptions_source');
  if (r.cost_estimated) reasons.push('cost_estimated');
  const estimatedFees = ['commission', 'shipping', 'other'].some(k => r.financial_parts?.[k]?.estimated || r.financial_parts?.[k]?.estimated_cents);
  const unexplainedOffering = r.sales_items?.some(i => i?.estimated > 0) && !reasons.length && !r.fees_estimated;
  if (estimatedFees || r.fees_estimated && !r.withholding_estimated && !r.fees_from_history) reasons.push('fees_estimated');
  if (unexplainedOffering) reasons.push('offering_estimated');
  const insufficient = !!(estimatedFees || unexplainedOffering || r.fees_from_history || r.assumptions_source || r.cost_estimated || r.fees_estimated && !r.withholding_estimated);
  return {reasons, insufficient, estimated: reasons.length > 0};
}

/** Pure; today is an explicit YYYY-MM-DD Istanbul calendar date supplied by the caller. */
export function salesAlerts(rows, {today, partial = false, historyPartial = false, unallocatedFeeCents = 0} = {}) {
  if (!validDay(today)) throw new TypeError('salesAlerts today must be a valid YYYY-MM-DD date');
  if (!Array.isArray(rows)) throw new TypeError('salesAlerts rows must be an array');
  const from = new Date(Date.parse(today) - (WINDOW_DAYS - 1) * DAY).toISOString().slice(0, 10), to = today;
  const coverage = {complete: false, history_partial: !!historyPartial, packages: 0, orders: 0, offerings: 0, unknown_orders: 0, ineligible_orders: 0, excluded_price_orders: 0,
    unknown_packages: 0, unmapped_packages: 0, insufficient_evidence_packages: 0, estimated_packages: 0,
    excluded_price_packages: 0, return_packages: 0, failed_delivery_packages: 0, technical_correction_packages: 0,
    duplicate_packages: 0, duplicate_items: 0, ambiguous_packages: 0, unsafe_packages: 0, unsafe_totals: 0,
    invalid_date_packages: 0, invalid_identity_packages: 0, unsupported_channel_packages: 0,
    outside_window_packages: 0, historical_sibling_packages: 0, future_customer_return_packages: 0, pending_packages: 0, unknown_recent_orders: 0, ambiguous_exception_windows: 0,
    price_blocked_offerings: 0, price_evaluable_offerings: 0, insufficient_orders_offerings: 0, ambiguous_ordering_offerings: 0,
    price_blocked_channels: []};
  const priceBlocked = [];
  if (partial) priceBlocked.push('partial_read');
  if (historyPartial) priceBlocked.push('historical_read_failure');
  if (!integer(unallocatedFeeCents)) priceBlocked.push('invalid_unallocated_fees');
  else if (unallocatedFeeCents !== 0) priceBlocked.push('unallocated_fees');
  const blockedChannels = new Set(), packages = new Map(), orderDates = new Map();
  // Select orders by their latest eligible result, then retain all loaded historical siblings.
  // Filtering individual packages first could turn a recovered order into a fabricated loss.
  for (const [index, r] of rows.entries()) {
    if (!r || !CHANNELS.includes(r.channel)) continue;
    const failed = !!r.teslim_edilemedi || r.sales_items?.some(hasDelivery);
    if (r.status && r.status !== 'delivered' && !failed) continue;
    const date = r.delivered_on || r.occurred_on;
    if (!validDay(date) || date > to) continue;
    const key = orderIdentity(r, index);
    if (!orderDates.has(key) || date > orderDates.get(key)) orderDates.set(key, date);
  }
  // Deduplicate package replays before order aggregation. Conflicting replays are unknown evidence.
  for (const [index, r] of rows.entries()) {
    if (!r || !CHANNELS.includes(r.channel)) { coverage.unsupported_channel_packages++; continue; }
    const items = Array.isArray(r.sales_items) ? r.sales_items : [];
    const failed = !!r.teslim_edilemedi || items.some(hasDelivery);
    if (r.status && r.status !== 'delivered' && !failed) { coverage.pending_packages++; continue; }
    const date = r.delivered_on || r.occurred_on;
    if (!validDay(date)) { coverage.invalid_date_packages++; blockedChannels.add(r.channel); continue; }
    if (date > to || orderDates.get(orderIdentity(r, index)) < from) { coverage.outside_window_packages++; continue; }
    const id = identity(r.id), key = JSON.stringify([r.channel, id ? 'package' : 'row', id ?? index]);
    const previous = packages.get(key), sig = signature(r);
    if (previous) {
      coverage.duplicate_packages++;
      if (previous.signature !== sig) { previous.ambiguous = true; blockedChannels.add(r.channel); }
    } else packages.set(key, {r, id, date, signature: sig, ambiguous: false, index});
  }
  const groups = new Map(), orderIds = new Set(), orderChannels = new Map();
  const unknownOrders = new Set(), ineligibleOrders = new Set(), excludedOrders = new Set(), unknownRecentOrders = new Set();
  const entries = [...packages.values()].sort((a, b) => compare(b.date, a.date) || compare(a.r.channel, b.r.channel) || compare(a.id, b.id));
  for (const p of entries) {
    const {r, id} = p, provenance = evidence(r);
    const orderNo = identity(r.order_no), orderKey = orderIdentity(r, p.index), date = orderDates.get(orderKey);
    if (p.date < from) coverage.historical_sibling_packages++;
    coverage.packages++; orderIds.add(orderKey); orderChannels.set(orderKey, r.channel);
    if (!id) { coverage.invalid_identity_packages++; blockedChannels.add(r.channel); }
    const items = []; let itemAmbiguous = false;
    const lineIds = new Map();
    for (const item of Array.isArray(r.sales_items) ? r.sales_items : []) {
      if (!item || typeof item !== 'object') { itemAmbiguous = true; continue; }
      const ids = sorted((item.line_ids || []).map(identity).filter(Boolean));
      const seen = ids.map(line => lineIds.get(line)).filter(Boolean), sig = signature(item);
      if (seen.length) {
        if (seen.length === ids.length && seen.every(s => s === sig)) { coverage.duplicate_items++; continue; }
        itemAmbiguous = true;
      }
      ids.forEach(line => lineIds.set(line, sig)); items.push(item);
    }
    const futureReturn = !!r.future_customer_return || validDay(r.latest_customer_return_on) && r.latest_customer_return_on > today;
    const failed = !futureReturn && (!!r.teslim_edilemedi || items.some(hasDelivery));
    const returned = !futureReturn && !failed && items.some(hasReturn);
    const technical = !!r.technical_correction || items.some(i => i.technical_correction);
    const excluded = failed || returned || technical;
    const ambiguous = p.ambiguous || itemAmbiguous;
    const unmapped = !items.length || items.some(i => !mapped(i));
    const cashUnknown = futureReturn || !integer(r.cash_cents) || !!r.missing?.length || items.some(i => !integer(i.cash_cents) || i.missing > 0);
    const unknown = cashUnknown || !excluded && items.some(i => !integer(i.units_milli) || i.units_milli <= 0)
      || !technical && items.some(i => (failed || hasReturn(i)) && !integer(i.return_cash_cents));
    const unsafe = [r.cash_cents, ...items.flatMap(i => [i.cash_cents, i.return_cash_cents, i.units_milli])]
      .some(v => v !== null && v !== undefined && !integer(v));
    if (unmapped || ambiguous) blockedChannels.add(r.channel);
    const unknownPackage = unknown || unmapped || ambiguous || unsafe || !id;
    if (unknownPackage) unknownOrders.add(orderKey);
    if (unknownPackage || provenance.insufficient) ineligibleOrders.add(orderKey);
    if (excluded) excludedOrders.add(orderKey);
    for (const [key, condition] of [['unknown_packages', unknownPackage], ['unmapped_packages', unmapped],
      ['insufficient_evidence_packages', provenance.insufficient], ['estimated_packages', provenance.estimated],
      ['excluded_price_packages', excluded], ['return_packages', returned], ['failed_delivery_packages', failed],
      ['technical_correction_packages', technical], ['future_customer_return_packages', futureReturn], ['ambiguous_packages', ambiguous], ['unsafe_packages', unsafe]]) {
      if (condition) coverage[key]++;
    }
    for (const item of items.filter(mapped)) {
      const key = JSON.stringify([r.channel, item.key]);
      if (!groups.has(key)) groups.set(key, {channel: r.channel, key: item.key, name: item.name, kind: item.kind,
        components: item.components.map(c => ({...c})), orders: new Map()});
      const group = groups.get(key);
      if (!group.orders.has(orderKey)) group.orders.set(orderKey, {key: orderKey, order_no: orderNo, date, package_ids: new Set(),
        cash: [], units: [], returns_cash: [], delivery_cash: [], returns: false, delivery: false,
        excluded: false, technical: false, future_return: false, unknown: false, insufficient: false, estimated: false, reasons: new Set()});
      const order = group.orders.get(orderKey);
      if (date > order.date) order.date = date;
      if (id) order.package_ids.add(id);
      order.cash.push(cashUnknown || ambiguous ? null : item.cash_cents);
      order.units.push(item.units_milli);
      const delivery = failed && !technical && !ambiguous, returns = !delivery && !technical && !ambiguous && !futureReturn && hasReturn(item);
      if (returns) order.returns_cash.push(item.return_cash_cents);
      if (delivery) order.delivery_cash.push(item.return_cash_cents);
      order.returns ||= returns; order.delivery ||= delivery;
      order.excluded ||= excluded; order.technical ||= technical; order.future_return ||= futureReturn;
      if (futureReturn) order.reasons.add('future_customer_return');
      order.unknown ||= unknown || ambiguous || unsafe;
      order.insufficient ||= provenance.insufficient;
      order.estimated ||= provenance.estimated;
      provenance.reasons.forEach(reason => order.reasons.add(reason));
    }
  }
  coverage.orders = orderIds.size; coverage.offerings = groups.size;
  coverage.price_blocked_channels = sorted(blockedChannels);
  const alerts = [];
  const safeTotal = values => {
    const total = sum(values);
    if (total === null && values.every(integer)) coverage.unsafe_totals++;
    return total;
  };
  function alert(group, type, recent, matching, net, loss) {
    const reasons = new Set(recent.flatMap(o => [...o.reasons]));
    reasons.add(type === 'price' ? 'recurring_loss' : type === 'returns' ? 'recurring_returns' : 'recurring_failed_delivery');
    if (type === 'price') { reasons.add('latest_order_loss'); reasons.add('negative_recent_net'); }
    if (recent.some(o => o.cash_cents === null)) reasons.add('unknown_result');
    if (recent.some(o => o.insufficient)) reasons.add('insufficient_evidence');
    if (net === null || loss === null) reasons.add('incomplete_amounts');
    priceBlocked.forEach(reason => reasons.add(reason));
    return {id: 'sales-alert:v1:' + JSON.stringify([type, group.channel, group.key]), type,
      channel: group.channel, key: group.key, name: group.name, kind: group.kind, components: group.components,
      from, to, orders: recent.length, occurrences: matching.length, loss_cents: loss, net_cents: net,
      estimated: recent.some(o => o.estimated), reason_codes: sorted(reasons),
      samples: recent.map(o => ({order_no: o.order_no, package_ids: sorted(o.package_ids), date: o.date,
        cash_cents: o.cash_cents, units_milli: o.units_milli,
        kind: type === 'returns' && o.returns ? 'returns' : o.delivery ? 'delivery' : o.returns ? 'returns' : 'sale'})),
      package_ids: sorted(recent.flatMap(o => [...o.package_ids]))};
  }
  for (const group of [...groups.values()].sort((a, b) => compare(a.channel, b.channel) || compare(a.key, b.key))) {
    const orders = [...group.orders.values()].map(o => {
      const cash = safeTotal(o.cash), units = safeTotal(o.units);
      if (cash === null || !o.excluded && (units === null || units <= 0)) { unknownOrders.add(o.key); ineligibleOrders.add(o.key); }
      return {...o, cash_cents: cash, units_milli: units, returns: o.returns && !o.future_return, delivery: o.delivery && !o.future_return};
    })
      .sort((a, b) => compare(b.date, a.date) || compare(a.key, b.key));
    // Package-wide exclusion prevents a returned companion item distorting shared shipping.
    // Unknown clean orders must remain in this window; filtering them out would resurrect stale losses.
    const allClean = orders.filter(o => !o.excluded || o.future_return), clean = allClean.slice(0, SAMPLE_LIMIT);
    // Result dates have day precision, not a trustworthy intra-day sequence. Look through the
    // entire cutoff day before choosing a bounded display sample; an ID must not hide uncertainty.
    const candidates = allClean.filter(o => o.date >= clean.at(-1)?.date);
    const unknownRecent = candidates.filter(o => o.unknown || !integer(o.cash_cents) || !integer(o.units_milli) || o.units_milli <= 0);
    const boundary = candidates.filter(o => o.date === clean.at(-1)?.date);
    const boundaryMixed = candidates.length > SAMPLE_LIMIT && new Set(boundary.map(o =>
      signature([o.cash_cents, o.unknown, o.insufficient, o.estimated, sorted(o.reasons)]))).size > 1;
    const latestDay = candidates.filter(o => o.date === clean[0]?.date);
    const latestMixed = latestDay.some(o => integer(o.cash_cents) && o.cash_cents < 0)
      && latestDay.some(o => !integer(o.cash_cents) || o.cash_cents >= 0 || o.unknown || o.insufficient);
    const ambiguousOrdering = boundaryMixed || latestMixed;
    if (ambiguousOrdering) coverage.ambiguous_ordering_offerings++;
    unknownRecent.forEach(o => unknownRecentOrders.add(o.key));
    const net = safeTotal(clean.map(o => o.cash_cents));
    const losing = clean.filter(o => integer(o.cash_cents) && o.cash_cents < 0);
    const loss = safeTotal(losing.map(o => o.cash_cents));
    const blocked = priceBlocked.length || blockedChannels.has(group.channel) || unknownRecent.length
      || candidates.some(o => o.insufficient) || ambiguousOrdering || net === null || loss === null;
    if (blocked) { coverage.price_blocked_offerings++; candidates.forEach(o => ineligibleOrders.add(o.key)); }
    else if (clean.length < MIN_OCCURRENCES) coverage.insufficient_orders_offerings++;
    else coverage.price_evaluable_offerings++;
    if (!blocked && losing.length >= MIN_OCCURRENCES && clean[0].cash_cents < 0 && net < 0)
      alerts.push(alert(group, 'price', clean, losing, net, loss));
    // Normal orders remain in the exception denominator. Technical corrections are not customer events.
    const allEvents = orders.filter(o => !o.technical || o.future_return), recent = allEvents.slice(0, SAMPLE_LIMIT);
    const eventCandidates = allEvents.filter(o => o.date >= recent.at(-1)?.date);
    const eventBoundary = eventCandidates.filter(o => o.date === recent.at(-1)?.date);
    for (const type of ['returns', 'delivery']) {
      if (eventCandidates.length > SAMPLE_LIMIT && eventCandidates.filter(o => o[type]).length >= MIN_OCCURRENCES
        && eventBoundary.some(o => o[type]) && eventBoundary.some(o => !o[type])) {
        coverage.ambiguous_exception_windows++;
        eventCandidates.forEach(o => ineligibleOrders.add(o.key));
        continue;
      }
      const matching = recent.filter(o => o[type]);
      if (matching.length < MIN_OCCURRENCES) continue;
      const effects = matching.map(o => safeTotal(o[type + '_cash']));
      const loss = safeTotal(effects.map(v => integer(v) ? Math.min(0, v) : null));
      const net = safeTotal(recent.map(o => o.cash_cents));
      if (net === null || loss === null) recent.forEach(o => ineligibleOrders.add(o.key));
      alerts.push(alert(group, type, recent, matching, net, loss));
    }
  }
  for (const key of orderIds) if (priceBlocked.length || blockedChannels.has(orderChannels.get(key))) ineligibleOrders.add(key);
  coverage.unknown_orders = unknownOrders.size; coverage.ineligible_orders = ineligibleOrders.size;
  coverage.excluded_price_orders = excludedOrders.size; coverage.unknown_recent_orders = unknownRecentOrders.size;
  coverage.complete = !coverage.ambiguous_exception_windows && !coverage.ambiguous_ordering_offerings && !coverage.unknown_orders && !priceBlocked.length && !coverage.unknown_packages && !coverage.unmapped_packages
    && !coverage.insufficient_evidence_packages && !coverage.ambiguous_packages && !coverage.unsafe_packages
    && !coverage.unsafe_totals && !coverage.invalid_date_packages && !coverage.invalid_identity_packages
    && !coverage.unsupported_channel_packages;
  const status = !coverage.complete ? 'incomplete' : !coverage.packages ? 'empty' : coverage.estimated_packages ? 'estimated' : 'complete';
  return {as_of: today, from, to, window_days: WINDOW_DAYS, sample_limit: SAMPLE_LIMIT, min_occurrences: MIN_OCCURRENCES,
    partial: !!partial, status, unallocated_fee_cents: integer(unallocatedFeeCents) ? unallocatedFeeCents : null,
    price_blocked_reason_codes: priceBlocked, coverage, alerts};
}