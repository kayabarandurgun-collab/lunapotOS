// Rapor Kutusu çekirdeği — tarayıcıda (önizleme) ve sunucuda (kayıt) AYNI kurallar.
//
// Sağlayıcıya özel sütun adı UYDURULMAZ. Hangi Excel sütununun hangi anlama geldiğini kullanıcı
// bir kez onaylar; onay "profil" olarak saklanır ve aynı başlıklı dosyada tekrar sorulmaz.
// Başlık adından yapılan tahminler yalnızca ÖNERİDİR, onaysız uygulanmaz.
//
// Para her yerde tam sayı kuruş. Eksik sütun sıfır değildir: alan hiç yazılmaz.

export const REPORT_KINDS = {orders: 'Sipariş raporu', finance: 'Finans / hakediş raporu'};
export const PROVIDERS = {trendyol: 'Trendyol', hepsiburada: 'Hepsiburada'};

export const FIELDS = {
  bank: [
    {key: 'occurred_on', label: 'İşlem tarihi', type: 'date', required: true, hint: ['işlem tarihi', 'tarih', 'valör']},
    {key: 'description', label: 'Açıklama', type: 'text', hint: ['açıklama', 'izahat', 'detay']},
    {key: 'amount', label: 'Tutar (tek sütunda, eksi = para çıkışı)', type: 'money', hint: ['tutar', 'işlem tutarı']},
    {key: 'debit', label: 'Borç / çıkan (ayrı sütundaysa)', type: 'money', hint: ['borç', 'çıkan', 'gider']},
    {key: 'credit', label: 'Alacak / giren (ayrı sütundaysa)', type: 'money', hint: ['alacak', 'giren', 'gelir']},
    {key: 'balance', label: 'Bakiye', type: 'money', hint: ['bakiye']},
    {key: 'reference', label: 'Dekont / işlem numarası', type: 'id', hint: ['dekont', 'işlem no', 'referans', 'fiş', 'sıra']},
    {key: 'counterparty', label: 'Karşı taraf', type: 'text', hint: ['karşı', 'gönderen', 'alıcı', 'ünvan', 'unvan']}
  ],
  orders: [
    {key: 'order_no', label: 'Sipariş numarası', type: 'id', required: true, hint: ['sipariş no', 'sipariş numarası']},
    {key: 'package_id', label: 'Paket / gönderi numarası', type: 'id', hint: ['paket', 'gönderi']},
    {key: 'line_id', label: 'Sipariş kalemi kimliği', type: 'id', hint: ['kalem']},
    {key: 'barcode', label: 'Barkod', type: 'id', hint: ['barkod']},
    {key: 'sku', label: 'Stok kodu (SKU)', type: 'id', hint: ['stok kodu', 'sku', 'satıcı stok']},
    {key: 'product_name', label: 'Ürün adı', type: 'text', hint: ['ürün adı']},
    {key: 'quantity', label: 'Adet', type: 'int', required: true, hint: ['adet', 'miktar']},
    {key: 'status', label: 'Sipariş durumu', type: 'text', hint: ['durum']},
    {key: 'order_date', label: 'Sipariş tarihi', type: 'date', required: true, hint: ['sipariş tarihi']},
    {key: 'delivered_date', label: 'Teslim tarihi', type: 'date', hint: ['teslim']},
    {key: 'gross', label: 'Satış tutarı (müşterinin ödediği, KDV dahil)', type: 'money', hint: ['satış tutarı', 'faturalanacak']},
    {key: 'vat_bps', label: 'KDV oranı (%)', type: 'percent', hint: ['kdv']},
    {key: 'carrier', label: 'Kargo firması', type: 'text', hint: ['kargo firması']},
    {key: 'cargo_package', label: 'Kargo ücreti (paket başına)', type: 'money', hint: ['kargo ücreti', 'kargo bedeli']}
  ],
  finance: [
    {key: 'event_id', label: 'İşlem / hareket kimliği', type: 'id', hint: ['işlem no', 'hareket', 'dekont']},
    {key: 'order_no', label: 'Sipariş numarası', type: 'id', hint: ['sipariş no', 'sipariş numarası']},
    {key: 'package_id', label: 'Paket / gönderi numarası', type: 'id', hint: ['paket']},
    {key: 'barcode', label: 'Barkod', type: 'id', hint: ['barkod']},
    {key: 'event_type', label: 'İşlem türü (metin)', type: 'text', hint: ['işlem tipi', 'işlem türü', 'açıklama']},
    {key: 'event_date', label: 'İşlem tarihi', type: 'date', required: true, hint: ['işlem tarihi', 'tarih']},
    {key: 'amount', label: 'Tutar (türü "İşlem türü" sütunundan)', type: 'money', hint: ['tutar']},
    {key: 'sale', label: 'Satış tutarı', type: 'money', event: 'sale'},
    {key: 'refund', label: 'İade tutarı', type: 'money', event: 'refund'},
    {key: 'commission', label: 'Komisyon', type: 'money', event: 'commission', hint: ['komisyon']},
    {key: 'cargo', label: 'Kargo kesintisi', type: 'money', event: 'cargo'},
    {key: 'service', label: 'Hizmet bedeli', type: 'money', event: 'service', hint: ['hizmet']},
    {key: 'withholding', label: 'Stopaj', type: 'money', event: 'withholding', hint: ['stopaj']},
    {key: 'other_fee', label: 'Diğer kesinti', type: 'money', event: 'other_fee'},
    {key: 'net_payout', label: 'Net hakediş (pazaryerinin bildirdiği)', type: 'money', hint: ['hakediş', 'net tutar']},
    {key: 'payout_date', label: 'Ödeme / vade tarihi', type: 'date', hint: ['vade', 'ödeme tarihi']}
  ]
};

