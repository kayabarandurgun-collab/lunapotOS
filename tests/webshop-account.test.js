import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {hash} from '../src/access-api.js';
import {LEGAL_VERSION} from '../src/webshop-legal.js';

// Hesap güvenliği, test posta kutusu ve iletişim formu. HİÇBİR ileti gönderilmez; hepsi ws_mail_outbox'a düşer.
function database() {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(x => x.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  s.exec("INSERT INTO ws_catalog VALUES('soil-standard','soil','Toprak','Standart','soil.webp','toprak',19000,3,1)");
  const prepare = sql => ({v: [], bind(...v) { this.v = v; return this; }, first() { return s.prepare(sql).get(...this.v) || null; }, all() { return {results: s.prepare(sql).all(...this.v)}; }, run() { return s.prepare(sql).run(...this.v); }});
  return {s, prepare, batch: async items => { s.exec('BEGIN'); try { const r = items.map(i => i.all()); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; } }, close: () => s.close()};
}

function store(extra = {}) {
  const DB = database(), env = {DB, WS_MODE: 'demo', ...extra}, origin = 'http://localhost';
  const call = async (path, body, cookie = '') => {
    const r = await worker.fetch(new Request(origin + '/api' + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), env);
    let data = null; try { data = await r.clone().json(); } catch { data = null; }
    const set = r.headers.get('Set-Cookie');
    return {status: r.status, data, cookie: set ? set.split(';')[0] : null};
  };
  const mails = kind => DB.s.prepare('SELECT * FROM ws_mail_outbox WHERE kind=? ORDER BY rowid').all(kind).map(r => ({...r}));
  const tokenFrom = (mail, param) => new URL(mail.body.match(/https?:\/\/\S+/)[0]).searchParams.get(param);
  const EMAIL = 'hesap@example.test', PASSWORD = 'local-test-password-123';
  const register = () => call('/store/auth/register', {email: EMAIL, name: 'Test Kişi', password: PASSWORD, terms_version: LEGAL_VERSION});
  const login = (password = PASSWORD) => call('/store/auth/login', {email: EMAIL, password});
  return {DB, env, call, mails, tokenFrom, register, login, EMAIL, PASSWORD};
}

test('Kayıt doğrulama iletisi üretir; bağlantı bir kez çalışır ve belirteç veritabanında açık tutulmaz', async () => {
  const t = store(); try {
    const r = await t.register();
    assert.equal(r.status, 200);
    const [mail] = t.mails('verify_email');
    assert.equal(mail.to_email, t.EMAIL);
    assert.equal(mail.mode, 'test');
    const token = t.tokenFrom(mail, 'dogrula');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(t.DB.s.prepare('SELECT COUNT(*) n FROM ws_account_tokens WHERE token_hash=?').get(token).n, 0, 'ham belirteç saklanmaz');
    assert.equal((await t.call('/store/account/status', undefined, r.cookie)).data.email_verified, false);
    assert.equal((await t.call('/store/account/verify', {token})).status, 200);
    assert.equal((await t.call('/store/account/status', undefined, r.cookie)).data.email_verified, true);
    assert.equal((await t.call('/store/account/verify', {token})).status, 400, 'ikinci kullanım reddedilir');
  } finally { t.DB.close(); }
});

test('Süresi dolmuş veya yenisiyle geçersizleşmiş doğrulama bağlantısı çalışmaz', async () => {
  const t = store(); try {
    const r = await t.register();
    const first = t.tokenFrom(t.mails('verify_email')[0], 'dogrula');
    assert.equal((await t.call('/store/account/verify/request', {}, r.cookie)).status, 200);
    assert.equal((await t.call('/store/account/verify', {token: first})).status, 400, 'yeni bağlantı eskisini kapatır');
    const expired = 'e'.repeat(64), customer = t.DB.s.prepare('SELECT id FROM ws_customers').get().id;
    t.DB.s.prepare("INSERT INTO ws_account_tokens(token_hash,customer_id,purpose,expires_at) VALUES(?,?,'verify_email',0)").run(await hash(expired), customer);
    assert.equal((await t.call('/store/account/verify', {token: expired})).status, 400);
    assert.equal((await t.call('/store/account/verify', {token: 'kısa'})).status, 400);
  } finally { t.DB.close(); }
});

test('Sıfırlama isteği hesabın varlığını söylemez', async () => {
  const t = store(); try {
    await t.register();
    const unknown = await t.call('/store/account/reset/request', {email: 'yok@example.test'});
    const known = await t.call('/store/account/reset/request', {email: t.EMAIL});
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.data, known.data);
    assert.equal(t.mails('reset_password').length, 1, 'yalnızca var olan hesaba ileti hazırlanır');
  } finally { t.DB.close(); }
});

