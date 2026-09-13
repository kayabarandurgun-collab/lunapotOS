// Hepsiburada finans dökümünde işlem tarihi sütunu YOKTUR ve komisyon hücresi tutarı, oranı ve
// ham metni tek hücrede verir. İkisi de veri uydurmadan saklanmalı:
//   - tarih tahmin edilmez, event_date boş kalır (dosya adındaki aralık tarih sayılmaz),
//   - oran tutarın parçası değildir; ayrı alanda durur ve ikinci kez gider olarak toplanmaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

// Gerçek HB finans dökümünün sütun düzeni: tarih sütunu yok, komisyon oranla birlikte geliyor.
const COLUMNS = ['Sipariş no', 'Sipariş durumu', 'Sipariş tutarı, TL', 'Komisyon (KDV dahil)', 'Net tutar, TL']
  .map(header => ({header}));
const MAPPING = {order_no: 'Sipariş no', sale: 'Sipariş tutarı, TL', commission: 'Komisyon (KDV dahil)',
  net_payout: 'Net tutar, TL'};

async function profile(f, options) {
  return f.req('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'finance',
    headers: COLUMNS.map(c => c.header), mapping: MAPPING, options});
}

async function upload(f, store, rows, name) {
  const bytes = new Uint8Array(xlsxBytes([{name: 'Finans', columns: COLUMNS, rows}]));
  const table = await readTable(bytes, {name});
  const file = await f.ok('/ec/reports/files', {store_id: store, kind: 'finance', filename: name,
    size_bytes: bytes.length, sha256: await sha256Hex(bytes), snapshot_at: '2026-09-12T18:00',
    sheet: table.sheet, headers: table.headers, date1904: table.date1904,
    row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
  await f.ok('/ec/reports/files/' + file.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
  await f.ok('/ec/reports/files/' + file.id + '/rows', {rows: table.rows});
  await f.ok('/ec/reports/files/' + file.id + '/seal', {});
  let r; do { r = await f.ok('/ec/reports/files/' + file.id + '/apply', {}); } while (!r.done);
  return r;
}

const row = ['4500957854', 'Teslim edilecek', '277.0', '-54.12 TL (%19.54)', '222.88'];

test('Tarihsiz finans tarih uydurmadan saklanır; komisyon oranı tutardan ayrı durur', async () => {
  const f = appFixture(); await f.setup(); try {
    const store = (await f.ok('/ec/reports/stores', {provider: 'hepsiburada', code: 'HB-1', name: 'Sentetik HB'})).id;
    await f.ok('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'finance',
      headers: COLUMNS.map(c => c.header), mapping: MAPPING, options: {undated: true}});

    const applied = await upload(f, store, [row], 'hb-finans.xlsx');
    // Bir satır, eşlenen her para sütunu için AYRI finans olayı üretir: satış + komisyon = 2 kayıt.
    assert.equal(applied.counts.new, 2, 'tarih yok diye incelemeye düşmedi');
    assert.equal(applied.counts.review || 0, 0);

    const rows = f.sqlite.prepare("SELECT data_json FROM ec_report_records WHERE kind='finance_event'").all();
    const saved = rows.map(r => JSON.parse(r.data_json));
    const commission = saved.find(d => d.type === 'commission');
    assert.ok(commission, 'komisyon olayı saklandı');

    // Tarih UYDURULMADI: alan var ama boş.
    assert.equal(commission.event_date, null, 'işlem tarihi boş kaldı');
    assert.ok(!Object.values(commission).includes('2026-09-12'), 'raporun indirilme tarihi işlem tarihine yazılmadı');

    // Tutar, oran ve ham hücre AYRI.
    assert.equal(commission.amount_cents, -5412, 'tutar kuruş olarak doğru');
    assert.equal(commission.commission_rate_percent, '19.54', 'oran ayrı alanda');
    assert.equal(commission.commission_raw, '-54.12 TL (%19.54)', 'ham hücre korundu');
    // Oran bir tutar DEĞİLDİR: ikinci bir kesinti olarak kaydedilmedi.
    assert.equal(saved.filter(d => d.type === 'commission').length, 1, 'oran ikinci kesinti sayılmadı');
    assert.equal(saved.reduce((n, d) => n + (d.type === 'commission' ? d.amount_cents : 0), 0), -5412);
  } finally { f.close(); }
});

test('Tarihsizlik beyan edilmeden zorunlu tarih atlanamaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const r = await profile(f, {});
    assert.equal(r.status, 400, 'beyan yoksa profil kabul edilmez');
    assert.match(r.data.error, /tarih/i);
  } finally { f.close(); }
});

test('Tarihsizlik beyanı ile tarih sütunu birlikte kabul edilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const columns = [...COLUMNS.map(c => c.header), 'İşlem tarihi'];
    const r = await f.req('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'finance',
      headers: columns, mapping: {...MAPPING, event_date: 'İşlem tarihi'}, options: {undated: true}});
    assert.equal(r.status, 400, 'çelişkili beyan reddedildi');
    assert.match(r.data.error, /birini seçin/i);
  } finally { f.close(); }
});
