// Tedarikçi alış faturası PDF'inden METİN okuma. Tarayıcıda çalışır, dış servis ÇAĞIRMAZ.
//
// Ne yapar: metin katmanı olan (bilgisayarda üretilmiş) PDF'in yazılarını satır satır çıkarır.
// Ne YAPMAZ: taranmış/fotoğraf PDF'i okuyamaz. Bu panelde OCR hizmeti YOKTUR; öyle bir belgede
// satırlar uydurulmaz, "metin katmanı yok" denir ve kullanıcı elle girer.
//
// Okunan her alan ADAYDIR: kullanıcı onaylamadan hiçbir tutar, miktar veya ürün kaydedilmez.
export const PDF_LIMITS = {fileBytes: 20 * 1024 * 1024, pages: 40, streams: 800, textItems: 20000, streamBytes: 40 * 1024 * 1024};

const fail = message => { throw Object.assign(new Error(message), {status: 400}); };
const LATIN = new TextDecoder('latin1');

/** Ham baytları PDF sözdizimi için latin1 metne çevirir (bayt ↔ karakter birebir). */
const raw = bytes => LATIN.decode(bytes);

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- akış çözme ---------------- */
async function inflate(bytes, kind) {
  // PDF'te FlateDecode = zlib sarmalı. Bozuk sarmalda ham deflate de denenir.
  for (const format of kind === 'zlib' ? ['deflate', 'deflate-raw'] : ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      if (out.length) return out;
    } catch { /* sıradaki biçim denenir */ }
  }
  return null;
}

/** PDF'teki "a b obj ... endobj" nesnelerini sırayla döndürür. */
function objects(text) {
  const list = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = text.indexOf('endobj', m.index);
    if (end < 0) continue;
    list.push({num: Number(m[1]), start: m.index + m[0].length, end, body: text.slice(m.index + m[0].length, end)});
    if (list.length > 20000) break;
  }
  return list;
}

/** Nesnenin gövdesindeki stream baytlarını (varsa çözülmüş olarak) verir. */
async function streamOf(obj, bytes, text) {
  const at = obj.body.indexOf('stream');
  if (at < 0) return null;
  const dict = obj.body.slice(0, at);
  let from = obj.start + at + 'stream'.length;
  if (text[from] === '\r') from++;
  if (text[from] === '\n') from++;
  const endAt = text.indexOf('endstream', from);
  if (endAt < 0) return null;
  let data = bytes.subarray(from, endAt);
  if (data.length > PDF_LIMITS.streamBytes) fail('PDF içinde beklenmeyen büyüklükte bir bölüm var.');
  if (/\/FlateDecode/.test(dict)) data = await inflate(data, 'zlib');
  else if (/\/(LZWDecode|RunLengthDecode|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) return null;
  return data ? {dict, data} : null;
}

/* ---------------- ToUnicode (alt küme yazı tipleri) ---------------- */
// Türkçe faturalarda yazı tipi çoğu kez alt kümedir: kod → harf eşlemesi ToUnicode'dan gelir.
function parseToUnicode(text) {
  const map = new Map();
  const hex = h => h.length <= 4 ? String.fromCharCode(parseInt(h, 16))
    : (h.match(/.{1,4}/g) || []).map(p => String.fromCharCode(parseInt(p, 16))).join('');
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || [])
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), hex(m[2]));
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), start = parseInt(m[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(start + (c - lo)));
    }
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const items = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => hex(x[1]));
      items.forEach((v, i) => map.set(lo + i, v));
    }
  }
  return map;
}

/* ---------------- içerik akışındaki metin ---------------- */
const OCTAL = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\'};

/** PDF dizgisi: (metin) ya da <hex>. */
function readString(s, i) {
  if (s[i] === '(') {
    let depth = 1, out = '', j = i + 1;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (c === '\\') {
        const n = s[j + 1];
        if (n >= '0' && n <= '7') { const m = /^[0-7]{1,3}/.exec(s.slice(j + 1))[0]; out += String.fromCharCode(parseInt(m, 8)); j += 1 + m.length; continue; }
        out += OCTAL[n] !== undefined ? OCTAL[n] : n === '\n' ? '' : n; j += 2; continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (!depth) { j++; break; } }
      out += c; j++;
    }
    return {value: out, next: j, hex: false};
  }
  const end = s.indexOf('>', i);
  if (end < 0) return null;
  return {value: s.slice(i + 1, end), next: end + 1, hex: true};
}

