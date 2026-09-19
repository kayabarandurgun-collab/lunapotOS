// R25 — Yeni uçların yetki rota eşlemeleri. "Kaça satmalıyım" (fiyat-hesap) fiyat ekranının,
// ürün kârlılığı (urun-karlilik) stok ekranının arka plan isteğidir. Ekranı okuyabilen personel
// ilgili GET ucunu da aynı yetkiyle kullanmalı; yetkisiz personel 403 almalı. Okuma yazmaya
// dönüşmez, tutar yetkisi kapalıysa para alanları gizli kalır, yönetici davranışı değişmez.
// Owner erken dönüşü sorunu gizlediği için hem saf `permit` hem gerçek istek yolu denenir.
// TEMSİLİ veri; gerçek pazaryeri dosyası değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {permit, scrubAmounts} from '../src/permission-policy.js';
import {parsePermissions} from '../public/permissions.js';

const D = '2026-09-10';
const personel = ec => ({owner: false, name: 'P', ec_access: Object.values(ec).includes('write') ? 'write' : 'read', lp_access: 'read',
  permissions: parsePermissions({ec, lp: {products: 'read'}})});
const gecer = (u, path, method = 'GET') => assert.doesNotThrow(() => permit(u, path, method), path + ' ' + method + ' açık olmalı');
const kapali = (u, path, method = 'GET') => assert.throws(() => permit(u, path, method), e => e.status === 403, path + ' ' + method + ' kapalı olmalı');

test('R25 saf permit: fiyat okuma fiyat-hesap GET, stok okuma urun-karlilik GET açar; çapraz ve yazma kapalı', () => {
  const fiyatci = personel({pricing: 'read'}), depocu = personel({stock: 'read'}), siparisci = personel({orders: 'write'});
  gecer(fiyatci, '/api/ec/pricing');                // mevcut eşleme: kıyas noktası
  gecer(fiyatci, '/api/ec/fiyat-hesap');
  gecer(fiyatci, '/api/ec/fiyat-hesap', 'HEAD');
  kapali(fiyatci, '/api/ec/fiyat-hesap', 'POST');   // okuma yazmaya dönüşmez
  kapali(fiyatci, '/api/ec/urun-karlilik');         // fiyat yetkisi stok/kâr ekranını açmaz
  gecer(depocu, '/api/ec/urun-karlilik');
  kapali(depocu, '/api/ec/urun-karlilik', 'POST');
  kapali(depocu, '/api/ec/fiyat-hesap');            // stok yetkisi fiyat hesabını açmaz
  kapali(siparisci, '/api/ec/fiyat-hesap');
  kapali(siparisci, '/api/ec/urun-karlilik');
  // Üretim alanında bu uçlar yok; eşleme oraya taşmaz.
  kapali(personel({pricing: 'write', stock: 'write'}), '/api/lp/fiyat-hesap');
  kapali(personel({pricing: 'write', stock: 'write'}), '/api/lp/urun-karlilik');
  // Bilinmeyen rota genel olarak açılmadı.
  kapali(personel({pricing: 'write', stock: 'write'}), '/api/ec/fiyat-hesap-yeni');
  kapali(personel({pricing: 'write', stock: 'write'}), '/api/ec/new-backdoor');
  // E-ticaret alanı kapalı personel yetki haritasından geçemez.
  kapali({...fiyatci, ec_access: 'none'}, '/api/ec/fiyat-hesap');
  // Yönetici davranışı aynı.
  gecer({owner: true}, '/api/ec/fiyat-hesap'); gecer({owner: true}, '/api/ec/urun-karlilik');
});

