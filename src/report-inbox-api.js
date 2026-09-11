// Rapor Kutusu uçları — pazaryeri Excel raporları. YALNIZCA e-ticaret (ec) çalışma alanı.
//
//   GET  /api/ec/reports                         mağazalar, son dosyalar, açık inceleme sayısı
//   POST /api/ec/reports/stores                  {provider, code, name}
//   GET  /api/ec/reports/profiles?provider&kind&signature
//   POST /api/ec/reports/profiles                {provider, kind, headers, mapping, options}
//   POST /api/ec/reports/profiles/:id/verify     gerçek dosyayla karşılaştırıldı işareti (yönetici)
//   POST /api/ec/reports/files                   dosya kaydı (aynı dosya → 409)
//   POST /api/ec/reports/files/:id/chunk         ham dosya parçası (denetim için)
//   POST /api/ec/reports/files/:id/rows          kaynak satırlar (parti)
//   POST /api/ec/reports/files/:id/seal          özet ve satır sayısı doğrulanır, dosya kilitlenir
//   GET  /api/ec/reports/files/:id/preview       yeni/güncel/aynı/eski/inceleme sayıları (yazmaz)
//   POST /api/ec/reports/files/:id/apply         sıradaki partiyi işler (kaldığı yerden devam)
//   GET  /api/ec/reports/reviews                 açık incelemeler
//   POST /api/ec/reports/reviews/:id             {decision:'accept'|'reject'}
//   GET  /api/ec/reports/orders?store_id         sipariş sonuçları (dört ayrı sayı)
//   GET  /api/ec/reports/evidence-candidates     kanıt olarak bağlanabilecek fatura satırları
//   POST /api/ec/reports/records/:id/evidence    {invoice_line_id} gider kanıtı (ikinci gider yok)
//
// Bu dosya stok hareketi, sevkiyat, satış kaydı veya fatura OLUŞTURMAZ; pazaryeri API'si çağırmaz.
import {FIELDS, PROVIDERS, EVENT_TYPES, FEE_TYPES, headerSignature, normalizeRows, compareVersions, contentHash, exVat, observedEstimate} from '../public/report-core.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const text = (v, label, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(label + ' alanını kontrol edin.'); return v.trim(); };
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Kayıt seçimi geçersiz.'); return v; };
export const CHUNK_B64_MAX = 700000;           // ~512 KB ham parça
export const ROWS_PER_CALL = 500;
export const APPLY_BATCH = 200;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const inChunks = (list, size) => Array.from({length: Math.ceil(list.length / size)}, (_, i) => list.slice(i * size, i * size + size));

async function loadFile(db, fileId) {
  const f = await db.prepare('SELECT f.*,s.provider,s.code store_code,s.name store_name FROM ec_report_files f JOIN ec_report_stores s ON s.id=f.store_id WHERE f.id=?').bind(key(fileId)).first();
  if (!f) fail('Rapor dosyası bulunamadı.', 404);
  return f;
}
async function loadProfile(db, f) {
  const p = f.profile_id ? await db.prepare('SELECT * FROM ec_report_profiles WHERE id=?').bind(f.profile_id).first() : null;
  if (!p) fail('Bu dosya için onaylı sütun eşleştirmesi yok.', 409);
  return {...p, kind: p.kind, mapping: parse(p.mapping_json, {}), ...parse(p.options_json, {})};
}
async function fileRows(db, fileId, from, to) {
  return (await db.prepare('SELECT row_no,cells_json FROM ec_report_rows WHERE file_id=? AND row_no>? AND row_no<=? ORDER BY row_no').bind(fileId, from, to).all()).results
    .map(r => ({row: r.row_no, cells: parse(r.cells_json, [])}));
}
async function existingRecords(db, storeId, keys) {
  const map = new Map();
  for (const part of inChunks(keys, 100)) {
    const rows = (await db.prepare("SELECT * FROM ec_report_records WHERE store_id=? AND kind||'|'||record_key IN (SELECT value FROM json_each(?))").bind(storeId, JSON.stringify(part)).all()).results;
    for (const r of rows) map.set(r.kind + '|' + r.record_key, r);
  }
  return map;
}
const locked = async (db, rec) => rec?.erp_package_id
  ? !!(await db.prepare("SELECT 1 FROM ec_order_packages WHERE id=? AND status IN ('shipped','delivered')").bind(rec.erp_package_id).first()) : false;

/** Dosyadaki kayıtları mevcut durumla karşılaştırır. Yazmaz. */
async function classify(db, f, profile, records) {
  const existing = await existingRecords(db, f.store_id, [...new Set(records.map(r => r.kind + '|' + r.key))]);
  const seenInFile = new Map();
  const out = [];
  for (const r of records) {
    const k = r.kind + '|' + r.key;
    const blocking = r.issues.filter(i => ['ambiguous_twin', 'id_precision', 'bad_value', 'missing_required', 'unknown_type', 'no_amount'].includes(i.code));
    if (blocking.length) { out.push({...r, outcome: 'review', reason: blocking[0].code, detail: blocking.map(i => i.detail).join(' ')}); continue; }
    // Aynı dosyada aynı sağlayıcı kimliği iki kez: ikincisi ilkinin sürümü sayılmaz, incelemeye.
    if (seenInFile.has(k)) { out.push({...r, outcome: 'review', reason: 'duplicate_in_file', detail: 'Aynı kimlik dosyada ' + seenInFile.get(k) + '. satırda da var.'}); continue; }
    seenInFile.set(k, r.row);
    const prior = existing.get(k);
    const result = compareVersions(prior && {data: parse(prior.data_json, {}), time: prior.source_time, locked: await locked(db, prior)}, {data: r.data, time: f.snapshot_at});
    out.push({...r, outcome: result.outcome, merged: result.data, proposed: result.proposed, prior,
      reason: result.outcome === 'review' ? (prior && await locked(db, prior) ? 'posted_changed' : 'same_time_conflict') : null,
      detail: result.outcome === 'review' ? 'Önceki bilgiyle çelişiyor ve hangisinin daha yeni olduğu kesin değil.' : ''});
  }
  return out;
}

