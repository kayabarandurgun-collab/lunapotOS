// HARF TAŞIMAYAN PDF'İ GÖRÜNTÜDEN OKUMA.
//
// NEDEN: bazı fatura PDF'lerinde çıkarılacak metin YOKTUR. 29.09.2026'da canlıdan gelen bir
// tedarikçi faturasında ölçüldü — 16.814 bezier eğrisi, 10.631 çizgi, metin komutu SIFIR: yazı
// harf olarak değil ÇİZİM olarak gömülmüştü. Taranmış/fotoğraflanmış belgede de durum aynıdır.
// Gömülü görüntüleri çıkarmak YETMEZ (o dosyada çıkanlar yalnız logolardı); sayfanın kendisi
// resme çevrilmeli. pdf.js bunu tarayıcıda yapar.
//
// SAYFALAR TEK TEK GÖNDERİLİR: sunucunun gövde sınırı 1.000.000 karakterdir (worker.js bodyLimit).
// Hepsini tek istekte yollamak canlıda "İstek çok büyük" hatası verdi (30.09.2026).
//
// SINIR: buradan çıkan her şey ADAYDIR. Okunan metin guessHeader/guessLines'a verilir ve bütün
// kimlik alanları "kontrol et" işaretlenir; kullanıcı onaylamadan hiçbir tutar kaydedilmez.
const SAYFA_SINIRI = 8;
// Sunucu sayfa başına 600 KB ÇÖZÜLMÜŞ bayt kabul ediyor; base64 4/3 büyüttüğü için tavan budur.
// Pay bırakılıyor: JSON sarmalı ve çok baytlı karakter payı.
const BASE64_TAVAN = 780 * 1024;
// Sığmazsa sırayla küçültülür. Okunabilirlik önce gelir; en küçük kademe son çaredir.
// Fatura yazısı küçüktür: ilk kademe ÇÖZÜNÜRLÜĞÜ yüksek tutar, boyut sınırına sığmazsa düşülür.
// 1700 px'te model yalnız birkaç rakam okuyabildi; ince baskı için daha fazlası gerekiyor.
const KADEMELER = [{kenar: 2400, kalite: 0.78}, {kenar: 1900, kalite: 0.7}, {kenar: 1400, kalite: 0.6}, {kenar: 1000, kalite: 0.5}];

let pdfjsSoz = null;
// Kütüphane ancak GEREKTİĞİNDE yüklenir: harf taşıyan normal faturada 1,7 MB indirilmez.
function pdfjsYukle() {
  if (!pdfjsSoz) pdfjsSoz = import('./vendor/pdf.min.mjs').then(mod => {
    mod.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
    return mod;
  });
  return pdfjsSoz;
}

function canvasBase64(canvas, kalite) {
  return new Promise((tamam, hata) => canvas.toBlob(async blob => {
    if (!blob) return hata(new Error('Sayfa görüntüye çevrilemedi.'));
    const bayt = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bayt.length; i += 0x8000) s += String.fromCharCode.apply(null, bayt.subarray(i, i + 0x8000));
    tamam(btoa(s));
  }, 'image/jpeg', kalite));
}

async function kademeyleCiz(sayfa, kenar, kalite) {
  const ilk = sayfa.getViewport({scale: 1});
  const olcek = Math.max(0.3, Math.min(kenar / Math.max(ilk.width, ilk.height), 3));
  const viewport = sayfa.getViewport({scale: olcek});
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // ZEMİN BEYAZ: saydam zemin JPEG'e çevrilince siyah olur ve yazı okunmaz hâle gelir.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // pdf.js 6'da birincil parametre `canvas`; ikisi de açıkça veriliyor.
  await sayfa.render({canvas, canvasContext: ctx, viewport}).promise;
  const b64 = await canvasBase64(canvas, kalite);
  canvas.width = canvas.height = 0;   // bellek hemen bırakılsın
  return b64;
}

