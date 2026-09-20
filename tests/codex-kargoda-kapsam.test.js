// KARGODAKİ TAHMİN — devir notundaki iki kalan madde.
//  1) KAPSAM: ana sayfanın "Kargodaki tahminim" kartı ile ürün kârlılığının kargoda tutarı AYNI paketleri
//     sayar: gönderilen + hazırlanan (stok ayrılmış) paketler. İki ekranın toplamı kuruşu kuruşuna aynıdır
//     ve ürün bazındaki paylar bu toplamı verir.
//  2) ADET UYUMU: kesinti tahmincisinin (R23) uyum bilgisi kâr yoluna da taşınır. Benzer adette teslim
//     geçmişi yoksa satır 'uzak'/'yok' diye işaretlenir ve kısa Türkçe not döner; TUTARLAR DEĞİŞMEZ
//     (bugünkü rakam ne ise o kalır, yalnız belirsizlik görünür olur).
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet'),('p2','Perlit 5 L','P5','adet'),('p3','Kaktüs Toprağı','K3','adet')");
  for (const p of ['p1', 'p2', 'p3']) f.sqlite.exec(`INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('${p}',2000,0,0,0,0,100,100,100,500,1)`);
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=10000000,value_cents=46000000');   // birim maliyet 46,00
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-ty','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-hb','hepsiburada','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
}

// Tek satırlı paket. KDV hariç kuruş: adet başına satış 110,00 (KDV dahil 132,00), maliyet 46,00 (55,20).
// Teslim edilende kesintiler gerçek (16,10 + 30,00 + 5,00); kargodakinde ekstre henüz yok (NULL).
// durum: delivered (kesintili teslim) | shipped (kargoda) | reserved (hazırlanıyor, satış kaydı yok).
function paket(f, id, {kanal = 'trendyol', urun = 'p1', tarih, adet = 1, durum = 'delivered'} = {}) {
  const q = adet * 1000, satis = 11000 * adet, maliyet = 4600 * adet;
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${kanal}','E-${id}','S-${id}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','İlan',${q},${satis},${Math.round(satis * 1.2)},2000)`);
  if (durum === 'reserved') {
    f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','${urun}',${q},10000,NULL,'adet')`);
    f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
    return;
  }
  const teslim = durum === 'delivered';
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${kanal}','X-${id}','${urun}','sale',${q},${satis},${maliyet},${teslim ? 1610 : 'NULL'},${teslim ? 3000 : 'NULL'},${teslim ? 500 : 'NULL'},'${teslim ? 'confirmed' : 'pending'}','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','${urun}',${q},10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  if (teslim) f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}

test('Kargoda kapsamı: ürün kârlılığı ana sayfayla aynı paketleri sayar (gönderilen + hazırlanan)', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'teslim', {tarih: gun(-3)});                                  // geçmiş: tahminin kaynağı, 15,48
    paket(f, 'yolda', {tarih: gun(-4), durum: 'shipped'});                 // kargoda
    paket(f, 'hazir', {tarih: gun(-6), urun: 'p2', durum: 'reserved'});    // hazırlanıyor: ana sayfa sayıyor
    const p = await f.ok('/ec/panorama');
    assert.equal(p.pending.packages, 2, 'ana sayfa: gönderilen + hazırlanan');
    assert.equal(p.pending.cash_cents, 3096, 'iki paket × 15,48');
    const k = await f.ok('/ec/urun-karlilik');
    const by = new Map(k.rows.map(r => [r.product_id, r]));
    assert.equal(k.rows.reduce((t, r) => t + r.kargoda_kar_cents, 0), p.pending.cash_cents, 'ürün kârlılığı = ana sayfa (aynı kapsam)');
    assert.equal(k.rows.reduce((t, r) => t + r.kargoda_paket, 0), 2, 'hazırlanan paket de sayılır');
    assert.equal(by.get('p1').kargoda_kar_cents, 1548, 'ürün payları toplamı verir');
    assert.equal(by.get('p2').kargoda_kar_cents, 1548);
    assert.equal(by.get('p2').tahmini_paket, 1, 'kargodaki paket tahmini sayılır');
    // Teslim edilenler kapsamı değişmedi: ana sayfanın tüm zamanlar toplamıyla aynı.
    const tum = p.periods.find(x => x.key === 'tum');
    assert.equal(k.rows.reduce((t, r) => t + r.teslim_kar_cents, 0), tum.cash_cents, 'teslim toplamı yine aynı');
    assert.match(k.notice, /hazırlan/i, 'neyin sayıldığı yazıyor');
  } finally { f.close(); }
});

test('Kargoda tahmini: benzer adette teslim geçmişi yoksa satır kaba işaretlenir, tutar değişmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'g1', {tarih: gun(-5)});                                      // 1 adetlik teslim geçmişi
    paket(f, 'g2', {tarih: gun(-4)});
    paket(f, 'kaba', {tarih: gun(-2), adet: 10, durum: 'shipped'});        // 10 adet: benzer geçmiş yok
    paket(f, 'uyumlu', {tarih: gun(-2), durum: 'shipped'});                // 1 adet: aynı içerik geçmişi var
    paket(f, 'kanal', {tarih: gun(-2), urun: 'p3', durum: 'shipped'});     // bu ürünün teslimi hiç yok
    const r = await f.ok(`/ec/performance?mode=pending&from=${gun(-10)}&to=${bugun}`);
    const row = id => r.rows.find(x => x.id === id);
    assert.equal(row('uyumlu').tahmin_uyum, 'ayni', 'aynı adetli geçmiş: uyumlu');
    assert.ok(!row('uyumlu').tahmin_uyari, 'uyumlu satırda uyarı yok');
    assert.equal(row('kaba').tahmin_uyum, 'uzak', '10 adetlik pakete 1 adetlik geçmiş');
    assert.match(row('kaba').tahmin_uyari, /kaba/i, 'kısa Türkçe not: ' + row('kaba').tahmin_uyari);
    assert.match(row('kaba').tahmin_uyari, /10/, 'istenen adet yazılı');
    assert.equal(row('kanal').tahmin_uyum, 'yok', 'ürünün teslimi yok: kanal ortancası');
    assert.ok(row('kanal').tahmin_uyari, 'kanal ortancası da kaba sayılır');
    // TUTARLAR BUGÜNKÜ HÂLİNDE: formül değişmedi, yalnız belirsizlik görünür oldu.
    assert.equal(row('kaba').shipping_cents, 3000, 'bugünkü davranış: 10 adetlik pakete tek adetlik kargo (30,00)');
    assert.equal(row('kaba').cash_cents, 53280);
    assert.equal(row('uyumlu').cash_cents, 1548);
    assert.equal(row('kanal').cash_cents, 1548);
    // Ana sayfa kaç paketin kaba tahmin olduğunu söyler; toplam aynı kalır.
    const p = await f.ok('/ec/panorama');
    assert.equal(p.pending.packages, 3);
    assert.equal(p.pending.cash_cents, 53280 + 1548 + 1548);
    assert.equal(p.pending.kaba_tahmin, 2, 'kaba tahminli paket sayısı ana sayfaya taşınır');
  } finally { f.close(); }
});
