// Quotes use the pricing permission, including mapped offerings; catalog permission is not required.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const tl = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(v / 100);
const yuzde = v => v === null || v === undefined ? '—' : '%' + new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 2}).format(v * 100);
const number = v => new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(v);
const eksi = v => v == null ? null : v === 0 ? 0 : -v;
const types = {single: 'Tekli ürün', multipack: 'Çoklu paket', bundle: 'Karma set', mapped: 'Stok dönüşümü'};

export function renderFiyatResult(input) {
  const sen = input.senaryo, d = sen ? {...input, fiyatla: sen.fiyatla, basabas: sen.basabas, hedef: sen.hedef} : input;
  const k = d.kesinti, offering = d.offering;
  const row = (label, value, note = '') => `<tr><th scope="row">${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</th><td>${tl(value)}</td></tr>`;
  const packageNote = offering ? 'teklifin tamamına bir kez · KDV dahil' : 'ürün profili · paket başına';
  const costNote = offering ? d.qty + ' satış biriminin gerçek stok bileşenleri' : d.qty + ' adet × ' + tl(d.urun.birim_maliyet_kdv_dahil) + ' (son alış)';
  const breakdown = x => `<table class="fh-dokum" data-list-tools="off"><tbody>${row('Satış fiyatı · toplam', x.fiyat)}${row('Stok ürünlerinin maliyeti', eksi(x.maliyet), costNote)}${row('Kargo', eksi(x.kargo), 'paket başına bir kez')}${row('Hizmet bedeli', eksi(x.hizmet), 'pazaryeri · paket başına bir kez')}${row('Komisyon', eksi(x.komisyon), yuzde(k.komisyon_orani) + ' (KDV hariç satışa)')}${x.stopaj !== undefined ? row('Stopaj', eksi(x.stopaj), 'yıllık vergiden mahsup edilir') : ''}${x.paketleme !== undefined ? row('Ambalaj', eksi(x.paketleme), packageNote) + row('Diğer paket gideri', eksi(x.diger), packageNote) : ''}<tr class="fh-toplam"><th scope="row">Cebine kalan</th><td class="${x.cebine == null ? '' : x.cebine < 0 ? 'ol-neg' : 'ol-pos'}">${tl(x.cebine)}</td></tr></tbody></table>`;
  const f = d.fiyatla;
  const contents = offering ? `<details class="offering-components"><summary>İçindeki stok ürünleri · ${esc(offering.name)}</summary><p>${d.qty} satış birimi için toplam içerik. Maliyetler her stok ürününün kendi alış KDV’siyle hesaplanır.</p><ul>${offering.components.map(c => `<li><span>${esc(c.product_name)} · ${number(c.total_quantity_milli / 1000)} ${esc(c.stock_unit)}</span><strong>${tl(c.cost_gross_cents)}</strong></li>`).join('')}</ul><p>Toplam stok maliyeti: <strong>${tl(d.cost_gross_cents)}</strong></p></details>` : '';
  return `${d.uyari ? `<div class="notice" role="note"><strong>${sen ? 'Senaryo · fiyat önerisi değil.' : 'Hesap için eksik bilgi var.'}</strong> ${esc(d.uyari)}</div>` : ''}${offering ? `<p class="help">${esc(offering.name)} · ${d.qty} satış birimi tek gönderi paketinde. Satış KDV’si: ${d.sale_vat_bps == null ? 'bilinmiyor' : '%' + number(d.sale_vat_bps / 100)}${d.sale_vat_source === 'scenario' ? ' · girilen senaryo' : d.sale_vat_source === 'mapped_delivered_lines' ? ' · aynı bağlantının teslim edilmiş satırlarından' : ''}.</p>` : ''}<div class="fh-kartlar">
    ${f ? `<article class="fh-kart ${f.cebine == null ? '' : f.cebine < 0 ? 'zarar' : 'kar'}"><span>${sen ? 'Senaryo · ' : ''}${tl(f.fiyat)} toplam fiyata satarsan cebine kalan</span><strong>${tl(f.cebine)}</strong>${d.qty > 1 ? `<small>Satış birimi başına ${tl(f.cebine == null ? null : Math.round(f.cebine / d.qty))}</small>` : ''}</article>` : ''}
    ${d.basabas ? `<article class="fh-kart"><span>${sen ? 'Senaryo · zarar etmeme sınırı' : 'Zarar etmemek için toplam fiyat'}</span><strong>${tl(d.basabas.fiyat)}</strong><small>${sen ? esc(sen.aciklama) : 'Geçmiş kesintilere göre tahmini alt sınır'}</small></article>` : ''}
    ${d.hedef ? `<article class="fh-kart hedef"><span>${sen ? 'Senaryo · ' : ''}Cebine ${tl(d.hedef.istenen)} kalması için</span><strong>${tl(d.hedef.fiyat)}</strong><small>${sen ? esc(sen.aciklama) : 'Hedefin için tahmini toplam satış fiyatı'}</small></article>` : ''}
    </div>${f ? `<h3 class="fh-baslik">Bu fiyatın dökümü</h3>${breakdown(f)}` : d.basabas ? `<h3 class="fh-baslik">Başabaş fiyatın dökümü</h3>${breakdown(d.basabas)}` : '<p class="help">Bilgi tamamlanmadan fiyat veya nakit sonucu gösterilmez.</p>'}${contents}
    <p class="help">${esc(k.not)} Kargo ve hizmet bedeli geçmiş teslimlerden tahmindir; paket içeriği, adedi ve güncel tarife değiştiğinde gerçek kesinti farklı olabilir. ${esc(d.gider?.not || '')}</p>`;
}

