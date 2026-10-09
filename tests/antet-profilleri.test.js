import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// ANTET PROFILLERI. Kullanicinin birden cok tuzel kisiligi var ve ikisi de ayni
// calisma alanindan belge kesiyor; bu yuzden antet kimligi calisma alanina degil
// BELGEYE baglanir. Bu dosya o profillerin kurallarini kilitler.
//
// Profil MUHASEBE KAYDI DEGILDIR: yalniz kagida basilan kimliktir. Alis faturasi
// eslestirmesi /settings'teki unvan ve VKN uzerinden yurur ve buradan etkilenmez.

const profil = (extra = {}) => ({
  label: 'Dekovill',
  legal_name: 'Dekovill Mimarlık İnşaat Taahhüt Gıda Sanayi Ticaret Limited Şirketi',
  tax_id: '2731455087',
  tax_office: 'Yalova Vergi Dairesi',
  address: 'Sahil Mahallesi Gamze Sokak No:3 D:8 Çiftlikköy / Yalova',
  phone: '0850 304 24 12',
  email: 'info@lunapot.com',
  website: 'lunapot.com',
  bank_name: 'Örnek Bank',
  bank_iban: 'TR120006200000000000000001',
  signature_title: 'Yetkili imza',
  ...extra
});

async function fixture() {
  const f = appFixture();
  await f.setup();
  return f;
}

