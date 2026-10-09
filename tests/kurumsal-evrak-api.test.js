import test from 'node:test';import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {BRAND_DOCUMENT_TYPES} from '../src/brand-documents-api.js';

// Dokuz kurumsal evrak turu. HICBIRI gercek siparis, fatura, irsaliye, tahsilat
// ya da stok hareketi yaratmaz. Teklif ve proforma bu defterde DEGIL.

const gun = o => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const BUGUN = gun(0), YIL = BUGUN.slice(0, 4);

const sunum = () => ({
  schema_version: 1, template_id: 'lunapot-business-v2', template_version: 1,
  logo_variant_id: 'lunapot-yatay-antrasit',
  company_snapshot: {name: 'Lunapot', address: 'Örnek mah. 1', contact: '', tax: '', bank: ''},
  brand_version: 'v8'
});

const paraliSatir = (extra = {}) => ({description: 'Terracotta saksı 30 cm', unit: 'adet',
  quantity_milli: 2000, unit_price_cents: 12500, discount_bps: 1000, vat_bps: 2000, ...extra});
const sadeSatir = (extra = {}) => ({description: 'Terracotta saksı 30 cm', unit: 'adet',
  quantity_milli: 2000, note: 'Kontrol edildi', ...extra});

const icerik = (extra = {}) => ({
  title: 'Sipariş onayı', issue_date: BUGUN, reference: 'REF-1',
  recipient_snapshot: {name: 'Şişli Çiçekçilik', address: 'Teşvikiye 2', contact: '', tax: '', bank: ''},
  notes: 'Teslim 15 iş günü.', prepared: 'Baran Kaya', approved: 'Yönetim', example: false,
  lines: [paraliSatir()], ...extra
});

async function fixture() {
  const f = appFixture(); await f.setup();
  const party = await f.ok('/ec/ledger/parties', {name: 'Şişli Çiçekçilik Ltd. Şti.', kind: 'customer', tax_id: '9876543210'});
  return {f, party: party.id};
}

test('Dokuz tur tanimlidir; teklif ve proforma bu deftere GIRMEZ', () => {
  assert.deepEqual(Object.keys(BRAND_DOCUMENT_TYPES).sort(), ['antet', 'dosya-kapagi', 'iade-formu',
    'paket-listesi', 'satinalma-siparisi', 'siparis-onayi', 'teknik-bilgi', 'teslim-tutanagi', 'toplanti-notu']);
  assert.equal(BRAND_DOCUMENT_TYPES.teklif, undefined);
  assert.equal(BRAND_DOCUMENT_TYPES.proforma, undefined);
  assert.equal(BRAND_DOCUMENT_TYPES.contract, undefined);
});

test('Belge olusur, numarasi SUNUCUDA uretilir, geri okunur', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {
      type: 'siparis-onayi', party_id: party, content: icerik(), presentation: sunum(),
      // Istemcinin uydurdugu numara ESAS ALINMAZ.
      idempotency_key: 'istek-1'
    });
    assert.equal(doc.document_no, 'SIP-' + YIL + '-0001');
    assert.equal(doc.revision, 1);
    assert.equal(doc.status, 'draft');
    assert.equal(doc.type_name, 'Sipariş onayı');
    assert.equal(doc.line_count, 1);
    assert.equal(doc.total_cents, 27000);
    assert.equal(doc.content.notice.includes('resmî fatura'), true);
    const yeniden = await f.ok('/ec/brand-documents/' + doc.id);
    assert.equal(yeniden.document_no, doc.document_no);
    assert.equal(yeniden.presentation.logo_variant_id, 'lunapot-yatay-antrasit');
  } finally { f.close(); }
});

test('Numara tur bazinda sirayla artar', async () => {
  const {f, party} = await fixture(); try {
    const a = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    const b = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    const c = await f.ok('/ec/brand-documents', {type: 'satinalma-siparisi', party_id: party, content: icerik({title: 'Satın alma'})});
    assert.equal(a.document_no, 'SIP-' + YIL + '-0001');
    assert.equal(b.document_no, 'SIP-' + YIL + '-0002');
    assert.equal(c.document_no, 'SAT-' + YIL + '-0001');
  } finally { f.close(); }
});

