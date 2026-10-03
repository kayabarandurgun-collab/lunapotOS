// FATURA GÖRÜNTÜSÜNDEN YAZI OKUMA (OCR).
//
// NEDEN VAR: 29.09.2026'da canlıdan gelen bir tedarikçi faturasında ölçüldü — PDF'te 16.814 bezier
// eğrisi ve 10.631 çizgi vardı, metin komutu SIFIRDI. Yazı harf olarak değil ÇİZİM olarak gömülmüştü,
// yani çıkarılacak metin yoktu. Taranmış belgede de durum aynıdır.
//
// BU TESTLERİN ASIL DERDİ: modelin okuduğu hiçbir şeyin sessizce deftere girmemesi ve model
// saçmalarsa uydurma metin dönmemesi. Modelin OKUMA KALİTESİ burada ölçülemez; o ancak gerçek
// belgeyle, yayına çıktıktan sonra ölçülür.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {scopedDB} from '../src/scoped-db.js';
import {purchaseDocumentApi} from '../src/purchase-document-api.js';

function fixture(ai) {
  const s = new DatabaseSync(':memory:');
  s.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    s.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      return {args: [], bind(...a) { this.args = a; return this; },
        first() { return s.prepare(sql).get(...this.args) || null; },
        all() { return {results: s.prepare(sql).all(...this.args)}; },
        run() { return s.prepare(sql).run(...this.args); }};
    },
    async batch(items) { s.exec('BEGIN'); try { const r = items.map(i => i.all()); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; } }
  };
  const env = {DB: scopedDB(DB, 'ec'), ROOT_DB: DB, WORKSPACE: 'ec'};
  if (ai) env.AI = ai;
  env.OCR_TIMEOUT_MS = 300;   // testte askida kalmayi 300 ms'de olcuyoruz
  const ocr = body => purchaseDocumentApi(
    new Request('https://test.local/api/invoices/documents/ocr', {method: 'POST'}),
    env, '/api/invoices/documents/ocr', async () => body);
  const doc = body => purchaseDocumentApi(
    new Request('https://test.local/api/invoices/documents', {method: 'POST'}),
    env, '/api/invoices/documents', async () => body);
  return {s, ocr, doc, close: () => s.close()};
}
const img = (kb = 1) => 'A'.repeat(Math.ceil(kb * 1024 * 4 / 3));

test('OCR ucu: model kapaliysa, sayfa yoksa ve sinirlar asilirsa yazi okunmaz', async () => {
  const kapali = fixture(null);
  try {
    await assert.rejects(kapali.ocr({images: [img()]}), /açık değil/);
  } finally { kapali.close(); }

  const f = fixture({run: async () => ({response: 'x'})});
  try {
    await assert.rejects(f.ocr({}), /gönderilmedi/);
    await assert.rejects(f.ocr({images: []}), /gönderilmedi/);
    await assert.rejects(f.ocr({images: Array(9).fill(img())}), /en fazla 8 sayfa/);
    // Sayfa basina 600 KB cozulmus bayt tavan: sunucunun govde siniri 1.000.000 karakter ve
    // base64 4/3 buyutuyor. Istemci sigmazsa goruntuyu kademeli kucultur.
    await assert.rejects(f.ocr({images: [img(700)]}), /çok büyük/);
    await assert.rejects(f.ocr({images: Array(3).fill(img(500))}), /toplam boyutu/);
    // Sinirin altindaki sayfa gecer.
    assert.ok((await f.ocr({images: [img(500)]})).text);
    await assert.rejects(f.ocr({images: ['bu base64 degil!!']}), /geçersiz/);
  } finally { f.close(); }
});

test('OCR ucu: yanit alani hangi adla gelirse gelsin okunur', async () => {
  // Alan adini bilmemek yuzunden OKUNMUS sayfayi cope atmak canlida yasandi (30.09.2026):
  // model cevap verdi, uc "yazi bulunamadi" dedi. Artik bilinen alanlar once, sonra derin arama.
  const beklenen = 'AGROMART\nFatura No: ABC123\nTOPLAM 1.234,56';
  for (const donen of [{description: beklenen}, {answer: beklenen}, {response: beklenen}, {text: beklenen},
    {result: {response: beklenen}}, {choices: [{message: {content: beklenen}}]},
    {bilinmeyen_alan: beklenen}, {sarmal: {ic: {bir_yerde: beklenen}}}, beklenen]) {
    const f = fixture({run: async () => donen});
    try { assert.match((await f.ocr({images: [img()]})).text, /Fatura No: ABC123/, JSON.stringify(donen).slice(0, 60)); }
    finally { f.close(); }
  }
});

