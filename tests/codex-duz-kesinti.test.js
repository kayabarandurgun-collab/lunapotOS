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

test('Gerçek müşteri iadesinde ekstre komisyonu 0,00 BEYAN ederse sıfır yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Teslim edildi, sonra müşteri iade etti: pazaryeri komisyonu geri verdi ve ekstrede 0,00 yazdı.
    paket(f, 'gercek', gun(-6));
    iade(f, 'gercek', gun(-3));
    raporSatiri(f, {siparis: 'S-gercek', paket: 'PKG', erp: 'gercek', tarih: gun(-6), teslim: gun(-5), durum: 'İade Edildi'});
    kesinti(f, {siparis: 'S-gercek', paket: 'PKG', tur: 'cargo', tutar: 6000, tarih: gun(-4)});
    kesinti(f, {siparis: 'S-gercek', paket: 'PKG', tur: 'commission', tutar: 0, tarih: gun(-4)});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});
    assert.equal(yazildi.applied, 1, 'gerçek iade kesinleşmiştir: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, 's-gercek'), {commission_cents: 0, shipping_cents: 5000, other_cents: 0, fees_status: 'confirmed'},
      'pazaryerinin beyan ettiği sıfır gerçek sıfırdır');
  } finally { f.close(); }
});

test('Gerçek müşteri iadesinde komisyon satırı HİÇ yoksa sıfır uydurulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Aynı senaryo ama ekstrede komisyon satırı hiç yok: tutar bilinmiyor, yazılmaz (§3.4).
    paket(f, 'gercek', gun(-6));
    iade(f, 'gercek', gun(-3));
    raporSatiri(f, {siparis: 'S-gercek', paket: 'PKG', erp: 'gercek', tarih: gun(-6), teslim: gun(-5), durum: 'İade Edildi'});
    kesinti(f, {siparis: 'S-gercek', paket: 'PKG', tur: 'cargo', tutar: 6000, tarih: gun(-4)});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});
    assert.equal(yazildi.applied, 0, 'bilinmeyen komisyon yazıldı');
    assert.ok(yazildi.skipped.some(x => /komisyon/.test(x.reason)), JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, 's-gercek'), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'});
  } finally { f.close(); }
});

// ERP'DE KARŞILIĞI OLMAYAN PAKET SESSİZCE ELENMEZ. Eskiden `results.filter(r => r.erp_package_id)`
// ile atılıyor, atlananlar listesine bile girmiyordu: kullanıcı "bu paketin kesintisi neden
// yazılmadı" diye sorduğunda ekranda hiçbir sebep bulamıyordu (sebebi bulmak saatler aldı).
test('Panelde karşılığı olmayan paket sebebiyle listelenir, sessizce yutulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    // Rapor bu paketi tanıyor ama panelde karşılığı yok (erp_package_id boş).
    raporSatiri(f, {siparis: 'S-YOK', paket: 'PK-YOK', erp: null, tarih: gun(-6), teslim: gun(-4)});
    kesinti(f, {siparis: 'S-YOK', paket: 'PK-YOK', tur: 'commission', tutar: 4000, tarih: gun(-4)});
    kesinti(f, {siparis: 'S-YOK', paket: 'PK-YOK', tur: 'cargo', tutar: 6000, tarih: gun(-4)});

    const onizleme = await f.ok('/ec/reports/apply-fees?store_id=st-ty');
    assert.equal(onizleme.sale_entries_changed, 0, 'bağlı satış olmadan kesinti yazılmaz');
    assert.ok(onizleme.skipped.some(x => /karşılığı olan sipariş yok/.test(x.reason)),
      'sebep ekranda görünmeli: ' + JSON.stringify(onizleme.skipped));
  } finally { f.close(); }
});

// TESLİM BİLGİSİ ÇİFT AKTARIM KOPYASINDA KALMIŞSA ASIL KAYDA DA GEÇER. Eski aktarımda aynı paket
// panele iki kez girdi: kopyada teslim bilgisi, asıl kayıtta satış ve maliyet. Kopyanın satışları
// DUZELTME-CIFT ile sıfırlandı ama rapor bağı kopyada kaldı; asıl kayıt teslim bilgisini hiç
// alamadığı için canlıda 6 paket 25–27 gün "kargoda" göründü.
test('Çift aktarım kopyası teslim edilmişse ikizin durumu da teslime geçer; tarih kopyadan alınır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f);                                                   // asil: shipped, kopya: delivered
    const once = f.sqlite.prepare("SELECT status,delivered_on FROM ec_order_packages WHERE id='asil'").get();
    assert.equal(once.status, 'shipped', 'asıl kayıt kargoda başlıyor');

    const onizleme = await f.ok('/ec/reports/sync-deliveries?store_id=st-ty');
    const satir = onizleme.packages.find(x => x.id === 'asil');
    assert.ok(satir, 'asıl kayıt teslim onayı bekleyenler arasında görünmeli: ' + JSON.stringify(onizleme.packages));
    const kopya = f.sqlite.prepare("SELECT delivered_on FROM ec_order_packages WHERE id='kopya'").get();
    assert.equal(satir.gun, String(kopya.delivered_on).slice(0, 10), 'tarih uydurulmaz, kopyanınki yazılır');

    await f.ok('/ec/reports/sync-deliveries', {confirm: true});
    const sonra = f.sqlite.prepare("SELECT status,delivered_on FROM ec_order_packages WHERE id='asil'").get();
    assert.equal(sonra.status, 'delivered');
    assert.equal(String(sonra.delivered_on).slice(0, 10), satir.gun);
  } finally { f.close(); }
});

