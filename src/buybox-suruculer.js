// BUYBOX SÜRÜCÜLERİ: Hepsiburada ve Trendyol'un ayrı API'lerini tek biçime çevirir. Karar vermez.
//   urunSayfasi → satıcının ilanları, gozle → fiyat/stok/sıra/rakip, fiyatGonder → yükleme kimliği,
//   sonuc → yüklemenin ilan başına sonucu. Fiyat yüklemeleri iki platformda da ASENKRONDUR.
//
// Hepsiburada buybox-orders yanıtının ŞEMASI BELGELENMEMİŞ ("200 Success", gövde yok). Alan adı tahmin
// edilip yanlış sıra okunursa fiyat yanlış yöne gider: yalnız bu listelerdeki adlar kabul edilir, gerisi
// "bilinmiyor" sayılır ve o ilana dokunulmaz. Gerçek alanlar "Bağlantıyı sına" ile ekrana yazılır.
const fail = (message, status = 502) => { throw Object.assign(new Error(message), {status}); };
const kurus = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
const adet = v => Number.isSafeInteger(v) ? v : null;
const parcala = (liste, boy) => { const p = []; for (let i = 0; i < liste.length; i += boy) p.push(liste.slice(i, i + boy)); return p; };
const kisa = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';

async function istek(env, ad, url, baslik, secenek = {}) {
  const f = env.BUYBOX_FETCHER || fetch;
  let cevap;
  try {
    cevap = await f(url, {method: secenek.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: {...baslik, Accept: 'application/json', ...(secenek.body ? {'Content-Type': 'application/json'} : {})},
      ...(secenek.body ? {body: JSON.stringify(secenek.body)} : {})});
  } catch { fail(ad + '\'ya ulaşılamadı.'); }
  if (cevap.status === 401 || cevap.status === 403) fail(ad + ' kimlik bilgilerini ya da bu ucun iznini reddetti (' + cevap.status + ').');
  if (cevap.status === 429) fail(ad + ' istek sınırına takıldı; sonraki turda denenecek.');
  if (!cevap.ok) {
    const metin = await cevap.text().catch(() => '');
    // Trendyol aynı gövdeyi 15 dakika reddeder: arıza değil, sonraki turda fiyat farklıysa geçer.
    if (/15 dakika/.test(metin)) throw Object.assign(new Error(ad + ' aynı isteği 15 dakika kabul etmiyor.'), {status: 502, tekrar: true});
    fail(ad + ' ' + cevap.status + ' döndü.');
  }
  try { return await cevap.json(); } catch { fail(ad + ' yanıtı okunamadı.'); }
}

// ---------- Hepsiburada ----------
const HB_TABAN = 'https://listing-external.hepsiburada.com', HB_PARTI = 50;
const SIRA_ALANI = ['buyboxOrder', 'buyBoxOrder', 'order', 'rank'], SKU_ALANI = ['hepsiburadaSku', 'hbSku', 'sku', 'merchantSku'],
  LIDER_ALANI = ['buyboxPrice', 'buyBoxPrice'], IKINCI_ALANI = ['secondBuyboxPrice', 'secondBuyBoxPrice'], COKLU_ALANI = ['hasMultipleSeller'];
const ilk = (kayit, alanlar) => { for (const a of alanlar) if (kayit?.[a] !== undefined && kayit[a] !== null) return kayit[a]; return null; };

export function buyboxSatirlari(govde) {
  if (Array.isArray(govde)) return govde;
  for (const a of ['data', 'listings', 'items', 'buyboxOrders', 'buyboxInfo']) if (Array.isArray(govde?.[a])) return govde[a];
  return null;
}

// Yanıtın alan ADLARI (değerleri değil): şema doğrulaması için ekrana ve log'a yazılır.
export const alanAdlari = govde => { const satir = buyboxSatirlari(govde)?.[0]; return satir && typeof satir === 'object' ? Object.keys(satir).slice(0, 40) : []; };

