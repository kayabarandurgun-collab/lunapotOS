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
import {FIELDS, PROVIDERS, EVENT_TYPES, FEE_TYPES, headerSignature, normalizeRows, compareVersions, contentHash, exVat, observedEstimate, allocateCents} from '../public/report-core.js';

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
    const blocking = r.issues.filter(i => ['ambiguous_twin', 'duplicate_in_file', 'id_precision', 'bad_value', 'missing_required', 'unknown_type', 'no_amount'].includes(i.code));
    if (blocking.length) { out.push({...r, outcome: 'review', reason: blocking[0].code, detail: blocking.map(i => i.detail).join(' ')}); continue; }
    // Aynı dosyada aynı sağlayıcı kimliği iki kez: ikincisi ilkinin sürümü sayılmaz, incelemeye.
    if (seenInFile.has(k)) { out.push({...r, outcome: 'review', reason: 'duplicate_in_file', detail: 'Aynı kimlik dosyada ' + seenInFile.get(k) + '. satırda da var.'}); continue; }
    seenInFile.set(k, r.row);
    const prior = existing.get(k);
    const result = compareVersions(prior && {data: parse(prior.data_json, {}), dataTime: prior.data_time || prior.source_time, observedTime: prior.source_time, locked: await locked(db, prior)}, {data: r.data, time: f.snapshot_at});
    out.push({...r, outcome: result.outcome, merged: result.data, proposed: result.proposed, prior, advanceObservation: result.advanceObservation,
      reason: result.outcome === 'review' ? (prior && await locked(db, prior) ? 'posted_changed' : 'same_time_conflict') : null,
      detail: result.outcome === 'review' ? 'Önceki bilgiyle çelişiyor ve hangisinin daha yeni olduğu kesin değil.' : ''});
  }
  return out;
}

/** ERP'de zaten var olan paket (oluşturma yok). Mağaza ayrımı kesin değilse bağlanmaz. */
async function erpMatch(db, provider, data) {
  const ids = [data.package_id, data.order_no].filter(Boolean);
  if (!ids.length) return {id: null};
  // ERP paketlerinde mağaza/satıcı alanı YOK. Aynı pazaryerinde birden çok mağaza tanımlıysa
  // siparişin hangi mağazaya ait olduğu belirlenemez: yanlış kayda bağlamak yerine bağlanmaz.
  const stores = (await db.prepare('SELECT COUNT(*) n FROM ec_report_stores WHERE provider=?').bind(provider).first()).n;
  if (stores > 1) return {id: null, storeAmbiguous: true};
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
/**
 * Okuma maliyeti: aşağıdaki iki hesap sipariş başına değil, ÇAĞRI başına bir kez veri okur.
 * Önceden tek sorguyla KDV profilleri (birkaç düzine satır) ve stok girişleri (birkaç yüz satır)
 * belleğe alınır; sonrası bellekte hesaplanır. Sonuç birebir aynıdır, yalnızca sorgu sayısı düşer.
 * Bu olmadan yüzlerce sipariş × satır × bileşen kadar sorgu atılıyordu ve günlük okuma kotası doluyordu.
 */
async function preload(db, memo) {
  if (memo.loaded) return memo;
  memo.profiles = new Map((await db.prepare('SELECT product_id,vat_bps FROM ec_price_profiles').all()).results.map(r => [r.product_id, r.vat_bps]));
  memo.movements = new Map();
  for (const r of (await db.prepare("SELECT product_id,occurred_on,quantity_milli q,value_cents v FROM ec_stock_movements WHERE kind IN ('opening','purchase') AND quantity_milli>0 ORDER BY product_id,occurred_on").all()).results) {
    if (!memo.movements.has(r.product_id)) memo.movements.set(r.product_id, []);
    memo.movements.get(r.product_id).push(r);
  }
  memo.loaded = true;
  return memo;
}

async function unitCostAt(db, productId, date, memo) {
  // Sipariş tarihine kadarki açılış ve alış girişlerinin ortalaması. Giriş yoksa maliyet BİLİNMİYOR.
  const k = productId + '|' + date;
  if (memo?.costCache?.has(k)) return memo.costCache.get(k);
  let q = 0, v = 0;
  if (memo?.movements) {
    for (const m of memo.movements.get(productId) || []) { if (m.occurred_on > date) break; q += m.q; v += m.v; }
  } else {
    const r = await db.prepare("SELECT SUM(quantity_milli) q,SUM(value_cents) v FROM ec_stock_movements WHERE product_id=? AND kind IN ('opening','purchase') AND quantity_milli>0 AND occurred_on<=?")
      .bind(productId, date).first();
    q = r?.q || 0; v = r?.v ?? null;
  }
  const out = q > 0 && v !== null ? {cents_per_unit: v * 1000 / q, historical: true} : null;
  memo?.costCache?.set(k, out);
  return out;
}

async function vatOf(db, productIds, memo) {
  const k = productIds.join('␟');
  if (memo?.vatCache?.has(k)) return memo.vatCache.get(k);
  const rows = memo?.profiles
    ? productIds.map(p => ({product_id: p, vat_bps: memo.profiles.has(p) ? memo.profiles.get(p) : null}))
    : (await db.prepare('SELECT product_id,vat_bps FROM ec_price_profiles WHERE product_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(productIds)).all()).results;
  const rates = [...new Set(productIds.map(p => rows.find(r => r.product_id === p)?.vat_bps ?? null))];
  const out = rates.length === 1 && rates[0] !== null ? rates[0] : null;
  memo?.vatCache?.set(k, out);
  return out;
}

/**
 * Paket teslim edildi mi? Ölçüt pazaryerinin durum metni DEĞİL, eşleştirilmiş teslim tarihi alanıdır:
 * durum sözcükleri pazaryerine göre değişir, tarih alanı değişmez. Teslim edilmeyen pakette komisyon
 * kesilmiş görünse de kargo maliyeti kesinleşmediği için kâr HESAPLANMAZ (bkz. contribution_cents).
 */
const deliveryOf = lines => {
  const dates = lines.map(l => String(l.delivered_date || '').slice(0, 10)).filter(Boolean).sort();
  return {delivered: dates.length > 0 && dates.length === lines.length, delivered_on: dates.at(-1) || null};
};

/** Satır bazında komisyon tarifesi. Kargo tarifesi (desi) henüz bağlı değildir. */
async function tariffEstimate(db, provider, type, line, date) {
  if (type !== 'commission' || line.gross === undefined) return null;
  const rate = await db.prepare("SELECT * FROM ec_commission_rates WHERE channel=? AND archived_at IS NULL AND valid_from<=? AND valid_to>=? AND (sku='' OR sku=?) AND price_min_cents<=? AND (price_max_cents IS NULL OR price_max_cents>?) ORDER BY sku DESC,valid_from DESC LIMIT 1")
    .bind(provider, date, date, line.sku || line.barcode || '', line.gross, line.gross).first();
  if (!rate) return null;
  const base = rate.base === 'net' && line.vat_bps !== null && line.vat_bps !== undefined ? exVat(line.gross, line.vat_bps) : line.gross;
  const value = -Math.round(base * rate.rate_bps / 10000);
  return {value, basis: 'Tarife: ' + rate.label + ' (%' + (rate.rate_bps / 100) + ')'};
}

/** Paketin "neye benzediği": barkod/SKU, adet ve taşıyıcı. Tahmin yalnız aynı içerikli paketlerden yapılır. */
const packageSignature = lines => JSON.stringify(lines
  .map(l => [String(l.barcode || l.sku || ''), Number(l.quantity) || 0, String(l.carrier || '')])
  .sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2])));

/**
 * Gerçekleşmiş kayıtlardan tahmin: yalnızca aynı mağazada, son 90 günde, AYNI içerikli
 * (barkod, adet, taşıyıcı) paketlerin kayıtları. Yetersiz örnekte tahmin yapılmaz; sıfır sayılmaz.
 */
async function observedFor(db, storeId, type, signature, date, excludeGroup) {
  if (!date) return null;
  const from = new Date(Date.parse(date + 'T00:00:00Z') - 90 * 86400000).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT data_json FROM ec_report_records WHERE store_id=? AND kind='order_line' AND substr(json_extract(data_json,'$.order_date'),1,10) BETWEEN ? AND ? LIMIT 3000")
    .bind(storeId, from, date).all()).results.map(r => parse(r.data_json, {}));
  const groups = new Map();
  for (const d of rows) { const g = d.package_id || d.order_no; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
  const similar = new Set([...groups.entries()].filter(([g, ls]) => g !== excludeGroup && packageSignature(ls) === signature).map(([g]) => g));
  if (!similar.size) return null;
  // Benzer paketler sipariş tarihine göre seçilir (geçmişe bakarken gelecekteki sipariş kullanılmaz).
  // O paketlerin gerçekleşmiş kesintileri ise siparişten SONRA oluşur; bu yüzden olay tarihine göre süzülmez.
  const events = (await db.prepare("SELECT json_extract(data_json,'$.amount_cents') a,json_extract(data_json,'$.package_id') p,json_extract(data_json,'$.order_no') o FROM ec_report_records WHERE store_id=? AND kind='finance_event' AND json_extract(data_json,'$.type')=? LIMIT 3000")
    .bind(storeId, type).all()).results;
  const est = observedEstimate(events.filter(e => similar.has(e.p || e.o)).map(e => e.a));
  return est ? {...est, basis: 'Aynı içerikli paketlerin son 90 gündeki gerçekleşen kayıtları: ' + est.samples + ' örnek'} : null;
}

