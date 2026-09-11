import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from '../src/worker.js';
import {LEGAL_VERSION} from '../src/webshop-legal.js';
import {PATHS} from '../src/payment-iyzico.js';

// SAHTE anahtarlar: yalnızca imza hesabını sınamak için. Gerçek sağlayıcıya istek gitmez;
// ağ çağrısı env.PAYMENT_FETCH_FOR_TESTS ile sahte bir sağlayıcıya yönlendirilir.
const SECRET = 'test-secret-not-real';
const hmac = data => createHmac('sha256', SECRET).update(data).digest('hex');

function database() {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(x => x.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  s.exec("INSERT INTO ws_catalog VALUES('soil-standard','soil','Toprak','Standart','soil.webp','toprak',19000,3,1)");
  const prepare = sql => ({v: [], bind(...v) { this.v = v; return this; }, first() { return s.prepare(sql).get(...this.v) || null; }, all() { return {results: s.prepare(sql).all(...this.v)}; }, run() { return s.prepare(sql).run(...this.v); }});
  return {s, prepare, batch: async items => { s.exec('BEGIN'); try { const r = items.map(i => i.all()); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; } }, close: () => s.close()};
}

// Sahte iyzico: başlatmada token verir, sorguda imzalı sonuç döner.
function fakeProvider() {
  const state = {calls: [], counter: 0, detail: {paymentStatus: 'SUCCESS', fraudStatus: 1}, paidOverride: null};
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push({url, body, headers: init.headers});
    if (url.endsWith(PATHS.initialize)) {
      // Gercek iyzico tokenlari uzundur; ucun dogrulayicisi 8 karakterden kisasini reddeder.
      const token = 'tok-' + String(++state.counter).padStart(8, '0');
      state.tokens = {...state.tokens, [token]: body};
      return {json: async () => ({status: 'success', token, conversationId: body.conversationId, paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=' + token, signature: hmac(body.conversationId + ':' + token)})};
    }
    if (url.endsWith('/payment/refund')) {
      state.refunds = [...(state.refunds || []), body];
      if (state.refundMode === 'throw') throw new Error('ağ hatası');
      if (state.refundMode === 'fail') return {json: async () => ({status: 'failure', errorMessage: 'sandbox reddetti'})};
      if (state.refundMode === 'wrong-amount') return {json: async () => ({status: 'success', paymentTransactionId: body.paymentTransactionId, price: '0.01', currency: 'TRY'})};
      return {json: async () => ({status: 'success', paymentTransactionId: body.paymentTransactionId, price: body.price, currency: 'TRY', hostReference: 'ref-' + body.paymentTransactionId})};
    }
    const init0 = state.tokens?.[body.token];
    const price = init0 ? init0.price : '1';
    const r = {status: 'success', paymentId: 'pay-' + body.token, currency: 'TRY', basketId: init0?.basketId, conversationId: body.conversationId,
      paidPrice: state.paidOverride || price, price, token: body.token,
      itemTransactions: (init0?.basketItems || []).map((b, i) => ({itemId: b.id, paymentTransactionId: 'ptx-' + body.token + '-' + i, price: b.price, paidPrice: b.price, transactionStatus: 2})), ...state.detail};
    r.signature = hmac([r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId,
      String(r.paidPrice).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), String(r.price).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), r.token].join(':'));
    return {json: async () => r};
  };
  return {state, fetcher};
}

function shop(extraEnv = {}) {
  const DB = database(), provider = fakeProvider();
  const env = {DB, WS_MODE: 'demo', IYZICO_API_KEY: 'test-api-not-real', IYZICO_SECRET_KEY: SECRET,
    PAYMENT_CALLBACK_BASE: 'https://test.example', PAYMENT_FETCH_FOR_TESTS: provider.fetcher, ...extraEnv};
  let cookie = '';
  const origin = 'http://localhost';
  const req = async (path, method = 'GET', body, headers = {}) => {
    const r = await worker.fetch(new Request(origin + '/api' + path, {method, headers: {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers}, ...(body ? {body: JSON.stringify(body)} : {})}), env);
    if (r.headers.get('Set-Cookie')) cookie = r.headers.get('Set-Cookie').split(';')[0];
    let data = null; try { data = await r.clone().json(); } catch { data = null; }
    return {status: r.status, data, headers: r.headers};
  };
  // iyzico'nun tarayıcıyı döndürdüğü form: bizim Origin'imiz ve JSON başlığımız YOK.
  const callback = token => worker.fetch(new Request(origin + '/api/store/payment/callback', {
    method: 'POST', redirect: 'manual', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'token=' + encodeURIComponent(token)
  }), env);
  const webhook = (payload, signature) => worker.fetch(new Request(origin + '/api/store/payment/webhook', {
    method: 'POST', headers: {'Content-Type': 'application/json', ...(signature ? {'X-IYZ-SIGNATURE-V3': signature} : {})}, body: JSON.stringify(payload)
  }), env);
  const address = {name: 'Test Müşteri', phone: '05000000000', city: 'İstanbul', district: 'Şişli', line: 'Test adresi No 1'};
  const newOrder = async () => {
    if (!cookie) await req('/store/auth/register', 'POST', {email: 'pay@example.test', name: 'Test Müşteri', password: 'local-test-password-123', terms_version: LEGAL_VERSION});
    const q = await req('/store/quote', 'POST', {items: [{variant_id: 'soil-standard', qty: 1}], address, same_billing: true});
    const o = await req('/store/orders', 'POST', {quote_id: q.data.id, legal_version: LEGAL_VERSION, preinformation: true, contract: true});
    return o.data.id;
  };
  // node:sqlite satırları prototipsiz nesnedir; deepEqual için düz nesneye çevrilir.
  const row = id => ({...DB.s.prepare('SELECT status,payment_status FROM ws_orders WHERE id=?').get(id)});
  const payments = id => DB.s.prepare('SELECT status,verified_cents,provider_payment_id FROM ws_payments WHERE order_id=? ORDER BY rowid').all(id).map(r => ({...r}));
  return {DB, env, provider, req, callback, webhook, newOrder, row, payments};
}

test('Ödeme sunucudaki sipariş tutarıyla başlatılır; istemci tutarı yok sayılır', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    const start = await t.req(`/store/orders/${id}/payment`, 'POST', {price: 1});
    assert.equal(start.status, 200);
    assert.equal(start.data.mode, 'sandbox');
    assert.match(start.data.payment_page_url, /sandbox/);
    const init = t.provider.state.calls[0];
    assert.match(init.url, /^https:\/\/sandbox-api\.iyzipay\.com/, 'varsayılan olarak sandbox kullanılır');
    assert.equal(init.body.price, '249', '190 TL ürün + 59 TL kargo sunucudan gelir');
    assert.equal(init.body.basketId, id);
    assert.equal(init.body.callbackUrl, 'https://test.example/api/store/payment/callback');
    assert.ok(!JSON.stringify(init.body).includes(SECRET), 'gizli anahtar isteğe girmez');
  } finally { t.DB.close(); }
});

