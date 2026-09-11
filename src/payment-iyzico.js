// iyzico Ödeme Formu (Checkout Form) sunucu adaptörü.
//
// Kaynak: iyzico resmî belgeleri (10 Eylül 2026'da okundu)
//   • Kimlik doğrulama IYZWSv2: HMACSHA256(randomKey + uri.path + body, secretKey) → küçük harf hex;
//     "apiKey:{k}&randomKey:{r}&signature:{s}" base64 → "IYZWSv2 {base64}", ayrıca x-iyzi-rnd başlığı.
//   • Başlatma: POST /payment/iyzipos/checkoutform/initialize/auth/ecom
//   • Sonuç sorgulama: POST /payment/iyzipos/checkoutform/auth/ecom/detail  {token}
//   • Yanıt imzası (detail): paymentStatus:paymentId:currency:basketId:conversationId:paidPrice:price:token
//     HMAC-SHA256(secretKey) hex; fiyatlarda sondaki sıfırlar atılır ("10.50" → "10.5").
//   • Webhook (CF): X-IYZ-SIGNATURE-V3 = HMAC-SHA256 hex(secretKey,
//     iyziEventType + iyziPaymentId + token + paymentConversationId + status)
//
// Kurallar:
//   • Tarayıcıya dönen "başarılı" sayfası ödeme KANITI DEĞİLDİR. Tahsilat yalnızca
//     sunucudan detail sorgusu yapılıp imza, tutar, para birimi ve sipariş kimliği
//     eşleştiğinde kabul edilir.
//   • Anahtarlar yalnızca sunucu sırrıdır (env); istemciye, depoya, günlüğe yazılmaz.
//   • Canlı uç yalnızca açıkça IYZICO_ENV=production verilirse kullanılır; varsayılan sandbox.

const encoder = new TextEncoder();

export const IYZICO_HOSTS = {
  sandbox: 'https://sandbox-api.iyzipay.com',
  production: 'https://api.iyzipay.com'
};
export const PATHS = {
  initialize: '/payment/iyzipos/checkoutform/initialize/auth/ecom',
  retrieve: '/payment/iyzipos/checkoutform/auth/ecom/detail'
};

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}

// Zamanlamaya dayalı karşılaştırma sızıntısı olmasın diye sabit süreli eşitlik.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Kuruş → iyzico fiyat metni. Sondaki sıfırlar atılır: 1050 → "10.5", 1000 → "10". */
export function formatPrice(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Tutar pozitif kuruş olmalı.');
  const whole = Math.floor(cents / 100), rest = cents % 100;
  if (!rest) return String(whole);
  return (whole + '.' + String(rest).padStart(2, '0')).replace(/0+$/, '');
}

/** iyzico'nun yanıtta döndürdüğü fiyatı imza için normalleştirir ("10.50" → "10.5"). */
export function normalizePrice(value) {
  const text = String(value ?? '');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Fiyat biçimi tanınmadı: ' + text);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** iyzico fiyat metni → kuruş. Kuruştan küçük hane varsa reddeder. */
export function priceToCents(value) {
  const text = normalizePrice(value);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 2) throw new Error('Kuruştan küçük tutar kabul edilmez: ' + text);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(cents)) throw new Error('Tutar sınırı aşıyor.');
  return cents;
}

export async function authorizationHeader({apiKey, secretKey, path, body, randomKey}) {
  if (!apiKey || !secretKey) throw new Error('iyzico anahtarları tanımlı değil.');
  const signature = await hmacHex(secretKey, randomKey + path + body);
  const authorization = btoa(`apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`);
  return `IYZWSv2 ${authorization}`;
}

export const randomKey = () => Date.now() + String(crypto.getRandomValues(new Uint32Array(1))[0]).padStart(10, '0');

/** Yanıt (detail) imzasını doğrular. İmza yoksa geçersiz sayılır. */
export async function verifyRetrieveSignature(response, secretKey) {
  if (!response || typeof response.signature !== 'string') return false;
  const data = [
    response.paymentStatus, response.paymentId, response.currency, response.basketId,
    response.conversationId, normalizePrice(response.paidPrice), normalizePrice(response.price), response.token
  ].join(':');
  return safeEqual(await hmacHex(secretKey, data), response.signature.toLowerCase());
}

/** Başlatma yanıtı imzası: conversationId:token */
export async function verifyInitializeSignature(response, secretKey) {
  if (!response || typeof response.signature !== 'string') return false;
  return safeEqual(await hmacHex(secretKey, `${response.conversationId}:${response.token}`), response.signature.toLowerCase());
}