/** ERP'de zaten var olan paket (oluşturma yok). Birden çok aday varsa bağlanmaz. */
async function erpMatch(db, provider, data) {
  const ids = [data.package_id, data.order_no].filter(Boolean);
  if (!ids.length) return {id: null};
  const rows = (await db.prepare('SELECT id FROM ec_order_packages WHERE channel=? AND (external_id IN (SELECT value FROM json_each(?)) OR order_no IN (SELECT value FROM json_each(?)))')
    .bind(provider, JSON.stringify(ids), JSON.stringify(ids)).all()).results;
  return rows.length === 1 ? {id: rows[0].id} : {id: null, ambiguous: rows.length > 1};
}

/** Barkod/SKU → sipariş tarihinde geçerli set tanımı → gerçek ürünler (anlık görüntü). */
async function componentsFor(db, provider, data) {
  const codes = [data.barcode, data.sku].filter(Boolean);
  if (!codes.length) return null;
  const at = (data.order_date || '9999-12-31').slice(0, 10) + ' 23:59:59';
  const maps = (await db.prepare("SELECT * FROM ec_catalog_mappings WHERE source=? AND match_by='code' AND match_value IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC")
    .bind(provider, JSON.stringify(codes)).all()).results;
  const valid = maps.find(m => m.created_at <= at && (!m.archived_at || m.archived_at > at));
  const chosen = valid || maps.find(m => m.active === 1);
  if (!chosen) return null;
  const comps = (await db.prepare('SELECT product_id,quantity_milli,revenue_share_bps FROM ec_catalog_mapping_components WHERE mapping_id=? ORDER BY product_id').bind(chosen.id).all()).results;
  return {mapping_id: chosen.id, mapping_version: chosen.version, after_order: !valid, components: comps.map(c => ({...c}))};
}