test('OCR ucu: model bos ya da anlamsiz donerse METIN UYDURULMAZ ve yanitin sekli soylenir', async () => {
  for (const donen of [{response: ''}, {response: '   '}, {}, {choices: []}, null]) {
    const f = fixture({run: async () => donen});
    try { await assert.rejects(f.ocr({images: [img()]}), /okunabilir yazı bulamadı/); } finally { f.close(); }
  }
  // Tanimadigim bir sekil gelirse hata mesaji NE GELDIGINI yazar; kor kalmayalim.
  const tuhaf = fixture({run: async () => ({durum: 'hata', kod: 500})});
  try { await assert.rejects(tuhaf.ocr({images: [img()]}), /Modelin yanıtı:.*durum/s); } finally { tuhaf.close(); }
  const patlayan = fixture({run: async () => { throw new Error('model mesgul'); }});
  try { await assert.rejects(patlayan.ocr({images: [img()]}), /Görüntü okunamadı/); } finally { patlayan.close(); }
});

test('OCR ucu: sayfalar modele goruntu olarak gider, yalniz duz metin doner ve alan tahmini YAPILMAZ', async () => {
  const cagrilar = [];
  const f = fixture({run: async (model, girdi) => { cagrilar.push({model, girdi}); return {description: 'AGROMART\nFatura No: ABC123\nTOPLAM 1.234,56'}; }});
  try {
    const r = await f.ocr({images: [img(), img()]});
    assert.equal(r.pages, 2);
    assert.match(r.text, /Fatura No: ABC123/);
    assert.equal(r.model, '@cf/moondream/moondream3.1-9B-A2B');
    assert.match(r.notice, /harf hatası olabilir/);
    // UC ALAN TAHMINI YAPMAZ: fatura no / tarih / VKN cikarimi istemcide yapilir ve
    // ekranda "kontrol et" isaretiyle gelir. Sunucu tahmin donerse bu sessizce deftere girerdi.
    for (const alan of ['invoice_no', 'invoice_date', 'tax_id', 'lines', 'total_cents'])
      assert.equal(alan in r, false, alan + ' ucta tahmin edilmemeli');

    // Moondream TEK goruntu okur: iki sayfa = iki cagri, metinler birlestirilir.
    assert.equal(cagrilar.length, 2, 'her sayfa icin ayri cagri');
    for (const c of cagrilar) {
      assert.ok(c.girdi.image.startsWith('data:image/jpeg;base64,'), 'goruntu base64 data URI olarak gider');
      assert.match(c.girdi.question, /not invent anything/i, 'uydurma yasagi soruda');
      assert.equal(c.girdi.temperature, 0, 'okuma isinde rastgelelik olmamali');
      assert.equal(c.girdi.reasoning, false, 'model ozetlemesin, doksun');
      assert.equal(c.girdi.task, 'query');
      // PROMPT'TA ORNEK RAKAM OLMAZ. Canlida (30.09.2026) prompt'taki "1.234,56" ornegi modelin
      // yanitinda cikti: komutun kendisi uydurma kaynagi oldu. Bir daha sizmasin.
      assert.equal(/\d{1,3}[.,]\d{3}[.,]\d{2}/.test(c.girdi.question), false, 'promptta ornek tutar olmamali');
    }
  } finally { f.close(); }
});

test('OCR ucu: model askida kalirsa istek sonsuza kadar beklemez', async () => {
  // Canlida (30.09.2026) yanlis girdi semasiyla cagrilan model dakikalarca cevap vermedi ve
  // kullanici "Isleniyor..." ekraninda kilitli kaldi. Artik sure dolunca acik hata doner.
  const f = fixture({run: () => new Promise(() => {})});   // hic cozulmeyen soz
  try {
    const basla = Date.now();
    await assert.rejects(f.ocr({images: [img()]}), /yanıt vermedi|okunamadı/);
    assert.ok(Date.now() - basla < 5000, 'zaman asimi devrede');
  } finally { f.close(); }
});

