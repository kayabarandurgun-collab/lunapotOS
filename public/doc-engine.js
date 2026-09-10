// Ortak belge motoru. Cari mutabakatı, teklif/proforma/sözleşme ve etiket çıktıları bunu kullanır.
// Belgeler tarayıcıda üretilir; kaynak veri sunucudan yetki denetimlerinden geçerek gelir.
// Bu yüzden ayrıca korunması gereken ikili bir indirme ucu yoktur.
// Ücretli servis yok, dış istek yok. PDF kitaplığı yalnızca PDF istendiğinde yüklenir.

const encoder = new TextEncoder();

/* ---------- ortak yardımcılar ---------- */

export const escapeXml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // XML 1.0'da geçersiz denetim karakterleri belgeyi bozar; ayıklanır.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// Excel bir hücreyi = + - @ ile başlıyorsa formül sayar. Metinler tırnaklanarak etkisizleştirilir.
export const csvCell = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).replace('.', ',');
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};

export function csvBytes(rows) {
  const body = rows.map(row => row.map(csvCell).join(';')).join('\r\n');
  return encoder.encode('﻿' + body);
}

/* ---------- en küçük ZIP yazıcı (yalnızca "store", sıkıştırmasız) ---------- */
// XLSX ve DOCX birer ZIP paketidir. Sıkıştırmasız girdiler her iki biçimde de geçerlidir,
// böylece dışarıdan sıkıştırma kitaplığı gerekmez.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipBytes(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const {name, data} of entries) {
    const nameBytes = encoder.encode(name);
    const body = typeof data === 'string' ? encoder.encode(data) : data;
    const crc = crc32(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);      // sürüm
    local.setUint16(6, 0x0800, true);  // UTF-8 ad bayrağı
    local.setUint16(8, 0, true);       // store
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, body.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}

/* ---------- XLSX ---------- */
// sheets: [{name, columns:[{header,width,type}], rows:[[deger,...]]}]
// type: 'text' | 'number' | 'date'  → hücre türü buna göre yazılır, toplamlar Excel'de hesaplanabilir kalır.

const columnName = index => {
  let name = '', n = index + 1;
  while (n > 0) { const rest = (n - 1) % 26; name = String.fromCharCode(65 + rest) + name; n = Math.floor((n - 1) / 26); }
  return name;
};

// Excel tarihleri 1900 dizgesiyle sayar; 1900'ü artık yıl sayan tarihsel hata için 2 gün kayması vardır.
const excelSerial = value => {
  const date = value instanceof Date ? value : new Date(String(value) + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 86400000) + 25569;
};

function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const header = columns.length ? [columns.map(c => c.header)] : [];
  const all = [...header, ...(sheet.rows || [])];
  const rows = all.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = columnName(columnIndex) + (rowIndex + 1);
      const isHeader = rowIndex === 0 && header.length > 0;
      const type = isHeader ? 'text' : (columns[columnIndex]?.type || 'text');
      if (value === null || value === undefined || value === '') return `<c r="${reference}" s="${isHeader ? 1 : 0}"/>`;
      if (!isHeader && type === 'number' && typeof value === 'number' && Number.isFinite(value))
        return `<c r="${reference}" s="2"><v>${value}</v></c>`;
      if (!isHeader && type === 'date') {
        const serial = excelSerial(value);
        if (serial !== null) return `<c r="${reference}" s="3"><v>${serial}</v></c>`;
      }
      return `<c r="${reference}" s="${isHeader ? 1 : 0}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const widths = columns.length
    ? `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const lastColumn = columnName(Math.max(0, (columns.length || (all[0]?.length || 1)) - 1));
  // Başlık satırı donuk kalsın ve süzgeç açık gelsin.
  const freeze = header.length ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  const filter = header.length ? `<autoFilter ref="A1:${lastColumn}${all.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${widths}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

export function xlsxBytes(sheets) {
  const list = sheets.filter(Boolean);
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF5F0"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs></styleSheet>`;
  const entries = [
    {name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`},
    {name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${escapeXml((s.name || ('Sayfa' + (i + 1))).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`},
    {name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name: 'xl/styles.xml', data: styles},
    ...list.map((sheet, i) => ({name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet)}))
  ];
  return zipBytes(entries);
}

/* ---------- DOCX ---------- */
// blocks: [{type:'heading'|'text'|'small'|'spacer'|'table', text, rows, columns}]

const runXml = (text, {bold = false, size = 22, color = '243830'} = {}) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;

