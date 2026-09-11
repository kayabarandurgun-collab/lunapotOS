// Web mağaza hesap güvenliği, test posta kutusu ve iletişim mesajları.
//
//   POST /api/store/account/verify/request   giriş yapmış müşteriye doğrulama bağlantısı (test kutusuna)
//   POST /api/store/account/verify           {token}  e-postayı doğrular (tek kullanımlık, 24 saat)
//   POST /api/store/account/reset/request    {email}  sıfırlama bağlantısı; hesabın varlığını SÖYLEMEZ
//   POST /api/store/account/reset            {token,password}  tek kullanımlık, 30 dk; bütün oturumlar kapanır
//   GET  /api/store/account/status           e-posta doğrulandı mı
//   POST /api/store/contact                  iletişim formu → sunucu kaydı (mailto yerine)
//
//   GET  /api/webshop/outbox                 test e-postaları (YALNIZCA yönetici: sıfırlama bağlantısı içerir)
//   GET  /api/webshop/contact                iletişim mesajları
//   POST /api/webshop/contact/:id            {status}
//
// HİÇBİR E-POSTA GÖNDERİLMEZ. Bütün iletiler ws_mail_outbox (mode='test') tablosuna yazılır.
// Bütün müşteri uçları storeApi içinde requireDemo'dan SONRA çağrılır: canlıda kapalıdır.

const TTL = {verify_email: 24 * 3600, reset_password: 30 * 60};
const TOPICS = ['Ürün hakkında', 'Sipariş hakkında', 'Proje talebi', 'Toplu alım', 'İş birliği', 'Kurumsal talep', 'Diğer'];
const RESET_REPLY = 'Bu e-posta ile bir hesap varsa sıfırlama bağlantısı gönderildi. Test sürümünde ileti gerçekten gönderilmez.';

const outbox = (db, {customer_id = null, order_id = null, to, kind, subject, body}) =>
  db.prepare('INSERT INTO ws_mail_outbox(id,customer_id,order_id,to_email,kind,subject,body) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), customer_id, order_id, to, kind, subject, body);

/**
 * Yeni belirteç üretir, aynı amaçla açık kalan eskileri kapatır, bağlantıyı test kutusuna yazar.
 * Ham belirteç yalnızca iletinin gövdesindedir; veritabanındaki kayıt özettir.
 */
export async function issueToken(db, {hash, hex, now}, customer, purpose, origin) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const link = new URL('/magaza/hesabim.html', origin);
  link.searchParams.set(purpose === 'verify_email' ? 'dogrula' : 'sifirla', token);
  const verify = purpose === 'verify_email';
  await db.batch([
    db.prepare('UPDATE ws_account_tokens SET used_at=CURRENT_TIMESTAMP WHERE customer_id=? AND purpose=? AND used_at IS NULL').bind(customer.id, purpose),
    db.prepare('INSERT INTO ws_account_tokens(token_hash,customer_id,purpose,expires_at) VALUES(?,?,?,?)').bind(await hash(token), customer.id, purpose, now() + TTL[purpose]),
    outbox(db, {
      customer_id: customer.id, to: customer.email, kind: purpose,
      subject: verify ? 'Lunapot hesabını doğrula' : 'Lunapot şifre sıfırlama',
      body: 'Merhaba ' + customer.name + ',\n\n' +
        (verify ? 'E-posta adresini doğrulamak için bağlantıyı aç (24 saat geçerli, bir kez kullanılır):\n'
          : 'Şifreni sıfırlamak için bağlantıyı aç (30 dakika geçerli, bir kez kullanılır). Bu isteği sen yapmadıysan iletiyi yok say:\n') +
        link.toString() + '\n\nBu bir test iletisidir; gerçekten gönderilmedi.'
    })
  ]);
}

/** Belirteci tek bir koşullu güncellemeyle harcar: eşzamanlı iki istekten yalnızca biri sahibini alır. */
async function consume(db, {hash, now}, token, purpose) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare('UPDATE ws_account_tokens SET used_at=CURRENT_TIMESTAMP WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>? RETURNING customer_id')
    .bind(await hash(token), purpose, now()).first();
  return row?.customer_id || null;
}

