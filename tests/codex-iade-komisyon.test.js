// İADE EDİLEN SİPARİŞTE KOMİSYON. Pazaryeri iade sonrası komisyonu geri verir ve ekstrede açıkça
// "0,00" satırı gönderir; o sıfır GERÇEK sıfırdır, deftere yazılır (canlı: TY 11581049903, 11587333488,
// HB 4221039448 — üçünde de ekstre 0 diyor, kayıp kargo/hizmettir). Ama komisyon satırı HİÇ yoksa bu
// bilinmeyen veridir: sıfır yazmak veri uydurmaktır (§3.4 "bilinmeyen sıfır değildir"). TEMSİLİ veri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf','T10','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000,value_cents=4600000');
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  for (const fid of ['fl-eski', 'fl-yeni']) {
    const snap = fid === 'fl-eski' ? '2026-09-15T14:50' : '2026-09-19T18:13';
    const h = (fid === 'fl-eski' ? 'a' : 'b').repeat(64);
    f.sqlite.exec("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by,profile_id) VALUES('" +
      fid + "','st','finance','" + fid + ".xlsx',10,'" + h + "','" + snap + "','S','[]',1,1,'applied','t','pf')");
  }
  f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('pk','trendyol','TEA153','11581049903','2026-09-08','draft','t')");
  f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('ln','pk','L1','Torf',1000,16167,19400,2000)");
  f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES('sl','trendyol','order:pk:1','p1','sale',1000,16167,8400,'pending','2026-09-08')");
  f.sqlite.exec("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('cm','ln','p1',1000,10000,'sl','adet')");
  f.sqlite.exec("UPDATE ec_order_packages SET status='reserved' WHERE id='pk'");
  f.sqlite.exec("UPDATE ec_order_packages SET status='shipped',shipped_on='2026-09-09' WHERE id='pk'");
  f.sqlite.exec("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT 'rt',channel,'IADE-11581049903-sl',product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,'2026-09-16' FROM ec_sale_entries WHERE id='sl'");
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no,erp_package_id,components_json) VALUES('rl','st','order_line','L:1','provider',?,'2026-09-19T18:13','fl-yeni',1,'pk',?)")
    .run(JSON.stringify({order_no: '11581049903', package_id: 'TEA153', barcode: 'T10', product_name: 'Torf', quantity: 1,
      status: 'Iade Edildi', order_date: '2026-09-08', delivered_date: null, gross: 19400}),
    JSON.stringify({components: [{product_id: 'p1', quantity_milli: 1000, revenue_share_bps: 10000}]}));
}
let n = 0;
// Ekstre satiri. Bilesik anahtar TUTARI icerir: eski tutar ayri kayit olarak durur (canlidaki gibi).
const olay = (f, o) =>
  f.sqlite.prepare("INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,file_id,row_no) VALUES(?,'st','finance_event',?,'composite',?,?,?,?)")
    .run('fe' + (++n), 'C:11581049903|||' + o.tur + '||' + o.tutar + '#' + (o.sutun || o.tur),
      JSON.stringify({order_no: '11581049903', type: o.tur, amount_cents: o.tutar, source_field: o.sutun || o.tur}), o.zaman, o.dosya, n);
const kesintiler = f => ({...f.sqlite.prepare('SELECT commission_cents,shipping_cents,other_cents,fees_status FROM ec_sale_entries WHERE id=?').get('sl')});

test('İade sonrası ekstre komisyonu 0,00 beyan ederse deftere 0 yazılır (canlı TEA2026000000153)', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    olay(f, {tur: 'commission', tutar: -2832, dosya: 'fl-eski', zaman: '2026-09-15T14:50'});
    olay(f, {tur: 'commission', tutar: 0, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    olay(f, {tur: 'cargo', tutar: -4649, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    olay(f, {tur: 'service', tutar: -599, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 1, 'paket atlanmadi: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiler(f), {commission_cents: 0, shipping_cents: 3874, other_cents: 499, fees_status: 'confirmed'});
  } finally { f.close(); }
});

test('Kontrol: yeni ekstrede 0 satırı olmasaydı komisyon 23,60 yazılırdı', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    olay(f, {tur: 'commission', tutar: -2832, dosya: 'fl-eski', zaman: '2026-09-15T14:50'});
    olay(f, {tur: 'cargo', tutar: -4649, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    olay(f, {tur: 'service', tutar: -599, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.deepEqual(kesintiler(f), {commission_cents: 2360, shipping_cents: 3874, other_cents: 499, fees_status: 'confirmed'});
  } finally { f.close(); }
});

test('İadeli pakette ekstrede komisyon satırı hiç yoksa yazılmaz; sıfır uydurulmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    olay(f, {tur: 'cargo', tutar: -4649, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 0, 'bilinmeyen komisyon yazıldı: ' + JSON.stringify(yazildi.skipped));
    assert.ok(yazildi.skipped.some(x => /komisyon/.test(x.reason)), JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiler(f), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'});
  } finally { f.close(); }
});

test('Teslim edilmiş iadesiz pakette komisyon 0 gözlemi yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    f.sqlite.exec("DELETE FROM ec_sale_entries WHERE id='rt'");
    f.sqlite.exec("UPDATE ec_order_packages SET status='delivered',delivered_on='2026-09-12' WHERE id='pk'");
    f.sqlite.exec("UPDATE ec_report_records SET data_json=json_set(data_json,'$.delivered_date','2026-09-12','$.status','Teslim Edildi'),version=version+1 WHERE id='rl'");
    olay(f, {tur: 'commission', tutar: -2832, dosya: 'fl-eski', zaman: '2026-09-15T14:50'});
    olay(f, {tur: 'commission', tutar: 0, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    olay(f, {tur: 'cargo', tutar: -4649, dosya: 'fl-yeni', zaman: '2026-09-19T18:13'});
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 0, 'iadesiz pakette eksik komisyon yazilmaz');
    assert.ok(yazildi.skipped.some(x => /komisyon kesintisi yok/.test(x.reason)), JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiler(f), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'});
  } finally { f.close(); }
});