function blockXml(block) {
  if (block.type === 'heading')
    return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>${runXml(block.text, {size: 30})}</w:p>`;
  if (block.type === 'small')
    return `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>${runXml(block.text, {size: 18, color: '64746C'})}</w:p>`;
  if (block.type === 'spacer') return '<w:p/>';
  if (block.type === 'table') {
    const header = `<w:tr>${(block.columns || []).map(c => `<w:tc><w:tcPr><w:shd w:val="clear" w:fill="EDF5F0"/></w:tcPr><w:p>${runXml(c, {size: 18})}</w:p></w:tc>`).join('')}</w:tr>`;
    const rows = (block.rows || []).map(row => `<w:tr>${row.map(cell => `<w:tc><w:p>${runXml(cell, {size: 18})}</w:p></w:tc>`).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="DFE7E0"/><w:left w:val="single" w:sz="4" w:color="DFE7E0"/><w:bottom w:val="single" w:sz="4" w:color="DFE7E0"/><w:right w:val="single" w:sz="4" w:color="DFE7E0"/><w:insideH w:val="single" w:sz="4" w:color="DFE7E0"/><w:insideV w:val="single" w:sz="4" w:color="DFE7E0"/></w:tblBorders></w:tblPr>${header}${rows}</w:tbl><w:p/>`;
  }
  return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${runXml(block.text || '')}</w:p>`;
}

export function docxBytes(blocks, {footer = ''} = {}) {
  const body = blocks.map(blockXml).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:p><w:pPr><w:spacing w:before="240"/></w:pPr>${runXml(footer, {size: 16, color: '64746C'})}</w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  return zipBytes([
    {name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`},
    {name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`},
    {name: 'word/document.xml', data: document}
  ]);
}

/* ---------- indirme ---------- */

const TYPES = {
  csv: 'text/csv;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf'
};

export function saveFile(bytes, filename) {
  const extension = filename.split('.').pop().toLowerCase();
  const blob = new Blob([bytes], {type: TYPES[extension] || 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Dosya adı: tarayıcı ve işletim sistemi için güvenli, Türkçe harfler sadeleştirilir.
export function safeFilename(...parts) {
  const base = parts.filter(Boolean).join('-')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G').replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ş/g, 's').replace(/Ş/g, 'S').replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O').replace(/ç/g, 'c').replace(/Ç/g, 'C')
    .replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base.slice(0, 120) || 'belge';
}

/* ---------- PDF ---------- */
// pdf-lib, fontkit ve yazı tipi yalnızca PDF istendiğinde yüklenir; sayfa açılışını yavaşlatmaz.
// Yazı tipi Latin + Türkçe alt kümesidir (48 KB), böylece ş/ğ/İ/ı/₺ doğru çıkar.

let pdfKit = null;
// UMD paketleri kendi bagimliliklarini icerir ve genel degiskene yazar.
// CSP script-src 'self' oldugu icin yalnizca bu alandan yuklenir; dis kaynak yoktur.
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-vendor="' + globalName + '"]');
    if (existing) { existing.addEventListener('load', () => resolve(window[globalName])); existing.addEventListener('error', () => reject(new Error('Belge kitaplığı yüklenemedi.'))); return; }
    const script = document.createElement('script');
    script.src = src; script.dataset.vendor = globalName;
    script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error('Belge kitaplığı beklenen biçimde yüklenmedi.'));
    script.onerror = () => reject(new Error('Belge kitaplığı yüklenemedi.'));
    document.head.append(script);
  });
}
async function loadPdfKit() {
  if (pdfKit) return pdfKit;
  const [lib, fontkit, fontBytes] = await Promise.all([
    loadScript('/vendor/pdf-lib.min.js', 'PDFLib'),
    loadScript('/vendor/fontkit.min.js', 'fontkit'),
    fetch('/vendor/NotoSans-tr.ttf').then(r => {
      if (!r.ok) throw new Error('PDF yazı tipi yüklenemedi.');
      return r.arrayBuffer();
    })
  ]);
  pdfKit = {lib, fontkit, fontBytes};
  return pdfKit;
}

const A4 = {width: 595.28, height: 841.89};
const MARGIN = 42;

// Bir satiri verilen genislige sigacak parcalara boler; uzun isimler tasmaz.
function wrap(text, font, size, width) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
    if (line) lines.push(line);
    // Tek kelime bile sigmiyorsa karakterden bol.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * blocks: [{type:'heading'|'text'|'small'|'spacer'|'keyvalue'|'table', ...}]
 * Cok sayfali cikti otomatik olusur; her sayfada alt bilgi ve sayfa numarasi bulunur.
 */