test('Tarayıcı dönüşü tek başına kanıt değil: sunucu sağlayıcıya sorar, sonra kabul eder', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    const before = t.provider.state.calls.length;
    const r = await t.callback('tok-00000001');
    assert.equal(r.status, 303);
    assert.match(r.headers.get('Location'), /\/magaza\/hesabim\.html\?siparis=.+&odeme=dogrulandi$/);
    assert.equal(t.provider.state.calls.length, before + 1, 'dönüşte sağlayıcıya detail sorgusu yapılmalı');
    assert.ok(t.provider.state.calls.at(-1).url.endsWith(PATHS.retrieve));
    assert.deepEqual(t.row(id), {status: 'new', payment_status: 'demo_paid'}, 'sandbox ödemesi gerçek tahsilat sayılmaz');
    assert.deepEqual(t.payments(id)[0], {status: 'verified', verified_cents: 24900, provider_payment_id: 'pay-tok-00000001'});
  } finally { t.DB.close(); }
});

test('Aynı dönüş iki kez gelirse ikinci kez işlenmez', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    await t.callback('tok-00000001');
    const again = await t.callback('tok-00000001');
    assert.equal(again.status, 303);
    assert.equal(t.payments(id).length, 1);
    const verifiedEvents = t.DB.s.prepare("SELECT COUNT(*) n FROM ws_events WHERE order_id=? AND action LIKE 'Sandbox ödemesi sağlayıcıdan doğrulandı%'").get(id).n;
    assert.equal(verifiedEvents, 1, 'doğrulama olayı bir kez yazılır');
    assert.equal((await t.req(`/store/orders/${id}/payment`, 'POST', {})).status, 409, 'ödenmiş sipariş yeniden ödenemez');
  } finally { t.DB.close(); }
});

