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
import {pendingReturns} from './report-inbox-api.js';
import {accountingApi} from './accounting.js';

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

// Durum sırası: aynı malın yenilenen paketlerinden hangisinin güncel olduğunu söyler.
const durumSirasi = s => { s = String(s || '').toLocaleLowerCase('tr-TR');
  return /edilemedi/.test(s) ? 0 : /teslim/.test(s) ? 4 : /kargo|yolda|shipped/.test(s) ? 3 : /hazır|hazirlan|toplan/.test(s) ? 2 : 1; };
const malKodu = d => String(d.barcode || d.sku || '');

/**
 * YENİDEN NUMARALANAN PAKET. Pazaryeri bir paketi yeni numarayla yeniden açabilir: aynı sipariş,
 * aynı ürün, aynı adet; eski numara sonraki raporlarda artık görünmez. Kayıt, kardeşi DAHA YENİ
 * bir raporla gelmiş ve durumu en az onunki kadar ilerideyse eskimiştir. Gerçek bölünmüş
 * siparişte iki paket aynı raporla birlikte güncellenir; o yüzden eskimiş sayılmaz.
 * r: {data, updated_at}
 */
const eskittiMi = (yeni, eski) => String(yeni.data.package_id) !== String(eski.data.package_id)
  && String(yeni.data.order_no) === String(eski.data.order_no) && malKodu(yeni.data) === malKodu(eski.data)
  && Number(yeni.data.quantity) === Number(eski.data.quantity)
  && String(yeni.updated_at) > String(eski.updated_at) && durumSirasi(yeni.data.status) >= durumSirasi(eski.data.status);

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
    // Defter satirini rapor satiriyla eslestirmek icin IKI alan da bakilir: external_id ve sku.
    // Fatura kaydindan kurulan pakette kimlik 'TEA...-1' bicimindedir ve barkod tasimaz; barkod
    // sku alanindadir. Tek alana bakmak butun satirlari "eksik" gosterirdi.
    const defterSatirlari = (await db.prepare('SELECT external_id,sku,quantity_milli FROM ec_order_lines WHERE package_id=?')
      .bind(linked.erp_package_id).all()).results;
    // Eslestirme TUKETEREK yapilir: her defter satiri EN FAZLA BIR rapor satirini karsilar.
    // Kume uyeligine bakmak yanlis olurdu — ayni barkodlu iki satirdan biri defterde yoksa
    // ikisi de "var" gorunurdu.
    const kalanDefter = defterSatirlari.slice();
    const eksik = [];
    for (const r of records) {
      const kimlik = String(lineIdentity(r.data, packageId, lineIdentityDeclared) ?? '');
      const i = kalanDefter.findIndex(l => (kimlik && String(l.external_id ?? '') === kimlik)
        || (r.data.barcode && String(l.sku ?? '') === String(r.data.barcode))
        || (r.data.sku && String(l.sku ?? '') === String(r.data.sku)));
      if (i < 0) eksik.push(r); else kalanDefter.splice(i, 1);
    }

    // ADET EKSIGI: kimlikler ortusse bile defterdeki toplam adet, o defter paketini sahiplenen
    // rapor satirlarinin toplamindan az olabilir. Pazaryeri IKI paket gonderdigi halde ikisi de
    // ayni defter kaydina baglanmissa boyle olur: ikinci paketin mali hic deftere girmemistir.
    // Sayim uydurulmaz, iki taraftan da okunur; esitse hicbir sey yapilmaz.
    const sahipler = (await db.prepare(
      "SELECT json_extract(data_json,'$.package_id') pk,json_extract(data_json,'$.quantity') adet" +
      " FROM ec_report_records WHERE kind='order_line' AND erp_package_id=? AND store_id=?")
      .bind(linked.erp_package_id, store.id).all()).results;
    const baskaPaket = sahipler.some(r => String(r.pk) !== String(packageId));
    const raporAdet = sahipler.reduce((t, r) => t + (Number(r.adet) || 0), 0);
    const defterAdet = defterSatirlari.reduce((t, l) => t + (l.quantity_milli || 0) / 1000, 0);
    const adetEksigi = baskaPaket && defterAdet < raporAdet;

    // Ayrilacak satirlar: kimligi defterde bulunmayanlar; hicbiri bulunamiyorsa ve adet eksigi
    // varsa bu paketin TAMAMI yanlis kayda baglanmistir.
    // ADET KORUMASI HER DURUMDA: defterdeki toplam adet rapordakini karsiliyorsa hicbir sey
    // ayrilmaz. Kimlik biciminden dogan bir yanilgi yuzunden ayni satis ikinci kez deftere
    // gecmesin. Ayrilacak satirlar once kimligi bulunmayanlardir; hicbiri bulunamiyorsa ve
    // defter kaydini baska bir rapor paketi de sahipleniyorsa bu paketin TAMAMI yanlis baglidir.
    const ayrilacak = defterAdet >= raporAdet ? []
      : eksik.length && eksik.length < records.length ? eksik
        : adetEksigi ? records : [];
    if (ayrilacak.length) {
      const ayrilacakSorun = [];
      for (const r of ayrilacak) {
        const d = r.data;
        // Normal taslak yolundaki kural burada da gecerli: kalem kimligi UYDURULMAZ.
        if (!lineIdentity(d, packageId, lineIdentityDeclared))
          ayrilacakSorun.push('Kalem kimliği eksik; uydurma kimlikle stok çıkışı yapılmaz. Raporda kalem numarası yoksa "paket + stok kodu kalemi tekil tanımlar" beyanı gerekir.');
        if (!day(String(d.order_date || '').slice(0, 10))) ayrilacakSorun.push('Sipariş tarihi eksik veya geçersiz.');
        if (!Number.isSafeInteger(d.quantity) || d.quantity <= 0) ayrilacakSorun.push('Sipariş adedi geçersiz.');
        if (CANCELLED.test(String(d.status || '').toLocaleLowerCase('tr-TR'))) ayrilacakSorun.push('İptal/iade kaydı ayrı olaydır; yeni satışa çevrilmez.');
        if (!d.barcode && !d.sku) ayrilacakSorun.push('Barkod veya satıcı stok kodu eksik.');
      }
      const gun = String(ayrilacak[0].data.order_date || '').slice(0, 10);
      const ortak = {store, outcome: 'partial', stock_write: false, covered_by: linked.erp_package_id,
        missing_lines: ayrilacak.map(r => ({barcode: r.data.barcode || r.data.sku, name: r.data.product_name,
          quantity: r.data.quantity, gross_cents: r.data.gross ?? null}))};
      if (ayrilacakSorun.length) return {...ortak, outcome: 'review', issues: [...new Set(ayrilacakSorun)],
        reason: 'Bu paketin bazı satırları defterde yok ama olduğu gibi aktarılamıyor; incelemede kalır.'};
      if (!start) return {...ortak, outcome: 'blocked', reason: 'Stok başlangıç tarihi girilmemiş.'};
      if (gun < start) return {...ortak, outcome: 'historical', occurred_on: gun,
        reason: 'Eksik satır stok başlangıcından eski. Mali rapor korunur; güncel stoktan otomatik düşülmez.'};
      return {...ortak,
        occurred_on: gun,
        fingerprint: await packageFingerprint(ayrilacak),
        source: {provider: store.provider, store_id: store.id, package_id: packageId,
          record_ids: ayrilacak.map(r => r.id), versions: ayrilacak.map(r => r.version), relink_from: linked.erp_package_id},
        order: {channel: store.provider, external_id: 'RPT-' + (await digest([store.provider, store.id, packageId, 'eksik'])).slice(0, 40),
          order_no: ayrilacak[0].data.order_no, occurred_on: gun,
          external_status: ayrilacak[0].data.status || '',
          lines: ayrilacak.map(r => ({external_id: lineIdentity(r.data, packageId, lineIdentityDeclared),
            name: r.data.product_name || r.data.barcode || r.data.sku, sku: r.data.barcode || r.data.sku,
            quantity: r.data.quantity, gross: r.data.gross == null ? null : r.data.gross / 100,
            vat_rate: r.data.vat_bps == null ? null : r.data.vat_bps / 100, net_revenue: null}))},
        reason: (eksik.length
          ? 'Bu paketin ' + eksik.length + ' satırı defterde yok.'
          : 'Bu paket, kalemlerini tutmayan bir sipariş kaydına bağlanmış (defterdeki adet ' + defterAdet +
            ', raporda ' + raporAdet + ').') +
          ' Aşağıdaki ' + ayrilacak.length + ' satır için ayrı bir sipariş taslağı kurulur; mevcut sipariş ve satırları değişmez.',
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
      // Kaydı yalnız BU paketin yerine geçtiği eski numara sahipleniyorsa kayıt bu pakete aittir.
      const claims = (await db.prepare(
        "SELECT data_json,updated_at FROM ec_report_records WHERE erp_package_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id')!=?")
        .bind(t.id, packageId).all()).results.map(r => ({data: parse(r.data_json, {}), updated_at: r.updated_at}));
      if (!claims.length || claims.every(eski => records.some(r => eskittiMi(r, eski)))) sahipsiz.push(t);
    }
    // Birden çok sahipsiz kayıttan biri paket numarasını kimliğinde AÇIKÇA taşıyorsa
    // ("HB-5514249183" gibi toplu yüklemeden gelen kayıt) belirsizlik yoktur: o kayıt bu pakettir.
    const adli = sahipsiz.filter(t => new RegExp('(^|-)' + String(packageId) + '$').test(String(t.external_id || '')));
    if (sahipsiz.length > 1 && adli.length === 1) sahipsiz.splice(0, sahipsiz.length, adli[0]);
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

/**
 * TASLAK siparişin rapor bağlantısını tazeler. Taslakta stok hareketi yoktur; raporun sonradan
 * değişmesi (çoğunlukla yalnız DURUM: "Gönderime Hazır" → "Teslim edildi") taslağı sonsuza dek
 * kilitlememeli. Rapordaki ürün/adet taslaktakiyle AYNIYSA içerik özeti yenilenir ve sipariş
 * sürer; farklıysa dokunulmaz ve sebep döner.
 * Yeniden numaralanmış paketin eski kaydı (eskittiMi) adet karşılaştırmasında sayılmaz.
 */
async function tazeleTaslakBagi(db, packageId) {
  const pkg = await db.prepare('SELECT id,status,report_linked,report_link_hash,source_changed FROM ec_order_packages WHERE id=?').bind(packageId).first();
  if (!pkg || !['draft', 'reserved'].includes(pkg.status) || !pkg.report_linked) return {};
  const rows = (await db.prepare("SELECT data_json,updated_at FROM ec_report_records WHERE erp_package_id=? AND kind='order_line'").bind(packageId).all()).results;
  if (!rows.length) return {};
  const records = rows.map(r => ({data: parse(r.data_json, {}), updated_at: r.updated_at}));
  const hash = await reportLinkFingerprint(records);
  if (hash === pkg.report_link_hash && !pkg.source_changed) return {};
  const gecerli = records.filter(r => !records.some(k => eskittiMi(k, r)));
  const topla = (liste, anahtar, adet) => { const m = new Map(); for (const x of liste) m.set(anahtar(x), (m.get(anahtar(x)) || 0) + adet(x)); return m; };
  const rapor = topla(gecerli, r => malKodu(r.data), r => Number(r.data.quantity) || 0);
  const lines = (await db.prepare('SELECT sku,quantity_milli FROM ec_order_lines WHERE package_id=?').bind(packageId).all()).results;
  const defter = topla(lines, l => String(l.sku || ''), l => (l.quantity_milli || 0) / 1000);
  const ayni = rapor.size === defter.size && [...rapor].every(([k, q]) => defter.get(k) === q);
  if (!ayni) return {error: 'Sipariş taslak kaldı: raporda ürün veya adet değişti (' +
    [...rapor].map(([k, q]) => k + ' × ' + q).join(', ') + '); taslak ' + [...defter].map(([k, q]) => k + ' × ' + q).join(', ') + '.'};
  await db.prepare("UPDATE ec_order_packages SET report_link_hash=?,source_changed=0 WHERE id=? AND status IN ('draft','reserved')").bind(hash, packageId).run();
  return {updated: true};
}

// RAF SAYIMI DÜZELTMESİ. Ürün, sipariş tarihinden SONRA rafta geçici sayılmışsa (GECICI-SAYIM) o
// sayım satıştan SONRAKİ rafı gösterir. Satış şimdi stoktan düşülürse raf eksik görünür. Satış
// kaydedilir ve aynı sayım, satılan adet kadar artırılır (ayrı referanslı ek sayım hareketi,
// sayımın kendi birim değeriyle). Raf değişmez; ek adet de faturasızdır ve fatura gelince
// geçici sayımla birlikte kendiliğinden kapanır. Tekrar çalıştırmada ikinci kez yazılmaz.
async function sayimiSatislaDuzelt(db, packageId, occurred) {
  const rows = (await db.prepare(`SELECT c.product_id,SUM(c.quantity_milli) q,
      (SELECT m.id FROM ec_stock_movements m WHERE m.product_id=c.product_id AND m.kind='count' AND m.quantity_milli>0
        AND m.reference LIKE 'GECICI-SAYIM-%' AND m.reference NOT LIKE '%-SAT-%' AND m.occurred_on>=? ORDER BY m.occurred_on,m.rowid LIMIT 1) sayim_id
    FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=? GROUP BY c.product_id`).bind(occurred, packageId).all()).results
    .filter(r => r.sayim_id);
  let yazildi = 0;
  for (const r of rows) {
    const m = await db.prepare('SELECT reference,quantity_milli,value_cents,occurred_on FROM ec_stock_movements WHERE id=?').bind(r.sayim_id).first();
    const ref = m.reference + '-SAT-' + packageId.slice(0, 8);
    if (await db.prepare("SELECT 1 FROM ec_stock_movements WHERE kind='count' AND reference=? AND product_id=?").bind(ref, r.product_id).first()) continue;
    await db.prepare(`INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
      VALUES(?,?,?,?,'count',?,?,?)`).bind(crypto.randomUUID(), r.product_id, r.q, Math.round(m.value_cents * r.q / m.quantity_milli), ref,
      'Geçici sayım, sayımdan önceki satış kadar artırıldı (' + m.reference + '). Raf değişmez; fatura gelince kapanır.', m.occurred_on).run();
    yazildi++;
  }
  return yazildi;
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

  // OTOMATİK AKTARIM. Sipariş raporu işlendikten sonra, panele bağlanmamış her paket için elle
  // "Stoğa aktar → Stok ayır → Gönder" yapmak gerekiyordu. Bu uç aynı adımları mevcut akışlardan
  // (bütün korumalarıyla) sırayla çalıştırır: sipariş panelde varsa bağlar, yoksa açar; ürün
  // eşleşmesi tamamsa stok ayırır; raporda kargoya verilmişse gönderir (stok düşer), teslim
  // edilmişse teslim işler. İptal/iade ve incelemeye düşen paket ATLANIR ve sebebi döner.
  // Tek çağrı en çok AUTO_LIMIT paket işler; ekran bitene kadar tekrar çağırır (skip: atlananlar).
  if (sub === '/auto' && method === 'POST') {
    const x = await readBody(request), storeId = key(x.store_id), skip = new Set(Array.isArray(x.skip) ? x.skip.map(String) : []);
    const AUTO_LIMIT = 5;
    const hepsi = (await db.prepare(`SELECT json_extract(data_json,'$.package_id') package_id,
        GROUP_CONCAT(COALESCE(json_extract(data_json,'$.status'),''),'|') statuses,
        MAX(substr(json_extract(data_json,'$.order_date'),1,10)) order_date,
        SUM(COALESCE(json_extract(data_json,'$.delivered_date'),'')='') not_delivered,
        MAX(substr(json_extract(data_json,'$.delivered_date'),1,10)) delivered_on
      FROM ec_report_records WHERE store_id=? AND kind='order_line' AND json_extract(data_json,'$.package_id') IS NOT NULL
        AND (erp_package_id IS NULL OR erp_package_id IN (SELECT id FROM ec_order_packages WHERE status IN ('cancelled','draft','reserved')))
        -- Bu paket için açılan sipariş İPTAL edildiyse (ör. yanlışlıkla eklenen hediye) karar verilmiştir:
        -- her rapor işlenişinde yeniden denenip "atlanan" diye gösterilmez.
        AND NOT (erp_package_id IN (SELECT id FROM ec_order_packages WHERE status='cancelled')
          AND erp_package_id IN (SELECT target_id FROM import_items WHERE kind='report_stock_link'
            AND source_key LIKE '%:'||json_extract(ec_report_records.data_json,'$.package_id')))
      GROUP BY package_id ORDER BY order_date,package_id`).bind(storeId).all()).results
      .filter(c => !skip.has(String(c.package_id)));
    // Yeniden numaralanmış paketin ESKİ numarası işlenmez; satış yeni numarayla bir kez yazılır.
    const kardes = (await db.prepare(`SELECT data_json,updated_at FROM ec_report_records WHERE store_id=? AND kind='order_line'
        AND json_extract(data_json,'$.order_no') IN (SELECT json_extract(data_json,'$.order_no') FROM ec_report_records
          WHERE store_id=? AND kind='order_line' GROUP BY 1 HAVING COUNT(DISTINCT json_extract(data_json,'$.package_id'))>1)`)
      .bind(storeId, storeId).all()).results.map(r => ({data: parse(r.data_json, {}), updated_at: r.updated_at}));
    const eskiPaket = new Set();
    for (const pk of new Set(kardes.map(r => String(r.data.package_id)))) {
      const own = kardes.filter(r => String(r.data.package_id) === pk);
      if (own.every(eski => kardes.some(r => eskittiMi(r, eski)))) eskiPaket.add(pk);
    }
    // Stok AYRILMIŞ sipariş yalnız rapor kargoya verildiğini söylüyorsa işe girer (gönderim).
    const ayrilmis = new Set((await db.prepare(`SELECT DISTINCT json_extract(r.data_json,'$.package_id') pk FROM ec_report_records r
        JOIN ec_order_packages p ON p.id=r.erp_package_id WHERE r.store_id=? AND r.kind='order_line' AND p.status='reserved'`)
      .bind(storeId).all()).results.map(r => String(r.pk)));
    const GITTI = /kargo|teslim|shipped|delivered|yolda/;
    const iptalAcik = new Set((await db.prepare(`SELECT DISTINCT json_extract(r.data_json,'$.package_id') pk FROM ec_report_records r
        JOIN ec_order_packages p ON p.id=r.erp_package_id WHERE r.store_id=? AND r.kind='order_line' AND p.status IN ('draft','reserved')`)
      .bind(storeId).all()).results.map(r => String(r.pk)));
    const all = hepsi.filter(c => !eskiPaket.has(String(c.package_id))
      && (!CANCELLED.test(String(c.statuses || '').toLocaleLowerCase('tr-TR')) || iptalAcik.has(String(c.package_id)))
      && (!ayrilmis.has(String(c.package_id)) || GITTI.test(String(c.statuses || '').toLocaleLowerCase('tr-TR')) || CANCELLED.test(String(c.statuses || '').toLocaleLowerCase('tr-TR'))));
    const results = [];
    const call = (handler, url, body) => handler(new Request('https://internal.invalid' + url, {method: 'POST'}), env, url, async () => body);
    for (const c of all.slice(0, AUTO_LIMIT)) {
      const pkg = String(c.package_id), durum = String(c.statuses || '').toLocaleLowerCase('tr-TR');
      const out = {package_id: pkg};
      try {
        // İPTAL: gönderilmemiş (taslak/ayrılmış) sipariş iptal edilir, ayrılan stok serbest kalır.
        // Panelde karşılığı olmayan iptal paketi listeye hiç girmez (yukarıda elendi).
        if (CANCELLED.test(durum)) {
          const acik = await db.prepare(`SELECT DISTINCT p.id FROM ec_report_records r JOIN ec_order_packages p ON p.id=r.erp_package_id
            WHERE r.store_id=? AND r.kind='order_line' AND json_extract(r.data_json,'$.package_id')=? AND p.status IN ('draft','reserved')`).bind(storeId, pkg).first();
          if (acik) { await call(ordersApi, '/api/orders/' + acik.id + '/cancel', {reason: 'Pazaryeri raporunda iptal/iade: ' + pkg}); results.push({...out, done: 'iptal edildi', order_package: acik.id}); }
          else results.push({...out, skipped: true, reason: 'İptal/iade: satış açılmadı.'});
          continue;
        }
        // Pazaryeri raporunda kalem kimliği sütunu yoktur; her satırda paket no ve barkod/stok kodu
        // vardır. Elle aktarımda da kullanılan "paket no + stok kodu" kimliği açıkça beyan edilir;
        // aynı pakette aynı kod iki kez geçerse plan zaten incelemeye düşürür.
        // Daha önce açılıp taslak kalmış sipariş yeniden açılmaz; kaldığı yerden sürer.
        const cur = await db.prepare(`SELECT p.id,p.occurred_on,p.status FROM ec_report_records r JOIN ec_order_packages p ON p.id=r.erp_package_id
          WHERE r.store_id=? AND r.kind='order_line' AND json_extract(r.data_json,'$.package_id')=? AND p.status IN ('draft','reserved') LIMIT 1`).bind(storeId, pkg).first();
        let id, occurred, steps = [];
        if (cur) {
          id = cur.id; occurred = cur.occurred_on; steps.push(cur.status === 'reserved' ? 'ayrılmış sipariş sürdürüldü' : 'taslak sürdürüldü');
          const tazele = await tazeleTaslakBagi(db, id);
          if (tazele.error) { results.push({...out, skipped: true, order_package: id, reason: tazele.error}); continue; }
          if (tazele.updated) steps.push('rapor güncellemesi işlendi');
        }
        else {
          const linked = await call(reportStockLinkApi, '/api/reports/stock-link/apply', {store_id: storeId, package_id: pkg, complete_package_confirmed: true, line_identity_from_package_sku: true});
          if (linked.outcome === 'match') { results.push({...out, done: 'bağlandı', order_package: linked.package_id}); continue; }
          if (!linked.applied) { results.push({...out, skipped: true, reason: linked.reason || (linked.issues || []).join(' ') || linked.outcome}); continue; }
          id = linked.package_id; occurred = linked.occurred_on; steps.push('sipariş açıldı');
        }
        // KDV hariç tutar: pazaryeri sipariş raporu KDV oranı vermez. Satırın eşleştiği stok
        // ürünlerinin fiyat profilinde TEK ve tanımlı bir oran varsa o oranla tamamlanır (ürüne
        // kullanıcının tanımladığı oran; kategoriden tahmin değil). Yoksa taslak kalır.
        const ls = (await db.prepare(`SELECT l.id,l.gross_cents,l.net_revenue_cents,
            (SELECT c.mapping_id FROM ec_order_line_components c WHERE c.line_id=l.id AND c.mapping_id IS NOT NULL LIMIT 1) mapping_id,
            (SELECT COUNT(DISTINCT pp.vat_bps) FROM ec_order_line_components c JOIN ec_price_profiles pp ON pp.product_id=c.product_id WHERE c.line_id=l.id) oran_sayisi,
            (SELECT MIN(pp.vat_bps) FROM ec_order_line_components c JOIN ec_price_profiles pp ON pp.product_id=c.product_id WHERE c.line_id=l.id) oran,
            (SELECT COUNT(*) FROM ec_order_line_components c LEFT JOIN ec_price_profiles pp ON pp.product_id=c.product_id WHERE c.line_id=l.id AND pp.vat_bps IS NULL) oransiz
          FROM ec_order_lines l WHERE l.package_id=?`).bind(id).all()).results;
        const eksik = cur?.status === 'reserved' ? [] : ls.filter(l => l.net_revenue_cents === null && l.gross_cents !== null && l.mapping_id && l.oran_sayisi === 1 && !l.oransiz);
        if (eksik.length) { await call(ordersApi, '/api/orders/' + id + '/map', {lines: eksik.map(l => ({id: l.id, mapping_id: l.mapping_id, vat_rate: l.oran / 100}))}); steps.push('KDV ürün profilinden'); }
        const linked = {occurred_on: occurred};
        // Ürün sipariş tarihinden sonra rafta geçici sayıldıysa sayım satış kadar artırılır; satış sonra düşer.
        if (await sayimiSatislaDuzelt(db, id, occurred || c.order_date)) steps.push('raf sayımı satışla düzeltildi');
        try { if (cur?.status !== 'reserved') { await call(ordersApi, '/api/orders/' + id + '/reserve', {}); steps.push('stok ayrıldı'); } }
        catch (e) { results.push({...out, skipped: true, reason: 'Sipariş taslak kaldı: ' + e.message, order_package: id}); continue; }
        if (/kargo|teslim|shipped|delivered|yolda/.test(durum)) {
          await call(ordersApi, '/api/orders/' + id + '/ship', {occurred_on: linked.occurred_on || c.order_date, reference: 'RAPOR-' + pkg});
          steps.push('gönderildi');
          if (!c.not_delivered && day(c.delivered_on)) { await call(ordersApi, '/api/orders/' + id + '/deliver', {occurred_on: c.delivered_on}); steps.push('teslim edildi'); }
        }
        results.push({...out, done: steps.join(', '), order_package: id});
      } catch (e) { results.push({...out, skipped: true, reason: e.message}); }
    }
    return {results, remaining: Math.max(0, all.length - AUTO_LIMIT)};
  }

  // OTOMATİK İADE. Raporda tam iade görünen (ya da teslim edilemeyip yeniden gönderilen) ama
  // defterde hâlâ satış olarak duran paketler, mevcut satış iadesi ucundan iade edilir: mal stoğa
  // döner, satış tutarı geri alınır; kargo ve hizmet bedeli gider olarak kalır. Kısmi iade
  // (hangi satır olduğu raporda yok) listede atlanır. Aynı satış ikinci kez iade edilmez.
  if (sub === '/returns-apply' && method === 'POST') {
    const x = await readBody(request);
    if (x.confirm !== true) fail('İade aktarımını onaylayın.');
    const {pending, skipped} = await pendingReturns(db, x.store_id || '');
    const done = [], errors = [];
    for (const p of pending.slice(0, 20)) for (const l of p.lines) {
      const url = '/api/accounting/sales/' + l.sale_id + '/return';
      try {
        await accountingApi(new Request('https://internal.invalid' + url, {method: 'POST'}), env, url, async () => ({
          quantity: l.quantity, revenue: l.revenue_cents / 100, restock: true,
          // Kesinti siparişin son hâlinde (satış kaydında) durur; iadeye ayrıca yazılmaz.
          commission: 0, shipping: 0, other: 0, fees_status: 'confirmed',
          external_id: 'IADE-' + p.order_no + '-' + String(l.sale_id).slice(0, 8), occurred_on: l.occurred_on,
          notes: (p.reason || 'Pazaryeri raporunda iade: ' + p.order_no + '.') + ' Mal geri döndü; kargo ve hizmet bedeli gider olarak kalır.'}));
        done.push({order_no: p.order_no, sale_id: l.sale_id});
      } catch (e) { errors.push({order_no: p.order_no, reason: e.message}); }
    }
    return {done, errors, skipped, remaining: Math.max(0, pending.length - 20)};
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
