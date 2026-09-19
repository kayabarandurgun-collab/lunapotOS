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
  // Nesne akışından açılan nesne (start<0) akış taşıyamaz.
  if (obj.start < 0) return null;
  const at = obj.body.indexOf('stream');
  if (at < 0) return null;
  const dict = obj.body.slice(0, at);
  let from = obj.start + at + 'stream'.length;
  if (text[from] === '\r') from++;
  if (text[from] === '\n') from++;
  // Akışın uzunluğu SÖZLÜKTE yazar. 'endstream'e kadar okumak, arada duran satır sonu
  // baytlarını da içine alır; açma "Trailing junk found" diye patlar ve akış SESSİZCE atlanır.
  // PDF'lerin çoğunda 'endstream' öncesinde satır sonu bulunur, yani bu okuyucu metin taşıyan
  // belgelerin büyük kısmını "taranmış" sanıyordu. Önce /Length kullanılır; yoksa satır
  // sonları kırpılır. Uzunluk 'endstream'i aşıyorsa güvenilmez sayılır ve kırpma yoluna gidilir.
  const endAt = text.indexOf('endstream', from);
  if (endAt < 0) return null;
  const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  let to = endAt;
  if (declared && from + Number(declared[1]) <= endAt) to = from + Number(declared[1]);
  else while (to > from && (text.charCodeAt(to - 1) === 10 || text.charCodeAt(to - 1) === 13)) to--;
  let data = bytes.subarray(from, to);
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

/** Gösterilen dizginin genişliği (em cinsinden). Genişlik tablosu yoksa null: tahmin edilmez. */
const shownWidth = (value, isHex, font) => {
  const w = font?.widths;
  if (!w) return null;
  // CID yazı tipinde kod İKİ bayttır; (…) biçiminde yazılmış dizgide de.
  const bytes = isHex ? (value.match(/.{1,2}/g) || []).map(h => parseInt(h.padEnd(2, '0'), 16)) : [...value].map(c => c.charCodeAt(0) & 0xff);
  const codes = w.cid ? bytes.reduce((a, b, i) => (i % 2 ? a[a.length - 1] = a[a.length - 1] * 256 + b : a.push(b), a), []) : bytes;
  return {em: codes.reduce((s, c) => s + (w.map.get(c) ?? w.dw), 0) / 1000, count: codes.length};
};

/** Yazı tipinin harf genişlikleri: Type0 → alt yazı tipinin /W'si, basit yazı tipi → /Widths. */
function fontWidths(fontObj, byNum) {
  const resolve = (body, key) => {
    const ref = new RegExp('\\/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(body);
    if (ref) return byNum.get(Number(ref[1]))?.body ?? null;
    const at = body.search(new RegExp('\\/' + key + '\\s*\\['));
    if (at < 0) return null;
    // İç içe köşeli parantezli diziyi sonuna kadar al.
    let depth = 0, i = body.indexOf('[', at);
    for (let j = i; j < body.length; j++) {
      if (body[j] === '[') depth++;
      else if (body[j] === ']' && !--depth) return body.slice(i, j + 1);
    }
    return null;
  };
  const map = new Map();
  const desc = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(fontObj.body);
  if (desc) {
    const cid = byNum.get(Number(desc[1]))?.body || '';
    const w = resolve(cid, 'W');
    const dw = /\/DW\s+([\d.]+)/.exec(cid);
    if (w) {
      // c [w1 w2 …]  ya da  c1 c2 w
      const tok = w.slice(1, -1).match(/\[[^\]]*\]|-?[\d.]+/g) || [];
      for (let i = 0; i < tok.length;) {
        const c = Number(tok[i]);
        if (tok[i + 1]?.startsWith('[')) {
          (tok[i + 1].match(/-?[\d.]+/g) || []).forEach((v, k) => map.set(c + k, Number(v)));
          i += 2;
        } else if (tok[i + 2] !== undefined) {
          for (let k = c; k <= Number(tok[i + 1]) && k - c < 65536; k++) map.set(k, Number(tok[i + 2]));
          i += 3;
        } else break;
      }
    }
    return map.size ? {map, dw: dw ? Number(dw[1]) : 1000, cid: true} : null;
  }
  const first = /\/FirstChar\s+(\d+)/.exec(fontObj.body), widths = resolve(fontObj.body, 'Widths');
  if (!first || !widths) return null;
  (widths.match(/-?[\d.]+/g) || []).forEach((v, k) => map.set(Number(first[1]) + k, Number(v)));
  return map.size ? {map, dw: 0, cid: false} : null;
}