test('idempotency_key ayni istegi iki kez kaydetmez', async () => {
  const {f, party} = await fixture(); try {
    const govde = {type: 'siparis-onayi', party_id: party, content: icerik(), idempotency_key: 'ayni-istek'};
    const a = await f.ok('/ec/brand-documents', govde);
    const b = await f.ok('/ec/brand-documents', govde);
    assert.equal(a.id, b.id, 'kopya belge olustu');
    const liste = await f.ok('/ec/brand-documents');
    assert.equal(liste.items.length, 1);
  } finally { f.close(); }
});

test('Parasiz tablolu turde satir PARA TASIMAZ', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'paket-listesi', party_id: party,
      content: icerik({title: 'Paket listesi', lines: [sadeSatir()]})});
    assert.equal(doc.total_cents, null);
    assert.equal(doc.content.lines[0].note, 'Kontrol edildi');
    assert.equal('unit_price_cents' in doc.content.lines[0], false, 'parasiz turde fiyat alani var');
    assert.equal(doc.content.totals, null);
    // Para alani gonderilirse REDDEDILIR.
    const r = await f.req('/ec/brand-documents', {type: 'paket-listesi', party_id: party,
      content: icerik({title: 'Paket', lines: [paraliSatir()]})});
    assert.equal(r.status, 400);
  } finally { f.close(); }
});

test('Tablosuz turde satir gonderilemez', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'antet', party_id: party,
      content: {title: 'Antetli yazı', issue_date: BUGUN, notes: 'Sayın ilgili,', lines: []}});
    assert.equal(doc.line_count, 0);
    assert.equal(doc.total_cents, null);
    const r = await f.req('/ec/brand-documents', {type: 'toplanti-notu',
      content: {title: 'Toplantı', issue_date: BUGUN, lines: [sadeSatir()]}});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /satır tablosu bulunmaz/);
  } finally { f.close(); }
});

test('Taslak guncellenir; expected_revision catisma 409 verir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    const guncel = await f.ok('/ec/brand-documents/' + doc.id,
      {content: icerik({title: 'Düzeltilmiş onay'}), expected_revision: 1});
    assert.equal(guncel.content.title, 'Düzeltilmiş onay');
    // Sunum gonderilmedi: mevcut sunum KORUNUR.
    const r = await f.req('/ec/brand-documents/' + doc.id, {content: icerik(), expected_revision: 99});
    assert.equal(r.status, 409);
  } finally { f.close(); }
});

test('Sunum gonderilmedigide korunur, null ile temizlenir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik(), presentation: sunum()});
    const a = await f.ok('/ec/brand-documents/' + doc.id, {content: icerik({title: 'Yeni'})});
    assert.equal(a.presentation.logo_variant_id, 'lunapot-yatay-antrasit', 'sunum silindi');
    const b = await f.ok('/ec/brand-documents/' + doc.id, {content: icerik(), presentation: null});
    assert.equal(b.presentation, null);
  } finally { f.close(); }
});

test('Dondurulan belge DEGISMEZ; cikti almak finalize degildir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    // Okumak ya da listelemek belgeyi dondurmaz.
    await f.ok('/ec/brand-documents/' + doc.id);
    assert.equal((await f.ok('/ec/brand-documents/' + doc.id)).status, 'draft');
    const dondu = await f.ok('/ec/brand-documents/' + doc.id + '/finalize', {});
    assert.equal(dondu.status, 'final');
    const r = await f.req('/ec/brand-documents/' + doc.id, {content: icerik({title: 'Zorla'})});
    assert.equal(r.status, 409);
    assert.equal((await f.ok('/ec/brand-documents/' + doc.id)).content.title, 'Sipariş onayı');
  } finally { f.close(); }
});

