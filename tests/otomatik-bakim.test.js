// Zamanlanmış otomatik bakım: kullanıcı rapor yükleyip sayfayı kapatsa da yarım kalan işler sunucuda
// tamamlanır. Kanıtlanan: rapordaki bağlanmamış paketler aktarılır/gönderilir/teslim edilir, ikinci
// tur hiçbir şeyi çoğaltmaz, kullanıcı o sırada yükleme yapıyorsa tur atlanır.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {otomatikBakim} from '../src/otomatik-bakim.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
function store(f) {
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', 'st', 'trendyol', 'TY-1', 'Mağaza');
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status,created_at)
    VALUES('fl','st','orders','rapor.xlsx',100,?,?,'[]',1,1,'applied','2026-09-12 10:00:00')`, 'f'.repeat(64), '2026-09-12T10:00');
  return 'st';
}
const record = (f, n, data) => sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
  VALUES(?,'st','order_line',?,'provider',?,'2026-09-12T10:00','2026-09-12T10:00','fl',?)`, 'rec-' + n, 'L:' + n, JSON.stringify({order_date: DATE, barcode: '785457868',
  product_name: '4 adet 225 ml', quantity: 1, gross: 25000, vat_bps: 2000, ...data}), n);

async function kur(f) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
  store(f);
  return product;
}

test('Sayfa kapansa da bakım bağlanmamış paketleri aktarır, gönderir, teslim eder; ikinci tur çoğaltmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const product = await kur(f);
    record(f, 1, {package_id: 'PK1', line_id: 'L1', order_no: 'O1', status: 'Kargolandı'});
    record(f, 2, {package_id: 'PK2', line_id: 'L2', order_no: 'O2', status: 'Teslim Edildi', delivered_date: '2026-09-14T10:00'});
    const ilk = await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T12:00:00Z')});
    assert.equal(ilk.siparis, 2, JSON.stringify(ilk));
    assert.deepEqual(ilk.hatalar, []);
    const paketler = f.sqlite.prepare("SELECT status FROM ec_order_packages ORDER BY status").all().map(x => x.status);
    assert.deepEqual(paketler, ['delivered', 'shipped']);
    assert.equal(f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(product.id).q, 12000, 'iki ilan × 4 şişe düştü');
    assert.match(f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım%'").get().d, /2 sipariş aktarıldı/);

    const ikinci = await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T12:15:00Z')});
    assert.equal(ikinci.siparis, 0, 'yapılmış iş tekrar yazılmadı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 2);
  } finally { f.close(); }
});

test('Kullanıcı son 10 dakikada rapor yüklediyse bakım turu atlanır (ekranla yarışmaz)', async () => {
  const f = appFixture(); await f.setup(); try {
    await kur(f);
    record(f, 1, {package_id: 'PK1', line_id: 'L1', order_no: 'O1', status: 'Kargolandı'});
    const r = await otomatikBakim(f.env, {simdi: Date.parse('2026-09-12T10:05:00Z')});
    assert.match(r.atlandi, /10 dakikada/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 0);
  } finally { f.close(); }
});
