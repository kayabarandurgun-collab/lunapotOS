// Birleşik EDM PDF'i (ASDAFF.pdf) gerçekte hiç işlenemedi. Beş kök neden vardı:
//  1) Sayfa koordinatı 'cm' ile ters çevrilmişti; satırlar alttan üste diziliyordu.
//  2) Sözcükler harf aralığı ayarıyla parçalanmıştı ("Li"+"tr"+"e"); araya boşluk giriyordu.
//  3) Belgedeki İLK VKN tedarikçi sanılıyordu; sıra ters olunca bu ALICININ (bizim) numaramızdı.
//  4) Kalem satırı "sıra + miktar" ile başlıyordu; açıklama üst/alt satırdaydı; KDV ile tutar
//     yer değiştiriyordu.
//  5) Eski okuyucu belgeyi "taranmış" sanıp saklamıştı; aynı dosya bir daha yüklenemiyordu.
// TEMSİLİ belgeler burada üretilir; gerçek fatura, unvan veya numara DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {readPdf, guessHeader, guessLines, guessTotals, splitInvoices} from '../public/pdf-read.js';
import {appFixture} from './helpers/app-fixture.js';
import {sha256Hex} from '../public/xlsx-read.js';

const bin = s => Buffer.from(s, 'latin1');
const OWN = {taxIds: ['1234567890'], name: 'Örnek Alıcı Ticaret Limited Şirketi'};

/**
 * Ters koordinatlı, CID yazı tipli, genişlik tablolu tek sayfalık PDF.
 * parcalar: [[metin, x, y]] — y AŞAĞI doğru büyür (HTML'den basılmış sayfa gibi).
 * Aynı satırdaki bitişik parçalar tek sözcüğün kaydırılmış parçalarıdır.
 */
function tersPdf(parcalar) {
  const harfler = [...new Set(parcalar.flatMap(([t]) => [...t]))];
  const kod = new Map(harfler.map((h, i) => [h, i + 3]));
  const W = 500; // her harf 0,5 em
  const hex = t => [...t].map(h => kod.get(h).toString(16).padStart(4, '0')).join('');
  const govde = '0.5 0 0 -0.5 0 842 cm\n' + parcalar.map(([t, x, y]) =>
    'BT /F1 20 Tf 1 0 0 -1 ' + x + ' ' + y + ' Tm <' + hex(t) + '> Tj ET').join('\n');
  const icerik = deflateSync(Buffer.from(govde, 'latin1'));
  const cmap = deflateSync(Buffer.from('beginbfchar\n' + harfler.map(h =>
    '<' + kod.get(h).toString(16).padStart(4, '0') + '> <' + h.charCodeAt(0).toString(16).padStart(4, '0') + '>').join('\n') + '\nendbfchar', 'latin1'));
  const parts = [bin('%PDF-1.7\n')];
  const ekle = (num, s, akis) => {
    if (!akis) { parts.push(bin(num + ' 0 obj\n' + s + '\nendobj\n')); return; }
    parts.push(bin(num + ' 0 obj\n' + s + 'stream\n'), akis, bin('\nendstream\nendobj\n'));
  };
  ekle(1, '<</Type/Catalog/Pages 2 0 R>>');
  ekle(2, '<</Type/Pages/Count 1/Kids[ 3 0 R ]>>');
  ekle(3, '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R >>>>>>');
  ekle(4, '<</Filter/FlateDecode/Length ' + icerik.length + '>>', icerik);
  ekle(5, '<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-H/DescendantFonts[ 6 0 R ]/ToUnicode 7 0 R >>');
  ekle(6, '<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Test/DW 0/W[ 3 [' + harfler.map(() => W).join(' ') + ']]>>');
  ekle(7, '<</Filter/FlateDecode/Length ' + cmap.length + '>>', cmap);
  parts.push(bin('trailer<</Root 1 0 R>>\n%%EOF'));
  return new Uint8Array(Buffer.concat(parts));
}

test('Ters çevrilmiş sayfa yukarıdan aşağı okunur; kaydırılmış sözcük parçaları birleşir', async () => {
  // Yazı boyu 20, harf 0,5 em → yazı uzayında harf başına 10 birim. "Li" 20 birim sürer.
  const pdf = tersPdf([
    ['Fatura No: ABC2026000000001', 40, 100],
    ['Toprak 40 Li', 40, 200], ['tr', 160, 200], ['e', 180, 200],   // bitişik: tek sözcük
    ['Ödenecek Tutar', 40, 300], ['1.200,00 TL', 400, 300]            // uzak: ayrı sütun
  ]);
  const r = await readPdf(pdf, {name: 'ters.pdf'});
  assert.equal(r.textLayer, true, r.warnings.join(' '));
  assert.deepEqual(r.lines, ['Fatura No: ABC2026000000001', 'Toprak 40 Litre', 'Ödenecek Tutar 1.200,00 TL'],
    'satır sırası sayfadaki gibi; parçalar birleşti, sütunlar ayrı kaldı');
});

