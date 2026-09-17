// Rapor Kutusu → sipariş → stok köprüsü.
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR. Stok kuralları doğrulanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);

/** Rapor dosyası + kayıtları doğrudan yazar (yükleme akışı ayrıca test ediliyor). */
function store(f, {provider = 'trendyol', code = 'TY-1'} = {}) {
  const id = 'store-' + code;
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', id, provider, code, 'Mağaza ' + code);
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
    VALUES(?,?,'orders','rapor.xlsx',100,?,?,'[]',1,1,'applied')`, 'file-' + code, id, 'f'.repeat(64), '2026-09-12T10:00');
  return id;
}
function record(f, storeId, code, data, n) {
  sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
    VALUES(?,?,'order_line',?,'provider',?,?,?,?,?)`,
    'rec-' + code + '-' + n, storeId, 'L:' + data.line_id, JSON.stringify(data), '2026-09-12T10:00', '2026-09-12T10:00', 'file-' + code, n);
}
const startDate = (f, date) => sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', date, 'ec');
const line = (over = {}) => ({package_id: 'PK1', line_id: 'L1', order_no: 'O1', order_date: DATE,
  barcode: '785457868', product_name: '4 adet 225 ml', quantity: 2, gross: 50000, vat_bps: 2000, status: 'Teslim edildi', ...over});
const stockOf = (f, id) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(id).quantity_milli;

/** Dörtlü paket ilanı: 1 ilan = 4 şişe. */
async function fourPack(f) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  return product;
}

test('Önizleme yazmaz; stok başlangıcı girilmeden geçmiş sipariş uygulanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);

    const blocked = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(blocked.outcome, 'blocked', 'stok başlangıç tarihi yokken aktarılamaz');
    assert.equal(blocked.stock_write, false);

    startDate(f, DATE);
    const ready = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(ready.outcome, 'draft');
    assert.equal(ready.order.lines.length, 1);
    assert.equal(ready.order.lines[0].quantity, 2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0, 'önizleme sipariş açmadı');
  } finally { f.close(); }
});

test('Aktarım tek taslak sipariş açar; stok ancak gönderimde bir kez düşer, tekrar aktarım çoğaltmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);

    // Paketin tamamı doğrulanmadan aktarılmaz.
    assert.equal((await f.req('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1'})).status, 409);

    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.applied, true);
    assert.equal(applied.stock_write, false, 'aktarım stok yazmaz');
    assert.equal(stockOf(f, product.id), 20000, 'stok henüz değişmedi');

    // Stok yalnız sipariş adımlarında değişir: 2 ilan × 4 şişe = 8.
    await f.ok('/ec/orders/' + applied.package_id + '/reserve', {});
    await f.ok('/ec/orders/' + applied.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-1'});
    assert.equal(stockOf(f, product.id), 12000, '2 paket × 4 şişe bir kez düştü');

    // Aynı paketi yeniden aktarmak ikinci sipariş veya ikinci çıkış yaratmaz.
    const again = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(again.applied, false);
    assert.equal(again.outcome, 'existing');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 1);
    assert.equal(stockOf(f, product.id), 12000, 'tekrar aktarım stoğu çoğaltmadı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n, 1);
  } finally { f.close(); }
});

test('KDV oranı bilinmeyen pakette stok ayrılamaz; kural gevşetilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', {...line(), vat_bps: undefined}, 1);
    startDate(f, DATE);
    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.applied, true, 'taslak açılır');
    const reserve = await f.req('/ec/orders/' + applied.package_id + '/reserve', {});
    assert.equal(reserve.status, 409, 'KDV hariç tutar bilinmeden stok ayrılmaz');
    assert.match(reserve.data.error, /tutarı eksik/i);
    assert.equal(stockOf(f, product.id), 20000, 'stok değişmedi');
  } finally { f.close(); }
});

test('Stok başlangıcından eski sipariş bugünkü stoktan düşülmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line({order_date: '2026-07-01'}), 1);
    startDate(f, DATE);
    const result = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(result.outcome, 'historical');
    assert.equal(result.applied, false);
    assert.equal(stockOf(f, product.id), 20000);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0);
  } finally { f.close(); }
});

