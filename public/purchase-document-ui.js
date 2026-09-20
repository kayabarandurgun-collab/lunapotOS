import {prepareWorkflow} from './product-list.js';
// Alış belgesi çalışma alanı: PDF (ya da XML) yükle → tedarikçi/belge → satırlar → çeşit dağılımı → onay.
//
// Kurallar:
//  · Belgeden okunan her şey ADAYDIR; kullanıcı onaylamadan hiçbir tutar/miktar kaydedilmez.
//  · Okunamayan alan BOŞ bırakılır, uydurulmaz; belirsiz alan işaretlenir.
//  · Bu ekran EDM'den fatura ÇEKMEZ, fatura kesmez/iptal etmez. Belgeyi kullanıcı yükler.
//  · Taslak kaydı borç ve stok yazmaz: borç muhasebeleştirmede, stok mal tesliminde oluşur.
//  · Çeşit adetleri hiçbir zaman hatırlanmaz; her belgede yeniden girilir ve onaylanır.
import {readPdf, guessHeader, guessLines, guessTotals, splitInvoices, sha256Hex, PDF_LIMITS} from './pdf-read.js';
import {parseInvoiceXML} from './invoice-import.js';
import {matchFromHistory, codeOf} from './purchase-match.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = n => n === null || n === undefined || Number.isNaN(n) ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(n);
const num = n => new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(n || 0);
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const CHUNK = 480 * 1024;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const flag = (on, text) => on ? `<span class="pd-flag">${esc(text)}</span>` : '';

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const STEPS = [['document', 'Tedarikçi ve belge'], ['lines', 'Satırlar'], ['allocate', 'Çeşit dağılımı'], ['confirm', 'Kontrol ve onay']];

