// KAÇA SATMALIYIM? Ürün, kanal ve adet seçilir; kargo, hizmet bedeli, komisyon oranı ve stopaj
// GERÇEK teslimlerin ekstresinden (fee-history.js), maliyet ürünün son alış fiyatından gelir.
// Ölçü, ağırlık, tarife girmek gerekmez. Bütün tutarlar KDV DAHİL (kullanıcının gördüğü para).
//
//   GET /api/fiyat-hesap?product_id&channel&qty&price&target
//     price  : KDV dahil satış fiyatı (TL, isteğe bağlı) → cebine kalan
//     target : cebine kalması istenen tutar (TL, varsayılan 0) → gereken en düşük fiyat
//
// Sonuç her zaman TAHMİNDİR. Kargo/hizmet örnekleri istenen adede uymuyorsa (geçmişte yalnız daha az
// ya da yalnız daha çok adetli paket var: 'uzak') ya da ürünün hiç teslimi yoksa ('yok') kesin fiyat
// verilmez: guven='belirsiz', kısa uyarı ve açıkça etiketli senaryo döner. Tek paket kargosu adetle
// çarpılmaz. Ürün profilindeki ambalaj ve diğer paket gideri (KDV hariç, paket başına) bir kez düşülür;
// pazaryerinin hizmet bedeli (ekstreden) ayrı kalemdir. Başabaş ve hedef aynı gider kırılımını kullanır.
import {kesintiTahmincisi} from './fee-history.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const kurus = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 1e7) fail('Tutar geçersiz.'); return Math.round(n * 100); };
const adetYaz = m => (m / 1000).toLocaleString('tr-TR');