test('İptal/iade, eksik kimlik ve çelişkili sipariş incelemede kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    startDate(f, DATE);

    record(f, s, 'TY-1', line({package_id: 'PK-IADE', line_id: 'LI', status: 'İade Edildi'}), 1);
    const refund = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-IADE'});
    assert.equal(refund.outcome, 'review');
    assert.ok(refund.issues.some(i => /yeni satışa çevrilmez/.test(i)));

    record(f, s, 'TY-1', {package_id: 'PK-EKSIK', order_no: 'O9', order_date: DATE, barcode: '785457868', quantity: 1, status: 'Teslim edildi'}, 2);
    const missing = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-EKSIK'});
    assert.equal(missing.outcome, 'review');
    assert.ok(missing.issues.some(i => /Kalem kimliği eksik/.test(i)));

    // Aynı pakette iki farklı sipariş numarası
    record(f, s, 'TY-1', line({package_id: 'PK-CELISKI', line_id: 'LC1', order_no: 'A'}), 3);
    record(f, s, 'TY-1', line({package_id: 'PK-CELISKI', line_id: 'LC2', order_no: 'B'}), 4);
    const conflict = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK-CELISKI'});
    assert.equal(conflict.outcome, 'review');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0);
  } finally { f.close(); }
});

test('Aynı paket numarası iki mağazada karışmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const a = store(f, {code: 'TY-1'}), b = store(f, {code: 'TY-2'});
    record(f, a, 'TY-1', line(), 1);
    record(f, b, 'TY-2', line({line_id: 'L2'}), 1);
    startDate(f, DATE);

    const first = await f.ok('/ec/reports/stock-link/apply', {store_id: a, package_id: 'PK1', complete_package_confirmed: true});
    const second = await f.ok('/ec/reports/stock-link/apply', {store_id: b, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(first.applied, true);
    assert.equal(second.applied, true);
    assert.notEqual(first.package_id, second.package_id, 'iki mağaza ayrı sipariş açar');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 2);
  } finally { f.close(); }
});

test('Aktarılabilir paketler listelenir ve bağlanan paket işaretlenir', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);
    let list = await f.ok('/ec/reports/stock-link/candidates?store_id=' + s);
    assert.equal(list.inventory_start_date, DATE);
    assert.equal(list.candidates.length, 1);
    assert.equal(list.candidates[0].linked, false);

    await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    list = await f.ok('/ec/reports/stock-link/candidates?store_id=' + s);
    assert.equal(list.candidates[0].linked, true, 'bağlanan paket işaretli');
  } finally { f.close(); }
});

test('Kalem kimliği yoksa istisna ancak AÇIKÇA beyan edilirse uygulanır', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    startDate(f, DATE);

    // Saglayici kalem kimligi vermemis; paket numarasi ve barkod var.
    const s1 = store(f, {code: 'TY-9'});
    record(f, s1, 'TY-9', {package_id: 'PK-BEYAN', order_no: 'O7', order_date: DATE, barcode: '785457868', quantity: 1, status: 'Teslim edildi'}, 1);

    // 1) Beyan YOKSA eski kural aynen gecerli: incelemede kalir.
    const beyansiz = await f.ok('/ec/reports/stock-link/preview', {store_id: s1, package_id: 'PK-BEYAN'});
    assert.equal(beyansiz.outcome, 'review');
    assert.ok(beyansiz.issues.some(i => /Kalem kimliği eksik/.test(i)));

    // 2) Beyan VARSA kimlik paket + stok kodundan turetilir; onizleme yine hicbir sey yazmaz.
    const beyanli = await f.ok('/ec/reports/stock-link/preview', {store_id: s1, package_id: 'PK-BEYAN', line_identity_from_package_sku: true});
    assert.equal(beyanli.outcome, 'draft');
    assert.equal(beyanli.stock_write, false);
    assert.equal(beyanli.order.lines[0].external_id, 'PK-BEYAN|785457868');

    // 3) Beyan olsa bile stok kodu ve barkod yoksa kimlik UYDURULMAZ.
    const s2 = store(f, {code: 'TY-8'});
    record(f, s2, 'TY-8', {package_id: 'PK-KODSUZ', order_no: 'O8', order_date: DATE, quantity: 1, status: 'Teslim edildi'}, 1);
    const kodsuz = await f.ok('/ec/reports/stock-link/preview', {store_id: s2, package_id: 'PK-KODSUZ', line_identity_from_package_sku: true});
    assert.equal(kodsuz.outcome, 'review');
    assert.ok(kodsuz.issues.some(i => /Kalem kimliği eksik/.test(i)));

    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0, 'önizleme sipariş açmaz');
  } finally { f.close(); }
});