// PDFDocEncoding/WinAnsi'de Türkçe harfler bu konumlardadır.
const WINANSI = {0x80: '€', 0x8a: 'Š', 0x8e: 'Ž', 0x9a: 'š', 0x9e: 'ž', 0x9f: 'Ÿ', 0xd0: 'Ğ', 0xdd: 'İ', 0xde: 'Ş', 0xf0: 'ğ', 0xfd: 'ı', 0xfe: 'ş'};
const fixLatin = s => [...s].map(c => WINANSI[c.charCodeAt(0)] || c).join('');

/**
 * Bir içerik akışından konumlu metin parçaları çıkarır.
 * Dönen her parça: {text, x, y}
 */
// Sayfa koordinatı 'cm' ile dönüştürülebilir. Bazı üreticiler (HTML'den PDF basanlar) sayfayı
// "0.24 0 0 -0.24 0 842 cm" ile TERS çevirir: Y aşağı doğru büyür. Dönüşüm izlenmezse satırlar
// alttan üste dizilir ve tablo satırı açıklamasından kopar. Bu yüzden q/Q yığını ve cm izlenir,
// her parça CİHAZ koordinatında (yukarı = büyük Y) konumlanır.
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

function textItems(content, fonts) {
  const items = [];
  let font = null, size = 12, tm = null, line = null, ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = '', pendingW = 0, adv = 0, charSpace = 0;
  // width: yazı uzayında genişlik (bilinmiyorsa null). Parça yazıldıktan sonra satır başı
  // genişlik kadar ilerler: aynı BT içindeki ardışık Tj'ler üst üste konumlanmaz.
  const push = (text, lx, ly, width) => {
    if (!text) return;
    // Td/TD/T* SATIR BAŞINA (Tlm) göredir; yazılan parça yalnız o anki yazı konumunu ilerletir.
    const base = line ? mul([1, 0, 0, 1, adv, 0], line) : [1, 0, 0, 1, lx, ly];
    const m = mul(base, ctm);
    // Etkin yazı boyu: satır matrisinin ve sayfa dönüşümünün dikey ölçeği.
    const scale = Math.hypot(m[2], m[3]) || 1;
    const across = Math.hypot(m[0], m[1]) || 1;
    items.push({text, x: m[4], y: m[5], size: size * scale, w: width === null ? null : width * across});
    if (width !== null) adv += width;
  };
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
        // TJ dizisindeki parçalar TEK yazıdır; aradaki sayılar harf aralığı ayarıdır, boşluk
        // değil. Yalnız büyük bir geri kaydırma (< -200, binde em) sözcük arası sayılır.
        pending += fixLatin(decodeShown(s.value, s.hex, font));
        const sw = shownWidth(s.value, s.hex, font);
        // Tc: her harfe eklenen aralık (yazı uzayı birimi).
        pendingW = pendingW === null || sw === null ? null : pendingW + sw.em * size + sw.count * charSpace;
        const last = op || /^\s*[\]\-\d.\s]*\]\s*TJ/.test(after);
        const kern = /^\s*(-?[\d.]+)/.exec(after);
        if (!last && kern) {
          if (Number(kern[1]) < -200) pending += ' ';
          if (pendingW !== null) pendingW -= Number(kern[1]) / 1000 * size;
        }
        if (last) { push(pending, line ? line[4] : 0, line ? line[5] : 0, pendingW); pending = ''; pendingW = 0; }
      }
      i = s.next - 1;
      continue;
    }
    // İşleç yalnız kelime sınırında sayılır: "/Q1" gibi ad ya da "cmyk" içindeki harf işleç değildir.
    if (i > 0 && !/[\s\]>)]/.test(content[i - 1])) continue;
    const op = /^(BT|ET|T\*|Td|TD|Tm|Tf|Tc|cm|q|Q)(?![A-Za-z0-9*'"])/.exec(content.slice(i, i + 4));
    if (!op) continue;
    const before = content.slice(Math.max(0, i - 120), i);
    if (op[1] === 'q') stack.push(ctm);
    else if (op[1] === 'Q') ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (op[1] === 'cm') { const n = before.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (n) ctm = mul(n.slice(1).map(Number), ctm); }
    else if (op[1] === 'Tc') { const n = /(-?[\d.]+)\s*$/.exec(before); charSpace = n ? Number(n[1]) : 0; }
    else if (op[1] === 'BT') { tm = [1, 0, 0, 1, 0, 0]; line = [...tm]; adv = 0; }
    else if (op[1] === 'ET') { tm = null; line = null; }
    else if (op[1] === 'Tf') { const f = /\/([^\s/]+)\s*(-?[\d.]+)\s*$/.exec(before); font = f ? fonts.get(f[1]) || null : null; if (f && Number(f[2])) size = Math.abs(Number(f[2])); }
    else if (op[1] === 'Tm') { const n = before.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (n) { line = n.slice(1).map(Number); adv = 0; } }
    else if (op[1] === 'Td' || op[1] === 'TD') { const n = before.match(/(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (n && line) { line = mul([1, 0, 0, 1, Number(n[1]), Number(n[2])], line); adv = 0; } }
    else if (op[1] === 'T*') { if (line) { line = mul([1, 0, 0, 1, 0, -size * 1.2], line); adv = 0; } }
    i += op[1].length - 1;
  }
  return items;
}

/** Konumlu parçaları okunabilir satırlara toplar. */
// Satır: dikey konumu yazı boyunun üçte birinden yakın parçalar. Sabit bir eşik (eskiden 3 birim)
// küçük ölçekli sayfada ardışık satırları birleştirir, büyük ölçeklide aynı satırı böler.
// Parça arası: genişlik biliniyorsa önceki parçanın BİTİŞİNE göre bakılır; bitişikse aynı
// sözcüktür, boşluk konmaz. Genişlik bilinmiyorsa eski davranış: araya boşluk.
function toLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    const tol = Math.max(0.5, 0.33 * Math.min(it.size || 12, row?.size || 12));
    if (row && Math.abs(row.y - it.y) <= tol) row.list.push(it);
    else rows.push({y: it.y, size: it.size || 12, list: [it]});
  }
  return rows.map(({list}) => {
    list.sort((a, b) => a.x - b.x);
    let out = '';
    list.forEach((it, k) => {
      const prev = list[k - 1];
      const glued = prev && prev.w !== null && prev.w !== undefined &&
        it.x - (prev.x + prev.w) < 0.15 * Math.min(prev.size || 12, it.size || 12);
      out += (k && !glued ? ' ' : '') + it.text;
    });
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
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
  const all = objects(text);
  // SIKIŞTIRILMIŞ NESNE AKIŞI (/ObjStm). PDF 1.5+ üreticileri yazı tipi sözlüklerini, ToUnicode
  // başvurularını ve sayfa sözlüklerini buraya koyar; düz metinde görünmezler. Açılmazsa kod→harf
  // tablosu bulunamaz ve kodlar ANLAMSIZ metin olarak "okunmuş" sayılır. Akıştaki nesneler (kendileri
  // akış taşıyamaz) listeye eklenir; aramalar bu genişletilmiş metin üzerinde yapılır.
  let ekMetin = '';
  for (const obj of [...all]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.body)) continue;
    const s = await streamOf(obj, bytes, text);
    if (!s) continue;
    const icerik = raw(s.data), n = Number(/\/N\s+(\d+)/.exec(s.dict)?.[1]), ilk = Number(/\/First\s+(\d+)/.exec(s.dict)?.[1]);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(ilk) || ilk > icerik.length) continue;
    const sayilar = icerik.slice(0, ilk).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && all.length <= 20000; i++) {
      const num = sayilar[2 * i], bas = ilk + sayilar[2 * i + 1], son = i + 1 < n ? ilk + sayilar[2 * i + 3] : icerik.length;
      if (!Number.isSafeInteger(num) || !(bas >= ilk) || !(son >= bas)) break;
      const body = icerik.slice(bas, son);
      all.push({num, start: -1, end: -1, body});
      ekMetin += '\n' + body;
    }
  }
  const tumMetin = ekMetin ? text + ekMetin : text;
  const sayfaSayisi = (tumMetin.match(/\/Type\s*\/Page\b/g) || []).length;
  const pages = Math.min(sayfaSayisi || 1, PDF_LIMITS.pages);
  if (sayfaSayisi > PDF_LIMITS.pages)
    warnings.push('Belge ' + PDF_LIMITS.pages + ' sayfadan uzun; yalnız ilk sayfalar okundu. Toplamları belgeyle karşılaştırın.');

  // 1) Yazı tipi kod→harf tabloları.
  const unicodeByObj = new Map();
  // ToUnicode tablosu AYRI bir nesnededir ve SIKIŞTIRILMIŞTIR: gövdesinde ne '/Type /Font'
  // ne de 'beginbfchar' yazar — ikisi de ancak açıldıktan sonra ortaya çıkar. Yalnız gövdeye
  // bakan bir süzgeç bu tabloları hiç açmaz; metin okunur ama kodlar çözülemediği için
  // anlamsız çıkar. Bu yüzden önce /ToUnicode ile GÖSTERİLEN nesne numaraları toplanır.
  const toUnicodeRefs = new Set([...tumMetin.matchAll(/\/ToUnicode\s+(\d+)\s+\d+\s+R/g)].map(m => Number(m[1])));
  for (const obj of all) {
    if (!toUnicodeRefs.has(obj.num) && !/\/Type\s*\/Font|beginbfchar|beginbfrange/.test(obj.body)) continue;
    const s = await streamOf(obj, bytes, text);
    if (s && /beginbfchar|beginbfrange/.test(raw(s.data))) unicodeByObj.set(obj.num, parseToUnicode(raw(s.data)));
  }
  // Yazı tipi nesnesi → kod→harf tablosu + harf GENİŞLİKLERİ. Genişlik, aynı sözcüğün
  // harf aralığı ayarıyla bölünmüş parçalarını ("Li"+"tr"+"e") gerçek sözcük arasından
  // ayırmanın tek güvenilir yoludur; harf sayısından tahmin iki durumu karıştırıyordu.
  const byNum = new Map(all.map(o => [o.num, o]));
  const tableOf = num => {
    const target = byNum.get(num);
    if (!target) return null;
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(target.body);
    const table = ref ? unicodeByObj.get(Number(ref[1])) : unicodeByObj.get(target.num);
    if (!table || !table.size) return null;
    const font = new Map(table);
    font.widths = fontWidths(target, byNum);
    return font;
  };
  // Kaynak adı (/F1 gibi) → yazı tipi.
  const fonts = new Map();
  for (const obj of all) {
    for (const m of obj.body.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const font = tableOf(Number(m[2]));
      if (font) fonts.set(m[1], font);
    }
  }

  // Hangi içerik akışının hangi SAYFAYA ait olduğu izlenir. Bütün sayfaların yazıları tek
  // torbaya dökülüp Y koordinatına göre sıralanırsa 2. sayfanın satırları 1. sayfanınkilerin
  // arasına karışır: tek sayfalık belgede fark etmez, çok sayfalıda ve birleştirilmiş PDF'te
  // veriyi bozar. Eşleme kurulamazsa sayfa bölmesi UYDURULMAZ, eski davranış sürer.
  const pageOfContent = new Map();
  // Yazı tipi kaynak adları SAYFA BAŞINA tanımlıdır: /F11 birinci sayfada başka nesne,
  // ikinci sayfada başkadır. Tek ortak ad→tablo haritası tutmak sonraki sayfanın tablosunu
  // öncekinin üstüne yazar ve o sayfanın yazıları çözülemez — etiketler okunur, TUTARLAR boş
  // çıkar. Bu yüzden her sayfanın kendi tablosu kurulur.
  const fontsByPage = new Map();
  let pageSeq = 0;
  for (const obj of all) {
    if (!/\/Type\s*\/Page[^s]/.test(obj.body + ' ')) continue;
    const order = pageSeq++;
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(obj.body);
    if (fontDict) {
      const map = new Map();
      for (const m of fontDict[1].matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
        const table = tableOf(Number(m[2]));
        if (table) map.set(m[1], table);
      }
      if (map.size) fontsByPage.set(order, map);
    }
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(obj.body);
    if (single) { pageOfContent.set(Number(single[1]), order); continue; }
    const many = /\/Contents\s*\[([^\]]*)\]/.exec(obj.body);
    if (many) for (const m of many[1].matchAll(/(\d+)\s+\d+\s+R/g)) pageOfContent.set(Number(m[1]), order);
  }

  // 2) İçerik akışları.
  const items = [];
  const itemsByPage = new Map();
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
    const order = pageOfContent.has(obj.num) ? pageOfContent.get(obj.num) : null;
    // Sayfanın kendi tablosu varsa o kullanılır; yoksa genel harita (eski davranış).
    const found = textItems(content, order !== null && fontsByPage.has(order) ? fontsByPage.get(order) : fonts);
    items.push(...found);
    if (order !== null) {
      if (!itemsByPage.has(order)) itemsByPage.set(order, []);
      itemsByPage.get(order).push(...found);
    }
  }

  // pageLines: sayfa sayfa satırlar. Birleştirilmiş PDF'i faturalara ayırmak buna dayanır.
  const pageLines = [...itemsByPage.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => toLines(list));
  const lines = pageLines.length ? pageLines.flat() : toLines(items);
  const joined = lines.join('\n');
  // Çözülemeyen yazı tipi kodları kontrol karakteri olarak gelir (\x00\x0E…): bu METİN DEĞİLDİR.
  // Anlamsız çıktıyı "okundu" saymak fatura satırlarını bozar; o durumda metin katmanı yok denir.
  const gorunur = joined.replace(/\s/g, ''), bozuk = (gorunur.match(/[\x00-\x1f�]/g) || []).length;
  const textLayer = gorunur.length >= 40 && bozuk / gorunur.length < 0.05;
  if (!textLayer)
    warnings.push('Bu PDF\'te okunabilir metin katmanı yok; büyük olasılıkla taranmış veya fotoğraflanmış. Bu panelde OCR (görüntüden yazı okuma) hizmeti bulunmuyor, bu yüzden satırlar okunamadı. Belgeyi ekranda görüp bilgileri elle girebilirsiniz.');
  return {pages, textLayer, lines: textLayer ? lines : [], pageLines: textLayer ? pageLines : [], text: textLayer ? joined : '', warnings};
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

