// R23 — "Kaça satmalıyım" fiyat önerisi.
//  a) Adet uyumu: yalnız 1 adetlik paket geçmişi varken 100 adetlik paket için tek paket kargosu
//     kesin fiyat gibi kullanılmaz; açık, "belirsiz" işaretli senaryo döner. Uyumlu çoklu paket
//     geçmişi (aynı adet ya da iki yanında gözlenmiş adet) güvenle çalışır.
//  b) Ürün profilindeki paket ambalajı ve diğer paket gideri (KDV hariç, paket başına) sonuçtan bir
//     kez düşülür; başabaş ve hedef aynı gider kırılımını kullanır; pazaryeri hizmet bedeliyle
//     çift sayılmaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası değildir. Tutarlar kuruş, ekranda KDV dahil.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const D = '2026-09-10';

async function kur(f, {maliyet = 5000, profil = true} = {}) {
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  const p = await f.ok('/ec/products', {name: 'Gartengold Torf 20 L', sku: 'T20', stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 500, unit_cost: maliyet / 100, kind: 'opening', reference: 'A-T20', notes: 'Açılış', occurred_on: '2026-09-01'});
  if (profil) f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,2000,?,0,0,0,100,100,100,500,1)").run(p.id, maliyet);
  let n = 0;
  // Teslim edilmiş paket; kesintiler KDV hariç TL (satış kaydındaki gibi).
  const teslim = async (adet, {kargo = 50, komisyon = 30, diger = 5, brut = 240 * adet} = {}) => {
    const no = 'T' + (++n);
    const o = await f.ok('/ec/orders', {channel: 'trendyol', external_id: no, order_no: no, occurred_on: D,
      lines: [{external_id: no + '-1', sku: 'S', name: 'İlan', product_id: p.id, quantity: adet, gross: brut, vat_rate: 20}]});
    await f.ok('/ec/orders/' + o.id + '/reserve', {});
    await f.ok('/ec/orders/' + o.id + '/ship', {occurred_on: D, reference: 'K-' + no});
    await f.ok('/ec/orders/' + o.id + '/deliver', {occurred_on: D});
    const s = f.sqlite.prepare('SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?').get(o.id);
    await f.ok('/ec/sales/' + s.id + '/fees', {commission: komisyon, shipping: kargo, other: diger, fees_status: 'confirmed'});
  };
  const hesap = (qty, {price = '', target = ''} = {}) => f.req('/ec/fiyat-hesap?' + new URLSearchParams({product_id: p.id, channel: 'trendyol', qty, price, target}));
  const profilGider = (packaging, other) => f.sqlite.prepare('UPDATE ec_price_profiles SET packaging_cents=?,other_cents=? WHERE product_id=?').run(packaging, other, p.id);
  return {id: p.id, teslim, hesap, profilGider};
}
const kalemler = x => x.maliyet + x.kargo + x.hizmet + x.komisyon + x.stopaj + x.paketleme + x.diger;

test('R23a: yalnız 1 adetlik geçmişle 100 adet istenince tek paket kargosuyla kesin fiyat verilmez; açık senaryo döner', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim, hesap} = await kur(f);
    await teslim(1, {kargo: 50}); await teslim(1, {kargo: 50});
    const r = await hesap(100, {price: '30000', target: '50'});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.basabas, null, 'kesin başabaş fiyatı verilmez (eski kod: 1 adetlik kargoyla ' + JSON.stringify(r.data.basabas) + ')');
    assert.equal(r.data.hedef, null, 'kesin hedef fiyat verilmez');
    assert.equal(r.data.fiyatla, null, 'kesin sonuç yerine senaryo');
    assert.equal(r.data.guven, 'belirsiz', '1→100 adet kesin değildir');
    assert.equal(r.data.kesinti.adet_uyumu, 'uzak');
    assert.deepEqual(r.data.kesinti.ornek_adet, {en_az: 1, en_cok: 1}, 'geçmişteki paket adetleri açıkça verilir');
    assert.match(r.data.uyari, /100 adet/, 'neden kısa ve açık: ' + r.data.uyari);
    assert.match(r.data.uyari, /1 adet/);
    // Senaryo açıkça etiketli; kargo çarpılmaz, 1 adetlik paketin kargosu varsayım olarak gösterilir.
    assert.ok(r.data.senaryo && r.data.senaryo.aciklama, 'senaryo açıklaması var');
    assert.equal(r.data.senaryo.basabas.kargo, 6000, 'tek paket kargosu yalnız senaryo varsayımı; 100 ile çarpılmadı');
    assert.ok(r.data.senaryo.fiyatla && r.data.senaryo.hedef, 'senaryoda fiyat ve hedef dökümü var');
  } finally { f.close(); }
});

