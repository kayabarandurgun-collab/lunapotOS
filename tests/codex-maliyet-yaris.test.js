// CODEX R02/R03 — yarış ve yarım işlem. Cron (15 dk) ve tarayıcı aynı adımı aynı anda ya da
// kesintiden sonra yeniden çalıştırabilir; nihai sonuç aynı, ikinci çalıştırma etkisiz olmalı.
// Yarış, seçilen SELECT'in bir bariyerde beklemesiyle; yarım işlem, belirli adımda hata
// enjeksiyonuyla üretilir. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {accountingApi} from '../src/accounting.js';
import {scopedDB} from '../src/scoped-db.js';
import {fifoRevalue} from '../src/fifo-cost.js';

// D1 benzeri sarmalayıcı: her okuma `kanca(sql)` bitene dek bekler; batch içteki ifadelerle çalışır.
function sarDB(inner, kanca = async () => {}) {
  return {
    prepare(sql) {
      const st = inner.prepare(sql);
      const w = {inner: st, bind(...a) { st.bind(...a); return w; },
        async first() { await kanca(sql); return st.first(); },
        async all() { await kanca(sql); return st.all(); },
        async run() { await kanca(sql); return st.run(); }};
      return w;
    },
    batch: items => inner.batch(items.map(i => i.inner || i))
  };
}
function bariyer(n) {
  let say = 0, ac; const p = new Promise(r => { ac = r; });
  return async () => { if (++say >= n) ac(); await p; };
}
// FIFO'yu tetiklemeyen doğrudan muhasebe çağrısı (yarışı elle kurmak için).
const dogrudan = f => (path, body) => accountingApi(new Request('https://test.local/api/accounting' + path, {method: body === undefined ? 'GET' : 'POST'}),
  {DB: scopedDB(f.env.DB, 'ec'), ROOT_DB: f.env.DB, WORKSPACE: 'ec'}, '/api/accounting' + path, async () => body);

async function alis(api, supplier, product, no, date, qty, unitNet) {
  const id = (await api('/invoices', {supplier_id: supplier, invoice_no: no, invoice_date: date, currency: 'TRY',
    lines: [{description: 'Torf 10 L', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, product_id: product, stock_quantity: qty}]})).id;
  await api('/invoices/' + id + '/post', {});
  const line = (await api('/invoices/' + id)).lines[0].id;
  await api('/invoices/' + id + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: line, quantity: qty}]});
}
const satis = (api, product, ref, date, qty = 1) => api('/sales', {channel: 'trendyol', external_id: ref, product_id: product, quantity: qty,
  revenue: 250 * qty, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: date});
const maliyet = (f, ref) => f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE external_id=?').get(ref).cost_cents;
const bakiye = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});
const say = (f, sql, ...a) => f.sqlite.prepare(sql).get(...a).n;

async function kur(f) {
  const api = dogrudan(f);
  const supplier = (await api('/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await api('/products', {name: 'Torf 10 L', sku: 'SNT-T10', stock_unit: 'adet', min_stock: 0})).id;
  await alis(api, supplier, product, 'B', '2026-08-01', 2, 150);
  await satis(api, product, 'S1', '2026-08-05');
  await fifoRevalue(f.env.DB, 8);
  assert.equal(maliyet(f, 'S1'), 15000);
  await alis(api, supplier, product, 'A', '2026-07-01', 1, 90);             // sonradan girilen eski fatura: ürün kirli
  return {api, supplier, product};
}

test('R02: aynı kirli ürünü iki FIFO aynı anda işlerse fark bir kez yazılır (150 → 90, 30 değil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product} = await kur(f);
    const bekle = bariyer(2);
    const db = sarDB(f.env.DB, async sql => { if (/FROM ec_stock_movements WHERE product_id/.test(sql)) await bekle(); });
    await Promise.all([fifoRevalue(db, 8), fifoRevalue(db, 8)]);
    assert.equal(maliyet(f, 'S1'), 9000, 'tek fark: 150 TL → 90 TL');
    assert.equal(say(f, "SELECT COUNT(*) n FROM ec_cost_revaluations WHERE sale_id=(SELECT id FROM ec_sale_entries WHERE external_id='S1')"), 1);
    assert.deepEqual(bakiye(f, product), {q: 2000, v: 30000}, 'kalan 2 adet 150 TL');
    const tekrar = await fifoRevalue(f.env.DB, 8);
    assert.equal(tekrar.changed, 0, 'tekrar sıfır fark');
    assert.equal(say(f, 'SELECT COUNT(*) n FROM ec_cost_dirty'), 0);
  } finally { f.close(); }
});

