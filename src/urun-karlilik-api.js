// ÜRÜN KÂRLILIĞI. Ürünler ve stok ekranı için, bugüne kadar: satılan adet (iadeler düşülür), ciro
// (KDV dahil, müşterinin ödediği), toplam kâr (cebine kalan: KDV dahil satış − KDV dahil maliyet −
// KDV dahil kesintiler − stopaj) ve adet başı kâr. Hesap kâr raporuyla aynıdır.
//
// Kargoya verilmiş (gönderilmiş/teslim edilmiş) paketlerin satışları sayılır. Kesintisi henüz
// ekstreye yazılmamış paketin kesintisi geçmiş teslimlerden TAHMİN edilir ve sayısı ayrıca söylenir.
// Birden çok ürünlü pakette kesinti ve stopaj ürünlere satış tutarı oranında dağılır.
//
//   GET /api/urun-karlilik
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const inc = (v, bps) => Math.round(v * (10000 + (bps ?? 0)) / 10000);

export async function urunKarlilikApi(request, env, path) {
  if (path !== '/api/urun-karlilik' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Ürün kârlılığı e-ticaret çalışma alanına aittir.', 403);
  const db = env.DB;
  const [satirlar, bilesenler, feeVatRows, stopajlar] = (await db.batch([
    db.prepare(`SELECT s.id,s.kind,s.parent_id,s.product_id,s.quantity_milli,s.revenue_cents,s.cost_cents,s.commission_cents,s.shipping_cents,s.other_cents,
        l.vat_bps satir_kdv,pp.vat_bps urun_kdv,p.id pkg,p.channel,p.order_no
      FROM ec_sale_entries s JOIN ec_order_line_components c ON (s.id=c.sale_id OR s.parent_id=c.sale_id) JOIN ec_order_lines l ON l.id=c.line_id
      JOIN ec_order_packages p ON p.id=l.package_id LEFT JOIN ec_price_profiles pp ON pp.product_id=s.product_id
      WHERE p.status IN ('shipped','delivered') AND p.channel IN ('trendyol','hepsiburada')`),
    db.prepare(`SELECT l.package_id,c.product_id,c.quantity_milli FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id
      JOIN ec_order_packages p ON p.id=l.package_id WHERE p.status IN ('shipped','delivered')`),
    db.prepare("SELECT provider,json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND json_extract(options_json,'$.fee_amounts_include_vat')=1 AND json_extract(options_json,'$.fee_vat_bps') IS NOT NULL"),
    // Stopaj sipariş düzeyinde bildirilir; siparişin iptal olmayan paketlerine eşit bölünür (kâr raporuyla aynı).
    db.prepare(`SELECT p.id pkg,(SELECT COALESCE(SUM(json_extract(r.data_json,'$.amount_cents')),0) FROM ec_report_records r JOIN ec_report_stores st ON st.id=r.store_id AND st.provider=p.channel
        WHERE r.kind='finance_event' AND json_extract(r.data_json,'$.type')='withholding' AND json_extract(r.data_json,'$.order_no')=p.order_no) stopaj,
        (SELECT COUNT(*) FROM ec_order_packages q WHERE q.order_no=p.order_no AND q.channel=p.channel AND q.status!='cancelled') paket
      FROM ec_order_packages p WHERE p.status IN ('shipped','delivered') AND p.channel='hepsiburada'`)
  ])).map(r => r.results);
  const feeVat = new Map(feeVatRows.map(r => [r.provider, r.bps]));
  const stopajOf = new Map(stopajlar.map(r => [r.pkg, Math.round(Math.abs(r.stopaj || 0) / Math.max(1, r.paket || 1))]));
  const tahmin = await kesintiTahmincisi(db);
  const paketler = new Map();
  for (const s of satirlar) { if (!paketler.has(s.pkg)) paketler.set(s.pkg, []); paketler.get(s.pkg).push(s); }
  const partsOf = new Map();
  for (const c of bilesenler) { if (!partsOf.has(c.package_id)) partsOf.set(c.package_id, []); partsOf.get(c.package_id).push(c); }
  const urun = new Map(), al = id => { if (!urun.has(id)) urun.set(id, {product_id: id, adet_milli: 0, ciro_cents: 0, kar_cents: 0, paketler: new Set(), tahmini: new Set()}); return urun.get(id); };

  for (const [pkg, list] of paketler) {
    const fv = feeVat.get(list[0].channel) ?? 2000;
    const satislar = list.filter(s => s.kind === 'sale'), ciroNet = satislar.reduce((t, s) => t + s.revenue_cents, 0) || 1;
    // Kesintisi yazılmamış paket: geçmiş teslimlerden tahmin, satış tutarı oranında dağıtılır.
    const eksik = satislar.some(s => s.shipping_cents === null || s.commission_cents === null || s.other_cents === null);
    const h = eksik ? tahmin(list[0].channel, partsOf.get(pkg) || []) : null;
    const brutCiro = satislar.reduce((t, s) => t + inc(s.revenue_cents, s.satir_kdv ?? s.urun_kdv), 0);
    const stopaj = stopajOf.has(pkg) ? stopajOf.get(pkg) : h ? Math.round(brutCiro * h.withholdingRate) : 0;
    for (const s of list) {
      const u = al(s.product_id), pay = s.kind === 'sale' ? s.revenue_cents / ciroNet : 0;
      const kom = s.commission_cents ?? (h && s.kind === 'sale' ? Math.round(s.revenue_cents * h.commissionRate) : 0);
      const kargo = s.shipping_cents ?? (h && s.kind === 'sale' ? Math.round(h.shipping * pay) : 0);
      const diger = s.other_cents ?? (h && s.kind === 'sale' ? Math.round(h.other * pay) : 0);
      const ciro = inc(s.revenue_cents, s.satir_kdv ?? s.urun_kdv);
      u.adet_milli += s.kind === 'return' ? -s.quantity_milli : s.quantity_milli;
      u.ciro_cents += ciro;
      u.kar_cents += ciro - inc(s.cost_cents, s.urun_kdv) - inc(kom, fv) - inc(kargo, fv) - inc(diger, fv) - Math.round(stopaj * pay);
      if (s.kind === 'sale') { u.paketler.add(pkg); if (h) u.tahmini.add(pkg); }
    }
  }
  return {as_of: new Date().toISOString(), rows: [...urun.values()].map(u => ({product_id: u.product_id, adet_milli: u.adet_milli, ciro_cents: u.ciro_cents, kar_cents: u.kar_cents,
    kar_adet_cents: u.adet_milli > 0 ? Math.round(u.kar_cents * 1000 / u.adet_milli) : null, paket: u.paketler.size, tahmini_paket: u.tahmini.size}))};
}
