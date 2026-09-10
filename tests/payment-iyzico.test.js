import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {formatPrice, normalizePrice, priceToCents, authorizationHeader, verifyRetrieveSignature,
  verifyInitializeSignature, verifyWebhookSignature, buildInitializeRequest, interpretRetrieve,
  iyzicoConfig, iyzicoCall, PATHS, IYZICO_HOSTS} from '../src/payment-iyzico.js';

// Bu anahtarlar SAHTEDİR; yalnızca imza hesabını bağımsız bir uygulamayla karşılaştırmak içindir.
const SECRET = 'test-secret-not-real';
const API = 'test-api-not-real';
const nodeHmac = data => createHmac('sha256', SECRET).update(data).digest('hex');

const order = (extra = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', total_cents: 20900, shipping_cents: 5900,
  items: [{variant_id: 'luna-silver-kucuk', name: 'Luna Gümüş', price_cents: 15000, qty: 1, category: 'Saksı'}],
  shipping: {name: 'Test Müşteri', city: 'İstanbul', district: 'Şişli', line: 'Test adresi No 1'},
  ...extra
});

async function signedDetail(extra = {}) {
  const r = {status: 'success', paymentStatus: 'SUCCESS', paymentId: '2233', currency: 'TRY',
    basketId: order().id, conversationId: order().id, paidPrice: '209.00', price: '209.0',
    token: 'tok-1', fraudStatus: 1, ...extra};
  r.signature = nodeHmac([r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId,
    normalizePrice(r.paidPrice), normalizePrice(r.price), r.token].join(':'));
  return r;
}

test('Fiyat metni iyzico kuralına göre yazılır ve geri okunur', () => {
  assert.equal(formatPrice(1050), '10.5');
  assert.equal(formatPrice(1000), '10');
  assert.equal(formatPrice(1001), '10.01');
  assert.equal(normalizePrice('10.50'), '10.5', 'belgedeki örnek');
  assert.equal(normalizePrice('10.51050'), '10.5105', 'belgedeki örnek');
  assert.equal(normalizePrice('209.00'), '209');
  assert.equal(priceToCents('209.0'), 20900);
  assert.equal(priceToCents('10.5'), 1050);
  assert.throws(() => priceToCents('10.505'), /Kuruştan küçük/);
  assert.throws(() => formatPrice(0), /pozitif/);
});