export async function orderResults(db, storeId, {limit = 100, offset = 0, q = '', status = ''} = {}) {
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);
  // Sayfalama SİPARİŞ düzeyinde: bir paketin satırları sayfa sınırında bölünmez.
  // Arama ve durum süzgeci sipariş düzeyinde uygulanır; sayfa sınırı paketi bölmez.
  const needle = String(q || '').trim().toLocaleLowerCase('tr-TR').slice(0, 100);
  const where = "store_id=? AND kind='order_line'"
    + (needle ? " AND (instr(lower(COALESCE(json_extract(data_json,'$.order_no'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.package_id'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.barcode'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.sku'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.product_name'),'')),?)>0)" : '')
    + (status ? " AND json_extract(data_json,'$.status')=?" : '');
  const filterArgs = [...(needle ? [needle, needle, needle, needle, needle] : []), ...(status ? [String(status).slice(0, 100)] : [])];
  const total = (await db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM ec_report_records WHERE ' + where + " GROUP BY json_extract(data_json,'$.order_no'))")
    .bind(store.id, ...filterArgs).first()).n;
  const statuses = (await db.prepare("SELECT DISTINCT json_extract(data_json,'$.status') s FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.status') IS NOT NULL ORDER BY s LIMIT 50")
    .bind(store.id).all()).results.map(r => r.s);
  const orderNos = (await db.prepare("SELECT json_extract(data_json,'$.order_no') o,MAX(substr(json_extract(data_json,'$.order_date'),1,10)) d FROM ec_report_records WHERE " + where + ' GROUP BY o ORDER BY d DESC,o LIMIT ? OFFSET ?')
    .bind(store.id, ...filterArgs, limit, offset).all()).results.map(r => r.o).filter(o => o !== null && o !== undefined);
  if (!orderNos.length) return {store, results: [], total, statuses};
  return {store, results: await packagesFor(db, store, orderNos, await preload(db, newMemo())), total, statuses};
}

/**
 * Verilen siparişlerin paket bazında sonucu. Sayfa görünümü, mağaza özeti ve kesinti aktarımı
 * AYNI hesabı kullanır; böylece ekranda görünen tutarla deftere yazılan tutar ayrışamaz.
 * memo: yalnızca sorgu tekrarını önler, sonucu değiştirmez.
 */
const newMemo = () => ({costCache: new Map(), vatCache: new Map(), profiles: null, movements: null, loaded: false});

