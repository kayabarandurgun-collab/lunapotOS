// Koli etiketi içeriği. Saf dönüşüm: bir koli kaydından basılacak etiketi üretir.
//
// Etiket üç ayrı kimliği BİRLİKTE ama KARIŞTIRMADAN taşır:
//   • ürün barkodu — ürünün kimliği (GS1'den alınmış resmî barkod)
//   • parti kodu   — o ürünün belirli bir üretimi
//   • koli sırası  — o parti içindeki kaçıncı koli
// Barkod alanına parti kodu basılmaz; parti kodu okunabilir metin olarak yazılır.

const dayText = value => { const [y, m, d] = String(value || '').split('-'); return d ? `${d}.${m}.${y}` : ''; };
const quantity = milli => milli === null || milli === undefined
  ? ''
  : new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(milli / 1000);

export const CARTON_NOTICE = 'Parti kodu ürün barkodu değildir. Bu etiket stok hareketi oluşturmaz.';

/**
 * Bir koli kaydını etikete çevirir. Kaynak, basım anında dondurulmuş snapshot'tır;
 * parti sonradan düzenlense bile basılmış etiketin anlamı değişmez.
 */
export function cartonLabel(carton, {lot, product} = {}) {
  const snapshot = carton.snapshot || {};
  const lotCode = snapshot.lot_code || lot?.lot_code || '';
  const name = snapshot.product_name || product?.name || lot?.product_name || '';
  const sku = snapshot.product_sku || product?.sku || lot?.product_sku || '';
  const unit = snapshot.unit || lot?.unit || '';
  const produced = snapshot.produced_on || lot?.produced_on || '';
  const bestBefore = snapshot.best_before ?? lot?.best_before ?? null;
  const rows = [
    ['Parti', lotCode],
    ['Koli', `${carton.sequence} / ${carton.total_cartons}`],
    ['İçindeki', `${quantity(carton.quantity_milli)} ${unit}`.trim()],
    ['Üretim', dayText(produced)]
  ];
  if (bestBefore) rows.push(['Son kullanma', dayText(bestBefore)]);
  if (sku) rows.push(['Ürün kodu', sku]);
  return {
    code: carton.barcode,
    title: name,
    rows,
    subtitle: CARTON_NOTICE
  };
}

/** Bir parti için basılacak etiket listesi; sıraya göre. */
export function cartonLabels(cartons, context = {}) {
  if (!Array.isArray(cartons) || !cartons.length) throw new Error('Basılacak koli etiketi yok.');
  return [...cartons].sort((a, b) => a.sequence - b.sequence).map(carton => cartonLabel(carton, context));
}

/**
 * Sihirbazın adımları. Her adım kendi sorusunu ve neyi doğruladığını bilir;
 * eksik bilgiyle sonraki adıma geçilmez.
 */
export const CARTON_STEPS = [
  {key: 'lot', title: 'Parti seç', help: 'Hangi üretimin kolilerini basıyorsun? Parti yoksa önce parti aç.'},
  {key: 'barcode', title: 'Barkod seç', help: 'Koli üzerine basılacak ürün barkodu. Parti kodu buraya basılmaz.'},
  {key: 'quantity', title: 'Koli içeriği', help: 'Bir koliye kaç adet giriyor ve kaç koli basılacak?'},
  {key: 'preview', title: 'Önizle ve bas', help: 'Etiketleri gör, sonra bas. Basılan etiket kaydı değiştirilemez.'}
];

/** Sihirbazın bir adımı geçilebilir mi? Geçilemiyorsa NEDEN geçilemediğini söyler. */
export function stepIssue(step, draft, {lot} = {}) {
  if (step === 'lot') {
    if (!draft.lot_id) return 'Bir parti seçin.';
    if (lot && lot.status !== 'open') return 'Bu parti kapalı; yeni koli etiketi basılamaz.';
    return null;
  }
  if (step === 'barcode') {
    if (!draft.barcode) return 'Koli üzerine basılacak barkodu seçin.';
    return null;
  }
  if (step === 'quantity') {
    const perCarton = Number(draft.quantity_per_carton);
    const count = Number(draft.count);
    if (!Number.isFinite(perCarton) || perCarton <= 0) return 'Koli içi adet sıfırdan büyük olmalı.';
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) return 'Koli sayısı 1 ile 500 arasında olmalı.';
    if (lot) {
      const already = lot.printed_cartons || 0;
      const total = Math.round(perCarton * 1000) * (already + count);
      if (total > lot.quantity_milli)
        return `Bu kadar koli partideki miktarı aşıyor. Partide ${quantity(lot.quantity_milli)} ${lot.unit} var, ${already} koli basılmış.`;
    }
    return null;
  }
  return null;
}

/** Basımdan önce özet: kullanıcı ne basacağını görmeden onaylamasın. */
export function cartonSummary(draft, {lot} = {}) {
  const perCarton = Number(draft.quantity_per_carton) || 0;
  const count = Number(draft.count) || 0;
  const already = lot?.printed_cartons || 0;
  return {
    lot_code: lot?.lot_code || '',
    product_name: lot?.product_name || '',
    barcode: draft.barcode || '',
    count,
    quantity_per_carton_milli: Math.round(perCarton * 1000),
    total_quantity_milli: Math.round(perCarton * 1000) * count,
    first_sequence: already + 1,
    last_sequence: already + count,
    already_printed: already,
    // Daha önce basılmış etiketler o günkü toplamı taşır: 3 koli basıldıysa üzerlerinde
    // "1/3" yazar. Şimdi 4 koli daha basınca yenileri "4/7" der. Bu, basılmış kâğıdın
    // gerçeğidir; sessizce geçilirse sahada karışır, o yüzden söylenir.
    mixed_totals: already > 0
      ? `Daha önce basılan ${already} etiketin üzerinde "${already}" toplamı yazıyor; yeni etiketler "${already + count}" diyecek. Tüm koliler aynı toplamı göstersin istiyorsanız önce partiyi kapatıp tek seferde basın.`
      : null,
    notice: CARTON_NOTICE
  };
}