/** Webhook (CF) imzası: X-IYZ-SIGNATURE-V3 */
export async function verifyWebhookSignature(payload, headerValue, secretKey) {
  if (!payload || typeof headerValue !== 'string' || !headerValue) return false;
  const data = String(secretKey) + payload.iyziEventType + payload.iyziPaymentId + payload.token + payload.paymentConversationId + payload.status;
  // Belge: SECRET KEY ve alanlar birleştirilir, HMAC-SHA256 ile özetlenir, HEX yazılır.
  return safeEqual(await hmacHex(secretKey, data), headerValue.toLowerCase());
}

/**
 * Siparişten başlatma isteği. Fiyat SUNUCUDAKİ siparişten gelir; istemciden gelen tutar kullanılmaz.
 * Sepet kalemlerinin toplamı "price" alanına eşit olmalıdır (iyzico kuralı); kargo ayrı kalem yapılır.
 */
export function buildInitializeRequest({order, buyer, callbackUrl, locale = 'tr'}) {
  if (!order?.id || !Number.isSafeInteger(order.total_cents)) throw new Error('Sipariş bilgisi eksik.');
  if (!/^https:\/\//.test(callbackUrl || '')) throw new Error('Geri dönüş adresi SSL (https) olmalı.');
  const items = order.items.map((item, index) => ({
    id: String(item.variant_id).slice(0, 64),
    name: String(item.name).slice(0, 100),
    category1: String(item.category || 'Lunapot').slice(0, 100),
    itemType: 'PHYSICAL',
    price: formatPrice(item.price_cents * item.qty),
    _cents: item.price_cents * item.qty,
    _index: index
  }));
  if (order.shipping_cents > 0) items.push({id: 'kargo', name: 'Kargo', category1: 'Kargo', itemType: 'PHYSICAL', price: formatPrice(order.shipping_cents), _cents: order.shipping_cents});
  const basketTotal = items.reduce((sum, item) => sum + item._cents, 0);
  if (basketTotal !== order.total_cents) throw new Error('Sepet kalemleri sipariş toplamına eşit değil.');
  const address = a => ({contactName: a.name, city: a.city, country: 'Turkey', address: `${a.line} ${a.district}/${a.city}`.slice(0, 250)});
  return {
    locale,
    conversationId: order.id,
    price: formatPrice(order.total_cents),
    paidPrice: formatPrice(order.total_cents),
    currency: 'TRY',
    basketId: order.id,
    paymentGroup: 'PRODUCT',
    callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: buyer.id,
      name: buyer.name,
      surname: buyer.surname,
      identityNumber: buyer.identityNumber,
      email: buyer.email,
      gsmNumber: buyer.gsmNumber,
      registrationAddress: address(order.shipping).address,
      city: order.shipping.city,
      country: 'Turkey',
      ip: buyer.ip
    },
    shippingAddress: address(order.shipping),
    billingAddress: address(order.billing || order.shipping),
    basketItems: items.map(({_cents, _index, ...item}) => item)
  };
}

/**
 * Sağlayıcı yanıtını siparişe karşı yorumlar. Tahsilat, YALNIZCA her kontrol geçerse "paid" olur.
 * Dönüş: {outcome: 'paid'|'failed'|'pending'|'rejected', reason, paymentId}
 */
export async function interpretRetrieve(response, {order, secretKey}) {
  if (!response || response.status !== 'success') return {outcome: 'failed', reason: 'Sağlayıcı sorgusu başarısız: ' + (response?.errorMessage || 'bilinmeyen hata')};
  if (!await verifyRetrieveSignature(response, secretKey)) return {outcome: 'rejected', reason: 'Yanıt imzası doğrulanamadı.'};
  // Güvenilir eşleşme basketId'dir. Eski Lunapot mağazasının kayıtlarına göre sandbox,
  // conversationId alanında sipariş yerine token'ı yansıtabiliyor; ikisi de imzanın içinde
  // olduğu için bu alan sipariş kimliği ya da bu ödemenin token'ı olabilir, başka bir şey olamaz.
  if (response.basketId !== order.id) return {outcome: 'rejected', reason: 'Yanıt başka bir siparişe ait.'};
  if (response.conversationId !== order.id && response.conversationId !== response.token)
    return {outcome: 'rejected', reason: 'Yanıt başka bir işleme ait.'};
  if (response.currency !== 'TRY') return {outcome: 'rejected', reason: 'Para birimi eşleşmiyor.'};
  let paid;
  try { paid = priceToCents(response.paidPrice); } catch (error) { return {outcome: 'rejected', reason: error.message}; }
  if (paid !== order.total_cents) return {outcome: 'rejected', reason: `Tahsil edilen tutar siparişle eşleşmiyor (${paid} ≠ ${order.total_cents} kuruş).`};
  if (response.paymentStatus === 'SUCCESS') {
    // Sahtekârlık incelemesi sürüyorsa ödeme henüz kesinleşmemiştir.
    if (Number(response.fraudStatus) === 0) return {outcome: 'pending', reason: 'Ödeme risk incelemesinde.', paymentId: response.paymentId};
    if (Number(response.fraudStatus) === -1) return {outcome: 'failed', reason: 'Ödeme risk incelemesinde reddedildi.', paymentId: response.paymentId};
    return {outcome: 'paid', reason: 'Ödeme sağlayıcıdan doğrulandı.', paymentId: response.paymentId, items: itemTransactions(response)};
  }
  if (['INIT_THREEDS', 'CALLBACK_THREEDS', 'PENDING_CREDIT'].includes(response.paymentStatus))
    return {outcome: 'pending', reason: 'Ödeme henüz tamamlanmadı.', paymentId: response.paymentId};
  return {outcome: 'failed', reason: 'Ödeme başarısız: ' + response.paymentStatus, paymentId: response.paymentId};
}

