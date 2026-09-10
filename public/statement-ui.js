// Cari mutabakatı ekranı. Belgeler tarayıcıda, sunucudan yetkiyle gelen veriden üretilir;
// ayrı bir ikili indirme ucu yoktur. Müşteri bilgisi veya tutar hiçbir yerde saklanmaz.
// Bu ekran dışarıya e-posta veya mesaj GÖNDERMEZ; yalnızca indirilebilir belge hazırlar.
import {pdfBytes, xlsxBytes, docxBytes, csvBytes, saveFile, safeFilename, printDocument} from './doc-engine.js';
import {
  statementPdfDocument, statementSheets, statementCsvRows, statementPrintHtml, statementBlocks,
  STATUS_NAMES, money, balanceSentence, balancePhrase, differenceSentence
} from './statement-document.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const monthStart = () => today().slice(0, 8) + '01';
const dayText = value => { const [y, m, d] = String(value || '').split('-'); return d ? `${d}.${m}.${y}` : ''; };
const badgeType = status => ({agreed: 'success', disputed: 'danger', cancelled: 'neutral', sent: 'warning'}[status] || 'neutral');
const badge = (label, type = 'neutral') => `<span class="v2-badge ${type}">${esc(label)}</span>`;
const stat = (label, value, note) => `<article class="v2-stat"><span class="v2-stat-label">${esc(label)}</span><strong class="v2-stat-value">${esc(value)}</strong><small>${esc(note)}</small></article>`;
const card = (title, content, action = '') => `<section class="v2-card"><div class="v2-card-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
const act = (label, action, id = '', secondary = true) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-statement="${action}" data-id="${esc(id)}">${esc(label)}</button>`;

