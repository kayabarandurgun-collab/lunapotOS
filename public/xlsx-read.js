// Rapor Kutusu için Excel (.xlsx) ve CSV okuyucu. Dış kitaplık yok; tarayıcıda ve testte aynı kod.
//
// Güvenlik ve doğruluk kuralları:
//  · Makro, formül ve dış bağlantı ÇALIŞTIRILMAZ. Formülün kayıtlı sonucu varsa okunur ve hücre
//    "formül" diye işaretlenir; sonuç yoksa değer boş kalır (tahmin edilmez).
//  · Eski .xls (BIFF) ve Excel gibi görünen HTML sayfaları reddedilir (oturum düşünce panel HTML indirir).
//  · ZIP açılımında dosya, giriş ve açılmış boyut sınırı vardır (zip bombası).
//  · Hücre değeri METİN olarak döner. Uzun kimlikler sayıya çevrilmez; sayıya çevirmeyi alan türü yapar.
export const LIMITS = {fileBytes: 25 * 1024 * 1024, entries: 3000, entryBytes: 120 * 1024 * 1024, rows: 200000, cols: 256};

const fail = message => { throw Object.assign(new Error(message), {status: 400}); };
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function sniff(bytes, name) {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    fail('Eski .xls biçimi okunmuyor. Dosyayı Excel\'de açıp "Farklı kaydet → Excel Çalışma Kitabı (.xlsx)" ile kaydedin.');
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';
  const head = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') && head.includes('<html'))
    fail('Bu dosya bir Excel raporu değil, bir web sayfası. Pazaryeri oturumu sona ermiş olabilir; raporu yeniden indirin.');
  if (/\.(csv|txt)$/i.test(name) || !/\.[a-z0-9]+$/i.test(name)) return 'csv';
  fail('Desteklenen biçimler: .xlsx ve .csv.');
}

/* ---------------- ZIP ---------------- */
function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(bytes, i) === 0x06054b50) { end = i; break; }
  if (end < 0) fail('Excel dosyası bozuk (ZIP dizini bulunamadı).');
  const count = u16(bytes, end + 10), dirOffset = u32(bytes, end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) fail('Çok büyük (ZIP64) Excel dosyaları desteklenmiyor. Dönemi bölerek indirin.');
  if (count > LIMITS.entries) fail('Excel dosyasında beklenmeyen sayıda parça var.');
  const entries = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) fail('Excel dosyası bozuk (ZIP dizini).');
    const method = u16(bytes, p + 10), compressed = u32(bytes, p + 20), size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32), local = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    entries.set(name, {method, compressed, size, local});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflate(data, limit) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader(), chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); fail('Excel dosyasının açılmış boyutu sınırı aşıyor.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function readEntry(bytes, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (u32(bytes, e.local) !== 0x04034b50) fail('Excel dosyası bozuk (parça başlığı).');
  const start = e.local + 30 + u16(bytes, e.local + 26) + u16(bytes, e.local + 28);
  const data = bytes.slice(start, start + e.compressed);
  if (e.size > LIMITS.entryBytes) fail('Excel sayfası çok büyük. Dönemi bölerek indirin.');
  const raw = e.method === 0 ? data : e.method === 8 ? await inflate(data, LIMITS.entryBytes) : fail('Excel dosyası desteklenmeyen sıkıştırma kullanıyor.');
  return new TextDecoder().decode(raw);
}

