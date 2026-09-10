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
export function mountBusiness(root, namespace, view) {
  if (!['ec','lp'].includes(namespace) || !['pricing','ledger'].includes(view)) throw new Error('Çalışma alanı veya ekran geçersiz.');
  const controller = new AbortController();
  const state = { ledgerQuery: '', ledgerFrom: '', ledgerTo: '', ledgerDue: '', ledgerPage: 1, entryPagination: null,data:null, tab:view === 'pricing' ? 'quote' : 'parties', party:'', search:'', quote:null, quoteInput:{channel:'trendyol',desired_profit:0,max_price:10000}, disposed:false, sequence:0};
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
    root.insertAdjacentHTML('beforeend', `<dialog data-business-dialog><form class="v2-form" data-business-form="${form}" data-context="${esc(context)}"><div class="dialog-heading"><h2>${esc(title)}</h2><button type="button" class="icon-button" data-business="close" aria-label="Kapat">×</button></div><div class="form-body">${body}<p class="error" data-business-form-error role="alert"></p></div><div class="dialog-footer">${button('Vazgeç','close','',true)}<button class="primary" type="submit">${esc(submit)}</button></div></form></dialog>`);
    $('dialog[data-business-dialog]').showModal();
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
      if (state.ledgerPage > 1) p.set('page', String(state.ledgerPage));
      query = p.toString() ? '?' + p : '';
    }
    const result = await api(query);
    if (state.disposed || sequence !== state.sequence || !root.isConnected) return;
    state.entryPagination = result.entry_pagination || null; state.data = result; render();
  }
  function render() {
    if (state.disposed || !state.data) return;
    const title = view === 'pricing' ? 'Fiyat ve kâr planı' : 'Cari hesaplar';
    const subtitle = view === 'pricing' ? 'Satmadan önce hesabını gör. Ürün, paket ve geçerli tarifelerle fiyatını belirle.' : 'Kimden alacağın var, kime borçlusun? Belgeleri ve ödemeleri aynı hesapta takip et.';
    const tabs = view === 'pricing' ? [['quote','Kâr hesapla'],['profiles','Ürün ve paket'],['tariffs','Komisyon ve kargo']] : [['parties','Cariler'],['entries','Hesap hareketleri'],['cash','Kasa ve banka'],['allocations','Belge kapamaları'],['statement','Mutabakat']];
    root.innerHTML = `<div class="v2-page"><div class="page-heading"><div><span class="eyebrow">${namespace === 'ec' ? 'E-TİCARET' : 'LUNAPOT'} ÇALIŞMA ALANI</span><h1>${title}</h1><p>${subtitle}</p></div>${view === 'ledger' ? `<div class="ac-actions">${button('Cari ekle','party')}${button('Tahsilat / ödeme','cash','',true)}</div>` : ''}</div><div class="notice" data-business-error role="alert" hidden></div><nav class="v2-tabs" aria-label="${title}">${tabs.map(([key,label]) => `<button type="button" data-business="tab" data-id="${key}" class="${state.tab === key ? 'active' : ''}" aria-current="${state.tab === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav><section data-business-body></section></div>`;
    // Mutabakat kendi modulunde durur; sekme degisince onceki baglanti birakilir.
    if (state.statementDispose) { state.statementDispose(); state.statementDispose = null; }
    const body = $('[data-business-body]');
    if (view === 'ledger' && state.tab === 'statement') mountStatementTab(body);
    else body.innerHTML = view === 'pricing' ? pricingView() : ledgerView();
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
  const partyOptions = () => state.data.parties.map(p => [p.id, p.name]);
  const accountOptions = () => state.data.accounts.map(p => [p.id, `${p.name} · ${p.kind === 'bank' ? 'Banka' : 'Kasa'}`]);

  function pricingView() {
    const d = state.data;
    if (state.tab === 'profiles') return `<div class="v2-hero"><div><h2>Doğru kâr, doğru ürün bilgisiyle başlar.</h2><p>Ürün maliyeti bir adet içindir. Ölçü, ağırlık ve ambalaj gideri hazırladığın paketin tamamına aittir. Bilmediğin maliyet veya vergi oranına sıfır yazma.</p></div>${button('Ürün bilgisi ekle','profile')}</div>` + card('Ürün ve paket bilgileri', table(['Ürün','Birim maliyet · KDV hariç','Paket','Ağırlık / ölçü','Ürün KDV','İşlem'], d.products.map(p => {
      const f = d.profiles.find(x => x.product_id === p.id);
      return [`<strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small>`, f ? money(f.replacement_cost_cents) : badge('Bilgi gerekli','warning'), f ? `${number(f.units_per_parcel)} adet / paket` : '—', f ? `${number(f.weight_grams / 1000)} kg<small>${number(f.length_mm / 10)} × ${number(f.width_mm / 10)} × ${number(f.height_mm / 10)} cm</small>` : '—', f ? `%${number(f.vat_bps / 100)}` : '—', button(f ? 'Düzenle' : 'Bilgileri tamamla','profile',p.id,true)];
    }), 'Önce ürün ekleyin.', namespace === 'ec' ? 'Stok ekranından ürün ekledikten sonra paket ve maliyet bilgilerini burada tamamlayabilirsiniz.' : 'Ürünler ekranından bir ürün ekleyin.'));
    if (state.tab === 'tariffs') return `<div class="notice subtle">Tarifeler tarih aralığıyla saklanır. Haftalık koşullar değiştiğinde yeni tarife ekleyin; yanlış kaydı arşivleyin. Aynı koşullarda çakışan tarifeler varsa hesap durur.</div><div class="v2-grid cols-2">${stat('Komisyon tarifesi', number(d.commissionRates.filter(x => !x.archived_at).length), 'Arşivlenmemiş tarife')}${stat('Kargo tarifesi', number(d.shippingRates.filter(x => !x.archived_at).length), 'Arşivlenmemiş tarife')}</div>` + card('Komisyon tarifeleri', table(['Tarife / kaynak','Kanal / ürün','Geçerlilik','Fiyat aralığı · KDV dahil','Komisyon','Durum / işlem'], d.commissionRates.map(r => [tariffName(r), `${esc(channelName(r.channel))}<small>${esc(r.sku || r.category || 'Tüm ürünler')}</small>`, `${esc(r.valid_from)} → ${esc(r.valid_to)}`, tariffRange(r), `%${number(r.rate_bps / 100)}<small>${r.base === 'gross' ? 'KDV dahil' : 'KDV hariç'} satış üzerinden · ücret KDV ${r.tax_included ? 'dahil' : 'hariç'}</small>`, tariffAction(r,'commissions')])), button('Komisyon tarifesi ekle','commission')) + `<div class="breakdown">` + card('Kargo tarifeleri', table(['Tarife / kaynak','Kanal / kargo','Geçerlilik','Fiyat / desi aralığı','Ücret','Durum / işlem'], d.shippingRates.map(r => [tariffName(r), `${esc(channelName(r.channel))}<small>${esc(r.carrier)}</small>`, `${esc(r.valid_from)} → ${esc(r.valid_to)}`, `${tariffRange(r)}<small>${number(r.billable_min_milli / 1000)} – ${r.billable_max_milli === null ? 'üst sınır yok' : number(r.billable_max_milli / 1000) + ' hariç'} desi/kg</small>`, `${money(r.amount_cents)}<small>KDV ${r.tax_included ? 'dahil' : 'hariç'} · %${number(r.vat_bps / 100)}</small>`, tariffAction(r,'shipping')])), button('Kargo tarifesi ekle','shipping')) + '</div>';
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
    const lines = [['KDV hariç satış',q.revenue_net_cents],['Ürün maliyeti',q.cost_net_cents],['Ambalaj gideri',q.packaging_net_cents],['Komisyon · KDV hariç',q.commission_net_cents],['Kargo · KDV hariç',q.shipping_net_cents],['Diğer satış gideri',q.other_net_cents]];
    const desired = Math.round(Number(state.quoteInput.desired_profit) * 100);
    const targetWarning = q.estimated_profit_cents < desired ? `<div class="notice"><strong>Seçtiğin satış fiyatı hedef kârını sağlamıyor.</strong><br>Hedef ${money(desired)}, bu fiyattaki tahmini katkı ${money(q.estimated_profit_cents)}. Kargo veya komisyon baremi değiştiğinde daha yüksek fiyat bile daha düşük kâr bırakabilir.</div>` : '';
    return `<div class="v2-card-body">${badge(q.estimated_profit_cents < 0 ? 'Bu fiyatta zarar görünüyor' : 'Tahmini katkı kârı',q.estimated_profit_cents < 0 ? 'danger' : 'success')}<strong class="v2-stat-value">${money(q.estimated_profit_cents)}</strong><p class="help">Kargo hesabı: ${number(q.billable_milli / 1000)} desi/kg</p>${targetWarning}${lines.map(([label,value]) => `<div class="v2-summary-line"><span>${label}</span><strong>${money(value)}</strong></div>`).join('')}${renderPriceDecision(state.quote)}<div class="v2-summary-line total"><span>Tahmini hakediş</span><strong>${money(q.estimated_payout_cents)}</strong></div><p class="help">Bu ön hakediş yalnızca tanımlı komisyon, kargo ve stopajı düşer. Diğer pazaryeri hizmet kesintileri ayrıca doğrulanır; ürün ve ambalaj maliyeti nakit hakedişinden düşülmez. ${money(q.withholding_cents)} stopaj nakit kesintisi olarak ayrı hesaplandı.</p>${f.status === 'found' ? `<div class="notice ${q.price_cents < f.price_cents ? '' : 'subtle'}"><strong>Hedef kâr için ${money(f.price_cents)} altında satma.</strong><br>Bu tutar paketin KDV dahil en düşük uygun toplam satış fiyatıdır. Her daha yüksek fiyatın aynı hedefi sağlayacağı garanti değildir; barem değişiminde yeniden hesapla.</div>` : `<div class="notice"><strong>${f.status === 'impossible' ? 'Seçtiğin aralıkta hedef kâra ulaşılamıyor.' : 'Güvenilir alt fiyat sınırı henüz bulunamadı.'}</strong>${missing.length ? `<ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : '<p>Üst sınırı veya hedef kârı gözden geçir.</p>'}</div>`}<details><summary>Hesapta kullanılan tarifeler</summary><p class="help">Komisyon: ${esc(state.data.commissionRates.find(r => r.id === q.commission_rate_id)?.label || '—')}<br>Kargo: ${esc(state.data.shippingRates.find(r => r.id === q.shipping_rate_id)?.label || '—')}</p></details></div>`;
  }

  // Sunucu sayfalamasi: eski hareketler 500 sinirinin ardinda kalmaz.
  function ledgerPager() {
    const p = state.entryPagination;
    if (!p || p.pages <= 1) return '';
    const back = p.page > 1 ? '' : ' disabled';
    const next = p.has_more ? '' : ' disabled';
    return `<span class="ledger-pager"><button type="button" class="secondary" data-business="page" data-context="-1"${back}>← Önceki</button><span class="muted">Sayfa ${p.page} / ${p.pages}</span><button type="button" class="secondary" data-business="page" data-context="1"${next}>Sonraki →</button></span>`;
  }
  function ledgerFilter() {
    const page = state.entryPagination;
    const scope = page ? `${page.total} hareket bulundu · sayfa ${page.page}/${page.pages}` : (state.party ? 'Seçili carinin hesap hareketleri' : 'Bu çalışma alanındaki kayıtlar');
    return `<form class="v2-toolbar ledger-filters" data-business-form="filter">${select('Cari hesabı seç','party_id',[['','Tüm cariler'],...partyOptions()],state.party,false)}` +
      `<label>Referans, açıklama veya cari<input name="q" value="${esc(state.ledgerQuery || '')}" maxlength="200" placeholder="Tüm geçmişte ara"></label>` +
      `<label>Başlangıç<input name="from" type="date" value="${esc(state.ledgerFrom || '')}"></label>` +
      `<label>Bitiş<input name="to" type="date" value="${esc(state.ledgerTo || '')}"></label>` +
      `${select('Vade','due',[['','Tümü'],['overdue','Vadesi geçenler'],['upcoming','Vadesi gelecekler']],state.ledgerDue || '',false)}` +
      `<button class="secondary" type="submit">Göster</button><span class="muted">${esc(scope)}</span></form>`;
  }
  function ledgerView() {
    const d = state.data, relevant = state.party && state.tab !== 'parties' ? d.parties.filter(p => p.id === state.party) : d.parties;
    const receivable = relevant.reduce((sum,p) => sum + Math.max(0,p.balance_cents),0), payable = relevant.reduce((sum,p) => sum + Math.max(0,-p.balance_cents),0);
    const warnings = Object.entries(d.truncated).filter(([,value]) => value).length ? '<div class="notice">Hareket listesinde son 500 kayıt gösteriliyor. Cari bakiyeleri tüm hareketleri içerir. Daha dar bir liste için cari seçin; indirilen dosya yalnızca gösterilen hareketleri kapsar.</div>' : '';
    if (state.tab === 'parties') {
      const parties = d.parties.filter(p => `${p.name} ${p.tax_id || ''} ${p.phone || ''}`.toLocaleLowerCase('tr-TR').includes(state.search.toLocaleLowerCase('tr-TR')));
      return `<div class="v2-grid cols-3">${stat('Alacağım',money(receivable),'Pozitif bakiyesi olan cari hesaplar')}${stat('Borcum',money(payable),'Negatif bakiyesi olan cari hesaplar')}${stat('Cari hesap',number(d.parties.length),'Yalnızca bu çalışma alanı')}</div><div class="notice subtle">Lunapot ve e-ticaret carileri birbirinden ayrıdır. Alış ve ödemeler bu cari defterinde izlenir; eski tedarikçi özetleri ayrıca toplanmaz.</div>` + card('Cari listesi', `<form class="v2-toolbar" data-business-form="search">${input('Cari adı, vergi no veya telefon','search',state.search,'search','placeholder="Cari ara…"')}<button class="secondary" type="submit">Ara</button></form>` + table(['Cari','Tür','İletişim','Alacağım','Borcum','İşlem'],parties.map(p => [`<strong>${esc(p.name)}</strong><small>${esc(p.tax_id || 'Vergi numarası eklenmemiş')}</small>`, esc(kindNames[p.kind] || 'Tedarikçi'),`${esc(p.phone || '—')}<small>${esc(p.email || '')}</small>`,money(Math.max(0,p.balance_cents)),money(Math.max(0,-p.balance_cents)),button('Hesabı incele','party-detail',p.id,true)]),'Henüz cari hesabın yok.','Tedarikçi, müşteri veya pazaryerini cari olarak ekleyerek başlayabilirsin.'),button('Cari ekle','party'));
    }
    if (state.tab === 'entries') return `<div class="v2-grid cols-2">${stat('Alacağım',money(receivable),state.party ? 'Seçili cari' : 'Tüm cariler')}${stat('Borcum',money(payable),state.party ? 'Seçili cari' : 'Tüm cariler')}</div>${warnings}` + card('Cari hesap hareketleri', ledgerFilter() + table(['Tarih / vade','Cari / referans','Açıklama','Alacağım artışı','Borcum artışı','Kapatılmamış tutar','İşlem'], d.entries.map(e => [`${esc(e.occurred_on)}<small>${e.due_on ? 'Vade: ' + esc(e.due_on) : 'Vade yok'}</small>`,`<strong>${esc(e.party_name)}</strong><small>${esc(e.reference)}</small>`,`${esc(e.description)}<small>${esc(e.source_key?.startsWith('adjustment:')?'Fatura düzeltmesi':e.source_key?.startsWith('purchase-return:')?'Tedarikçi iadesi':sourceNames[e.source] || 'Belge kaydı')}</small>`,e.amount_cents > 0 ? money(e.amount_cents) : '—',e.amount_cents < 0 ? money(-e.amount_cents) : '—',e.reversed_by || e.reversal_of ? badge('Düzeltildi') : `${money(e.remaining_cents)}${e.due_on && e.due_on < today() && e.remaining_cents > 0 ? '<br>' + badge('Vadesi geçti','warning') : ''}`,!e.reversed_by && !e.reversal_of && ['manual','opening'].includes(e.source) ? button('Ters kayıt','reverse','entry_id:' + e.id,true) : '—'])),`<div class="ac-actions">${button('Hareket ekle','entry')}${button('CSV indir','csv','entries',true)}${ledgerPager()}</div>`);
    if (state.tab === 'cash') return `${warnings}<div class="v2-grid cols-3">${d.accounts.map(a => stat(a.name,money(a.balance_cents),a.kind === 'bank' ? 'Banka · kaydedilen bakiye' : 'Kasa · kaydedilen bakiye')).join('')}</div>${d.accounts.length ? '' : '<div class="notice subtle">Tahsilat veya ödeme kaydetmek için önce kasa ya da banka hesabı ekle.</div>'}` + card('Kasa ve banka hareketleri', table(['Tarih','Hesap / cari','Referans / açıklama','Giriş','Çıkış','İşlem'],d.cash_transactions.map(t => [esc(t.occurred_on),`<strong>${esc(t.account_name)}</strong><small>${esc(t.party_name || 'Cari bağlantısı yok')}</small>`,`${esc(t.reference)}<small>${esc(t.description)}</small>`,t.amount_cents > 0 ? money(t.amount_cents) : '—',t.amount_cents < 0 ? money(-t.amount_cents) : '—',t.reversed_by || t.reversal_of ? badge('Düzeltildi') : button('Ters kayıt','reverse','cash_transaction_id:' + t.id,true)])),`<div class="ac-actions">${button('Kasa / banka ekle','account','',true)}${button('Tahsilat / ödeme','cash')}</div>`) + '<p class="help">Bu ekran yalnızca gerçekleşen para hareketlerinin kaydını tutar; banka transferi yapmaz. Tahsilat/ödemeyi bir cariye bağlamak cari bakiyesini de günceller.</p>';
    const allocations = d.allocations.filter(a => !state.party || a.party_id === state.party);
    return `${warnings}<div class="notice subtle">Belge kapaması, hangi tahsilatın hangi alacağı ya da hangi ödemenin hangi borcu kapattığını gösterir. Yeni para hareketi oluşturmaz ve cari bakiyesini değiştirmez.</div>` + card('Belge kapamaları',ledgerFilter() + table(['Cari','Alacak yönlü belge','Borç yönlü belge','Referans','Tutar','Durum','İşlem'],allocations.map(a => [esc(d.parties.find(p => p.id === a.party_id)?.name || '—'),esc(d.entries.find(e => e.id === a.positive_entry_id)?.reference || 'Eski belge · listede değil'),esc(d.entries.find(e => e.id === a.negative_entry_id)?.reference || 'Eski belge · listede değil'),esc(a.reference),money(a.amount_cents),a.reversed_by ? badge('Geri alındı') : badge('Kapandı','success'),a.reversed_by ? esc(a.reversal_reason || '') : a.reference.startsWith('reverse:') ? badge('Otomatik düzeltme') : button('Kapamayı geri al','reverse','allocation_id:' + a.id,true)])),button('Belgeleri eşleştir','allocation'));
  }

  function profileForm(id) {
    if (!state.data.products.length) throw new Error('Önce ürün ekleyin.');
    const f = state.data.profiles.find(p => p.product_id === id) || {};
    dialog('Ürün ve paket bilgisi','profile', choose('Ürün','product_id',productOptions(),id) + '<p class="help">Maliyeti güncel alış/yenileme bedeline göre gir. Buradaki değişiklik geçmiş satışların maliyetini değiştirmez.</p><div class="field-grid">' + amount('Bir adet ürün maliyeti · KDV hariç (TL)','replacement_cost',divided(f.replacement_cost_cents,100)) + amount('Paketin ambalaj gideri · KDV hariç (TL)','packaging',divided(f.packaging_cents,100)) + amount('Paketin diğer giderleri · KDV hariç (TL)','other',divided(f.other_cents,100)) + input('Paketteki ürün adedi','units_per_parcel',f.units_per_parcel ?? '', 'number','required min="1" max="1000000" step="1"') + amount('Ürünün KDV oranı (%)','vat',divided(f.vat_bps,100)) + amount('Stopaj oranı (%)','withholding',divided(f.withholding_bps,100)) + '</div><h3>Hazır paketin ölçüsü ve ağırlığı</h3><div class="field-grid">' + input('Uzunluk (cm)','length',divided(f.length_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Genişlik (cm)','width',divided(f.width_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Yükseklik (cm)','height',divided(f.height_mm,10),'number','required min="0.1" max="1000" step="0.1"') + input('Brüt ağırlık (kg)','weight',divided(f.weight_grams,1000),'number','required min="0.001" max="1000" step="0.001"') + '</div><p class="help">Paketin dış ölçülerini ve ambalaj dahil ağırlığını gir. Bilinen sıfır gider için 0 yaz; vergi veya gider bilgisi bilinmiyorsa doğrulamadan kaydetme.</p>');
  }
  function tariffForm(type) {
    const shipping = type === 'shipping';
    const common = input('Tarife adı','label','','text','required maxlength="200" placeholder="Örn. Eylül ilk hafta anlaşması"') + choose('Satış kanalı','channel',channels) + '<div class="field-grid">' + input('Başlangıç tarihi · dahil','valid_from','','date','required') + input('Bitiş tarihi · dahil','valid_to','','date','required') + amount('Satış fiyatı alt sınırı · dahil (TL)','price_min') + amount('Satış fiyatı üst sınırı · hariç (TL)','price_max','',false) + '</div><p class="help">Fiyat sınırları KDV dahil paket satışıdır. Üst sınırı boş bırakırsan üst limit olmaz. Alt sınır dahil, üst sınır hariçtir.</p>';
    const fields = shipping ? input('Kargo şirketi','carrier','','text','required maxlength="100"') + '<div class="field-grid">' + input('Desi/kg alt sınırı · dahil','billable_min','','number','required min="0" step="0.001"') + input('Desi/kg üst sınırı · hariç','billable_max','','number','min="0.001" step="0.001"') + input('Desi hesabının böleni','desi_divisor','','number','required min="1" max="1000000" step="1"') + input('Desi/kg yuvarlama adımı','billable_step','','number','required min="0.001" max="1000" step="0.001"') + amount('Paketin kargo ücreti (TL)','amount') + '</div><p class="help">Bölen ve yuvarlama adımını kargo anlaşmandan al. Sistem hacim desisi ile ağırlığın büyük olanını kullanır. Örneğin anlaşmanda 3000 böleni ve tam desiye yuvarlama varsa 3000 ve 1 gir.</p>' : '<div class="field-grid">' + input('Ürün kodu · isteğe bağlı','sku','','text','maxlength="100"') + input('Kategori · isteğe bağlı','category','','text','maxlength="100"') + amount('Komisyon oranı (%)','rate') + choose('Komisyon hangi tutardan alınır?','base',[['gross','KDV dahil satış'],['net','KDV hariç satış']]) + '</div><p class="help">Ürün kodu ve kategori boşsa tarife tüm ürünleri kapsar. Ürüne özel tarife, genel tarifeden önceliklidir.</p>';
    dialog(shipping ? 'Kargo tarifesi ekle' : 'Komisyon tarifesi ekle',type,common + fields + '<div class="field-grid">' + amount('Hizmet KDV oranı (%)','vat') + choose(shipping ? 'Yazdığın kargo ücreti' : 'Yazdığın komisyon oranı','tax_included',[['1','Hizmet KDV dahil'],['0','Hizmet KDV hariç']]) + '</div>' + input('Tarifenin kaynağı','source','','text','required maxlength="500" placeholder="Satıcı paneli / anlaşma adı ve tarihi"') + '<p class="help">Oran ve vergi koşullarını satıcı paneli veya anlaşmandan doğrula. Kaydedilen tarifeler geçmişi korumak için silinmez; gerektiğinde arşivlenir.</p>');
  }
  function ledgerForm(action, context = '') {
    const d = state.data;
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
      if (kind === 'filter') { state.party = x.party_id; state.ledgerQuery = (x.q||'').trim(); state.ledgerFrom = x.from||''; state.ledgerTo = x.to||''; state.ledgerDue = x.due||''; state.ledgerPage = 1; await load(); return; }
      if (kind === 'search') { state.search = x.search; render(); return; }
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
      else if (kind === 'reverse') { path = '/reverse'; const [type,id] = form.dataset.context.split(':'); body[type] = id; }
      else throw new Error('İşlem tanınmadı.');
      const result = await api(path,body);
      if (state.disposed) return;
      if (kind === 'party' && result.existing) { closeDialog(); await load(); showError('Bu vergi numarasıyla kayıtlı cari zaten var. Yeni kayıt açılmadı.'); return; }
      closeDialog(); if (view === 'pricing') state.quote = null;
      await load();
      // Bant bosluk/cakisma uyarisi kaydi engellemez; kullanicinin gormesi icin gosterilir.
      if (result?.warnings?.length && !state.disposed) showError(result.warnings.join(' '));
    } catch (e) { if (e.name !== 'AbortError' && !state.disposed) { if (error && error.isConnected) error.textContent = e.message; else showError(e.message); } }
    finally { if (submitButton?.isConnected) submitButton.disabled = false; }
  }
  function exportEntries() {
    const rows = [['Tarih','Vade','Cari','Referans','Açıklama','Alacak artışı TL','Borç artışı TL','Kapatılmamış TL'],...state.data.entries.map(e => [e.occurred_on,e.due_on || '',e.party_name,e.reference,e.description,e.amount_cents > 0 ? e.amount_cents / 100 : '',e.amount_cents < 0 ? -e.amount_cents / 100 : '',e.reversed_by || e.reversal_of ? '' : e.remaining_cents / 100])];
    const safe = value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g,'""') + '"'; };
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(safe).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `${namespace === 'ec' ? 'E-Ticaret' : 'Lunapot'}-Cari-Hareketleri-${today()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  root.addEventListener('click', async event => {
    const target = event.target.closest('[data-business]'); if (!target || !root.contains(target)) return;
    const action = target.dataset.business, id = target.dataset.id;
    try {
      if (action === 'page') { const step = Number(target.dataset.context); state.ledgerPage = Math.max(1, (state.ledgerPage || 1) + step); await load(); return; }
      if (action === 'tab') { closeDialog(); state.tab = id; render(); }
      else if (action === 'close') closeDialog();
      else if (action === 'profile') profileForm(id);
      else if (action === 'shipping' || action === 'commission') tariffForm(action);
      else if (action === 'archive') dialog('Tarifeyi arşivle','archive','<p>Bu tarife yeni hesaplarda kullanılmayacak. Kaydın geçmişi korunacak.</p>',id,'Arşivle');
      else if (action === 'party-detail') { state.party = id; state.tab = 'entries'; await load(); }
      else if (action === 'csv') exportEntries();
      else if (action === 'retry') await load();
      else ledgerForm(action,id);
    } catch (e) { if (e.name !== 'AbortError' && !state.disposed) showError(e.message); }
  },{signal:controller.signal});
  root.addEventListener('submit',submit,{signal:controller.signal});
  root.addEventListener('change',event => {
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