async function packagesFor(db, store, orderNos, memo = newMemo(), {withEstimates = true} = {}) {
  const lines = (await db.prepare("SELECT * FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.order_no') IN (SELECT value FROM json_each(?)) ORDER BY record_key")
    .bind(store.id, JSON.stringify(orderNos)).all()).results;
  // Paket kimliği hangi siparişe ait? Finans satırında sipariş no boş olsa da olay bu yolla bulunur.
  // Eşleme YALNIZCA bu mağazanın kayıtlarından kurulur; paketler mağazalar arasında karışmaz.
  const packageOwner = new Map();
  for (const l of lines) { const d = parse(l.data_json, {}); if (d.package_id !== undefined && d.package_id !== null && d.package_id !== '') packageOwner.set(String(d.package_id), d.order_no || ''); }
  const packageIds = [...packageOwner.keys()];

  // DEFTERDEKİ MALİYET. Bu ekran raporu okur, ama ürün maliyeti defterin işidir ve iki yerde
  // rapordan ayrılır: (1) iade gelip stoğa dönen malın maliyeti defterde geri alınır,
  // (2) defter, gönderim anında DONDURULAN maliyeti kullanır; rapor tarafı sipariş tarihindeki
  // birim maliyeti yeniden hesaplar. Aynı paket iki ekranda iki rakam gösteremez: ERP paketine
  // bağlıysa maliyet DEFTERDEN alınır. Bağlı değilse rapor tarafındaki hesap kalır ve söylenir.
  const erpIds = [...new Set(lines.map(l => l.erp_package_id).filter(Boolean))];
  const defter = new Map();
  if (erpIds.length) {
    const arg = JSON.stringify(erpIds);
    const [satirlar, eksikler] = await Promise.all([
      db.prepare('SELECT package_id,SUM(cost_cents) cost,SUM(vat) vat,SUM(vatsiz) vatsiz FROM (' +
        'SELECT DISTINCT s.id,l.package_id,s.cost_cents,' +
        "CAST(ROUND(s.cost_cents*COALESCE(pp.vat_bps,0)/10000.0) AS INTEGER) vat," +
        'CASE WHEN pp.vat_bps IS NULL THEN 1 ELSE 0 END vatsiz' +
        ' FROM ec_sale_entries s JOIN ec_order_line_components c ON (s.id=c.sale_id OR s.parent_id=c.sale_id)' +
        ' JOIN ec_order_lines l ON l.id=c.line_id LEFT JOIN ec_price_profiles pp ON pp.product_id=s.product_id' +
        ' WHERE l.package_id IN (SELECT value FROM json_each(?))) GROUP BY package_id').bind(arg).all(),
      db.prepare('SELECT l.package_id,COUNT(*) n FROM ec_order_lines l' +
        ' WHERE l.package_id IN (SELECT value FROM json_each(?))' +
        ' AND NOT EXISTS(SELECT 1 FROM ec_order_line_components c WHERE c.line_id=l.id AND c.sale_id IS NOT NULL)' +
        ' GROUP BY l.package_id').bind(arg).all()
    ]);
    const eksik = new Map(eksikler.results.map(r => [r.package_id, r.n]));
    // KDV oranı tanımsız ürün varsa vat negatife düşer: KDV dahil maliyet hesaplanmaz, uydurulmaz.
    for (const r of satirlar.results)
      defter.set(r.package_id, {cost: r.cost, incl: r.vatsiz ? null : r.cost + r.vat, eksik: eksik.get(r.package_id) || 0});
  }
  let allEvents = (await db.prepare("SELECT r.*,e.invoice_line_id,f.profile_id FROM ec_report_records r LEFT JOIN ec_report_fee_evidence e ON e.record_id=r.id JOIN ec_report_files f ON f.id=r.file_id WHERE r.store_id=? AND r.kind='finance_event' AND (json_extract(r.data_json,'$.order_no') IN (SELECT value FROM json_each(?)) OR json_extract(r.data_json,'$.package_id') IN (SELECT value FROM json_each(?)))")
    .bind(store.id, JSON.stringify(orderNos), JSON.stringify(packageIds)).all()).results
    .map(r => ({...parse(r.data_json, {}), id: r.id, invoice_line_id: r.invoice_line_id, profile_id: r.profile_id, row_no: r.row_no, file_id: r.file_id, source_time: r.source_time}));
  // Tek kaynak satırından üretilen birden çok olay (geniş kolonlu rapor) bildirilen neti çoğaltmamalı:
  // net, olay kimliği yoksa kaynak satırın kimliğiyle tekilleştirilir.
  const sourceKey = e => e.event_id || (e.file_id || '') + ':' + (e.row_no ?? '');

  // KABA TEKRAR: aynı gider iki ayrı raporda, biri paket no ve tarih ile, diğeri onlarsız
  // geldiğinde iki AYRI bileşik anahtar oluşur ve tutar iki kez sayılırdı. Ham kayıt silinmez
  // (defter değişmez); yalnızca HESAPTA sayılmaz ve pakete not düşülür.
  // Yalnızca ayrıntısı EKSİK olan kopya elenir: iki paketin aynı tutarlı kargosu gibi gerçekten
  // ayrı iki gider, ikisi de paket no taşıdığı için aynı ayrıntı düzeyindedir ve elenmez.
  const ayrinti = e => (e.package_id ? 2 : 0) + (e.event_date ? 1 : 0);
  const kabaNot = new Map();
  const kume = new Map();
  for (const e of allEvents) {
    if (!e.order_no || !e.type) continue;
    const k = e.order_no + '|' + e.type + '|' + e.amount_cents;
    if (!kume.has(k)) kume.set(k, []);
    kume.get(k).push(e);
  }
  const elenen = new Set();
  for (const [, grup] of kume) {
    if (grup.length < 2) continue;
    const enIyi = Math.max(...grup.map(ayrinti));
    const tam = grup.find(e => ayrinti(e) === enIyi);
    for (const e of grup) {
      if (ayrinti(e) >= enIyi) continue;
      // Ayrıntısı eksik olan, ayrıntılı kaydın aynısı mı? Dolu alanları çelişmemeli.
      if (e.package_id && String(e.package_id) !== String(tam.package_id)) continue;
      if (e.event_date && e.event_date !== tam.event_date) continue;
      // Faturaya bağlanmış gider elenmez: belge bağı varsa insan bakmalı.
      if (e.invoice_line_id) continue;
      elenen.add(e.id);
      if (!kabaNot.has(e.order_no)) kabaNot.set(e.order_no, []);
      kabaNot.get(e.order_no).push((EVENT_TYPES[e.type] || 'Gider') + ' ' + (Math.abs(e.amount_cents) / 100).toFixed(2) +
        ' TL iki raporda birden geldi (biri paket no/tarih taşımıyor); bir kez sayıldı. Ham kayıt silinmedi.');
    }
  }
  if (elenen.size) allEvents = allEvents.filter(e => !elenen.has(e.id));

  // Gider KDV bilgisi olayın KENDİ dosyasının profil sürümünden gelir; sonradan açılan başka profil
  // geçmiş hesabı değiştirmez.
  const profileOptions = new Map(), profileMapping = new Map();
  // Bir olayin RAPORDAKI sutun adi: source_field esleme anahtaridir ('other_fee'), kullanicinin
  // gordugu baslik degil. Artı gelen bir kalemin ne oldugu ancak sutun adiyla anlasilir.
  const sutunAdi = e => {
    const alan = String(e.source_field || '');
    if (alan.startsWith('ek:')) return alan.slice(3);
    return (profileMapping.get(e.profile_id) || {})[alan] || '';
  };
  for (const pid of [...new Set(allEvents.map(e => e.profile_id).filter(Boolean))])
  {
    const p = await db.prepare('SELECT options_json,mapping_json FROM ec_report_profiles WHERE id=?').bind(pid).first();
    profileOptions.set(pid, parse(p?.options_json, {}));
    profileMapping.set(pid, parse(p?.mapping_json, {}));
  }
  const feeVatOf = event => {
    const o = profileOptions.get(event.profile_id) || {};
    return o.fee_amounts_include_vat === true && Number.isInteger(o.fee_vat_bps) ? o.fee_vat_bps : o.fee_amounts_include_vat === false ? 0 : null;
  };

  // Sipariş → paketler.
  const byOrder = new Map();
  for (const l of lines) {
    const d = parse(l.data_json, {}), order = d.order_no || '', group = d.package_id || order;
    if (!byOrder.has(order)) byOrder.set(order, new Map());
    const packages = byOrder.get(order);
    if (!packages.has(group)) packages.set(group, {group, order_no: order, package_id: d.package_id || null, order_date: d.order_date, status: d.status || null, erp_package_id: l.erp_package_id, lines: []});
    packages.get(group).lines.push({...d, id: l.id, components: parse(l.components_json, null)});
  }

  const results = [];
  for (const [order, packages] of byOrder) {
    const list = [...packages.values()];
    const packageEvents = new Map(list.map(p => [p.group, []]));
    const shared = [];
    const conflictNotes = [];
    for (const e of allEvents) {
      const pkg = e.package_id === undefined || e.package_id === null || e.package_id === '' ? null : String(e.package_id);
      const stated = e.order_no || '', owner = pkg !== null && packageOwner.has(pkg) ? packageOwner.get(pkg) : null;
      // Finans satırındaki sipariş no ile paketin gerçek siparişi çelişiyorsa: sipariş geneline
      // DAĞITILMAZ, incelemeye ayrılır. Yanlış siparişe gider yazmaktansa eksik bırakılır.
      if (stated && owner !== null && stated !== owner) {
        if (stated === order || owner === order)
          conflictNotes.push('Çelişkili kesinti: ' + (EVENT_TYPES[e.type] || 'gider') + ' satırı ' + stated + ' siparişini gösteriyor ama ' +
            pkg + ' paketi ' + (owner || '(siparişsiz)') + ' siparişine ait. Dağıtılmadı; incelenmeli.');
        continue;
      }
      if (!(stated ? stated === order : owner === order)) continue;
      const direct = pkg !== null && packageEvents.has(pkg);
      if (direct) packageEvents.get(pkg).push(e); else shared.push(e);
    }
    // BELİRSİZ TOPLAM: aynı türden gider, iki AYRI rapor dosyasından, paket numarası taşımadan
    // ve farklı tutarlarla geliyorsa bunlar iki ayrı paketin gideri de olabilir, aynı giderin
    // iki farklı beyanı da. Toplamak da birini seçmek de uydurma olur: kâr HESAPLANMAZ,
    // paket incelemeye kalır. (Aynı tutarlı kaba tekrar bir üstteki kuralla zaten elenir.)
    const dosyaSay = new Map();
    for (const e of shared) {
      if (!e.type || !e.amount_cents || e.type === 'payout' || e.type === 'sale') continue;
      if (!dosyaSay.has(e.type)) dosyaSay.set(e.type, new Map());
      dosyaSay.get(e.type).set(e.file_id || '', (dosyaSay.get(e.type).get(e.file_id || '') || 0) + e.amount_cents);
    }
    for (const [tur, dosyalar] of dosyaSay) {
      if (dosyalar.size < 2) continue;
      conflictNotes.push((EVENT_TYPES[tur] || 'Gider') + ' iki ayrı raporda, paket numarası olmadan ve farklı tutarlarla geldi (' +
        [...dosyalar.values()].map(v => (v / 100).toFixed(2)).join(' / ') +
        ' TL). Aynı giderin iki beyanı mı, iki paketin ayrı gideri mi belli değil; toplanmadı, kâr hesaplanmadı.');
    }
    // Paket numarası olmayan SİPARİŞ düzeyindeki gider bir kez sayılır: tek pakette olduğu gibi,
    // bölünmüş siparişte toplamı koruyarak paketlere dağıtılır.
    const grossOf = p => p.lines.reduce((s, l) => s + (l.gross || 0), 0);
    const weights = list.map(p => grossOf(p));
    const evenSplit = weights.some(w => !w);
    const sharedNotes = [];
    for (const e of shared) {
      if (list.length === 1) { packageEvents.get(list[0].group).push(e); continue; }
      const shares = evenSplit ? list.map(() => 1) : weights;
      const parts = allocateCents(e.amount_cents, shares);
      // Bildirilen net hakediş kaynak kapsamına aittir; kopyalanırsa sipariş toplamı çoğalır.
      const netParts = Number.isSafeInteger(e.net_payout) ? allocateCents(e.net_payout, shares) : null;
      list.forEach((p, i) => packageEvents.get(p.group).push({...e, amount_cents: parts[i], ...(netParts ? {net_payout: netParts[i]} : {}), allocated: true}));
      sharedNotes.push((EVENT_TYPES[e.type] || 'Gider') + ' sipariş düzeyinde geldi; ' + list.length + ' pakete tutar korunarak dağıtıldı' +
        (netParts ? ' (bildirilen net hakediş de aynı oranda bölündü; sipariş toplamı değişmedi)' : '') +
        (evenSplit ? ' (satır tutarı bilinmediği için eşit bölündü; dağılım belirsiz).' : '.'));
    }

    for (const g of list) {
      const events = packageEvents.get(g.group);
      const missing = [...conflictNotes], notes = [...sharedNotes, ...conflictNotes, ...(kabaNot.get(order) || [])], date = String(g.order_date || '').slice(0, 10);
      // Teslim edilmeyen pakette kargo maliyeti kesinleşmez (iade, yeniden gönderim, ceza).
      // Komisyon kesilmiş görünse bile kâr HESAPLANMAZ; tahmin bölümü ayrıca durur.
      const {delivered, delivered_on} = deliveryOf(g.lines);
      if (!delivered) missing.push('Teslim edilmedi' + (g.status ? ' (' + g.status + ')' : '') + ': kargo maliyeti kesinleşmediği için kâr hesaplanmaz.');
      // cogsIncl: malın KDV DAHİL maliyeti. Nakit sonuç için gerekir — kasadan çıkan para budur.
      let netSales = 0, cogs = 0, cogsIncl = 0;
      const defterKaydi = g.erp_package_id ? defter.get(g.erp_package_id) || null : null;
      for (const line of g.lines) {
        const comps = line.components?.components || null;
        if (!comps) { missing.push('Ürün/set eşleşmesi yok: ' + (line.barcode || line.sku || line.product_name || 'ürün')); netSales = null; cogs = null; cogsIncl = null; continue; }
        if (line.components.after_order) notes.push((line.barcode || line.sku) + ': set tanımı sipariş tarihinden sonra; eski içerik doğrulanmalı.');
        line.vat_bps = await vatOf(db, comps.map(c => c.product_id), memo);
        if (line.gross === undefined) { missing.push('Satış tutarı yok (sipariş ' + line.order_no + ')'); netSales = null; }
        else if (line.vat_bps === null) { missing.push('KDV oranı tanımlı değil: ' + (line.barcode || line.sku)); netSales = null; }
        else if (netSales !== null) netSales += exVat(line.gross, line.vat_bps);
        if (defterKaydi) continue; // maliyet defterden alınacak; burada yeniden hesaplanmaz
        for (const c of comps) {
          const cost = await unitCostAt(db, c.product_id, date, memo);
          if (!cost) { missing.push('Maliyet yok: ' + c.product_id + ' (' + date + ' öncesi giriş bulunamadı)'); cogs = null; cogsIncl = null; continue; }
          // İki adet ikili set = her üründen 2 × set içindeki miktar.
          const satirMaliyet = Math.round(cost.cents_per_unit * c.quantity_milli * (line.quantity || 0) / 1000);
          if (cogs !== null) cogs += satirMaliyet;
          if (cogsIncl !== null) {
            if (line.vat_bps === null) { cogsIncl = null; continue; }
            cogsIncl += Math.round(satirMaliyet * (10000 + line.vat_bps) / 10000);
          }
        }
      }
      // Defterde kaydı olan paketin maliyeti DEFTERİNKİDİR: iade dönüşü ve gönderim anında
      // dondurulan maliyet ancak orada bilinir. Böylece Kâr raporu ile bu ekran aynı rakamı verir.
      if (defterKaydi) {
        if (defterKaydi.eksik) { missing.push('Paketin ' + defterKaydi.eksik + ' satırı deftere işlenmemiş; maliyet eksik.'); cogs = null; cogsIncl = null; }
        else { cogs = defterKaydi.cost; cogsIncl = defterKaydi.incl; if (cogsIncl === null) missing.push('Defterdeki ürünün KDV oranı tanımlı değil; nakit sonuç hesaplanmadı.'); }
      } else if (cogs !== null) notes.push('Bu paket deftere bağlı değil; maliyet sipariş tarihindeki birim maliyetten hesaplandı.');
      const sum = type => events.filter(e => e.type === type).reduce((s, e) => s + e.amount_cents, 0);
      const has = type => events.some(e => e.type === type);
      const refunds = sum('refund');
      const vatForRefund = g.lines.length && g.lines.every(l => l.vat_bps === g.lines[0].vat_bps) ? g.lines[0].vat_bps : null;
      if (refunds && netSales !== null) { if (vatForRefund === null) { missing.push('İadenin KDV oranı belirlenemedi'); netSales = null; } else netSales += exVat(refunds, vatForRefund); }
      if (refunds) notes.push('İade var: ürün fiziken dönmeden stok ve maliyet geri alınmaz.');

      let fees = 0, vatUnknown = false;
      const feeRows = [];
      // İndirim "diğer kesinti" içinde toplanır; etiketten ayırt edilemez, KAYNAK alanına bakılır.
      // DİKKAT: /indirim/i deseni 'ek:İndirim' ile EŞLEŞMEZ — Türkçe büyük İ (U+0130) ASCII i'ye
      // katlanmaz. Karşılaştırma tr-TR küçültmesiyle yapılır.
      const trKucuk = v => String(v ?? '').toLocaleLowerCase('tr-TR');
      const indirimOlay = events.filter(e => trKucuk(e.source_field).includes('indirim'));
      const indirimBrut = indirimOlay.reduce((t, e) => t + -e.amount_cents, 0);
      for (const t of FEE_TYPES) {
        if (!has(t)) continue;
        const rows = events.filter(e => e.type === t);
        const raw = rows.reduce((s, e) => s + e.amount_cents, 0);
        // net_cents: katkıya giren KDV hariç tutar. Deftere de bu yazılır; ekranla defter ayrışmasın.
        let net = 0;
        for (const e of rows) { const v = feeVatOf(e); if (v === null) vatUnknown = true; const x = v ? exVat(e.amount_cents, v) : e.amount_cents; fees += x; net += x; }
        feeRows.push({type: t, label: EVENT_TYPES[t], actual_cents: raw, net_cents: net, evidence: rows.filter(e => e.invoice_line_id).length, allocated: rows.some(e => e.allocated),
          source_columns: [...new Set(rows.filter(e => e.amount_cents).map(sutunAdi).filter(Boolean))]});
      }
      // Sipariş raporundaki paket kargosu: finans kaydı yoksa ve paketteki bütün satırlarda aynıysa BİR kez.
      if (!has('cargo')) {
        const cargoValues = [...new Set(g.lines.map(l => l.cargo_package).filter(v => v !== undefined))];
        if (cargoValues.length === 1) { const v = -Math.abs(cargoValues[0]); feeRows.push({type: 'cargo', label: 'Kargo (sipariş raporu, paket başına)', actual_cents: v, net_cents: v, evidence: 0}); fees += v; vatUnknown = true; }
        else if (cargoValues.length > 1) missing.push('Paketin satırlarında farklı kargo ücretleri var; tek kargo kabul edilmedi.');
      }
      if (vatUnknown && feeRows.length) notes.push('Kesinti tutarlarının KDV durumu profilde belirtilmedi; katkı yaklaşık.');

      // Tahmin: yalnızca gerçekleşmiş kaydı OLMAYAN gider türleri için. Gerçek gelince tahmin kaybolur.
      // Bu blok paket başına geçmiş tarar; okuma maliyetinin büyük kısmı burada. Özet ve kesinti
      // aktarımı tahmin kullanmadığı için oralarda hiç çalıştırılmaz (withEstimates=false).
      const signature = packageSignature(g.lines), estimates = [];
      if (withEstimates && !feeRows.some(r => r.type === 'commission')) {
        let total = 0, unknownLines = 0;
        const basis = new Set();
        for (const line of g.lines) {
          const est = await tariffEstimate(db, store.provider, 'commission', line, date);
          if (est) { total += est.value; basis.add(est.basis); } else unknownLines++;
        }
        if (!unknownLines && basis.size) estimates.push({type: 'commission', label: EVENT_TYPES.commission, value: total, low: total, high: total, samples: 0, basis: [...basis].join(' · ') + ' — paketteki ' + g.lines.length + ' satırın toplamı'});
        else {
          const obs = await observedFor(db, store.id, 'commission', signature, date, g.group);
          estimates.push(obs ? {type: 'commission', label: EVENT_TYPES.commission, ...obs}
            : {type: 'commission', label: EVENT_TYPES.commission, value: null, partial_cents: unknownLines && total ? total : null,
              basis: unknownLines ? unknownLines + ' satırın tarifesi yok; kısmi hesap tam tahmin sayılmaz.' : 'Tahmin için yeterli veri yok (sıfır sayılmadı).'});
        }
      }
      if (withEstimates && !feeRows.some(r => r.type === 'cargo')) {
        const obs = await observedFor(db, store.id, 'cargo', signature, date, g.group);
        estimates.push(obs ? {type: 'cargo', label: EVENT_TYPES.cargo, ...obs}
          : {type: 'cargo', label: EVENT_TYPES.cargo, value: null, basis: 'Kargo tarifesi (desi) bağlanmadı; aynı içerikli paketten yeterli kayıt da yok.'});
      }
      const payouts = events.filter(e => e.source_field === 'net_payout' || e.type === 'payout');
      // Bildirilen hakediş DOSYA BAZINDA okunur. İki rapor aynı paketi kapsıyorsa tutarlar
      // TOPLANMAZ: her dosya o paketin hakedişinin TAMAMINI söyler, parçasını değil. En yeni
      // raporun rakamı geçerlidir; rakamlar çelişiyorsa toplanmaz, not düşülür.
      const netKayit = [...new Map(events.filter(e => e.net_payout !== undefined).map(e => [sourceKey(e), e])).values()];
      let reported = null;
      if (netKayit.length) {
        const dosyaBazli = new Map();
        for (const e of netKayit) {
          const fid = e.file_id || '';
          const v = dosyaBazli.get(fid) || {tutar: 0, zaman: ''};
          v.tutar += e.net_payout;
          if (String(e.source_time || '') > v.zaman) v.zaman = String(e.source_time || '');
          dosyaBazli.set(fid, v);
        }
        const sirali = [...dosyaBazli.values()].sort((a, b) => b.zaman.localeCompare(a.zaman));
        reported = sirali[0].tutar;
        if (sirali.some(v => v.tutar !== reported))
          notes.push('Bildirilen hakediş raporlara göre değişiyor (' + sirali.map(v => (v.tutar / 100).toFixed(2)).join(' / ') +
            ' TL). Toplanmadı; en yeni rapordaki tutar kullanıldı.');
      } else if (payouts.length) reported = payouts.reduce((s, e) => s + e.amount_cents, 0);
      // Gider kalemi ARTI geldiyse bu bir kesinti değil, geri verilen/karşılanan tutardır.
      // Hesaba raporda yazdığı gibi girer ama sessiz kalmaz: kâr onunla oluşmuş olabilir.
      // Artı gelen kalem gider değildir: pazaryerinin GERİ VERDİĞİ tutardır (karşıladığı indirim,
      // iade edilen kesinti). Hesaba raporda yazdığı gibi girer; hangi sütundan geldiği söylenir ki
      // "kâr buradan mı geldi" sorusu ekranda cevaplansın.
      for (const r of feeRows) if (r.actual_cents > 0)
        notes.push(r.label + ' raporda ARTI geldi (+' + (r.actual_cents / 100).toFixed(2) + ' TL' +
          (r.source_columns?.length ? ', kaynak sütun: ' + r.source_columns.join(', ') : '') +
          '): kesinti değil, pazaryerinin karşıladığı/geri verdiği tutar olarak gelire sayıldı.');
      const computed = events.filter(e => e.type && e.type !== 'payout').reduce((s, e) => s + e.amount_cents, 0);
      // basis: hesabın kendisi. GERÇEKLEŞMİŞ katkı yalnızca teslim edilmiş pakette raporlanır;
      // teslim edilmemiş paket için aynı hesap "tahmini sonuç" olarak ayrı alanda kalır.
      const basis = conflictNotes.length || netSales === null || cogs === null ? null : netSales - cogs + fees;
      const contribution = delivered ? basis : null;
      // NAKİT SONUÇ: hesaba giren para − malın KDV dahil maliyeti. KDV'siz katkıdan farklıdır
      // ve kullanıcının gördüğü rakam budur. Gelir tarafında ÖNCE raporun kendi net hakediş
      // rakamı kullanılır: bankaya giren odur. Rapor net söylemiyorsa kalemlerin toplamı alınır.
      const nakitGelir = reported !== null ? reported : events.length ? computed : null;
      if (reported !== null && events.length && Math.abs(reported - computed) > 1)
        notes.push('Raporun bildirdiği hakediş (' + (reported / 100).toFixed(2) + ' TL) kalemlerin toplamıyla (' +
          (computed / 100).toFixed(2) + ' TL) aynı değil. Nakit sonuç raporun rakamıyla hesaplandı; ' +
          ((reported - computed) / 100).toFixed(2) + ' TL fark incelenmeli.');
      const cashBasis = conflictNotes.length || nakitGelir === null || cogsIncl === null ? null : nakitGelir - cogsIncl;
      const cash = delivered ? cashBasis : null;
      const complete = estimates.every(e => e.value !== null);
      const estimatedFees = estimates.reduce((s, e) => s + (e.value || 0), 0);
      results.push({
        ...g, delivered, delivered_on,
        lines: g.lines.map(l => ({order_no: l.order_no, barcode: l.barcode, sku: l.sku, product_name: l.product_name, quantity: l.quantity, gross_cents: l.gross ?? null,
          components: l.components?.components || null})),
        reported_net_cents: reported, computed_net_cents: events.length ? computed : null,
        bank_verified_cents: null, bank_note: 'Banka hareketleriyle eşleştirme henüz bağlanmadı.',
        withholding_cents: has('withholding') ? sum('withholding') : null,
        net_sales_ex_vat_cents: netSales, cogs_cents: cogs, cogs_incl_vat_cents: cogsIncl, fees: feeRows,
        contribution_cents: contribution, contribution_missing: missing,
        cash_result_cents: cash, cash_income_cents: nakitGelir,
        cash_basis: nakitGelir === null ? null : reported !== null ? 'rapor' : 'hesap',
        estimated_cash_cents: cashBasis !== null && complete && estimates.length ? cashBasis + estimatedFees : null,
        fee_events: events.filter(e => FEE_TYPES.includes(e.type)).map(e => ({id: e.id, type: e.type, label: EVENT_TYPES[e.type], amount_cents: e.amount_cents, invoice_line_id: e.invoice_line_id || null, allocated: !!e.allocated})),
        discount_gross_cents: indirimBrut,
        discount_net_cents: indirimOlay.reduce((t, e) => { const v = feeVatOf(e); return t + -(v ? exVat(e.amount_cents, v) : e.amount_cents); }, 0),
        estimates, estimated_result_cents: basis !== null && complete && estimates.length ? basis + estimatedFees : null,
        notes
      });
    }
  }
  return results;
}