export const EVENT_TYPES = {sale: 'Satış', refund: 'İade', commission: 'Komisyon', cargo: 'Kargo', service: 'Hizmet bedeli',
  withholding: 'Stopaj', other_fee: 'Diğer kesinti', payout: 'Ödeme / hakediş', ignore: 'Yok say (bilgi satırı)'};
export const FEE_TYPES = ['commission', 'cargo', 'service', 'other_fee'];

const lower = s => String(s ?? '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();

/** Başlıkların sırasız, büyük/küçük harf duyarsız imzası: aynı raporun sonraki dosyası tanınır. */
export function headerSignature(headers) {
  return [...new Set(headers.map(lower))].sort().join('␟');
}

/**
 * RAPOR TÜRÜNÜ KENDİSİ ANLAR. Kullanıcı yalnız mağazayı (pazaryerini) seçer; dosyanın sipariş mi
 * finans/hakediş raporu mu olduğu sütunlarından çıkarılır:
 *  1) Daha önce onaylanmış bir biçimle birebir aynı sütunlar → o biçimin türü.
 *  2) Kayıtlı biçimlerden biriyle sütunların çoğu ortaksa (en az %60) → en çok örtüşenin türü.
 *  3) Ayırt edici sütunlar: sipariş raporunda barkod, adet, teslimat adresi, kargo firması…;
 *     finans raporunda net tutar, hakediş, hizmet bedeli, stopaj, kesinti… (barkod yok).
 * Karar verilemezse null döner; o zaman ekran türü sorar.
 */
export function detectReportKind(headers, profiles = []) {
  const set = new Set(headers.map(lower)), sig = headerSignature(headers);
  const active = profiles.filter(p => p && p.active !== 0 && REPORT_KINDS[p.kind]);
  const exact = active.find(p => p.signature === sig);
  if (exact) return exact.kind;
  let best = null;
  for (const p of active) {
    const theirs = String(p.signature || '').split('␟').filter(Boolean);
    if (!theirs.length) continue;
    const common = theirs.filter(h => set.has(h)).length, ratio = common / Math.max(theirs.length, set.size);
    if (ratio >= 0.6 && (!best || ratio > best.ratio)) best = {kind: p.kind, ratio};
  }
  if (best) return best.kind;
  const has = re => [...set].some(h => re.test(h));
  const orders = [/barkod/, /^adet$/, /teslimat adresi/, /kargo firması/, /kargo takip/, /alıcı/, /paket (numarası|no)/, /stok kodu/].filter(has).length;
  const finance = [/net tutar/, /hakedi[şs]/, /hizmet bedeli/, /stopaj/, /kesinti/, /tahsilat/, /işlem (tipi|türü|tarihi)/, /ceza/].filter(has).length;
  if (orders >= finance + 2) return 'orders';
  if (finance >= orders + 2) return 'finance';
  return null;
}

/** Başlık adından ÖNERİ (kullanıcı onaylamadan uygulanmaz). */
export function suggestMapping(kind, headers) {
  const out = {};
  for (const field of FIELDS[kind]) {
    const hit = headers.find(h => (field.hint || []).some(k => lower(h).includes(k)));
    if (hit && !Object.values(out).includes(hit)) out[field.key] = hit;
  }
  return out;
}

/**
 * Hicbir alana eslenmemis ama icinde sifirdan farkli para degeri olan sutunlar.
 * Bunlar genelde ikinci bir kargo kalemi, indirim ya da iptal sutunudur; sorulmazsa
 * tutar sessizce duser ve rapor kendi net tutariyla tutmaz.
 */
export function extraFeeCandidates(headers, rows, mapping = {}, date1904 = false) {
  const used = new Set(Object.values(mapping || {}).filter(Boolean));
  return headers.filter((header, at) => {
    if (used.has(header)) return false;
    return rows.some(r => {
      const cell = r.cells[at];
      if (!cell || cell.v === null || cell.v === undefined) return false;
      const read = readers.money(cell, date1904);
      return !read.error && Number.isSafeInteger(read.value) && read.value !== 0;
    });
  });
}

/** Profil, bu dosyanın başlıklarıyla birebir kullanılabilir mi? Değişmiş/eksik sütun sorulur. */
export function profileFits(profile, headers) {
  const set = new Set(headers);
  const missing = Object.entries(profile.mapping || {}).filter(([, h]) => h && !set.has(h)).map(([k]) => k);
  const known = new Set(Object.values(profile.mapping || {}).concat(profile.ignored || []));
  const added = headers.filter(h => !known.has(h));
  return {fits: missing.length === 0, missing, added};
}

/* ---------------- değerler ---------------- */
const issue = (code, field, detail = '') => ({code, field, detail});

/** Türkçe/İngilizce tutar metnini kuruşa çevirir. Kayan nokta kullanılmaz. */
export function parseMoney(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return {missing: true};
  let s = String(cell.v).replace(/[\s ]/g, '').replace(/₺|TL|TRY/gi, '');
  if (!s) return {missing: true};
  // Hepsiburada komisyon hücresi tutarı ve ORANI tek hücrede verir: "-54.12 TL (%19.54)".
  // Oran tutarın parçası değildir; ayrı okunur ve ham hücre korunur. Oran eki olmayan hücreler
  // eskisi gibi çalışır; "(123,45)" muhasebe eksi gösterimi bundan ayrıdır çünkü % işareti yoktur.
  let ratePercent = null;
  const rateSuffix = s.match(/\(%(\d+(?:[.,]\d+)?)\)$/);
  if (rateSuffix) { ratePercent = rateSuffix[1].replace(',', '.'); s = s.slice(0, rateSuffix.index); }
  if (!s) return {missing: true};
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/e/i.test(s)) return {error: 'Tutar bilimsel gösterimde; güvenle okunamadı.'};
  if (cell.t === 'n') {
    if (!/^\d+(\.\d+)?$/.test(s)) return {error: 'Tutar sayı değil.'};
  } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else if (!/^\d+(\.\d+)?$/.test(s)) return {error: 'Tutar biçimi tanınmadı: ' + String(cell.v)};
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return {error: 'Tutarda kuruştan küçük basamak var; yuvarlanmadı.'};
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return {error: 'Tutar sınırı aşıldı.'};
  return {value: Number(cents) * (negative ? -1 : 1), ...(ratePercent === null ? {} : {rate_percent: ratePercent})};
}