/** Yapılandırma: anahtar yoksa null döner ve ödeme adımı açılmaz. Canlı uç açıkça istenmedikçe kullanılmaz. */
export function iyzicoConfig(env) {
  if (!env?.IYZICO_API_KEY || !env?.IYZICO_SECRET_KEY) return null;
  const mode = env.IYZICO_ENV === 'production' ? 'production' : 'sandbox';
  return {apiKey: env.IYZICO_API_KEY, secretKey: env.IYZICO_SECRET_KEY, mode, host: IYZICO_HOSTS[mode]};
}

export async function iyzicoCall(config, path, payload, fetcher = fetch) {
  const body = JSON.stringify(payload);
  const rnd = randomKey();
  const response = await fetcher(config.host + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-iyzi-rnd': rnd,
      Authorization: await authorizationHeader({apiKey: config.apiKey, secretKey: config.secretKey, path, body, randomKey: rnd})
    },
    body
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Ödeme sağlayıcısından okunabilir yanıt gelmedi.'); }
  return data;
}

// ---- İade (sandbox) ----
// Kaynak: docs.iyzico.com "Refund & Cancel" — POST /payment/refund {paymentTransactionId, price, currency, ip, conversationId, locale}.
export const REFUND_PATH = '/payment/refund';

/**
 * Sorgu yanıtındaki kalem işlemleri (itemTransactions[]: itemId, paymentTransactionId, paidPrice).
 * iyzico bunların iade için saklanmasını ister. Okunamayan kalem varsa liste boş döner;
 * ödeme yine doğrulanır ama iade uygulamadan yapılamaz (sağlayıcı panelinden yapılır).
 */
export function itemTransactions(response) {
  if (!Array.isArray(response?.itemTransactions)) return [];
  try {
    return response.itemTransactions.map(t => {
      const transaction_id = String(t.paymentTransactionId || '');
      if (!/^[\w-]{1,100}$/.test(transaction_id)) throw new Error('kalem işlem kimliği');
      return {item_id: String(t.itemId || '').slice(0, 64), transaction_id, paid_cents: priceToCents(t.paidPrice)};
    });
  } catch { return []; }
}

/**
 * İade yanıtını yorumlar. Belgede iade yanıtı imzasının alan sırası YOK; uydurulmaz, imza
 * doğrulanmaz. Bunun yerine durum, (varsa) işlem/ödeme kimliği, tutar ve para birimi eşleşmesi aranır.
 */
export function interpretRefund(response, {transactionId, paymentId, cents}) {
  if (!response || response.status !== 'success') return {ok: false, reason: 'İade reddedildi: ' + (response?.errorMessage || 'bilinmeyen hata')};
  if (response.paymentTransactionId !== undefined && String(response.paymentTransactionId) !== transactionId)
    return {ok: false, reason: 'Yanıt başka bir kalem işlemine ait.'};
  if (response.paymentId !== undefined && paymentId && String(response.paymentId) !== paymentId)
    return {ok: false, reason: 'Yanıt başka bir ödemeye ait.'};
  if (response.currency !== undefined && response.currency !== 'TRY') return {ok: false, reason: 'Para birimi eşleşmiyor.'};
  let refunded;
  try { refunded = priceToCents(response.price); } catch (error) { return {ok: false, reason: error.message}; }
  if (refunded !== cents) return {ok: false, reason: `İade tutarı eşleşmiyor (${refunded} ≠ ${cents} kuruş).`};
  return {ok: true, reason: '', reference: String(response.hostReference || response.refundHostReference || response.paymentId || '').slice(0, 200)};
}