export async function fiyatHesapApi(request, env, path) {
  if (path !== '/api/fiyat-hesap' || request.method !== 'GET') return null;
  if (env.WORKSPACE !== 'ec') fail('Bu hesap e-ticaret çalışma alanına aittir.', 403);
  const db = env.DB, q = new URL(request.url).searchParams;
  const channel = q.get('channel') || '';
  if (!['trendyol', 'hepsiburada'].includes(channel)) fail('Kanal seçin.');
  const qty = Number(q.get('qty') || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) fail('Adet 1 ile 100 arasında olmalı.');
  const price = kurus(q.get('price')), target = kurus(q.get('target')) ?? 0;
  const urun = await db.prepare('SELECT p.id,p.name,pp.product_id profil,pp.vat_bps,pp.replacement_cost_cents,pp.packaging_cents,pp.other_cents,pp.units_per_parcel FROM ec_products p LEFT JOIN ec_price_profiles pp ON pp.product_id=p.id WHERE p.id=?').bind(q.get('product_id') || '').first();
  if (!urun) fail('Ürün bulunamadı.', 404);
  // Maliyet: ürün profilindeki son alış fiyatı; yoksa son muhasebeleşmiş alış satırı. Uydurulmaz.
  let birim = urun.replacement_cost_cents;
  if (!birim) birim = (await db.prepare("SELECT CAST(ROUND(l.net_cents*1000.0/l.quantity_milli) AS INTEGER) b FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.product_id=? AND i.status='posted' AND l.line_type='product' AND l.quantity_milli>0 ORDER BY i.invoice_date DESC,i.created_at DESC LIMIT 1").bind(urun.id).first())?.b || null;
  if (!birim) fail('Bu ürünün alış fiyatı yok; önce alış faturasını girin.', 409);
  const v = urun.vat_bps ?? 2000;
  const fvRow = await db.prepare("SELECT json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND provider=? AND json_extract(options_json,'$.fee_amounts_include_vat')=1 AND json_extract(options_json,'$.fee_vat_bps') IS NOT NULL LIMIT 1").bind(channel).first();
  const fv = fvRow?.bps ?? 2000;
  const h = (await kesintiTahmincisi(db))(channel, [{product_id: urun.id, quantity_milli: qty * 1000}], {adetSiniri: true});
  if (!h) fail('Bu kanalda henüz kesintisi gelmiş teslim yok; ilk teslimlerden sonra hesaplanır.', 409);

  const inc = (x, b) => Math.round(x * (10000 + b) / 10000);
  const maliyet = inc(birim * qty, v), kargo = inc(h.shipping, fv), hizmet = inc(h.other, fv);
  // Profil paket giderleri KDV hariç girilir; ürünün KDV oranıyla KDV dahil gösterilir. Paket başına bir kez.
  const profil = !!urun.profil, paketleme = inc(urun.packaging_cents ?? 0, v), diger = inc(urun.other_cents ?? 0, v);
  const sabit = maliyet + kargo + hizmet + paketleme + diger;
  // Fiyata bağlı kesintiler: komisyon (KDV hariç satışın oranı, KDV'siyle) ve stopaj (KDV dahil satışın oranı).
  const degisken = 1 - h.commissionRate * (10000 + fv) / (10000 + v) - h.withholdingRate;
  const dokum = P => {
    const komisyon = Math.round(P * 10000 / (10000 + v) * h.commissionRate * (10000 + fv) / 10000), stopaj = Math.round(P * h.withholdingRate);
    return {fiyat: P, maliyet, kargo, hizmet, komisyon, stopaj, paketleme, diger, cebine: P - sabit - komisyon - stopaj};
  };
  const fiyatFor = hedef => degisken > 0 ? Math.ceil((hedef + sabit) / degisken) : null;
  const sonuc = {
    fiyatla: price !== null ? dokum(price) : null,
    basabas: fiyatFor(0) === null ? null : dokum(fiyatFor(0)),
    hedef: target > 0 && fiyatFor(target) !== null ? {...dokum(fiyatFor(target)), istenen: target} : null
  };
  // Adet uyumu yoksa kesin öneri yok: aynı hesap yalnız etiketli senaryo olarak döner.
  const belirsiz = h.uyum === 'uzak' || h.uyum === 'yok', oa = h.ornekAdet;
  const uyari = !belirsiz ? null : h.uyum === 'yok'
    ? 'Bu ürünün teslim geçmişi yok; kargo ve hizmet bedeli başka ürünlerin paketlerinden. Rakamlar senaryodur, fiyat önerisi değildir.'
    : qty + ' adetlik paketin kargosu bilinmiyor: bu ürün geçmişte en ' + (oa.en_cok < qty * 1000 ? 'çok ' : 'az ') + adetYaz(oa.en_cok) + ' adetlik pakette teslim edildi. Rakamlar ' + adetYaz(oa.en_cok) + ' adetlik paketin kargo ve hizmet bedeliyle kurulmuş senaryodur, fiyat önerisi değildir.';
  const giderNot = !profil ? 'Ürün profili yok: ambalaj ve diğer paket gideri 0 sayıldı; "Ürün ve paket" sekmesinden girilebilir.'
    : 'Ambalaj ve diğer paket gideri ürün profilinden; KDV hariç girilen tutar KDV eklenerek, paket başına bir kez düşüldü.'
      + ((urun.packaging_cents || urun.other_cents) && urun.units_per_parcel !== qty ? ' Profil ' + urun.units_per_parcel + ' adetlik pakete göre girilmiş.' : '');
  return {
    urun: {id: urun.id, name: urun.name, birim_maliyet_kdv_dahil: inc(birim, v)}, channel, qty,
    guven: belirsiz ? 'belirsiz' : 'tahmini', uyari,
    kesinti: {kargo, hizmet, komisyon_orani: h.commissionRate, stopaj_orani: h.withholdingRate, kaynak: h.source, ornek: h.n, not: h.note,
      adet_uyumu: h.uyum, ornek_adet: oa ? {en_az: oa.en_az / 1000, en_cok: oa.en_cok / 1000} : null},
    gider: {paketleme, diger, profil, not: giderNot},
    ...(belirsiz ? {fiyatla: null, basabas: null, hedef: null,
      senaryo: {aciklama: h.uyum === 'yok' ? 'Kargo ve hizmet bedeli kanalın son teslimlerindeki gibi olursa' : 'Kargo ve hizmet bedeli ' + adetYaz(oa.en_cok) + ' adetlik paketteki gibi kalırsa', ...sonuc}}
      : {...sonuc, senaryo: null})
  };
}
