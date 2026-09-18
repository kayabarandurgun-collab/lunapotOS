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

// İçe aktarımda kurulup sevk edilmeden iptal edilen ve yerine yenisi kurulan taslaklar da
// 'cancelled' görünür. Bunlar satış kaybı DEĞİLDİR; gerçek iptalle aynı sayıda gösterilirse
// kullanıcı olmayan bir zarar arar. Ayrımın ölçütü kayıtların kendisidir, tahmin değil.
test('Yerine yenisi kurulan aktarım taslağı listede ve sayılarda görünmez; gerçek iptal görünür', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // A: içe aktarım taslağı — sevk edilmedi, satış kaydı yok, yerine 'pk' duruyor (aynı sipariş no).
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint,cancel_reason) VALUES('eski','hepsiburada','P1-ESKI','S1','2026-09-01','draft','t','')");
    f.sqlite.exec("UPDATE ec_order_packages SET status='cancelled',cancel_reason='Köprü taslağı KDV taşımıyor' WHERE id='eski'");
    // B: gerçek iptal — yerine kurulmuş başka paket YOK.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('gercek','hepsiburada','P9','S9','2026-09-03','draft','t')");
    f.sqlite.exec("UPDATE ec_order_packages SET status='cancelled',cancel_reason='Müşteri vazgeçti' WHERE id='gercek'");

    const d = await f.ok('/ec/orders');
    const c = d.counts.find(x => x.status === 'cancelled');
    assert.equal(c.count, 1, 'yalnız gerçek iptal sayıldı');
    const ids = d.packages.map(p => p.id);
    assert.ok(ids.includes('gercek'), 'gerçek iptal listede');
    assert.ok(!ids.includes('eski'), 'aktarım artığı listede değil');
    assert.ok(ids.includes('pk'), 'siparişin gerçek kaydı listede');
  } finally { f.close(); }
});

// Sipariş listesindeki sonuç sütunu, kâr raporuyla AYNI rakamı vermeli. Önceden KDV hariç
// katkı ekranda 1,2 ile çarpılıyordu: bu nakit değildir, çünkü kesintilerin KDV'si indirilebilir.
test('Sipariş listesindeki sonuç, kâr raporundaki nakitle aynı', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    const liste = await f.ok('/ec/orders');
    const p = liste.packages.find(x => x.id === 'pk');
    const kanal = (await rapor(f)).rows.find(r => r.id === 'pk');
    assert.ok(Number.isSafeInteger(p.cash_result_cents), 'listede nakit sonuç var');
    assert.equal(p.cash_result_cents, kanal.cash_cents, 'iki ekran kuruşu kuruşuna aynı');
    assert.equal(p.result_cents, kanal.profit_cents, 'KDV hariç katkı da aynı');
    // Nakit, kalemlerin KDV DAHİL hâlinden kurulur; katkının kaba 1,2 katı değildir.
    assert.equal(p.cash_result_cents,
      kanal.revenue_gross_cents - kanal.cost_gross_cents - kanal.commission_gross_cents
      - kanal.shipping_gross_cents - kanal.other_gross_cents,
      'nakit sonuç kalemlerin KDV dahil toplamıyla tutuyor');
  } finally { f.close(); }
});

// Pazaryeri raporu pakette 2 satır görürken defterde 1 satır varsa, o paketin BÜTÜN
// kesintileri eksik ciroya yüklenir ve kârlı sipariş zararlı görünür. Canlıda iki paket
// bu durumdaydı (11584479206 ve 11556015519). Sessizce yanlış rakam verilmemeli.
test('Defter paketin bir satırını tutmuyorsa kâr hesaplanmaz, sebebi yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'd'.repeat(64) + "','2026-09-06T10:00','S','[]',2,1,'applied','t')");
    const satir = (i, brut) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id) VALUES(?,'st','order_line',?,'provider',?,'2026-09-06T10:00','fl',?,'pk')")
      .run('r' + i, 'L:' + i, JSON.stringify({order_no: 'S1', package_id: 'P1', barcode: 'U1', quantity: 1,
        status: 'Teslim edildi', order_date: '2026-09-01', delivered_date: '2026-09-05', gross: brut}), i);

    // Önce defterle aynı: tek satır → kâr hesaplanır.
    satir(1, 13200);
    let r = (await rapor(f)).rows.find(x => x.id === 'pk');
    assert.ok(Number.isSafeInteger(r.cash_cents), 'tek satırken hesaplandı');

    // Raporda ikinci satır belirdi ama deftere işlenmedi → kâr artık verilmez.
    satir(2, 22139);
    r = (await rapor(f)).rows.find(x => x.id === 'pk');
    assert.equal(r.profit_cents, null, 'eksik ciroyla kâr hesaplanmadı');
    assert.equal(r.cash_cents, null, 'nakit de verilmedi');
    assert.ok(r.missing.some(n => /2 satır gösteriyor, defterde 1 satır/.test(n)), 'sebebi tek tek yazıldı');
  } finally { f.close(); }
});

