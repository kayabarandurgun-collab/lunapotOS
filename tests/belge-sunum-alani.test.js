import test from 'node:test';import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

// Belge Atolyesi teklif/proformayi MEVCUT offers kaydina baglar. Ikinci kayit havuzu YOK.
// Atolyenin sunum verisi (sablon, logo, antet, hazirlayan) `presentation` altinda,
// WHITELIST ile ve boyut sinirli olarak ayni snapshot icinde saklanir.

const gun = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const BUGUN = gun(0), OTUZ = gun(30);

const line = (extra = {}) => ({description: 'Terracotta saksı 30 cm', unit: 'adet', quantity_milli: 2000, unit_price_cents: 12500, discount_bps: 1000, vat_bps: 2000, ...extra});
const quote = (party, extra = {}) => ({
  kind: 'quote', party_id: party, title: 'Bahar sezonu saksı teklifi',
  issue_date: BUGUN, valid_until: OTUZ, terms: 'Teslim 15 iş günü.',
  lines: [line()], ...extra
});

const sunum = (extra = {}) => ({
  schema_version: 1, template_id: 'lunapot-business-v2', template_version: 1,
  logo_variant_id: 'lunapot-yatay-antrasit',
  company_snapshot: {name: 'Lunapot', address: 'Örnek mah. 1', contact: '0212 000 00 00', tax: 'Şişli / 1234567890', bank: 'Örnek Bank TR00'},
  recipient_snapshot: {name: 'Şişli Çiçekçilik', address: 'Teşvikiye 2', tax: 'Şişli / 9876543210'},
  reference: 'TEK-2026-0042', prepared: 'Baran Kaya', approved: 'Yönetim',
  example: false, line_metadata: [{index: 0, sku: 'SKU-01'}], brand_version: 'v8', ...extra
});

async function fixture() {
  const f = appFixture(); await f.setup();
  const party = await f.ok('/ec/ledger/parties', {name: 'Şişli Çiçekçilik Ltd. Şti.', kind: 'customer', tax_id: '9876543210'});
  return {f, party: party.id};
}

test('Sunum verisi kaydedilir ve aynı kimlikle geri okunur', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum()}));
    assert.equal(doc.snapshot.presentation.template_id, 'lunapot-business-v2');
    assert.equal(doc.snapshot.presentation.logo_variant_id, 'lunapot-yatay-antrasit');
    assert.equal(doc.snapshot.presentation.reference, 'TEK-2026-0042');
    assert.equal(doc.snapshot.presentation.company_snapshot.name, 'Lunapot');
    assert.deepEqual(doc.snapshot.presentation.line_metadata, [{index: 0, sku: 'SKU-01'}]);
    // Ikinci kayit havuzu YOK: ayni offers kaydi.
    const yeniden = await f.ok('/ec/offers/' + doc.id);
    assert.equal(yeniden.snapshot.presentation.prepared, 'Baran Kaya');
    assert.equal(yeniden.document_no, doc.document_no);
  } finally { f.close(); }
});

test('Sunum GONDERILMEDIGINDE mevcut veri SILINMEZ', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum()}));
    // Eski istemci presentation bilmiyor: yalnizca icerik gonderir.
    const guncel = await f.ok('/ec/offers/' + doc.id, quote(party, {title: 'Güncellenmiş başlık'}));
    assert.equal(guncel.snapshot.title, 'Güncellenmiş başlık');
    assert.equal(guncel.snapshot.presentation.reference, 'TEK-2026-0042', 'sunum verisi silinmis');
    assert.equal(guncel.snapshot.presentation.prepared, 'Baran Kaya');
  } finally { f.close(); }
});

test('Sunum acikca null gonderilince temizlenir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum()}));
    const guncel = await f.ok('/ec/offers/' + doc.id, quote(party, {presentation: null}));
    assert.equal(guncel.snapshot.presentation, null);
  } finally { f.close(); }
});

test('Sunumu olmayan ESKI kayit sorunsuz acilir', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party));
    assert.equal(doc.snapshot.presentation, null);
    const yeniden = await f.ok('/ec/offers/' + doc.id);
    assert.equal(yeniden.snapshot.presentation, null);
    // Sonradan sunum eklenebilir.
    const guncel = await f.ok('/ec/offers/' + doc.id, quote(party, {presentation: sunum()}));
    assert.equal(guncel.snapshot.presentation.brand_version, 'v8');
  } finally { f.close(); }
});