export function mountStatement(root, namespace, parties = []) {
  if (!['ec', 'lp'].includes(namespace)) throw new Error('Çalışma alanı geçersiz.');
  const controller = new AbortController();
  const state = {party: '', from: monthStart(), to: today(), live: null, docs: [], doc: null, error: '', busy: false, disposed: false};
  const $ = selector => root.querySelector(selector);

  async function api(path, body) {
    const response = await fetch(`/api/${namespace}/statement${path}`, {
      signal: controller.signal,
      ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
    });
    let data; try { data = await response.json(); } catch { throw new Error('Sunucuya ulaşılamadı. Lütfen yeniden deneyin.'); }
    if (!response.ok) throw new Error(data.error || 'İşlem tamamlanamadı.');
    return data;
  }

  const partyName = () => parties.find(p => p.id === state.party)?.name || '';

  // Belge kaynağı: ekrandaki canlı ekstre ya da kaydedilmiş belgenin dondurulmuş görüntüsü.
  function source(saved) {
    if (saved) return {
      party: saved.party, workspace: saved.workspace, statement: saved.snapshot.statement,
      difference: saved.difference, notice: saved.notice,
      meta: {document_no: saved.document_no, revision: saved.revision, status: saved.status, ledger_changed: saved.ledger_changed}
    };
    const live = state.live;
    return {party: live.party, workspace: live.workspace, statement: live.statement, difference: live.difference, notice: live.notice, meta: {}};
  }

  const fileBase = data => safeFilename(
    data.meta.document_no || 'Cari-ekstre', data.party.name, data.statement.from, data.statement.to
  );

  async function produce(format, saved) {
    const data = source(saved);
    const name = fileBase(data);
    if (format === 'print') return printDocument(statementPrintHtml(data), {title: 'Cari mutabakat mektubu'});
    if (format === 'csv') return saveFile(csvBytes(statementCsvRows(data)), name + '.csv');
    if (format === 'xlsx') return saveFile(xlsxBytes(statementSheets(data)), name + '.xlsx');
    if (format === 'docx') return saveFile(docxBytes(statementBlocks(data), {footer: data.notice}), name + '.docx');
    if (format === 'pdf') return saveFile(await pdfBytes(statementPdfDocument(data)), name + '.pdf');
    throw new Error('Belge biçimi tanınmadı.');
  }

  async function loadLive() {
    if (!state.party) throw new Error('Önce bir cari hesap seçin.');
    state.live = await api(`?party_id=${encodeURIComponent(state.party)}&from=${state.from}&to=${state.to}`);
    state.docs = (await api(`/documents?party_id=${encodeURIComponent(state.party)}`)).documents;
  }

  function exportBar(saved) {
    const key = saved ? saved.id : '';
    return `<div class="ac-actions">${act('Yazdır', 'print', key)}${act('PDF indir', 'pdf', key)}${act('Excel indir', 'xlsx', key)}${act('Word indir', 'docx', key)}${act('CSV indir', 'csv', key)}</div>`;
  }

  function statementTable(statement) {
    if (!statement.rows.length) return '<div class="v2-empty"><h3>Bu dönemde hareket yok.</h3><p>Tarih aralığını genişletin ya da başka bir cari seçin.</p></div>';
    return `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Tarih / vade</th><th>Referans</th><th>Açıklama</th><th>Alacağımız</th><th>Borcumuz</th><th>Bakiye</th></tr></thead><tbody>${statement.rows.map(row => `<tr><td>${esc(dayText(row.occurred_on))}<small>${row.due_on ? 'Vade: ' + esc(dayText(row.due_on)) : 'Vade yok'}</small></td><td>${esc(row.reference || '')}</td><td>${esc(row.description || '')}</td><td>${row.receivable_cents ? esc(money(row.receivable_cents)) : (row.receivable_cents === null ? esc(money(null)) : '—')}</td><td>${row.payable_cents ? esc(money(row.payable_cents)) : (row.payable_cents === null ? esc(money(null)) : '—')}</td><td>${esc(money(row.running_cents))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function livePanel() {
    const live = state.live;
    if (!live) return '<div class="v2-empty"><h3>Dönem seçip ekstreyi getirin.</h3><p>Ekstre seçtiğiniz dönemin tamamını kapsar; devir, dönem başından önceki bütün hareketlerden hesaplanır.</p></div>';
    const s = live.statement;
    return `<div class="v2-grid cols-4">${stat('Devir', money(s.opening_cents), 'Dönem başından önceki bakiye')}${stat('Dönem içi alacağımız', money(s.debit_cents), `${s.row_count} hareket`)}${stat('Dönem içi borcumuz', money(s.credit_cents), 'Dönem içi ödeme ve iadeler')}${stat('Dönem sonu bakiye', money(s.closing_cents), balanceSentence(s.closing_cents))}</div>` +
      card(`${partyName()} · ${dayText(s.from)} – ${dayText(s.to)}`, statementTable(s), exportBar(null)) +
      `<div class="notice subtle">${esc(live.notice)}</div>` +
      `<div class="ac-actions">${act('Mutabakat belgesi olarak kaydet', 'save', '', false)}</div>` +
      '<p class="help">Belge kaydedilince bu görüntü dondurulur. Sonradan deftere geçmiş tarihli kayıt girerse belge değişmez; uyarı verilir ve yeni sürüm alınabilir.</p>';
  }

  function documentsPanel() {
    if (!state.party) return '';
    const rows = state.docs.map(d => `<tr><td><strong>${esc(d.document_no)}</strong><small>${d.revision}. sürüm${d.superseded ? ' · yerine yenisi alındı' : ''}</small></td><td>${esc(dayText(d.period_from))} – ${esc(dayText(d.period_to))}</td><td>${esc(balancePhrase(d.closing_cents))}</td><td>${badge(STATUS_NAMES[d.status] || d.status, badgeType(d.status))}</td><td>${esc(d.created_by_name)}<small>${esc(String(d.created_at).slice(0, 10))}</small></td><td>${act('Aç', 'open', d.id)}</td></tr>`).join('');
    return card('Mutabakat belgeleri', state.docs.length
      ? `<div class="table-wrap"><table class="v2-table"><thead><tr><th>Belge</th><th>Dönem</th><th>Dönem sonu bakiye</th><th>Durum</th><th>Kaydeden</th><th>İşlem</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="v2-empty"><h3>Bu cari için kaydedilmiş belge yok.</h3><p>Ekstreyi getirip “Mutabakat belgesi olarak kaydet” diyerek ilk belgeyi oluşturabilirsiniz.</p></div>');
  }

  function documentPanel() {
    const d = state.doc;
    if (!d) return '';
    const closed = ['agreed', 'cancelled'].includes(d.status);
    const warning = d.ledger_changed
      ? `<div class="notice"><strong>Bu belge kaydedildikten sonra deftere bu döneme ait kayıt girilmiş.</strong><br>Belge değiştirilmedi. Güncel defterde dönem sonu bakiye ${esc(balancePhrase(d.ledger_now.closing_cents))} ve ${d.ledger_now.row_count} hareket görünüyor. İsterseniz yeni sürüm alın.</div>`
      : '';
    const superseded = d.superseded_by ? `<div class="notice subtle">Bu belgenin yerine ${d.superseded_by.revision}. sürüm alınmış.</div>` : '';
    const actions = closed || d.superseded_by ? '' :
      `<div class="ac-actions">${d.status === 'draft' ? act('Karşı tarafa iletildi olarak işaretle', 'sent', d.id) : ''}${act('Karşı tarafın yanıtını gir', 'reply', d.id, false)}${act('Yeni sürüm al', 'revise', d.id)}${act('Belgeyi iptal et', 'cancel', d.id)}</div>`;
    return card(`${esc(d.document_no)} · ${d.revision}. sürüm`, `<div class="v2-card-body">${badge(STATUS_NAMES[d.status] || d.status, badgeType(d.status))}
      <p>${esc(balanceSentence(d.closing_cents))}</p>
      <p>${esc(differenceSentence(d.difference))}</p>
      ${d.reported_note ? `<p class="help">Not: ${esc(d.reported_note)}</p>` : ''}
      ${warning}${superseded}
      ${statementTable(d.snapshot.statement)}
      ${exportBar(d)}
      ${actions}
      <p class="help">Belgeyi indirmek ya da karşı tarafa iletmek kabul veya imza anlamına gelmez. Mutabakat ancak karşı taraf bakiyesini bildirdiğinde oluşur. Bu ekran dışarıya mesaj göndermez.</p>
    </div>`, act('Kapat', 'close-doc'));
  }

  function render() {
    if (state.disposed) return;
    const options = [['', 'Cari seçin…'], ...parties.map(p => [p.id, p.name])];
    root.innerHTML = `<div class="notice" data-statement-error role="alert" ${state.error ? '' : 'hidden'}>${esc(state.error)}</div>
      <form class="v2-toolbar" data-statement-form="period">
        <label>Cari hesap<select name="party_id" required>${options.map(([key, label]) => `<option value="${esc(key)}" ${key === state.party ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Başlangıç<input name="from" type="date" value="${esc(state.from)}" required></label>
        <label>Bitiş<input name="to" type="date" value="${esc(state.to)}" required></label>
        <button class="primary" type="submit"${state.busy ? ' disabled' : ''}>Ekstreyi getir</button>
      </form>
      <div data-statement-body>${state.doc ? documentPanel() : livePanel() + documentsPanel()}</div>`;
  }

  function showError(message) {
    state.error = message;
    const box = $('[data-statement-error]');
    if (box) { box.hidden = !message; box.textContent = message; }
  }

  function replyDialog(id) {
    const d = state.doc;
    root.insertAdjacentHTML('beforeend', `<dialog data-statement-dialog><form class="v2-form" data-statement-form="reply" data-id="${esc(id)}">
      <div class="dialog-heading"><h2>Karşı tarafın yanıtı</h2><button type="button" class="icon-button" data-statement="close" aria-label="Kapat">×</button></div>
      <div class="form-body">
        <p class="help">Bizim defterimizde dönem sonu bakiye ${esc(money(d.closing_cents))}. Karşı tarafın size yazılı olarak bildirdiği tutarı, kendi mektubunda yazdığı gibi girin.</p>
        <label>Bildirilen tutar (TL)<input name="reported" type="number" step="0.01" min="0" max="1000000000" required></label>
        <label>Karşı taraf ne diyor?<select name="direction" required>
          <option value="they_owe">Bu tutarı bize borçlu olduklarını bildirdiler</option>
          <option value="we_owe">Bu tutarı bizden alacaklı olduklarını bildirdiler</option>
        </select></label>
        <p class="help">Tutarı eksisiz yazın; yönü bu seçim belirler. İki defter birbirinin aynasıdır: bizde alacak görünen tutar karşı tarafta borç görünür.</p>
        <label>Sonuç<select name="status" required>
          <option value="agreed">Mutabık kalındı</option>
          <option value="disputed">İhtilaflı</option>
        </select></label>
        <label>Açıklama<textarea name="note" rows="3" maxlength="1000" placeholder="İhtilafta farkın nedenini yazın."></textarea></label>
        <p class="error" data-statement-form-error role="alert"></p>
      </div>
      <div class="dialog-footer">${act('Vazgeç', 'close')}<button class="primary" type="submit">Yanıtı kaydet</button></div>
    </form></dialog>`);
    $('dialog[data-statement-dialog]').showModal();
  }

  function closeDialog() { const node = $('dialog[data-statement-dialog]'); node?.close(); node?.remove(); }

  async function openDocument(id) {
    state.doc = await api('/documents/' + encodeURIComponent(id));
    render();
  }

  async function run(work) {
    if (state.busy) return;
    state.busy = true; showError('');
    try { await work(); }
    catch (error) { if (error.name !== 'AbortError' && !state.disposed) showError(error.message); }
    finally { state.busy = false; }
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('[data-statement]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.statement, id = target.dataset.id;
    if (action === 'close') { closeDialog(); return; }
    if (action === 'close-doc') { state.doc = null; render(); return; }
    if (['print', 'pdf', 'xlsx', 'docx', 'csv'].includes(action)) {
      run(async () => {
        const saved = id ? state.doc : null;
        if (!saved && !state.live) throw new Error('Önce ekstreyi getirin.');
        await produce(action, saved);
      });
      return;
    }
    if (action === 'open') { run(() => openDocument(id)); return; }
    if (action === 'reply') { replyDialog(id); return; }
    if (action === 'save' || action === 'revise') {
      run(async () => {
        const body = {party_id: state.party, from: state.from, to: state.to};
        if (action === 'revise') body.supersedes = id;
        const saved = await api('/documents', body);
        state.doc = saved;
        await loadLive();
        render();
      });
      return;
    }
    if (action === 'sent' || action === 'cancel') {
      run(async () => {
        state.doc = await api(`/documents/${encodeURIComponent(id)}/status`, {status: action === 'sent' ? 'sent' : 'cancelled'});
        await loadLive();
        render();
      });
    }
  }, {signal: controller.signal});

  root.addEventListener('submit', event => {
    const form = event.target.closest('form[data-statement-form]');
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form)), kind = form.dataset.statementForm;
    const error = form.querySelector('[data-statement-form-error]');
    if (error) error.textContent = '';
    run(async () => {
      try {
        if (kind === 'period') {
          if (values.from > values.to) throw new Error('Başlangıç tarihi bitişten sonra olamaz.');
          state.party = values.party_id; state.from = values.from; state.to = values.to; state.doc = null;
          await loadLive();
          render();
          return;
        }
        // Kullanıcı eksisiz tutar ve yön yazar; işaret burada bizim kuralımıza çevrilir.
        // Böylece "aynı sayıyı söylediler" ile "mutabıkız" karışmaz.
        const size = Math.round(Number(values.reported) * 100);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Bildirilen tutar geçersiz.');
        const reported = values.direction === 'they_owe' ? size : -size;
        if (values.status === 'disputed' && !String(values.note).trim()) throw new Error('İhtilaf için farkın nedenini yazın.');
        state.doc = await api(`/documents/${encodeURIComponent(form.dataset.id)}/status`,
          {status: values.status, reported_cents: reported, reported_perspective: 'ours', note: values.note});
        closeDialog();
        await loadLive();
        render();
      } catch (problem) {
        if (error && error.isConnected) { error.textContent = problem.message; return; }
        throw problem;
      }
    });
  }, {signal: controller.signal});

  render();
  return () => { state.disposed = true; controller.abort(); closeDialog(); };
}