// Sıra 1'de rakip = 2. satıcı, değilse rakip = buybox sahibi. Çoklu satıcı açıkça "hayır" ise rakip yoktur.
export function rakibiBul(sira, lider, ikinci, coklu) {
  if (coklu === false) return {rakipVar: false, rivalCents: null};
  if (!Number.isSafeInteger(sira) || sira < 1) return {rakipVar: null, rivalCents: null};
  return {rakipVar: null, rivalCents: sira === 1 ? ikinci : lider};
}

export function hbSiraOku(govde) {
  const harita = new Map();
  for (const kayit of buyboxSatirlari(govde) || []) {
    const sku = ilk(kayit, SKU_ALANI), sira = ilk(kayit, SIRA_ALANI);
    if (typeof sku !== 'string' || !sku) continue;
    const rank = Number.isSafeInteger(sira) ? sira : null;
    harita.set(sku.toUpperCase(), {rank, ...rakibiBul(rank, kurus(ilk(kayit, LIDER_ALANI)), kurus(ilk(kayit, IKINCI_ALANI)), ilk(kayit, COKLU_ALANI))});
  }
  return harita;
}

// Şu an yürürlükteki kampanya fiyatı liste fiyatından farklıysa robot o ilana karışmaz.
const hbKampanyada = (l, simdi) => (Array.isArray(l?.pricings) ? l.pricings : []).some(p => {
  const a = Date.parse(p?.startDate), b = Date.parse(p?.endDate);
  return Number.isFinite(a) && Number.isFinite(b) && a <= simdi && simdi <= b && typeof p.finalPrice === 'number' && p.finalPrice !== l.price;
});

export function hbKilidi(l, simdi) {
  if (!l) return null;
  if (l.isSuspended) return 'askıda';
  if (l.isLocked) return 'kilitli';
  if (l.isFrozen) return 'donuk';
  if (l.isSalable === false) return 'satışta değil';
  return hbKampanyada(l, simdi) ? 'kampanyada' : null;
}

// Hata/doğrulama varsa 'hata', bitti ise 'tamam', yoksa 'bekliyor'. Durum kelimeleri belgede yok: ilk gerçek yüklemede bakılacak.
export function hbYuklemeDurumu(g) {
  if (!g || typeof g !== 'object') return 'bekliyor';
  if (g.errors?.length || g.priceValidations?.length) return 'hata';
  const s = String(g.status || '');
  if (/fail|error|invalid|reject/i.test(s)) return 'hata';
  return /done|success|complete|finish/i.test(s) ? 'tamam' : 'bekliyor';
}

