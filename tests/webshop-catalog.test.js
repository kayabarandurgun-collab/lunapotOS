import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {appFixture} from './helpers/app-fixture.js';
import {sellableUnits, variantBlockers} from '../src/webshop-catalog.js';

// E-ticaret stok kartı + fiyat profili + web varyantı. Stok gerçek hareketle (opening) açılır.
function seed(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('ec-luna','Luna Gümüş Küçük','LN-S-01','adet'),('ec-toprak','Saksı Toprağı 5 L','TP-05','adet')");
  f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('m1','ec-luna',10000,100000,'opening','ACILIS-1','2026-09-01'),('m2','ec-toprak',30000,60000,'opening','ACILIS-2','2026-09-01')");
  f.sqlite.exec("INSERT INTO products(id,name,sku,stock_unit) VALUES('lp-urun','Üretim kartı','LP-X','adet')");
  f.sqlite.exec("INSERT INTO ws_catalog VALUES('luna-kucuk','luna','Luna','Küçük','luna-silver.webp','saksı',15000,5,1),('set-ikili','set','Toprak ikili set','2 × 5 L','soil.webp','toprak',9000,5,1)");
}
const vat = (f, product, bps = 2000) => f.sqlite.prepare(
  "INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,0,0,0,0,100,100,100,500,1)"
).run(product, bps);

async function owner() {
  const f = appFixture(); await f.setup(); seed(f);
  f.env.WS_MODE = 'demo';
  const login = await f.req('/auth/login', {username: 'admin', password: 'synthetic-owner-password'});
  const cookie = login.cookie;
  // Eşleme yazımı yalnızca yerel demo hostta açıktır.
  const local = (path, body, auth = cookie) => worker.fetch(new Request('http://localhost/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: auth},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }), f.env).then(async r => ({status: r.status, data: await r.json()}));
  return {f, local, cookie};
}

test('Satılabilir adet bileşenlerin en kısıtlayıcısıdır ve ayırmalar düşülür', () => {
  assert.equal(sellableUnits([]), null, 'eşleme yoksa adet bilinmiyor, sıfır değil');
  assert.equal(sellableUnits([{balance_milli: 10000, ec_reserved_milli: 0, ws_reserved_milli: 0, quantity_milli: 1000}]), 10);
  // 2'li set: aynı karttan 2 birim → 30 birimden 15 set
  assert.equal(sellableUnits([{balance_milli: 30000, quantity_milli: 2000}]), 15);
  // Pazaryeri 4, web 3 birim ayırmışsa 10 birimden 3 kalır
  assert.equal(sellableUnits([{balance_milli: 10000, ec_reserved_milli: 4000, ws_reserved_milli: 3000, quantity_milli: 1000}]), 3);
  // En kısıtlayıcı bileşen belirler
  assert.equal(sellableUnits([{balance_milli: 10000, quantity_milli: 1000}, {balance_milli: 3000, quantity_milli: 2000}]), 1);
  assert.equal(sellableUnits([{balance_milli: 1000, ec_reserved_milli: 5000, quantity_milli: 1000}]), 0, 'eksiye düşmez');

  assert.deepEqual(variantBlockers({active: 1}, []), ['Gerçek stok kartına bağlanmadı.']);
  assert.match(variantBlockers({active: 1}, [{product_name: 'X', vat_bps: null, balance_milli: 5000, quantity_milli: 1000}]).join(' '), /KDV oranı tanımlı değil: X/);
});

test('Hazırlık ekranı eşlenmemiş varyantı ve eksik KDV\'yi engel olarak gösterir', async () => {
  const {f, local} = await owner(); try {
    const once = await local('/webshop/catalog/readiness');
    assert.equal(once.status, 200);
    const luna = once.data.items.find(i => i.id === 'luna-kucuk');
    assert.equal(luna.ready, false);
    assert.equal(luna.sellable_units, null, 'eşleme yokken satılabilir adet uydurulmaz');
    assert.deepEqual(luna.blockers, ['Gerçek stok kartına bağlanmadı.']);
    assert.equal(once.data.summary.unmapped, 2);

    const eslendi = await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 1}]});
    assert.equal(eslendi.status, 200);
    assert.equal(eslendi.data.sellable_units, 10, 'gerçek e-ticaret bakiyesinden gelir');
    assert.equal(eslendi.data.test_stock, 5, 'test stoğu ayrı durur ve gerçek sayılmaz');
    assert.match(eslendi.data.blockers.join(' '), /KDV oranı tanımlı değil/, 'KDV sıfır varsayılmaz');

    vat(f, 'ec-luna', 2000);
    const hazir = (await local('/webshop/catalog/readiness')).data.items.find(i => i.id === 'luna-kucuk');
    assert.equal(hazir.ready, true);
    assert.equal(hazir.vat_bps, 2000, 'KDV fiyat profilinden gelir');
  } finally { f.close(); }
});

