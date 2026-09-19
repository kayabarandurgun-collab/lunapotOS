// ANA SAYFA ÖZETİ (Genel durum). Teslim edilenlerin cebine kalanı son 1 hafta / 2 hafta / 1 ay /
// 3 ay / 6 ay / tüm zamanlar; kargodaki ve hazırlanan paketlerin tahmini; günlük seri (grafik) ve
// dönem başına en çok / en az kazandıran ürünler.
//
// Hesap kâr raporuyla BİREBİRDİR: aynı performanceReport satırları toplanır (tek formül). Dönem kartı
// tıklanınca kâr raporu aynı aralıkla açılır ve aynı toplamı gösterir. Tutarlar KDV dahil nakittir.
//
// Kâr raporu 1.000 paketle sınırlı olduğu için tüm zamanlar aralığı parçalara bölünür; parça yine
// sığmazsa ikiye bölünür. Kesinti tahmincisi bir kez kurulur.
//
//   GET /api/panorama
import {performanceReport} from './performance-api.js';
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const DAY = 86400000;
const shift = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const gunFarki = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const KANALLAR = ['trendyol', 'hepsiburada'];
const DONEMLER = [['7g', 'Son 1 hafta', 7], ['14g', 'Son 2 hafta', 14], ['30g', 'Son 1 ay', 30], ['90g', 'Son 3 ay', 90], ['180g', 'Son 6 ay', 180], ['tum', 'Tüm zamanlar', null]];
const nakitVar = r => r.cash_cents !== null && r.cash_cents !== undefined;

async function teslimRaporlari(env, from, to, tahmin) {
  try {
    return [await performanceReport(env, {mode: 'delivered', from, to, tahmin, detay: true})];
  } catch (e) {
    if (e.status !== 409 || from === to) throw e;
    const orta = shift(from, Math.floor(gunFarki(from, to) / 2));
    return [...await teslimRaporlari(env, from, orta, tahmin), ...await teslimRaporlari(env, shift(orta, 1), to, tahmin)];
  }
}

function ozet(rows) {
  const hesapli = rows.filter(nakitVar);
  const kanallar = Object.fromEntries(KANALLAR.map(k => {
    const list = rows.filter(r => r.channel === k), h = list.filter(nakitVar);
    return [k, {packages: list.length, calculated: h.length, cash_cents: h.reduce((t, r) => t + r.cash_cents, 0)}];
  }));
  return {
    packages: rows.length, calculated: hesapli.length, missing: rows.length - hesapli.length,
    cash_cents: hesapli.reduce((t, r) => t + r.cash_cents, 0),
    revenue_gross_cents: hesapli.reduce((t, r) => t + (r.revenue_gross_cents || 0), 0),
    losses: hesapli.filter(r => r.cash_cents < 0).length,
    // KDV hariç katkı yalnız vergi beyanı için küçük satırda gösterilir.
    profit_ex_vat_cents: rows.reduce((t, r) => t + (r.profit_cents ?? 0), 0),
    estimated: rows.filter(r => r.fees_estimated || r.cost_note || r.assumptions_source).length,
    channels: kanallar
  };
}

function urunSirasi(rows, adlar) {
  const m = new Map();
  for (const r of rows) for (const u of r.urunler || []) {
    const x = m.get(u.product_id) || {product_id: u.product_id, name: adlar.get(u.product_id) || 'Ürün', qty_milli: 0, cash_cents: 0, packages: 0};
    x.qty_milli += u.qty_milli; x.cash_cents += u.cash_cents; x.packages += 1; m.set(u.product_id, x);
  }
  const list = [...m.values()].filter(u => u.qty_milli > 0).map(u => ({...u, per_unit_cents: Math.round(u.cash_cents * 1000 / u.qty_milli)}));
  const top = [...list].sort((a, b) => b.cash_cents - a.cash_cents).slice(0, 5);
  const ust = new Set(top.map(u => u.product_id));
  const bottom = [...list].sort((a, b) => a.cash_cents - b.cash_cents).filter(u => !ust.has(u.product_id)).slice(0, 5);
  return {top, bottom, count: list.length};
}