test('Sipariş panelde zaten varsa ikinci sipariş açılmaz; rapor mevcut siparişe bağlanır, stok değişmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    // Sipariş panele BAŞKA yoldan girmiş: farklı paket kodu ('HB-...' gibi), aynı sipariş numarası.
    const mevcut = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'ELLE-O1', order_no: 'O1', occurred_on: DATE,
      lines: [{external_id: 'E1', sku: '785457868', name: '4 adet 225 ml', quantity: 2, gross: 500, vat_rate: 20}]});
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);

    const plan = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(plan.outcome, 'match', 'mevcut sipariş bulunur');
    assert.equal(plan.package_id, mevcut.id);

    const stokOnce = stockOf(f, product.id), paketOnce = f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n;
    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.outcome, 'match');
    assert.equal(applied.package_id, mevcut.id);
    assert.equal(applied.linked_records, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, paketOnce, 'ikinci sipariş açılmadı');
    assert.equal(stockOf(f, product.id), stokOnce, 'stok değişmedi');
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE kind='order_line'").get().erp_package_id, mevcut.id);
  } finally { f.close(); }
});

test('Farklı mağazanın aynı numaralı siparişine bağlanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const a = store(f, {code: 'TY-1'}), b = store(f, {code: 'TY-2'});
    record(f, a, 'TY-1', line(), 1);
    record(f, b, 'TY-2', line({line_id: 'L2'}), 2);
    startDate(f, DATE);
    const first = await f.ok('/ec/reports/stock-link/apply', {store_id: a, package_id: 'PK1', complete_package_confirmed: true});
    // A mağazasının siparişi artık A'nın kaydına bağlı; B onu sahiplenemez.
    const plan = await f.ok('/ec/reports/stock-link/preview', {store_id: b, package_id: 'PK1'});
    assert.notEqual(plan.outcome, 'match', 'başka mağazanın siparişine bağlanmaz');
    assert.equal(plan.outcome, 'draft');
    const second = await f.ok('/ec/reports/stock-link/apply', {store_id: b, package_id: 'PK1', complete_package_confirmed: true});
    assert.notEqual(second.package_id, first.package_id);
  } finally { f.close(); }
});

test('İptal edilmiş siparişe bağlı kalmış rapor kaydı, gerçek siparişe yönlendirilir', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);
    // Önce kopya sipariş açılmış ve iptal edilmiş (eski hatalı bağlama).
    const kopya = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    await f.ok('/ec/orders/' + kopya.package_id + '/cancel', {reason: 'Kopya kayıt'});
    // Siparişin gerçek karşılığı panelde ayrıca duruyor.
    const gercek = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'ELLE-O1', order_no: 'O1', occurred_on: DATE,
      lines: [{external_id: 'E1', sku: '785457868', name: '4 adet 225 ml', quantity: 2, gross: 500, vat_rate: 20}]});

    const stokOnce = stockOf(f, product.id);
    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.outcome, 'match');
    assert.equal(applied.package_id, gercek.id, 'iptal edilene değil gerçek siparişe bağlanır');
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE kind='order_line'").get().erp_package_id, gercek.id);
    assert.equal(stockOf(f, product.id), stokOnce, 'stok değişmedi');
  } finally { f.close(); }
});

test('Bölünmüş sipariş (1 sipariş, N paket) tek kayda bağlanmaz; her parça kendi siparişi olur', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    const s = store(f);
    // Aynı sipariş numarası, iki ayrı paket.
    record(f, s, 'TY-1', line(), 1);
    record(f, s, 'TY-1', line({package_id: 'PK2', line_id: 'L2'}), 2);
    startDate(f, DATE);
    const a = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    const b = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK2', complete_package_confirmed: true});
    assert.equal(a.applied, true);
    assert.equal(b.applied, true, 'ikinci parça incelemede takılmaz');
    assert.notEqual(a.package_id, b.package_id, 'her parça kendi siparişi');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 2);
  } finally { f.close(); }
});

