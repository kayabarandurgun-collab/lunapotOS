// Web mağaza ödeme uçları — iyzico Ödeme Formu, YALNIZCA SANDBOX.
//
//   POST /api/store/orders/:id/payment   müşteri ödemeyi başlatır (kendi siparişi, yerel demo)
//   GET  /api/store/orders/:id/payment   son ödeme durumu
//   POST /api/store/payment/callback     iyzico tarayıcıyı buraya form ile döndürür (token)
//   POST /api/store/payment/webhook      iyzico sunucu bildirimi (X-IYZ-SIGNATURE-V3)
//
// Güven kuralı: callback formu ve webhook gövdesi YALNIZCA hangi token'a bakılacağını söyler.
// Ödeme; sunucu iyzico'ya imzalı detail sorgusu yapıp imza, tutar, para birimi ve sipariş
// kimliği eşleştiğinde kabul edilir. Tarayıcının "başarılı" sayfası kanıt değildir.
//
// Sandbox'ta doğrulanan ödeme gerçek para değildir; sipariş 'demo_paid' olur ve is_test=1 kalır.
import {iyzicoConfig, iyzicoCall, buildInitializeRequest, interpretRetrieve, verifyWebhookSignature,
  verifyInitializeSignature, PATHS} from './payment-iyzico.js';

const ORDER_PATH = /^\/orders\/([a-f0-9-]{36})\/payment$/;

// Testler ağ yerine sahte bir çağrıcı verebilir; gerçek ortamda bu alan tanımlı değildir.
const fetcherOf = env => env.PAYMENT_FETCH_FOR_TESTS || fetch;

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return {name: parts[0] || 'Müşteri', surname: parts[0] || 'Müşteri'};
  return {name: parts.slice(0, -1).join(' '), surname: parts.at(-1)};
}
const gsm = phone => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '+90' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '+9' + digits;
  if (digits.length === 12 && digits.startsWith('90')) return '+' + digits;
  return '+90' + digits.slice(-10);
};

/**
 * Doğrulama sonucunu siparişe uygular. Callback ve webhook aynı anda gelebilir; her
 * güncelleme mevcut durumu koşul olarak taşır, ikinci gelen hiçbir şey değiştirmez.
 */
async function settle(db, helpers, {payment, order, result}) {
  const {event} = helpers;
  const statusFor = {paid: 'verified', pending: 'pending', failed: 'failed', rejected: 'rejected'};
  const next = statusFor[result.outcome] || 'failed';
  const statements = [
    db.prepare("UPDATE ws_payments SET status=?,provider_payment_id=?,verified_cents=?,reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('initialized','pending') RETURNING id")
      .bind(next, result.paymentId || null, next === 'verified' ? payment.amount_cents : null, result.reason.slice(0, 500), payment.id)
  ];
  if (next === 'verified') {
    statements.push(db.prepare("UPDATE ws_orders SET payment_status='demo_paid',updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status='pending' AND status='new' RETURNING id").bind(order.id));
    statements.push(event(db, order.id, 'iyzico-sandbox', 'Sandbox ödemesi sağlayıcıdan doğrulandı — gerçek tahsilat yok'));
  } else if (next === 'failed' || next === 'rejected') {
    statements.push(event(db, order.id, 'iyzico-sandbox', 'Sandbox ödemesi kabul edilmedi: ' + result.reason.slice(0, 200)));
  }
  const outcome = await db.batch(statements);
  const changed = outcome[0].results.length > 0;
  // Ödeme doğrulandı ama sipariş bu arada iptal edildiyse: para alınmış, mal gitmeyecek.
  // Bu durum sessizce kalmaz; iade gerektiği sipariş geçmişine yazılır.
  if (next === 'verified' && changed && outcome[1].results.length === 0) {
    const current = await db.prepare('SELECT status,payment_status FROM ws_orders WHERE id=?').bind(order.id).first();
    if (current?.status === 'cancelled')
      await event(db, order.id, 'iyzico-sandbox', 'DİKKAT: ödeme doğrulandı ama sipariş iptal edilmişti — iade gerekli').run();
  }
  return {changed, status: next};
}