test('Şifre sıfırlama tek kullanımlıktır, bütün oturumları kapatır, eski bağlantıları geçersiz kılar', async () => {
  const t = store(); try {
    const a = await t.register(), b = await t.login();
    for (const c of [a.cookie, b.cookie]) assert.equal((await t.call('/store/account/status', undefined, c)).status, 200);
    await t.call('/store/account/reset/request', {email: t.EMAIL});
    await t.call('/store/account/reset/request', {email: t.EMAIL});
    const [older, newer] = t.mails('reset_password').map(m => t.tokenFrom(m, 'sifirla'));
    assert.equal((await t.call('/store/account/reset', {token: older, password: 'yeni-sifre-1234567'})).status, 400, 'yeni istek eskisini kapatır');
    assert.equal((await t.call('/store/account/reset', {token: newer, password: 'kısa'})).status, 400, 'geçersiz şifre belirteci harcamaz');
    const done = await t.call('/store/account/reset', {token: newer, password: 'yeni-sifre-1234567'});
    assert.equal(done.status, 200);
    for (const c of [a.cookie, b.cookie]) assert.equal((await t.call('/store/account/status', undefined, c)).status, 401, 'eski oturum kapandı');
    assert.equal((await t.login()).status, 401, 'eski şifre çalışmaz');
    assert.equal((await t.login('yeni-sifre-1234567')).status, 200);
    assert.equal((await t.call('/store/account/reset', {token: newer, password: 'baska-sifre-1234567'})).status, 400, 'tekrar kullanılamaz');
    assert.throws(() => t.DB.s.exec("UPDATE ws_account_tokens SET used_at=NULL"), /WS_TOKEN_USED/);
  } finally { t.DB.close(); }
});

test('Her siparişte test kutusuna sipariş ve sözleşme bildirimi düşer', async () => {
  const t = store(); try {
    const r = await t.register();
    const address = {name: 'Test Kişi', phone: '05000000000', city: 'İstanbul', district: 'Şişli', line: 'Test adresi No 1'};
    const q = await t.call('/store/quote', {items: [{variant_id: 'soil-standard', qty: 1}], address, same_billing: true}, r.cookie);
    const o = await t.call('/store/orders', {quote_id: q.data.id, legal_version: LEGAL_VERSION, preinformation: true, contract: true}, r.cookie);
    assert.equal(o.status, 201);
    const number = t.DB.s.prepare('SELECT number FROM ws_orders WHERE id=?').get(o.data.id).number;
    const [mail] = t.mails('order_received');
    assert.equal(mail.order_id, o.data.id);
    assert.equal(mail.to_email, t.EMAIL);
    assert.match(mail.subject, new RegExp(number));
    assert.ok(mail.body.includes(LEGAL_VERSION) && mail.body.includes('249.00') && /test bildirimidir/.test(mail.body));
  } finally { t.DB.close(); }
});

test('İletişim formu sunucuya kaydedilir; e-postasız anonim mesaj alınmaz', async () => {
  const t = store(); try {
    const message = 'Nova için toplu alım fiyatı öğrenmek istiyorum.';
    assert.equal((await t.call('/store/contact', {topic: 'Toplu alım', message})).status, 400);
    assert.equal((await t.call('/store/contact', {topic: 'Uydurma', message, email: 'z@example.test'})).status, 400);
    assert.equal((await t.call('/store/contact', {topic: 'Toplu alım', message: 'kısa', email: 'z@example.test'})).status, 400);
    assert.equal((await t.call('/store/contact', {topic: 'Toplu alım', message, email: 'z@example.test', name: 'Z Firma'})).status, 200);
    const r = await t.register();
    assert.equal((await t.call('/store/contact', {topic: 'Sipariş hakkında', message}, r.cookie)).status, 200);
    const rows = t.DB.s.prepare('SELECT name,email,topic,status FROM ws_contact_messages ORDER BY rowid').all().map(x => ({...x}));
    assert.deepEqual(rows, [{name: 'Z Firma', email: 'z@example.test', topic: 'Toplu alım', status: 'open'},
      {name: 'Test Kişi', email: t.EMAIL, topic: 'Sipariş hakkında', status: 'open'}]);
    assert.equal(t.mails('contact_received').length, 2);
    assert.throws(() => t.DB.s.exec('DELETE FROM ws_contact_messages'), /IMMUTABLE_LEDGER/);
  } finally { t.DB.close(); }
});

test('Canlı ortamda hesap ve iletişim uçları kapalı; test e-postaları oturumsuz okunamaz', async () => {
  const t = store({WS_MODE: undefined}); try {
    assert.equal((await t.call('/store/account/reset/request', {email: 'a@example.test'})).status, 503);
    assert.equal((await t.call('/store/contact', {topic: 'Diğer', message: 'Merhaba, bir sorum var.', email: 'a@example.test'})).status, 503);
    assert.ok([401, 403].includes((await t.call('/webshop/outbox')).status));
    assert.equal(t.DB.s.prepare('SELECT COUNT(*) n FROM ws_mail_outbox').get().n, 0);
  } finally { t.DB.close(); }
});
