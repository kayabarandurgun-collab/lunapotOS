// Belge Atölyesi'nin sayı giriş adaptörü.
//
// Atölyenin özgün `n()` fonksiyonu String(v).replace(',','.') yapıyordu: yalnız İLK
// virgülü çevirdiği için "1.234,56" → "1.234.56" → NaN oluyordu. Burada tahmin
// YÜRÜTÜLMEZ: tek ondalık ayırıcı kabul edilir, binlik ayırıcı reddedilir.
//
// Kanonik hedef birimler (public/offer-math.js): 1000 milli = 1 birim,
// 100 kuruş = 1 TL, 100 bps = %1. Fazla hassasiyet sessiz Math.round ile
// kesilmez; kullanıcıdan düzeltme istenir.

export const LIMITS = {
  quantity_milli: {min: 1, max: 100000000000},
  unit_price_cents: {min: 0, max: 100000000000},
  bps: {min: 0, max: 10000}
};

export class SayiHatasi extends Error {
  constructor(message, {field = '', value = ''} = {}) {
    super(message);
    this.name = 'SayiHatasi';
    this.field = field;
    this.value = value;
  }
}

const bos = value => value === undefined || value === null || String(value).trim() === '';

/**
 * Metni tamsayı ölçeğe çevirir. Ondalık basamak sayısı aşılırsa HATA verir.
 * @param {string|number} raw kullanıcı girişi
 * @param {object} options {decimals, label, min, max, allowEmpty}
 * @returns {number|null} ölçeklenmiş tamsayı; boş ve allowEmpty ise null
 */
export function parseScaled(raw, {decimals, label, min = 0, max = Number.MAX_SAFE_INTEGER, allowEmpty = false} = {}) {
  if (bos(raw)) {
    // Birim fiyat boşsa SIFIR SAYILMAZ: kullanıcı açıkça yazmalı.
    if (allowEmpty) return null;
    throw new SayiHatasi(label + ' alanı boş bırakılamaz. Sıfır istiyorsan 0 yaz.', {field: label, value: raw});
  }
  // Yalnız baş ve son boşluk kırpılır. İÇ boşluk silinmez: "1 234" bir binlik
  // ayırıcı tahminidir ve reddedilir.
  const text = String(raw).trim();
  if (/[\s ]/.test(text))
    throw new SayiHatasi(label + ' içinde boşluk var. Binlik ayırıcı yazma: "1234,56".', {field: label, value: raw});
  if (text.startsWith('-'))
    throw new SayiHatasi(label + ' eksi olamaz.', {field: label, value: raw});
  const sade = text.replace(/^\+/, '');

  const nokta = (sade.match(/\./g) || []).length;
  const virgul = (sade.match(/,/g) || []).length;
  // Binlik ayırıcıda TAHMİN YÜRÜTÜLMEZ: iki ayırıcı birlikte gelemez.
  if (nokta && virgul)
    throw new SayiHatasi(label + ' için tek ondalık ayırıcı kullan: "1234,56" ya da "1234.56". Binlik ayırıcı yazma.', {field: label, value: raw});
  if (nokta > 1 || virgul > 1)
    throw new SayiHatasi(label + ' içinde birden fazla ayırıcı var. Binlik ayırıcı yazma: "1234,56".', {field: label, value: raw});

  const ayrilmis = sade.replace(',', '.');
  if (!/^\d*(?:\.\d*)?$/.test(ayrilmis) || ayrilmis === '' || ayrilmis === '.')
    throw new SayiHatasi(label + ' sayı olmalı.', {field: label, value: raw});

  const [tam, kesir = ''] = ayrilmis.split('.');
  if (kesir.length > decimals)
    throw new SayiHatasi(label + ' en çok ' + decimals + ' ondalık basamak alır. Girdiğin değeri yuvarlamıyorum, sen düzelt: "' + raw + '".',
      {field: label, value: raw});

  const olcek = 10 ** decimals;
  // Tamsayı aritmetiği: ondalık kayan nokta hatası girmesin.
  const deger = Number(tam || '0') * olcek + Number((kesir + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (!Number.isSafeInteger(deger))
    throw new SayiHatasi(label + ' çok büyük.', {field: label, value: raw});
  if (deger < min || deger > max)
    throw new SayiHatasi(label + ' izin verilen aralığın dışında.', {field: label, value: raw});
  return deger;
}

/** Miktar → quantity_milli (3 ondalık). */
export const toQuantityMilli = raw =>
  parseScaled(raw, {decimals: 3, label: 'Miktar', min: LIMITS.quantity_milli.min, max: LIMITS.quantity_milli.max});

/** Birim fiyat → unit_price_cents (2 ondalık). Boş bırakılabilir; sıfır sayılmaz. */
export const toPriceCents = raw =>
  parseScaled(raw, {decimals: 2, label: 'Birim fiyat', min: LIMITS.unit_price_cents.min, max: LIMITS.unit_price_cents.max, allowEmpty: true});

/** Yüzde oran → bps (2 ondalık). %20 → 2000. Boş = 0 oran. */
export const toBps = (raw, label = 'Oran') => {
  if (bos(raw)) return 0;
  return parseScaled(raw, {decimals: 2, label, min: LIMITS.bps.min, max: LIMITS.bps.max});
};

/**
 * Atölye satırını kanonik offers satırına çevirir.
 * Birim fiyat boşsa HATA verir: belgeye sıfır fiyat sessizce yazılmaz.
 */
export function toCanonicalLine(item, index) {
  const yer = ' (satır ' + (index + 1) + ')';
  const sar = fn => { try { return fn(); } catch (error) { throw new SayiHatasi(error.message + yer, error); } };
  const price = sar(() => toPriceCents(item.price));
  if (price === null)
    throw new SayiHatasi('Birim fiyat yazılmamış' + yer + '. Boş fiyat sıfır sayılmaz.', {field: 'Birim fiyat'});
  return {
    description: String(item.name ?? '').trim(),
    unit: String(item.unit ?? '').trim(),
    product_id: item.product_id ?? null,
    quantity_milli: sar(() => toQuantityMilli(item.qty)),
    unit_price_cents: price,
    discount_bps: sar(() => toBps(item.discount, 'İskonto oranı')),
    vat_bps: sar(() => toBps(item.vat, 'KDV oranı'))
  };
}