/**
 * Bir mağazanın siparişleri için sonuç — PARÇALI.
 * Tek istekte yüzlerce sipariş taranırsa çalışma süresi sınırı aşılır (503). Bu yüzden
 * `cursor`'dan başlayıp en çok `take` sipariş işlenir ve kaldığı yer `next_cursor` ile bildirilir.
 */
async function allPackages(db, store, {q = '', status = '', cursor = 0, take = 0, withEstimates = false} = {}) {
  const memo = await preload(db, newMemo()), out = [];
  const needle = String(q || '').trim().toLocaleLowerCase('tr-TR').slice(0, 100);
  const where = "store_id=? AND kind='order_line'"
    + (needle ? " AND (instr(lower(COALESCE(json_extract(data_json,'$.order_no'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.package_id'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.barcode'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.sku'),'')),?)>0 OR instr(lower(COALESCE(json_extract(data_json,'$.product_name'),'')),?)>0)" : '')
    + (status ? " AND json_extract(data_json,'$.status')=?" : '');
  const args = [...(needle ? [needle, needle, needle, needle, needle] : []), ...(status ? [String(status).slice(0, 100)] : [])];
  // Sıralama sabit olmalı: parçalı okumada aynı sipariş iki kez işlenmesin, atlanmasın.
  const orderNos = (await db.prepare("SELECT DISTINCT json_extract(data_json,'$.order_no') o FROM ec_report_records WHERE " + where + ' ORDER BY o')
    .bind(store.id, ...args).all()).results.map(r => r.o).filter(o => o !== null && o !== undefined);
  const from = Math.max(0, Number(cursor) || 0);
  const dilim = take > 0 ? orderNos.slice(from, from + take) : orderNos.slice(from);
  for (const part of inChunks(dilim, 25)) out.push(...await packagesFor(db, store, part, memo, {withEstimates}));
  const next = from + dilim.length;
  return {results: out, total_orders: orderNos.length, next_cursor: next < orderNos.length ? next : null};
}

