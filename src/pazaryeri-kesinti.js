// PAZARYERİ FİNANS KAYITLARINDAN KESİNTİ İŞLEME.
//
// Hepsiburada'nın kesinti belgeleri şimdiye kadar yalnız ELLE YÜKLENEN rapordan işleniyordu; API'den
// çekilen finans kayıtları (canlıda 679 adet) kaynak kutusunda duruyor, kimse okumuyordu. Bu modül
// o kayıtları satışların komisyon/kargo/diğer gider alanlarına yazar.
//
// BİLİNMEYEN SIFIR DEĞİLDİR. Ölçüldü (2026-09-25): bir paketin kesintileri AYRI GÜNLERDE geliyor,
// tek günlük çekim asla tam resmi göstermiyor; üstelik 167 paketin 59'unda ödeme kaydı olduğu hâlde
// komisyon ya da kargo kaydı YOK. Bu yüzden "ödeme geldi ⇒ kesinti tamamdır" kabul edilmez.
// Bir pakete kesinti YAZILMASI için hem komisyonunun hem kargo payının gelmiş olması gerekir;
// gelmeyen paket olduğu gibi bırakılır ve bekleyen olarak sayılır.
//
// DEFTERDE KESİNLEŞMİŞ KAYDA DOKUNULMAZ. Paketin satışlarından biri bile 'confirmed' ise o paket
// atlanır: rapor yolu ya da fatura zaten karar vermiştir, iki kaynak aynı rakamın üstüne yazmaz.
// Faturaya bağlanmış gider (fee_allocations) her hâlükârda üstündür.
import {allocateCents} from '../public/report-core.js';

// HB işlem türü → defterdeki gider bileşeni.
//   Stoppage (stopaj) GİDER DEĞİLDİR: hakedişten düşülür ama yıllık vergiden mahsup edilir.
//   Payment / TotalPayment ödemenin kendisidir, kesinti değildir.
//   CampaignDiscount bilerek dışarıda: canlıda ARTI tutanla geldi, gider mi gelir düzeltmesi mi
//   olduğu ölçülmedi; tahmin edip deftere yazmak yerine o paket bekleyen bırakılır.
export const HB_KESINTI_TURU = {
  Commission: 'commission',
  ShipmentCostSharingExpense: 'shipping',
  PaymentServiceCostReflection: 'other',
  ProcessingFeeExpense: 'other'
};
// Kesinti yazılabilmesi için gelmiş olması ZORUNLU türler.
const ZORUNLU = ['Commission', 'ShipmentCostSharingExpense'];
const kurus = tl => Math.round(Math.abs(Number(tl)) * 100);

/** Finans kaynak kayıtlarını pakete göre toplar: türler, tutarlar ve sipariş numarası. */
export function paketKesintileri(records) {
  const paketler = new Map();
  for (const r of records) {
    const paket = r.package_no, tur = r.type;
    if (!paket || !tur) continue;
    const p = paketler.get(paket) ?? {paket, order_no: r.order_no || '', turler: new Set(), commission: 0, shipping: 0, other: 0};
    p.turler.add(tur);
    if (!p.order_no && r.order_no) p.order_no = r.order_no;
    const bilesen = HB_KESINTI_TURU[tur];
    if (bilesen && Number.isFinite(Number(r.amount))) p[bilesen] += kurus(r.amount);
    paketler.set(paket, p);
  }
  return [...paketler.values()];
}

/** Paketin kesintileri yazılabilir mi? Zorunlu türlerin hepsi gelmiş olmalı. */
export const kesintiTam = p => ZORUNLU.every(t => p.turler.has(t));

