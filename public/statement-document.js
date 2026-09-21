// Mutabakat belgesinin içeriği. Saf dönüşüm: ekrandaki ekstre ile PDF, Excel,
// Word, CSV ve yazdırma çıktısı AYNI kaynaktan üretilir; biri diğerinden sapmaz.
// Tutar yetkisi kapalı kullanıcıda tutarlar null gelir; sıfır yazılmaz.
import {balanceWording} from './party-statement.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

export const STATUS_NAMES = {
  draft: 'Taslak',
  sent: 'Karşı tarafa iletildi',
  agreed: 'Mutabık kalındı',
  disputed: 'İhtilaflı',
  cancelled: 'İptal edildi'
};

const HIDDEN = 'Görme yetkiniz yok';

export const money = cents => cents === null || cents === undefined
  ? HIDDEN
  : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(cents / 100);

// Excel ve CSV sayısal sütunları için: gizlenen tutar boş kalır, sıfıra dönmez.
const lira = cents => cents === null || cents === undefined ? '' : cents / 100;

const dayText = value => {
  if (!value) return '';
  const [year, month, day] = String(value).split('-');
  return day ? `${day}.${month}.${year}` : String(value);
};

// Ek ünlü uyumuna göre değişir: "alacağımızdır" ama "borcumuzdur".
const BALANCE_CLAUSE = {'bizim alacağımız': 'bizim alacağımızdır', 'bizim borcumuz': 'bizim borcumuzdur'};

export function balanceSentence(closing_cents) {
  if (closing_cents === null || closing_cents === undefined)
    return 'Dönem sonu bakiyesini görme yetkiniz yok.';
  if (closing_cents === 0) return 'Dönem sonunda iki taraf arasında bakiye kalmamıştır.';
  return `Dönem sonu bakiyesi ${money(Math.abs(closing_cents))} tutarında ${BALANCE_CLAUSE[balanceWording(closing_cents)]}.`;
}

/** Ekranda ve uyarılarda eksi işareti yerine yönü kelimeyle söyler. */
export function balancePhrase(cents) {
  if (cents === null || cents === undefined) return money(null);
  if (cents === 0) return 'bakiye yok';
  return `${money(Math.abs(cents))} ${balanceWording(cents)}`;
}

export function differenceSentence(difference) {
  if (!difference || difference.status === 'unknown')
    return 'Karşı taraf kendi bakiyesini henüz bildirmedi. Bu tutar sıfır değil, bilinmiyor.';
  if (difference.status === 'agreed') return 'Karşı tarafın bildirdiği bakiye bu belgeyle örtüşmektedir.';
  return `Karşı tarafın bildirdiği bakiye ile aramızda ${money(Math.abs(difference.difference_cents))} fark vardır. Farkın nedeni açıklanmadan mutabık sayılmaz.`;
}

const heading = (party, meta) => {
  const number = meta.document_no ? `${meta.document_no} · ${meta.revision}. sürüm` : 'Kaydedilmemiş ekstre';
  return {number, status: meta.document_no ? (STATUS_NAMES[meta.status] || meta.status) : 'Kaydedilmedi'};
};

const summaryPairs = (statement, difference, meta) => {
  const pairs = [
    ['Dönem', `${dayText(statement.from)} – ${dayText(statement.to)}`],
    ['Devir', money(statement.opening_cents)],
    ['Dönem içi alacağımız', money(statement.debit_cents)],
    ['Dönem içi borcumuz', money(statement.credit_cents)],
    ['Dönem sonu bakiye', money(statement.closing_cents)],
    ['Hareket sayısı', String(statement.row_count)]
  ];
  if (meta.document_no) pairs.push(['Belge durumu', STATUS_NAMES[meta.status] || meta.status]);
  if (difference && difference.status !== 'unknown')
    pairs.push(['Karşı tarafın bildirdiği bakiye', money(difference.reported_common_cents)]);
  return pairs;
};

// Genişlikler oransaldır: PDF sütunları bu orana göre bölünür, Word ve yazdırma başlığı kullanır.
const TABLE_COLUMNS = [
  {header: 'Tarih', width: 9}, {header: 'Vade', width: 9}, {header: 'Referans', width: 13},
  {header: 'Açıklama', width: 28}, {header: 'Alacağımız', width: 13},
  {header: 'Borcumuz', width: 13}, {header: 'Bakiye', width: 15}
];