/* ---------------- sipariş sonuçları ---------------- */
async function unitCostAt(db, productId, date) {
  // Sipariş tarihine kadarki açılış ve alış girişlerinin ortalaması. Giriş yoksa maliyet BİLİNMİYOR.
  const r = await db.prepare("SELECT SUM(quantity_milli) q,SUM(value_cents) v FROM ec_stock_movements WHERE product_id=? AND kind IN ('opening','purchase') AND quantity_milli>0 AND occurred_on<=?")
    .bind(productId, date).first();
  return r && r.q > 0 && r.v !== null ? {cents_per_unit: r.v * 1000 / r.q, historical: true} : null;
}
async function vatOf(db, productIds) {
  const rows = (await db.prepare('SELECT product_id,vat_bps FROM ec_price_profiles WHERE product_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(productIds)).all()).results;
  const rates = [...new Set(productIds.map(p => rows.find(r => r.product_id === p)?.vat_bps ?? null))];
  return rates.length === 1 && rates[0] !== null ? rates[0] : null;
}

async function tariffEstimate(db, provider, type, line, date) {
  if (type !== 'commission' || line.gross === undefined) return null;
  const rate = await db.prepare("SELECT * FROM ec_commission_rates WHERE channel=? AND archived_at IS NULL AND valid_from<=? AND valid_to>=? AND (sku='' OR sku=?) AND price_min_cents<=? AND (price_max_cents IS NULL OR price_max_cents>?) ORDER BY sku DESC,valid_from DESC LIMIT 1")
    .bind(provider, date, date, line.sku || line.barcode || '', line.gross, line.gross).first();
  if (!rate) return null;
  const base = rate.base === 'net' && line.vat_bps !== null ? exVat(line.gross, line.vat_bps) : line.gross;
  const value = -Math.round(base * rate.rate_bps / 10000);
  return {value, low: value, high: value, samples: 0, basis: 'Tarife: ' + rate.label + ' (%' + (rate.rate_bps / 100) + ')'};
}
async function observed(db, storeId, type, code, date) {
  if (!code) return null;
  const from = new Date(Date.parse(date + 'T00:00:00Z') - 90 * 86400000).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT json_extract(data_json,'$.amount_cents') a FROM ec_report_records WHERE store_id=? AND kind='finance_event' AND json_extract(data_json,'$.type')=? AND json_extract(data_json,'$.barcode')=? AND substr(json_extract(data_json,'$.event_date'),1,10) BETWEEN ? AND ?")
    .bind(storeId, type, code, from, date).all()).results;
  const est = observedEstimate(rows.map(r => r.a));
  return est ? {...est, basis: 'Benzer gerçekleşmiş işlemler: son 90 gün, ' + est.samples + ' örnek'} : null;
}

export async function orderResults(db, storeId, {limit = 100, offset = 0} = {}) {
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);
  const lines = (await db.prepare("SELECT * FROM ec_report_records WHERE store_id=? AND kind='order_line' ORDER BY json_extract(data_json,'$.order_date') DESC,record_key LIMIT ? OFFSET ?").bind(store.id, limit, offset).all()).results;
  const groups = new Map();
  for (const l of lines) {
    const d = parse(l.data_json, {}), g = d.package_id || d.order_no;
    if (!groups.has(g)) groups.set(g, {group: g, order_no: d.order_no, package_id: d.package_id || null, order_date: d.order_date, status: d.status || null, erp_package_id: l.erp_package_id, lines: []});
    groups.get(g).lines.push({...d, id: l.id, components: parse(l.components_json, null)});
  }
  const results = [];
  for (const g of groups.values()) {
    const events = (await db.prepare("SELECT r.*,e.invoice_line_id FROM ec_report_records r LEFT JOIN ec_report_fee_evidence e ON e.record_id=r.id WHERE r.store_id=? AND r.kind='finance_event' AND (json_extract(r.data_json,'$.package_id')=? OR (json_extract(r.data_json,'$.package_id') IS NULL AND json_extract(r.data_json,'$.order_no')=?))")
      .bind(store.id, g.package_id || '', g.order_no || '').all()).results.map(r => ({...parse(r.data_json, {}), id: r.id, invoice_line_id: r.invoice_line_id}));
    const missing = [], notes = [], date = String(g.order_date || '').slice(0, 10);
    let netSales = 0, cogs = 0;
    for (const line of g.lines) {
      const comps = line.components?.components || null;
      if (!comps) { missing.push('Ürün/set eşleşmesi yok: ' + (line.barcode || line.sku || line.product_name || 'ürün')); netSales = null; cogs = null; continue; }
      if (line.components.after_order) notes.push((line.barcode || line.sku) + ': set tanımı sipariş tarihinden sonra; eski içerik doğrulanmalı.');
      line.vat_bps = await vatOf(db, comps.map(c => c.product_id));
      if (line.gross === undefined) { missing.push('Satış tutarı yok (sipariş ' + line.order_no + ')'); netSales = null; }
      else if (line.vat_bps === null) { missing.push('KDV oranı tanımlı değil: ' + (line.barcode || line.sku)); netSales = null; }
      else if (netSales !== null) netSales += exVat(line.gross, line.vat_bps);
      for (const c of comps) {
        const cost = await unitCostAt(db, c.product_id, date);
        if (!cost) { missing.push('Maliyet yok: ' + c.product_id + ' (' + date + ' öncesi giriş bulunamadı)'); cogs = null; continue; }
        // İki adet ikili set = her üründen 2 × set içindeki miktar.
        if (cogs !== null) cogs += Math.round(cost.cents_per_unit * c.quantity_milli * (line.quantity || 0) / 1000);
      }
    }
    const sum = type => events.filter(e => e.type === type).reduce((s, e) => s + e.amount_cents, 0);
    const has = type => events.some(e => e.type === type);
    const refunds = sum('refund');
    const vatForRefund = g.lines.length && g.lines.every(l => l.vat_bps === g.lines[0].vat_bps) ? g.lines[0].vat_bps : null;
    if (refunds && netSales !== null) { if (vatForRefund === null) { missing.push('İadenin KDV oranı belirlenemedi'); netSales = null; } else netSales += exVat(refunds, vatForRefund); }
    if (refunds) notes.push('İade var: ürün fiziken dönmeden stok ve maliyet geri alınmaz.');

    const profile = await db.prepare("SELECT options_json FROM ec_report_profiles WHERE provider=? AND kind='finance' AND active=1 ORDER BY created_at DESC LIMIT 1").bind(store.provider).first();
    const opts = parse(profile?.options_json, {});
    const feeVat = opts.fee_amounts_include_vat === true && Number.isInteger(opts.fee_vat_bps) ? opts.fee_vat_bps : opts.fee_amounts_include_vat === false ? 0 : null;
    let fees = 0;
    const feeRows = [];
    for (const t of FEE_TYPES) {
      if (has(t)) { const v = sum(t); feeRows.push({type: t, label: EVENT_TYPES[t], actual_cents: v, evidence: events.filter(e => e.type === t && e.invoice_line_id).length}); fees += feeVat ? exVat(v, feeVat) : v; }
    }
    // Sipariş raporundaki paket kargosu: finans kaydı yoksa ve paketteki bütün satırlarda aynıysa BİR kez.
    if (!has('cargo')) {
      const cargoValues = [...new Set(g.lines.map(l => l.cargo_package).filter(v => v !== undefined))];
      if (cargoValues.length === 1) { const v = -Math.abs(cargoValues[0]); feeRows.push({type: 'cargo', label: 'Kargo (sipariş raporu, paket başına)', actual_cents: v, evidence: 0}); fees += feeVat ? exVat(v, feeVat) : v; }
      else if (cargoValues.length > 1) missing.push('Paketin satırlarında farklı kargo ücretleri var; tek kargo kabul edilmedi.');
    }
    if (feeVat === null && feeRows.length) notes.push('Kesinti tutarlarının KDV durumu profilde belirtilmedi; katkı yaklaşık.');

    // Tahmin: yalnızca gerçekleşmiş kaydı OLMAYAN gider türleri için. Gerçek gelince tahmin kaybolur.
    const estimates = [];
    for (const t of ['commission', 'cargo']) {
      if (feeRows.some(r => r.type === t)) continue;
      let est = null;
      for (const line of g.lines) est = est || await tariffEstimate(db, store.provider, t, line, date);
      if (!est) est = await observed(db, store.id, t, g.lines[0]?.barcode, date);
      estimates.push(est ? {type: t, label: EVENT_TYPES[t], ...est} : {type: t, label: EVENT_TYPES[t], value: null, basis: 'Tahmin için yeterli veri yok (sıfır sayılmadı).'});
    }
    const payouts = events.filter(e => e.source_field === 'net_payout' || e.type === 'payout');
    const reported = events.some(e => e.net_payout !== undefined) ? [...new Map(events.filter(e => e.net_payout !== undefined).map(e => [e.event_id || e.id, e.net_payout])).values()].reduce((s, v) => s + v, 0)
      : payouts.length ? payouts.reduce((s, e) => s + e.amount_cents, 0) : null;
    const computed = events.filter(e => e.type && e.type !== 'payout').reduce((s, e) => s + e.amount_cents, 0);
    const contribution = netSales !== null && cogs !== null ? netSales - cogs + fees : null;
    const estimatedFees = estimates.reduce((s, e) => s + (e.value || 0), 0);
    results.push({
      ...g, lines: g.lines.map(l => ({order_no: l.order_no, barcode: l.barcode, sku: l.sku, product_name: l.product_name, quantity: l.quantity, gross_cents: l.gross ?? null,
        components: l.components?.components || null})),
      reported_net_cents: reported, computed_net_cents: events.length ? computed : null,
      bank_verified_cents: null, bank_note: 'Banka hareketleriyle eşleştirme henüz bağlanmadı.',
      withholding_cents: has('withholding') ? sum('withholding') : null,
      net_sales_ex_vat_cents: netSales, cogs_cents: cogs, fees: feeRows,
      contribution_cents: contribution, contribution_missing: missing,
      fee_events: events.filter(e => FEE_TYPES.includes(e.type)).map(e => ({id: e.id, type: e.type, label: EVENT_TYPES[e.type], amount_cents: e.amount_cents, invoice_line_id: e.invoice_line_id || null})),
      estimates, estimated_result_cents: contribution !== null && estimates.some(e => e.value !== null) ? contribution + (feeVat ? exVat(estimatedFees, feeVat) : estimatedFees) : null,
      notes
    });
  }
  return {store, results};
}