test('Sipariş panelde iki kayıtla duruyorsa İKİNCİSİ AÇILMAZ; belirsizlik incelemeye gider', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    // Aynı sipariş panele iki paket olarak girmiş (bölünmüş), ikisi de rapora bağlanmamış.
    const a = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'ELLE-1', order_no: 'O1', occurred_on: DATE,
      lines: [{external_id: 'E1', sku: '785457868', name: '4 adet 225 ml', quantity: 1, gross: 250, vat_rate: 20}]});
    const b = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'ELLE-2', order_no: 'O1', occurred_on: DATE,
      lines: [{external_id: 'E2', sku: '785457868', name: '4 adet 225 ml', quantity: 1, gross: 250, vat_rate: 20}]});
    const s = store(f);
    record(f, s, 'TY-1', line(), 1);
    startDate(f, DATE);

    const paketOnce = f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n;
    const stokOnce = stockOf(f, product.id);
    const plan = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(plan.outcome, 'review', 'belirsizken yeni sipariş açılmaz');
    const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(applied.applied, false, 'ÇİFT KAYIT oluşmaz');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, paketOnce);
    assert.equal(stockOf(f, product.id), stokOnce, 'stok iki kez düşmedi');
    assert.ok(a.id && b.id);
  } finally { f.close(); }
});

// Rapor kaydı sipariş NUMARASIYLA bağlanır; satırların gerçekten o pakette olduğu
// doğrulanmaz. Bağlı olduğu sipariş paketin bütün kalemlerini tutmuyorsa, eksik satırın
// cirosu yokken paketin bütün kesintileri kalan satıra yüklenir ve kârlı sipariş zararlı
// görünür; üstelik çıkan mal stoktan düşmemiştir. Canlıda iki paket bu durumdaydı.
test('Defterde olmayan satırlar için ayrı taslak kurulur; mevcut sipariş değişmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    startDate(f, DATE);
    const s = store(f);
    // Defter paketi ÖNCE tek satırla kuruldu (canlıda fatura kaydından gelmişti).
    record(f, s, 'TY-1', line({line_id: 'L1', gross: 50000}), 1);
    const ilk = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(ilk.outcome, 'draft');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_lines WHERE package_id=?').get(ilk.package_id).n, 1);

    // Sonra rapor ikinci satırı getirdi ve sipariş NUMARASIYLA aynı pakete bağlandı —
    // ama o satır defterde yok. Canlıda tam olarak bu oldu.
    record(f, s, 'TY-1', line({line_id: 'L2', gross: 22139, quantity: 1}), 2);
    f.sqlite.prepare("UPDATE ec_report_records SET erp_package_id=? WHERE record_key='L:L2'").run(ilk.package_id);

    // Önizleme: eksik satır görülür ve HİÇBİR ŞEY yazılmaz.
    const stokOnce = stockOf(f, product.id);
    const onizleme = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK1'});
    assert.equal(onizleme.outcome, 'partial');
    assert.equal(onizleme.stock_write, false);
    assert.equal(onizleme.covered_by, ilk.package_id);
    assert.equal(onizleme.missing_lines.length, 1);
    assert.equal(onizleme.missing_lines[0].gross_cents, 22139);
    assert.equal(stockOf(f, product.id), stokOnce, 'önizleme stok değiştirmedi');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 1);

    // Uygula: eksik satır için AYRI taslak açılır.
    const sonuc = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(sonuc.outcome, 'partial');
    assert.equal(sonuc.applied, true);
    assert.notEqual(sonuc.package_id, ilk.package_id, 'yeni paket açıldı');
    assert.equal(sonuc.stock_write, false, 'taslak açmak stok düşürmez');
    assert.equal(stockOf(f, product.id), stokOnce, 'stok taslak aşamasında değişmedi');

    // Mevcut sipariş ve satırları DEĞİŞMEDİ.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_lines WHERE package_id=?').get(ilk.package_id).n, 1);
    // Eksik satırın rapor kaydı artık yeni pakete bağlı.
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE record_key='L:L2'").get().erp_package_id, sonuc.package_id);
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE record_key='L:L1'").get().erp_package_id, ilk.package_id,
      'yerinde duran satırın bağı değişmedi');

    // İkinci kez çalıştırmak yeni paket açmaz.
    const tekrar = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    assert.equal(tekrar.applied, false);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 2, 'üçüncü paket açılmadı');
  } finally { f.close(); }
});

