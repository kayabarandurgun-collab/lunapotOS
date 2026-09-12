import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';
import {parseMoney, parseDate, allocateCents, headerSignature} from '../public/report-core.js';

// TEMSİLİ test verisi: gerçek Trendyol/Hepsiburada sütun adları DEĞİLDİR. Sütunları kullanıcı eşler.
const ORDER_COLUMNS = [
  {header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Kargo'}
];
const ORDER_MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo'};
const FIN_COLUMNS = [{header: 'İşlem No'}, {header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Barkod'}, {header: 'İşlem Tipi'}, {header: 'Tarih'}, {header: 'Tutar'}];
const FIN_MAPPING = {event_id: 'İşlem No', order_no: 'Sipariş No', package_id: 'Paket No', barcode: 'Barkod', event_type: 'İşlem Tipi', event_date: 'Tarih', amount: 'Tutar'};
const line = (order, pkg, lineId, barcode, qty, status, gross, cargo = '50,00') => [order, pkg, lineId, barcode, 'Ürün ' + barcode, qty, status, '01.09.2026', gross, cargo];

function seed(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('nova','Nova','NV','adet'),('luna','Luna','LN','adet'),('yeni','Maliyetsiz','YN','adet')");
  // Birim maliyet: Nova 100 TL, Luna 150 TL (açılış girişi sipariş tarihinden önce).
  f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('o1','nova',10000,100000,'opening','A1','2026-08-01'),('o2','luna',10000,150000,'opening','A2','2026-08-01')");
  for (const p of ['nova', 'luna', 'yeni']) f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,2000,0,0,0,0,100,100,100,500,1)").run(p);
  // Set içeriği yalnızca eşleme etkinleşmeden yazılabilir (katalog koruması); sonra etkinleştirilir.
  f.sqlite.exec(`INSERT INTO ec_catalog_mappings(id,source,match_by,match_value,external_code,active,version,created_at) VALUES
    ('m-set','trendyol','code','SET-NL','SET-NL',0,1,'2026-01-01 00:00:00'),('m-nova','trendyol','code','NOVA-1','NOVA-1',0,1,'2026-01-01 00:00:00'),('m-yeni','trendyol','code','YENI-1','YENI-1',0,1,'2026-01-01 00:00:00')`);
  f.sqlite.exec(`INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES
    ('c1','m-set','nova',1000,5000),('c2','m-set','luna',1000,5000),('c3','m-nova','nova',1000,10000),('c4','m-yeni','yeni',1000,10000)`);
  f.sqlite.exec("UPDATE ec_catalog_mappings SET active=1 WHERE id IN ('m-set','m-nova','m-yeni')");
}
const counts = f => ({stock: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_movements').get().n, sales: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_sale_entries').get().n, packages: f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n});

async function fixture() {
  const f = appFixture(); await f.setup(); seed(f);
  const store = async (provider = 'trendyol', code = 'TY-1') => (await f.ok('/ec/reports/stores', {provider, code, name: 'Mağaza ' + code})).id;
  const profile = (kind, columns, mapping, options = {}, provider = 'trendyol') => f.ok('/ec/reports/profiles', {provider, kind, headers: columns.map(c => c.header), mapping, options});
  async function upload(storeId, kind, columns, rows, snapshot, name = 'rapor.xlsx') {
    const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns, rows}]));
    const table = await readTable(bytes, {name});
    const created = await f.ok('/ec/reports/files', {store_id: storeId, kind, filename: name, size_bytes: bytes.length, sha256: await sha256Hex(bytes), snapshot_at: snapshot,
      sheet: table.sheet, headers: table.headers, date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    if (created.duplicate) return created;
    await f.ok('/ec/reports/files/' + created.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    for (let i = 0; i < table.rows.length; i += 500) await f.ok('/ec/reports/files/' + created.id + '/rows', {rows: table.rows.slice(i, i + 500)});
    await f.ok('/ec/reports/files/' + created.id + '/seal', {});
    return created;
  }
  async function applyAll(fileId) { let r; do { r = await f.ok('/ec/reports/files/' + fileId + '/apply', {}); } while (!r.done); return r; }
  const record = (storeId, key) => { const r = f.sqlite.prepare("SELECT data_json,version FROM ec_report_records WHERE store_id=? AND record_key=?").get(storeId, key); return r ? {...JSON.parse(r.data_json), _v: r.version} : null; };
  return {f, store, profile, upload, applyAll, record};
}

test('Okuyucu gerçek .xlsx ve Türkçe CSV okur; uzun kimlik metin kalır; .xls ve HTML reddedilir', async () => {
  const bytes = new Uint8Array(xlsxBytes([{name: 'R', columns: [{header: 'Kimlik'}, {header: 'Adet', type: 'number'}], rows: [['100000000000000123', 3], ['Toplam', 3]]}]));
  const t = await readTable(bytes, {name: 'a.xlsx'});
  assert.deepEqual(t.headers, ['Kimlik', 'Adet']);
  assert.deepEqual(t.rows[0].cells.map(c => [c.v, c.t]), [['100000000000000123', 's'], ['3', 'n']]);
  const csv = await readTable(new TextEncoder().encode('Sipariş No;Tutar\n"A-1";1.234,56\nA-2;(10,00)\n'), {name: 'a.csv'});
  assert.deepEqual(csv.rows.map(r => parseMoney(r.cells[1]).value), [123456, -1000]);
  await assert.rejects(readTable(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), {name: 'eski.xls'}), /\.xls/);
  await assert.rejects(readTable(new TextEncoder().encode('<!doctype html><html>Giriş</html>'), {name: 'rapor.xlsx'}), /web sayfası/);
});

