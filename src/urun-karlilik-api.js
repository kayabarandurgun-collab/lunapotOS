import {aggregateSales, pendingSalesSummary} from './sales-presentation.js';
// ÜRÜN KÂRLILIĞI. Ürünler ve stok ekranı için, bugüne kadar: satılan adet (iadeler düşülür), ciro
// (KDV dahil, müşterinin ödediği), toplam kâr (cebine kalan: KDV dahil satış − KDV dahil maliyet −
// KDV dahil kesintiler − stopaj) ve adet başı kâr.
//
// TEK FORMÜL (Codex R13/R17): ayrı SQL toplamı YOKTUR. Kâr raporunun (performanceReport) paket satırları
// ürünlere dağıtılır; ana sayfa ve kâr raporuyla aynı paket aynı kuruşu verir.
//  - Teslim edilenler (iade tarihiyle sonuçlananlar ve çift aktarım ikizi dahil): kâr raporunun kendisi.
//    Kesintisi ekstreye yazılmamış paket geçmişten TAHMİN edilir, sayısı söylenir (tahmini_paket).
//  - Kargodakiler (henüz teslim edilmemiş: gönderilen + hazırlanan/stok ayrılmış): kâr raporunun
//    "Kargoda · Tahmin" satırları; ayrı alanda (kargoda_kar_cents) ve tahmini sayılır. Kapsam ana
//    sayfanın "Kargodaki tahminim" kartıyla AYNIDIR (aynı tarih, aynı durumlar): iki ekran aynı rakamı
//    verir. Eskiden yalnız 'shipped' sayılıyordu; hazırlanan paketler ekranlar arasında fark yaratıyordu.
//  - Maliyeti/kesintisi bilinmeyen paket SIFIR SAYILMAZ: ürünün toplam kârı boş (null) kalır, hesaplanan
//    kısım (hesaplanan_kar_cents), eksik paket sayısı ve kısa nedeni ayrıca verilir.
// Birden çok ürünlü pakette kesinti ve stopaj ürünlere KDV dahil satış oranında dağılır.
//
//   GET /api/urun-karlilik
import {tumSatirlar, ilkSonucTarihi} from './performance-api.js';
import {kesintiTahmincisi} from './fee-history.js';
import {analyticsRange, analyticsChannel} from './panorama-api.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const nakitVar = r => r.cash_cents !== null && r.cash_cents !== undefined;

