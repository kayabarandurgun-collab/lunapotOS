// CODEX §3.1 (tek ekonomik sonuç) ve §3.4 (bilinmeyen sıfır değildir) — RAPOR KUTUSU "Sipariş sonuçları".
// Deftere bağlı paketin sonucu kâr raporunun AYNI satırından gelmeli: kâr raporu (/api/ec/performance),
// sipariş listesi (/api/ec/orders) ve Rapor Kutusu aynı pakette aynı kuruşu göstermeli. Eksik kesinti
// sıfır sayılmaz, tahmin "tahmini" diye işaretlenir, çift aktarım kopyası ikinci kez sayılmaz.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {performanceReport} from '../src/performance-api.js';
import {orderResults} from '../src/report-inbox-api.js';
import {scopedDB} from '../src/scoped-db.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);
const ecEnv = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4600000');
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-hb','hepsiburada','HB','HB'),('st-ty','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-ty','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  for (const [id, st, c] of [['fl-hb', 'st-hb', 'a'], ['fl-ty', 'st-ty', 'b']])
    f.sqlite.exec(`INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('${id}','${st}','orders','f.xlsx',10,'${c.repeat(64)}','2026-09-06T10:00','S','[]',1,1,'applied','t')`);
}
// Tek satırlı paket; tutarlar KDV hariç kuruş. Varsayılan: satış 110,00 (KDV dahil 132,00), maliyet 46,00
// (55,20), kesinti 16,10 + 30,00 + 5,00 (KDV dahil 61,32) → katkı 12,90, cebine kalan 15,48.
function paket(f, id, kanal, tarih, {satis = 11000, maliyet = 4600, kom = 1610, kargo = 3000, diger = 500, durum = 'delivered', siparis = 'S-' + id} = {}) {
  const q = v => v === null ? 'NULL' : v, tam = kom !== null && kargo !== null && diger !== null;
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${kanal}','E-${id}','${siparis}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Torf 10 L',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${kanal}','X-${id}','p1','sale',1000,${satis},${maliyet},${q(kom)},${q(kargo)},${q(diger)},'${tam ? 'confirmed' : 'pending'}','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','p1',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  if (durum === 'delivered') f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}
// Satışın tamamının iadesi (stoğa döner). duz: çift aktarım düzeltmesi (teknik ters kayıt).
const iade = (f, id, tarih, duz = false) => f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?")
  .run('r-' + id, (duz ? 'DUZELTME-CIFT-' : 'IADE-') + id, tarih, 's-' + id);
// Rapor Kutusu'ndaki sipariş satırı: defterdeki paketle bağlı (erp_package_id) ve ürün eşleşmesi çözülmüş.
let rs = 0;
const raporSatiri = (f, {kanal = 'trendyol', siparis, paket: pk, erp, tarih, teslim = null, brut = 13200, durum = 'Teslim edildi', gozlem = '2026-09-06T10:00'}) => {
  const store = kanal === 'trendyol' ? 'st-ty' : 'st-hb';
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id,components_json) VALUES(?,?,'order_line',?,'provider',?,?,?,?,?,?)")
    .run('rl' + (++rs), store, 'L:' + rs, JSON.stringify({order_no: siparis, package_id: pk, barcode: 'T10', product_name: 'Torf 10 L',
      quantity: 1, status: durum, order_date: tarih, delivered_date: teslim, gross: brut}), gozlem, store === 'st-ty' ? 'fl-ty' : 'fl-hb', rs, erp,
    JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]}));
};
// Üç ekranın aynı pakete verdiği rakamlar: kâr raporu satırı, sipariş listesi satırı, Rapor Kutusu satırı.
async function ucEkran(f, store = 'st-ty') {
  const [perf, liste, kutu] = await Promise.all([
    performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-20), to: bugun}),
    f.ok('/ec/orders'),
    orderResults(scopedDB(f.env.DB, 'ec'), store, {})
  ]);
  return {
    perf: new Map(perf.rows.map(r => [r.id, r])),
    liste: new Map(liste.packages.map(p => [p.id, p])),
    kutu: new Map(kutu.results.map(r => [r.erp_package_id, r]))
  };
}