export async function accountRoutes({request, env, sub, readBody, db, helpers}) {
  const {customer, passwordHash, email, text, fail, json, limit, cookie} = helpers;
  const method = request.method, origin = new URL(request.url).origin;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  if (sub === '/account/status' && method === 'GET') {
    const c = await customer(request, db);
    if (!c) fail('Mağaza hesabınla giriş yap.', 401);
    const row = await db.prepare('SELECT email_verified_at FROM ws_customers WHERE id=?').bind(c.id).first();
    return json({email_verified: !!row?.email_verified_at});
  }

  if (sub === '/account/verify/request' && method === 'POST') {
    const c = await customer(request, db);
    if (!c) fail('Mağaza hesabınla giriş yap.', 401);
    await limit(request, db, 'verify:' + c.id, 5);
    const row = await db.prepare('SELECT email_verified_at FROM ws_customers WHERE id=?').bind(c.id).first();
    if (row?.email_verified_at) return json({ok: true, already: true});
    await issueToken(db, helpers, c, 'verify_email', origin);
    return json({ok: true, message: 'Doğrulama bağlantısı hazırlandı. Test sürümünde ileti gerçekten gönderilmez.'});
  }

  if (sub === '/account/verify' && method === 'POST') {
    const x = await readBody(request);
    await limit(request, db, 'verify-confirm:' + ip, 20);
    const customerId = await consume(db, helpers, x.token, 'verify_email');
    if (!customerId) fail('Doğrulama bağlantısı geçersiz, kullanılmış ya da süresi dolmuş.', 400);
    await db.prepare('UPDATE ws_customers SET email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP) WHERE id=?').bind(customerId).run();
    return json({ok: true});
  }

  if (sub === '/account/reset/request' && method === 'POST') {
    const x = await readBody(request), em = email(x.email);
    await limit(request, db, 'reset:' + em, 5);
    const c = await db.prepare('SELECT id,email,name FROM ws_customers WHERE email=?').bind(em).first();
    // Hesap olsun olmasın aynı yanıt: e-posta adresinin kayıtlı olup olmadığı buradan öğrenilemez.
    if (c) await issueToken(db, helpers, c, 'reset_password', origin);
    return json({ok: true, message: RESET_REPLY});
  }

  if (sub === '/account/reset' && method === 'POST') {
    const x = await readBody(request);
    await limit(request, db, 'reset-confirm:' + ip, 20);
    if (typeof x.password !== 'string' || x.password.length < 12 || x.password.length > 200) fail('Yeni şifre 12–200 karakter olmalı.');
    const customerId = await consume(db, helpers, x.token, 'reset_password');
    if (!customerId) fail('Sıfırlama bağlantısı geçersiz, kullanılmış ya da süresi dolmuş. Yeni bağlantı iste.', 400);
    const salt = crypto.randomUUID();
    await db.batch([
      db.prepare('UPDATE ws_customers SET salt=?,password_hash=?,email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP) WHERE id=?')
        .bind(salt, await passwordHash(x.password, salt), customerId),
      // Şifre sıfırlandı: açık bütün oturumlar kapanır, bekleyen diğer sıfırlama bağlantıları geçersiz olur.
      db.prepare('DELETE FROM ws_sessions WHERE customer_id=?').bind(customerId),
      db.prepare("UPDATE ws_account_tokens SET used_at=CURRENT_TIMESTAMP WHERE customer_id=? AND purpose='reset_password' AND used_at IS NULL").bind(customerId)
    ]);
    return json({ok: true, message: 'Şifren değişti. Yeni şifrenle giriş yap.'}, 200, {'Set-Cookie': cookie(request, '', 0)});
  }

  if (sub === '/contact' && method === 'POST') {
    const x = await readBody(request), c = await customer(request, db);
    await limit(request, db, 'contact:' + ip, 5);
    const to = c ? c.email : (x.email ? email(x.email) : fail('Sana dönebilmemiz için e-posta adresini yaz.'));
    const topic = TOPICS.includes(x.topic) ? x.topic : fail('Konu seçimi geçersiz.');
    const message = typeof x.message === 'string' ? x.message.trim() : '';
    if (message.length < 10 || message.length > 2000) fail('Mesajın 10–2000 karakter olmalı.');
    const name = x.name ? text(x.name, 'Ad', 100) : (c?.name || '');
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT INTO ws_contact_messages(id,customer_id,name,email,topic,message) VALUES(?,?,?,?,?,?)').bind(id, c?.id || null, name, to, topic, message),
      outbox(db, {customer_id: c?.id || null, to, kind: 'contact_received', subject: 'Mesajın bize ulaştı: ' + topic,
        body: 'Merhaba' + (name ? ' ' + name : '') + ',\n\nMesajını aldık; en kısa sürede dönüş yapacağız.\n\nKonu: ' + topic + '\n\n' + message + '\n\nBu bir test iletisidir; gerçekten gönderilmedi.'})
    ]);
    return json({ok: true, message: 'Mesajın kaydedildi. Test sürümünde yanıt e-postası gerçekten gönderilmez.'});
  }
  return null;
}

export async function accountAdminRoutes({request, env, path, readBody, user, helpers}) {
  const {requireDemo, fail, can} = helpers;
  const db = env.DB, method = request.method, sub = path.slice('/api/webshop'.length);
  const url = new URL(request.url), page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1)), offset = (page - 1) * 50;

  if (sub === '/outbox' && method === 'GET') {
    // İletiler sıfırlama bağlantısı içerir; personel bunları görürse müşteri hesabını ele geçirebilir.
    if (!user?.owner) fail('Test e-postalarını yalnızca yönetici görebilir.', 403);
    return {
      mails: (await db.prepare('SELECT id,to_email,kind,subject,body,order_id,created_at FROM ws_mail_outbox ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?').bind(offset).all()).results,
      page, total: (await db.prepare('SELECT COUNT(*) n FROM ws_mail_outbox').first()).n,
      notice: 'Test yakalayıcısı: bu iletilerin hiçbiri gerçekten gönderilmedi.'
    };
  }
  if (sub === '/contact' && method === 'GET') {
    return {
      messages: (await db.prepare('SELECT id,name,email,topic,message,status,created_at FROM ws_contact_messages ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?').bind(offset).all()).results,
      page, total: (await db.prepare('SELECT COUNT(*) n FROM ws_contact_messages').first()).n
    };
  }
  const match = sub.match(/^\/contact\/([a-f0-9-]{36})$/);
  if (match && method === 'POST') {
    if (!can(user, 'ec', 'webshop', true)) fail('Bu işlem için yazma yetkisi gerekli.', 403);
    requireDemo(request, env);
    const x = await readBody(request);
    if (!['open', 'reviewing', 'closed'].includes(x.status)) fail('Geçersiz durum.');
    const r = await db.prepare('UPDATE ws_contact_messages SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING id').bind(x.status, match[1]).first();
    if (!r) fail('Mesaj bulunamadı.', 404);
    return {ok: true};
  }
  return null;
}
