// CODEX R13 / R17 / R22 — TEK EKONOMİK SONUÇ. Kâr raporu (performanceReport paket satırları), ana sayfa,
// ürün kârlılığı ve sipariş listesi/penceresi aynı paket için aynı kuruşu, aynı tahmin işaretini ve aynı
// "hesaplanmadı" durumunu göstermeli. Bilinmeyen maliyet/kesinti sıfır sayılmaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {performanceReport} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);
const ecEnv = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet'),('p2','Perlit 5 L','P5','adet'),('p3','Kaktüs Toprağı','K3','adet')");
  for (const p of ['p1', 'p2', 'p3']) f.sqlite.exec(`INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('${p}',2000,0,0,0,0,100,100,100,500,1)`);
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4600000');
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-hb','hepsiburada','HB','HB'),('st-ty','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-ty','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  for (const [id, st, c] of [['fl-hb', 'st-hb', 'a'], ['fl-ty', 'st-ty', 'b']])
    f.sqlite.exec(`INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('${id}','${st}','finance','f.xlsx',10,'${c.repeat(64)}','2026-09-06T10:00','S','[]',1,1,'applied','t')`);
}

// Tek satırlı paket; tutarlar KDV hariç kuruş. Varsayılan: satış 110,00 (KDV dahil 132,00), maliyet 46,00
// (55,20), kesinti 16,10 + 30,00 + 5,00 (KDV dahil 61,32) → cebine kalan 15,48.
function paket(f, id, kanal, tarih, {urun = 'p1', satis = 11000, maliyet = 4600, kom = 1610, kargo = 3000, diger = 500, durum = 'delivered', siparis = 'S-' + id} = {}) {
  const q = v => v === null ? 'NULL' : v, tam = kom !== null && kargo !== null && diger !== null;
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${kanal}','E-${id}','${siparis}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Ürün',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${kanal}','X-${id}','${urun}','sale',1000,${satis},${maliyet},${q(kom)},${q(kargo)},${q(diger)},'${tam ? 'confirmed' : 'pending'}','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','${urun}',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  if (durum === 'delivered') f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}
let sira = 0;
const stopaj = (f, kanal, siparis, tutar) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,'finance_event',?,'provider',?,'2026-09-06T10:00',?,?)")
  .run('w' + (++sira), kanal === 'trendyol' ? 'st-ty' : 'st-hb', 'W:' + sira, JSON.stringify({order_no: siparis, type: 'withholding', amount_cents: tutar}), kanal === 'trendyol' ? 'fl-ty' : 'fl-hb', sira);

// Aynı kapsamda (teslim edilenler, ilk sonuçtan bugüne) kâr raporunun ürün katkıları.
async function raporUrunleri(f, from) {
  const r = await performanceReport(ecEnv(f), {mode: 'delivered', from, to: bugun, detay: true});
  const m = new Map();
  for (const row of r.rows) for (const u of row.urunler || []) m.set(u.product_id, (m.get(u.product_id) || 0) + u.cash_cents);
  return {r, m};
}

test('R13: maliyeti veya kesintisi bilinmeyen paket ürün kârlılığında 70,68 / 76,80 değil, hesaplanmadı görünür', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'maliyetsiz', 'trendyol', gun(-3), {maliyet: 0});                                // alış kaydı yok
    paket(f, 'kesintisiz', 'hepsiburada', gun(-2), {urun: 'p2', kom: null, kargo: null, diger: null}); // HB'de geçmiş yok
    const {r} = await raporUrunleri(f, gun(-10));
    const by = id => r.rows.find(x => x.id === id);
    assert.equal(by('maliyetsiz').cash_cents, null, 'kâr raporu: maliyet bilinmiyor');
    assert.equal(by('kesintisiz').cash_cents, null, 'kâr raporu: kesinti bilinmiyor, tahmin yok');
    const u = new Map((await f.ok('/ec/urun-karlilik')).rows.map(x => [x.product_id, x]));
    assert.notEqual(u.get('p1')?.kar_cents, 7068, 'bilinmeyen maliyet sıfır sayılıp 70,68 çıkmamalı');
    assert.notEqual(u.get('p2')?.kar_cents, 7680, 'bilinmeyen kesinti sıfır sayılıp 76,80 çıkmamalı');
    assert.equal(u.get('p1').kar_cents, null, 'ürün kârı da hesaplanmadı');
    assert.equal(u.get('p2').kar_cents, null);
    assert.equal(u.get('p1').eksik_paket, 1, 'eksik kapsam söylenir');
    assert.equal(u.get('p2').eksik_paket, 1);
    assert.match(u.get('p1').eksik_neden, /alış kaydı yok/, 'kâr raporuyla aynı kısa sebep');
    assert.equal(u.get('p1').adet_milli, 1000, 'satılan adet yine bilinir');
    // Sipariş listesi ve penceresi de aynı belirsizliği gösterir.
    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    assert.equal(liste.get('maliyetsiz').cash_result_cents, null, 'liste: sıfır maliyetle rakam uydurmaz');
    assert.equal((await f.ok('/ec/orders/maliyetsiz/insights')).cash_cents, null, 'pencere: aynı');
  } finally { f.close(); }
});

