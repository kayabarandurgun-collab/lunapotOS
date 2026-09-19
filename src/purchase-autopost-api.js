// Alış faturasını GEÇMİŞTEN öğrenerek tamamlar: ürün bağla → muhasebeleştir → mal teslimi.
//
//   POST /api/invoices/:id/autocomplete   {}
//
// Ürün TAHMİN EDİLMEZ; aynı tedarikçiden daha önce muhasebeleşmiş faturalarda aynı satırın hangi
// karta bağlandığına bakılır:
//   1) Açıklama (boşluk/noktalama farkı hariç) ve birim birebir aynıysa → o kart.
//   2) Değilse, aynı ÜRÜN KODUYLA alınmış kartlar içinde adının ayırt edici sözcüklerinin
//      hepsi açıklamada geçen TEK kart varsa → o kart ("Çiçek Açan … 1000 ml").
//   Geçmiş iki farklı karta işaret ediyorsa ya da hiçbir kart uymuyorsa satır BAĞLANMAZ;
//   fatura taslak kalır ve kullanıcıya sorulur.
// Stok karşılığı (fatura birimi başına stok miktarı) da geçmişten alınır; tutarsızsa bağlanmaz.
//
// Bütün ürün satırları bağlandıysa fatura muhasebeleştirilir (cari borç) ve FATURA TARİHİYLE mal
// teslimi yapılır (stok). İkisi de mevcut muhasebe akışından geçer; doğrulamalar atlanmaz.
// Çeşit dağılımı bekleyen (ürün ailesine yönlendirilmiş) faturalar otomatik işlenmez.
import {accountingApi} from './accounting.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
// Eşleme kuralı ekranla ortaktır: public/purchase-match.js
import {matchFromHistory} from '../public/purchase-match.js';
export {matchFromHistory};

async function gecmisSatirlar(env, supplierId, haricId) {
  // Aynı tedarikçinin muhasebeleşmiş faturalarındaki ürün satırları (en yeni önce).
  // Mal kabulü geri alınmış satır YANLIŞ eşleşmedir (ör. yanlış çeşide girilmiş): örnek alınmaz.
  // Geri alma kaydı yalnız e-ticaret alanında vardır.
  const reversed = env.WORKSPACE === 'ec'
  ? 'AND NOT EXISTS(SELECT 1 FROM receipt_reversals r JOIN goods_receipts g ON g.id=r.receipt_id WHERE g.line_id=l.id)' : '';
  return (await env.DB.prepare(`SELECT l.description,l.external_code,l.invoice_unit,l.invoice_quantity,l.quantity_milli,l.product_id,p.name product_name
  FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id JOIN products p ON p.id=l.product_id
  WHERE i.supplier_id=? AND i.status='posted' AND i.id<>? AND l.line_type='product' AND l.product_id IS NOT NULL
  AND l.quantity_milli>0 AND l.invoice_quantity>0
  ${reversed} ORDER BY i.invoice_date DESC LIMIT 3000`).bind(supplierId, haricId).all()).results;
}

export async function purchaseAutopostApi(request, env, path, readBody) {
  // Ekran satırları gösterirken aynı geçmişe bakar: öneri ile kayıt aynı kuraldan çıkar.
  //   GET /api/invoices/match-history?supplier_id=…
  if (path === '/api/invoices/match-history' && request.method === 'GET') {
    const supplier = new URL(request.url).searchParams.get('supplier_id') || '';
    if (!/^[\w-]{1,80}$/.test(supplier)) fail('Tedarikçi geçersiz.');
    return {rows: await gecmisSatirlar(env, supplier, '')};
  }
  const m = path.match(/^\/api\/invoices\/([\w-]+)\/autocomplete$/);
  if (!m || request.method !== 'POST') return null;
  const db = env.DB, key = m[1];
  const invoice = await db.prepare('SELECT id,supplier_id,invoice_no,invoice_date,status FROM purchase_invoices WHERE id=?').bind(key).first();
  if (!invoice) fail('Fatura bulunamadı.', 404);
  if (invoice.status !== 'draft') return {status: invoice.status, notice: 'Fatura zaten işlenmiş.'};
  const lines = (await db.prepare('SELECT * FROM purchase_lines WHERE invoice_id=? ORDER BY rowid').bind(key).all()).results;
  if (!lines.length) return {status: 'draft', reason: 'Faturada satır yok.'};
  const pendingSplit = await db.prepare('SELECT 1 FROM purchase_line_splits WHERE invoice_id=? LIMIT 1').bind(key).first();
  if (pendingSplit) return {status: 'draft', reason: 'Çeşit dağılımı olan fatura elle muhasebeleştirilir.'};

  const history = await gecmisSatirlar(env, invoice.supplier_id, key);

  const mapped = [], missing = [];
  const payload = lines.map(l => {
    const base = {id: l.id, line_type: l.line_type, expense_category: l.expense_category, expense_treatment: l.expense_treatment || ''};
    if (l.line_type !== 'product') return base;
    if (l.product_id && l.quantity_milli) return {...base, product_id: l.product_id, stock_quantity: l.quantity_milli / 1000};
    const hit = matchFromHistory(l, history);
    if (!hit) { missing.push(l.description); return base; }
    const stock = Math.round(l.invoice_quantity * hit.ratio) / 1000;
    mapped.push({description: l.description, product_name: hit.product_name, how: hit.how, stock_quantity: stock});
    return {...base, product_id: hit.product_id, stock_quantity: stock};
  });
  const call = (sub, body) => accountingApi(new Request('https://internal/api/accounting/invoices/' + key + sub, {method: 'POST'}),
    env, '/api/accounting/invoices/' + key + sub, async () => body);
  // Bulunan bağlantılar kısmi de olsa kaydedilir: kullanıcı yalnız kalan satırları seçer.
  if (mapped.length) await call('', {lines: payload});
  // Kartın tedarikçisi BOŞSA bu faturanın tedarikçisi yazılır: kart ondan alınıyor, bu bir
  // olgudur. Dolu tedarikçi değiştirilmez (ikinci tedarikçi kartın asıl tedarikçisini ezmez).
  const productIds = [...new Set(payload.map(l => l.product_id).filter(Boolean))];
  if (env.WORKSPACE === 'ec' && productIds.length)
    await db.prepare('UPDATE products SET supplier_id=? WHERE supplier_id IS NULL AND id IN (SELECT value FROM json_each(?))')
      .bind(invoice.supplier_id, JSON.stringify(productIds)).run();
  if (missing.length) return {status: 'draft', mapped, missing,
    reason: missing.length + ' satırın ürünü geçmişte bulunamadı: ' + missing.join('; ')};

  await call('/post', {});
  const fresh = (await db.prepare("SELECT id,quantity_milli FROM purchase_lines WHERE invoice_id=? AND line_type='product'").bind(key).all()).results;
  // Teslim ayrı adımdır: başarısız olursa fatura muhasebeleşmiş kalır ve bu SÖYLENİR.
  try {
    if (fresh.length)
      await call('/receive', {occurred_on: invoice.invoice_date, reference: 'Fatura ile teslim ' + invoice.invoice_no,
        lines: fresh.map(l => ({id: l.id, quantity: l.quantity_milli / 1000}))});
  } catch (e) {
    return {status: 'posted', received: false, mapped, reason: 'Muhasebeleşti ama mal teslimi yapılamadı: ' + e.message};
  }
  return {status: 'posted', received: fresh.length > 0, mapped,
    notice: 'Muhasebeleşti ve ' + invoice.invoice_date + ' tarihli mal teslimiyle stoğa girdi.'};
}