test('Tutar, tarih ve kuruş dağıtımı güvenli; sayı olarak bozulmuş kimlik onarılmaz', () => {
  assert.equal(parseMoney({v: '1.234,5', t: 's'}).value, 123450);
  assert.equal(parseMoney({v: '12.5', t: 'n'}).value, 1250);
  assert.match(parseMoney({v: '1,2345', t: 's'}).error, /kuruştan küçük/);
  assert.equal(parseMoney({v: '', t: 's'}).missing, true, 'boş tutar sıfır değildir');
  assert.equal(parseDate({v: '11.09.2026 14:05', t: 's'}).value, '2026-09-11T14:05');
  assert.equal(parseDate({v: '46276', t: 'n'}).value, '2026-09-11');
  assert.deepEqual(allocateCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateCents(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.equal(headerSignature(['B', ' a ']), headerSignature(['a', 'B']));
});

test('Tarihî aktarım stok, satış ve paket oluşturmaz; aynı dosya ikinci kez işlenmez', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const before = counts(f);
    const rows = [line('1001', 'P1', 'L1', 'SET-NL', 2, 'Kargoda', '600,00'), line('1002', 'P2', 'L2', 'NOVA-1', 1, 'Kargoda', '240,00', '40,00')];
    const file = await upload(s, 'orders', ORDER_COLUMNS, rows, '2026-09-01T10:00');
    const preview = await f.ok('/ec/reports/files/' + file.id + '/preview');
    assert.equal(preview.counts.new, 2);
    const done = await applyAll(file.id);
    assert.equal(done.counts.new, 2);
    assert.deepEqual(counts(f), before, 'stok hareketi, satış kaydı ve paket oluşmadı');
    const again = await upload(s, 'orders', ORDER_COLUMNS, rows, '2026-09-01T10:00');
    assert.equal(again.duplicate, true);
  } finally { f.close(); }
});

