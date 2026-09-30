// HARF TAŞIMAYAN PDF'İ GÖRÜNTÜDEN OKUMA.
//
// NEDEN: bazı fatura PDF'lerinde çıkarılacak metin YOKTUR. 29.09.2026'da canlıdan gelen bir
// tedarikçi faturasında ölçüldü — 16.814 bezier eğrisi, 10.631 çizgi, metin komutu SIFIR: yazı
// harf olarak değil ÇİZİM olarak gömülmüştü. Taranmış/fotoğraflanmış belgede de durum aynıdır.
// Gömülü görüntüleri çıkarmak YETMEZ (o dosyada çıkanlar yalnız logolardı); sayfanın kendisi
// çizimden resme çevrilmeli. pdf.js bunu tarayıcıda yapar.
//
// SINIR: buradan çıkan her şey ADAYDIR. Okunan metin doğrudan guessHeader/guessLines'a verilir ve
// bütün kimlik alanları "kontrol et" işaretlenir; kullanıcı onaylamadan hiçbir tutar kaydedilmez.
const SAYFA_SINIRI = 8;      // sunucudaki MAX_OCR_PAGES ile aynı olmalı
const EN_UZUN_KENAR = 2000;  // OCR için yeterli çözünürlük; daha büyüğü boyut sınırını zorlar
const JPEG_KALITE = 0.85;

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

/** PDF sayfalarını JPEG'e çevirir; base64 dizisi döndürür (data: öneki YOK, sunucu öyle bekliyor). */
export async function sayfalariResmeCevir(bytes, {sayfaSiniri = SAYFA_SINIRI, ilerleme} = {}) {
  const pdfjs = await pdfjsYukle();
  // Kopya veriliyor: pdf.js gelen tamponu devralıp boşaltıyor, aynı baytlar sonra da lazım.
  const belge = await pdfjs.getDocument({data: bytes.slice(), isEvalSupported: false}).promise;
  const sayfalar = [];
  try {
    const adet = Math.min(belge.numPages, sayfaSiniri);
    for (let i = 1; i <= adet; i++) {
      if (ilerleme) ilerleme(i, adet);
      const sayfa = await belge.getPage(i);
      const ilk = sayfa.getViewport({scale: 1});
      const olcek = Math.max(0.5, Math.min(EN_UZUN_KENAR / Math.max(ilk.width, ilk.height), 3));
      const viewport = sayfa.getViewport({scale: olcek});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      // ZEMİN BEYAZ: saydam zemin JPEG'e çevrilince siyah olur ve yazı okunmaz hâle gelir.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await sayfa.render({canvasContext: ctx, viewport}).promise;
      sayfalar.push(await canvasBase64(canvas, JPEG_KALITE));
      canvas.width = canvas.height = 0;   // bellek hemen bırakılsın
      sayfa.cleanup();
    }
  } finally { await belge.destroy().catch(() => {}); }
  return sayfalar;
}

/**
 * Harf taşımayan PDF'i görüntüden okur. Başarısızlıkta null döner ve ÇAĞIRAN AKIŞ BOZULMAZ:
 * kullanıcı belgeyi ekranda görüp elle girmeye devam edebilir.
 */
export async function ocrIleOku(bytes, api, {ilerleme} = {}) {
  let sayfalar;
  try { sayfalar = await sayfalariResmeCevir(bytes, {ilerleme}); }
  catch (e) { return {hata: 'Sayfa görüntüye çevrilemedi: ' + (e.message || 'bilinmeyen hata')}; }
  if (!sayfalar.length) return {hata: 'PDF sayfası bulunamadı.'};
  let sonuc;
  try { sonuc = await api('/invoices/documents/ocr', {images: sayfalar}); }
  catch (e) { return {hata: e.message || 'Görüntüden yazı okunamadı.'}; }
  const lines = String(sonuc.text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return {hata: 'Görüntüde okunabilir yazı bulunamadı.'};
  return {lines, pages: sonuc.pages, notice: sonuc.notice};
}
