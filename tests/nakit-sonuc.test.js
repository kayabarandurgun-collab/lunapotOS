// Kullanıcı KDV hariç katkıyı değil, CEBİNE KALAN parayı görmek istiyor.
// Kanıtlanan: nakit sonuç = KDV dahil satış − KDV dahil mal maliyeti − KDV dahil kesintiler,
// kesinti KDV oranı UYDURULMAZ (rapor profilinde beyan yoksa nakit sonuç boş kalır),
// ve kâr/zarar sayımı nakite göre yapılır.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {selectPerformanceRows} from '../public/performance-tools.js';
import {performanceApi} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

const rapor = f => performanceApi(new Request('https://test.local/api/ec/performance?from=2026-09-01&to=2026-09-30'), {...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')}, '/api/performance');

function kur(f, {feeVat = true} = {}) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Ürün','U1','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=100000,value_cents=460000 WHERE product_id='p1'");
  f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk','hepsiburada','P1','S1','2026-09-01','draft','t')");
  f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln','pk','L1','Ürün',1000,11000)");
  // Satış: KDV hariç 110 TL, maliyet 46 TL, kesintiler KDV hariç.
  f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('se','hepsiburada','S-1','p1','sale',1000,11000,4600,1610,8992,1138,'confirmed','2026-09-05')");
  f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm','ln','p1',1000,10000,'se','adet')");
  f.sqlite.exec("UPDATE ec_order_packages SET status='reserved' WHERE id='pk'");
  f.sqlite.exec("UPDATE ec_order_packages SET status='shipped' WHERE id='pk'");
  f.sqlite.exec("UPDATE ec_order_packages SET status='delivered',delivered_on='2026-09-05' WHERE id='pk'");
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','hepsiburada','HB','HB')");
  if (feeVat) f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
}

test('Kâr raporu nakit gösterir: KDV dahil satış − KDV dahil maliyet − KDV dahil kesinti', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    const r = await rapor(f);
    const row = r.rows.find(x => x.order_no === 'S1');
    // 132,00 − 55,20 − 19,32 − 107,90 − 13,66 = −64,08
    assert.equal(row.revenue_gross_cents, 13200, 'satış KDV dahil');
    assert.equal(row.cost_gross_cents, 5520, 'maliyet KDV dahil');
    assert.equal(row.commission_gross_cents, 1932, 'komisyon KDV dahil');
    assert.equal(row.cash_cents, 13200 - 5520 - 1932 - 10790 - 1366);
    assert.equal(row.profit_cents, 11000 - 4600 - 1610 - 8992 - 1138, 'KDV hariç katkı da duruyor');

    const hb = r.channels.find(c => c.channel === 'hepsiburada');
    assert.equal(hb.cash_cents, row.cash_cents);
    assert.equal(hb.cash_losses, 1, 'nakit zararda bir paket');
    // Süzgeç de nakite göre sayar.
    assert.equal(selectPerformanceRows(r.rows, {result: 'loss'}).length, 1);
    assert.equal(selectPerformanceRows(r.rows, {result: 'profit'}).length, 0);
  } finally { f.close(); }
});

test('Kesinti KDV durumu beyan edilmemişse oran uydurulmaz; nakit sonuç boş kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f, {feeVat: false});
    const r = await rapor(f);
    const row = r.rows.find(x => x.order_no === 'S1');
    assert.equal(row.cash_cents, null, 'oran bilinmeden nakit hesaplanmadı');
    assert.match(row.cash_note, /beyan edilmedi/);
    assert.equal(r.channels.find(c => c.channel === 'hepsiburada').cash_cents, null);
  } finally { f.close(); }
});

// Rapor Kutusu ile Kâr raporu AYNI rakamı vermeli. İki ekran ayrı kaynaktan beslenir:
// biri pazaryeri raporu, öteki defter. Maliyet defterin işidir — iade dönüşü ve gönderim
// anında dondurulan maliyet ancak orada bilinir — bu yüzden rapor tarafı da defteri okur.
test('Rapor Kutusu, deftere bağlı paketin maliyetini defterden alır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Defterdeki maliyet 46,00 (KDV dahil 55,20). Rapor tarafı sipariş tarihindeki birim
    // maliyeti kullansaydı stok girişindeki 4,60/adet çıkardı — kasıtlı olarak farklı.
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'a'.repeat(64) + "','2026-09-06T10:00','S','[]',1,1,'applied','t')");
    const sip = {order_no: 'S1', package_id: 'P1', barcode: 'U1', quantity: 1, status: 'Teslim edildi',
      order_date: '2026-09-01', delivered_date: '2026-09-05', gross: 13200};
    f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id,components_json) VALUES('rc','st','order_line','L:1','provider',?,'2026-09-06T10:00','fl',1,'pk',?)")
      .run(JSON.stringify(sip), JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]}));

    const {orderResults} = await import('../src/report-inbox-api.js');
    const {results} = await orderResults(scopedDB(f.env.DB, 'ec'), 'st', {});
    const p = results[0];
    assert.equal(p.cogs_cents, 4600, 'maliyet defterden geldi');
    assert.equal(p.cogs_incl_vat_cents, 5520, 'KDV dahil maliyet defterden geldi');
    assert.ok(!(p.notes || []).some(n => /deftere bağlı değil/.test(n)));
  } finally { f.close(); }
});