test('Rapor Kutusu sipariş sonuçları: gerçekleşen, tahmini ve hesaplanamayan paket kâr raporuyla aynı kuruşu gösterir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'gecmis', 'trendyol', gun(-6));                                                          // gerçekleşen kesinti
    paket(f, 'bekleyen', 'trendyol', gun(-3), {kom: null, kargo: null, diger: null});                 // kesinti ekstreye yazılmadı → tahmin
    paket(f, 'yalniz', 'hepsiburada', gun(-3), {kom: null, kargo: null, diger: null});                // HB'de geçmiş yok → hesaplanamaz
    raporSatiri(f, {siparis: 'S-gecmis', paket: 'PK1', erp: 'gecmis', tarih: gun(-6), teslim: gun(-6)});
    raporSatiri(f, {siparis: 'S-bekleyen', paket: 'PK2', erp: 'bekleyen', tarih: gun(-3), teslim: gun(-3)});
    raporSatiri(f, {kanal: 'hepsiburada', siparis: 'S-yalniz', paket: 'PK3', erp: 'yalniz', tarih: gun(-3), teslim: gun(-3)});

    const ty = await ucEkran(f), hb = await ucEkran(f, 'st-hb');
    // Gerçekleşen kesinti: üç ekran da 12,90 katkı / 15,48 nakit.
    assert.equal(ty.perf.get('gecmis').profit_cents, 1290);
    assert.equal(ty.kutu.get('gecmis').contribution_cents, 1290, 'Rapor Kutusu katkısı kâr raporunun satırı');
    assert.equal(ty.kutu.get('gecmis').cash_result_cents, ty.perf.get('gecmis').cash_cents, 'nakit sonuç da aynı');
    assert.equal(ty.kutu.get('gecmis').cash_result_cents, ty.liste.get('gecmis').cash_result_cents, 'sipariş listesiyle aynı');

    // Kesintisi ekstreye yazılmamış teslim: geçmişten TAHMİN; üç ekran aynı tutar ve aynı tahmin işareti.
    assert.equal(ty.perf.get('bekleyen').fees_estimated, true);
    assert.notEqual(ty.kutu.get('bekleyen').contribution_cents, 6400, 'eksik kesinti sıfır sayılıp 64,00 katkı çıkmamalı');
    assert.equal(ty.kutu.get('bekleyen').contribution_cents, 1290, 'tahmini kesintiyle 12,90');
    assert.equal(ty.kutu.get('bekleyen').cash_result_cents, 1548);
    assert.equal(ty.kutu.get('bekleyen').result_estimated, true, 'Rapor Kutusu da "tahmini" der');
    assert.equal(ty.liste.get('bekleyen').cash_result_cents, ty.kutu.get('bekleyen').cash_result_cents);

    // Hesaplanamayan paket: sıfır değil, BOŞ ve kısa sebep. Üç ekranda aynı.
    const perfYalniz = hb.perf.get('yalniz'), kutuYalniz = hb.kutu.get('yalniz');
    assert.equal(perfYalniz.cash_cents, null);
    assert.notEqual(kutuYalniz.contribution_cents, 6400, 'bilinmeyen kesinti sıfır sayılıp 64,00 çıkmamalı');
    assert.equal(kutuYalniz.contribution_cents, null, 'hesaplanmadı');
    assert.equal(kutuYalniz.cash_result_cents, null);
    assert.equal(hb.liste.get('yalniz').cash_result_cents, null);
    const neden = perfYalniz.missing[0] || perfYalniz.cash_note;
    assert.ok(kutuYalniz.contribution_missing.includes(neden), 'kâr raporuyla aynı kısa sebep: ' + JSON.stringify(kutuYalniz.contribution_missing));
  } finally { f.close(); }
});