export async function urunKarlilikApi(request, env, path) {
  if (path !== '/api/urun-karlilik' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Ürün kârlılığı e-ticaret çalışma alanına aittir.', 403);
  const range = analyticsRange(request), channel = analyticsChannel(request);
  const db = env.DB, today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
  const tahmin = await kesintiTahmincisi(db);
  const ilk = await ilkSonucTarihi(db, range?.to || today);
  // İlk bekleyen paketin sipariş tarihi: ana sayfanın (panorama-api) kullandığı sorgunun AYNISI.
  const kargoIlk = (await db.prepare("SELECT MIN(occurred_on) d FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status IN ('draft','reserved','shipped') AND occurred_on<=?").bind(today).first())?.d;
  const from = range?.from || ilk, to = range?.to || today;
  const teslim = from ? (await tumSatirlar(env, {mode: 'delivered', from, to, tahmin, detay: true, channel})).rows : [];
  // Özel aralıkta teslimler sonuç tarihiyle, bekleyenler sipariş tarihiyle süzülür; parametresiz eski kapsam korunur.
  const pendingFrom = range?.from || kargoIlk;
  const kargoda = pendingFrom ? (await tumSatirlar(env, {mode: 'pending', from: pendingFrom, to, tahmin, detay: true, channel})).rows : [];

  const urun = new Map(), al = id => {
    if (!urun.has(id)) urun.set(id, {product_id: id, adet_milli: 0, ciro_cents: 0, kar_cents: 0, teslim_kar_cents: 0, kargoda_kar_cents: 0,
      single_cash_cents: 0, multipack_cash_cents: 0, bundle_cash_cents: 0, return_cash_cents: 0,
      teslim_eksik: false, kargoda_eksik: false, preparing_cash_cents: 0, shipped_cash_cents: 0, preparing: new Set(), shipped: new Set(),
      paketler: new Set(), tahmini: new Set(), kargodaki: new Set(), eksik: new Set(), neden: null});
    return urun.get(id);
  };
  for (const [liste, yolda] of [[teslim, false], [kargoda, true]]) for (const r of liste) {
    if (nakitVar(r) && r.urunler) {
      for (const u of r.urunler) {
        const x = al(u.product_id);
        for (const field of ['single_cash_cents', 'multipack_cash_cents', 'bundle_cash_cents', 'return_cash_cents']) x[field] = Number.isSafeInteger(x[field]) && Number.isSafeInteger(u[field]) ? x[field] + u[field] : null;
        if (yolda) { const state = r.status === 'shipped' ? 'shipped' : 'preparing'; x[state].add(r.id); if (x[state + '_cash_cents'] !== null) x[state + '_cash_cents'] += u.cash_cents; }
        x.adet_milli += u.qty_milli; x.ciro_cents += u.revenue_gross_cents; x.kar_cents += u.cash_cents;
        if (yolda) { x.kargoda_kar_cents += u.cash_cents; x.kargodaki.add(r.id); } else x.teslim_kar_cents += u.cash_cents;
        x.paketler.add(r.id);
        if (yolda || r.fees_estimated || r.cost_estimated) x.tahmini.add(r.id);
      }
    } else for (const u of r.urunler_eksik || []) {
      const x = al(u.product_id);
      x.adet_milli += u.qty_milli; x.paketler.add(r.id); x.eksik.add(r.id);
      x[yolda ? 'kargoda_eksik' : 'teslim_eksik'] = true; if (yolda) x.kargodaki.add(r.id);
      for (const field of ['single_cash_cents', 'multipack_cash_cents', 'bundle_cash_cents', 'return_cash_cents']) x[field] = null;
      if (yolda) { const state = r.status === 'shipped' ? 'shipped' : 'preparing'; x[state].add(r.id); x[state + '_cash_cents'] = null; }
      x.neden = x.neden || r.missing?.[0] || r.cash_note || 'Kâr hesaplanamadı.';
    }
  }
  return {as_of: new Date().toISOString(), from, to, sales: {...aggregateSales(teslim), scope: 'delivered'},
    pending: {...pendingSalesSummary(kargoda), sales: aggregateSales(kargoda)},
    date_basis: {delivered: 'delivered_on', pending: 'occurred_on'}, pending_from: pendingFrom || null,
    notice: range ? 'Seçilen aralıkta teslim edilenler sonuç tarihiyle (teslim veya iade), hazırlanan ve kargodaki paketler sipariş tarihiyle süzülür. Kargodaki kâr tahminidir. Stok bakiyesi bu tarih aralığından etkilenmez.' : 'Teslim edilenler (iade tarihiyle sonuçlananlar dahil) kâr raporuyla aynıdır. Kargodaki tutar henüz teslim edilmemiş paketlerin tahminidir: gönderilenler ve hazırlananlar (stok ayrılmış) birlikte — ana sayfadaki "Kargodaki tahminim" ile aynı kapsam. Maliyeti veya kesintisi bilinmeyen paket sıfır sayılmaz.',
    rows: [...urun.values()].map(u => {
      const kar = u.eksik.size ? null : u.kar_cents;
      return {product_id: u.product_id, role: 'stock_component_contribution',
        single_cash_cents: u.single_cash_cents, multipack_cash_cents: u.multipack_cash_cents, bundle_cash_cents: u.bundle_cash_cents, return_cash_cents: u.return_cash_cents,
        preparing_packages: u.preparing.size, shipped_packages: u.shipped.size, preparing_cash_cents: u.preparing_cash_cents, shipped_cash_cents: u.shipped_cash_cents,
        adet_milli: u.adet_milli, ciro_cents: u.eksik.size ? null : u.ciro_cents, kar_cents: kar,
        hesaplanan_ciro_cents: u.paketler.size > u.eksik.size ? u.ciro_cents : null,
        hesaplanan_kar_cents: u.paketler.size > u.eksik.size ? u.kar_cents : null,
        kar_adet_cents: kar !== null && u.adet_milli > 0 ? Math.round(kar * 1000 / u.adet_milli) : null,
        teslim_kar_cents: u.teslim_eksik ? null : u.teslim_kar_cents, kargoda_kar_cents: u.kargoda_eksik ? null : u.kargoda_kar_cents, kargoda_paket: u.kargodaki.size,
        paket: u.paketler.size, tahmini_paket: u.tahmini.size, eksik_paket: u.eksik.size, eksik_neden: u.neden};
    })};
}
