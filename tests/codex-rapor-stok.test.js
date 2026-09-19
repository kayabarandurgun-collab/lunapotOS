// R05 — Geçici sayım telafisi yalnız fiilen gerçekleşen gönderimle birlikte yazılır: hazırlanan ya da
//        ayrılıp iptal edilen sipariş stoğu artırmaz; rezervasyon hatası artış bırakmaz.
// R06 — Taslak tazelemesi yalnız SKU/adede bakıp fiyat değişimini yutmaz.
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
function store(f) {
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', 'st', 'trendyol', 'TY-1', 'Mağaza');
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
    VALUES('fl','st','orders','rapor.xlsx',100,?,?,'[]',1,1,'applied')`, 'f'.repeat(64), '2026-09-12T10:00');
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
}
const record = (f, data) => sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
  VALUES(?,'st','order_line',?,'provider',?,'2026-09-12T10:00','2026-09-12T10:00','fl',1)`, 'rec-1', 'L:L1',
  JSON.stringify({package_id: 'PK1', line_id: 'L1', order_no: 'O1', order_date: DATE, barcode: '785457868', product_name: '4 adet 225 ml',
    quantity: 2, gross: 50000, vat_bps: 2000, status: 'Hazırlanıyor', delivered_date: '', ...data}));
function guncelle(f, over) {
  const r = f.sqlite.prepare("SELECT data_json,version FROM ec_report_records WHERE id='rec-1'").get();
  sql(f, "UPDATE ec_report_records SET data_json=?,version=?,updated_at=datetime(updated_at,'+1 hour') WHERE id='rec-1'", JSON.stringify({...JSON.parse(r.data_json), ...over}), r.version + 1);
}
const stok = (f, id) => f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(id).q;
const telafiler = f => f.sqlite.prepare("SELECT quantity_milli q FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%'").all().map(x => x.q);
const satislar = f => f.sqlite.prepare("SELECT quantity_milli q,revenue_cents r FROM ec_sale_entries WHERE kind='sale'").all().map(x => ({...x}));
const oto = f => f.ok('/ec/reports/stock-link/auto', {store_id: 'st', skip: []});

async function kur(f, {acilis = 20, sayim = 24, profil = true} = {}) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  if (acilis) await f.ok('/ec/stock', {product_id: product.id, quantity: acilis, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  if (profil) sql(f, `INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel)
    VALUES(?,2000,0,0,0,0,100,100,100,500,1)`, product.id);
  store(f);
  // Siparişten SONRA rafta geçici sayım: raf bu sayıdadır.
  if (sayim) await f.ok('/ec/stock', {product_id: product.id, quantity: sayim, unit_cost: 10, kind: 'count', reference: 'GECICI-SAYIM-X', notes: 'Raf sayımı', occurred_on: '2026-09-15'});
  return product;
}

test('R05: yalnız hazırlanan sipariş stoğu artırmaz; iptal edilince stok raf sayımında kalır (24 → 24, 32 değil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    assert.equal(stok(f, p.id), 24000);
    record(f, {status: 'Hazırlanıyor'});
    const r = await oto(f);
    assert.ok(r.results[0].done, JSON.stringify(r.results));
    assert.equal(f.sqlite.prepare('SELECT status FROM ec_order_packages').get().status, 'reserved');
    assert.equal(stok(f, p.id), 24000, 'hazırlık/rezervasyon telafi yaratmaz: ' + JSON.stringify(r.results[0]));
    assert.deepEqual(telafiler(f), []);
    guncelle(f, {status: 'İptal Edildi'});
    const iptal = await oto(f);
    assert.equal(iptal.results[0].done, 'iptal edildi', JSON.stringify(iptal.results));
    assert.equal(stok(f, p.id), 24000, 'iptal sonrası fiziksel stok değişmedi');
    assert.deepEqual(satislar(f), []);
  } finally { f.close(); }
});

