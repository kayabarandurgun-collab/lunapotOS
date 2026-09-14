// Sipariş satırında KDV oranı olmadan net tutar hesaplanamıyor; net tutar olmadan da
// sipariş sevk edilemiyor, yani satış stoktan hiç düşmüyordu. Oran satır bazında okunur:
// aynı dosyada %10 ve %20 birlikte bulunabilir (Hepsiburada dökümü böyle).
// TEMSİLİ veri; gerçek rapor değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRows, FIELDS} from '../public/report-core.js';

const cell = (v) => ({v, t: typeof v === 'number' ? 'n' : 's'});
const headers = ['Sipariş Numarası', 'Satıcı Stok Kodu', 'Adet', 'Sipariş Tarihi', 'Tutar', 'KDV(%)'];
const mapping = {order_no: 'Sipariş Numarası', sku: 'Satıcı Stok Kodu', quantity: 'Adet',
  order_date: 'Sipariş Tarihi', gross: 'Tutar', vat_bps: 'KDV(%)'};

test('Sipariş satırının KDV oranı dosyadan okunur; aynı dosyada farklı oranlar olabilir', () => {
  const rows = [
    {row: 2, cells: [cell('4332820217'), cell('HBV1'), cell(1), cell('15-08-2026'), cell(240), cell(20)]},
    {row: 3, cells: [cell('4332820218'), cell('HBV2'), cell(2), cell('15-08-2026'), cell(300), cell('%10,00')]},
    {row: 4, cells: [cell('4332820219'), cell('HBV3'), cell(1), cell('15-08-2026'), cell(150), null]}
  ];
  const n = normalizeRows({kind: 'orders', mapping}, headers, rows, {});
  const kayit = n.records;
  assert.equal(kayit.length, 3);
  assert.equal(kayit[0].data.vat_bps, 2000, 'düz sayı yüzde sayılır');
  assert.equal(kayit[1].data.vat_bps, 1000, "yüzde işareti ve virgül kabul edilir");
  assert.equal(kayit[2].data.vat_bps, undefined, 'boş hücre oran uydurmaz');
  assert.ok(!kayit[2].issues.some(i => i.code === 'bad_value'), 'boş KDV hata değildir');
});

test('Geçersiz KDV oranı sessizce kabul edilmez', () => {
  const rows = [
    {row: 2, cells: [cell('4332820217'), cell('HBV1'), cell(1), cell('15-08-2026'), cell(240), cell('abc')]},
    {row: 3, cells: [cell('4332820218'), cell('HBV2'), cell(1), cell('15-08-2026'), cell(240), cell(150)]}
  ];
  const n = normalizeRows({kind: 'orders', mapping}, headers, rows, {});
  assert.ok(n.records[0].issues.some(i => i.code === 'bad_value'), 'metin oran hata verir');
  assert.ok(n.records[1].issues.some(i => i.code === 'bad_value'), 'yüzde 150 kabul edilmez');
});

test('KDV alanı sipariş şemasında tanımlı ve yalnız sipariş türünde', () => {
  assert.ok(FIELDS.orders.some(f => f.key === 'vat_bps' && f.type === 'percent'));
  assert.ok(!FIELDS.orders.find(f => f.key === 'vat_bps').required, 'KDV zorunlu değildir');
});