test('Defter boşluğu ucu, eksik satırı barkoduyla söyler ve hiçbir şey yazmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    const once = ['ec_stock_movements', 'ec_sale_entries', 'ec_order_lines']
      .map(t => f.sqlite.prepare('SELECT COUNT(*) n FROM ' + t).get().n);
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'e'.repeat(64) + "','2026-09-06T10:00','S','[]',2,1,'applied','t')");
    const satir = (i, barkod, brut) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id) VALUES(?,'st','order_line',?,'provider',?,'2026-09-06T10:00','fl',?,'pk')")
      .run('r' + i, 'L:' + i, JSON.stringify({order_no: 'S1', package_id: 'P1', barcode: barkod, product_name: 'Eksik Ürün',
        quantity: 1, status: 'Teslim edildi', order_date: '2026-09-01', delivered_date: '2026-09-05', gross: brut}), i);
    satir(1, 'U1', 13200);      // defterdeki satır (ln → sku U1 değil; external_id L1)
    satir(2, 'EKSIK-1', 22139); // defterde karşılığı olmayan satır

    const r = await f.ok('/ec/reports/ledger-gaps?store_id=st');
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0].order_no, 'S1');
    assert.equal(r.gaps[0].report_lines, 2);
    assert.equal(r.gaps[0].ledger_lines, 1);
    assert.ok(r.gaps[0].missing_lines.some(l => l.barcode === 'EKSIK-1'), 'eksik satır barkoduyla verildi');
    assert.deepEqual(['ec_stock_movements', 'ec_sale_entries', 'ec_order_lines']
      .map(t => f.sqlite.prepare('SELECT COUNT(*) n FROM ' + t).get().n), once, 'uç hiçbir şey yazmadı');
  } finally { f.close(); }
});