test('Rapor Kutusu: çift aktarım kopyası ikinci kez sayılmaz, sonuç asıl kayıtta bir kez görünür', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Çift aktarım: asıl kayıt (satış faturası) "gönderildi"de kaldı; rapor kopyası teslimli, pazaryeri
    // kesintileri kopyada, kopyanın satışı DUZELTME-CIFT ile sıfırlandı. Rapor satırı KOPYAYA bağlı.
    paket(f, 'asil', 'trendyol', gun(-6), {siparis: 'S-IKIZ', durum: 'shipped', kom: null, kargo: null, diger: null});
    paket(f, 'kopya', 'trendyol', gun(-4), {siparis: 'S-IKIZ'});
    iade(f, 'kopya', gun(-3), true);
    raporSatiri(f, {siparis: 'S-IKIZ', paket: 'PKD', erp: 'kopya', tarih: gun(-6), teslim: gun(-4)});
    // İkinci ikiz: rapor satırı ASIL kayda bağlı (defterde "gönderildi" durur ama sonucu teslim edilmiştir).
    paket(f, 'asil2', 'trendyol', gun(-6), {siparis: 'S-IKIZ2', durum: 'shipped', kom: null, kargo: null, diger: null});
    paket(f, 'kopya2', 'trendyol', gun(-4), {siparis: 'S-IKIZ2'});
    iade(f, 'kopya2', gun(-3), true);
    raporSatiri(f, {siparis: 'S-IKIZ2', paket: 'PKD2', erp: 'asil2', tarih: gun(-6), teslim: gun(-4)});

    const {perf, liste, kutu} = await ucEkran(f);
    assert.equal(perf.get('asil').cash_cents, 1548, 'kâr raporu: sonuç asıl kayıtta bir kez');
    assert.equal(liste.get('kopya').cash_result_cents, null, 'sipariş listesi: kopya ikinci kez sayılmaz');
    const kopya = kutu.get('kopya');
    assert.notEqual(kopya.contribution_cents, 11000, 'kopyanın sıfırlanmış satışı 110,00 katkı gibi görünmemeli');
    assert.equal(kopya.contribution_cents, null, 'Rapor Kutusu da kopyayı ikinci kez saymaz');
    assert.equal(kopya.cash_result_cents, null);
    assert.ok(kopya.contribution_missing.some(n => /kopya/i.test(n)), 'sebebi söylenir: ' + JSON.stringify(kopya.contribution_missing));
    // Rapor satırı asıl kayda bağlıysa paketin TEK sonucu orada görünür.
    assert.equal(kutu.get('asil2').contribution_cents, perf.get('asil2').profit_cents);
    assert.equal(kutu.get('asil2').cash_result_cents, 1548, 'ikizin sonucu Rapor Kutusu\'nda da 15,48');
  } finally { f.close(); }
});

test('Rapor Kutusu: yeniden numaralanan paketin sonucu iki satıra iki kez yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Pazaryeri aynı siparişe yeni paket numarası verdi (canlıda HB 4731515470: 5517911182 → 5518837752).
    // İki rapor satırı da AYNI defter paketine bağlı: sonuç bir kez sayılır.
    paket(f, 'tek', 'trendyol', gun(-5));
    raporSatiri(f, {siparis: 'S-tek', paket: 'ESKI-NO', erp: 'tek', tarih: gun(-5), teslim: gun(-5)});
    raporSatiri(f, {siparis: 'S-tek', paket: 'YENI-NO', erp: 'tek', tarih: gun(-5), teslim: gun(-5), gozlem: '2026-09-08T10:00'});

    const kutu = (await orderResults(scopedDB(f.env.DB, 'ec'), 'st-ty', {})).results;
    assert.equal(kutu.length, 2, 'iki paket numarası iki satır');
    const yazan = kutu.filter(r => r.contribution_cents !== null);
    assert.equal(yazan.length, 1, 'sonuç tek satırda: ' + JSON.stringify(kutu.map(r => [r.package_id, r.contribution_cents])));
    assert.equal(yazan[0].package_id, 'YENI-NO', 'en son görülen paket numarası sayılır');
    assert.equal(yazan[0].contribution_cents, 1290);
    const oteki = kutu.find(r => r.package_id === 'ESKI-NO');
    assert.ok(oteki.contribution_missing.some(n => /bir kez/.test(n)), 'sebebi söylenir: ' + JSON.stringify(oteki.contribution_missing));
  } finally { f.close(); }
});

test('Rapor Kutusu: teslim edilemeyip dönen paketin gideri kâr raporundaki gibi gösterilir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Satış iadeyle sıfırlandı ama gidiş-dönüş kargosu ve hizmet bedeli gerçek giderdir.
    paket(f, 'donen', 'trendyol', gun(-6), {durum: 'shipped'});
    iade(f, 'donen', gun(-4));
    raporSatiri(f, {siparis: 'S-donen', paket: 'PKI', erp: 'donen', tarih: gun(-6), teslim: null, durum: 'İade Edildi'});

    const {perf, liste, kutu} = await ucEkran(f);
    assert.equal(perf.get('donen').cash_cents, -6132, 'kâr raporu: kalan gider KDV dahil 61,32');
    assert.equal(perf.get('donen').profit_cents, -5110);
    assert.equal(liste.get('donen').cash_result_cents, -6132, 'sipariş listesi aynı');
    assert.equal(kutu.get('donen').contribution_cents, -5110, 'Rapor Kutusu da aynı zararı gösterir');
    assert.equal(kutu.get('donen').cash_result_cents, -6132);
  } finally { f.close(); }
});
