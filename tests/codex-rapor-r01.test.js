// R01 — Eski ama değişmiş rapor, sınıflandırması ile yazması arasında gelen DAHA YENİ gözlemi ezmemeli.
// İki dosya aynı kaydı işler: ESKİ (içerik değişik, T1) ve YENİ (içerik güncel kayıtla aynı, T2>T1).
// Bariyer, seçilen dosyanın yazma partisini diğeri bitene kadar bekletir; iki sıra da denenir.
// TEMSİLİ veri: gerçek pazaryeri sütun adları DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';
import {scopedDB} from '../src/scoped-db.js';
import {reportInboxApi} from '../src/report-inbox-api.js';

const COLS = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Kargo'}];
const MAP = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo'};
const row = kargo => ['1001', 'P1', 'L1', 'NOVA-1', 'Nova', 1, 'Kargoda', '01.09.2026', '240,00', kargo];
const T0 = '2026-09-01T10:00', T1 = '2026-09-02T10:00', T2 = '2026-09-03T10:00';

async function kur() {
  const f = appFixture(); await f.setup();
  const s = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'})).id;
  await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLS.map(c => c.header), mapping: MAP, options: {}});
  async function yukle(rows, snapshot, name) {
    const bytes = new Uint8Array(xlsxBytes([{name: name.replace('.xlsx', ''), columns: COLS, rows}]));
    const t = await readTable(bytes, {name});
    const c = await f.ok('/ec/reports/files', {store_id: s, kind: 'orders', filename: name, size_bytes: bytes.length, sha256: await sha256Hex(bytes),
      snapshot_at: snapshot, sheet: t.sheet, headers: t.headers, date1904: t.date1904, row_count: t.rows.length, chunk_count: 1, warnings: t.warnings});
    await f.ok('/ec/reports/files/' + c.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + c.id + '/rows', {rows: t.rows});
    await f.ok('/ec/reports/files/' + c.id + '/seal', {});
    return c.id;
  }
  // İlk gözlem: kargo 50 TL (A), T0.
  const ilk = await yukle([row('50,00')], T0, 'ilk.xlsx');
  let r; do { r = await f.ok('/ec/reports/files/' + ilk + '/apply', {}); } while (!r.done);
  const eski = await yukle([row('55,00')], T1, 'eski.xlsx');   // içerik değişik (B), daha eski
  const yeni = await yukle([row('50,00')], T2, 'yeni.xlsx');   // içerik güncel kayıtla aynı (A), en yeni
  return {f, s, eski, yeni};
}

/** Seçilen dosyanın İLK yazma partisini bariyere kadar bekleten D1 sarmalayıcısı. */
function bariyerli(DB, fileId) {
  let birak, vardi; const kapi = new Promise(r => { birak = r; }), ulasti = new Promise(r => { vardi = r; });
  let bekledi = false;
  const db = {prepare: sql => DB.prepare(sql), async batch(items) {
    if (!bekledi && items.some(s => (s.args || []).includes(fileId))) { bekledi = true; vardi(); await kapi; }
    return DB.batch(items);
  }};
  return {db, birak, ulasti};
}
const uygula = async (DB, fileId) => {
  const env = {DB: scopedDB(DB, 'ec'), ROOT_DB: DB, WORKSPACE: 'ec', USER: {owner: true, id: 'test'}};
  let r, n = 0;
  do { const yol = '/api/reports/files/' + fileId + '/apply';
    r = await reportInboxApi(new Request('https://internal.invalid/api/ec' + yol.slice(4), {method: 'POST'}), env, yol, async () => ({})); }
  while (!r.done && ++n < 20);
  return r;
};
const kayit = f => {
  const r = f.sqlite.prepare("SELECT id,data_json,source_time,version FROM ec_report_records WHERE record_key='L:L1'").get();
  return {kargo: JSON.parse(r.data_json).cargo_package, source_time: r.source_time, version: r.version,
    surumler: f.sqlite.prepare('SELECT version,json_extract(data_json,\'$.cargo_package\') kargo,source_time FROM ec_report_record_versions WHERE record_id=? ORDER BY version').all(r.id).map(x => ({...x}))};
};

test('R01 sıra 1: eski dosya beklerken yeni gözlem yazılır; eski dosya en yeni gözlemi geri alamaz, sahte sürüm yok', async () => {
  const {f, eski, yeni} = await kur(); try {
    const b = bariyerli(f.env.DB, eski);
    const eskiIs = uygula(b.db, eski);
    await b.ulasti;                      // ESKİ sınıflandırıldı ("güncel"), yazma bekliyor
    await uygula(f.env.DB, yeni);         // YENİ: içerik aynı, gözlem zamanı T2'ye ilerler
    b.birak(); await eskiIs;
    const k = kayit(f);
    assert.equal(k.kargo, 5000, 'en yeni gözlemin içeriği (50 TL) korunur');
    assert.equal(k.source_time, T2, 'gözlem zamanı geri gitmez');
    assert.deepEqual(k.surumler.map(v => v.version), [1], 'kaybedilen yazma sürüm üretmez');
    assert.equal(k.version, 1);
    assert.equal(f.sqlite.prepare("SELECT outcome FROM ec_report_outcomes WHERE file_id=?").get(eski).outcome, 'older', 'eski dosya "eski" sayılır, "güncellendi" değil');
    // Üçüncü tekrar etkisizdir.
    await uygula(f.env.DB, eski); await uygula(f.env.DB, yeni);
    assert.deepEqual(kayit(f), k);
  } finally { f.close(); }
});

test('R01 sıra 2: yeni dosya beklerken eski değişiklik yazılır; yeni gözlem sonra gelir ve en yeni içerik kalır', async () => {
  const {f, eski, yeni} = await kur(); try {
    const b = bariyerli(f.env.DB, yeni);
    const yeniIs = uygula(b.db, yeni);
    await b.ulasti;                      // YENİ "aynı, gözlem ilerlet" diye sınıflandı, yazma bekliyor
    await uygula(f.env.DB, eski);         // ESKİ: 55 TL, T1 (o an için gerçekten daha yeni)
    b.birak(); await yeniIs;
    const k = kayit(f);
    assert.equal(k.kargo, 5000, 'T2 gözlemi 50 TL diyor; eski içerik T2 zamanıyla damgalanamaz');
    assert.equal(k.source_time, T2);
    assert.deepEqual(k.surumler.map(v => [v.version, v.kargo, v.source_time]), [[1, 5000, T0], [2, 5500, T1], [3, 5000, T2]], 'geçmiş gerçek sırayla');
    await uygula(f.env.DB, eski); await uygula(f.env.DB, yeni);
    assert.deepEqual(kayit(f), k, 'tekrar etkisiz');
  } finally { f.close(); }
});
