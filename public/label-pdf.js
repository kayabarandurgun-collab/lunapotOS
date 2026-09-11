// Barkod ve koli etiketlerinin doğrudan PDF çıktısı. YALNIZCA üretim (lp) alanında kullanılır.
//
// Yazdırma görünümüyle (labelPrintHtml) aynı içeriği taşır ama tarayıcının yazdırma
// ayarlarına bağlı değildir: her etiket kendi ölçüsünde (ör. 100 × 70 mm) bir PDF sayfasıdır.
// Barkod, labelPlan'ın milimetre planından vektör olarak çizilir; büyütme ve sessiz alan
// yazdırma görünümüyle birebir aynıdır. Yazı tipi, belge motorunun Türkçe alt kümesidir
// (ş/ğ/İ/ı doğru çıkar). Bu dosya stok DEĞİŞTİRMEZ.
import {LABEL_SIZES, labelPlan} from './barcode-label.js';

const MM = 72 / 25.4;
const PAD_MM = 2;

// Uzun metin etikete sığmıyorsa sonu '…' ile kısaltılır; etiket taşmaz.
function fit(text, font, size, width) {
  let value = String(text ?? '');
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  while (value.length > 1 && font.widthOfTextAtSize(value + '…', size) > width) value = value.slice(0, -1);
  return value + '…';
}

/**
 * labels: [{code, title, rows: [[etiket, değer]], subtitle}]  (cartonLabels / barkod etiketi biçimi)
 * kit: {lib, fontkit, fontBytes} — testte dışarıdan verilir, tarayıcıda belge motorundan yüklenir.
 */
export async function labelsPdfBytes(labels, {size = 'carton'} = {}, kit) {
  const preset = LABEL_SIZES[size];
  if (!preset) throw new Error('Etiket boyutu geçersiz.');
  if (!Array.isArray(labels) || !labels.length) throw new Error('Basılacak etiket yok.');
  const {lib, fontkit, fontBytes} = kit || await (await import('./doc-engine.js')).loadPdfKit();
  const {PDFDocument, rgb} = lib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, {subset: true});
  const ink = rgb(0, 0, 0), muted = rgb(0.3, 0.3, 0.3);
  const width = preset.width_mm * MM, height = preset.height_mm * MM, pad = PAD_MM * MM;
  const inner = width - pad * 2;
  const fontSize = preset.font, small = Math.max(5, preset.font * 0.72);

  doc.setTitle('Etiketler');
  doc.setCreator('Lunapot üretim');

  for (const label of labels) {
    const plan = labelPlan({code: label.code, size});
    const page = doc.addPage([width, height]);
    let y = height - pad - fontSize;

    page.drawText(fit(label.title || '', font, fontSize, inner), {x: pad, y, size: fontSize, font, color: ink});
    y -= fontSize * 1.35;
    for (const [name, value] of label.rows || []) {
      const nameText = fit(name, font, small, inner * 0.38);
      page.drawText(nameText, {x: pad, y, size: small, font, color: muted});
      page.drawText(fit(value, font, small, inner * 0.6), {x: pad + inner * 0.4, y, size: small, font, color: ink});
      y -= small * 1.3;
    }

    // Alt bölge: okunabilir haneler ve alt not. Barkod bunların üstüne, satırların altına sığmalı.
    const humanY = pad + (label.subtitle ? small * 1.4 : 0);
    const barsBottom = humanY + fontSize * 1.15;
    const available = y - barsBottom;
    const planHeight = plan.bar_height_mm * MM;
    if (available < 8 * MM)
      throw new Error('Etiket içeriği bu boyuta sığmıyor. Daha büyük etiket seçin.');
    // Genişlik (modül) asla daraltılmaz; gerekirse yalnızca çubuk boyu kısalır.
    const scale = Math.min(1, available / planHeight);
    const barsTop = barsBottom + planHeight * scale;
    for (const bar of plan.bars) {
      const h = bar.height_mm * MM * scale;
      page.drawRectangle({x: bar.x_mm * MM, y: barsTop - h, width: bar.width_mm * MM, height: h, color: ink});
    }

    if (plan.human) {
      const m = plan.module_mm * MM, start = plan.start_x_mm * MM;
      const ean13 = plan.symbology === 'ean13';
      const leftCenter = start + (ean13 ? 24 : 17) * m, rightCenter = start + (ean13 ? 71 : 50) * m;
      const centered = (text, cx) => page.drawText(text, {x: cx - font.widthOfTextAtSize(text, fontSize) / 2, y: humanY, size: fontSize, font, color: ink});
      if (plan.human.lead) page.drawText(plan.human.lead, {x: start - font.widthOfTextAtSize(plan.human.lead, fontSize) - m * 2, y: humanY, size: fontSize, font, color: ink});
      centered(plan.human.left, leftCenter);
      centered(plan.human.right, rightCenter);
    } else {
      const text = fit(label.code, font, fontSize, inner);
      page.drawText(text, {x: (width - font.widthOfTextAtSize(text, fontSize)) / 2, y: humanY, size: fontSize, font, color: ink});
    }
    if (label.subtitle) page.drawText(fit(label.subtitle, font, small, inner), {x: pad, y: pad, size: small, font, color: muted});
  }
  return doc.save();
}
