// Rapor Kutusu → sipariş → stok köprüsü.
//
//   POST /api/reports/stock-link/preview  {store_id,package_id}  — HİÇBİR ŞEY YAZMAZ
//   POST /api/reports/stock-link/apply    {store_id,package_id,complete_package_confirmed}
//   GET  /api/reports/stock-link/candidates?store_id                aktarılabilir paketler
//
// Bu köprü stoğu KENDİSİ düşmez. Mevcut sipariş motoruna taslak paket açar; stok ancak
// siparişin rezervasyon ve gönderim adımlarında, bir kez değişir. Fatura satırı, ticari sipariş,
// sevkiyat ve finans olayı ayrı kalır: rapor yüklendi diye yeniden sipariş veya çıkış oluşmaz.
//
// Korumalar:
//  · Mağaza ayrımı: kayıtlar yalnız verilen mağazadan okunur, paketler mağazalar arası karışmaz.
//  · Stok başlangıç tarihi girilmeden geçmiş sipariş bugünkü stoğa uygulanmaz (tarih uydurulmaz).
//  · İptal/iade ayrı olaydır; yeni satışa çevrilmez.
//  · Gerçek paket/kalem kimliği yoksa aktarılmaz.
//  · Aynı paket ikinci kez aktarılamaz: hem sipariş kimliği hem aktarım kaydı tekildir.
import {ordersApi} from './orders-api.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const id = () => crypto.randomUUID();
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Mağaza veya paket seçimi geçersiz.'); return v; };
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const day = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s).toISOString().slice(0, 10) === s;
const CANCELLED = /iptal|iade|cancel|return|refund/i;

async function digest(parts) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Paketin O ANKİ içerik parmak izi: kalem kimliği, adet, tutar ve durum.
 * Bağlantı kurulduğunda saklanır; sonraki okumalarda rapor değişmiş mi diye karşılaştırılır.
 */
const packageFingerprint = records => digest(records
  .map(r => [String(r.data.line_id || ''), Number(r.data.quantity) || 0, r.data.gross ?? null, String(r.data.status || '')])
  .sort((a, b) => a[0].localeCompare(b[0])));