const decodeShown = (value, isHex, font) => {
  if (font && font.size) {
    // Alt küme yazı tipi: kodlar ToUnicode ile çözülür. Hex'te 2 baytlık kodlar yaygındır.
    const codes = isHex ? (value.match(/.{1,4}/g) || []).map(h => parseInt(h.padEnd(4, '0'), 16))
      : [...value].map(c => c.charCodeAt(0));
    return codes.map(c => font.get(c) ?? font.get(c & 0xff) ?? '').join('');
  }
  if (isHex) {
    const pairs = value.match(/.{1,2}/g) || [];
    return pairs.map(h => String.fromCharCode(parseInt(h.padEnd(2, '0'), 16))).join('');
  }
  return value;
};

// PDFDocEncoding/WinAnsi'de Türkçe harfler bu konumlardadır.
const WINANSI = {0x80: '€', 0x8a: 'Š', 0x8e: 'Ž', 0x9a: 'š', 0x9e: 'ž', 0x9f: 'Ÿ', 0xd0: 'Ğ', 0xdd: 'İ', 0xde: 'Ş', 0xf0: 'ğ', 0xfd: 'ı', 0xfe: 'ş'};
const fixLatin = s => [...s].map(c => WINANSI[c.charCodeAt(0)] || c).join('');

/**
 * Bir içerik akışından konumlu metin parçaları çıkarır.
 * Dönen her parça: {text, x, y}
 */
