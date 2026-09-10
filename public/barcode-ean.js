// EAN-13 / EAN-8 sembolojisi. İşletmenin barkodları GS1'den alınmış resmî barkodlar
// olduğu için etiketlerde bu semboloji kullanılır: EAN-13, 13 haneyi 95 modülde taşır ve
// aynı kodu Code 128 ile basmaktan belirgin biçimde dardır — 38 mm etikete sığar.
//
// Kod her zaman METİNDİR; baştaki sıfırlar korunur.
import {isValidGs1} from './barcode.js';

// Sol yarı, tek pariteli (L) ve çift pariteli (G); sağ yarı (R). Her hane 7 modül.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];

// İlk hane, sol yarının parite düzenini belirler; kendisi çizilmez, okunur hâlde yazılır.
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

const GUARD = '101', CENTER = '01010';

export const isEan13 = code => /^\d{13}$/.test(code) && isValidGs1(code);
export const isEan8 = code => /^\d{8}$/.test(code) && isValidGs1(code);
export const isEan = code => isEan13(code) || isEan8(code);

/**
 * Modül dizisi: her eleman 0 (boşluk) ya da 1 (bar). EAN-13 tam 95 modüldür.
 * Koruma çubukları (başlangıç, orta, bitiş) ayrıca işaretlenir; standart bunların
 * diğer barlardan daha uzun çizilmesini ister.
 */
export function ean13Modules(code) {
  if (!isEan13(code)) throw new Error('Geçerli bir EAN-13 barkodu değil.');
  const digits = [...code].map(Number);
  const parity = PARITY[digits[0]];
  let bits = GUARD;
  const guards = [];
  const mark = (from, length) => guards.push([from, from + length]);
  mark(0, GUARD.length);
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[digits[i + 1]];
  mark(bits.length, CENTER.length);
  bits += CENTER;
  for (let i = 7; i < 13; i++) bits += R[digits[i]];
  mark(bits.length, GUARD.length);
  bits += GUARD;
  if (bits.length !== 95) throw new Error('EAN-13 modül sayısı 95 olmalı.');
  return {modules: [...bits].map(Number), guards, lead: code[0], left: code.slice(1, 7), right: code.slice(7)};
}

export function ean8Modules(code) {
  if (!isEan8(code)) throw new Error('Geçerli bir EAN-8 barkodu değil.');
  const digits = [...code].map(Number);
  let bits = GUARD;
  const guards = [[0, GUARD.length]];
  for (let i = 0; i < 4; i++) bits += L[digits[i]];
  guards.push([bits.length, bits.length + CENTER.length]);
  bits += CENTER;
  for (let i = 4; i < 8; i++) bits += R[digits[i]];
  guards.push([bits.length, bits.length + GUARD.length]);
  bits += GUARD;
  if (bits.length !== 67) throw new Error('EAN-8 modül sayısı 67 olmalı.');
  return {modules: [...bits].map(Number), guards, lead: '', left: code.slice(0, 4), right: code.slice(4)};
}

export const eanModules = code => (isEan13(code) ? ean13Modules(code) : ean8Modules(code));

// GS1 ölçüleri: %100 büyütmede modül 0,33 mm'dir. Sessiz alan EAN-13'te solda 11,
// sağda 7 modüldür ve KISALTILAMAZ; kısaltılırsa okuyucu kodu kaçırır.
export const EAN_NOMINAL_MODULE_MM = 0.33;
export const EAN_MIN_MODULE_MM = 0.264;   // GS1 asgari büyütme (%80)
export const EAN_QUIET_LEFT = 11;
export const EAN_QUIET_RIGHT = 7;

/** Bitişik modülleri tek bara toplar; çizimde daha az dikdörtgen olur. */
export function eanBars(modules) {
  const bars = [];
  let at = 0;
  while (at < modules.length) {
    const value = modules[at];
    let width = 1;
    while (at + width < modules.length && modules[at + width] === value) width++;
    if (value === 1) bars.push({from: at, width});
    at += width;
  }
  return bars;
}
