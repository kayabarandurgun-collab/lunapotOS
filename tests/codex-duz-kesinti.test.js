// CODEX §3.9 (iade ayrımı) ve §3.4 (bilinmeyen sıfır değildir) — KESİNTİ AKTARIMI.
// DUZELTME-CIFT çift aktarım düzeltmesi teknik ters kayıttır: mal dönmedi, para iade edilmedi,
// pazaryeri komisyonu almaya devam etti. applyReportFees onu müşteri iadesi sayarsa (a) teslim
// beklemeden kesinti yazar, (b) raporda komisyon yoksa SIFIR komisyonu "kesinleşmiş" diye yazar.
// Kopyanın kesintileri kâr raporunda ikize taşındığı için bu sıfır doğrudan kâra şişme olarak geçer.
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
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st-ty','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-ty','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by,profile_id) VALUES('fl-ty','st-ty','finance','f.xlsx',10,'" + 'b'.repeat(64) + "','2026-09-06T10:00','S','[]',1,1,'applied','t','pf-ty')");
}
// Kesintisi HENÜZ yazılmamış paket (komisyon/kargo/diğer boş): aktarımın yazacağı kayıt budur.
function paket(f, id, tarih, {satis = 11000, maliyet = 4600, durum = 'delivered', siparis = 'S-' + id} = {}) {
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','trendyol','E-${id}','${siparis}','${tarih}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Torf 10 L',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('s-${id}','trendyol','X-${id}','p1','sale',1000,${satis},${maliyet},'pending','${tarih}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','p1',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${tarih}' WHERE id='${id}'`);
  if (durum === 'delivered') f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${tarih}' WHERE id='${id}'`);
}
// Satışın tamamının iadesi. duz: çift aktarım düzeltmesi (teknik ters kayıt), değilse müşteri iadesi.
const iade = (f, id, tarih, duz = false) => f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?")
  .run('r-' + id, (duz ? 'DUZELTME-CIFT-' : 'IADE-') + id, tarih, 's-' + id);
let rs = 0;
const raporSatiri = (f, {siparis, paket: pk, erp, tarih, teslim = null, durum = 'Teslim edildi'}) =>
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id,components_json) VALUES(?,'st-ty','order_line',?,'provider',?,'2026-09-06T10:00','fl-ty',?,?,?)")
    .run('rl' + (++rs), 'L:' + rs, JSON.stringify({order_no: siparis, package_id: pk, barcode: 'T10', product_name: 'Torf 10 L',
      quantity: 1, status: durum, order_date: tarih, delivered_date: teslim, gross: 13200}), rs, erp,
    JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]}));
// Pazaryeri ekstresindeki kesinti: eksi işaretli, KDV dahil (profil beyanı fee_vat_bps=2000).
const kesinti = (f, {siparis, paket: pk, tur, tutar, tarih}) =>
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,'st-ty','finance_event',?,'composite',?,'2026-09-07T10:00','fl-ty',?)")
    .run('fe' + (++rs), 'F:' + rs, JSON.stringify({event_id: 'E' + rs, order_no: siparis, package_id: pk, type: tur, amount_cents: -tutar, event_date: tarih}), rs);
const kesintiOf = (f, saleId) => ({...f.sqlite.prepare('SELECT commission_cents,shipping_cents,other_cents,fees_status FROM ec_sale_entries WHERE id=?').get(saleId)});
const karSatiri = async (f, id) => (await performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-20), to: bugun})).rows.find(r => r.id === id);

// ÇİFT AKTARIM İKİZİ: kopya teslimli ve raporla bağlı, satışı DUZELTME-CIFT ile sıfırlanmış;
// asıl kayıt "gönderildi"de duran satış faturasıdır. Kâr raporu kopyanın kesintilerini ikize taşır.
function ikiz(f, {komisyon = true, teslim = true} = {}) {
  paket(f, 'asil', gun(-6), {siparis: 'S-IKIZ', durum: 'shipped'});
  paket(f, 'kopya', gun(-4), {siparis: 'S-IKIZ'});
  iade(f, 'kopya', gun(-3), true);
  raporSatiri(f, {siparis: 'S-IKIZ', paket: 'PKD', erp: 'kopya', tarih: gun(-6), teslim: teslim ? gun(-4) : null, durum: teslim ? 'Teslim edildi' : 'Kargoda'});
  if (komisyon) kesinti(f, {siparis: 'S-IKIZ', paket: 'PKD', tur: 'commission', tutar: 4000, tarih: gun(-4)});
  kesinti(f, {siparis: 'S-IKIZ', paket: 'PKD', tur: 'cargo', tutar: 6000, tarih: gun(-4)});
}