async function evrakPersoneli(f, yetki) {
  const staff = await f.ok('/admin/users', {name: 'Antet', username: 'antet',
    permissions: {ec: {brand_documents: yetki, ledger: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'antet-personel-sifresi'});
  return (await f.req('/auth/login', {username: 'antet', password: 'antet-personel-sifresi'})).cookie;
}

test('Profil kaydedilir, listede doner ve ILK profil varsayilan olur', async () => {
  const f = await fixture(); try {
    const kayit = await f.ok('/ec/brand-profile/profiles', profil());
    assert.equal(kayit.saved, true);
    assert.equal(kayit.profiles.length, 1);
    const [p] = kayit.profiles;
    assert.equal(p.label, 'Dekovill');
    assert.equal(p.address, 'Sahil Mahallesi Gamze Sokak No:3 D:8 Çiftlikköy / Yalova');
    assert.equal(p.tax_office, 'Yalova Vergi Dairesi');
    assert.equal(p.is_default, 1, 'ilk profil varsayilan olmali, yoksa hicbir sey onsecili gelmez');
    // Ayni liste GET ile de gelir: ekran tek cagriyla kurulur.
    const okunan = await f.ok('/ec/brand-profile');
    assert.equal(okunan.profilesAvailable, true);
    assert.equal(okunan.profiles.length, 1);
    assert.equal(okunan.profiles[0].id, p.id);
  } finally { f.close(); }
});

test('Varsayilan TEK olur: ikincisi isaretlenince birincisi birakir', async () => {
  const f = await fixture(); try {
    const birinci = (await f.ok('/ec/brand-profile/profiles', profil())).profiles[0];
    const liste = (await f.ok('/ec/brand-profile/profiles',
      profil({label: 'Lunapot Endüstriyel', legal_name: 'Lunapot Endüstriyel A.Ş.', tax_id: '1234567890', is_default: true}))).profiles;
    assert.equal(liste.length, 2);
    assert.equal(liste.filter(p => p.is_default).length, 1, 'ayni anda tek varsayilan olmali');
    assert.equal(liste.find(p => p.is_default).label, 'Lunapot Endüstriyel');
    assert.equal(liste.find(p => p.id === birinci.id).is_default, 0);
  } finally { f.close(); }
});

test('Profil guncellenir; kimligi ve varsayilanligi KORUNUR', async () => {
  const f = await fixture(); try {
    const id = (await f.ok('/ec/brand-profile/profiles', profil())).id;
    const liste = (await f.ok('/ec/brand-profile/profiles', profil({id, phone: '0212 000 00 00'}))).profiles;
    assert.equal(liste.length, 1, 'guncelleme ikinci kayit yaratmamali');
    assert.equal(liste[0].id, id);
    assert.equal(liste[0].phone, '0212 000 00 00');
    assert.equal(liste[0].is_default, 1);
  } finally { f.close(); }
});

test('Olmayan kimlikle guncelleme 404 doner, sessizce yeni profil ACMAZ', async () => {
  const f = await fixture(); try {
    await f.ok('/ec/brand-profile/profiles', profil());
    const r = await f.req('/ec/brand-profile/profiles', profil({id: 'olmayan-profil', label: 'Hayalet'}));
    assert.equal(r.status, 404);
    assert.equal((await f.ok('/ec/brand-profile')).profiles.length, 1);
  } finally { f.close(); }
});

test('Ayni etiket, bos etiket ve taninmayan alan REDDEDILIR', async () => {
  const f = await fixture(); try {
    await f.ok('/ec/brand-profile/profiles', profil());
    const ayni = await f.req('/ec/brand-profile/profiles', profil({label: 'Dekovill'}));
    assert.equal(ayni.status, 400);
    assert.match(ayni.data.error, /zaten var/);
    assert.equal((await f.req('/ec/brand-profile/profiles', profil({label: ''}))).status, 400);
    const uydurma = await f.req('/ec/brand-profile/profiles', profil({uydurma: 'x'}));
    assert.equal(uydurma.status, 400);
    assert.match(uydurma.data.error, /tanınmayan alan/);
  } finally { f.close(); }
});

test('Hatali IBAN, e-posta ve vergi numarasi REDDEDILIR', async () => {
  const f = await fixture(); try {
    for (const kotu of [{bank_iban: 'TR12'}, {bank_iban: 'DE89370400440532013000'},
                        {email: 'bu-adres-degil'}, {tax_id: '123'}, {tax_id: 'abcdefghij'}]) {
      const r = await f.req('/ec/brand-profile/profiles', profil(kotu));
      assert.equal(r.status, 400, JSON.stringify(kotu) + ' kabul edildi');
    }
    // Bosluklu IBAN kabul edilir ve bosluksuz, buyuk harfle saklanir.
    const liste = (await f.ok('/ec/brand-profile/profiles', profil({bank_iban: 'tr12 0006 2000 0000 0000 0000 01'}))).profiles;
    assert.equal(liste[0].bank_iban, 'TR120006200000000000000001');
  } finally { f.close(); }
});

test('Varsayilan profil ARSIVLENEMEZ', async () => {
  const f = await fixture(); try {
    const id = (await f.ok('/ec/brand-profile/profiles', profil())).id;
    const r = await f.req('/ec/brand-profile/profiles/archive', {id});
    assert.equal(r.status, 409);
    assert.match(r.data.error, /varsayılan/i);
    assert.equal((await f.ok('/ec/brand-profile')).profiles.length, 1);
  } finally { f.close(); }
});

test('Arsivlenen profil listeden duser ama SILINMEZ; etiketi yeniden kullanilabilir', async () => {
  const f = await fixture(); try {
    await f.ok('/ec/brand-profile/profiles', profil());
    const ikinci = (await f.ok('/ec/brand-profile/profiles',
      profil({label: 'Lunapot Endüstriyel', tax_id: '1234567890'}))).profiles.find(p => p.label === 'Lunapot Endüstriyel');
    const sonra = (await f.ok('/ec/brand-profile/profiles/archive', {id: ikinci.id})).profiles;
    assert.equal(sonra.length, 1);
    assert.equal(sonra.some(p => p.id === ikinci.id), false, 'arsivlenen profil listede kalmamali');
    // Satir DURUYOR: eski belgeler hangi kimlikle basildigini gostermeye devam eder.
    const satir = f.sqlite.prepare('SELECT id,archived_at FROM brand_profiles WHERE id=?').get(ikinci.id);
    assert.ok(satir, 'arsivlenen profil silinmis');
    assert.ok(satir.archived_at, 'arsiv tarihi yazilmamis');
    // Ayni etiket yeniden kullanilabilir: tekillik yalniz yasayan profiller icindir.
    const yeniden = await f.req('/ec/brand-profile/profiles', profil({label: 'Lunapot Endüstriyel', tax_id: '1234567890'}));
    assert.equal(yeniden.status, 200);
  } finally { f.close(); }
});

test('Antet profili /settings unvanini ve VKN sini DEGISTIRMEZ', async () => {
  const f = await fixture(); try {
    await f.ok('/ec/settings', {legal_name: 'Dekovill Mimarlık', tax_id: '2731455087',
      inventory_start_date: '', allow_negative_stock: false});
    await f.ok('/ec/brand-profile/profiles', profil({legal_name: 'Bambaşka Bir Unvan', tax_id: '1234567890'}));
    const ayar = await f.ok('/ec/settings');
    assert.equal(ayar.settings.legal_name, 'Dekovill Mimarlık', 'sirket unvani profilden ezilmis');
    assert.equal(ayar.settings.tax_id, '2731455087', 'sirket VKN si profilden ezilmis');
  } finally { f.close(); }
});

test('Tablo YOKSA profil kapali gorunur; ana defter ve diger ekranlar 500 VERMEZ', async () => {
  const f = await fixture(); try {
    f.sqlite.exec('DROP TABLE brand_profiles');
    const okunan = await f.req('/ec/brand-profile');
    assert.equal(okunan.status, 200, 'gocu gecikmis ozellik ekrani dusurmemeli');
    assert.equal(okunan.data.profilesAvailable, false);
    assert.deepEqual(okunan.data.profiles, []);
    assert.match(okunan.data.profilesNotice, /göçü|kurulmadı/);
    // 0077 antet alanlari ayakta oldugu icin eski profil okunmaya devam eder.
    assert.equal(okunan.data.available, true);
    // Yazma denemesi acik bir 409 verir, 500 degil.
    const yazma = await f.req('/ec/brand-profile/profiles', profil());
    assert.equal(yazma.status, 409);
    assert.match(yazma.data.error, /göç/);
    for (const yol of ['/ec', '/ec/ledger', '/ec/offers', '/ec/settings', '/data'])
      assert.equal((await f.req(yol)).status, 200, yol + ' dusmus');
  } finally { f.close(); }
});

test('Okuma yetkili personel YAZAMAZ; ilgisiz personel hic goremez', async () => {
  const f = await fixture(); try {
    await f.ok('/ec/brand-profile/profiles', profil());
    const okur = await evrakPersoneli(f, 'read');
    assert.equal((await f.req('/ec/brand-profile', undefined, okur)).status, 200);
    assert.equal((await f.req('/ec/brand-profile/profiles', profil({label: 'Yeni'}), okur)).status, 403);
    assert.equal((await f.req('/ec/brand-profile/profiles/archive', {id: 'x'}, okur)).status, 403);
  } finally { f.close(); }
});

test('Yetkisiz personel antet profillerine HIC erisemez', async () => {
  const f = await fixture(); try {
    const yabanci = await evrakPersoneli(f, 'none');
    for (const [yol, govde] of [['/ec/brand-profile', undefined],
                                ['/ec/brand-profile/profiles', profil()],
                                ['/ec/brand-profile/profiles/archive', {id: 'x'}]])
      assert.equal((await f.req(yol, govde, yabanci)).status, 403, yol + ' acik kalmis');
  } finally { f.close(); }
});

test('Taninmayan alt yol 404 doner, belge listesine DUSMEZ', async () => {
  const f = await fixture(); try {
    const r = await f.req('/ec/brand-profile/uydurma-yol');
    assert.equal(r.status, 404);
  } finally { f.close(); }
});

// ---- Muhatabi cariden doldurmak ----
// Yasal unvan ve vergi dairesi cari DOSYASINDA durur; cari listesi bunlari da
// dondurmezse belgeye yalniz kisa ad ve VKN yazilir, kagit eksik basilir.

test('Cari listesi yasal unvani ve vergi dairesini de DONDURUR', async () => {
  const f = await fixture(); try {
    const cari = await f.ok('/ec/ledger/parties',
      {name: 'Şişli Çiçekçilik', kind: 'customer', tax_id: '9876543210', address: 'Teşvikiye Cd. 2'});
    await f.ok('/ec/party-profiles/' + cari.id, {expected_revision: 0,
      legal_name: 'Şişli Çiçekçilik Ltd. Şti.', trade_name: '', tax_office: 'Şişli Vergi Dairesi',
      contacts: [], addresses: [], tags: [], payment_terms_days: null, lead_days: null,
      responsible_staff_id: null});
    const {parties} = await f.ok('/ec/brand-documents/lookups/parties');
    const satir = parties.find(p => p.id === cari.id);
    assert.ok(satir, 'cari listede yok');
    assert.equal(satir.legal_name, 'Şişli Çiçekçilik Ltd. Şti.');
    assert.equal(satir.tax_office, 'Şişli Vergi Dairesi');
    assert.equal(satir.tax_id, '9876543210');
    assert.equal(satir.address, 'Teşvikiye Cd. 2');
  } finally { f.close(); }
});

test('Cari dosyasi OLMAYAN kayit da listede doner; unvan alanlari bos gelir', async () => {
  const f = await fixture(); try {
    const cari = await f.ok('/ec/ledger/parties', {name: 'Dosyasız Cari', kind: 'customer'});
    const {parties} = await f.ok('/ec/brand-documents/lookups/parties');
    const satir = parties.find(p => p.id === cari.id);
    assert.ok(satir, 'dosyasi olmayan cari listeden dusmus');
    assert.equal(satir.name, 'Dosyasız Cari');
    assert.equal(satir.legal_name, null);
    assert.equal(satir.tax_office, null);
  } finally { f.close(); }
});
