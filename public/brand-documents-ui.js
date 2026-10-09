import {can} from './permissions.js';
import {toCanonicalLine, toQuantityMilli, SayiHatasi} from './belge-sayi.js';
import {offerTotals} from './offer-math.js';

// BELGE ATÖLYESİ. On bir belge türü, tek ekran.
//
// Teklif ve proforma MEVCUT offers kaydına gider: ikinci kayıt havuzu yoktur,
// numara/revizyon/durum zinciri o servisin kurallarıdır. Diğer dokuz tür kurumsal
// evrak defterine gider ve HİÇBİRİ gerçek sipariş, fatura, irsaliye ya da stok
// hareketi yaratmaz.
//
// Kaynak tasarım: lunapot-kurumsal-moduller-devir/01-Belge-Atolyesi/business-app.js
// Uyarlama: global document seçicileri, DOMContentLoaded, tek global
// window.LunapotBusiness ve localStorage kaynak kaydı yerine mount/unmount ve
// sunucu kimlikleri. Yerel depolama KAYNAK KAYIT DEĞİLDİR.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const multiline = value => esc(value).replace(/\n/g, '<br>');

// Atölyenin on bir türü. İlk ikisi offers, diğer dokuzu kurumsal evrak defteri.
const TYPES = [
  {id: 'teklif', name: 'Fiyat teklifi', code: 'TEK', store: 'offers', kind: 'quote', money: true, table: true, party: 'Müşteri', subject: 'Teklif konusu', validity: true, sign: ['Hazırlayan', 'Değerlendiren']},
  {id: 'proforma', name: 'Proforma', code: 'PRO', store: 'offers', kind: 'proforma', money: true, table: true, party: 'Alıcı', subject: 'Proforma konusu', validity: true, sign: ['Hazırlayan', 'Alıcı'], foot: 'Proforma — mali belge değildir.'},
  {id: 'siparis-onayi', name: 'Sipariş onayı', code: 'SIP', store: 'brand', money: true, table: true, party: 'Müşteri', subject: 'Sipariş açıklaması', sign: ['Hazırlayan', 'Müşteri onayı']},
  {id: 'satinalma-siparisi', name: 'Satın alma siparişi', code: 'SAT', store: 'brand', money: true, table: true, party: 'Tedarikçi', subject: 'Satın alma konusu', sign: ['Talep eden', 'Onaylayan']},
  {id: 'paket-listesi', name: 'Paket listesi', code: 'PKT', store: 'brand', money: false, table: true, party: 'Alıcı', subject: 'Gönderi referansı', sign: ['Paketleyen', 'Kontrol eden'], foot: 'Paket içeriği listesidir; sevk irsaliyesi yerine kullanılmaz.'},
  {id: 'teslim-tutanagi', name: 'Teslim tutanağı', code: 'TES', store: 'brand', money: false, table: true, party: 'Teslim alan', subject: 'Teslim yeri / referansı', sign: ['Teslim eden', 'Teslim alan']},
  {id: 'iade-formu', name: 'İade talep formu', code: 'IAD', store: 'brand', money: false, table: true, party: 'Talep sahibi', subject: 'Sipariş / fatura referansı', sign: ['Talep sahibi', 'Teslim alan']},
  {id: 'teknik-bilgi', name: 'Ürün bilgi formu', code: 'URN', store: 'brand', money: false, table: false, party: 'Hazırlayan / ilgili', subject: 'Ürün / model', sign: ['Hazırlayan', 'Kontrol eden']},
  {id: 'antet', name: 'Antetli yazı', code: 'YAZ', store: 'brand', money: false, table: false, party: 'Muhatap', subject: 'Konu', sign: ['Ad / unvan', '']},
  {id: 'toplanti-notu', name: 'Toplantı notu', code: 'TOP', store: 'brand', money: false, table: false, party: 'Katılımcılar', subject: 'Toplantı konusu', sign: ['Notu hazırlayan', '']},
  {id: 'dosya-kapagi', name: 'Dosya kapağı', code: 'DOS', store: 'brand', money: false, table: false, party: 'Hazırlanan kişi / kurum', subject: 'Proje / dosya adı', sign: ['Hazırlayan', 'Kontrol eden']}
];
const typeOf = id => TYPES.find(type => type.id === id) || TYPES[0];
const DEFAULT_LOGO = 'lunapot-yatay-antrasit';

// Örnek veri AYRI moddur: boş yeni belgeye örnek fiyat SIZMAZ.
const SAMPLE_ITEMS = [
  {name: '[Örnek ürün / hizmet A]', sku: '[SKU-01]', qty: '2', unit: 'adet', price: '125', discount: '10', vat: '20', note: ''},
  {name: '[Örnek ürün / hizmet B]', sku: '[SKU-02]', qty: '1', unit: 'adet', price: '80', discount: '0', vat: '10', note: ''}
];
const blankItem = () => ({name: '', sku: '', qty: '1', unit: 'adet', price: '', discount: '0', vat: '20', note: '', product_id: null});

