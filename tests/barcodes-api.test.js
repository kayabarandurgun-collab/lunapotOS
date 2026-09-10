import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

async function fixture() {
  const f = appFixture(); await f.setup();
  // Hammadde ve urun kartlari mevcut uretim yapisindan gelir; barkod ayri bir kart acmaz.
  f.sqlite.exec("INSERT INTO materials(id,name,unit,price) VALUES('torf','Torf 20 kg teneke','kg',12.5),('perlit','Perlit','kg',8)");
  f.sqlite.exec("INSERT INTO products(id,name,sku,stock_unit) VALUES('urun','Lunapot Saksi Topragi','LP-TOPRAK-5L','adet')");
  // Bakiye satiri hammadde eklenince tetikle acilir; miktari hareket tetigi yazar.
  f.sqlite.exec("INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES('mv1','torf',100000,125000,'receipt','GIRIS-1','Acilis girisi','2026-09-01')");
  return {f, torf: 'torf', perlit: 'perlit', urun: 'urun'};
}

const link = (material, extra = {}) => ({target_kind: 'material', material_id: material, code: '8690632012346', brand: 'Klasmann', pack_quantity: 20, pack_label: '20 kg teneke', ...extra});

test('Barkod var olan karta bağlanır ve bir okutmanın kaç kg ettiği saklanır', async () => {
  const {f, torf} = await fixture(); try {
    const kayit = await f.ok('/lp/barcodes', link(torf));
    assert.equal(kayit.code, '8690632012346');
    assert.equal(kayit.source, 'gs1', 'kontrol hanesi tutan kod GS1 sayılır');
    assert.equal(kayit.pack_quantity_milli, 20000);
    assert.equal(kayit.scan_quantity_milli, 20000, '1 okutma 1 kg değil 20 kg');
    assert.equal(kayit.pack_wording, '1 okutma = 20 kg');
    assert.equal(kayit.card_name, 'Torf 20 kg teneke');
    assert.equal(kayit.unit, 'kg');
  } finally { f.close(); }
});

test('Aynı barkod iki farklı karta bağlanamaz', async () => {
  const {f, torf, perlit, urun} = await fixture(); try {
    await f.ok('/lp/barcodes', link(torf));
    const ikinci = await f.req('/lp/barcodes', link(perlit));
    assert.equal(ikinci.status, 409);
    assert.match(ikinci.data.error, /Torf 20 kg teneke/, 'hangi karta bağlı olduğu söylenmeli');
    const urune = await f.req('/lp/barcodes', {target_kind: 'product', product_id: urun, code: '8690632012346'});
    assert.equal(urune.status, 409, 'ürün kartına da bağlanamaz');
    // Veritabanı da kabul etmez.
    assert.throws(() => f.sqlite.exec(`INSERT INTO lp_barcodes(id,code,target_kind,material_id) VALUES('x','8690632012346','material','${perlit}')`), /UNIQUE/);
  } finally { f.close(); }
});

test('Bir kartın birden çok barkodu olabilir; farklı ambalajlar ayrı bağlantıdır', async () => {
  const {f, torf} = await fixture(); try {
    const teneke = await f.ok('/lp/barcodes', link(torf));
    const poset = await f.ok('/lp/barcodes', link(torf, {code: '4006381333931', pack_quantity: 1, pack_label: '1 kg poşet', brand: 'Klasmann'}));
    assert.equal(teneke.scan_quantity_milli, 20000);
    assert.equal(poset.scan_quantity_milli, 1000);
    const liste = await f.ok('/lp/barcodes');
    assert.equal(liste.barcodes.filter(b => b.material_id === torf).length, 2);
  } finally { f.close(); }
});

test('Baştaki sıfırlar korunur ve kod sayıya çevrilmez', async () => {
  const {f, torf} = await fixture(); try {
    const kayit = await f.ok('/lp/barcodes', link(torf, {code: '0000123456789'}));
    assert.equal(kayit.code, '0000123456789');
    const okuma = await f.ok('/lp/barcodes/lookup?code=0000123456789');
    assert.equal(okuma.found, true);
    assert.equal(okuma.link.code, '0000123456789');
    // Sıfırsız hâli BAŞKA bir barkoddur ve bulunmaz.
    assert.equal((await f.ok('/lp/barcodes/lookup?code=123456789')).found, false);
  } finally { f.close(); }
});

test('Okutma yalnızca arar: stok ve hareket değişmez', async () => {
  const {f, torf} = await fixture(); try {
    await f.ok('/lp/barcodes', link(torf));
    const once = {
      miktar: f.sqlite.prepare('SELECT quantity_milli q FROM lp_material_balances WHERE material_id=?').get(torf).q,
      hareket: f.sqlite.prepare('SELECT COUNT(*) c FROM lp_material_movements').get().c
    };
    for (let i = 0; i < 5; i++) await f.ok('/lp/barcodes/lookup?code=8690632012346');
    const sonra = {
      miktar: f.sqlite.prepare('SELECT quantity_milli q FROM lp_material_balances WHERE material_id=?').get(torf).q,
      hareket: f.sqlite.prepare('SELECT COUNT(*) c FROM lp_material_movements').get().c
    };
    assert.deepEqual(sonra, once, 'beş kez okutmak stoğu değiştirmemeli');
    const okuma = await f.ok('/lp/barcodes/lookup?code=8690632012346');
    assert.equal(okuma.stock.quantity_milli, 100000, 'depodaki miktar görünmeli');
    assert.match(okuma.notice, /Stok bu ekranda değişmez/);
  } finally { f.close(); }
});

