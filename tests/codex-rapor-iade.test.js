// R04 + R14 — Rapor iadesi paket/satır tahsisi: tek iade olayı iki pakete iki kez uygulanmaz,
// kısmi iadeden sonra kalan adet engellenmez, DUZELTME-CIFT teknik ters kaydı müşteri iadesi sayılmaz.
// Paralel (cron + ekran) iki çalıştırma sıralı çalıştırmayla aynı sonucu verir.
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {reportStockLinkApi} from '../src/report-stock-link-api.js';

const DATE = '2026-09-12';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
function store(f) {
  sql(f, 'INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)', 'st', 'trendyol', 'TY-1', 'Mağaza');
  sql(f, `INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)
    VALUES('fl','st','orders','rapor.xlsx',100,?,?,'[]',1,1,'applied')`, 'f'.repeat(64), '2026-09-12T10:00');
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
  return 'st';
}
let n = 0;
const record = (f, data) => sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
  VALUES(?,'st','order_line',?,'provider',?,'2026-09-12T10:00','2026-09-12T10:00','fl',?)`, 'rec-' + data.line_id, 'L:' + data.line_id,
  JSON.stringify({order_date: DATE, barcode: '785457868', product_name: '4 adet 225 ml', quantity: 1, gross: 25000, vat_bps: 2000,
    status: 'Teslim Edildi', delivered_date: '2026-09-14', ...data}), ++n);
const finans = (f, data) => sql(f, `INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)
  VALUES(?,'st','finance_event',?,'composite',?,'2026-09-15T10:00','2026-09-15T10:00','fl',?)`, 'fin-' + (++n), 'F:' + n, JSON.stringify({type: 'refund', ...data}), 100 + n);
const durum = (f, lineId, status) => {
  const r = f.sqlite.prepare('SELECT data_json,version FROM ec_report_records WHERE id=?').get('rec-' + lineId);
  sql(f, 'UPDATE ec_report_records SET data_json=?,version=? WHERE id=?', JSON.stringify({...JSON.parse(r.data_json), status}), r.version + 1, 'rec-' + lineId);
};
const stok = (f, id) => f.sqlite.prepare('SELECT quantity_milli q FROM ec_stock_balances WHERE product_id=?').get(id).q;
const iadeler = f => f.sqlite.prepare("SELECT parent_id,quantity_milli,revenue_cents,external_id FROM ec_sale_entries WHERE kind='return' AND external_id NOT LIKE 'DUZELTME-CIFT-%' AND external_id NOT LIKE 'ELLE-%' ORDER BY rowid").all();
const satisOf = (f, lineId) => f.sqlite.prepare('SELECT c.sale_id s FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.external_id LIKE ?').get('%' + lineId).s;

async function kur(f) {
  const product = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-CICEK-225ML', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: product.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '785457868', external_name: '4 adet 225 ml',
    components: [{product_id: product.id, quantity_milli: 4000, revenue_share_bps: 10000}]});
  store(f);
  return product;
}
const aktar = async f => { const r = await f.ok('/ec/reports/stock-link/auto', {store_id: 'st', skip: []}); assert.ok(r.results.every(x => x.done), JSON.stringify(r)); };
const iadeUygula = f => f.ok('/ec/reports/stock-link/returns-apply', {store_id: 'st', confirm: true});

test('R04: aynı siparişte iki paket, paketi belirsiz tek iade olayı iki pakete iade üretmez; kanıt gelince yalnız o paket', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    record(f, {package_id: 'PKA', line_id: 'LA', order_no: 'O2'});
    record(f, {package_id: 'PKB', line_id: 'LB', order_no: 'O2'});
    await aktar(f);
    assert.equal(stok(f, p.id), 12000, 'iki paket × 4 şişe gönderildi');
    finans(f, {order_no: 'O2', amount_cents: -25000});   // yalnız BİR paketin tutarı; paket no yok

    const r = await iadeUygula(f);
    assert.equal(iadeler(f).length, 0, 'tutar iki paketle de aynı: hangisi olduğu belirsiz, iade uydurulmaz: ' + JSON.stringify(r));
    assert.equal(stok(f, p.id), 12000);
    assert.ok(r.skipped.some(s => s.order_no === 'O2'), 'belirsiz olay gerekçesiyle incelemede kalır');

    durum(f, 'LA', 'İade Edildi');                       // rapor hangi paketin döndüğünü söyledi
    await iadeUygula(f);
    const liste = iadeler(f);
    assert.deepEqual(liste.map(x => [x.parent_id, x.quantity_milli]), [[satisOf(f, 'LA'), 4000]], 'yalnız iade durumundaki paket');
    assert.equal(stok(f, p.id), 16000);
    await iadeUygula(f);
    assert.equal(iadeler(f).length, 1, 'tekrar ilave iade üretmez');
  } finally { f.close(); }
});

test('R04: iade olayı paket numarası taşıyorsa yalnız o pakete uygulanır; aynı tutarlı diğer paket etkilenmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    record(f, {package_id: 'PKA', line_id: 'LA', order_no: 'O6'});
    record(f, {package_id: 'PKB', line_id: 'LB', order_no: 'O6'});
    await aktar(f);
    finans(f, {order_no: 'O6', package_id: 'PKB', amount_cents: -25000});
    await iadeUygula(f); await iadeUygula(f);
    assert.deepEqual(iadeler(f).map(x => [x.parent_id, x.quantity_milli]), [[satisOf(f, 'LB'), 4000]]);
    assert.equal(stok(f, p.id), 16000);
  } finally { f.close(); }
});

test('R04: tutar yalnız TEK paketi açıklıyorsa o paket iade edilir (diğer paket etkilenmez)', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    record(f, {package_id: 'PKA', line_id: 'LA', order_no: 'O3', gross: 30000});
    record(f, {package_id: 'PKB', line_id: 'LB', order_no: 'O3', quantity: 2, gross: 50000});
    await aktar(f);
    finans(f, {order_no: 'O3', amount_cents: -30000});
    await iadeUygula(f); await iadeUygula(f);
    assert.deepEqual(iadeler(f).map(x => [x.parent_id, x.quantity_milli]), [[satisOf(f, 'LA'), 4000]]);
    assert.equal(stok(f, p.id), 20000 - 12000 + 4000);
  } finally { f.close(); }
});

/** İki çalıştırmanın da iade yazmadan önce aynı durumu okumasını sağlayan bariyer. */
function ikili(DB) {
  let gelen = 0, ac; const kapi = new Promise(r => { ac = r; });
  const sar = () => { let gecti = false; return {prepare: q => DB.prepare(q), async batch(items) {
    if (!gecti && items.some(s => (s.args || []).some(a => typeof a === 'string' && /^IADE-/.test(a)))) { gecti = true; if (++gelen >= 2) ac(); await kapi; }
    return DB.batch(items);
  }}; };
  const calistir = db => reportStockLinkApi(new Request('https://internal.invalid/api/ec/reports/stock-link/returns-apply', {method: 'POST'}),
    {DB: scopedDB(db, 'ec'), ROOT_DB: db, WORKSPACE: 'ec', USER: {owner: true, id: 'test'}}, '/api/reports/stock-link/returns-apply', async () => ({store_id: 'st', confirm: true}));
  return () => { const a = calistir(sar()), b = calistir(sar()); a.finally(ac); b.finally(ac); return Promise.allSettled([a, b]); };
}

test('R04: paralel iki iade çalıştırması (cron + ekran) kısmi iadeyi bir kez yazar', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    record(f, {package_id: 'PKK', line_id: 'LK', order_no: 'OK', quantity: 4, gross: 100000});
    await aktar(f);
    assert.equal(stok(f, p.id), 4000);
    finans(f, {order_no: 'OK', amount_cents: -25000});   // 4 ilandan 1'i
    await ikili(f.env.DB)();
    assert.deepEqual(iadeler(f).map(x => x.quantity_milli), [4000], 'tek olay tek iade: ' + JSON.stringify(iadeler(f)));
    assert.equal(stok(f, p.id), 8000);
    await iadeUygula(f);
    assert.equal(iadeler(f).length, 1, 'sıralı tekrar da etkisiz');
  } finally { f.close(); }
});

test('R14: ilk kısmi iadeden sonra kalan adedi kapsayan yeni rapor kalan iadeyi tamamlar, satışı aşmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    record(f, {package_id: 'PK3', line_id: 'L3', order_no: 'O4', quantity: 3, gross: 75000});
    await aktar(f);
    assert.equal(stok(f, p.id), 8000);
    finans(f, {order_no: 'O4', amount_cents: -25000});
    await iadeUygula(f);
    assert.deepEqual(iadeler(f).map(x => x.quantity_milli), [4000]);
    finans(f, {order_no: 'O4', amount_cents: -50000});   // sonraki rapor: kalan 2 adet
    await iadeUygula(f); await iadeUygula(f);
    const liste = iadeler(f);
    assert.deepEqual(liste.map(x => x.quantity_milli), [4000, 8000], 'kalan iki ilan tek seferde, tekrar yok');
    const satis = f.sqlite.prepare('SELECT quantity_milli q,revenue_cents r FROM ec_sale_entries WHERE id=?').get(satisOf(f, 'L3'));
    assert.equal(liste.reduce((t, x) => t + x.quantity_milli, 0), satis.q, 'iade satış adedini aşmaz');
    assert.equal(-liste.reduce((t, x) => t + x.revenue_cents, 0), satis.r, 'iade tutarı satış tutarına kuruşu kuruşuna eşit');
    assert.equal(stok(f, p.id), 20000);
  } finally { f.close(); }
});

test('R14: bir satırın iadesi aynı paketteki diğer satırın iadesini kilitlemez', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const q = await f.ok('/ec/products', {name: 'Orkide toprağı 3 L', sku: 'TR-ORK-3L', stock_unit: 'adet', min_stock: 0});
    await f.ok('/ec/stock', {product_id: q.id, quantity: 5, unit_cost: 20, kind: 'opening', reference: 'ACILIS-2', occurred_on: DATE, notes: 'Test açılışı'});
    await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: '868000000001', external_name: 'Orkide toprağı',
      components: [{product_id: q.id, quantity_milli: 1000, revenue_share_bps: 10000}]});
    record(f, {package_id: 'PKM', line_id: 'LM1', order_no: 'O5'});
    record(f, {package_id: 'PKM', line_id: 'LM2', order_no: 'O5', barcode: '868000000001', product_name: 'Orkide toprağı', gross: 10000});
    await aktar(f);
    // Birinci satırın iadesi elle girilmiş (hangi satır olduğu kullanıcıca bilindi).
    const s1 = satisOf(f, 'LM1'), r1 = f.sqlite.prepare('SELECT revenue_cents r FROM ec_sale_entries WHERE id=?').get(s1).r;
    await f.ok('/ec/sales/' + s1 + '/return', {external_id: 'ELLE-1', quantity: 4, revenue: r1 / 100, restock: true, occurred_on: DATE, notes: 'Elle iade'});
    finans(f, {order_no: 'O5', amount_cents: -35000});   // paketin tamamı iade edildi
    await iadeUygula(f); await iadeUygula(f);
    assert.deepEqual(iadeler(f).map(x => [x.parent_id, x.quantity_milli]), [[satisOf(f, 'LM2'), 1000]], 'kalan satır iade edildi, ilk satır ikinci kez değil');
    assert.equal(stok(f, q.id), 5000);
    assert.equal(stok(f, p.id), 20000);
  } finally { f.close(); }
});

test('R04/R14: DUZELTME-CIFT teknik ters kaydı müşteri iadesi sayılmaz; gerçek iade asıl kayda bir kez yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await kur(f);
    const ac = async (ext, teslim) => { const o = await f.ok('/ec/orders', {channel: 'trendyol', external_id: ext, order_no: 'OD', occurred_on: DATE,
      lines: [{external_id: ext + '-1', sku: '785457868', name: '4 adet 225 ml', quantity: 1, gross: 250, vat_rate: 20}]});
      await f.ok('/ec/orders/' + o.id + '/reserve', {}); await f.ok('/ec/orders/' + o.id + '/ship', {occurred_on: DATE, reference: 'S-' + ext});
      if (teslim) await f.ok('/ec/orders/' + o.id + '/deliver', {occurred_on: '2026-09-14'}); return o; };
    const kopya = await ac('TY-PKD', true), asil = await ac('TEA-OD', false);   // asıl kayıt kalıcı "gönderildi"
    const kopyaSatis = f.sqlite.prepare("SELECT c.sale_id s,s.revenue_cents r FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_sale_entries s ON s.id=c.sale_id WHERE l.package_id=?").get(kopya.id);
    await f.ok('/ec/sales/' + kopyaSatis.s + '/return', {external_id: 'DUZELTME-CIFT-D1', quantity: 4, revenue: kopyaSatis.r / 100, restock: true, occurred_on: DATE, notes: 'Çift kayıt düzeltmesi'});
    record(f, {package_id: 'PKD', line_id: 'LD', order_no: 'OD'});
    sql(f, "UPDATE ec_report_records SET erp_package_id=? WHERE id='rec-LD'", kopya.id);
    assert.equal(stok(f, p.id), 16000);
    finans(f, {order_no: 'OD', amount_cents: -25000});   // gerçek müşteri iadesi
    await iadeUygula(f); await iadeUygula(f);
    const asilSatis = f.sqlite.prepare("SELECT c.sale_id s FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?").get(asil.id).s;
    assert.deepEqual(iadeler(f).map(x => [x.parent_id, x.quantity_milli]), [[asilSatis, 4000]], 'teknik ters kayıt iadeyi engellemedi; gerçek iade bir kez');
    assert.equal(stok(f, p.id), 20000);
  } finally { f.close(); }
});