/** Mağaza geneli özet: kaç paket teslim edildi, kaçı kârda, kaçı zararda, toplam ne. */
export async function orderSummary(db, storeId, {q = '', status = '', cursor = 0, take = 60} = {}) {
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);
  const {results: all, total_orders, next_cursor} = await allPackages(db, store, {q, status, cursor, take});
  const delivered = all.filter(r => r.delivered);
  // Kar/zarar sayimi NAKIT sonuca gore yapilir: hesaba giren para eksi malin KDV dahil maliyeti.
  // KDV haric katki ayrica raporlanir ama kac paket zararda sorusunun cevabi nakittir.
  const computed = delivered.filter(r => r.cash_result_cents !== null);
  const losing = computed.filter(r => r.cash_result_cents < 0).sort((a, b) => a.cash_result_cents - b.cash_result_cents);
  const winning = computed.filter(r => r.cash_result_cents >= 0);
  const row = r => ({group: r.group, order_no: r.order_no, package_id: r.package_id, order_date: r.order_date, status: r.status,
    delivered_on: r.delivered_on, contribution_cents: r.contribution_cents, net_sales_ex_vat_cents: r.net_sales_ex_vat_cents,
    cash_result_cents: r.cash_result_cents, cash_income_cents: r.cash_income_cents, cash_basis: r.cash_basis,
    cogs_cents: r.cogs_cents, cogs_incl_vat_cents: r.cogs_incl_vat_cents, fees: r.fees, missing: r.contribution_missing.slice(0, 4),
    notes: (r.notes || []).slice(0, 4),
    products: r.lines.map(l => (l.product_name || l.barcode || l.sku || '') + ' ×' + (l.quantity ?? 1)).join(', ').slice(0, 200)});
  return {
    store, next_cursor, total_orders,
    packages: all.length,
    delivered: delivered.length,
    not_delivered: all.length - delivered.length,
    computed: computed.length,
    uncomputed: delivered.length - computed.length,
    profitable: winning.length,
    losing: losing.length,
    cash_result_cents: computed.reduce((s, r) => s + r.cash_result_cents, 0),
    cash_profit_cents: winning.reduce((s, r) => s + r.cash_result_cents, 0),
    cash_loss_cents: losing.reduce((s, r) => s + r.cash_result_cents, 0),
    // KDV haric katki: vergi beyani icin durur, ekranda one cikarilmaz.
    contribution_cents: computed.reduce((s, r) => s + (r.contribution_cents || 0), 0),
    profit_cents: winning.reduce((s, r) => s + (r.contribution_cents || 0), 0),
    loss_cents: losing.reduce((s, r) => s + (r.contribution_cents || 0), 0),
    worst: losing.slice(0, 50).map(row),
    // Teslim edilmiş ama hesaplanamayanlar: neyin eksik olduğu tek tek yazılır, sıfır sayılmaz.
    blocked: delivered.filter(r => r.cash_result_cents === null).slice(0, 50).map(row),
    notice: 'Tutarlar NAKİTtİr: hesabına giren para eksi malın KDV dahil maliyeti. Kâr YALNIZCA teslim edilmiş paketler için hesaplanır; kargodaki paketin kargo maliyeti kesinleşmemiştir.',
    ledger_notice: 'Bu ekran YALNIZCA pazaryeri raporundan hesaplar; defteri okumaz. İki yerde fark çıkabilir: (1) iade edilip stoğa dönen malın maliyeti burada hâlâ düşülür, defterde geri alınır; (2) maliyet burada sipariş tarihindeki birim maliyettir, defterde gönderim anında dondurulan maliyettir. Kesin rakam Kâr raporudur; burası çapraz kontroldür.'
  };
}

