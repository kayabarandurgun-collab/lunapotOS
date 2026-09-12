// Rapora bağlı siparişin KAYNAK GÜNCELLİĞİ denetimi.
//
// Bu modülü hem sipariş motoru (stok eylemleri) hem rapor köprüsü kullanır. Ortak modül olması
// döngüsel içe aktarmayı önler: orders-api → guard ← report-stock-link-api.
//
// Kural: fiziksel stok hareketinin güvenliği İSTEĞE BAĞLI bir ekran ziyaretine bağlanamaz.
// Denetim rezervasyon ve gönderimde zorunludur; önizleme yalnızca okur.
const VERSION = 'v2';

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Paketin kanonik içerik özeti. Sürümlüdür ve kapsamı bilinçlidir:
 *   kalem kimliği · barkod · satıcı stok kodu · adet · tutar · durum
 * Aynı adet ve tutar, aynı ürün demek DEĞİLDİR; ürün kimliği bu yüzden özete dahildir.
 */
export async function reportLinkFingerprint(records) {
  const rows = records
    .map(r => {
      const d = r.data || {};
      return [String(d.line_id ?? ''), String(d.barcode ?? ''), String(d.sku ?? ''),
        Number(d.quantity) || 0, d.gross ?? null, String(d.status ?? '')];
    })
    .sort((a, b) => (a[0] + '|' + a[1] + '|' + a[2]).localeCompare(b[0] + '|' + b[1] + '|' + b[2]));
  return VERSION + ':' + await sha256Hex(JSON.stringify(rows));
}

/**
 * Siparişe bağlı rapor kayıtlarının ŞİMDİKİ özeti.
 *   {linked:false}                          → rapora bağlı değil, denetim uygulanmaz
 *   {linked:true, missing:true}             → bağlıydı ama kayıt bulunamıyor: güvenli değil
 *   {linked:true, current:'v2:...'}         → karşılaştırılacak güncel özet
 */
export async function currentReportLink(db, pkg) {
  if (!pkg || !pkg.report_link_hash) return {linked: false};
  const rows = (await db.prepare("SELECT data_json FROM ec_report_records WHERE erp_package_id=? AND kind='order_line'")
    .bind(pkg.id).all()).results;
  if (!rows.length) return {linked: true, missing: true};
  const records = rows.map(r => { try { return {data: JSON.parse(r.data_json)}; } catch { return {data: {}}; } });
  return {linked: true, current: await reportLinkFingerprint(records)};
}

/**
 * Stok eyleminden ÖNCE çağrılır. Kaynak değiştiyse hareketi durdurur.
 * Yazma işlemi ayrıca aynı özete koşullanır; okuma ile yazma arasındaki değişiklik satırı
 * güncellemez ve işlem başarısız olur.
 */
export async function assertReportLinkFresh(db, pkg, fail) {
  const state = await currentReportLink(db, pkg);
  if (!state.linked) return;
  if (state.missing)
    fail('Bu siparişin bağlı olduğu pazaryeri raporu kayıtları bulunamıyor. Stok hareketi yapılmadan önce inceleyin.', 409);
  if (state.current !== pkg.report_link_hash)
    fail('Bağlı pazaryeri raporu değişti (adet, ürün kimliği veya sipariş durumu). Stok hareketi yapılmadan önce taslağı inceleyip düzeltin.', 409);
}