test('Revizyon ayni numarayi surdurur, onceki belge degismez', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    await f.ok('/ec/brand-documents/' + doc.id + '/finalize', {});
    const rev = await f.ok('/ec/brand-documents/' + doc.id + '/revisions',
      {content: icerik({title: 'İkinci sürüm'})});
    assert.equal(rev.document_no, doc.document_no);
    assert.equal(rev.revision, 2);
    assert.equal(rev.supersedes, doc.id);
    assert.equal(rev.status, 'draft');
    const ilk = await f.ok('/ec/brand-documents/' + doc.id);
    assert.equal(ilk.content.title, 'Sipariş onayı', 'onceki revizyon degismis');
    // Ikinci revizyon istegi reddedilir.
    const r = await f.req('/ec/brand-documents/' + doc.id + '/revisions', {content: icerik()});
    assert.equal(r.status, 409);
  } finally { f.close(); }
});

test('Cogaltma YENI numara verir; kaynak belge degismez', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    const kopya = await f.ok('/ec/brand-documents/' + doc.id + '/duplicate', {});
    assert.notEqual(kopya.id, doc.id);
    assert.equal(kopya.document_no, 'SIP-' + YIL + '-0002');
    assert.equal(kopya.revision, 1);
    assert.equal(kopya.supersedes, null);
    assert.equal(kopya.content.title, doc.content.title);
    assert.equal((await f.ok('/ec/brand-documents/' + doc.id)).document_no, 'SIP-' + YIL + '-0001');
  } finally { f.close(); }
});

test('Arsivleme gecmisi SILMEZ', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    const ars = await f.ok('/ec/brand-documents/' + doc.id + '/archive', {});
    assert.equal(ars.status, 'archived');
    const okunur = await f.ok('/ec/brand-documents/' + doc.id);
    assert.equal(okunur.content.title, 'Sipariş onayı');
    assert.equal(okunur.document_no, 'SIP-' + YIL + '-0001');
  } finally { f.close(); }
});

test('Liste sayfalanir ve tur suzulur', async () => {
  const {f, party} = await fixture(); try {
    for (let i = 0; i < 3; i++)
      await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik({title: 'Onay ' + i})});
    await f.ok('/ec/brand-documents', {type: 'antet', content: {title: 'Yazı', issue_date: BUGUN, notes: 'x'}});
    const hepsi = await f.ok('/ec/brand-documents');
    assert.equal(hepsi.items.length, 4);
    assert.equal(hepsi.available, true);
    const onaylar = await f.ok('/ec/brand-documents?type=siparis-onayi');
    assert.equal(onaylar.items.length, 3);
    assert.ok(onaylar.items.every(x => x.type === 'siparis-onayi'));
    const r = await f.req('/ec/brand-documents?type=uydurma');
    assert.equal(r.status, 400);
  } finally { f.close(); }
});

test('Cari ve urun secimi yetkili alandan gelir', async () => {
  const {f, party} = await fixture(); try {
    const cariler = await f.ok('/ec/brand-documents/lookups/parties');
    assert.ok(cariler.parties.some(p => p.id === party));
    const arama = await f.ok('/ec/brand-documents/lookups/parties?q=Şişli');
    assert.equal(arama.parties.length, 1);
    const bos = await f.ok('/ec/brand-documents/lookups/parties?q=bulunmayan-cari');
    assert.equal(bos.parties.length, 0);
    const urunler = await f.ok('/ec/brand-documents/lookups/products');
    assert.ok(Array.isArray(urunler.products));
  } finally { f.close(); }
});

test('Baska alanin carisi secilemez', async () => {
  const {f, party} = await fixture(); try {
    // ec carisi lp belgesine baglanamaz.
    const r = await f.req('/lp/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    assert.equal(r.status, 404);
    assert.match(r.data.error, /bulunamadı/);
    const uydurma = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: 'olmayan-id', content: icerik()});
    assert.equal(uydurma.status, 404);
  } finally { f.close(); }
});

test('Kaynak atfi dogrulanir ve finansal etki yaratmaz', async () => {
  const {f, party} = await fixture(); try {
    const r = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik(),
      source_ref: {kind: 'offer', id: 'olmayan-teklif'}});
    assert.equal(r.status, 404);
    const kotu = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik(),
      source_ref: {kind: 'fatura', id: 'x'}});
    assert.equal(kotu.status, 400);
  } finally { f.close(); }
});