const round2 = n => Math.round(n * 100) / 100;
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 0.011;
// Normalleştirilmiş harf dizisi: büyük/küçük, boşluk ve noktalama farkı karşılaştırmayı bozmasın.
const letters = s => String(s || '').toLocaleUpperCase('tr').replace(/[^A-ZÇĞİÖŞÜ0-9]/g, '');

/**
 * Fatura başlık alanları: bulunamayan alan boş kalır.
 * own: {taxIds:[], name:''} — bu çalışma alanının şirketi. Faturada ALICI olarak geçer;
 * tedarikçi VKN'si ve unvanı sanılmamalı. Belgede iki VKN vardır, hangisinin satıcı olduğu
 * sıraya bakılarak TAHMİN EDİLMEZ: kendi numaramız çıkarılır, geriye tek numara kalırsa odur.
 */
export function guessHeader(lines, own = {}) {
  const text = lines.join('\n');
  const ownIds = new Set((own.taxIds || []).map(String).filter(Boolean));
  const ownName = letters(own.name);
  const out = {invoice_no: '', invoice_date: '', uuid: '', supplier_tax_id: '', supplier_name: '', receiver_tax_id: '', tax_ids: [], uncertain: []};
  const ettn = /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/.exec(text);
  if (ettn) out.uuid = ettn[1].toLowerCase();
  const no = /(?:Fatura\s*(?:No|Numaras[ıi])|Belge\s*No)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{4,30})/i.exec(text);
  if (no) out.invoice_no = no[1].trim(); else out.uncertain.push('invoice_no');
  // Tarih bazı belgelerde "15 - 09 - 2026" diye aralıklı yazılır. Önce FATURA tarihi aranır;
  // düzenleme tarihi ancak o yoksa kullanılır (ikisi farklı olabilir).
  // Ayraç olarak görünmez "yumuşak tire" (U+00AD) ve tipografik tireler de kullanılır.
  const DATE = '\\s*[:.]?\\s*(\\d{2})\\s*[./\\-\\u00AD\\u2010-\\u2015]\\s*(\\d{2})\\s*[./\\-\\u00AD\\u2010-\\u2015]\\s*(\\d{4})';
  const date = ['Fatura\\s*Tarihi', 'D[üu]zenleme\\s*Tarihi', 'Tarih'].map(l => new RegExp('(?:' + l + ')' + DATE, 'i').exec(text)).find(Boolean);
  if (date) out.invoice_date = date[3] + '-' + date[2] + '-' + date[1]; else out.uncertain.push('invoice_date');
  // VKN 10, TCKN 11 hane. Kendi numaramız da belgede geçer: alıcıdır, tedarikçi değil.
  const ids = [...new Set([...text.matchAll(/(?:VKN|TCKN|Vergi\s*(?:Kimlik\s*)?No)\s*[:.]?\s*(\d{10,11})\b/gi)].map(m => m[1]))];
  // 11111111111 e-Arşiv'de nihai tüketiciye verilen genel numaradır; tedarikçi olamaz.
  const theirs = ids.filter(id => !ownIds.has(id) && !/^1{10,11}$/.test(id));
  const mine = ids.find(id => ownIds.has(id));
  if (mine) out.receiver_tax_id = mine;
  // Belgedeki İLK numara bizimse faturayı biz kesmişizdir (satış faturası): alış olarak işlenmez.
  if (ids.length && ownIds.has(ids[0])) out.own_issued = true;
  out.tax_ids = theirs;
  if (theirs.length && !out.own_issued) { out.supplier_tax_id = theirs[0]; if (theirs.length > 1) out.uncertain.push('supplier_tax_id'); }
  else out.uncertain.push('supplier_tax_id');
  // Unvan: şirket eki taşıyan ilk satır — kendi unvanımızın parçası olan satır hariç. Eki tek
  // başına taşıyan kısa satır ("İhr.Tic.Ltd.Şti.") bir üstteki satırın devamıdır.
  const isOwn = l => ownName && letters(l).length >= 6 && ownName.includes(letters(l));
  const at = lines.findIndex(l => /(?:A\.?Ş|LTD|LİMİTED|LIMITED|ŞTİ|SAN\.|TİC\.)/i.test(l) && l.length < 120 && !isOwn(l));
  if (at >= 0) {
    let name = lines[at].trim();
    if (name.length < 25 && at > 0 && !/\d/.test(lines[at - 1]) && !isOwn(lines[at - 1])) name = lines[at - 1].trim() + name;
    out.supplier_name = name;
  } else out.uncertain.push('supplier_name');
  return out;
}