test('Kendi rapor bağı olan kargodaki paket, ikizin tarihiyle teslime geçirilmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f);
    // Asıl kaydın KENDİ rapor satırı var ve orada teslim tarihi yok: karar raporundur, ikizin değil.
    raporSatiri(f, {siparis: 'S-IKIZ', paket: 'PKA', erp: 'asil', tarih: gun(-6), teslim: null, durum: 'Kargoda'});
    const onizleme = await f.ok('/ec/reports/sync-deliveries?store_id=st-ty');
    assert.ok(!onizleme.packages.some(x => x.id === 'asil'),
      'kendi raporu teslim demiyorsa ikizin tarihi uygulanmamalı: ' + JSON.stringify(onizleme.packages));
  } finally { f.close(); }
});

// İKİZ DE TESLİME GEÇTİĞİNDE KOPYA HAYALET KÂR YAZMAZ. Kopyanın geliri ters kayıtla sıfırlanmıştır
// ama pazaryeri kesintileri satırında durur; iade satırındaki eksi işaretli kesintiler kopyayı
// "kârlı" gösteriyordu. Kopya yalnız ikiz listede YOKKEN onun yerine geçerdi; ikiz de teslim
// edildiğinde ikisi birden sayılıp kâr şişiyordu (canlıda 6 paket, +1.452,24 TL).
test('Kopya ve ikiz birlikte teslim edildiğinde kâr iki kez sayılmaz; kesinti ikize taşınır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    ikiz(f);
    await f.ok('/ec/reports/apply-fees', {store_id: 'st-ty', confirm: true});   // kesintiler kopyaya yazılır

    const once = await karSatiri(f, 'asil');
    assert.ok(once, 'ikiz, kopyanın yerine geçerek kâr raporunda görünür');
    const kopyaOnce = await karSatiri(f, 'kopya');
    assert.ok(!kopyaOnce, 'kopya kendi başına satır açmaz');

    // Rapor eşitlemesi asıl kaydı da teslime alır: ikisi birden "teslim edildi" olur.
    await f.ok('/ec/reports/sync-deliveries', {confirm: true});
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_order_packages WHERE id='asil'").get().status, 'delivered');

    const sonra = await karSatiri(f, 'asil');
    assert.ok(sonra, 'ikiz kendi başına raporda kalmalı');
    const kopyaSonra = await karSatiri(f, 'kopya');
    assert.ok(!kopyaSonra, 'kopya listeden düşmeli, hayalet kâr yazmamalı');
    assert.equal(sonra.profit_cents, once.profit_cents,
      'teslim durumu değişti diye kâr değişmemeli: ' + once.profit_cents + ' → ' + sonra.profit_cents);
    assert.equal(sonra.commission_cents, once.commission_cents, 'kesinti ikize taşınmalı, tahmine düşmemeli');
  } finally { f.close(); }
});

// STOPAJI RAPORLAMAYAN KANAL İÇİN TAHMİN. Ölçüldü (28.09.2026): Hepsiburada teslim edilmiş 205
// siparişin 205'inde stopajı bildiriyor; Trendyol'un sipariş raporunda stopaj SÜTUNU YOK ve 548
// siparişin hiçbirinde kayıt gelmiyor. Kayıt yokken sıfır saymak o kanalın nakit sonucunu
// olduğundan yüksek gösteriyordu. Oran pazaryerinin kendi verisinden çıkarıldı: KDV hariç satışın
// %1'i (HB doğrulaması: tahmin 598,73 TL / gerçek 599,87 TL).
const kesintiliPaket = (f, id, satis = 100000, siparis = 'S-' + id) => {
  paket(f, id, gun(-5), {satis, siparis});
  f.sqlite.exec(`UPDATE ec_sale_entries SET commission_cents=1000,shipping_cents=2000,other_cents=0,fees_status='confirmed' WHERE id='s-${id}'`);
};

test('Stopaj tahmini varsayılan olarak KAPALIDIR; rakam kendiliğinden kaymaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    kesintiliPaket(f, 'p-kapali');
    const satir = await karSatiri(f, 'p-kapali');
    assert.ok(satir, 'satır hesaplanmalı');
    assert.equal(satir.withholding_cents, 0, 'ayar açılmadan stopaj düşülmemeli');
    assert.ok(!satir.withholding_estimated, 'tahmin işareti konmamalı');
  } finally { f.close(); }
});

test('Kanal işaretlenince stopaj ölçülen oranla tahmin edilir ve "tahmini" işaretlenir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("UPDATE workspace_settings SET withholding_estimate_channels='trendyol' WHERE workspace='ec'");
    kesintiliPaket(f, 'p-tahmin');                            // KDV hariç 1.000,00 TL satış
    const satir = await karSatiri(f, 'p-tahmin');
    assert.equal(satir.withholding_cents, -1000, "KDV hariç satışın %1'i düşülmeli");
    assert.ok(satir.fees_estimated && satir.withholding_estimated, 'satır tahmini işaretini taşımalı: ' + JSON.stringify({f: satir.fees_estimated, w: satir.withholding_estimated, n: satir.cash_note}));
  } finally { f.close(); }
});

test('Gerçek stopaj kaydı varsa tahmin kullanılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("UPDATE workspace_settings SET withholding_estimate_channels='trendyol' WHERE workspace='ec'");
    kesintiliPaket(f, 'p-gercek', 100000, 'S-GERCEK');
    kesinti(f, {siparis: 'S-GERCEK', paket: 'PKG', tur: 'withholding', tutar: 250, tarih: gun(-4)});
    const satir = await karSatiri(f, 'p-gercek');
    assert.equal(satir.withholding_cents, -250, 'ölçülen tutar geçerli, tahmin devreye girmemeli');
  } finally { f.close(); }
});
