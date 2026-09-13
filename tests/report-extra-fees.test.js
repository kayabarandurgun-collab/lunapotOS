// Bir pazaryeri dökümünde aynı türden birden çok tutar sütunu olur: Trendyol raporunda hem
// "Gönderi Kargo Bedeli" hem "İade Kargo Bedeli" kargodur, hem "Ceza Bedeli" hem "İndirim"
// kesintidir. Alan başına tek sütun kuralıyla bunlardan biri dışarıda kalıyor ve tutar sessizce
// düşüyordu: rapor kendi net tutarıyla tutmuyordu. TEMSİLİ veri; gerçek rapor değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {normalizeRows} from '../public/report-core.js';

const headers = ['Sipariş No', 'Sipariş Tutarı', 'Komisyon', 'Gönderi Kargo Bedeli', 'İade Kargo Bedeli', 'İndirim', 'Net Tutar'];
const cell = (v) => ({v, t: typeof v === 'number' ? 'n' : 's'});
const rows = [{row: 2, cells: [cell('11408249438'), cell(1000), cell(-150), cell(-50), cell(-10), cell(-40), cell(750)]}];
const mapping = {order_no: 'Sipariş No', sale: 'Sipariş Tutarı', commission: 'Komisyon',
  cargo: 'Gönderi Kargo Bedeli', net_payout: 'Net Tutar'};

test('Eşleşmeyen tutar sütunu ek kesinti olarak bağlanır ve rapor kendi netiyle tutar', () => {
  const eksik = normalizeRows({kind: 'finance', mapping, undated: true}, headers, rows, {});
  const eksikToplam = eksik.records.filter(r => r.data.type).reduce((s, r) => s + r.data.amount_cents, 0);
  assert.equal(eksikToplam, 80000, 'iade kargo ve indirim eşlenmeden 800,00 çıkıyor');

  const tam = normalizeRows({kind: 'finance', mapping, undated: true,
    extra_fees: [{header: 'İade Kargo Bedeli', type: 'cargo'}, {header: 'İndirim', type: 'other_fee'}]}, headers, rows, {});
  const tamToplam = tam.records.filter(r => r.data.type).reduce((s, r) => s + r.data.amount_cents, 0);
  assert.equal(tamToplam, 75000, 'ek sütunlarla 750,00 — dosyanın kendi net tutarı');

  // Aynı türden iki sütun ayrı kayıt kalır; biri diğerinin üstüne yazmaz.
  const kargolar = tam.records.filter(r => r.data.type === 'cargo');
  assert.equal(kargolar.length, 2);
  assert.notEqual(kargolar[0].key, kargolar[1].key, 'aynı türdeki iki sütun ayrı anahtar alır');
  assert.deepEqual(kargolar.map(r => r.data.amount_cents).sort((a, b) => a - b), [-5000, -1000]);
});

test('Ek kesinti sütunu sunucuda doğrulanır: uydurma sütun ve çift eşleme reddedilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const iyi = await f.ok('/ec/reports/profiles', {provider: 'trendyol', kind: 'finance', headers, mapping,
      options: {undated: true, extra_fees: [{header: 'İade Kargo Bedeli', type: 'cargo'}]}});
    assert.equal(iyi.options.extra_fees.length, 1);
    assert.equal(iyi.options.extra_fees[0].type, 'cargo');
    assert.ok(!iyi.options.ignored.includes('İade Kargo Bedeli'), 'ek kesinti sütunu "yok sayılan" değildir');

    const yokSutun = await f.req('/ec/reports/profiles', {provider: 'trendyol', kind: 'finance', headers, mapping,
      options: {undated: true, extra_fees: [{header: 'Olmayan Sütun', type: 'cargo'}]}});
    assert.equal(yokSutun.status, 400);

    const ciftEsleme = await f.req('/ec/reports/profiles', {provider: 'trendyol', kind: 'finance', headers, mapping,
      options: {undated: true, extra_fees: [{header: 'Komisyon', type: 'cargo'}]}});
    assert.equal(ciftEsleme.status, 400, 'zaten eşlenmiş sütun ikinci kez bağlanamaz');

    const kotuTur = await f.req('/ec/reports/profiles', {provider: 'trendyol', kind: 'finance', headers, mapping,
      options: {undated: true, extra_fees: [{header: 'İndirim', type: 'payout'}]}});
    assert.equal(kotuTur.status, 400, 'hakediş bir kesinti türü değildir');
  } finally { f.close(); }
});

// Aday seçimi şablonun içinde yazılıydı; bozuk bir düzenli ifade bütün adayları eleyip
// bölümü hiç göstermedi ve üç kesinti sütunu sessizce dışarıda kaldı. Ayrıca yalnız ilk 40
// satıra bakılıyordu: tek dolu satırı daha aşağıda olan sütun hiç sorulmuyordu.
test('İçinde para olan eşleşmemiş sütun sorulur; satır 100 bile olsa kaçmaz', async () => {
  const {extraFeeCandidates} = await import('../public/report-core.js');
  const basliklar = ['Sipariş No', 'Sipariş Tutarı', 'Komisyon', 'Geç Kalan Kesinti', 'Hep Boş', 'Hep Sıfır', 'Açıklama'];
  const satir = (no, tutar, komisyon, gec, aciklama) => ({row: no + 1,
    cells: [cell(String(no)), cell(tutar), cell(komisyon), gec === null ? null : cell(gec), null, cell(0), cell(aciklama)]});
  const rows = [];
  for (let i = 1; i <= 120; i++) rows.push(satir(11408249000 + i, 100, -10, i === 100 ? -7 : 0, 'satır ' + i));

  const aday = extraFeeCandidates(basliklar, rows, {order_no: 'Sipariş No', sale: 'Sipariş Tutarı', commission: 'Komisyon'});
  assert.ok(aday.includes('Geç Kalan Kesinti'), 'tek dolu satırı 100. sırada olan sütun da sorulur');
  assert.ok(!aday.includes('Sipariş Tutarı'), 'eşlenmiş sütun tekrar sorulmaz');
  assert.ok(!aday.includes('Komisyon'), 'eşlenmiş sütun tekrar sorulmaz');
  assert.ok(!aday.includes('Hep Boş'), 'boş sütun sorulmaz');
  assert.ok(!aday.includes('Hep Sıfır'), 'sıfır sütun sorulmaz');
  assert.ok(!aday.includes('Açıklama'), 'metin sütunu tutar sayılmaz');

  // Türkçe biçimli metin tutarlar da para sayılır (1.234,56).
  const metinBaslik = ['Sipariş No', 'Kesinti'];
  const metinSatir = [{row: 2, cells: [cell('11408249438'), cell('-1.234,56')]}];
  assert.deepEqual(extraFeeCandidates(metinBaslik, metinSatir, {order_no: 'Sipariş No'}), ['Kesinti']);
});