/** Paketi okur ve aktarıma uygun olup olmadığını söyler. Yalnız eskimiş taslağı işaretler. */
async function plan(env, storeId, packageId) {
  const db = env.DB, rootDB = env.ROOT_DB || db;
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);

  const settings = await rootDB.prepare('SELECT inventory_start_date FROM workspace_settings WHERE workspace=?').bind('ec').first();
  const start = settings?.inventory_start_date || null;

  const rows = (await db.prepare("SELECT * FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id')=?")
    .bind(store.id, key(packageId)).all()).results;
  if (!rows.length) fail('Bu mağazada bu paket için rapor kaydı yok.', 404);

  const records = rows.map(r => ({...r, data: parse(r.data_json, {})}));
  const linked = records.find(r => r.erp_package_id);
  if (linked) {
    // Bağlantı anındaki içerik ile ŞİMDİKİ içerik karşılaştırılır. Rapor güncellendiyse (iptal,
    // adet değişimi) eski taslak sessizce kullanılmaz: paket "kaynak değişti" diye işaretlenir ve
    // mevcut veritabanı tetiği rezervasyon/gönderimi engeller. Rezerve/gönderilmiş sipariş
    // sessizce yeniden yazılmaz; iptal/iade/düzeltme akışına bırakılır.
    const linkKey = store.provider + ':' + store.id + ':' + packageId;
    const item = await db.prepare("SELECT content_hash FROM import_items WHERE kind='report_stock_link' AND source_key=?").bind(linkKey).first();
    const current = await packageFingerprint(records);
    const cancelledNow = records.some(r => CANCELLED.test(String(r.data.status || '').toLocaleLowerCase('tr-TR')));
    const drifted = !!item?.content_hash && item.content_hash !== current;
    if (drifted || cancelledNow) {
      await db.prepare("UPDATE ec_order_packages SET source_changed=1 WHERE id=? AND status='draft'").bind(linked.erp_package_id).run();
      return {store, outcome: 'changed', package_id: linked.erp_package_id, stock_write: false,
        issues: [cancelledNow
          ? 'Rapor bu paketi iptal/iade olarak gösteriyor; bağlı taslakla stok çıkışı yapılamaz.'
          : 'Rapor güncellendi (adet veya içerik değişti); bağlı taslağın içeriği eski.'],
        reason: 'Bağlı sipariş taslağı güncel raporla uyuşmuyor. Stok ayırma ve gönderim engellendi; taslağı inceleyip düzeltin.'};
    }
    return {store, outcome: 'existing', package_id: linked.erp_package_id, stock_write: false,
      reason: 'Bu paket panelde zaten bir siparişe bağlı. İkinci sipariş açılmaz.'};
  }

  const orders = new Set(records.map(r => r.data.order_no)), dates = new Set(), seen = new Set();
  const issues = [];
  for (const r of records) {
    const d = r.data;
    if (!d.line_id) issues.push('Kalem kimliği eksik; uydurma kimlikle stok çıkışı yapılmaz.');
    else if (seen.has(d.line_id)) issues.push('Aynı kalem kimliği pakette birden fazla.');
    seen.add(d.line_id);
    if (!day(String(d.order_date || '').slice(0, 10))) issues.push('Sipariş tarihi eksik veya geçersiz.');
    else dates.add(String(d.order_date).slice(0, 10));
    if (!Number.isSafeInteger(d.quantity) || d.quantity <= 0) issues.push('Sipariş adedi geçersiz.');
    // Türkçe büyük İ, JS'in basit harf katlamasıyla 'i'ye eşlenmez: önce tr-TR küçültmesi şart.
    // Bu yapılmazsa 'İade Edildi' durumu yakalanmaz ve iade yeni satışa dönüşürdü.
    if (CANCELLED.test(String(d.status || '').toLocaleLowerCase('tr-TR'))) issues.push('İptal/iade kaydı ayrı olaydır; yeni satışa çevrilmez.');
    if (!d.barcode && !d.sku) issues.push('Barkod veya satıcı stok kodu eksik.');
  }
  if (orders.size !== 1 || !orders.values().next().value) issues.push('Paketin sipariş kimliği çelişiyor.');
  if (dates.size > 1) issues.push('Paketin satırlarında farklı sipariş tarihleri var.');
  if (records.length > 10) issues.push('Paket en fazla 10 kalem içerebilir; kalanı ayrıca incelenmeli.');

  const occurred = [...dates][0] || null;
  const lines = records.map(r => ({
    external_id: r.data.line_id, name: r.data.product_name || r.data.barcode || r.data.sku,
    sku: r.data.barcode || r.data.sku, quantity: r.data.quantity,
    gross: r.data.gross == null ? null : r.data.gross / 100,
    vat_rate: r.data.vat_bps == null ? null : r.data.vat_bps / 100,
    net_revenue: null
  }));
  const external_id = 'RPT-' + (await digest([store.provider, store.id, packageId])).slice(0, 40);

  if (issues.length) return {store, outcome: 'review', stock_write: false, issues: [...new Set(issues)],
    reason: 'Bu paket olduğu gibi aktarılamaz; incelemede kalır.'};
  if (!start) return {store, outcome: 'blocked', stock_write: false,
    reason: 'Stok başlangıç tarihi girilmemiş. Girilmeden geçmiş siparişler bugünkü stoktan düşülmez.'};
  if (occurred < start) return {store, outcome: 'historical', stock_write: false, occurred_on: occurred,
    reason: 'Sipariş stok başlangıcından eski. Mali rapor korunur; güncel stoktan otomatik düşülmez.'};

  return {store, outcome: 'draft', stock_write: false, occurred_on: occurred,
    fingerprint: await packageFingerprint(records),
    source: {provider: store.provider, store_id: store.id, package_id: packageId,
      record_ids: records.map(r => r.id), versions: records.map(r => r.version)},
    order: {channel: store.provider, external_id, order_no: [...orders][0], occurred_on: occurred,
      external_status: records[0].data.status || '', lines},
    notice: 'Mevcut sipariş ucuna TASLAK olarak gönderilir. Stok yalnızca rezervasyon ve gönderim adımlarında, bir kez değişir.'};
}

