import {aggregateSales, offeringComposition, pendingSalesSummary} from './sales-presentation.js';
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
import {tumSatirlar, ilkSonucTarihi, komisyonOraniBps} from './performance-api.js';
import {kesintiTahmincisi} from './fee-history.js';
import {analyticsRange, analyticsChannel} from './panorama-api.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const nakitVar = r => r.cash_cents !== null && r.cash_cents !== undefined;
const tam = Number.isSafeInteger, SEKIL = ['tek', 'set'];

// ORTALAMA KOMİSYON ORANI VE DÖNEMLER. Pazaryeri komisyonu kampanya dönemlerinde değişir; sahibin
// göreceği rakam AĞIRLIKLI orandır: Σ KDV dahil komisyon ÷ Σ KDV dahil satış. Oranların ortalaması
// DEĞİLDİR (büyük paket küçük pakete eşit sayılamaz). Kaynak, kâr raporunun teslim edilen paket
// satırlarının ürün paylarıdır (row.urunler): ikinci bir SQL toplamı ya da ikinci formül yoktur.
// Sonucu hesaplanamayan paket (maliyeti/kesintisi bilinmeyen) kapsamda değildir: oran uydurulmaz.
// Dönem sınırları raporun bitiş tarihine göredir; paketi olmayan dönem boş kalır, sıfır sayılmaz.
const KANALLAR = ['trendyol', 'hepsiburada'], DONEM = ['son_30', 'onceki_30', 'tum'];
const gunEkle = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const donemAraliklari = (from, to) => ({
  son_30: {from: gunEkle(to, -29), to},
  onceki_30: {from: gunEkle(to, -59), to: gunEkle(to, -30)},
  tum: {from: from || null, to}});
const komisyonKutusu = () => ({komisyon_cents: 0, ciro_cents: 0, paketler: new Set()});
const komisyonOzeti = (kutu, aralik = null) => ({
  oran_bps: kutu ? komisyonOraniBps(kutu.komisyon_cents, kutu.ciro_cents) : null,
  paket: kutu ? kutu.paketler.size : 0,
  komisyon_cents: kutu ? kutu.komisyon_cents : null, ciro_cents: kutu ? kutu.ciro_cents : null,
  ...(aralik ? {from: aralik.from, to: aralik.to} : {})});
export const SET_NOTICE = 'Bir bileşenin set payı, o ürünün tek başına kârı DEĞİLDİR: pazaryeri set için tek tutar öder, bu tutar gelir payına göre bölünür, her ürün kendi gerçek maliyetini taşır. Kararı ilan (set) bazında verin.';