test('DUZ teknik ters kaydı müşteri iadesi değildir: komisyonu gelmemiş rapor sıfır komisyon yazamaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f, {komisyon: false});                                   // ekstrede yalnız kargo var
    const onizleme = await f.ok('/ec/reports/apply-fees?store_id=st-ty');
    assert.equal(onizleme.sale_entries_changed, 0, 'komisyonu bilinmeyen paket yazılmaz');
    assert.ok(onizleme.skipped.some(x => /komisyon kesintisi yok/.test(x.reason)), 'gerekçe: ' + JSON.stringify(onizleme.skipped));
    await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});
    assert.deepEqual(kesintiOf(f, 's-kopya'), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'},
      'bilinmeyen komisyon sıfır yazılmadı');
    // Kopyanın kesintileri kâr raporunda ikize taşınır: sıfır yazılsaydı paket kesintisiz kârlı görünürdü.
    const satir = await karSatiri(f, 'asil');
    assert.equal(satir.cash_cents, null, 'kâr raporu: kesinti bilinmiyor, nakit sonuç uydurulmadı');
  } finally { f.close(); }
});

test('DUZ kopyası teslim edilmeden kesinti yazılmaz: teknik ters kayıt kargoyu kesinleştirmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f, {teslim: false});                                     // rapor "Kargoda" diyor
    const onizleme = await f.ok('/ec/reports/apply-fees?store_id=st-ty');
    assert.equal(onizleme.sale_entries_changed, 0);
    assert.ok(onizleme.skipped.some(x => /Teslim edilmedi/.test(x.reason)), 'gerekçe: ' + JSON.stringify(onizleme.skipped));
    assert.equal(kesintiOf(f, 's-kopya').shipping_cents, null);
  } finally { f.close(); }
});

test('DUZ kopyasına kesintiler normal teslim gibi yazılır; kâr raporu ikizde aynı kesintiyi görür', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f);                                                      // komisyon 40,00 + kargo 60,00 (KDV dahil)
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});
    assert.equal(yazildi.applied, 1, 'paket atlanmadı: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, 's-kopya'), {commission_cents: 3333, shipping_cents: 5000, other_cents: 0, fees_status: 'confirmed'},
      'KDV hariç komisyon 33,33 ve kargo 50,00');
    const satir = await karSatiri(f, 'asil');
    assert.equal(satir.cash_cents, 13200 - 5520 - 4000 - 6000, 'kâr raporu ikizde aynı kesintileri kullanır');
  } finally { f.close(); }
});

test('Gerçek müşteri iadesinde bugünkü davranış korunur: geri verilen komisyon sıfır yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Teslim edildi, sonra müşteri iade etti: pazaryeri komisyonu geri verdi (ekstrede yok), kargo kaldı.
    paket(f, 'gercek', gun(-6));
    iade(f, 'gercek', gun(-3));
    raporSatiri(f, {siparis: 'S-gercek', paket: 'PKG', erp: 'gercek', tarih: gun(-6), teslim: gun(-5), durum: 'İade Edildi'});
    kesinti(f, {siparis: 'S-gercek', paket: 'PKG', tur: 'cargo', tutar: 6000, tarih: gun(-4)});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});
    assert.equal(yazildi.applied, 1, 'gerçek iade kesinleşmiştir: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, 's-gercek'), {commission_cents: 0, shipping_cents: 5000, other_cents: 0, fees_status: 'confirmed'},
      'iadede komisyonun sıfır olması eksik veri değildir');
  } finally { f.close(); }
});
