// CODEX R07/R08/R15 — açık maliyet, iade ve tarihsel doldurma. Ölçülen: stok miktarı/değeri,
// satış/iade maliyeti, kapanış (settlement) kaynak kapasitesi ve ikinci FIFO turunun etkisizliği.
// Tutarlar KDV hariç kuruş. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {appFixture} from './helpers/app-fixture.js';
import * as fifo from '../src/fifo-cost.js';
const {fifoRevalue} = fifo;

async function kur(f) {
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await f.ok('/ec/products', {name: 'Torf 40 L', sku: 'SNT-T40', stock_unit: 'adet', min_stock: 0})).id;
  return {supplier, product};
}
async function alis(f, supplier, product, no, date, qty, unitNet) {
  const id = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: date, currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 40 L', external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, line_type: 'product', product_id: product, stock_quantity: qty}]})).id;
  await f.ok('/ec/invoices/' + id + '/post', {});
  await f.ok('/ec/invoices/' + id + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: (await f.ok('/ec/invoices/' + id)).lines[0].id, quantity: qty}]});
}
const satis = async (f, product, ref, date, qty = 1) => (await f.ok('/ec/sales', {channel: 'trendyol', external_id: ref, product_id: product, quantity: qty,
  revenue: 900 * qty, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: date})).id;
const iade = (f, sale, ref, date, qty = 1) => f.ok('/ec/sales/' + sale + '/return', {external_id: ref, quantity: qty, revenue: 900 * qty, restock: true, occurred_on: date});
const maliyet = (f, ref) => f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE external_id=?').get(ref).cost_cents;
const bakiye = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});
const acik = (f, ref) => f.sqlite.prepare('SELECT o.open_milli-o.settled_milli n FROM ec_open_costs o JOIN ec_sale_entries s ON s.id=o.sale_id WHERE s.external_id=?').get(ref)?.n ?? 0;
const netMaliyet = (f, p) => f.sqlite.prepare('SELECT COALESCE(SUM(cost_cents),0) n FROM ec_sale_entries WHERE product_id=?').get(p).n;
async function durgun(f) {
  const r = await fifoRevalue(f.env.DB, 50);
  assert.equal(r.changed, 0, 'ikinci FIFO turu yeni fark yazmaz');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cost_dirty').get().n, 0);
}

// ---- R07 ---------------------------------------------------------------------------------------

test('R07: maliyeti bilinen satışın fiziksel iadesi başka açık satışı kapatır; sıfır adette 100 TL kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 100);
    const s1 = await satis(f, product, 'S1', '2026-08-02');
    await satis(f, product, 'S2', '2026-08-03');                                // stoksuz: açık, tahmin 100
    assert.equal(acik(f, 'S2'), 1000);
    await iade(f, s1, 'IADE-S1', '2026-08-04');
    assert.equal(acik(f, 'S2'), 0, 'dönen mal S2\'nin açığını kapattı');
    assert.equal(maliyet(f, 'S2'), 10000, 'S2 gerçek maliyet');
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0}, 'fiziksel 0 adet, 0 değer');
    assert.equal(netMaliyet(f, product), 10000, 'giren tek adet bir kez maliyet oldu');
    const kapanis = f.sqlite.prepare('SELECT COUNT(*) n,SUM(quantity_milli) q FROM ec_cost_settlements WHERE product_id=?').get(product);
    assert.deepEqual({...kapanis}, {n: 1, q: 1000});
    await durgun(f);
  } finally { f.close(); }
});

test('R07: hiç stoktan çıkmamış açık kısmın iadesi başka satışı kapatmaz, değer yaratmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 100);
    const s1 = await satis(f, product, 'S1', '2026-08-02', 2);                 // 1 stoktan, 1 açık
    await satis(f, product, 'S2', '2026-08-03');                                // açık
    await iade(f, s1, 'IADE-S1', '2026-08-04');                                 // S1'in açık adedi geri geldi
    assert.equal(acik(f, 'S1'), 0);
    assert.equal(acik(f, 'S2'), 1000, 'S2 açık kalır: gerçek mal gelmedi');
    assert.deepEqual(bakiye(f, product), {q: -1000, v: 0});
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cost_settlements').get().n, 0);
    await durgun(f);
  } finally { f.close(); }
});

// ---- R08 ---------------------------------------------------------------------------------------

test('R08: kısmen açık satışın açık kısmı iade edilince miktar 0, değer 0; net maliyet 300 TL', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 100);
    await alis(f, supplier, product, 'B', '2026-08-02', 1, 200);
    const s = await satis(f, product, 'S3', '2026-08-03', 3);                  // 2 stoktan (300), 1 açık (tahmin 200)
    assert.equal(maliyet(f, 'S3'), 50000);
    await iade(f, s, 'IADE-1', '2026-08-04');
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0}, 'sıfır adette açıklanamayan değer yok');
    assert.equal(netMaliyet(f, product), 30000, 'satılan 2 adet: 100 + 200');
    assert.equal(acik(f, 'S3'), 0);
    await durgun(f);
  } finally { f.close(); }
});