test('R25 saf scrubAmounts: fiyat-hesap yanıtındaki Türkçe para alanları tutar yetkisi yoksa gizlenir', () => {
  const dokum = {fiyat: 24000, maliyet: 6000, kargo: 6000, hizmet: 600, komisyon: 3600, stopaj: 0, paketleme: 0, diger: 0, cebine: 7800};
  const yanit = {urun: {id: 'u', name: 'Torf', birim_maliyet_kdv_dahil: 6000}, channel: 'trendyol', qty: 2,
    kesinti: {kargo: 6000, hizmet: 600, komisyon_orani: 0.15, stopaj_orani: 0.01, kaynak: 'content', ornek: 3, not: 'Not.', ornek_adet: {en_az: 2, en_cok: 2}},
    fiyatla: dokum, basabas: dokum, hedef: {...dokum, istenen: 3000}};
  const gizli = scrubAmounts(yanit, personel({pricing: 'read', amounts: 'none'}), 'ec');
  for (const k of Object.keys(dokum)) { assert.equal(gizli.fiyatla[k], null, 'fiyatla.' + k); assert.equal(gizli.basabas[k], null, 'basabas.' + k); }
  assert.equal(gizli.hedef.istenen, null);
  assert.equal(gizli.urun.birim_maliyet_kdv_dahil, null);
  for (const k of ['kargo', 'hizmet', 'komisyon_orani', 'stopaj_orani']) assert.equal(gizli.kesinti[k], null, 'kesinti.' + k);
  assert.equal(gizli.qty, 2, 'adet görünür'); assert.equal(gizli.kesinti.ornek, 3, 'örnek sayısı görünür');
  assert.deepEqual(gizli.kesinti.ornek_adet, {en_az: 2, en_cok: 2}, 'örnek paket adetleri miktardır');
  assert.equal(gizli.urun.name, 'Torf');
  assert.deepEqual(scrubAmounts(yanit, personel({pricing: 'read', amounts: 'read'}), 'ec'), yanit, 'tutar yetkisi olan tam görür');
  assert.deepEqual(scrubAmounts(yanit, {owner: true}, 'ec'), yanit, 'yönetici tam görür');
});

test('scrubAmounts: aynı nesne yanıtta iki kez geçerse ikinci geçişte de tutar gizlenir', () => {
  const ortak = {product_id: 'u', kar_cents: 500, adet_milli: 1000};
  const gizli = scrubAmounts({top: [ortak], bottom: [ortak], secili: ortak}, personel({stock: 'read', amounts: 'none'}), 'ec');
  for (const x of [gizli.top[0], gizli.bottom[0], gizli.secili]) { assert.equal(x.kar_cents, null, 'ortak nesnede tutar sızmamalı'); assert.equal(x.adet_milli, 1000); }
  const dongu = {amount_cents: 5, ad: 'x'}; dongu.self = dongu;
  const d = scrubAmounts(dongu, personel({stock: 'read', amounts: 'none'}), 'ec');
  assert.equal(d.amount_cents, null); assert.equal(d.self, d, 'döngü sonsuz yürümez');
});

// Gerçek istek yolu: yönetici veriyi kurar, personel davetle hesap açıp kendi oturumuyla ister.
async function kur() {
  const f = appFixture(); await f.setup();
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  const p = await f.ok('/ec/products', {name: 'Torf 20 L', sku: 'T20', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 100, unit_cost: 50, kind: 'opening', reference: 'A-T20', notes: 'Açılış', occurred_on: '2026-09-01'});
  f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,2000,5000,0,0,0,100,100,100,500,1)").run(p.id);
  const o = await f.ok('/ec/orders', {channel: 'trendyol', external_id: 'T1', order_no: 'T1', occurred_on: D,
    lines: [{external_id: 'T1-1', sku: 'S', name: 'İlan', product_id: p.id, quantity: 1, gross: 240, vat_rate: 20}]});
  await f.ok('/ec/orders/' + o.id + '/reserve', {});
  await f.ok('/ec/orders/' + o.id + '/ship', {occurred_on: D, reference: 'K-T1'});
  await f.ok('/ec/orders/' + o.id + '/deliver', {occurred_on: D});
  const s = f.sqlite.prepare('SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?').get(o.id);
  await f.ok('/ec/sales/' + s.id + '/fees', {commission: 30, shipping: 50, other: 5, fees_status: 'confirmed'});
  let n = 0;
  const giris = async ec => {
    const username = 'personel' + (++n);
    const staff = await f.ok('/admin/users', {name: 'Personel ' + n, username, permissions: {ec, lp: {}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'personel-sifresi-' + n});
    return (await f.req('/auth/login', {username, password: 'personel-sifresi-' + n})).cookie;
  };
  const fiyatUrl = '/ec/fiyat-hesap?' + new URLSearchParams({product_id: p.id, channel: 'trendyol', qty: 1, price: '240', target: '30'});
  return {f, product: p.id, giris, fiyatUrl};
}