// SET (İLAN) KÂRLILIĞI. Sahibin gerçekten fiyatladığı şey ilanın kendisidir. Kırılım satış sunumunun
// bileşim anahtarından gelir (aggregateSales); katalog eşleştirmesi YALNIZCA ilan adını ve
// yapılandırılmış gelir payını ekler. Tutarlar kâr raporunun paket satırlarıdır: ikinci formül yok.
async function ilanHaritasi(db) {
  const rows = (await db.prepare("SELECT m.id,m.external_code,m.external_name,c.product_id,c.quantity_milli,c.revenue_share_bps,p.stock_unit FROM catalog_mappings m JOIN catalog_mapping_components c ON c.mapping_id=m.id JOIN products p ON p.id=c.product_id WHERE m.active=1 AND m.archived_at IS NULL AND m.source IN ('trendyol','hepsiburada') ORDER BY m.id,c.product_id").all()).results;
  const grup = new Map();
  for (const r of rows) {
    const g = grup.get(r.id) || {id: r.id, external_code: r.external_code, external_name: r.external_name, parts: [], paylar: new Map()};
    g.parts.push({product_id: r.product_id, quantity_milli: r.quantity_milli, stock_unit: r.stock_unit});
    g.paylar.set(r.product_id, r.revenue_share_bps); grup.set(r.id, g);
  }
  // Anahtar satılan BİR adete göre normalize edilir: ilan sürümü değişse de aynı bileşim aynı anahtar.
  // Aynı anahtarlı ikinci eşleştirme ilkini ezmez; tek bileşenli eşleştirme set değildir, listeye girmez.
  const harita = new Map();
  for (const g of grup.values()) if (g.parts.length > 1) {
    const k = offeringComposition({id: g.id, quantity_milli: 1000}, g.parts).key;
    if (!harita.has(k)) harita.set(k, g);
  }
  return harita;
}

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

  const bosSekil = () => ({paketler: new Set(), eksik: new Set(), adet_milli: 0, ciro_cents: 0, kar_cents: 0});
  const urun = new Map(), al = id => {
    if (!urun.has(id)) urun.set(id, {product_id: id, adet_milli: 0, ciro_cents: 0, kar_cents: 0, teslim_kar_cents: 0, kargoda_kar_cents: 0,
      single_cash_cents: 0, multipack_cash_cents: 0, bundle_cash_cents: 0, return_cash_cents: 0,
      teslim_eksik: false, kargoda_eksik: false, preparing_cash_cents: 0, shipped_cash_cents: 0, preparing: new Set(), shipped: new Set(),
      paketler: new Set(), tahmini: new Set(), kargodaki: new Set(), eksik: new Set(), neden: null, tek: bosSekil(), set: bosSekil(),
      komisyon: new Map()});
    return urun.get(id);
  };
  // Komisyon kutuları: kanal ('hepsi' + gerçek kanal) × dönem. Yalnız TESLİM EDİLEN ve sonucu
  // hesaplanan paketler; tutarlar kâr raporunun ürün paylarından gelir, yeniden hesaplanmaz.
  const araliklar = donemAraliklari(from, to);
  const komisyonEkle = (x, r, u) => {
    if (!tam(u.commission_gross_cents) || !tam(u.revenue_gross_cents)) return;
    const gun = r.delivered_on || '';
    for (const kanal of ['hepsi', r.channel]) for (const d of DONEM) {
      const a = araliklar[d];
      if (d !== 'tum' && !(gun >= a.from && gun <= a.to)) continue;
      const anahtar = kanal + '|' + d, kutu = x.komisyon.get(anahtar) || komisyonKutusu();
      kutu.komisyon_cents += u.commission_gross_cents; kutu.ciro_cents += u.revenue_gross_cents; kutu.paketler.add(r.id);
      x.komisyon.set(anahtar, kutu);
    }
  };
  // SATIŞ ŞEKLİ KIRILIMI. Aynı paket satırı sales-presentation'da zaten tek/set olarak işaretlenmiştir
  // (tek = kendi ilanı ya da yalnız kendisinden oluşan çoklu paket, set = çok bileşenli ilan). Burada
  // yalnız TOPLANIR: ikinci bir kâr formülü yoktur, tek_* + set_* daima mevcut toplamı verir.
  const sekilEkle = (x, u, id, eksikPaket) => { for (const s of SEKIL) {
    if (u[s + '_satir'] > 0) { x[s].paketler.add(id); if (eksikPaket) x[s].eksik.add(id); }
    x[s].adet_milli += u[s + '_qty_milli'] || 0;
    if (eksikPaket) continue;
    for (const [alan, kaynak] of [['ciro_cents', s + '_revenue_gross_cents'], ['kar_cents', s + '_cash_cents']])
      x[s][alan] = Number.isSafeInteger(x[s][alan]) && Number.isSafeInteger(u[kaynak]) ? x[s][alan] + u[kaynak] : null;
  } };
  for (const [liste, yolda] of [[teslim, false], [kargoda, true]]) for (const r of liste) {
    if (nakitVar(r) && r.urunler) {
      for (const u of r.urunler) {
        const x = al(u.product_id);
        sekilEkle(x, u, r.id, false);
        for (const field of ['single_cash_cents', 'multipack_cash_cents', 'bundle_cash_cents', 'return_cash_cents']) x[field] = Number.isSafeInteger(x[field]) && Number.isSafeInteger(u[field]) ? x[field] + u[field] : null;
        if (yolda) { const state = r.status === 'shipped' ? 'shipped' : 'preparing'; x[state].add(r.id); if (x[state + '_cash_cents'] !== null) x[state + '_cash_cents'] += u.cash_cents; }
        else komisyonEkle(x, r, u);
        x.adet_milli += u.qty_milli; x.ciro_cents += u.revenue_gross_cents; x.kar_cents += u.cash_cents;
        if (yolda) { x.kargoda_kar_cents += u.cash_cents; x.kargodaki.add(r.id); } else x.teslim_kar_cents += u.cash_cents;
        x.paketler.add(r.id);
        if (yolda || r.fees_estimated || r.cost_estimated) x.tahmini.add(r.id);
      }
    } else for (const u of r.urunler_eksik || []) {
      const x = al(u.product_id);
      sekilEkle(x, u, r.id, true);
      x.adet_milli += u.qty_milli; x.paketler.add(r.id); x.eksik.add(r.id);
      x[yolda ? 'kargoda_eksik' : 'teslim_eksik'] = true; if (yolda) x.kargodaki.add(r.id);
      for (const field of ['single_cash_cents', 'multipack_cash_cents', 'bundle_cash_cents', 'return_cash_cents']) x[field] = null;
      if (yolda) { const state = r.status === 'shipped' ? 'shipped' : 'preparing'; x[state].add(r.id); x[state + '_cash_cents'] = null; }
      x.neden = x.neden || r.missing?.[0] || r.cash_note || 'Kâr hesaplanamadı.';
    }
  }
  // Karar yüzeyi teslim edilenlerdir: kesinleşmiş paketler. En kötü paket başına sonuç en üstte.
  const satislar = aggregateSales(teslim), ilanlar = await ilanHaritasi(db);
  const setler = satislar.rows.filter(x => x.kind === 'bundle').map(x => {
    const m = ilanlar.get(x.key);
    return {key: x.key, mapping_id: m?.id || null, external_code: m?.external_code || null,
      ad: m?.external_name || x.name, bilesim: x.name,
      paket: x.packages, adet_milli: x.units_milli, ciro_cents: x.revenue_gross_cents, kar_cents: x.cash_cents,
      hesaplanan_kar_cents: x.calculated_cash_cents, eksik_paket: x.missing, tahmini_paket: x.estimated, iade_paket: x.return_packages,
      paket_basina_cents: tam(x.cash_cents) && x.packages ? Math.round(x.cash_cents / x.packages) : null,
      adet_kar_cents: x.per_unit_cents,
      bilesenler: x.components.map(c => ({...c, revenue_share_bps: m?.paylar.get(c.product_id) ?? null}))};
  }).sort((a, b) => (a.paket_basina_cents ?? Infinity) - (b.paket_basina_cents ?? Infinity) || (a.ad < b.ad ? -1 : a.ad > b.ad ? 1 : 0));
  return {as_of: new Date().toISOString(), from, to, sales: {...satislar, scope: 'delivered'}, setler, set_notice: SET_NOTICE,
    pending: {...pendingSalesSummary(kargoda), sales: aggregateSales(kargoda)},
    date_basis: {delivered: 'delivered_on', pending: 'occurred_on'}, pending_from: pendingFrom || null,
    notice: range ? 'Seçilen aralıkta teslim edilenler sonuç tarihiyle (teslim veya iade), hazırlanan ve kargodaki paketler sipariş tarihiyle süzülür. Kargodaki kâr tahminidir. Stok bakiyesi bu tarih aralığından etkilenmez.' : 'Teslim edilenler (iade tarihiyle sonuçlananlar dahil) kâr raporuyla aynıdır. Kargodaki tutar henüz teslim edilmemiş paketlerin tahminidir: gönderilenler ve hazırlananlar (stok ayrılmış) birlikte — ana sayfadaki "Kargodaki tahminim" ile aynı kapsam. Maliyeti veya kesintisi bilinmeyen paket sıfır sayılmaz.',
    rows: [...urun.values()].map(u => {
      const kar = u.eksik.size ? null : u.kar_cents;
      // tek_* / set_*: aynı ürünün TEK satıştan ve SET içinden gelen sonucu ayrı ayrı. Eksik paketi
      // olan şekil SIFIR SAYILMAZ, boş (null) kalır; miktar ve paket sayısı yine söylenir.
      const sekil = Object.fromEntries(SEKIL.flatMap(s => {
        const v = u[s], bos = v.eksik.size > 0, k = bos ? null : v.kar_cents;
        return [[s + '_paket', v.paketler.size], [s + '_adet_milli', v.adet_milli],
          [s + '_ciro_cents', bos ? null : v.ciro_cents], [s + '_kar_cents', k],
          [s + '_kar_adet_cents', k !== null && v.adet_milli > 0 ? Math.round(k * 1000 / v.adet_milli) : null],
          [s + '_eksik_paket', v.eksik.size]];
      }));
      // ORTALAMA KOMİSYON ORANI: ürünün bütün kapsamı, kanal kanal ve dönem dönem. Oran bir TUTAR
      // DEĞİLDİR (pazaryerinin tarife oranıdır, tek başına TL vermez): tutar yetkisi kapalı personel
      // oranı ve paket sayısını görür, *_cents alanları mevcut kuralla gizlenir.
      const komisyonHepsi = komisyonOzeti(u.komisyon.get('hepsi|tum'));
      const komisyon = {komisyon_oran_bps: komisyonHepsi.oran_bps, komisyon_paket: komisyonHepsi.paket,
        komisyon_cents: komisyonHepsi.komisyon_cents, komisyon_ciro_cents: komisyonHepsi.ciro_cents,
        komisyon_donemler: Object.fromEntries(DONEM.map(d => [d, komisyonOzeti(u.komisyon.get('hepsi|' + d), araliklar[d])])),
        komisyon_kanallar: KANALLAR.filter(c => u.komisyon.has(c + '|tum')).map(c => ({kanal: c, ...komisyonOzeti(u.komisyon.get(c + '|tum')),
          donemler: Object.fromEntries(DONEM.map(d => [d, komisyonOzeti(u.komisyon.get(c + '|' + d), araliklar[d])]))}))};
      return {product_id: u.product_id, role: 'stock_component_contribution', ...sekil, ...komisyon,
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
