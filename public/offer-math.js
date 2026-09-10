// Teklif / proforma / sözleşme satır hesabı. Saf hesap; veri erişimi ve yetki sunucudadır.
// Kuruş tam sayıdır. Yuvarlama SATIR BAZINDA yapılır ve toplam satırların toplamıdır;
// böylece belgede yazan satırlar alt alta toplandığında toplamı tutar.
// Bu belgeler stok düşmez, cariye borç/alacak yazmaz, resmî fatura değildir.

const MAX_CENTS = 100000000000;   // 1 milyar TL
const MAX_MILLI = 100000000000;   // 100 milyon adet

const whole = (value, label) => {
  if (!Number.isSafeInteger(value)) throw new Error(label + ' tam sayı olmalı.');
  return value;
};

export function offerLine(line) {
  const quantity = whole(line.quantity_milli, 'Miktar');
  if (quantity <= 0 || quantity > MAX_MILLI) throw new Error('Miktar sıfırdan büyük olmalı.');
  const unitPrice = whole(line.unit_price_cents, 'Birim fiyat');
  if (unitPrice < 0 || unitPrice > MAX_CENTS) throw new Error('Birim fiyat geçersiz.');
  const discount = whole(line.discount_bps ?? 0, 'İskonto oranı');
  if (discount < 0 || discount > 10000) throw new Error('İskonto oranı %0 ile %100 arasında olmalı.');
  const vat = whole(line.vat_bps ?? 0, 'KDV oranı');
  if (vat < 0 || vat > 10000) throw new Error('KDV oranı geçersiz.');

  const gross = Math.round(quantity * unitPrice / 1000);
  const discountCents = Math.round(gross * discount / 10000);
  const net = gross - discountCents;
  const vatCents = Math.round(net * vat / 10000);
  return {
    description: String(line.description ?? ''),
    unit: String(line.unit ?? 'adet'),
    product_id: line.product_id || null,
    quantity_milli: quantity,
    unit_price_cents: unitPrice,
    discount_bps: discount,
    vat_bps: vat,
    gross_cents: gross,
    discount_cents: discountCents,
    net_cents: net,
    vat_cents: vatCents,
    total_cents: net + vatCents
  };
}

export function offerTotals(lines = []) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Belgeye en az bir satır ekleyin.');
  if (lines.length > 200) throw new Error('Bir belgeye en fazla 200 satır girilebilir.');
  const rows = lines.map(offerLine);
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  const totals = {
    gross_cents: sum('gross_cents'),
    discount_cents: sum('discount_cents'),
    net_cents: sum('net_cents'),
    vat_cents: sum('vat_cents'),
    total_cents: sum('total_cents')
  };
  if (!Number.isSafeInteger(totals.total_cents) || totals.total_cents > MAX_CENTS)
    throw new Error('Belge toplamı sınırı aşıyor.');
  // KDV oranı başına döküm: belgede yasal olarak oran bazında gösterilir.
  const byRate = new Map();
  for (const row of rows) {
    const current = byRate.get(row.vat_bps) || {vat_bps: row.vat_bps, net_cents: 0, vat_cents: 0};
    current.net_cents += row.net_cents;
    current.vat_cents += row.vat_cents;
    byRate.set(row.vat_bps, current);
  }
  return {rows, ...totals, vat_breakdown: [...byRate.values()].sort((a, b) => a.vat_bps - b.vat_bps)};
}

export const OFFER_KINDS = {quote: 'Teklif', proforma: 'Proforma fatura', contract: 'Sözleşme'};
export const OFFER_PREFIX = {quote: 'TKF', proforma: 'PRF', contract: 'SZL'};

// Bir teklif proformaya, proforma sözleşmeye dönüşür. Zincir tek yönlüdür ve
// aynı işten iki kez belge üretilmesini engellemek için tek adım ileri gider.
export const NEXT_KIND = {quote: 'proforma', proforma: 'contract'};

export const OFFER_STATUS = {
  draft: 'Taslak',
  sent: 'Yanıt bekleniyor',
  accepted: 'Kabul edildi',
  rejected: 'Reddedildi',
  expired: 'Süresi doldu',
  cancelled: 'İptal edildi'
};

// Kapanmış belge: içerik de durum da bir daha değişmez.
export const CLOSED_STATUS = ['accepted', 'rejected', 'cancelled'];

/**
 * Süre dolması saklanan bir durum değil, tarihten okunan bir gerçektir.
 * Yanıt beklenirken geçerlilik günü geçtiyse belge kendiliğinden "süresi doldu" görünür;
 * kabul edilmiş ya da reddedilmiş belge sonradan süresi dolmuş sayılmaz.
 */
export function effectiveStatus(offer, todayIso) {
  if (offer.status === 'sent' && offer.valid_until && offer.valid_until < todayIso) return 'expired';
  return offer.status;
}

/** İndirmek, yazdırmak ya da göndermek kabul değildir; kabul ayrı ve bilinçli bir işlemdir. */
export function canAccept(offer, todayIso) {
  return effectiveStatus(offer, todayIso) === 'sent';
}