test('IYZWSv2 başlığı belgedeki formülle ve bağımsız HMAC ile birebir aynı üretilir', async () => {
  const body = '{"binNumber":"589004"}', rnd = '1722246017090123456789', path = '/payment/bin/check';
  const header = await authorizationHeader({apiKey: API, secretKey: SECRET, path, body, randomKey: rnd});
  assert.match(header, /^IYZWSv2 [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(header.slice(8), 'base64').toString('utf8');
  assert.equal(decoded, `apiKey:${API}&randomKey:${rnd}&signature:${nodeHmac(rnd + path + body)}`);
  await assert.rejects(authorizationHeader({apiKey: '', secretKey: SECRET, path, body, randomKey: rnd}), /tanımlı değil/);
});

test('Yanıt, başlatma ve webhook imzaları doğrulanır; kurcalanmış olan reddedilir', async () => {
  const detail = await signedDetail();
  assert.equal(await verifyRetrieveSignature(detail, SECRET), true);
  assert.equal(await verifyRetrieveSignature({...detail, paidPrice: '1.00'}, SECRET), false, 'tutar değiştirilirse imza tutmaz');
  assert.equal(await verifyRetrieveSignature({...detail, signature: undefined}, SECRET), false, 'imzasız yanıt geçersiz');

  const init = {conversationId: 'c1', token: 't1'};
  init.signature = nodeHmac('c1:t1');
  assert.equal(await verifyInitializeSignature(init, SECRET), true);

  const hook = {iyziEventType: 'CHECKOUT_FORM_AUTH', iyziPaymentId: '2233', token: 'tok-1', paymentConversationId: order().id, status: 'SUCCESS'};
  const sig = nodeHmac(SECRET + hook.iyziEventType + hook.iyziPaymentId + hook.token + hook.paymentConversationId + hook.status);
  assert.equal(await verifyWebhookSignature(hook, sig, SECRET), true);
  assert.equal(await verifyWebhookSignature({...hook, status: 'FAILURE'}, sig, SECRET), false);
  assert.equal(await verifyWebhookSignature(hook, '', SECRET), false);
});

test('Başlatma isteği fiyatı sunucudaki siparişten kurar ve kalem toplamını denetler', () => {
  const buyer = {id: 'c1', name: 'Test', surname: 'Müşteri', identityNumber: '11111111111', email: 't@example.test', gsmNumber: '+905000000000', ip: '127.0.0.1'};
  const req = buildInitializeRequest({order: order(), buyer, callbackUrl: 'https://test.example/api/store/payment/callback'});
  assert.equal(req.price, '209');
  assert.equal(req.paidPrice, '209');
  assert.equal(req.currency, 'TRY');
  assert.equal(req.conversationId, order().id);
  assert.equal(req.basketId, order().id);
  assert.deepEqual(req.basketItems.map(i => i.price), ['150', '59'], 'kargo ayrı kalem');
  assert.ok(req.basketItems.every(i => !('_cents' in i)), 'iç alanlar sağlayıcıya gönderilmez');
  assert.throws(() => buildInitializeRequest({order: order({total_cents: 99999}), buyer, callbackUrl: 'https://x.test'}), /toplamına eşit değil/);
  assert.throws(() => buildInitializeRequest({order: order(), buyer, callbackUrl: 'http://x.test'}), /https/);
});

test('Tahsilat yalnızca bütün kontroller geçerse kabul edilir', async () => {
  const o = order();
  assert.equal((await interpretRetrieve(await signedDetail(), {order: o, secretKey: SECRET})).outcome, 'paid');
  // Tutar farkı: imza geçerli olsa bile reddedilir.
  assert.equal((await interpretRetrieve(await signedDetail({paidPrice: '1.00', price: '1.0'}), {order: o, secretKey: SECRET})).outcome, 'rejected');
  // Başka siparişin yanıtı
  assert.equal((await interpretRetrieve(await signedDetail({basketId: 'baska', conversationId: 'baska'}), {order: o, secretKey: SECRET})).outcome, 'rejected');
  // Sandbox conversationId yerine token'ı yansıtabilir (eski mağaza kaydı); bu kabul edilir.
  assert.equal((await interpretRetrieve(await signedDetail({conversationId: 'tok-1'}), {order: o, secretKey: SECRET})).outcome, 'paid');
  // Ama sipariş de token da olmayan bir değer reddedilir.
  assert.equal((await interpretRetrieve(await signedDetail({conversationId: 'yabanci'}), {order: o, secretKey: SECRET})).outcome, 'rejected');
  // Para birimi
  assert.equal((await interpretRetrieve(await signedDetail({currency: 'USD'}), {order: o, secretKey: SECRET})).outcome, 'rejected');
  // İmza bozuk
  assert.equal((await interpretRetrieve({...(await signedDetail()), signature: 'ab'}, {order: o, secretKey: SECRET})).outcome, 'rejected');
  // Risk incelemesi → bekliyor; red → başarısız
  assert.equal((await interpretRetrieve(await signedDetail({fraudStatus: 0}), {order: o, secretKey: SECRET})).outcome, 'pending');
  assert.equal((await interpretRetrieve(await signedDetail({fraudStatus: -1}), {order: o, secretKey: SECRET})).outcome, 'failed');
  // Başarısız ödeme ve başarısız sorgu
  assert.equal((await interpretRetrieve(await signedDetail({paymentStatus: 'FAILURE'}), {order: o, secretKey: SECRET})).outcome, 'failed');
  assert.equal((await interpretRetrieve({status: 'failure', errorMessage: 'x'}, {order: o, secretKey: SECRET})).outcome, 'failed');
});

test('Anahtar yoksa ödeme kapalıdır; canlı uç yalnızca açıkça istenirse kullanılır', async () => {
  assert.equal(iyzicoConfig({}), null);
  assert.equal(iyzicoConfig({IYZICO_API_KEY: 'a'}), null);
  assert.equal(iyzicoConfig({IYZICO_API_KEY: 'a', IYZICO_SECRET_KEY: 'b'}).host, IYZICO_HOSTS.sandbox, 'varsayılan sandbox');
  assert.equal(iyzicoConfig({IYZICO_API_KEY: 'a', IYZICO_SECRET_KEY: 'b', IYZICO_ENV: 'production'}).host, IYZICO_HOSTS.production);

  // Ağ çağrısı sahte fetch ile: doğru uç, başlıklar, gövde.
  let seen;
  const fake = async (url, init) => { seen = {url, init}; return {json: async () => ({status: 'success'})}; };
  await iyzicoCall({apiKey: API, secretKey: SECRET, host: IYZICO_HOSTS.sandbox}, PATHS.retrieve, {token: 't'}, fake);
  assert.equal(seen.url, 'https://sandbox-api.iyzipay.com/payment/iyzipos/checkoutform/auth/ecom/detail');
  assert.match(seen.init.headers.Authorization, /^IYZWSv2 /);
  assert.ok(seen.init.headers['x-iyzi-rnd']);
  assert.equal(seen.init.body, '{"token":"t"}');
  assert.ok(!JSON.stringify(seen.init).includes(SECRET), 'gizli anahtar isteğe düz metin olarak girmez');
});
