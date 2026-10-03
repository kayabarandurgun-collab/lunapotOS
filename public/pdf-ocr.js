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
// Fatura no, tarih ve ETTN sayfanın üst kısmındadır. Bu oran kadarı ayrıca ve büyütülmüş okunur.
const UST_BOLGE_ORANI = 0.42;

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

// oran < 1 ise sayfanın yalnız ÜST bölgesi çizilir: tuval kısa tutulur, gerisi kırpılır.
// Aynı bayt bütçesi dar bir alana harcandığı için yazı büyür ve ince baskı okunur hâle gelir.
async function kademeyleCiz(sayfa, kenar, kalite, oran = 1) {
  const ilk = sayfa.getViewport({scale: 1});
  // Üst bölgede ölçek GENİŞLİĞE göre: yükseklik kırpıldığı için uzun kenara bakmak ölçeği düşürürdü.
  const taban = oran < 1 ? ilk.width : Math.max(ilk.width, ilk.height);
  const olcek = Math.max(0.3, Math.min(kenar / taban, 4));
  const viewport = sayfa.getViewport({scale: olcek});
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height * oran);
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

/** Sayfayı (ya da üst bölgesini) sunucunun kabul edeceği boyuta sığdırır; sığmazsa null. */
async function sayfayiSigdir(sayfa, oran = 1) {
  let son = null;
  for (const k of KADEMELER) {
    son = await kademeyleCiz(sayfa, k.kenar, k.kalite, oran);
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
      let b64, ustB64 = null;
      try {
        const sayfa = await belge.getPage(i);
        b64 = await sayfayiSigdir(sayfa);
        // FATURA NO VE TARİH SAYFANIN ÜSTÜNDE, İNCE BASKIDIR. Tam sayfa 2400 px'e sığdırılınca
        // model o köşeyi hiç okuyamadı (canlıda 03.10.2026, üst üste üç deneme). Bu yüzden İLK
        // SAYFANIN ÜST BÖLGESİ ayrıca ve büyütülmüş olarak okunur. Modele yeni bir SORU
        // sorulmuyor — aynı "olduğu gibi yaz" işi, yalnız daha büyük yazıyla; uydurma riski artmaz.
        if (i === 1) ustB64 = await sayfayiSigdir(sayfa, UST_BOLGE_ORANI);
        try { sayfa.cleanup(); } catch { /* temizlik sonucu etkilemez */ }
      } catch (e) { atlanan.push(i + '. sayfa çevrilemedi'); continue; }
      if (!b64) { atlanan.push(i + '. sayfa küçültülse de boyut sınırına sığmadı'); continue; }
      // HER GÖRÜNTÜ KENDİ İSTEĞİNDE: hepsi bir arada gövde sınırını aşıyordu.
      // Üst bölge ÖNCE eklenir: guessHeader ilk eşleşmeyi aldığı için net okunan hâli kazansın.
      if (ustB64) {
        try {
          const ust = await api('/invoices/documents/ocr', {images: [ustB64]});
          const ustMetin = String(ust.text || '').trim();
          if (ustMetin) parcalar.push(ustMetin);
        } catch (e) { atlanan.push('üst bölge okunamadı (' + (e.message || 'model yanıt vermedi') + ')'); }
      }
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