test('Örtüşen yeni rapor günceller, eski rapor geri almaz, aynı zamanlı çelişki incelemeye gider, eksik satır silinmez, mağazalar ayrı', async () => {
  const {f, store, profile, upload, applyAll, record} = await fixture(); try {
    const a = await store('trendyol', 'TY-A'), b = await store('trendyol', 'TY-B');
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(a, 'orders', ORDER_COLUMNS, [line('1001', 'P1', 'L1', 'SET-NL', 2, 'Kargoda', '600,00'), line('1002', 'P2', 'L2', 'NOVA-1', 1, 'Kargoda', '240,00')], '2026-09-01T10:00')).id);
    // Yeni rapor: L1 teslim edildi, L3 yeni; L2 bu dosyada yok.
    const overlap = await applyAll((await upload(a, 'orders', ORDER_COLUMNS, [line('1001', 'P1', 'L1', 'SET-NL', 2, 'Teslim edildi', '600,00'), line('1003', 'P3', 'L3', 'NOVA-1', 1, 'Yeni', '240,00')], '2026-09-02T10:00', 'b.xlsx')).id);
    assert.deepEqual([overlap.counts.updated, overlap.counts.new], [1, 1]);
    assert.equal(record(a, 'L:L1').status, 'Teslim edildi');
    assert.equal(record(a, 'L:L1')._v, 2);
    assert.ok(record(a, 'L:L2'), 'yeni dosyada olmayan kayıt silinmez');
    // Eski rapor (31 Ağustos) güncel durumu geri almaz.
    const older = await applyAll((await upload(a, 'orders', ORDER_COLUMNS, [line('1001', 'P1', 'L1', 'SET-NL', 2, 'Hazırlanıyor', '600,00')], '2026-08-31T10:00', 'c.xlsx')).id);
    assert.equal(older.counts.older, 1);
    assert.equal(record(a, 'L:L1').status, 'Teslim edildi');
    // Aynı anlık görüntü zamanı + farklı içerik: hangisi yeni belli değil → inceleme.
    const conflict = await applyAll((await upload(a, 'orders', ORDER_COLUMNS, [line('1001', 'P1', 'L1', 'SET-NL', 2, 'İptal', '600,00')], '2026-09-02T10:00', 'd.xlsx')).id);
    assert.equal(conflict.counts.review, 1);
    assert.equal(record(a, 'L:L1').status, 'Teslim edildi');
    // Başka mağazada aynı kalem kimliği ayrı kayıttır.
    const other = await applyAll((await upload(b, 'orders', ORDER_COLUMNS, [line('1001', 'P1', 'L1', 'SET-NL', 2, 'Kargoda', '600,00')], '2026-09-01T10:00', 'e.xlsx')).id);
    assert.equal(other.counts.new, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE record_key='L:L1'").get().n, 2);
    // İnceleme kabul edilince yeni sürüm olur.
    const review = (await f.ok('/ec/reports/reviews')).reviews.find(r => r.reason === 'same_time_conflict');
    await f.ok('/ec/reports/reviews/' + review.id, {decision: 'accept'});
    assert.equal(record(a, 'L:L1').status, 'İptal');
  } finally { f.close(); }
});

test('İki adet ikili set dört ürün maliyeti oluşturur; paket kargosu bir kez; eksik maliyet sıfır sayılmaz', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    // P1 paketinde iki satır: aynı paket kargosu her satırda tekrar yazılmış.
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [
      line('1001', 'P1', 'L1', 'SET-NL', 2, 'Teslim edildi', '600,00', '50,00'),
      line('1001', 'P1', 'L1b', 'NOVA-1', 1, 'Teslim edildi', '240,00', '50,00'),
      line('1009', 'P9', 'L9', 'YENI-1', 1, 'Teslim edildi', '120,00', '30,00')], '2026-09-01T10:00')).id);
    const {results} = await f.ok('/ec/reports/orders?store_id=' + s);
    const p1 = results.find(r => r.group === 'P1');
    assert.equal(p1.cogs_cents, 2 * (10000 + 15000) + 10000, '2 set = 2 Nova + 2 Luna; + 1 Nova');
    assert.equal(p1.net_sales_ex_vat_cents, 50000 + 20000);
    assert.deepEqual(p1.fees.map(x => [x.type, x.actual_cents]), [['cargo', -5000]], 'kargo satır sayısı kadar çoğalmaz');
    assert.equal(p1.bank_verified_cents, null, 'banka doğrulaması uydurulmaz');
    const p9 = results.find(r => r.group === 'P9');
    assert.equal(p9.contribution_cents, null);
    assert.ok(p9.contribution_missing.some(m => /Maliyet yok: yeni/.test(m)));
  } finally { f.close(); }
});

