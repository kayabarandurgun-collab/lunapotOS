// KOMİSYON ORANI. Pazaryeri komisyonu dönemden döneme değişir (kampanya dönemleri): sahibin
// "bazı dönemler düşük komisyonla satıyoruz, bazı dönemler yüksek" dediği şey budur. Ekranda
// oranın kendisi hiç yazmıyordu. Kanıtlanan:
//  1) Her paketin KDV dahil komisyonu ve ETKİN oranı (komisyon ÷ KDV dahil satış) sipariş
//     listesinde, sipariş penceresinde ve kâr raporunda AYNI kuruş/oranla görünür.
//  2) Ürünün ORTALAMA komisyon oranı AĞIRLIKLIDIR: Σ komisyon ÷ Σ satış. Oranların ortalaması
//     DEĞİLDİR (büyük paket küçük pakete eşit sayılmaz).
//  3) Dönem karşılaştırması (son 30 gün / önceki 30 gün / tüm zamanlar) doğru paketleri seçer;
//     paketi olmayan dönem "veri yok" der, sıfır saymaz.
//  4) Komisyonu bilinen teslim edilmiş paketi olmayan ürün "bilinmiyor" der, %0 demez.
//  5) KARAR: oranın kendisi TUTAR DEĞİLDİR (pazaryerinin ilan ettiği tarife oranıdır ve tek
//     başına hiçbir TL rakamı vermez). Tutar yetkisi kapalı personel oranı görür, kuruşları
//     görmez: bütün *_cents alanları mevcut gizleme kuralıyla boş döner.
// TEMSİLİ veri; gerçek pazaryeri dosyası, canlı veritabanı veya kimlik bilgisi DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {performanceReport} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';
import {productList} from '../public/product-list.js';
import {komisyonSatiri} from '../public/orders-ui.js';
import {komisyonEtiketi} from '../public/performance-ui.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);
const ecEnv = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Orkide Toprağı 3 L','OR3','adet'),('p2','Perlit 5 L','P5','adet'),('p3','Torf 20 L','T20','adet')");
  for (const p of ['p1', 'p2', 'p3']) f.sqlite.exec(`INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('${p}',2000,0,0,0,0,100,100,100,500,1)`);
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4000000');
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-hb','hepsiburada','HB','HB'),('st-ty','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-ty','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  for (const [id, st, c] of [['fl-hb', 'st-hb', 'a'], ['fl-ty', 'st-ty', 'b']])
    f.sqlite.exec(`INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('${id}','${st}','finance','f.xlsx',10,'${c.repeat(64)}','2026-09-06T10:00','S','[]',1,1,'applied','t')`);
}

// Tek satırlı teslim edilmiş paket; tutarlar KDV HARİÇ kuruş, ürün ve kesinti KDV'si %20.
function paket(f, id, kanal, tarih, {urun = 'p1', satis = 10000, maliyet = 4000, kom = 2000, kargo = 0, diger = 0} = {}) {
  const q = v => v === null ? 'NULL' : v, tam = kom !== null && kargo !== null && diger !== null;
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${kanal}','E-${id}','S-${id}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','İlan',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${kanal}','X-${id}','${urun}','sale',1000,${satis},${maliyet},${q(kom)},${q(kargo)},${q(diger)},'${tam ? 'confirmed' : 'pending'}','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','${urun}',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}

// DÖNEMİ DEĞİŞEN KOMİSYON. p1 üç kez satıldı: yüksek oranlı iki yeni paket, düşük oranlı bir eski paket.
// KDV dahil: ty-yeni 24,00 / 120,00 = %20,0 · ty-eski 12,00 / 120,00 = %10,0 · hb-yeni 60,00 / 240,00 = %25,0
// Ağırlıklı toplam: 96,00 / 480,00 = %20,0 (oranların ortalaması %18,33 DEĞİL).
function donemler(f) {
  kur(f);
  paket(f, 'ty-yeni', 'trendyol', gun(-5), {kom: 2000});
  paket(f, 'ty-eski', 'trendyol', gun(-45), {kom: 1000});
  paket(f, 'hb-yeni', 'hepsiburada', gun(-5), {satis: 20000, maliyet: 8000, kom: 5000});
}

const rapor = f => performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-120), to: bugun, detay: true});

