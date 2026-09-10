import test from 'node:test';
import assert from 'node:assert/strict';
import {code128Bars, code128Checksum, encodable, labelPlan, labelPrintHtml, LABEL_SIZES, CODE128_PATTERNS} from '../public/barcode-label.js';

test('Code 128 sağlama hanesi bilinen örneklerle uyuşur', () => {
  // Yaygın olarak anılan "PJJ123C = 54" örneği Start A içindir. Biz Start B kullanıyoruz;
  // aynı dizgede doğru sağlama 55'tir: (104 + 48 + 84 + 126 + 68 + 90 + 114 + 245) % 103.
  assert.equal(code128Checksum('PJJ123C'), 55);
  // Tek karakter: START_B(104) + ('A'-32)*1 = 104+33 = 137 → 137 % 103 = 34
  assert.equal(code128Checksum('A'), 34);
});

test('Barlar başlangıç, veri, sağlama ve durdurma desenlerini içerir', () => {
  const bars = code128Bars('A');
  // Start B + veri + sağlama + durdurma; durdurma deseni 7 modüldür.
  assert.equal(bars.length, 6 + 6 + 6 + 7, 'başlangıç + veri + sağlama + durdurma');
  assert.deepEqual(bars.slice(0, 6), [2, 1, 1, 2, 1, 4], 'Start B deseni 211214');
  assert.deepEqual(bars.slice(-7), [2, 3, 3, 1, 1, 1, 2], 'durdurma deseni');
  assert.ok(bars.every(w => w >= 1 && w <= 4), 'modül genişlikleri 1-4 arasındadır');
});

test('İç kod ve GS1 barkodu aynı sembolojiyle basılabilir', () => {
  assert.equal(encodable('LP-ABCDEF0123'), true);
  assert.equal(encodable('8690632012346'), true);
  assert.equal(encodable(''), false);
  assert.equal(encodable('Torf ürünü'), false, 'ASCII dışı karakter Code 128-B ile basılamaz');
  assert.throws(() => code128Bars('Torf ürünü'), /Code 128 ile basılamaz/);
  assert.ok(code128Bars('LP-ABCDEF0123').length > 20);
});

test('Etiket planı barları ortalar ve okunabilirlik sınırını korur', () => {
  const plan = labelPlan({code: '8690632012346', size: 'medium'});
  assert.equal(plan.preset.width_mm, 50);
  assert.ok(plan.module_mm >= 0.19, 'modül genişliği okunabilirlik sınırının altına düşmemeli');
  assert.ok(plan.bars_width_mm <= plan.preset.width_mm - 4, 'barlar kenar boşluğuna taşmamalı');
  assert.ok(plan.start_x_mm > 0, 'barlar ortalanmalı');
  assert.equal(plan.bar_height_mm, 18);
  assert.ok(plan.page.width_pt > 140 && plan.page.width_pt < 145, '50 mm yaklaşık 141,7 punto');
});

test('Sığmayan kod sessizce küçültülmez, daha büyük etiket istenir', () => {
  const uzun = 'LP-' + 'A'.repeat(40);
  assert.throws(() => labelPlan({code: uzun, size: 'small'}), /okunabilir biçimde sığmıyor/);
  // Aynı kod büyük etikete sığabiliyorsa basılır.
  const buyuk = labelPlan({code: 'LP-ABCDEF0123', size: 'large'});
  assert.ok(buyuk.module_mm >= 0.19);
  assert.throws(() => labelPlan({code: 'LP-ABCDEF0123', size: 'devasa'}), /boyutu geçersiz/);
});

test('Yazdırma sayfası kodu, adı ve gerçek barları taşır', () => {
  const html = labelPrintHtml([
    {code: '8690632012346', title: 'Torf 20 kg teneke', subtitle: 'Klasmann · 1 okutma = 20 kg'},
    {code: 'LP-ABCDEF0123', title: 'Etiketsiz ürün', subtitle: 'İç kullanım kodu'}
  ], {size: 'medium'});
  assert.ok(html.includes('8690632012346'), 'kod insan tarafından da okunabilir yazılmalı');
  assert.ok(html.includes('Torf 20 kg teneke'));
  assert.ok(html.includes('İç kullanım kodu'));
  assert.ok((html.match(/<svg/g) || []).length === 2, 'her etikette bir barkod çizimi');
  assert.ok((html.match(/<rect/g) || []).length > 40, 'gerçek barlar çizilmeli');
  // Olculer artik print.css icindeki .labels.medium sinifindan gelir; HTML'e gomulmez.
  assert.ok(html.includes('class="labels medium"'), 'seçilen etiket boyutu sınıfla verilmeli');
  assert.deepEqual(Object.keys(LABEL_SIZES), ['small', 'medium', 'large']);
});

// Barlari geri cozen bagimsiz bir okuyucu: cizim var demek okunuyor demek degildir.
function decode128(widths) {
  const patterns = [];
  for (let i = 0; i < widths.length;) {
    const size = widths.length - i === 7 ? 7 : 6;
    patterns.push(widths.slice(i, i + size).join(''));
    i += size;
  }
  const table = code128Table();
  const values = patterns.map(p => {
    const value = table.indexOf(p);
    if (value < 0) throw new Error('Tanınmayan desen: ' + p);
    return value;
  });
  if (values[0] !== 104) throw new Error('Start B bekleniyordu.');
  if (values.at(-1) !== 106) throw new Error('Durdurma deseni bekleniyordu.');
  const check = values.at(-2), data = values.slice(1, -2);
  let sum = 104;
  data.forEach((value, index) => { sum += value * (index + 1); });
  if (sum % 103 !== check) throw new Error('Sağlama hanesi tutmuyor.');
  return data.map(value => String.fromCharCode(value + 32)).join('');
}

function code128Table() {
  // Desen tablosu kodlayicidan alinir; cozme mantigi (gruplama, start/stop, saglama,
  // karakter esleme) bagimsiz yazildi. Dogrulanan sey budur.
  return CODE128_PATTERNS;
}

test('Üretilen barlar bağımsız bir okuyucuyla aynı koda geri çözülür', () => {
  for (const code of ['8690632012346', 'LP-ABCDEF0123', '0000123456789', 'A', 'Torf-20KG']) {
    assert.equal(decode128(code128Bars(code)), code, code + ' geri okunmalı');
  }
  // Tek bir modül bozulursa sağlama tutmaz; okuyucu sessizce yanlış kod dönmez.
  const bozuk = code128Bars('8690632012346');
  bozuk[7] = bozuk[7] === 1 ? 2 : 1;
  assert.throws(() => decode128(bozuk), /Tanınmayan desen|Sağlama hanesi tutmuyor/);
});