test('Kimliksiz iki eşit kısmi iade birleştirilmez; kimlikli iadeler ayrı; tanımsız tür işlemi durdurur', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    const noId = FIN_COLUMNS.filter(c => c.header !== 'İşlem No'), {event_id, ...noIdMapping} = FIN_MAPPING;
    await profile('finance', noId, noIdMapping, {type_map: {'Satış': 'sale', 'İade': 'refund', 'Komisyon': 'commission'}});
    const twin = ['1001', 'P1', 'SET-NL', 'İade', '05.09.2026', '-100,00'];
    const r1 = await applyAll((await upload(s, 'finance', noId, [twin, [...twin], ['1001', 'P1', 'SET-NL', 'Satış', '05.09.2026', '600,00']], '2026-09-06T10:00')).id);
    assert.deepEqual([r1.counts.review, r1.counts.new], [2, 1], 'eşit iki iade incelemeye, silinmez/birleşmez');
    for (const r of (await f.ok('/ec/reports/reviews')).reviews) await f.ok('/ec/reports/reviews/' + r.id, {decision: 'accept'});
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_records WHERE kind='finance_event' AND json_extract(data_json,'$.type')='refund'").get().n, 2);

    await profile('finance', FIN_COLUMNS, FIN_MAPPING, {type_map: {'İade': 'refund'}});
    const withIds = await applyAll((await upload(s, 'finance', FIN_COLUMNS, [['E1', '1002', 'P2', 'NOVA-1', 'İade', '05.09.2026', '-50,00'], ['E2', '1002', 'P2', 'NOVA-1', 'İade', '05.09.2026', '-50,00']], '2026-09-06T10:00', 'f.xlsx')).id);
    assert.equal(withIds.counts.new, 2);
    const unknown = await upload(s, 'finance', FIN_COLUMNS, [['E3', '1002', 'P2', 'NOVA-1', 'Ceza', '05.09.2026', '-10,00']], '2026-09-07T10:00', 'g.xlsx');
    const refused = await f.req('/ec/reports/files/' + unknown.id + '/apply', {});
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Ceza/);
  } finally { f.close(); }
});

