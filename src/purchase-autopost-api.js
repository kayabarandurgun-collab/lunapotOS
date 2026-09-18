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
const letters = s => String(s || '').toLocaleUpperCase('tr').replace(/[^A-ZÇĞİÖŞÜ0-9]/g, '');
const words = s => String(s || '').toLocaleLowerCase('tr').split(/[^a-zçğıöşü0-9]+/).filter(w => w.length >= 3 && !['ile', 'için'].includes(w));
const codeOf = l => letters(l.external_code) || letters((String(l.description || '').match(/^\S+/) || [''])[0]);

/** Geçmiş satırlarından bu satıra uyan TEK kartı bulur; bulamazsa null. */
export function matchFromHistory(line, history) {
  const unit = line.invoice_unit, same = history.filter(h => h.invoice_unit === unit);
  const ratioOf = rows => { const r = [...new Set(rows.map(h => h.quantity_milli / h.invoice_quantity))]; return r.length === 1 && r[0] > 0 ? r[0] : null; };
  const pick = (rows, how) => {
    const ids = [...new Set(rows.map(h => h.product_id))];
    if (ids.length !== 1) return null;
    const ratio = ratioOf(rows.filter(h => h.product_id === ids[0]));
    return ratio ? {product_id: ids[0], product_name: rows[0].product_name, ratio, how} : null;
  };
  const exact = same.filter(h => letters(h.description) === letters(line.description));
  if (exact.length) return pick(exact, 'aynı açıklama');
  const code = codeOf(line);
  if (!code) return null;
  const byCode = same.filter(h => codeOf(h) === code);
  const products = [...new Map(byCode.map(h => [h.product_id, h.product_name])).entries()];
  if (!products.length) return null;
  // Ayırt edici sözcük: bütün aday kartlarda ortak OLMAYAN sözcük.
  const sets = products.map(([, name]) => new Set(words(name)));
  const common = [...sets[0]].filter(w => sets.every(s => s.has(w)));
  const text = words(line.description);
  const fits = products.filter(([, name], i) => {
    const own = [...sets[i]].filter(w => !common.includes(w));
    return own.length > 0 && own.every(w => text.some(t => t === w || t.startsWith(w)));
  });
  if (fits.length !== 1) return null;
  return pick(byCode.filter(h => h.product_id === fits[0][0]), 'aynı ürün kodu ve ad');
}

export async function purchaseAutopostApi(request, env, path, readBody) {
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

  // Mal kabulü geri alınmış satır YANLIŞ eşleşmedir (ör. yanlış çeşide girilmiş): örnek alınmaz.
  // Geri alma kaydı yalnız e-ticaret alanında vardır.
  const reversed = env.WORKSPACE === 'ec'
    ? 'AND NOT EXISTS(SELECT 1 FROM receipt_reversals r JOIN goods_receipts g ON g.id=r.receipt_id WHERE g.line_id=l.id)' : '';
  const history = (await db.prepare(`SELECT l.description,l.external_code,l.invoice_unit,l.invoice_quantity,l.quantity_milli,l.product_id,p.name product_name
    FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id JOIN products p ON p.id=l.product_id
    WHERE i.supplier_id=? AND i.status='posted' AND i.id<>? AND l.line_type='product' AND l.product_id IS NOT NULL
      AND l.quantity_milli>0 AND l.invoice_quantity>0
      ${reversed} ORDER BY i.invoice_date DESC LIMIT 3000`).bind(invoice.supplier_id, key).all()).results;

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