export function mountFiyatHesap(root, products = []) {
  if (!document.querySelector('link[data-offering-workflows]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./offering-workflows.css', import.meta.url).href; link.dataset.offeringWorkflows = ''; document.head.append(link); }
  const abort = new AbortController(), state = {kanal: 'trendyol', seq: 0, offerings: []};
  root.innerHTML = `<section class="v2-card fh-card fh-workbench offering-price">
    <div class="v2-card-head"><div><span class="eyebrow">SATIŞTAN ÖNCE HESAPLA</span><h2>Satacağın paketin fiyatını belirle.</h2><p>Tek ürün, çoklu paket veya karma set. Stok maliyeti içerikten, kesintiler geçmiş teslimlerden gelir. Tutarlar KDV dahil.</p></div></div>
    <div class="fh-workbench-body"><form class="fh-form" data-fh><div class="fh-step"><span>01</span><div><h3>Satış senaryon</h3><p>Depoda ürünleri say; burada müşteriye satılan paketi seç.</p></div></div>
      <label class="fh-urun">Hesap türü<select name="quote_type"><option value="product">Stok ürününden hesapla</option><option value="offering">Satılan ürün / kayıtlı set</option></select></label>
      <div class="fh-kanal"><span>Kanal</span><div class="ol-seg" role="group" aria-label="Kanal">${[['trendyol', 'Trendyol'], ['hepsiburada', 'Hepsiburada']].map(([v, l]) => `<button type="button" data-fh-kanal="${v}" aria-pressed="${v === state.kanal}">${l}</button>`).join('')}</div></div>
      <label class="fh-urun" data-product-field>Stok ürünü<select name="product_id" required><option value="">Ürün seçin…</option>${products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="fh-urun" data-offering-field hidden>Satılan ürün<select name="mapping_id" disabled><option value="">Bağlantılar yükleniyor…</option></select></label>
      <p class="help" data-options-note hidden></p><div class="offering-selection" data-offering-content hidden></div>
      <label><span data-qty-label>Paketteki ürün adedi</span><input name="qty" type="number" min="1" max="100" step="1" value="1" inputmode="numeric" required></label>
      <label>Toplam satış fiyatı · KDV dahil (TL)<input name="price" inputmode="decimal" placeholder="örn. 240" autocomplete="off"></label>
      <label>Toplam cebine kalsın istediğin (TL)<input name="target" inputmode="decimal" placeholder="örn. 30" autocomplete="off"></label>
      <fieldset class="offering-package-inputs" data-offering-expenses hidden disabled><legend>Bu gönderi paketinin giderleri</legend><p class="help">Seçtiğin tüm satış birimleri tek paket kabul edilir. Bu toplam giderleri bir kez gir. Boş giderler yalnız 0 varsayımlı senaryo üretir; bilinen sıfır için 0 yaz.</p>
        <label>Toplam ambalaj · KDV dahil (TL)<input name="packaging" inputmode="decimal" placeholder="Bilinen sıfır için 0" autocomplete="off"></label>
        <label>Toplam diğer gider · KDV dahil (TL)<input name="other" inputmode="decimal" placeholder="Bilinen sıfır için 0" autocomplete="off"></label>
        <label>Satış KDV senaryosu (%) · isteğe bağlı<input name="sale_vat_rate" type="number" min="0" max="100" step="0.01" placeholder="Doğrulanmış oran varsa boş bırak"></label><p class="help">İçerikteki ürünlerin alış KDV’si setin satış KDV’sini belirlemez. Buraya girilen oran açıkça senaryo olarak gösterilir.</p>
      </fieldset>
    </form><div class="fh-results-panel"><div class="fh-step"><span>02</span><div><h3>Fiyatın karşılığı</h3><p>Tahmini sonuç ve kesintilerin dökümü.</p></div></div><div class="fh-sonuc" data-fh-sonuc aria-live="polite"><div class="v2-empty"><h3>Satacağın ürünü seç.</h3><p>Fiyat veya hedef ekleyerek paketin tahminini gör.</p></div></div></div></div></section>`;
  const form = root.querySelector('[data-fh]'), result = root.querySelector('[data-fh-sonuc]'), field = name => form.elements.namedItem(name);
  let timer = null;
  const mapped = () => field('quote_type').value === 'offering';
  function selection() {
    const offer = state.offerings.find(x => x.id === field('mapping_id').value), box = root.querySelector('[data-offering-content]');
    box.hidden = !mapped() || !offer;
    box.innerHTML = offer ? `<strong>İçindeki stok ürünleri · 1 satış birimi</strong><ul>${offer.components.map(c => `<li>${number(c.quantity_milli / 1000)} ${esc(c.stock_unit)} ${esc(c.product_name)}</li>`).join('')}</ul><p>Ayrı set stoğu yoktur. Gönderimde bu bileşenler düşer.</p>` : '';
  }
  function options() {
    const select = field('mapping_id'), previous = select.value, offers = state.offerings.filter(o => o.channel === state.kanal);
    select.innerHTML = '<option value="">Satılan ürünü seçin…</option>' + offers.map(o => `<option value="${esc(o.id)}">${esc(o.name)} · ${esc(types[o.kind] || 'Bağlantı')} · ${esc(o.external_code)}</option>`).join('');
    select.value = offers.some(o => o.id === previous) ? previous : '';
    selection();
  }
  function mode() {
    const isMapping = mapped();
    root.querySelector('[data-product-field]').hidden = isMapping;
    root.querySelector('[data-offering-field]').hidden = !isMapping;
    root.querySelector('[data-options-note]').hidden = !isMapping;
    field('product_id').disabled = isMapping; field('product_id').required = !isMapping;
    field('mapping_id').disabled = !isMapping; field('mapping_id').required = isMapping;
    const expenses = root.querySelector('[data-offering-expenses]'); expenses.hidden = !isMapping; expenses.disabled = !isMapping;
    root.querySelector('[data-qty-label]').textContent = isMapping ? 'Tek gönderide satılan paket / set adedi' : 'Paketteki ürün adedi';
    selection();
  }
  async function calculate() {
    const f = Object.fromEntries(new FormData(form)), seq = ++state.seq;
    if (!(mapped() ? f.mapping_id : f.product_id)) { result.removeAttribute('aria-busy'); result.innerHTML = '<div class="v2-empty"><h3>Satacağın ürünü seç.</h3><p>Fiyat veya hedef ekleyerek paketin tahminini gör.</p></div>'; return; }
    if (!form.reportValidity()) { result.removeAttribute('aria-busy'); result.innerHTML = '<p class="notice">Hesaplamak için işaretli alanları düzelt.</p>'; return; }
    const params = {channel: state.kanal, qty: f.qty || 1, price: f.price || '', target: f.target || '', ...(mapped() ? {mapping_id: f.mapping_id, packaging: f.packaging || '', other: f.other || '', sale_vat_rate: f.sale_vat_rate || ''} : {product_id: f.product_id})};
    result.innerHTML = '<p class="loading" role="status">Fiyat tahmini hesaplanıyor…</p>'; result.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/ec/fiyat-hesap?' + new URLSearchParams(params), {signal: abort.signal}), data = await response.json();
      if (seq !== state.seq) return;
      result.innerHTML = response.ok ? renderFiyatResult(data) : `<div class="notice">${esc(data.error || 'Hesaplanamadı.')}</div>`;
    } catch (error) { if (error.name !== 'AbortError' && seq === state.seq) result.innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
    finally { if (seq === state.seq) result.removeAttribute('aria-busy'); }
  }
  const schedule = () => { clearTimeout(timer); ++state.seq; result.removeAttribute('aria-busy'); result.innerHTML = '<p class="help">Seçimin güncellendi; hesap hazırlanıyor…</p>'; timer = setTimeout(calculate, 250); };
  form.addEventListener('input', schedule, {signal: abort.signal});
  form.addEventListener('change', () => { mode(); schedule(); }, {signal: abort.signal});
  form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(timer); calculate(); }, {signal: abort.signal});
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-fh-kanal]'); if (!button) return;
    clearTimeout(timer); state.kanal = button.dataset.fhKanal;
    for (const b of root.querySelectorAll('[data-fh-kanal]')) b.setAttribute('aria-pressed', String(b === button));
    options(); calculate();
  }, {signal: abort.signal});
  fetch('/api/ec/fiyat-hesap?mode=options', {signal: abort.signal}).then(async response => {
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Satılan ürünler yüklenemedi.'); if (abort.signal.aborted) return;
    state.offerings = data.offerings; options(); root.querySelector('[data-options-note]').textContent = data.truncated ? 'İlk 1.000 etkin bağlantı listeleniyor; kanal değiştirerek uygun satılan ürünü seç.' : data.offerings.length ? 'Kayıtlı bağlantılar kendi satış kanalında gösterilir.' : 'Henüz etkin satış bağlantısı yok. Ürün bağlantıları ekranında içerik oluşturulmalı.';
  }).catch(error => { if (error.name !== 'AbortError') { field('mapping_id').innerHTML = '<option value="">Bağlantılar yüklenemedi</option>'; root.querySelector('[data-options-note]').textContent = error.message; } });
  return () => { abort.abort(); clearTimeout(timer); };
}