test('Bilinmeyen barkod kart açmaz, ne yapılacağını sorar', async () => {
  const {f} = await fixture(); try {
    const okuma = await f.ok('/lp/barcodes/lookup?code=5901234123457');
    assert.equal(okuma.found, false);
    assert.equal(okuma.classification.gs1, true, 'geçerli GS1 olduğu söylenir');
    assert.deepEqual(okuma.options, ['Var olan bir karta bağla', 'Yeni kart aç ve sonra bağla']);
    assert.match(okuma.notice, /Kart kendiliğinden açılmaz/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) c FROM materials').get().c, 2, 'okutma yeni kart oluşturmamalı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) c FROM lp_barcodes').get().c, 0);
  } finally { f.close(); }
});

test('İç kullanım kodu sistemce üretilir ve GS1 diye sunulmaz', async () => {
  const {f, torf} = await fixture(); try {
    const kayit = await f.ok('/lp/barcodes', {target_kind: 'material', material_id: torf, generate_internal: true, pack_label: 'Etiketsiz ürün'});
    assert.match(kayit.code, /^LP-[0-9A-F]{10}$/);
    assert.equal(kayit.source, 'internal');
    assert.equal(kayit.classification.gs1, false);
    assert.match(kayit.classification.note, /GS1 barkodu değildir/);
    // Elle "LP-" kodu yazılamaz: iç kodlar yalnızca sistemce üretilir.
    assert.equal((await f.req('/lp/barcodes', link(torf, {code: 'LP-1234567890'}))).status, 400);
  } finally { f.close(); }
});

test('Kontrol hanesi tutmayan kod saklanır ama GS1 sayılmaz', async () => {
  const {f, torf} = await fixture(); try {
    const kayit = await f.ok('/lp/barcodes', link(torf, {code: '9780143007235'}));
    assert.equal(kayit.code, '9780143007235');
    assert.equal(kayit.source, 'other', 'GS1 diye işaretlenmemeli');
    assert.match(kayit.classification.note, /GS1 barkodu olarak sunulmaz/);
  } finally { f.close(); }
});

test('Barkodun kendisi ve bağlı kart sonradan değiştirilemez', async () => {
  const {f, torf, perlit} = await fixture(); try {
    const kayit = await f.ok('/lp/barcodes', link(torf));
    const guncel = await f.ok('/lp/barcodes/' + kayit.id, {brand: 'Yeni marka', pack_quantity: 25, pack_label: '25 kg', active: false});
    assert.equal(guncel.brand, 'Yeni marka');
    assert.equal(guncel.pack_quantity_milli, 25000);
    assert.equal(guncel.active, 0);
    assert.equal(guncel.code, '8690632012346', 'kod değişmedi');
    assert.throws(() => f.sqlite.exec(`UPDATE lp_barcodes SET material_id='${perlit}' WHERE id='${kayit.id}'`), /BARCODE_RELINK/);
    assert.throws(() => f.sqlite.exec(`UPDATE lp_barcodes SET code='111' WHERE id='${kayit.id}'`), /BARCODE_RELINK/);
    const kapali = await f.ok('/lp/barcodes/lookup?code=8690632012346');
    assert.equal(kapali.active, false);
    assert.match(kapali.notice, /bağlantısı kapalı/);
  } finally { f.close(); }
});

test('Barkod yönetimi e-ticaret alanında bulunmaz ve yetki ister', async () => {
  const {f, torf} = await fixture(); try {
    assert.equal((await f.req('/ec/barcodes')).status, 403, 'barkod yalnızca üretim modülünde');
    assert.equal((await f.req('/ec/barcodes/lookup?code=8690632012346')).status, 403);

    const depo = await f.ok('/admin/users', {name: 'Depo', username: 'depo', permissions: {ec: {}, lp: {materialstock: 'write'}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: depo.invite_path.split('invite=')[1], password: 'depo-personel-sifresi'});
    const depoLogin = await f.req('/auth/login', {username: 'depo', password: 'depo-personel-sifresi'});
    const eklendi = await f.req('/lp/barcodes', link(torf), depoLogin.cookie);
    assert.equal(eklendi.status, 200, 'depo yetkisi barkod bağlayabilmeli');
    assert.equal((await f.req('/lp/barcodes/' + eklendi.data.id, undefined, depoLogin.cookie)).status, 404, 'GET tek kayıt ucu yok');

    const okuyucu = await f.ok('/admin/users', {name: 'Reçeteci', username: 'recete', permissions: {ec: {}, lp: {recipes: 'read'}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: okuyucu.invite_path.split('invite=')[1], password: 'recete-personel-sifresi'});
    const okuyucuLogin = await f.req('/auth/login', {username: 'recete', password: 'recete-personel-sifresi'});
    assert.equal((await f.req('/lp/barcodes/lookup?code=8690632012346', undefined, okuyucuLogin.cookie)).status, 200, 'kart görebilen okutabilmeli');
    assert.equal((await f.req('/lp/barcodes', link(torf, {code: '4006381333931'}), okuyucuLogin.cookie)).status, 403, 'yalnızca okuma yetkisi bağlantı kuramaz');
  } finally { f.close(); }
});