// Teslim tarihi ÖNCEKİ bir yüklemede gelmişse kayıt "aynı" sayılır. Yalnızca değişen
// kayıtlara bakan bir çözüm, o paketi sonsuza kadar kargoda bırakır ve kârın dışında tutar.
// Canlıda tam olarak bu oldu: 7 paket raporda "Teslim Edildi" iken defterde kargoda kaldı.
test('Teslim tarihi eski yüklemeden gelse bile paket teslime geçer; ikinci kez işlem kaydı düşmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk3','hepsiburada','P3','S3','2026-09-02','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln3','pk3','L3','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('se3','hepsiburada','S-3','p1','sale',1000,11000,4600,'pending','2026-09-02')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm3','ln3','p1',1000,10000,'se3','adet')");

    const KOL = [{header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'},
      {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Teslim Tarihi'}, {header: 'Kaynak'}];
    const ESL = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod',
      quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', delivered_date: 'Teslim Tarihi'};
    await f.ok('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'orders', headers: KOL.map(c => c.header), mapping: ESL, options: {}});
    // Her yükleme gerçek hayattaki gibi AYRI bir dosya: eşlenmemiş "Kaynak" sütunu değişir,
    // eşlenen alanlar aynı kalır. Böylece kaydın kendisi "aynı" (same) sayılır.
    const yukle = async (ad, zaman) => {
      const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns: KOL,
        rows: [['S3', 'P3', 'L3', 'U1', 1, 'Teslim edildi', '02.09.2026', '132,00', '07.09.2026', ad]]}]));
      const t = await readTable(bytes, {name: ad});
      const d = await f.ok('/ec/reports/files', {store_id: 'st', kind: 'orders', filename: ad, size_bytes: bytes.length,
        sha256: await sha256Hex(bytes), snapshot_at: zaman, sheet: t.sheet, headers: t.headers, date1904: t.date1904,
        row_count: t.rows.length, chunk_count: 1, warnings: t.warnings});
      if (d.duplicate) return d;
      await f.ok('/ec/reports/files/' + d.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
      await f.ok('/ec/reports/files/' + d.id + '/rows', {rows: t.rows});
      await f.ok('/ec/reports/files/' + d.id + '/seal', {});
      let r; do { r = await f.ok('/ec/reports/files/' + d.id + '/apply', {}); } while (!r.done);
      return r;
    };

    // Birinci yükleme: paket henüz kargoya verilmedi (draft) → teslime çekilmez.
    await yukle('ilk.xlsx', '2026-09-08T10:00');
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='pk3'").get().status, 'draft');

    // Paket kargoya verildi. İkinci raporda satır AYNI (outcome 'same') ama paket artık kargoda.
    for (const st of ['reserved', 'shipped']) f.sqlite.prepare("UPDATE ec_order_packages SET status=? WHERE id='pk3'").run(st);
    const ikinci = await yukle('ikinci.xlsx', '2026-09-09T10:00');
    assert.equal(ikinci.counts.same, 1, 'satır değişmedi, yine de işlendi');
    const p = f.sqlite.prepare("SELECT status,delivered_on FROM ec_order_packages WHERE id='pk3'").get();
    assert.equal(p.status, 'delivered', 'değişmeyen kayıttan da teslim onayı alındı');
    assert.equal(p.delivered_on, '2026-09-07');

    // Üçüncü yükleme: paket zaten teslim edildi → ikinci kez işlem kaydı düşmez.
    const once = f.sqlite.prepare("SELECT COUNT(*) n FROM ec_activity WHERE description LIKE 'Teslim onayı rapordan%'").get().n;
    await yukle('ucuncu.xlsx', '2026-09-10T10:00');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_activity WHERE description LIKE 'Teslim onayı rapordan%'").get().n, once,
      'aynı pakete tekrar tekrar kayıt düşmedi');
  } finally { f.close(); }
});

test('Geçmişe dönük teslim onayı: önizleme yazmaz, onay yalnız kargodakini kapatır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + 'f'.repeat(64) + "','2026-09-06T10:00','S','[]',2,1,'applied','t')");
    const kayit = (i, pid, teslim) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id) VALUES(?,'st','order_line',?,'provider',?,'2026-09-06T10:00','fl',?,?)")
      .run('r' + i, 'L:' + i, JSON.stringify({order_no: 'S' + i, package_id: 'P' + i, barcode: 'U1', quantity: 1,
        status: 'Teslim Edildi', order_date: '2026-09-01', delivered_date: teslim, gross: 13200}), i, pid);
    // A: kargoda kalmış paket, raporda teslim tarihi var.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('kargoda','trendyol','P7','S7','2026-09-02','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln7','kargoda','L7','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('se7','trendyol','S-7','p1','sale',1000,11000,4600,'pending','2026-09-02')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm7','ln7','p1',1000,10000,'se7','adet')");
    for (const st of ['reserved', 'shipped']) f.sqlite.prepare("UPDATE ec_order_packages SET status=? WHERE id='kargoda'").run(st);
    kayit(7, 'kargoda', '2026-09-07T13:24');
    // B: hazırlıktaki paket — teslim tarihi olsa bile dokunulmaz.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('taslak','trendyol','P8','S8','2026-09-02','draft','t')");
    kayit(8, 'taslak', '2026-09-07');

    const onizleme = await f.ok('/ec/reports/sync-deliveries');
    assert.equal(onizleme.count, 1, 'yalnızca kargodaki paket listelendi');
    assert.equal(onizleme.commit, false);
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='kargoda'").get().status, 'shipped',
      'önizleme hiçbir şey yazmadı');

    const sonuc = await f.ok('/ec/reports/sync-deliveries', {confirm: true});
    assert.equal(sonuc.count, 1);
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='kargoda'").get().status, 'delivered');
    assert.equal(f.sqlite.prepare("SELECT delivered_on FROM ec_order_packages WHERE id='kargoda'").get().delivered_on, '2026-09-07',
      'tarih rapordaki gün; uydurulmadı');
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='taslak'").get().status, 'draft',
      'kargoya verilmemiş paket teslime çekilmedi');
  } finally { f.close(); }
});