test('her paketin komisyonu ve etkin oranı: kâr raporu, sipariş listesi ve pencere kuruşu kuruşuna aynı', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    const satirlar = new Map((await rapor(f)).rows.map(r => [r.id, r]));
    const r = satirlar.get('ty-yeni');
    assert.equal(r.commission_gross_cents, 2400, 'KDV dahil komisyon');
    assert.equal(r.revenue_gross_cents, 12000, 'KDV dahil satış');
    assert.equal(r.commission_rate_bps, 2000, 'etkin oran = komisyon ÷ KDV dahil satış');
    assert.equal(satirlar.get('ty-eski').commission_rate_bps, 1000);
    assert.equal(satirlar.get('hb-yeni').commission_rate_bps, 2500);
    for (const x of satirlar.values()) assert.equal(x.commission_rate_bps, Math.round(x.commission_gross_cents * 10000 / x.revenue_gross_cents), x.id + ': oran iki rakamın bölümüdür');

    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    assert.equal(liste.get('ty-yeni').commission_gross_cents, 2400, 'liste: kâr raporuyla aynı kuruş');
    assert.equal(liste.get('ty-yeni').commission_base_cents, 12000, 'liste: oranın paydası KDV dahil satış');
    assert.equal(liste.get('ty-yeni').commission_rate_bps, 2000);
    assert.equal(liste.get('hb-yeni').commission_rate_bps, 2500);

    const pencere = await f.ok('/ec/orders/ty-yeni/insights');
    assert.equal(pencere.commission_gross_cents, 2400, 'pencere: aynı kuruş');
    assert.equal(pencere.commission_base_cents, 12000);
    assert.equal(pencere.commission_rate_bps, 2000);
    assert.equal(pencere.cash_breakdown.commission_gross_cents, 2400, 'dökümdeki komisyonla aynı');
  } finally { f.close(); }
});

test('kesintisi tahmin edilen pakette oran da TAHMİNİ işaretini taşır, bilinmeyen kesinti %0 olmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    paket(f, 'ty-tahmin', 'trendyol', gun(-3), {urun: 'p3', kom: null, kargo: null, diger: null});
    const satir = (await rapor(f)).rows.find(x => x.id === 'ty-tahmin');
    assert.equal(satir.fees_estimated, true, 'kesinti geçmişten tahmin edildi');
    assert.ok(satir.commission_rate_bps > 0, 'tahminden gelen oran da gösterilir');
    assert.equal(satir.commission_rate_bps, Math.round(satir.commission_gross_cents * 10000 / satir.revenue_gross_cents));
    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    assert.equal(liste.get('ty-tahmin').cash_estimated, true, 'liste "tahmini" işaretini korur');
    assert.equal(liste.get('ty-tahmin').commission_rate_bps, satir.commission_rate_bps);
  } finally { f.close(); }
});

test('kesintisi bilinmeyen pakette komisyon ve oran BOŞ kalır, sıfır sayılmaz; neden söylenir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'maliyetsiz', 'trendyol', gun(-4), {urun: 'p2', maliyet: 0});
    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    const p = liste.get('maliyetsiz');
    assert.equal(p.commission_gross_cents, null, 'uydurma sıfır yok');
    assert.equal(p.commission_rate_bps, null);
    assert.ok(p.cash_note, 'eksik nedeni yerinde duruyor');
    assert.equal((await f.ok('/ec/orders/maliyetsiz/insights')).commission_rate_bps, null, 'pencere: aynı');
  } finally { f.close(); }
});

test('ürünün ortalama komisyon oranı AĞIRLIKLIDIR ve kanal kanal ayrılır', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    const k = await f.ok('/ec/urun-karlilik');
    const p1 = k.rows.find(x => x.product_id === 'p1');
    assert.equal(p1.komisyon_oran_bps, 2000, 'Σ komisyon ÷ Σ satış = 9600/48000');
    assert.notEqual(p1.komisyon_oran_bps, 1833, 'oranların ortalaması DEĞİL');
    assert.equal(p1.komisyon_paket, 3, 'oranın arkasındaki paket sayısı');
    assert.equal(p1.komisyon_cents, 9600); assert.equal(p1.komisyon_ciro_cents, 48000);
    // Kâr raporunun AYNI paket satırlarından: ikinci bir toplam yok.
    const rows = (await rapor(f)).rows;
    const toplam = rows.reduce((t, r) => t + (r.urunler || []).filter(u => u.product_id === 'p1').reduce((n, u) => n + u.commission_gross_cents, 0), 0);
    assert.equal(p1.komisyon_cents, toplam, 'ürün payları paket satırlarından gelir');

    const kanal = Object.fromEntries((p1.komisyon_kanallar || []).map(x => [x.kanal, x]));
    assert.equal(kanal.trendyol.oran_bps, 1500, 'Trendyol: 3600/24000');
    assert.equal(kanal.trendyol.paket, 2);
    assert.equal(kanal.hepsiburada.oran_bps, 2500, 'Hepsiburada: 6000/24000');
    assert.equal(kanal.hepsiburada.paket, 1);
  } finally { f.close(); }
});