test('Tutar tutmazsa imza geçerli olsa bile ödeme kabul edilmez', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    t.provider.state.paidOverride = '1.0';
    const r = await t.callback('tok-00000001');
    assert.match(r.headers.get('Location'), /odeme=basarisiz$/);
    assert.equal(t.row(id).payment_status, 'pending', 'sipariş ödenmiş sayılmaz');
    assert.equal(t.payments(id)[0].status, 'rejected');
  } finally { t.DB.close(); }
});

test('Başarısız ve risk incelemesindeki ödeme ayrı ayrı işlenir', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    t.provider.state.detail = {paymentStatus: 'SUCCESS', fraudStatus: 0};
    assert.match((await t.callback('tok-00000001')).headers.get('Location'), /odeme=bekliyor$/);
    assert.equal(t.payments(id)[0].status, 'pending');
    assert.equal(t.row(id).payment_status, 'pending');
    // İnceleme sonuçlanınca aynı token yeniden sorulur ve bu kez kabul edilir.
    t.provider.state.detail = {paymentStatus: 'SUCCESS', fraudStatus: 1};
    assert.match((await t.callback('tok-00000001')).headers.get('Location'), /odeme=dogrulandi$/);
    assert.equal(t.row(id).payment_status, 'demo_paid');
  } finally { t.DB.close(); }
});

test('Webhook imzası doğrulanır, yinelenen bildirim bir kez işlenir, sahte bildirim hiçbir şey değiştirmez', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    const payload = {iyziReferenceCode: 'ref-1', iyziEventType: 'CHECKOUT_FORM_AUTH', iyziPaymentId: 'pay-tok-00000001', token: 'tok-00000001', paymentConversationId: id, status: 'SUCCESS'};
    const good = hmac(SECRET + payload.iyziEventType + payload.iyziPaymentId + payload.token + payload.paymentConversationId + payload.status);

    const forged = await t.webhook({...payload, iyziReferenceCode: 'ref-sahte'}, 'deadbeef');
    assert.equal(forged.status, 401);
    assert.equal(t.row(id).payment_status, 'pending', 'imzasız bildirim ödemeyi kabul ettirmez');

    const first = await t.webhook(payload, good);
    assert.equal(first.status, 200);
    assert.equal(t.row(id).payment_status, 'demo_paid');

    const repeat = await (await t.webhook(payload, good)).json();
    assert.equal(repeat.duplicate, true, 'aynı bildirim ikinci kez işlenmez');
    assert.equal(t.DB.s.prepare('SELECT COUNT(*) n FROM ws_payment_events').get().n, 2, 'sahte + gerçek bildirim kayda geçti');
  } finally { t.DB.close(); }
});

test('Sipariş iptal edildikten sonra ödeme doğrulanırsa iade gerektiği yazılır', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    await t.req(`/store/orders/${id}/payment`, 'POST', {});
    await t.req(`/store/orders/${id}/cancel`, 'POST', {});
    assert.equal(t.row(id).status, 'cancelled');
    await t.callback('tok-00000001');
    assert.equal(t.row(id).status, 'cancelled', 'iptal edilen sipariş canlanmaz');
    assert.equal(t.payments(id)[0].status, 'verified', 'para alındıysa kayıt gerçeği söyler');
    const warning = t.DB.s.prepare("SELECT COUNT(*) n FROM ws_events WHERE order_id=? AND action LIKE '%iade gerekli%'").get(id).n;
    assert.equal(warning, 1);
  } finally { t.DB.close(); }
});

test('Canlı hostta ve anahtarsız ortamda ödeme başlatılamaz', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    const live = await worker.fetch(new Request(`https://muhasebe.lunapot.com/api/store/orders/${id}/payment`, {method: 'POST', headers: {Origin: 'https://muhasebe.lunapot.com', 'Content-Type': 'application/json'}, body: '{}'}), t.env);
    assert.ok([401, 503].includes(live.status), 'canlı hostta ödeme açılmaz');
  } finally { t.DB.close(); }
  const k = shop({IYZICO_API_KEY: undefined, IYZICO_SECRET_KEY: undefined}); try {
    const id = await k.newOrder();
    const r = await k.req(`/store/orders/${id}/payment`, 'POST', {});
    assert.equal(r.status, 503);
    assert.match(r.data.error, /sandbox anahtarı tanımlı değil/);
    assert.equal(k.provider.state.calls.length, 0, 'anahtar yoksa sağlayıcıya hiç gidilmez');
  } finally { k.DB.close(); }
});