test('Uydurma logo kimligi REDDEDILIR', async () => {
  const {f, party} = await fixture(); try {
    const r = await f.req('/ec/offers', quote(party, {presentation: sunum({logo_variant_id: 'lunapot-uydurma-renk'})}));
    assert.equal(r.status, 400);
    assert.match(r.data.error, /[Ll]ogo/);
  } finally { f.close(); }
});

test('Bilinmeyen sunum alani REDDEDILIR; serbest SVG/HTML saklanmaz', async () => {
  const {f, party} = await fixture(); try {
    for (const kotu of [{svg: '<svg onload=alert(1)>'}, {script: 'x'}, {company_logo_svg: '<svg/>'},
                        {template_html: '<b>x</b>'}, {logo_svg: 'currentColor'}]) {
      const r = await f.req('/ec/offers', quote(party, {presentation: sunum(kotu)}));
      assert.equal(r.status, 400, JSON.stringify(kotu) + ' kabul edildi');
    }
  } finally { f.close(); }
});

test('Govdedeki __proto__ anahtari prototipi KIRLETMEZ', async () => {
  const {f, party} = await fixture(); try {
    // Nesne literalinde __proto__ prototipi degistirir; govdeye GERCEKTEN yazilmasi
    // icin kendi numarali alan olarak tanimlanir. Sunucu JSON.parse ettiginde
    // bu KENDI anahtari olur ve whitelist tarafindan reddedilmelidir.
    const kirli = sunum();
    Object.defineProperty(kirli, '__proto__', {value: {zararli: true}, enumerable: true, writable: true, configurable: true});
    assert.ok(JSON.stringify(kirli).includes('__proto__'), 'test govdesi __proto__ tasimiyor');
    const r = await f.req('/ec/offers', quote(party, {presentation: kirli}));
    assert.equal(r.status, 400, '__proto__ anahtari kabul edildi');
    assert.equal({}.zararli, undefined, 'prototip kirlendi');
  } finally { f.close(); }
});

test('Sunum boyutu sinirlidir', async () => {
  const {f, party} = await fixture(); try {
    const r = await f.req('/ec/offers', quote(party, {presentation: sunum({reference: 'x'.repeat(5000)})}));
    assert.equal(r.status, 400);
    const r2 = await f.req('/ec/offers', quote(party, {
      presentation: sunum({company_snapshot: {name: 'y'.repeat(9000), address: '', contact: '', tax: '', bank: ''}})
    }));
    assert.equal(r2.status, 400);
  } finally { f.close(); }
});

test('line_metadata satir sayisini asamaz ve indeks gecerli olmali', async () => {
  const {f, party} = await fixture(); try {
    // Tek satirli belgede 5. satirin SKU su olamaz.
    const r = await f.req('/ec/offers', quote(party, {presentation: sunum({line_metadata: [{index: 5, sku: 'SKU-X'}]})}));
    assert.equal(r.status, 400);
    const r2 = await f.req('/ec/offers', quote(party, {
      presentation: sunum({line_metadata: Array.from({length: 250}, (_, i) => ({index: 0, sku: 'S' + i}))})
    }));
    assert.equal(r2.status, 400);
  } finally { f.close(); }
});

test('Gonderilmis belgenin sunumu DONAR', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum()}));
    await f.ok('/ec/offers/' + doc.id + '/status', {status: 'sent'});
    const r = await f.req('/ec/offers/' + doc.id, quote(party, {presentation: sunum({reference: 'DEGISTI'})}));
    assert.equal(r.status, 409);
    const yeniden = await f.ok('/ec/offers/' + doc.id);
    assert.equal(yeniden.snapshot.presentation.reference, 'TEK-2026-0042');
  } finally { f.close(); }
});