test('Faturası yüklenen gider ikinci kez düşülmez; tarifeden tahmin, gerçek gelince tahmin kalkar', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    f.sqlite.exec("INSERT INTO ec_commission_rates(id,label,channel,sku,category,valid_from,valid_to,price_min_cents,price_max_cents,rate_bps,base,vat_bps,tax_included,source) VALUES('k1','TY genel','trendyol','','','2026-01-01','2026-12-31',0,NULL,1500,'gross',2000,1,'test')");
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('1002', 'P2', 'L2', 'NOVA-1', 1, 'Kargoda', '240,00', '40,00')], '2026-09-01T10:00')).id);
    let row = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    const est = row.estimates.find(e => e.type === 'commission');
    assert.equal(est.value, -3600);
    assert.match(est.basis, /Tarife: TY genel/);

    await profile('finance', FIN_COLUMNS, FIN_MAPPING, {type_map: {'Komisyon': 'commission'}});
    await applyAll((await upload(s, 'finance', FIN_COLUMNS, [['K1', '1002', 'P2', 'NOVA-1', 'Komisyon', '03.09.2026', '-36,00']], '2026-09-04T10:00', 'k.xlsx')).id);
    row = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.ok(!row.estimates.some(e => e.type === 'commission'), 'gerçek komisyon gelince tahmin ayrıca gider olarak kalmaz');
    const fee = row.fee_events.find(e => e.type === 'commission');

    f.sqlite.exec("INSERT INTO ec_suppliers(id,name) VALUES('sup','Trendyol')");
    f.sqlite.exec("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('inv','sup','KOM-1','2026-09-10')");
    f.sqlite.exec("INSERT INTO ec_purchase_lines(id,invoice_id,description,invoice_quantity,invoice_unit,net_cents,tax_cents) VALUES('ln','inv','Komisyon',1,'adet',3000,600)");
    const linked = await f.ok('/ec/reports/records/' + fee.id + '/evidence', {invoice_line_id: 'ln'});
    assert.match(linked.notice, /Yeni gider oluşturulmadı/);
    row = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(row.fees.find(x => x.type === 'commission').actual_cents, -3600, 'gider bir kez');
    assert.throws(() => f.sqlite.exec("INSERT INTO ec_fee_allocations(id,invoice_line_id,sale_id,component,amount_cents,reference) VALUES('a1','ln','yok','commission',3600,'r1')"), /FEE_ALREADY_IN_REPORT/);
  } finally { f.close(); }
});

test('Büyük aktarım partilerle ilerler ve yarıda kalırsa kaldığı yerden devam eder', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const rows = Array.from({length: 450}, (_, i) => line('20' + i, 'PK' + i, 'LK' + i, 'NOVA-1', 1, 'Kargoda', '240,00'));
    const file = await upload(s, 'orders', ORDER_COLUMNS, rows, '2026-09-01T10:00', 'buyuk.xlsx');
    const first = await f.ok('/ec/reports/files/' + file.id + '/apply', {});
    assert.equal(first.done, false);
    // Sayfa kapandı; yeniden açılınca "Devam et".
    let r = first;
    while (!r.done) r = await f.ok('/ec/reports/files/' + file.id + '/apply', {});
    assert.equal(r.counts.new, 450);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_report_records').get().n, 450);
    const again = await f.ok('/ec/reports/files/' + file.id + '/apply', {});
    assert.equal(again.done, true);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_report_records').get().n, 450, 'ikinci çağrı çoğaltmaz');
    assert.throws(() => f.sqlite.exec(`DELETE FROM ec_report_rows WHERE file_id='${file.id}'`), /IMMUTABLE_LEDGER/);
  } finally { f.close(); }
});

test('Rapor Kutusu yalnızca e-ticaret alanında', async () => {
  const {f} = await fixture(); try {
    assert.equal((await f.req('/lp/reports')).status, 403);
  } finally { f.close(); }
});

/* ---- Codex incelemesi (12 Eylül 2026): doğrulanan hatalar ve ek şüpheler ---- */

test('Sipariş düzeyindeki tek kesinti bölünmüş paketlerde iki kez sayılmaz', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Teslim edildi', '240,00', '0,00'), line('S1', 'P2', 'L2', 'NOVA-1', 1, 'Teslim edildi', '240,00', '0,00')], '2026-09-01T10:00')).id);
    await profile('finance', FIN_COLUMNS, FIN_MAPPING, {type_map: {'Komisyon': 'commission'}, fee_amounts_include_vat: false});
    await applyAll((await upload(s, 'finance', FIN_COLUMNS, [['K1', 'S1', '', 'NOVA-1', 'Komisyon', '03.09.2026', '-12,00']], '2026-09-03T10:00')).id);
    const {results} = await f.ok('/ec/reports/orders?store_id=' + s);
    const commission = results.flatMap(r => r.fees).filter(r => r.type === 'commission');
    assert.equal(commission.reduce((n, r) => n + r.actual_cents, 0), -1200, 'tek olay toplamda bir kez');
    assert.deepEqual(commission.map(r => r.actual_cents).sort((a, b) => a - b), [-600, -600], 'toplamı koruyarak dağıtıldı');
    assert.ok(results[0].notes.some(n => /dağıtıldı/.test(n)), 'dağıtım kullanıcıya söylenir');
  } finally { f.close(); }
});