test('R05: kargolanmış pakette rezervasyon başarısız olursa telafi artışı kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f, {profil: false});
    record(f, {status: 'Kargolandı', vat_bps: undefined});      // KDV bilinmiyor: tutar eksik, ayırma yapılamaz
    const r = await oto(f);
    assert.ok(r.results[0].skipped, JSON.stringify(r.results));
    assert.equal(stok(f, p.id), 24000, 'başarısız rezervasyon stok artışı bırakmadı');
    assert.deepEqual(telafiler(f), []);
    await oto(f);
    assert.equal(stok(f, p.id), 24000, 'tekrar da artırmaz');
  } finally { f.close(); }
});

test('R05: gönderimde bir satış ve bir telafi; raf sayımı siparişten küçük olsa da gönderilir; tekrar etkisiz', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f, {acilis: 0, sayim: 6});             // 8 şişe sayımdan önce gitmiş, rafta 6 kalmış
    record(f, {status: 'Teslim Edildi', delivered_date: '2026-09-13'});
    const r = await oto(f);
    assert.match(r.results[0].done || '', /gönderildi/, JSON.stringify(r.results));
    assert.equal(stok(f, p.id), 6000, 'raf 6: satış 8 düştü, telafi 8');
    assert.deepEqual(telafiler(f), [8000]);
    assert.deepEqual(satislar(f).map(s => s.q), [8000]);
    await oto(f); await oto(f);
    assert.equal(stok(f, p.id), 6000);
    assert.deepEqual(telafiler(f), [8000], 'ikinci telafi yok');
    assert.equal(satislar(f).length, 1, 'ikinci satış yok');
  } finally { f.close(); }
});

test('R06: taslakken rapor brütü 500 → 900 değişirse sipariş 900 ile tamamlanır; eski tutar onaylanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await kur(f, {sayim: 0});
    record(f, {quantity: 1, status: 'Gönderime Hazır'});
    const taslak = await f.ok('/ec/reports/stock-link/apply', {store_id: 'st', package_id: 'PK1', complete_package_confirmed: true, line_identity_from_package_sku: true});
    assert.equal(f.sqlite.prepare('SELECT gross_cents g FROM ec_order_lines').get().g, 50000);
    guncelle(f, {gross: 90000, status: 'Kargolandı'});
    const r = await oto(f);
    const s = satislar(f);
    assert.ok(!s.length || s[0].r !== Math.round(50000 / 1.2), 'eski 500 TL satış olarak yazılmadı: ' + JSON.stringify(s));
    assert.match(r.results[0].done || '', /gönderildi/, JSON.stringify(r.results));
    assert.deepEqual(s.map(x => x.r), [75000], '900 TL (KDV hariç 750) ile satış');
    const l = f.sqlite.prepare('SELECT gross_cents,net_revenue_cents FROM ec_order_lines WHERE package_id=?').get(taslak.package_id);
    assert.deepEqual([l.gross_cents, l.net_revenue_cents], [90000, 75000]);
    const iz = f.sqlite.prepare('SELECT old_lines_json,new_lines_json FROM ec_report_draft_refreshes WHERE package_id=?').all(taslak.package_id);
    assert.equal(iz.length, 1, 'değişiklik iz bırakır');
    assert.equal(JSON.parse(iz[0].old_lines_json)[0].gross_cents, 50000);
  } finally { f.close(); }
});

test('R06: ayrılmış siparişte tutar değişirse eski tutarla gönderilmez, gerekçeyle durur', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f, {sayim: 0});
    record(f, {quantity: 1, status: 'Toplanmaya Başlandı'});
    const once = await oto(f);
    assert.equal(once.results[0].done, 'sipariş açıldı, stok ayrıldı');
    guncelle(f, {gross: 90000, status: 'Kargolandı'});
    const r = await oto(f);
    assert.deepEqual(satislar(f), [], 'eski 500 TL satış yazılmadı: ' + JSON.stringify(r.results));
    assert.ok(r.results[0].skipped && /tutar/i.test(r.results[0].reason), JSON.stringify(r.results));
    const pk = f.sqlite.prepare('SELECT status,source_changed FROM ec_order_packages').get();
    assert.deepEqual([pk.status, pk.source_changed], ['reserved', 1], 'kaynak değişti işareti kalır');
    assert.equal(stok(f, p.id), 20000);
  } finally { f.close(); }
});
