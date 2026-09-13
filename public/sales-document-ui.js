// Fatura belgeleri ekranı: SATIŞ faturası arşivi + ALIŞ belgelerinde sayfa → fatura bağlantısı.
//
// Neden bu ekran var:
//  · Satış faturalarının sunucu ucu vardı ama kullanıcının ulaşabildiği bir ekranı yoktu.
//    Sunucu ucu yazmak, ekran yapmak değildir.
//  · Bir belge birden çok faturayı içerebilir ("tüm zamanlar" dökümü, birleşik pazaryeri PDF'i).
//    Sayfa bağlantısı bu yüzden ayrı bir adımdır: dosya seçmek eşleştirme değildir.
//
// Kurallar:
//  · Dosya seçici GÖRÜNÜR ve klavyeyle erişilebilir; gizli input'a bağlı otomasyon beklenmez.
//  · Baytlar dosyadan okunur (File.arrayBuffer); elle base64 üretilmez.
//  · Yükleme parçalıdır ve sunucu SHA-256 ile mühürler: ulaşan dosya seçilen dosya değilse reddedilir.
//  · Bu ekran SATIŞ, GELİR, BORÇ ya da STOK kaydı OLUŞTURMAZ. Arşiv ve bağlantı kaydıdır.
//  · Aynı dosya ikinci kez yüklenmez; kopya dosya ikinci fatura sayılmaz.
import {sha256Hex} from './xlsx-read.js';
import {readPdf} from './pdf-read.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const num = v => new Intl.NumberFormat('tr-TR').format(v || 0);
const mb = v => (v / 1024 / 1024).toFixed(1) + ' MB';
const CHUNK = 480 * 1024;                 // rapor/alış yüklemeleriyle aynı parça boyu
const MAX_BYTES = 20 * 1024 * 1024;
const PROVIDERS = {trendyol: 'Trendyol', hepsiburada: 'Hepsiburada', other: 'Diğer'};

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Dosya adından TÜREV ilişkisini okur: "... sayfa1-parca2(sayfa23-43).pdf"
 * Türev, boyut sınırı için özgün dosyadan üretilmiş parçadır. Kendi baytlarıyla doğrulanır;
 * özgün dosyayla aynı özete sahip olması BEKLENMEZ. İlişki ayrıca saklanır ki sayfa numarası
 * anlamını yitirmesin.
 */
export function turevBilgisi(ad) {
  const m = /^(.*?)-parca\d+\(sayfa(\d+)-(\d+)\)\.pdf$/i.exec(ad);
  if (!m) return null;
  const ilk = Number(m[2]), son = Number(m[3]);
  if (!Number.isSafeInteger(ilk) || !Number.isSafeInteger(son) || ilk < 1 || son < ilk) return null;
  return {origin_filename: m[1] + '.pdf', origin_first_page: ilk, origin_last_page: son};
}