/* ---------------- rapordaki kesintileri satış kayıtlarına aktarma ---------------- */

/** Rapor gider türü → satış kaydındaki alan. İade, stopaj ve satış buraya GİRMEZ. */
const FEE_COMPONENT = {commission: 'commission', cargo: 'shipping', service: 'other', other_fee: 'other'};

/**
 * Pazaryeri raporundaki kesintileri, ERP'de bağlı paketlerin satış kayıtlarına yazar.
 * Fatura İSTEMEZ: tutarlar pazaryerinin kendi hesap raporundan gelir.
 *
 *  - Yalnızca erp_package_id ile bağlı paketler işlenir; bağsız pakete tutar uydurulmaz.
 *  - Tutar, paketin satış kayıtlarına gelirleri oranında ve toplamı KORUNARAK bölünür.
 *  - Yazma SET'tir, toplama DEĞİL: aynı rapor tekrar tekrar aktarılsa da sonuç aynı kalır.
 *  - Faturaya bağlanmış (fee_allocations) kayda dokunulmaz; fatura her zaman üstündür.
 *  - fees_status 'pending' kalır: bu tutarlar faturayla doğrulanmadı.
 */
export async function applyReportFees(db, storeId, {commit = false, cursor = 0, take = 50} = {}) {
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);
  const {results, total_orders, next_cursor} = await allPackages(db, store, {cursor, take});
  const all = results.filter(r => r.erp_package_id);
  const writes = [], skipped = [], changes = [];
  for (const g of all) {
    // Teslim edilmemiş pakette kargo kesinleşmemiştir; deftere de yazılmaz (kâr kuralıyla aynı çizgi).
    if (!g.delivered) { skipped.push({group: g.group, reason: 'Teslim edilmedi; kargo kesinleşmeden kesinti yazılmaz.'}); continue; }
    const want = {commission: 0, shipping: 0, other: 0}, kaynak = {commission: false, shipping: false, other: false};
    for (const f of g.fees) {
      const comp = FEE_COMPONENT[f.type];
      if (!comp) continue;
      // Rapor kesintileri negatif gelir; defterde kesinti POZİTİF saklanıp kârdan düşülür.
      const tutar = -(f.net_cents ?? f.actual_cents);
      want[comp] += tutar;
      if (tutar !== 0) kaynak[comp] = true;
    }
    // Teslim edilmiş bir pazaryeri paketinde komisyon ve kargo MUTLAKA vardır; yoksa rapor eksiktir
    // ve sıfır yazmak veri uydurmak olur. "Diğer" kalemi ise gerçekten alınmamış olabilir: 0 yazılır.
    if (!kaynak.commission || !kaynak.shipping) {
      skipped.push({group: g.group, reason: 'Raporda ' + (!kaynak.commission ? 'komisyon' : 'kargo') + ' kesintisi yok; eksik veri sıfır sayılmaz.'});
      continue;
    }
    // İNDİRİM ÇİFT SAYIMI. Pazaryeri indirimi satış fiyatının İÇİNDE olabilir: Trendyol
    // "Tutar 423,61 · İndirim −30,00 · Net Tutar 320,00" yazar ve komisyonu 393,61 üzerinden
    // (%18,7) keser — yani müşterinin ödediği 393,61'dir, indirim zaten uygulanmıştır.
    // Böyle bir siparişte indirimi bir de gider yazmak aynı parayı iki kez düşer.
    // Karar sipariş bazında verilir: defterdeki brüt, rapordaki brütten indirim kadar düşükse
    // indirim zaten uygulanmıştır ve gidere EKLENMEZ. Tahmin yok, iki rakam karşılaştırılır.
    const indirimBrut = g.discount_gross_cents || 0;
    if (indirimBrut > 0) {
      const raporBrut = g.lines.reduce((t, l) => t + (l.gross_cents || 0), 0);
      const defter = await db.prepare('SELECT COALESCE(SUM(gross_cents),0) b FROM ec_order_lines WHERE package_id=?').bind(g.erp_package_id).first();
      if (Math.abs((raporBrut - defter.b) - indirimBrut) <= 2) {
        want.other -= (g.discount_net_cents || 0);
        skipped.push({group: g.group, reason: 'İndirim satış fiyatına zaten uygulanmış; gider olarak ikinci kez yazılmadı (' + (indirimBrut / 100).toFixed(2) + ' TL).'});
      }
    }
    const rows = (await db.prepare(
      'SELECT c.sale_id,s.revenue_cents,s.commission_cents,s.shipping_cents,s.other_cents,s.fees_status,' +
      '(SELECT COUNT(*) FROM ec_fee_allocations a WHERE a.sale_id=c.sale_id AND a.reversed_at IS NULL) faturali ' +
      'FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_sale_entries s ON s.id=c.sale_id ' +
      "WHERE l.package_id=? AND s.kind='sale' ORDER BY c.id").bind(g.erp_package_id).all()).results;
    if (!rows.length) { skipped.push({group: g.group, reason: 'ERP paketinde satış kaydı yok (stok çıkışı yapılmamış).'}); continue; }
    if (rows.some(r => r.faturali)) { skipped.push({group: g.group, reason: 'Bu paketin gideri faturaya bağlanmış; fatura üstündür, dokunulmadı.'}); continue; }
    // Gelirleri oranında böl; hepsi sıfırsa eşit böl. allocateCents toplamı korur.
    const weights = rows.map(r => r.revenue_cents);
    const shares = weights.some(w => w > 0) ? weights : rows.map(() => 1);
    const parts = Object.fromEntries(Object.entries(want).map(([c, v]) => [c, allocateCents(v, shares)]));
    rows.forEach((r, i) => {
      const next = {commission: parts.commission[i], shipping: parts.shipping[i], other: parts.other[i]};
      if (r.commission_cents === next.commission && r.shipping_cents === next.shipping && r.other_cents === next.other
        && r.fees_status === 'confirmed') return;
      changes.push({sale_id: r.sale_id, group: g.group, erp_package_id: g.erp_package_id,
        before: {commission: r.commission_cents, shipping: r.shipping_cents, other: r.other_cents},
        after: next});
    });
    writes.push({group: g.group, erp_package_id: g.erp_package_id, ...want});
  }
  if (commit && changes.length) {
    for (const part of inChunks(changes, 40)) {
      await db.batch(part.flatMap(c => [
        // Üç bileşen de bilindiği için 'confirmed': kaynak pazaryerinin KENDİ hesap raporudur.
        // Sonradan fatura gelirse devralma koruması (FEE_TAKEOVER_REQUIRED) yine devrededir.
        db.prepare("UPDATE ec_sale_entries SET commission_cents=?,shipping_cents=?,other_cents=?,fees_status='confirmed' WHERE id=?")
          .bind(c.after.commission, c.after.shipping, c.after.other, c.sale_id),
        db.prepare('INSERT INTO ec_fee_audit(id,sale_id,old_values,new_values) VALUES(?,?,?,?)')
          .bind(id(), c.sale_id, JSON.stringify(c.before), JSON.stringify({...c.after, source: 'pazaryeri raporu', package: c.erp_package_id}))
      ]));
    }
  }
  return {
    store, commit, next_cursor, total_orders,
    packages: all.length, applied: writes.length, sale_entries_changed: changes.length,
    skipped: skipped.slice(0, 100), skipped_total: skipped.length,
    totals: writes.reduce((t, w) => ({commission: t.commission + w.commission, shipping: t.shipping + w.shipping, other: t.other + w.other}), {commission: 0, shipping: 0, other: 0}),
    notice: commit
      ? 'Kesintiler satış kayıtlarına yazıldı. Stok, satış tutarı ve fatura DEĞİŞMEDİ; yalnızca kesinti alanları doldu. Tutarlar faturayla doğrulanmadığı için "kesinleşmedi" kalır.'
      : 'Önizleme: hiçbir şey yazılmadı. Aşağıdaki tutarlar yazılacak olanlardır.'
  };
}

