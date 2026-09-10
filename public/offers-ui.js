// Teklif, proforma ve sözleşme ekranı.
// Belgeler tarayıcıda, sunucudan yetkiyle gelen veriden üretilir; ayrı bir indirme ucu yoktur.
// Bu ekran dışarıya e-posta veya mesaj GÖNDERMEZ; yalnızca indirilebilir belge hazırlar.
// Stok düşmez, cariye borç/alacak yazmaz, resmî fatura kesmez.
import {OFFER_KINDS, NEXT_KIND, offerTotals} from './offer-math.js';
import {offerPdfDocument, offerSheets, offerCsvRows, offerPrintHtml, offerBlocks, statusName, kindName, money} from './offer-document.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const plusDays = days => new Date(Date.now() + days * 86400000).toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const dayText = value => { const [y, m, d] = String(value || '').split('-'); return d ? `${d}.${m}.${y}` : '—'; };
const badgeType = status => ({accepted: 'success', rejected: 'danger', expired: 'warning', cancelled: 'neutral', sent: 'warning'}[status] || 'neutral');
const badge = (label, type = 'neutral') => `<span class="v2-badge ${type}">${esc(label)}</span>`;
const card = (title, content, action = '') => `<section class="v2-card"><div class="v2-card-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
const act = (label, action, id = '', secondary = true) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-offer="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
const stat = (label, value, note) => `<article class="v2-stat"><span class="v2-stat-label">${esc(label)}</span><strong class="v2-stat-value">${esc(value)}</strong><small>${esc(note)}</small></article>`;

const blankLine = () => ({description: '', unit: 'adet', quantity: '1', unit_price: '', discount: '0', vat: '20'});

// Ekrandaki metin alanları kuruş/milli tam sayıya burada çevrilir; hesap saf modülde yapılır.
function toLines(rows) {
  return rows.map((row, index) => {
    const scale = (value, factor, label) => {
      const parsed = Number(String(value).replace(',', '.'));
      const result = Math.round(parsed * factor);
      if (!Number.isFinite(parsed) || !Number.isSafeInteger(result))
        throw new Error(`${index + 1}. satırdaki ${label} sayısı geçersiz.`);
      return result;
    };
    if (!String(row.description).trim()) throw new Error(`${index + 1}. satırın açıklamasını yazın.`);
    return {
      description: String(row.description).trim(),
      unit: String(row.unit || 'adet').trim() || 'adet',
      quantity_milli: scale(row.quantity, 1000, 'miktar'),
      unit_price_cents: scale(row.unit_price === '' ? 0 : row.unit_price, 100, 'birim fiyat'),
      discount_bps: scale(row.discount === '' ? 0 : row.discount, 100, 'iskonto'),
      vat_bps: scale(row.vat === '' ? 0 : row.vat, 100, 'KDV')
    };
  });
}

const fromSnapshotRows = rows => rows.map(row => ({
  description: row.description, unit: row.unit,
  quantity: String(row.quantity_milli / 1000),
  unit_price: row.unit_price_cents === null ? '' : String(row.unit_price_cents / 100),
  discount: row.discount_bps === null ? '0' : String(row.discount_bps / 100),
  vat: row.vat_bps === null ? '0' : String(row.vat_bps / 100)
}));

export function mountOffers(root, namespace) {
  if (!['ec', 'lp'].includes(namespace)) throw new Error('Çalışma alanı geçersiz.');
  const controller = new AbortController();
  const state = {
    kind: '', offers: [], parties: [], detail: null, editor: null, error: '', busy: false, disposed: false, loaded: false
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

  async function load() {
    const query = state.kind ? '?kind=' + state.kind : '';
    const [list, ledger] = await Promise.all([
      api('/offers' + query),
      state.parties.length ? Promise.resolve(null) : api('/ledger')
    ]);
    if (ledger) state.parties = ledger.parties || [];
    state.offers = list.offers;
    state.loaded = true;
  }

  // pdf-lib ve yazı tipi yalnızca gerçekten belge indirilirken yüklenir.
  async function produce(format) {
    const detail = state.detail;
    if (!detail) throw new Error('Önce bir belge açın.');
    const engine = await import('./doc-engine.js');
    const payload = {offer: detail, snapshot: detail.snapshot, today: today()};
    const name = engine.safeFilename(detail.document_no, detail.snapshot.party.name, String(detail.revision) + '-surum');
    if (format === 'print') return engine.printDocument(offerPrintHtml(payload), {title: kindName(detail.kind)});
    if (format === 'csv') return engine.saveFile(engine.csvBytes(offerCsvRows(payload)), name + '.csv');
    if (format === 'xlsx') return engine.saveFile(engine.xlsxBytes(offerSheets(payload)), name + '.xlsx');
    if (format === 'docx') return engine.saveFile(engine.docxBytes(offerBlocks(payload), {footer: detail.snapshot.notice}), name + '.docx');
    if (format === 'pdf') return engine.saveFile(await engine.pdfBytes(offerPdfDocument(payload)), name + '.pdf');
    throw new Error('Belge biçimi tanınmadı.');
  }

  function listPanel() {
    const now = today();
    const counts = kind => state.offers.filter(o => o.kind === kind).length;
    const summary = state.kind ? '' : `<div class="v2-grid cols-3">${Object.entries(OFFER_KINDS).map(([kind, label]) => stat(label, String(counts(kind)), 'Güncel sürümler')).join('')}</div>`;
    const rows = state.offers.map(offer => `<tr>
      <td><strong>${esc(offer.document_no)}</strong><small>${offer.revision}. sürüm · ${esc(kindName(offer.kind))}</small></td>
      <td>${esc(offer.party_name)}<small>${esc(offer.title)}</small></td>
      <td>${esc(dayText(offer.issue_date))}<small>${offer.valid_until ? 'Geçerlilik: ' + esc(dayText(offer.valid_until)) : 'Süre yok'}</small></td>
      <td>${esc(money(offer.total_cents))}</td>
      <td>${badge(statusName(offer, now), badgeType(offer.effective_status))}</td>
      <td>${act('Aç', 'open', offer.id)}</td></tr>`).join('');
    return summary + card('Belgeler', state.offers.length
      ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Belge</th><th>Cari / başlık</th><th>Tarih</th><th>Genel toplam</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="v2-empty"><h3>Henüz belge yok.</h3><p>Yeni teklif oluşturup müşteriye PDF, Word veya Excel olarak verebilirsiniz.</p></div>');
  }

  function lineEditorRows(lines) {
    return lines.map((line, index) => `<tr>
      <td><input name="description" value="${esc(line.description)}" maxlength="300" placeholder="Ürün veya hizmet" required></td>
      <td><input name="unit" value="${esc(line.unit)}" maxlength="20" size="6"></td>
      <td><input name="quantity" value="${esc(line.quantity)}" type="number" step="0.001" min="0.001" required></td>
      <td><input name="unit_price" value="${esc(line.unit_price)}" type="number" step="0.01" min="0" required></td>
      <td><input name="discount" value="${esc(line.discount)}" type="number" step="0.01" min="0" max="100"></td>
      <td><input name="vat" value="${esc(line.vat)}" type="number" step="0.01" min="0" max="100"></td>
      <td>${lines.length > 1 ? act('Sil', 'line-remove', String(index)) : '—'}</td></tr>`).join('');
  }

  function editorPanel() {
    const e = state.editor;
    const isContract = e.kind === 'contract';
    const options = [['', 'Cari seçin…'], ...state.parties.map(p => [p.id, p.name])];
    let preview = '';
    try {
      const totals = offerTotals(toLines(e.lines));
      preview = `<div class="v2-grid cols-3">${stat('KDV hariç toplam', money(totals.net_cents), '')}${stat('KDV', money(totals.vat_cents), '')}${stat('Genel toplam', money(totals.total_cents), 'Belgeye yazılacak tutar')}</div>`;
    } catch (problem) {
      preview = `<div class="notice subtle">Toplam henüz hesaplanamıyor: ${esc(problem.message)}</div>`;
    }
    return card(e.id ? 'Taslağı düzenle' : 'Yeni ' + kindName(e.kind).toLocaleLowerCase('tr-TR'),
      `<form class="v2-form v2-card-body" data-offer-form="save">
        <div class="field-grid">
          <label>Belge türü<select name="kind" ${e.id ? 'disabled' : ''}>${Object.entries(OFFER_KINDS).map(([k, l]) => `<option value="${k}" ${k === e.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Cari hesap<select name="party_id" required ${e.id ? 'disabled' : ''}>${options.map(([k, l]) => `<option value="${esc(k)}" ${k === e.party_id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Belge tarihi<input name="issue_date" type="date" value="${esc(e.issue_date)}" required></label>
          ${isContract ? '' : `<label>Geçerlilik tarihi<input name="valid_until" type="date" value="${esc(e.valid_until)}" required></label>`}
        </div>
        <label>Belge başlığı<input name="title" value="${esc(e.title)}" maxlength="200" required placeholder="Örn. Bahar sezonu saksı teklifi"></label>
        <div class="table-wrap"><table class="v2-table"><thead><tr><th>Açıklama</th><th>Birim</th><th>Miktar</th><th>Birim fiyat (TL)</th><th>İskonto %</th><th>KDV %</th><th></th></tr></thead><tbody data-offer-lines>${lineEditorRows(e.lines)}</tbody></table></div>
        <div class="ac-actions">${act('Satır ekle', 'line-add')}</div>
        ${preview}
        <label>Koşullar<textarea name="terms" rows="4" maxlength="4000" placeholder="Teslim süresi, ödeme koşulu, geçerlilik…">${esc(e.terms)}</textarea></label>
        <p class="help">Bu belge stok düşmez, cari hesaba borç/alacak yazmaz ve resmî fatura değildir. Kaydetmek kimseye mesaj göndermez.</p>
        <p class="error" data-offer-form-error role="alert"></p>
        <div class="ac-actions">${act('Vazgeç', 'editor-close')}<button class="primary" type="submit">${e.id ? 'Taslağı güncelle' : 'Taslak olarak kaydet'}</button></div>
      </form>`);
  }

  function detailPanel() {
    const d = state.detail, now = today();
    const closed = ['accepted', 'rejected', 'cancelled'].includes(d.status);
    const expired = d.effective_status === 'expired';
    const snapshot = d.snapshot;
    const lines = `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Açıklama</th><th>Miktar</th><th>Birim fiyat</th><th>İskonto</th><th>Net</th><th>KDV</th><th>Toplam</th></tr></thead><tbody>${snapshot.totals.rows.map(row => `<tr><td>${esc(row.description)}</td><td>${row.quantity_milli === null ? '—' : esc(new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(row.quantity_milli / 1000) + ' ' + row.unit)}</td><td>${esc(money(row.unit_price_cents))}</td><td>${row.discount_bps ? '%' + row.discount_bps / 100 : '—'}</td><td>${esc(money(row.net_cents))}</td><td>${row.vat_bps === null ? '—' : '%' + row.vat_bps / 100}</td><td>${esc(money(row.total_cents))}</td></tr>`).join('')}</tbody></table></div>`;
    const chain = [
      d.origin ? `<p class="help">Kaynak belge: <strong>${esc(d.origin.document_no)}</strong> · ${esc(kindName(d.origin.kind))}</p>` : '',
      d.derived.length ? `<p class="help">Bu belgeden üretilenler: ${d.derived.map(x => esc(x.document_no) + ' · ' + esc(kindName(x.kind))).join(', ')}</p>` : ''
    ].join('');
    const superseded = d.superseded_by ? `<div class="notice subtle">Bu belgenin yerine ${d.superseded_by.revision}. sürüm alınmış.</div>` : '';
    const expiredNote = expired ? '<div class="notice"><strong>Bu belgenin geçerlilik süresi dolmuş.</strong><br>Kabul edilemez. Yeni sürüm alıp yeniden iletebilirsiniz.</div>' : '';
    const actions = [];
    if (!closed && !d.superseded_by) {
      if (d.status === 'draft') actions.push(act('Taslağı düzenle', 'edit', d.id), act('Karşı tarafa iletildi olarak işaretle', 'sent', d.id, false));
      if (d.status === 'sent' && !expired) actions.push(act('Kabul edildi olarak kaydet', 'accept', d.id, false), act('Reddedildi olarak kaydet', 'reject', d.id));
      actions.push(act('Yeni sürüm al', 'revise', d.id));
      actions.push(act('Belgeyi iptal et', 'cancel', d.id));
    }
    if (d.status === 'accepted' && NEXT_KIND[d.kind] && !d.derived.some(x => x.kind === NEXT_KIND[d.kind]))
      actions.push(act(kindName(NEXT_KIND[d.kind]) + ' hazırla', 'convert', d.id, false));

    return card(`${d.document_no} · ${d.revision}. sürüm`, `<div class="v2-card-body">
      ${badge(statusName({...d, valid_until: d.valid_until ?? snapshot.valid_until}, now), badgeType(d.effective_status))}
      <h3>${esc(snapshot.title)}</h3>
      <p class="help">${esc(snapshot.party.name)} · ${esc(kindName(d.kind))} · ${esc(dayText(snapshot.issue_date))}${snapshot.valid_until ? ' · geçerlilik ' + esc(dayText(snapshot.valid_until)) : ''}</p>
      ${expiredNote}${superseded}${chain}
      ${lines}
      <div class="v2-summary-line"><span>KDV hariç toplam</span><strong>${esc(money(d.net_cents))}</strong></div>
      <div class="v2-summary-line"><span>KDV</span><strong>${esc(money(d.vat_cents))}</strong></div>
      <div class="v2-summary-line total"><span>Genel toplam</span><strong>${esc(money(d.total_cents))}</strong></div>
      ${snapshot.terms ? `<h3>Koşullar</h3><p>${esc(snapshot.terms).replace(/\n/g, '<br>')}</p>` : ''}
      ${d.status_note ? `<p class="help">Not: ${esc(d.status_note)}</p>` : ''}
      <div class="ac-actions">${act('Yazdır', 'print', d.id)}${act('PDF indir', 'pdf', d.id)}${act('Excel indir', 'xlsx', d.id)}${act('Word indir', 'docx', d.id)}${act('CSV indir', 'csv', d.id)}</div>
      ${actions.length ? `<div class="ac-actions">${actions.join('')}</div>` : ''}
      <p class="help">Belgeyi indirmek, yazdırmak ya da karşı tarafa iletmek kabul veya imza anlamına gelmez. Kabul, ayrıca ve bilinçli olarak buradan kaydedilir. Bu ekran dışarıya mesaj göndermez.</p>
    </div>`, act('Kapat', 'detail-close'));
  }

  function render() {
    if (state.disposed) return;
    const filters = [['', 'Tümü'], ...Object.entries(OFFER_KINDS)];
    root.innerHTML = `<div class="v2-page">
      <div class="page-heading"><div><span class="eyebrow">${namespace === 'ec' ? 'E-TİCARET' : 'LUNAPOT'} ÇALIŞMA ALANI</span>
      <h1>Teklif ve belgeler</h1><p>Teklif, proforma ve sözleşmeyi hazırla, sürümünü koru, müşteriye PDF veya Word olarak ver. Bu belgeler stok ve cari hesabı değiştirmez.</p></div>
      <div class="ac-actions">${act('Yeni teklif', 'new', 'quote', false)}${act('Yeni proforma', 'new', 'proforma')}${act('Yeni sözleşme', 'new', 'contract')}</div></div>
      <div class="notice" data-offer-error role="alert" ${state.error ? '' : 'hidden'}>${esc(state.error)}</div>
      <nav class="v2-tabs" aria-label="Belge türü">${filters.map(([key, label]) => `<button type="button" data-offer="filter" data-id="${esc(key)}" class="${state.kind === key ? 'active' : ''}" aria-current="${state.kind === key ? 'page' : 'false'}">${esc(label)}</button>`).join('')}</nav>
      <section data-offer-body>${state.editor ? editorPanel() : state.detail ? detailPanel() : state.loaded ? listPanel() : '<div class="loading">Belgeler yükleniyor…</div>'}</section></div>`;
  }

  function showError(message) {
    state.error = message;
    const box = $('[data-offer-error]');
    if (box) { box.hidden = !message; box.textContent = message; }
  }

  // Satır kutularındaki yazılanlar yeniden çizimde kaybolmasın.
  function readEditorForm() {
    const form = $('[data-offer-form="save"]');
    if (!form || !state.editor) return;
    const e = state.editor;
    if (form.elements.title) e.title = form.elements.title.value;
    if (form.elements.terms) e.terms = form.elements.terms.value;
    if (form.elements.issue_date) e.issue_date = form.elements.issue_date.value;
    if (form.elements.valid_until) e.valid_until = form.elements.valid_until.value;
    if (!e.id) {
      if (form.elements.kind) e.kind = form.elements.kind.value;
      if (form.elements.party_id) e.party_id = form.elements.party_id.value;
    }
    e.lines = [...form.querySelectorAll('[data-offer-lines] tr')].map(tr => ({
      description: tr.querySelector('[name=description]').value,
      unit: tr.querySelector('[name=unit]').value,
      quantity: tr.querySelector('[name=quantity]').value,
      unit_price: tr.querySelector('[name=unit_price]').value,
      discount: tr.querySelector('[name=discount]').value,
      vat: tr.querySelector('[name=vat]').value
    }));
  }

  function openEditor(kind, existing) {
    if (existing) {
      state.editor = {
        id: existing.id, kind: existing.kind, party_id: existing.party_id,
        title: existing.snapshot.title, issue_date: existing.snapshot.issue_date,
        valid_until: existing.snapshot.valid_until || '', terms: existing.snapshot.terms || '',
        lines: fromSnapshotRows(existing.snapshot.totals.rows)
      };
    } else {
      state.editor = {
        id: null, kind, party_id: '', title: '', issue_date: today(),
        valid_until: kind === 'contract' ? '' : plusDays(30), terms: '', lines: [blankLine()]
      };
    }
    state.detail = null;
    render();
  }

  async function run(work) {
    if (state.busy) return;
    state.busy = true; showError('');
    try { await work(); }
    catch (error) { if (error.name !== 'AbortError' && !state.disposed) showError(error.message); }
    finally { state.busy = false; }
  }

  async function statusChange(id, status, prompt) {
    const note = prompt ? window.prompt(prompt) : '';
    if (prompt && !String(note || '').trim()) throw new Error('Nedenini yazmadan kaydedilemez.');
    state.detail = await api(`/offers/${encodeURIComponent(id)}/status`, {status, note: note || ''});
    await load();
    render();
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-offer]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.offer, id = target.dataset.id;
    if (action === 'filter') { state.kind = id; state.detail = null; state.editor = null; run(async () => { await load(); render(); }); return; }
    if (action === 'new') { openEditor(id); return; }
    if (action === 'editor-close') { state.editor = null; render(); return; }
    if (action === 'detail-close') { state.detail = null; render(); return; }
    if (action === 'line-add') { readEditorForm(); state.editor.lines.push(blankLine()); render(); return; }
    if (action === 'line-remove') { readEditorForm(); state.editor.lines.splice(Number(id), 1); render(); return; }
    if (['print', 'pdf', 'xlsx', 'docx', 'csv'].includes(action)) { run(() => produce(action)); return; }
    if (action === 'open') { run(async () => { state.detail = await api('/offers/' + encodeURIComponent(id)); state.editor = null; render(); }); return; }
    if (action === 'edit') { openEditor(state.detail.kind, state.detail); return; }
    if (action === 'sent') { run(() => statusChange(id, 'sent')); return; }
    if (action === 'accept') { run(() => statusChange(id, 'accepted')); return; }
    if (action === 'reject') { run(() => statusChange(id, 'rejected', 'Reddedilme nedenini yazın:')); return; }
    if (action === 'cancel') { run(() => statusChange(id, 'cancelled', 'İptal nedenini yazın:')); return; }
    if (action === 'revise') { const d = state.detail; run(async () => { openEditor(d.kind, d); state.editor.id = null; state.editor.supersedes = d.id; render(); }); return; }
    if (action === 'convert') {
      run(async () => {
        state.detail = await api(`/offers/${encodeURIComponent(id)}/convert`, {});
        await load();
        render();
      });
    }
  }, {signal: controller.signal});

  root.addEventListener('submit', event => {
    const form = event.target.closest('form[data-offer-form]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const error = form.querySelector('[data-offer-form-error]');
    if (error) error.textContent = '';
    run(async () => {
      try {
        readEditorForm();
        const e = state.editor;
        if (!e.party_id) throw new Error('Cari hesap seçin.');
        const body = {
          kind: e.kind, party_id: e.party_id, title: e.title,
          issue_date: e.issue_date, terms: e.terms, lines: toLines(e.lines)
        };
        if (e.kind !== 'contract') body.valid_until = e.valid_until;
        if (e.supersedes) body.supersedes = e.supersedes;
        state.detail = e.id ? await api('/offers/' + encodeURIComponent(e.id), body) : await api('/offers', body);
        state.editor = null;
        await load();
        render();
      } catch (problem) {
        if (error && error.isConnected) { error.textContent = problem.message; return; }
        throw problem;
      }
    });
  }, {signal: controller.signal});

  render();
  run(async () => { await load(); render(); });
  return () => { state.disposed = true; controller.abort(); };
}
