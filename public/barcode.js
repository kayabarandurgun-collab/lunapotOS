// Barkod okuma ve doğrulama. Yalnızca ÜRETİM (lp) çalışma alanında kullanılır.
// Saf hesap; veri erişimi ve yetki sunucudadır.
//
// İki kural burada korunur:
// 1. Baştaki sıfırlar kaybolmaz. Kod her zaman METİNDİR, hiçbir yerde sayıya çevrilmez.
// 2. Kendi ürettiğimiz kod GS1 barkodu DEĞİLDİR; "iç kullanım kodu" olarak işaretlenir.

// Okuyucular Enter, sekme ve gorunmez denetim karakteri gonderir. Bunlar kod
// noktasindan suzulur; dosyada ham denetim karakteri bulunmaz, aksi halde dosya
// ikili gorunur ve aramada kaybolur.
const isControl = ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;

export const BARCODE_KINDS = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upca: 'UPC-A',
  itf14: 'ITF-14',
  other: 'Diğer barkod',
  internal: 'İç kullanım kodu'
};

/**
 * Okuyucular sonuna Enter, bazen boşluk ve görünmez denetim karakteri ekler.
 * Bunlar temizlenir; rakamlara DOKUNULMAZ, baştaki sıfır korunur.
 */
export function normalizeBarcode(raw) {
  if (typeof raw !== 'string') throw new Error('Barkod metni bekleniyor.');
  const code = [...raw].filter(ch => !isControl(ch)).join('').trim();
  if (!code) throw new Error('Barkod boş olamaz.');
  if (code.length > 48) throw new Error('Barkod en fazla 48 karakter olabilir.');
  if (!/^[0-9A-Za-z][0-9A-Za-z._\-/]*$/.test(code))
    throw new Error('Barkod yalnızca harf, rakam ve - . _ / karakterlerini içerebilir.');
  return code;
}

/** GS1 kontrol hanesi: sağdan sola 3-1-3-1… ağırlıklarla toplanır. */
export function gs1CheckDigit(digitsWithoutCheck) {
  if (!/^\d+$/.test(digitsWithoutCheck)) throw new Error('Yalnızca rakam bekleniyor.');
  let sum = 0;
  const reversed = [...digitsWithoutCheck].reverse();
  for (let i = 0; i < reversed.length; i++) sum += Number(reversed[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function isValidGs1(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

const GS1_KIND = {8: 'ean8', 12: 'upca', 13: 'ean13', 14: 'itf14'};

/**
 * Kodun ne olduğunu söyler. Doğrulanamayan sayısal kod GS1 SAYILMAZ;
 * "other" olarak geçer ve hiçbir belgede GS1 gibi sunulmaz.
 */
export function classifyBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (/^LP-/.test(code))
    return {code, kind: 'internal', gs1: false, note: 'İç kullanım kodu. GS1 barkodu değildir, işletme dışında geçerli değildir.'};
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) {
    if (isValidGs1(code)) return {code, kind: GS1_KIND[code.length], gs1: true, note: 'Kontrol hanesi doğrulandı.'};
    return {code, kind: 'other', gs1: false, note: 'Uzunluğu GS1 barkoduna benziyor ama kontrol hanesi tutmuyor. Kod okunduğu gibi saklanır; GS1 barkodu olarak sunulmaz.'};
  }
  return {code, kind: 'other', gs1: false, note: 'Tanınan bir GS1 biçimi değil. Kod okunduğu gibi saklanır.'};
}

/**
 * Barkodu olmayan ürün için iç kod üretir. GS1 numara alanına girmemek için
 * kasten harfle başlar ve "LP-" ön eki taşır.
 */
export function internalCode(random = crypto.randomUUID()) {
  const body = String(random).replace(/[^0-9a-fA-F]/g, '').slice(0, 10).toUpperCase();
  if (body.length < 10) throw new Error('İç kod üretilemedi.');
  return 'LP-' + body;
}

/**
 * Bir okutmanın kaç birim ettiği. Bağlantıda ambalaj miktarı tanımlıysa
 * 1 okutma = o miktar; tanımlı değilse 1 okutma = 1 birimdir.
 * Kart biriminden başka bir birime SESSİZCE çevirmez.
 */
export function scanQuantityMilli(link, scans = 1) {
  if (!Number.isSafeInteger(scans) || scans < 1) throw new Error('Okutma sayısı en az 1 olmalı.');
  const pack = link?.pack_quantity_milli;
  if (pack === null || pack === undefined) return scans * 1000;
  if (!Number.isSafeInteger(pack) || pack <= 0) throw new Error('Ambalaj miktarı geçersiz.');
  const total = pack * scans;
  if (!Number.isSafeInteger(total)) throw new Error('Toplam miktar sınırı aşıyor.');
  return total;
}

/** Ekranda "1 okutma = 20 kg" diye yazmak için. */
export function packWording(link, unit) {
  const pack = link?.pack_quantity_milli;
  if (pack === null || pack === undefined) return `1 okutma = 1 ${unit}`;
  const amount = new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(pack / 1000);
  return `1 okutma = ${amount} ${unit}`;
}

/**
 * Sayımda fark. Sayılmayan kart FARK ÜRETMEZ: sistemde ne varsa o kalır.
 * Sıfıra çekmek ayrı ve bilinçli bir karardır, sayımın yan etkisi değildir.
 */
export function countDifference({system_milli, counted_milli}) {
  if (!Number.isSafeInteger(system_milli) || system_milli < 0) throw new Error('Sistem miktarı geçersiz.');
  if (counted_milli === null || counted_milli === undefined)
    return {status: 'uncounted', difference_milli: null, wording: 'Sayılmadı. Sistemdeki miktar değişmez.'};
  if (!Number.isSafeInteger(counted_milli) || counted_milli < 0) throw new Error('Sayılan miktar geçersiz.');
  const difference = counted_milli - system_milli;
  if (difference === 0) return {status: 'match', difference_milli: 0, wording: 'Sayım sistemle örtüşüyor.'};
  return {
    status: difference > 0 ? 'surplus' : 'shortage',
    difference_milli: difference,
    wording: difference > 0 ? 'Sayımda fazla çıktı.' : 'Sayımda eksik çıktı.'
  };
}

/**
 * Kamera aynı kodu saniyede birkaç kez okur. Aynı kod, verilen süre içinde
 * tekrar okunduğunda YOK SAYILIR; aksi hâlde tek okutma birden çok hareket üretirdi.
 * Elle giriş bu korumaya takılmaz: kullanıcı bilerek tekrar ediyordur.
 */
export function createScanGate(windowMs = 1500) {
  const seen = new Map();
  return {
    accept(code, now = Date.now(), manual = false) {
      const key = normalizeBarcode(code);
      if (!manual) {
        const last = seen.get(key);
        if (last !== undefined && now - last < windowMs) return false;
      }
      seen.set(key, now);
      return true;
    },
    reset() { seen.clear(); }
  };
}