export function mountSalesDocuments(root, namespace = 'ec') {
  const controller = new AbortController(), signal = controller.signal;
  const state = {tab: 'sales', busy: false, message: '', error: '',
    sales: null, purchases: null, invoices: null,
    kuyruk: [],            // seçilen satış dosyaları
    alisKuyruk: [],        // seçilen alış belgeleri
    sayfalar: null,        // açık belgenin sayfa listesi
    acikBelge: null};

  const api = async (path, body) => {
    const r = await fetch('/api/' + namespace + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    let x; try { x = await r.json(); } catch { throw new Error('Sunucudan yanıt alınamadı.'); }
    if (!r.ok) throw new Error(x.error || 'İşlem tamamlanamadı.');
    return x;
  };
  const say = (m, hata = false) => { state.message = hata ? '' : m; state.error = hata ? m : ''; render(); };
  const run = async (fn) => {
    if (state.busy) return;
    state.busy = true; state.error = ''; render();
    try { await fn(); } catch (e) { state.error = e.message; } finally { state.busy = false; render(); }
  };

  async function load() {
    const [sales, purchases] = await Promise.all([api('/sales/documents'), api('/invoices/documents')]);
    state.sales = sales.documents; state.purchases = purchases.documents;
    return {sales, purchases};
  }

  /* ---------------- yükleme ---------------- */

  async function yukle(item) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(item.file.name + ': belge 20 MB sınırını aşıyor.');
    const sha = await sha256Hex(bytes);
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
    const turev = turevBilgisi(item.file.name) || {};
    // Sayfa sayısı olmadan sunucudaki "belgede olmayan sayfaya bağlama" denetimi çalışmaz.
    // Okunamayan belgede alan boş bırakılır; uydurulmaz.
    let sayfaSayisi = null, metinKatmani = 0;
    try { const okunan = await readPdf(bytes); sayfaSayisi = okunan.pages; metinKatmani = okunan.textLayer ? 1 : 0; }
    catch { sayfaSayisi = null; }

    item.durum = 'kayıt'; render();
    const created = await api('/sales/documents', {kind: 'pdf', provider: item.provider, filename: item.file.name,
      mime: item.file.type || 'application/pdf', size_bytes: bytes.length, sha256: sha, chunk_count: chunks,
      ...(sayfaSayisi === null ? {} : {page_count: sayfaSayisi}), text_layer: metinKatmani, ...turev});
    if (created.duplicate) { item.durum = 'kopya'; item.sonuc = 'Bu dosya daha önce yüklendi; ikinci kez işlenmedi.'; return; }

    const id = created.id;
    for (let i = 0; i < chunks; i++) {
      item.durum = 'aktarılıyor'; item.ilerleme = {max: chunks, value: i}; render();
      await api('/sales/documents/' + id + '/chunk', {index: i, data: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK))});
    }
    item.ilerleme = null; item.durum = 'mühürleniyor'; render();
    // Sunucu kendi hesabıyla doğrular: ulaşan dosya seçilen dosya değilse mühürlenmez.
    await api('/sales/documents/' + id + '/seal', {});
    item.durum = 'tamam'; item.belgeId = id;
    item.sonuc = turev.origin_filename
      ? 'Arşivlendi · türev: ' + turev.origin_filename + ' sayfa ' + turev.origin_first_page + '–' + turev.origin_last_page
      : 'Arşivlendi';
  }

  // ALIS belgesi yukleme. Ayni parcali yol ve sunucu tarafi SHA-256 muhru.
  // Neden burada: panelin alis sihirbazindaki dosya girdisi gizli ve tek belgelik bir akisa bagli;
  // "tum zamanlar" dokumu gibi cok faturali belgeyi once arsive alip sonra sayfa sayfa baglamak
  // icin gorunur ve toplu bir giris gerekiyordu.
  async function alisYukle(item) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(item.file.name + ': belge 20 MB sınırını aşıyor.');
    const sha = await sha256Hex(bytes);
    const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
    let sayfaSayisi = null, metinKatmani = 0;
    try { const okunan = await readPdf(bytes); sayfaSayisi = okunan.pages; metinKatmani = okunan.textLayer ? 1 : 0; }
    catch { sayfaSayisi = null; }

    item.durum = 'kayıt'; render();
    const created = await api('/invoices/documents', {kind: 'pdf', filename: item.file.name,
      mime: item.file.type || 'application/pdf', size_bytes: bytes.length, sha256: sha, chunk_count: chunks,
      ...(sayfaSayisi === null ? {} : {page_count: sayfaSayisi}), text_layer: metinKatmani});
    if (created.duplicate) { item.durum = 'kopya'; item.sonuc = created.notice || 'Bu belge daha önce yüklendi.'; return; }

    const id = created.id;
    for (let i = 0; i < chunks; i++) {
      item.durum = 'aktarılıyor'; item.ilerleme = {max: chunks, value: i}; render();
      await api('/invoices/documents/' + id + '/chunk', {index: i, data: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK))});
    }
    item.ilerleme = null; item.durum = 'mühürleniyor'; render();
    await api('/invoices/documents/' + id + '/seal', {});
    item.durum = 'tamam'; item.belgeId = id;
    item.sonuc = 'Arşivlendi' + (sayfaSayisi ? ' · ' + sayfaSayisi + ' sayfa' : '');
  }

  async function alisKuyrugaBas() {
    const bekleyen = state.alisKuyruk.filter(i => !i.durum || i.durum === 'hata');
    if (!bekleyen.length) throw new Error('Yüklenecek belge yok.');
    let tamam = 0, kopya = 0, hata = 0;
    for (const item of bekleyen) {
      try { await alisYukle(item); item.durum === 'kopya' ? kopya++ : tamam++; }
      catch (e) { item.durum = 'hata'; item.hata = e.message; hata++; }
      render();
    }
    await load();
    say(tamam + ' alış belgesi arşivlendi · ' + kopya + ' kopya atlandı' + (hata ? ' · ' + hata + ' hata' : '') +
      '. Belgeler faturaya bağlanmadı; aşağıdan sayfa sayfa bağlayın.');
  }

  async function kuyrugaBas() {
    const bekleyen = state.kuyruk.filter(i => !i.durum || i.durum === 'hata');
    if (!bekleyen.length) throw new Error('Yüklenecek dosya yok.');
    let tamam = 0, kopya = 0, hata = 0;
    for (const item of bekleyen) {
      try { await yukle(item); item.durum === 'kopya' ? kopya++ : tamam++; }
      catch (e) { item.durum = 'hata'; item.hata = e.message; hata++; }
      render();
    }
    await load();
    say(tamam + ' belge arşivlendi · ' + kopya + ' kopya atlandı' + (hata ? ' · ' + hata + ' hata' : '') + '. Bu işlem satış veya stok kaydı oluşturmadı.');
  }

  /* ---------------- sayfa bağlantısı ---------------- */

  async function sayfalariAc(tur, id) {
    const yol = tur === 'sales' ? '/sales/documents/' + id + '/pages' : '/invoices/documents/' + id + '/pages';
    state.acikBelge = {tur, id};
    state.sayfalar = await api(yol);
    render();
  }

  async function alisSayfasiBagla(form) {
    const x = new FormData(form);
    const page_no = Number(x.get('page_no')), invoice_id = String(x.get('invoice_id') || '');
    if (!invoice_id) throw new Error('Fatura seçin.');
    const r = await api('/invoices/documents/' + state.acikBelge.id + '/pages', {pages: [{page_no, invoice_id}]});
    await sayfalariAc('purchase', state.acikBelge.id);
    say(r.created ? 'Sayfa ' + page_no + ' faturaya bağlandı.' :
      r.already_linked ? 'Bu bağlantı zaten vardı; ikinci kez yazılmadı.' :
      'Bağlanmadı: ' + (r.conflicts[0]?.reason || 'çelişki var.'), !r.created);
  }

  /* ---------------- görünüm ---------------- */

  const tabs = () => `<div class="rb-tabs" role="tablist">${[['sales', 'Satış faturaları'], ['purchase', 'Alış sayfa bağlantısı']]
    .map(([k, t]) => `<button type="button" role="tab" class="${state.tab === k ? 'active' : ''}" aria-selected="${state.tab === k}" data-sd-tab="${k}">${esc(t)}</button>`).join('')}</div>`;

  const durumRozeti = (item) => item.durum === 'tamam' ? '<span class="pill">Arşivlendi</span>'
    : item.durum === 'kopya' ? '<span class="pill neutral">Kopya</span>'
    : item.durum === 'hata' ? '<span class="pill neutral">Hata</span>'
    : item.durum ? '<span class="pill neutral">' + esc(item.durum) + '</span>' : '<span class="pill neutral">Bekliyor</span>';

  function kuyrukTablosu() {
    if (!state.kuyruk.length) return '<p class="rb-muted">Henüz dosya seçilmedi.</p>';
    return `<div class="v2-table-wrap"><table class="v2-table"><thead><tr>
      <th>Dosya</th><th>Boyut</th><th>Pazaryeri</th><th>Türev</th><th>Durum</th></tr></thead><tbody>
      ${state.kuyruk.map((i, k) => { const t = turevBilgisi(i.file.name);
        return `<tr><td>${esc(i.file.name)}</td><td>${esc(mb(i.file.size))}</td>
        <td><select data-sd-provider="${k}" ${i.durum === 'tamam' ? 'disabled' : ''}>${Object.entries(PROVIDERS)
          .map(([v, t2]) => `<option value="${v}" ${i.provider === v ? 'selected' : ''}>${esc(t2)}</option>`).join('')}</select></td>
        <td>${t ? esc(t.origin_filename) + '<br><small>sayfa ' + t.origin_first_page + '–' + t.origin_last_page + '</small>' : '<small class="rb-muted">tekil dosya</small>'}</td>
        <td>${durumRozeti(i)}${i.ilerleme ? `<progress max="${i.ilerleme.max}" value="${i.ilerleme.value}"></progress>` : ''}
          ${i.sonuc ? '<br><small>' + esc(i.sonuc) + '</small>' : ''}${i.hata ? '<br><small class="error">' + esc(i.hata) + '</small>' : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function satisGorunumu() {
    const docs = state.sales || [];
    return `<section class="v2-card"><h3>1 · Belgeleri seç</h3>
      <p class="rb-muted">Pazaryerinin kestiği satış faturalarının özgün dosyaları. Birden çok dosya seçebilirsin.
        Dosya adı <code>parca2(sayfa23-43)</code> biçimindeyse türev olarak tanınır ve özgün sayfa aralığı saklanır.</p>
      <label class="rb-drop" data-sd-drop>
        <strong>Satış faturası PDF'lerini seç</strong>
        <span>ya da buraya sürükle · dosya başına en çok 20 MB</span>
        <input type="file" accept=".pdf,application/pdf" multiple data-sd="file" aria-label="Satış faturası PDF dosyalarını seç">
      </label>
      ${kuyrukTablosu()}
      <div class="rb-actions">
        ${state.kuyruk.length ? '<button type="button" class="secondary" data-sd-act="temizle">Listeyi temizle</button>' : ''}
        <button type="button" class="primary" data-sd-act="yukle" ${state.kuyruk.some(i => !i.durum || i.durum === 'hata') ? '' : 'disabled'}>Arşive yükle</button>
      </div>
      <p class="rb-muted">Yükleme satış, gelir veya stok kaydı oluşturmaz. Sunucu dosyanın SHA-256 özetini kendisi doğrular.</p>
    </section>

    <section class="v2-card"><h3>2 · Arşivdeki satış belgeleri <small class="rb-muted">${num(docs.length)} belge</small></h3>
      ${docs.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr>
        <th>Dosya</th><th>Pazaryeri</th><th>Sayfa</th><th>Özgün dosya</th><th>Fatura sayfası</th><th>Siparişe bağlı</th><th></th></tr></thead><tbody>
        ${docs.map(d => `<tr><td>${esc(d.filename)}</td><td>${esc(PROVIDERS[d.provider] || d.provider)}</td>
          <td>${d.page_count === null ? '—' : num(d.page_count)}</td>
          <td>${d.origin_filename ? esc(d.origin_filename) + '<br><small>sayfa ' + num(d.origin_first_page) + '–' + num(d.origin_last_page) + '</small>' : '<small class="rb-muted">—</small>'}</td>
          <td>${num(d.linked_pages)}</td><td>${num(d.linked_orders)}</td>
          <td><button type="button" class="text-button" data-sd-act="sayfalar" data-tur="sales" data-id="${esc(d.id)}">Sayfalar →</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="rb-muted">Henüz satış belgesi yok.</p>'}
    </section>${sayfaPaneli('sales')}`;
  }

  function alisKuyrukTablosu() {
    if (!state.alisKuyruk.length) return '<p class="rb-muted">Henüz belge seçilmedi.</p>';
    return `<div class="v2-table-wrap"><table class="v2-table"><thead><tr>
      <th>Dosya</th><th>Boyut</th><th>Durum</th></tr></thead><tbody>
      ${state.alisKuyruk.map(i => `<tr><td>${esc(i.file.name)}</td><td>${esc(mb(i.file.size))}</td>
      <td>${durumRozeti(i)}${i.ilerleme ? `<progress max="${i.ilerleme.max}" value="${i.ilerleme.value}"></progress>` : ''}
        ${i.sonuc ? '<br><small>' + esc(i.sonuc) + '</small>' : ''}${i.hata ? '<br><small class="error">' + esc(i.hata) + '</small>' : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function alisGorunumu() {
    const docs = state.purchases || [];
    return `<section class="v2-card"><h3>1 · Alış belgesi yükle</h3>
      <p class="rb-muted">Tedarikçinin "tüm zamanlar" dökümü tek PDF olabilir; içinde onlarca fatura bulunur.
        Önce belgeyi arşive al, sonra aşağıdan her faturayı kendi sayfasına bağla.
        <strong>Yükleme borç, stok ya da fatura kaydı oluşturmaz.</strong></p>
      <label class="rb-drop" data-sd-alis-drop>
        <strong>Alış faturası PDF'lerini seç</strong>
        <span>ya da buraya sürükle · dosya başına en çok 20 MB</span>
        <input type="file" accept=".pdf,application/pdf" multiple data-sd="alis-file" aria-label="Alış faturası PDF dosyalarını seç">
      </label>
      ${alisKuyrukTablosu()}
      <div class="rb-actions">
        ${state.alisKuyruk.length ? '<button type="button" class="secondary" data-sd-act="alis-temizle">Listeyi temizle</button>' : ''}
        <button type="button" class="primary" data-sd-act="alis-yukle" ${state.alisKuyruk.some(i => !i.durum || i.durum === 'hata') ? '' : 'disabled'}>Arşive yükle</button>
      </div>
    </section>

    <section class="v2-card"><h3>2 · Sayfa → fatura bağlantısı</h3>`;
  }

  function alisBaglantiGovdesi() {
    const docs = state.purchases || [];
    return `
      <p class="rb-muted">Tedarikçi "tüm zamanlar" dökümünü tek PDF olarak verir: bir belgenin içinde onlarca fatura olabilir.
        Her faturayı kendi sayfasına bağla. Bağlantı kanıttır: kurulduktan sonra taşınmaz, silinmez ve
        <strong>aynı fatura ikinci kez bağlanmaz</strong>.</p>
      ${docs.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr>
        <th>Dosya</th><th>Sayfa</th><th>Durum</th><th>Bağlı fatura</th><th></th></tr></thead><tbody>
        ${docs.map(d => `<tr><td>${esc(d.filename)}</td><td>${d.page_count === null ? '—' : num(d.page_count)}</td>
          <td>${esc({receiving: 'Yükleniyor', stored: 'Arşivde', linked: 'Faturaya bağlı'}[d.status] || d.status)}</td>
          <td>${esc(d.invoice_no || '—')}</td>
          <td><button type="button" class="text-button" data-sd-act="sayfalar" data-tur="purchase" data-id="${esc(d.id)}">Sayfalar →</button></td></tr>`).join('')}
        </tbody></table></div>`
        : `<p class="rb-muted">Henüz alış belgesi yüklenmedi. Belgeleri <a href="#invoices">Alış faturaları</a> ekranındaki
           "PDF fatura yükle" ile yükle; sonra buradan her faturayı sayfasına bağla.</p>`}
    </section>${sayfaPaneli('purchase')}`;
  }

  function sayfaPaneli(tur) {
    if (!state.acikBelge || state.acikBelge.tur !== tur || !state.sayfalar) return '';
    const s = state.sayfalar, satirlar = s.pages || [];
    const faturalar = state.invoices || [];
    return `<section class="v2-card"><h3>${esc(s.filename)} · sayfalar
      <small class="rb-muted">${s.page_count ? num(s.page_count) + ' sayfa' : 'sayfa sayısı bilinmiyor'}</small></h3>
      ${s.origin_filename ? `<p class="rb-muted">Türev belge: özgün dosya <strong>${esc(s.origin_filename)}</strong>,
        bu bölüm özgün ${num(s.origin_first_page)}. sayfadan başlıyor.</p>` : ''}
      ${satirlar.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr>
        <th>Sayfa</th>${tur === 'sales' ? '<th>Özgün sayfa</th><th>Fatura no</th><th>Sipariş</th>' : '<th>Fatura no</th><th>Tarih</th>'}
        </tr></thead><tbody>
        ${satirlar.map(p => tur === 'sales'
          ? `<tr><td>${num(p.page_no)}</td><td>${num(p.origin_page_no)}</td><td>${esc(p.invoice_no || '—')}</td><td>${esc(p.order_no || '—')}</td></tr>`
          : `<tr><td>${num(p.page_no)}</td><td>${esc(p.invoice_no || '—')}</td><td>${esc(p.invoice_date || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="rb-muted">Bu belgede henüz sayfa kaydı yok.</p>'}
      ${tur === 'purchase' ? `<form data-sd-form="sayfa" class="rb-grid">
        <label>Sayfa no<input name="page_no" type="number" min="1" ${s.page_count ? 'max="' + s.page_count + '"' : ''} required></label>
        <label>Fatura<select name="invoice_id" required><option value="">Seçin…</option>
          ${faturalar.map(i => `<option value="${esc(i.id)}">${esc(i.invoice_no)} · ${esc(i.invoice_date)} · ${esc(i.supplier_name || '')}</option>`).join('')}
        </select></label>
        <button class="primary" type="submit">Sayfayı faturaya bağla</button></form>
        <p class="rb-muted">Dolu bir sayfaya ikinci fatura ya da bağlı bir faturayı başka sayfaya bağlamak reddedilir.</p>` : ''}
      <div class="rb-actions"><button type="button" class="secondary" data-sd-act="kapat">Kapat</button></div></section>`;
  }

  function render() {
    root.innerHTML = `<div class="rb">
      <section class="rb-intro"><h2>Fatura belgeleri</h2>
        <p>Özgün fatura dosyalarının arşivi. Bu ekran <strong>satış, gelir, borç veya stok kaydı oluşturmaz</strong>;
          belgeyi saklar ve hangi sayfanın hangi faturaya ait olduğunu kaydeder.</p></section>
      ${tabs()}
      ${state.error ? `<p class="rb-alert warn" role="alert">${esc(state.error)}</p>` : ''}
      ${state.message ? `<p class="rb-alert ok" role="status">${esc(state.message)}</p>` : ''}
      ${state.sales === null ? '<p class="rb-busy" role="status">Yükleniyor…</p>'
        : state.tab === 'sales' ? satisGorunumu() : alisGorunumu()}
      ${state.busy ? '<p class="rb-busy" role="status">İşleniyor…</p>' : ''}</div>`;
  }

  /* ---------------- olaylar ---------------- */

  const alisDosyalariAl = (liste) => {
    for (const f of liste) {
      if (!/\.pdf$/i.test(f.name)) { state.error = f.name + ': yalnız PDF kabul edilir.'; continue; }
      if (state.alisKuyruk.some(i => i.file.name === f.name && i.file.size === f.size)) continue;
      state.alisKuyruk.push({file: f, durum: '', ilerleme: null, sonuc: '', hata: ''});
    }
    render();
  };

  const dosyalariAl = (liste) => {
    for (const f of liste) {
      if (!/\.pdf$/i.test(f.name)) { state.error = f.name + ': yalnız PDF kabul edilir.'; continue; }
      if (state.kuyruk.some(i => i.file.name === f.name && i.file.size === f.size)) continue;
      const ad = f.name.toLocaleLowerCase('tr-TR');
      // Ön seçim yalnızca kolaylık; kullanıcı satır bazında değiştirebilir.
      const provider = ad.includes('hepsi') || ad.startsWith('hb') ? 'hepsiburada' : 'trendyol';
      state.kuyruk.push({file: f, provider, durum: '', ilerleme: null, sonuc: '', hata: ''});
    }
    render();
  };

  root.addEventListener('change', e => {
    if (e.target.dataset.sd === 'file') { dosyalariAl([...e.target.files]); e.target.value = ''; return; }
    if (e.target.dataset.sd === 'alis-file') { alisDosyalariAl([...e.target.files]); e.target.value = ''; return; }
    if (e.target.dataset.sdProvider !== undefined) { state.kuyruk[Number(e.target.dataset.sdProvider)].provider = e.target.value; return; }
  }, {signal});

  root.addEventListener('click', e => {
    const tab = e.target.closest('[data-sd-tab]');
    if (tab) { state.tab = tab.dataset.sdTab; state.acikBelge = null; state.sayfalar = null; render(); return; }
    const b = e.target.closest('[data-sd-act]');
    if (!b) return;
    const a = b.dataset.sdAct;
    if (a === 'temizle') { state.kuyruk = state.kuyruk.filter(i => i.durum === 'tamam'); render(); return; }
    if (a === 'alis-temizle') { state.alisKuyruk = state.alisKuyruk.filter(i => i.durum === 'tamam'); render(); return; }
    if (a === 'alis-yukle') { run(alisKuyrugaBas); return; }
    if (a === 'yukle') { run(kuyrugaBas); return; }
    if (a === 'kapat') { state.acikBelge = null; state.sayfalar = null; render(); return; }
    if (a === 'sayfalar') {
      run(async () => {
        if (b.dataset.tur === 'purchase' && !state.invoices) state.invoices = (await api('/accounting')).invoices || [];
        await sayfalariAc(b.dataset.tur, b.dataset.id);
      });
    }
  }, {signal});

  root.addEventListener('submit', e => {
    if (e.target.dataset.sdForm !== 'sayfa') return;
    e.preventDefault();
    const form = e.target;
    run(() => alisSayfasiBagla(form));
  }, {signal});

  root.addEventListener('dragover', e => { const z = e.target.closest('[data-sd-drop],[data-sd-alis-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } }, {signal});
  root.addEventListener('dragleave', e => { e.target.closest('[data-sd-drop],[data-sd-alis-drop]')?.classList.remove('over'); }, {signal});
  root.addEventListener('drop', e => {
    const z = e.target.closest('[data-sd-drop]'), za = e.target.closest('[data-sd-alis-drop]');
    if (!z && !za) return;
    e.preventDefault(); (z || za).classList.remove('over');
    (z ? dosyalariAl : alisDosyalariAl)([...e.dataTransfer.files]);
  }, {signal});

  render();
  run(load);
  return () => controller.abort();
}