export async function panoramaApi(request, env, path) {
  if (path !== '/api/panorama' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Genel durum e-ticaret çalışma alanına aittir.', 403);
  const db = env.DB, today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
  const ilk = await db.prepare(`SELECT
      (SELECT MIN(delivered_on) FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status='delivered' AND delivered_on<=?) teslim,
      (SELECT MIN(occurred_on) FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status IN ('draft','reserved','shipped') AND occurred_on<=?) bekleyen`).bind(today, today).first();
  const tahmin = await kesintiTahmincisi(db);

  // Teslim edilenler: tüm aralık 92 günlük parçalarla. Aynı paket iki parçada görünemez (teslim
  // tarihi tektir); çift aktarım ikizi başka parçada ayrıca teslimliyse bir kez sayılır.
  const rows = [], gorulen = new Set();let unallocated = 0;
  if (ilk?.teslim) {
    for (let from = ilk.teslim; from <= today; from = shift(from, 92)) {
      const to = shift(from, 91) < today ? shift(from, 91) : today;
      for (const rapor of await teslimRaporlari(env, from, to, tahmin)) {
        unallocated = rapor.unallocated_fee_cents || 0;
        for (const r of rapor.rows) if (!gorulen.has(r.id)) { gorulen.add(r.id); rows.push(r); }
      }
    }
  }
  const idler = [...new Set(rows.flatMap(r => (r.urunler || []).map(u => u.product_id)))];
  const adlar = new Map(idler.length ? (await db.prepare('SELECT id,name FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(idler)).all()).results.map(p => [p.id, p.name]) : []);

  const periods = DONEMLER.map(([key, label, days]) => {
    const from = days ? shift(today, 1 - days) : ilk?.teslim || today;
    const icinde = rows.filter(r => r.delivered_on >= from && r.delivered_on <= today);
    // Önceki eş dönem yalnız verinin başladığı günden sonraysa karşılaştırılır (yarım dönem yanıltır).
    const oncekiFrom = days ? shift(from, -days) : null;
    const onceki = days && ilk?.teslim && oncekiFrom >= ilk.teslim ? ozet(rows.filter(r => r.delivered_on >= oncekiFrom && r.delivered_on < from)) : null;
    return {key, label, days, from, to: today, ...ozet(icinde), prev_cash_cents: onceki ? onceki.cash_cents : null, products: urunSirasi(icinde, adlar)};
  });

  const gunluk = new Map();
  for (const r of rows) {
    if (!nakitVar(r)) continue;
    const g = gunluk.get(r.delivered_on) || {date: r.delivered_on, trendyol: 0, hepsiburada: 0, packages: 0};
    g[r.channel] += r.cash_cents; g.packages += 1; gunluk.set(r.delivered_on, g);
  }
  const daily = [];
  if (ilk?.teslim) for (let d = ilk.teslim; d <= today; d = shift(d, 1)) daily.push(gunluk.get(d) || {date: d, trendyol: 0, hepsiburada: 0, packages: 0});

  // Kargodaki ve hazırlanan paketler: sipariş tarihi en eski bekleyen paketten bugüne (30 günle sınırlı değil).
  const pendingFrom = ilk?.bekleyen || today;
  const bekleyen = await performanceReport(env, {mode: 'pending', from: pendingFrom, to: today, tahmin});

  return {as_of: new Date().toISOString(), today, first_delivered: ilk?.teslim || null, unallocated_fee_cents: unallocated,
    periods, daily, pending: {from: pendingFrom, to: today, ...ozet(bekleyen.rows)},
    notice: 'Cebine kalan = KDV dahil satış − KDV dahil ürün maliyeti − KDV dahil pazaryeri kesintileri − stopaj. Ortak giderler ve gelir vergisi hariç.'};
}
