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
import {reportLinkFingerprint} from './report-link-guard.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };

/**
 * Siparis satirinin kimligi. Saglayici kalem kimligi verdiyse HER ZAMAN o kullanilir.
 * Vermediyse kimlik ancak cagri bunu ACIKCA beyan ettiginde paket numarasi + stok kodu
 * ikilisinden turetilir; beyan yoksa null doner ve satir incelemede kalir. Kimlik uydurulmaz.
 */
const lineIdentity = (data, packageId, declared) => {
  if (data.line_id) return String(data.line_id);
  if (!declared) return null;
  const code = data.sku || data.barcode;
  return code && packageId ? String(packageId) + String.fromCharCode(124) + String(code) : null;
};
const id = () => crypto.randomUUID();
const key = v => { if (!/^[\w-]{1,100}$/.test(v || '')) fail('Mağaza veya paket seçimi geçersiz.'); return v; };
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const day = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s).toISOString().slice(0, 10) === s;
const CANCELLED = /iptal|iade|cancel|return|refund/i;

async function digest(parts) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Parmak izi ortak modülden gelir: sürümlü ve ÜRÜN KİMLİĞİNİ de kapsar.
// Aynı adet ve tutar, aynı ürün demek değildir.
const packageFingerprint = records => reportLinkFingerprint(records);