async function verifyByToken(db, env, helpers, token) {
  const config = iyzicoConfig(env);
  if (!config) return {error: 'Ödeme sağlayıcısı yapılandırılmadı.', status: 503};
  const payment = await db.prepare('SELECT * FROM ws_payments WHERE token=?').bind(token).first();
  if (!payment) return {error: 'Ödeme kaydı bulunamadı.', status: 404};
  const order = await db.prepare('SELECT * FROM ws_orders WHERE id=?').bind(payment.order_id).first();
  if (!order) return {error: 'Sipariş bulunamadı.', status: 404};
  if (payment.status === 'verified') return {payment, order, result: {outcome: 'paid'}, settled: {changed: false, status: 'verified'}};
  const response = await iyzicoCall(config, PATHS.retrieve, {locale: 'tr', conversationId: order.id, token}, fetcherOf(env));
  const result = await interpretRetrieve(response, {order: {id: order.id, total_cents: payment.amount_cents}, secretKey: config.secretKey});
  const settled = await settle(db, helpers, {payment, order, result});
  return {payment, order, result, settled};
}

export async function paymentRoutes({request, env, sub, readBody, db, helpers}) {
  const {customer, ownOrder, requireDemo, json, fail, limit} = helpers;
  const method = request.method;

  // iyzico tarayıcıyı form ile geri gönderir. Formdan yalnızca token okunur.
  if (sub === '/payment/callback' && method === 'POST') {
    let token = '';
    try { token = String((await request.formData()).get('token') || ''); } catch { token = ''; }
    if (!/^[\w-]{8,200}$/.test(token)) return json({error: 'Ödeme dönüşü okunamadı.'}, 400);
    const checked = await verifyByToken(db, env, helpers, token);
    if (checked.error) return json({error: checked.error}, checked.status);
    const outcome = checked.result.outcome;
    // Müşteri hesabına döner; sonuç orada sunucudan yeniden okunur, URL'deki değer kanıt değildir.
    const target = new URL('/magaza/hesabim.html', request.url);
    target.searchParams.set('siparis', checked.order.id);
    target.searchParams.set('odeme', outcome === 'paid' ? 'dogrulandi' : outcome === 'pending' ? 'bekliyor' : 'basarisiz');
    return Response.redirect(target.toString(), 303);
  }

  // Sunucudan sunucuya bildirim. İmza yoksa/yanlışsa hiçbir şey değişmez.
  if (sub === '/payment/webhook' && method === 'POST') {
    const config = iyzicoConfig(env);
    if (!config) return json({error: 'Ödeme sağlayıcısı yapılandırılmadı.'}, 503);
    let payload;
    try { payload = JSON.parse(await request.text()); } catch { return json({error: 'Geçersiz bildirim.'}, 400); }
    const signatureOk = await verifyWebhookSignature(payload, request.headers.get('X-IYZ-SIGNATURE-V3') || '', config.secretKey);
    const reference = String(payload?.iyziReferenceCode || '').slice(0, 200);
    if (!reference) return json({error: 'Bildirim kimliği eksik.'}, 400);
    try {
      await db.prepare('INSERT INTO ws_payment_events(id,provider,reference_code,token,event_type,status,signature_ok,outcome) VALUES(?,?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), 'iyzico', reference, String(payload.token || '').slice(0, 200), String(payload.iyziEventType || '').slice(0, 60),
          String(payload.status || '').slice(0, 40), signatureOk ? 1 : 0, signatureOk ? 'işleniyor' : 'imza geçersiz').run();
    } catch (error) {
      // Aynı bildirim ikinci kez geldi: işlenmiş sayılır, sağlayıcı yeniden denemesin diye 200 döner.
      if (/UNIQUE/.test(String(error.message))) return json({ok: true, duplicate: true});
      throw error;
    }
    if (!signatureOk) return json({error: 'İmza doğrulanamadı.'}, 401);
    // Bildirimdeki durum da kanıt değildir; sağlayıcıya yeniden sorulur.
    const checked = await verifyByToken(db, env, helpers, String(payload.token || ''));
    if (checked.error) return json({ok: false, error: checked.error}, checked.status === 404 ? 200 : checked.status);
    return json({ok: true, status: checked.settled.status});
  }

  const match = sub.match(ORDER_PATH);
  if (!match) return null;
  const c = await customer(request, db);
  if (!c) fail('Mağaza hesabınla giriş yap.', 401);
  const order = await ownOrder(db, match[1], c.id);

  if (method === 'GET') {
    const last = await db.prepare('SELECT status,amount_cents,provider_payment_id,reason,created_at,updated_at FROM ws_payments WHERE order_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(order.id).first();
    return json({order_payment_status: order.payment_status, payment: last || null, mode: 'sandbox'});
  }

  if (method === 'POST') {
    // Yalnızca yerel demo ortamında: canlı hostta hiçbir ödeme başlatılamaz.
    requireDemo(request, env);
    const config = iyzicoConfig(env);
    if (!config) fail('Ödeme sağlayıcısı henüz bağlanmadı (sandbox anahtarı tanımlı değil).', 503);
    await limit(request, db, 'payment:' + c.id, 10);
    if (order.status !== 'new' || order.payment_status !== 'pending') fail('Bu sipariş ödeme beklemiyor.', 409);
    const open = await db.prepare("SELECT * FROM ws_payments WHERE order_id=? AND status IN ('initialized','pending','verified') LIMIT 1").bind(order.id).first();
    if (open?.status === 'verified') fail('Bu siparişin ödemesi zaten doğrulandı.', 409);

    const snapshot = JSON.parse(order.snapshot_json);
    const {name, surname} = splitName(snapshot.address?.name || c.name);
    const callbackUrl = (env.PAYMENT_CALLBACK_BASE || new URL(request.url).origin) + '/api/store/payment/callback';
    const initRequest = buildInitializeRequest({
      order: {
        id: order.id, total_cents: order.total_cents, shipping_cents: order.shipping_cents,
        items: snapshot.items.map(item => ({...item, category: 'Lunapot'})),
        shipping: snapshot.address, billing: snapshot.billing
      },
      buyer: {
        id: c.id, name, surname, email: c.email,
        // Kimlik numarası TOPLANMIYOR. Sandbox iyzico'nun kabul ettiği test değerini kullanır;
        // canlıya geçmeden bu alanın nasıl karşılanacağı ayrıca kararlaştırılmalıdır.
        identityNumber: '11111111111',
        gsmNumber: gsm(snapshot.address?.phone),
        ip: request.headers.get('CF-Connecting-IP') || '127.0.0.1'
      },
      callbackUrl
    });
    const response = await iyzicoCall(config, PATHS.initialize, initRequest, fetcherOf(env));
    if (response?.status !== 'success' || !response.token) fail('Ödeme başlatılamadı: ' + (response?.errorMessage || 'sağlayıcı yanıtı yok'), 502);
    if (response.signature && !await verifyInitializeSignature(response, config.secretKey)) fail('Sağlayıcı yanıtının imzası doğrulanamadı.', 502);
    try {
      // Önceki başlatılmış (tamamlanmamış) deneme kapanır; aynı anda tek açık ödeme olur.
      await db.batch([
        db.prepare("UPDATE ws_payments SET status='expired',reason='Yeni ödeme denemesi başlatıldı',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='initialized'").bind(order.id),
        db.prepare("INSERT INTO ws_payments(id,order_id,provider,mode,token,amount_cents) VALUES(?,?,'iyzico','sandbox',?,?)").bind(crypto.randomUUID(), order.id, response.token, order.total_cents)
      ]);
    } catch (error) {
      if (/UNIQUE/.test(String(error.message))) fail('Bu sipariş için başka bir ödeme işlemi sürüyor.', 409);
      throw error;
    }
    return json({mode: 'sandbox', payment_page_url: response.paymentPageUrl || null, token_expire_time: response.tokenExpireTime || null});
  }
  return null;
}
