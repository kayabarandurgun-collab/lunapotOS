// Teklif / proforma / sözleşme belgesinin içeriği. Saf dönüşüm: ekran, PDF, Word,
// Excel, CSV ve yazdırma AYNI kaynaktan üretilir. Tutar yetkisi kapalıysa tutarlar
// null gelir ve sıfır yazılmaz.
import {OFFER_KINDS, OFFER_STATUS, effectiveStatus} from './offer-math.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const HIDDEN = 'Görme yetkiniz yok';

export const money = cents => cents === null || cents === undefined
  ? HIDDEN
  : new Intl.NumberFormat('tr-TR', {style: 'currency', currency: 'TRY'}).format(cents / 100);

const lira = cents => cents === null || cents === undefined ? '' : cents / 100;
const quantity = milli => milli === null || milli === undefined ? '' : milli / 1000;
const quantityText = (milli, unit) => milli === null || milli === undefined
  ? HIDDEN
  : new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 3}).format(milli / 1000) + ' ' + (unit || '');
const percent = bps => bps === null || bps === undefined ? '' : '%' + new Intl.NumberFormat('tr-TR', {maximumFractionDigits: 2}).format(bps / 100);

const dayText = value => { const [y, m, d] = String(value || '').split('-'); return d ? `${d}.${m}.${y}` : ''; };

export const kindName = kind => OFFER_KINDS[kind] || kind;
export const statusName = (offer, todayIso) => OFFER_STATUS[effectiveStatus(offer, todayIso)] || offer.status;

// Geçerlilik günü hem satırda hem dondurulmuş görüntüde bulunur. Aynı gerçeğin iki
// kaynağı olmasın diye belge üretiminde tek bir birleşik kayıt kullanılır; aksi hâlde
// biri boş kaldığında belge "süresi doldu" demeyi sessizce unutur.
const merged = ({offer, snapshot}) => ({
  ...offer,
  valid_until: offer.valid_until ?? snapshot.valid_until ?? null
});

const LINE_COLUMNS = [
  {header: 'Açıklama', width: 32}, {header: 'Miktar', width: 13}, {header: 'Birim fiyat', width: 14},
  {header: 'İskonto', width: 9}, {header: 'Net', width: 14}, {header: 'KDV', width: 9}, {header: 'Toplam', width: 15}
];

const lineRows = totals => totals.rows.map(row => [
  row.description,
  quantityText(row.quantity_milli, row.unit),
  money(row.unit_price_cents),
  row.discount_bps ? percent(row.discount_bps) : '—',
  money(row.net_cents),
  percent(row.vat_bps),
  money(row.total_cents)
]);

const summaryPairs = totals => {
  const pairs = [['Ara toplam', money(totals.gross_cents)]];
  if (totals.discount_cents) pairs.push(['İskonto', money(totals.discount_cents)]);
  pairs.push(['KDV hariç toplam', money(totals.net_cents)]);
  for (const rate of totals.vat_breakdown || []) pairs.push([`KDV ${percent(rate.vat_bps)}`, money(rate.vat_cents)]);
  pairs.push(['Genel toplam', money(totals.total_cents)]);
  return pairs;
};

const headPairs = (offer, snapshot, todayIso) => {
  const pairs = [
    ['Belge', `${offer.document_no} · ${offer.revision}. sürüm`],
    ['Belge türü', kindName(offer.kind)],
    ['Durum', statusName(offer, todayIso)],
    ['Cari hesap', snapshot.party.name],
    ['VKN / TCKN', snapshot.party.tax_id || 'Kayıtlı değil'],
    ['Belge tarihi', dayText(snapshot.issue_date)]
  ];
  if (snapshot.valid_until) pairs.push(['Geçerlilik', dayText(snapshot.valid_until) + ' tarihine kadar']);
  if (offer.origin_no) pairs.push(['Kaynak belge', offer.origin_no]);
  pairs.push(['Çalışma alanı', snapshot.workspace === 'ec' ? 'E-ticaret' : 'Lunapot üretim']);
  return pairs;
};

const ACCEPT_NOTICE = 'Bu belgenin indirilmesi, yazdırılması veya karşı tarafa iletilmesi kabul ya da imza anlamına gelmez.';

/** PDF ve Word için ortak blok listesi. */
export function offerBlocks(payload) {
  const {snapshot, today: todayIso} = payload, offer = merged(payload);
  const blocks = [
    {type: 'keyvalue', pairs: headPairs(offer, snapshot, todayIso)},
    {type: 'heading', text: snapshot.title},
    {type: 'table', columns: LINE_COLUMNS, rows: lineRows(snapshot.totals)},
    {type: 'heading', text: 'Tutarlar'},
    {type: 'keyvalue', pairs: summaryPairs(snapshot.totals)}
  ];
  if (snapshot.terms) {
    blocks.push({type: 'heading', text: 'Koşullar'});
    for (const paragraph of String(snapshot.terms).split('\n').filter(Boolean)) blocks.push({type: 'text', text: paragraph});
  }
  if (offer.kind === 'contract') {
    blocks.push({type: 'spacer'});
    blocks.push({type: 'keyvalue', pairs: [['Satıcı · kaşe ve imza', ''], ['Alıcı · kaşe ve imza', '']]});
  }
  blocks.push({type: 'spacer'});
  blocks.push({type: 'small', text: snapshot.notice || ACCEPT_NOTICE});
  return blocks;
}