test('Komisyon tahmini paketteki bütün satırları kapsar; tarifesi olmayan satır varsa tam tahmin denmez', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    f.sqlite.exec("INSERT INTO ec_commission_rates(id,label,channel,sku,category,valid_from,valid_to,price_min_cents,price_max_cents,rate_bps,base,vat_bps,tax_included,source) VALUES('k1','TY genel','trendyol','','','2026-01-01','2026-12-31',0,NULL,1500,'gross',2000,1,'test')");
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00', '0,00'), line('S1', 'P1', 'L2', 'NOVA-1', 1, 'Kargoda', '120,00', '0,00')], '2026-09-01T10:00')).id);
    let row = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    assert.equal(row.estimates.find(e => e.type === 'commission').value, -5400, '240 + 120 TL üzerinden %15');
    // Tarife dar bir fiyat aralığına çekilince ikinci satır kapsam dışında kalır: kısmi hesap tam tahmin sayılmaz.
    f.sqlite.exec("UPDATE ec_commission_rates SET archived_at='2026-09-01' WHERE id='k1'");
    f.sqlite.exec("INSERT INTO ec_commission_rates(id,label,channel,sku,category,valid_from,valid_to,price_min_cents,price_max_cents,rate_bps,base,vat_bps,tax_included,source) VALUES('k2','Dar bant','trendyol','','','2026-01-01','2026-12-31',20000,NULL,1500,'gross',2000,1,'test')");
    row = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0];
    const est = row.estimates.find(e => e.type === 'commission');
    assert.equal(est.value, null);
    assert.match(est.basis, /tarifesi yok/);
    assert.equal(row.estimated_result_cents, null, 'eksik tahminle sonuç tahmini verilmez');
  } finally { f.close(); }
});

test('Değişmeyen yeni gözlem güncellik sınırını ilerletir; sonradan yüklenen eski rapor geri alamaz', async () => {
  const {f, store, profile, upload, applyAll, record} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00')], '2026-09-01T10:00')).id);
    const second = await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00'), line('S2', 'P2', 'L2', 'NOVA-1', 1, 'Yeni', '120,00')], '2026-09-03T10:00', 'b.xlsx')).id);
    assert.deepEqual([second.counts.same, second.counts.new], [1, 1], 'L1 aynı, L2 yeni');
    const older = await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Hazırlanıyor', '240,00')], '2026-09-02T10:00', 'c.xlsx')).id);
    assert.deepEqual({older: older.counts.older || 0, updated: older.counts.updated || 0, status: record(s, 'L:L1').status}, {older: 1, updated: 0, status: 'Kargoda'});
    assert.equal(record(s, 'L:L1')._v, 1, 'yalnız gözlem zamanı ilerledi, veri sürümü artmadı');
  } finally { f.close(); }
});

