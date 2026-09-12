// Rapor Kutusu — pazaryeri Excel raporlarını yükleme sihirbazı (e-ticaret).
// Dosya tarayıcıda okunur; sunucuya ham dosya (denetim) ve kaynak satırlar küçük partilerle gider.
// Aktarım stok, sevkiyat, satış kaydı veya fatura OLUŞTURMAZ.
import {readTable, sha256Hex, LIMITS} from './xlsx-read.js';
import {FIELDS, REPORT_KINDS, PROVIDERS, EVENT_TYPES, headerSignature, suggestMapping, profileFits, normalizeRows} from './report-core.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(v / 100);
const num = v => new Intl.NumberFormat('tr-TR').format(v || 0);
const localNow = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const REASONS = {ambiguous_twin: 'Kimliksiz ikiz satır', id_precision: 'Kimlik bozulmuş olabilir', bad_value: 'Okunamayan değer', missing_required: 'Zorunlu alan boş',
  unknown_type: 'Tanımsız işlem türü', no_amount: 'Tutar yok', duplicate_in_file: 'Dosyada aynı kimlik iki kez', same_time_conflict: 'Aynı zamanlı çelişki',
  posted_changed: 'Sevk edilmiş siparişte değişiklik', erp_ambiguous: 'ERP\'de birden çok aday', store_ambiguous: 'Mağaza ayrımı belirsiz', review: 'İnceleme'};