// Birleşik belgenin bir sayfası: satıcı bloku, alıcı bloku (SAYIN), tablo, toplamlar.
const krkSayfa = (no, tarih) => [
  'ÖRNEK TORF SANAYİ VE TİCARET LİMİTED ŞİRKETİ', 'VKN: 5555555555',
  'SAYIN', 'ÖRNEK ALICI TİCARET', 'LİMİTED ŞİRKETİ',
  'Fatura No: ' + no, 'Fatura Tarihi: ' + tarih, 'VKN: 1234567890 Düzenleme Tarihi: ' + tarih,
  'ETTN: 45f1674a-8c87-4026-bfd7-6c5c3f676837',
  'Sıra İskonto İskonto KDV', 'Mal Hizmet Miktar Birim Fiyat KDV Tutarı Diğer Vergiler Mal Hizmet Tutarı', 'No Oranı Tutarı Oranı',
  'Torf 20 Litre Genel', '1 4 Adet 190,00 TL %20,00 152,00 TL 760,00 TL', 'Kullanım Torfu',
  'Torf 40 Litre Genel', '2 4 Adet 300,00 TL %20,00 240,00 TL 1.200,00 TL', 'Kullanım Torfu',
  'Mal Hizmet Toplam Tutarı 1.960,00 TL', 'Hesaplanan KDV(%20.00) 392,00 TL', 'Ödenecek Tutar 2.352,00 TL'];

test('Kendi VKN\'miz tedarikçi sanılmaz; alıcı olarak ayrılır', () => {
  const h = guessHeader(krkSayfa('ORN2026000000001', '16-09-2026'), OWN);
  assert.equal(h.supplier_tax_id, '5555555555');
  assert.equal(h.receiver_tax_id, '1234567890');
  assert.equal(h.supplier_name, 'ÖRNEK TORF SANAYİ VE TİCARET LİMİTED ŞİRKETİ', 'bizim unvan satırı ("LİMİTED ŞİRKETİ") seçilmedi');
  assert.deepEqual(h.uncertain, []);
  // Kendi numaramız bilinmese de belge sırası doğruysa ilk VKN satıcınındır, ama iki VKN
  // olduğu için "kontrol et" işaretlenir: otomatik işlenmez.
  assert.ok(guessHeader(krkSayfa('ORN2026000000001', '16-09-2026')).uncertain.includes('supplier_tax_id'));
});

test('Faturayı biz kesmişsek (satış faturası) alış tedarikçisi çıkarılmaz', () => {
  const satis = ['Örnek Alıcı Ticaret Limited Şirketi', 'VKN: 1234567890', 'SAYIN', 'Bir Müşteri', 'TCKN: 11111111111',
    'Fatura No: ARV2026000000001', 'Fatura Tarihi: 13-08-2026'];
  const h = guessHeader(satis, OWN);
  assert.equal(h.own_issued, true);
  assert.equal(h.supplier_tax_id, '', 'genel tüketici numarası 11111111111 tedarikçi yapılmadı');
});

test('Aralıklı ve yumuşak tireli tarih okunur', () => {
  assert.equal(guessHeader(['Fatura Tarihi: 15 - 09 - 2026']).invoice_date, '2026-09-15');
  assert.equal(guessHeader(['Fatura Tarihi: 15 ­ 09 ­ 2026']).invoice_date, '2026-09-15');
});

test('Sıra+miktar ile başlayan kalem, üst/alt satırdaki açıklamasıyla okunur; KDV ile tutar karışmaz', () => {
  const lines = guessLines(krkSayfa('ORN2026000000001', '16-09-2026'));
  assert.deepEqual(lines.map(l => [l.description, l.invoice_quantity, l.invoice_unit, l.net, l.tax, l.vat_rate, l.uncertain]), [
    ['Torf 20 Litre Genel Kullanım Torfu', 4, 'adet', 760, 152, 20, []],
    ['Torf 40 Litre Genel Kullanım Torfu', 4, 'adet', 1200, 240, 20, []]
  ]);
  assert.equal(lines[0].external_code, '', 'Ürün Kodu sütunu yoksa açıklamanın ilk sözcüğü kod sanılmaz');
});