const hb = kimlik => {
  const baslik = {Authorization: 'Basic ' + btoa(kimlik.key + ':' + kimlik.secret), 'User-Agent': kimlik.user_agent};
  const kok = HB_TABAN + '/listings/merchantid/' + encodeURIComponent(kimlik.seller_id);
  return {
    parti: HB_PARTI,
    async urunSayfasi(env, sayfa) {
      const g = await istek(env, 'Hepsiburada', kok + '?' + new URLSearchParams({offset: sayfa * 100, limit: 100}), baslik);
      const liste = Array.isArray(g?.listings) ? g.listings : fail('Hepsiburada ilan listesi okunamadı.');
      return {bitti: liste.length < 100, urunler: liste.filter(l => typeof l.hepsiburadaSku === 'string' && l.hepsiburadaSku).map(l => ({
        sku: l.hepsiburadaSku.slice(0, 100), merchant_sku: kisa(l.merchantSku, 200), label: kisa(l.merchantSku, 200) || l.hepsiburadaSku.slice(0, 100),
        url: 'https://www.hepsiburada.com/ara?q=' + encodeURIComponent(l.hepsiburadaSku), price_cents: kurus(l.price), list_cents: null, stock: adet(l.availableStock), komisyon_bp: null}))};
    },
    async gozle(env, skular, simdi) {
      const ilanlar = await istek(env, 'Hepsiburada', kok + '?' + new URLSearchParams({offset: 0, limit: HB_PARTI, hbSkuList: skular.join(',')}), baslik);
      const siraGovde = await istek(env, 'Hepsiburada', HB_TABAN + '/buybox-orders/merchantid/' + encodeURIComponent(kimlik.seller_id) + '?' + new URLSearchParams({skuList: skular.join(',')}), baslik);
      const sira = hbSiraOku(siraGovde), sonuc = new Map();
      for (const l of Array.isArray(ilanlar?.listings) ? ilanlar.listings : []) {
        const anahtar = String(l.hepsiburadaSku || '').toUpperCase(), s = sira.get(anahtar);
        sonuc.set(anahtar, {priceCents: kurus(l.price), listCents: null, stock: adet(l.availableStock), rank: s?.rank ?? null, rivalCents: s?.rivalCents ?? null, rakipVar: s?.rakipVar ?? null,
          kilit: hbKilidi(l, simdi), artisKilit: !!l.priceIncreaseDisabled, dususKilit: !!l.priceDecreaseDisabled});
      }
      return {gozlemler: sonuc, alanlar: alanAdlari(siraGovde)};
    },
    async fiyatGonder(env, kalemler) {
      const c = await istek(env, 'Hepsiburada', kok + '/price-uploads', baslik, {method: 'POST', body: kalemler.map(k => ({hepsiburadaSku: k.sku, price: k.cents / 100}))});
      return typeof c?.id === 'string' && c.id ? c.id : fail('Hepsiburada fiyat yüklemesine kimlik dönmedi.');
    },
    async sonuc(env, id, skular) {
      const g = await istek(env, 'Hepsiburada', kok + '/price-uploads/id/' + encodeURIComponent(id), baslik), durum = hbYuklemeDurumu(g);
      const neden = durum === 'hata' ? String(g?.errors?.[0]?.message || g?.priceValidations?.[0]?.description || 'Hepsiburada fiyatı kabul etmedi.').slice(0, 300) : null;
      return new Map(skular.map(s => [s, {durum, neden}]));
    }
  };
};

// ---------- Trendyol ----------
const TY_TABAN = 'https://apigw.trendyol.com/integration', TY_URUN_PARTI = 50, TY_SIRA_PARTI = 10;

// Belge örneği: buyboxPrice = 1. satıcı, secondBuyboxPrice = 2., thirdBuyboxPrice = 3.
export function tySiraOku(govde) {
  const harita = new Map();
  for (const k of Array.isArray(govde?.buyboxInfo) ? govde.buyboxInfo : []) {
    if (typeof k?.barcode !== 'string' || !k.barcode) continue;
    const rank = Number.isSafeInteger(k.buyboxOrder) ? k.buyboxOrder : null;
    harita.set(k.barcode.toUpperCase(), {rank, ...rakibiBul(rank, kurus(k.buyboxPrice), kurus(k.secondBuyboxPrice), k.hasMultipleSeller)});
  }
  return harita;
}

export function tyKilidi(v) {
  if (!v) return null;
  if (v.archived) return 'arşivde';
  if (v.locked) return 'kilitli';
  if (v.blacklisted) return 'kara listede';
  if (v.onSale === false) return 'satışta değil';
  const g = kurus(v.price?.priceSeenByCustomer), s = kurus(v.price?.salePrice);
  return g !== null && s !== null && g !== s ? 'kampanyada' : null;
}

const tyVaryantlari = g => (Array.isArray(g?.content) ? g.content : []).flatMap(c => (Array.isArray(c?.variants) ? c.variants : []).map(v => ({c, v})));

// Stok ve fiyat işlemlerinde batch status DÖNMEZ (belge): yalnız ilan başına status okunur.
export function tySonucOku(g, skular) {
  const satirlar = new Map((Array.isArray(g?.items) ? g.items : []).map(i => [String(i?.requestItem?.barcode ?? '').toUpperCase(), i]));
  return new Map(skular.map(s => {
    const i = satirlar.get(s.toUpperCase());
    if (i?.status === 'SUCCESS') return [s, {durum: 'tamam', neden: null}];
    if (i?.status === 'FAILED') return [s, {durum: 'hata', neden: String(i.failureReasons?.[0] || 'Trendyol fiyatı kabul etmedi.').slice(0, 300)}];
    return [s, {durum: 'bekliyor', neden: null}];
  }));
}

