import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {appFixture} from './helpers/app-fixture.js';
import {itemPlan, splitRevenue, netOf, reservationStatements, saleStatements} from '../src/webshop-ledger.js';

// Web siparişinin gerçek stok ve satış defterine yazılması — CANLI GEÇİŞ YOLU.
// Uygulamada bugün hiçbir sipariş is_test=0 olamaz (CHECK). Bu yolu sınamak için yalnızca test
// veritabanında kısıt geçici olarak devre dışı bırakılır (webshop-catalog testindeki yöntem).
const vat = (f, product, bps = 2000) => f.sqlite.prepare(
  "INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,0,0,0,0,100,100,100,500,1)"
).run(product, bps);

function seed(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('ec-luna','Luna Küçük','LN-S','adet'),('ec-toprak','Toprak 5 L','TP-05','adet')");
  f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('m1','ec-luna',10000,100000,'opening','ACILIS-1','2026-09-01'),('m2','ec-toprak',20000,40000,'opening','ACILIS-2','2026-09-01')");
  vat(f, 'ec-luna'); vat(f, 'ec-toprak');
  f.sqlite.exec("INSERT INTO ws_catalog VALUES('luna-kucuk','luna','Luna','Küçük','luna.webp','saksı',15000,5,1),('set-luna','set','Luna + toprak','Set','set.webp','set',27000,5,1)");
  f.sqlite.exec("INSERT INTO ws_variant_components(id,variant_id,product_id,quantity_milli,revenue_share_bps) VALUES('vc1','luna-kucuk','ec-luna',1000,NULL),('vc2','set-luna','ec-luna',1000,7000),('vc3','set-luna','ec-toprak',2000,3000)");
  f.sqlite.exec("INSERT INTO ws_customers(id,email,name,salt,password_hash) VALUES('c1','a@example.test','A','s','h')");
}

function order(f, id, {live = true, items = [['luna-kucuk', 2, 15000]]} = {}) {
  const subtotal = items.reduce((s, [, q, p]) => s + q * p, 0);
  f.sqlite.prepare("INSERT INTO ws_quotes(id,customer_id,snapshot_json,expires_at) VALUES(?,'c1','{}',9999999999)").run('q-' + id);
  if (live) f.sqlite.exec('PRAGMA ignore_check_constraints=ON');
  f.sqlite.prepare("INSERT INTO ws_orders(id,number,customer_id,quote_id,status,payment_status,subtotal_cents,shipping_cents,total_cents,snapshot_json,legal_version,accepted_at,is_test) VALUES(?,?,'c1',?,'preparing','demo_paid',?,0,?,'{}','v','x',?)")
    .run(id, 'W-' + id, 'q-' + id, subtotal, subtotal, live ? 0 : 1);
  if (live) f.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
  items.forEach(([variant, qty, price], i) => f.sqlite.prepare("INSERT INTO ws_order_items(id,order_id,variant_id,name,size,qty,price_cents) VALUES(?,?,?,?,?,?,?)")
    .run(id + '-i' + i, id, variant, variant, 'x', qty, price));
  return {...f.sqlite.prepare('SELECT * FROM ws_orders WHERE id=?').get(id)};
}
const balance = (f, p) => f.sqlite.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(p).quantity_milli;
const sales = f => f.sqlite.prepare("SELECT channel,external_id,product_id,quantity_milli,revenue_cents,cost_cents,fees_status FROM ec_sale_entries ORDER BY product_id").all().map(r => ({...r}));

async function fixture() { const f = appFixture(); await f.setup(); seed(f); return f; }

test('Net gelir KDV hariçtir ve paylara kuruş kaybı olmadan bölünür', () => {
  assert.equal(netOf(30000, 2000), 25000);
  assert.deepEqual(splitRevenue(22500, [7000, 3000]), [15750, 6750]);
  const parts = splitRevenue(10001, [3333, 3333, 3334]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10001);
});

test('Test siparişi gerçek stok ve satış defterine yazılamaz', async () => {
  const f = await fixture(); try {
    const o = order(f, 'test1', {live: false});
    await assert.rejects(saleStatements(f.env.DB, o, '2026-09-11'), e => e.status === 409);
    await assert.rejects(reservationStatements(f.env.DB, o), e => e.status === 409);
    assert.throws(() => f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('s-x','other','web:x','ec-luna','sale',1000,1,1,'pending','2026-09-11')") ||
      f.sqlite.exec("INSERT INTO ws_sale_links(id,order_id,order_item_id,product_id,sale_id) VALUES('l','test1','test1-i0','ec-luna','s-x')"), /WS_TEST_ORDER_LEDGER/);
  } finally { f.close(); }
});

