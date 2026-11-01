// BUYBOX MOTORU: tek bir ilan için "fiyat ne olmalı" kararı. Saf fonksiyon: ağ, veritabanı, saat yok.
//
// Kullanıcının kuralı (örnek: taban 179, çekilme 199):
//   rakip tabana ya da altına indi  → onu aşağıda bırak, çekilme fiyatına çık   179 → 199
//   rakip tabanın üstünde, bizden ucuz → aynı fiyata in                          185 → 185
//   aynı fiyatta sıra bizde değil   → taban izin veriyorsa 1 TL altına in        185 → 184
//   rakip bizden yukarıda           → 1 TL altına kadar birlikte çık             250 → 249
//   rakip yok                       → çekilme fiyatı
// Tavan YOKTUR: rakip yükselince ucuz kalmamak amaçtır. Yalnız hatalı fiyatın (9.999 TL gibi) peşine
// düşmemek için güvenlik sınırı vardır; aşılınca fiyat değişmez, kullanıcıya sorulur.
//
// DEĞİŞMEZLER: dönen fiyat tabanın altında olamaz; zarar sınırının altına ancak açık onayla iner;
// rakip fiyatı bilinmeyen, stoku bitmiş ya da kilitli ilana dokunulmaz. Kuruş cinsinden tam sayı çalışır.
export const BIR_TL = 100;
export const GUVENLIK_KATI = 3;         // güvenlik sınırı girilmemişse çekilme fiyatının bu katı
export const GUNLUK_SINIR = 96;         // ilan başına günlük değişiklik; iki robot birbirini kovalarsa fren

const tam = v => Number.isSafeInteger(v);

export const kurallarGecerli = r => tam(r?.taban_cents) && tam(r?.cekilme_cents) && r.taban_cents > 0 && r.cekilme_cents > r.taban_cents;
export const guvenlikSiniri = r => tam(r?.guvenlik_cents) && r.guvenlik_cents > 0 ? r.guvenlik_cents : r.cekilme_cents * GUVENLIK_KATI;

// Fiyat bu noktanın altına düşerse satış zarar yazar: (maliyet + kargo) / (1 - komisyon). KDV dahil, stopaj hariç.
export function zararSiniri({maliyet_cents: m, kargo_cents: k, komisyon_bp: c}) {
  if (!tam(m) || m <= 0) return null;
  const oran = tam(c) && c > 0 ? c : 0;
  if (oran >= 10000) return null;
  return Math.ceil((m + (tam(k) && k > 0 ? k : 0)) * 10000 / (10000 - oran));
}

// Aktif olmak için: taban zarar sınırının üstünde olmalı ya da kullanıcı açıkça onaylamış olmalı.
export const aktifOlabilir = r => kurallarGecerli(r) && (r.zarar_onay === 1 || (tam(r.zarar_cents) && r.taban_cents >= r.zarar_cents));

export function hedefFiyat(kural, gozlem) {
  const {taban_cents: taban, cekilme_cents: cekilme} = kural, {priceCents: fiyat, rivalCents: rakip, rank: sira, rakipVar} = gozlem;
  if (rakipVar === false) return {hedef: cekilme, neden: 'rakipsiz'};
  if (!tam(rakip) || rakip <= 0) return {neden: 'rakip_bilinmiyor'};
  if (rakip <= taban) return {hedef: cekilme, neden: 'cekil'};
  if (rakip > guvenlikSiniri(kural)) return {neden: 'hata_freni'};
  if (rakip < fiyat) return {hedef: rakip, neden: 'esitle'};
  if (rakip === fiyat) {
    if (!tam(sira) || sira === 1) return {neden: 'esit'};
    return rakip - BIR_TL >= taban ? {hedef: rakip - BIR_TL, neden: 'alta_in'} : {neden: 'esit_tabanda'};
  }
  const yukari = kural.yukari_esit === 1 ? rakip : rakip - BIR_TL;
  if (yukari > fiyat) return {hedef: yukari, neden: 'yukari'};
  return {neden: tam(sira) && sira > 1 ? 'fiyat_disi' : 'onde'};
}

export function buyboxKarari(kural, gozlem) {
  const yok = neden => ({degistir: false, neden});
  if (!kurallarGecerli(kural)) return yok('ayar_yok');
  const {priceCents: fiyat, stock, kilit, artisKilit, dususKilit} = gozlem || {};
  if (!tam(fiyat) || fiyat <= 0) return yok('fiyat_yok');
  if (kilit) return yok('kilitli');
  if (tam(stock) && stock <= 0) return yok('stok_yok');
  const {hedef, neden} = hedefFiyat(kural, gozlem);
  if (!tam(hedef) || hedef === fiyat) return yok(tam(hedef) ? 'yerinde' : neden);
  if (hedef < kural.taban_cents) return yok('taban_alti');
  if (kural.zarar_onay !== 1 && tam(kural.zarar_cents) && hedef < kural.zarar_cents) return yok('zarar_kilidi');
  if (hedef > fiyat ? artisKilit : dususKilit) return yok('yon_kilitli');
  if ((kural.changes_today || 0) >= GUNLUK_SINIR) return yok('gunluk_sinir');
  return {degistir: true, yeniCents: hedef, neden};
}