test('Ürün kodu ve açıklama sütunlu tablo: KDV komşu satırdan, kod sütundan okunur', () => {
  const sayfa = ['Sıra Birim İskonto İskonto KDV KDV Diğer Mal Hizmet', 'Ürün Kodu Ürün Adı Ürün Açıklama Miktar',
    'No Fiyat Oranı Tutarı Oranı Tutarı Vergiler Tutarı',
    '414,00', '1 TOPRAK3 TOPRAK 10 LT 30 Adet 69 TL %0,00 0,00 TL 2.070,00 TL', '%20,00 TL',
    'GENEL BİTKİ BESİNİ 230,00', '2 B.BESİNİ3 BİTKİ BESİNİ 1000 ML 25 Adet 46 TL %0,00 0,00 TL 1.150,00 TL', '1000 ML %20,00 TL',
    'Mal Hizmet Toplam Tutarı 3.220,00 TL', 'Hesaplanan KDV(%20.0) 644,00 TL'];
  const lines = guessLines(sayfa);
  assert.deepEqual(lines.map(l => [l.external_code, l.description, l.invoice_quantity, l.net, l.tax, l.uncertain]), [
    ['TOPRAK3', 'TOPRAK3 TOPRAK 10 LT', 30, 2070, 414, []],
    ['B.BESİNİ3', 'B.BESİNİ3 BİTKİ BESİNİ 1000 ML / GENEL BİTKİ BESİNİ 1000 ML', 25, 1150, 230, []]
  ], '"10 LT" ürün adında kaldı; "1000 ML %20" satırı kalem sayılmadı');
});

test('Miktar ile birim bitişikse ("72kg") da okunur', () => {
  const sayfa = ['Sıra İskonto İskonto KDV KDV Mal Hizmet', 'Mal Hizmet Açıklama Miktar Birim Fiyat Diğer Vergiler',
    '1.512,00', '1 elyaf 72kg 105TL %0 %20,00 7.560,00 TL', 'TL', 'Mal Hizmet Toplam Tutarı 7.560,00 TL'];
  const [l] = guessLines(sayfa);
  assert.deepEqual([l.description, l.invoice_quantity, l.invoice_unit, l.net, l.tax, l.uncertain], ['elyaf', 72, 'kg', 7560, 1512, []]);
});

test('Satır toplamı belge toplamını tutmazsa hiçbir satır kesin sayılmaz', () => {
  const eksik = krkSayfa('ORN2026000000001', '16-09-2026').filter(l => !l.startsWith('2 4 Adet'));
  const lines = guessLines(eksik);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].uncertain.includes('net'), 'kaçan kalem fark edildi');
});

test('Birleşik belge faturalara ayrılır; her faturanın toplamı kendi sayfasından okunur', () => {
  const g = splitInvoices([krkSayfa('ORN2026000000001', '16-09-2026'), krkSayfa('ORN2026000000002', '15-09-2026')]);
  assert.deepEqual(g.map(x => [x.no, x.sayfalar]), [['ORN2026000000001', [1]], ['ORN2026000000002', [2]]]);
  assert.deepEqual(guessTotals(g[1].satirlar), {net: 1960, tax: 392, gross: 2352});
  assert.equal(guessHeader(g[1].satirlar, OWN).invoice_date, '2026-09-15');
});

// Eski okuyucu belgeyi "taranmış" diye saklamış, hiçbir fatura çıkaramamıştı. Aynı dosya bir
// daha yüklenince "daha önce yüklendi" deniyordu: belge kilitli kalıyordu.
test('Faturası hiç çıkmamış belge yeniden okunur; faturaya bağlanmış belge yine reddedilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 9, 8, 7, 6, 5]);
    const body = {kind: 'pdf', filename: 'birlesik.pdf', sha256: await sha256Hex(bytes), size_bytes: bytes.length, chunk_count: 1, page_count: 5, text_layer: 0};
    const first = await f.ok('/ec/invoices/documents', body);
    await f.ok('/ec/invoices/documents/' + first.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    assert.equal((await f.ok('/ec/invoices/documents/' + first.id + '/seal', {})).status, 'stored');

    const again = await f.ok('/ec/invoices/documents', {...body, text_layer: 1, extracted: {invoices: ['A', 'B']}});
    assert.equal(again.id, first.id, 'aynı belge kaydı kullanıldı; dosya çoğaltılmadı');
    assert.equal(again.reread, true);
    assert.equal(again.duplicate, undefined);
    const doc = await f.ok('/ec/invoices/documents/' + first.id);
    assert.equal(doc.text_layer, 1, 'okunan alanlar yenilendi');
    assert.equal((await f.ok('/ec/invoices/documents/' + first.id + '/seal', {})).status, 'stored', 'mühür bozulmadı');

    // Belgeden bir fatura çıktıktan sonra aynı dosya artık ikinci kez işlenmez.
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Tedarik', tax_id: '9340990552'})).id;
    const inv = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'SNT-9', uuid: '', invoice_date: '2026-09-11',
      currency: 'TRY', source: 'pdf', notes: '', lines: [{description: 'Torf', external_code: '', invoice_quantity: 1,
        invoice_unit: 'adet', net: 100, tax: 20, line_type: 'product'}]})).id;
    await f.ok('/ec/invoices/documents/' + first.id + '/pages', {pages: [{page_no: 1, invoice_id: inv}]});
    const third = await f.ok('/ec/invoices/documents', body);
    assert.equal(third.duplicate, true, 'faturası çıkmış belge yeniden işlenmedi');
  } finally { f.close(); }
});