const UNITS = '(adet|ad|kutu|koli|paket|pk|kg|gr|g|lt|l|ml|m|m2|m3|ton|çift|cift|rulo|top|dm3)';
// Kalem satırı: [sıra/kod/ad] MİKTAR BİRİM ve ardından en az bir kuruşlu tutar. Birim sözcüğü ada
// da girebilir ("10 LT"); açgözlü ön ek SON miktar+birim çiftini seçer.
// Miktar ile birim bitişik de yazılabilir ("72kg").
const ROW = new RegExp('^(?:(.*)\\s)?(\\d+(?:,\\d+)?)\\s*' + UNITS + '\\s+(.*\\d,\\d{2}.*)$', 'i');
const HEADER_WORD = /(?:^|\s)(S[ıi]ra|Miktar|Birim|Fiyat|Oran[ıi]|Tutar[ıi]|[İI]skonto|KDV|[ÜU]r[üu]n|Mal\s*Hizmet|A[çc][ıi]klama|Vergiler)(?=\s|$)/i;
const TOTALS_LINE = /(Mal\s*\/?\s*Hizmet\s*Toplam|Toplam\s*[İI]skonto|Ara\s*Toplam|Genel\s*Toplam|Hesaplanan\s*KDV|Vergiler\s*Dahil|[ÖO]denecek\s*Tutar)/i;
const AMOUNT = /(%\s*)?(-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?)/g;
const VAT_RATES = new Set([1, 8, 10, 18, 20]);
const numbersIn = s => [...String(s).matchAll(AMOUNT)].map(m => ({v: toNumber(m[2]), pct: !!m[1]})).filter(x => x.v !== null);
// Açıklama satırındaki tutar/oran/para birimi kırıntıları açıklamaya girmez.
const words = s => String(s).replace(/%\s*[\d.,]+/g, ' ').replace(/(?:^|\s)-?[\d.]+,\d+(?=\s|$)/g, ' ').replace(/(?:^|\s)TL(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Satır adayları. Tablo bölgesi başlık satırlarından toplamlara kadardır. Bir kalemin açıklaması
 * çoğu zaman satırın ÜSTÜNE ve ALTINA taşar; bölgedeki kalem-dışı satırlar komşu kaleme verilir.
 * Tutarlar ÇARPIMLA doğrulanır: miktar × birim fiyat (− iskonto) = satır tutarı. KDV, belgede
 * yazan orana göre belgede yazan tutarla eşleşirse alınır. Doğrulanamayan alan null kalır ve
 * "kontrol et" işaretlenir: miktar/vergi/ürün UYDURULMAZ.
 */
export function guessLines(lines) {
  // Birimden sonra en az bir TUTAR olmalı: "1000 ML %20,00 TL" gibi yalnız oran taşıyan
  // açıklama devamı kalem değildir.
  const isRow = l => { const m = ROW.exec(l.trim()); return !!m && numbersIn(m[4]).some(x => !x.pct); };
  const isHeader = l => HEADER_WORD.test(l) && !isRow(l) && !/\d,\d{2}/.test(l) && !TOTALS_LINE.test(l);
  // Tablo bölgeleri: başlık bloğundan sonra, toplam satırına ya da yeni başlık bloğuna kadar.
  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isHeader(lines[i])) continue;
    const head = [];
    while (i < lines.length && isHeader(lines[i])) head.push(lines[i++]);
    const start = i;
    while (i < lines.length && !TOTALS_LINE.test(lines[i]) && !isHeader(lines[i])) i++;
    if (lines.slice(start, i).some(isRow)) regions.push({head: head.join(' '), body: lines.slice(start, i)});
    i--;
  }
  // Başlık tanınmadıysa eski davranış: bütün satırlarda kalem aranır, komşu satır kullanılmaz.
  const noTable = !regions.length;
  if (noTable) regions.push({head: '', body: lines.filter(isRow)});

  const docRates = [...new Set([...lines.join('\n').matchAll(/Hesaplanan\s*KDV\s*\(\s*%\s*([\d.,]+)\s*\)/gi)].map(m => Number(m[1].replace(',', '.'))))];
  const out = [];
  for (const {head, body} of regions) {
    const rowAt = body.map((l, k) => isRow(l) ? k : -1).filter(k => k >= 0);
    if (!rowAt.length) continue;
    const context = rowAt.map(() => ({above: [], below: []}));
    if (!noTable) {
      const before = rowAt[0], after = body.length - 1 - rowAt[rowAt.length - 1];
      context[0].above = body.slice(0, before);
      context[rowAt.length - 1].below = body.slice(rowAt[rowAt.length - 1] + 1);
      for (let r = 0; r + 1 < rowAt.length; r++) {
        const gap = body.slice(rowAt[r] + 1, rowAt[r + 1]);
        // İlk kalemin üstünde ve son kalemin altında kaç satır varsa aradaki satırlar da öyle
        // bölünür; örüntü tutmuyorsa yarı yarıya.
        const down = gap.length === before + after ? after : Math.ceil(gap.length / 2);
        context[r].below = gap.slice(0, down);
        context[r + 1].above = gap.slice(down);
      }
    }
    const hasSira = /S[ıi]ra/i.test(head), hasCode = /[ÜU]r[üu]n\s*Kodu/i.test(head), hasNote = /[ÜU]r[üu]n\s*A[çc][ıi]klama/i.test(head);
    rowAt.forEach((k, r) => {
      const m = ROW.exec(body[k].trim());
      const quantity = toNumber(m[2]);
      if (!quantity || quantity <= 0) return;
      let prefix = (m[1] || '').trim();
      if (hasSira) prefix = prefix.replace(/^\d{1,3}(?:\s+|$)/, '');
      const nums = numbersIn(m[4]), plain = nums.filter(x => !x.pct).map(x => x.v);
      const ctxNums = [...context[r].above, ...context[r].below].flatMap(numbersIn);
      if (!plain.length) return;
      const gross = round2(quantity * plain[0]);
      // Satır tutarı: çarpımı (iskonto düşülmüş hâliyle) tutan tutar. Sondan aranır.
      let net = null;
      for (let j = plain.length - 1; j >= 1 && net === null; j--)
        if (near(plain[j], gross) || plain.slice(1, j).some(d => d > 0 && near(round2(gross - d), plain[j]))) net = plain[j];
      const uncertain = [];
      if (net === null) { net = plain[plain.length - 1]; uncertain.push('net'); }
      // KDV oranı: satırda/komşusunda yazan sıfırdan büyük geçerli oran; yoksa belgenin TEK oranı.
      const rates = [...new Set([...nums, ...ctxNums].filter(x => x.pct && VAT_RATES.has(x.v)).map(x => x.v))];
      const rate = rates.length === 1 ? rates[0] : !rates.length && docRates.length === 1 && VAT_RATES.has(docRates[0]) ? docRates[0] : null;
      let tax = null;
      if (rate !== null) {
        const expected = round2(net * rate / 100);
        const seen = [...plain.filter(v => v !== net), ...ctxNums.filter(x => !x.pct).map(x => x.v)];
        if (seen.some(v => near(v, expected))) tax = expected;
      }
      if (rate === null) uncertain.push('vat_rate');
      if (tax === null) uncertain.push('tax');
      const note = [...context[r].above, ...context[r].below].map(words).filter(Boolean).join(' ');
      const description = hasNote && prefix
        ? prefix + (note ? ' / ' + note : '')
        : [...context[r].above.map(words), prefix, ...context[r].below.map(words)].filter(Boolean).join(' ');
      // Ürün kodu yalnız belgede "Ürün Kodu" sütunu varsa alınır. Açıklamanın ilk büyük harfli
      // sözcüğü ("SAB Substrate") kod SANILMAZ: kod, sonraki faturalarda ürün eşleştirmesinin anahtarıdır.
      const code = hasCode ? (/^([A-ZÇĞİÖŞÜ0-9][A-ZÇĞİÖŞÜ0-9._-]{1,24})(?:\s|$)/.exec(prefix) || [])[1] || '' : '';
      out.push({description: description.replace(/\s+/g, ' ').trim(), external_code: code,
        invoice_quantity: quantity, invoice_unit: m[3].toLowerCase(), net, tax, vat_rate: rate, uncertain});
    });
    if (out.length >= 40) break;
  }
  // Satırların toplamı belgenin yazdığı toplamı tutmuyorsa bir kalem kaçmış ya da yanlış
  // okunmuştur: hiçbir satır "kesin" sayılmaz.
  const totals = guessTotals(lines);
  const sumNet = round2(out.reduce((s, l) => s + l.net, 0));
  const sumTax = out.every(l => l.tax !== null) ? round2(out.reduce((s, l) => s + l.tax, 0)) : null;
  if (out.length && ((totals.net !== null && !near(totals.net, sumNet)) || (totals.tax !== null && sumTax !== null && !near(totals.tax, sumTax))))
    out.forEach(l => { if (!l.uncertain.includes('net')) l.uncertain.push('net'); });
  return out.slice(0, 40);
}