test('Başka müşterinin siparişine ödeme başlatılamaz ve durumu okunamaz', async () => {
  const t = shop(); try {
    const id = await t.newOrder();
    // AYNI veritabanında ikinci bir müşteri, kendi oturum çereziyle.
    const origin = 'http://localhost';
    const reg = await worker.fetch(new Request(origin + '/api/store/auth/register', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({email: 'baska@example.test', name: 'Başka Kişi', password: 'local-test-password-123', terms_version: LEGAL_VERSION})}), t.env);
    const strangerCookie = reg.headers.get('Set-Cookie').split(';')[0];
    const as = (method, body) => worker.fetch(new Request(`${origin}/api/store/orders/${id}/payment`, {method,
      headers: {Origin: origin, 'Content-Type': 'application/json', Cookie: strangerCookie}, ...(body ? {body: JSON.stringify(body)} : {})}), t.env);
    assert.equal((await as('GET')).status, 404, 'başkasının siparişinin ödeme durumu görünmez');
    assert.equal((await as('POST', {})).status, 404, 'başkasının siparişine ödeme başlatılamaz');
    assert.equal(t.provider.state.calls.length, 0, 'sağlayıcıya hiç gidilmez');

    const anonymous = await worker.fetch(new Request(`${origin}/api/store/orders/${id}/payment`, {headers: {Origin: origin}}), t.env);
    assert.equal(anonymous.status, 401, 'oturumsuz istek siparişi göremez');
  } finally { t.DB.close(); }
});

// ---- Sandbox iadesi ----
import {refundOrder} from '../src/webshop-payment.js';

async function paidOrder(t, {cancel = true} = {}) {
  const id = await t.newOrder();
  await t.req(`/store/orders/${id}/payment`, 'POST', {});
  await t.callback('tok-00000001');
  if (cancel) await t.req(`/store/orders/${id}/cancel`, 'POST', {});
  return {id, order: () => ({...t.DB.s.prepare('SELECT * FROM ws_orders WHERE id=?').get(id)})};
}
const refunds = (t, id) => t.DB.s.prepare('SELECT item_id,amount_cents,status FROM ws_refunds WHERE order_id=? ORDER BY rowid').all(id).map(r => ({...r}));

test('Doğrulanan ödemenin kalem işlem kimlikleri iade için saklanır', async () => {
  const t = shop(); try {
    const {id} = await paidOrder(t, {cancel: false});
    const items = JSON.parse(t.DB.s.prepare('SELECT item_transactions_json j FROM ws_payments WHERE order_id=?').get(id).j);
    assert.deepEqual(items.map(i => [i.item_id, i.paid_cents]), [['soil-standard', 19000], ['kargo', 5900]]);
  } finally { t.DB.close(); }
});

test('İptal edilen ödenmiş sipariş kalem kalem iade edilir; ikinci istek yeniden iade etmez', async () => {
  const t = shop(); try {
    const {id, order} = await paidOrder(t);
    assert.equal(order().status, 'cancelled');
    const r = await refundOrder(t.DB, t.env, {order: order(), actor: 'owner'});
    assert.deepEqual(r, {refunded_cents: 24900, failed: [], already: false});
    assert.deepEqual(t.provider.state.refunds.map(b => [b.paymentTransactionId, b.price, b.currency]),
      [['ptx-tok-00000001-0', '190', 'TRY'], ['ptx-tok-00000001-1', '59', 'TRY']]);
    assert.deepEqual(refunds(t, id).map(r => r.status), ['succeeded', 'succeeded']);
    const again = await refundOrder(t.DB, t.env, {order: order(), actor: 'owner'});
    assert.equal(again.already, true);
    assert.equal(t.provider.state.refunds.length, 2, 'ikinci istek sağlayıcıya gitmez');
    assert.equal(t.DB.s.prepare("SELECT COUNT(*) n FROM ws_events WHERE order_id=? AND action LIKE 'Sandbox iadesi sağlayıcıda onaylandı%'").get(id).n, 1);
    assert.equal(order().is_test, 1, 'sipariş test olarak kalır');
  } finally { t.DB.close(); }
});