test('Canlı sipariş: ayırma pazaryeri çıkışını durdurur, sevkte satış yazılır ve ayırma kalkar; ikinci kayıt olmaz', async () => {
  const f = await fixture(); try {
    const db = f.env.DB, o = order(f, 'live1');
    await db.batch(await reservationStatements(db, o));
    assert.equal(f.sqlite.prepare("SELECT SUM(quantity_milli) n FROM ws_stock_reservations WHERE order_id='live1' AND released_on IS NULL").get().n, 2000);
    assert.throws(() => f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('mp','ec-luna',-9000,-90000,'sale','TY-1','2026-09-02')"), /STOCK_RESERVED/,
      'web ayırması başka kanaldan tüketilemez');

    await db.batch(await saleStatements(db, o, '2026-09-11'));
    assert.deepEqual(sales(f), [{channel: 'other', external_id: 'web:W-live1:live1-i0:ec-luna', product_id: 'ec-luna', quantity_milli: 2000, revenue_cents: 25000, cost_cents: 20000, fees_status: 'pending'}]);
    assert.equal(balance(f, 'ec-luna'), 8000, 'stok çıkışı mevcut satış tetiğiyle yazılır');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ws_stock_reservations WHERE order_id='live1' AND released_on IS NULL").get().n, 0);
    await assert.rejects(async () => db.batch(await saleStatements(db, o, '2026-09-11')), /UNIQUE/, 'aynı sipariş ikinci kez deftere yazılmaz');
    assert.equal(balance(f, 'ec-luna'), 8000);
  } finally { f.close(); }
});

test('Set satışı bileşenlere gelir payı oranında ve kart başına miktarla yazılır', async () => {
  const f = await fixture(); try {
    const db = f.env.DB, o = order(f, 'set1', {items: [['set-luna', 1, 27000]]});
    await db.batch(await saleStatements(db, o, '2026-09-11'));
    const rows = sales(f);
    assert.deepEqual(rows.map(r => [r.product_id, r.quantity_milli, r.revenue_cents]), [['ec-luna', 1000, 15750], ['ec-toprak', 2000, 6750]]);
    assert.equal(rows.reduce((s, r) => s + r.revenue_cents, 0), netOf(27000, 2000));
  } finally { f.close(); }
});

test('Eksik gelir payı, karışık KDV ve eşlenmemiş ürün satışı durdurur', async () => {
  const f = await fixture(); try {
    const db = f.env.DB;
    f.sqlite.exec("UPDATE ws_variant_components SET revenue_share_bps=NULL WHERE id='vc3'");
    await assert.rejects(itemPlan(db, null, [{variant_id: 'set-luna', qty: 1, name: 'Set', size: 'x'}]), /gelir payları/);
    f.sqlite.exec("UPDATE ws_variant_components SET revenue_share_bps=3000 WHERE id='vc3'; UPDATE ec_price_profiles SET vat_bps=1000 WHERE product_id='ec-toprak'");
    await assert.rejects(itemPlan(db, null, [{variant_id: 'set-luna', qty: 1, name: 'Set', size: 'x'}]), /KDV/);
    f.sqlite.exec("INSERT INTO ws_catalog VALUES('bos','x','Boş','x','x.webp','x',1000,5,1)");
    await assert.rejects(itemPlan(db, null, [{variant_id: 'bos', qty: 1, name: 'Boş', size: 'x'}]), /bağlanmadı/);
  } finally { f.close(); }
});

test('Yönetim sevk ucu: canlı siparişte satışı yazar, test siparişinde deftere dokunmaz', async () => {
  const f = await fixture(); try {
    f.env.WS_MODE = 'demo';
    const {cookie} = await f.req('/auth/login', {username: 'admin', password: 'synthetic-owner-password'});
    const ship = id => worker.fetch(new Request(`http://localhost/api/webshop/orders/${id}`, {method: 'POST',
      headers: {Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: cookie},
      body: JSON.stringify({status: 'shipped', carrier: 'Test Kargo', tracking: 'TK-1'})}), f.env);

    // Yönetim ucu yalnızca UUID biçimli sipariş kimliği kabul eder.
    const [T2, L2, L3] = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013'];
    order(f, T2, {live: false});
    assert.equal((await ship(T2)).status, 200);
    assert.equal(sales(f).length, 0, 'test siparişi deftere yazılmaz');
    assert.equal(balance(f, 'ec-luna'), 10000);

    order(f, L2);
    assert.equal((await ship(L2)).status, 200);
    assert.deepEqual(sales(f).map(r => [r.product_id, r.quantity_milli, r.revenue_cents]), [['ec-luna', 2000, 25000]]);
    assert.equal(balance(f, 'ec-luna'), 8000);

    // Gerçek stok yetmezse sevk kaydı hiç yazılmaz (sipariş durumu da değişmez).
    // (ws_catalog.stock eski TEST stoğudur; kalem eklenirken düşer. Gerçek stok kontrolünü sınamak için yükseltilir.)
    f.sqlite.exec("UPDATE ws_catalog SET stock=50 WHERE id='luna-kucuk'");
    order(f, L3, {items: [['luna-kucuk', 9, 15000]]});
    const refused = await ship(L3);
    assert.equal(refused.status, 409);
    assert.equal(f.sqlite.prepare('SELECT status FROM ws_orders WHERE id=?').get(L3).status, 'preparing');
  } finally { f.close(); }
});