test('Bu belgeler STOK ve DEFTER hareketi yaratmaz', async () => {
  const {f, party} = await fixture(); try {
    const once = {
      stok: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_stock_movements').get().c,
      satis: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_sale_entries').get().c,
      fatura: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_purchase_invoices').get().c,
      kasa: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_cash_transactions').get().c,
      cari: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_party_entries').get().c
    };
    for (const type of Object.keys(BRAND_DOCUMENT_TYPES)) {
      const spec = BRAND_DOCUMENT_TYPES[type];
      const govde = spec.table
        ? icerik({title: spec.name, lines: [spec.money ? paraliSatir() : sadeSatir()]})
        : {title: spec.name, issue_date: BUGUN, notes: 'içerik'};
      const doc = await f.ok('/ec/brand-documents', {type, party_id: party, content: govde});
      await f.ok('/ec/brand-documents/' + doc.id + '/finalize', {});
    }
    const sonra = {
      stok: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_stock_movements').get().c,
      satis: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_sale_entries').get().c,
      fatura: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_purchase_invoices').get().c,
      kasa: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_cash_transactions').get().c,
      cari: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_party_entries').get().c
    };
    assert.deepEqual(sonra, once, 'kurumsal evrak muhasebe kaydi yaratti');
  } finally { f.close(); }
});

test('Antet profili okunur ve YALNIZ antet alanlarini yazar', async () => {
  const {f} = await fixture(); try {
    await f.ok('/ec/settings', {legal_name: 'Lunapot Ltd.', tax_id: '1234567890'});
    const once = await f.ok('/ec/brand-profile');
    assert.equal(once.profile.legal_name, 'Lunapot Ltd.');
    assert.equal(once.profile.address, '');
    const kaydet = await f.ok('/ec/brand-profile', {
      address: 'Örnek mah. No 1 Şişli/İstanbul', phone: '0212 000 00 00',
      email: 'bilgi@lunapot.com', website: 'lunapot.com', tax_office: 'Şişli',
      bank_name: 'Örnek Bank', bank_iban: 'TR120006200000000000000001', signature_title: 'Genel Müdür'
    });
    assert.equal(kaydet.profile.address, 'Örnek mah. No 1 Şişli/İstanbul');
    assert.equal(kaydet.profile.bank_iban, 'TR120006200000000000000001');
    // Unvan ve VKN SIFIRLANMADI.
    assert.equal(kaydet.profile.legal_name, 'Lunapot Ltd.');
    assert.equal(kaydet.profile.tax_id, '1234567890');
    // Operasyon ayarlari da durur.
    const ayarlar = await f.ok('/ec/settings');
    assert.equal(ayarlar.settings.legal_name, 'Lunapot Ltd.');
  } finally { f.close(); }
});

test('Antet profilinde uydurma deger kabul edilmez', async () => {
  const {f} = await fixture(); try {
    assert.equal((await f.req('/ec/brand-profile', {bank_iban: 'TR123'})).status, 400);
    assert.equal((await f.req('/ec/brand-profile', {email: 'gecersiz'})).status, 400);
    assert.equal((await f.req('/ec/brand-profile', {legal_name: 'Zorla'})).status, 400);
    assert.equal((await f.req('/ec/brand-profile', {uydurma: 'x'})).status, 400);
    // Bos birakilabilir: bilinmeyen bilgi UYDURULMAZ.
    const bos = await f.ok('/ec/brand-profile', {address: '', bank_iban: ''});
    assert.equal(bos.profile.address, '');
  } finally { f.close(); }
});

test('Para birimi TRY disinda olamaz', async () => {
  const {f, party} = await fixture(); try {
    const r = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({currency: 'EUR'})});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /TRY/);
  } finally { f.close(); }
});