test('Revizyon kendi sunumunu tasir; onceki belge degismez', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum()}));
    const rev = await f.ok('/ec/offers', quote(party, {supersedes: doc.id, presentation: sunum({reference: 'REV-2'})}));
    assert.equal(rev.revision, 2);
    assert.equal(rev.snapshot.presentation.reference, 'REV-2');
    const ilk = await f.ok('/ec/offers/' + doc.id);
    assert.equal(ilk.snapshot.presentation.reference, 'TEK-2026-0042', 'onceki revizyonun sunumu degismis');
  } finally { f.close(); }
});

test('Tutar yetkisi kapali personel sunum METNINDEKI parayi da GORMEZ', async () => {
  const {f, party} = await fixture(); try {
    await f.ok('/ec/offers', quote(party, {presentation: sunum({
      reference: 'Anlaşma bedeli 12.500,00 TL olarak teyit edildi',
      prepared: 'Baran Kaya',
      company_snapshot: {name: 'Lunapot', address: 'Ciro 1.250.000,00 TL', contact: '', tax: '', bank: ''}
    })}));
    const staff = await f.ok('/admin/users', {name: 'Belge', username: 'belge',
      permissions: {ec: {offers: 'read', ledger: 'read', brand_documents: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'belge-personel-sifresi'});
    const login = await f.req('/auth/login', {username: 'belge', password: 'belge-personel-sifresi'});
    const liste = await f.req('/ec/offers', undefined, login.cookie);
    assert.equal(liste.status, 200);
    const govde = JSON.stringify(liste.data);
    assert.equal(govde.includes('12.500,00'), false, 'sunum metnindeki tutar sizdi');
    assert.equal(govde.includes('1.250.000,00'), false, 'firma metnindeki tutar sizdi');

    const id = (await f.ok('/ec/offers')).offers[0].id;
    const tek = await f.req('/ec/offers/' + id, undefined, login.cookie);
    assert.equal(tek.status, 200);
    const tekGovde = JSON.stringify(tek.data);
    assert.equal(tekGovde.includes('12.500,00'), false, 'belge sunumundaki tutar sizdi');
    assert.equal(tekGovde.includes('1.250.000,00'), false, 'firma anlik goruntusundeki tutar sizdi');
    // Para olmayan sunum bilgisi GORUNMEYE devam eder: miktar ve sevk bilgisi gizlenmez.
    assert.equal(tek.data.snapshot.presentation.prepared, 'Baran Kaya');
    assert.equal(tek.data.snapshot.presentation.logo_variant_id, 'lunapot-yatay-antrasit');
  } finally { f.close(); }
});

test('Gecerlilik tarihi atolyeden bos gelirse ANLASILIR hata doner', async () => {
  const {f, party} = await fixture(); try {
    const eksik = quote(party, {presentation: sunum()});
    delete eksik.valid_until;
    const r = await f.req('/ec/offers', eksik);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /[Gg]eçerlilik/);
    const bos = await f.req('/ec/offers', quote(party, {valid_until: '', presentation: sunum()}));
    assert.equal(bos.status, 400);
    assert.match(bos.data.error, /[Gg]eçerlilik/);
  } finally { f.close(); }
});

test('Matematik sozlesmesi sunum eklenince DEGISMEZ', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {
      presentation: sunum(),
      lines: [line(), line({description: 'Toprak 20 L', unit: 'çuval', quantity_milli: 1000, unit_price_cents: 8000, discount_bps: 0, vat_bps: 1000})]
    }));
    // 2x125TL %10 isk %20 KDV -> 27000 ; 1x80TL %0 isk %10 KDV -> 8800 ; toplam 35800 kurus
    assert.equal(doc.gross_cents, 25000 + 8000);
    assert.equal(doc.discount_cents, 2500);
    assert.equal(doc.net_cents, 22500 + 8000);
    assert.equal(doc.vat_cents, 4500 + 800);
    assert.equal(doc.total_cents, 35800);
    assert.equal(doc.snapshot.currency, 'TRY');
  } finally { f.close(); }
});

test('Sunum TRY disinda para birimi kaydetmeye yol acmaz', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {presentation: sunum(), currency: 'EUR'}));
    // Mevcut offers yalniz TRY: istemcinin gonderdigi para birimi ESAS ALINMAZ.
    assert.equal(doc.snapshot.currency, 'TRY');
  } finally { f.close(); }
});
