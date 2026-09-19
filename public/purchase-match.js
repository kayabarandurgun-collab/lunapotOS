// GEÇMİŞTEN ÜRÜN EŞLEME. Sunucu (purchase-autopost-api.js, kaydedince) ve alış faturası ekranı
// (purchase-document-ui.js, satırlar gösterilirken) AYNI kuralı kullanır: ekran ne öneriyorsa
// kayıt da onu yapar. Ürün tahmin edilmez; aynı tedarikçinin muhasebeleşmiş faturalarına bakılır.
export const letters = s => String(s || '').toLocaleUpperCase('tr').replace(/[^A-ZÇĞİÖŞÜ0-9]/g, '');
export const words = s => String(s || '').toLocaleLowerCase('tr').split(/[^a-zçğıöşü0-9]+/).filter(w => w.length >= 3 && !['ile', 'için'].includes(w));
export const codeOf = l => letters(l.external_code) || letters((String(l.description || '').match(/^\S+/) || [''])[0]);

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
  // Kod geçmişte hep TEK karta gittiyse açıklama yazımı değişse de o kart (ör. "Y.TEMİZLEYİCİ").
  // Yalnız GERÇEK ürün kodunda (tedarikçi kodu ya da nokta/rakam taşıyan ilk sözcük): "Gartengold"
  // gibi marka adı kod sayılmaz. Açıklamada geçmişte görülmemiş bir ölçü (80 L gibi) varsa bağlanmaz.
  if (products.length === 1) {
    const ilk = (String(line.description || '').match(/^\S+/) || [''])[0];
    const gercekKod = !!letters(line.external_code) || /[.\d]/.test(ilk);
    const sayilar = s => (String(s || '').match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace(',', '.'));
    const bilinen = new Set([...sayilar(products[0][1]), ...byCode.flatMap(h => sayilar(h.description))]);
    const yeniOlcu = sayilar(String(line.description || '').slice(ilk.length)).some(n => !bilinen.has(n));
    return gercekKod && !yeniOlcu ? pick(byCode, 'aynı ürün kodu') : null;
  }
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