/**
 * Raporda İADE görünen ama defterde hâlâ tam gelirle duran paketler.
 * Bu uç YAZMAZ, yalnızca listeler: hangi satış kaydının ne kadar iade edilmesi gerektiğini söyler.
 * İadeyi mevcut ve korumaları denenmiş satış iadesi ucu yazar; burada ikinci bir defter yolu açılmaz.
 *
 * İade edilen siparişte mal geri döner (maliyet geri alınır) ama GİDİŞ KARGOSU, DÖNÜŞ KARGOSU ve
 * hizmet bedeli cepte kalır: zarar satıştan değil, iadeden doğar. Bu yüzden kesintiler silinmez.
 */
export async function pendingReturns(db, storeId) {
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);
  const rows = (await db.prepare(
    "SELECT json_extract(r.data_json,'$.order_no') order_no, r.erp_package_id," +
    " (SELECT SUM(json_extract(f.data_json,'$.amount_cents')) FROM ec_report_records f" +
    "  WHERE f.store_id=r.store_id AND f.kind='finance_event' AND json_extract(f.data_json,'$.type')='refund'" +
    "  AND json_extract(f.data_json,'$.order_no')=json_extract(r.data_json,'$.order_no')) refund_cents," +
    " SUM(json_extract(r.data_json,'$.gross')) rapor_brut" +
    " FROM ec_report_records r WHERE r.store_id=? AND r.kind='order_line' AND r.erp_package_id IS NOT NULL" +
    " GROUP BY r.erp_package_id").bind(store.id).all()).results.filter(x => x.refund_cents && x.refund_cents < 0);

  const out = [], skipped = [];
  for (const x of rows) {
    const sales = (await db.prepare(
      'SELECT c.sale_id,s.revenue_cents,s.quantity_milli,p.sku,' +
      '(SELECT COUNT(*) FROM ec_sale_entries r WHERE r.parent_id=s.id) iade_var' +
      ' FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id' +
      " JOIN ec_sale_entries s ON s.id=c.sale_id JOIN ec_products p ON p.id=s.product_id" +
      " WHERE l.package_id=? AND s.kind='sale' ORDER BY c.id").bind(x.erp_package_id).all()).results;
    if (!sales.length) { skipped.push({order_no: x.order_no, reason: 'Pakette satış kaydı yok.'}); continue; }
    if (sales.some(r => r.iade_var)) { skipped.push({order_no: x.order_no, reason: 'Bu paketin iadesi zaten girilmiş.'}); continue; }
    // Rapor iadesi paketin TAMAMINI kapsıyorsa satırların tamamı iade edilir. Kısmi iadede
    // hangi satırın iade edildiği raporda yazmadığı için elle karara bırakılır: uydurulmaz.
    // Tam iade ölçüsü RAPORDAKİ satış tutarıdır: iade onu aynalar. Defterdeki KDV hariç tutarla
    // karşılaştırmak indirimli siparişlerde şaşırır, çünkü iade indirimsiz tutarı gösterir.
    const iade = Math.abs(x.refund_cents), raporBrut = x.rapor_brut || 0;
    const tamIade = raporBrut > 0 && Math.abs(iade - raporBrut) <= 200;
    if (!tamIade) { skipped.push({order_no: x.order_no, reason: 'Kısmi iade (' + (iade / 100).toFixed(2) + ' TL); hangi satırın iade edildiği raporda yok, elle girilmeli.'}); continue; }
    out.push({order_no: x.order_no, erp_package_id: x.erp_package_id, refund_cents: iade,
      lines: sales.map(r => ({sale_id: r.sale_id, sku: r.sku, quantity: r.quantity_milli / 1000, revenue_cents: r.revenue_cents}))});
  }
  return {store, pending: out, skipped,
    notice: 'Bu liste yazmaz. İade kaydı, mevcut satış iadesi ucundan girilir; mal stoğa döner, kargo ve hizmet bedeli gider olarak kalır.'};
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
    // Hepsiburada finans dökümünde işlem tarihi sütunu yoktur. Profil bunu AÇIKÇA beyan ederse
    // tarih alanı boş bırakılabilir; kayıtlar "tarihi bilinmeyen" olarak saklanır. Beyan edilmeden
    // zorunlu alan atlanamaz ve beyan varken tarih sütunu eşlenemez: ikisi birbiriyle çelişir.
    const undated = x.kind === 'finance' && x.options?.undated === true;
    if (undated && mapping.event_date) fail('Tarihsiz rapor işaretlendi ama bir tarih sütunu da eşlendi. Birini seçin.');
    for (const f of FIELDS[x.kind]) {
      if (!f.required || mapping[f.key]) continue;
      if (undated && f.key === 'event_date') continue;
      fail(f.label + ' eşlenmeli.');
    }
    if (x.kind === 'orders' && !mapping.barcode && !mapping.sku) fail('Barkod ya da stok kodu eşlenmeli; set ve maliyet bununla bulunur.');
    if (x.kind === 'finance' && !FIELDS.finance.some(f => (f.type === 'money') && mapping[f.key])) fail('En az bir tutar sütunu eşlenmeli.');
    const typeMap = {};
    for (const [t, v] of Object.entries(x.options?.type_map || {})) { if (!EVENT_TYPES[v]) fail('İşlem türü karşılığı geçersiz.'); typeMap[String(t).slice(0, 200)] = v; }
    const extraFees = [];
    for (const e of (Array.isArray(x.options?.extra_fees) ? x.options.extra_fees : [])) {
      if (x.kind !== 'finance') fail('Ek kesinti sütunu yalnız finans raporunda olur.');
      const h = String(e?.header ?? '');
      if (!headers.includes(h)) fail('Ek kesinti için seçilen sütun dosyada yok: ' + h);
      if (Object.values(mapping).includes(h)) fail('"' + h + '" hem bir alana hem ek kesintiye eşlenemez.');
      if (extraFees.some(v => v.header === h)) fail('"' + h + '" iki kez eklenemez.');
      if (!EVENT_TYPES[e?.type] || e.type === 'ignore' || e.type === 'payout') fail('Ek kesinti türü geçersiz: ' + h);
      extraFees.push({header: h, type: e.type});
    }
    const options = {type_map: typeMap, fees_positive: x.options?.fees_positive === true, undated, extra_fees: extraFees,
      fee_amounts_include_vat: x.options?.fee_amounts_include_vat === true ? true : x.options?.fee_amounts_include_vat === false ? false : null,
      fee_vat_bps: Number.isInteger(x.options?.fee_vat_bps) && x.options.fee_vat_bps >= 0 && x.options.fee_vat_bps <= 10000 ? x.options.fee_vat_bps : null,
      ignored: headers.filter(h => !Object.values(mapping).includes(h) && !extraFees.some(v => v.header === h))};
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
  // Kesinti tutarlarinin KDV durumu profilde BEYAN EDILMEMISSE, sistem tutari KDV haricmis gibi
  // kullanir ve gider oldugundan yuksek gorunur. Bu uc o eksik beyani tamamlar: TUTARLAR DEGISMEZ,
  // yalnizca "bu rakam KDV dahildir" bilgisi kaydedilir.
  // Yalniz BIR KEZ, henuz beyan edilmemis profile yazilabilir. Boylece gecmis hesap ileri geri
  // oynatilamaz; yanlis beyan edilmisse yeni profil surumu acilir.
  const feeVat = sub.match(/^\/profiles\/([\w-]+)\/fee-vat$/);
  if (feeVat && method === 'POST') {
    const x = await readBody(request);
    const p = await db.prepare('SELECT * FROM ec_report_profiles WHERE id=?').bind(key(feeVat[1])).first();
    if (!p) fail('Eşleştirme profili bulunamadı.', 404);
    const o = parse(p.options_json, {});
    if (o.fee_amounts_include_vat !== undefined && o.fee_amounts_include_vat !== null)
      fail('Bu profilde kesinti KDV durumu zaten beyan edilmiş; değiştirmek için yeni profil sürümü açın.', 409);
    if (typeof x.include_vat !== 'boolean') fail('Kesintilerin KDV dahil olup olmadığını belirtin.');
    if (x.include_vat && !(Number.isInteger(x.vat_bps) && x.vat_bps >= 0 && x.vat_bps <= 10000)) fail('KDV oranı geçersiz.');
    const next = {...o, fee_amounts_include_vat: x.include_vat, ...(x.include_vat ? {fee_vat_bps: x.vat_bps} : {})};
    await db.batch([
      db.prepare('UPDATE ec_report_profiles SET options_json=? WHERE id=?').bind(JSON.stringify(next), p.id),
      db.prepare('INSERT INTO ec_activity(id,description) VALUES(?,?)').bind(id(),
        'Kesinti KDV beyanı tamamlandı: ' + p.provider + ' ' + p.kind + ' v' + p.version +
        ' → ' + (x.include_vat ? 'KDV dahil %' + (x.vat_bps / 100) : 'KDV hariç'))
    ]);
    return {id: p.id, provider: p.provider, kind: p.kind, version: p.version,
      fee_amounts_include_vat: x.include_vat, fee_vat_bps: x.include_vat ? x.vat_bps : null,
      notice: 'Tutarlar değişmedi; yalnızca KDV durumu beyan edildi. Katkı hesabı artık kesintileri KDV hariç kullanır.'};
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
      // Kimliksiz ikizler ve dosya içi tekrarlar burada bir kez bulunur; her aktarım partisinde
      // bütün dosyanın yeniden okunması gerekmez.
      const sealProfile = await loadProfile(db, f);
      const sealNorm = normalizeRows(sealProfile, parse(f.headers_json, []), await fileRows(db, f.id, 0, Number.MAX_SAFE_INTEGER), {date1904: !!f.date1904});
      const twins = [...new Set(sealNorm.records.filter(r => r.issues.some(i => i.code === 'ambiguous_twin')).map(r => r.kind + '|' + r.key))];
      const firstRow = {};
      for (const r of sealNorm.records) { const k = r.kind + '|' + r.key; if (firstRow[k] === undefined) firstRow[k] = r.row; }
      const duplicates = {};
      for (const r of sealNorm.records) { const k = r.kind + '|' + r.key; if (firstRow[k] !== r.row) duplicates[k] = firstRow[k]; }
      await db.prepare("UPDATE ec_report_files SET status='received',twin_keys_json=? WHERE id=? AND status='receiving'")
        .bind(JSON.stringify({twins, duplicates}), f.id).run();
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
      // Bu parti dışındaki satırlar okunmaz: iş yükü dosya boyutuyla değil parti boyutuyla artar.
      // Dosya genelini ilgilendiren ikiz/tekrar bilgisi mühürleme sırasında hesaplanmıştır.
      const seal = parse(f.twin_keys_json, {twins: [], duplicates: {}});
      const twinKeys = new Set(seal.twins || []), duplicateKeys = seal.duplicates || {};
      const batch = normalizeRows(profile, parse(f.headers_json, []), await fileRows(db, f.id, f.applied_row, toRow), {date1904: !!f.date1904});
      if (batch.unknownTypes.length) fail('Tanımlanmamış işlem türleri var (' + batch.unknownTypes.slice(0, 5).join(', ') + '). Önce eşleştirmede karşılığını seçin.', 409);
      for (const r of batch.records) {
        const k = r.kind + '|' + r.key;
        if (twinKeys.has(k) && !r.issues.some(i => i.code === 'ambiguous_twin'))
          r.issues.push({code: 'ambiguous_twin', field: null, detail: 'Aynı bilgilere sahip başka satır var ve kimlikleri yok; ayrı işlemler olabilir.'});
        if (duplicateKeys[k] !== undefined && duplicateKeys[k] !== r.row)
          r.issues.push({code: 'duplicate_in_file', field: null, detail: 'Aynı kimlik dosyada ' + duplicateKeys[k] + '. satırda da var.'});
      }
      const part = await classify(db, f, profile, batch.records);
      const counts = parse(f.counts_json, {new: 0, updated: 0, same: 0, older: 0, review: 0});
      const stmts = [db.prepare('INSERT INTO ec_report_apply_steps(file_id,from_row,to_row) VALUES(?,?,?)').bind(f.id, f.applied_row, toRow)];
      for (const r of part) {
        counts[r.outcome] = (counts[r.outcome] || 0) + 1;
        stmts.push(db.prepare('INSERT INTO ec_report_outcomes(file_id,row_no,record_key,outcome) VALUES(?,?,?,?)').bind(f.id, r.row, r.kind + '|' + r.key, r.outcome));
        if (r.outcome === 'new') {
          const recId = id(), erp = r.kind === 'order_line' ? await erpMatch(db, f.provider, r.data) : {id: null};
          const comps = r.kind === 'order_line' ? await componentsFor(db, f.provider, r.data) : null;
          stmts.push(db.prepare('INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no,erp_package_id,components_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(recId, f.store_id, r.kind, r.key, r.keySource, JSON.stringify(r.data), f.snapshot_at, f.snapshot_at, f.id, r.row, erp.id, comps ? JSON.stringify(comps) : null));
          stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,1,?,?,'new',?,?)").bind(id(), recId, f.id, r.row, JSON.stringify(r.data), f.snapshot_at));
          if (erp.ambiguous) stmts.push(review(db, f, r, 'erp_ambiguous', 'ERP\'de bu siparişe uyan birden fazla paket var; bağlantı kurulmadı.'));
          if (erp.storeAmbiguous) stmts.push(review(db, f, r, 'store_ambiguous', 'Bu pazaryerinde birden çok mağaza tanımlı; siparişin hangi mağazaya ait olduğu ERP kaydından anlaşılmadığı için bağlanmadı.'));
        } else if (r.outcome === 'updated') {
          const v = r.prior.version + 1;
          stmts.push(db.prepare('UPDATE ec_report_records SET data_json=?,source_time=?,data_time=?,file_id=?,row_no=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?')
            .bind(JSON.stringify(r.merged), f.snapshot_at, f.snapshot_at, f.id, r.row, v, r.prior.id, r.prior.version));
          stmts.push(db.prepare("INSERT INTO ec_report_record_versions(id,record_id,version,file_id,row_no,outcome,data_json,source_time) VALUES(?,?,?,?,?,'updated',?,?)").bind(id(), r.prior.id, v, f.id, r.row, JSON.stringify(r.merged), f.snapshot_at));
        } else if (r.outcome === 'same' && r.advanceObservation) {
          // İçerik değişmedi ama kayıt daha yeni bir raporda yeniden görüldü: güncellik sınırı ilerler,
          // böylece sonradan yüklenen ESKİ rapor bu kaydı geri alamaz. Veri sürümü artmaz.
          stmts.push(db.prepare('UPDATE ec_report_records SET source_time=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (source_time IS NULL OR source_time<?)')
            .bind(f.snapshot_at, r.prior.id, f.snapshot_at));
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

  // Sonradan tanımlanan ürün/set eşleştirmesini eksik kayıtlara uygular. Var olan tarihî
  // anlık görüntüler DEĞİŞMEZ; yalnızca eşleşmesi hiç olmayan kayıtlar doldurulur.
  if (sub === '/backfill-components' && method === 'POST') {
    const x = await readBody(request);
    const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(x.store_id)).first();
    if (!store) fail('Mağaza bulunamadı.', 404);
    const cursor = typeof x.cursor === 'string' && /^[w-]{0,100}$/.test(x.cursor) ? x.cursor : '';
    const rows = (await db.prepare("SELECT id,data_json FROM ec_report_records WHERE store_id=? AND kind='order_line' AND components_json IS NULL AND id>? ORDER BY id LIMIT 500").bind(store.id, cursor).all()).results;
    const stmts = [];
    for (const r of rows) {
      const comps = await componentsFor(db, store.provider, parse(r.data_json, {}));
      if (comps) stmts.push(db.prepare('UPDATE ec_report_records SET components_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND components_json IS NULL').bind(JSON.stringify(comps), r.id));
    }
    if (stmts.length) await db.batch(stmts);
    // Kalan = bu partideki artık değil, mağazadaki GERÇEK toplam çözülememiş kayıt sayısı.
    const remaining = (await db.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE store_id=? AND kind='order_line' AND components_json IS NULL").bind(store.id).first()).n;
    return {checked: rows.length, filled: stmts.length, remaining, next_cursor: rows.length ? rows.at(-1).id : cursor, done: rows.length < 500,
      notice: 'Yalnızca eşleşmesi olmayan kayıtlar dolduruldu; daha önce kaydedilmiş set içerikleri değişmedi.'};
  }

  if (sub === '/orders' && method === 'GET') {
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
    const result = await orderResults(db, url.searchParams.get('store_id') || '', {limit: 100, offset: (page - 1) * 100,
      q: url.searchParams.get('q') || '', status: url.searchParams.get('status') || ''});
    return {...result, page, page_size: 100};
  }

  // Her ikisi de PARÇALI: next_cursor doluyken çağıran döngüye devam eder.
  // Raporda iade gorunen ama defterde hala tam gelirle duran paketler. YAZMAZ, listeler.
  if (sub === '/returns-pending' && method === 'GET')
    return pendingReturns(db, url.searchParams.get('store_id') || '');

  if (sub === '/orders/summary' && method === 'GET')
    return orderSummary(db, url.searchParams.get('store_id') || '', {q: url.searchParams.get('q') || '', status: url.searchParams.get('status') || '',
      cursor: Number(url.searchParams.get('cursor')) || 0});

  // Rapordaki kesintileri satış kayıtlarına aktarır. GET önizleme (yazmaz), POST uygular.
  if (sub === '/apply-fees' && method === 'GET')
    return applyReportFees(db, url.searchParams.get('store_id') || '', {commit: false, cursor: Number(url.searchParams.get('cursor')) || 0});
  if (sub === '/apply-fees' && method === 'POST') {
    const x = await readBody(request);
    if (x.confirm !== true) fail('Aktarımı onaylayın.');
    return applyReportFees(db, x.store_id || '', {commit: true, cursor: Number(x.cursor) || 0});
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