test('200 satir siniri ve gecersiz tarih kontrollu islenir', async () => {
  const {f, party} = await fixture(); try {
    const cok = Array.from({length: 201}, () => paraliSatir());
    assert.equal((await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({lines: cok})})).status, 400);
    // 200 tam kabul edilir.
    const tam = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({lines: Array.from({length: 200}, () => paraliSatir())})});
    assert.equal(tam.line_count, 200);
    // Ters tarih.
    assert.equal((await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({valid_until: gun(-5)})})).status, 400);
    assert.equal((await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({issue_date: '2026-02-30'})})).status, 400);
  } finally { f.close(); }
});

test('Metin HTML olarak CALISTIRILMAZ: oldugu gibi saklanir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'antet',
      content: {title: 'Yazı', issue_date: BUGUN, notes: '<script>alert(1)</script>'}});
    // Sunucu metni degistirmez; kacirma arayuzun isidir ve esc() ile yapilir.
    assert.equal(doc.content.notes, '<script>alert(1)</script>');
  } finally { f.close(); }
});

// --- GOC GELMEZSE: modul kapali sayilir, panelin tamami 500 vermez ---
// 07.10.2026'da tam bu yasandi: yeni tablo okuyan kod yuzunden ana defter 500 dondu.

test('Tablo YOKSA modul kapali gorunur, 500 vermez', async () => {
  const {f, party} = await fixture(); try {
    f.sqlite.exec('DROP TABLE ec_brand_documents');
    const liste = await f.req('/ec/brand-documents');
    assert.equal(liste.status, 200, 'liste 500 verdi');
    assert.equal(liste.data.available, false);
    assert.match(liste.data.notice, /göçü|kurulmadı/);
    // Turler yine bildirilir: ekran ne oldugunu anlatabilsin.
    assert.equal(Object.keys(liste.data.types).length, 9);
    // Yazma denemesi ANLASILIR hata verir, patlamaz.
    const yazma = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    assert.equal(yazma.status, 409);
    assert.match(yazma.data.error, /göçü uygulanmalı|kurulmadı/);
  } finally { f.close(); }
});

test('Tablo YOKSA ana defter ve diger ekranlar CALISMAYA devam eder', async () => {
  const {f} = await fixture(); try {
    f.sqlite.exec('DROP TABLE ec_brand_documents');
    // 07.10 dersi: ana muhasebe payload'u ve diger uclar etkilenmemeli.
    const defter = await f.req('/ec');
    assert.equal(defter.status, 200, 'ana defter 500 verdi');
    assert.equal((await f.req('/ec/ledger')).status, 200);
    assert.equal((await f.req('/ec/offers')).status, 200);
    assert.equal((await f.req('/ec/settings')).status, 200);
    assert.equal((await f.req('/data')).status, 200);
    // Antet profili de ayakta: ayar tablosu duruyor.
    assert.equal((await f.req('/ec/brand-profile')).status, 200);
  } finally { f.close(); }
});

test('Antet sutunlari YOKSA profil kapali gorunur, 500 vermez', async () => {
  const {f} = await fixture(); try {
    // Sutunlar silinemez; ayar tablosunu dusurup ayni etkiyi olc.
    f.sqlite.exec('DROP TABLE workspace_settings');
    const r = await f.req('/ec/brand-profile');
    assert.equal(r.status, 200, 'antet profili 500 verdi');
    assert.equal(r.data.available, false);
    const yazma = await f.req('/ec/brand-profile', {address: 'x'});
    assert.equal(yazma.status, 409);
  } finally { f.close(); }
});

// --- Tutar yetkisi: para API, liste, icerik ve serbest metinden SIZMAZ ---

