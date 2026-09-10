import test from 'node:test';
import assert from 'node:assert/strict';
import {offerLine, offerTotals, effectiveStatus, canAccept, NEXT_KIND, CLOSED_STATUS} from '../public/offer-math.js';

const line = (extra = {}) => ({description: 'Saksı', unit: 'adet', quantity_milli: 3000, unit_price_cents: 12550, vat_bps: 2000, ...extra});

test('Satır iskonto ve KDV sırasıyla hesaplanır, kuruş tam sayı kalır', () => {
  const row = offerLine(line({discount_bps: 1000}));
  assert.equal(row.gross_cents, 37650, '3 adet × 125,50');
  assert.equal(row.discount_cents, 3765, '%10 iskonto');
  assert.equal(row.net_cents, 33885);
  assert.equal(row.vat_cents, 6777, 'KDV iskontodan SONRA hesaplanır');
  assert.equal(row.total_cents, 40662);
  assert.ok(Object.values(row).every(v => typeof v !== 'number' || Number.isSafeInteger(v)));
});

test('Toplam satırların toplamıdır; belgede alt alta toplayan kişi aynı sayıyı bulur', () => {
  // Tek tek yuvarlanan satırlar toplandığında, toplam üzerinden yuvarlamaktan farklı çıkabilir.
  // Belge satırları gösterdiği için satır bazlı yuvarlama doğrudur.
  const lines = [line({quantity_milli: 1000, unit_price_cents: 3333}), line({quantity_milli: 1000, unit_price_cents: 3333}), line({quantity_milli: 1000, unit_price_cents: 3333})];
  const result = offerTotals(lines);
  assert.equal(result.rows.length, 3);
  assert.equal(result.net_cents, 9999);
  assert.equal(result.vat_cents, result.rows.reduce((t, r) => t + r.vat_cents, 0));
  assert.equal(result.total_cents, result.rows.reduce((t, r) => t + r.total_cents, 0));
});

test('KDV oranı başına döküm ayrı ayrı toplanır', () => {
  const result = offerTotals([line({vat_bps: 2000}), line({vat_bps: 1000}), line({vat_bps: 2000})]);
  assert.deepEqual(result.vat_breakdown.map(v => v.vat_bps), [1000, 2000]);
  assert.equal(result.vat_breakdown[0].net_cents, 37650);
  assert.equal(result.vat_breakdown[1].net_cents, 75300);
  assert.equal(result.vat_breakdown.reduce((t, v) => t + v.vat_cents, 0), result.vat_cents);
});

test('Sıfır fiyat kabul edilir, eksi ve kesirli değerler reddedilir', () => {
  assert.equal(offerLine(line({unit_price_cents: 0})).total_cents, 0, 'promosyon satırı sıfır olabilir');
  assert.throws(() => offerLine(line({quantity_milli: 0})), /sıfırdan büyük/);
  assert.throws(() => offerLine(line({quantity_milli: -1000})), /sıfırdan büyük/);
  assert.throws(() => offerLine(line({unit_price_cents: -1})), /Birim fiyat geçersiz/);
  assert.throws(() => offerLine(line({unit_price_cents: 12.5})), /tam sayı olmalı/);
  assert.throws(() => offerLine(line({discount_bps: 10001})), /%0 ile %100/);
  assert.throws(() => offerTotals([]), /en az bir satır/);
  assert.throws(() => offerTotals(Array.from({length: 201}, () => line())), /en fazla 200 satır/);
});

test('Süre dolması tarihten okunur, kabul edilmiş belge sonradan süresi dolmuş sayılmaz', () => {
  const waiting = {status: 'sent', valid_until: '2026-02-01'};
  assert.equal(effectiveStatus(waiting, '2026-01-31'), 'sent');
  assert.equal(effectiveStatus(waiting, '2026-02-01'), 'sent', 'geçerlilik günü dahildir');
  assert.equal(effectiveStatus(waiting, '2026-02-02'), 'expired');
  assert.equal(effectiveStatus({status: 'accepted', valid_until: '2026-02-01'}, '2026-05-05'), 'accepted');
  assert.equal(effectiveStatus({status: 'draft', valid_until: '2020-01-01'}, '2026-05-05'), 'draft', 'gönderilmemiş taslak süresi dolmuş sayılmaz');
  assert.equal(effectiveStatus({status: 'sent', valid_until: null}, '2026-05-05'), 'sent');
});

test('Kabul yalnızca yanıt beklenen ve süresi geçmemiş belgede mümkündür', () => {
  assert.equal(canAccept({status: 'sent', valid_until: '2026-02-10'}, '2026-02-01'), true);
  assert.equal(canAccept({status: 'sent', valid_until: '2026-02-10'}, '2026-02-11'), false, 'süresi dolmuş teklif indirilip kabul edilemez');
  assert.equal(canAccept({status: 'draft', valid_until: null}, '2026-02-01'), false, 'gönderilmemiş taslak kabul edilemez');
  assert.equal(canAccept({status: 'accepted', valid_until: null}, '2026-02-01'), false, 'ikinci kez kabul edilemez');
});

test('Belge zinciri tek yön ilerler ve sözleşmeden sonrası yoktur', () => {
  assert.equal(NEXT_KIND.quote, 'proforma');
  assert.equal(NEXT_KIND.proforma, 'contract');
  assert.equal(NEXT_KIND.contract, undefined, 'sözleşmeden yeni belge türetilmez');
  assert.deepEqual(CLOSED_STATUS, ['accepted', 'rejected', 'cancelled']);
});