// kit yalnizca testte disaridan verilir; tarayicida her zaman tembel yukleyiciden gelir.
export async function pdfBytes({title, subtitle, blocks = [], footer = ''}, kit) {
  const {lib, fontkit, fontBytes} = kit || await loadPdfKit();
  const {PDFDocument, rgb} = lib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, {subset: true});
  const ink = rgb(0.14, 0.22, 0.19), muted = rgb(0.39, 0.45, 0.42), line = rgb(0.87, 0.91, 0.88);
  const contentWidth = A4.width - MARGIN * 2;

  const pages = [];
  let page = null, y = 0;
  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    pages.push(page);
    y = A4.height - MARGIN;
  };
  const room = need => { if (!page || y - need < MARGIN + 26) newPage(); };
  // Kalinlik icin metni iki kez cizmek PDF'te metni de ciftler; kopyalarken tekrar eder.
  // Bu yuzden vurgu punto ve renkle yapilir, tek cizim korunur.
  const draw = (text, {size = 10, color = ink, x = MARGIN} = {}) =>
    page.drawText(String(text ?? ''), {x, y, size, font, color});

  newPage();
  draw(title || 'Belge', {size: 17}); y -= 21;
  if (subtitle) { draw(subtitle, {size: 10, color: muted}); y -= 16; }
  y -= 6;
  page.drawLine({start: {x: MARGIN, y}, end: {x: A4.width - MARGIN, y}, thickness: 0.8, color: line});
  y -= 20;

  for (const block of blocks) {
    if (block.type === 'spacer') { room(16); y -= 14; continue; }
    if (block.type === 'heading') {
      room(34); y -= 6; draw(block.text, {size: 12}); y -= 17; continue;
    }
    if (block.type === 'keyvalue') {
      for (const [label, value] of block.rows || []) {
        room(16);
        draw(label, {size: 9.5, color: muted});
        const text = String(value ?? '');
        draw(text, {size: 9.5, x: MARGIN + 165});
        y -= 15;
      }
      continue;
    }
    if (block.type === 'table') {
      const columns = block.columns || [];
      const widths = columns.map(c => (c.width || 1));
      const total = widths.reduce((a, b) => a + b, 0);
      const sizes = widths.map(w => (w / total) * contentWidth);
      const header = () => {
        room(24);
        page.drawRectangle({x: MARGIN, y: y - 4, width: contentWidth, height: 17, color: rgb(0.93, 0.96, 0.94)});
        let x = MARGIN + 4;
        columns.forEach((column, i) => { draw(column.header, {size: 8.5, x}); x += sizes[i]; });
        y -= 20;
      };
      header();
      for (const row of block.rows || []) {
        const cells = row.map((cell, i) => wrap(cell, font, 9, sizes[i] - 8));
        const height = Math.max(...cells.map(c => c.length)) * 12 + 4;
        if (y - height < MARGIN + 26) { newPage(); header(); }
        let x = MARGIN + 4;
        cells.forEach((linesOfCell, i) => {
          linesOfCell.forEach((textLine, index) => {
            page.drawText(textLine, {x, y: y - index * 12, size: 9, font, color: ink});
          });
          x += sizes[i];
        });
        y -= height;
        page.drawLine({start: {x: MARGIN, y: y + 8}, end: {x: A4.width - MARGIN, y: y + 8}, thickness: 0.5, color: line});
      }
      y -= 8;
      continue;
    }
    const size = block.type === 'small' ? 8.5 : 10;
    const color = block.type === 'small' ? muted : ink;
    for (const textLine of wrap(block.text, font, size, contentWidth)) {
      room(16);
      draw(textLine, {size, color});
      y -= size + 4;
    }
    y -= 4;
  }

  pages.forEach((current, index) => {
    const label = `${footer ? footer + ' · ' : ''}Sayfa ${index + 1} / ${pages.length}`;
    current.drawText(label, {x: MARGIN, y: MARGIN - 14, size: 8, font, color: muted});
  });
  return doc.save();
}

/* ---------- yazdırılabilir görünüm ---------- */
// Yazdırma her zaman beyaz kâğıt düzenini kullanır; kullanıcı koyu temadayken de okunaklıdır.

export function printDocument(html, {title = 'Belge'} = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(frame);
  const win = frame.contentWindow;
  win.document.open();
  win.document.write(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<style>
 @page{size:A4;margin:16mm}
 :root{color-scheme:light}
 body{margin:0;background:#fff;color:#243830;font:12px/1.6 'Segoe UI',system-ui,sans-serif}
 h1{font-size:19px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px}
 .muted{color:#64746c;font-size:11px}
 table{width:100%;border-collapse:collapse;margin:10px 0}
 th{background:#edf5f0;text-align:left;font-size:10px;padding:7px 9px;border:1px solid #dfe7e0}
 td{padding:7px 9px;border:1px solid #dfe7e0;font-size:11px;vertical-align:top;overflow-wrap:anywhere}
 tr{break-inside:avoid}
 .right{text-align:right}
 .note{border:1px solid #efe0bb;background:#fff8e9;padding:9px 12px;border-radius:6px;color:#76531c;font-size:11px}
</style></head><body>${html}</body></html>`);
  win.document.close();
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  frame.onload = () => { win.focus(); win.print(); cleanup(); };
  // onload bazi tarayicilarda document.write sonrasi tetiklenmez; yedek yol.
  setTimeout(() => { if (frame.isConnected) { win.focus(); win.print(); cleanup(); } }, 350);
}