test('Deftere bağlı olmayan paketin maliyeti rapordan hesaplanır ve bu söylenir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('sm','p1',10000,46000,'opening','A','2026-08-01')");
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'b'.repeat(64) + "','2026-09-06T10:00','S','[]',1,1,'applied','t')");
    const sip = {order_no: 'S9', package_id: 'P9', barcode: 'U1', quantity: 1, status: 'Teslim edildi',
      order_date: '2026-09-01', delivered_date: '2026-09-05', gross: 13200};
    f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,components_json) VALUES('rc','st','order_line','L:9','provider',?,'2026-09-06T10:00','fl',1,?)")
      .run(JSON.stringify(sip), JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]}));

    const {orderResults} = await import('../src/report-inbox-api.js');
    const {results} = await orderResults(scopedDB(f.env.DB, 'ec'), 'st', {});
    const p = results[0];
    assert.equal(p.cogs_cents, 4600, 'stok girişindeki birim maliyet');
    assert.ok((p.notes || []).some(n => /deftere bağlı değil/.test(n)), 'kaynağı söylendi');
  } finally { f.close(); }
});

test('Bölünmüş siparişin stopajı her pakete ayrı ayrı yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Aynı siparişin İKİNCİ paketi. Stopaj sipariş düzeyinde bildirilir: 10,00 TL.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk2','hepsiburada','P2','S1','2026-09-01','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln2','pk2','L2','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('se2','hepsiburada','S-2','p1','sale',1000,11000,4600,1610,8992,1138,'confirmed','2026-09-05')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm2','ln2','p1',1000,10000,'se2','adet')");
    for (const st of ['reserved', 'shipped']) f.sqlite.prepare("UPDATE ec_order_packages SET status=? WHERE id='pk2'").run(st);
    f.sqlite.exec("UPDATE ec_order_packages SET status='delivered',delivered_on='2026-09-05' WHERE id='pk2'");
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','finance','f.xlsx',10,'" + 'c'.repeat(64) + "','2026-09-06T10:00','S','[]',1,1,'applied','t')");
    f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES('w','st','finance_event','W:1','provider',?,'2026-09-06T10:00','fl',1)")
      .run(JSON.stringify({order_no: 'S1', type: 'withholding', amount_cents: -1000}));

    const r = await rapor(f);
    const satirlar = r.rows.filter(x => x.order_no === 'S1');
    assert.equal(satirlar.length, 2);
    // 10,00 TL stopaj iki pakete bölünür: her birine 5,00 TL.
    assert.deepEqual(satirlar.map(x => x.withholding_cents), [-500, -500], 'stopaj iki kez tam düşülmedi');
  } finally { f.close(); }
});

// Kâr yalnız teslim edilmiş pakette hesaplanır. Kargoda duran paket sessizce dışarıda
// kalırsa ekran "0 bilgi bekliyor" der ve kullanıcı toplamın eksik olduğunu göremez.
test('Teslim onayı gelmeyen paket sayısı kanal kartında söylenir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Aynı kanalda kargoda kalmış bir paket: kâra girmez ama sayılıp söylenmeli.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk3','hepsiburada','P3','S3','2026-09-02','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln3','pk3','L3','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('se3','hepsiburada','S-3','p1','sale',1000,11000,4600,'pending','2026-09-02')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm3','ln3','p1',1000,10000,'se3','adet')");
    for (const st of ['reserved', 'shipped']) f.sqlite.prepare("UPDATE ec_order_packages SET status=? WHERE id='pk3'").run(st);

    const hb = (await rapor(f)).channels.find(c => c.channel === 'hepsiburada');
    assert.equal(hb.packages, 1, 'kargodaki paket teslim edilenlere karışmadı');
    assert.equal(hb.awaiting_delivery, 1, 'kaç paketin dışarıda kaldığı söylendi');
    assert.equal(hb.awaiting_delivery_since, '2026-09-02', 'en eskisinin tarihi verildi');
  } finally { f.close(); }
});