const money = cents => cents === null || cents === undefined
  ? '—' : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(cents / 100);
const quantity = milli => new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(milli / 1000);

export function mountBrandDocuments(root, namespace, user) {
  if (!['ec', 'lp'].includes(namespace)) throw new Error('Çalışma alanı geçersiz.');
  const controller = new AbortController();
  const signal = controller.signal;
  const writable = can(user, namespace, 'brand_documents', true);
  const showMoney = can(user, namespace, 'amounts');

  const state = {
    type: 'teklif', draft: null, record: null, dirty: false, busy: false,
    company: null, companyAvailable: true, parties: [], partiesLoaded: false,
    brandAvailable: true, brandNotice: '', list: [], listLoaded: false,
    error: '', status: '', disposed: false, view: 'editor'
  };

  const $ = selector => root.querySelector(selector);

  async function api(path, body) {
    const response = await fetch('/api/' + namespace + path, {
      signal,
      ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'application/json'}})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'İşlem tamamlanamadı.'), {status: response.status});
    return data;
  }

  // Yeni belgenin tarihi İstanbul günüdür. İÇE AKTARILAN ya da AÇILAN belgenin
  // tarihi asla bu değerle ezilmez.
  const istanbulToday = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
  const plusDays = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

  function freshDraft(typeId, {sample = false} = {}) {
    const type = typeOf(typeId);
    const bugun = istanbulToday();
    return {
      title: '', issue_date: bugun,
      valid_until: type.validity ? plusDays(bugun, 30) : '',
      reference: '', party_id: '',
      recipient: {name: '', address: '', tax: ''},
      notes: '', prepared: '', approved: '',
      example: sample,
      logo_variant_id: DEFAULT_LOGO,
      items: !type.table ? [] : sample ? SAMPLE_ITEMS.map(item => ({...item, product_id: null})) : [blankItem()]
    };
  }

  const presentationOf = draft => ({
    schema_version: 1, template_id: 'lunapot-business-v2', template_version: 1,
    logo_variant_id: draft.logo_variant_id || DEFAULT_LOGO,
    company_snapshot: state.company ? {
      name: state.company.legal_name || '', address: state.company.address || '',
      contact: [state.company.phone, state.company.email, state.company.website].filter(Boolean).join(' · '),
      tax: [state.company.tax_office, state.company.tax_id].filter(Boolean).join(' / '),
      bank: [state.company.bank_name, state.company.bank_iban].filter(Boolean).join(' · ')
    } : null,
    brand_version: 'v8'
  });

  // Önizleme hesabı kanonik motordan geçer: ekranda ayrı bir matematik yoktur.
  function previewTotals(draft, type) {
    if (!type.money || !type.table) return {totals: null, problem: ''};
    try {
      const lines = draft.items.map((item, index) => toCanonicalLine(item, index));
      return {totals: offerTotals(lines), problem: ''};
    } catch (error) {
      return {totals: null, problem: error.message};
    }
  }

  function canonicalLines(draft, type) {
    if (!type.table) return [];
    if (type.money) return draft.items.map((item, index) => toCanonicalLine(item, index));
    return draft.items.map((item, index) => {
      const yer = ' (satır ' + (index + 1) + ')';
      if (!String(item.name ?? '').trim()) throw new SayiHatasi('Ürün / hizmet adı yazılmamış' + yer + '.');
      let qty;
      try { qty = toQuantityMilli(item.qty); } catch (error) { throw new SayiHatasi(error.message + yer, error); }
      return {description: String(item.name).trim(), unit: String(item.unit ?? '').trim(),
        product_id: item.product_id ?? null, quantity_milli: qty, note: String(item.note ?? '').trim()};
    });
  }

  // ---------- A4 önizleme. Kaynak tasarım korunur. ----------
  function sheetHtml(draft, type) {
    const {totals, problem} = previewTotals(draft, type);
    const company = state.company || {};
    const companyName = company.legal_name || '[Şirket unvanı]';
    const contact = [company.phone, company.email, company.website].filter(Boolean).join(' · ');
    const taxLine = [company.tax_office, company.tax_id].filter(Boolean).join(' / ');
    const bank = [company.bank_name, company.bank_iban].filter(Boolean).join(' · ');
    const no = state.record ? state.record.document_no + (state.record.revision > 1 ? ' · ' + state.record.revision + '. sürüm' : '') : type.code + '-[kaydedince verilir]';

    const rows = draft.items.map((item, index) => {
      const line = totals ? totals.rows[index] : null;
      const cells = type.money
        ? '<td class="num">' + (showMoney ? esc(money(line ? line.unit_price_cents : null)) : 'gizli') + '</td>' +
          '<td class="num">' + esc(item.discount || '0') + '%</td>' +
          '<td class="num">' + esc(item.vat || '0') + '%</td>' +
          '<td class="num strong">' + (showMoney ? esc(money(line ? line.net_cents : null)) : 'gizli') + '</td>'
        // Boş "Kontrol / açıklama" sütunu artık düzenlenebilir; boş kalırsa boş basılır, gizlenmez.
        : '<td>' + esc(item.note || '') + '</td>';
      return '<tr><td>' + (index + 1) + '</td><td><strong>' + esc(item.name || '—') + '</strong>' +
        (item.sku ? '<small>' + esc(item.sku) + '</small>' : '') + '</td>' +
        '<td class="num">' + esc(item.qty || '') + '<small>' + esc(item.unit || '') + '</small></td>' + cells + '</tr>';
    }).join('');

    const table = type.table
      ? '<table class="ba-items"><thead><tr><th>#</th><th>Ürün / hizmet</th><th class="num">Miktar</th>' +
        (type.money ? '<th class="num">Birim fiyat</th><th class="num">İsk.</th><th class="num">KDV</th><th class="num">Net tutar</th>'
          : '<th>Kontrol / açıklama</th>') + '</tr></thead><tbody>' + rows + '</tbody></table>'
      : '';

    let summary = '';
    if (type.money && type.table) {
      if (!showMoney) summary = '<section class="ba-totals"><p class="ba-hidden-money">Tutarları görme yetkin yok.</p></section>';
      else if (problem) summary = '<section class="ba-totals"><p class="ba-problem">' + esc(problem) + '</p></section>';
      else if (totals) {
        const rates = new Map();
        for (const row of totals.rows) rates.set(row.vat_bps, (rates.get(row.vat_bps) || 0) + row.vat_cents);
        summary = '<section class="ba-totals"><dl>' +
          '<div><dt>Brüt satır toplamı</dt><dd>' + esc(money(totals.gross_cents)) + '</dd></div>' +
          '<div><dt>Satır iskontoları</dt><dd>' + esc(money(totals.discount_cents)) + '</dd></div>' +
          '<div><dt>KDV hariç toplam</dt><dd>' + esc(money(totals.net_cents)) + '</dd></div>' +
          [...rates.entries()].sort((a, b) => a[0] - b[0]).map(([bps, sum]) =>
            '<div><dt>KDV %' + (bps / 100) + '</dt><dd>' + esc(money(sum)) + '</dd></div>').join('') +
          '<div class="ba-grand"><dt>Genel toplam</dt><dd>' + esc(money(totals.total_cents)) + '</dd></div>' +
          '</dl></section>';
      }
    }

    return '<article class="ba-sheet" data-document="' + esc(type.id) + '">' +
      '<header class="ba-head"><img class="ba-brand" src="/marka/logo/01-SVG/' + esc(draft.logo_variant_id || DEFAULT_LOGO) + '.svg" alt="Lunapot">' +
      '<div class="ba-kind"><p>LUNAPOT / İŞ EVRAKLARI</p><h1>' + esc(type.name) + '</h1><span>' + esc(no) + '</span></div></header>' +
      (draft.example ? '<div class="ba-sample">ÖRNEK / TASLAK — alanlar ve fiyatlar gösterim içindir.</div>' : '') +
      '<section class="ba-meta"><div><h2>' + esc(companyName) + '</h2>' +
      '<p>' + multiline(company.address || '[Şirket adresi]') + '</p>' +
      '<p>' + esc(contact || '[Telefon · E-posta · Web]') + '</p>' +
      '<p>' + esc(taxLine || '[Vergi dairesi / VKN]') + '</p></div>' +
      '<dl><div><dt>Tarih</dt><dd>' + esc(draft.issue_date) + '</dd></div>' +
      '<div><dt>Referans</dt><dd>' + esc(draft.reference || '—') + '</dd></div>' +
      (draft.valid_until ? '<div><dt>Geçerlilik</dt><dd>' + esc(draft.valid_until) + '</dd></div>' : '') +
      '<div><dt>Para birimi</dt><dd>TRY</dd></div></dl></section>' +
      '<section class="ba-recipient"><p class="ba-eyebrow">' + esc(type.party) + '</p>' +
      '<h2>' + esc(draft.recipient.name || '[Ad / şirket unvanı]') + '</h2>' +
      '<p>' + multiline(draft.recipient.address || '') + '</p><p>' + esc(draft.recipient.tax || '') + '</p></section>' +
      '<section class="ba-subject"><p class="ba-eyebrow">' + esc(type.subject) + '</p>' +
      '<h2>' + esc(draft.title || '[' + type.subject + ']') + '</h2></section>' +
      table + summary +
      '<section class="ba-notes"><h3>' + (type.table ? 'Notlar ve koşullar' : 'İçerik') + '</h3>' +
      '<p>' + multiline(draft.notes || '') + '</p></section>' +
      (type.money && bank ? '<section class="ba-payment"><h3>Ödeme bilgisi</h3><p>' + esc(bank) + '</p></section>' : '') +
      '<section class="ba-signatures"><div><p>' + esc(type.sign[0]) + '</p><strong>' + esc(draft.prepared || '') + '</strong></div>' +
      (type.sign[1] ? '<div><p>' + esc(type.sign[1]) + '</p><strong>' + esc(draft.approved || '') + '</strong></div>' : '') +
      '</section><footer class="ba-foot"><span>' + esc(companyName) + '</span>' +
      '<span>' + esc(type.foot || 'Lunapot / ' + type.name) + '</span></footer></article>';
  }

  // ---------- Düzenleyici ----------
  const field = (label, key, value, {type = 'text', scope = 'draft'} = {}) =>
    '<label>' + esc(label) + '<input type="' + type + '" data-ba-scope="' + scope + '" data-ba-key="' + key + '" value="' + esc(value) + '"' +
    (writable ? '' : ' disabled') + '></label>';

  function editorHtml(draft, type) {
    const parties = state.parties;
    return '<form class="ba-form" data-ba-form>' +
      '<h3>Belge bilgileri</h3><div class="ba-grid">' +
      field('Tarih', 'issue_date', draft.issue_date, {type: 'date'}) +
      (type.validity ? field('Geçerlilik', 'valid_until', draft.valid_until, {type: 'date'}) : '') +
      field('Referans', 'reference', draft.reference) +
      '<label class="ba-check"><input type="checkbox" data-ba-scope="draft" data-ba-key="example"' +
      (draft.example ? ' checked' : '') + (writable ? '' : ' disabled') + '> Örnek / taslak işareti</label>' +
      '</div>' +
      '<h3>' + esc(type.party) + '</h3><div class="ba-grid">' +
      '<label>Kayıtlı cari<select data-ba-party' + (writable ? '' : ' disabled') + '>' +
      '<option value="">— seçilmedi —</option>' +
      parties.map(party => '<option value="' + esc(party.id) + '"' + (draft.party_id === party.id ? ' selected' : '') + '>' +
        esc(party.name) + '</option>').join('') + '</select></label>' +
      field('Ad / unvan', 'name', draft.recipient.name, {scope: 'recipient'}) +
      field('Adres / iletişim', 'address', draft.recipient.address, {scope: 'recipient'}) +
      field('Vergi bilgisi', 'tax', draft.recipient.tax, {scope: 'recipient'}) +
      '</div>' +
      '<div class="ba-grid">' + field(type.subject, 'title', draft.title) + '</div>' +
      '<label>' + (type.table ? 'Notlar ve koşullar' : 'İçerik') +
      '<textarea rows="6" data-ba-scope="draft" data-ba-key="notes"' + (writable ? '' : ' disabled') + '>' + esc(draft.notes) + '</textarea></label>' +
      '<div class="ba-grid">' + field(type.sign[0], 'prepared', draft.prepared) +
      (type.sign[1] ? field(type.sign[1], 'approved', draft.approved) : '') + '</div>' +
      '<label>Antet logosu<select data-ba-scope="draft" data-ba-key="logo_variant_id"' + (writable ? '' : ' disabled') + '>' +
      ['lunapot-yatay-antrasit', 'lunapot-yatay-siyah', 'lunapot-yatay-lime-antrasit', 'lunapot-dikey-antrasit', 'lunapot-yazi-antrasit']
        .map(id => '<option value="' + id + '"' + (draft.logo_variant_id === id ? ' selected' : '') + '>' + id + '</option>').join('') +
      '</select></label>' +
      (type.table ? linesHtml(draft, type) : '') + '</form>';
  }

  function linesHtml(draft, type) {
    return '<h3>Satırlar</h3><div class="ba-lines">' + draft.items.map((item, index) =>
      '<fieldset><legend>Satır ' + (index + 1) +
      (writable ? ' <button type="button" class="ba-remove" data-ba-remove="' + index + '" aria-label="' + (index + 1) + '. satırı sil">Sil</button>' : '') +
      '</legend><div class="ba-grid">' +
      ['name:Ürün / hizmet', 'sku:Stok kodu', 'qty:Miktar', 'unit:Birim',
        ...(type.money ? ['price:Birim fiyat (KDV hariç)', 'discount:İskonto %', 'vat:KDV %'] : ['note:Kontrol / açıklama'])]
        .map(pair => {
          const [key, label] = pair.split(':');
          return '<label>' + esc(label) + '<input data-ba-row="' + index + '" data-ba-item="' + key + '" value="' +
            esc(item[key] ?? '') + '"' + (writable ? '' : ' disabled') + '></label>';
        }).join('') + '</div></fieldset>').join('') + '</div>' +
      (writable ? '<button type="button" class="secondary" data-ba-action="line-add">+ Satır ekle</button>' : '');
  }

  function render() {
    const type = typeOf(state.type);
    const draft = state.draft;
    const kapali = type.store === 'brand' && !state.brandAvailable;
    root.innerHTML =
      '<section class="card pad ba-intro"><div class="section-heading"><div><span class="eyebrow">MARKA</span>' +
      '<h2>Belge Atölyesi</h2><p>On bir kurumsal evrak türü. Teklif ve proforma mevcut teklif kaydına yazılır; ' +
      'diğer türler kurumsal evrak defterine. Hiçbiri fatura, irsaliye ya da stok hareketi yaratmaz.</p></div>' +
      '<div class="ba-head-actions">' +
      '<button type="button" class="secondary" data-ba-action="list">Kayıtlı belgeler</button>' +
      (writable ? '<button type="button" class="secondary" data-ba-action="sample">Örnek veriyle doldur</button>' : '') +
      '</div></div>' +
      '<div class="ba-types" role="group" aria-label="Belge türü">' + TYPES.map(item =>
        '<button type="button" data-ba-type="' + esc(item.id) + '" aria-pressed="' + (item.id === state.type) + '">' +
        esc(item.name) + '</button>').join('') + '</div>' +
      (state.record ? '<p class="ba-open">Açık kayıt: <strong>' + esc(state.record.document_no) + '</strong>' +
        (state.record.revision > 1 ? ' · ' + state.record.revision + '. sürüm' : '') +
        ' · durum ' + esc(state.record.status || state.record.effective_status || 'taslak') +
        ' <button type="button" class="text-button" data-ba-action="new">Yeni boş belge</button></p>' : '') +
      (state.dirty ? '<p class="ba-dirty" role="status">Kaydedilmemiş değişiklik var.</p>' : '') +
      (state.error ? '<p class="notice" role="alert">' + esc(state.error) + '</p>' : '') +
      (state.status ? '<p class="help" role="status">' + esc(state.status) + '</p>' : '') +
      '</section>' +
      (kapali
        ? '<section class="card pad"><h3>' + esc(type.name) + ' henüz açılmadı</h3><p role="status">' +
          esc(state.brandNotice || 'Kurumsal evrak defteri kurulduğunda bu tür açılır.') + '</p></section>'
        : state.view === 'list' ? listHtml()
        : '<div class="ba-workspace"><section class="card pad ba-editor">' + editorHtml(draft, type) + '</section>' +
          '<section class="ba-preview"><div class="ba-preview-bar">' +
          (writable ? '<button type="button" class="primary" data-ba-action="save"' + (state.busy ? ' disabled' : '') + '>Sunucuya kaydet</button>' : '') +
          '<button type="button" class="secondary" data-ba-action="print">Yazdır / PDF</button>' +
          (state.record && writable ? '<button type="button" class="secondary" data-ba-action="duplicate">Çoğalt</button>' +
            '<button type="button" class="secondary" data-ba-action="revise">Yeni revizyon</button>' : '') +
          '</div>' + sheetHtml(draft, type) + '</section></div>');
  }

  function listHtml() {
    if (!state.listLoaded) return '<section class="card pad" role="status"><p>Kayıtlı belgeler yükleniyor…</p></section>';
    if (!state.list.length) return '<section class="card pad"><p>Bu türde kayıtlı belge yok. ' +
      '<button type="button" class="text-button" data-ba-action="editor">Düzenleyiciye dön</button></p></section>';
    return '<section class="card pad"><div class="section-heading"><div><h3>Kayıtlı belgeler</h3>' +
      '<p>' + state.list.length + ' kayıt · en yeni üstte.</p></div>' +
      '<button type="button" class="secondary" data-ba-action="editor">Düzenleyiciye dön</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Belge no</th><th>Tür</th><th>Başlık</th><th>Tarih</th><th>Durum</th><th></th></tr></thead><tbody>' +
      state.list.map(item => '<tr><td><strong>' + esc(item.document_no) + '</strong>' +
        (item.revision > 1 ? '<small>' + item.revision + '. sürüm</small>' : '') + '</td>' +
        '<td>' + esc(item.type_name || item.kind || '') + '</td><td>' + esc(item.title || '') + '</td>' +
        '<td>' + esc(item.issue_date || '') + '</td><td>' + esc(item.status || '') + '</td>' +
        '<td><button type="button" class="text-button" data-ba-open="' + esc(item.id) + '">Atölyede aç</button></td></tr>').join('') +
      '</tbody></table></div></section>';
  }

  // ---------- Yükleme ----------
  async function loadCompany() {
    try {
      const data = await api('/brand-profile');
      state.company = data.profile;
      state.companyAvailable = data.available !== false;
      if (!state.companyAvailable) state.status = data.notice || '';
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.company = null;
      state.companyAvailable = false;
    }
  }

  async function loadParties() {
    if (state.partiesLoaded) return;
    if (!can(user, namespace, 'ledger')) { state.partiesLoaded = true; return; }
    try {
      const data = await api('/brand-documents/lookups/parties');
      state.parties = data.parties || [];
    } catch (error) { if (error.name !== 'AbortError') state.parties = []; }
    state.partiesLoaded = true;
  }

  async function probeBrandStore() {
    try {
      const data = await api('/brand-documents?type=antet');
      state.brandAvailable = data.available !== false;
      state.brandNotice = data.notice || '';
    } catch (error) {
      if (error.name === 'AbortError') return;
      // Göç gelmediyse modül kapalı sayılır; ekranın tamamı çökmez.
      state.brandAvailable = false;
      state.brandNotice = error.message;
    }
  }

  async function loadList() {
    const type = typeOf(state.type);
    state.listLoaded = false;
    render();
    try {
      if (type.store === 'offers') {
        const data = await api('/offers?kind=' + type.kind);
        state.list = (data.offers || []).map(offer => ({
          id: offer.id, document_no: offer.document_no, revision: offer.revision,
          type_name: type.name, title: offer.title, issue_date: offer.issue_date,
          status: offer.effective_status || offer.status
        }));
      } else {
        const data = await api('/brand-documents?type=' + type.id);
        state.list = (data.items || []).map(item => ({
          id: item.id, document_no: item.document_no, revision: item.revision,
          type_name: item.type_name, title: item.title, issue_date: item.issue_date, status: item.status
        }));
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.list = [];
      state.error = error.message;
    }
    state.listLoaded = true;
    render();
  }

  // Açılan belgenin tarihleri ve muhatabı KAYITTAN gelir; bugünün tarihiyle ezilmez.
  function draftFromOffer(record) {
    const snapshot = record.snapshot || {};
    const presentation = snapshot.presentation || {};
    const recipient = presentation.recipient_snapshot || {};
    const party = snapshot.party || {};
    return {
      title: snapshot.title || '', issue_date: snapshot.issue_date || '',
      valid_until: snapshot.valid_until || '', reference: presentation.reference || '',
      party_id: record.party_id || '',
      recipient: {
        name: recipient.name || party.name || '',
        address: recipient.address || party.address || '',
        tax: recipient.tax || party.tax_id || ''
      },
      notes: snapshot.terms || '', prepared: presentation.prepared || '', approved: presentation.approved || '',
      example: presentation.example === true,
      logo_variant_id: presentation.logo_variant_id || DEFAULT_LOGO,
      items: (snapshot.totals?.rows || []).map((row, index) => ({
        name: row.description || '', sku: (presentation.line_metadata || []).find(x => x.index === index)?.sku || '',
        qty: String((row.quantity_milli ?? 0) / 1000), unit: row.unit || '',
        price: row.unit_price_cents === null || row.unit_price_cents === undefined ? '' : String(row.unit_price_cents / 100),
        discount: String((row.discount_bps ?? 0) / 100), vat: String((row.vat_bps ?? 0) / 100),
        note: '', product_id: row.product_id ?? null
      }))
    };
  }

  function draftFromBrand(record) {
    const content = record.content || {};
    const presentation = record.presentation || {};
    const recipient = content.recipient_snapshot || {};
    const spec = typeOf(record.type);
    return {
      title: content.title || '', issue_date: content.issue_date || '',
      valid_until: content.valid_until || '', reference: content.reference || '',
      party_id: record.party_id || '',
      recipient: {name: recipient.name || '', address: recipient.address || '', tax: recipient.tax || ''},
      notes: content.notes || '', prepared: content.prepared || '', approved: content.approved || '',
      example: content.example === true,
      logo_variant_id: presentation.logo_variant_id || DEFAULT_LOGO,
      items: (content.lines || []).map((row, index) => ({
        name: row.description || '', sku: '',
        qty: String((row.quantity_milli ?? 0) / 1000), unit: row.unit || '',
        price: spec.money ? (row.unit_price_cents === null || row.unit_price_cents === undefined ? '' : String(row.unit_price_cents / 100)) : '',
        discount: spec.money ? String((row.discount_bps ?? 0) / 100) : '0',
        vat: spec.money ? String((row.vat_bps ?? 0) / 100) : '20',
        note: row.note || (content.line_notes || []).find(x => x.index === index)?.note || '',
        product_id: row.product_id ?? null
      }))
    };
  }

  async function openRecord(id) {
    state.busy = true; state.error = ''; render();
    try {
      // Hangi defterde olduğunu açık türden biliyoruz; teklif ekranından gelen bağlantı da buraya düşer.
      const type = typeOf(state.type);
      if (type.store === 'offers') {
        const record = await api('/offers/' + id);
        state.type = record.kind === 'proforma' ? 'proforma' : 'teklif';
        state.record = record;
        state.draft = draftFromOffer(record);
      } else {
        const record = await api('/brand-documents/' + id);
        state.type = record.type;
        state.record = record;
        state.draft = draftFromBrand(record);
      }
      state.dirty = false; state.view = 'editor';
      state.status = 'Belge açıldı. Kaydedene kadar sunucudaki kayıt değişmez.';
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.error = error.message;
    }
    state.busy = false;
    if (!state.disposed) render();
  }

  async function save() {
    const type = typeOf(state.type);
    const draft = state.draft;
    state.error = ''; state.status = '';
    if (!writable) { state.error = 'Bu belgeyi kaydetme yetkin yok.'; render(); return; }
    let lines;
    try { lines = canonicalLines(draft, type); }
    catch (error) { state.error = error.message; render(); return; }
    if (!String(draft.title || '').trim()) { state.error = type.subject + ' alanını yaz.'; render(); return; }
    // Geçerlilik offers'ta ZORUNLU: atölyeden boş gelirse kaydetmeden önce açık hata.
    if (type.validity && !draft.valid_until) {
      state.error = 'Geçerlilik tarihi gerekir. Teklif ve proforma kaydı bu alanı zorunlu tutar.';
      render(); return;
    }
    if (type.store === 'offers' && !draft.party_id) {
      state.error = 'Teklif ve proforma için kayıtlı bir cari seçmelisin. Metin eşleşmesiyle yeni cari oluşturulmaz.';
      render(); return;
    }
    state.busy = true; render();
    try {
      if (type.store === 'offers') {
        const presentation = {
          ...presentationOf(draft),
          recipient_snapshot: {name: draft.recipient.name, address: draft.recipient.address,
            contact: '', tax: draft.recipient.tax, bank: ''},
          reference: draft.reference, prepared: draft.prepared, approved: draft.approved,
          example: draft.example,
          line_metadata: draft.items.map((item, index) => ({index, sku: String(item.sku || '').trim()}))
            .filter(entry => entry.sku)
        };
        const body = {
          kind: type.kind, party_id: draft.party_id, title: draft.title,
          issue_date: draft.issue_date, valid_until: draft.valid_until,
          terms: draft.notes, lines, presentation
        };
        state.record = state.record && state.record.status === 'draft'
          ? await api('/offers/' + state.record.id, body)
          : await api('/offers', body);
        state.draft = draftFromOffer(state.record);
      } else {
        const content = {
          title: draft.title, issue_date: draft.issue_date,
          valid_until: draft.valid_until || null, currency: 'TRY', reference: draft.reference,
          recipient_snapshot: {name: draft.recipient.name, address: draft.recipient.address,
            contact: '', tax: draft.recipient.tax, bank: ''},
          notes: draft.notes, prepared: draft.prepared, approved: draft.approved,
          example: draft.example, lines
        };
        const body = {type: type.id, content, presentation: presentationOf(draft),
          ...(draft.party_id ? {party_id: draft.party_id} : {})};
        state.record = state.record && state.record.status === 'draft'
          ? await api('/brand-documents/' + state.record.id, {content, presentation: presentationOf(draft), expected_revision: state.record.revision})
          : await api('/brand-documents', body);
        state.draft = draftFromBrand(state.record);
      }
      state.dirty = false;
      state.status = 'Kaydedildi: ' + state.record.document_no +
        (state.record.revision > 1 ? ' · ' + state.record.revision + '. sürüm' : '') + '.';
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.error = error.message;
    }
    state.busy = false;
    if (!state.disposed) render();
  }

  async function recordAction(action) {
    if (!state.record || !writable) return;
    const type = typeOf(state.type);
    state.busy = true; state.error = ''; render();
    try {
      if (type.store === 'offers') {
        if (action === 'duplicate') {
          // Offers'ta çoğaltma ayrı uç değildir: aynı içerikle yeni belge açılır.
          state.record = null;
          state.status = 'Kopya hazır. Kaydedince yeni belge numarası verilir.';
        } else {
          const body = {
            kind: type.kind, party_id: state.draft.party_id, title: state.draft.title,
            issue_date: state.draft.issue_date, valid_until: state.draft.valid_until,
            terms: state.draft.notes, lines: canonicalLines(state.draft, type),
            supersedes: state.record.id
          };
          state.record = await api('/offers', body);
          state.draft = draftFromOffer(state.record);
          state.status = 'Yeni revizyon alındı: ' + state.record.revision + '. sürüm.';
        }
      } else {
        state.record = action === 'duplicate'
          ? await api('/brand-documents/' + state.record.id + '/duplicate', {})
          : await api('/brand-documents/' + state.record.id + '/revisions', {});
        state.draft = draftFromBrand(state.record);
        state.status = action === 'duplicate'
          ? 'Çoğaltıldı: ' + state.record.document_no + '.'
          : 'Yeni revizyon: ' + state.record.revision + '. sürüm.';
      }
      state.dirty = false;
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.error = error.message;
    }
    state.busy = false;
    if (!state.disposed) render();
  }

  async function printSheet() {
    const {printDocument} = await import('./doc-engine.js');
    if (state.disposed) return;
    const type = typeOf(state.type);
    printDocument(sheetHtml(state.draft, type), {title: type.name, bodyClass: 'ba-print'});
  }

  // ---------- Olaylar: YALNIZ modül köküne bağlı ----------
  root.addEventListener('click', event => {
    const typeButton = event.target.closest('[data-ba-type]');
    if (typeButton) {
      const next = typeButton.dataset.baType;
      if (next === state.type) return;
      if (state.dirty && !confirm('Kaydedilmemiş değişiklik var. Tür değiştirirsen bu taslak kaybolur. Devam edilsin mi?')) return;
      state.type = next; state.record = null; state.draft = freshDraft(next);
      state.dirty = false; state.error = ''; state.status = ''; state.view = 'editor';
      render(); return;
    }
    const open = event.target.closest('[data-ba-open]');
    if (open) { openRecord(open.dataset.baOpen); return; }
    const remove = event.target.closest('[data-ba-remove]');
    if (remove && writable) {
      const index = Number(remove.dataset.baRemove);
      if (state.draft.items.length > 1) { state.draft.items.splice(index, 1); state.dirty = true; render(); }
      return;
    }
    const action = event.target.closest('[data-ba-action]')?.dataset.baAction;
    if (!action) return;
    if (action === 'line-add' && writable) { state.draft.items.push(blankItem()); state.dirty = true; render(); return; }
    if (action === 'save') { save(); return; }
    if (action === 'print') { printSheet(); return; }
    if (action === 'duplicate' || action === 'revise') { recordAction(action === 'duplicate' ? 'duplicate' : 'revise'); return; }
    if (action === 'list') { state.view = 'list'; loadList(); return; }
    if (action === 'editor') { state.view = 'editor'; render(); return; }
    if (action === 'new') {
      if (state.dirty && !confirm('Kaydedilmemiş değişiklik var. Yeni boş belge açılsın mı?')) return;
      state.record = null; state.draft = freshDraft(state.type); state.dirty = false;
      state.error = ''; state.status = ''; render(); return;
    }
    // Örnek veri AYRI moddur: boş yeni belgeye örnek fiyat kendiliğinden girmez.
    if (action === 'sample' && writable) {
      if (state.dirty && !confirm('Kaydedilmemiş değişiklik var. Örnek veriyle değiştirilsin mi?')) return;
      state.record = null; state.draft = freshDraft(state.type, {sample: true}); state.dirty = true;
      state.status = 'Örnek veri yüklendi. Bu bir gösterimdir; kaydetmeden önce gerçek bilgileri yaz.';
      render();
    }
  }, {signal});

  root.addEventListener('input', event => {
    const target = event.target;
    if (!writable) return;
    if (target.dataset.baScope) {
      const bucket = target.dataset.baScope === 'recipient' ? state.draft.recipient : state.draft;
      bucket[target.dataset.baKey] = target.type === 'checkbox' ? target.checked : target.value;
      state.dirty = true;
      refreshPreview();
      return;
    }
    if (target.dataset.baItem) {
      state.draft.items[Number(target.dataset.baRow)][target.dataset.baItem] = target.value;
      state.dirty = true;
      refreshPreview();
    }
  }, {signal});

  root.addEventListener('change', event => {
    const target = event.target;
    if (!writable) return;
    if (target.hasAttribute('data-ba-party')) {
      const party = state.parties.find(item => item.id === target.value);
      state.draft.party_id = target.value;
      // Seçilen carinin anlık kopyası belgeye yazılır; sonradan kart değişse belge değişmez.
      if (party) state.draft.recipient = {
        name: party.name || '',
        address: [party.address, party.contact, party.phone, party.email].filter(Boolean).join('\n'),
        tax: party.tax_id || ''
      };
      state.dirty = true;
      render();
      return;
    }
    if (target.dataset.baScope === 'draft' && target.dataset.baKey === 'logo_variant_id') {
      state.draft.logo_variant_id = target.value; state.dirty = true; render();
    }
  }, {signal});

  root.addEventListener('submit', event => { if (event.target.matches('[data-ba-form]')) event.preventDefault(); }, {signal});

  // Önizlemeyi tek başına yeniler: her tuşta bütün formu yeniden kurup imleci kaybetmez.
  function refreshPreview() {
    const type = typeOf(state.type);
    const preview = $('.ba-preview .ba-sheet');
    if (preview) preview.outerHTML = sheetHtml(state.draft, type);
    const dirty = $('.ba-dirty');
    if (state.dirty && !dirty) {
      const intro = $('.ba-intro .section-heading');
      intro?.insertAdjacentHTML('afterend', '<p class="ba-dirty" role="status">Kaydedilmemiş değişiklik var.</p>');
    }
  }

  // Route üstündeki ?offer=<id> ile Teklif ekranından gelen bağlantı aynı kaydı açar.
  function openFromHash() {
    const [route, query = ''] = location.hash.slice(1).split('?');
    if (route !== 'belge-atolyesi') return false;
    const params = new URLSearchParams(query);
    const offer = params.get('offer');
    const brand = params.get('belge');
    const tur = params.get('tur');
    if (tur && TYPES.some(type => type.id === tur)) state.type = tur;
    if (offer) { state.type = state.type === 'proforma' ? 'proforma' : 'teklif'; openRecord(offer); return true; }
    if (brand) { openRecord(brand); return true; }
    return false;
  }

  state.draft = freshDraft(state.type);
  root.innerHTML = '<section class="card pad" role="status"><p>Belge Atölyesi yükleniyor…</p></section>';
  (async () => {
    await Promise.all([loadCompany(), loadParties(), probeBrandStore()]);
    if (state.disposed) return;
    if (!openFromHash()) render();
  })();

  const dispose = () => { state.disposed = true; controller.abort(); };
  dispose.onHash = () => { if (!state.disposed) openFromHash(); };
  return dispose;
}
