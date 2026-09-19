// KAÇA SATMALIYIM? Ürün, kanal, adet → gerçek geçmiş kesintilerle cebine kalan, başabaş ve hedef fiyat.
// Sunucu: src/fiyat-hesap-api.js. Tutarlar KDV dahildir. Girdi değiştikçe kendiliğinden hesaplar.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const tl = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(v / 100);
const yuzde = v => v === null || v === undefined ? '—' : '%' + new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 2}).format(v * 100);
// Tutar yetkisi kapalı personelde para alanları null gelir: "0,00 TL" değil "—" gösterilir.
const eksi = v => v ? -v : v;

export function mountFiyatHesap(root, products) {
  const abort = new AbortController();
  const state = {kanal: 'trendyol', seq: 0};
  root.innerHTML = `<section class="v2-card fh-card">
    <div class="v2-card-head"><div><h2>Kaça satmalıyım?</h2><p>Son alış maliyeti ve benzer teslimlerin kesintileriyle satış fiyatını tahmin et. Tüm tutarlar KDV dahil.</p></div></div>
    <form class="fh-form" data-fh>
      <label class="fh-urun">Ürün<select name="product_id" required><option value="">Ürün seçin…</option>${products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="fh-kanal"><span>Kanal</span><div class="ol-seg" role="group" aria-label="Kanal">${[['trendyol', 'Trendyol'], ['hepsiburada', 'Hepsiburada']].map(([v, l]) => `<button type="button" data-fh-kanal="${v}" aria-pressed="${v === state.kanal}">${l}</button>`).join('')}</div></div>
      <label>Paketteki adet<input name="qty" type="number" min="1" max="100" step="1" value="1" inputmode="numeric"></label>
      <label>Satış fiyatı · KDV dahil (TL)<input name="price" inputmode="decimal" placeholder="örn. 240" autocomplete="off"></label>
      <label>Cebine kalsın istediğin (TL)<input name="target" inputmode="decimal" placeholder="örn. 30" autocomplete="off"></label>
    </form>
    <div class="fh-sonuc" data-fh-sonuc aria-live="polite"><div class="v2-empty"><h3>Ürünü ve kanalı seç.</h3><p>Fiyat yazarsan cebine ne kalacağını, yazmasan da zarar etmemek için en düşük fiyatı gösterir.</p></div></div>
  </section>`;
  const form = root.querySelector('[data-fh]'), sonuc = root.querySelector('[data-fh-sonuc]');
  let zaman = null;
  async function hesapla() {
    const f = Object.fromEntries(new FormData(form));
    const seq = ++state.seq;
    if (!f.product_id) { sonuc.removeAttribute('aria-busy'); sonuc.innerHTML = '<div class="v2-empty"><h3>Ürünü ve kanalı seç.</h3><p>Satış fiyatı veya hedef kâr ekleyerek tahminini görebilirsin.</p></div>'; return; }
    if (!form.reportValidity()) { sonuc.removeAttribute('aria-busy'); sonuc.innerHTML = '<p class="notice">Hesaplamak için işaretli alanları düzelt.</p>'; return; }
    sonuc.innerHTML = '<p class="loading" role="status">Fiyat tahmini hesaplanıyor…</p>';
    sonuc.setAttribute('aria-busy', 'true');
    try {
      const r = await fetch('/api/ec/fiyat-hesap?' + new URLSearchParams({product_id: f.product_id, channel: state.kanal, qty: f.qty || 1, price: f.price || '', target: f.target || ''}), {signal: abort.signal});
      const d = await r.json();
      if (seq !== state.seq) return;
      if (!r.ok) { sonuc.innerHTML = `<div class="notice">${esc(d.error || 'Hesaplanamadı.')}</div>`; return; }
      sonuc.innerHTML = cizim(d);
    } catch (e) { if (e.name !== 'AbortError' && seq === state.seq) sonuc.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
    finally { if (seq === state.seq) sonuc.removeAttribute('aria-busy'); }
  }
  function cizim(d) {
    // Adet uyumu yoksa sunucu kesin fiyat vermez; aynı hesap etiketli senaryo olarak gelir (guven: belirsiz).
    const sen = d.senaryo;
    if (sen) d = {...d, fiyatla: sen.fiyatla, basabas: sen.basabas, hedef: sen.hedef};
    const k = d.kesinti, satir = (etiket, v, not = '') => `<tr><th scope="row">${esc(etiket)}${not ? `<small>${esc(not)}</small>` : ''}</th><td>${tl(v)}</td></tr>`;
    const dokum = x => `<table class="fh-dokum" data-list-tools="off"><tbody>${satir('Satış fiyatı', x.fiyat)}${satir('Ürün maliyeti', eksi(x.maliyet), d.qty + ' adet × ' + tl(d.urun.birim_maliyet_kdv_dahil) + ' (son alış)')}${satir('Kargo', eksi(x.kargo))}${satir('Hizmet bedeli', eksi(x.hizmet), 'pazaryeri')}${satir('Komisyon', eksi(x.komisyon), yuzde(k.komisyon_orani) + ' (KDV hariç satışa)')}${x.stopaj ? satir('Stopaj', -x.stopaj, 'yıllık vergiden mahsup edilir') : ''}${x.paketleme !== undefined ? satir('Ambalaj', eksi(x.paketleme), 'ürün profili · paket başına') + satir('Diğer paket gideri', eksi(x.diger), 'ürün profili · paket başına') : ''}<tr class="fh-toplam"><th scope="row">Cebine kalan</th><td class="${x.cebine < 0 ? 'ol-neg' : 'ol-pos'}">${tl(x.cebine)}</td></tr></tbody></table>`;
    const f = d.fiyatla;
    return `${d.uyari ? `<div class="notice" role="note"><strong>Kesin fiyat değil.</strong> ${esc(d.uyari)}</div>` : ''}<div class="fh-kartlar">
      ${f ? `<article class="fh-kart ${f.cebine < 0 ? 'zarar' : 'kar'}"><span>${tl(f.fiyat)} fiyata satarsan cebine kalan</span><strong>${tl(f.cebine)}</strong>${d.qty > 1 ? `<small>Adet başı ${tl(f.cebine === null ? null : Math.round(f.cebine / d.qty))}</small>` : ''}</article>` : ''}
      ${d.basabas ? `<article class="fh-kart"><span>${sen ? 'Senaryo · zarar etmeme sınırı' : 'Zarar etmemek için en az'}</span><strong>${tl(d.basabas.fiyat)}</strong><small>${sen ? esc(sen.aciklama) : 'Geçmiş kesintilere göre tahmini alt sınır'}</small></article>` : ''}
      ${d.hedef ? `<article class="fh-kart hedef"><span>Cebine ${tl(d.hedef.istenen)} kalması için</span><strong>${tl(d.hedef.fiyat)}</strong><small>${sen ? esc(sen.aciklama) : 'Hedefin için tahmini satış fiyatı'}</small></article>` : ''}
    </div>
    ${f ? `<h3 class="fh-baslik">Bu fiyatın dökümü</h3>${dokum(f)}` : d.basabas ? `<h3 class="fh-baslik">Başabaş fiyatın dökümü</h3>${dokum(d.basabas)}` : ''}
    <p class="help">${esc(k.not)} Kargo ve hizmet bedeli geçmiş teslimlerin ortancasıdır. Paket adedi, ölçüsü ve güncel tarife değiştiğinde gerçek kesinti farklı olabilir.${d.gider ? ' ' + esc(d.gider.not) : ''}</p>`;
  }
  const tetikle = () => { clearTimeout(zaman); ++state.seq; sonuc.removeAttribute('aria-busy'); sonuc.innerHTML = '<p class="help">Seçimin güncellendi; hesap hazırlanıyor…</p>'; zaman = setTimeout(hesapla, 250); };
  form.addEventListener('input', tetikle, {signal: abort.signal});
  form.addEventListener('change', tetikle, {signal: abort.signal});
  form.addEventListener('submit', e => { e.preventDefault(); hesapla(); }, {signal: abort.signal});
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-fh-kanal]'); if (!b) return;
    state.kanal = b.dataset.fhKanal;
    for (const x of root.querySelectorAll('[data-fh-kanal]')) x.setAttribute('aria-pressed', String(x === b));
    hesapla();
  }, {signal: abort.signal});
  return () => { abort.abort(); clearTimeout(zaman); };
}
