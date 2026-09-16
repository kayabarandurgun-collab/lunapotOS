// Kullanıcı KDV hariç katkıyı değil, CEBİNE KALAN parayı görmek istiyor.
// Kanıtlanan: nakit sonuç = KDV dahil satış − KDV dahil mal maliyeti − KDV dahil kesintiler,
// kesinti KDV oranı UYDURULMAZ (rapor profilinde beyan yoksa nakit sonuç boş kalır),
// ve kâr/zarar sayımı nakite göre yapılır.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {selectPerformanceRows} from '../public/performance-tools.js';
import {performanceApi} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';

const rapor = f => performanceApi(new Request('https://test.local/api/ec/performance?from=2026-09-01&to=2026-09-30'), {...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')}, '/api/performance');

function kur(f, {feeVat = true} = {}) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Ürün','U1','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=100000,value_cents=460000 WHERE product_id='p1'");
  f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk','hepsiburada','P1','S1','2026-09-01','draft','t')");
  f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents) VALUES('ln','pk','L1','Ürün',1000,11000)");
  // Satış: KDV hariç 110 TL, maliyet 46 TL, kesintiler KDV hariç.
  f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('se','hepsiburada','S-1','p1','sale',1000,11000,4600,1610,8992,1138,'confirmed','2026-09-05')");
  f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm','ln','p1',1000,10000,'se','adet')");
  f.sqlite.exec("UPDATE ec_order_packages SET status='reserved' WHERE id='pk'");
  f.sqlite.exec("UPDATE ec_order_packages SET status='shipped' WHERE id='pk'");
  f.sqlite.exec("UPDATE ec_order_packages SET status='delivered',delivered_on='2026-09-05' WHERE id='pk'");
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','hepsiburada','HB','HB')");
  if (feeVat) f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
}

test('Kâr raporu nakit gösterir: KDV dahil satış − KDV dahil maliyet − KDV dahil kesinti', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    const r = await rapor(f);
    const row = r.rows.find(x => x.order_no === 'S1');
    // 132,00 − 55,20 − 19,32 − 107,90 − 13,66 = −64,08
    assert.equal(row.revenue_gross_cents, 13200, 'satış KDV dahil');
    assert.equal(row.cost_gross_cents, 5520, 'maliyet KDV dahil');
    assert.equal(row.commission_gross_cents, 1932, 'komisyon KDV dahil');
    assert.equal(row.cash_cents, 13200 - 5520 - 1932 - 10790 - 1366);
    assert.equal(row.profit_cents, 11000 - 4600 - 1610 - 8992 - 1138, 'KDV hariç katkı da duruyor');

    const hb = r.channels.find(c => c.channel === 'hepsiburada');
    assert.equal(hb.cash_cents, row.cash_cents);
    assert.equal(hb.cash_losses, 1, 'nakit zararda bir paket');
    // Süzgeç de nakite göre sayar.
    assert.equal(selectPerformanceRows(r.rows, {result: 'loss'}).length, 1);
    assert.equal(selectPerformanceRows(r.rows, {result: 'profit'}).length, 0);
  } finally { f.close(); }
});

test('Kesinti KDV durumu beyan edilmemişse oran uydurulmaz; nakit sonuç boş kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f, {feeVat: false});
    const r = await rapor(f);
    const row = r.rows.find(x => x.order_no === 'S1');
    assert.equal(row.cash_cents, null, 'oran bilinmeden nakit hesaplanmadı');
    assert.match(row.cash_note, /beyan edilmedi/);
    assert.equal(r.channels.find(c => c.channel === 'hepsiburada').cash_cents, null);
  } finally { f.close(); }
});
