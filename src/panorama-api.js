import {aggregateSales, pendingSalesSummary, salesReturnSummary} from './sales-presentation.js';
// Genel durum: bütün ekonomik tutarlar performanceReport satırlarından gelir.
// Stok değeri ayrı bir GÜNCEL defter bakiyesidir; tarih filtresinden etkilenmez.
import {tumSatirlar, ilkSonucTarihi} from './performance-api.js';
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const DAY = 86400000;
const shift = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const KANALLAR = ['trendyol', 'hepsiburada'];
const DONEMLER = [['1g', 'Bugün', 1], ['7g', 'Son 1 hafta', 7], ['14g', 'Son 2 hafta', 14], ['30g', 'Son 1 ay', 30], ['90g', 'Son 3 ay', 90], ['180g', 'Son 6 ay', 180], ['tum', 'Tüm zamanlar', null]];
const tutarVar = v => Number.isSafeInteger(v);
const nakitVar = r => tutarVar(r.cash_cents);
const ciroVar = r => tutarVar(r.revenue_gross_cents);
const tahmini = r => !!(r.fees_estimated || r.cost_estimated || r.assumptions_source);
const hataMetni = e => (e && e.message) || 'Bu bölüm hesaplanamadı.';

// İki analytics uç noktası aynı sıkı takvim ve aralık doğrulamasını kullanır.
// Parametresiz çağrı eski tüm-zamanlar davranışını korur; tek sınır sessizce tamamlanmaz.
export function analyticsRange(request) {
  const params = new URL(request.url).searchParams;
  if (!params.has('from') && !params.has('to')) return null;
  if (params.getAll('from').length !== 1 || params.getAll('to').length !== 1)
    fail('Başlangıç ve bitiş tarihlerini birlikte ve birer kez belirtin.');
  const day = v => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
      fail('Tarih geçersiz; YYYY-MM-DD biçimini kullanın.');
    return v;
  };
  const from = day(params.get('from')), to = day(params.get('to'));
  if (from > to) fail('Başlangıç tarihi bitişten sonra olamaz.');
  return {from, to};
}

export function analyticsChannel(request) {
  const channel = new URL(request.url).searchParams.get('channel') || null;
  if (channel && !KANALLAR.includes(channel)) fail('Kanal geçersiz.');
  return channel;
}

function ozet(rows) {
  const hesapli = rows.filter(nakitVar), cirolu = rows.filter(ciroVar);
  const ortak = hesapli.filter(ciroVar);
  const sum = (list, key) => list.reduce((t, r) => t + r[key], 0);
  const ortakCiro = sum(ortak, 'revenue_gross_cents'), ortakNakit = sum(ortak, 'cash_cents');
  const kanallar = Object.fromEntries(KANALLAR.map(k => {
    const list = rows.filter(r => r.channel === k), h = list.filter(nakitVar);
    return [k, {packages: list.length, calculated: h.length, cash_cents: sum(h, 'cash_cents')}];
  }));
  return {
    packages: rows.length, calculated: hesapli.length, missing: rows.length - hesapli.length,
    // Eski nakit toplamı, hesaplanabilen kısmın toplamıdır. Sıfır/bilinmiyor ayrımı yeni alanlarda açıktır.
    cash_cents: sum(hesapli, 'cash_cents'),
    calculated_cash_cents: hesapli.length || !rows.length ? sum(hesapli, 'cash_cents') : null,
    revenue_gross_cents: cirolu.length || !rows.length ? sum(cirolu, 'revenue_gross_cents') : null,
    revenue_calculated: cirolu.length, revenue_missing: rows.length - cirolu.length,
    margin_bps: ortakCiro > 0 ? Math.round(ortakNakit * 10000 / ortakCiro) : null,
    margin_packages: ortak.length, margin_missing: rows.length - ortak.length,
    margin_revenue_gross_cents: ortak.length ? ortakCiro : null,
    margin_cash_cents: ortak.length ? ortakNakit : null,
    losses: hesapli.filter(r => r.cash_cents < 0).length,
    loss_cents: hesapli.reduce((t, r) => t + Math.min(0, r.cash_cents), 0),
    gain_cents: hesapli.reduce((t, r) => t + Math.max(0, r.cash_cents), 0),
    gains: hesapli.filter(r => r.cash_cents > 0).length,
    profit_ex_vat_cents: rows.reduce((t, r) => t + (r.profit_cents ?? 0), 0),
    estimated: rows.filter(tahmini).length,
    kaba_tahmin: rows.filter(r => r.tahmin_uyari).length,
    channels: kanallar
  };
}

