import {can} from './permissions.js';
import {isISODate} from './date-range.js';
import {prepareWorkflow} from './product-list.js';
import {renderPriceDecision} from './price-decision-ui.js';
import {bandLabel} from './rate-bands.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money = value => value === null || value === undefined ? 'Bilgi eksik' : new Intl.NumberFormat('tr-TR', {style:'currency', currency:'TRY'}).format(value / 100);
const number = value => new Intl.NumberFormat('tr-TR', {maximumFractionDigits:3}).format(value);
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone:'Europe/Istanbul'});
const reference = prefix => prefix + '-' + crypto.randomUUID().slice(0, 12);
const channels = [['trendyol','Trendyol'],['hepsiburada','Hepsiburada'],['other','Diğer']];
const channelName = value => channels.find(([key]) => key === value)?.[1] || value;
const kindNames = {supplier:'Tedarikçi', customer:'Müşteri', marketplace:'Pazaryeri', other:'Diğer'};
const sourceNames = {manual:'Elle kayıt', opening:'Açılış', cash:'Kasa / banka', reversal:'Düzeltme', purchase:'Alış faturası', invoice:'Alış faturası', sale:'Satış', payment:'Ödeme', legacy_payment:'Ödeme', return:'İade'};
// Ödemeyi nasıl yaptığın sorulur; hangi bankadan olduğu serbest nottur, listeden seçilmez.
const methodNames = {nakit:'Nakit', kart:'Kart', havale:'Havale / EFT', cek:'Çek'};
// Satır içinde okunan kısa rozet. Uzun ad yalnızca ödeme penceresinde kullanılır.
const methodBadges = {nakit:'Nakit', kart:'Kart', havale:'Havale-EFT', cek:'Çek'};
const payStatus = row => row.status === 'partial' ? badge('Kısmi · kalan ' + money(row.remaining_cents),'warning') : badge('Açık');
const gun = value => { const [y,m,d] = String(value ?? '').split('-'); return d ? `${d}.${m}.${y}` : ''; };
const kisalt = (value, max = 32) => { const text = String(value ?? '').trim(); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
// Bilinmeyen sıfır değildir: toplamda tek bir gizli tutar varsa toplam da gizlenir.
const toplam = (rows, pick) => rows.some(row => pick(row) === null || pick(row) === undefined) ? null : rows.reduce((sum, row) => sum + pick(row), 0);
const artisi = value => value === null || value === undefined ? null : Math.max(0, value);

/** Ödemenin kısa yöntem rozeti. Bilinmeyen yöntem uydurulmaz. */
export function odemeRozeti(method) { return methodBadges[method] || ''; }

/** Hareket satırındaki ödeme ayrıntısı: yöntem · serbest not · çekse vade. */
export function odemeAyrintisi(entry) {
  if (!entry || !entry.payment_method) return '';
  const parts = [odemeRozeti(entry.payment_method) || 'Ödeme'];
  if (entry.payment_note) parts.push(kisalt(entry.payment_note, 40));
  if (entry.payment_due_on) parts.push('vade ' + gun(entry.payment_due_on));
  return parts.join(' · ');
}

/**
 * Ödemenin kapattığı faturalar: numara + o faturaya yazılan tutar. Tutar gizliyse numara yine görünür.
 * Satır dar ekranda taşmasın diye ilk üç fatura yazılır, kalanı sayıyla anılır; hiçbiri gizlenmez.
 */
export function kapatilanFaturalar(entry) {
  const rows = entry?.closed_invoices || [];
  if (!rows.length) return '';
  const shown = rows.slice(0, 3), rest = rows.length - shown.length;
  return 'Kapattığı fatura: ' + shown.map(row => {
    const no = row.invoice_no || 'Belge';
    return row.amount_cents === null || row.amount_cents === undefined ? no : `${no} ${money(row.amount_cents)}`;
  }).join(' · ') + (rest > 0 ? ` ve ${rest} fatura daha` : '');
}

/** Borç satırının ödeme durumu. Ödeme yoksa ya da tutar gizliyse hiçbir şey uydurulmaz. */
export function borcDurumu(entry) {
  if (!entry || !(entry.amount_cents < 0) || !entry.paid_cents) return '';
  return 'Ödenen ' + money(entry.paid_cents) + ' · kalan ' + money(entry.remaining_cents);
}

/** "Bunu şu tarihte ödeyeceğim" notu. */
export function planMetni(entry) { return entry?.planned_on ? 'Ödeyeceğim: ' + gun(entry.planned_on) : ''; }

/** Cari kartındaki son ödeme: "12.09.2026 · Kart · Garanti Bonus". Ödeme yoksa açıkça söylenir. */
export function sonOdemeMetni(party) {
  const payment = party?.last_payment;
  if (!payment || !payment.occurred_on) return 'Ödeme yok';
  const parts = [gun(payment.occurred_on), odemeRozeti(payment.method) || 'Ödeme'];
  if (payment.note) parts.push(kisalt(payment.note));
  return parts.join(' · ');
}
const humanize = message => String(message).replace(/vat_bps|withholding_bps|replacement_cost_cents|packaging_cents|other_cents|length_mm|width_mm|height_mm|weight_grams|units_per_parcel/g, key => ({vat_bps:'KDV oranı',withholding_bps:'Stopaj oranı',replacement_cost_cents:'Ürün maliyeti',packaging_cents:'Ambalaj gideri',other_cents:'Diğer giderler',length_mm:'Paket uzunluğu',width_mm:'Paket genişliği',height_mm:'Paket yüksekliği',weight_grams:'Paket ağırlığı',units_per_parcel:'Paketteki ürün adedi'}[key]));
const input = (label, name, value = '', type = 'text', extra = '') => `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const amount = (label, name, value = '', required = true) => input(label, name, value, 'number', `min="0" max="100000000" step="0.01" ${required ? 'required' : ''}`);
const select = (label, name, options, value = '', required = true) => `<label>${esc(label)}<select name="${esc(name)}" ${required ? 'required' : ''}>${options.map(([key,title]) => `<option value="${esc(key)}" ${String(key) === String(value) ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></label>`;
const choose = (label, name, options, value = '') => select(label, name, [['','Seçin…'], ...options], value);
const textArea = (label, name, value = '', required = true) => `<label>${esc(label)}<textarea name="${esc(name)}" rows="3" maxlength="2000" ${required ? 'required' : ''}>${esc(value)}</textarea></label>`;
const button = (label, action, id = '', secondary = false) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-business="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
const badge = (label, type = 'neutral') => `<span class="v2-badge ${type}">${esc(label)}</span>`;
const table = (headers, rows, emptyTitle = 'Henüz kayıt yok.', emptyText = 'Eklediğiniz kayıtlar burada görünecek.') => rows.length ? `<div class="table-wrap"><table class="v2-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="v2-empty"><h3>${esc(emptyTitle)}</h3><p>${esc(emptyText)}</p></div>`;
const card = (title, content, action = '') => `<section class="v2-card"><div class="v2-card-head"><h2>${esc(title)}</h2>${action}</div>${content}</section>`;
const stat = (label, value, note, highlight = false) => `<article class="v2-stat ${highlight ? 'highlight' : ''}"><span class="v2-stat-label">${esc(label)}</span><strong class="v2-stat-value">${esc(value)}</strong><small>${esc(note)}</small></article>`;
const scaled = (value, factor, name, optional = false) => {
  if (value === '' || value === undefined || value === null) { if (optional) return null; throw new Error(name + ' alanını doldurun.'); }
  const parsed = Number(value), result = Math.round(parsed * factor);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(result) || parsed < 0 || Math.abs(parsed * factor - result) > 0.00001) throw new Error(name + ' alanındaki sayı geçersiz.');
  return result;
};
const divided = (value, factor) => value === null || value === undefined ? '' : value / factor;

/** A separate mounted view; all reads and writes stay in the authenticated workspace. */
export function mountBusiness(root, namespace, view, user = null) {
  if (!['ec','lp'].includes(namespace) || !['pricing','ledger'].includes(view)) throw new Error('Çalışma alanı veya ekran geçersiz.');
  const canReceivables = namespace === 'ec' && (user?.owner || (can(user, 'ec', 'ledger') && can(user, 'ec', 'orders')));
  const incomingDates=new URLSearchParams(location.hash.split('?')[1]||'');
  const from=incomingDates.get('from')||'',to=incomingDates.get('to')||'';
  const validDates=(!from||isISODate(from))&&(!to||isISODate(to))&&(!from||!to||from<=to);
  const controller = new AbortController();
  // Alış faturası ekranındaki "Ödeme gir" buraya yönlendirir: #ledger?tab=odemeler&party=…&invoice=…
  const incomingTab = incomingDates.get('tab') || '';
  const ledgerTab = incomingTab === 'receivables' && canReceivables ? 'receivables'
    : ['odemeler','entries','cash','allocations','statement'].includes(incomingTab) ? incomingTab : 'parties';
  const safeId = value => /^[\w:.-]{1,120}$/.test(value || '') ? value : '';
  const incomingParty = view === 'ledger' ? safeId(incomingDates.get('party')) : '';
  const incomingInvoice = view === 'ledger' ? safeId(incomingDates.get('invoice')) : '';
  const state = { partyKind: '', ledgerQuery: '', ledgerFrom: validDates?from:'', ledgerTo: validDates?to:'', ledgerDue: '', ledgerKind: '', ledgerPage: 1, entryPagination: null,data:null, tab:view === 'pricing' ? 'hizli' : ledgerTab, party:incomingParty, search:'', quote:null, quoteInput:{channel:'trendyol',desired_profit:0,max_price:10000}, selected:new Set(), payParty:'', pendingInvoice:incomingInvoice, disposed:false, sequence:0};
  const $ = selector => root.querySelector(selector);
  const api = async (path = '', body) => {
    const response = await fetch(`/api/${namespace}/${view}${path}`, {signal:controller.signal, ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})});
    let data; try { data = await response.json(); } catch { throw new Error('Sunucuya ulaşılamadı. Lütfen yeniden deneyin.'); }
    if (!response.ok) throw new Error(humanize(data.error || 'İşlem tamamlanamadı.'));
    return data;
  };
  function showError(message) { const box = $('[data-business-error]'); if (box) { box.hidden = false; box.textContent = message; } }
  function closeDialog() { const node = $('dialog[data-business-dialog]'); node?.close(); node?.remove(); }
  function dialog(title, form, body, context = '', submit = 'Kaydet') {
    closeDialog();
    root.insertAdjacentHTML('beforeend', `<dialog data-business-dialog class="workflow-dialog" aria-label="${esc(title)}"><form class="v2-form" data-business-form="${form}" data-context="${esc(context)}"><div class="dialog-heading"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-business="close" aria-label="Kapat">×</button></div><div class="form-body">${body}<p class="error" data-business-form-error role="alert"></p></div><div class="dialog-footer">${button('Vazgeç','close','',true)}<button class="primary" type="submit">${esc(submit)}</button></div></form></dialog>`);
    prepareWorkflow(root);$('dialog[data-business-dialog]').showModal();
  }
  async function load() {
    const sequence = ++state.sequence;
    let query = '';
    if (view === 'ledger') {
      const p = new URLSearchParams();
      if (state.party) p.set('party_id', state.party);
      if (state.ledgerQuery) p.set('q', state.ledgerQuery);
      if (state.ledgerFrom) p.set('from', state.ledgerFrom);
      if (state.ledgerTo) p.set('to', state.ledgerTo);
      if (state.ledgerDue) p.set('due', state.ledgerDue);
      if (state.ledgerKind) p.set('kind', state.ledgerKind);
      if (state.ledgerPage > 1) p.set('page', String(state.ledgerPage));
      query = p.toString() ? '?' + p : '';
    }
    const result = await api(query);
    if (state.disposed || sequence !== state.sequence || !root.isConnected) return;
    state.entryPagination = result.entry_pagination || null; state.data = result;
    // Ekranda kalmayan fatura seçili sayılmaz: ödenen ya da düzeltilen satır listeden düşer.
    const live = new Set((result.open_invoices || []).map(row => row.entry_id));
    for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
    if (state.pendingInvoice) {
      const row = (result.open_invoices || []).find(x => x.invoice_id === state.pendingInvoice);
      if (row) { state.selected.add(row.entry_id); state.payParty = row.party_id; }
      state.pendingInvoice = '';
    }
    if (!state.selected.size) state.payParty = '';
    render();
  }
  function render() {
    prepareWorkflow(root);
    if (state.disposed || !state.data) return;
    const title = view === 'pricing' ? 'Fiyat ve kâr planı' : 'Cari hesaplar';
    const subtitle = view === 'pricing' ? 'Satmadan önce hesabını gör. Ürün, paket ve geçerli tarifelerle fiyatını belirle.' : 'Kimden alacağın var, kime borçlusun? Belgeleri ve ödemeleri aynı hesapta takip et.';
    const tabs = view === 'pricing' ? [['hizli','Kaça satmalıyım?'],['quote','Tarifeyle hesapla'],['profiles','Ürün ve paket'],['tariffs','Komisyon ve kargo']] : [['parties','Cariler'],['odemeler','Fatura ödemeleri'],['entries','Hesap hareketleri'],['cash','Kasa ve banka'],['allocations','Belge kapamaları'],['statement','Mutabakat'],...(canReceivables ? [['receivables','Raporlardan hakediş']] : [])];
    root.innerHTML = `<div class="v2-page workflow-page"><div class="page-heading"><div><span class="eyebrow">${namespace === 'ec' ? 'E-TİCARET' : 'LUNAPOT'} ÇALIŞMA ALANI</span><h1>${title}</h1><p>${subtitle}</p></div>${view === 'ledger' ? `<div class="ac-actions">${button('Tahsilat / ödeme','cash')}${button('Cari ekle','party','',true)}</div>` : ''}</div><div class="notice" data-business-error role="alert" hidden></div><nav class="v2-tabs" aria-label="${title}">${tabs.map(([key,label]) => `<button type="button" data-business="tab" data-id="${key}" class="${state.tab === key ? 'active' : ''}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav><section data-business-body></section></div>`;
    // Mutabakat kendi modulunde durur; sekme degisince onceki baglanti birakilir.
    if (state.statementDispose) { state.statementDispose(); state.statementDispose = null; }
    const body = $('[data-business-body]');
    if (view === 'ledger' && state.tab === 'statement') mountStatementTab(body);
    else if (view === 'ledger' && canReceivables && state.tab === 'receivables') mountReceivablesTab(body);
    else if (view === 'pricing' && state.tab === 'hizli') mountHizliTab(body);
    else body.innerHTML = view === 'pricing' ? pricingView() : ledgerView();
  }
  async function mountReceivablesTab(body) {
    body.innerHTML = '<div class="loading">Rapor bildirimleri yükleniyor…</div>';
    try {
      const {mountMarketplaceReceivables} = await import('./marketplace-receivables-ui.js');
      if (state.disposed || !body.isConnected) return;
      state.statementDispose = mountMarketplaceReceivables(body, namespace);
    } catch (e) {
      if (!state.disposed && body.isConnected) body.innerHTML = `<div class="v2-empty"><h3>Rapor bildirimleri yüklenemedi.</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  // Kaça satmalıyım: geçmiş teslimlerin gerçek kesintileriyle hızlı hesap (fiyat-hesap-ui.js).
  async function mountHizliTab(body) {
    body.innerHTML = '<div class="loading">Hesap ekranı yükleniyor…</div>';
    try {
      const {mountFiyatHesap} = await import('./fiyat-hesap-ui.js');
      if (state.disposed || !body.isConnected) return;
      state.statementDispose = mountFiyatHesap(body, state.data.products || []);
    } catch (e) {
      if (!state.disposed && body.isConnected) body.innerHTML = `<div class="v2-empty"><h3>Hesap ekranı yüklenemedi.</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  // Belge motoru ve yazi tipi yalnizca bu sekme acildiginda indirilir.
  async function mountStatementTab(body) {
    body.innerHTML = '<div class="loading">Mutabakat ekranı yükleniyor…</div>';
    try {
      const {mountStatement} = await import('./statement-ui.js');
      if (state.disposed || !body.isConnected) return;
      body.innerHTML = '';
      state.statementDispose = mountStatement(body, namespace, state.data.parties);
    } catch (e) {
      if (!state.disposed && body.isConnected) body.innerHTML = `<div class="v2-empty"><h3>Mutabakat ekranı yüklenemedi.</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  const productOptions = () => state.data.products.map(p => [p.id, `${p.name} · ${p.sku}`]);
  // Faturasız mal girişinin ürün satırı. Aynı adlar tekrarlanır; gönderirken FormData.getAll ile okunur.
  // FATURASIZ GİRİŞ SATIRI. Ürün 37 kalemlik açılır listeden tek tek seçilmiyor; kutuya yazılıp
  // datalist ile süzülerek seçiliyor. Gönderirken metin ürün kimliğine çevrilir.
  const proAd = x => x.name + " · " + x.sku;
  const provisionalRow = (v = {}) => { const rid = "r" + Math.random().toString(36).slice(2, 9); return "<div class=\"pro-row\" data-provisional-row=\"" + rid + "\">"
   + "<label class=\"pro-urun\">Ürün<input list=\"pro-urun-listesi\" name=\"urun_metin\" value=\"" + esc(v.urun || "") + "\" required autocomplete=\"off\" placeholder=\"Yazarak ara: orkide…\"></label>"
   + "<label class=\"pro-adet\">Adet<input name=\"quantity\" type=\"number\" value=\"" + esc(v.adet || "") + "\" required min=\"0.001\" max=\"1000000\" step=\"0.001\"></label>"
   + "<label class=\"pro-maliyet\">Birim · KDV hariç<input name=\"unit_cost\" type=\"number\" value=\"" + esc(v.maliyet || "") + "\" required min=\"0\" max=\"100000000\" step=\"0.01\"></label>"
   + "<label class=\"pro-kdv\">KDV %<input name=\"vat\" type=\"number\" value=\"" + esc(v.kdv === undefined ? 20 : v.kdv) + "\" required min=\"0\" max=\"100\" step=\"0.01\"></label>"
   + "<button type=\"button\" class=\"secondary pro-sil\" data-business=\"provisional-remove\" data-id=\"" + rid + "\" title=\"Satırı sil\" aria-label=\"Satırı sil\">×</button>"
   + "</div>"; };
  // TASLAK KORUMA. 10 satır doldurup pencere yanlışlıkla kapanınca hepsi gidiyordu. Yazdıkça
  // tarayıcıya kaydedilir, pencere yeniden açılınca geri yüklenir, kayıt başarılı olunca silinir.
  const PRO_TASLAK = "lunapot:faturasiz-mal-girisi";
  const proTaslakOku = () => { try { const v = localStorage.getItem(PRO_TASLAK); return v ? JSON.parse(v) : null; } catch { return null; } };
  const proTaslakYaz = d => { try { localStorage.setItem(PRO_TASLAK, JSON.stringify(d)); } catch {} };
  const proTaslakSil = () => { try { localStorage.removeItem(PRO_TASLAK); } catch {} };
  function proTaslakTopla(form) {
   const d = new FormData(form), satirlar = [];
   const m = d.getAll("urun_metin"), q = d.getAll("quantity"), c = d.getAll("unit_cost"), v = d.getAll("vat");
   m.forEach((t, i) => satirlar.push({urun: t, adet: q[i], maliyet: c[i], kdv: v[i]}));
   return {supplier_id: d.get("supplier_id"), occurred_on: d.get("occurred_on"), reference: d.get("reference"), notes: d.get("notes"), satirlar};
  }
  const partyOptions = () => state.data.parties.map(p => [p.id, p.name]);
  const accountOptions = () => state.data.accounts.map(p => [p.id, `${p.name} · ${p.kind === 'bank' ? 'Banka' : 'Kasa'}`]);

  function pricingView() {
    const d = state.data;
    if (state.tab === 'profiles') return `<div class="workflow-section-heading"><div><h2>Ürün ve paket bilgilerini tamamla</h2><details class="workflow-details"><summary>Maliyet ve ölçülerin kapsamı</summary><p>Ürün maliyeti bir adet içindir. Ölçü, ağırlık ve ambalaj gideri hazırladığın paketin tamamına aittir. Bilmediğin maliyet veya vergi oranına sıfır yazma.</p></details></div>${button('Ürün bilgisi ekle','profile')}</div>` + card('Ürün ve paket bilgileri', table(['Ürün','Birim maliyet · KDV dahil','Paket','Ağırlık / ölçü','Ürün KDV','İşlem'], d.products.map(p => {
      const f = d.profiles.find(x => x.product_id === p.id);
      return [`<strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small>`, f ? (f.replacement_cost_cents === null || f.replacement_cost_cents === undefined ? badge('Alış kaydı yok','warning') : money(Math.round(f.replacement_cost_cents * (10000 + (f.vat_bps || 0)) / 10000)) + `<small>${{manual:'elle girildi',last_purchase:'son alış faturasından',stock:'stok maliyetinden'}[f.cost_source] || ''}</small>`) : badge('Bilgi gerekli','warning'), f ? `${number(f.units_per_parcel)} adet / paket` : '—', f ? `${number(f.weight_grams / 1000)} kg<small>${number(f.length_mm / 10)} × ${number(f.width_mm / 10)} × ${number(f.height_mm / 10)} cm</small>` : '—', f ? `%${number(f.vat_bps / 100)}` : '—', button(f ? 'Düzenle' : 'Bilgileri tamamla','profile',p.id,true)];
    }), 'Önce ürün ekleyin.', namespace === 'ec' ? 'Stok ekranından ürün ekledikten sonra paket ve maliyet bilgilerini burada tamamlayabilirsiniz.' : 'Ürünler ekranından bir ürün ekleyin.'));
    if (state.tab === 'tariffs') return `<div class="notice subtle">Tarifeler tarih aralığıyla saklanır. Haftalık koşullar değiştiğinde yeni tarife ekleyin; yanlış kaydı arşivleyin. Aynı koşullarda çakışan tarifeler varsa hesap durur.</div><div class="v2-grid cols-2">${stat('Komisyon tarifesi', number(d.commissionRates.filter(x => !x.archived_at).length), 'Arşivlenmemiş tarife')}${stat('Kargo tarifesi', number(d.shippingRates.filter(x => !x.archived_at).length), 'Arşivlenmemiş tarife')}</div>` + card('Komisyon tarifeleri', table(['Tarife / kaynak','Kanal / ürün','Geçerlilik','Fiyat aralığı · KDV dahil','Komisyon','Durum / işlem'], d.commissionRates.map(r => [tariffName(r), `${esc(channelName(r.channel))}<small>${esc(r.sku || r.category || 'Tüm ürünler')}</small>`, `${esc(r.valid_from)} → ${esc(r.valid_to)}`, tariffRange(r), `%${number(r.rate_bps / 100)}<small>${r.base === 'gross' ? 'KDV dahil' : 'KDV hariç'} satış üzerinden · ücret KDV ${r.tax_included ? 'dahil' : 'hariç'}</small>`, tariffAction(r,'commissions')])), button('Komisyon tarifesi ekle','commission')) + `<div class="breakdown">` + card('Kargo tarifeleri', table(['Tarife / kaynak','Kanal / kargo','Geçerlilik','Fiyat / desi aralığı','Ücret','Durum / işlem'], d.shippingRates.map(r => [tariffName(r), `${esc(channelName(r.channel))}<small>${esc(r.carrier)}</small>`, `${esc(r.valid_from)} → ${esc(r.valid_to)}`, `${tariffRange(r)}<small>${number(r.billable_min_milli / 1000)} – ${r.billable_max_milli === null ? 'üst sınır yok' : number(r.billable_max_milli / 1000) + ' hariç'} desi/kg</small>`, `${money(r.amount_cents)}<small>KDV ${r.tax_included ? 'dahil' : 'hariç'} · %${number(r.vat_bps / 100)}</small>`, tariffAction(r,'shipping')]), 'Komisyon tarifesi tanımlı değil.', 'Tarife olmadan “satmadan önce kârım ne olur” hesaplanamaz; sistem yalnızca olan biteni ölçer. Pazaryeri komisyon oranını fiyat aralığıyla ekleyin.'), button('Kargo tarifesi ekle','shipping')) + '</div>';
    const f = state.quoteInput, carriers = [...new Set(d.shippingRates.filter(r => !r.archived_at).map(r => r.carrier))];
    return `<div class="v2-grid cols-2">${card('Satışını planla', `<form class="v2-form v2-card-body" data-business-form="quote">${choose('Ürün','product_id',productOptions(),f.product_id)}<div class="field-grid">${choose('Satış kanalı','channel',channels,f.channel)}${choose('Kargo şirketi','carrier',carriers.map(x => [x,x]),f.carrier)}</div><div class="field-grid">${amount('Paketin toplam satış fiyatı · KDV dahil (TL)','price',f.price ?? '')}${input('Paketteki ürün adedi','quantity',f.quantity ?? '', 'number','required min="1" max="1000000" step="1"')}${amount('Paket için hedef kâr · KDV hariç (TL)','desired_profit',f.desired_profit ?? '')}</div><details class="quote-advanced"><summary>Tarih ve arama sınırı</summary><div class="field-grid">${amount('Aranacak en yüksek paket fiyatı (TL)','max_price',f.max_price ?? 10000)}${input('Hesap tarihi','date',f.date || today(),'date','required')}</div></details><p class="help">Adet, ürün profilindeki paketle aynı olmalı. Hedef kâr 0 ise başabaş fiyatı aranır. Bütün fiyat aralıklarında tarifelerin tamamlanmış olması gerekir.</p><p class="error" data-business-form-error role="alert"></p><button class="primary" type="submit">Kârı ve alt fiyat sınırını hesapla</button></form>`)}${card('Satışın sana ne bırakıyor?', '<div data-quote-result tabindex="-1" aria-label="Fiyat hesabı sonucu">'+quoteResult()+'</div>')}</div><div class="notice subtle">Bu hesap tahmindir. Gerçek kesintiler geldiğinde kontrol edilir. Sabit işletme giderleri, gelir/kurumlar vergisi ve sonradan oluşan iadeler katkı kârına dahil değildir.</div>`;
  }
  function tariffName(r) { return `<strong>${esc(r.label)}</strong><small>${esc(r.source)}</small>`; }
  // Ust sinir haric oldugu icin aralik bir kurus asagisiyla yazilir: 200,00 siniri 199,99'a kadar demektir.
  function tariffRange(r) { return bandLabel(r); }
  function tariffAction(r, type) { return r.archived_at ? badge('Arşivde') : badge(r.valid_to < today() ? 'Süresi doldu' : r.valid_from > today() ? 'İleri tarihli' : 'Geçerli', r.valid_to < today() ? 'neutral' : 'success') + `<br>${button('Arşivle','archive',type + ':' + r.id,true)}`; }
  function quoteResult() {
    if (!state.quote) return '<div class="v2-empty"><h3>Karar vermeden önce hesapla.</h3><p>Ürününü ve satış koşullarını seç. Tahmini kârı, hakedişi ve hedefin için gerekli en düşük fiyatı burada göreceksin.</p></div>';
    const {quote:q,floor:f} = state.quote;
    const missing = [...new Set([...(q.missing || []), ...(f.missing || [])].map(humanize))];
    if (q.status !== 'estimated') return `<div class="v2-card-body"><span class="v2-badge warning">Bilgiler tamamlanmalı</span><h3>Şu an güvenilir bir hesap yapılamıyor.</h3><ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul><p class="help">Ürün ve paket bilgilerini, tarihleri ve bu fiyata uygun tarifeleri kontrol et.</p></div>`;
    // KDV DAHİL NAKİT GÖRÜNÜM. Kullanıcı ödediği ve tahsil ettiği parayı görür: satış fiyatı KDV
    // dahildir, ürün maliyeti ve kesintiler de KDV dahil yazılır. Ürün KDV oranı profilden gelir.
    // KDV hariç katkı yalnızca vergi beyanı için altta küçük durur.
    const profile = (state.data?.profiles || []).find(x => x.product_id === state.quoteInput?.product_id) || {};
    const v = Number.isFinite(profile.vat_bps) ? profile.vat_bps : null;
    const inc = x => x === null || x === undefined ? null : v === null ? x : Math.round(x * (10000 + v) / 10000);
    const costSource = {manual:'elle girilen', last_purchase:'son alış faturasından', stock:'stok maliyetinden'}[profile.cost_source] || '';
    const cash = [q.price_cents, -inc(q.cost_net_cents), -inc(q.packaging_net_cents), -q.commission_gross_cents, -q.shipping_gross_cents, -inc(q.other_net_cents), -(q.withholding_cents || 0)];
    const nakit = cash.every(x => Number.isFinite(x)) ? cash.reduce((a, b) => a + b, 0) : null;
    const lines = [['Satış · KDV dahil',q.price_cents],['Ürün maliyeti · KDV dahil'+(costSource?' ('+costSource+')':''),inc(q.cost_net_cents)],['Ambalaj · KDV dahil',inc(q.packaging_net_cents)],['Komisyon · KDV dahil',q.commission_gross_cents],['Kargo · KDV dahil',q.shipping_gross_cents],['Diğer satış gideri · KDV dahil',inc(q.other_net_cents)],...(q.withholding_cents?[['Stopaj · yıllık vergiden mahsup',q.withholding_cents]]:[])];
    const desired = Math.round(Number(state.quoteInput.desired_profit) * 100);
    const targetWarning = q.estimated_profit_cents < desired ? `<div class="notice"><strong>Seçtiğin satış fiyatı hedef kârını sağlamıyor.</strong><br>Hedef ${money(desired)}, bu fiyattaki tahmini katkı ${money(q.estimated_profit_cents)}. Kargo veya komisyon baremi değiştiğinde daha yüksek fiyat bile daha düşük kâr bırakabilir.</div>` : '';
    return `<div class="v2-card-body">${badge(q.estimated_profit_cents < 0 ? 'Bu fiyatta zarar görünüyor' : 'Bu fiyatta cebine kalan',q.estimated_profit_cents < 0 ? 'danger' : 'success')}<strong class="v2-stat-value">${money(nakit ?? q.estimated_profit_cents)}</strong><p class="help">KDV dahil nakit: satış fiyatından ürünün KDV dahil maliyeti ve KDV dahil kesintiler düşüldü. Vergi beyanı için KDV hariç katkı: ${money(q.estimated_profit_cents)} · Kargo hesabı: ${number(q.billable_milli / 1000)} desi/kg</p>${targetWarning}${lines.map(([label,value]) => `<div class="v2-summary-line"><span>${label}</span><strong>${money(value)}</strong></div>`).join('')}${renderPriceDecision(state.quote)}<div class="v2-summary-line total"><span>Tahmini hakediş</span><strong>${money(q.estimated_payout_cents)}</strong></div><p class="help">Bu ön hakediş yalnızca tanımlı komisyon, kargo ve stopajı düşer. Diğer pazaryeri hizmet kesintileri ayrıca doğrulanır; ürün ve ambalaj maliyeti nakit hakedişinden düşülmez. ${money(q.withholding_cents)} stopaj nakit kesintisi olarak ayrı hesaplandı.</p>${f.status === 'found' ? `<div class="notice ${q.price_cents < f.price_cents ? '' : 'subtle'}"><strong>Hedef kâr için ${money(f.price_cents)} altında satma.</strong><br>Bu tutar paketin KDV dahil en düşük uygun toplam satış fiyatıdır. Her daha yüksek fiyatın aynı hedefi sağlayacağı garanti değildir; barem değişiminde yeniden hesapla.</div>` : `<div class="notice"><strong>${f.status === 'impossible' ? 'Seçtiğin aralıkta hedef kâra ulaşılamıyor.' : 'Güvenilir alt fiyat sınırı henüz bulunamadı.'}</strong>${missing.length ? `<ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p>Üst sınırı veya hedef kârı gözden geçir.</p>'}</div>`}<details><summary>Hesapta kullanılan tarifeler</summary><p class="help">Komisyon: ${esc(state.data.commissionRates.find(r => r.id === q.commission_rate_id)?.label || '—')}<br>Kargo: ${esc(state.data.shippingRates.find(r => r.id === q.shipping_rate_id)?.label || '—')}</p></details></div>`;
  }

  // Sunucu sayfalamasi: eski hareketler 500 sinirinin ardinda kalmaz.
  function ledgerPager() {
    const p = state.entryPagination;
    if (!p || p.pages <= 1) return '';
    const back = p.page > 1 ? '' : ' disabled';
    const next = p.has_more ? '' : ' disabled';
    return `<span class="ledger-pager"><button type="button" class="secondary" data-business="page" data-context="-1"${back}>← Önceki</button><span class="muted">Sayfa ${p.page} / ${p.pages}</span><button type="button" class="secondary" data-business="page" data-context="1"${next}>Sonraki →</button></span>`;
  }
  // payments: "Yalnızca ödemeler" kutusu. Süzme sunucudadır; yoksa sayfanın dışında kalan ödemeler görünmezdi.
  function ledgerFilter(payments = false) {
    const page = state.entryPagination;
    const scope = page ? `${page.total} hareket bulundu · sayfa ${page.page}/${page.pages}` : (state.party ? 'Seçili carinin hesap hareketleri' : 'Bu çalışma alanındaki kayıtlar');
    return `<form class="v2-toolbar ledger-filters" data-business-form="filter">${select('Cari hesabı seç','party_id',[['','Tüm cariler'],...partyOptions()],state.party,false)}` +
      `<label>Referans, açıklama veya cari<input name="q" value="${esc(state.ledgerQuery || '')}" maxlength="200" placeholder="Tüm geçmişte ara"></label>` +
      `<label>Başlangıç<input name="from" type="date" value="${esc(state.ledgerFrom || '')}"></label>` +
      `<label>Bitiş<input name="to" type="date" value="${esc(state.ledgerTo || '')}"></label>` +
      `${select('Vade','due',[['','Tümü'],['overdue','Vadesi geçenler'],['upcoming','Vadesi gelecekler']],state.ledgerDue || '',false)}` +
      (payments ? `<label class="ledger-only-pay"><input type="checkbox" name="kind" value="payments" ${state.ledgerKind === 'payments' ? 'checked' : ''}> Yalnızca ödemeler</label>` : '') +
      `<button class="secondary" type="submit">Göster</button><span class="muted">${esc(scope)}</span></form>`;
  }
  // Fatura ödemeleri: açık alış faturaları, toplu ödeme, verilen çekler ve planlanan ödeme tarihleri.
  // Ödeme için kasa/banka hesabı seçmek gerekmez; nasıl ödediğin ve serbest notun yeterlidir.
  function paymentsView() {
    const d = state.data, open = d.open_invoices || [], cheques = d.cheques || [], due = d.due_soon || [];
    const toplam = open.reduce((sum, row) => sum + (row.remaining_cents || 0), 0);
    const cekToplam = cheques.reduce((sum, row) => sum + (row.amount_cents || 0), 0);
    const secili = open.filter(row => state.selected.has(row.entry_id));
    const seciliToplam = secili.reduce((sum, row) => sum + (row.remaining_cents || 0), 0);
    const suppliers = [...new Map(open.map(row => [row.party_id, row.party_name])).entries()].slice(0, 30);
    const filtre = `<form class="v2-toolbar" data-business-form="pay-filter">${select('Cari hesabı','party_id',[['','Tüm cariler'],...partyOptions()],state.party,false)}<button class="secondary" type="submit">Listele</button>${button('Eksik fatura borçlarını tamamla','invoice-debts','',true)+button('Faturasız mal girişi','provisional','',true)}</form>`;
    const bilgi = '<div class="notice subtle">Muhasebeleşen her alış faturası cari borcu oluşturur. Eski faturaların borcu görünmüyorsa “Eksik fatura borçlarını tamamla”ya bas: yalnızca eksik olanlar yazılır, var olan kayda dokunulmaz, taslak fatura işlenmez.</div>';
    const gruplar = suppliers.map(([id, name]) => {
      const rows = open.filter(row => row.party_id === id);
      const borc = rows.reduce((sum, row) => sum + (row.remaining_cents || 0), 0);
      const seciliSayi = rows.filter(row => state.selected.has(row.entry_id)).length;
      const actions = `<div class="ac-actions">${button(seciliSayi === rows.length ? 'Seçimi kaldır' : 'Tümünü seç · ' + rows.length + ' fatura','pay-all',id,true)}${seciliSayi ? button('Seçilenleri öde · ' + seciliSayi,'pay-open',id) : ''}</div>`;
      return card(name + ' · borcum ' + money(borc), table(['Fatura','Tarih / planlanan ödeme','Toplam · KDV dahil','Kalan','İşlem'], rows.map(row => [
        `<label class="pay-pick"><input type="checkbox" data-pay-pick="${esc(row.entry_id)}" data-party="${esc(row.party_id)}" ${state.selected.has(row.entry_id) ? 'checked' : ''} aria-label="${esc(row.invoice_no)} faturasını seç"> <strong>${esc(row.invoice_no)}</strong></label>`,
        `${esc(row.occurred_on)}<small>${row.planned_on ? 'Ödeyeceğim: ' + esc(row.planned_on) : 'Planlanan ödeme yok'}</small>`,
        `${money(row.debt_cents)}<small>Ödenen ${money(row.paid_cents)}</small>`,
        `<strong>${money(row.remaining_cents)}</strong><small>KDV dahil</small>`,
        `${payStatus(row)} ${button('Öde','pay-one',row.entry_id,true)} ${button(row.planned_on ? 'Tarihi değiştir' : 'Ay sonunda öderim','plan',row.entry_id,true)}`
      ]), 'Bu carinin açık faturası yok.','Ödenmemiş alış faturası kalmadı.'), actions);
    }).join('');
    const bos = `<div class="v2-empty"><h3>Açık alış faturan yok.</h3><p>Muhasebeleşmiş ve ödenmemiş fatura bulunmuyor. Eski faturaların borcu hiç görünmüyorsa “Eksik fatura borçlarını tamamla”yı çalıştır.</p></div>`;
    const cekKart = card('Verilen çekler · vade', table(['Vade','Cari','Tutar · KDV dahil','Çek notu'], cheques.map(row => [
      `<strong>${esc(row.due_on || '—')}</strong><small>${row.due_on && row.due_on < today() ? 'Vadesi geçti' : 'Bekliyor'}</small>`,
      `${esc(row.party_name)}<small>${esc(row.occurred_on)} tarihinde verildi</small>`, money(row.amount_cents), esc(row.note || '—')
    ]), 'Verilmiş çek yok.','Çekle ödeme yaptığında vadesiyle burada listelenir.'))
      + `<p class="help">${esc(d.cheque_note || 'Verilen çek cari borcunu kapatır; para hesabından vadesinde çıkar, henüz tahsil edilmemiştir.')}</p>`;
    const vadeKart = card('Vadesi gelen / geçen', table(['Tarih','Cari / belge','Tutar','Durum'], due.map(row => [
      `<strong>${esc(row.due_on)}</strong><small>${row.kind === 'cheque' ? 'Çek vadesi' : row.planned ? 'Planladığın ödeme' : 'Fatura vadesi'}</small>`,
      `${esc(row.party_name)}<small>${esc(row.reference)}</small>`, money(row.amount_cents),
      row.overdue ? badge('Vadesi geçti','danger') : badge('Yaklaşıyor','warning')
    ]), 'Yaklaşan vade yok.','Faturaya ödeme tarihi işaretlediğinde ya da çek verdiğinde burada görünür.'));
    return `<div class="v2-grid cols-3">${stat('Ödenmemiş fatura',number(open.length),state.party ? 'Seçili cari' : 'Tüm cariler')}${stat('Toplam açık borcum',money(toplam),'KDV dahil · kapatılmamış tutar',true)}${stat('Verilen çek',number(cheques.length),cheques.length ? 'Vadesinde çıkacak ' + money(cekToplam) : 'Bekleyen çek yok')}</div>`
      + bilgi + filtre
      + (secili.length ? `<div class="notice">${secili.length} fatura seçili · toplam ${esc(money(seciliToplam))}. ${button('Seçilenleri tek ödemeyle kapat','pay-open',state.payParty)}</div>` : '')
      + (open.length ? gruplar : bos) + cekKart + vadeKart;
  }
  // Hareket satırının açıklaması: belge kaynağı, ödemeyse yöntem rozeti + not + çek vadesi,
  // kapattığı faturalar ve borç satırında ödenen/kalan. Bilinmeyen için hiçbir şey uydurulmaz.
  function hareketAciklamasi(e) {
    const aciklama = String(e.description ?? '');
    // Ödeme satırında kaynak satırı ("Ödeme · Kart") rozetin aynısıdır; iki kez yazılmaz.
    const kaynak = e.payment_method ? ''
      : e.source_key?.startsWith('adjustment:') ? 'Fatura düzeltmesi'
      : e.source_key?.startsWith('purchase-return:') ? 'Tedarikçi iadesi'
      : e.source_key?.startsWith('gecici-kapanis:') ? 'Faturasız giriş faturalandı'
      : e.source_key?.startsWith('gecici:') ? 'Faturasız mal girişi'
      : sourceNames[e.source] || 'Belge kaydı';
    // Not zaten açıklamada geçiyorsa tekrarlanmaz; vade her zaman Türkçe biçimde yazılır.
    const ek = [
      e.payment_note && !aciklama.includes(e.payment_note) ? kisalt(e.payment_note, 40) : '',
      e.payment_due_on ? 'vade ' + gun(e.payment_due_on) : ''
    ].filter(Boolean).join(' · ');
    const kapanan = kapatilanFaturalar(e), durum = borcDurumu(e);
    // FATURASIZ MAL GİRİŞİ ROZETİ: mal geldi ama faturası kesilmedi. Ters kaydı varsa fatura
    // gelmiş ve giriş kapanmıştır; o zaman bekleyen bir şey kalmaz.
    const gecici = e.source_key?.startsWith('gecici:') ? badge(e.reversed_by ? 'Faturalandı' : 'Faturası bekleniyor', e.reversed_by ? 'success' : 'warning') : '';
    return esc(aciklama) + (kaynak ? `<small>${esc(kaynak)}</small>` : '') + (gecici ? `<div class="ledger-pay">${gecici}</div>` : '')
      + (e.payment_method ? `<div class="ledger-pay">${badge(odemeRozeti(e.payment_method) || 'Ödeme','success')}${ek ? `<small>${esc(ek)}</small>` : ''}</div>` : '')
      + (kapanan ? `<small>${esc(kapanan)}</small>` : '')
      + (durum ? `<small>${esc(durum)}</small>` : '');
  }
  function ledgerView() {
    const d = state.data, relevant = state.party && state.tab !== 'parties' ? d.parties.filter(p => p.id === state.party) : d.parties;
    // Tutar yetkisi kapalıysa bakiye null gelir; toplam da gizlenir, sıfır yazılmaz.
    const receivable = toplam(relevant, p => artisi(p.balance_cents)), payable = toplam(relevant, p => artisi(p.balance_cents === null || p.balance_cents === undefined ? null : -p.balance_cents));
    const warnings = Object.entries(d.truncated).filter(([,value]) => value).length ? '<div class="notice">Hareket listesinde son 500 kayıt gösteriliyor. Cari bakiyeleri tüm hareketleri içerir. Daha dar bir liste için cari seçin; indirilen dosya yalnızca gösterilen hareketleri kapsar.</div>' : '';
    if (state.tab === 'odemeler') return paymentsView();
    if (state.tab === 'parties') {
      const parties = d.parties.filter(p => (!state.partyKind || p.kind === state.partyKind)
        && `${p.name} ${p.tax_id || ''} ${p.phone || ''}`.toLocaleLowerCase('tr-TR').includes(state.search.toLocaleLowerCase('tr-TR')));
      const kindCounts = d.parties.reduce((acc, p) => ({...acc, [p.kind]: (acc[p.kind] || 0) + 1}), {});
      const kindTabs = '<div class="rb-status">' + [['', 'Tümü', d.parties.length],
        ...Object.keys(kindNames).map(k => [k, kindNames[k], kindCounts[k] || 0])]
        .map(([k, ad, n]) => `<button type="button" data-business-kind="${k}" class="${state.partyKind === k ? 'warn' : ''}">`
          + `<span>${esc(ad)}</span><strong>${number(n)}</strong></button>`).join('') + '</div>';
      return kindTabs + `<div class="v2-grid cols-3">${stat('Güncel alacağım',money(receivable),'Pozitif bakiyesi olan cari hesaplar')}${stat('Güncel borcum',money(payable),'Negatif bakiyesi olan cari hesaplar')}${stat('Cari hesap',number(d.parties.length),'Yalnızca bu çalışma alanı')}</div><div class="notice subtle">Lunapot ve e-ticaret carileri birbirinden ayrıdır. Alış ve ödemeler bu cari defterinde izlenir; eski tedarikçi özetleri ayrıca toplanmaz.</div>` + card('Cari listesi', `<form class="v2-toolbar" data-business-form="search">${input('Cari adı, vergi no veya telefon','search',state.search,'search','placeholder="Cari ara…"')}<button class="secondary" type="submit">Ara</button></form>` + table(['Cari','Tür','Alacağım','Borcum · ödenen · kalan','Son ödeme','İşlem'],parties.map(p => [`<strong>${esc(p.name)}</strong><small>${esc(p.tax_id || 'Vergi numarası eklenmemiş')}${p.phone ? ' · ' + esc(p.phone) : ''}</small>`, esc(kindNames[p.kind] || 'Tedarikçi'),money(artisi(p.balance_cents)),p.debt_cents === null || p.debt_cents === undefined ? esc(money(null)) : p.debt_cents === 0 ? badge('Borç yok') : `<strong>${esc(money(p.remaining_cents))}</strong><small>Toplam borç ${esc(money(p.debt_cents))} · Ödenen ${esc(money(p.paid_cents))}</small>`,p.last_payment ? `<strong>${esc(sonOdemeMetni(p))}</strong><small>Ödenen tutar ${esc(money(p.last_payment.amount_cents))}</small>` : `${badge('Ödeme yok')}<small>Bu cariye ödeme kaydedilmedi.</small>`,button('Hesabı incele','party-detail',p.id,true)]),'Henüz cari hesabın yok.','Tedarikçi, müşteri veya pazaryerini cari olarak ekleyerek başlayabilirsin.', 'Kargo tarifesi tanımlı değil.', 'Zarar eden siparişlerin çoğu kargo yüzünden. Tutar bandı ve desi aralığıyla ücreti ekleyin; barem eşiğine yakın fiyatları önceden görün.'),button('Cari ekle','party'));
    }
    if (state.tab === 'entries') return `<p class="workflow-scope">Bakiyeler günceldir. Tarih ve vade filtreleri yalnız hareket listesini daraltır.</p><div class="v2-grid cols-2">${stat('Güncel alacağım',money(receivable),state.party ? 'Seçili cari' : 'Tüm cariler')}${stat('Güncel borcum',money(payable),state.party ? 'Seçili cari' : 'Tüm cariler')}</div>${warnings}` + card('Cari hesap hareketleri', ledgerFilter(true) + table(['Tarih / vade','Cari / referans','Açıklama','Alacağım artışı','Borcum artışı','Kapatılmamış tutar','İşlem'], d.entries.map(e => [`${esc(gun(e.occurred_on) || e.occurred_on)}<small>${e.due_on ? 'Vade: ' + esc(gun(e.due_on)) : e.planned_on ? esc(planMetni(e)) : 'Vade yok'}</small>`,`<strong>${esc(e.party_name)}</strong><small>${esc(e.reference)}</small>`,hareketAciklamasi(e),e.amount_cents > 0 ? money(e.amount_cents) : '—',e.amount_cents < 0 ? money(-e.amount_cents) : '—',e.reversed_by || e.reversal_of ? badge('Düzeltildi') : `${money(e.remaining_cents)}${(e.due_on || e.planned_on) && (e.due_on || e.planned_on) < today() && e.remaining_cents > 0 ? '<br>' + badge('Vadesi geçti','warning') : ''}`,!e.reversed_by && !e.reversal_of && (['manual','opening'].includes(e.source) || e.source === 'cash' && !d.cash_transactions.some(t => t.party_entry_id === e.id)) ? button('Ters kayıt','reverse','entry_id:' + e.id,true) : '—'])),`<div class="ac-actions">${button('Hareket ekle','entry')}${button('CSV indir','csv','entries',true)}${ledgerPager()}</div>`);
    if (state.tab === 'cash') return `${warnings}<div class="v2-grid cols-3">${d.accounts.map(a => stat(a.name,money(a.balance_cents),a.kind === 'bank' ? 'Banka · kaydedilen bakiye' : 'Kasa · kaydedilen bakiye')).join('')}</div>${d.accounts.length ? '' : '<div class="notice subtle">Tahsilat veya ödeme kaydetmek için önce kasa ya da banka hesabı ekle.</div>'}` + card('Kasa ve banka hareketleri', table(['Tarih','Hesap / cari','Referans / açıklama','Giriş','Çıkış','İşlem'],d.cash_transactions.map(t => [esc(t.occurred_on),`<strong>${esc(t.account_name)}</strong><small>${esc(t.party_name || 'Cari bağlantısı yok')}</small>`,`${esc(t.reference)}<small>${esc(t.description)}</small>`,t.amount_cents > 0 ? money(t.amount_cents) : '—',t.amount_cents < 0 ? money(-t.amount_cents) : '—',t.reversed_by || t.reversal_of ? badge('Düzeltildi') : button('Ters kayıt','reverse','cash_transaction_id:' + t.id,true)])),`<div class="ac-actions">${button('Kasa / banka ekle','account','',true)}${button('Tahsilat / ödeme','cash')}</div>`) + '<p class="help">Bu ekran yalnızca gerçekleşen para hareketlerinin kaydını tutar; banka transferi yapmaz. Tahsilat/ödemeyi bir cariye bağlamak cari bakiyesini de günceller.</p>';
    const allocations = d.allocations.filter(a => !state.party || a.party_id === state.party);
    return `${warnings}<div class="notice subtle">Belge kapaması, hangi tahsilatın hangi alacağı ya da hangi ödemenin hangi borcu kapattığını gösterir. Yeni para hareketi oluşturmaz ve cari bakiyesini değiştirmez.</div>` + card('Belge kapamaları',ledgerFilter() + table(['Cari','Alacak yönlü belge','Borç yönlü belge','Referans','Tutar','Durum','İşlem'],allocations.map(a => [esc(d.parties.find(p => p.id === a.party_id)?.name || '—'),esc(d.entries.find(e => e.id === a.positive_entry_id)?.reference || 'Eski belge · listede değil'),esc(d.entries.find(e => e.id === a.negative_entry_id)?.reference || 'Eski belge · listede değil'),esc(a.reference),money(a.amount_cents),a.reversed_by ? badge('Geri alındı') : badge('Kapandı','success'),a.reversed_by ? esc(a.reversal_reason || '') : a.reference.startsWith('reverse:') ? badge('Otomatik düzeltme') : button('Kapamayı geri al','reverse','allocation_id:' + a.id,true)])),button('Belgeleri eşleştir','allocation'));
  }

  function profileForm(id) {
    if (!state.data.products.length) throw new Error('Önce ürün ekleyin.');
    const f = state.data.profiles.find(p => p.product_id === id) || {};
    dialog('Ürün ve paket bilgisi','profile', choose('Ürün','product_id',productOptions(),id) + '<p class="help">Maliyeti güncel alış/yenileme bedeline göre gir. Buradaki değişiklik geçmiş satışların maliyetini değiştirmez.</p><div class="field-grid">' + amount('Bir adet ürün maliyeti · KDV hariç (TL) — 0 bırakırsan son alış faturasından alınır','replacement_cost',divided(f.manual_cost_cents ?? f.replacement_cost_cents,100)) + amount('Paketin ambalaj gideri · KDV hariç (TL)','packaging',divided(f.packaging_cents,100)) + amount('Paketin diğer giderleri · KDV hariç (TL)','other',divided(f.other_cents,100)) + input('Paketteki ürün adedi','units_per_parcel',f.units_per_parcel ?? '', 'number','required min="1" max="1000000" step="1"') + amount('Ürünün KDV oranı (%)','vat',divided(f.vat_bps,100)) + amount('Stopaj oranı (%)','withholding',divided(f.withholding_bps,100)) + '</div><h3>Hazır paketin ölçüsü ve ağırlığı</h3><div class="field-grid">' + input('Uzunluk (cm)','length',divided(f.length_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Genişlik (cm)','width',divided(f.width_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Yükseklik (cm)','height',divided(f.height_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Brüt ağırlık (kg)','weight',divided(f.weight_grams,1000),'number','required min="0.001" max="1000" step="0.001"') + '</div><p class="help">Paketin dış ölçülerini ve ambalaj dahil ağırlığını gir. Bilinen sıfır gider için 0 yaz; vergi veya gider bilgisi bilinmiyorsa doğrulamadan kaydetme.</p>');
  }
  function tariffForm(type) {
    const shipping = type === 'shipping';
    const common = input('Tarife adı','label','','text','required maxlength="200" placeholder="Örn. Eylül ilk hafta anlaşması"') + choose('Satış kanalı','channel',channels) + '<div class="field-grid">' + input('Başlangıç tarihi · dahil','valid_from','','date','required') + input('Bitiş tarihi · dahil','valid_to','','date','required') + amount('Satış fiyatı alt sınırı · dahil (TL)','price_min') + amount('Satış fiyatı üst sınırı · hariç (TL)','price_max','',false) + '</div><p class="help">Fiyat sınırları KDV dahil paket satışıdır. Üst sınırı boş bırakırsan üst limit olmaz. Alt sınır dahil, üst sınır hariçtir.</p>';
    const fields = shipping ? input('Kargo şirketi','carrier','','text','required maxlength="100"') + '<div class="field-grid">' + input('Desi/kg alt sınırı · dahil','billable_min','','number','required min="0" step="0.001"') + input('Desi/kg üst sınırı · hariç','billable_max','','number','min="0.001" step="0.001"') + input('Desi hesabının böleni','desi_divisor','','number','required min="1" max="1000000" step="1"') + input('Desi/kg yuvarlama adımı','billable_step','','number','required min="0.001" max="1000" step="0.001"') + amount('Paketin kargo ücreti (TL)','amount') + '</div><p class="help">Bölen ve yuvarlama adımını kargo anlaşmandan al. Sistem hacim desisi ile ağırlığın büyük olanını kullanır. Örneğin anlaşmanda 3000 böleni ve tam desiye yuvarlama varsa 3000 ve 1 gir.</p>' : '<div class="field-grid">' + input('Ürün kodu · isteğe bağlı','sku','','text','maxlength="100"') + input('Kategori · isteğe bağlı','category','','text','maxlength="100"') + amount('Komisyon oranı (%)','rate') + choose('Komisyon hangi tutardan alınır?','base',[['gross','KDV dahil satış'],['net','KDV hariç satış']]) + '</div><p class="help">Ürün kodu ve kategori boşsa tarife tüm ürünleri kapsar. Ürüne özel tarife, genel tarifeden önceliklidir.</p>';
    dialog(shipping ? 'Kargo tarifesi ekle' : 'Komisyon tarifesi ekle',type,common + fields + '<div class="field-grid">' + amount('Hizmet KDV oranı (%)','vat') + choose(shipping ? 'Yazdığın kargo ücreti' : 'Yazdığın komisyon oranı','tax_included',[['1','Hizmet KDV dahil'],['0','Hizmet KDV hariç']]) + '</div>' + input('Tarifenin kaynağı','source','','text','required maxlength="500" placeholder="Satıcı paneli / anlaşma adı ve tarihi"') + '<p class="help">Oran ve vergi koşullarını satıcı paneli veya anlaşmandan doğrula. Kaydedilen tarifeler geçmişi korumak için silinmez; gerektiğinde arşivlenir.</p>');
  }
  // Toplu ödeme: seçilen faturalar TEK ödeme kaydıyla kapanır; yöntem, tarih ve not bir kez sorulur.
  function openPayment() {
    const rows = (state.data.open_invoices || []).filter(row => state.selected.has(row.entry_id) && (!state.payParty || row.party_id === state.payParty));
    if (!rows.length) throw new Error('Önce kapatılacak faturaları işaretle.');
    if (new Set(rows.map(row => row.party_id)).size > 1) throw new Error('Tek ödeme yalnızca bir cariye yazılır. Aynı tedarikçinin faturalarını seç.');
    state.payment = {party_id:rows[0].party_id, party_name:rows[0].party_name, rows, total:rows.reduce((sum,row) => sum + (row.remaining_cents || 0),0)};
    ledgerForm('payment');
  }
  function ledgerForm(action, context = '') {
    const d = state.data;
    if (action === 'provisional-remove') {
      const kutu = $('[data-provisional-rows]');
      const satir = kutu && context ? kutu.querySelector('[data-provisional-row="' + context + '"]') : null;
      // Tek satır kaldıysa silmek yerine boşaltılır: form hiç satırsız kalmasın.
      if (satir && kutu.children.length > 1) satir.remove();
      else if (satir) satir.querySelectorAll('input').forEach(i => { i.value = i.name === 'vat' ? 20 : ''; });
      const f = $('dialog[data-business-dialog] form');
      if (f) proTaslakYaz(proTaslakTopla(f));
      return;
    }
    if (action === 'provisional-row') { const box = $('[data-provisional-rows]'); if (box && box.children.length < 40) box.insertAdjacentHTML('beforeend', provisionalRow(box.children.length + 1)); return; }
    if (action === 'party') return dialog('Cari hesap ekle','party', input('Cari adı / unvan','name','','text','required maxlength="200"') + '<div class="field-grid">' + choose('Cari türü','kind',Object.entries(kindNames)) + input('VKN / TCKN · isteğe bağlı','tax_id','','text','maxlength="11" inputmode="numeric" pattern="[0-9]{10,11}"') + input('Yetkili kişi · isteğe bağlı','contact','','text','maxlength="500"') + input('Telefon · isteğe bağlı','phone','','tel','maxlength="50"') + input('E-posta · isteğe bağlı','email','','email','maxlength="200"') + '</div>' + textArea('Adres · isteğe bağlı','address','',false));
    if (action === 'account') return dialog('Kasa veya banka hesabı ekle','account',input('Hesap adı','name','','text','required maxlength="200" placeholder="Örn. İşletme banka hesabı"') + choose('Hesap türü','kind',[['cash','Kasa'],['bank','Banka']]) + '<p class="help">Hesap boş bakiye ile açılır. Mevcut bakiyeyi kaydederken gerçekleşen giriş/çıkışı ve açıklamasını kullan.</p>');
    if (action === 'entry') {
      if (!d.parties.length) throw new Error('Önce bir cari hesap ekle.');
      return dialog('Cari hareketi ekle','entry', choose('Cari','party_id',partyOptions(),state.party) + '<div class="field-grid">' + choose('Kayıt türü','kind',[['manual','Yeni cari hareketi'],['opening','Devir / açılış bakiyesi']]) + choose('Bu tutar neyi artırıyor?','sign',[['1','Alacağım'],['-1','Borcum']]) + amount('Tutar · KDV dahil (TL)','amount') + input('İşlem tarihi','occurred_on',today(),'date','required') + input('Vade · isteğe bağlı','due_on','','date') + input('Benzersiz referans','reference',reference('CARI'),'text','required maxlength="200"') + '</div>' + textArea('Açıklama','description') + '<p class="help">Alış faturası, satış veya kasa hareketi bu hesaba zaten işlendi ise tekrar elle ekleme. Tahsilat ve ödeme kaydı Kasa ve banka ekranından yapılır.</p>');
    }
    if (action === 'cash') {
      if (!d.accounts.length) throw new Error('Önce Kasa ve banka sekmesinden bir hesap ekle.');
      return dialog('Tahsilat veya ödeme kaydet','cash',choose('Kasa / banka hesabı','account_id',accountOptions()) + select('Bağlanacak cari · isteğe bağlı','party_id',[['','Cari bağlantısı yok'],...partyOptions()],state.party,false) + '<div class="field-grid">' + choose('Para hareketi','direction',[['receipt','Tahsilat · hesaba giriş'],['payment','Ödeme · hesaptan çıkış']]) + amount('Tutar (TL)','amount') + input('İşlem tarihi','occurred_on',today(),'date','required') + input('Benzersiz referans','reference',reference('PARA'),'text','required maxlength="200"') + '</div>' + textArea('Açıklama','description') + '<div class="notice subtle">Gerçekleşmiş işlemi kaydediyorsun. Para gönderilmez. Cari seçersen onun bakiyesi de güncellenir; belirli belgeyi kapatmak için daha sonra Belge kapamaları ekranını kullan.</div>');
    }
    if (action === 'allocation') {
      if (!state.party) throw new Error('Önce belge kapamalarındaki filtreden bir cari seç.');
      const open = d.entries.filter(e => e.party_id === state.party && e.remaining_cents > 0 && !e.reversed_by && !e.reversal_of);
      const options = list => list.map(e => [e.id,`${e.reference} · ${money(e.remaining_cents)} kalan · ${e.occurred_on}`]);
      if (!open.some(e => e.amount_cents > 0) || !open.some(e => e.amount_cents < 0)) throw new Error('Bu caride eşleştirilecek açık alacak ve borç yönlü hareket birlikte bulunmalı.');
      return dialog('Belgeleri eşleştir','allocation', `<p class="help">${esc(d.parties.find(p => p.id === state.party)?.name)} hesabında eşleşen iki hareketi seç.</p>` + choose('Alacak yönlü hareket','positive_entry_id',options(open.filter(e => e.amount_cents > 0))) + choose('Borç yönlü hareket','negative_entry_id',options(open.filter(e => e.amount_cents < 0))) + amount('Kapatılacak tutar (TL)','amount') + input('Benzersiz referans','reference',reference('KAPAMA'),'text','required maxlength="200"') + '<p class="help">Ödeme ve tahsilatlar cari hareketinin ters yönünde oluşur. Tutar iki belgenin açık bakiyesini aşamaz; kısmi kapama yapılabilir.</p>');
    }
    // Ödeme: yöntem düğmelerden seçilir, "hangi banka / hangi kart" serbest nottur.
    // Kasa/banka hesabı isteğe bağlıdır: seçilirse o hesabın bakiyesi de düşer.
    if (action === 'payment') {
      const pick = state.payment;
      if (!pick || !pick.rows.length) throw new Error('Önce kapatılacak faturaları seç.');
      const list = pick.rows.map(row => `<li>${esc(row.invoice_no)} · ${esc(money(row.remaining_cents))}</li>`).join('');
      const methods = `<p class="help" id="pay-method-label">Ödemeyi nasıl yaptın?</p><div class="ac-actions" role="radiogroup" aria-labelledby="pay-method-label">${Object.entries(methodNames).map(([key,label],index) => `<label class="v2-badge"><input type="radio" name="method" value="${key}" ${index === 0 ? 'checked' : ''} required> ${esc(label)}</label>`).join('')}</div>`;
      return dialog('Fatura ödemesi kaydet','payment',
        `<p class="help"><strong>${esc(pick.party_name)}</strong> · ${pick.rows.length} fatura kapatılacak.</p><ul>${list}</ul>`
        + methods + '<div class="field-grid">' + amount('Ödediğin tutar · KDV dahil (TL)','amount',divided(pick.total,100)) + input('Ödeme tarihi','occurred_on',today(),'date','required') + '</div>'
        + input('Not · hangi kart, hangi banka, çek no','note','','text','maxlength="200" placeholder="Örn. Garanti Bonus kart / Ziraat EFT / Çek 123456"')
        + '<div class="field-grid">' + input('Çek vadesi · yalnızca çekte zorunlu','due_on','','date') + select('Kasa / banka hesabı · isteğe bağlı','account_id',[['','Hesap seçme'],...accountOptions()],'',false) + '</div>'
        + '<div class="notice subtle">Hesap seçmezsen yalnız cari borcun kapanır, kasa/banka bakiyesi değişmez. Çek seçersen borç kapanır ama para hesabından vade tarihinde çıkar; çek henüz tahsil edilmemiştir. Tutar seçili faturaların kalanını aşamaz; az yazarsan kalan açık kalır.</div>');
    }
    // "Bunu ay sonunda ödeyeceğim": ödeme yazmaz, yalnız tarihi işaretler.
    if (action === 'plan') {
      const row = (d.open_invoices || []).find(x => x.entry_id === context);
      if (!row) throw new Error('Bu fatura açık listede bulunamadı.');
      return dialog('Ne zaman ödeyeceksin?','plan',
        `<p class="help"><strong>${esc(row.invoice_no)}</strong> · ${esc(row.party_name)} · kalan ${esc(money(row.remaining_cents))}</p>`
        + input('Ödemeyi planladığın tarih','planned_on',row.planned_on || '','date','required')
        + input('Not · isteğe bağlı','note','','text','maxlength="200" placeholder="Örn. Ay sonunda ödeyeceğim"')
        + '<div class="notice subtle">Bu işlem ödeme kaydetmez ve bakiyeyi değiştirmez. Yalnızca “şu tarihte ödeyeceğim” notudur; vadesi gelen listesinde görünür. Tarihi sonra değiştirebilirsin, eski kayıt geçmişte kalır.</div>', context, 'Tarihi işaretle');
    }
    if (action === 'provisional') {
     const t = proTaslakOku() || {}, satirlar = (t.satirlar || []).length ? t.satirlar : [{}];
     dialog('Faturasız mal girişi', 'provisional',
      '<div class="notice subtle"><strong>Faturası henüz kesilmemiş malı buradan gir.</strong><p>Stok hemen artar ve cariye borcun yazılır. Gerçek fatura gelip muhasebeleştiğinde bu giriş kendiliğinden kapanır.</p></div>'
      + (t.satirlar && t.satirlar.length ? '<p class="help">Yarım kalan giriş geri yüklendi.</p>' : '')
      + choose('Cari · tedarikçi', 'supplier_id', partyOptions(), t.supplier_id || state.party)
      + '<div class="field-grid">' + input('Malın geldiği tarih', 'occurred_on', t.occurred_on || today(), 'date', 'required')
      + input('İrsaliye / referans', 'reference', t.reference || '', 'text', 'required maxlength="200"') + '</div>'
      + input('Not · isteğe bağlı', 'notes', t.notes || '', 'text', 'maxlength="1000"')
      + '<datalist id="pro-urun-listesi">' + (state.data.products || []).map(x => '<option value="' + esc(proAd(x)) + '"></option>').join('') + '</datalist>'
      + '<div class="pro-basliklar"><span>Ürün</span><span>Adet</span><span>Birim · KDV hariç</span><span>KDV %</span><span></span></div>'
      + '<div data-provisional-rows>' + satirlar.map(v => provisionalRow(v)).join('') + '</div>'
      + button('+ Ürün satırı ekle', 'provisional-row', '', true)
      + '<p class="help">Ürün kutusuna yazarak ara. Aynı ürünü iki satıra yazma, miktarı birleştir. Yazdıkların saklanır; pencere kapansa da kaybolmaz.</p>',
      '', 'Girişi kaydet');
     const form = $('dialog[data-business-dialog] form');
     if (form) form.addEventListener('input', () => proTaslakYaz(proTaslakTopla(form)));
     return;
    }
    if (action === 'invoice-debts') return dialog('Eksik fatura borçlarını tamamla','invoice-debts',
      '<div class="notice">Muhasebeleşmiş her alış faturası için eksik olan cari borcu yazılır. Borcu zaten olan faturaya dokunulmaz, taslak ve iptal fatura işlenmez. İstediğin kadar tekrar çalıştırabilirsin.</div>','','Eksikleri tamamla');
    if (action === 'reverse') {
      const [kind] = context.split(':');
      return dialog(kind === 'allocation_id' ? 'Belge kapamasını geri al' : 'Düzeltme kaydı oluştur','reverse', '<div class="notice">Asıl kayıt geçmişte korunur. Bu işlem onun etkisini geri alan bir kayıt oluşturur. Hareket kapatılmışsa önce ilgili belge kapamalarını geri al.</div>' + (kind === 'allocation_id' ? '' : '<div class="field-grid">' + input('Düzeltme tarihi','occurred_on',today(),'date','required') + input('Benzersiz referans','reference',reference('DUZELTME'),'text','required maxlength="200"') + '</div>') + textArea('Düzeltme nedeni','reason'),context,'Düzeltmeyi kaydet');
    }
  }

  async function submit(event) {
    const form = event.target.closest('form[data-business-form]'); if (!form || !root.contains(form)) return;
    event.preventDefault();
    const submitButton = form.querySelector('[type="submit"]'), error = form.querySelector('[data-business-form-error]');
    if (submitButton) submitButton.disabled = true; if (error) error.textContent = '';
    const x = Object.fromEntries(new FormData(form)), kind = form.dataset.businessForm;
    try {
      if (kind === 'filter') {
        if((x.from&&!isISODate(x.from))||(x.to&&!isISODate(x.to))||(x.from&&x.to&&x.from>x.to))throw Error('Geçerli bir tarih aralığı seçin; başlangıç bitişten sonra olamaz.');
        state.party = x.party_id; state.ledgerQuery = (x.q||'').trim(); state.ledgerFrom = x.from||''; state.ledgerTo = x.to||''; state.ledgerDue = x.due||''; state.ledgerPage = 1;
        state.ledgerKind = x.kind === 'payments' ? 'payments' : '';
        const [route,query='']=location.hash.split('?'),params=new URLSearchParams(query);
        for(const key of ['from','to','donem','preset'])params.delete(key);
        if(state.ledgerFrom)params.set('from',state.ledgerFrom);if(state.ledgerTo)params.set('to',state.ledgerTo);
        if(state.ledgerFrom&&state.ledgerTo)params.set('donem','custom');
        history.replaceState(history.state,'',route+(params.size?'?'+params:''));await load();return;
      }
      if (kind === 'search') { state.search = x.search; render(); return; }
      if (kind === 'pay-filter') { state.party = x.party_id || ''; state.selected.clear(); state.payParty = ''; await load(); return; }
      if (kind === 'quote') {
        state.quoteInput = {...x};
        state.quote = await api('/quote',{product_id:x.product_id,channel:x.channel,carrier:x.carrier,date:x.date,quantity:scaled(x.quantity,1,'Ürün adedi'),price_cents:scaled(x.price,100,'Satış fiyatı'),desired_profit_cents:scaled(x.desired_profit,100,'Hedef kâr'),max_price_cents:scaled(x.max_price,100,'Arama üst sınırı')});
        if (!state.disposed) { render(); const result=$('[data-quote-result]'); result?.focus({preventScroll:true}); result?.scrollIntoView({block:'start',behavior:'instant'}); } return;
      }
      let path, body = {...x};
      if (kind === 'profile') {
        path = '/profiles'; body = {product_id:x.product_id,vat_bps:scaled(x.vat,100,'KDV'),withholding_bps:scaled(x.withholding,100,'Stopaj'),replacement_cost_cents:scaled(x.replacement_cost,100,'Ürün maliyeti'),packaging_cents:scaled(x.packaging,100,'Ambalaj'),other_cents:scaled(x.other,100,'Diğer giderler'),length_mm:scaled(x.length,10,'Uzunluk'),width_mm:scaled(x.width,10,'Genişlik'),height_mm:scaled(x.height,10,'Yükseklik'),weight_grams:scaled(x.weight,1000,'Ağırlık'),units_per_parcel:scaled(x.units_per_parcel,1,'Paket adedi')};
      } else if (kind === 'shipping' || kind === 'commission') {
        path = kind === 'shipping' ? '/shipping' : '/commissions';
        body = {label:x.label,source:x.source,channel:x.channel,valid_from:x.valid_from,valid_to:x.valid_to,price_min_cents:scaled(x.price_min,100,'Alt fiyat'),price_max_cents:scaled(x.price_max,100,'Üst fiyat',true),vat_bps:scaled(x.vat,100,'Hizmet KDV'),tax_included:scaled(x.tax_included,1,'KDV dahil / hariç')};
        if (kind === 'shipping') Object.assign(body,{carrier:x.carrier,amount_cents:scaled(x.amount,100,'Kargo ücreti'),billable_min_milli:scaled(x.billable_min,1000,'Alt desi'),billable_max_milli:scaled(x.billable_max,1000,'Üst desi',true),desi_divisor:scaled(x.desi_divisor,1,'Desi böleni'),billable_step_milli:scaled(x.billable_step,1000,'Yuvarlama adımı')});
        else Object.assign(body,{sku:x.sku,category:x.category,rate_bps:scaled(x.rate,100,'Komisyon'),base:x.base});
      } else if (kind === 'archive') { const [type,id] = form.dataset.context.split(':'); path = `/${type}/${id}/archive`; body = {}; }
      else if (kind === 'party') path = '/parties';
      else if (kind === 'account') path = '/accounts';
      else if (kind === 'entry') { path = '/entries'; const value = scaled(x.amount,100,'Tutar'); if (value <= 0) throw new Error('Tutar sıfırdan büyük olmalı.'); body.amount = value / 100 * Number(x.sign); delete body.sign; }
      else if (kind === 'cash') { path = '/cash'; body.amount = scaled(x.amount,100,'Tutar') / 100; if (body.amount <= 0) throw new Error('Tutar sıfırdan büyük olmalı.'); }
      else if (kind === 'allocation') { path = '/allocations'; body.amount = scaled(x.amount,100,'Tutar') / 100; if (body.amount <= 0) throw new Error('Tutar sıfırdan büyük olmalı.'); }
      else if (kind === 'payment') {
        const pick = state.payment; if (!pick || !pick.rows.length) throw new Error('Kapatılacak fatura seçilmedi.');
        if (!x.method) throw new Error('Ödemeyi nasıl yaptığını seç.');
        if (x.method === 'cek' && !x.due_on) throw new Error('Çek için vade tarihi gir.');
        const value = scaled(x.amount,100,'Tutar'); if (value <= 0) throw new Error('Tutar sıfırdan büyük olmalı.');
        path = '/payments';
        body = {party_id:pick.party_id, amount:value / 100, occurred_on:x.occurred_on, method:x.method, note:x.note || '', invoice_ids:pick.rows.map(row => row.invoice_id)};
        if (x.due_on) body.due_on = x.due_on;
        if (x.account_id) body.account_id = x.account_id;
      }
      else if (kind === 'provisional') {
        // Satır adları tekrarlandığı için Object.fromEntries yetmez; hepsini getAll ile okuyoruz.
        // Tutarlar SAYIYA çevrilir: form metin verir, sunucudaki cents() yalnız sayı kabul eder.
        const data = new FormData(form), metin = data.getAll('urun_metin'), qs = data.getAll('quantity'), cs = data.getAll('unit_cost'), vs = data.getAll('vat');
        const harita = new Map((state.data.products || []).map(u => [proAd(u).toLowerCase(), u.id]));
        const lines = [];
        metin.forEach((t, i) => {
          const anahtar = String(t || '').trim().toLowerCase();
          if (!anahtar) return;
          const pid = harita.get(anahtar);
          if (!pid) throw Error((i + 1) + '. satırdaki ürün listede yok: "' + t + '". Kutuya yazıp açılan listeden seç.');
          lines.push({product_id: pid, quantity: Number(qs[i]), unit_cost: Number(cs[i]), vat_bps: Math.round(Number(vs[i]) * 100)});
        });
        if (!lines.length) throw Error('En az bir ürün satırı ekleyin.');
        if (new Set(lines.map(l => l.product_id)).size !== lines.length) throw Error('Aynı ürün iki satırda olamaz; miktarları birleştirin.');
        path = '/provisional'; body = {supplier_id: x.supplier_id, occurred_on: x.occurred_on, reference: x.reference, notes: x.notes || '', lines};
      }
      else if (kind === 'plan') { path = '/plans'; body = {entry_id:form.dataset.context, planned_on:x.planned_on, note:x.note || ''}; }
      else if (kind === 'invoice-debts') { path = '/invoice-debts'; body = {}; }
      else if (kind === 'reverse') { path = '/reverse'; const [type,id] = form.dataset.context.split(':'); body[type] = id; }
      else throw new Error('İşlem tanınmadı.');
      const result = await api(path,body);
      if (state.disposed) return;
      if (kind === 'party' && result.existing) { closeDialog(); await load(); showError('Bu vergi numarasıyla kayıtlı cari zaten var. Yeni kayıt açılmadı.'); return; }
      if (kind === 'provisional') proTaslakSil();
      if (kind === 'payment') { state.payment = null; state.selected.clear(); state.payParty = ''; }
      closeDialog(); if (view === 'pricing') state.quote = null;
      await load();
      if (kind === 'payment' && result.existing && !state.disposed) showError('Bu ödeme daha önce kaydedilmişti; ikinci kez yazılmadı.');
      if (kind === 'invoice-debts' && !state.disposed) showError(result.created ? result.created + ' fatura için eksik cari borcu yazıldı.' + (result.remaining ? ' ' + result.remaining + ' fatura kaldı, tekrar çalıştır.' : '') : 'Eksik fatura borcu bulunamadı; bütün muhasebeleşmiş faturaların cari borcu zaten yazılı.');
      // Bant bosluk/cakisma uyarisi kaydi engellemez; kullanicinin gormesi icin gosterilir.
      if (result?.warnings?.length && !state.disposed) showError(result.warnings.join(' '));
    } catch (e) { if (e.name !== 'AbortError' && !state.disposed) { if (error && error.isConnected) error.textContent = e.message; else showError(e.message); } }
    finally { if (submitButton?.isConnected) submitButton.disabled = false; }
  }
  function exportEntries() {
    const lira = value => value === null || value === undefined ? '' : value / 100;
    const rows = [['Tarih','Vade','Cari','Referans','Açıklama','Ödeme yöntemi','Ödeme notu','Kapattığı faturalar','Alacak artışı TL','Borç artışı TL','Ödenen TL','Kapatılmamış TL'],...state.data.entries.map(e => [e.occurred_on,e.due_on || '',e.party_name,e.reference,e.description,odemeRozeti(e.payment_method),e.payment_note || '',(e.closed_invoices || []).map(row => row.invoice_no).join(' '),e.amount_cents > 0 ? lira(e.amount_cents) : '',e.amount_cents < 0 ? lira(-e.amount_cents) : '',e.amount_cents < 0 ? lira(e.paid_cents) : '',e.reversed_by || e.reversal_of ? '' : lira(e.remaining_cents)])];
    const safe = value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g,'""') + '"'; };
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(safe).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `${namespace === 'ec' ? 'E-Ticaret' : 'Lunapot'}-Cari-Hareketleri-${today()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  root.addEventListener('click', async event => {
    // Cari türü sekmesi: tedarikçi, müşteri ve pazaryeri ayrı ayrı görülür.
    const tur = event.target.closest('[data-business-kind]');
    if (tur && root.contains(tur)) { state.partyKind = tur.dataset.businessKind; render(); return; }
    const target = event.target.closest('[data-business]'); if (!target || !root.contains(target)) return;
    const action = target.dataset.business, id = target.dataset.id;
    try {
      if (action === 'page') { const step = Number(target.dataset.context); state.ledgerPage = Math.max(1, (state.ledgerPage || 1) + step); await load(); return; }
      if (action === 'tab') { closeDialog(); state.tab = id; render(); }
      else if (action === 'close') closeDialog();
      else if (action === 'profile') profileForm(id);
      else if (action === 'shipping' || action === 'commission') tariffForm(action);
      else if (action === 'archive') dialog('Tarifeyi arşivle','archive','<p>Bu tarife yeni hesaplarda kullanılmayacak. Kaydın geçmişi korunacak.</p>',id,'Arşivle');
      else if (action === 'pay-all') {
        const rows = (state.data.open_invoices || []).filter(row => row.party_id === id);
        const hepsi = rows.length > 0 && rows.every(row => state.selected.has(row.entry_id));
        state.selected.clear(); state.payParty = hepsi ? '' : id;
        if (!hepsi) for (const row of rows) state.selected.add(row.entry_id);
        render();
      }
      else if (action === 'pay-one') {
        const row = (state.data.open_invoices || []).find(x => x.entry_id === id);
        if (!row) throw new Error('Bu fatura açık listede bulunamadı.');
        state.selected.clear(); state.selected.add(row.entry_id); state.payParty = row.party_id; render(); openPayment();
      }
      else if (action === 'pay-open') { if (id) state.payParty = id; openPayment(); }
      else if (action === 'party-detail') { state.party = id; state.tab = 'entries'; await load(); }
      else if (action === 'csv') exportEntries();
      else if (action === 'retry') await load();
      else ledgerForm(action,id);
    } catch (e) { if (e.name !== 'AbortError' && !state.disposed) showError(e.message); }
  },{signal:controller.signal});
  root.addEventListener('submit',submit,{signal:controller.signal});
  root.addEventListener('change',event => {
    // Fatura seçimi: bir ödeme tek cariye yazılır, başka tedarikçi işaretlenince seçim ona geçer.
    const pick = event.target.closest('[data-pay-pick]');
    if (pick && root.contains(pick)) {
      const id = pick.dataset.payPick, party = pick.dataset.party;
      if (pick.checked && state.payParty && party !== state.payParty) { state.selected.clear(); showError('Tek ödeme yalnızca bir cariye yazılır; seçim yeni tedarikçiye geçti.'); }
      if (pick.checked) { state.selected.add(id); state.payParty = party; } else state.selected.delete(id);
      if (!state.selected.size) state.payParty = '';
      render(); return;
    }
    const quoteForm=event.target.closest('[data-business-form="quote"]');
    if(view==='pricing'&&quoteForm){
      if(event.target.name==='product_id'){const profile=state.data.profiles.find(p=>p.product_id===event.target.value);quoteForm.elements.quantity.value=profile?.units_per_parcel??'';}
      if(['channel','date','product_id'].includes(event.target.name)){const channel=quoteForm.elements.channel.value,date=quoteForm.elements.date.value;const carriers=[...new Set(state.data.shippingRates.filter(r=>!r.archived_at&&r.channel===channel&&r.valid_from<=date&&r.valid_to>=date).map(r=>r.carrier))];const old=quoteForm.elements.carrier.value;quoteForm.elements.carrier.innerHTML='<option value="">Seçin…</option>'+carriers.map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');quoteForm.elements.carrier.value=carriers.includes(old)?old:carriers.length===1?carriers[0]:'';}
    }

    if (view === 'pricing' && event.target.name === 'product_id' && event.target.closest('[data-business-form="profile"]')) {
      const selected = event.target.value; if (selected) profileForm(selected);
    }
  },{signal:controller.signal});
  root.innerHTML = '<div class="loading">Çalışma alanı yükleniyor…</div>';
  load().catch(e => { if (e.name !== 'AbortError' && !state.disposed) root.innerHTML = `<div class="v2-empty"><h3>Ekran yüklenemedi.</h3><p>${esc(e.message)}</p>${button('Yeniden dene','retry')}</div>`; });
  return () => { state.disposed = true; controller.abort(); closeDialog(); state.statementDispose?.(); };
}