test('R25 istek yolu: fiyat okuma yetkili personel Kaça satmalıyım hesabını alır; yetkisiz 403', async () => {
  const {f, giris, fiyatUrl} = await kur(); try {
    const sahip = await f.req(fiyatUrl);
    assert.equal(sahip.status, 200, 'yönetici: ' + JSON.stringify(sahip.data));
    const fiyatci = await giris({pricing: 'read', amounts: 'read'});
    const r = await f.req(fiyatUrl, undefined, fiyatci);
    assert.equal(r.status, 200, 'fiyat okuma yetkisi yeterli olmalı: ' + JSON.stringify(r.data));
    assert.deepEqual(r.data, sahip.data, 'tutar yetkili personel yöneticiyle aynı sonucu görür');
    assert.equal((await f.req('/ec/pricing', undefined, fiyatci)).status, 200, 'aynı ekranın ana ucu da açık');
    assert.equal((await f.req('/ec/fiyat-hesap', {product_id: 'x'}, fiyatci)).status, 403, 'okuma yetkisi yazmaya dönüşmez');
    assert.equal((await f.req('/ec/urun-karlilik', undefined, fiyatci)).status, 403, 'fiyat yetkisi ürün kârlılığını açmaz');
    const siparisci = await giris({orders: 'write', amounts: 'read'});
    assert.equal((await f.req(fiyatUrl, undefined, siparisci)).status, 403, 'fiyat yetkisi olmayan 403 alır');
  } finally { f.close(); }
});

test('R25 istek yolu: stok okuma yetkili personel ürün kârlılığını alır; yetkisiz 403', async () => {
  const {f, product, giris, fiyatUrl} = await kur(); try {
    const sahip = await f.req('/ec/urun-karlilik');
    assert.equal(sahip.status, 200);
    const depocu = await giris({stock: 'read', amounts: 'read'});
    const r = await f.req('/ec/urun-karlilik', undefined, depocu);
    assert.equal(r.status, 200, 'stok okuma yetkisi yeterli olmalı: ' + JSON.stringify(r.data));
    assert.deepEqual(r.data.rows, sahip.data.rows, 'tutar yetkili personel yöneticiyle aynı satırları görür');
    assert.ok(r.data.rows.find(x => x.product_id === product).kar_cents !== null);
    assert.equal((await f.req('/ec/urun-karlilik', {}, depocu)).status, 403, 'okuma yetkisi yazmaya dönüşmez');
    assert.equal((await f.req(fiyatUrl, undefined, depocu)).status, 403, 'stok yetkisi fiyat hesabını açmaz');
    const faturaci = await giris({invoices: 'write', amounts: 'read'});
    assert.equal((await f.req('/ec/urun-karlilik', undefined, faturaci)).status, 403, 'stok yetkisi olmayan 403 alır');
  } finally { f.close(); }
});

test('R25 istek yolu: tutar yetkisi kapalı personelde iki uçta da para gizli, miktar görünür', async () => {
  const {f, product, giris, fiyatUrl} = await kur(); try {
    const sahip = (await f.req(fiyatUrl)).data;
    assert.ok(sahip.fiyatla.cebine > 0 && sahip.basabas.fiyat > 0, 'yöneticide tutarlar görünür');
    const fiyatci = await giris({pricing: 'read', amounts: 'none'});
    const r = await f.req(fiyatUrl, undefined, fiyatci);
    assert.equal(r.status, 200);
    for (const x of [r.data.fiyatla, r.data.basabas, r.data.hedef])
      for (const k of ['fiyat', 'maliyet', 'kargo', 'hizmet', 'komisyon', 'stopaj', 'cebine']) assert.equal(x[k], null, k + ' gizlenmeli');
    assert.equal(r.data.hedef.istenen, null);
    assert.equal(r.data.urun.birim_maliyet_kdv_dahil, null, 'birim maliyet gizlenmeli');
    for (const k of ['kargo', 'hizmet', 'komisyon_orani', 'stopaj_orani']) assert.equal(r.data.kesinti[k], null, 'kesinti.' + k + ' gizlenmeli');
    assert.equal(r.data.qty, 1, 'adet görünür');
    const govde = JSON.stringify(r.data);
    for (const v of [sahip.fiyatla.cebine, sahip.basabas.fiyat, sahip.hedef.fiyat, sahip.kesinti.kargo]) assert.equal(govde.includes(String(v)), false, v + ' sızmamalı');

    const depocu = await giris({stock: 'read', amounts: 'none'});
    const k = await f.req('/ec/urun-karlilik', undefined, depocu);
    assert.equal(k.status, 200);
    const row = k.data.rows.find(x => x.product_id === product);
    assert.equal(row.adet_milli, 1000, 'satılan adet görünür');
    for (const key of ['ciro_cents', 'kar_cents', 'kar_adet_cents']) assert.equal(row[key], null, key + ' gizlenmeli');
  } finally { f.close(); }
});