test('Goruntuden okunan belgede VKN tek harf hatasiyla gelse de tedarikci numarasi bulunur', async () => {
  // Canlida (03.10.2026): model saticinin "VKN"ini "WKN" okudu, ayiklayici tanimadi ve ekran
  // "Tedarikci VKN okunamadi" dedi. Alicinin VKN'i duzgun okundugu icin tek bulunan o oldu.
  const {guessHeader} = await import('../public/pdf-read.js');
  const satirlar = ['KARAKUS AKSESUAR SANAYI VE TICARET LIMITED SIRKETI', 'WKN: 5166070631',
    'SAYIN', 'DEKOVIL MIMARLIK INSAAT', 'VKN: 2731455087'];
  const h = guessHeader(satirlar, {taxIds: ['2731455087'], name: 'Dekovil'});
  assert.equal(h.supplier_tax_id, '5166070631', 'satici numarasi WKN yazsa da bulunmali');
  assert.equal(h.receiver_tax_id, '2731455087', 'alici bizim numaramiz');
  // RAKAM SARTI GEVSEMEDI: harf toleransi sayi uydurmaya kapi acmamali.
  const bos = guessHeader(['WKN: 12345', 'VKN: abcdefghij'], {taxIds: [], name: ''});
  assert.equal(bos.supplier_tax_id, '', 'eksik haneli numara kabul edilmez');
});

test('Goruntuden okunan tutarda binlik ayraci virgul cikarsa sayi dogru okunur', async () => {
  // Canlida (03.10.2026): model 2.850,00'i "2,850,00" yazdi, satir tutari 0 okundu ve 15 adetlik
  // kalem bedava gorundu. Turkce yazimda bir sayida IKI virgul olmaz; sonuncusu ondalik sayilir.
  const {guessLines} = await import('../public/pdf-read.js');
  const satir = guessLines(['1 Gartengold 20 Litre Torfu 15 Adet 190,00 TL 570,00 TL 2,850,00 TL']);
  assert.equal(satir.length, 1);
  assert.equal(satir[0].net, 2850, 'bozuk binlik ayraci duzeltilmeli');
  // NOKTALI SAYIYA DOKUNULMAZ: dogru yazilmis tutar bozulmamali.
  assert.equal(guessLines(['2 Urun 1 Adet 1.234,56 TL 1.234,56 TL'])[0].net, 1234.56);
  // TEK VIRGULLU ONDALIK aynen kalir.
  assert.equal(guessLines(['3 Urun 1 Adet 165,00 TL 165,00 TL'])[0].net, 165);
});

test('Fatura numarasi tedarikcinin kalibindan sapiyorsa SOYLENIR ama degistirilmez', async () => {
  // Canlida (03.10.2026): goruntuden "KRK20260000009027" okundu (17 karakter); o tedarikcinin
  // butun faturalari 16 karakter. Yanlis ama duzgun gorunen bir numara sessizce deftere girerdi.
  const f = fixture(null);
  try {
    f.s.exec("INSERT INTO ec_suppliers(id,name,tax_id) VALUES('s1','KARAKUS','5160067031')");
    for (const [n, t] of [['KRK2026000000900', '2026-09-24'], ['KRK2026000000886', '2026-09-22'], ['KRK2026000000874', '2026-09-17']])
      f.s.prepare("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date,currency,status) VALUES(?,?,?,?,'TRY','draft')").run('i' + n, 's1', n, t);
    const belge = (ek = {}) => f.doc({kind: 'pdf', filename: 'k.pdf', sha256: 'a'.repeat(64), size_bytes: 10, chunk_count: 1,
      supplier_tax_id: '5160067031', text_layer: 0, ...ek});
    const sapan = await belge({doc_no: 'KRK20260000009027', sha256: 'b'.repeat(64)});
    assert.match(sapan.format_warning, /FARKLI biçimde/, 'sapma soylenmeli');
    assert.match(sapan.format_warning, /16 karakter, bu 17 karakter/, 'kac hane oldugu yazilmali');
    // NUMARA DEGISTIRILMEZ: uydurma duzeltme yapilmaz, yalniz bildirilir.
    assert.ok(sapan.id, 'belge yine kaydedilir, is durmaz');
    const uyan = await belge({doc_no: 'KRK2026000000911', sha256: 'c'.repeat(64)});
    assert.equal(uyan.format_warning, '', 'kalibá uyan numarada uyari olmaz');
  } finally { f.close(); }
});