export function parseInt10(cell) {
  if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === '') return {missing: true};
  const s = String(cell.v).trim().replace(/\.0+$/, '').replace(',0', '');
  if (!/^-?\d+$/.test(s)) return {error: 'Adet tam sayı değil: ' + cell.v};
  return {value: Number(s)};
}

/** Kimlik: METİN. Excel'in sayıya çevirip bozduğu uzun kimlik tahminle onarılmaz, incelemeye ayrılır. */
export function parseId(cell) {
  if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === '') return {missing: true};
  const s = String(cell.v).trim();
  if (cell.t === 'n' && (/e/i.test(s) || s.replace(/\D/g, '').length > 15))
    return {value: s, error: 'Kimlik Excel\'de sayıya dönüşmüş, son haneleri bozulmuş olabilir. Raporu metin olarak indirin.'};
  return {value: s.replace(/\.0$/, '')};
}

/** Tarih → 'YYYY-MM-DD' ya da 'YYYY-MM-DDTHH:MM' (Europe/Istanbul duvar saati; saat dilimi eklenmez). */
export function parseDate(cell, date1904 = false) {
  if (!cell || cell.v === null || cell.v === undefined || String(cell.v).trim() === '') return {missing: true};
  const s = String(cell.v).trim();
  const pad = n => String(n).padStart(2, '0');
  if (cell.t === 'n' && /^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s), days = Math.floor(serial);
    if (days < 1) return {error: 'Tarih geçersiz.'};
    // Excel 1900 sisteminde 1900-02-29 yoktur ama sayılır; 60'tan büyük seriler bir gün kaydırılır.
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days > 59 ? 30 : 31);
    const d = new Date(base + days * 86400000), minutes = Math.round((serial - days) * 1440);
    const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    return {value: minutes ? date + 'T' + pad(Math.floor(minutes / 60) % 24) + ':' + pad(minutes % 60) : date};
  }
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, d, mo, y, h, mi] = m, iso = y + '-' + pad(mo) + '-' + pad(d);
    if (new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) !== iso) return {error: 'Tarih geçersiz: ' + s};
    return {value: h !== undefined ? iso + 'T' + pad(h) + ':' + mi : iso};
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return {value: m[4] !== undefined ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`};
  return {error: 'Tarih biçimi tanınmadı: ' + s};
}

/** Yuzde hucresi: "20", "%20" ve "%20,00" kabul edilir; deger baz puana cevrilir. */
function parsePercent(cell) {
  if (cell === null || cell === undefined || cell.v === null || cell.v === undefined) return {missing: true};
  const raw = String(cell.v).trim();
  if (!raw) return {missing: true};
  const cleaned = raw.split('%').join('').split(' ').join('').split(',').join('.');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return {error: 'KDV oranı okunamadı: ' + raw};
  if (value < 0 || value > 100) return {error: 'KDV oranı 0 ile 100 arasında olmalı: ' + raw};
  return {value: Math.round(value * 100)};
}
const readers = {percent: parsePercent, id: parseId, text: c => (c?.v === null || c?.v === undefined || String(c.v).trim() === '' ? {missing: true} : {value: String(c.v).trim()}), int: parseInt10, money: parseMoney, date: parseDate};

/* ---------------- satır → kayıt ---------------- */
/**
 * profile: {kind, mapping:{alan:başlık}, type_map:{'işlem türü metni': 'commission'|...}, fees_positive:bool}
 * Dönüş: {records, skipped:{empty,total}, unknownTypes:[metin], totals:{alan:kuruş}}
 * Her kayıt: {row, kind, key, keySource:'provider'|'composite', data, issues}
 */
export function normalizeRows(profile, headers, rows, {date1904 = false} = {}) {
  const kind = profile.kind, fields = FIELDS[kind], col = {};
  for (const [field, header] of Object.entries(profile.mapping || {})) if (header) col[field] = headers.indexOf(header);
  const records = [], skipped = {empty: 0, total: 0}, unknownTypes = new Set(), totals = {};
  for (const {row, cells} of rows) {
    const values = cells.filter(c => c?.v !== null && c?.v !== undefined);
    if (!values.length) { skipped.empty++; continue; }
    const data = {}, issues = [];
    for (const field of fields) {
      if (col[field.key] === undefined || col[field.key] < 0) continue;
      const cell = cells[col[field.key]];
      const r = readers[field.type](cell, date1904);
      if (cell?.f && !r.missing) issues.push(issue('formula', field.key, 'Değer bir formülün kayıtlı sonucu.'));
      if (r.error) issues.push(issue(field.type === 'id' ? 'id_precision' : 'bad_value', field.key, r.error));
      if (r.value !== undefined && !(r.error && field.type !== 'id')) data[field.key] = r.value;
      // Tutar, oran ve ham hücre AYRI kalır: oran tekrar gider diye toplanmaz, ham metin kaybolmaz.
      if (r.rate_percent !== undefined) {
        data[field.key + '_rate_percent'] = r.rate_percent;
        data[field.key + '_raw'] = String(cell.v);
      }
      if (field.type === 'money' && Number.isSafeInteger(data[field.key])) totals[field.key] = (totals[field.key] || 0) + data[field.key];
    }
    // Toplam satırı işlem sayılmaz: kimlik alanları boş ve satırda "toplam" yazıyor.
    // ETİKETİN KENDİSİ KİMLİK SÜTUNUNA DÜŞEBİLİYOR. Canlıda görüldü: Hepsiburada sipariş dökümünün
    // son satırında "Toplam" kelimesi SİPARİŞ NO sütununda; alan dolu sayıldığı için bu eleme
    // çalışmıyor, satır "tutarı yok" diye incelemeye düşüyordu. Yedi inceleme kaydının beşi buydu:
    // kullanıcıdan her dosyada aynı çöp satır için karar isteniyordu. Sipariş numarası "Toplam"
    // olan gerçek sipariş yoktur; etiket taşıyan kimlik alanı BOŞ sayılır.
    const ozetEtiketi = v => /^(genel\s+toplam|ara\s+toplam|toplam|grand\s+total|total|sum)$/i.test(String(v ?? '').trim());
    const idFields = kind === 'orders' ? ['order_no', 'package_id', 'line_id'] : ['event_id', 'order_no', 'package_id'];
    if (idFields.every(f => data[f] === undefined || ozetEtiketi(data[f])) && values.some(c => /toplam|total/i.test(String(c.v)))) {
      skipped.total++;
      for (const [k, v] of Object.entries(data)) if (Number.isSafeInteger(v) && totals[k] !== undefined) totals[k] -= v;
      continue;
    }
    for (const field of fields) {
      if (!field.required || data[field.key] !== undefined) continue;
      // Hepsiburada finans dökümünde işlem tarihi sütunu HİÇ YOK. Sipariş tarihini ya da dosya
      // adındaki aralığı işlem tarihi saymak veri uydurmaktır. Profil bunu açıkça beyan ettiyse
      // kayıt "tarihi bilinmeyen" olarak saklanır; tarih alanı boş kalır, tahmin edilmez.
      if (kind === 'finance' && field.key === 'event_date' && profile.undated) { data.event_date = null; continue; }
      issues.push(issue('missing_required', field.key, field.label + ' boş.'));
    }

    if (kind === 'orders') {
      const item = data.line_id ? null : (data.barcode || data.sku || '');
      const key = data.line_id ? 'L:' + data.line_id
        : data.package_id ? 'P:' + data.package_id + '|' + item : 'O:' + (data.order_no || '') + '|' + item;
      records.push({row, kind: 'order_line', key, keySource: data.line_id ? 'provider' : 'composite', data, issues});
      continue;
    }
    // Finans: uzun biçim (tür + tutar) satır başına bir olay; geniş biçimde her tutar sütunu ayrı olay.
    const events = [];
    if (col.amount !== undefined && col.amount >= 0) {
      const text = data.event_type ? String(data.event_type) : '';
      const type = profile.type_map?.[text];
      if (!type) { unknownTypes.add(text); issues.push(issue('unknown_type', 'event_type', 'İşlem türü tanımlanmadı: ' + (text || '(boş)'))); }
      if (type !== 'ignore' && data.amount !== undefined) events.push({type: type || null, amount: data.amount, field: 'amount'});
    }
    for (const field of fields.filter(f => f.event)) if (data[field.key] !== undefined) events.push({type: field.event, amount: data[field.key], field: field.key});
    for (const extra of profile.extra_fees || []) {
      const at = headers.indexOf(extra.header);
      if (at < 0) continue;
      const okunan = readers.money(cells[at], date1904);
      if (okunan.error || okunan.value === undefined) continue;
      events.push({type: extra.type, amount: okunan.value, field: 'ek:' + extra.header});
    }
    if (data.net_payout !== undefined && !events.length) events.push({type: 'payout', amount: data.net_payout, field: 'net_payout'});
    for (const e of events) {
      // İşaret: kullanıcı raporda kesintilerin pozitif yazıldığını söylediyse kesinti/iade eksiye çevrilir.
      let amount = e.amount;
      if (profile.fees_positive && [...FEE_TYPES, 'refund', 'withholding'].includes(e.type) && amount > 0) amount = -amount;
      const base = data.event_id ? 'E:' + data.event_id : 'C:' + [data.order_no || '', data.package_id || '', data.barcode || '', e.type || '?', data.event_date || '', amount].join('|');
      records.push({row, kind: 'finance_event', key: base + (events.length > 1 ? '#' + e.field : ''), keySource: data.event_id ? 'provider' : 'composite',
        data: {...data, type: e.type, amount_cents: amount, source_field: e.field}, issues: [...issues]});
    }
    if (!events.length) records.push({row, kind: 'finance_event', key: 'X:' + row, keySource: 'composite', data, issues: [...issues, issue('no_amount', null, 'Satırda tutar yok.')]});
  }
  // Kimliksiz ve aynı bileşik anahtarlı birden çok satır = belirsiz ikiz. Birleştirilmez, silinmez: ikisi de incelemeye.
  const count = new Map();
  for (const r of records) if (r.keySource === 'composite') count.set(r.key, (count.get(r.key) || 0) + 1);
  for (const r of records) if (r.keySource === 'composite' && count.get(r.key) > 1)
    r.issues.push(issue('ambiguous_twin', null, 'Aynı bilgilere sahip ' + count.get(r.key) + ' satır var ve kimlikleri yok; ayrı işlemler olabilir.'));
  return {records, skipped, unknownTypes: [...unknownTypes].filter(t => t !== undefined), totals};
}

/* ---------------- sürüm karşılaştırma ---------------- */
const stable = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const contentHash = data => stable(data);

/**
 * Önceki kayıt ile gelen kaydı karşılaştırır (Codex referansı core.mjs ile aynı kurallar).
 *   new | same | updated | older | review
 * Eksik alan önceki değeri silmez (birleştirme). Eski rapor güncel bilgiyi geri almaz.
 * Zaman eşit/bilinmiyorsa ve içerik farklıysa ya da kayıt ERP'ye bağlıysa: inceleme.
 */
// Deftere islenen alanlar: bunlar degistiyse insan bakmali. Durum ve teslim tarihi degil.
const PARA_ALANLARI = ['gross', 'net_revenue', 'quantity', 'barcode', 'sku', 'package_id', 'order_no', 'line_id', 'amount_cents', 'net_payout', 'type'];
function paraDegisti(eski, yeni) {
  return PARA_ALANLARI.some(k => (eski?.[k] ?? null) !== (yeni?.[k] ?? null));
}

export function compareVersions(prior, incoming) {
  if (!prior) return {outcome: 'new', data: incoming.data};
  const merged = {...prior.data, ...incoming.data};
  // observedTime: bu kaydı en son DOĞRULAYAN gözlem (içerik değişmese de ilerler).
  // dataTime: veriyi en son DEĞİŞTİREN rapor. Araya sonradan yüklenen eski rapor geri alamaz.
  const observed = prior.observedTime || prior.dataTime || prior.time || null;
  if (incoming.time && observed && incoming.time < observed) return {outcome: 'older', data: prior.data};
  if (stable(prior.data) === stable(merged))
    return {outcome: 'same', data: prior.data, advanceObservation: !!(incoming.time && (!observed || incoming.time > observed))};
  // Kilitli kayitta (sevk edilmis/teslim edilmis pakete bagli) degisiklik normalde INCELEMEYE
  // gider: para ve miktar alanlari deftere islenmistir. Ama teslim sureci ilerledikce durum ve
  // teslim tarihi DOGAL olarak degisir. Para, miktar, urun ve paket aynı kalıyorsa bu bir celiski
  // degil ilerlemedir; her teslimat icin kullaniciya is cikarmaz.
  if (prior.locked && incoming.time && observed && incoming.time > observed && !paraDegisti(prior.data, merged))
    return {outcome: 'updated', data: merged};
  if (prior.locked || !incoming.time || !observed || incoming.time === observed) return {outcome: 'review', data: prior.data, proposed: merged};
  return {outcome: 'updated', data: merged};
}

/* ---------------- kuruş ---------------- */
/** Toplamı koruyan dağıtım: 100 kuruş → 34 + 33 + 33. Eksi tutarda da toplam korunur. */
export function allocateCents(total, weights) {
  if (!Number.isSafeInteger(total) || !Array.isArray(weights) || !weights.length || weights.some(w => !Number.isSafeInteger(w) || w < 0))
    throw new Error('Kuruş ve ağırlıklar tam sayı olmalı.');
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) throw new Error('Dağıtım ağırlığı sıfır olamaz.');
  const magnitude = BigInt(Math.abs(total));
  const parts = weights.map((w, i) => ({i, amount: magnitude * BigInt(w) / sum, rest: magnitude * BigInt(w) % sum}));
  let remaining = magnitude - parts.reduce((s, p) => s + p.amount, 0n);
  for (const p of [...parts].sort((a, b) => a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1)) if (remaining > 0n) { p.amount++; remaining--; }
  return parts.map(p => Number(p.amount) * (total < 0 ? -1 : 1));
}

/** KDV dahil → KDV hariç (panelin netAmount yuvarlamasıyla aynı). */
export const exVat = (gross, vatBps) => Math.round(gross * 10000 / (10000 + vatBps));

/** Gözlem listesinden tahmin: ortanca, aralık ve örnek sayısı. Az örnekte tahmin YOK (sıfır değil). */
export function observedEstimate(values, minSamples = 3) {
  const v = values.filter(Number.isSafeInteger).sort((a, b) => a - b);
  if (v.length < minSamples) return null;
  const mid = v.length >> 1;
  return {value: v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2), low: v[0], high: v[v.length - 1], samples: v.length};
}
