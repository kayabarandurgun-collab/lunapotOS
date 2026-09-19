// R24 — Otomatik bakım: sürekli hata veren ilk 10 dosya sağlıklı 11. dosyayı sonsuza dek engellememeli.
// Hatalı dosyalar silinmez, "işlendi" sayılmaz; deneme sayısı, sonraki deneme zamanı ve sebep görünür kalır.
// TEMSİLİ veri: gerçek pazaryeri sütun adları DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';
import {otomatikBakim} from '../src/otomatik-bakim.js';

const COLS = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}];
const MAP = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar'};
const T = Date.parse('2026-09-19T12:00:00Z'), DK = 60000;

async function kur() {
  const f = appFixture(); await f.setup();
  const s = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'})).id;
  // On bozuk dosya: onaylı eşleştirmesi yok, her denemede 409 verir. Hepsi sağlıklı dosyadan ESKİ.
  for (let i = 0; i < 10; i++) f.sqlite.prepare(`INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status,created_at)
    VALUES(?,?,'orders',?,100,?,'2026-09-01T10:00','[]',0,1,'received',?)`).run('bozuk-' + i, s, 'bozuk-' + i + '.xlsx', String(i).repeat(64).slice(0, 64), '2026-09-01 10:00:0' + i);
  await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLS.map(c => c.header), mapping: MAP, options: {}});
  const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: COLS, rows: [['1001', 'P1', 'L1', 'NOVA-1', 'Nova', 1, 'Kargoda', '01.09.2026', '240,00']]}]));
  const t = await readTable(bytes, {name: 'saglam.xlsx'});
  const c = await f.ok('/ec/reports/files', {store_id: s, kind: 'orders', filename: 'saglam.xlsx', size_bytes: bytes.length, sha256: await sha256Hex(bytes),
    snapshot_at: '2026-09-01T11:00', sheet: t.sheet, headers: t.headers, date1904: t.date1904, row_count: t.rows.length, chunk_count: 1, warnings: t.warnings});
  await f.ok('/ec/reports/files/' + c.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
  await f.ok('/ec/reports/files/' + c.id + '/rows', {rows: t.rows});
  await f.ok('/ec/reports/files/' + c.id + '/seal', {});
  f.sqlite.prepare("UPDATE ec_report_files SET created_at='2026-09-01 11:00:00' WHERE id=?").run(c.id);
  return {f, s, saglam: c.id};
}
const durum = (f, id) => f.sqlite.prepare('SELECT status FROM ec_report_files WHERE id=?').get(id).status;

test('R24: ilk 10 dosya sürekli hata verirken sağlıklı 11. dosya sınırlı turda işlenir; hatalılar görünür ve yeniden denenebilir kalır', async () => {
  const {f, saglam} = await kur(); try {
    let tur = 0;
    for (; tur < 3 && durum(f, saglam) !== 'applied'; tur++) await otomatikBakim(f.env, {simdi: T + tur * 15 * DK});
    assert.equal(durum(f, saglam), 'applied', 'sağlıklı dosya ' + tur + ' turda işlenmedi');
    assert.ok(tur <= 2, 'en çok iki turda: ' + tur);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE record_key='L:L1'").get().n, 1);

    // Hatalı dosyalar silinmedi, işlendi sayılmadı; deneme bilgisi ve sebep ekranda.
    const {files} = await f.ok('/ec/reports');
    const bozuk = files.filter(x => x.id.startsWith('bozuk-'));
    assert.equal(bozuk.length, 10);
    for (const b of bozuk) {
      assert.notEqual(b.status, 'applied');
      assert.ok(b.attempts >= 1, 'deneme sayısı görünür: ' + JSON.stringify(b));
      assert.ok(b.next_attempt_at, 'sonraki deneme zamanı görünür');
      assert.match(b.last_error || '', /eşleştirme/, 'sebep görünür');
    }

    // Yeniden denenebilir: sorun giderilince (eşleştirme bağlandı) sonraki uygun turda işlenir.
    const profil = f.sqlite.prepare('SELECT id FROM ec_report_profiles LIMIT 1').get().id;
    f.sqlite.prepare(`UPDATE ec_report_files SET profile_id=?,twin_keys_json='{"twins":[],"duplicates":{}}' WHERE id='bozuk-3'`).run(profil);
    await otomatikBakim(f.env, {simdi: T + 3 * 24 * 60 * DK});
    assert.equal(durum(f, 'bozuk-3'), 'applied');
    assert.equal(durum(f, 'bozuk-4'), 'received', 'hâlâ hatalı olan olduğu gibi durur');
  } finally { f.close(); }
});