test('R08: açık kısım önce kapanıp sonra iade edilirse değer ve miktar birlikte döner', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 100);
    await alis(f, supplier, product, 'B', '2026-08-02', 1, 200);
    const s = await satis(f, product, 'S3', '2026-08-03', 3);
    await alis(f, supplier, product, 'C', '2026-08-04', 1, 250);               // açık adet 250 ile kapandı
    assert.equal(maliyet(f, 'S3'), 55000);
    await iade(f, s, 'IADE-1', '2026-08-05');
    const b = bakiye(f, product);
    assert.equal(b.q, 1000);
    assert.equal(netMaliyet(f, product) + b.v, 55000, 'giren 550 TL = net satış maliyeti + stok');
    assert.equal(b.v, 18333, 'dönen adet satışın ortalama maliyetiyle');
    await durgun(f);
  } finally { f.close(); }
});

// ---- R15 ---------------------------------------------------------------------------------------

function goc(sadece) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  const dosyalar = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
  const uygula = f => sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  for (const f of dosyalar.filter(sadece)) uygula(f);
  return {sqlite, kalan: () => { for (const f of dosyalar.filter(f => !sadece(f))) uygula(f); }};
}
const d1 = sqlite => ({prepare(sql) { return {args: [], bind(...a) { this.args = a; return this; }, first() { return sqlite.prepare(sql).get(...this.args) || null; },
  all() { return {results: sqlite.prepare(sql).all(...this.args)}; }, run() { return sqlite.prepare(sql).run(...this.args); }}; },
  async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => s.all()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }});

test('R15: 0047 tarihsel doldurması ilk girişi kapasitesiz kullanır; önizleme gösterir, FIFO değeri uzlaştırır', async () => {
  const {sqlite, kalan} = goc(f => f < '0047');
  try {
    // 0047 öncesi: stoksuz iki satış maliyet 0 yazılmış; sonra 1'er adetlik iki alış gelmiş.
    sqlite.exec(`UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec';
      INSERT INTO ec_products(id,name,sku) VALUES('p','Torf 40 L','T40');
      INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES
       ('s1','trendyol','S1','p','sale',1000,90000,0,'confirmed','2026-07-01'),('s2','trendyol','S2','p','sale',1000,90000,0,'confirmed','2026-07-02');
      INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES
       ('m1','p',1000,10000,'purchase','m1','2026-07-03'),('m2','p',1000,15000,'purchase','m2','2026-07-04');`);
    kalan();
    const m1 = sqlite.prepare("SELECT COALESCE(SUM(quantity_milli),0) q FROM ec_cost_settlements WHERE source_id='m1'").get().q;
    assert.ok(m1 > 1000, 'yeniden üretim: 0047, 1 adetlik girişe ' + m1 / 1000 + ' adet kapanış bağladı');
    const db = d1(sqlite);
    const once = sqlite.prepare('SELECT (SELECT COUNT(*) FROM ec_cost_settlements)+(SELECT COUNT(*) FROM ec_cost_revaluations) n').get().n;
    const on = await fifo.gecmisKapasiteOnizleme(db);
    assert.equal(sqlite.prepare('SELECT (SELECT COUNT(*) FROM ec_cost_settlements)+(SELECT COUNT(*) FROM ec_cost_revaluations) n').get().n, once, 'önizleme yazmaz');
    const kaynak = on.sources.find(x => x.source_id === 'm1');
    assert.deepEqual([kaynak.capacity_milli, kaynak.settled_milli], [1000, 2000], 'kapasite aşımı görünür');
    assert.deepEqual(on.proposal.filter(x => x.product_id === 'p').map(x => [x.sale_id, x.source_id, x.quantity_milli, x.value_cents]),
      [['s1', 'm1', 1000, 10000], ['s2', 'm2', 1000, 15000]], 'tarih sırası ve kalan kapasiteyle tahsis');
    assert.deepEqual(await fifo.gecmisKapasiteOnizleme(db), on, 'tekrar aynı sonuç');
    await fifoRevalue(db, 50);
    assert.deepEqual({...sqlite.prepare("SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id='p'").get()}, {q: 0, v: 0}, 'sıfır adette değer kalmadı');
    assert.deepEqual(sqlite.prepare("SELECT cost_cents c FROM ec_sale_entries WHERE product_id='p' ORDER BY occurred_on").all().map(r => r.c), [10000, 15000]);
    assert.equal((await fifoRevalue(db, 50)).changed, 0);
  } finally { sqlite.close(); }
});

// ---- Geçiş dosyası ------------------------------------------------------------------------------

test('0049 geçişleri Wrangler ayrıştırıcısından eksiksiz geçer (tetik gövdeleri bölünmez)', () => {
  const dosyalar = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^0049.*\.sql$/.test(f));
  assert.ok(dosyalar.length >= 1, '0049 geçişi var');
  for (const d of dosyalar) {
    const sql = readFileSync(new URL('../migrations/' + d, import.meta.url), 'utf8');
    assert.ok(!/\bCASE\b/i.test(sql.replace(/--.*$/gm, '')), d + ': tetikte CASE yok (iif kullanılır)');
    for (const t of unstable_splitSqlQuery(sql).filter(q => /CREATE TRIGGER/i.test(q))) assert.match(t.trim(), /END;?$/, d + ': ' + t.slice(0, 60));
  }
});