/** Belgede yazan genel toplamlar: kullanıcı satır toplamlarıyla karşılaştırsın diye. */
export function guessTotals(lines) {
  const text = lines.join('\n');
  const pick = pattern => {
    const m = new RegExp(pattern + '\\s*[:.]?\\s*(?:TL|TRY)?\\s*(-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2})', 'i').exec(text);
    return m ? toNumber(m[1]) : null;
  };
  return {
    net: pick('(?:Mal\\s*/?\\s*Hizmet\\s*Toplam\\s*Tutar[ıi]|Mal\\s*/?\\s*Hizmet\\s*Toplam[ıi]|Ara\\s*Toplam|KDV\\s*Hari[çc]\\s*Toplam)'),
    tax: pick('(?:Hesaplanan\\s*KDV(?:\\s*\\(\\s*%\\s*[\\d.,]+\\s*\\))?|KDV\\s*Toplam[ıi]|Toplam\\s*KDV)'),
    gross: pick('(?:[ÖO]denecek\\s*Tutar|Vergiler\\s*Dahil\\s*Toplam(?:\\s*Tutar)?|Genel\\s*Toplam)')
  };
}

/**
 * BİRLEŞTİRİLMİŞ PDF. EDM'den "hepsini indir" denince tek dosyada birden çok fatura gelir.
 * Her sayfanın fatura numarası okunur; numarası olmayan sayfa bir öncekinin devamıdır (çok
 * sayfalı fatura). En az İKİ ayrı numara yoksa bölme YAPILMAZ: tek fatura gibi işlenir.
 */
export function splitInvoices(pageLines) {
  if (!Array.isArray(pageLines) || pageLines.length < 2) return [];
  const groups = [];
  pageLines.forEach((lines, i) => {
    const no = String(guessHeader(lines)?.invoice_no || '').trim();
    const last = groups[groups.length - 1];
    if (no && (!last || last.no !== no)) groups.push({no, sayfalar: [i + 1], satirlar: [...lines]});
    else if (last) { last.sayfalar.push(i + 1); last.satirlar.push(...lines); }
    else groups.push({no: '', sayfalar: [i + 1], satirlar: [...lines]});
  });
  return new Set(groups.map(g => g.no).filter(Boolean)).size >= 2 ? groups : [];
}
