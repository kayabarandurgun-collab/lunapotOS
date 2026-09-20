import {can} from '../public/permissions.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const MAX_RECORDS = 20000;
const PAGE_SIZE = 50;
const NOTICE = 'Bu görünüm rapordaki bildirimleri gösterir. Banka doğrulaması yapılmadı; tutarlar tahsilat veya açık cari alacak değildir. Cari, satış ve ödeme kaydı oluşturulmaz.';
const REASONS = {
  missing_net: 'Net hakediş bildirimi yok; satıştan veya kesintilerden tahmin edilmedi.',
  conflicting_net: 'Raporlarda farklı net bildirimler var; birlikte toplanmadı.',
  ambiguous_scope: 'Birden fazla satır veya kapsam var; aynı hakedişin tekrarı olup olmadığı kesin değil.',
  incomplete_net: 'Diğer finans satırlarında net bildirim bulunmuyor; kapsamın tamamlandığı doğrulanamadı.',
  invalid_data: 'Kaynak kayıtta geçersiz veri var; tek tutar gösterilmedi.'
};
const identifier = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 200) : '';
const validCents = value => Number.isSafeInteger(value) && Math.abs(value) <= 100000000000;
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const day = value.slice(0, 10), stamp = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day ? day : null;
}
function filterDate(value) {
  if (!value) return '';
  if (value.length !== 10 || date(value) !== value) fail('Tarih YYYY-AA-GG biçiminde geçerli bir gün olmalı.');
  return value;
}

// Current records only. Versions, ledger, sale and bank tables are deliberately not read.
// A physical finance row often expands to several events, EACH carrying the SAME net.
// One net observation per file+row is retained. Different rows/scopes never get summed.
function evidence(records) {
  const groups = new Map();
  for (const record of records) {
    let data;
    try { data = JSON.parse(record.data_json); } catch { data = null; }
    const invalid = !data || typeof data !== 'object' || Array.isArray(data);
    data = invalid ? {} : data;
    const order = identifier(data.order_no);
    const groupKey = order ? 'order:' + order : 'unreferenced:' + JSON.stringify([record.file_id, record.row_no]);
    let group = groups.get(groupKey);
    if (!group) {
      group = {order_no: order || null, order_records: 0, finance_records: 0, packages: new Set(), dates: new Set(), missing_date: false,
        observations: new Map(), sourceRows: new Set(), invalid: false, refund: false, payout: false};
      groups.set(groupKey, group);
    }
    group.invalid ||= invalid;
    const packageId = identifier(data.package_id);
    if (packageId) group.packages.add(packageId);
    if (record.kind === 'order_line') { group.order_records++; continue; }
    group.finance_records++;
    const eventDate = date(data.event_date);
    if (eventDate) group.dates.add(eventDate); else group.missing_date = true;
    group.refund ||= data.type === 'refund';
    group.payout ||= data.type === 'payout';
    const sourceKey = JSON.stringify([record.file_id, record.row_no]);
    group.sourceRows.add(sourceKey);
    // 'payout' is not sufficient proof of transfer. Only explicit net_payout is a net observation.
    if (data.net_payout === undefined || data.net_payout === null) continue;
    if (!validCents(data.net_payout)) { group.invalid = true; continue; }
    const scope = JSON.stringify([order, packageId, identifier(data.barcode), identifier(data.event_id)]);
    const existing = group.observations.get(sourceKey);
    if (existing) {
      if (existing.reported_net_cents !== data.net_payout || existing.scope !== scope) group.invalid = true;
      existing.event_count++;
    } else group.observations.set(sourceKey, {file_id: record.file_id, row_no: record.row_no, scope,
      event_date: eventDate, payout_date: date(data.payout_date), reported_net_cents: data.net_payout, event_count: 1});
  }
  return [...groups.values()].map(group => {
    const observations = [...group.observations.values()];
    const files = new Map();
    for (const item of observations) files.set(item.file_id, (files.get(item.file_id) || 0) + 1);
    let reason = null;
    if (group.invalid) reason = 'invalid_data';
    else if (!observations.length) reason = 'missing_net';
    else if (new Set(observations.map(item => item.reported_net_cents)).size !== 1) reason = 'conflicting_net';
    else if ([...files.values()].some(n => n > 1) || new Set(observations.map(item => item.scope)).size !== 1) reason = 'ambiguous_scope';
    else if (group.sourceRows.size !== observations.length) reason = 'incomplete_net';
    const eventDate = !group.missing_date && group.dates.size === 1 ? [...group.dates][0] : null;
    const section = !group.order_no ? 'unreferenced' : !eventDate ? 'undated' : 'dated';
    return {order_no: group.order_no, package_count: group.packages.size, order_record_count: group.order_records,
      finance_record_count: group.finance_records, event_date: eventDate, section,
      date_note: eventDate ? null : group.dates.size > 1 ? 'Farklı veya eksik işlem tarihleri; bir döneme atanmadı.' : 'İşlem tarihi bilinmiyor; sipariş veya dosya tarihi kullanılmadı.',
      reported_net_cents: reason ? null : observations[0].reported_net_cents,
      evidence_status: reason || 'consistent', reason: reason ? REASONS[reason] : 'Kaynak satırlarda aynı net bildirim; siparişe ait kesin hakediş veya tahsilat değildir.',
      has_refund: group.refund, has_payout_event: group.payout,
      source_row_count: group.sourceRows.size, net_observation_count: observations.length,
      // Bounded source pointers; no raw cells, source filenames or contact details in this response.
      observations: observations.slice(0, 12).map(({scope, ...item}) => item), observations_truncated: observations.length > 12};
  });
}

