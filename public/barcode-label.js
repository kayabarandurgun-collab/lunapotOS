// Etiket üretimi. Code 128-B sembolojisi: harf, rakam ve "-" içeren her kodu taşır,
// dolayısıyla hem GS1 barkodlarını hem "LP-" iç kodlarını aynı etikette basabiliriz.
//
// Barlar gerçek genişliklerle çizilir; etiket fiziksel olarak okunabilir olsun diye
// modül genişliği ve sessiz alan (quiet zone) korunur. Kod her zaman metindir.

import {isEan, eanModules, eanBars, EAN_QUIET_LEFT, EAN_QUIET_RIGHT, EAN_MIN_MODULE_MM} from './barcode-ean.js';

// 107 desen: her biri 6 haneli, sırayla bar/boşluk modül genişlikleri.
// Değer 0-102 karakterler, 103-105 başlangıçlar, 106 durdurma.
export const CODE128_PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(/\s+/);

const START_B = 104, STOP = 106;

/** Code 128-B yalnızca 32-126 arası ASCII taşır. */
export function encodable(code) {
  return typeof code === 'string' && code.length > 0 && [...code].every(ch => {
    const value = ch.charCodeAt(0);
    return value >= 32 && value <= 126;
  });
}

/**
 * Kodu modül genişlikleri dizisine çevirir. Dizideki her sayı kaç modül
 * genişliğinde olduğunu söyler; ilk eleman BAR, sonraki BOŞLUK, sırayla.
 */
export function code128Bars(code) {
  if (!encodable(code)) throw new Error('Bu kod Code 128 ile basılamaz.');
  const values = [START_B, ...[...code].map(ch => ch.charCodeAt(0) - 32)];
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103, STOP);
  const widths = [];
  for (const value of values) for (const digit of CODE128_PATTERNS[value]) widths.push(Number(digit));
  return widths;
}

/** Sağlama hanesi ayrıca gerekirse (test ve doğrulama için). */
export function code128Checksum(code) {
  if (!encodable(code)) throw new Error('Bu kod Code 128 ile basılamaz.');
  let sum = START_B;
  [...code].forEach((ch, index) => { sum += (ch.charCodeAt(0) - 32) * (index + 1); });
  return sum % 103;
}

export const LABEL_SIZES = {
  // GS1 barkodları EAN-13 ile basılır: 95 modül + sessiz alan, %100 büyütmede ~37,3 mm.
  // Bu yüzden 38 mm etiket resmî bir EAN-13'ü taşır. Code 128 aynı 13 haneyi
  // belirgin biçimde daha geniş çizer; o yüzden yalnızca EAN olmayan kodlarda kullanılır.
  small: {name: 'Küçük · 38 × 25 mm', width_mm: 38, height_mm: 25, module_mm: 0.28, font: 6.5},
  medium: {name: 'Orta · 50 × 30 mm', width_mm: 50, height_mm: 30, module_mm: 0.33, font: 7.5},
  large: {name: 'Büyük · 70 × 40 mm', width_mm: 70, height_mm: 40, module_mm: 0.4, font: 9},
  carton: {name: 'Koli · 100 × 70 mm', width_mm: 100, height_mm: 70, module_mm: 0.5, font: 11}
};

const MM = 72 / 25.4;   // 1 mm kaç PDF punto eder

/**
 * Bir etiketin çizim planı. Saf hesap: konumlar ve genişlikler, milimetre cinsinden.
 *
 * Semboloji koda göre seçilir: GS1'den alınmış resmî EAN-13/EAN-8 barkodlar kendi
 * sembolojisiyle basılır (dar ve her okuyucuda tanınır); GS1 olmayan kodlar ve
 * "LP-" iç kodları Code 128 ile basılır.
 *
 * Modül genişliği etikete sığmıyorsa daraltılır ama okunabilirlik alt sınırının
 * altına DÜŞÜRÜLMEZ; sığmıyorsa daha büyük etiket istenir.
 */