// Finans dosyası yüklemek tek başına kâr rakamlarını değiştirmez: kesintilerin satış
// kayıtlarına aktarılması ayrı bir adımdır. Kullanıcı bunu bilmiyorsa yüklediği raporun
// etkisini göremez ve hesapların tutmadığını sanır. Sayı yükleme sonucunda dönmeli.
test('Yükleme sonucu kaç kesinti kaydı geldiğini söyler', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    const KOL = [{header: 'Sipariş No'}, {header: 'İşlem Tipi'}, {header: 'Tutar'}];
    const ESL = {order_no: 'Sipariş No', event_type: 'İşlem Tipi', amount: 'Tutar'};
    await f.ok('/ec/reports/profiles', {provider: 'hepsiburada', kind: 'finance', headers: KOL.map(c => c.header),
      mapping: ESL, options: {type_map: {Komisyon: 'commission', Kargo: 'cargo'}, fee_amounts_include_vat: false, undated: true}});
    const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns: KOL, rows: [['S1', 'Komisyon', '-48,00'], ['S1', 'Kargo', '-30,00']]}]));
    const t = await readTable(bytes, {name: 'fin.xlsx'});
    const d = await f.ok('/ec/reports/files', {store_id: 'st', kind: 'finance', filename: 'fin.xlsx', size_bytes: bytes.length,
      sha256: await sha256Hex(bytes), snapshot_at: '2026-09-08T10:00', sheet: t.sheet, headers: t.headers,
      date1904: t.date1904, row_count: t.rows.length, chunk_count: 1, warnings: t.warnings});
    await f.ok('/ec/reports/files/' + d.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + d.id + '/rows', {rows: t.rows});
    await f.ok('/ec/reports/files/' + d.id + '/seal', {});
    let r; do { r = await f.ok('/ec/reports/files/' + d.id + '/apply', {}); } while (!r.done);
    assert.equal(r.counts.fee_events, 2, 'gelen kesinti kaydı sayısı bildirildi');
  } finally { f.close(); }
});

// Kilitli kayıtta (sevk edilmiş pakete bağlı) değişiklik incelemeye gider: para alanları
// deftere işlenmiştir. Ama teslim süreci ilerledikçe DURUM doğal olarak değişir; her teslimat
// için kullanıcıya iş çıkarmamalı. Canlıda 2 kayıt boşuna incelemeye düşmüştü.
test('Kilitli kayıtta durum ilerlemesi incelemeye düşmez; para değişirse düşer', async () => {
  const {compareVersions} = await import('../public/report-core.js');
  const eski = {order_no: 'S1', package_id: 'P1', barcode: 'U1', quantity: 1, gross: 13200, status: 'Kargoda'};
  const kilitli = t => ({data: eski, dataTime: t, observedTime: t, locked: true});

  // Yalnız durum ve teslim tarihi ilerledi → güncellenir, incelemeye gitmez.
  const ilerleme = compareVersions(kilitli('2026-09-08T10:00'),
    {data: {...eski, status: 'Teslim edildi', delivered_date: '2026-09-09'}, time: '2026-09-10T10:00'});
  assert.equal(ilerleme.outcome, 'updated');
  assert.equal(ilerleme.data.status, 'Teslim edildi');

  // Tutar değişti → insan bakmalı.
  const paraDegisti = compareVersions(kilitli('2026-09-08T10:00'),
    {data: {...eski, gross: 14000}, time: '2026-09-10T10:00'});
  assert.equal(paraDegisti.outcome, 'review', 'para alanı değişince incelemeye gider');

  // Adet değişti → insan bakmalı.
  assert.equal(compareVersions(kilitli('2026-09-08T10:00'),
    {data: {...eski, quantity: 2}, time: '2026-09-10T10:00'}).outcome, 'review');

  // Aynı anda gelen çelişki, para değişmese de incelemeye gider (hangisi yeni belli değil).
  assert.equal(compareVersions(kilitli('2026-09-08T10:00'),
    {data: {...eski, status: 'Teslim edildi'}, time: '2026-09-08T10:00'}).outcome, 'review');
});