export function mountPurchaseDocument(root, namespace = 'ec', {onClose} = {}) {
  const controller = new AbortController(), signal = controller.signal;
  const state = {step: 'pick', busy: false, message: '', error: '', file: null, bytes: null, kind: 'pdf',
    extracted: null, warnings: [], header: null, lines: [], totals: null, docId: null, catalog: null, families: [], previewUrl: null,
    // TOPLU YUKLEME KUYRUGU. Kullanici 30+ faturayi tek tek yuklemek zorunda kalmasin diye
    // dosyalar siraya alinir. Sistem kendi basina karar verebildigi faturayi otomatik islar,
    // yalnizca GERCEKTEN belirsiz olanda durur. Otomatik islenen TASLAK olusturur: cari borc
    // ve stok yine yazilmaz, muhasebelestirme ayri ve bilincli bir adimdir.
    queue: [], queueTotal: 0, queueDone: [], auto: false};

  const api = async (path, body) => {
    const r = await fetch('/api/' + namespace + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    let x; try { x = await r.json(); } catch { throw new Error('Sunucuya ulaşılamadı.'); }
    if (!r.ok) throw new Error(x.error || 'İşlem tamamlanamadı.');
    return x;
  };
  const say = (message, error = false) => { state.message = error ? '' : message; state.error = error ? message : ''; };
  // Kuyruk uzun surer: hangi dosyada olundugu ekranda yazsin, kullanici bekledigini bilsin.
  const ilerle = metin => { state.message = 'İşleniyor: ' + metin; render(); };
  const run = async fn => {
    if (state.busy) return;
    state.busy = true; say(''); render();
    try { await fn(); } catch (e) { if (e.name !== 'AbortError') say(e.message, true); }
    finally { state.busy = false; render(); }
  };

  /* ---------------- görünüm ---------------- */
  const steps = () => `<ol class="pd-steps">${STEPS.map(([k, t], i) => {
    const at = STEPS.findIndex(s => s[0] === state.step);
    return `<li ${state.step === k ? 'aria-current="step"' : ''} class="${state.step === k ? 'active' : at > i ? 'done' : ''}"><b>${i + 1}</b>${esc(t)}</li>`;
  }).join('')}</ol>`;

  const status = () => `${state.error ? `<p class="pd-alert error" role="alert">${esc(state.error)}</p>` : ''}` +
    `${state.message ? `<p class="pd-alert ok" role="status">${esc(state.message)}</p>` : ''}` +
    state.warnings.map(w => `<p class="pd-alert warn">${esc(w)}</p>`).join('');

  function preview() {
    if (!state.previewUrl && state.kind !== 'xml') return '';
    const body = state.kind === 'pdf'
      ? `<object data="${esc(state.previewUrl)}" type="application/pdf"><p class="pd-raw">Belge önizlemesi bu tarayıcıda açılamadı. Aşağıdaki okunan metinden kontrol edebilirsiniz.</p></object>`
      : `<pre class="pd-raw">${esc((state.extracted?.lines || []).join('\n').slice(0, 20000))}</pre>`;
    return `<div class="pd-preview"><div class="pd-preview-head"><strong>${esc(state.file?.name || 'Belge')}</strong>
      <button class="text-button" type="button" data-pd="download">İndir ↓</button></div>${body}</div>`;
  }

  function pickView() {
    return `<section class="v2-card v2-card-body">
      <h2>Alış faturası yükle</h2>
      <p class="pd-muted">Tedarikçinin gönderdiği faturanın PDF'ini buraya bırak. Belge özgün hâliyle saklanır. Okunan satırlar belgenin toplamıyla tutuyor ve ürünler geçmiş alışlardan biliniyorsa fatura kendiliğinden işlenir (borç + stok); emin olunamayan yerde durup sana sorar.</p>
      <label class="pd-drop" data-pd-drop><input type="file" accept=".pdf,application/pdf" data-pd="file" multiple aria-label="Alış faturası PDF dosyalarını seç">
        <strong>PDF faturaları buraya sürükle — birden fazla seçebilirsin</strong><span>ya da tıklayıp seç · en çok ${PDF_LIMITS.fileBytes / 1024 / 1024} MB</span></label>
      <div class="pd-alt">
        <span class="pd-muted">Başka yol:</span>
        <label class="secondary pd-file">UBL XML yükle<input type="file" accept=".xml,application/xml,text/xml" data-pd="xml" multiple></label>
        <button class="secondary" type="button" data-pd="manual">Elle fatura gir</button>
      </div>
      <p class="pd-alert info">Taranmış (fotoğraf) faturada yazıları okuyan bir hizmet bu panelde yok. Öyle bir belgeyi de yükleyebilirsin: belge saklanır, ekranda görürsün ve satırları elle girersin.</p>
    </section>`;
  }

  function documentView() {
    const h = state.header, suppliers = state.catalog?.suppliers || [];
    const matched = h.supplier_tax_id ? suppliers.find(s => s.tax_id === h.supplier_tax_id) : null;
    const unsure = k => h.uncertain?.includes(k);
    return `<section class="v2-card v2-card-body"><h2>1 · Tedarikçi ve belge</h2>
      <p class="pd-muted">Belgeden okunanlar aşağıda. <span class="pd-flag">kontrol et</span> işaretli alanlar kesin okunamadı.</p>
      <form data-pd-form="document"><div class="pd-grid">
        <label>Tedarikçi<select name="supplier_id"><option value="">— yeni tedarikçi —</option>
          ${suppliers.map(s => `<option value="${esc(s.id)}" ${matched?.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Yeni tedarikçi unvanı<input name="supplier_name" value="${esc(h.supplier_name || '')}" maxlength="200"></label>
        <label>Tedarikçi VKN / TCKN ${flag(unsure('supplier_tax_id'), 'kontrol et')}<input name="supplier_tax_id" value="${esc(h.supplier_tax_id || '')}" pattern="[0-9]{10,11}"></label>
        <label>Fatura numarası ${flag(unsure('invoice_no'), 'kontrol et')}<input name="invoice_no" value="${esc(h.invoice_no || '')}" required maxlength="60"></label>
        <label>Fatura tarihi ${flag(unsure('invoice_date'), 'kontrol et')}<input name="invoice_date" type="date" value="${esc(h.invoice_date || today())}" required></label>
        <label>ETTN / UUID<input name="uuid" value="${esc(h.uuid || '')}" maxlength="60"></label>
      </div>
      <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="restart">Başka belge</button>
        <button class="primary" type="submit">Satırlara geç →</button></div></form></section>`;
  }

  function lineCard(line, i) {
    const products = state.catalog?.products || [], families = state.families;
    const unsure = k => line.uncertain?.includes(k);
    return `<article class="pd-line" data-pd-line="${i}">
      <div class="pd-line-head"><strong>Satır ${i + 1}</strong>
        <button class="text-button danger" type="button" data-pd="remove-line" data-i="${i}">Kaldır</button></div>
      ${line.source ? `<p class="pd-source">Belgede: ${esc(line.source)}</p>` : ''}
      <label>Faturadaki açıklama<input name="description" value="${esc(line.description || '')}" required maxlength="300"></label>
      <div class="pd-cols">
        <label>Tedarikçi kodu<input name="external_code" value="${esc(line.external_code || '')}" maxlength="100"></label>
        <label>Miktar<input name="invoice_quantity" type="number" step="0.001" min="0.001" value="${esc(line.invoice_quantity ?? '')}" required></label>
        <label>Birim<input name="invoice_unit" value="${esc(line.invoice_unit || 'adet')}" required maxlength="30"></label>
        <label>Net tutar ${flag(unsure('net'), 'kontrol et')}<input name="net" type="number" step="0.01" min="0" value="${esc(line.net ?? '')}" required></label>
        <label>KDV tutarı ${flag(unsure('tax'), 'kontrol et')}<input name="tax" type="number" step="0.01" min="0" value="${esc(line.tax ?? '')}" required></label>
      </div>
      <div class="pd-cols">
        <label>Satır türü<select name="line_type">
          <option value="product" ${line.line_type !== 'expense' ? 'selected' : ''}>Stok ürünü</option>
          <option value="expense" ${line.line_type === 'expense' ? 'selected' : ''}>Hizmet / gider</option></select></label>
        <label>Gider türü<select name="expense_category">${[['shipping', 'Kargo'], ['commission', 'Komisyon'], ['advertising', 'Reklam'], ['rent', 'Kira'], ['packaging', 'Paketleme'], ['other', 'Diğer']]
          .map(([v, t]) => `<option value="${v}" ${line.expense_category === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Giderin işlendiği yer<select name="expense_treatment">
          <option value="">Seçin · kargo/komisyonda zorunlu</option>
          <option value="general" ${line.expense_treatment === 'general' ? 'selected' : ''}>Genel gider</option>
          <option value="sales_fee" ${line.expense_treatment === 'sales_fee' ? 'selected' : ''}>Satışlara dağıtılacak kesinti</option></select></label>
      </div>
      <div class="pd-cols">
        <label>Bizdeki ürün<select name="product_id"><option value="">— eşleştirilmedi —</option>
          ${products.map(p => `<option value="${esc(p.id)}" ${line.product_id === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.sku)} (${esc(p.stock_unit)})</option>`).join('')}</select></label>
        <label>Stok miktarı<input name="stock_quantity" type="number" step="0.001" min="0.001" value="${esc(line.stock_quantity ?? line.invoice_quantity ?? '')}"></label>
        <label>Çeşitlere dağıtılacak aile<select name="family_id"><option value="">— tek ürün —</option>
          ${families.map(fam => `<option value="${esc(fam.id)}" ${line.family_id === fam.id ? 'selected' : ''}>${esc(fam.name)}${fam.size_label ? ' · ' + esc(fam.size_label) : ''}</option>`).join('')}</select></label>
      </div>
      <p class="pd-muted" data-pd-status="${i}">${esc(line.status_text || '')}</p>
      <div class="pd-actions"><button class="secondary" type="button" data-pd="apply-link" data-i="${i}">Kayıtlı bağlantıyı uygula</button>
        <button class="secondary" type="button" data-pd="remember-link" data-i="${i}">Bu eşleştirmeyi hatırla</button></div>
    </article>`;
  }

  function linesView() {
    return `<section class="v2-card v2-card-body"><h2>2 · Satırlar</h2>
      <p class="pd-muted">Özgün belgeyi açarak her satırı karşılaştır; eksik okunan alanı kendin doldur.
        Bir satır aynı boyun birkaç çeşidini içeriyorsa (örneğin bitki besini 500 ml) ürün ailesini seç — adetleri sonraki adımda gireceksin.</p>
      <form data-pd-form="lines">${state.lines.map(lineCard).join('')}
        <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="add-line">+ Satır ekle</button>
          <button class="secondary" type="button" data-pd="back-document">← Geri</button>
          <button class="primary" type="submit">Devam →</button></div></form></section>`;
  }

  function ozetView() {
    const d = state.queueDone, islendi = d.filter(x => x.sonuc === 'islendi'), taslak = d.filter(x => x.sonuc === 'taslak'),
      atlanan = d.filter(x => x.sonuc !== 'taslak' && x.sonuc !== 'islendi');
    const eslesme = x => (x.eslesen || []).length ? `<br><span class="pd-muted">${x.eslesen.map(m => esc(m.description) + ' → ' + esc(m.product_name) + ' (' + esc(m.how) + ')').join('<br>')}</span>` : '';
    return `<section class="v2-card v2-card-body"><h2>Toplu yükleme bitti</h2>
      <p class="pd-alert ${atlanan.length || taslak.length ? 'info' : 'ok'}">${islendi.length} fatura muhasebeleşti ve stoğa girdi${taslak.length ? `, ${taslak.length} fatura taslakta bekliyor` : ''}${atlanan.length ? `, ${atlanan.length} dosya işlenmedi` : ''}.</p>
      ${islendi.length ? `<h3>Muhasebeleşti ve stoğa girdi</h3><ul class="pd-list">${islendi.map(x => `<li>${esc(x.fatura || x.ad)}${eslesme(x)}</li>`).join('')}</ul>` : ''}
      ${taslak.length ? `<h3>Taslakta bekleyenler</h3><ul class="pd-list">${taslak.map(x => `<li>${esc(x.fatura || x.ad)}${x.sebep ? ' — ' + esc(x.sebep) : ''}</li>`).join('')}</ul>` : ''}
      ${atlanan.length ? `<h3>İşlenmeyenler</h3><ul class="pd-list">${atlanan.map(x => `<li>${esc(x.ad)} — ${esc(x.sebep || '')}</li>`).join('')}</ul>
        <p class="pd-muted">Bunları tek tek yükleyip tamamlayabilirsin. Aynı belge ikinci kez kayıt yaratmaz.</p>` : ''}
      <div class="pd-actions"><button class="secondary" type="button" data-pd="restart">Yeni dosya yükle</button>
        <button class="primary" type="button" data-pd="close">Alış faturalarına dön</button></div></section>`;
  }

  function allocateView() {
    const familyLines = state.lines.map((l, i) => ({...l, i})).filter(l => l.family_id && l.line_type !== 'expense');
    if (!familyLines.length)
      return `<section class="v2-card v2-card-body"><h2>3 · Çeşit dağılımı</h2>
        <p class="pd-alert info">Bu faturada çeşide dağıtılacak satır yok.</p>
        <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="back-lines">← Geri</button>
          <button class="primary" type="button" data-pd="to-confirm">Kontrole geç →</button></div></section>`;
    return `<section class="v2-card v2-card-body"><h2>3 · Çeşit dağılımı</h2>
      <p class="pd-muted">Adetleri <b>bu belgedeki gerçek teslim/irsaliye bilgisine göre</b> gir. Önceki faturanın adetleri veya oranı otomatik uygulanmaz.
        Altı çeşidin tümünü almak zorunda değilsin; yalnız gelenleri seç.</p>
      ${familyLines.map(line => {
        const fam = state.families.find(fam => fam.id === line.family_id);
        const total = Math.round((Number(line.stock_quantity ?? line.invoice_quantity) || 0) * 1000);
        const used = (line.allocations || []).reduce((s, a) => s + Math.round((Number(a.quantity) || 0) * 1000), 0);
        const left = total - used;
        return `<div class="pd-alloc" data-pd-alloc="${line.i}">
          <div class="pd-alloc-head"><h3>${esc(fam?.name || 'Ürün ailesi')}${fam?.size_label ? ' · ' + esc(fam.size_label) : ''}</h3>
            <span class="pd-remaining ${left === 0 ? 'good' : 'bad'}">Dağıtılan ${num(used / 1000)} / ${num(total / 1000)} ${esc(fam?.stock_unit || '')} · kalan ${num(left / 1000)}</span></div>
          <p class="pd-muted">${esc(line.description)}</p>
          ${(line.allocations || []).map((a, k) => `<div class="pd-variant">
            <label>Çeşit<select data-pd-variant="${line.i}" data-k="${k}" data-field="product_id">
              <option value="">Çeşidi seç…</option>
              ${(fam?.members || []).map(m => `<option value="${esc(m.product_id)}" ${a.product_id === m.product_id ? 'selected' : ''}>${esc(m.name)} · ${esc(m.sku)}</option>`).join('')}</select></label>
            <label>Adet<input type="number" step="0.001" min="0" value="${esc(a.quantity ?? '')}" data-pd-variant="${line.i}" data-k="${k}" data-field="quantity"></label>
          </div>`).join('')}
          <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="add-variant" data-i="${line.i}">+ Çeşit ekle</button></div>
          <label class="pd-muted"><input type="checkbox" data-pd-equal="${line.i}" ${line.equal_unit_cost ? 'checked' : ''}> Çeşitlerin birim alış maliyeti aynı; toplam maliyet adede göre bölünsün.</label>
          <label>Adetlerin kaynağı<input data-pd-reason="${line.i}" value="${esc(line.reason || '')}" maxlength="500" placeholder="örn. irsaliye no / mal kabul"></label>
        </div>`;
      }).join('')}
      <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="back-lines">← Geri</button>
        <button class="secondary" type="button" data-pd="save-draft">Belirsiz; taslağı kaydet</button>
        <button class="primary" type="button" data-pd="to-confirm">Kontrole geç →</button></div></section>`;
  }

  function confirmView() {
    const net = state.lines.reduce((s, l) => s + round2(l.net), 0), tax = state.lines.reduce((s, l) => s + round2(l.tax), 0);
    const d = state.totals || {};
    const cmp = (label, ours, theirs) => {
      const off = theirs !== null && theirs !== undefined && Math.abs(round2(ours) - round2(theirs)) > 0.011;
      return `<div class="pd-total ${off ? 'bad' : ''}"><span>${esc(label)}</span><strong>${money(ours)}</strong>
        <span>${theirs === null || theirs === undefined ? 'Belgede okunamadı' : 'Belgede: ' + money(theirs) + (off ? ' — FARKLI' : ' ✓')}</span></div>`;
    };
    const problems = [];
    for (const [i, l] of state.lines.entries()) {
      if (l.line_type !== 'expense' && !l.family_id && !l.product_id) problems.push('Satır ' + (i + 1) + ': ürün eşleştirilmedi.');
      if (l.family_id) {
        const total = Math.round((Number(l.stock_quantity ?? l.invoice_quantity) || 0) * 1000);
        const used = (l.allocations || []).reduce((s, a) => s + Math.round((Number(a.quantity) || 0) * 1000), 0);
        if (used !== total) problems.push('Satır ' + (i + 1) + ': çeşit dağılımı tamamlanmadı (kalan ' + num((total - used) / 1000) + ').');
        if ((l.allocations || []).some(a => !a.product_id)) problems.push('Satır ' + (i + 1) + ': çeşit seçilmemiş satır var.');
        if (!l.equal_unit_cost) problems.push('Satır ' + (i + 1) + ': eşit birim maliyet onayı gerekiyor.');
        if (!String(l.reason || '').trim()) problems.push('Satır ' + (i + 1) + ': adetlerin kaynağını yaz.');
      }
    }
    return `<section class="v2-card v2-card-body"><h2>4 · Kontrol ve onay</h2>
      <div class="pd-totals">${cmp('Genel toplam · KDV dahil', net + tax, d.gross)}${cmp('Satırların net toplamı · KDV hariç', net, d.net)}${cmp('Satırların KDV toplamı', tax, d.tax)}</div>
      <p class="pd-muted">Belgedeki toplam okunamadıysa karşılaştırma yapılamaz; tutarları belgeden kendin doğrula. Belge düzeyi iskonto veya farklı vergi yapısı varsa satırlar elle düzeltilmelidir.</p>
      ${problems.length ? `<p class="pd-alert warn">Kesinleştirmeden önce: <br>${problems.map(esc).join('<br>')}</p>` : '<p class="pd-alert ok">Eksik görünmüyor.</p>'}
      <p class="pd-alert info">Kaydet dediğinde fatura oluşur. Bütün satırlar stok kartına bağlıysa sistem kendiliğinden <b>muhasebeleştirir</b> (cari borç) ve fatura tarihiyle <b>stoğa alır</b>. Çeşit dağılımı olan ya da ürünü bulunamayan satır varsa taslak kalır.</p>
      <div class="pd-actions"><button class="secondary pd-left" type="button" data-pd="back-allocate">← Geri</button>
        <button class="primary" type="button" data-pd="save-draft">Taslağı oluştur ve belgeyi bağla</button></div></section>`;
  }

  function render() {
    if(signal.aborted)return;
    prepareWorkflow(root);
    const body = state.step === 'pick' ? pickView() : state.step === 'document' ? documentView()
      : state.step === 'summary' ? ozetView()
        : state.step === 'lines' ? linesView() : state.step === 'allocate' ? allocateView() : confirmView();
    const withPreview = state.step !== 'pick';
    root.innerHTML = `<div class="pd workflow-page">
      <div class="pd-head"><div><span class="eyebrow">İşlemler / Alış faturası</span><h1>Alış faturası yükle</h1><p class="pd-muted">Belgeyi yükle, oku, kontrol et, onayla.</p></div>
        <button class="secondary" type="button" data-pd="close">← Alış faturaları</button></div>
      ${state.step === 'pick' ? '' : steps()}${status()}
      ${withPreview ? `<div class="pd-split"><div class="pd-work">${body}</div>${preview()?`<details class="workflow-details pd-document-preview"><summary>Özgün belgeyi göster</summary>${preview()}</details>`:''}</div>` : body}
      ${state.busy ? '<p class="rb-busy" role="status">İşleniyor…</p>' : ''}</div>`;
    root.setAttribute('aria-busy',String(state.busy));
    if(state.busy)for(const control of root.querySelectorAll('button,input,select,textarea'))control.disabled=true;
  }

  /* ---------------- işlemler ---------------- */
  async function loadReference() {
    if (!state.catalog) state.catalog = await api('/catalog');
    const {families} = await api('/invoices/families');
    state.families = families;
  }

  /* ---------------- toplu yukleme kuyrugu ---------------- */
  // Kullanicinin onaylamasi gereken seyler faturaya OZELdir: tedarikci taninmadiysa, satirlar
  // okunamadiysa, okunan bir alan supheliyse ya da bir kalem ceside dagitilacaksa. Bunlarin
  // hicbirinde sistem karar uyduramaz. Geri kalaninda duracak bir sey yoktur: taslak kendiliginden
  // olusur. Taslak cari borc ve stok YAZMAZ; muhasebelestirme yine ayri ve bilincli adimdir.
  // Tedarikci belgede YAZIYOR: unvan ve VKN okunduysa kayitli degilse bile acilabilir. Bu veri
  // uydurmak degil, belgeden okunani kullanmaktir. Yalniz VKN suphesizse ve bicimi dogruysa.
  async function tedarikciyiCoz() {
    const h = state.header || {}, liste = state.catalog?.suppliers || [];
    const vkn = String(h.supplier_tax_id || '').trim();
    const eslesen = vkn && liste.find(x => x.tax_id === vkn);
    if (eslesen) { state.supplierId = eslesen.id; return null; }
    if (!/^[0-9]{10,11}$/.test(vkn) || h.uncertain?.includes('supplier_tax_id')) return 'Tedarikçi VKN okunamadı';
    if (!String(h.supplier_name || '').trim() || h.uncertain?.includes('supplier_name')) return 'Tedarikçi unvanı okunamadı';
    const yeni = await api('/suppliers', {name: h.supplier_name.trim(), tax_id: vkn});
    state.supplierId = yeni.id;
    state.catalog = await api('/catalog');
    return null;
  }

  // Öneri kaynakları: elle hatırlanan bağlar, ürün aileleri ve tedarikçinin geçmiş alışları.
  async function oneriKaynaklari() {
    const {links, families} = await api('/invoices/families');
    state.familyLinks = links; state.families = families;
    state.purchaseHistory = state.supplierId ? (await api('/invoices/match-history?' + new URLSearchParams({supplier_id: state.supplierId}))).rows : [];
  }

  // Satir -> urun baglantilari tedarikci bazinda HATIRLANIR. Elle yolda uygulaniyordu ama
  // otomatik yolda atlaniyordu: taslak urunsuz satirla olusuyordu. Ayni oneri burada da uygulanir.
  async function hatirlananlariUygula() {
    await oneriKaynaklari();
    state.lines.forEach((_, i) => { try { applyLink(i); } catch { /* öneri zorunlu değil */ } });
  }

  function otomatikEngel() {
    const h = state.header || {};
    if (h.own_issued) return 'Bu faturayı şirketiniz kesmiş (satış faturası); alış olarak işlenmez';
    if (h.uncertain?.length) return 'Belgede kesin okunamayan alan var';
    if (!h.invoice_no || !h.invoice_date) return 'Fatura numarası veya tarihi okunamadı';
    if (!state.lines?.length) return 'Satır okunamadı';
    if (state.lines.some(l => !String(l.description || '').trim() || !(Number(l.invoice_quantity) > 0) || l.net === '' || l.net === null || l.net === undefined))
      return 'Satırlarda eksik alan var';
    if (state.lines.some(l => l.uncertain?.length)) return 'Satırlarda kesin okunamayan alan var';
    // Tek dosya da otomatik işlendiği için okunan satırlar belgenin kendi toplamıyla doğrulanır:
    // bir satır eksik ya da yanlış okunduysa durulur, kullanıcıya gösterilir.
    const t = state.totals || {};
    if (t.net === null || t.net === undefined) return 'Belgedeki toplam okunamadı; satırlar toplamla karşılaştırılamadı';
    if (Math.abs(state.lines.reduce((s, l) => s + (Number(l.net) || 0), 0) - t.net) > 0.01) return 'Satırların toplamı belgedeki toplamla tutmuyor';
    if (t.tax !== null && t.tax !== undefined && Math.abs(state.lines.reduce((s, l) => s + (Number(l.tax) || 0), 0) - t.tax) > 0.05)
      return 'Satırların KDV toplamı belgedekiyle tutmuyor';
    // Cesit dagilimi belgede YAZMAZ: "5'li set 10 adet" satiri hangi cesitten kac adet
    // oldugunu soylemez. Hatirlanan bag yalnizca "bu satir su urun ailesine gider" bilgisidir,
    // adetleri degil. Burada karar uydurulamaz; kullanici girer.
    if (state.lines.some(l => l.family_id && l.line_type !== 'expense')) return 'Çeşide dağıtılacak kalem var';
    return null;
  }

  // BİRLEŞTİRİLMİŞ PDF. EDM'den "hepsini indir" denince tek dosyada birden çok fatura gelir.
  // Sayfa sayfa okunan satırlardan her sayfanın fatura numarası çıkarılır; numarası olmayan
  // sayfa bir öncekinin devamı sayılır (çok sayfalı fatura). En az İKİ ayrı numara yoksa
  // bölme YAPILMAZ: tek fatura gibi işlenir. Bölme uydurulmaz, numaraya dayanır.
  // Ayırma mantığı pdf-read.js:splitInvoices'tadır (testler de onu sınar).
  const faturalaraAyir = splitInvoices;

  // Çalışma alanının kendi şirketi: faturada ALICI olarak geçer. Bilinmezse okuyucu belgedeki
  // ilk VKN'yi tedarikçi sanıyordu; birleşik belgede bu bizim numaramızdı.
  async function loadOwn() {
    if (state.own) return state.own;
    try {
      const {settings} = await api('/settings');
      state.own = {taxIds: [settings?.tax_id].filter(Boolean), name: settings?.legal_name || ''};
    } catch { state.own = {taxIds: [], name: ''}; }
    return state.own;
  }

  // Birleşik belgenin BİR faturasını işlenecek hâle getirir. Belge yeniden yüklenmez:
  // aynı docId paylaşılır, sayfa bağlantısı taslak oluşunca kurulur.
  function bolumuAc(is) {
    const b = is.bolum;
    state.docId = is.docId;
    state.warnings = [];
    state.header = guessHeader(b.satirlar, state.own || {});
    state.totals = guessTotals(b.satirlar);
    state.lines = guessLines(b.satirlar).map(l => ({...l, line_type: 'product', expense_category: 'other', source: l.description}));
    if (!state.lines.length) state.lines = [{description: '', invoice_quantity: 1, invoice_unit: 'adet', net: '', tax: '', line_type: 'product', expense_category: 'other', uncertain: []}];
    state.sayfaNo = b.sayfalar[0];
    state.supplierId = '';
    state.step = 'document';
  }

  async function kuyrugaAl(files, kind) {
    state.queue = files.map(f => ({file: f, kind: /\.xml$/i.test(f.name) ? 'xml' : kind}));
    state.queueTotal = files.length; state.queueDone = []; state.auto = true;
    await siradakini();
  }

  async function siradakini() {
    const sonraki = state.queue.shift();
    if (!sonraki) { state.step = 'summary'; render(); return; }
    const sira = state.queueTotal - state.queue.length;
    const ad = sonraki.bolum ? sonraki.dosyaAdi + ' · ' + (sonraki.bolum.no || 'fatura') : sonraki.file.name;
    ilerle(state.queueTotal > 1 ? ad + ' — ' + sira + ' / ' + state.queueTotal : ad);
    try {
      if (sonraki.bolum) bolumuAc(sonraki);
      else await takeFile(sonraki.file, sonraki.kind);
    } catch (e) {
      state.queueDone.push({ad, sonuc: 'atlandi', sebep: e.message});
      if (state.queueTotal > 1) { await siradakini(); return; }
      throw e;
    }
    // Birleşik belgenin parçaları ayrı ayrı sıraya alındı; bu turda işlenecek bir şey yok.
    if (state.parts?.length && !sonraki.bolum) { state.parts = null; await siradakini(); return; }
    if (!state.auto) return;
    const tedarikciSorun = await tedarikciyiCoz();
    if (!tedarikciSorun) await hatirlananlariUygula();
    const engel = tedarikciSorun || otomatikEngel();
    if (engel) {
      state.queueDone.push({ad, sonuc: 'bekliyor', sebep: engel});
      state.auto = false; // bu dosyada duruluyor; kullanici bitirince kuyruk devam eder
      say(engel + '. Bu faturayı birlikte tamamlayalım; bitince kalan ' + state.queue.length + ' dosya kendiliğinden işlenecek.');
      return;
    }
    try {
      await saveDraft();
      const auto = state.lastAuto || {};
      state.queueDone.push({ad, sonuc: auto.status === 'posted' && auto.received ? 'islendi' : 'taslak', fatura: state.header.invoice_no,
        sebep: auto.status === 'posted' && auto.received ? '' : auto.reason || '', eslesen: auto.mapped || []});
    } catch (e) {
      state.queueDone.push({ad, sonuc: 'atlandi', sebep: e.message});
    }
    await siradakini();
  }

  // e-Arsiv/e-Fatura PDF'leri "<VKN>-<FaturaNo>-<ETTN>.pdf" adiyla gelir. Taranmis belgede
  // yazi katmani olmadigi icin ic okunamaz ama DOSYA ADI bu ucunu tasir. Bu veri uydurmak
  // degildir: adlandirmayi belgeyi kesen sistem koyar. Yalniz bicim tam tutuyorsa kullanilir ve
  // BELGEDEN okunan bir deger varsa onun uzerine YAZILMAZ.
  const DOSYA_ADI = /^(\d{10,11})[-_]([A-Za-z0-9]{3,32})[-_]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.(pdf|xml)$/i;
  function adtanOku(ad, header) {
    const m = DOSYA_ADI.exec(String(ad || '').trim());
    if (!m) return [];
    const [, vkn, no, uuid] = m, alindi = [];
    // Adın başındaki numara çoğu zaman ALICININ (bizim) numaramızdır; o tedarikçi sayılmaz.
    if (!header.supplier_tax_id && !(state.own?.taxIds || []).includes(vkn)) { header.supplier_tax_id = vkn; alindi.push('VKN'); }
    if (!header.invoice_no) { header.invoice_no = no.toUpperCase(); alindi.push('fatura numarası'); }
    if (!header.uuid) { header.uuid = uuid.toLowerCase(); alindi.push('ETTN'); }
    if (alindi.length) header.uncertain = (header.uncertain || []).filter(k =>
      !(k === 'supplier_tax_id' && alindi.includes('VKN')) && !(k === 'invoice_no' && alindi.includes('fatura numarası')));
    return alindi;
  }

  async function takeFile(file, kind) {
    if (file.size > PDF_LIMITS.fileBytes) throw new Error('Belge 20 MB sınırını aşıyor.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.file = file; state.bytes = bytes; state.kind = kind; state.warnings = [];
    let header, lines = [], totals = null, pageCount = null, textLayer = 1;
    const own = await loadOwn();

    if (kind === 'pdf') {
      const pdf = await readPdf(bytes, {name: file.name});
      state.extracted = pdf; pageCount = pdf.pages; textLayer = pdf.textLayer ? 1 : 0;
      state.warnings.push(...pdf.warnings);
      header = guessHeader(pdf.lines, own);
      totals = guessTotals(pdf.lines);
      lines = guessLines(pdf.lines).map(l => ({...l, line_type: 'product', expense_category: 'other', source: l.description}));
      if (pdf.textLayer && !lines.length)
        state.warnings.push('Belgenin yazıları okundu ama satır düzeni tanınamadı. Satırları elle girebilirsin; belge yanında duruyor.');
    } else {
      const xml = parseInvoiceXML(new TextDecoder().decode(bytes));
      state.extracted = {lines: [], text: ''};
      header = {invoice_no: xml.invoice_no, invoice_date: xml.invoice_date, uuid: xml.uuid,
        supplier_tax_id: xml.supplier_tax_id, supplier_name: xml.supplier_name, receiver_tax_id: xml.receiver_tax_id, uncertain: []};
      lines = xml.lines.map(l => ({...l, line_type: 'product', expense_category: 'other', uncertain: []}));
      totals = {net: lines.reduce((s, l) => s + l.net, 0), tax: lines.reduce((s, l) => s + l.tax, 0), gross: null};
      totals.gross = totals.net + totals.tax;
    }
    // Belgeden okunamayan kimlik alanlari dosya adindan tamamlanir (e-Arsiv adlandirmasi).
    const adtan = adtanOku(file.name, header);
    if (adtan.length) state.warnings.push('Belgeden okunamayan ' + adtan.join(', ') + ' dosya adından alındı (e-Arşiv adlandırması). Kontrol et.');
    state.header = header; state.totals = totals;
    state.lines = lines.length ? lines : [{description: '', invoice_quantity: 1, invoice_unit: 'adet', net: '', tax: '', line_type: 'product', expense_category: 'other', uncertain: []}];

    // Birleşik belge ÖNCE tanınır. Belgenin kimliği tek bir faturanınki değildir: ilk okunan
    // fatura numarasıyla kaydedilirse, içindeki faturalardan biri daha önce işlendiği için
    // BÜTÜN dosya "mükerrer" diye reddedilir ve diğer faturalar hiç işlenmez. Mükerrer kontrolü
    // birleşik belgede her fatura için ayrı yapılır (taslak oluşturulurken).
    const gruplar = kind === 'pdf' ? faturalaraAyir(state.extracted?.pageLines) : [];
    const birlesik = gruplar.length > 1;

    // Belgeyi ÖNCE sakla ve mükerrer kontrolünü yap: veri girmeden önce uyarılsın.
    const created = await api('/invoices/documents', {kind, filename: file.name, mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'application/xml'),
      size_bytes: bytes.length, sha256: await sha256Hex(bytes), chunk_count: Math.max(1, Math.ceil(bytes.length / CHUNK)),
      page_count: pageCount, text_layer: textLayer, supplier_tax_id: birlesik ? '' : header.supplier_tax_id || '', doc_no: birlesik ? '' : header.invoice_no || '',
      doc_uuid: birlesik ? '' : header.uuid || '', extracted: birlesik ? {invoices: gruplar.map(g => g.no), pages: gruplar.map(g => g.sayfalar)} : {header, totals, line_count: lines.length},
      warnings: state.warnings});
    if (created.duplicate) { state.step = 'pick'; throw new Error(created.notice); }
    if (created.reread) state.warnings.push(created.notice);
    state.docId = created.id;
    if (!created.resume) {
      const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
      for (let i = 0; i < chunks; i++)
        await api('/invoices/documents/' + state.docId + '/chunk', {index: i, data: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK))});
    }
    await api('/invoices/documents/' + state.docId + '/seal', {});

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = kind === 'pdf' ? URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'})) : null;
    await loadReference();

    // Belge birden çok fatura taşıyorsa her fatura AYRI bir iş olarak sıraya alınır. Dosya
    // çoğaltılmaz: aynı belge kimliği paylaşılır, sayfa bağlantısı sonunda kurulur.
    if (birlesik) {
      state.warnings.push(gruplar.length + ' fatura tek belgede geldi (' + gruplar.map(g => g.no || '?').join(', ') +
        '). Her biri ayrı fatura olarak işlenecek; belge bir kez saklandı.');
      state.parts = gruplar.map(g => ({no: g.no, sayfalar: g.sayfalar, satirlar: g.satirlar}));
      state.queue.unshift(...state.parts.map(p => ({bolum: p, docId: state.docId, dosyaAdi: file.name})));
      // Dosyanın kendisi bir iş sayılmıştı; artık yerini faturaları alır ("1 / 5" … "5 / 5").
      state.queueTotal += state.parts.length - 1;
      // Tek dosya da olsa içindeki faturalar sırayla kendiliğinden işlenir. Duran fatura
      // (tanınmayan tedarikçi, şüpheli alan) yine kullanıcıya sorulur.
      state.auto = true;
      state.step = 'document';
      return;
    }

    // Kayıtlı tedarikçi satır eşleştirmeleri ve aile hatırlatmaları öneri olarak uygulanır.
    state.step = 'document';
    say('Belge saklandı. Okunan bilgiler aday olarak dolduruldu; kontrol et.');
  }

  const readForm = form => Object.fromEntries(new FormData(form).entries());

  function collectLines(form) {
    state.lines = [...form.querySelectorAll('[data-pd-line]')].map((el, i) => {
      const v = name => el.querySelector(`[name="${name}"]`)?.value ?? '';
      const prior = state.lines[i] || {};
      const enteredNumber = name => v(name)===''?'':Number(v(name));
      return {...prior, description: v('description'), external_code: v('external_code'),
        invoice_quantity: enteredNumber('invoice_quantity'), invoice_unit: v('invoice_unit'),
        net: enteredNumber('net'), tax: enteredNumber('tax'), line_type: v('line_type'),
        expense_category: v('expense_category'), expense_treatment: v('expense_treatment'),
        product_id: v('product_id') || null, stock_quantity: Number(v('stock_quantity')) || null,
        family_id: v('family_id') || null,
        allocations: v('family_id') ? (prior.family_id === v('family_id') ? prior.allocations || [{}, {}] : [{}, {}]) : null};
    });
  }

  /** Kayıtlı tedarikçi bağlantısı: aynı kod/ad ve birim sonraki faturada aynı karta bağlanır. */
  function applyLink(index) {
    const line = state.lines[index], supplier = state.supplierId;
    if (!supplier) throw new Error('Önce kayıtlı bir tedarikçi seçin.');
    const value = (line.external_code || '').trim() || (line.description || '').trim();
    const matchBy = (line.external_code || '').trim() ? 'code' : 'name';
    const fam = (state.familyLinks || []).find(l => l.supplier_id === supplier && l.match_by === matchBy && l.match_value === value && l.source_unit === line.invoice_unit);
    if (fam) {
      line.family_id = fam.family_id;
      line.stock_quantity = Number(line.invoice_quantity) * fam.units_per_invoice_unit_milli / 1000;
      line.allocations = [{}, {}];
      line.status_text = 'Bu satır kayıtlı ürün ailesine yönlendirildi. Çeşit adetlerini bu belgeye göre gireceksin.';
      return;
    }
    const mapping = (state.catalog.mappings || []).find(m => m.source === 'purchase' && m.supplier_id === supplier && m.active === 1 &&
      m.match_by === matchBy && m.match_value === value && m.source_unit === line.invoice_unit);
    if (!mapping) {
      // GEÇMİŞTEN: aynı tedarikçinin muhasebeleşmiş faturalarında bu kod/açıklama hangi karta
      // gittiyse o. Kural sunucuyla ortaktır (purchase-match.js): kaydedince de aynısı yapılır.
      const hit = matchFromHistory(line, state.purchaseHistory || []);
      if (hit) {
        line.product_id = hit.product_id; line.family_id = null; line.allocations = null;
        line.stock_quantity = Number(line.invoice_quantity) * hit.ratio / 1000;
        line.status_text = 'Geçmiş faturalardan eşlendi (' + hit.how + '): ' + hit.product_name + ' · ' + num(line.stock_quantity) + '. Kontrol et.';
        return;
      }
      // Kod geçmişte birden çok ÇEŞİDE dağıtıldıysa ve belgede hangisi olduğu yazmıyorsa ürün
      // ailesine yönlendirilir: yalnız çeşit adetleri sorulur (adet belgede yazmaz, uydurulmaz).
      const kod = codeOf(line), cesitler = [...new Set((state.purchaseHistory || []).filter(h => h.invoice_unit === line.invoice_unit && kod && codeOf(h) === kod).map(h => h.product_id))];
      const aile = cesitler.length > 1 && (state.families || []).find(f => cesitler.every(id => f.members.some(m => m.product_id === id)));
      if (aile) {
        line.family_id = aile.id; line.product_id = null; line.stock_quantity = Number(line.invoice_quantity); line.allocations = [{}, {}];
        line.status_text = 'Bu kod geçmişte ' + cesitler.length + ' çeşide dağıtıldı; belgede hangisi olduğu yazmıyor. Sonraki adımda çeşit adetlerini gir.';
        return;
      }
      line.status_text = 'Bu tedarikçiden bu kodla/adla daha önce muhasebeleşmiş alış yok. Ürünü seçip "hatırla" diyebilirsin.';
      return;
    }
    const parts = (state.catalog.components || []).filter(c => c.mapping_id === mapping.id);
    if (parts.length !== 1) { line.status_text = 'Alış bağlantısı tek stok kartına bağlanmalı.'; return; }
    line.product_id = parts[0].product_id;
    line.family_id = null; line.allocations = null;
    line.stock_quantity = Number(line.invoice_quantity) * parts[0].quantity_milli / 1000;
    const p = state.catalog.products.find(p => p.id === parts[0].product_id);
    line.status_text = 'Kayıtlı bağlantı uygulandı: ' + (p?.name || 'Ürün') + ' · ' + num(line.stock_quantity) + ' ' + (p?.stock_unit || '') + '. Kontrol et.';
  }

  async function rememberLink(index) {
    const line = state.lines[index], supplier = state.supplierId;
    if (!supplier) throw new Error('Bağlantıyı hatırlamak için kayıtlı bir tedarikçi seçin.');
    const value = (line.external_code || '').trim() || (line.description || '').trim();
    const matchBy = (line.external_code || '').trim() ? 'code' : 'name';
    if (!value || !line.invoice_unit) throw new Error('Önce tedarikçi kodu/adı ve fatura birimini doldurun.');
    const perUnit = Number(line.stock_quantity) / Number(line.invoice_quantity);
    if (!Number.isFinite(perUnit) || perUnit <= 0) throw new Error('Önce miktar ve stok karşılığını doldurun.');
    if (line.family_id) {
      await api('/invoices/families/link', {supplier_id: supplier, match_by: matchBy, match_value: value,
        source_unit: line.invoice_unit, family_id: line.family_id, units_per_invoice_unit: perUnit});
      line.status_text = 'Aile hatırlandı. Sonraki faturada bu satır yine bu aileye yönlendirilir; adetler yine sorulur.';
    } else {
      if (!line.product_id) throw new Error('Önce bizdeki ürünü seçin.');
      await api('/catalog/mappings', {source: 'purchase', supplier_id: supplier, external_code: matchBy === 'code' ? value : '',
        external_name: matchBy === 'name' ? value : (line.description || ''), source_unit: line.invoice_unit, match_by: matchBy,
        components: [{product_id: line.product_id, quantity_milli: Math.round(perUnit * 1000), revenue_share_bps: 10000}]});
      line.status_text = 'Bağlantı kaydedildi. Aynı tedarikçi ve birimde sonraki alışlar bu karta bağlanacak.';
    }
    state.catalog = await api('/catalog');
    const {families} = await api('/invoices/families');
    state.families = families;
  }

  /** Taslağı oluşturur, çeşitleri dağıtır ve belgeyi kayda bağlar. Borç/stok YAZMAZ. */
  async function saveDraft() {
    const h = state.header;
    let supplier = state.supplierId;
    if (!supplier) {
      if (!h.supplier_name) throw new Error('Tedarikçiyi seçin ya da yeni tedarikçi unvanını yazın.');
      supplier = (await api('/suppliers', {name: h.supplier_name, tax_id: h.supplier_tax_id || ''})).id;
      state.catalog = await api('/catalog');
    }
    const payload = state.lines.map(l => ({
      description: l.description, external_code: l.external_code || '', invoice_quantity: Number(l.invoice_quantity),
      invoice_unit: l.invoice_unit, net: round2(l.net), tax: round2(l.tax), line_type: l.line_type,
      expense_category: l.expense_category, expense_treatment: l.expense_treatment || '',
      // Aile satırı önce TEK karta bağlanır; hemen ardından gerçek çeşitlere dağıtılır.
      product_id: l.line_type === 'expense' ? null : l.family_id ? (l.allocations || []).find(a => a.product_id)?.product_id || null : l.product_id,
      stock_quantity: l.line_type === 'expense' ? undefined : Number(l.stock_quantity ?? l.invoice_quantity)
    }));
    const invoice = await api('/invoices', {supplier_id: supplier, invoice_no: h.invoice_no, uuid: h.uuid || '',
      invoice_date: h.invoice_date, currency: 'TRY', source: state.kind === 'xml' ? 'xml' : 'pdf',
      receiver_tax_id: h.receiver_tax_id || '', lines: payload});

    const saved = await api('/invoices/' + invoice.id);
    const notes = [];
    for (const [i, l] of state.lines.entries()) {
      if (!l.family_id || l.line_type === 'expense') continue;
      const target = saved.lines[i];
      const allocations = (l.allocations || []).filter(a => a.product_id && Number(a.quantity) > 0);
      if (!target || !allocations.length) { notes.push('Satır ' + (i + 1) + ': çeşit dağılımı yapılmadı, fatura ekranından tamamlayabilirsin.'); continue; }
      try {
        await api('/invoices/' + invoice.id + '/split', {line_id: target.id, total_quantity: Number(l.stock_quantity ?? l.invoice_quantity),
          family_id: l.family_id, equal_unit_cost: !!l.equal_unit_cost, reason: l.reason, allocations});
      } catch (e) { notes.push('Satır ' + (i + 1) + ': dağılım kaydedilemedi — ' + e.message); }
    }
    // Birleşik belgede bütün belgeyi tek faturaya bağlamak yanlış olur: hangi sayfanın hangi
    // faturaya ait olduğu kaydedilir. Sunucu bunu kanıt sayar ve sonradan taşınmaz.
    if (state.sayfaNo) {
      try { await api('/invoices/documents/' + state.docId + '/pages', {pages: [{page_no: state.sayfaNo, invoice_id: invoice.id, doc_no: state.header.invoice_no || '', doc_uuid: state.header.uuid || ''}]}); }
      catch (e) { notes.push('Sayfa bağlantısı kurulamadı: ' + e.message); }
    } else {
      try { await api('/invoices/documents/' + state.docId + '/link', {invoice_id: invoice.id}); }
      catch (e) { notes.push('Belge bağlanamadı: ' + e.message); }
    }
    // Geçmişte aynı satırlar hangi karta bağlandıysa ona bağlanır; hepsi bağlanırsa fatura
    // muhasebeleşir ve fatura tarihiyle stoğa girer. Bağlanamayan satır varsa taslak kalır.
    state.lastAuto = null;
    try { state.lastAuto = await api('/invoices/' + invoice.id + '/autocomplete', {}); }
    catch (e) { state.lastAuto = {status: 'draft', reason: 'Otomatik tamamlanamadı: ' + e.message}; }
    const auto = state.lastAuto;
    say(auto?.status === 'posted'
      ? (auto.received ? 'Fatura muhasebeleşti ve ' + h.invoice_date + ' tarihiyle stoğa girdi.' : auto.reason || 'Fatura muhasebeleşti.')
      : 'Taslak oluşturuldu; cari borç ve stok henüz yazılmadı. ' + (auto?.reason || '')
    + (notes.length ? ' ' + notes.join(' ') : ''));
    // Otomatik akışta kuyruğu siradakini() ilerletir ve sonucu o yazar. Burada da ilerletilirse
    // her fatura özete iki kez yazılıyordu ("8 taslak" — gerçekte 4).
    if (state.auto) return;
    // Kuyrukta dosya varsa ekran KAPANMAZ: kullanici her faturadan sonra yeniden yuklemeye
    // donmek zorunda kalmasin. Elle tamamlanan faturadan sonra otomatik isleme yeniden acilir.
    if (state.queue.length) {
      state.queueDone.push({ad: state.file?.name || '', sonuc: 'taslak', fatura: state.header?.invoice_no});
      state.auto = true;
      await siradakini();
      return;
    }
    state.step = state.queueTotal > 1 ? 'summary' : 'done';
    if (state.queueTotal > 1) { state.queueDone.push({ad: state.file?.name || '', sonuc: 'taslak', fatura: state.header?.invoice_no}); render(); return; }
    onClose?.({invoiceId: invoice.id});
  }

  /* ---------------- olaylar ---------------- */
  root.addEventListener('change', e => {
    const t = e.target.dataset.pd;
    if (t === 'file' && e.target.files.length) { const fs = [...e.target.files]; run(() => kuyrugaAl(fs, 'pdf')); return; }
    if (t === 'xml' && e.target.files.length) { const fs = [...e.target.files]; run(() => kuyrugaAl(fs, 'xml')); return; }
    if (e.target.dataset.pdVariant !== undefined) {
      const line = state.lines[Number(e.target.dataset.pdVariant)], k = Number(e.target.dataset.k);
      line.allocations = line.allocations || [];
      line.allocations[k] = {...line.allocations[k], [e.target.dataset.field]: e.target.dataset.field === 'quantity' ? e.target.value : e.target.value};
      render(); return;
    }
    if (e.target.dataset.pdEqual !== undefined) { state.lines[Number(e.target.dataset.pdEqual)].equal_unit_cost = e.target.checked; return; }
    if (e.target.dataset.pdReason !== undefined) { state.lines[Number(e.target.dataset.pdReason)].reason = e.target.value; return; }
    if (e.target.name === 'supplier_id') state.supplierId = e.target.value;
  }, {signal});

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pd]');
    if (!b) return;
    const a = b.dataset.pd, i = Number(b.dataset.i);
    const lineForm=root.querySelector('[data-pd-form="lines"]');
    if(lineForm&&['add-line','remove-line','back-document','apply-link','remember-link'].includes(a))collectLines(lineForm);
    if (a === 'close') { onClose?.({}); return; }
    if (a === 'restart') { Object.assign(state, {step: 'pick', queue: [], queueTotal: 0, queueDone: [], auto: false, message: '', error: ''}); render(); return; }
    if (a === 'restart') { state.step = 'pick'; state.docId = null; state.lines = []; render(); return; }
    if (a === 'manual') { onClose?.({manual: true}); return; }
    if (a === 'download') {
      const url = state.previewUrl || URL.createObjectURL(new Blob([state.bytes]));
      const link = document.createElement('a'); link.href = url; link.download = state.file?.name || 'belge'; link.click();
      return;
    }
    if (a === 'back-document') { state.step = 'document'; render(); return; }
    if (a === 'back-lines') { state.step = 'lines'; render(); return; }
    if (a === 'back-allocate') { state.step = 'allocate'; render(); return; }
    if (a === 'to-confirm') { state.step = 'confirm'; render(); return; }
    if (a === 'add-line') { state.lines.push({description: '', invoice_quantity: 1, invoice_unit: 'adet', net: '', tax: '', line_type: 'product', expense_category: 'other', uncertain: []}); render(); return; }
    if (a === 'remove-line') { state.lines.splice(i, 1); render(); return; }
    if (a === 'add-variant') { const l = state.lines[i]; l.allocations = [...(l.allocations || []), {}]; render(); return; }
    if (a === 'apply-link') { run(async () => { applyLink(i); }); return; }
    if (a === 'remember-link') { run(async () => { await rememberLink(i); }); return; }
    if (a === 'save-draft') { run(saveDraft); return; }
  }, {signal});

  root.addEventListener('submit', e => {
    const form = e.target.closest('[data-pd-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.pdForm === 'document') {
      const x = readForm(form);
      state.supplierId = x.supplier_id || '';
      state.header = {...state.header, ...x, uncertain: []};
      state.step = 'lines';
      // Kayıtlı bağlantılar öneri olarak uygulanır; kullanıcı her satırı yine onaylar.
      run(async () => {
        await oneriKaynaklari();
        if (state.supplierId) state.lines.forEach((_, i) => { try { applyLink(i); } catch { /* öneri zorunlu değil */ } });
      });
      return;
    }
    if (form.dataset.pdForm === 'lines') { collectLines(form); state.step = 'allocate'; render(); }
  }, {signal});

  root.addEventListener('dragover', e => { const z = e.target.closest('[data-pd-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } }, {signal});
  root.addEventListener('dragleave', e => { e.target.closest('[data-pd-drop]')?.classList.remove('over'); }, {signal});
  root.addEventListener('drop', e => {
    const z = e.target.closest('[data-pd-drop]');
    if (!z) return;
    e.preventDefault(); z.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (files.length) run(() => kuyrugaAl(files, /\.xml$/i.test(files[0].name) ? 'xml' : 'pdf'));
  }, {signal});

  render();
  return () => {root.removeAttribute('aria-busy'); controller.abort(); if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); };
}