// Fatura kaydından kurulan pakette satır kimlikleri barkod taşımaz; rapor kimlikleriyle hiç
// örtüşmez. Pazaryeri İKİ paket gönderdiği hâlde ikisi de aynı defter kaydına bağlanmışsa
// ikinci paketin malı hiç deftere girmemiştir. Ama "kimlik tutmadı" tek başına yetmez:
// defterdeki ADET, o kaydı sahiplenen rapor satırlarının toplamından AZ olmalı.
test('Yanlış bağlanan ikinci paket ayrılır; adet yeterliyse ayrılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await fourPack(f);
    startDate(f, DATE);
    const s = store(f);
    // Pazaryeri iki paket: PK1 ve PK2, her biri 1 adet.
    record(f, s, 'TY-1', line({package_id: 'PK1', line_id: 'L1', quantity: 1, gross: 300000}), 1);
    record(f, s, 'TY-1', line({package_id: 'PK2', line_id: 'L2', quantity: 1, gross: 300000}), 2);
    const ilk = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    // Defter satırının kimliği fatura biçiminde: rapor kimliğiyle örtüşmez.
    f.sqlite.prepare("UPDATE ec_order_lines SET external_id='TEA-086-1' WHERE package_id=?").run(ilk.package_id);
    // PK2 de aynı defter kaydına bağlanmış (sipariş numarasıyla).
    f.sqlite.prepare("UPDATE ec_report_records SET erp_package_id=? WHERE record_key='L:L2'").run(ilk.package_id);

    const stokOnce = stockOf(f, product.id);
    const onizleme = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK2'});
    assert.equal(onizleme.outcome, 'partial', 'yanlış bağlanan paket ayrıldı');
    assert.equal(onizleme.stock_write, false);
    assert.equal(stockOf(f, product.id), stokOnce, 'önizleme stok değiştirmedi');

    const sonuc = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK2', complete_package_confirmed: true});
    assert.equal(sonuc.applied, true);
    assert.notEqual(sonuc.package_id, ilk.package_id);
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE record_key='L:L2'").get().erp_package_id, sonuc.package_id);
    // Mevcut paket ve satırı değişmedi.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_lines WHERE package_id=?').get(ilk.package_id).n, 1);
  } finally { f.close(); }
});

test('Defterdeki adet rapordaki toplamı karşılıyorsa ikinci paket AÇILMAZ', async () => {
  const f = appFixture(); await f.setup(); try {
    await fourPack(f);
    startDate(f, DATE);
    const s = store(f);
    record(f, s, 'TY-1', line({package_id: 'PK1', line_id: 'L1', quantity: 1, gross: 300000}), 1);
    record(f, s, 'TY-1', line({package_id: 'PK2', line_id: 'L2', quantity: 1, gross: 300000}), 2);
    const ilk = await f.ok('/ec/reports/stock-link/apply', {store_id: s, package_id: 'PK1', complete_package_confirmed: true});
    // Defter iki adedi de tutuyor: kimlik örtüşmese bile eksik YOK.
    f.sqlite.prepare("UPDATE ec_order_lines SET external_id='TEA-086-1',quantity_milli=2000 WHERE package_id=?").run(ilk.package_id);
    f.sqlite.prepare("UPDATE ec_report_records SET erp_package_id=? WHERE record_key='L:L2'").run(ilk.package_id);

    const onizleme = await f.ok('/ec/reports/stock-link/preview', {store_id: s, package_id: 'PK2'});
    assert.notEqual(onizleme.outcome, 'partial', 'adet yeterliyken ikinci paket önerilmedi');
    assert.equal(onizleme.stock_write, false);
  } finally { f.close(); }
});
