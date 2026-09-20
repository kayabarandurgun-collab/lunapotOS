import {prepareWorkflow} from './product-list.js';
// Banka ekstresi ekranı. Dosya tarayıcıda okunur, sütunlar eşleştirilir, satırlar partiler
// hâlinde sunucuya gider. Aktarım STOK, SATIŞ, FATURA veya CARİ KAYDI OLUŞTURMAZ.
import {readTable, sha256Hex} from './xlsx-read.js';
import {FIELDS, suggestMapping, parseMoney, parseDate} from './report-core.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(v / 100);
const num = v => new Intl.NumberFormat('tr-TR').format(v || 0);
const PARTI = 400;

export function mountBank(root, namespace = 'ec') {
  const controller = new AbortController(), signal = controller.signal;
  const state = {data: null, account: '', draft: null, lines: null, page: 1, query: '', busy: false, message: '', error: '', progress: ''};

  const api = async (path = '', body) => {
    const r = await fetch('/api/' + namespace + '/bank' + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    let x; try { x = await r.json(); } catch { throw new Error('Sunucudan yanıt alınamadı.'); }
    if (!r.ok) throw new Error(x.error || 'İşlem tamamlanamadı.');
    return x;
  };
  const say = (m, hata = false) => { state.message = hata ? '' : m; state.error = hata ? m : ''; };
  const ilerle = m => { state.progress = m; render(); };
  const run = async fn => { if (state.busy) return; state.busy = true; state.progress = ''; say(''); render();
    try { await fn(); } catch (e) { if (e.name !== 'AbortError') say(e.message, true); } finally { state.busy = false; state.progress = ''; render(); } };

  const load = async () => { state.data = await api(); };
  const loadLines = async () => {
    if (!state.account) { state.lines = null; return; }
    state.lines = await api('/lines?' + new URLSearchParams({account_id: state.account, page: state.page, q: state.query}));
  };

  /* ---------- görünüm ---------- */
  const hesapSecenek = () => '<option value="">Hesap seçin…</option>' +
    (state.data?.accounts || []).map(a => `<option value="${esc(a.id)}" ${a.id === state.account ? 'selected' : ''}>${esc(a.name)} · ${a.kind === 'bank' ? 'banka' : 'kasa'}</option>`).join('');

  function hesapKarti() {
    const a = state.data?.accounts || [];
    return `<section class="v2-card"><h3>Hesaplar ve ekstre toplamları</h3><p class="help">Net tutar, yüklenen ekstre hareketlerinin toplamıdır; bankadaki güncel bakiye değildir.</p>
      ${a.length ? `<div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Hesap</th><th>Tür</th><th class="rb-num">Hareket</th><th class="rb-num">Ekstre net toplamı</th><th>Son işlem</th></tr></thead><tbody>
        ${a.map(x => `<tr><td><strong>${esc(x.name)}</strong></td><td>${x.kind === 'bank' ? 'Banka' : 'Kasa'}</td>
          <td class="rb-num">${num(x.line_count)}</td><td class="rb-num">${money(x.net_cents)}</td><td>${esc(x.last_date || '—')}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="rb-muted">Henüz hesap yok. Paranın yattığı bankayı ekleyerek başla; ekstreyi ona yükleyeceksin.</p>'}
      <form data-bank-form="account" class="rb-grid">
        <label>Hesap adı<input name="name" required maxlength="120" placeholder="Örn. QNB TL"></label>
        <label>Tür<select name="kind"><option value="bank">Banka</option><option value="cash">Kasa</option></select></label>
        <button class="primary" type="submit">Hesap ekle</button></form></section>`;
  }

  function yuklemeKarti() {
    const d = state.draft;
    if (!state.data?.accounts?.length) return '';
    if (!d) return `<section class="v2-card"><span class="eyebrow">1 / 3 · Dosya seçimi</span><h3>Ekstre yükle</h3>
      <p class="rb-muted">Bankadan indirdiğin ekstreyi (Excel veya CSV) seç. Dosya tarayıcında okunur.
        Aynı dosyayı veya aynı hareketi ikinci kez yüklersen sistem tekrar işlemez.</p>
      <div class="rb-grid">
        <label>Hesap<select data-bank="account">${hesapSecenek()}</select></label>
        <label>Ekstre dosyası<input type="file" data-bank="file" accept=".csv,.xlsx,.txt"></label></div></section>`;
    if (d.step === 'map') return eslestirmeKarti();
    if (d.step === 'preview') return onizlemeKarti();
    return '';
  }

  function eslestirmeKarti() {
    const d = state.draft;
    const secenek = alan => `<select data-bank-map="${alan.key}"><option value="">— yok —</option>` +
      d.headers.map(h => `<option value="${esc(h)}" ${d.mapping[alan.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('') + '</select>';
    return `<section class="v2-card"><span class="eyebrow">2 / 3 · Alan eşleştirme</span><h3>Sütunları eşleştir · ${esc(d.filename)}</h3>
      <p class="rb-muted">${num(d.rows.length)} satır okundu. Tutar tek sütundaysa <b>Tutar</b>'ı seç;
        banka <b>Borç</b> ve <b>Alacak</b> diye ayırmışsa o ikisini seç — sistem farkı alır.</p>
      <div class="rb-grid">${FIELDS.bank.map(alan => `<label>${esc(alan.label)}${alan.required ? ' *' : ''}${secenek(alan)}</label>`).join('')}</div>
      <div class="rb-actions"><button type="button" class="secondary" data-bank-act="cancel">Vazgeç</button>
        <button type="button" class="primary" data-bank-act="preview">Önizle</button></div></section>`;
  }

  function onizlemeKarti() {
    const d = state.draft, p = d.preview;
    return `<section class="v2-card"><span class="eyebrow">3 / 3 · Kontrol ve aktarım</span><h3>Önizleme · ${esc(d.filename)}</h3>
      <dl class="rb-kv">
        <div><dt>Okunan satır</dt><dd>${num(p.ok.length + p.hatali.length)}</dd></div>
        <div><dt>Aktarılacak</dt><dd><strong>${num(p.ok.length)}</strong></dd></div>
        <div><dt>Okunamayan</dt><dd class="${p.hatali.length ? 'rb-warn' : ''}">${num(p.hatali.length)}</dd></div>
        <div><dt>Dönem</dt><dd>${esc(p.ilk || '—')} – ${esc(p.son || '—')}</dd></div>
        <div><dt>Para girişi</dt><dd class="rb-num">${money(p.giren)}</dd></div>
        <div><dt>Para çıkışı</dt><dd class="rb-num">${money(p.cikan)}</dd></div></dl>
      ${p.hatali.length ? `<details><summary>Okunamayan ${num(p.hatali.length)} satır — bunlar aktarılmaz</summary>
        <ul class="rb-list">${p.hatali.slice(0, 20).map(h => `<li>Satır ${h.satir}: ${esc(h.sebep)}</li>`).join('')}</ul></details>` : ''}
      <div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Tarih</th><th>Açıklama</th><th class="rb-num">Tutar</th><th class="rb-num">Bakiye</th><th>Dekont</th></tr></thead><tbody>
        ${p.ok.slice(0, 8).map(l => `<tr><td>${esc(l.occurred_on)}</td><td>${esc(l.description).slice(0, 60)}</td>
          <td class="rb-num">${money(l.amount_cents)}</td><td class="rb-num">${money(l.balance_cents)}</td><td>${esc(l.reference)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="rb-muted">Bu aktarım stok, satış, fatura veya cari kaydı oluşturmaz. Satırlar ham hâliyle saklanır.</p>
      <div class="rb-actions"><button type="button" class="secondary" data-bank-act="back">Eşleştirmeye dön</button>
        <button type="button" class="primary" data-bank-act="upload">Yükle</button></div></section>`;
  }

  function dosyaKarti() {
    const f = state.data?.files || [];
    if (!f.length) return '';
    return `<section class="v2-card"><h3>Yüklenen ekstreler</h3><div class="v2-table-wrap"><table class="v2-table">
      <thead><tr><th>Dosya</th><th>Hesap</th><th class="rb-num">Satır</th><th>Dönem</th><th>Durum</th></tr></thead><tbody>
      ${f.map(x => `<tr><td>${esc(x.filename)}</td><td>${esc(x.account_name)}</td><td class="rb-num">${num(x.row_count)}</td>
        <td>${esc(x.period_from || '—')} – ${esc(x.period_to || '—')}</td>
        <td>${x.status === 'applied' ? '<span class="rb-chip ok">Kapandı</span>' : '<span class="rb-chip warn">Yarım</span>'}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  }

  function satirKarti() {
    const l = state.lines;
    return `<section class="v2-card"><h3>Ekstre hareketleri</h3>
      <form data-bank-form="search" class="rb-toolbar">
        <label>Hesap<select data-bank="lines-account">${hesapSecenek()}</select></label>
        <label>Açıklama, dekont veya karşı taraf ara<input name="q" type="search" value="${esc(state.query)}" maxlength="100"></label>
        <button class="secondary" type="submit">Ara</button></form>
      ${l ? (l.lines.length ? `<div class="v2-table-wrap"><table class="v2-table">
        <thead><tr><th>Tarih</th><th>Açıklama</th><th>Karşı taraf</th><th class="rb-num">Tutar</th><th class="rb-num">Bakiye</th><th>Dekont</th></tr></thead><tbody>
        ${l.lines.map(x => `<tr><td>${esc(x.occurred_on)}</td><td>${esc(x.description)}</td><td>${esc(x.counterparty)}</td>
          <td class="rb-num ${x.amount_cents < 0 ? 'rb-warn' : ''}">${money(x.amount_cents)}</td>
          <td class="rb-num">${money(x.balance_cents)}</td><td>${esc(x.reference)}</td></tr>`).join('')}
        </tbody></table></div><div class="rb-actions workflow-pagination"><span class="rb-muted">${num(l.total)} hareket · sayfa ${l.page} / ${Math.max(1,Math.ceil(l.total/l.page_size))}</span><button type="button" class="secondary" data-bank-act="previous" ${l.page<=1?'disabled':''}>← Önceki</button><button type="button" class="secondary" data-bank-act="next" ${l.page*l.page_size>=l.total?'disabled':''}>Sonraki →</button></div>`
        : '<p class="rb-muted">Bu aramaya uyan hareket yok.</p>') : '<p class="rb-muted">Hesap seçin.</p>'}</section>`;
  }

  function render() {
    if(signal.aborted)return;
    prepareWorkflow(root);
    root.innerHTML = '<div class="rb workflow-page">' +
      `<section class="page-heading"><div><span class="eyebrow">E-ticaret / Banka</span><h1>Banka hareketlerini doğrula</h1>
        <p>Paranın gerçekten yattığını buradan doğrularız. ${esc(state.data?.notice || '')}</p></div></section>` +
      (state.error ? `<p class="rb-alert error" role="alert">${esc(state.error)}</p>` : '') +
      (state.message ? `<p class="rb-alert ok" role="status">${esc(state.message)}</p>` : '') +
      (state.data?.accounts?.length ? yuklemeKarti() + satirKarti() + '<details class="workflow-details"><summary>Hesapları yönet · '+state.data.accounts.length+' hesap</summary>'+hesapKarti()+'</details>' : hesapKarti()) + '<details class="workflow-details"><summary>Yüklenen ekstreler · '+(state.data?.files?.length||0)+' dosya</summary>'+dosyaKarti()+'</details>' +
      '</div>' + (state.busy ? `<p class="rb-busy" role="status">${esc(state.progress || 'İşleniyor…')}</p>` : '');
    root.setAttribute('aria-busy',String(state.busy));
    if(state.busy)for(const control of root.querySelectorAll('button,input,select,textarea'))control.disabled=true;
  }

  /* ---------- okuma ve aktarma ---------- */
  async function dosyaAl(file) {
    if (!state.account) throw new Error('Önce hesabı seçin.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const table = await readTable(bytes, {name: file.name});
    if (!table.headers.length) throw new Error('Dosyada başlık satırı bulunamadı.');
    state.draft = {step: 'map', filename: file.name, bytes, sha: await sha256Hex(bytes), size: bytes.length,
      headers: table.headers, rows: table.rows, mapping: suggestMapping('bank', table.headers)};
  }

  // Tutar: tek sütun varsa o; banka Borç/Alacak diye ayırmışsa alacak - borç.
  // Iki tanim da yoksa satir okunamaz sayilir; sifir YAZILMAZ.
  function onizle() {
    const d = state.draft, m = d.mapping, ok = [], hatali = [];
    const indeks = ad => ad ? d.headers.indexOf(ad) : -1;
    const al = (satir, ad) => { const i = indeks(ad); return i < 0 ? null : satir.cells[i]; };
    let giren = 0, cikan = 0;
    d.rows.forEach((satir, n) => {
      const t = parseDate(al(satir, m.occurred_on));
      if (t.missing || t.error) { hatali.push({satir: n + 2, sebep: 'Tarih okunamadı'}); return; }
      let tutar = null;
      if (m.amount) { const a = parseMoney(al(satir, m.amount)); if (!a.missing && !a.error) tutar = a.value; }
      if (tutar === null && (m.debit || m.credit)) {
        const b = m.debit ? parseMoney(al(satir, m.debit)) : {missing: true};
        const a = m.credit ? parseMoney(al(satir, m.credit)) : {missing: true};
        const bc = b.missing || b.error ? 0 : Math.abs(b.value), ac = a.missing || a.error ? 0 : Math.abs(a.value);
        if (bc || ac) tutar = ac - bc;
      }
      if (tutar === null) { hatali.push({satir: n + 2, sebep: 'Tutar okunamadı'}); return; }
      if (tutar === 0) { hatali.push({satir: n + 2, sebep: 'Tutar sıfır; aktarılmaz'}); return; }
      const bakiye = m.balance ? parseMoney(al(satir, m.balance)) : {missing: true};
      const metin = (ad) => { const v = al(satir, ad); return v && v.v !== null && v.v !== undefined ? String(v.v).trim() : ''; };
      if (tutar > 0) giren += tutar; else cikan += tutar;
      ok.push({occurred_on: String(t.value).slice(0, 10), amount_cents: tutar,
        balance_cents: bakiye.missing || bakiye.error ? null : bakiye.value,
        description: metin(m.description), reference: metin(m.reference), counterparty: metin(m.counterparty)});
    });
    const tarihler = ok.map(x => x.occurred_on).sort();
    d.preview = {ok, hatali, giren, cikan, ilk: tarihler[0], son: tarihler.at(-1)};
    d.step = 'preview';
  }

  async function yukle() {
    const d = state.draft;
    const file = await api('/files', {account_id: state.account, filename: d.filename, sha256: d.sha, size_bytes: d.size});
    if (file.duplicate) { say(file.notice); state.draft = null; await load(); return; }
    let yazilan = 0, tekrar = 0;
    for (let i = 0; i < d.preview.ok.length; i += PARTI) {
      ilerle('Ekstre yükleniyor… ' + num(i) + ' / ' + num(d.preview.ok.length) + ' satır');
      const r = await api('/files/' + file.id + '/lines', {lines: d.preview.ok.slice(i, i + PARTI)});
      yazilan += r.inserted; tekrar += r.duplicate;
    }
    const kapat = await api('/files/' + file.id + '/seal', {});
    state.draft = null;
    await load(); await loadLines();
    say('Ekstre yüklendi: ' + num(yazilan) + ' yeni hareket' + (tekrar ? ', ' + num(tekrar) + ' hareket zaten vardı (ikinci kez yazılmadı)' : '') +
      '. Dönem ' + (kapat.period_from || '—') + ' – ' + (kapat.period_to || '—') + '.');
  }

  /* ---------- olaylar ---------- */
  root.addEventListener('change', e => {
    const t = e.target.dataset.bank;
    if (t === 'account') { state.account = e.target.value; state.page = 1; run(loadLines); return; }
    if (t === 'lines-account') { state.account = e.target.value; state.page = 1; run(loadLines); return; }
    if (t === 'file' && e.target.files?.[0]) { const f = e.target.files[0]; run(() => dosyaAl(f)); return; }
    const alan = e.target.dataset.bankMap;
    if (alan && state.draft) state.draft.mapping[alan] = e.target.value || undefined;
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-bank-act]'); if (!b) return;
    const a = b.dataset.bankAct;if(state.busy||b.disabled)return;
    if(a==='previous'||a==='next'){state.page=Math.max(1,state.page+(a==='next'?1:-1));run(loadLines);return;}
    if (a === 'cancel') { state.draft = null; render(); }
    if (a === 'back') { state.draft.step = 'map'; render(); }
    if (a === 'preview') run(async () => { onizle(); });
    if (a === 'upload') run(yukle);
  });
  root.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target, kind = form.dataset.bankForm;
    const x = Object.fromEntries(new FormData(form));
    if (kind === 'account') run(async () => { const h = await api('/accounts', {name: x.name, kind: x.kind}); await load(); state.account = h.id; await loadLines(); say('Hesap eklendi.'); });
    if (kind === 'search') { state.query = x.q || ''; state.page = 1; run(loadLines); }
  });

  run(async () => { await load(); });
  return () => {root.removeAttribute('aria-busy');controller.abort();};
}
