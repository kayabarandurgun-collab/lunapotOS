import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const gun = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const BUGUN = gun(0), OTUZ_GUN = gun(30), YIL = BUGUN.slice(0, 4);

const line = (extra = {}) => ({description: 'Terracotta saksı 30 cm', unit: 'adet', quantity_milli: 40000, unit_price_cents: 12550, vat_bps: 2000, ...extra});

const quote = (party, extra = {}) => ({
  kind: 'quote', party_id: party, title: 'Bahar sezonu saksı teklifi',
  issue_date: BUGUN, valid_until: OTUZ_GUN,
  terms: 'Teslim: 15 iş günü. Fiyatlar fabrika teslimdir.',
  lines: [line(), line({description: 'Toprak 20 L', unit: 'çuval', quantity_milli: 100000, unit_price_cents: 8900, vat_bps: 1000})],
  ...extra
});

async function fixture() {
  const f = appFixture(); await f.setup();
  const party = await f.ok('/ec/ledger/parties', {name: 'Şişli Çiçekçilik Ltd. Şti.', kind: 'customer', tax_id: '1234567890'});
  return {f, party: party.id};
}

test('Teklif numaralanır, satırları ve toplamları dondurulur', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party));
    assert.equal(doc.document_no, 'TKF-'+YIL+'-0001');
    assert.equal(doc.revision, 1);
    assert.equal(doc.status, 'draft');
    assert.equal(doc.line_count, 2);
    // 40 × 125,50 = 5.020,00 net + %20 KDV; 100 × 89,00 = 8.900,00 net + %10 KDV
    assert.equal(doc.net_cents, 502000 + 890000);
    assert.equal(doc.vat_cents, 100400 + 89000);
    assert.equal(doc.total_cents, 1581400);
    assert.equal(doc.snapshot.party.name, 'Şişli Çiçekçilik Ltd. Şti.', 'karşı taraf bilgisi dondurulmalı');
    assert.equal(doc.snapshot.totals.rows[0].total_cents, 602400);
    assert.match(doc.snapshot.notice, /kabul ya da imza anlamına gelmez/);

    const proforma = await f.ok('/ec/offers', {...quote(party), kind: 'proforma'});
    assert.equal(proforma.document_no, 'PRF-'+YIL+'-0001', 'her tür kendi numara dizisini kullanır');
  } finally { f.close(); }
});

test('Her uç aynı belge şeklini döndürür', async () => {
  // Durum değişikliği zincir alanlarını eksik döndürüyordu; ekran onları okurken patlıyordu.
  const {f, party} = await fixture(); try {
    const alanlar = ['id', 'kind', 'document_no', 'revision', 'status', 'effective_status', 'snapshot',
      'party', 'superseded_by', 'derived', 'origin', 'next_kind', 'workspace'];
    const olustur = await f.ok('/ec/offers', quote(party));
    const oku = await f.ok('/ec/offers/' + olustur.id);
    const duzenle = await f.ok('/ec/offers/' + olustur.id, quote(party, {title: 'Düzeltilmiş'}));
    const durum = await f.ok(`/ec/offers/${olustur.id}/status`, {status: 'sent'});
    for (const [ad, yanit] of Object.entries({olustur, oku, duzenle, durum}))
      for (const alan of alanlar)
        assert.ok(Object.hasOwn(yanit, alan), `${ad} yanıtında ${alan} alanı eksik`);
    assert.ok(Array.isArray(durum.derived), 'durum ucu da zincir listesini vermeli');
  } finally { f.close(); }
});

test('Belge stoğa, cari defterine ve faturaya dokunmaz', async () => {
  const {f, party} = await fixture(); try {
    const before = {
      hareket: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_stock_movements').get().c,
      cari: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_party_entries').get().c,
      fatura: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_purchase_invoices').get().c,
      satis: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_sale_entries').get().c
    };
    const doc = await f.ok('/ec/offers', quote(party));
    await f.ok(`/ec/offers/${doc.id}/status`, {status: 'sent'});
    await f.ok(`/ec/offers/${doc.id}/status`, {status: 'accepted'});
    await f.ok(`/ec/offers/${doc.id}/convert`, {});
    const after = {
      hareket: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_stock_movements').get().c,
      cari: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_party_entries').get().c,
      fatura: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_purchase_invoices').get().c,
      satis: f.sqlite.prepare('SELECT COUNT(*) c FROM ec_sale_entries').get().c
    };
    assert.deepEqual(after, before, 'teklif kabul edilse bile stok, cari, fatura ve satış kaydı oluşmamalı');
  } finally { f.close(); }
});