test('ERP bağlantısı mağaza ayrımı kesin değilse kurulmaz', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,source_fingerprint) VALUES('pkg-1','trendyol','P1','S1','2026-09-01','test')");
    const a = await store('trendyol', 'TY-A');
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(a, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00')], '2026-09-01T10:00')).id);
    assert.equal(f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE record_key='L:L1'").get().erp_package_id, 'pkg-1', 'tek mağazada bağlanır');
    // İkinci mağaza tanımlanınca aynı numaralar hangi mağazanınki belli olmaz: bağlanmaz, incelemeye gider.
    const b = await store('trendyol', 'TY-B');
    await applyAll((await upload(b, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00')], '2026-09-01T10:00', 'b.xlsx')).id);
    const second = f.sqlite.prepare("SELECT erp_package_id FROM ec_report_records WHERE store_id=? AND record_key='L:L1'").get(b);
    assert.equal(second.erp_package_id, null);
    assert.ok((await f.ok('/ec/reports/reviews')).reviews.some(r => r.reason === 'store_ambiguous'));
  } finally { f.close(); }
});

test('Sayfalama paket bütünlüğünü bozmaz', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const rows = [];
    for (const o of ['S1', 'S2', 'S3']) rows.push(line(o, 'P' + o, 'L' + o + 'a', 'NOVA-1', 1, 'Kargoda', '240,00', '0,00'), line(o, 'P' + o, 'L' + o + 'b', 'NOVA-1', 1, 'Kargoda', '120,00', '0,00'));
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, rows, '2026-09-01T10:00')).id);
    const {orderResults} = await import('../src/report-inbox-api.js');
    for (let page = 0; page < 3; page++) {
      const {results} = await orderResults(f.env.DB, s, {limit: 1, offset: page});
      assert.equal(results.length, 1);
      assert.equal(results[0].lines.length, 2, 'paketin iki satırı da hesaba girer');
      assert.equal(results[0].net_sales_ex_vat_cents, 30000, '360 TL brüt → KDV hariç 300 TL');
    }
  } finally { f.close(); }
});

test('Gider KDV bilgisi olayın kendi profil sürümünden gelir; sonraki profil geçmişi değiştirmez', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Teslim edildi', '240,00', '0,00')], '2026-09-01T10:00')).id);
    await profile('finance', FIN_COLUMNS, FIN_MAPPING, {type_map: {'Komisyon': 'commission'}, fee_amounts_include_vat: false});
    await applyAll((await upload(s, 'finance', FIN_COLUMNS, [['K1', 'S1', 'P1', 'NOVA-1', 'Komisyon', '03.09.2026', '-36,00']], '2026-09-03T10:00')).id);
    const before = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0].contribution_cents;
    // Aynı pazaryerinde SONRADAN başka bir rapor biçimi için "KDV dahil" profil açılır.
    await profile('finance', [...FIN_COLUMNS, {header: 'Ek'}], FIN_MAPPING, {type_map: {'Komisyon': 'commission'}, fee_amounts_include_vat: true, fee_vat_bps: 2000});
    const after = (await f.ok('/ec/reports/orders?store_id=' + s)).results[0].contribution_cents;
    assert.equal(after, before, 'eski olayın hesabı değişmez');
  } finally { f.close(); }
});

test('Gözlemden tahmin yalnızca aynı içerikli paketlerden yapılır', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await profile('finance', FIN_COLUMNS, FIN_MAPPING, {type_map: {'Kargo': 'cargo'}});
    // Geçmiş: üç paket 1 adet NOVA-1, kargo 30 TL. Ayrıca farklı içerikli (2 adet) bir paket.
    const past = [];
    for (const n of [1, 2, 3]) past.push(line('G' + n, 'PG' + n, 'LG' + n, 'NOVA-1', 1, 'Teslim edildi', '240,00', '0,00'));
    past.push(line('G9', 'PG9', 'LG9', 'NOVA-1', 2, 'Teslim edildi', '480,00', '0,00'));
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, past, '2026-09-01T10:00')).id);
    await applyAll((await upload(s, 'finance', FIN_COLUMNS, [1, 2, 3].map(n => ['C' + n, 'G' + n, 'PG' + n, 'NOVA-1', 'Kargo', '02.09.2026', '-30,00'])
      .concat([['C9', 'G9', 'PG9', 'NOVA-1', 'Kargo', '02.09.2026', '-90,00']]), '2026-09-02T10:00')).id);
    // Yeni sipariş: 1 adet → aynı içerikli üç paketten tahmin. 5 adetlik paket → benzer kayıt yok.
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'NOVA-1', 1, 'Kargoda', '240,00', ''), line('S5', 'P5', 'L5', 'NOVA-1', 5, 'Kargoda', '1200,00', '')], '2026-09-03T10:00', 'b.xlsx')).id);
    const {results} = await f.ok('/ec/reports/orders?store_id=' + s);
    const one = results.find(r => r.group === 'P1').estimates.find(e => e.type === 'cargo');
    assert.equal(one.value, -3000);
    assert.equal(one.samples, 3);
    const five = results.find(r => r.group === 'P5').estimates.find(e => e.type === 'cargo');
    assert.equal(five.value, null, 'farklı içerikli paket için uydurma tahmin yok');
  } finally { f.close(); }
});