test('R02: hesap sırasında gelen yeni hareketin kirli işareti silinmez; sonraki tur doğru sonucu yazar', async () => {
  const f = appFixture(); await f.setup(); try {
    const {api, product} = await kur(f);
    let tetik = true;
    const db = sarDB(f.env.DB, async sql => {
      // FIFO hareketleri okuduktan hemen sonra aynı ürüne yeni satış gelir.
      if (tetik && /FROM ec_stock_movements WHERE product_id/.test(sql)) { tetik = false; await satis(api, product, 'S2', '2026-08-06'); }
    });
    await fifoRevalue(db, 8);
    assert.equal(say(f, 'SELECT COUNT(*) n FROM ec_cost_dirty'), 1, 'yeni nesil kuyrukta kaldı');
    await fifoRevalue(f.env.DB, 8);
    assert.equal(maliyet(f, 'S1'), 9000, 'S1 Temmuz alışından');
    assert.equal(maliyet(f, 'S2'), 15000, 'S2 Ağustos alışından');
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 15000});
    assert.equal((await fifoRevalue(f.env.DB, 8)).changed, 0);
  } finally { f.close(); }
});

test('R02: bozuk bir ürün FIFO kuyruğunun geri kalanını durdurmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {api, supplier, product} = await kur(f);
    const diger = (await api('/products', {name: 'Torf 20 L', sku: 'SNT-T20', stock_unit: 'adet', min_stock: 0})).id;
    await alis(api, supplier, diger, 'D', '2026-08-02', 1, 170);
    let gecti = false;
    const bozuk = sarDB(f.env.DB, async sql => { if (!gecti && sql.includes('FROM ec_stock_movements WHERE product_id')) { gecti = true; throw new Error('SENTETIK-OKUMA-HATASI'); } });
    const r = await fifoRevalue(bozuk, 8);
    assert.equal(r.products, 2);
    assert.equal(say(f, 'SELECT COUNT(*) n FROM ec_cost_dirty'), 1, 'yalnız hatalı ürün kuyrukta kaldı');
    await fifoRevalue(f.env.DB, 8);
    assert.equal(maliyet(f, 'S1'), 9000);
    assert.equal(say(f, 'SELECT COUNT(*) n FROM ec_cost_dirty'), 0);
    assert.equal(bakiye(f, product).v, 30000);
  } finally { f.close(); }
});

// ---- R03: mal kabulü + geçici sayım kapanışı yarım kalmamalı ----------------------------------

async function r03kur(f) {
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await f.ok('/ec/products', {name: 'Torf 210 L', sku: 'SNT-TS1', stock_unit: 'adet', min_stock: 0})).id;
  // Geçmiş: bu tedarikçinin satırı bu karta elle bağlanmış, 1 adet teslim alınmış.
  const eski = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'ESKI-1', uuid: '', invoice_date: '2026-09-01', currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 210 Litre', external_code: '', invoice_quantity: 1, invoice_unit: 'adet', net: 100, tax: 20, line_type: 'product', product_id: product, stock_quantity: 1}]})).id;
  await f.ok('/ec/invoices/' + eski + '/post', {});
  await f.ok('/ec/invoices/' + eski + '/receive', {occurred_on: '2026-09-01', reference: 'TESLIM-ESKI', lines: [{id: (await f.ok('/ec/invoices/' + eski)).lines[0].id, quantity: 1}]});
  // Mal fatura gelmeden raftaydı: geçici sayım +10.
  await f.ok('/ec/stock', {product_id: product, quantity: 11, unit_cost: 100, kind: 'count', reference: 'GECICI-SAYIM-TS1', notes: 'Fatura ay sonunda', occurred_on: '2026-09-05'});
  const taslak = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'AYSONU-10', uuid: '', invoice_date: '2026-09-15', currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 210 Litre', external_code: '', invoice_quantity: 10, invoice_unit: 'adet', net: 1000, tax: 200, line_type: 'product'}]})).id;
  return {supplier, product, taslak};
}
const iz = (f, product) => ({
  hareket: say(f, 'SELECT COUNT(*) n FROM ec_stock_movements WHERE product_id=?', product),
  kabul: say(f, 'SELECT COUNT(*) n FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id WHERE l.product_id=?', product),
  kapanis: say(f, "SELECT COUNT(*) n FROM ec_stock_movements WHERE product_id=? AND reference LIKE 'provisional-close:%'", product),
  deger: say(f, 'SELECT COUNT(*) n FROM ec_cost_revaluations WHERE product_id=?', product)});