export function labelPlan({code, size = 'medium'}) {
  const preset = LABEL_SIZES[size];
  if (!preset) throw new Error('Etiket boyutu geçersiz.');
  const usableMm = preset.width_mm - 3;              // kenar boşluğu

  if (isEan(code)) {
    const {modules, guards, lead, left, right} = eanModules(code);
    const totalModules = modules.length + EAN_QUIET_LEFT + EAN_QUIET_RIGHT;
    const moduleMm = Math.min(preset.module_mm, usableMm / totalModules);
    if (moduleMm < EAN_MIN_MODULE_MM)
      throw new Error('Bu barkod seçilen etikete GS1 asgari büyütmesinde sığmıyor. Daha büyük etiket seçin.');
    const symbolWidthMm = modules.length * moduleMm;
    const quietLeftMm = EAN_QUIET_LEFT * moduleMm;
    const totalWidthMm = totalModules * moduleMm;
    const startMm = (preset.width_mm - totalWidthMm) / 2 + quietLeftMm;
    const height = Math.max(10, preset.height_mm - (preset.height_mm > 45 ? 26 : 12));
    const isGuard = index => guards.some(([from, to]) => index >= from && index < to);
    // Koruma çubukları standarda göre daha uzundur; okuyucu yarıları buradan ayırır.
    const bars = eanBars(modules).map(bar => ({
      x_mm: startMm + bar.from * moduleMm,
      width_mm: bar.width * moduleMm,
      height_mm: isGuard(bar.from) ? height + moduleMm * 5 : height
    }));
    return {
      code, size, preset, symbology: modules.length === 95 ? 'ean13' : 'ean8',
      module_mm: moduleMm, bars,
      bars_width_mm: symbolWidthMm,
      start_x_mm: startMm,
      quiet_left_mm: quietLeftMm,
      bar_height_mm: height + moduleMm * 5,
      human: {lead, left, right},
      page: {width_pt: preset.width_mm * MM, height_pt: preset.height_mm * MM},
      mm_to_pt: MM
    };
  }

  const widths = code128Bars(code);
  const modules = widths.reduce((total, width) => total + width, 0);
  const quietModules = 10 * 2;
  const moduleMm = Math.min(preset.module_mm, usableMm / (modules + quietModules));
  if (moduleMm < 0.19)
    throw new Error('Bu kod seçilen etikete okunabilir biçimde sığmıyor. Daha büyük etiket seçin.');
  const barsWidthMm = modules * moduleMm;
  const startMm = (preset.width_mm - barsWidthMm) / 2;
  const height = Math.max(8, preset.height_mm - (preset.height_mm > 45 ? 26 : 12));
  let x = startMm, paint = true;
  const bars = [];
  for (const width of widths) {
    const w = width * moduleMm;
    if (paint) bars.push({x_mm: x, width_mm: w, height_mm: height});
    x += w;
    paint = !paint;
  }
  return {
    code, size, preset, symbology: 'code128',
    module_mm: moduleMm, bars,
    bars_width_mm: barsWidthMm,
    start_x_mm: startMm,
    quiet_left_mm: 10 * moduleMm,
    bar_height_mm: height,
    human: null,
    page: {width_pt: preset.width_mm * MM, height_pt: preset.height_mm * MM},
    mm_to_pt: MM
  };
}

/**
 * Yazdırma için etiket sayfası. Satır içi stil YOKTUR: panelin güvenlik politikası
 * (style-src 'self') satır içi stilleri ve gömülü <style> bloklarını engelliyor,
 * etiketler stilsiz basılırdı. Ölçüler print.css içindeki .labels sınıflarından gelir.
 * SVG x/width birer sunum özniteliğidir, satır içi stil değildir; politikaya takılmaz.
 */
export function labelPrintHtml(labels, {size = 'medium'} = {}) {
  const preset = LABEL_SIZES[size];
  if (!preset) throw new Error('Etiket boyutu geçersiz.');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
  const cells = labels.map(label => {
    const plan = labelPlan({code: label.code, size});
    const rects = plan.bars
      .map(bar => `<rect x="${bar.x_mm.toFixed(3)}" y="0" width="${bar.width_mm.toFixed(3)}" height="${bar.height_mm.toFixed(3)}"/>`)
      .join('');
    // EAN'de okunabilir haneler standarda göre bölünür: ilk hane solda, kalanlar iki yarıda.
    const human = plan.human
      ? `<div class="ean"><span class="lead">${escapeHtml(plan.human.lead)}</span><span class="half">${escapeHtml(plan.human.left)}</span><span class="half">${escapeHtml(plan.human.right)}</span></div>`
      : `<div class="code">${escapeHtml(label.code)}</div>`;
    const rows = (label.rows || []).map(([etiket, deger]) =>
      `<div class="row"><span>${escapeHtml(etiket)}</span><strong>${escapeHtml(deger)}</strong></div>`).join('');
    return `<div class="label">
      <div class="title">${escapeHtml(label.title || '')}</div>
      ${rows ? `<div class="rows">${rows}</div>` : ''}
      <svg viewBox="0 0 ${preset.width_mm} ${plan.bar_height_mm.toFixed(3)}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label.code)}">${rects}</svg>
      ${human}
      ${label.subtitle ? `<div class="sub">${escapeHtml(label.subtitle)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="labels ${size}">${cells}</div>`;
}