/** Paketi okur ve aktarıma uygun olup olmadığını söyler. Yalnız eskimiş taslağı işaretler. */
async function plan(env, storeId, packageId, lineIdentityDeclared = false) {
  const db = env.DB, rootDB = env.ROOT_DB || db;
  const store = await db.prepare('SELECT * FROM ec_report_stores WHERE id=?').bind(key(storeId)).first();
  if (!store) fail('Mağaza bulunamadı.', 404);

  const settings = await rootDB.prepare('SELECT inventory_start_date FROM workspace_settings WHERE workspace=?').bind('ec').first();
  const start = settings?.inventory_start_date || null;

  const rows = (await db.prepare("SELECT * FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id')=?")
    .bind(store.id, key(packageId)).all()).results;
  if (!rows.length) fail('Bu mağazada bu paket için rapor kaydı yok.', 404);

  const records = rows.map(r => ({...r, data: parse(r.data_json, {})}));
  // İPTAL EDİLMİŞ siparişe bağlı kayıt "bağlı" sayılmaz: iptal paketin defterde karşılığı yoktur
  // (stok çıkışı, satış kaydı ve kesinti alanı olmaz). Böyle bir bağ eskimiştir; yeniden aranır.
  const linkedRow = records.find(r => r.erp_package_id);
  const linkedDead = linkedRow ? await db.prepare("SELECT 1 FROM ec_order_packages WHERE id=? AND status='cancelled'").bind(linkedRow.erp_package_id).first() : null;
  const linked = linkedDead ? null : linkedRow;
  if (linked) {
    // Bağlantı anındaki içerik ile ŞİMDİKİ içerik karşılaştırılır. Rapor güncellendiyse (iptal,
    // adet değişimi) eski taslak sessizce kullanılmaz: paket "kaynak değişti" diye işaretlenir ve
    // mevcut veritabanı tetiği rezervasyon/gönderimi engeller. Rezerve/gönderilmiş sipariş
    // sessizce yeniden yazılmaz; iptal/iade/düzeltme akışına bırakılır.
    // BAGLI AMA EKSIK. Bagli oldugu siparis paketin BUTUN kalemlerini tutmayabilir: rapor kaydi
    // siparis numarasiyla baglanir, satirlarin gercekten o pakette oldugu dogrulanmaz. Boyle bir
    // pakette eksik satirin cirosu yokken paketin butun kesintileri kalan satira yuklenir ve
    // karli siparis zararli gorunur; ustelik cikan mal stoktan dusmemistir.
    // Bu durumda eksik satirlar icin AYRI bir paket kurulur (1 siparis -> N paket, sistemin
    // kendi modeli). Mevcut paket ve onun satirlari DEGISMEZ.
    const defterSatirlari = (await db.prepare('SELECT external_id,quantity_milli FROM ec_order_lines WHERE package_id=?')
      .bind(linked.erp_package_id).all()).results;
    const defterSatir = new Map(defterSatirlari.map(r => [String(r.external_id), r.quantity_milli]));
    const kimlikli = records.map(r => ({r, kimlik: lineIdentity(r.data, packageId, lineIdentityDeclared)}));
    const eksik = kimlikli.filter(x => x.kimlik && !defterSatir.has(String(x.kimlik))).map(x => x.r);
    // Ortusen satirlarda ADET degismis olmamali: degismisse bu "eksik satir" degil, raporun
    // degismesidir ve asagidaki surukleme denetimine birakilir. Tutar karsilastirilmaz:
    // indirimli satista rapor liste fiyatini, defter indirimli fiyati tutar; fark normaldir.
    const ortusenTutuyor = kimlikli.every(x => !x.kimlik || !defterSatir.has(String(x.kimlik))
      || defterSatir.get(String(x.kimlik)) === (x.r.data.quantity ?? 0) * 1000);
    // Defter fazladan satir tasiyorsa durum belirsizdir: eksik satir eklemek tabloyu duzeltmez.
    const defterFazlaYok = defterSatirlari.every(l => kimlikli.some(x => String(x.kimlik) === String(l.external_id)));
    // YANLIS BAGLAMA: bu paketin satirlarinin HICBIRI defterde yok ve ayni defter paketini BASKA
    // bir rapor paketi de sahipleniyorsa, bu paket yanlis kayda baglanmistir. Fatura kaydindan
    // kurulan paketlerde satir kimlikleri barkod tasimaz; kimlik karsilastirmasi bu yuzden
    // ortusmez. Tek basina "kimlik tutmadi" yetmez — DEFTERDEKI ADET, o defter paketini
    // sahiplenen rapor satirlarinin toplam adedinden AZ olmali. Yoksa ayni satis ikinci kez
    // deftere gecer. Sayim uydurulmaz, iki taraftan da okunur.
    let yanlisBaglama = false;
    if (eksik.length === records.length && records.length) {
      const sahipler = (await db.prepare(
        "SELECT json_extract(data_json,'$.package_id') pk,json_extract(data_json,'$.quantity') adet" +
        " FROM ec_report_records WHERE kind='order_line' AND erp_package_id=? AND store_id=?")
        .bind(linked.erp_package_id, store.id).all()).results;
      const baskaPaket = sahipler.some(r => String(r.pk) !== String(packageId));
      const raporAdet = sahipler.reduce((t, r) => t + (Number(r.adet) || 0), 0);
      const defterAdet = defterSatirlari.reduce((t, l) => t + (l.quantity_milli || 0) / 1000, 0);
      yanlisBaglama = baskaPaket && defterAdet < raporAdet;
    }
    if (eksik.length && (yanlisBaglama || (eksik.length < records.length && ortusenTutuyor && defterFazlaYok))) {
      const eksikSorun = [];
      for (const r of eksik) {
        const d = r.data;
        if (!day(String(d.order_date || '').slice(0, 10))) eksikSorun.push('Sipariş tarihi eksik veya geçersiz.');
        if (!Number.isSafeInteger(d.quantity) || d.quantity <= 0) eksikSorun.push('Sipariş adedi geçersiz.');
        if (CANCELLED.test(String(d.status || '').toLocaleLowerCase('tr-TR'))) eksikSorun.push('İptal/iade kaydı ayrı olaydır; yeni satışa çevrilmez.');
        if (!d.barcode && !d.sku) eksikSorun.push('Barkod veya satıcı stok kodu eksik.');
      }
      const gun = String(eksik[0].data.order_date || '').slice(0, 10);
      const ortak = {store, outcome: 'partial', stock_write: false, covered_by: linked.erp_package_id,
        missing_lines: eksik.map(r => ({barcode: r.data.barcode || r.data.sku, name: r.data.product_name,
          quantity: r.data.quantity, gross_cents: r.data.gross ?? null}))};
      if (eksikSorun.length) return {...ortak, outcome: 'review', issues: [...new Set(eksikSorun)],
        reason: 'Bu paketin bazı satırları defterde yok ama olduğu gibi aktarılamıyor; incelemede kalır.'};
      if (!start) return {...ortak, outcome: 'blocked', reason: 'Stok başlangıç tarihi girilmemiş.'};
      if (gun < start) return {...ortak, outcome: 'historical', occurred_on: gun,
        reason: 'Eksik satır stok başlangıcından eski. Mali rapor korunur; güncel stoktan otomatik düşülmez.'};
      return {...ortak,
        occurred_on: gun,
        fingerprint: await packageFingerprint(eksik),
        source: {provider: store.provider, store_id: store.id, package_id: packageId,
          record_ids: eksik.map(r => r.id), versions: eksik.map(r => r.version), relink_from: linked.erp_package_id},
        order: {channel: store.provider, external_id: 'RPT-' + (await digest([store.provider, store.id, packageId, 'eksik'])).slice(0, 40),
          order_no: eksik[0].data.order_no, occurred_on: gun,
          external_status: eksik[0].data.status || '',
          lines: eksik.map(r => ({external_id: lineIdentity(r.data, packageId, lineIdentityDeclared),
            name: r.data.product_name || r.data.barcode || r.data.sku, sku: r.data.barcode || r.data.sku,
            quantity: r.data.quantity, gross: r.data.gross == null ? null : r.data.gross / 100,
            vat_rate: r.data.vat_bps == null ? null : r.data.vat_bps / 100, net_revenue: null}))},
        reason: 'Bu paketin ' + eksik.length + ' satırı defterde yok. Eksik satırlar için ayrı bir sipariş taslağı kurulur; ' +
          'mevcut sipariş ve satırları değişmez.',
        notice: 'Eksik satırların malı stoktan düşmemiştir. Taslak açıldıktan sonra "Stok ayır" ve "Gönder" adımlarında bir kez düşer.'};
    }
    const linkKey = store.provider + ':' + store.id + ':' + packageId;
    const item = await db.prepare("SELECT content_hash FROM import_items WHERE kind='report_stock_link' AND source_key=?").bind(linkKey).first();
    const current = await packageFingerprint(records);
    const cancelledNow = records.some(r => CANCELLED.test(String(r.data.status || '').toLocaleLowerCase('tr-TR')));
    // Eski kayıtlarda özet YOKSA bu "aynı" demek değildir: güvenli sayılmaz, incelemeye alınır.
    const unknownHash = !item || !item.content_hash;
    const drifted = !unknownHash && item.content_hash !== current;
    if (drifted || cancelledNow || unknownHash) {
      // Önizleme SALT OKUNUR: burada hiçbir şey yazılmaz. Rezervasyon ve gönderim,
      // sipariş motorundaki zorunlu kaynak denetimiyle zaten engellenir.
      return {store, outcome: 'changed', package_id: linked.erp_package_id, stock_write: false,
        issues: [cancelledNow
          ? 'Rapor bu paketi iptal/iade olarak gösteriyor; bağlı taslakla stok çıkışı yapılamaz.'
          : unknownHash
            ? 'Bu bağlantının içerik özeti kayıtlı değil; güncelliği doğrulanamıyor. İnceleyin.'
            : 'Rapor güncellendi (adet, ürün kimliği veya durum değişti); bağlı taslağın içeriği eski.'],
        reason: 'Bağlı sipariş taslağı güncel raporla uyuşmuyor. Stok ayırma ve gönderim engellendi; taslağı inceleyip düzeltin.'};
    }
    return {store, outcome: 'existing', package_id: linked.erp_package_id, stock_write: false,
      reason: 'Bu paket panelde zaten bir siparişe bağlı. İkinci sipariş açılmaz.'};
  }

  const orders = new Set(records.map(r => r.data.order_no)), dates = new Set(), seen = new Set();
  const issues = [];

  // Bu pazaryeri siparişi panele BAŞKA bir yoldan girmiş olabilir (elle, eski aktarım).
  // O zaman ikinci bir sipariş açmak kaydı ikiye böler: stok ve satış bir tarafta, rapor
  // kesintileri öbür tarafta kalır. Önce sipariş numarasıyla mevcut kayıt aranır.
  // Eşleşme TEK ve BAŞKA bir rapor paketine bağlı değilse bağlanır; şüpheli durum incelemeye gider.
  // Sipariş numarası MAĞAZA içinde tekildir, pazaryeri genelinde değil: aynı sağlayıcının iki
  // mağazasında aynı numara bulunabilir. Bu yüzden başka bir mağazanın kayıtlarına bağlı paket
  // aday sayılmaz; başka mağazada aynı numaralı rapor kaydı varsa da otomatik bağlanmaz.
  const orderNo = orders.size === 1 ? orders.values().next().value : null;
  if (orderNo) {
    const rival = await db.prepare(
      "SELECT 1 FROM ec_report_records WHERE kind='order_line' AND store_id!=? AND json_extract(data_json,'$.order_no')=? LIMIT 1")
      .bind(store.id, String(orderNo)).first();
    const twins = rival ? [] : (await db.prepare(
      "SELECT p.id,p.external_id,p.status FROM ec_order_packages p WHERE p.channel=? AND p.order_no=? AND p.status!='cancelled'" +
      " AND NOT EXISTS(SELECT 1 FROM ec_report_records r WHERE r.erp_package_id=p.id AND r.store_id!=?)")
      .bind(store.provider, String(orderNo), store.id).all()).results;
    // Adaylar ikiye ayrılır: bir rapor paketinin SAHİPLENDİĞİ kayıtlar ve henüz sahipsiz olanlar.
    // Sahipsiz kayıt varsa bu sipariş panele başka yoldan girmiş demektir; ASLA yenisi açılmaz,
    // yoksa aynı satış iki kez deftere geçer. Sahipsiz tek ise bağlanır, birden çoksa hangisinin
    // hangi pakete denk geldiği belirsizdir: incelemeye alınır, uydurma eşleme yapılmaz.
    const sahipsiz = [];
    for (const t of twins) {
      const claimed = await db.prepare(
        "SELECT 1 FROM ec_report_records WHERE erp_package_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id')!=? LIMIT 1")
        .bind(t.id, packageId).first();
      if (!claimed) sahipsiz.push(t);
    }
    if (sahipsiz.length === 1) {
      const t = sahipsiz[0];
      return {store, outcome: 'match', stock_write: false, package_id: t.id, external_id: t.external_id, status: t.status,
        order_no: String(orderNo),
        reason: 'Bu sipariş panelde ZATEN var (' + t.external_id + ', ' + t.status + '). İkinci sipariş açılmaz; ' +
          'rapor kaydı mevcut siparişe bağlanır, stok ve satış tutarı değişmez.'};
    }
    if (sahipsiz.length > 1) return {store, outcome: 'review', stock_write: false,
      issues: ['Panelde bu sipariş numarasıyla eşleşmemiş ' + sahipsiz.length + ' kayıt var: ' +
        sahipsiz.map(t => t.external_id).join(', ') + '. Hangi pazaryeri paketinin hangisine denk geldiği belirsiz.'],
      reason: 'Bu sipariş panelde zaten var ama hangi kayda bağlanacağı belirsiz. İkinci kez açılmadı; elle eşleştirin.'};
    // Bütün adaylar başka rapor paketlerince sahiplenilmişse bu gerçekten YENİ bir parçadır
    // (1 sipariş → N paket): aşağıdaki normal taslak akışı sürer.
  }
  for (const r of records) {
    const d = r.data;
    const identity = lineIdentity(d, packageId, lineIdentityDeclared);
    if (!identity) issues.push('Kalem kimliği eksik; uydurma kimlikle stok çıkışı yapılmaz.');
    else if (seen.has(identity)) issues.push('Aynı kalem kimliği pakette birden fazla.');
    seen.add(identity);
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
    external_id: lineIdentity(r.data, packageId, lineIdentityDeclared), name: r.data.product_name || r.data.barcode || r.data.sku,
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
    const result = await plan(env, x.store_id, x.package_id, x.line_identity_from_package_sku === true);
    return {...result, store: {id: result.store.id, name: result.store.name, provider: result.store.provider}};
  }

  if (sub === '/apply' && method === 'POST') {
    const x = await readBody(request);
    // Paketin BÜTÜN kalemlerinin elde olduğu açıkça doğrulanmalı: eksik kalemli paket stok çıkarmaz.
    if (x.complete_package_confirmed !== true) fail('Paketin bütün kalemlerinin raporda bulunduğunu doğrulayın.', 409);
    const result = await plan(env, x.store_id, x.package_id, x.line_identity_from_package_sku === true);

    // Sipariş panelde zaten var: YENİ sipariş açılmaz, stok ve satış tutarı değişmez.
    // Yalnızca rapor kaydı mevcut siparişe bağlanır ki kesintiler doğru kayda yazılabilsin.
    if (result.outcome === 'match') {
      // Bağsız kayıtlar VE iptal edilmiş siparişe bağlı kalmış kayıtlar mevcut siparişe yönlendirilir.
      const rows = (await db.prepare(
        "SELECT id FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id')=?" +
        " AND (erp_package_id IS NULL OR erp_package_id IN (SELECT id FROM ec_order_packages WHERE status='cancelled'))")
        .bind(result.store.id, key(x.package_id)).all()).results;
      if (rows.length) await db.batch(rows.map(r =>
        db.prepare("UPDATE ec_report_records SET erp_package_id=? WHERE id=? AND (erp_package_id IS NULL OR erp_package_id IN (SELECT id FROM ec_order_packages WHERE status='cancelled'))").bind(result.package_id, r.id)));
      return {outcome: 'match', applied: rows.length > 0, stock_write: false, package_id: result.package_id,
        external_id: result.external_id, order_no: result.order_no, linked_records: rows.length,
        reason: result.reason,
        notice: 'Rapor kaydı paneldeki mevcut siparişe bağlandı. Stok, satış tutarı ve sipariş durumu DEĞİŞMEDİ.'};
    }

    if (!['draft', 'partial'].includes(result.outcome))
      return {...result, store: {id: result.store.id, name: result.store.name, provider: result.store.provider}, applied: false};

    // Eksik satirlar icin acilan taslak AYRI bir kaynak anahtari tasir: ilk baglantiyi ezmez ve
    // ikinci kez calistirildiginda yeniden acilmaz.
    const eksikAktarim = result.outcome === 'partial';
    const sourceKey = result.store.provider + ':' + result.store.id + ':' + x.package_id + (eksikAktarim ? ':eksik' : '');
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
      // Sipariş satırına da yazılır: rezervasyon/gönderim denetimi bunu okur ve yazmayı buna koşullar.
      db.prepare('UPDATE order_packages SET report_link_hash=? WHERE id=? AND report_link_hash IS NULL').bind(result.fingerprint, created.id),
      // Rapor kayıtları artık bu siparişe bağlı: sürüm ve veri değişmez, yalnız bağlantı kurulur.
      // Eksik satir aktariminda kayit, kendisini TUTMAYAN pakete bagliydi: bag yeni pakete tasinir.
      // Verinin kendisi ve surumu degismez, yalniz hangi siparise ait oldugu duzelir.
      ...result.source.record_ids.map(recordId => eksikAktarim
        ? db.prepare('UPDATE ec_report_records SET erp_package_id=? WHERE id=? AND erp_package_id=?').bind(created.id, recordId, result.source.relink_from)
        : db.prepare('UPDATE ec_report_records SET erp_package_id=? WHERE id=? AND erp_package_id IS NULL').bind(created.id, recordId))
    ];
    try { await db.batch(stmts); }
    catch (e) {
      if (/UNIQUE/.test(e.message)) fail('Bu paket az önce aktarıldı. Listeyi yenileyin.', 409);
      throw e;
    }
    return {outcome: result.outcome, applied: true, stock_write: false, package_id: created.id, existing: !!created.existing,
      order_status: created.status, occurred_on: result.occurred_on,
      notice: eksikAktarim
        ? 'Defterde olmayan satırlar için ayrı bir sipariş TASLAĞI açıldı ve rapor kaydı buna bağlandı. Mevcut sipariş ve satırları DEĞİŞMEDİ. Stok henüz değişmedi; "Stok ayır" ve "Gönder" adımlarında bir kez düşer.'
        : 'Sipariş TASLAK olarak açıldı ve rapor kaydına bağlandı. Stok henüz değişmedi; "Stok ayır" ve "Gönder" adımlarında bir kez düşer.'};
  }
  return null;
}