test('R13: güvenilir geçmiş gelince dört görünüm aynı tahmini tutara geçer; gerçek sıfır gider tahmin sayılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'hb-gecmis', 'hepsiburada', gun(-5), {urun: 'p2'});                              // 15,48 gerçek
    paket(f, 'kesintisiz', 'hepsiburada', gun(-2), {urun: 'p2', kom: null, kargo: null, diger: null});
    paket(f, 'sifir', 'trendyol', gun(-4), {urun: 'p3', kom: 0, kargo: 0, diger: 0});        // gerçekten sıfır kesinti
    const {r, m} = await raporUrunleri(f, gun(-10));
    const by = id => r.rows.find(x => x.id === id);
    assert.equal(by('kesintisiz').cash_cents, 1548, 'geçmişten tahmin');
    assert.equal(by('kesintisiz').fees_estimated, true);
    assert.equal(by('sifir').cash_cents, 13200 - 5520, 'gerçek sıfır kesinti hesaplanır');
    assert.ok(!by('sifir').fees_estimated, 'gerçek sıfır tahmin değildir');
    const u = new Map((await f.ok('/ec/urun-karlilik')).rows.map(x => [x.product_id, x]));
    for (const p of ['p2', 'p3']) assert.equal(u.get(p).kar_cents, m.get(p), p + ': ürün kârı kâr raporunun ürün katkısıyla kuruşu kuruşuna aynı');
    assert.equal(u.get('p2').kar_cents, 3096);
    assert.equal(u.get('p2').tahmini_paket, 1);
    assert.equal(u.get('p3').tahmini_paket, 0, 'sıfır gider tahmin sayılmadı');
    assert.equal(u.get('p3').eksik_paket, 0);
    // Ana sayfanın tüm zamanlar ürün sıralaması da aynı tutar.
    const tum = (await f.ok('/ec/panorama')).periods.find(p => p.key === 'tum');
    const pano = new Map([...tum.products.top, ...tum.products.bottom].map(x => [x.product_id, x.cash_cents]));
    assert.equal(pano.get('p2'), u.get('p2').kar_cents, 'ana sayfa = ürün kârlılığı');
  } finally { f.close(); }
});

test('R17: TY stopajı ürün kârlılığında da düşer; aynı sipariş no farklı kanalda karışmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'ty', 'trendyol', gun(-3), {siparis: 'S-ORTAK'});
    paket(f, 'hb', 'hepsiburada', gun(-3), {urun: 'p2', siparis: 'S-ORTAK'});
    stopaj(f, 'trendyol', 'S-ORTAK', -100);
    stopaj(f, 'hepsiburada', 'S-ORTAK', -300);
    const {r, m} = await raporUrunleri(f, gun(-10));
    assert.equal(r.rows.find(x => x.id === 'ty').cash_cents, 1448, 'kâr raporu: 15,48 − 1,00 stopaj');
    assert.equal(r.rows.find(x => x.id === 'hb').cash_cents, 1248, 'kâr raporu: 15,48 − 3,00 stopaj');
    const u = new Map((await f.ok('/ec/urun-karlilik')).rows.map(x => [x.product_id, x]));
    assert.equal(u.get('p1').kar_cents, 1448, 'ürün kârlılığı TY stopajını düşer (15,48 değil)');
    assert.equal(u.get('p2').kar_cents, 1248);
    assert.equal(u.get('p1').kar_cents, m.get('p1'));
    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    assert.equal(liste.get('ty').cash_result_cents, 1448);
    assert.equal(liste.get('hb').cash_result_cents, 1248);
    assert.equal((await f.ok('/ec/orders/ty/insights')).cash_cents, 1448);
  } finally { f.close(); }
});