test('dönem karşılaştırması doğru paketleri seçer; paketi olmayan dönem veri yok der', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    const k = await f.ok('/ec/urun-karlilik');
    const p1 = k.rows.find(x => x.product_id === 'p1'), d = p1.komisyon_donemler;
    assert.equal(d.son_30.oran_bps, 2333, 'son 30 gün: (2400+6000)/(12000+24000)');
    assert.equal(d.son_30.paket, 2);
    assert.equal(d.onceki_30.oran_bps, 1000, 'önceki 30 gün: yalnız eski paket');
    assert.equal(d.onceki_30.paket, 1);
    assert.equal(d.tum.oran_bps, 2000); assert.equal(d.tum.paket, 3);
    // Kanal bazında dönem: Hepsiburada'nın önceki 30 günde paketi YOK → oran boş, sıfır değil.
    const hb = (p1.komisyon_kanallar || []).find(x => x.kanal === 'hepsiburada');
    assert.equal(hb.donemler.son_30.oran_bps, 2500);
    assert.equal(hb.donemler.onceki_30.oran_bps, null, 'veri yok; %0 değil');
    assert.equal(hb.donemler.onceki_30.paket, 0);
  } finally { f.close(); }
});

test('komisyonu bilinen teslimi olmayan ürün "bilinmiyor" der, %0 demez', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    paket(f, 'maliyetsiz', 'trendyol', gun(-4), {urun: 'p2', maliyet: 0, kom: 2000});
    const k = await f.ok('/ec/urun-karlilik');
    const p2 = k.rows.find(x => x.product_id === 'p2');
    assert.equal(p2.komisyon_oran_bps, null, 'hesaplanamayan paketten oran uydurulmaz');
    assert.equal(p2.komisyon_paket, 0);
    assert.equal(p2.komisyon_cents, null, 'sıfır değil, boş');
    assert.deepEqual(p2.komisyon_kanallar, []);
    assert.equal(p2.komisyon_donemler.tum.oran_bps, null);
  } finally { f.close(); }
});

// ---- Yetki: oran tarife oranıdır, tutar değildir ---------------------------------------------
async function depocu(f) {
  const staff = await f.ok('/admin/users', {name: 'Depo', username: 'depo',
    permissions: {ec: {stock: 'read', orders: 'read', amounts: 'none'}, lp: {}, delete_records: false}});
  await f.req('/auth/accept-invite', {token: staff.invite_path.split('invite=')[1], password: 'depo-personel-sifresi'});
  return (await f.req('/auth/login', {username: 'depo', password: 'depo-personel-sifresi'})).cookie;
}

test('tutar yetkisi kapalı personel komisyon ORANINI görür, kuruşları görmez', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    const cookie = await depocu(f);
    const liste = await f.req('/ec/orders', undefined, cookie);
    assert.equal(liste.status, 200);
    const p = liste.data.packages.find(x => x.id === 'ty-yeni');
    assert.equal(p.commission_rate_bps, 2000, 'oran görünür');
    assert.equal(p.commission_gross_cents, null, 'KDV dahil komisyon gizli');
    assert.equal(p.commission_base_cents, null, 'oranın paydası da gizli');
    assert.equal(p.cash_result_cents, null, 'cebine kalan zaten gizli');

    const k = await f.req('/ec/urun-karlilik', undefined, cookie);
    assert.equal(k.status, 200);
    const p1 = k.data.rows.find(x => x.product_id === 'p1');
    assert.equal(p1.komisyon_oran_bps, 2000, 'ortalama oran görünür');
    assert.equal(p1.komisyon_paket, 3, 'paket sayısı miktar bilgisidir, görünür');
    assert.equal(p1.komisyon_cents, null, 'komisyon tutarı gizli');
    assert.equal(p1.komisyon_ciro_cents, null, 'ciro gizli');
    assert.equal(p1.komisyon_donemler.son_30.oran_bps, 2333, 'dönem oranları görünür');
    assert.equal(p1.komisyon_donemler.son_30.komisyon_cents, null, 'dönem tutarı gizli');
    assert.equal(p1.komisyon_kanallar.find(x => x.kanal === 'trendyol').oran_bps, 1500);
    assert.equal(p1.komisyon_kanallar.find(x => x.kanal === 'trendyol').ciro_cents, null);
  } finally { f.close(); }
});