const ty = kimlik => {
  const baslik = {Authorization: 'Basic ' + btoa(kimlik.key + ':' + kimlik.secret), 'User-Agent': kimlik.user_agent || kimlik.seller_id + ' - SelfIntegration'};
  const urun = TY_TABAN + '/product/sellers/' + encodeURIComponent(kimlik.seller_id);
  return {
    parti: TY_URUN_PARTI,
    async urunSayfasi(env, sayfa) {
      const g = await istek(env, 'Trendyol', urun + '/products/approved?' + new URLSearchParams({page: sayfa, size: 100}), baslik);
      if (!Array.isArray(g?.content)) fail('Trendyol ürün listesi okunamadı.');
      return {bitti: g.content.length < 100, urunler: tyVaryantlari(g).filter(({v}) => typeof v.barcode === 'string' && v.barcode).map(({c, v}) => {
        const ek = (Array.isArray(v.attributes) ? v.attributes : []).map(a => a?.attributeValue).filter(Boolean).join(' ');
        return {sku: v.barcode.slice(0, 100), merchant_sku: kisa(v.stockCode, 200), label: kisa([c.title, ek].filter(Boolean).join(' · '), 200) || v.barcode.slice(0, 100),
          url: /^https:\/\//.test(v.productUrl || '') ? v.productUrl.slice(0, 500) : '', price_cents: kurus(v.price?.salePrice), list_cents: kurus(v.price?.listPrice), stock: adet(v.stock?.quantity), komisyon_bp: typeof v.commission === 'number' ? Math.round(v.commission * 100) : null};
      })};
    },
    async gozle(env, skular) {
      const sonuc = new Map(), sira = new Map();
      let alanlar = [];
      for (const parti of parcala(skular, TY_SIRA_PARTI)) {
        const g = await istek(env, 'Trendyol', urun + '/products/buybox-information', baslik, {method: 'POST', body: {barcodes: parti}});
        for (const [a, b] of tySiraOku(g)) sira.set(a, b);
        if (!alanlar.length) alanlar = alanAdlari(g);
      }
      const g = await istek(env, 'Trendyol', urun + '/products/approved?' + new URLSearchParams({barcodes: skular.join(','), page: 0, size: 100}), baslik);
      for (const {v} of tyVaryantlari(g)) {
        const anahtar = String(v.barcode || '').toUpperCase(), s = sira.get(anahtar);
        sonuc.set(anahtar, {priceCents: kurus(v.price?.salePrice), listCents: kurus(v.price?.listPrice), stock: adet(v.stock?.quantity), rank: s?.rank ?? null, rivalCents: s?.rivalCents ?? null, rakipVar: s?.rakipVar ?? null, kilit: tyKilidi(v), artisKilit: false, dususKilit: false});
      }
      return {gozlemler: sonuc, alanlar};
    },
    // quantity GÖNDERİLMEZ: belgeye göre yalnız fiyat güncellenebilir, stok ezilmez.
    // Satış fiyatı liste fiyatını geçemeyeceği için yükselirken liste fiyatı da taşınır.
    async fiyatGonder(env, kalemler) {
      const c = await istek(env, 'Trendyol', TY_TABAN + '/inventory/sellers/' + encodeURIComponent(kimlik.seller_id) + '/products/price-and-inventory', baslik, {method: 'POST',
        body: {items: kalemler.map(k => ({barcode: k.sku, salePrice: k.cents / 100, listPrice: Math.max(k.cents, k.listCents || 0) / 100}))}});
      return typeof c?.batchRequestId === 'string' && c.batchRequestId ? c.batchRequestId : fail('Trendyol fiyat yüklemesine kimlik dönmedi.');
    },
    async sonuc(env, id, skular) {
      return tySonucOku(await istek(env, 'Trendyol', urun + '/products/batch-requests/' + encodeURIComponent(id), baslik), skular);
    }
  };
};

export const surucu = (platform, kimlik) => platform === 'ty' ? ty(kimlik) : hb(kimlik);