/* ---------------- uçlar ---------------- */
export async function reportInboxApi(request, env, path, readBody) {
  if (!path.startsWith('/api/reports')) return null;
  if (env.WORKSPACE !== 'ec') fail('Rapor Kutusu yalnızca e-ticaret çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), user = env.USER || {};
  const sub = path.slice('/api/reports'.length);

  if (sub === '' && method === 'GET') {
    const [stores, files, profiles, reviews] = await Promise.all([
      db.prepare('SELECT * FROM ec_report_stores ORDER BY provider,name').all(),
      db.prepare('SELECT f.id,f.store_id,f.kind,f.filename,f.size_bytes,f.snapshot_at,f.row_count,f.status,f.applied_row,f.counts_json,f.warnings_json,f.created_at,p.sample_verified,s.name store_name,s.provider FROM ec_report_files f JOIN ec_report_stores s ON s.id=f.store_id LEFT JOIN ec_report_profiles p ON p.id=f.profile_id ORDER BY f.created_at DESC LIMIT 100').all(),
      db.prepare('SELECT id,provider,kind,version,sample_verified,created_at FROM ec_report_profiles WHERE active=1 ORDER BY provider,kind').all(),
      db.prepare("SELECT COUNT(*) n FROM ec_report_reviews WHERE status='open'").first()
    ]);
    return {stores: stores.results, files: files.results.map(f => ({...f, counts: parse(f.counts_json, {}), warnings: parse(f.warnings_json, [])})),
      profiles: profiles.results, open_reviews: reviews.n,
      notice: 'Excel aktarımı stok, sevkiyat, satış kaydı veya fatura oluşturmaz. ERP\'de bulunan siparişe yalnızca bağlanır.'};
  }

  if (sub === '/stores' && method === 'POST') {
    const x = await readBody(request);
    if (!PROVIDERS[x.provider]) fail('Pazaryeri seçin.');
    const row = {id: id(), provider: x.provider, code: text(x.code, 'Mağaza kodu', 80), name: text(x.name, 'Mağaza adı', 120)};
    try { await db.prepare('INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)').bind(row.id, row.provider, row.code, row.name).run(); }
    catch (e) { if (/UNIQUE/.test(e.message)) fail('Bu pazaryerinde aynı kodla bir mağaza zaten var.', 409); throw e; }
    return row;
  }

  if (sub === '/profiles' && method === 'GET') {
    const p = await db.prepare('SELECT * FROM ec_report_profiles WHERE provider=? AND kind=? AND signature=? AND active=1').bind(url.searchParams.get('provider') || '', url.searchParams.get('kind') || '', url.searchParams.get('signature') || '').first();
    return {profile: p ? {...p, mapping: parse(p.mapping_json, {}), options: parse(p.options_json, {})} : null};
  }
  if (sub === '/profiles' && method === 'POST') {
    const x = await readBody(request);
    if (!PROVIDERS[x.provider] || !FIELDS[x.kind]) fail('Pazaryeri ve rapor türü seçin.');
    if (!Array.isArray(x.headers) || !x.headers.length || x.headers.length > 256) fail('Başlıklar gerekli.');
    const headers = x.headers.map(h => String(h)), mapping = {};
    for (const f of FIELDS[x.kind]) {
      const h = x.mapping?.[f.key];
      if (h === undefined || h === null || h === '') continue;
      if (!headers.includes(h)) fail(f.label + ' için seçilen sütun dosyada yok.');
      if (Object.values(mapping).includes(h)) fail('"' + h + '" sütunu iki alana birden eşlenemez.');
      mapping[f.key] = h;
    }
    for (const f of FIELDS[x.kind]) if (f.required && !mapping[f.key]) fail(f.label + ' eşlenmeli.');
    if (x.kind === 'orders' && !mapping.barcode && !mapping.sku) fail('Barkod ya da stok kodu eşlenmeli; set ve maliyet bununla bulunur.');
    if (x.kind === 'finance' && !FIELDS.finance.some(f => (f.type === 'money') && mapping[f.key])) fail('En az bir tutar sütunu eşlenmeli.');
    const typeMap = {};
    for (const [t, v] of Object.entries(x.options?.type_map || {})) { if (!EVENT_TYPES[v]) fail('İşlem türü karşılığı geçersiz.'); typeMap[String(t).slice(0, 200)] = v; }
    const options = {type_map: typeMap, fees_positive: x.options?.fees_positive === true,
      fee_amounts_include_vat: x.options?.fee_amounts_include_vat === true ? true : x.options?.fee_amounts_include_vat === false ? false : null,
      fee_vat_bps: Number.isInteger(x.options?.fee_vat_bps) && x.options.fee_vat_bps >= 0 && x.options.fee_vat_bps <= 10000 ? x.options.fee_vat_bps : null,
      ignored: headers.filter(h => !Object.values(mapping).includes(h))};
    const signature = headerSignature(headers);
    const prev = await db.prepare('SELECT MAX(version) v FROM ec_report_profiles WHERE provider=? AND kind=? AND signature=?').bind(x.provider, x.kind, signature).first();
    const row = {id: id(), version: (prev?.v || 0) + 1};
    await db.batch([
      db.prepare('UPDATE ec_report_profiles SET active=0 WHERE provider=? AND kind=? AND signature=? AND active=1').bind(x.provider, x.kind, signature),
      db.prepare('INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .bind(row.id, x.provider, x.kind, signature, row.version, JSON.stringify(mapping), JSON.stringify(options), user.id || 'owner')
    ]);
    return {...row, provider: x.provider, kind: x.kind, signature, mapping, options, sample_verified: 0};
  }
  const verify = sub.match(/^\/profiles\/([\w-]+)\/verify$/);
  if (verify && method === 'POST') {
    if (!user.owner) fail('Profili yalnızca yönetici doğrulayabilir.', 403);
    const r = await db.prepare('UPDATE ec_report_profiles SET sample_verified=1 WHERE id=? RETURNING id').bind(key(verify[1])).first();
    if (!r) fail('Profil bulunamadı.', 404);
    return {ok: true};
  }

  if (sub === '/files' && method === 'POST') {
    const x = await readBody(request);
    const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(x.store_id)).first();
    if (!store) fail('Önce mağazayı seçin.', 404);
    if (!FIELDS[x.kind]) fail('Rapor türünü seçin.');
    if (!/^[a-f0-9]{64}$/.test(x.sha256 || '')) fail('Dosya özeti geçersiz.');
    if (!Number.isSafeInteger(x.size_bytes) || x.size_bytes < 1 || x.size_bytes > MAX_FILE_BYTES) fail('Dosya boyutu geçersiz (en çok 25 MB).');
    if (!Number.isSafeInteger(x.row_count) || x.row_count < 0 || x.row_count > 200000) fail('Satır sayısı geçersiz.');
    if (!Number.isSafeInteger(x.chunk_count) || x.chunk_count < 1 || x.chunk_count > 60) fail('Parça sayısı geçersiz.');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.snapshot_at || '')) fail('Raporun indirildiği zamanı girin.');
    if (!Array.isArray(x.headers) || !x.headers.length) fail('Başlıklar gerekli.');
    const existing = await db.prepare('SELECT id,status FROM ec_report_files WHERE store_id=? AND sha256=?').bind(store.id, x.sha256).first();
    // Yarım kalmış yükleme aynı dosyayla sürer; tamamlanmış dosya ikinci kez işlenmez.
    if (existing?.status === 'receiving') return {id: existing.id, resume: true};
    if (existing) return {duplicate: true, existing, notice: 'Bu dosya bu mağazaya daha önce yüklendi; ikinci kez işlenmez.'};
    const profile = await db.prepare('SELECT id FROM ec_report_profiles WHERE provider=? AND kind=? AND signature=? AND active=1').bind(store.provider, x.kind, headerSignature(x.headers.map(String))).first();
    if (!profile) fail('Bu başlıklar için onaylı sütun eşleştirmesi yok. Önce eşleştirmeyi kaydedin.', 409);
    const row = {id: id()};
    await db.prepare('INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,date1904,row_count,chunk_count,profile_id,warnings_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(row.id, store.id, x.kind, text(x.filename, 'Dosya adı', 255), x.size_bytes, x.sha256, x.snapshot_at, String(x.sheet || '').slice(0, 100), JSON.stringify(x.headers.map(String)),
        x.date1904 ? 1 : 0, x.row_count, x.chunk_count, profile.id, JSON.stringify((x.warnings || []).slice(0, 20).map(String)), user.id || 'owner').run();
    return {id: row.id, profile_id: profile.id};
  }

  const fileMatch = sub.match(/^\/files\/([\w-]+)\/(chunk|rows|seal|preview|apply)$/);
  if (fileMatch) {
    const f = await loadFile(db, fileMatch[1]), action = fileMatch[2];
    if (action === 'chunk' && method === 'POST') {
      const x = await readBody(request);
      if (!Number.isInteger(x.index) || x.index < 0 || x.index >= f.chunk_count) fail('Parça sırası geçersiz.');
      if (typeof x.data !== 'string' || !x.data || x.data.length > CHUNK_B64_MAX || !/^[A-Za-z0-9+/]+=*$/.test(x.data)) fail('Parça geçersiz.');
      await db.prepare('INSERT OR IGNORE INTO ec_report_file_chunks(file_id,idx,data_b64) VALUES(?,?,?)').bind(f.id, x.index, x.data).run();
      return {ok: true};
    }
    if (action === 'rows' && method === 'POST') {
      const x = await readBody(request);
      if (!Array.isArray(x.rows) || x.rows.length > ROWS_PER_CALL) fail('En çok ' + ROWS_PER_CALL + ' satır gönderin.');
      const stmts = x.rows.map(r => {
        if (!Number.isSafeInteger(r?.row) || r.row < 1 || !Array.isArray(r.cells) || r.cells.length > 256) fail('Satır biçimi geçersiz.');
        const cells = r.cells.map(c => c === null || c === undefined ? null : {v: c.v === null || c.v === undefined ? null : String(c.v).slice(0, 2000), t: ['s', 'n', 'b', 'e'].includes(c.t) ? c.t : 's', ...(c.f ? {f: true} : {})});
        return db.prepare('INSERT OR IGNORE INTO ec_report_rows(file_id,row_no,cells_json) VALUES(?,?,?)').bind(f.id, r.row, JSON.stringify(cells));
      });
      if (stmts.length) await db.batch(stmts);
      return {ok: true};
    }
    if (action === 'seal' && method === 'POST') {
      if (f.status !== 'receiving') return {ok: true, status: f.status};
      const chunks = (await db.prepare('SELECT idx,data_b64 FROM ec_report_file_chunks WHERE file_id=? ORDER BY idx').bind(f.id).all()).results;
      if (chunks.length !== f.chunk_count || chunks.some((c, i) => c.idx !== i)) fail('Dosya parçaları eksik; yüklemeyi sürdürün.', 409);
      const parts = chunks.map(c => b64bytes(c.data_b64)), size = parts.reduce((s, p) => s + p.length, 0);
      const all = new Uint8Array(size); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      if (size !== f.size_bytes || await sha256Hex(all) !== f.sha256) fail('Sunucuya ulaşan dosya, seçilen dosyayla aynı değil. Yeniden yükleyin.', 409);
      const n = (await db.prepare('SELECT COUNT(*) n FROM ec_report_rows WHERE file_id=?').bind(f.id).first()).n;
      if (n !== f.row_count) fail('Satırlar eksik (' + n + ' / ' + f.row_count + '); yüklemeyi sürdürün.', 409);
      await db.prepare("UPDATE ec_report_files SET status='received' WHERE id=? AND status='receiving'").bind(f.id).run();
      return {ok: true, status: 'received'};
    }
    if (action === 'preview' && method === 'GET') {
      if (f.status === 'receiving') fail('Dosya henüz tamamen alınmadı.', 409);
      const profile = await loadProfile(db, f);
      const norm = normalizeRows(profile, parse(f.headers_json, []), await fileRows(db, f.id, 0, Number.MAX_SAFE_INTEGER), {date1904: !!f.date1904});
      const classified = await classify(db, f, profile, norm.records);
      const counts = {new: 0, updated: 0, same: 0, older: 0, review: 0};
      for (const r of classified) counts[r.outcome]++;
      let erpLinks = 0, noMapping = 0;
      for (const r of classified.filter(r => r.kind === 'order_line' && ['new', 'updated'].includes(r.outcome)).slice(0, 500)) {
        if ((await erpMatch(db, f.provider, r.data)).id) erpLinks++;
        if (!await componentsFor(db, f.provider, r.data)) noMapping++;
      }
      return {file: {id: f.id, filename: f.filename, status: f.status, row_count: f.row_count, store_name: f.store_name, provider: f.provider, snapshot_at: f.snapshot_at},
        profile: {id: profile.id, version: profile.version, sample_verified: profile.sample_verified},
        counts, skipped: norm.skipped, unknown_types: norm.unknownTypes, totals: norm.totals, erp_links: erpLinks, unmapped_products: noMapping,
        reviews: classified.filter(r => r.outcome === 'review').slice(0, 50).map(r => ({row: r.row, key: r.key, reason: r.reason, detail: r.detail})),
        notice: 'Önizleme hiçbir şey yazmaz. İşlem stok, sevkiyat, satış veya fatura oluşturmaz.'};
    }
    if (action === 'apply' && method === 'POST') {
      if (f.status === 'receiving') fail('Dosya henüz tamamen alınmadı.', 409);
      if (f.status === 'applied') return {done: true, applied_row: f.applied_row, counts: parse(f.counts_json, {})};
      const profile = await loadProfile(db, f);
      const lastRow = (await db.prepare('SELECT MAX(row_no) m FROM ec_report_rows WHERE file_id=?').bind(f.id).first()).m || 0;
      const chunkRows = (await db.prepare('SELECT row_no FROM ec_report_rows WHERE file_id=? AND row_no>? ORDER BY row_no LIMIT ?').bind(f.id, f.applied_row, APPLY_BATCH).all()).results;
      const toRow = chunkRows.length ? chunkRows.at(-1).row_no : lastRow;
      // Belirsiz ikizler dosya genelinde görülmeli: tüm dosya normalize edilir, yalnız bu partinin satırları yazılır.
      const all = normalizeRows(profile, parse(f.headers_json, []), await fileRows(db, f.id, 0, Number.MAX_SAFE_INTEGER), {date1904: !!f.date1904});
      if (all.unknownTypes.length) fail('Tanımlanmamış işlem türleri var (' + all.unknownTypes.slice(0, 5).join(', ') + '). Önce eşleştirmede karşılığını seçin.', 409);
      const classifiedAll = await classify(db, f, profile, all.records);
      const part = classifiedAll.filter(r => r.row > f.applied_row && r.row <= toRow);
      const counts = parse(f.counts_json, {new: 0, updated: 0, same: 0, older: 0, review: 0});
      const stmts = [db.prepare('INSERT INTO ec_report_apply_steps(file_id,from_row,to_row) VALUES(?,?,?)').bind(f.id, f.applied_row, toRow)];
      for (const r of part) {
        counts[r.outcome] = (counts[r.outcome] || 0) + 1;
        stmts.push(db.prepare('INSERT INTO ec_report_outcomes(file_id,row_no,record_key,outcome) VALUES(?,?,?,?)').bind(f.id, r.row, r.kind + '|' + r.key, r.outcome));
        if (r.outcome === 'new') {
          const recId = id(), erp = r.kind === 'order_line' ? await erpMatch(db, f.provider, r.data) : {id: null};
          const comps = r.kind === 'order_line' ? await componentsFor(db, f.provider, r.data) : null;
          stmts.push(db.prepare('INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id,components_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .bind(recId, f.store_id, r.kind, r.key, r.keySource, JSON.stringify(r.data), f.snapshot_at, f.id, r.row, erp.id, comps ? JSON.stringify(comps) : null));
          stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,1,?,?,'new',?,?)").bind(id(), recId, f.id, r.row, JSON.stringify(r.data), f.snapshot_at));
          if (erp.ambiguous) stmts.push(review(db, f, r, 'erp_ambiguous', 'ERP\'de bu siparişe uyan birden fazla paket var; bağlantı kurulmadı.'));
        } else if (r.outcome === 'updated') {
          const v = r.prior.version + 1;
          stmts.push(db.prepare('UPDATE ec_report_records SET data_json=?,source_time=?,file_id=?,row_no=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?')
            .bind(JSON.stringify(r.merged), f.snapshot_at, f.id, r.row, v, r.prior.id, r.prior.version));
          stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,?,?,?,'updated',?,?)").bind(id(), r.prior.id, v, f.id, r.row, JSON.stringify(r.merged), f.snapshot_at));
        } else if (r.outcome === 'review') {
          stmts.push(review(db, f, r, r.reason, r.detail));
        }
      }
      const done = toRow >= lastRow;
      stmts.push(db.prepare('UPDATE ec_report_files SET applied_row=?,status=?,counts_json=? WHERE id=? AND applied_row=?').bind(toRow, done ? 'applied' : 'applying', JSON.stringify(counts), f.id, f.applied_row));
      try { await db.batch(stmts); }
      catch (e) { if (/UNIQUE|PRIMARY KEY/.test(e.message)) fail('Bu parti başka bir sekmede işleniyor ya da az önce işlendi. Sayfayı yenileyin.', 409); throw e; }
      return {done, applied_row: toRow, row_count: f.row_count, counts};
    }
  }

  if (sub === '/reviews' && method === 'GET') {
    return {reviews: (await db.prepare("SELECT r.*,s.name store_name,s.provider,f.filename FROM ec_report_reviews r JOIN ec_report_stores s ON s.id=r.store_id JOIN ec_report_files f ON f.id=r.file_id WHERE r.status='open' ORDER BY r.created_at LIMIT 200").all()).results
      .map(r => ({...r, incoming: parse(r.incoming_json, {}), prior: parse(r.prior_json, null)}))};
  }
  const rev = sub.match(/^\/reviews\/([\w-]+)$/);
  if (rev && method === 'POST') {
    const x = await readBody(request);
    if (!['accept', 'reject'].includes(x.decision)) fail('Karar geçersiz.');
    const r = await db.prepare("SELECT v.*,f.snapshot_at FROM ec_report_reviews v JOIN ec_report_files f ON f.id=v.file_id WHERE v.id=? AND v.status='open'").bind(key(rev[1])).first();
    if (!r) fail('İnceleme bulunamadı ya da çözülmüş.', 404);
    const stmts = [db.prepare("UPDATE ec_report_reviews SET status=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(x.decision === 'accept' ? 'accepted' : 'rejected', user.id || 'owner', r.id)];
    if (x.decision === 'accept') {
      const incoming = parse(r.incoming_json, {}), [kind, ...rest] = r.record_key.split('|'), recordKey = rest.join('|');
      const current = await db.prepare('SELECT * FROM ec_report_records WHERE store_id=? AND kind=? AND record_key=?').bind(r.store_id, kind, recordKey).first();
      if (current && !['ambiguous_twin', 'duplicate_in_file'].includes(r.reason)) {
        const merged = {...parse(current.data_json, {}), ...incoming}, v = current.version + 1;
        stmts.push(db.prepare('UPDATE ec_report_records SET data_json=?,source_time=?,file_id=?,row_no=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?').bind(JSON.stringify(merged), r.snapshot_at, r.file_id, r.row_no, v, current.id, current.version));
        stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,?,?,?,'accepted',?,?)").bind(id(), current.id, v, r.file_id, r.row_no, JSON.stringify(merged), r.snapshot_at));
      } else {
        // Belirsiz ikiz ya da yeni kayıt: AYRI kayıt olarak saklanır (iadeler birleştirilmez).
        const recId = id(), separateKey = current || ['ambiguous_twin', 'duplicate_in_file'].includes(r.reason) ? recordKey + '#' + r.file_id.slice(0, 8) + ':' + r.row_no : recordKey;
        stmts.push(db.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,?,?,'composite',?,?,?,?)").bind(recId, r.store_id, kind, separateKey, JSON.stringify(incoming), r.snapshot_at, r.file_id, r.row_no));
        stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,1,?,?,'accepted',?,?)").bind(id(), recId, r.file_id, r.row_no, JSON.stringify(incoming), r.snapshot_at));
      }
    }
    await db.batch(stmts);
    return {ok: true};
  }

  if (sub === '/orders' && method === 'GET') {
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
    return await orderResults(db, url.searchParams.get('store_id') || '', {limit: 100, offset: (page - 1) * 100});
  }

  if (sub === '/evidence-candidates' && method === 'GET') {
    return {lines: (await db.prepare("SELECT l.id,l.description,l.net_cents,l.tax_cents,i.invoice_no,i.invoice_date,s.name supplier FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id JOIN ec_suppliers s ON s.id=i.supplier_id WHERE l.product_id IS NULL AND i.status!='cancelled' AND NOT EXISTS(SELECT 1 FROM ec_fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL) ORDER BY i.invoice_date DESC LIMIT 200").all()).results};
  }
  const ev = sub.match(/^\/records\/([\w-]+)\/evidence$/);
  if (ev && method === 'POST') {
    const x = await readBody(request);
    const rec = await db.prepare("SELECT * FROM ec_report_records WHERE id=? AND kind='finance_event'").bind(key(ev[1])).first();
    if (!rec) fail('Gider kaydı bulunamadı.', 404);
    const data = parse(rec.data_json, {});
    if (!FEE_TYPES.includes(data.type)) fail('Yalnızca kargo, komisyon, hizmet ve diğer kesintilere belge bağlanır.');
    const line = await db.prepare('SELECT * FROM ec_purchase_lines WHERE id=?').bind(key(x.invoice_line_id)).first();
    if (!line) fail('Fatura satırı bulunamadı.', 404);
    const linked = (await db.prepare('SELECT COALESCE(SUM(ABS(amount_cents)),0) s FROM ec_report_fee_evidence WHERE invoice_line_id=?').bind(line.id).first()).s;
    const lineTotal = line.net_cents + line.tax_cents, amount = Math.abs(data.amount_cents || 0);
    if (linked + amount > lineTotal) fail('Bu fatura satırına bağlanan giderler faturanın tutarını aşıyor; ayrı bir ücret olabilir. İnceleyin.', 409);
    try { await db.prepare('INSERT INTO ec_report_fee_evidence(id,record_id,invoice_line_id,amount_cents,created_by) VALUES(?,?,?,?,?)').bind(id(), rec.id, line.id, amount, user.id || 'owner').run(); }
    catch (e) {
      if (/FEE_ALREADY_ALLOCATED/.test(e.message)) fail('Bu fatura satırı kesinti eşleştirmesinde bir satışa gider olarak dağıtılmış; ikinci kez sayılamaz.', 409);
      if (/UNIQUE/.test(e.message)) fail('Bu gidere zaten bir belge bağlı.', 409);
      throw e;
    }
    return {ok: true, remaining_cents: lineTotal - linked - amount,
      notice: 'Belge mevcut gidere kanıt olarak bağlandı. Yeni gider oluşturulmadı.'};
  }
  return null;
}

function review(db, f, r, reason, detail) {
  return db.prepare('INSERT OR IGNORE INTO ec_report_reviews(id,store_id,file_id,row_no,kind,record_key,reason,detail,incoming_json,prior_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(id(), f.store_id, f.id, r.row, r.kind, r.kind + '|' + r.key, reason || 'review', String(detail || '').slice(0, 500), JSON.stringify(r.data), r.prior ? r.prior.data_json : null);
}
export {contentHash};