export async function reportStockLinkApi(request, env, path, readBody) {
  if (!path.startsWith('/api/reports/stock-link')) return null;
  if (env.WORKSPACE !== 'ec') fail('Rapor Kutusu yalnızca e-ticaret çalışma alanında kullanılır.', 403);
  const db = env.DB, method = request.method, url = new URL(request.url), user = env.USER || {};
  const sub = path.slice('/api/reports/stock-link'.length);

  // Aktarılabilecek paketler: ERP'ye bağlanmamış, kaydı olan paketler.
  if (sub === '/candidates' && method === 'GET') {
    const storeId = key(url.searchParams.get('store_id') || '');
    const rows = (await db.prepare(`SELECT json_extract(data_json,'$.package_id') package_id,
        json_extract(data_json,'$.order_no') order_no, MAX(substr(json_extract(data_json,'$.order_date'),1,10)) order_date,
        COUNT(*) line_count, SUM(erp_package_id IS NOT NULL) linked
      FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id') IS NOT NULL
      GROUP BY package_id ORDER BY order_date DESC LIMIT 200`).bind(storeId).all()).results;
    const settings = await (env.ROOT_DB || db).prepare('SELECT inventory_start_date FROM workspace_settings WHERE workspace=?').bind('ec').first();
    return {inventory_start_date: settings?.inventory_start_date || null,
      candidates: rows.map(r => ({...r, linked: !!r.linked})),
      notice: 'Aktarım sipariş taslağı açar; stok rezervasyon ve gönderim adımlarında değişir.'};
  }

  if (sub === '/preview' && method === 'POST') {
    const x = await readBody(request);
    const result = await plan(env, x.store_id, x.package_id);
    return {...result, store: {id: result.store.id, name: result.store.name, provider: result.store.provider}};
  }

  if (sub === '/apply' && method === 'POST') {
    const x = await readBody(request);
    // Paketin BÜTÜN kalemlerinin elde olduğu açıkça doğrulanmalı: eksik kalemli paket stok çıkarmaz.
    if (x.complete_package_confirmed !== true) fail('Paketin bütün kalemlerinin raporda bulunduğunu doğrulayın.', 409);
    const result = await plan(env, x.store_id, x.package_id);
    if (result.outcome !== 'draft')
      return {...result, store: {id: result.store.id, name: result.store.name, provider: result.store.provider}, applied: false};

    const sourceKey = result.store.provider + ':' + result.store.id + ':' + x.package_id;
    const already = await db.prepare("SELECT * FROM import_items WHERE kind='report_stock_link' AND source_key=?").bind(sourceKey).first();
    if (already) return {outcome: 'existing', applied: false, package_id: already.target_id, stock_write: false,
      reason: 'Bu paket daha önce aktarıldı; ikinci sipariş açılmaz.'};

    // Sipariş mevcut uçtan açılır: bileşen genişletme, kimlik tekilliği ve stok korumaları aynen çalışır.
    const created = await ordersApi(new Request('https://internal.invalid/api/orders', {method: 'POST'}),
      env, '/api/orders', async () => result.order);

    const batchId = id();
    const stmts = [
      db.prepare('INSERT INTO import_batches(id,kind,source_name,sha256,item_count,counts_json,status,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .bind(batchId, 'report_stock_link', sourceKey, await digest([sourceKey, result.order.external_id]), 1,
          JSON.stringify({created: created.existing ? 0 : 1, skipped: created.existing ? 1 : 0}), 'applied', user.id || 'owner'),
      db.prepare('INSERT OR IGNORE INTO import_items(id,batch_id,kind,source_key,outcome,target_kind,target_id,detail,content_hash) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(id(), batchId, 'report_stock_link', sourceKey, created.existing ? 'skipped' : 'created', 'order_package', created.id,
          'Sipariş taslağı açıldı; stok değişmedi.', result.fingerprint),
      // Rapor kayıtları artık bu siparişe bağlı: sürüm ve veri değişmez, yalnız bağlantı kurulur.
      ...result.source.record_ids.map(recordId =>
        db.prepare('UPDATE ec_report_records SET erp_package_id=? WHERE id=? AND erp_package_id IS NULL').bind(created.id, recordId))
    ];
    try { await db.batch(stmts); }
    catch (e) {
      if (/UNIQUE/.test(e.message)) fail('Bu paket az önce aktarıldı. Listeyi yenileyin.', 409);
      throw e;
    }
    return {outcome: 'draft', applied: true, stock_write: false, package_id: created.id, existing: !!created.existing,
      order_status: created.status, occurred_on: result.occurred_on,
      notice: 'Sipariş TASLAK olarak açıldı ve rapor kaydına bağlandı. Stok henüz değişmedi; "Stok ayır" ve "Gönder" adımlarında bir kez düşer.'};
  }
  return null;
}
