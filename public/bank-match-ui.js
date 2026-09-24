// HAKEDİŞ–BANKA EŞLEŞTİRME ekranı.
//
// Soru şu: "Pazaryerinin bana yatırdığını söylediği para gerçekten bankaya girdi mi?"
// Cevabı yalnızca banka ekstresi verir. Bu ekran ekstre satırlarını pazaryerinin ödeme
// emirleriyle yan yana koyar; kaydı kullanıcının onayı doğurur, motor kendiliğinden yazmaz.
//
// Belirsiz eşleşmede ÖNERİ VERİLMEZ (aynı tutarlı birden çok ödeme emri). Kuruş farkında da
// öneri verilmez; onaylanırsa deftere BANKA tutarı yazılır.
import {prepareWorkflow} from './product-list.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = v => v === null || v === undefined ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(v / 100);
const num = v => new Intl.NumberFormat('tr-TR').format(v || 0);
const DURUM = {
  exact: ['ok', 'Tam eşleşme'],
  ambiguous: ['warn', 'Belirsiz'],
  near: ['warn', 'Kuruş farkı'],
  unmatched: ['', 'Karşılığı yok']
};

export function mountBankMatch(root, namespace = 'ec') {
  const controller = new AbortController(), signal = controller.signal;
  const state = {data: null, list: null, account: '', provider: 'trendyol', choice: new Map(),
    busy: false, message: '', error: ''};

  const api = async (path = '', body) => {
    const r = await fetch('/api/' + namespace + '/bank/matches' + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal});
    let x; try { x = await r.json(); } catch { throw new Error('Sunucudan yanıt alınamadı.'); }
    // Sunucu bazı hatalarda makine okunur ayrıntı döner (örn. alacak hesabı yok, kuruş farkı var);
    // ekran o ayrıntıyla DOĞRU SORUYU sorar, körlemesine yeniden denemez.
    if (!r.ok) throw Object.assign(new Error(x.error || 'İşlem tamamlanamadı.'), {data: x});
    return x;
  };
  const say = (m, hata = false) => { state.message = hata ? '' : m; state.error = hata ? m : ''; };
  const run = async fn => { if (state.busy) return; state.busy = true; say(''); render();
    try { await fn(); } catch (e) { if (e.name !== 'AbortError') say(e.message, true); } finally { state.busy = false; render(); } };

  const load = async () => {
    const [aday, liste] = await Promise.all([
      api('/candidates?' + new URLSearchParams({account_id: state.account, provider: state.provider})),
      api('')
    ]);
    state.data = aday; state.list = liste;
    if (!state.account && aday.accounts.length === 1) { state.account = aday.accounts[0].id; return load(); }
  };

  /* ---------- görünüm ---------- */
  // Bakiye sıfır değilse sebebi açıkça yazılır; sessizce "yeşil" gösterilmez.
  const acikParaUyarisi = acik => acik ? `<p class="rb-alert error" role="alert">Alacak hesaplarında ${money(acik)} açıklanmamış
    para duruyor. Bu tutar bir yere aktarılmamış demektir; eşleştirmeleri ve kasa hareketlerini gözden geçirin.</p>` : '';

  function alacakKarti() {
    const hesaplar = state.list?.clearing_accounts || [];
    const acik = state.list?.unexplained_cents;
    if (!hesaplar.length) return `<section class="v2-card"><h3>Pazaryeri alacak hesapları</h3>
      <p class="rb-muted">Henüz alacak hesabı yok. İlk hakedişi onayladığında, seçtiğin pazaryeri için
        (“Trendyol Alacağı” gibi) bir hesap açılmasını onaylaman istenir. Gelen para önce o hesaba girer,
        aynı anda ekstrenin bankasına aktarılır.</p></section>`;
    return `<section class="v2-card"><h3>Pazaryeri alacak hesapları</h3>
      <div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Hesap</th><th class="rb-num">Eşleşme</th>
        <th class="rb-num">Giren para</th><th class="rb-num">Bakiye</th><th>Durum</th></tr></thead><tbody>
        ${hesaplar.map(h => `<tr><td><strong>${esc(h.name)}</strong></td><td class="rb-num">${num(h.match_count)}</td>
          <td class="rb-num">${money(h.in_cents)}</td><td class="rb-num ${h.balance_cents ? 'rb-warn' : ''}">${money(h.balance_cents)}</td>
          <td>${h.balance_cents ? '<span class="rb-chip warn">Açıklanmamış para</span>' : '<span class="rb-chip ok">Yerinde</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="help">${esc(state.list?.balance_note || '')}</p>
      ${acikParaUyarisi(acik)}</section>`;
  }

  function suzgec() {
    const d = state.data;
    const hesaplar = d?.accounts || [];
    return `<section class="v2-card"><h3>Hangi hesabın ekstresini eşleştiriyoruz?</h3>
      <form data-match-form="filter" class="rb-toolbar">
        <label>Banka hesabı<select data-match="account">
          <option value="">Hesap seçin…</option>
          ${hesaplar.map(a => `<option value="${esc(a.id)}" ${a.id === state.account ? 'selected' : ''}>${esc(a.name)} · ${num(a.line_count)} hareket</option>`).join('')}
        </select></label>
        <label>Pazaryeri<select data-match="provider">
          ${(d?.providers || []).map(p => `<option value="${esc(p.id)}" ${p.id === state.provider ? 'selected' : ''}>${esc(p.name)}${p.supported ? '' : ' (ödeme emri gelmiyor)'}</option>`).join('')}
        </select></label></form>
      ${hesaplar.length ? '' : '<p class="rb-muted">Henüz hiç banka ekstresi yüklenmemiş. Önce “Ekstre yükle” sekmesinden bankadan indirdiğin dosyayı yükle; eşleştirme ancak ondan sonra yapılabilir.</p>'}
      ${d ? `<p class="help">${esc(d.notice)} Tutar birebir aynı ve tarih farkı en çok ${num(d.window_days)} gün olan ödeme emirleri önerilir.</p>` : ''}</section>`;
  }

  function adayRow(line) {
    const [chip, etiket] = DURUM[line.status];
    const secili = state.choice.get(line.bank_line_id) || line.suggestion?.payment_order_id || '';
    const secim = line.candidates.length
      ? `<select data-match-choice="${esc(line.bank_line_id)}">
          ${line.status === 'exact' ? '' : '<option value="">Ödeme emri seçin…</option>'}
          ${line.candidates.map(c => `<option value="${esc(c.payment_order_id)}" ${c.payment_order_id === secili ? 'selected' : ''}>${esc(c.payment_order_id)} · ${money(c.net_cents)} · ${esc(c.first_date)}${c.difference_cents ? ' · fark ' + money(c.difference_cents) : ''}</option>`).join('')}
        </select>` : '<span class="rb-muted">Aday yok</span>';
    return `<tr><td>${esc(line.occurred_on)}</td>
      <td>${esc(line.description).slice(0, 70)}${line.counterparty ? `<small>${esc(line.counterparty)}</small>` : ''}</td>
      <td class="rb-num">${money(line.amount_cents)}</td>
      <td><span class="rb-chip ${chip}">${etiket}</span></td>
      <td>${secim}<small>${esc(line.note)}</small></td>
      <td>${line.candidates.length ? `<button type="button" class="primary" data-match-act="confirm" data-id="${esc(line.bank_line_id)}">Onayla ve deftere yaz</button>` : ''}</td></tr>`;
  }

  function adayKarti() {
    const d = state.data;
    if (!d || !state.account) return '';
    if (!d.lines.length) return `<section class="v2-card"><h3>Eşleşmeyi bekleyen para girişi yok</h3>
      <p class="rb-muted">Bu hesapta eşleştirilmemiş para girişi bulunmuyor. Yeni ekstre yüklediğinde burada görünür.</p></section>`;
    const bekleyen = d.payment_orders;
    return `<section class="v2-card"><h3>Eşleşmeyi bekleyen para girişleri</h3>
      <p class="help">${num(bekleyen.open)} açık ödeme emri var (${num(bekleyen.matched)} tanesi zaten eşleşti).
        Onayladığın satırın parası ${esc(state.data.providers.find(p => p.id === state.provider)?.name || '')} alacak hesabına girer
        ve aynı anda bu banka hesabına aktarılır. Ana Kasa etkilenmez.</p>
      <div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Tarih</th><th>Ekstre açıklaması</th>
        <th class="rb-num">Tutar</th><th>Durum</th><th>Ödeme emri</th><th>İşlem</th></tr></thead>
        <tbody>${d.lines.map(adayRow).join('')}</tbody></table></div>
      ${d.lines_truncated ? '<p class="rb-muted">İlk 300 hareket gösteriliyor.</p>' : ''}
      ${bekleyen.unusable.length ? `<details><summary>Kullanılamayan ${num(bekleyen.unusable.length)} ödeme emri — sebebiyle</summary>
        <ul class="rb-list">${bekleyen.unusable.map(u => `<li>${esc(u.payment_order_id)} · ${money(u.net_cents)} · ${esc(u.reason)}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  }

  function gecmisKarti() {
    const m = state.list?.matches || [];
    if (!m.length) return '';
    return `<section class="v2-card"><h3>Yazılmış eşleştirmeler</h3>
      <div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>Tarih</th><th>Ödeme emri</th><th>Banka</th>
        <th class="rb-num">Deftere yazılan</th><th class="rb-num">Pazaryeri bildirimi</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>
        ${m.map(x => `<tr><td>${esc(x.occurred_on)}</td><td>${esc(x.payment_order_id)}<small>${esc(x.description).slice(0, 40)}</small></td>
          <td>${esc(x.account_name)}</td><td class="rb-num">${money(x.matched_cents)}</td><td class="rb-num">${money(x.reported_cents)}</td>
          <td>${x.status === 'confirmed' ? '<span class="rb-chip ok">Yazıldı</span>' : `<span class="rb-chip warn">Geri alındı</span><small>${esc(x.reversal_reason)}</small>`}</td>
          <td>${x.status === 'confirmed' ? `<button type="button" class="secondary" data-match-act="reverse" data-id="${esc(x.id)}">Geri al</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="help">Geri alma ters kayıt yazar: ham ekstre satırı ve özgün hareketler defterde kalır, satır yeniden eşleştirilebilir.</p></section>`;
  }

  function render() {
    if (signal.aborted) return;
    prepareWorkflow(root);
    root.innerHTML = '<div class="rb workflow-page">' +
      `<section class="page-heading"><div><span class="eyebrow">E-ticaret / Banka</span><h1>Hakediş–banka eşleştirme</h1>
        <p>Pazaryerinden gelen paranın hangi ekstre satırı olduğunu onayla; kayıt ancak o zaman doğar.</p></div></section>` +
      (state.error ? `<p class="rb-alert error" role="alert">${esc(state.error)}</p>` : '') +
      (state.message ? `<p class="rb-alert ok" role="status">${esc(state.message)}</p>` : '') +
      alacakKarti() + suzgec() + adayKarti() + gecmisKarti() +
      '</div>' + (state.busy ? '<p class="rb-busy" role="status">İşleniyor…</p>' : '');
    root.setAttribute('aria-busy', String(state.busy));
    if (state.busy) for (const control of root.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  }

  /* ---------- işlemler ---------- */
  async function onayla(lineId) {
    const line = state.data.lines.find(l => l.bank_line_id === lineId);
    const order = state.choice.get(lineId) || line?.suggestion?.payment_order_id || '';
    if (!order) throw new Error('Önce hangi ödeme emrine denk geldiğini seçin.');
    let body = {bank_line_id: lineId, provider: state.provider, payment_order_id: order};
    for (let deneme = 0; deneme < 3; deneme++) {
      try {
        const r = await api('', body);
        state.choice.delete(lineId);
        await load();
        say('Hakediş yazıldı: ' + money(r.matched_cents) + ' ' + r.account_name + ' hesabına girdi.' +
          (r.difference_cents ? ' Pazaryeri bildirimiyle arada ' + money(Math.abs(r.difference_cents)) + ' fark vardı; deftere banka tutarı yazıldı.' : '') +
          (r.clearing_account_created ? ' ' + r.clearing_account_name + ' hesabı açıldı.' : ''));
        return;
      } catch (e) {
        const d = e.data || {};
        if (d.code === 'clearing_account_missing' && !body.create_clearing_account) {
          if (!confirm(d.suggested_name + ' hesabı henüz yok.\n\nBu pazaryerinden gelen para önce bu hesapta toplanır, aynı anda banka hesabına aktarılır. Hesap açılsın mı?')) return;
          body = {...body, create_clearing_account: true}; continue;
        }
        if (d.code === 'amount_difference' && !body.accept_difference) {
          if (!confirm('Bankaya giren tutar ' + money(d.matched_cents) + ', pazaryerinin bildirdiği net tutar ' + money(d.reported_cents) +
            '.\nAralarında ' + money(Math.abs(d.difference_cents)) + ' fark var.\n\nDeftere BANKA tutarı yazılacak. Devam edilsin mi?')) return;
          body = {...body, accept_difference: true}; continue;
        }
        throw e;
      }
    }
  }

  async function geriAl(id) {
    const reason = window.prompt('Bu eşleştirme neden geri alınıyor? (Ters kayıtta bu not görünür.)');
    if (reason === null || !reason.trim()) return;
    await api('/' + id + '/reverse', {reason: reason.trim()});
    await load();
    say('Eşleştirme geri alındı. Ham ekstre satırı yerinde duruyor; yeniden eşleştirebilirsin.');
  }

  /* ---------- olaylar ---------- */
  root.addEventListener('change', e => {
    const alan = e.target.dataset.match;
    if (alan === 'account') { state.account = e.target.value; state.choice.clear(); run(load); return; }
    if (alan === 'provider') { state.provider = e.target.value; state.choice.clear(); run(load); return; }
    const secim = e.target.dataset.matchChoice;
    if (secim) state.choice.set(secim, e.target.value);
  });
  root.addEventListener('submit', e => e.preventDefault());
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-match-act]');
    if (!b || state.busy || b.disabled) return;
    if (b.dataset.matchAct === 'confirm') run(() => onayla(b.dataset.id));
    if (b.dataset.matchAct === 'reverse') run(() => geriAl(b.dataset.id));
  });

  run(load);
  return () => { root.removeAttribute('aria-busy'); controller.abort(); };
}
