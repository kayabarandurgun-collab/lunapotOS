// "Fatura belgeleri" ekranı yeni bir yetki İCAT ETMEZ: alış ve satış fatura belgelerini
// gösterdiği için mevcut `invoices` yetkisine bağlıdır.
//
// Neden test: yeni ekran için yeni bir yetki anahtarı açmak, kayıtlı personel yetkilerinde
// o anahtar bulunmadığı için herkesi dışarıda bırakırdı — ekran yapılmış ama erişilemez olurdu.
// Sunucu tarafında da satış BELGESİ ucu yanlışlıkla `sales` (satış kaydı) yetkisine düşerse,
// yalnız fatura yetkisi olan personel ekranı açar ama satış sekmesinde 403 alır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {routeKey, can} from '../public/permissions.js';

const personel = (izinler) => ({owner: false, name: 'Personel', ec_access: 'write', lp_access: 'none',
  permissions: {ec: izinler, lp: {}, delete_records: false}});

test('Ekran rotası mevcut fatura yetkisine eşlenir; yeni yetki anahtarı gerekmez', () => {
  assert.equal(routeKey('ec', 'documents'), 'invoices', 'documents -> invoices');
  assert.equal(routeKey('ec', 'orders'), 'orders', 'diğer rotalar değişmez');
  assert.equal(routeKey('lp', 'documents'), 'documents', 'üretim alanında eşleme yok');

  const faturaci = personel({invoices: 'write'});
  assert.equal(can(faturaci, 'ec', routeKey('ec', 'documents')), true, 'fatura yetkisi ekranı açar');
  assert.equal(can(faturaci, 'ec', routeKey('ec', 'documents'), true), true, 'yazma da açık');

  const depocu = personel({stock: 'read'});
  assert.equal(can(depocu, 'ec', routeKey('ec', 'documents')), false, 'fatura yetkisi olmayan giremez');
});

async function girisYap(f, izinler) {
  const staff = await f.ok('/admin/users', {name: 'Faturacı', username: 'faturaci',
    permissions: {ec: izinler, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'fatura-personel-sifresi'});
  return (await f.req('/auth/login', {username: 'faturaci', password: 'fatura-personel-sifresi'})).cookie;
}

test('Satış belgesi ucu fatura yetkisiyle açılır, satış kaydı yetkisiyle açılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const fatura = await girisYap(f, {invoices: 'write'});
    const r = await f.req('/ec/sales/documents', undefined, fatura);
    assert.equal(r.status, 200, 'fatura yetkisi satış belgesi arşivini görür');
    assert.ok(Array.isArray(r.data.documents));

    // Alış sayfa bağlantısı ucu da aynı ekranda; o da fatura yetkisine bağlı.
    const belgeler = await f.req('/ec/invoices/documents', undefined, fatura);
    assert.equal(belgeler.status, 200);
  } finally { f.close(); }
});

test('Yalnız satış kaydı yetkisi olan personel belge arşivine giremez', async () => {
  const f = appFixture(); await f.setup(); try {
    const satisci = await girisYap(f, {sales: 'write'});
    const r = await f.req('/ec/sales/documents', undefined, satisci);
    assert.equal(r.status, 403, 'satış kaydı yetkisi belge arşivi demek değildir');

    const yazma = await f.req('/ec/sales/documents', {kind: 'pdf', provider: 'trendyol', filename: 'x.pdf',
      sha256: 'a'.repeat(64), size_bytes: 10, chunk_count: 1}, satisci);
    assert.equal(yazma.status, 403, 'yazma da engellenir');
  } finally { f.close(); }
});

test('Ekranın kullandığı türev ayrıştırması özgün sayfa aralığını korur', async () => {
  const {turevBilgisi} = await import('../public/sales-document-ui.js');
  assert.deepEqual(turevBilgisi('tüm siparişler sayfa1-parca2(sayfa23-43).pdf'),
    {origin_filename: 'tüm siparişler sayfa1.pdf', origin_first_page: 23, origin_last_page: 43});
  assert.equal(turevBilgisi('4561.pdf'), null, 'tekil dosya türev değildir');
  assert.equal(turevBilgisi('rapor-parca1(sayfa5-1).pdf'), null, 'ters aralık kabul edilmez');
});