export async function pazaryeriKesintileriniIsle(env, {provider = 'hepsiburada', commit = false, limit = 40} = {}) {
  const db = env.DB;
  const ham = (await db.prepare("SELECT payload_json FROM ec_provider_records WHERE provider=? AND kind='finance'")
    .bind(provider).all()).results;
  const kayitlar = [];
  for (const r of ham) { try { kayitlar.push(JSON.parse(r.payload_json)); } catch { /* bozuk kayıt atlanır */ } }
  const hepsi = paketKesintileri(kayitlar);
  const ozet = {packages: hepsi.length, incomplete: 0, unmatched: 0, ambiguous: 0, alreadyConfirmed: 0, invoiced: 0, noSales: 0, applied: 0, sale_entries_changed: 0};
  const yazimlar = [];

  for (const p of hepsi) {
    if (yazimlar.length >= limit) break;
    if (!kesintiTam(p)) { ozet.incomplete++; continue; }
    // ÖNCE PAKET NUMARASIYLA BİREBİR. Yerel paketlerin bir kısmının kimliği doğrudan pazaryerinin
    // paket numarasıdır ('HB-5511370489'); orada eşleşme kesindir, siparişe düşmeye gerek yoktur.
    let yerel = (await db.prepare("SELECT id FROM ec_order_packages WHERE channel=? AND external_id IN (?, ?)")
      .bind(provider, 'HB-' + p.paket, p.paket).all()).results;
    if (!yerel.length) {
      if (!p.order_no) { ozet.unmatched++; continue; }
      // SİPARİŞ NUMARASINA DÜŞÜLÜR: rapor yolundan gelen paketlerin kimliği (RPT-…) pazaryerinin
      // paket numarasıyla kesişmiyor. İPTAL EDİLMİŞ paket aday değildir — iptalin kesintisi olmaz
      // ve onu saymak tek gerçek paketi "belirsiz" gösterip kesintiyi boşuna engelliyordu.
      yerel = (await db.prepare("SELECT id FROM ec_order_packages WHERE channel=? AND order_no=? AND status<>'cancelled'")
        .bind(provider, p.order_no).all()).results;
    }
    if (!yerel.length) { ozet.unmatched++; continue; }
    // Hâlâ birden çok aday varsa hangisinin kesintisi olduğu bilinemez: dokunulmaz.
    if (yerel.length > 1) { ozet.ambiguous++; continue; }
    const paketId = yerel[0].id;
    const satislar = (await db.prepare(
      'SELECT c.sale_id, s.revenue_cents, s.commission_cents, s.shipping_cents, s.other_cents, s.fees_status,' +
      ' (SELECT COUNT(*) FROM ec_fee_allocations a WHERE a.sale_id=c.sale_id AND a.reversed_at IS NULL) faturali' +
      ' FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_sale_entries s ON s.id=c.sale_id' +
      " WHERE l.package_id=? AND s.kind='sale' ORDER BY c.id").bind(paketId).all()).results;
    if (!satislar.length) { ozet.noSales++; continue; }
    if (satislar.some(s => s.faturali)) { ozet.invoiced++; continue; }
    if (satislar.some(s => s.fees_status === 'confirmed')) { ozet.alreadyConfirmed++; continue; }

    // Gelirleri oranında böl; hepsi sıfırsa eşit böl. allocateCents toplamı korur, kuruş kaybolmaz.
    const agirlik = satislar.map(s => s.revenue_cents);
    const paylar = agirlik.some(w => w > 0) ? agirlik : satislar.map(() => 1);
    const parca = {commission: allocateCents(p.commission, paylar), shipping: allocateCents(p.shipping, paylar), other: allocateCents(p.other, paylar)};
    const degisim = satislar.map((s, i) => ({
      sale_id: s.sale_id,
      before: {commission: s.commission_cents, shipping: s.shipping_cents, other: s.other_cents},
      after: {commission: parca.commission[i], shipping: parca.shipping[i], other: parca.other[i]}
    })).filter(d => d.before.commission !== d.after.commission || d.before.shipping !== d.after.shipping || d.before.other !== d.after.other);
    if (!degisim.length) continue;
    yazimlar.push({paket: p.paket, order_no: p.order_no, package_id: paketId, degisim});
  }

  ozet.applied = yazimlar.length;
  ozet.sale_entries_changed = yazimlar.reduce((t, w) => t + w.degisim.length, 0);
  if (commit && yazimlar.length) {
    const hepsiDegisim = yazimlar.flatMap(w => w.degisim.map(d => ({...d, paket: w.paket})));
    for (let i = 0; i < hepsiDegisim.length; i += 20) {
      await db.batch(hepsiDegisim.slice(i, i + 20).flatMap(d => [
        // Üç bileşen de bilindiği için 'confirmed': kaynak pazaryerinin KENDİ finans kaydıdır.
        db.prepare("UPDATE ec_sale_entries SET commission_cents=?,shipping_cents=?,other_cents=?,fees_status='confirmed' WHERE id=?")
          .bind(d.after.commission, d.after.shipping, d.after.other, d.sale_id),
        db.prepare('INSERT INTO ec_fee_audit(id,sale_id,old_values,new_values) VALUES(?,?,?,?)')
          .bind(crypto.randomUUID(), d.sale_id, JSON.stringify(d.before),
            JSON.stringify({...d.after, source: provider + ' finans kaydı (API)', package: d.paket}))
      ]));
    }
  }
  return ozet;
}