const OUTCOMES = {new: 'Yeni', updated: 'Güncellenen', same: 'Aynı (tekrar)', older: 'Eski rapor — yok sayıldı', review: 'İncelemeye ayrılan'};
const CHUNK = 480 * 1024, ROW_BYTES = 800000;

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function mountReports(root, namespace = 'ec') {
  const controller = new AbortController(), signal = controller.signal;
  const state = {tab: 'upload', data: null, draft: null, busy: false, message: '', error: '', orders: null, reviews: null, storeFilter: ''};
  const api = async (path = '', body) => {
    const r = await fetch('/api/' + namespace + '/reports' + path, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    let x; try { x = await r.json(); } catch { throw new Error('Sunucudan yanıt alınamadı.'); }
    if (!r.ok) throw new Error(x.error || 'İşlem tamamlanamadı.');
    return x;
  };
  const say = (message, error = false) => { state.message = error ? '' : message; state.error = error ? message : ''; };
  const run = async fn => { if (state.busy) return; state.busy = true; say(''); render(); try { await fn(); } catch (e) { if (e.name !== 'AbortError') say(e.message, true); } finally { state.busy = false; render(); } };

  async function load() { state.data = await api(); }

  /* ---------- görünüm parçaları ---------- */
  const tabs = () => `<div class="rb-tabs" role="tablist">${[['upload', 'Dosya yükle'], ['files', 'Yüklenen dosyalar'], ['reviews', 'İnceleme' + (state.data?.open_reviews ? ' (' + state.data.open_reviews + ')' : '')], ['orders', 'Sipariş sonuçları']]
    .map(([k, t]) => `<button type="button" role="tab" data-rb-tab="${k}" aria-selected="${state.tab === k}" class="${state.tab === k ? 'active' : ''}">${esc(t)}</button>`).join('')}</div>`;
  const status = () => `${state.error ? `<p class="rb-alert error" role="alert">${esc(state.error)}</p>` : ''}${state.message ? `<p class="rb-alert ok" role="status">${esc(state.message)}</p>` : ''}`;
  const storeOptions = (selected, blank = true) => (blank ? '<option value="">Mağaza seçin…</option>' : '') + (state.data?.stores || []).map(s => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(PROVIDERS[s.provider])} · ${esc(s.name)} (${esc(s.code)})</option>`).join('');

  function uploadView() {
    const d = state.draft;
    const head = `<section class="v2-card rb-intro"><div><h2>Rapor Kutusu</h2><p>Trendyol ve Hepsiburada panelinden indirdiğin sipariş ve finans raporlarını buraya bırak. İlk sefer geçmişi, sonra örtüşen son 7 veya 30 günü yükleyebilirsin; aynı kayıt ikinci kez sayılmaz.</p></div>
      <ul class="rb-facts"><li><strong>Stok, sevkiyat ve fatura oluşturmaz.</strong> ERP'de olan siparişe yalnızca bağlanır.</li><li>Pazaryeri API'si kullanılmaz; yalnızca yüklediğin dosya.</li><li>Günlük otomatik indirme yardımcısı: <em>henüz yok</em>.</li></ul></section>`;
    if (!d || d.step === 'pick') return head + pickForm();
    if (d.step === 'map') return head + mapForm();
    if (d.step === 'check') return head + checkView();
    if (d.step === 'server') return head + serverView();
    return head;
  }

  function pickForm() {
    const d = state.draft || {};
    return `<section class="v2-card"><h3>1 · Dosyayı seç</h3>
      <div class="rb-grid">
        <label>Mağaza<select data-rb="store">${storeOptions(d.store_id)}</select></label>
        <label>Rapor türü<select data-rb="kind">${Object.entries(REPORT_KINDS).map(([k, t]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>Rapor ne zaman indirildi?<input type="datetime-local" data-rb="snapshot" value="${esc(d.snapshot_at || localNow())}" required></label>
      </div>
      <details class="rb-add"><summary>Yeni mağaza ekle</summary><form data-rb-form="store" class="rb-grid">
        <label>Pazaryeri<select name="provider">${Object.entries(PROVIDERS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select></label>
        <label>Mağaza kodu / satıcı no<input name="code" required maxlength="80"></label>
        <label>Görünen ad<input name="name" required maxlength="120"></label>
        <button class="secondary" type="submit">Mağazayı ekle</button></form></details>
      <label class="rb-drop" data-rb-drop><input type="file" accept=".xlsx,.csv" data-rb="file" hidden>
        <strong>Excel (.xlsx) ya da CSV dosyasını buraya sürükle</strong><span>ya da tıklayıp seç · en çok ${LIMITS.fileBytes / 1024 / 1024} MB</span></label>
      <p class="rb-muted">"Rapor ne zaman indirildi" hangi bilginin daha yeni olduğunu belirler: eski tarihli bir rapor güncel durumu geri almaz.</p></section>`;
  }

  function mapForm() {
    const d = state.draft, fields = FIELDS[d.kind];
    const option = (field) => `<option value="">— bu dosyada yok —</option>` + d.table.headers.map(h => `<option ${d.mapping[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const fits = d.fitInfo;
    return `<section class="v2-card"><h3>2 · Sütunları eşleştir <small class="rb-muted">${esc(d.file.name)} · ${num(d.table.rows.length)} satır</small></h3>
      ${fits && !fits.fits ? `<p class="rb-alert warn">Bu rapor türünün sütunları değişmiş. Değişen alanlar: ${esc(fits.missing.join(', ') || '—')}. Yeni sütunlar: ${esc(fits.added.slice(0, 8).join(', ') || '—')}.</p>` : ''}
      <p class="rb-muted">Her alan için dosyadaki sütunu seç. <span class="rb-chip">öneri</span> işaretli olanlar başlık adından tahmin edildi; kontrol et. Onayladığın eşleştirme kaydedilir, aynı başlıklı dosyada tekrar sorulmaz.</p>
      <form data-rb-form="map"><div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Alan</th><th>Dosyadaki sütun</th><th>Örnek değer</th></tr></thead><tbody>
      ${fields.map(f => { const h = d.mapping[f.key], i = d.table.headers.indexOf(h); const sample = i >= 0 ? d.table.rows.slice(0, 3).map(r => r.cells[i]?.v).filter(v => v !== null && v !== undefined).join(' · ') : '';
        return `<tr><td>${esc(f.label)}${f.required ? ' <span class="rb-req">zorunlu</span>' : ''}${d.suggested[f.key] && d.suggested[f.key] === h ? ' <span class="rb-chip">öneri</span>' : ''}</td><td><select name="${f.key}">${option(f.key)}</select></td><td class="rb-sample">${esc(sample.slice(0, 80))}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${d.kind === 'finance' ? `<fieldset class="rb-grid"><legend>Tutarların anlamı (senin raporuna göre)</legend>
        <label class="rb-check"><input type="checkbox" name="fees_positive" ${d.options.fees_positive ? 'checked' : ''}> Kesinti ve iadeler raporda artı (+) yazılıyor</label>
        <label>Kesinti tutarları KDV dahil mi?<select name="fee_vat"><option value="">Bilmiyorum (katkı yaklaşık gösterilir)</option><option value="inc" ${d.options.fee_amounts_include_vat === true ? 'selected' : ''}>KDV dahil</option><option value="exc" ${d.options.fee_amounts_include_vat === false ? 'selected' : ''}>KDV hariç</option></select></label>
        <label>Kesintilerin KDV oranı %<input name="fee_vat_rate" type="number" min="0" max="100" step="0.01" value="${d.options.fee_vat_bps !== null && d.options.fee_vat_bps !== undefined ? d.options.fee_vat_bps / 100 : ''}" placeholder="Faturadan bak"></label></fieldset>
        ${d.unknownTypes?.length ? `<fieldset><legend>Dosyada geçen işlem türleri — her biri ne anlama geliyor?</legend><div class="rb-grid">${d.unknownTypes.map((t, i) => `<label>${esc(t || '(boş)')}<select name="type_${i}" data-type-text="${esc(t)}"><option value="">Seçin…</option>${Object.entries(EVENT_TYPES).map(([k, v]) => `<option value="${k}" ${d.options.type_map?.[t] === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`).join('')}</div></fieldset>` : ''}` : ''}
      <div class="rb-actions"><button type="button" class="secondary" data-rb-act="restart">Vazgeç</button><button class="primary" type="submit">Eşleştirmeyi kaydet ve kontrol et</button></div></form></section>`;
  }

  function checkView() {
    const d = state.draft, n = d.local, issueCounts = {};
    for (const r of n.records) for (const i of r.issues) issueCounts[i.code] = (issueCounts[i.code] || 0) + 1;
    return `<section class="v2-card"><h3>3 · Kontrol et <small class="rb-muted">${esc(d.file.name)}</small></h3>
      ${d.profile && !d.profile.sample_verified ? `<p class="rb-alert warn">Bu eşleştirme gerçek raporla henüz doğrulanmadı. Aşağıdaki toplamları pazaryeri ekranındaki toplamlarla karşılaştır. ${state.data?.stores ? '' : ''}</p>` : ''}
      ${d.table.warnings.map(w => `<p class="rb-alert warn">${esc(w)}</p>`).join('')}
      <dl class="rb-kv"><div><dt>Okunan satır</dt><dd>${num(d.table.rows.length)}</dd></div><div><dt>Kayıt</dt><dd>${num(n.records.length)}</dd></div>
        <div><dt>Boş satır</dt><dd>${num(n.skipped.empty)}</dd></div><div><dt>Toplam satırı (işlem sayılmadı)</dt><dd>${num(n.skipped.total)}</dd></div></dl>
      ${Object.keys(n.totals).length ? `<h4>Dosyadaki tutar toplamları</h4><dl class="rb-kv">${Object.entries(n.totals).map(([k, v]) => `<div><dt>${esc(FIELDS[d.kind].find(f => f.key === k)?.label || k)}</dt><dd class="rb-num">${money(v)}</dd></div>`).join('')}</dl>` : ''}
      ${Object.keys(issueCounts).length ? `<h4>Dikkat gerektirenler</h4><ul class="rb-list">${Object.entries(issueCounts).map(([k, v]) => `<li>${esc(REASONS[k] || k)}: <strong>${num(v)}</strong> kayıt${['formula'].includes(k) ? ' (bilgi)' : ' — incelemeye ayrılacak'}</li>`).join('')}</ul>` : '<p class="rb-muted">Okuma sırasında sorun görülmedi.</p>'}
      <div class="rb-actions"><button type="button" class="secondary" data-rb-act="remap">Eşleştirmeyi değiştir</button>${d.profile && !d.profile.sample_verified ? '<button type="button" class="secondary" data-rb-act="verify">Toplamlar doğru, eşleştirmeyi doğrulandı işaretle</button>' : ''}<button type="button" class="primary" data-rb-act="upload">Yükle ve mevcut kayıtlarla karşılaştır</button></div></section>`;
  }

  function serverView() {
    const d = state.draft, p = d.serverPreview, prog = d.progress;
    return `<section class="v2-card"><h3>4 · Önizleme ve işleme <small class="rb-muted">${esc(d.file.name)}</small></h3>
      ${prog ? `<p>${esc(prog.label)}</p><progress max="${prog.max}" value="${prog.value}"></progress>` : ''}
      ${p ? `<dl class="rb-kv">${Object.entries(OUTCOMES).map(([k, t]) => `<div class="rb-o-${k}"><dt>${esc(t)}</dt><dd>${num(p.counts[k])}</dd></div>`).join('')}
        <div><dt>ERP'deki siparişe bağlanacak</dt><dd>${num(p.erp_links)}</dd></div><div><dt>Ürün/set eşleşmesi olmayan</dt><dd>${num(p.unmapped_products)}</dd></div></dl>
        ${p.unknown_types?.length ? `<p class="rb-alert warn">Tanımsız işlem türleri: ${esc(p.unknown_types.join(', '))}. Eşleştirmede karşılığını seç.</p>` : ''}
        ${p.reviews.length ? `<details><summary>İncelemeye ayrılacak ilk ${p.reviews.length} kayıt</summary><ul class="rb-list">${p.reviews.map(r => `<li>Satır ${r.row}: ${esc(REASONS[r.reason] || r.reason)} — ${esc(r.detail)}</li>`).join('')}</ul></details>` : ''}
        <p class="rb-muted">${esc(p.notice)}</p>` : ''}
      <div class="rb-actions">${d.result ? `<button type="button" class="secondary" data-rb-act="restart">Yeni dosya</button><button type="button" class="primary" data-rb-tab="orders">Sipariş sonuçlarını gör</button>` : p && !prog ? `<button type="button" class="secondary" data-rb-act="restart">Vazgeç</button><button type="button" class="primary" data-rb-act="apply" data-id="${esc(d.fileId)}">İşle</button>` : ''}</div>
      ${d.result ? `<p class="rb-alert ok">Tamamlandı: ${Object.entries(d.result).map(([k, v]) => esc(OUTCOMES[k] || k) + ' ' + num(v)).join(' · ')}</p>` : ''}</section>`;
  }

  function filesView() {
    const files = state.data?.files || [];
    return `<section class="v2-card"><h3>Yüklenen dosyalar</h3>${files.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Dosya</th><th>Mağaza</th><th>İndirilme</th><th>Durum</th><th>Sonuç</th><th></th></tr></thead><tbody>
      ${files.map(f => `<tr><td>${esc(f.filename)}<small>${esc(REPORT_KINDS[f.kind])} · ${num(f.row_count)} satır${f.sample_verified ? '' : ' · <span class="rb-chip">eşleştirme doğrulanmadı</span>'}</small></td><td>${esc(PROVIDERS[f.provider])} · ${esc(f.store_name)}</td><td>${esc(f.snapshot_at.replace('T', ' '))}</td>
        <td>${esc({receiving: 'Yükleniyor (yarım)', received: 'Alındı, işlenmedi', applying: 'Yarıda kaldı', applied: 'İşlendi'}[f.status])}${f.status === 'applying' ? `<small>${num(f.applied_row)} / ${num(f.row_count)}</small>` : ''}</td>
        <td>${Object.entries(f.counts || {}).filter(([, v]) => v).map(([k, v]) => esc(OUTCOMES[k] || k) + ': ' + num(v)).join('<br>') || '—'}</td>
        <td>${['received', 'applying'].includes(f.status) ? `<button type="button" class="secondary" data-rb-act="apply" data-id="${esc(f.id)}">Devam et</button>` : f.status === 'receiving' ? '<small>Aynı dosyayı yeniden seç; kaldığı yerden sürer.</small>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="rb-muted">Henüz dosya yok.</p>'}</section>`;
  }

  function reviewsView() {
    const list = state.reviews || [];
    const kv = o => o ? `<dl class="rb-kv small">${Object.entries(o).filter(([k]) => !['source_field'].includes(k)).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v).slice(0, 60))}</dd></div>`).join('')}</dl>` : '<p class="rb-muted">Önceki kayıt yok.</p>';
    return `<section class="v2-card"><h3>İnceleme bekleyenler</h3><p class="rb-muted">Otomatik karar verilemeyen kayıtlar. "Kabul et" gelen bilgiyi yeni sürüm olarak alır; kimliksiz ikizlerde ayrı kayıt açar (iadeler birleştirilmez). "Reddet" mevcut bilgiyi korur.</p>
      ${list.length ? list.map(r => `<article class="rb-review"><header><strong>${esc(REASONS[r.reason] || r.reason)}</strong><span>${esc(PROVIDERS[r.provider])} · ${esc(r.store_name)} · ${esc(r.filename)} · satır ${r.row_no}</span></header><p>${esc(r.detail)}</p>
        <div class="rb-compare"><div><h4>Gelen</h4>${kv(r.incoming)}</div><div><h4>Mevcut</h4>${kv(r.prior)}</div></div>
        <div class="rb-actions"><button type="button" class="secondary" data-rb-act="reject" data-id="${esc(r.id)}">Reddet</button><button type="button" class="primary" data-rb-act="accept" data-id="${esc(r.id)}">Kabul et</button></div></article>`).join('') : '<p class="rb-muted">İnceleme bekleyen kayıt yok.</p>'}</section>`;
  }

  function ordersView() {
    const o = state.orders;
    const cell = r => r.contribution_cents !== null ? `<strong class="rb-num">${money(r.contribution_cents)}</strong>` : `<span class="rb-chip warn">Hesaplanamadı</span><small>${r.contribution_missing.slice(0, 3).map(esc).join('<br>')}</small>`;
    return `<section class="v2-card"><h3>Sipariş sonuçları</h3>
      <div class="rb-grid"><label>Mağaza<select data-rb="order-store">${storeOptions(state.storeFilter)}</select></label></div>
      <p class="rb-muted">Dört sayı ayrı tutulur: <b>pazaryerinin bildirdiği net</b>, <b>bankada doğrulanan tahsilat</b>, <b>bilinen doğrudan maliyetlerden sonraki katkı</b> (KDV hariç satış − ürün maliyeti − kesintiler; stopaj dahil edilmez) ve <b>tahmin</b>. Eksik maliyet sıfır sayılmaz.</p>
      ${o ? (o.results.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Sipariş</th><th>Ürünler</th><th>Pazaryeri neti</th><th>Banka</th><th>Katkı</th><th>Tahmin</th><th></th></tr></thead><tbody>
      ${o.results.map(r => `<tr><td><strong>${esc(r.order_no)}</strong><small>${esc(r.order_date)}${r.status ? ' · ' + esc(r.status) : ''}${r.erp_package_id ? ' · ERP\'de bağlı' : ''}</small></td>
        <td>${r.lines.map(l => `${esc(l.product_name || l.barcode || l.sku)} × ${num(l.quantity)}${l.components ? `<small>${l.components.map(c => esc(c.product_id) + ' ×' + (c.quantity_milli / 1000)).join(', ')}</small>` : '<small class="rb-warn">eşleşme yok</small>'}`).join('<br>')}</td>
        <td class="rb-num">${money(r.reported_net_cents)}${r.computed_net_cents !== null && r.reported_net_cents !== null && r.computed_net_cents !== r.reported_net_cents ? `<small>Bileşenlerden: ${money(r.computed_net_cents)}</small>` : ''}${r.withholding_cents ? `<small>Stopaj: ${money(r.withholding_cents)} (ayrı takip)</small>` : ''}</td>
        <td><small>${esc(r.bank_note)}</small></td><td>${cell(r)}${r.notes.length ? `<small>${r.notes.map(esc).join('<br>')}</small>` : ''}</td>
        <td>${r.estimates.map(e => `<div>${esc(e.label)}: ${e.value !== null ? `<span class="rb-num">${money(e.value)}</span>${e.low !== e.high ? ` <small>(${money(e.low)} – ${money(e.high)})</small>` : ''}` : ''}<small>${esc(e.basis)}</small></div>`).join('')}${r.estimated_result_cents !== null ? `<small>Tahmini sonuç: ${money(r.estimated_result_cents)}</small>` : ''}</td>
        <td>${r.fee_events.some(e => !e.invoice_line_id) ? `<button type="button" class="secondary" data-rb-act="evidence" data-order="${esc(r.group)}">Fatura bağla</button>` : r.fee_events.length ? '<small>Belgeler bağlı</small>' : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="rb-muted">Bu mağazada işlenmiş sipariş raporu yok.</p>') : '<p class="rb-muted">Mağaza seçin.</p>'}</section>`;
  }

  function render() {
    root.innerHTML = `<div class="rb">${tabs()}${status()}${state.tab === 'upload' ? uploadView() : state.tab === 'files' ? filesView() : state.tab === 'reviews' ? reviewsView() : ordersView()}</div>${state.busy ? '<p class="rb-busy" role="status">İşleniyor…</p>' : ''}`;
  }

  /* ---------- işlemler ---------- */
  async function takeFile(file) {
    const d = state.draft || {};
    const store = state.data.stores.find(s => s.id === d.store_id);
    if (!store) throw new Error('Önce mağazayı seçin.');
    if (file.size > LIMITS.fileBytes) throw new Error('Dosya 25 MB sınırını aşıyor.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const table = await readTable(bytes, {name: file.name});
    const sha = await sha256Hex(bytes), signature = headerSignature(table.headers);
    const {profile} = await api('/profiles?provider=' + store.provider + '&kind=' + d.kind + '&signature=' + encodeURIComponent(signature));
    const suggested = suggestMapping(d.kind, table.headers);
    Object.assign(d, {file, bytes, table, sha, store, signature, suggested, profile,
      mapping: profile ? profile.mapping : {...suggested}, options: profile ? profile.options : {type_map: {}, fees_positive: false, fee_amounts_include_vat: null, fee_vat_bps: null}});
    d.fitInfo = profile ? profileFits(profile, table.headers) : null;
    refreshLocal(d);
    d.step = profile && d.fitInfo.fits && !d.unknownTypes.length ? 'check' : 'map';
    if (d.step === 'check') say('Bu rapor biçimi tanındı; önceki eşleştirme kullanıldı.');
  }
  function refreshLocal(d) {
    d.local = normalizeRows({kind: d.kind, mapping: d.mapping, ...d.options}, d.table.headers, d.table.rows, {date1904: d.table.date1904});
    d.unknownTypes = d.kind === 'finance' ? d.local.unknownTypes : [];
  }
  async function saveMapping(form) {
    const d = state.draft, x = new FormData(form), mapping = {};
    for (const f of FIELDS[d.kind]) if (x.get(f.key)) mapping[f.key] = x.get(f.key);
    const typeMap = {...(d.options.type_map || {})};
    form.querySelectorAll('[data-type-text]').forEach(s => { if (s.value) typeMap[s.dataset.typeText] = s.value; });
    const vat = x.get('fee_vat'), rate = x.get('fee_vat_rate');
    const options = {type_map: typeMap, fees_positive: x.get('fees_positive') === 'on', fee_amounts_include_vat: vat === 'inc' ? true : vat === 'exc' ? false : null,
      fee_vat_bps: rate === null || rate === '' ? null : Math.round(Number(rate) * 100)};
    d.mapping = mapping; d.options = options; refreshLocal(d);
    if (d.unknownTypes.length) { say('Dosyada karşılığı seçilmemiş işlem türleri var; aşağıdan seçin.', true); return; }
    d.profile = await api('/profiles', {provider: d.store.provider, kind: d.kind, headers: d.table.headers, mapping, options});
    d.fitInfo = profileFits(d.profile, d.table.headers);
    d.step = 'check';
    say('Eşleştirme kaydedildi (sürüm ' + d.profile.version + '). Aynı başlıklı dosyada tekrar sorulmayacak.');
  }
  async function upload() {
    const d = state.draft, chunks = Math.max(1, Math.ceil(d.bytes.length / CHUNK));
    const created = await api('/files', {store_id: d.store.id, kind: d.kind, filename: d.file.name, size_bytes: d.bytes.length, sha256: d.sha, snapshot_at: d.snapshot_at,
      sheet: d.table.sheet, headers: d.table.headers, date1904: d.table.date1904, row_count: d.table.rows.length, chunk_count: chunks, warnings: d.table.warnings});
    if (created.duplicate) { say(created.notice, true); d.step = 'pick'; return; }
    d.fileId = created.id; d.step = 'server';
    for (let i = 0; i < chunks; i++) {
      d.progress = {label: 'Dosya güvenli depoya aktarılıyor…', max: chunks, value: i}; render();
      await api('/files/' + d.fileId + '/chunk', {index: i, data: b64(d.bytes.subarray(i * CHUNK, (i + 1) * CHUNK))});
    }
    let batch = [], size = 0, sent = 0;
    const flush = async () => { if (!batch.length) return; await api('/files/' + d.fileId + '/rows', {rows: batch}); sent += batch.length; batch = []; size = 0; d.progress = {label: 'Satırlar aktarılıyor…', max: d.table.rows.length, value: sent}; render(); };
    for (const r of d.table.rows) {
      const item = {row: r.row, cells: r.cells.map(c => c ? {v: c.v, t: c.t, ...(c.f ? {f: true} : {})} : null)}, bytes = JSON.stringify(item).length;
      if (batch.length >= 500 || size + bytes > ROW_BYTES) await flush();
      batch.push(item); size += bytes;
    }
    await flush();
    await api('/files/' + d.fileId + '/seal', {});
    d.progress = null;
    d.serverPreview = await api('/files/' + d.fileId + '/preview');
    say(created.resume ? 'Yarım kalan yükleme tamamlandı.' : 'Dosya alındı ve doğrulandı. Önizlemeyi kontrol edip "İşle"ye bas.');
  }
  async function apply(fileId) {
    let result;
    for (;;) {
      result = await api('/files/' + fileId + '/apply', {});
      if (state.draft?.fileId === fileId) { state.draft.progress = {label: 'İşleniyor…', max: result.row_count || 1, value: result.applied_row}; render(); }
      if (result.done) break;
    }
    if (state.draft?.fileId === fileId) { state.draft.progress = null; state.draft.result = result.counts; }
    await load();
    say('İşlem tamamlandı. ' + Object.entries(result.counts || {}).map(([k, v]) => (OUTCOMES[k] || k) + ': ' + v).join(', '));
  }
  async function evidenceDialog(group) {
    const row = state.orders.results.find(r => r.group === group), open = row.fee_events.filter(e => !e.invoice_line_id);
    const {lines} = await api('/evidence-candidates');
    const dialog = document.createElement('dialog');
    dialog.className = 'v2-dialog';
    dialog.innerHTML = `<form method="dialog" data-rb-form="evidence"><div class="dialog-heading"><h2>Fatura bağla · ${esc(row.order_no)}</h2></div><div class="form-body">
      <p class="rb-muted">Fatura, rapordaki gidere <b>kanıt</b> olarak bağlanır; ikinci gider oluşturulmaz. Kesinti eşleştirmesinde satışa dağıtılmış fatura satırı burada görünmez.</p>
      <label>Gider<select name="record">${open.map(e => `<option value="${esc(e.id)}">${esc(e.label)} · ${money(e.amount_cents)}</option>`).join('')}</select></label>
      <label>Fatura satırı<select name="line">${lines.length ? lines.map(l => `<option value="${esc(l.id)}">${esc(l.supplier)} · ${esc(l.invoice_no)} · ${esc(l.description)} · ${money(l.net_cents + l.tax_cents)}</option>`).join('') : '<option value="">Uygun fatura satırı yok</option>'}</select></label></div>
      <div class="dialog-footer"><button value="cancel" class="secondary">Vazgeç</button><button value="ok" class="primary">Bağla</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      const f = new FormData(dialog.querySelector('form')), ok = dialog.returnValue === 'ok', rec = f.get('record'), line = f.get('line');
      dialog.remove();
      if (ok && rec && line) run(async () => { const r = await api('/records/' + rec + '/evidence', {invoice_line_id: line}); say(r.notice); state.orders = await api('/orders?store_id=' + state.storeFilter); });
    }, {once: true});
    dialog.showModal();
  }

  /* ---------- olaylar ---------- */
  root.addEventListener('click', e => {
    const tab = e.target.closest('[data-rb-tab]');
    if (tab) { state.tab = tab.dataset.rbTab; run(async () => { if (state.tab === 'reviews') state.reviews = (await api('/reviews')).reviews; if (state.tab === 'orders' && state.storeFilter) state.orders = await api('/orders?store_id=' + state.storeFilter); if (state.tab === 'files') await load(); }); return; }
    const act = e.target.closest('[data-rb-act]');
    if (!act) return;
    const a = act.dataset.rbAct, id = act.dataset.id;
    if (a === 'restart') { state.draft = {step: 'pick', kind: state.draft?.kind || 'orders', store_id: state.draft?.store_id, snapshot_at: localNow()}; render(); }
    if (a === 'remap') { state.draft.step = 'map'; render(); }
    if (a === 'verify') run(async () => { await api('/profiles/' + state.draft.profile.id + '/verify', {}); state.draft.profile.sample_verified = 1; say('Eşleştirme gerçek raporla doğrulandı olarak işaretlendi.'); });
    if (a === 'upload') run(upload);
    if (a === 'apply') run(() => apply(id));
    if (a === 'accept' || a === 'reject') run(async () => { await api('/reviews/' + id, {decision: a}); state.reviews = (await api('/reviews')).reviews; await load(); say(a === 'accept' ? 'Kabul edildi.' : 'Reddedildi; mevcut bilgi korundu.'); });
    if (a === 'evidence') run(() => evidenceDialog(act.dataset.order));
  }, {signal});
  root.addEventListener('change', e => {
    const t = e.target.dataset.rb;
    if (!t) return;
    state.draft = state.draft || {step: 'pick', kind: 'orders', snapshot_at: localNow()};
    if (t === 'store') state.draft.store_id = e.target.value;
    if (t === 'kind') state.draft.kind = e.target.value;
    if (t === 'snapshot') state.draft.snapshot_at = e.target.value;
    if (t === 'file' && e.target.files[0]) { const file = e.target.files[0]; run(() => takeFile(file)); }
    if (t === 'order-store') { state.storeFilter = e.target.value; run(async () => { state.orders = state.storeFilter ? await api('/orders?store_id=' + state.storeFilter) : null; }); }
  }, {signal});
  root.addEventListener('submit', e => {
    const form = e.target.closest('[data-rb-form]');
    if (!form || form.dataset.rbForm === 'evidence') return;
    e.preventDefault();
    if (form.dataset.rbForm === 'store') run(async () => { const s = await api('/stores', Object.fromEntries(new FormData(form))); await load(); state.draft = {...(state.draft || {step: 'pick', kind: 'orders', snapshot_at: localNow()}), store_id: s.id}; say('Mağaza eklendi.'); });
    if (form.dataset.rbForm === 'map') run(() => saveMapping(form));
  }, {signal});
  // Sürükle-bırak
  root.addEventListener('dragover', e => { const z = e.target.closest('[data-rb-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } }, {signal});
  root.addEventListener('dragleave', e => { e.target.closest('[data-rb-drop]')?.classList.remove('over'); }, {signal});
  root.addEventListener('drop', e => {
    const z = e.target.closest('[data-rb-drop]');
    if (!z) return;
    e.preventDefault(); z.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) run(() => takeFile(file));
  }, {signal});

  state.draft = {step: 'pick', kind: 'orders', snapshot_at: localNow()};
  run(async () => { await load(); if (state.data.stores.length === 1) state.draft.store_id = state.data.stores[0].id; });
  return () => controller.abort();
}