// Bir pazaryeri paketinin satırları defterde farklı siparişlere düşmüş olabilir (paketin bir
// kalemi eksik kaldığı için ayrı kayıt açıldığında). Sipariş düzeyindeki kesinti o zaman İKİ
// deftere de tam yazılırsa iki kat sayılır. Canlıda 11584479206'da tam olarak bu oldu.
test('Pazaryeri paketi defterde ikiye ayrıldıysa kesinti bölünür, iki kez yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // İkinci ERP paketi: aynı pazaryeri paketinin öteki kalemi.
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk2','hepsiburada','P1-EK','S1','2026-09-01','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln2','pk2','L2','Ürün',1000,11000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('se2','hepsiburada','S-2','p1','sale',1000,11000,4600,'pending','2026-09-01')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm2','ln2','p1',1000,10000,'se2','adet')");

    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('fl','st','orders','r.xlsx',10,'" + '9'.repeat(64) + "','2026-09-06T10:00','S','[]',2,1,'applied','t')");
    // AYNI pazaryeri paketi (P1), iki satır, iki AYRI defter paketi.
    const satir = (i, erp) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id) VALUES(?,'st','order_line',?,'provider',?,'2026-09-06T10:00','fl',?,?)")
      .run('r' + i, 'L:' + i, JSON.stringify({order_no: 'S1', package_id: 'P1', barcode: 'U1', quantity: 1,
        status: 'Teslim edildi', order_date: '2026-09-01', delivered_date: '2026-09-05', gross: 13200}), i, erp);
    satir(1, 'pk'); satir(2, 'pk2');
    // Sipariş düzeyinde tek komisyon: 40,00 TL.
    f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES('fe','st','finance_event','C:1','provider',?,'2026-09-06T10:00','fl',9)")
      .run(JSON.stringify({order_no: 'S1', type: 'commission', amount_cents: -4000}));

    const {orderResults} = await import('../src/report-inbox-api.js');
    const {results} = await orderResults(scopedDB(f.env.DB, 'ec'), 'st', {});
    assert.equal(results.length, 2, 'iki ayrı sonuç satırı');
    const komisyonlar = results.map(r => r.fees.filter(x => x.type === 'commission').reduce((t, x) => t + x.actual_cents, 0));
    assert.equal(komisyonlar.reduce((a, b) => a + b, 0), -4000, 'komisyon toplamı korundu, iki kez sayılmadı');
    assert.ok(komisyonlar.every(k => k < 0 && k > -4000), 'iki pakete bölündü: ' + komisyonlar.join(' / '));
  } finally { f.close(); }
});

// Alış kaydı olmayan bir maldan satış yapılınca (stok eksiye düştüğü için) birim maliyet 0
// çıkar. Bedava mal diye hesaba katmak kârı şişirir. Canlıda 11556015519 tam olarak böyleydi:
// iki paket de +1.781,24 kâr gösteriyordu, ürün maliyeti 0 sayılmıştı.
test('Alış kaydı olmayan malın maliyeti sıfır sayılmaz; kâr hesaplanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Maliyeti bilinmeyen satış: alış kaydı yok, cost_cents 0.
    f.sqlite.prepare("UPDATE ec_sale_entries SET cost_cents=0 WHERE id='se'").run();
    const r = (await rapor(f)).rows.find(x => x.id === 'pk');
    assert.equal(r.profit_cents, null, 'kâr hesaplanmadı');
    assert.equal(r.cash_cents, null, 'nakit de verilmedi');
    assert.ok(r.missing.some(n => /alış kaydı yok/.test(n)), 'sebebi yazıldı');

    // Alış girilince kendiliğinden düzelir.
    f.sqlite.prepare("UPDATE ec_sale_entries SET cost_cents=4600 WHERE id='se'").run();
    const d = (await rapor(f)).rows.find(x => x.id === 'pk');
    assert.ok(Number.isSafeInteger(d.cash_cents), 'maliyet gelince hesaplandı');
  } finally { f.close(); }
});