test('Sonradan tanımlanan eşleştirme eksik kayıtları tamamlar; eski anlık görüntüler korunur', async () => {
  const {f, store, profile, upload, applyAll} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, 'orders', ORDER_COLUMNS, [line('S1', 'P1', 'L1', 'YOK-1', 1, 'Teslim edildi', '240,00', '0,00'), line('S2', 'P2', 'L2', 'NOVA-1', 1, 'Teslim edildi', '240,00', '0,00')], '2026-09-01T10:00')).id);
    let row = (await f.ok('/ec/reports/orders?store_id=' + s)).results.find(r => r.group === 'P1');
    assert.ok(row.contribution_missing.some(m => /eşleşmesi yok/.test(m)));
    // Eşleştirme sonradan tanımlanır.
    f.sqlite.exec("INSERT INTO ec_catalog_mappings(id,source,match_by,match_value,external_code,active,version,created_at) VALUES('m-yok','trendyol','code','YOK-1','YOK-1',0,1,'2026-09-05 00:00:00')");
    f.sqlite.exec("INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES('c9','m-yok','nova',1000,10000)");
    f.sqlite.exec("UPDATE ec_catalog_mappings SET active=1 WHERE id='m-yok'");
    const nova = f.sqlite.prepare("SELECT components_json FROM ec_report_records WHERE record_key='L:L2'").get().components_json;
    const result = await f.ok('/ec/reports/backfill-components', {store_id: s});
    assert.equal(result.filled, 1);
    row = (await f.ok('/ec/reports/orders?store_id=' + s)).results.find(r => r.group === 'P1');
    assert.equal(row.cogs_cents, 10000);
    assert.ok(row.notes.some(n => /sipariş tarihinden sonra/.test(n)), 'sonradan tanımlanan set için uyarı');
    assert.equal(f.sqlite.prepare("SELECT components_json FROM ec_report_records WHERE record_key='L:L2'").get().components_json, nova, 'var olan anlık görüntü değişmedi');
  } finally { f.close(); }
});

test('Aktarım partisi yalnız kendi satırlarını okur; dosya içi tekrar partiler arasında da yakalanır', async () => {
  const {f, store, profile, upload} = await fixture(); try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const rows = Array.from({length: 300}, (_, i) => line('B' + i, 'PB' + i, 'LB' + i, 'NOVA-1', 1, 'Kargoda', '240,00'));
    rows.push(line('B0', 'PB0', 'LB0', 'NOVA-1', 1, 'Kargoda', '240,00'));   // 1. satırın kimliğinin tekrarı, son partide
    const file = await upload(s, 'orders', ORDER_COLUMNS, rows, '2026-09-01T10:00', 'buyuk.xlsx');
    const seal = JSON.parse(f.sqlite.prepare('SELECT twin_keys_json j FROM ec_report_files WHERE id=?').get(file.id).j);
    assert.ok(seal.duplicates['order_line|L:LB0'], 'tekrar eden kimlik mühürlemede bulunur');
    let r; do { r = await f.ok('/ec/reports/files/' + file.id + '/apply', {}); } while (!r.done);
    assert.equal(r.counts.new, 300);
    assert.equal(r.counts.review, 1, 'farklı partideki tekrar yine incelemeye gider');
  } finally { f.close(); }
});
