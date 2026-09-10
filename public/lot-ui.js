// Üretim partisi ve koli etiketi sihirbazı. YALNIZCA üretim (lp) çalışma alanı.
//
// Parti kodu ürün barkodundan ayrıdır; ekran ikisini birlikte gösterir ama karıştırmaz.
// Parti açmak ve etiket basmak STOK HAREKETİ ÜRETMEZ; ekran bunu söyler.
import {CARTON_STEPS, stepIssue, cartonSummary, cartonLabels, CARTON_NOTICE} from './carton-label.js';
import {LABEL_SIZES, labelPrintHtml} from './barcode-label.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const dayText = value => { const [y, m, d] = String(value || '').split('-'); return d ? `${d}.${m}.${y}` : '—'; };
const qty = milli => milli === null || milli === undefined
  ? '—'
  : new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(milli / 1000);
const badge = (label, type = 'neutral') => `<span class="v2-badge ${type}">${esc(label)}</span>`;
const card = (title, content, action = '') => `<section class="v2-card"><div class="v2-card-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
const act = (label, action, id = '', secondary = true) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-lot="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
const STATUS = {open: 'Açık', closed: 'Kapalı', blocked: 'Bloke'};

export function mountLots(root, namespace = 'lp') {
  if (namespace !== 'lp') throw new Error('Parti yönetimi yalnızca üretim çalışma alanındadır.');
  const controller = new AbortController();
  const state = {
    tab: 'lots', lots: [], products: [], detail: null, error: '', busy: false, disposed: false, loaded: false,
    wizard: null, labelSize: 'carton'
  };
  const $ = selector => root.querySelector(selector);

  async function api(path, body) {
    const response = await fetch(`/api/${namespace}${path}`, {
      signal: controller.signal,
      ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
    });
    let data; try { data = await response.json(); } catch { throw new Error('Sunucuya ulaşılamadı. Lütfen yeniden deneyin.'); }
    if (!response.ok) throw new Error(data.error || 'İşlem tamamlanamadı.');
    return data;
  }

  async function loadLots() { state.lots = (await api('/lots')).lots; state.loaded = true; }
  async function loadProducts() {
    if (state.products.length) return;
    const data = await api('/data');
    state.products = (data.products || []).filter(p => p.inventory_kind !== 'material');
  }

  function lotsPanel() {
    const rows = state.lots.map(lot => `<tr>
      <td><strong>${esc(lot.lot_code)}</strong><small>${esc(dayText(lot.produced_on))}${lot.job_reference ? ' · ' + esc(lot.job_reference) : ''}</small></td>
      <td>${esc(lot.product_name)}<small>${esc(lot.product_sku || '')}</small></td>
      <td>${esc(qty(lot.quantity_milli))} ${esc(lot.unit)}</td>
      <td>${lot.printed_cartons} koli<small>${esc(qty(lot.printed_quantity_milli))} ${esc(lot.unit)} etiketlendi</small></td>
      <td>${badge(STATUS[lot.status] || lot.status, lot.status === 'open' ? 'success' : lot.status === 'blocked' ? 'danger' : 'neutral')}</td>
      <td>${act('Aç', 'open', lot.id)}${lot.status === 'open' ? act('Koli etiketi', 'wizard', lot.id, false) : ''}</td></tr>`).join('');
    return `<div class="notice subtle">Parti kodu, ürünün belirli bir üretimini gösterir. <strong>Ürün barkodundan ayrıdır</strong> ve barkod alanına basılmaz. Parti açmak stok hareketi oluşturmaz.</div>` +
      card('Üretim partileri', state.lots.length
        ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Parti</th><th>Ürün</th><th>Üretilen</th><th>Etiketlenen</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="v2-empty"><h3>Henüz parti yok.</h3><p>Bir üretimi partiye bağlamak ve koli etiketi basmak için parti açın.</p></div>',
        act('Parti aç', 'new', '', false));
  }

  function detailPanel() {
    const lot = state.detail;
    const cartons = lot.cartons.length
      ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Koli</th><th>İçindeki</th><th>Barkod</th><th>Basan</th></tr></thead><tbody>${lot.cartons.map(c => `<tr><td>${c.sequence} / ${c.total_cartons}</td><td>${esc(qty(c.quantity_milli))} ${esc(lot.unit)}</td><td>${esc(c.barcode)}</td><td>${esc(c.printed_by_name)}<small>${esc(String(c.printed_at).slice(0, 16))}</small></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="v2-empty"><h3>Bu partiden henüz koli etiketi basılmadı.</h3><p>“Koli etiketi bas” ile sihirbazı açabilirsiniz.</p></div>';
    return card(`${lot.lot_code} · ${lot.product_name}`, `<div class="v2-card-body">
      ${badge(STATUS[lot.status] || lot.status, lot.status === 'open' ? 'success' : lot.status === 'blocked' ? 'danger' : 'neutral')}
      <div class="v2-summary-line"><span>Üretim tarihi</span><strong>${esc(dayText(lot.produced_on))}</strong></div>
      <div class="v2-summary-line"><span>Son kullanma</span><strong>${esc(dayText(lot.best_before))}</strong></div>
      <div class="v2-summary-line"><span>Üretilen miktar</span><strong>${esc(qty(lot.quantity_milli))} ${esc(lot.unit)}</strong></div>
      <div class="v2-summary-line"><span>Koli içi</span><strong>${lot.pack_size_milli ? esc(qty(lot.pack_size_milli)) + ' ' + esc(lot.unit) : 'Tanımlı değil'}</strong></div>
      <div class="v2-summary-line total"><span>Etiketlenen</span><strong>${lot.printed_cartons} koli · ${esc(qty(lot.printed_quantity_milli))} ${esc(lot.unit)}</strong></div>
      ${lot.note ? `<p class="help">Not: ${esc(lot.note)}</p>` : ''}
      ${lot.status_note ? `<p class="help">Durum açıklaması: ${esc(lot.status_note)}</p>` : ''}
      ${lot.barcodes.length
        ? `<p class="help">Bu ürünün barkodları: ${lot.barcodes.map(b => esc(b.code)).join(', ')}</p>`
        : '<div class="notice">Bu ürünün tanımlı barkodu yok. Koli etiketi basmadan önce Barkod ekranından bir barkod bağlayın.</div>'}
      ${cartons}
      <div class="ac-actions">${lot.status === 'open' && lot.barcodes.length ? act('Koli etiketi bas', 'wizard', lot.id, false) : ''}${lot.cartons.length ? act('Basılmış etiketleri yeniden yazdır', 'reprint', lot.id) : ''}${act('Durumu değiştir', 'status', lot.id)}</div>
      <p class="help">Basılmış etiket kayıtları değiştirilemez ve silinemez. ${esc(CARTON_NOTICE)}</p>
    </div>`, act('Kapat', 'close-detail'));
  }

  function wizardPanel() {
    const w = state.wizard, lot = w.lot;
    const index = CARTON_STEPS.findIndex(s => s.key === w.step);
    const issue = stepIssue(w.step, w.draft, {lot});
    const steps = CARTON_STEPS.map((step, i) => `<button type="button" data-lot="step" data-id="${step.key}" class="${step.key === w.step ? 'active' : ''}" ${i > index ? 'disabled' : ''} aria-current="${step.key === w.step ? 'page' : 'false'}">${i + 1}. ${esc(step.title)}</button>`).join('');
    let body = '';
    if (w.step === 'lot') {
      body = `<div class="v2-summary-line"><span>Parti</span><strong>${esc(lot.lot_code)}</strong></div>
        <div class="v2-summary-line"><span>Ürün</span><strong>${esc(lot.product_name)}</strong></div>
        <div class="v2-summary-line"><span>Üretilen</span><strong>${esc(qty(lot.quantity_milli))} ${esc(lot.unit)}</strong></div>
        <div class="v2-summary-line"><span>Daha önce basılan</span><strong>${lot.printed_cartons} koli</strong></div>`;
    } else if (w.step === 'barcode') {
      body = lot.barcodes.length
        ? `<form class="v2-form" data-lot-form="barcode"><label>Koli üzerine basılacak barkod<select name="barcode" required>${lot.barcodes.map(b => `<option value="${esc(b.code)}" ${b.code === w.draft.barcode ? 'selected' : ''}>${esc(b.code)}${b.brand ? ' · ' + esc(b.brand) : ''}${b.pack_label ? ' · ' + esc(b.pack_label) : ''}</option>`).join('')}</select></label>
           <p class="help">Bu, <strong>ürünün</strong> barkodudur. Parti kodu (${esc(lot.lot_code)}) etikete okunabilir metin olarak yazılır, barkod alanına basılmaz.</p>
           <button class="secondary" type="submit">Seç</button></form>`
        : '<div class="notice">Bu ürünün tanımlı barkodu yok. Barkod ekranından bağladıktan sonra devam edin.</div>';
    } else if (w.step === 'quantity') {
      body = `<form class="v2-form" data-lot-form="quantity"><div class="field-grid">
          <label>Bir koliye kaç ${esc(lot.unit)} giriyor?<input name="quantity_per_carton" type="number" min="0.001" step="0.001" value="${esc(w.draft.quantity_per_carton ?? '')}" required></label>
          <label>Kaç koli basılacak?<input name="count" type="number" min="1" max="500" step="1" value="${esc(w.draft.count ?? '')}" required></label>
          <label>Etiket boyutu<select name="size">${Object.entries(LABEL_SIZES).map(([key, preset]) => `<option value="${key}" ${key === state.labelSize ? 'selected' : ''}>${esc(preset.name)}</option>`).join('')}</select></label>
        </div><p class="help">Partide ${esc(qty(lot.quantity_milli))} ${esc(lot.unit)} var; ${lot.printed_cartons} koli daha önce etiketlendi.</p>
        <button class="secondary" type="submit">Devam</button></form>`;
    } else {
      const summary = cartonSummary(w.draft, {lot});
      body = `<div class="v2-summary-line"><span>Parti</span><strong>${esc(summary.lot_code)}</strong></div>
        <div class="v2-summary-line"><span>Barkod</span><strong>${esc(summary.barcode)}</strong></div>
        <div class="v2-summary-line"><span>Koli sırası</span><strong>${summary.first_sequence} – ${summary.last_sequence}</strong></div>
        <div class="v2-summary-line"><span>Koli içi</span><strong>${esc(qty(summary.quantity_per_carton_milli))} ${esc(lot.unit)}</strong></div>
        <div class="v2-summary-line total"><span>Toplam</span><strong>${summary.count} koli · ${esc(qty(summary.total_quantity_milli))} ${esc(lot.unit)}</strong></div>
        ${summary.mixed_totals ? `<div class="notice">${esc(summary.mixed_totals)}</div>` : ''}
        <div class="notice subtle">${esc(summary.notice)}</div>
        <div class="ac-actions">${act('Önizle', 'preview')}${act('Bas ve kaydet', 'print', '', false)}</div>
        <p class="help">Basınca etiket kayıtları oluşur ve <strong>bir daha değiştirilemez</strong>. Önizleme kayıt oluşturmaz.</p>`;
    }
    const next = w.step !== 'preview'
      ? `<div class="ac-actions">${act('Geri', 'back')}${issue ? '' : act('Sonraki adım', 'next', '', false)}</div>`
      : `<div class="ac-actions">${act('Geri', 'back')}</div>`;
    return card('Koli etiketi sihirbazı', `<nav class="v2-tabs" aria-label="Sihirbaz adımları">${steps}</nav>
      <div class="v2-card-body"><p class="help">${esc(CARTON_STEPS[index].help)}</p>${body}
      ${issue ? `<div class="notice">${esc(issue)}</div>` : ''}${next}</div>`, act('Vazgeç', 'close-wizard'));
  }

  function render() {
    if (state.disposed) return;
    const tabs = [['lots', 'Partiler']];
    root.innerHTML = `<div class="v2-page">
      <div class="page-heading"><div><span class="eyebrow">LUNAPOT ÇALIŞMA ALANI</span><h1>Parti ve koli etiketi</h1>
      <p>Hangi üretimden hangi koli çıktı? Partiyi aç, koli etiketini bas, geriye dönük iz kalsın.</p></div></div>
      <div class="notice" data-lot-error role="alert" ${state.error ? '' : 'hidden'}>${esc(state.error)}</div>
      <nav class="v2-tabs" aria-label="Parti ekranı">${tabs.map(([key, label]) => `<button type="button" data-lot="tab" data-id="${key}" class="${state.tab === key ? 'active' : ''}">${label}</button>`).join('')}</nav>
      <section data-lot-body>${state.wizard ? wizardPanel() : state.detail ? detailPanel() : state.loaded ? lotsPanel() : '<div class="loading">Partiler yükleniyor…</div>'}</section></div>`;
  }

  function showError(message) {
    state.error = message;
    const box = $('[data-lot-error]');
    if (box) { box.hidden = !message; box.textContent = message; }
  }

  async function run(work) {
    if (state.busy) return;
    state.busy = true; showError('');
    try { await work(); }
    catch (error) { if (error.name !== 'AbortError' && !state.disposed) showError(error.message); }
    finally { state.busy = false; }
  }

  const closeDialog = () => { const node = $('dialog[data-lot-dialog]'); node?.close(); node?.remove(); };

  function newLotForm() {
    root.insertAdjacentHTML('beforeend', `<dialog data-lot-dialog><form class="v2-form" data-lot-form="new">
      <div class="dialog-heading"><h2>Parti aç</h2><button type="button" class="icon-button" data-lot="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <label>Ürün<select name="product_id" required><option value="">Seçin…</option>${state.products.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.sku)}</option>`).join('')}</select></label>
        <div class="field-grid">
          <label>Üretim tarihi<input name="produced_on" type="date" value="${today()}" required></label>
          <label>Son kullanma · isteğe bağlı<input name="best_before" type="date"></label>
          <label>Üretilen miktar<input name="quantity" type="number" min="0.001" step="0.001" required></label>
          <label>Koli içi adet · isteğe bağlı<input name="pack_size" type="number" min="0.001" step="0.001"></label>
        </div>
        <label>Parti kodu · boş bırakırsan sistem üretir<input name="lot_code" maxlength="40" placeholder="Örn. VARDIYA-A-01"></label>
        <label>Not<textarea name="note" rows="2" maxlength="500"></textarea></label>
        <p class="help">Parti kodu ürün barkodu değildir. Parti açmak stok hareketi oluşturmaz; üretim miktarı ve maliyeti Üretim kayıtları ekranından yürür.</p>
        <p class="error" data-lot-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Vazgeç', 'close')}<button class="primary" type="submit">Partiyi aç</button></div>
    </form></dialog>`);
    $('dialog[data-lot-dialog]').showModal();
  }

  function statusForm(lot) {
    root.insertAdjacentHTML('beforeend', `<dialog data-lot-dialog><form class="v2-form" data-lot-form="status" data-id="${esc(lot.id)}">
      <div class="dialog-heading"><h2>${esc(lot.lot_code)} · durum</h2><button type="button" class="icon-button" data-lot="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <label>Durum<select name="status">${Object.entries(STATUS).map(([key, label]) => `<option value="${key}" ${key === lot.status ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Nedeni<textarea name="status_note" rows="3" maxlength="1000" placeholder="Durum değişikliğinin nedeni"></textarea></label>
        <p class="help">Durum değişikliği gerekçesiz kaydedilmez. Kapalı partiye yeni koli etiketi basılamaz; parti kodu ve ürün bağlantısı hiçbir durumda değişmez.</p>
        <p class="error" data-lot-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Vazgeç', 'close')}<button class="primary" type="submit">Kaydet</button></div>
    </form></dialog>`);
    $('dialog[data-lot-dialog]').showModal();
  }

  async function printLabels(cartons, lot) {
    const {printDocument} = await import('./doc-engine.js');
    printDocument(labelPrintHtml(cartonLabels(cartons, {lot}), {size: state.labelSize}), {title: 'Koli etiketleri'});
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-lot]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.lot, id = target.dataset.id;
    if (action === 'close') { closeDialog(); return; }
    if (action === 'close-detail') { state.detail = null; render(); return; }
    if (action === 'close-wizard') { state.wizard = null; render(); return; }
    if (action === 'tab') { state.tab = id; render(); return; }
    if (action === 'new') { run(async () => { await loadProducts(); newLotForm(); }); return; }
    if (action === 'open') { run(async () => { state.detail = await api('/lots/' + encodeURIComponent(id)); state.wizard = null; render(); }); return; }
    if (action === 'status') { run(async () => { const lot = state.detail || await api('/lots/' + encodeURIComponent(id)); statusForm(lot); }); return; }
    if (action === 'wizard') {
      run(async () => {
        const lot = await api('/lots/' + encodeURIComponent(id));
        state.wizard = {
          lot, step: 'lot',
          draft: {
            lot_id: lot.id,
            barcode: lot.barcodes[0]?.code || '',
            quantity_per_carton: lot.pack_size_milli ? lot.pack_size_milli / 1000 : '',
            count: ''
          }
        };
        state.detail = null;
        render();
      });
      return;
    }
    if (action === 'step') {
      const w = state.wizard;
      const wanted = CARTON_STEPS.findIndex(s => s.key === id);
      const current = CARTON_STEPS.findIndex(s => s.key === w.step);
      if (wanted <= current) { w.step = id; render(); }
      return;
    }
    if (action === 'back') {
      const w = state.wizard;
      const index = CARTON_STEPS.findIndex(s => s.key === w.step);
      if (index === 0) { state.wizard = null; } else { w.step = CARTON_STEPS[index - 1].key; }
      render();
      return;
    }
    if (action === 'next') {
      const w = state.wizard;
      const index = CARTON_STEPS.findIndex(s => s.key === w.step);
      const issue = stepIssue(w.step, w.draft, {lot: w.lot});
      if (issue) { showError(issue); return; }
      w.step = CARTON_STEPS[index + 1].key;
      render();
      return;
    }
    if (action === 'preview') {
      // Önizleme KAYIT OLUŞTURMAZ: henüz basılmamış etiketler geçici olarak çizilir.
      const w = state.wizard, lot = w.lot;
      const already = lot.printed_cartons || 0;
      const count = Number(w.draft.count) || 0;
      const perCarton = Math.round(Number(w.draft.quantity_per_carton) * 1000);
      const gecici = Array.from({length: count}, (unused, i) => ({
        sequence: already + i + 1, total_cartons: already + count,
        quantity_milli: perCarton, barcode: w.draft.barcode,
        snapshot: {lot_code: lot.lot_code, product_name: lot.product_name, product_sku: lot.product_sku,
          produced_on: lot.produced_on, best_before: lot.best_before, unit: lot.unit}
      }));
      run(() => printLabels(gecici, lot));
      return;
    }
    if (action === 'print') {
      run(async () => {
        const w = state.wizard;
        const sonuc = await api(`/lots/${encodeURIComponent(w.lot.id)}/cartons`, {
          count: Number(w.draft.count),
          quantity_per_carton: w.draft.quantity_per_carton,
          barcode: w.draft.barcode
        });
        await printLabels(sonuc.printed, sonuc.lot);
        state.wizard = null;
        state.detail = await api('/lots/' + encodeURIComponent(w.lot.id));
        await loadLots();
        render();
      });
      return;
    }
    if (action === 'reprint') {
      run(async () => {
        const lot = state.detail || await api('/lots/' + encodeURIComponent(id));
        await printLabels(lot.cartons, lot);
      });
    }
  }, {signal: controller.signal});

  root.addEventListener('submit', event => {
    const form = event.target.closest('form[data-lot-form]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const kind = form.dataset.lotForm, values = Object.fromEntries(new FormData(form));
    const error = form.querySelector('[data-lot-form-error]');
    if (error) error.textContent = '';
    run(async () => {
      try {
        if (kind === 'new') {
          const lot = await api('/lots', values);
          closeDialog();
          await loadLots();
          state.detail = await api('/lots/' + encodeURIComponent(lot.id));
          render();
          return;
        }
        if (kind === 'status') {
          await api('/lots/' + encodeURIComponent(form.dataset.id), {status: values.status, status_note: values.status_note});
          closeDialog();
          await loadLots();
          state.detail = await api('/lots/' + encodeURIComponent(form.dataset.id));
          render();
          return;
        }
        if (kind === 'barcode') { state.wizard.draft.barcode = values.barcode; state.wizard.step = 'quantity'; render(); return; }
        if (kind === 'quantity') {
          state.wizard.draft.quantity_per_carton = values.quantity_per_carton;
          state.wizard.draft.count = Number(values.count);
          state.labelSize = values.size;
          const issue = stepIssue('quantity', state.wizard.draft, {lot: state.wizard.lot});
          if (issue) throw new Error(issue);
          state.wizard.step = 'preview';
          render();
        }
      } catch (problem) {
        if (error && error.isConnected) { error.textContent = problem.message; return; }
        throw problem;
      }
    });
  }, {signal: controller.signal});

  render();
  run(async () => { await loadLots(); render(); });
  return () => { state.disposed = true; controller.abort(); closeDialog(); };
}