test('Sipariş listesi kâr edenler / zarar edenler diye süzülür; kesintisi olmayan ikisine de girmez; kanalla birlikte çalışır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);   // pk: HB, nakit −64,08 (zarar)
    // pk2: HB, aynı kesintilerle yüksek satış → kâr
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk2','hepsiburada','P2','S2','2026-09-02','draft','t')");
    f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln2','pk2','L2','Ürün',1000,50000)");
    f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('se2','hepsiburada','S-2','p1','sale',1000,50000,4600,1610,8992,1138,'confirmed','2026-09-05')");
    f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm2','ln2','p1',1000,10000,'se2','adet')");
    // pk3: HB, satışı yok (kesinti bekliyor)
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk3','hepsiburada','P3','S3','2026-09-03','draft','t')");
    const liste = async q => { const d = await f.ok('/ec/orders?' + q); return {no: d.packages.map(p => p.order_no), toplam: d.pagination.total}; };
    assert.deepEqual(await liste('sonuc=kar'), {no: ['S2'], toplam: 1});
    assert.deepEqual(await liste('sonuc=zarar'), {no: ['S1'], toplam: 1});
    assert.deepEqual(await liste('sonuc=zarar&channel=hepsiburada'), {no: ['S1'], toplam: 1});
    assert.deepEqual(await liste('sonuc=kar&channel=trendyol'), {no: [], toplam: 0});
    assert.equal((await liste('')).toplam, 3, 'süzgeçsiz hepsi');
    // Düğme sayıları diğer filtrelere göre, kâr/zarar seçiminden bağımsız.
    assert.deepEqual((await f.ok('/ec/orders?sonuc=zarar')).sonuc_counts, {hepsi: 3, kar: 1, zarar: 1});
    assert.deepEqual((await f.ok('/ec/orders?channel=trendyol')).sonuc_counts, {hepsi: 0, kar: 0, zarar: 0});
    assert.deepEqual((await f.ok('/ec/orders?status=draft')).sonuc_counts, {hepsi: 2, kar: 1, zarar: 0}, 'durum süzgecine göre (S2 ve S3 hazırlıkta)');
    assert.equal((await f.req('/ec/orders?sonuc=belki')).status, 400);
  } finally { f.close(); }
});

test('İade edilen sipariş listede iade durumunu taşır (tam / kısmi)', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);   // pk: 1 adet satış
    const once = (await f.ok('/ec/orders')).packages.find(p => p.id === 'pk');
    assert.equal(once.return_status, null, 'iade yokken rozet yok');
    await f.ok('/ec/sales/se/return', {external_id: 'IADE-S1', quantity: 1, revenue: 110, restock: true, occurred_on: '2026-09-06'});
    const sonra = (await f.ok('/ec/orders')).packages.find(p => p.id === 'pk');
    assert.equal(sonra.return_status, 'tam');
  } finally { f.close(); }
});

// HB bazı ilanlarda satır KDV'sini %10 yazıyor, ürün profili %20. KDV hariç satış satırın oranıyla
// çıkarılmışsa KDV dahile de AYNI oranla dönülmeli; yoksa satış olduğundan yüksek görünür
// (canlıda HB 4215556069: 240 TL satış 261,82 TL sayılıyordu).
test('Cebine kalan: satış, satırın kendi KDV oranıyla geri çevrilir; üç ekran aynı', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("DROP TRIGGER IF EXISTS ec_order_line_lock");   // teslim edilmiş satır kilitli; test verisi için
    f.sqlite.exec("UPDATE ec_order_lines SET vat_bps=1000 WHERE id='ln'");
    const beklenen = 12100 - 5520 - 1932 - 10790 - 1366;   // satış 110 × 1,10; maliyet 46 × 1,20
    const liste = (await f.ok('/ec/orders')).packages.find(p => p.id === 'pk').cash_result_cents;
    const ozet = (await f.ok('/ec/orders/pk/insights')).cash_cents;
    const r = await rapor(f);
    const satir = r.rows.find(x => x.order_no === 'S1');
    assert.equal(liste, beklenen, 'liste');
    assert.equal(ozet, beklenen, 'sipariş penceresi');
    assert.equal(satir.cash_cents, beklenen, 'kâr raporu');
    assert.equal(satir.revenue_gross_cents, 12100, 'satış KDV dahil = müşterinin ödediği');
  } finally { f.close(); }
});