// Kâr yalnız teslim edilmiş pakette hesaplanır ve teslim durumu ERP paketinde durur.
// Rapor teslim tarihini getirdiği hâlde paket 'shipped' kalırsa paket sessizce kârın
// dışında kalır. Kullanıcı hiçbir şeyi elle işaretlemez: tarih RAPORDAN alınır.
test('Raporun getirdiği teslim tarihi paketi teslim edildiye geçirir; tarih uydurulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk3','hepsiburada','P3','S3','2026-09-02','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln3','pk3','L3','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('se3','hepsiburada','S-3','p1','sale',1000,11000,4600,'pending','2026-09-02')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm3','ln3','p1',1000,10000,'se3','adet')");
    for (const st of ['reserved', 'shipped']) f.sqlite.prepare("UPDATE ec_order_packages SET status=? WHERE id='pk3'").run(st);

    const KOL = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'},
      {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Teslim Tarihi'}];
    const ESL = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod',
      quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', delivered_date: 'Teslim Tarihi'};
    await f.ok('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'orders', headers: KOL.map(c => c.header), mapping: ESL, options: {}});
    const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns: KOL,
      rows: [['S3', 'P3', 'L3', 'U1', 1, 'Teslim edildi', '02.09.2026', '132,00', '07.09.2026']]}]));
    const table = await readTable(bytes, {name: 'hb-siparis.xlsx'});
    const dosya = await f.ok('/ec/reports/files', {store_id: 'st', kind: 'orders', filename: 'hb-siparis.xlsx',
      size_bytes: bytes.length, sha256: await sha256Hex(bytes), snapshot_at: '2026-09-08T10:00', sheet: table.sheet,
      headers: table.headers, date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    await f.ok('/ec/reports/files/' + dosya.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + dosya.id + '/rows', {rows: table.rows});
    await f.ok('/ec/reports/files/' + dosya.id + '/seal', {});
    let r; do { r = await f.ok('/ec/reports/files/' + dosya.id + '/apply', {}); } while (!r.done);

    const p = f.sqlite.prepare("SELECT status,delivered_on FROM ec_order_packages WHERE id='pk3'").get();
    assert.equal(p.status, 'delivered', 'paket rapordan teslim edildiye geçti');
    assert.equal(p.delivered_on, '2026-09-07', 'tarih rapordaki gün; uydurulmadı');
    assert.equal(r.counts.delivered, 1, 'kaç paketin teslime geçtiği sayıldı');
    // Ve artık kâr raporuna giriyor.
    const hb = (await rapor(f)).channels.find(c => c.channel === 'hepsiburada');
    assert.equal(hb.awaiting_delivery, 0, 'kargoda bekleyen kalmadı');
  } finally { f.close(); }
});

test('Kargoya verilmemiş paket rapordaki teslim tarihiyle teslime geçirilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Paket hâlâ hazırlıkta: raporda teslim tarihi olsa bile durum makinesi zorlanmaz.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk4','hepsiburada','P4','S4','2026-09-02','draft','t')");
    const KOL = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'},
      {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Teslim Tarihi'}];
    const ESL = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod',
      quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', delivered_date: 'Teslim Tarihi'};
    await f.ok('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'orders', headers: KOL.map(c => c.header), mapping: ESL, options: {}});
    const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns: KOL,
      rows: [['S4', 'P4', 'L4', 'U1', 1, 'Teslim edildi', '02.09.2026', '132,00', '07.09.2026']]}]));
    const table = await readTable(bytes, {name: 'hb2.xlsx'});
    const dosya = await f.ok('/ec/reports/files', {store_id: 'st', kind: 'orders', filename: 'hb2.xlsx',
      size_bytes: bytes.length, sha256: await sha256Hex(bytes), snapshot_at: '2026-09-08T10:00', sheet: table.sheet,
      headers: table.headers, date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    await f.ok('/ec/reports/files/' + dosya.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + dosya.id + '/rows', {rows: table.rows});
    await f.ok('/ec/reports/files/' + dosya.id + '/seal', {});
    let r; do { r = await f.ok('/ec/reports/files/' + dosya.id + '/apply', {}); } while (!r.done);

    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='pk4'").get().status, 'draft',
      'hazırlıktaki paket atlanmadan teslime çekilmedi');
    assert.ok(r.counts.new >= 1, 'yükleme yine de tamamlandı, parti düşmedi');
  } finally { f.close(); }
});
