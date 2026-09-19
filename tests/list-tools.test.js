// Tablo aracının sıralama değerleri: tutar, eksi tutar, tarih ve birimli miktar doğru okunur.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sortValue, columnKind, gecerli} from '../public/list-tools.js';

test('Sıralama değeri: TL tutarı, eksi (− ve -) tutar, tarih ve birimli miktar sayı/tarih olarak okunur', () => {
  assert.equal(sortValue('₺1.234,56'), 1234.56);
  assert.equal(sortValue('-₺3.487,20'), -3487.2);
  assert.equal(sortValue('−₺15,09'), -15.09);
  assert.equal(sortValue('20 adet'), 20);
  assert.equal(sortValue('2026-08-17'), '20260817');
  assert.equal(sortValue('17.08.2026'), '20260817');
  assert.equal(sortValue('KRK2026000000763'), 'krk2026000000763', 'belge numarası metin kalır');
});

test('Sütun türü: tutar, tarih, sayı ve metin ayrılır', () => {
  assert.equal(columnKind(['₺10,00', '₺2.500,00', '-₺4,00']), 'tutar');
  assert.equal(columnKind(['2026-08-17', '2026-09-01']), 'tarih');
  assert.equal(columnKind(['5 adet', '12 adet']), 'sayi');
  assert.equal(columnKind(['Karakuş', 'Tropikal']), 'metin');
});

test('Tutar sıralamasında "Eksik veri" gibi hücreler geçersiz sayılır (her iki yönde sona)', () => {
  assert.equal(gecerli(sortValue('Eksik veri'), 'tutar'), false);
  assert.equal(gecerli(sortValue('-₺324,17'), 'tutar'), true);
  assert.equal(gecerli(sortValue('—'), 'tarih'), false);
  assert.equal(gecerli(sortValue('2026-09-18'), 'tarih'), true);
});