test('R23a: uyumlu çoklu paket geçmişi güvenle çalışır; uzak adetler ortancayı bozmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim, hesap} = await kur(f);
    for (let i = 0; i < 4; i++) await teslim(1, {kargo: 50});
    await teslim(3, {kargo: 90});
    // Aynı adet (3) geçmişi: kesin tahmin, kargo o paketlerden.
    const ayni = await hesap(3);
    assert.equal(ayni.status, 200);
    assert.equal(ayni.data.kesinti.kargo, 10800, '3 adetlik paketin kargosu (90 TL + KDV)');
    assert.ok(ayni.data.basabas && ayni.data.basabas.fiyat > 0);
    // 2 adet: iki yanında gözlenmiş adet var (1 ve 3). Dört tane 1 adetlik paket 3 adetliği ezmemeli.
    const ara = await hesap(2);
    assert.equal(ara.status, 200);
    assert.ok(ara.data.kesinti.kargo > 6000 && ara.data.kesinti.kargo < 10800, '1 ve 3 adetlik kargo arasında: ' + ara.data.kesinti.kargo);
    assert.equal(ayni.data.guven, 'tahmini');
    assert.equal(ayni.data.kesinti.adet_uyumu, 'ayni');
    assert.equal(ara.data.guven, 'tahmini');
    assert.equal(ara.data.kesinti.adet_uyumu, 'aralik');
    assert.deepEqual(ara.data.kesinti.ornek_adet, {en_az: 1, en_cok: 3});
    assert.ok(ara.data.basabas && ara.data.basabas.fiyat > 0, 'uyumlu geçmişte başabaş verilir');
    // Geçmişte büyük paket de varsa 100 adet artık aynı içerikten gelir.
    await teslim(100, {kargo: 2000, komisyon: 3000});
    const yuz = await hesap(100);
    assert.equal(yuz.data.guven, 'tahmini');
    assert.equal(yuz.data.kesinti.kargo, 240000, '100 adetlik gerçek teslimin kargosu');
  } finally { f.close(); }
});

test('R23a: bu ürünün hiç teslimi yoksa kanal ortancası kesin öneri sayılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim} = await kur(f);
    await teslim(1, {kargo: 50});
    const baska = await f.ok('/ec/products', {name: 'Klasmann TS1 Torf 210 L', sku: 'K210', stock_unit: 'adet', min_stock: 0});
    f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,2000,90000,0,0,0,100,100,100,500,1)").run(baska.id);
    const r = await f.req('/ec/fiyat-hesap?' + new URLSearchParams({product_id: baska.id, channel: 'trendyol', qty: 1}));
    assert.equal(r.status, 200);
    assert.equal(r.data.basabas, null, 'başka ürünlerin kargosuyla kesin başabaş verilmez');
    assert.equal(r.data.guven, 'belirsiz');
    assert.equal(r.data.kesinti.adet_uyumu, 'yok');
    assert.ok(r.data.senaryo.basabas.fiyat > 0 && r.data.uyari);
  } finally { f.close(); }
});

test('R23b: yalnız profil ambalaj/diğer gideri artınca aynı fiyatta cebine kalan düşer, başabaş ve hedef yükselir', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim, hesap, profilGider} = await kur(f);
    await teslim(1, {kargo: 50, komisyon: 30, diger: 5});
    const once = (await hesap(1, {price: '240', target: '30'})).data;
    // Sıfır gider: eski hesapla aynı (240 − 60 maliyet − 60 kargo − 6 hizmet − 36 komisyon).
    assert.equal(once.fiyatla.cebine, 24000 - 6000 - 6000 - 600 - 3600);
    profilGider(1000, 500);   // paket başı 10 TL ambalaj + 5 TL diğer, KDV hariç
    const sonra = (await hesap(1, {price: '240', target: '30'})).data;
    assert.equal(sonra.fiyatla.cebine, once.fiyatla.cebine - 1800, 'aynı fiyatta nakit sonuç tam gider kadar düşer');
    assert.ok(sonra.basabas.fiyat > once.basabas.fiyat, 'başabaş yükselir');
    assert.equal(once.fiyatla.paketleme, 0); assert.equal(once.fiyatla.diger, 0);
    assert.equal(sonra.fiyatla.paketleme, 1200, 'ambalaj KDV dahil (ürün KDV oranı)');
    assert.equal(sonra.fiyatla.diger, 600, 'diğer paket gideri KDV dahil');
    assert.equal(sonra.fiyatla.hizmet, once.fiyatla.hizmet, 'pazaryeri hizmet bedeli değişmez: profil gideriyle çift sayılmaz');
    assert.equal(sonra.kesinti.hizmet, once.kesinti.hizmet);
    for (const x of [sonra.fiyatla, sonra.basabas, sonra.hedef]) assert.equal(x.fiyat - kalemler(x), x.cebine, 'her kalem bir kez düşülür');
    assert.ok(sonra.basabas.fiyat > once.basabas.fiyat, 'başabaş yükselir');
    assert.ok(sonra.hedef.fiyat > once.hedef.fiyat, 'hedef fiyat yükselir');
    assert.ok(sonra.basabas.cebine >= 0 && sonra.basabas.cebine < 5, 'başabaş aynı kırılımla ~0');
    assert.ok(sonra.hedef.cebine >= 3000 && sonra.hedef.cebine < 3005, 'hedef aynı kırılımla sağlanır');
    assert.equal(sonra.basabas.paketleme, 1200); assert.equal(sonra.hedef.diger, 600);
  } finally { f.close(); }
});