// Borcun NASIL kapandığı: ödeme yöntemi, serbest not, çek vadesi, kapattığı fatura
// numaraları ve borç satırında ödenen/kalan. Tutar gizliyse numara yine yazılır; sıfır uydurulmaz.
const METHOD_NAMES = {nakit: 'Nakit', kart: 'Kart', havale: 'Havale-EFT', cek: 'Çek'};
// compact: dar ekranda tablo satırı için. Belge ve çıktılarda kısaltma yapılmaz, hepsi yazılır.
const COMPACT_NOTE = 40, COMPACT_INVOICES = 3;
const shorten = (value, max) => String(value ?? '').length > max ? String(value).slice(0, max - 1) + '…' : String(value ?? '');
export function settlementNote(row = {}, compact = false) {
  const parts = [];
  if (row.payment_method) parts.push(METHOD_NAMES[row.payment_method] || 'Ödeme');
  if (row.payment_note) parts.push(compact ? shorten(row.payment_note, COMPACT_NOTE) : row.payment_note);
  if (row.payment_due_on) parts.push('vade ' + dayText(row.payment_due_on));
  if (row.closed_invoices && row.closed_invoices.length) {
    const all = row.closed_invoices, shown = compact ? all.slice(0, COMPACT_INVOICES) : all;
    const rest = all.length - shown.length;
    parts.push('kapattığı fatura: ' + shown.map(item => {
      const no = item.invoice_no || 'Belge';
      return item.amount_cents === null || item.amount_cents === undefined ? no : `${no} ${money(item.amount_cents)}`;
    }).join(', ') + (rest > 0 ? ` ve ${rest} fatura daha` : ''));
  }
  if (row.payable_cents && row.paid_cents) parts.push('ödenen ' + money(row.paid_cents) + ' · kalan ' + money(row.remaining_cents));
  if (row.planned_on) parts.push('ödeyeceğim ' + dayText(row.planned_on));
  return parts.join(' · ');
}

const describe = row => {
  const note = settlementNote(row);
  return note ? `${row.description || ''} — ${note}` : (row.description || '');
};

const tableRows = statement => statement.rows.map(row => [
  dayText(row.occurred_on),
  dayText(row.due_on) || '—',
  row.reference || '',
  describe(row),
  row.receivable_cents ? money(row.receivable_cents) : (row.receivable_cents === null ? HIDDEN : '—'),
  row.payable_cents ? money(row.payable_cents) : (row.payable_cents === null ? HIDDEN : '—'),
  money(row.running_cents)
]);

/** PDF ve Word için ortak blok listesi. */
export function statementBlocks({party, workspace, statement, difference, meta = {}}) {
  const info = heading(party, meta);
  const blocks = [
    {type: 'keyvalue', pairs: [
      ['Cari hesap', party.name],
      ['VKN / TCKN', party.tax_id || 'Kayıtlı değil'],
      ['Çalışma alanı', workspace === 'ec' ? 'E-ticaret' : 'Lunapot üretim'],
      ['Belge', info.number],
      ['Durum', info.status]
    ]},
    {type: 'heading', text: 'Dönem özeti'},
    {type: 'keyvalue', pairs: summaryPairs(statement, difference, meta)},
    {type: 'text', text: balanceSentence(statement.closing_cents)},
    {type: 'text', text: differenceSentence(difference)}
  ];
  if (meta.ledger_changed)
    blocks.push({type: 'text', text: 'Uyarı: Bu belge kaydedildikten sonra deftere bu döneme ait yeni kayıt girilmiştir. Belge değiştirilmemiştir; güncel durum için yeni sürüm alınmalıdır.'});
  blocks.push({type: 'heading', text: 'Hesap hareketleri'});
  blocks.push(statement.rows.length
    ? {type: 'table', columns: TABLE_COLUMNS, rows: tableRows(statement)}
    : {type: 'text', text: 'Bu dönemde hareket bulunmamaktadır.'});
  blocks.push({type: 'spacer'});
  blocks.push({type: 'small', text: 'Bu belge indirilmekle veya iletilmekle kabul edilmiş sayılmaz. Mutabakat, karşı tarafın bakiyeyi yazılı bildirmesiyle oluşur.'});
  return blocks;
}

