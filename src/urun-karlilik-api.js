// ÜRÜN KÂRLILIĞI. Ürünler ve stok ekranı için, bugüne kadar: satılan adet (iadeler düşülür), ciro
// (KDV dahil, müşterinin ödediği), toplam kâr (cebine kalan: KDV dahil satış − KDV dahil maliyet −
// KDV dahil kesintiler − stopaj) ve adet başı kâr.
//
// TEK FORMÜL (Codex R13/R17): ayrı SQL toplamı YOKTUR. Kâr raporunun (performanceReport) paket satırları
// ürünlere dağıtılır; ana sayfa ve kâr raporuyla aynı paket aynı kuruşu verir.
//  - Teslim edilenler (iade tarihiyle sonuçlananlar ve çift aktarım ikizi dahil): kâr raporunun kendisi.
//    Kesintisi ekstreye yazılmamış paket geçmişten TAHMİN edilir, sayısı söylenir (tahmini_paket).
//  - Kargodakiler (gönderilmiş, teslim bekleyen): kâr raporunun "Kargoda · Tahmin" satırları; ayrı alanda
//    (kargoda_kar_cents) ve tahmini sayılır.
//  - Maliyeti/kesintisi bilinmeyen paket SIFIR SAYILMAZ: ürünün toplam kârı boş (null) kalır, hesaplanan
//    kısım (hesaplanan_kar_cents), eksik paket sayısı ve kısa nedeni ayrıca verilir.
// Birden çok ürünlü pakette kesinti ve stopaj ürünlere KDV dahil satış oranında dağılır.
//
//   GET /api/urun-karlilik
import {tumSatirlar, ilkSonucTarihi} from './performance-api.js';
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const nakitVar = r => r.cash_cents !== null && r.cash_cents !== undefined;

export async function urunKarlilikApi(request, env, path) {
  if (path !== '/api/urun-karlilik' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Ürün kârlılığı e-ticaret çalışma alanına aittir.', 403);
  const db = env.DB, today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
  const tahmin = await kesintiTahmincisi(db);
  const ilk = await ilkSonucTarihi(db, today);
  const kargoIlk = (await db.prepare("SELECT MIN(occurred_on) d FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status='shipped' AND occurred_on<=?").bind(today).first())?.d;
  const teslim = ilk ? (await tumSatirlar(env, {mode: 'delivered', from: ilk, to: today, tahmin, detay: true})).rows : [];
  const kargoda = kargoIlk ? (await tumSatirlar(env, {mode: 'pending', from: kargoIlk, to: today, tahmin, detay: true})).rows.filter(r => r.status === 'shipped') : [];

  const urun = new Map(), al = id => {
    if (!urun.has(id)) urun.set(id, {product_id: id, adet_milli: 0, ciro_cents: 0, kar_cents: 0, teslim_kar_cents: 0, kargoda_kar_cents: 0,
      paketler: new Set(), tahmini: new Set(), kargodaki: new Set(), eksik: new Set(), neden: null});
    return urun.get(id);
  };
  for (const [liste, yolda] of [[teslim, false], [kargoda, true]]) for (const r of liste) {
    if (nakitVar(r) && r.urunler) {
      for (const u of r.urunler) {
        const x = al(u.product_id);
        x.adet_milli += u.qty_milli; x.ciro_cents += u.revenue_gross_cents; x.kar_cents += u.cash_cents;
        if (yolda) { x.kargoda_kar_cents += u.cash_cents; x.kargodaki.add(r.id); } else x.teslim_kar_cents += u.cash_cents;
        x.paketler.add(r.id);
        if (yolda || r.fees_estimated || r.cost_estimated) x.tahmini.add(r.id);
      }
    } else for (const u of r.urunler_eksik || []) {
      const x = al(u.product_id);
      x.adet_milli += u.qty_milli; x.paketler.add(r.id); x.eksik.add(r.id);
      x.neden = x.neden || r.missing[0] || r.cash_note || 'Kâr hesaplanamadı.';
    }
  }
  return {as_of: new Date().toISOString(), from: ilk, to: today,
    notice: 'Teslim edilenler (iade tarihiyle sonuçlananlar dahil) kâr raporuyla aynıdır; kargodakiler tahminidir. Maliyeti veya kesintisi bilinmeyen paket sıfır sayılmaz.',
    rows: [...urun.values()].map(u => {
      const kar = u.eksik.size ? null : u.kar_cents;
      return {product_id: u.product_id, adet_milli: u.adet_milli, ciro_cents: u.ciro_cents, kar_cents: kar, hesaplanan_kar_cents: u.kar_cents,
        kar_adet_cents: kar !== null && u.adet_milli > 0 ? Math.round(kar * 1000 / u.adet_milli) : null,
        teslim_kar_cents: u.teslim_kar_cents, kargoda_kar_cents: u.kargoda_kar_cents, kargoda_paket: u.kargodaki.size,
        paket: u.paketler.size, tahmini_paket: u.tahmini.size, eksik_paket: u.eksik.size, eksik_neden: u.neden};
    })};
}