test('R23b: çoklu adette ambalaj ve diğer gider paket başına bir kez; ürün maliyeti adetle', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim, hesap, profilGider} = await kur(f);
    await teslim(2, {kargo: 70, komisyon: 60, diger: 5});
    profilGider(1000, 500);
    const r = (await hesap(2, {price: '480'})).data;
    assert.equal(r.fiyatla.maliyet, 12000, '2 × 50 TL + KDV');
    assert.equal(r.fiyatla.paketleme, 1200, 'paket başına bir kez; adetle çarpılmaz');
    assert.equal(r.guven, 'tahmini');
    assert.equal(r.fiyatla.diger, 600);
    assert.equal(r.fiyatla.fiyat - kalemler(r.fiyatla), r.fiyatla.cebine);
  } finally { f.close(); }
});

test('R23b: ürün profili yoksa ambalaj/diğer gider sessizce sıfır sayılmaz; varsayım açıkça yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {id, teslim, hesap} = await kur(f, {profil: false});
    // Profil yok: maliyet son muhasebeleşmiş alıştan (10 adet × 50 TL KDV hariç).
    const supplier = await f.ok('/ec/suppliers', {name: 'Tedarikçi', tax_id: '1234567890', contact: ''});
    const inv = await f.ok('/ec/invoices', {supplier_id: supplier.id, invoice_no: 'F-1', invoice_date: '2026-09-02', currency: 'TRY',
      lines: [{description: 'Torf', external_code: 'T', invoice_quantity: 10, invoice_unit: 'adet', product_id: id, stock_quantity: 10, net: 500, tax: 100}]});
    await f.ok('/ec/invoices/' + inv.id + '/post', {});
    await teslim(1);
    const r = await hesap(1, {price: '240'});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.urun.birim_maliyet_kdv_dahil, 6000);
    assert.equal(r.data.gider.profil, false, 'profil eksikliği işaretli');
    assert.match(r.data.gider.not, /profil/i, 'varsayım açıkça yazılı: ' + r.data.gider.not);
    assert.equal(r.data.fiyatla.paketleme, 0); assert.equal(r.data.fiyatla.diger, 0);
  } finally { f.close(); }
});

// Rapor §9 Torf 20 L TY örneği: 228 TL KDV dahil son maliyet; kesintiler rapor §6.4'teki gerçek
// TY paketinden (satış 403,38 · komisyon 74,63 · kargo 150,72 · hizmet 13,19, hepsi KDV dahil).
// TY'de stopaj olayı yok (stopaj %0). Formül: başabaş = (maliyet + kargo + hizmet + ambalaj + diğer)
// / (1 − komisyon oranı × (1+kesinti KDV)/(1+ürün KDV) − stopaj oranı).
test('Torf 20 L TY koşullu örneği: 228 TL maliyetle başabaş ~481, +50 TL hedef ~542–543 TL', async () => {
  const f = appFixture(); await f.setup(); try {
    const {teslim, hesap, profilGider} = await kur(f, {maliyet: 19000});
    await teslim(1, {brut: 403.38, komisyon: 62.19, kargo: 125.60, diger: 10.99});
    const r = (await hesap(1, {target: '50'})).data;
    assert.equal(r.urun.birim_maliyet_kdv_dahil, 22800);
    assert.equal(r.kesinti.kargo, 15072); assert.equal(r.kesinti.hizmet, 1319); assert.equal(r.kesinti.stopaj_orani, 0);
    assert.ok(Math.abs(r.basabas.fiyat - 48100) <= 100, 'başabaş ~481 TL: ' + r.basabas.fiyat);
    assert.ok(Math.abs(r.hedef.fiyat - 54300) <= 100, 'hedef ~543 TL: ' + r.hedef.fiyat);
    assert.equal(r.guven, 'tahmini');
    // Profilde ambalaj girilirse aynı kırılımla yükselir.
    profilGider(1000, 0);
    const a = (await hesap(1, {target: '50'})).data;
    assert.ok(a.basabas.fiyat > r.basabas.fiyat && a.hedef.fiyat > r.hedef.fiyat);
  } finally { f.close(); }
});