async function belgePersoneli(f, yetki) {
  const staff = await f.ok('/admin/users', {name: 'Evrak', username: 'evrak',
    permissions: {ec: {offers: 'read', ledger: 'read', brand_documents: yetki, amounts: 'none'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'evrak-personel-sifresi'});
  return (await f.req('/auth/login', {username: 'evrak', password: 'evrak-personel-sifresi'})).cookie;
}

test('Tutar yetkisi kapali personel kurumsal evrakta PARAYI gormez', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party,
      content: icerik({notes: 'Toplam 270,00 TL olarak onaylandı.', reference: 'Bedel 12.500,00 TL'})});
    const cookie = await belgePersoneli(f, 'read');

    const liste = await f.req('/ec/brand-documents', undefined, cookie);
    assert.equal(liste.status, 200);
    const listeGovde = JSON.stringify(liste.data);
    assert.equal(listeGovde.includes('270,00'), false, 'liste metninde tutar sizdi');
    assert.equal(listeGovde.includes('12.500,00'), false, 'liste referansinda tutar sizdi');

    const tek = await f.req('/ec/brand-documents/' + doc.id, undefined, cookie);
    assert.equal(tek.status, 200);
    const govde = JSON.stringify(tek.data);
    assert.equal(govde.includes('270,00'), false, 'not metninde tutar sizdi');
    assert.equal(govde.includes('12.500,00'), false, 'referansta tutar sizdi');
    assert.equal(tek.data.total_cents, null, 'toplam kurus sizdi');
    // Para olmayan bilgi GORUNMEYE devam eder: miktar ve sevk bilgisi gizlenmez.
    assert.equal(tek.data.content.title, 'Sipariş onayı');
    assert.equal(tek.data.content.prepared, 'Baran Kaya');
    assert.equal(tek.data.content.lines[0].quantity_milli, 2000);
    assert.equal(tek.data.content.lines[0].description, 'Terracotta saksı 30 cm');
  } finally { f.close(); }
});

test('NULL tutar SIFIR DEGILDIR', async () => {
  const {f, party} = await fixture(); try {
    // Parasiz turde toplam gercekten yok: null doner, 0 degil.
    const paket = await f.ok('/ec/brand-documents', {type: 'paket-listesi', party_id: party,
      content: icerik({title: 'Paket', lines: [sadeSatir()]})});
    assert.equal(paket.total_cents, null);
    assert.notEqual(paket.total_cents, 0);
    const cookie = await belgePersoneli(f, 'read');
    const tek = await f.req('/ec/brand-documents/' + paket.id, undefined, cookie);
    assert.equal(tek.data.total_cents, null);
  } finally { f.close(); }
});

test('Okuma yetkisi YAZMAYA gecit vermez', async () => {
  const {f, party} = await fixture(); try {
    const cookie = await belgePersoneli(f, 'read');
    const olustur = await f.req('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()}, cookie);
    assert.equal(olustur.status, 403);
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    assert.equal((await f.req('/ec/brand-documents/' + doc.id, {content: icerik()}, cookie)).status, 403);
    assert.equal((await f.req('/ec/brand-documents/' + doc.id + '/finalize', {}, cookie)).status, 403);
    assert.equal((await f.req('/ec/brand-documents/' + doc.id + '/archive', {}, cookie)).status, 403);
    assert.equal((await f.req('/ec/brand-profile', {address: 'x'}, cookie)).status, 403);
    // Okuma calisir.
    assert.equal((await f.req('/ec/brand-documents/' + doc.id, undefined, cookie)).status, 200);
  } finally { f.close(); }
});

test('Yetkisi olmayan personel ucu DOGRUDAN cagirinca 403 alir', async () => {
  const {f, party} = await fixture(); try {
    const staff = await f.ok('/admin/users', {name: 'Depo', username: 'depo',
      permissions: {ec: {stock: 'read'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'depo-personel-sifresi'});
    const cookie = (await f.req('/auth/login', {username: 'depo', password: 'depo-personel-sifresi'})).cookie;
    const doc = await f.ok('/ec/brand-documents', {type: 'siparis-onayi', party_id: party, content: icerik()});
    for (const [yol, govde] of [['/ec/brand-documents', undefined], ['/ec/brand-documents/' + doc.id, undefined],
      ['/ec/brand-documents/lookups/parties', undefined], ['/ec/brand-profile', undefined],
      ['/ec/brand-documents', {type: 'antet', content: {title: 'x', issue_date: BUGUN}}]]) {
      const r = await f.req(yol, govde, cookie);
      assert.equal(r.status, 403, yol + ' acik kaldi');
    }
  } finally { f.close(); }
});