test('Taslak düzenlenir; iletildikten sonra içerik donar', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party));
    const edited = await f.ok(`/ec/offers/${doc.id}`, quote(party, {title: 'Bahar sezonu · düzeltilmiş', lines: [line({unit_price_cents: 11900})]}));
    assert.equal(edited.title, 'Bahar sezonu · düzeltilmiş');
    assert.equal(edited.line_count, 1);
    assert.equal(edited.document_no, 'TKF-'+YIL+'-0001', 'taslak düzenlemesi yeni numara almaz');

    await f.ok(`/ec/offers/${doc.id}/status`, {status: 'sent'});
    const late = await f.req(`/ec/offers/${doc.id}`, quote(party, {title: 'Sonradan değiştirilen'}));
    assert.equal(late.status, 409, 'iletilmiş belge değiştirilemez');
    assert.throws(() => f.sqlite.exec(`UPDATE ec_offers SET total_cents=1 WHERE id='${doc.id}'`), /OFFER_SENT_IMMUTABLE/);
    assert.throws(() => f.sqlite.exec(`DELETE FROM ec_offers WHERE id='${doc.id}'`), /IMMUTABLE_LEDGER/);

    const revision = await f.ok('/ec/offers', quote(party, {supersedes: doc.id, title: 'Bahar sezonu · 2. sürüm'}));
    assert.equal(revision.document_no, 'TKF-'+YIL+'-0001');
    assert.equal(revision.revision, 2);
    const old = await f.ok('/ec/offers/' + doc.id);
    assert.equal(old.superseded_by.revision, 2);
    assert.equal(old.title, 'Bahar sezonu · düzeltilmiş', 'eski sürüm olduğu gibi kalır');
  } finally { f.close(); }
});

test('İndirmek kabul değildir: kabul yalnızca iletilmiş belgede olur', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party));
    const early = await f.req(`/ec/offers/${doc.id}/status`, {status: 'accepted'});
    assert.equal(early.status, 409);
    assert.match(early.data.error, /İndirmek kabul anlamına gelmez/);
    assert.throws(() => f.sqlite.exec(`UPDATE ec_offers SET status='accepted' WHERE id='${doc.id}'`), /OFFER_NOT_SENT/);

    const noReason = await f.req(`/ec/offers/${doc.id}/status`, {status: 'cancelled'});
    assert.equal(noReason.status, 400, 'gerekçesiz iptal edilemez');

    await f.ok(`/ec/offers/${doc.id}/status`, {status: 'sent'});
    const accepted = await f.ok(`/ec/offers/${doc.id}/status`, {status: 'accepted', note: 'Sözlü onay alındı.'});
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.sent_at && accepted.decided_at);
    const again = await f.req(`/ec/offers/${doc.id}/status`, {status: 'rejected', note: 'fikir değişti'});
    assert.equal(again.status, 409, 'kapanmış belge yeniden açılamaz');
  } finally { f.close(); }
});

test('Süresi dolmuş teklif kabul edilemez ve listede süresi dolmuş görünür', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party, {issue_date: '2020-01-02', valid_until: '2020-01-31'}));
    await f.ok(`/ec/offers/${doc.id}/status`, {status: 'sent'});
    const late = await f.req(`/ec/offers/${doc.id}/status`, {status: 'accepted'});
    assert.equal(late.status, 409);
    assert.match(late.data.error, /geçerlilik süresi dolmuş/);
    const list = await f.ok('/ec/offers');
    assert.equal(list.offers[0].status, 'sent', 'saklanan durum değişmez');
    assert.equal(list.offers[0].effective_status, 'expired', 'süre dolması tarihten okunur');
  } finally { f.close(); }
});

test('Teklif proformaya, proforma sözleşmeye dönüşür; aynı iş iki kez belgelenemez', async () => {
  const {f, party} = await fixture(); try {
    const teklif = await f.ok('/ec/offers', quote(party));
    await f.ok(`/ec/offers/${teklif.id}/status`, {status: 'sent'});
    await f.ok(`/ec/offers/${teklif.id}/status`, {status: 'accepted'});

    const proforma = await f.ok(`/ec/offers/${teklif.id}/convert`, {issue_date: BUGUN, valid_until: OTUZ_GUN});
    assert.equal(proforma.kind, 'proforma');
    assert.equal(proforma.document_no, 'PRF-'+YIL+'-0001');
    assert.equal(proforma.source_offer_id, teklif.id);
    assert.equal(proforma.total_cents, teklif.total_cents, 'satırlar yeniden yazılmadan taşınır');
    assert.equal(proforma.snapshot.totals.rows.length, 2);

    const varsayilan = await f.ok('/ec/offers', {...quote(party), title: 'İkinci teklif'});
    await f.ok(`/ec/offers/${varsayilan.id}/status`, {status: 'sent'});
    await f.ok(`/ec/offers/${varsayilan.id}/status`, {status: 'accepted'});
    const varsayilanProforma = await f.ok(`/ec/offers/${varsayilan.id}/convert`, {});
    assert.notEqual(varsayilanProforma.valid_until, varsayilanProforma.issue_date, 'aynı gün biten proforma üretilmemeli');
    assert.equal(varsayilanProforma.valid_until, gun(30));

    const ikinci = await f.req(`/ec/offers/${teklif.id}/convert`, {});
    assert.equal(ikinci.status, 409, 'aynı tekliften ikinci proforma çıkmaz');

    await f.ok(`/ec/offers/${proforma.id}/status`, {status: 'sent'});
    await f.ok(`/ec/offers/${proforma.id}/status`, {status: 'accepted'});
    const sozlesme = await f.ok(`/ec/offers/${proforma.id}/convert`, {issue_date: BUGUN});
    assert.equal(sozlesme.kind, 'contract');
    assert.equal(sozlesme.valid_until, null, 'sözleşmenin geçerlilik günü olmaz');
    assert.equal((await f.req(`/ec/offers/${sozlesme.id}/convert`, {})).status, 400, 'sözleşmeden yeni belge türetilmez');

    const zincir = await f.ok('/ec/offers/' + proforma.id);
    assert.equal(zincir.origin.document_no, 'TKF-'+YIL+'-0001');
    assert.equal(zincir.derived[0].document_no, 'SZL-'+YIL+'-0001');
  } finally { f.close(); }
});