function textItems(content, fonts) {
  const items = [];
  let font = null, tm = null, line = null;
  const push = (text, x, y) => { if (text) items.push({text, x, y}); };
  for (let i = 0; i < content.length && items.length < PDF_LIMITS.textItems; i++) {
    const c = content[i];
    if (c === '(' || c === '<') {
      // Dizgiyi oku, ardından hangi işleçle gösterildiğine bak.
      if (c === '<' && content[i + 1] === '<') { i++; continue; }
      const s = readString(content, i);
      if (!s) continue;
      const after = content.slice(s.next, s.next + 40);
      const op = /^\s*(Tj|TJ|'|")/.exec(after);
      const inArray = /^\s*[\]\-\d.\s]*\]\s*TJ/.test(after) || /^\s*[-\d.]/.test(after);
      if (op || inArray) {
        const shown = fixLatin(decodeShown(s.value, s.hex, font));
        push(shown, line ? line[4] : 0, line ? line[5] : 0);
      }
      i = s.next - 1;
      continue;
    }
    const op = /^(BT|ET|T\*|Td|TD|Tm|Tf)\b/.exec(content.slice(i, i + 4));
    if (!op) continue;
    const before = content.slice(Math.max(0, i - 120), i);
    if (op[1] === 'BT') { tm = [1, 0, 0, 1, 0, 0]; line = [...tm]; }
    else if (op[1] === 'ET') { tm = null; line = null; }
    else if (op[1] === 'Tf') { const f = /\/([^\s/]+)\s*[\d.]+\s*$/.exec(before); font = f ? fonts.get(f[1]) || null : null; }
    else if (op[1] === 'Tm') { const n = before.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (n) line = n.slice(1).map(Number); }
    else if (op[1] === 'Td' || op[1] === 'TD') { const n = before.match(/(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (n && line) { line = [...line]; line[4] += Number(n[1]); line[5] += Number(n[2]); } }
    else if (op[1] === 'T*') { if (line) { line = [...line]; line[5] -= 12; } }
    i += op[1].length - 1;
  }
  return items;
}

/** Konumlu parçaları okunabilir satırlara toplar. */
function toLines(items) {
  const rows = new Map();
  for (const it of items) {
    const key = Math.round(it.y / 3);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([, list]) => list.sort((a, b) => a.x - b.x).map(i => i.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * PDF'i okur.
 *   {pages, textLayer, lines, text, warnings}
 * textLayer=false ise belge taranmıştır: satır ÇIKARILMAZ, uydurulmaz.
 */
export async function readPdf(input, {name = ''} = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) fail('Dosya boş.');
  if (bytes.length > PDF_LIMITS.fileBytes) fail('PDF 20 MB sınırını aşıyor.');
  const head = raw(bytes.subarray(0, 1024));
  if (!head.startsWith('%PDF-')) fail(name ? '"' + name + '" bir PDF dosyası değil.' : 'Bu dosya bir PDF değil.');
  const text = raw(bytes);
  if (/\/Encrypt\b/.test(text)) fail('PDF şifreli. Şifresiz bir kopya kaydedip yükleyin.');

  const warnings = [];
  const pages = Math.min((text.match(/\/Type\s*\/Page\b/g) || []).length || 1, PDF_LIMITS.pages);
  if ((text.match(/\/Type\s*\/Page\b/g) || []).length > PDF_LIMITS.pages)
    warnings.push('Belge ' + PDF_LIMITS.pages + ' sayfadan uzun; yalnız ilk sayfalar okundu. Toplamları belgeyle karşılaştırın.');

  const all = objects(text);
  // 1) Yazı tipi kod→harf tabloları.
  const unicodeByObj = new Map();
  for (const obj of all) {
    if (!/\/Type\s*\/Font|beginbfchar|beginbfrange/.test(obj.body)) continue;
    const s = await streamOf(obj, bytes, text);
    if (s && /beginbfchar|beginbfrange/.test(raw(s.data))) unicodeByObj.set(obj.num, parseToUnicode(raw(s.data)));
  }
  // Kaynak adı (/F1 gibi) → ToUnicode tablosu.
  const fonts = new Map();
  for (const obj of all) {
    for (const m of obj.body.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const target = all.find(o => o.num === Number(m[2]));
      if (!target) continue;
      const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(target.body);
      const table = ref ? unicodeByObj.get(Number(ref[1])) : unicodeByObj.get(target.num);
      if (table && table.size) fonts.set(m[1], table);
    }
  }

  // 2) İçerik akışları.
  const items = [];
  let streams = 0;
  for (const obj of all) {
    if (streams >= PDF_LIMITS.streams) break;
    if (!obj.body.includes('stream')) continue;
    if (/\/Type\s*\/(Font|XObject|Metadata|ObjStm)\b/.test(obj.body) && !/\/Subtype\s*\/Form/.test(obj.body)) continue;
    const s = await streamOf(obj, bytes, text);
    if (!s) continue;
    const content = raw(s.data);
    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(content)) continue;
    streams++;
    items.push(...textItems(content, fonts));
  }

  const lines = toLines(items);
  const joined = lines.join('\n');
  const textLayer = joined.replace(/\s/g, '').length >= 40;
  if (!textLayer)
    warnings.push('Bu PDF\'te okunabilir metin katmanı yok; büyük olasılıkla taranmış veya fotoğraflanmış. Bu panelde OCR (görüntüden yazı okuma) hizmeti bulunmuyor, bu yüzden satırlar okunamadı. Belgeyi ekranda görüp bilgileri elle girebilirsiniz.');
  return {pages, textLayer, lines: textLayer ? lines : [], text: textLayer ? joined : '', warnings};
}

/* ---------------- fatura alanı adayları ---------------- */
// Buradan çıkan HER ŞEY adaydır ve ekranda "kontrol edin" diye işaretlenir.
// Bulunamayan alan boş bırakılır; tahmin edilmez.

const TR_NUMBER = /^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/;
const toNumber = s => {
  const t = String(s).trim();
  if (!TR_NUMBER.test(t)) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Fatura başlık alanları: bulunamayan alan boş kalır. */
export function guessHeader(lines) {
  const text = lines.join('\n');
  const out = {invoice_no: '', invoice_date: '', uuid: '', supplier_tax_id: '', supplier_name: '', uncertain: []};
  const ettn = /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/.exec(text);
  if (ettn) out.uuid = ettn[1].toLowerCase();
  const no = /(?:Fatura\s*(?:No|Numaras[ıi])|Belge\s*No)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{4,30})/i.exec(text);
  if (no) out.invoice_no = no[1].trim(); else out.uncertain.push('invoice_no');
  const date = /(?:Fatura\s*Tarihi|D[üu]zenleme\s*Tarihi|Tarih)\s*[:.]?\s*(\d{2})[./-](\d{2})[./-](\d{4})/i.exec(text);
  if (date) out.invoice_date = date[3] + '-' + date[2] + '-' + date[1]; else out.uncertain.push('invoice_date');
  // VKN 10, TCKN 11 hane. Kendi numaramız da belgede geçer; ikisi de aday olarak sunulur.
  const ids = [...text.matchAll(/(?:VKN|TCKN|Vergi\s*(?:Kimlik\s*)?No)\s*[:.]?\s*(\d{10,11})/gi)].map(m => m[1]);
  if (ids.length) { out.supplier_tax_id = ids[0]; if (ids.length > 1) out.uncertain.push('supplier_tax_id'); }
  else out.uncertain.push('supplier_tax_id');
  const name = lines.find(l => /(?:A\.?Ş|LTD|LİMİTED|LIMITED|ŞTİ|SAN\.|TİC\.)/i.test(l) && l.length < 120);
  if (name) out.supplier_name = name.trim(); else out.uncertain.push('supplier_name');
  return out;
}

/**
 * Satır adayları. Bir satırda miktar + birim + tutar birlikte görünüyorsa kalem sayılır.
 * Emin olunamayan alan null bırakılır; miktar/vergi/ürün UYDURULMAZ.
 */
export function guessLines(lines) {
  const units = '(adet|ad|kutu|koli|paket|pk|kg|gr|g|lt|l|ml|m|m2|m3|ton|çift|cift|rulo|top|dm3)';
  const re = new RegExp('^(.{3,140}?)\\s+(-?[\\d.,]+)\\s*' + units + '\\b(.*)$', 'i');
  const out = [];
  for (const line of lines) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const quantity = toNumber(m[2]);
    if (!quantity || quantity <= 0) continue;
    const amounts = (m[4].match(/-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}/g) || []).map(toNumber).filter(n => n !== null);
    if (!amounts.length) continue;
    // Kalan sütunlarda genellikle: birim fiyat … KDV oranı … KDV tutarı … satır toplamı.
    const rate = /(?:^|\s)%?\s*(0|1|8|10|18|20)\s*(?:%|\s|$)/.exec(m[4]);
    const net = amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[0];
    const tax = amounts.length >= 2 ? amounts[amounts.length - 1] : null;
    out.push({
      description: m[1].replace(/\s+/g, ' ').trim(),
      external_code: (/^([A-Z0-9][A-Z0-9._-]{2,24})\s/.exec(m[1]) || [])[1] || '',
      invoice_quantity: quantity,
      invoice_unit: m[3].toLowerCase(),
      net, tax,
      vat_rate: rate ? Number(rate[1]) : null,
      uncertain: [...(tax === null ? ['tax'] : []), ...(rate ? [] : ['vat_rate'])]
    });
    if (out.length >= 40) break;
  }
  return out;
}

/** Belgede yazan genel toplamlar: kullanıcı satır toplamlarıyla karşılaştırsın diye. */
export function guessTotals(lines) {
  const text = lines.join('\n');
  const pick = pattern => {
    const m = new RegExp(pattern + '\\s*[:.]?\\s*(?:TL|TRY)?\\s*(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2})', 'i').exec(text);
    return m ? toNumber(m[1]) : null;
  };
  return {
    net: pick('(?:Mal\\s*/?\\s*Hizmet\\s*Toplam[ıi]|Ara\\s*Toplam|KDV\\s*Hari[çc]\\s*Toplam)'),
    tax: pick('(?:Hesaplanan\\s*KDV|KDV\\s*Toplam[ıi]|Toplam\\s*KDV)'),
    gross: pick('(?:[ÖO]denecek\\s*Tutar|Vergiler\\s*Dahil\\s*Toplam|Genel\\s*Toplam)')
  };
}