test('R03: kapanış adımı hata verirse yeniden deneme tek kabul + tek kapanış bırakır (20 değil 11)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product, taslak} = await r03kur(f);
    assert.equal(bakiye(f, product).q, 11000);
    // Kapanış yazımının İLK INSERT'ünde bir kez hata: SQL metninde ya da bağlı parametrede provisional-close.
    const asil = f.env.DB; let kes = true;
    f.env.DB = {prepare(sql) {
      const st = asil.prepare(sql); let args = [];
      const dene = () => { if (kes && /INSERT INTO ec_stock_movements/.test(sql) && (sql.includes('provisional-close') || args.some(a => String(a).startsWith('provisional-close')))) { kes = false; throw new Error('SENTETIK-KAPANIS-HATASI'); } };
      const w = {bind(...a) { args = a; st.bind(...a); return w; }, all() { dene(); return st.all(); }, run() { dene(); return st.run(); }, first() { dene(); return st.first(); }};
      return w;
    }, batch: items => asil.batch(items)};
    const ilk = await f.ok('/ec/invoices/' + taslak + '/autocomplete', {});
    f.env.DB = asil;
    assert.equal(ilk.status, 'posted');
    const ikinci = await f.ok('/ec/invoices/' + taslak + '/autocomplete', {});
    assert.equal(ikinci.status, 'posted');
    assert.equal(bakiye(f, product).q, 11000, '1 eski + 10 geçici sayım; faturalı 10 adet ikinci kez stoğa girmedi');
    const once = iz(f, product);
    assert.equal(once.kabul, 2, 'eski + bu faturanın tek kabulü');
    assert.equal(once.kapanis, 1, 'tek kapanış');
    await f.ok('/ec/invoices/' + taslak + '/autocomplete', {});
    assert.deepEqual(iz(f, product), once, 'üçüncü çağrı yeni satır üretmez');
  } finally { f.close(); }
});

test('R03: eski sürümden kalan yarım iş (kabul var, kapanış yok) otomatik tamamlamada kapanır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {product, taslak} = await r03kur(f);
    // Eski kodun bıraktığı durum: fatura muhasebeleşmiş, kabul yazılmış, kapanış yazılamamış.
    const detay = await f.ok('/ec/invoices/' + taslak);
    f.sqlite.prepare('UPDATE ec_purchase_lines SET product_id=?,quantity_milli=10000 WHERE id=?').run(product, detay.lines[0].id);
    f.sqlite.prepare("UPDATE ec_purchase_invoices SET status='posted' WHERE id=?").run(taslak);
    f.sqlite.prepare("INSERT INTO ec_goods_receipts(id,line_id,quantity_milli,value_cents,occurred_on,reference) VALUES('yarim-kabul',?,10000,100000,'2026-09-15','Fatura ile teslim AYSONU-10')").run(detay.lines[0].id);
    assert.equal(bakiye(f, product).q, 21000, 'yarım durum: stok çift');
    const r = await f.ok('/ec/invoices/' + taslak + '/autocomplete', {});
    assert.equal(r.status, 'posted');
    assert.equal(bakiye(f, product).q, 11000, 'kapanış tamamlandı');
    const once = iz(f, product);
    assert.equal(once.kapanis, 1);
    await f.ok('/ec/invoices/' + taslak + '/autocomplete', {});
    assert.deepEqual(iz(f, product), once, 'tekrar etkisiz');
  } finally { f.close(); }
});
