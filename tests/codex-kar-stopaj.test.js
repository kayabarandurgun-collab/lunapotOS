// CODEX R18 — Sipariş stopajı ekonomik paketlere tam dağılır. DUZELTME-CIFT kopyası teknik ters kayıttır:
// asıl kayıtla birlikte TEK ekonomik paket sayılır; stopaj ikiye bölünüp yarısı kaybolmaz. Gerçek iki
// paketli siparişte payların toplamı finans olayına kuruşu kuruşuna eşittir (yuvarlama artığı korunur).
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
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4600000');
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-hb','hepsiburada','HB','HB'),('st-ty','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-ty','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  for (const [id, st, c] of [['fl-hb', 'st-hb', 'a'], ['fl-ty', 'st-ty', 'b']])
    f.sqlite.exec(`INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES('${id}','${st}','finance','f.xlsx',10,'${c.repeat(64)}','2026-09-06T10:00','S','[]',1,1,'applied','t')`);
}
function paket(f, id, kanal, tarih, {satis = 11000, maliyet = 4600, kom = 1610, kargo = 3000, diger = 500, durum = 'delivered', siparis = 'S-' + id} = {}) {
  const q = v => v === null ? 'NULL' : v, tam = kom !== null && kargo !== null && diger !== null;
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${kanal}','E-${id}','${siparis}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Ürün',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${kanal}','X-${id}','p1','sale',1000,${satis},${maliyet},${q(kom)},${q(kargo)},${q(diger)},'${tam ? 'confirmed' : 'pending'}','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','p1',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  if (durum === 'delivered') f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}
// Satışın tamamının iadesi (stoğa döner). duz: çift aktarım düzeltmesi (teknik ters kayıt).
const iade = (f, id, tarih, duz = false) => f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?")
  .run('r-' + id, (duz ? 'DUZELTME-CIFT-' : 'IADE-') + id, tarih, 's-' + id);
let sira = 0;
const stopaj = (f, kanal, siparis, tutar) => f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,?,'finance_event',?,'provider',?,'2026-09-06T10:00',?,?)")
  .run('w' + (++sira), kanal === 'trendyol' ? 'st-ty' : 'st-hb', 'W:' + sira, JSON.stringify({order_no: siparis, type: 'withholding', amount_cents: tutar}), kanal === 'trendyol' ? 'fl-ty' : 'fl-hb', sira);

test('R18: çift kayıt ikizinin stopajı tek ekonomik pakete TAM düşer; gerçek iki paketin payları olayla eşit', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Çift aktarım: asıl kayıt (satış faturası, kesintisiz) "gönderildi"de kaldı; rapor kopyası teslimli,
    // pazaryeri kesintileri kopyada, kopyanın satışı DUZELTME-CIFT ile sıfırlandı.
    paket(f, 'asil', 'trendyol', gun(-6), {siparis: 'S-IKIZ', durum: 'shipped', kom: null, kargo: null, diger: null});
    paket(f, 'kopya', 'trendyol', gun(-4), {siparis: 'S-IKIZ'});
    iade(f, 'kopya', gun(-3), true);
    stopaj(f, 'trendyol', 'S-IKIZ', -200);
    // Gerçekten iki paketli HB siparişi, tek sayılı stopaj: 10,01 TL.
    paket(f, 'r1', 'hepsiburada', gun(-4), {siparis: 'S-IKI'});
    paket(f, 'r2', 'hepsiburada', gun(-4), {siparis: 'S-IKI'});
    stopaj(f, 'hepsiburada', 'S-IKI', -1001);

    const r = await performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-10), to: bugun, detay: true});
    const ikiz = r.rows.filter(x => x.order_no === 'S-IKIZ');
    assert.equal(ikiz.length, 1, 'ikiz tek ekonomik paket');
    assert.equal(ikiz[0].id, 'asil', 'asıl kayıt hesaplanır');
    assert.equal(ikiz[0].withholding_cents, -200, 'stopajın tamamı düşer (yarısı değil)');
    assert.equal(ikiz[0].cash_cents, 1548 - 200);
    const iki = r.rows.filter(x => x.order_no === 'S-IKI');
    assert.equal(iki.length, 2);
    assert.equal(iki.reduce((t, x) => t + x.withholding_cents, 0), -1001, 'paylar toplamı finans olayına eşit (−10,02 değil)');
    assert.ok(iki.every(x => [-500, -501].includes(x.withholding_cents)), 'kuruş artığı tek pakete yazılır');
    // Ürün katkıları paket nakdini bozmaz.
    for (const x of [...ikiz, ...iki]) assert.equal(x.urunler.reduce((t, u) => t + u.cash_cents, 0), x.cash_cents);
    // Diğer görünümler aynı payı kullanır.
    const liste = new Map((await f.ok('/ec/orders')).packages.map(p => [p.id, p]));
    assert.equal(liste.get('asil').cash_result_cents, 1548 - 200, 'liste: asıl kayıt');
    assert.equal(liste.get('kopya').cash_result_cents, null, 'liste: teknik kopya ikinci kez sayılmaz');
    assert.equal(liste.get('r1').cash_result_cents + liste.get('r2').cash_result_cents, 2 * 1548 - 1001);
    const o1 = await f.ok('/ec/orders/r1/insights'), o2 = await f.ok('/ec/orders/r2/insights');
    assert.equal(o1.withholding_cents + o2.withholding_cents, 1001, 'pencere: paylar toplamı olaya eşit');
    assert.equal((await f.ok('/ec/orders/asil/insights')).cash_cents, 1548 - 200, 'pencere: asıl kayıt');
    const u = (await f.ok('/ec/urun-karlilik')).rows.find(x => x.product_id === 'p1');
    assert.equal(u.kar_cents, (1548 - 200) + 2 * 1548 - 1001, 'ürün kârlılığı: ikiz bir kez, stopaj tam');
  } finally { f.close(); }
});
