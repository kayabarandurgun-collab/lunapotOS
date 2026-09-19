// SIKIŞTIRILMIŞ NESNE AKIŞI (/ObjStm). PDF 1.5+ üreticileri (pdf-lib, birçok e-fatura yazılımı)
// yazı tipi sözlüklerini ve ToUnicode başvurularını sıkıştırılmış nesne akışına koyar. Okuyucu
// yalnız düz metindeki "N 0 obj" nesnelerine bakarsa kod→harf tablosunu bulamaz ve ANLAMSIZ metni
// "metin var" diye döndürür: fatura satırları bozuk okunur. Kanıt: aynı sayfa nesne akışlı ve
// akışsız kaydedilir; ikisi de aynı satırları vermelidir.
// TEMSİLİ veri; gerçek fatura değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readPdf, guessHeader, guessLines, guessTotals} from '../public/pdf-read.js';

async function fatura(useObjectStreams) {
  const {PDFDocument} = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync(new URL('../public/vendor/NotoSans-tr.ttf', import.meta.url)), {subset: true});
  const page = doc.addPage([595, 842]);
  const yaz = (t, x, y) => page.drawText(t, {x, y, size: 10, font});
  yaz('ÖRNEK TORF SANAYİ VE TİCARET LİMİTED ŞİRKETİ', 40, 800);
  yaz('VKN: 1234567890', 40, 785);
  yaz('e-FATURA', 400, 800);
  yaz('Fatura No: ORN2026000000123', 360, 770);
  yaz('Fatura Tarihi: 17-08-2026', 360, 755);
  yaz('Sıra', 40, 700); yaz('Mal Hizmet', 80, 700); yaz('Miktar', 250, 700); yaz('Birim Fiyat', 310, 700); yaz('KDV Oranı', 380, 700); yaz('KDV Tutarı', 440, 700); yaz('Mal Hizmet Tutarı', 500, 700);
  yaz('1', 40, 680); yaz('Genel Kullanım Torfu 10 L', 80, 680); yaz('5 Adet', 250, 680); yaz('110,00 TL', 310, 680); yaz('%20,00', 380, 680); yaz('110,00 TL', 440, 680); yaz('550,00 TL', 500, 680);
  yaz('2', 40, 660); yaz('Kaktüs Toprağı 2,5 L', 80, 660); yaz('2 Adet', 250, 660); yaz('38,00 TL', 310, 660); yaz('%20,00', 380, 660); yaz('15,20 TL', 440, 660); yaz('76,00 TL', 500, 660);
  yaz('Mal Hizmet Toplam Tutarı', 330, 600); yaz('626,00 TL', 500, 600);
  yaz('Hesaplanan KDV(%20.00)', 330, 585); yaz('125,20 TL', 500, 585);
  yaz('Vergiler Dahil Toplam Tutar', 330, 570); yaz('751,20 TL', 500, 570);
  yaz('Ödenecek Tutar', 330, 555); yaz('751,20 TL', 500, 555);
  return doc.save({useObjectStreams});
}

test('Nesne akışlı PDF, akışsız kopyasıyla aynı okunur (yazı tipi tablosu akışın içinde)', async () => {
  const akisli = await fatura(true), akissiz = await fatura(false);
  assert.match(new TextDecoder('latin1').decode(akisli), /\/ObjStm/, 'örnek gerçekten nesne akışı kullanıyor');
  const a = await readPdf(akisli), b = await readPdf(akissiz);
  assert.equal(a.textLayer, true);
  assert.deepEqual(a.lines, b.lines, 'iki kayıt biçimi aynı satırları verir');
  assert.ok(a.lines.some(l => l.includes('ORN2026000000123')), 'fatura numarası okundu');
  assert.ok(a.lines.some(l => l.includes('ŞİRKETİ')), 'Türkçe harfler çözüldü');
  assert.equal(a.pages, 1);
});

test('Nesne akışlı faturada başlık, satırlar ve toplamlar çıkar', async () => {
  const r = await readPdf(await fatura(true));
  const h = guessHeader(r.lines, {});
  assert.equal(h.invoice_no, 'ORN2026000000123');
  assert.equal(h.invoice_date, '2026-08-17');
  const satirlar = guessLines(r.lines);
  assert.deepEqual(satirlar.map(s => [s.invoice_quantity, s.net]), [[5, 550], [2, 76]]);
  assert.deepEqual(guessTotals(r.lines), {net: 626, tax: 125.2, gross: 751.2});
});

test('Kod→harf tablosu bulunamazsa anlamsız kodlar "metin" sayılmaz; satır uydurulmaz', async () => {
  const bayt = await fatura(false);
  // ToUnicode başvurusu aynı uzunlukta bozulur: kodlar çözülemez, yalnız kontrol karakterleri kalır.
  const metin = new TextDecoder('latin1').decode(bayt).replaceAll('/ToUnicode', '/ToUnicodX');
  const bozuk = Uint8Array.from(metin, c => c.charCodeAt(0));
  const r = await readPdf(bozuk);
  assert.equal(r.textLayer, false);
  assert.deepEqual(r.lines, []);
  assert.ok(r.warnings.some(w => /metin katmanı yok/.test(w)));
});