export function statementPdfDocument(payload) {
  const info = heading(payload.party, payload.meta || {});
  return {
    title: 'Cari mutabakat mektubu',
    subtitle: `${payload.party.name} · ${info.number}`,
    blocks: statementBlocks(payload),
    footer: payload.notice || ''
  };
}

/** Excel: özet ayrı sayfada, hareketler gerçek sayı ve tarih olarak. */
export function statementSheets({party, workspace, statement, difference, meta = {}, notice = ''}) {
  const info = heading(party, meta);
  return [
    {
      name: 'Özet',
      columns: [{header: 'Bilgi', width: 34}, {header: 'Değer', width: 40}],
      rows: [
        ['Cari hesap', party.name],
        ['VKN / TCKN', party.tax_id || 'Kayıtlı değil'],
        ['Çalışma alanı', workspace === 'ec' ? 'E-ticaret' : 'Lunapot üretim'],
        ['Belge', info.number],
        ['Durum', info.status],
        ...summaryPairs(statement, difference, meta),
        ['Bakiye açıklaması', balanceSentence(statement.closing_cents)],
        ['Karşı taraf', differenceSentence(difference)],
        ['Not', notice]
      ]
    },
    {
      name: 'Hareketler',
      columns: [
        {header: 'Tarih', type: 'date', width: 12},
        {header: 'Vade', type: 'date', width: 12},
        {header: 'Referans', width: 22},
        {header: 'Açıklama', width: 46},
        {header: 'Alacağımız TL', type: 'number', width: 16},
        {header: 'Borcumuz TL', type: 'number', width: 16},
        {header: 'Bakiye TL', type: 'number', width: 16},
        {header: 'Ödeme / kapama', width: 46}
      ],
      // Sayı sütunlarının yeri korunur; ödeme açıklaması sona eklenir.
      rows: statement.rows.map(row => [
        row.occurred_on, row.due_on || '', row.reference || '', row.description || '',
        lira(row.receivable_cents), lira(row.payable_cents), lira(row.running_cents), settlementNote(row)
      ])
    }
  ];
}

export function statementCsvRows({statement}) {
  return [
    ['Tarih', 'Vade', 'Referans', 'Açıklama', 'Alacağımız TL', 'Borcumuz TL', 'Bakiye TL', 'Ödeme / kapama'],
    ...statement.rows.map(row => [
      row.occurred_on, row.due_on || '', row.reference || '', row.description || '',
      lira(row.receivable_cents), lira(row.payable_cents), lira(row.running_cents), settlementNote(row)
    ])
  ];
}

/** Yazdırma: koyu tema açıkken de okunaklı olsun diye ayrı beyaz kâğıt düzeni. */
export function statementPrintHtml(payload) {
  const {party, workspace, statement, difference, meta = {}, notice = ''} = payload;
  const info = heading(party, meta);
  const rows = tableRows(statement);
  const pairs = summaryPairs(statement, difference, meta);
  const warning = meta.ledger_changed
    ? '<p class="note">Bu belge kaydedildikten sonra deftere bu döneme ait yeni kayıt girilmiştir. Belge değiştirilmemiştir; güncel durum için yeni sürüm alınmalıdır.</p>'
    : '';
  return `<h1>Cari mutabakat mektubu</h1>
<p class="muted">${escapeHtml(party.name)} · ${escapeHtml(info.number)} · ${escapeHtml(info.status)} · ${escapeHtml(workspace === 'ec' ? 'E-ticaret' : 'Lunapot üretim')}</p>
<p class="muted">VKN / TCKN: ${escapeHtml(party.tax_id || 'Kayıtlı değil')}</p>
${warning}
<h2>Dönem özeti</h2>
<table><tbody>${pairs.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>
<p>${escapeHtml(balanceSentence(statement.closing_cents))}</p>
<p>${escapeHtml(differenceSentence(difference))}</p>
<h2>Hesap hareketleri</h2>
${rows.length
    ? `<table><thead><tr>${TABLE_COLUMNS.map((c, i) => `<th${i > 3 ? ' class="right"' : ''}>${escapeHtml(c.header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, i) => `<td${i > 3 ? ' class="right"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p>Bu dönemde hareket bulunmamaktadır.</p>'}
<p class="muted">${escapeHtml(notice)}</p>
<p class="muted">Bu belge indirilmekle veya iletilmekle kabul edilmiş sayılmaz. Mutabakat, karşı tarafın bakiyeyi yazılı bildirmesiyle oluşur.</p>`;
}