function urunSirasi(rows, adlar) {
  const m = new Map();
  for (const r of rows) for (const u of r.urunler || []) {
    const x = m.get(u.product_id) || {product_id: u.product_id, name: adlar.get(u.product_id) || 'Ürün', qty_milli: 0, cash_cents: 0, revenue_gross_cents: 0, revenue_missing: 0, packages: 0, estimated: 0};
    x.qty_milli += u.qty_milli; x.cash_cents += u.cash_cents; x.packages += 1;
    if (tutarVar(u.revenue_gross_cents)) x.revenue_gross_cents += u.revenue_gross_cents;
    else x.revenue_missing += 1;
    if (tahmini(r)) x.estimated += 1;
    m.set(u.product_id, x);
  }
  // Kısmi ürün toplamını eksiksiz ciro rekoru gibi sıralama. Eski kâr listelerinin kapsamı değişmez.
  for (const r of rows) for (const u of r.urunler_eksik || []) {
    const known = m.get(u.product_id);
    if (known) known.revenue_missing += 1;
  }
  const list = [...m.values()].filter(u => u.qty_milli > 0).map(u => ({...u, per_unit_cents: Math.round(u.cash_cents * 1000 / u.qty_milli)}));
  const tie = (a, b) => a.product_id.localeCompare(b.product_id);
  const top = [...list].sort((a, b) => b.cash_cents - a.cash_cents || tie(a, b)).slice(0, 5);
  const ust = new Set(top.map(u => u.product_id));
  const bottom = [...list].sort((a, b) => a.cash_cents - b.cash_cents || tie(a, b)).filter(u => !ust.has(u.product_id)).slice(0, 5);
  const revenue_top = [...list].filter(u => !u.revenue_missing).sort((a, b) => b.revenue_gross_cents - a.revenue_gross_cents || tie(a, b)).slice(0, 5);
  return {top, bottom, count: list.length, revenue_top, missing_packages: rows.filter(r => !Array.isArray(r.urunler)).length};
}

// Rekor bir siparişe aittir: aynı kanaldaki bölünmüş paketler birleştirilir.
// Bir siparişin eksik paketi varsa o metrikte rekor adayı olamaz. Bilinmeyen sıfır değildir.
function siparisRekorlari(rows, partial) {
  const orders = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.channel, r.order_no || r.id]);
    if (!orders.has(key)) orders.set(key, {id: r.id, channel: r.channel, order_no: r.order_no, external_id: r.external_id,
      package_ids: [], packages: 0, revenue_gross_cents: 0, cash_cents: 0, revenue_missing: 0, cash_missing: 0, estimated: false});
    const order = orders.get(key);
    order.package_ids.push(r.id); order.packages += 1; order.estimated ||= tahmini(r);
    if (ciroVar(r)) order.revenue_gross_cents += r.revenue_gross_cents; else order.revenue_missing += 1;
    if (nakitVar(r)) order.cash_cents += r.cash_cents; else order.cash_missing += 1;
  }
  const list = [...orders.values()].map(o => ({...o,
    revenue_gross_cents: o.revenue_missing ? null : o.revenue_gross_cents,
    cash_cents: o.cash_missing ? null : o.cash_cents}));
  const best = field => list.filter(o => tutarVar(o[field])).sort((a, b) => b[field] - a[field] || a.id.localeCompare(b.id))[0] || null;
  return {revenue: best('revenue_gross_cents'), profit: best('cash_cents'), orders: list.length,
    revenue_missing_orders: list.filter(o => o.revenue_missing).length,
    profit_missing_orders: list.filter(o => o.cash_missing).length, partial};
}