export async function marketplaceReceivablesApi(request, env, path, readBody) {
  if (!path.startsWith('/api/marketplace-receivables')) return null;
  if (path !== '/api/marketplace-receivables') fail('İstek bulunamadı.', 404);
  if (env.WORKSPACE !== 'ec' || request.method !== 'GET') fail('Bu görünüm yalnız e-ticarette okunabilir.', 403);
  if (!env.USER?.owner && !(can(env.USER, 'ec', 'ledger') && can(env.USER, 'ec', 'orders')))
    fail('Cari ve sipariş görüntüleme yetkileri birlikte gerekli.', 403);
  const url = new URL(request.url), storeId = url.searchParams.get('store_id') || '';
  if (storeId && !/^[\w-]{1,100}$/.test(storeId)) fail('Mağaza seçimi geçersiz.');
  const from = filterDate(url.searchParams.get('from')), to = filterDate(url.searchParams.get('to'));
  if (from && to && from > to) fail('Başlangıç tarihi bitişten sonra olamaz.');
  const section = url.searchParams.get('section') || 'all';
  if (!['all', 'dated', 'undated', 'unreferenced'].includes(section)) fail('Görünüm seçimi geçersiz.');
  const page = Number(url.searchParams.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail('Sayfa geçersiz.');
  const stores = (await env.DB.prepare('SELECT s.id,s.provider,s.name,COUNT(r.id) record_count FROM ec_report_stores s LEFT JOIN ec_report_records r ON r.store_id=s.id GROUP BY s.id ORDER BY s.provider,s.name,s.id').all()).results;
  const selected = stores.find(store => store.id === storeId);
  if (storeId && !selected) fail('Rapor mağazası bulunamadı.', 404);
  const base = {stores, store_id: storeId || null, currency: 'TRY', bank_verified: false, posting: false,
    notice: NOTICE, bank_href: '/eticaret/#bank', filters: {from, to, section}};
  if (!storeId) return {...base, rows: [], summary: null, pagination: {page: 1, page_size: PAGE_SIZE, total: 0, pages: 1}};
  const records = (await env.DB.prepare('SELECT r.id,r.kind,r.data_json,r.file_id,r.row_no FROM ec_report_records r JOIN ec_report_stores s ON s.id=r.store_id WHERE s.id=? ORDER BY r.id LIMIT ?').bind(storeId, MAX_RECORDS + 1).all()).results;
  if (records.length > MAX_RECORDS) fail('Bu mağazanın rapor kayıtları bu görünümün sınırını aşıyor. Eksik toplam gösterilmedi.', 409);
  const groups = evidence(records);
  const dated = groups.filter(row => row.section === 'dated');
  const period = dated.filter(row => (!from || row.event_date >= from) && (!to || row.event_date <= to));
  // net_payout has no proven payment/settlement scope. NEVER sum it across orders,
  // packages or stores, even when row-level observations happen to agree.
  const visible = [...period, ...groups.filter(row => row.section !== 'dated')];
  const rows = (section === 'all' ? visible : section === 'dated' ? period : groups.filter(row => row.section === section))
    .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')) || String(a.order_no || '').localeCompare(String(b.order_no || '')));
  const actualPage = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  return {...base, summary: {order_count: groups.filter(row => row.order_no).length, dated_count: period.length,
    undated_count: groups.filter(row => row.section === 'undated').length, unreferenced_count: groups.filter(row => row.section === 'unreferenced').length,
    outside_period_count: dated.length - period.length, consistent_count: visible.filter(row => row.evidence_status === 'consistent').length,
    unresolved_count: visible.filter(row => row.evidence_status !== 'consistent').length,
    scope_note: 'Net bildirimlerin sipariş, paket veya ödeme grubu kapsamı doğrulanmadığı için genel tutar toplamı hesaplanmaz. Tarihsiz kayıtlar herhangi bir döneme atanmaz.'},
    rows: rows.slice((actualPage - 1) * PAGE_SIZE, actualPage * PAGE_SIZE),
    pagination: {page: actualPage, page_size: PAGE_SIZE, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / PAGE_SIZE))}};
}
