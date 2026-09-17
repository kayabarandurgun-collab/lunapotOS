// PDF okuyucusundaki üç kör nokta. Üçü birden gerçek bir e-Arşiv faturasında ortaya çıktı:
// belge metin taşıdığı hâlde "taranmış" sanılıyor, sanılmadığında yazılar anlamsız çıkıyor,
// çok sayfalıda sayfalar birbirine karışıyordu.
// TEMSİLİ PDF'ler burada üretilir; gerçek fatura dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {readPdf} from '../public/pdf-read.js';

const bin = s => Buffer.from(s, 'latin1');

/** Küçük bir PDF kurar. sayfalar: [{fontAdi, tablo:{kod:harf}, metin:[[kod,x,y]]}] */
function pdfKur(sayfalar, {satirSonu = '\r\n', uzunlukYaz = true} = {}) {
  const parts = [bin('%PDF-1.7\n')];
  const ekle = (num, govde, akis) => {
    let s = num + ' 0 obj\n' + govde;
    if (akis) {
      s += 'stream' + satirSonu;
      parts.push(bin(s));
      parts.push(akis);
      // 'endstream' öncesine satır sonu konur: /Length bunu KAPSAMAZ.
      parts.push(bin(satirSonu + 'endstream\nendobj\n'));
      return;
    }
    parts.push(bin(s + '\nendobj\n'));
  };

  const kids = sayfalar.map((_, i) => (5 + i * 4) + ' 0 R').join(' ');
  ekle(1, '<</Type/Catalog/Pages 2 0 R>>');
  ekle(2, '<</Type/Pages/Count ' + sayfalar.length + '/Kids[ ' + kids + ' ]>>');

  sayfalar.forEach((sayfa, i) => {
    const sayfaNo = 5 + i * 4, icerikNo = sayfaNo + 1, fontNo = sayfaNo + 2, cmapNo = sayfaNo + 3;
    ekle(sayfaNo, '<</Type/Page/Parent 2 0 R/Contents ' + icerikNo + ' 0 R' +
      '/Resources<</Font<</' + sayfa.fontAdi + ' ' + fontNo + ' 0 R >>>>>>');

    const govde = sayfa.metin.map(([kod, x, y]) =>
      'BT /' + sayfa.fontAdi + ' 12 Tf 1 0 0 1 ' + x + ' ' + y + ' Tm <' + kod + '> Tj ET').join('\n');
    const sikistirilmis = deflateSync(Buffer.from(govde, 'latin1'));
    ekle(icerikNo, '<</Filter/FlateDecode' + (uzunlukYaz ? '/Length ' + sikistirilmis.length : '') + '>>', sikistirilmis);

    ekle(fontNo, '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-H/ToUnicode ' + cmapNo + ' 0 R >>');
    const cmap = 'beginbfchar\n' + Object.entries(sayfa.tablo)
      .map(([kod, harf]) => '<' + kod + '> <' + harf.charCodeAt(0).toString(16).padStart(4, '0') + '>').join('\n') + '\nendbfchar';
    const cmapZ = deflateSync(Buffer.from(cmap, 'latin1'));
    ekle(cmapNo, '<</Filter/FlateDecode/Length ' + cmapZ.length + '>>', cmapZ);
  });
  parts.push(bin('trailer<</Root 1 0 R>>\n%%EOF'));
  return new Uint8Array(Buffer.concat(parts));
}

// textLayer eşiği 40 karakterdir: kısa örnek "taranmış" sayılır. Satırlar yeterince uzun tutulur.
const kod = (n, a, b) => Array.from({length: n}, () => a + b).join('');
const SAYFA1 = {fontAdi: 'F11', tablo: {'0035': 'A', '0036': 'B'},
  metin: [[kod(30, '0035', '0036'), 100, 700], [kod(30, '0036', '0035'), 100, 600]]};
const SAYFA2 = {fontAdi: 'F11', tablo: {'0035': 'X', '0036': 'Y'},
  metin: [[kod(30, '0035', '0036'), 100, 700], [kod(30, '0036', '0035'), 100, 600]]};

test('endstream öncesindeki satır sonu akışı bozmaz; belge "taranmış" sanılmaz', async () => {
  const r = await readPdf(pdfKur([SAYFA1]), {name: 'a.pdf'});
  assert.equal(r.textLayer, true, 'metin katmanı bulundu: ' + r.warnings.join(' '));
  assert.ok(r.lines.join(' ').includes('AB'), 'yazı çözüldü: ' + JSON.stringify(r.lines));
});

test('/Length yoksa satır sonları kırpılarak yine okunur', async () => {
  const r = await readPdf(pdfKur([SAYFA1], {uzunlukYaz: false}), {name: 'b.pdf'});
  assert.equal(r.textLayer, true);
  assert.ok(r.lines.join(' ').includes('AB'));
});

test('ToUnicode tablosu sıkıştırılmış nesnede olsa da açılır; kodlar çözülür', async () => {
  const r = await readPdf(pdfKur([SAYFA1]), {name: 'c.pdf'});
  // Tablo açılmazsa kodlar ham bayt olarak çıkar ve 'AB' görünmez.
  assert.ok(r.lines.join(' ').includes('AB'), 'ToUnicode uygulandı');
});

test('Aynı yazı tipi adı sayfadan sayfaya farklı tabloyu gösterir; sayfalar karışmaz', async () => {
  const r = await readPdf(pdfKur([SAYFA1, SAYFA2]), {name: 'd.pdf'});
  assert.equal(r.pageLines.length, 2, 'iki sayfa ayrı tutuldu');
  assert.ok(r.pageLines[0].join(' ').includes('AB'), '1. sayfa kendi tablosuyla çözüldü');
  assert.ok(r.pageLines[1].join(' ').includes('XY'), '2. sayfa kendi tablosuyla çözüldü: ' + JSON.stringify(r.pageLines[1]));
  // Aynı Y'deki iki sayfa satırı tek satıra karışmamalı.
  assert.ok(!r.lines.some(l => l.includes('AB') && l.includes('XY')), 'sayfalar aynı satırda birleşmedi');
});

test('Gerçekten metinsiz belgede satır UYDURULMAZ', async () => {
  const bos = pdfKur([{fontAdi: 'F11', tablo: {'0035': 'A'}, metin: []}]);
  const r = await readPdf(bos, {name: 'e.pdf'});
  assert.equal(r.textLayer, false);
  assert.deepEqual(r.lines, []);
  assert.ok(r.warnings.some(w => /metin katmanı yok/.test(w)));
});
