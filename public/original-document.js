// ÖZGÜN FATURA BELGESİ. Alış faturasının saklanan PDF'i parça parça alınır (sunucu yalnız yetkili
// kullanıcıya verir) ve yeni sekmede açılır. Belge birden çok faturalıysa ("tüm zamanlar" dökümü)
// yalnız bu faturanın sayfası ayrılır: telefonda da doğru sayfa açılır. Hiçbir kayıt değişmez.
const yukle = (src, ad) => window[ad] ? Promise.resolve(window[ad]) : new Promise((ok, no) => {
  const s = document.createElement('script'); s.src = src; s.dataset.vendor = ad;
  s.onload = () => ok(window[ad]); s.onerror = () => no(new Error('Belge kitaplığı yüklenemedi.'));
  document.head.append(s);
});

export async function openOriginalDocument(belge, parcaGetir) {
  // Pencere tıklama anında açılır; sonradan açılan pencereyi tarayıcı engeller.
  const pencere = window.open('', '_blank');
  if (pencere) pencere.document.title = 'Belge hazırlanıyor…';
  try {
    const parcalar = [];
    for (let i = 0; i < belge.chunk_count; i++) {
      const p = await parcaGetir(i), ham = atob(p.data), u = new Uint8Array(ham.length);
      for (let k = 0; k < ham.length; k++) u[k] = ham.charCodeAt(k);
      parcalar.push(u);
    }
    let bayt = new Uint8Array(parcalar.reduce((t, p) => t + p.length, 0)), o = 0;
    for (const p of parcalar) { bayt.set(p, o); o += p.length; }
    if (belge.page_no && belge.page_count !== 1) {
      const {PDFDocument} = await yukle('/vendor/pdf-lib.min.js', 'PDFLib');
      const kaynak = await PDFDocument.load(bayt, {ignoreEncryption: true}), yeni = await PDFDocument.create();
      const [sayfa] = await yeni.copyPages(kaynak, [belge.page_no - 1]); yeni.addPage(sayfa);
      bayt = await yeni.save();
    }
    const url = URL.createObjectURL(new Blob([bayt], {type: 'application/pdf'}));
    if (pencere && !pencere.closed) pencere.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = belge.filename || 'fatura.pdf'; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) { pencere?.close(); throw e; }
}
