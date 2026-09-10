import test from 'node:test';
import assert from 'node:assert/strict';
import {ean13Modules, ean8Modules, isEan13, isEan8, isEan, eanBars, EAN_QUIET_LEFT, EAN_QUIET_RIGHT} from '../public/barcode-ean.js';

// Bağımsız çözücü: modülleri okuyup kodu geri kurar. Aynı tabloyu kullanmaz,
// pariteyi bitlerden çıkarır — yani çizimin gerçekten okunabilir olduğunu gösterir.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function decodeEan13(modules) {
  const bits = modules.join('');
  assert.equal(bits.length, 95);
  assert.equal(bits.slice(0, 3), '101', 'başlangıç koruma çubuğu');
  assert.equal(bits.slice(45, 50), '01010', 'orta koruma çubuğu');
  assert.equal(bits.slice(92), '101', 'bitiş koruma çubuğu');
  let parity = '', left = '';
  for (let i = 0; i < 6; i++) {
    const chunk = bits.slice(3 + i * 7, 10 + i * 7);
    const asL = L.indexOf(chunk), asG = G.indexOf(chunk);
    if (asL >= 0) { parity += 'L'; left += asL; }
    else if (asG >= 0) { parity += 'G'; left += asG; }
    else throw new Error('Sol yarıda tanınmayan hane: ' + chunk);
  }
  let right = '';
  for (let i = 0; i < 6; i++) {
    const chunk = bits.slice(50 + i * 7, 57 + i * 7);
    const value = R.indexOf(chunk);
    if (value < 0) throw new Error('Sağ yarıda tanınmayan hane: ' + chunk);
    right += value;
  }
  const lead = PARITY.indexOf(parity);
  if (lead < 0) throw new Error('Parite düzeni tanınmadı.');
  return String(lead) + left + right;
}

test('EAN-13 modülleri bağımsız bir çözücüyle aynı koda geri okunur', () => {
  for (const code of ['8690632012346', '4006381333931', '9780143007234', '0000123456784']) {
    if (!isEan13(code)) continue;
    assert.equal(decodeEan13(ean13Modules(code).modules), code, code + ' geri okunmalı');
  }
});

test('EAN-13 tam 95 modüldür ve koruma çubukları işaretlenir', () => {
  const plan = ean13Modules('8690632012346');
  assert.equal(plan.modules.length, 95);
  assert.deepEqual(plan.guards, [[0, 3], [45, 50], [92, 95]], 'üç koruma çubuğu');
  assert.equal(plan.lead, '8', 'ilk hane çizilmez, yanına yazılır');
  assert.equal(plan.left, '690632');
  assert.equal(plan.right, '012346');
  assert.ok(plan.modules.every(m => m === 0 || m === 1));
});

test('Geçersiz kod EAN olarak çizilmez', () => {
  assert.equal(isEan13('8690632012345'), false, 'kontrol hanesi tutmuyor');
  assert.equal(isEan13('869063201234'), false, '12 hane');
  assert.equal(isEan13('LP-ABCDEF0123'), false);
  assert.throws(() => ean13Modules('8690632012345'), /Geçerli bir EAN-13 barkodu değil/);
  assert.throws(() => ean13Modules('12345678'), /Geçerli bir EAN-13 barkodu değil/);
});

test('EAN-8 de desteklenir ve 67 modüldür', () => {
  // 96385074 yayınlanmış geçerli bir EAN-8 örneğidir.
  assert.equal(isEan8('96385074'), true);
  const plan = ean8Modules('96385074');
  assert.equal(plan.modules.length, 67);
  assert.equal(plan.left, '9638');
  assert.equal(plan.right, '5074');
  assert.equal(isEan('96385074'), true);
  assert.equal(isEan('8690632012346'), true);
  assert.equal(isEan('TORF20'), false);
});

test('Sessiz alan GS1 ölçüsündedir ve kısaltılmaz', () => {
  assert.equal(EAN_QUIET_LEFT, 11);
  assert.equal(EAN_QUIET_RIGHT, 7);
});

test('Bitişik modüller tek bara toplanır ve toplam genişlik korunur', () => {
  const {modules} = ean13Modules('8690632012346');
  const bars = eanBars(modules);
  assert.ok(bars.length > 20 && bars.length < 60, 'makul sayıda dikdörtgen');
  // Toplanan barların kapladığı modül sayısı, 1 olan modül sayısına eşit olmalı.
  const barModules = bars.reduce((total, bar) => total + bar.width, 0);
  assert.equal(barModules, modules.filter(m => m === 1).length);
  // Hiçbir bar sınırı aşmamalı.
  assert.ok(bars.every(bar => bar.from >= 0 && bar.from + bar.width <= 95));
});