/* ---------------- XML ---------------- */
const decodeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"})[e.toLowerCase()]);
const attr = (tag, name) => { const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"')); return m ? decodeXml(m[1]) : null; };
const texts = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map(m => decodeXml(m[1] || '')).join('');
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(bytes, {sheet: wanted} = {}) {
  const entries = zipEntries(bytes), warnings = [];
  if ([...entries.keys()].some(n => /vbaProject\.bin$/i.test(n))) warnings.push('Dosyada makro var; çalıştırılmadı.');
  if ([...entries.keys()].some(n => /^xl\/externalLinks\//i.test(n))) warnings.push('Dosyada dış bağlantı var; izlenmedi, kayıtlı değerler okundu.');
  const workbook = await readEntry(bytes, entries, 'xl/workbook.xml');
  if (!workbook) fail('Bu dosyada Excel çalışma kitabı yok.');
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const rels = (await readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels')) || '';
  const targets = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => ({name: attr(m[0], 'name'), rid: attr(m[0], 'r:id')}));
  if (!sheets.length) fail('Excel dosyasında sayfa yok.');
  const chosen = wanted ? sheets.find(s => s.name === wanted) : sheets[0];
  if (!chosen) fail('Seçilen sayfa dosyada yok.');
  let target = targets[chosen.rid] || '';
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const xml = await readEntry(bytes, entries, target);
  if (!xml) fail('Excel sayfası okunamadı.');
  const sharedXml = (await readEntry(bytes, entries, 'xl/sharedStrings.xml')) || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => texts(m[1] || ''));

  const rows = [];
  let formulaWithoutValue = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= LIMITS.rows) fail('Dosyada ' + LIMITS.rows + ' satırdan fazla var. Dönemi bölerek indirin.');
    const rowNo = Number(attr('<r ' + rm[1] + '>', 'r')) || rows.length + 1;
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = '<c ' + cm[1] + '>', inner = cm[2] || '', ref = attr(tag, 'r');
      const index = ref ? colIndex(ref) : cells.length;
      if (index >= LIMITS.cols) fail('Dosyada ' + LIMITS.cols + ' sütundan fazla var.');
      const type = attr(tag, 't') || 'n', formula = /<f\b/.test(inner);
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = null, kind = 'n';
      if (type === 's') { value = v ? shared[Number(v[1])] ?? null : null; kind = 's'; }
      else if (type === 'inlineStr') { value = texts(inner); kind = 's'; }
      else if (type === 'str') { value = v ? decodeXml(v[1]) : null; kind = 's'; }
      else if (type === 'b') { value = v ? (v[1] === '1' ? 'DOĞRU' : 'YANLIŞ') : null; kind = 'b'; }
      else if (type === 'e') { value = v ? decodeXml(v[1]) : null; kind = 'e'; }
      else { value = v ? v[1].trim() : null; kind = 'n'; }
      if (formula && value === null) formulaWithoutValue++;
      cells[index] = {v: value === '' ? null : value, t: kind, ...(formula ? {f: true} : {})};
    }
    rows.push({row: rowNo, cells});
  }
  if (formulaWithoutValue) warnings.push(formulaWithoutValue + ' formül hücresinin kayıtlı sonucu yok; boş bırakıldı.');
  return {format: 'xlsx', sheets: sheets.map(s => s.name), sheet: chosen.name, date1904, rows, warnings};
}

/* ---------------- CSV ---------------- */
function decodeText(bytes) {
  const utf = new TextDecoder('utf-8').decode(bytes);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('windows-1254').decode(bytes); } catch { return utf; }
}
function readCsv(bytes) {
  const text = decodeText(bytes), first = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', ',', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let cell = '', row = [], quoted = false;
  const push = () => { row.push(cell); cell = ''; };
  const end = () => { push(); if (row.some(c => c !== '')) rows.push({row: rows.length + 1, cells: row.map(v => ({v: v === '' ? null : v, t: 's'}))}); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) push();
    else if (ch === '\n') { end(); if (rows.length > LIMITS.rows) fail('Dosyada çok fazla satır var.'); }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) end();
  return {format: 'csv', sheets: ['CSV'], sheet: 'CSV', date1904: false, rows, warnings: []};
}

/**
 * Dosyayı okur ve başlık satırını bulur (en az iki dolu hücreli ilk satır).
 * Dönüş: {format, sheets, sheet, date1904, headerRow, headers, rows:[{row, cells}], warnings}
 */
export async function readTable(input, {name = '', sheet} = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) fail('Dosya boş.');
  if (bytes.length > LIMITS.fileBytes) fail('Dosya 25 MB sınırını aşıyor. Dönemi bölerek indirin.');
  const table = sniff(bytes, name) === 'xlsx' ? await readXlsx(bytes, {sheet}) : readCsv(bytes);
  const headerAt = table.rows.findIndex(r => r.cells.filter(c => c?.v !== null && c?.v !== undefined).length >= 2);
  if (headerAt < 0) fail('Dosyada başlık satırı bulunamadı.');
  const width = Math.max(...table.rows.slice(headerAt).map(r => r.cells.length));
  const seen = new Map();
  const headers = Array.from({length: width}, (_, i) => {
    let h = String(table.rows[headerAt].cells[i]?.v ?? '').replace(/\s+/g, ' ').trim() || 'Sütun ' + (i + 1);
    const n = (seen.get(h) || 0) + 1; seen.set(h, n);
    if (n > 1) { table.warnings.push('"' + h + '" başlığı birden fazla kez geçiyor; ayrı sütunlar olarak numaralandı.'); h += ' (' + n + ')'; }
    return h;
  });
  return {...table, headerRow: table.rows[headerAt].row, headers, rows: table.rows.slice(headerAt + 1)};
}

/** Dosyanın SHA-256 özeti (onaltılık). Aynı dosyanın ikinci kez yüklenmesini tanır. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