test('R22: kesintisi ekstreye yazılmamış teslim; liste ve pencere kâr raporuyla aynı 15,48 TL "tahmini"', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'gecmis', 'trendyol', gun(-5));
    paket(f, 'bekleyen', 'trendyol', gun(-2), {kom: null, kargo: null, diger: null});
    const r = await f.ok(`/ec/performance?from=${gun(-10)}&to=${bugun}`);
    const row = r.rows.find(x => x.id === 'bekleyen');
    assert.equal(row.cash_cents, 1548);
    assert.equal(row.fees_estimated, true);
    const liste = (await f.ok('/ec/orders')).packages.find(p => p.id === 'bekleyen');
    assert.equal(liste.cash_result_cents, 1548, 'liste tahmini gösterir');
    assert.equal(liste.cash_estimated, true, 'liste tahmin işaretini taşır');
    const ozet = await f.ok('/ec/orders/bekleyen/insights');
    assert.equal(ozet.cash_cents, 1548, 'pencere tahmini gösterir');
    assert.equal(ozet.cash_estimated, true);
    assert.match(ozet.cash_note, /henüz yazmadı/, 'tahmin kaynağı söylenir');
    // Penceredeki "Paran nereye gidiyor?" dökümü de aynı satırdan: kalemler toplamı nakit sonuca eşit.
    const k = ozet.cash_breakdown;
    assert.deepEqual([k.shipping_gross_cents, k.commission_gross_cents, k.other_gross_cents], [row.shipping_gross_cents, row.commission_gross_cents, row.other_gross_cents]);
    assert.equal(k.revenue_gross_cents - k.cost_gross_cents - k.shipping_gross_cents - k.commission_gross_cents - k.other_gross_cents - (ozet.withholding_cents || 0), ozet.cash_cents, 'döküm toplamı pencerenin tutarı');
    // Gerçek kesinti gelince üç görünüm birlikte gerçeğe geçer.
    f.sqlite.exec("UPDATE ec_sale_entries SET commission_cents=1610,shipping_cents=3500,other_cents=500,fees_status='confirmed' WHERE id='s-bekleyen'");
    const r2 = (await f.ok(`/ec/performance?from=${gun(-10)}&to=${bugun}`)).rows.find(x => x.id === 'bekleyen');
    const l2 = (await f.ok('/ec/orders')).packages.find(p => p.id === 'bekleyen');
    const o2 = await f.ok('/ec/orders/bekleyen/insights');
    assert.equal(r2.cash_cents, 948);
    assert.deepEqual([l2.cash_result_cents, !!l2.cash_estimated], [948, false]);
    assert.deepEqual([o2.cash_cents, !!o2.cash_estimated], [948, false]);
  } finally { f.close(); }
});

test('R22: geçmiş yoksa üç görünüm aynı kısa eksik nedenini verir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'yalniz', 'hepsiburada', gun(-2), {kom: null, kargo: null, diger: null});
    const row = (await f.ok(`/ec/performance?from=${gun(-10)}&to=${bugun}`)).rows.find(x => x.id === 'yalniz');
    assert.equal(row.cash_cents, null);
    const neden = row.missing[0] || row.cash_note;
    assert.ok(neden);
    const liste = (await f.ok('/ec/orders')).packages.find(p => p.id === 'yalniz');
    const ozet = await f.ok('/ec/orders/yalniz/insights');
    assert.equal(liste.cash_result_cents, null);
    assert.equal(liste.cash_note, neden, 'liste aynı nedeni taşır');
    assert.equal(ozet.cash_cents, null);
    assert.equal(ozet.cash_note, neden, 'pencere aynı nedeni taşır');
  } finally { f.close(); }
});