async function inventorySnapshot(db, asOf) {
  // Arşivli ürünün elde kalan stoğu da varlıktır. Boş kartlar KDV eksikliği yaratmaz.
  const rows = (await db.prepare('SELECT b.product_id,b.quantity_milli,b.value_cents,pp.vat_bps FROM stock_balances b LEFT JOIN price_profiles pp ON pp.product_id=b.product_id WHERE b.quantity_milli!=0 OR b.value_cents!=0').all()).results;
  const missing = rows.filter(r => !tutarVar(r.vat_bps)).length;
  const gross = rows.filter(r => tutarVar(r.vat_bps)).reduce((t, r) => t + Math.round(r.value_cents * (10000 + r.vat_bps) / 10000), 0);
  return {scope: 'current', as_of: asOf, date_filter_applies: false, products: rows.length,
    net_cents: rows.reduce((t, r) => t + r.value_cents, 0),
    gross_cents: missing ? null : gross, calculated_gross_cents: gross,
    missing_vat_products: missing, negative_products: rows.filter(r => r.quantity_milli < 0).length,
    gross_estimated: true, gross_basis: 'current_product_vat', partial: !!missing,
    notice: 'Güncel stok defteri değeri; tarih filtresi uygulanmaz. Brüt değer güncel ürün KDV oranıyla tahmin edilir; geçmiş alış KDV toplamı değildir.'};
}

