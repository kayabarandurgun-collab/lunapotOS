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
  const ocr = body => purchaseDocumentApi(
    new Request('https://test.local/api/invoices/documents/ocr', {method: 'POST'}),
    env, '/api/invoices/documents/ocr', async () => body);
  return {s, ocr, close: () => s.close()};
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

test('OCR ucu: model bos ya da anlamsiz donerse METIN UYDURULMAZ', async () => {
  for (const donen of [{response: ''}, {response: '   '}, {}, {choices: []}, null]) {
    const f = fixture({run: async () => donen});
    try { await assert.rejects(f.ocr({images: [img()]}), /okunabilir yazı bulamadı/); } finally { f.close(); }
  }
  const patlayan = fixture({run: async () => { throw new Error('model mesgul'); }});
  try { await assert.rejects(patlayan.ocr({images: [img()]}), /Görüntü okunamadı/); } finally { patlayan.close(); }
});

test('OCR ucu: sayfalar modele goruntu olarak gider, yalniz duz metin doner ve alan tahmini YAPILMAZ', async () => {
  let gonderilen = null;
  const f = fixture({run: async (model, girdi) => { gonderilen = {model, girdi}; return {response: 'AGROMART\nFatura No: ABC123\nTOPLAM 1.234,56'}; }});
  try {
    const r = await f.ocr({images: [img(), img()]});
    assert.equal(r.pages, 2);
    assert.match(r.text, /Fatura No: ABC123/);
    assert.equal(r.model, '@cf/google/gemma-4-26b-a4b-it');
    assert.match(r.notice, /harf hatası olabilir/);
    // UC ALAN TAHMINI YAPMAZ: fatura no / tarih / VKN cikarimi istemcide yapilir ve
    // ekranda "kontrol et" isaretiyle gelir. Sunucu tahmin donerse bu sessizce deftere girerdi.
    for (const alan of ['invoice_no', 'invoice_date', 'tax_id', 'lines', 'total_cents'])
      assert.equal(alan in r, false, alan + ' ucta tahmin edilmemeli');

    const icerik = gonderilen.girdi.messages[0].content;
    assert.equal(icerik.filter(c => c.type === 'image_url').length, 2, 'iki sayfa da modele gitti');
    assert.ok(icerik[0].text.includes('HİÇBİR ŞEY UYDURMA'), 'uydurma yasagi prompt\'ta');
    assert.ok(icerik[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.equal(gonderilen.girdi.temperature, 0, 'okuma isinde rastgelelik olmamali');
  } finally { f.close(); }
});