/** Tek sayfayı sunucunun kabul edeceği boyuta sığacak şekilde resme çevirir; sığmazsa null. */
async function sayfayiSigdir(sayfa) {
  let son = null;
  for (const k of KADEMELER) {
    son = await kademeyleCiz(sayfa, k.kenar, k.kalite);
    if (son.length <= BASE64_TAVAN) return son;
  }
  return null;
}

/**
 * Harf taşımayan PDF'i görüntüden okur. Sayfalar TEK TEK gönderilir ve okunan metinler birleştirilir.
 * Başarısızlıkta {hata} döner; ÇAĞIRAN AKIŞ BOZULMAZ, kullanıcı belgeyi görüp elle girer.
 */
export async function ocrIleOku(bytes, api, {ilerleme} = {}) {
  let pdfjs, gorev, belge;
  try {
    pdfjs = await pdfjsYukle();
    // Kopya veriliyor: pdf.js gelen tamponu devralıp boşaltıyor, aynı baytlar sonra da lazım.
    // DESTROY YÜKLEME GÖREVİNDEDİR, belgede değil; belgede yalnız cleanup() var.
    gorev = pdfjs.getDocument({data: bytes.slice(), isEvalSupported: false});
    belge = await gorev.promise;
  } catch (e) { return {hata: 'PDF açılamadı: ' + (e.message || 'bilinmeyen hata') + '.'}; }

  const parcalar = [], atlanan = [];
  let sayfaSayisi = 0;
  try {
    const adet = Math.min(belge.numPages, SAYFA_SINIRI);
    for (let i = 1; i <= adet; i++) {
      if (ilerleme) ilerleme(i, adet);
      let b64;
      try {
        const sayfa = await belge.getPage(i);
        b64 = await sayfayiSigdir(sayfa);
        try { sayfa.cleanup(); } catch { /* temizlik sonucu etkilemez */ }
      } catch (e) { atlanan.push(i + '. sayfa çevrilemedi'); continue; }
      if (!b64) { atlanan.push(i + '. sayfa küçültülse de boyut sınırına sığmadı'); continue; }
      // HER SAYFA KENDİ İSTEĞİNDE: hepsi bir arada gövde sınırını aşıyordu.
      try {
        const sonuc = await api('/invoices/documents/ocr', {images: [b64]});
        const metin = String(sonuc.text || '').trim();
        if (metin) { parcalar.push(metin); sayfaSayisi++; }
      } catch (e) { atlanan.push(i + '. sayfa okunamadı (' + (e.message || 'model yanıt vermedi') + ')'); }
    }
  } finally {
    // TEMİZLİK SONUCU ASLA DÜŞÜRMEZ: buradaki bir hata, okunmuş sayfaları çöpe atardı.
    try { await gorev.destroy(); } catch { /* yok sayılır */ }
  }

  // MODEL MARKDOWN TABLOSU YAZABİLİYOR ("| 1 | Gartengold ... |") ve prompt'taki yasağa
  // uymuyor. Tutarlar borulu hâlde de doğru ayrışıyor ama ÜRÜN ADINA boru işaretleri karışıyor;
  // bu ad geçmiş alışlarla eşleştirmede kullanıldığı için temizlenmeli. Ayırıcı satır ("|---|")
  // büsbütün atılır. Sütun arası iki boşluğa çevrilir: tek boşluk kolon sınırını kaybettiriyor.
  const ayiriciSatir = s => /^\s*\|?[\s|:-]*\|[\s|:-]*$/.test(s);
  const lines = parcalar.join('\n').split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !ayiriciSatir(s))
    .map(s => s.includes('|')
      ? s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, '  ').replace(/\s{3,}/g, '  ').trim()
      : s)
    .filter(Boolean);
  if (!lines.length) return {hata: (atlanan[0] || 'Görüntüde okunabilir yazı bulunamadı') + '.'};
  return {lines, pages: sayfaSayisi,
    notice: 'Bu yazı bir modelin GÖRÜNTÜDEN okumasıdır; harf hatası olabilir. Her alanı belgeyle karşılaştırın.'
      + (atlanan.length ? ' Atlanan: ' + atlanan.join('; ') + '.' : '')};
}