export async function panoramaApi(request, env, path) {
  if (path !== '/api/panorama' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Genel durum e-ticaret çalışma alanına aittir.', 403);
  const range = analyticsRange(request), channel = analyticsChannel(request);
  const db = env.DB, today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
  const firstResult = await ilkSonucTarihi(db, today);
  const ilk = {teslim: firstResult,
    bekleyen: (await db.prepare("SELECT MIN(occurred_on) d FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status IN ('draft','reserved','shipped') AND occurred_on<=?").bind(today).first())?.d || null};
  const tahmin = await kesintiTahmincisi(db);
  const rows = [], gorulen = new Set(), eksik = []; let unallocated = 0;
  const read = async (from, to) => {
    try {
      const rapor = await tumSatirlar(env, {mode: 'delivered', from, to, tahmin, detay: true, channel});
      unallocated = rapor.unallocated_fee_cents || 0;
      for (const r of rapor.rows) if (!gorulen.has(r.id)) { gorulen.add(r.id); rows.push(r); }
    } catch (e) { eksik.push({from, to, error: hataMetni(e)}); }
  };
  if (firstResult) {
    for (let from = firstResult; from <= today; from = shift(from, 92)) {
      const to = shift(from, 91) < today ? shift(from, 91) : today;
      await read(from, to);
    }
  }
  // Gelecek tarihli kayıtlar özel aralıkta performanceReport ile aynı kapsamda kalır.
  // Uzak bir gelecek bitişi binlerce boş tarih parçası üretmez; tek imleçli sorgu yeterlidir.
  if (range && range.to > today) await read(range.from > today ? range.from : shift(today, 1), range.to);
  const eksikMi = (from, to) => eksik.some(x => x.from <= to && x.to >= from);
  const idler = [...new Set(rows.flatMap(r => (r.urunler || []).map(u => u.product_id)))];
  const adlar = new Map(idler.length ? (await db.prepare('SELECT id,name FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(idler)).all()).results.map(p => [p.id, p.name]) : []);

  const period = (key, label, days, from, to) => {
    const icinde = rows.filter(r => r.delivered_on >= from && r.delivered_on <= to);
    const oncekiFrom = days && key !== 'custom' ? shift(from, -days) : null;
    const onceki = oncekiFrom && firstResult && oncekiFrom >= firstResult ? ozet(rows.filter(r => r.delivered_on >= oncekiFrom && r.delivered_on < from)) : null;
    const partial = eksikMi(from, to), oncekiEksik = !!onceki && eksikMi(oncekiFrom, shift(from, -1));
    const summary = ozet(icinde);
    if (partial) {
      summary.margin_bps = null;
      if (!icinde.length) summary.revenue_gross_cents = summary.calculated_cash_cents = null;
    }
    return {key, label, days, from, to, ...summary, partial,
      status: partial || summary.missing || summary.revenue_missing ? 'incomplete' : summary.estimated ? 'estimated' : 'complete',
      prev_cash_cents: onceki && !oncekiEksik ? onceki.cash_cents : null,
      sales: aggregateSales(icinde), returns: partial ? {failed_count: null, returned_count: null, failed_cash_cents: null, returned_cash_cents: null} : salesReturnSummary(icinde), products: {...urunSirasi(icinde, adlar), role: 'stock_component_contribution'}, records: siparisRekorlari(icinde, partial)};
  };
  const periods = DONEMLER.map(([key, label, days]) => period(key, label, days, days ? shift(today, 1 - days) : ilk.teslim || today, today));
  const selected = range ? period('custom', 'Seçilen tarih aralığı', Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY) + 1, range.from, range.to) : null;
  if (selected) periods.push(selected);

  const gunluk = new Map();
  for (const r of rows) {
    if (!nakitVar(r)) continue;
    const g = gunluk.get(r.delivered_on) || {date: r.delivered_on, trendyol: 0, hepsiburada: 0, packages: 0};
    g[r.channel] += r.cash_cents; g.packages += 1; gunluk.set(r.delivered_on, g);
  }
  const daily = [];
  if (ilk.teslim) for (let d = ilk.teslim; d <= today; d = shift(d, 1)) daily.push(gunluk.get(d) || {date: d, trendyol: 0, hepsiburada: 0, packages: 0});
  // Gelecek kayıtları özel aralık toplamında varsa grafikte de bulunur.
  // Geleceğin boş günlerini üretmeyiz: yalnız aralık içinde gerçek sonucu olan günler eklenir.
  if (range && range.to > today) daily.push(...[...gunluk.values()]
    .filter(g => g.date > today && g.date >= range.from && g.date <= range.to)
    .sort((a, b) => a.date.localeCompare(b.date)));

  // Mevcut pending sözleşmesi korunur: bütün güncel bekleyenler, sipariş tarihi temelinde.
  const pendingFrom = ilk.bekleyen || today;
  let pending;
  try { const pendingRows = (await tumSatirlar(env, {mode: 'pending', from: pendingFrom, to: today, tahmin, channel})).rows;
    pending = {from: pendingFrom, to: today, ...ozet(pendingRows), ...pendingSalesSummary(pendingRows), partial: false}; }
  catch (e) { pending = {from: pendingFrom, to: today, ...ozet([]), ...pendingSalesSummary(null), packages: null, calculated: null, cash_cents: null,
    calculated_cash_cents: null, revenue_gross_cents: null, revenue_calculated: null, revenue_missing: null,
    margin_packages: null, margin_missing: null, partial: true, error: hataMetni(e)}; }

  const asOf = new Date().toISOString();
  const inventory = await inventorySnapshot(db, asOf);
  return {as_of: asOf, today, first_delivered: ilk.teslim, unallocated_fee_cents: unallocated,
    coverage: {complete: !eksik.length && !pending.partial, missing: eksik, pending_error: pending.error || null},
    periods, daily, pending, selected_period: selected, inventory,
    notice: 'Cebine kalan = KDV dahil satış − KDV dahil ürün maliyeti − KDV dahil pazaryeri kesintileri − stopaj. Ortak giderler ve gelir vergisi hariç.'};
}
