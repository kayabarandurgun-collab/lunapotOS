// ROZET İLE LİSTE AYNI SAYIYI VERMELİ. Ölçüldü (07.10.2026, canlı): iş listesindeki
// "7+ gündür kargoda" rozeti **2** diyordu, rozete tıklayınca açılan sipariş listesi **10** satır
// gösteriyordu. Sebep: rozet iadesi tamamlanmış paketleri ve çift aktarım ikizlerini dışlıyordu,
// listenin süzgeci dışlamıyordu — iki ekran aynı işi iki farklı sayıyla gösteriyordu.
//
// Koşul artık tek yerde duruyor (orders-query.js: YOLDA_DEGIL) ve ikisi de onu kullanıyor.
//
// Kanıtlanan: (a) iadesi tamamlanmış paket ikisinde de yolda sayılmıyor, (b) İKAME ters kaydı iade
// SAYILMIYOR (sipariş içeriği değişti, paket yine yolda), (c) rozetin sayısı listenin satır
// sayısına EŞİT, (d) iki kaynak da ortak koşulu kullanıyor, kopyası kalmadı.
// TEMSİLİ veri; gerçek sipariş DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';

const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);
const gunOnce = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** Ürün + tek bileşenli ilan; satış kaydı paketin gönderilmesiyle doğar. */
async function kurulum(f) {
  const p = await f.ok('/ec/products', {name: 'Klasmann TS1 Torf 210 L', sku: 'KL-TS1', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 50, unit_cost: 1400, kind: 'opening', reference: 'ACILIS', occurred_on: gunOnce(60), notes: 'Test'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'TEK', external_name: 'Tek ürün',
    components: [{product_id: p.id, quantity_milli: 1000, revenue_share_bps: 10000}]});
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', gunOnce(60), 'ec');
  return p;
}

/** Kargoya verilmiş (teslim edilmemiş) paket kurar ve satış kayıtlarını döndürür. */
async function kargodaPaket(f, ref, gun) {
  const r = await f.ok('/ec/orders', {channel: 'trendyol', external_id: ref, order_no: ref, occurred_on: gun,
    lines: [{external_id: 'L-' + ref, name: 'Tek ürün', sku: 'TEK', quantity: 1, gross: 300000, vat_rate: 20}]});
  const id = r.id || r.package_ids?.[0];
  const satir = f.sqlite.prepare('SELECT id FROM ec_order_lines WHERE package_id=?').get(id);
  const urun = f.sqlite.prepare('SELECT id FROM ec_products LIMIT 1').get().id;
  await f.ok('/ec/orders/' + id + '/map', {lines: [{id: satir.id, product_id: urun, vat_rate: 20}]});
  await f.ok('/ec/orders/' + id + '/reserve', {});
  await f.ok('/ec/orders/' + id + '/ship', {occurred_on: gun, reference: 'SEVK-' + ref});
  const sales = f.sqlite.prepare("SELECT s.id,s.quantity_milli,s.revenue_cents,s.cost_cents,s.channel,s.product_id"
    + ' FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id'
    + " WHERE l.package_id=? AND s.kind='sale'").all(id);
  return {id, sales};
}

/** Satışı TAMAMEN iade eder. external_id ön eki ters kaydın türünü belirler. */
function tamIade(f, sale, onEk) {
  sql(f, 'INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on)'
    + " VALUES(?,?,?,?,'return',?,?,?,?,'pending',?)",
  'ret-' + sale.id, sale.channel, onEk + sale.id, sale.product_id, sale.id,
  sale.quantity_milli, -sale.revenue_cents, -sale.cost_cents, gunOnce(1));
}

const rozet = async f => (await f.ok('/ec/attention')).orders.long_shipping;
const liste = async f => (await f.ok('/ec/orders?watch=long_shipping')).packages.length;

test('İadesi tamamlanmış paket ikisinde de yolda sayılmaz; sayılar EŞİT', async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f);
    const yolda = await kargodaPaket(f, 'ACIK', gunOnce(20));
    const donmus = await kargodaPaket(f, 'DONMUS', gunOnce(20));
    for (const s of donmus.sales) tamIade(f, s, 'IADE-');

    assert.equal(await rozet(f), 1, 'yalnız gerçekten yolda olan sayılmalı');
    assert.equal(await liste(f), 1, 'liste rozetle AYNI sayıyı vermeli');
    const p = (await f.ok('/ec/orders?watch=long_shipping')).packages;
    assert.equal(p[0].order_no, 'ACIK', 'listede duran paket yolda olan olmalı');
    assert.ok(yolda.id && donmus.id);
  } finally { f.close(); }
});

// İKAME: siparişteki ürün yerine başkası gönderilmiştir, paket YİNE YOLDA. İade sayılsaydı
// düzeltilen sipariş kargo takibinden sessizce düşerdi.
test('İKAME ters kaydı iade sayılmaz: paket yolda kalmaya devam eder', async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f);
    const ikame = await kargodaPaket(f, 'IKAME', gunOnce(20));
    for (const s of ikame.sales) tamIade(f, s, 'DUZELTME-IKAME-');

    assert.equal(await rozet(f), 1, 'İKAME düzeltmesi paketi takipten düşürmemeli');
    assert.equal(await liste(f), 1);
  } finally { f.close(); }
});

test('7 günden yeni paket ikisinde de sayılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f);
    await kargodaPaket(f, 'YENI', gunOnce(2));
    assert.equal(await rozet(f), 0);
    assert.equal(await liste(f), 0);
  } finally { f.close(); }
});

test('Koşul TEK YERDE: iki kaynak da ortak metni kullanıyor, kopyası kalmadı', () => {
  const sorgu = readFileSync(new URL('../src/orders-query.js', import.meta.url), 'utf8');
  const isListesi = readFileSync(new URL('../src/attention-api.js', import.meta.url), 'utf8');
  assert.match(sorgu, /export const YOLDA_DEGIL/, 'ortak koşul orders-query.js içinde durmalı');
  assert.match(sorgu, /watch==='long_shipping'\)add\("status='shipped' AND shipped_on<=\? AND "\+YOLDA_DEGIL/, 'süzgeç ortak koşulu kullanmalı');
  assert.match(isListesi, /import \{YOLDA_DEGIL\} from '\.\/orders-query\.js'/, 'iş listesi ortak koşulu içe almalı');
  assert.match(isListesi, /\$\{YOLDA_DEGIL\}\),0\) long_shipping/, 'rozet ortak koşulu kullanmalı');
  assert.ok(!/DUZELTME-CIFT-%'\)\),0\) long_shipping/.test(isListesi), 'kopya koşul metni kalmamalı');
});
