// YÖNETİCİ ŞİFRESİ EKRANDAN DEĞİŞİR. Güvenlik incelemesi: şifre ya da oturum çerezi sızarsa kapatmanın
// yolu yoktu (çalışan hesapları davet yenilenerek kapatılabiliyordu, yönetici kapatılamıyordu).
// Şifre değişince yöneticinin bütün oturumları kapanır; değişikliği yapan cihaz yeni çerezle açık kalır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const ESKI = 'synthetic-owner-password', YENI = 'sentetik-yeni-sifre-2026';

test('Yönetici şifresini değiştirir; eski oturumlar kapanır, eski şifre geçmez', async () => {
  const f = appFixture(); await f.setup(); try {
    // İkinci cihazdan da giriş: bu oturum şifre değişince kapanmalı.
    const ikinci = (await f.req('/auth/login', {password: ESKI}, '')).cookie;
    assert.equal((await f.req('/ec/settings', undefined, ikinci)).status, 200);
    assert.equal((await f.req('/admin/password', {current_password: 'yanlis-sifre-123', password: YENI})).status, 401, 'şu anki şifre doğrulanır');
    assert.equal((await f.req('/admin/password', {current_password: ESKI, password: 'kisa'})).status, 400, 'en az 12 karakter');
    const r = await f.req('/admin/password', {current_password: ESKI, password: YENI});
    assert.equal(r.status, 200);
    assert.ok(r.cookie, 'değişikliği yapan cihaz yeni çerez alır');
    assert.equal((await f.req('/ec/settings', undefined, r.cookie)).status, 200, 'bu cihaz açık kalır');
    assert.equal((await f.req('/ec/settings', undefined, ikinci)).status, 401, 'diğer cihazın oturumu kapandı');
    assert.equal((await f.req('/auth/login', {password: ESKI}, '')).status, 401, 'eski şifre geçmez');
    assert.equal((await f.req('/auth/login', {password: YENI}, '')).status, 200, 'yeni şifre geçer');
    // Denetim izine yazılır.
    assert.match(f.sqlite.prepare("SELECT action FROM access_audit ORDER BY rowid DESC LIMIT 1").get().action, /şifresi değiştirildi/);
  } finally { f.close(); }
});

test('Personel yönetici şifresini değiştiremez', async () => {
  const f = appFixture(); await f.setup(); try {
    const davet = await f.ok('/admin/users', {username: 'sentetik.personel', name: 'Sentetik Personel', ec_access: 'read', lp_access: 'none'});
    const token = davet.invite_path.split('=')[1];
    const kabul = await f.req('/auth/accept-invite', {token, password: 'sentetik-personel-2026'}, '');
    assert.equal(kabul.status, 200);
    const oturum = (await f.req('/auth/login', {username: 'sentetik.personel', password: 'sentetik-personel-2026'}, '')).cookie;
    const r = await f.req('/admin/password', {current_password: ESKI, password: YENI}, oturum);
    assert.equal(r.status, 403, 'personel reddedilir');
    assert.equal((await f.req('/auth/login', {password: ESKI}, '')).status, 200, 'yönetici şifresi değişmedi');
  } finally { f.close(); }
});