test('Set eşlemesi ambalaj dönüşümünü taşır', async () => {
  const {f, local} = await owner(); try {
    vat(f, 'ec-toprak', 1000);
    const set = await local('/webshop/catalog/set-ikili/components', {components: [{product_id: 'ec-toprak', quantity: 2}]});
    assert.equal(set.data.sellable_units, 15, '30 torbadan 15 ikili set');
    assert.equal(set.data.ready, true);
    // Eşleme bütün olarak değişir
    const tekli = await local('/webshop/catalog/set-ikili/components', {components: [{product_id: 'ec-toprak', quantity: 1}]});
    assert.equal(tekli.data.components.length, 1);
    assert.equal(tekli.data.sellable_units, 30);
  } finally { f.close(); }
});

test('Eşleme yalnızca e-ticaret kartına, yalnızca yönetici ve yerel demo ortamında yapılır', async () => {
  const {f, local} = await owner(); try {
    assert.equal((await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'lp-urun', quantity: 1}]})).status, 404, 'üretim kartı web mağazaya bağlanmaz');
    assert.equal((await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 1}, {product_id: 'ec-luna', quantity: 1}]})).status, 400);
    assert.equal((await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 0}]})).status, 400);
    assert.equal((await local('/webshop/catalog/yok/components', {components: []})).status, 404);

    const staff = await f.ok('/admin/users', {name: 'Mağaza', username: 'magaza', permissions: {ec: {webshop: 'write'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'magaza-personel-sifresi'});
    const staffLogin = await f.req('/auth/login', {username: 'magaza', password: 'magaza-personel-sifresi'});
    assert.equal((await local('/webshop/catalog/readiness', undefined, staffLogin.cookie)).status, 200, 'web mağaza yetkisi hazırlığı görebilir');
    assert.equal((await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 1}]}, staffLogin.cookie)).status, 403, 'eşlemeyi yalnızca yönetici değiştirir');

    f.env.WS_MODE = undefined;
    assert.equal((await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 1}]})).status, 503, 'canlı ortamda eşleme yazılmaz');
  } finally { f.close(); }
});

// Canlıya geçiş yolunu sınamak için bir siparişi is_test=0 yapmak gerekir. Bu, ws_orders'taki
// CHECK(is_test=1) kısıtı yüzünden uygulamada İMKÂNSIZDIR; yalnızca bu test veritabanında kısıt
// geçici olarak devre dışı bırakılır.
function orders(f) {
  f.sqlite.exec("INSERT INTO ws_customers(id,email,name,salt,password_hash) VALUES('c1','a@example.test','A','s','h')");
  f.sqlite.exec("INSERT INTO ws_quotes(id,customer_id,snapshot_json,expires_at) VALUES('q-test','c1','{}',9999999999),('q-canli','c1','{}',9999999999)");
  f.sqlite.exec("INSERT INTO ws_orders(id,number,customer_id,quote_id,subtotal_cents,shipping_cents,total_cents,snapshot_json,legal_version,accepted_at) VALUES('o-test','T-1','c1','q-test',100,0,100,'{}','v','x')");
  f.sqlite.exec('PRAGMA ignore_check_constraints=ON');
  f.sqlite.exec("INSERT INTO ws_orders(id,number,customer_id,quote_id,subtotal_cents,shipping_cents,total_cents,snapshot_json,legal_version,accepted_at,is_test) VALUES('o-canli','C-1','c1','q-canli',100,0,100,'{}','v','x',0)");
  f.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
}
const reserve = (f, id, order, qty) => f.sqlite.prepare("INSERT INTO ws_stock_reservations(id,order_id,product_id,quantity_milli) VALUES(?,?,'ec-luna',?)").run(id, order, qty);
const sell = (f, ref, qty) => f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,'ec-luna',?,?,'sale',?,'2026-09-02')").run(ref, -qty, -qty * 10, ref);