test('Kabul edilmemiş belgeden sonraki belge üretilemez', async () => {
  const {f, party} = await fixture(); try {
    const teklif = await f.ok('/ec/offers', quote(party));
    assert.equal((await f.req(`/ec/offers/${teklif.id}/convert`, {})).status, 409);
    await f.ok(`/ec/offers/${teklif.id}/status`, {status: 'sent'});
    assert.equal((await f.req(`/ec/offers/${teklif.id}/convert`, {})).status, 409, 'yanıt beklerken sonraki belge çıkmaz');
    // Veritabanı da kabul edilmemiş kaynağı reddeder.
    assert.throws(() => f.sqlite.exec(
      `INSERT INTO ec_offers(id,kind,party_id,document_no,revision,source_offer_id,title,issue_date,valid_until,gross_cents,discount_cents,net_cents,vat_cents,total_cents,line_count,snapshot_json,created_by_name)
       VALUES('x','proforma','${teklif.party_id}','PRF-2026-9999',1,'${teklif.id}','x','2026-03-02','2026-03-31',0,0,0,0,0,1,'{}','t')`
    ), /OFFER_CHAIN/);
  } finally { f.close(); }
});

test('Belge girdileri doğrulanır', async () => {
  const {f, party} = await fixture(); try {
    assert.equal((await f.req('/ec/offers', quote(party, {kind: 'fatura'}))).status, 400);
    assert.equal((await f.req('/ec/offers', quote(party, {lines: []}))).status, 400);
    assert.equal((await f.req('/ec/offers', quote(party, {valid_until: '2026-03-01'}))).status, 400, 'geçerlilik belge tarihinden önce olamaz');
    assert.equal((await f.req('/ec/offers', quote(party, {title: ''}))).status, 400);
    assert.equal((await f.req('/ec/offers', quote(party, {lines: [line({unit_price_cents: -5})]}))).status, 400);
    assert.equal((await f.req('/ec/offers', {...quote(party), kind: 'contract'})).status, 400, 'sözleşmede geçerlilik günü olmaz');
    assert.equal((await f.req('/ec/offers', quote('yok'))).status, 404);
    const sozlesme = await f.ok('/ec/offers', {...quote(party), kind: 'contract', valid_until: undefined});
    assert.equal(sozlesme.valid_until, null);
  } finally { f.close(); }
});

test('Belgeler çalışma alanına, modül yetkisine ve tutar yetkisine uyar', async () => {
  const {f, party} = await fixture(); try {
    const doc = await f.ok('/ec/offers', quote(party));
    assert.equal((await f.req('/lp/offers/' + doc.id)).status, 404, 'ec belgesi lp alanında görünmemeli');

    const depo = await f.ok('/admin/users', {name: 'Depo', username: 'depo', permissions: {ec: {stock: 'read'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: depo.invite_path.split('invite=')[1], password: 'depo-personel-sifresi'});
    const depoLogin = await f.req('/auth/login', {username: 'depo', password: 'depo-personel-sifresi'});
    assert.equal((await f.req('/ec/offers', undefined, depoLogin.cookie)).status, 403, 'teklif yetkisi olmayan listeyi görememeli');

    const satis = await f.ok('/admin/users', {name: 'Satış', username: 'satis', permissions: {ec: {offers: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: satis.invite_path.split('invite=')[1], password: 'satis-personel-sifresi'});
    const satisLogin = await f.req('/auth/login', {username: 'satis', password: 'satis-personel-sifresi'});
    const read = await f.req('/ec/offers/' + doc.id, undefined, satisLogin.cookie);
    assert.equal(read.status, 200);
    assert.equal(read.data.total_cents, null, 'tutar yetkisi kapalıysa toplam gizlenir');
    assert.equal(read.data.snapshot.totals.rows[0].unit_price_cents, null, 'saklanan görüntüdeki birim fiyat da gizlenir');
    assert.equal(read.data.snapshot.totals.rows[0].quantity_milli, 40000, 'miktar görünmeye devam eder');
    assert.equal(read.data.snapshot_json, undefined, 'ham JSON metni yanıtta bulunmamalı');
    assert.equal((await f.req('/ec/offers', quote(party), satisLogin.cookie)).status, 403, 'yalnızca görüntüleme yetkisi belge oluşturamaz');
  } finally { f.close(); }
});