export function offerPdfDocument(payload) {
  const {snapshot} = payload, offer = merged(payload);
  return {
    title: kindName(offer.kind),
    subtitle: `${snapshot.party.name} · ${offer.document_no} · ${offer.revision}. sürüm`,
    blocks: offerBlocks(payload),
    footer: snapshot.notice || ACCEPT_NOTICE
  };
}

/** Teklif ve proformada gerçek Excel; sözleşmede de aynı motor kullanılır. */
export function offerSheets(payload) {
  const {snapshot, today: todayIso} = payload, offer = merged(payload);
  return [
    {
      name: 'Belge',
      columns: [{header: 'Bilgi', width: 30}, {header: 'Değer', width: 44}],
      rows: [
        ...headPairs(offer, snapshot, todayIso),
        ['Başlık', snapshot.title],
        ...summaryPairs(snapshot.totals),
        ['Koşullar', snapshot.terms || ''],
        ['Not', snapshot.notice || ACCEPT_NOTICE]
      ]
    },
    {
      name: 'Satırlar',
      columns: [
        {header: 'Açıklama', width: 40}, {header: 'Birim', width: 10},
        {header: 'Miktar', type: 'number', width: 12}, {header: 'Birim fiyat TL', type: 'number', width: 15},
        {header: 'İskonto %', type: 'number', width: 11}, {header: 'Net TL', type: 'number', width: 14},
        {header: 'KDV %', type: 'number', width: 10}, {header: 'KDV TL', type: 'number', width: 13},
        {header: 'Toplam TL', type: 'number', width: 15}
      ],
      rows: snapshot.totals.rows.map(row => [
        row.description, row.unit, quantity(row.quantity_milli), lira(row.unit_price_cents),
        row.discount_bps === null || row.discount_bps === undefined ? '' : row.discount_bps / 100,
        lira(row.net_cents),
        row.vat_bps === null || row.vat_bps === undefined ? '' : row.vat_bps / 100,
        lira(row.vat_cents), lira(row.total_cents)
      ])
    }
  ];
}

export function offerCsvRows({snapshot}) {
  return [
    ['Açıklama', 'Birim', 'Miktar', 'Birim fiyat TL', 'İskonto %', 'Net TL', 'KDV %', 'KDV TL', 'Toplam TL'],
    ...snapshot.totals.rows.map(row => [
      row.description, row.unit, quantity(row.quantity_milli), lira(row.unit_price_cents),
      row.discount_bps === null || row.discount_bps === undefined ? '' : row.discount_bps / 100,
      lira(row.net_cents),
      row.vat_bps === null || row.vat_bps === undefined ? '' : row.vat_bps / 100,
      lira(row.vat_cents), lira(row.total_cents)
    ])
  ];
}

/** Yazdırma her zaman beyaz kâğıt düzenini kullanır; kullanıcı koyu temadayken de okunaklıdır. */
export function offerPrintHtml(payload) {
  const {snapshot, today: todayIso} = payload, offer = merged(payload);
  const rows = lineRows(snapshot.totals);
  const signature = offer.kind === 'contract'
    ? '<h2>İmzalar</h2><table><tbody><tr><th>Satıcı · kaşe ve imza</th><td style="height:70px"></td></tr><tr><th>Alıcı · kaşe ve imza</th><td style="height:70px"></td></tr></tbody></table>'
    : '';
  return `<h1>${escapeHtml(kindName(offer.kind))}</h1>
<p class="muted">${escapeHtml(snapshot.party.name)} · ${escapeHtml(offer.document_no)} · ${offer.revision}. sürüm · ${escapeHtml(statusName(offer, todayIso))}</p>
<table><tbody>${headPairs(offer, snapshot, todayIso).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>
<h2>${escapeHtml(snapshot.title)}</h2>
<table><thead><tr>${LINE_COLUMNS.map((c, i) => `<th${i > 0 ? ' class="right"' : ''}>${escapeHtml(c.header)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(row => `<tr>${row.map((cell, i) => `<td${i > 0 ? ' class="right"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<h2>Tutarlar</h2>
<table><tbody>${summaryPairs(snapshot.totals).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td class="right">${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>
${snapshot.terms ? `<h2>Koşullar</h2>${String(snapshot.terms).split('\n').filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join('')}` : ''}
${signature}
<p class="note">${escapeHtml(snapshot.notice || ACCEPT_NOTICE)}</p>`;
}