test('Test siparişi gerçek stok kartından ayırma yapamaz', async () => {
  const {f} = await owner(); try {
    orders(f);
    assert.throws(() => reserve(f, 'r0', 'o-test', 1000), /WS_TEST_ORDER_REAL_STOCK/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ws_stock_reservations').get().n, 0);
  } finally { f.close(); }
});

test('Canlı geçiş yolu: web ayırması pazaryeri stok çıkışını durdurur, iptal serbest bırakır', async () => {
  const {f} = await owner(); try {
    orders(f);
    // 10 birim var; web siparişi 8 birim ayırır.
    reserve(f, 'r1', 'o-canli', 8000);
    assert.throws(() => reserve(f, 'r2', 'o-canli', 1000), /UNIQUE/, 'aynı siparişte aynı kart iki kez ayrılmaz');
    // Pazaryerinden 5 birim çıkış 10−5=5 < 8 ayırma → durdurulur.
    assert.throws(() => sell(f, 'SATIS-1', 5000), /STOCK_RESERVED/, 'web\'in ayırdığı stok başka kanaldan tüketilemez');
    // 2 birim çıkış 10−2=8 ≥ 8 → izin verilir.
    sell(f, 'SATIS-2', 2000);
    // Ayırma kaydı değiştirilemez, silinemez.
    assert.throws(() => f.sqlite.exec("UPDATE ws_stock_reservations SET quantity_milli=1 WHERE id='r1'"), /WS_RESERVATION_IMMUTABLE/);
    assert.throws(() => f.sqlite.exec("DELETE FROM ws_stock_reservations WHERE id='r1'"), /IMMUTABLE_LEDGER/);
    // İptal: ayırma bir kez serbest kalır, sonra çıkış yapılabilir.
    f.sqlite.exec("UPDATE ws_orders SET status='cancelled' WHERE id='o-canli'");
    assert.ok(f.sqlite.prepare("SELECT released_on FROM ws_stock_reservations WHERE id='r1'").get().released_on);
    sell(f, 'SATIS-3', 5000);
    assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM ec_stock_balances WHERE product_id='ec-luna'").get().q, 3000);
  } finally { f.close(); }
});

test('Mevcut stoktan fazla web ayırması yapılamaz', async () => {
  const {f} = await owner(); try {
    orders(f);
    assert.throws(() => reserve(f, 'r3', 'o-canli', 11000), /WS_STOCK_UNAVAILABLE/, '10 birimden 11 ayrılamaz');
    reserve(f, 'r4', 'o-canli', 10000);
  } finally { f.close(); }
});

test('Eşleme seçenekleri yalnızca yöneticiye ve yalnızca e-ticaret kartlarından verilir', async () => {
  const {f, local} = await owner(); try {
    const r = await local('/webshop/catalog/readiness');
    const ids = r.data.candidates.map(c => c.id);
    assert.ok(ids.includes('ec-luna') && ids.includes('ec-toprak'));
    assert.ok(!ids.includes('lp-urun'), 'üretim kartı aday listesinde yer almaz');
    const staff = await f.ok('/admin/users', {name: 'Mağaza', username: 'magaza2', permissions: {ec: {webshop: 'write'}, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'magaza-personel-sifresi'});
    const login = await f.req('/auth/login', {username: 'magaza2', password: 'magaza-personel-sifresi'});
    const seen = await local('/webshop/catalog/readiness', undefined, login.cookie);
    assert.equal(seen.status, 200);
    assert.equal(seen.data.candidates, undefined, 'personel kart listesini almaz');
  } finally { f.close(); }
});

test('Set eşlemesinde gelir payları toplamı %100 olmak zorunda; hazırlık eksik payı engel sayar', async () => {
  const {f, local} = await owner(); try {
    const url = '/webshop/catalog/set-ikili/components';
    assert.equal((await local(url, {components: [{product_id: 'ec-luna', quantity: 1}, {product_id: 'ec-toprak', quantity: 2}]})).status, 400, 'pay yoksa reddedilir');
    assert.equal((await local(url, {components: [{product_id: 'ec-luna', quantity: 1, share: 60}, {product_id: 'ec-toprak', quantity: 2, share: 30}]})).status, 400, 'toplam %90');
    const ok = await local(url, {components: [{product_id: 'ec-luna', quantity: 1, share: 70}, {product_id: 'ec-toprak', quantity: 2, share: 30}]});
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data.components.map(c => [c.product_id, c.revenue_share_bps]).sort(), [['ec-luna', 7000], ['ec-toprak', 3000]]);
    assert.ok(!ok.data.blockers.some(b => /gelir payları/.test(b)));
    const single = await local('/webshop/catalog/luna-kucuk/components', {components: [{product_id: 'ec-luna', quantity: 1, share: 40}]});
    assert.equal(single.data.components[0].revenue_share_bps, null, 'tek kartta pay %100 sayılır');
    f.sqlite.exec("UPDATE ws_variant_components SET revenue_share_bps=NULL WHERE variant_id='set-ikili' AND product_id='ec-toprak'");
    const r = await local('/webshop/catalog/readiness');
    assert.ok(r.data.items.find(i => i.id === 'set-ikili').blockers.some(b => /gelir payları/.test(b)));
  } finally { f.close(); }
});
