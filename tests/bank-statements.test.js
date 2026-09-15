// Banka ekstresi aktarımı. TEMSİLİ veri: gerçek banka dosyası DEĞİLDİR.
// Kanıtlanan: aynı dosya ve aynı hareket ikinci kez yazılmaz, ham satır değiştirilemez,
// aktarım mali kayıt oluşturmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {bankRecordKey} from '../src/bank-api.js';

const HASH = a => String(a).repeat(64).slice(0, 64);
const satir = (over = {}) => ({occurred_on: '2026-09-10', amount_cents: 251623, description: 'TRENDYOL ODEME',
  reference: 'DEK-1', counterparty: 'Trendyol', balance_cents: 1000000, ...over});

async function hesap(f) {
  const a = await f.ok('/ec/bank/accounts', {name: 'Ziraat TL', kind: 'bank'});
  const file = await f.ok('/ec/bank/files', {account_id: a.id, filename: 'ekstre-eylul.csv', sha256: HASH('a'), size_bytes: 4096});
  return {a, file};
}

test('Ekstre yüklenir; aynı dosya ve aynı hareket ikinci kez yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, file} = await hesap(f);
    assert.equal(file.duplicate, false);

    const ilk = await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: [satir(), satir({reference: 'DEK-2', amount_cents: -45000, description: 'KARGO ODEMESI'})]});
    assert.deepEqual([ilk.received, ilk.inserted, ilk.duplicate], [2, 2, 0]);

    // Aynı parti tekrar gönderilirse hiçbiri yazılmaz.
    const tekrar = await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: [satir(), satir({reference: 'DEK-2', amount_cents: -45000, description: 'KARGO ODEMESI'})]});
    assert.deepEqual([tekrar.received, tekrar.inserted, tekrar.duplicate], [2, 0, 2], 'aynı hareket ikinci kez yazılmadı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_bank_lines').get().n, 2);

    // Aynı dosya aynı hesaba ikinci kez yüklenemez.
    const ikinci = await f.ok('/ec/bank/files', {account_id: a.id, filename: 'baska-ad.csv', sha256: HASH('a'), size_bytes: 4096});
    assert.equal(ikinci.duplicate, true);
    assert.equal(ikinci.id, file.id);

    const kapat = await f.ok('/ec/bank/files/' + file.id + '/seal', {});
    assert.equal(kapat.row_count, 2);
    assert.equal(kapat.status, 'applied');
  } finally { f.close(); }
});

test('Dekont numarası yoksa kimlik tarih+tutar+açıklama+bakiyeden kurulur; uydurma sıra eklenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {file} = await hesap(f);
    // Aynı gün, aynı tutar, farklı bakiye → iki AYRI hareket.
    const r = await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: [
      satir({reference: '', balance_cents: 100000}),
      satir({reference: '', balance_cents: 351623})]});
    assert.equal(r.inserted, 2, 'bakiye farklı olduğu için iki ayrı hareket');

    // Tamamen aynı satır → tek kayıt kalır, ikinci yazılmaz.
    const ayni = await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: [satir({reference: '', balance_cents: 100000})]});
    assert.equal(ayni.inserted, 0);

    assert.equal(bankRecordKey({occurred_on: '2026-09-10', amount_cents: 100, reference: 'X-1'}), 'R:X-1',
      'dekont numarası varsa kimlik odur');
  } finally { f.close(); }
});

test('Aktarım stok, satış, fatura veya cari kaydı OLUŞTURMAZ; ham satır değiştirilemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const say = () => ['ec_stock_movements', 'ec_sale_entries', 'ec_purchase_invoices', 'ec_party_entries', 'ec_cash_transactions']
      .map(t => f.sqlite.prepare('SELECT COUNT(*) n FROM ' + t).get().n);
    const once = say();
    const {file} = await hesap(f);
    await f.ok('/ec/bank/files/' + file.id + '/lines', {lines: [satir()]});
    await f.ok('/ec/bank/files/' + file.id + '/seal', {});
    assert.deepEqual(say(), once, 'hiçbir mali tabloya kayıt düşmedi');

    // Tutar ve tarih ham veridir: değiştirilemez, silinemez.
    const id = f.sqlite.prepare('SELECT id FROM ec_bank_lines').get().id;
    assert.throws(() => f.sqlite.prepare('UPDATE ec_bank_lines SET amount_cents=1 WHERE id=?').run(id), /IMMUTABLE_BANK_LINE/);
    assert.throws(() => f.sqlite.prepare('DELETE FROM ec_bank_lines WHERE id=?').run(id), /IMMUTABLE_BANK_LINE/);
    // Eşleştirme alanı güncellenebilir: hangi hakedişe denk geldiği sonradan işaretlenir.
    f.sqlite.prepare("UPDATE ec_bank_lines SET matched_note='Trendyol hakedişi' WHERE id=?").run(id);
    assert.equal(f.sqlite.prepare('SELECT matched_note FROM ec_bank_lines WHERE id=?').get(id).matched_note, 'Trendyol hakedişi');
  } finally { f.close(); }
});

test('Sıfır tutarlı hareket ve geçersiz tarih reddedilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const {file} = await hesap(f);
    assert.equal((await f.req('/ec/bank/files/' + file.id + '/lines', {lines: [satir({amount_cents: 0})]})).status, 400);
    assert.equal((await f.req('/ec/bank/files/' + file.id + '/lines', {lines: [satir({occurred_on: '10.09.2026x'})]})).status, 400);
  } finally { f.close(); }
});
