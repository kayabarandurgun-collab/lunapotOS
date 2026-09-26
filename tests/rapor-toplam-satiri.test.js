// RAPORUN "TOPLAM" SATIRI İŞLEM SAYILMAZ.
// Canlıda görüldü (2026-09-26): Hepsiburada sipariş dökümünün son satırındaki "Toplam" kelimesi
// SİPARİŞ NO sütununa düşüyor. Eleme kuralı kimlik alanlarının boş olmasını şart koştuğu için
// çalışmıyor, satır "tutarı yok" diye incelemeye düşüyordu — yedi inceleme kaydının BEŞİ buydu ve
// kullanıcıdan her dosyada aynı çöp satır için karar isteniyordu.
// TEMSİLİ veri; gerçek rapor değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRows} from '../public/report-core.js';

const cell = v => (v === null ? null : {v, t: typeof v === 'number' ? 'n' : 's'});
const headers = ['Sipariş Numarası', 'Satıcı Stok Kodu', 'Adet', 'Sipariş Tarihi', 'Tutar', 'KDV(%)'];
const mapping = {order_no: 'Sipariş Numarası', sku: 'Satıcı Stok Kodu', quantity: 'Adet',
  order_date: 'Sipariş Tarihi', gross: 'Tutar', vat_bps: 'KDV(%)'};
const siparis = (no, tutar) => [cell(no), cell('HBV1'), cell(1), cell('15-08-2026'), cell(tutar), cell(20)];

test('"Toplam" kelimesi sipariş no sütununda olsa da satır elenir, incelemeye düşmez', () => {
  const rows = [
    {row: 2, cells: siparis('4332820217', 240)},
    {row: 3, cells: siparis('4332820218', 300)},
    // Dökümün son satırı: etiket kimlik sütununda, tutar sütunu dolu (toplam).
    {row: 4, cells: [cell('Toplam'), cell(null), cell(null), cell(null), cell(540), cell(null)]}
  ];
  const n = normalizeRows({kind: 'orders', mapping}, headers, rows, {});
  assert.equal(n.records.length, 2, 'yalnız gerçek siparişler kalmalı');
  assert.ok(!n.records.some(r => String(r.data.order_no).toLowerCase() === 'toplam'), 'toplam satırı kayıt olmamalı');
  assert.equal(n.skipped.total, 1, 'atlanan toplam satırı sayılmalı');
});

test('toplam satırının tutarı genel toplamı şişirmez', () => {
  const rows = [
    {row: 2, cells: siparis('A1', 240)},
    {row: 3, cells: [cell('Genel Toplam'), cell(null), cell(null), cell(null), cell(240), cell(null)]}
  ];
  const n = normalizeRows({kind: 'orders', mapping}, headers, rows, {});
  assert.equal(n.records.length, 1);
  assert.equal(n.totals.gross, 24000, 'toplam satırı tutara eklenmemeli');
});

test('sipariş numarası gerçek olan satır elenmez, "toplam" kelimesi başka sütunda olsa bile', () => {
  const rows = [
    {row: 2, cells: [cell('4332820217'), cell('Toplam Bakım Seti'), cell(1), cell('15-08-2026'), cell(240), cell(20)]}
  ];
  const n = normalizeRows({kind: 'orders', mapping}, headers, rows, {});
  assert.equal(n.records.length, 1, 'ürün adında "toplam" geçen gerçek sipariş elenmemeli');
  assert.equal(n.records[0].data.order_no, '4332820217');
});

test('finans dökümünün toplam satırı da elenir', () => {
  const fHeaders = ['Sipariş Numarası', 'İşlem Türü', 'Tutar'];
  const fMapping = {order_no: 'Sipariş Numarası', event_type: 'İşlem Türü', amount: 'Tutar'};
  const rows = [
    {row: 2, cells: [cell('4332820217'), cell('Komisyon'), cell(-30)]},
    {row: 3, cells: [cell('TOPLAM'), cell(null), cell(-30)]}
  ];
  const n = normalizeRows({kind: 'finance', mapping: fMapping, type_map: {'Komisyon': 'commission'}, undated: true}, fHeaders, rows, {});
  assert.equal(n.skipped.total, 1);
  assert.ok(!n.records.some(r => /toplam/i.test(String(r.data.order_no ?? ''))), 'toplam satırı finans kaydı olmamalı');
});
