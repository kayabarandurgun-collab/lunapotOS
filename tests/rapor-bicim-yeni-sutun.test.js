import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {headerSignature} from '../public/report-core.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

// PAZARYERİ RAPORA SÜTUN EKLEYİNCE EŞLEŞTİRME SIFIRLANMAMALI.
// Gerçek olay (27.09.2026): Trendyol sipariş raporuna "Tedarik Süresi Durumu" sütununu ekledi.
// 56 sütunun 56'sı yerindeydi, dosya 57 sütun oldu; imza birebir tutmadığı için kayıtlı eşleştirme
// bulunamadı ve toplu yükleme dosyayı "ilk kez görülen biçim" diye atladı.
// Kural: eşleştirmede KULLANILAN sütunların hepsi dosyada duruyorsa kayıtlı biçim kullanılır.
// Sütun EKSİLDİYSE kullanılmaz — orada susmak alanı boş okuyup sessizce yanlış veri yazmak olurdu.

const COLUMNS = ['Sipariş No', 'Paket No', 'Kalem No', 'Barkod', 'Ürün', 'Adet', 'Durum', 'Sipariş Tarihi', 'Tutar', 'Kargo', 'Teslim Tarihi'];
const MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo', delivered_date: 'Teslim Tarihi'};

const ara = (f, headers) => f.req('/ec/reports/profiles?provider=trendyol&kind=orders&signature=' + encodeURIComponent(headerSignature(headers)));

async function fixture() {
  const f = appFixture();
  await f.setup();
  await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLUMNS, mapping: MAPPING, options: {}});
  return f;
}

test('birebir aynı sütunlarda kayıtlı eşleştirme bulunur', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, COLUMNS);
    assert.ok(data.profile, 'kayıtlı biçim bulunmalı');
    assert.equal(data.profile.mapping.order_no, 'Sipariş No');
    assert.ok(!data.profile.signature_drift, 'birebir eşleşmede sapma işareti olmamalı');
  } finally { f.close(); }
});

test('pazaryeri yeni sütun eklediğinde kayıtlı eşleştirme kullanılmaya devam eder', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, [...COLUMNS, 'Tedarik Süresi Durumu']);
    assert.ok(data.profile, 'yalnız sütun eklendiğinde biçim yine bulunmalı');
    assert.equal(data.profile.mapping.delivered_date, 'Teslim Tarihi');
    assert.equal(data.profile.signature_drift, true, 'sütun eklendiği kullanıcıya bildirilebilsin');
  } finally { f.close(); }
});

test('eşleştirmede kullanılan sütun kaybolursa kullanıcıya yine sorulur', async () => {
  const f = await fixture();
  try {
    const {data} = await ara(f, COLUMNS.filter(h => h !== 'Teslim Tarihi'));
    assert.equal(data.profile, null, 'eksilen sütunda sessizce devam edilmemeli');
  } finally { f.close(); }
});

test('eşleştirmede kullanılmayan sütun kaybolsa da kullanıcıya sorulur', async () => {
  const f = await fixture();
  try {
    // Kural bilerek dar: "yalnız eklendi" diyebilmek için kayıtlı biçimin BÜTÜN sütunları durmalı.
    const {data} = await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders',
      headers: [...COLUMNS, 'Not'], mapping: MAPPING, options: {}}).then(() => ara(f, COLUMNS.concat('Başka')));
    assert.equal(data.profile?.signature_drift, true, 'ilk biçim hâlâ tam olarak duruyor, o kullanılır');
  } finally { f.close(); }
});

test('başka türün biçimi ödünç alınmaz', async () => {
  const f = await fixture();
  try {
    const {data} = await f.req('/ec/reports/profiles?provider=trendyol&kind=finance&signature=' + encodeURIComponent(headerSignature([...COLUMNS, 'Yeni'])));
    assert.equal(data.profile, null, 'sipariş biçimi finans raporuna uygulanmamalı');
  } finally { f.close(); }
});

test('boş imzayla biçim döndürülmez', async () => {
  const f = await fixture();
  try {
    const {data} = await f.req('/ec/reports/profiles?provider=trendyol&kind=orders&signature=');
    assert.equal(data.profile, null);
  } finally { f.close(); }
});

// DOSYA KABULÜ DE AYNI KAPIDAN GEÇMELİ. 27.09.2026'da biçim sorgusu düzeltildi ama dosya kabulündeki
// ikinci birebir-imza kontrolü unutuldu: eşleştirme ekranı atlandı, dosya yüklemede 409 yedi.
test('yeni sütunlu dosya yüklemede de kabul edilir', async () => {
  const f = appFixture();
  await f.setup();
  try {
    const storeId = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'})).id;
    await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLUMNS, mapping: MAPPING, options: {}});
    const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: [...COLUMNS, 'Tedarik Süresi Durumu'].map(header => ({header})),
      rows: [['S-1', 'P-1', 'K-1', '869', 'Ürün', 1, 'Teslim Edildi', '01.09.2026', '100,00', '10,00', '05.09.2026', 'Zamanında']]}]));
    const table = await readTable(bytes, {name: 'yeni.xlsx'});
    const created = await f.ok('/ec/reports/files', {store_id: storeId, kind: 'orders', filename: 'yeni.xlsx', size_bytes: bytes.length,
      sha256: await sha256Hex(bytes), snapshot_at: '2026-09-27T21:00', sheet: table.sheet, headers: table.headers,
      date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    assert.ok(created.id, 'yeni sütunlu dosya 409 almadan kabul edilmeli');
    const profilId = f.sqlite.prepare('SELECT profile_id FROM ec_report_files WHERE id=?').get(created.id).profile_id;
    assert.ok(profilId, 'dosya kayıtlı biçime bağlanmalı');
  } finally { f.close(); }
});

test('eşleştirmede kullanılan sütun eksilirse dosya kabul edilmez', async () => {
  const f = appFixture();
  await f.setup();
  try {
    const storeId = (await f.ok('/ec/reports/stores', {provider: 'trendyol', code: 'TY-1', name: 'Mağaza'})).id;
    await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'orders', headers: COLUMNS, mapping: MAPPING, options: {}});
    const eksik = COLUMNS.filter(h => h !== 'Teslim Tarihi');
    const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: eksik.map(header => ({header})),
      rows: [['S-1', 'P-1', 'K-1', '869', 'Ürün', 1, 'Teslim Edildi', '01.09.2026', '100,00', '10,00']]}]));
    const table = await readTable(bytes, {name: 'eksik.xlsx'});
    const r = await f.req('/ec/reports/files', {store_id: storeId, kind: 'orders', filename: 'eksik.xlsx', size_bytes: bytes.length,
      sha256: await sha256Hex(bytes), snapshot_at: '2026-09-27T21:00', sheet: table.sheet, headers: table.headers,
      date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    assert.equal(r.status, 409, 'sütun eksildiğinde eşleştirme yine sorulmalı');
  } finally { f.close(); }
});