// ---- Ekranlar: kısa Türkçe etiketler ---------------------------------------------------------
test('sipariş listesi satırı komisyonu ve oranını yazar; bilinmeyeni sıfır yazmaz', () => {
  const tam = komisyonSatiri({status: 'delivered', commission_gross_cents: 2400, commission_base_cents: 12000, commission_rate_bps: 2000});
  assert.match(tam, /Komisyon/); assert.match(tam, /%20,0/); assert.match(tam, /24,00/);
  const tahmini = komisyonSatiri({status: 'delivered', commission_gross_cents: 2400, commission_base_cents: 12000, commission_rate_bps: 2000, cash_estimated: true});
  assert.match(tahmini, /tahmini/);
  const bos = komisyonSatiri({status: 'delivered', commission_gross_cents: null, commission_base_cents: null, commission_rate_bps: null, cash_note: 'Kesinti bekleniyor.'});
  assert.match(bos, /bilinmiyor/i); assert.doesNotMatch(bos, /%0,0/); assert.doesNotMatch(bos, /0,00/);
  // Tutar yetkisi kapalı personelde oran kalır, tutar yazılmaz.
  const yetkisiz = komisyonSatiri({status: 'delivered', commission_gross_cents: null, commission_base_cents: null, commission_rate_bps: 2000});
  assert.match(yetkisiz, /%20,0/); assert.doesNotMatch(yetkisiz, /₺/);
  assert.equal(komisyonSatiri({status: 'cancelled', commission_rate_bps: null}), '', 'iptal edilen siparişte satır yok');
});

test('kâr raporu satır dökümünde komisyonun oranı yazar', () => {
  assert.match(komisyonEtiketi({commission_rate_bps: 2000}), /Komisyon \(KDV dahil\)/);
  assert.match(komisyonEtiketi({commission_rate_bps: 2000}), /%20,0/);
  assert.match(komisyonEtiketi({commission_rate_bps: null}), /bilinmiyor/i);
});

const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const helpers = {esc, money: v => v == null ? 'Tutar bilinmiyor' : (v / 100).toFixed(2) + ' TL', qty: v => String(v / 1000)};
const urun = id => ({id, name: 'Orkide Toprağı 3 L', sku: 'OR3', brand: 'Tropikal', category: 'Toprak', stock_unit: 'adet',
  min_stock_milli: 0, quantity_milli: 8000, on_hand_milli: 8000, reserved_milli: 0, available_milli: 8000,
  in_transit_milli: 0, in_transit_status: 'complete', in_transit_notes: [], value_cents: 10000, vat_bps: 2000, average_purchase_cents: 1000});

test('stok ekranı ürünün ortalama komisyon oranını ve dönem karşılaştırmasını gösterir', async () => {
  const f = appFixture(); await f.setup(); try {
    donemler(f);
    paket(f, 'maliyetsiz', 'trendyol', gun(-4), {urun: 'p2', maliyet: 0});
    const k = await f.ok('/ec/urun-karlilik');
    const data = {sales: [], suppliers: [], productStats: new Map(k.rows.map(r => [r.product_id, r]))};
    for (const stockView of ['cards', 'table']) {
      const html = productList([urun('p1')], data, {stockView}, helpers);
      assert.match(html, /Ortalama komisyon oranı/, 'kısa Türkçe etiket');
      assert.ok(html.includes('%20,0'), 'ağırlıklı oran');
      assert.ok(html.includes('3 paket'), 'oranın arkasındaki paket sayısı');
      assert.ok(html.includes('%15,0') && html.includes('%25,0'), 'kanal kırılımı');
      assert.match(html, /son 30 gün %23,3/, 'dönem karşılaştırması');
      assert.match(html, /önceki 30 gün %10,0/);
      assert.match(html, /tüm zamanlar %20,0/);
      assert.ok(!html.includes('%0,0'), 'bilinmeyen sıfır yazılmaz');

      const bos = productList([urun('p2')], data, {stockView}, helpers);
      assert.match(bos, /Ortalama komisyon oranı/);
      assert.match(bos, /[Bb]ilinmiyor/, 'komisyonu bilinen teslim yoksa bilinmiyor denir');
      assert.ok(!bos.includes('%0,0'), 'sıfır oran uydurulmaz');
    }
  } finally { f.close(); }
});

test('stok ekranı paketi olmayan dönem için "veri yok" yazar', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'ty-yeni', 'trendyol', gun(-5), {kom: 2000});   // yalnız son 30 günde satış var
    const k = await f.ok('/ec/urun-karlilik');
    const data = {sales: [], suppliers: [], productStats: new Map(k.rows.map(r => [r.product_id, r]))};
    const html = productList([urun('p1')], data, {stockView: 'cards'}, helpers);
    assert.match(html, /son 30 gün %20,0/);
    assert.match(html, /önceki 30 gün veri yok/, 'boş dönem sıfır değil, veri yok');
  } finally { f.close(); }
});