test('İptal edilmemiş siparişte iade başlamaz', async () => {
  const t = shop(); try {
    const {order} = await paidOrder(t, {cancel: false});
    await assert.rejects(refundOrder(t.DB, t.env, {order: order(), actor: 'owner'}), e => e.status === 409);
    assert.equal(t.provider.state.refunds, undefined);
  } finally { t.DB.close(); }
});

test('Sağlayıcı reddederse veya tutar tutmazsa iade başarılı sayılmaz; reddedilen iade yeniden denenebilir', async () => {
  const t = shop(); try {
    const {id, order} = await paidOrder(t);
    t.provider.state.refundMode = 'wrong-amount';
    const wrong = await refundOrder(t.DB, t.env, {order: order(), actor: 'owner'});
    assert.equal(wrong.refunded_cents, 0);
    assert.match(wrong.failed[0].reason, /eşleşmiyor/);
    t.provider.state.refundMode = 'fail';
    const failed = await refundOrder(t.DB, t.env, {order: order(), actor: 'owner'});
    assert.equal(failed.failed.length, 2);
    t.provider.state.refundMode = null;
    const ok = await refundOrder(t.DB, t.env, {order: order(), actor: 'owner'});
    assert.equal(ok.refunded_cents, 24900);
    assert.deepEqual(refunds(t, id).map(r => r.status), ['failed', 'failed', 'failed', 'failed', 'succeeded', 'succeeded']);
  } finally { t.DB.close(); }
});

test('Yanıtsız kalan iade tekrar denenmez (çift iade yolu kapalı)', async () => {
  const t = shop(); try {
    const {id, order} = await paidOrder(t);
    t.provider.state.refundMode = 'throw';
    await assert.rejects(refundOrder(t.DB, t.env, {order: order(), actor: 'owner'}), e => e.status === 502);
    t.provider.state.refundMode = null;
    await assert.rejects(refundOrder(t.DB, t.env, {order: order(), actor: 'owner'}), e => e.status === 409 && /sonucu bilinmiyor/.test(e.message));
    assert.equal(t.provider.state.refunds.length, 1);
    assert.deepEqual(refunds(t, id).map(r => r.status), ['requested']);
  } finally { t.DB.close(); }
});

test('Veritabanı toplam iadenin tahsilatı aşmasına ve kaydın değişmesine izin vermez', async () => {
  const t = shop(); try {
    const {id} = await paidOrder(t);
    const pay = t.DB.s.prepare('SELECT id FROM ws_payments WHERE order_id=?').get(id).id;
    const ins = (rid, tx, cents) => t.DB.s.prepare("INSERT INTO ws_refunds(id,payment_id,order_id,transaction_id,item_id,amount_cents,actor) VALUES(?,?,?,?,'x',?,'test')").run(rid, pay, id, tx, cents);
    assert.throws(() => ins('r1', 'a', 24901), /WS_REFUND_EXCEEDS/);
    ins('r2', 'a', 24900);
    assert.throws(() => ins('r3', 'b', 1), /WS_REFUND_EXCEEDS/);
    assert.throws(() => ins('r4', 'a', 1), /UNIQUE|WS_REFUND_EXCEEDS/);
    t.DB.s.exec("UPDATE ws_refunds SET status='succeeded' WHERE id='r2'");
    assert.throws(() => t.DB.s.exec("UPDATE ws_refunds SET status='failed' WHERE id='r2'"), /WS_REFUND_IMMUTABLE/);
    assert.throws(() => t.DB.s.exec("DELETE FROM ws_refunds WHERE id='r2'"), /IMMUTABLE_LEDGER/);
  } finally { t.DB.close(); }
});

test('Yönetim iade ucu oturumsuz çağrılamaz', async () => {
  const t = shop(); try {
    const {id} = await paidOrder(t);
    const r = await worker.fetch(new Request(`http://localhost/api/webshop/orders/${id}/refund`, {method: 'POST',
      headers: {Origin: 'http://localhost', 'Content-Type': 'application/json'}, body: '{}'}), t.env);
    assert.ok([401, 403].includes(r.status));
    assert.equal(t.provider.state.refunds, undefined);
  } finally { t.DB.close(); }
});
