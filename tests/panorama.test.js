// Ana sayfa (Genel durum) dönem kârları kâr raporuyla BİREBİR aynı olmalı: aynı aralık, aynı toplam.
// Kanıtlanan: dönem sınırları (son 7 gün bugünü de sayar), kanal ayrımı, ürün sıralaması toplamı,
// kargodaki paketin 30 günden eski olsa da tahmine girmesi.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet'),('p2','Perlit 5 L','P5','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1),('p2',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec("UPDATE ec_stock_balances SET quantity_milli=100000,value_cents=460000");
  f.sqlite.exec("INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','hepsiburada','HB','HB'),('st2','trendyol','TY','TY')");
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf2','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
}

// Teslim edilmiş tek satırlı paket: satış ve kesintiler KDV hariç kuruş.
function paket(f, id, channel, teslim, {urun = 'p1', satis = 11000, maliyet = 4600, kom = 1610, kargo = 3000, diger = 500, durum = 'delivered'} = {}) {
  f.sqlite.exec(`INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES('${id}','${channel}','E-${id}','S-${id}','${gun(-200) < teslim ? teslim : gun(-200)}','draft','t')`);
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('l-${id}','${id}','L-${id}','Ürün',1000,${satis},${Math.round(satis * 1.2)},2000)`);
  f.sqlite.exec(`INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES('s-${id}','${channel}','X-${id}','${urun}','sale',1000,${satis},${maliyet},${kom},${kargo},${diger},'confirmed','${teslim}')`);
  f.sqlite.exec(`INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES('c-${id}','l-${id}','${urun}',1000,10000,'s-${id}','adet')`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='reserved' WHERE id='${id}'`);
  f.sqlite.exec(`UPDATE ec_order_packages SET status='shipped',shipped_on='${teslim}' WHERE id='${id}'`);
  if (durum === 'delivered') f.sqlite.exec(`UPDATE ec_order_packages SET status='delivered',delivered_on='${teslim}' WHERE id='${id}'`);
}

test('Ana sayfa dönem kârları kâr raporunun aynı aralıktaki toplamına eşittir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'a', 'trendyol', bugun);                                     // bugün
    paket(f, 'b', 'hepsiburada', gun(-6), {urun: 'p2', satis: 20000, maliyet: 5000}); // 7. gün (son 1 haftada)
    paket(f, 'c', 'trendyol', gun(-7), {satis: 5000, maliyet: 4600, kargo: 4000}); // 8. gün: zarar, 2 haftada
    paket(f, 'd', 'hepsiburada', gun(-100), {urun: 'p2'});               // yalnız 6 ay ve tümü
    const p = await f.ok('/ec/panorama');
    const d = Object.fromEntries(p.periods.map(x => [x.key, x]));
    assert.deepEqual(p.periods.map(x => x.key), ['1g', '7g', '14g', '30g', '90g', '180g', 'tum']);
    assert.equal(d['7g'].from, gun(-6), 'son 7 gün bugünü de sayar');
    assert.equal(d['7g'].packages, 2);
    assert.equal(d['14g'].packages, 3);
    assert.equal(d['14g'].losses, 1, 'zarar eden paket sayılır');
    assert.equal(d['90g'].packages, 3);
    assert.equal(d.tum.packages, 4);
    assert.equal(d.tum.from, gun(-100), 'tüm zamanlar ilk teslimden başlar');
    // Her dönem kâr raporunun aynı aralığıyla birebir aynı toplam.
    for (const x of p.periods) {
      const r = await f.ok(`/ec/performance?from=${x.from}&to=${x.to}`);
      const toplam = r.rows.reduce((t, row) => t + (row.cash_cents ?? 0), 0);
      assert.equal(x.cash_cents, toplam, x.label + ' toplamı kâr raporuyla aynı');
      // Zarar edenlerin tutarı (eksi) + kâr bırakanlarınki = dönem toplamı.
      assert.equal(x.loss_cents, r.rows.filter(row => row.cash_cents < 0).reduce((t, row) => t + row.cash_cents, 0), x.label + ' zarar tutarı');
      assert.equal(x.gain_cents + x.loss_cents, x.cash_cents);
      assert.equal(x.gains + x.losses, r.rows.filter(row => row.cash_cents !== 0).length);
      for (const k of ['trendyol', 'hepsiburada'])
        assert.equal(x.channels[k].cash_cents, r.channels.find(c => c.channel === k).calculated_cash_cents ?? 0, x.label + ' ' + k);
      // Ürün katkıları paket toplamını bozmaz.
      const urun = [...x.products.top, ...x.products.bottom].reduce((t, u) => t + u.cash_cents, 0);
      assert.equal(urun, x.cash_cents, x.label + ' ürün katkıları toplamı');
    }
    // Günlük seri dönemi tam kapsar.
    assert.equal(p.daily.length, 101);
    assert.equal(p.daily.reduce((t, g) => t + g.trendyol + g.hepsiburada, 0), d.tum.cash_cents);
    // Önceki eş dönem: 7 günün öncesi (8-14. gün) verinin başladığı günden sonra.
    assert.equal(d['7g'].prev_cash_cents, d['14g'].cash_cents - d['7g'].cash_cents);
    assert.equal(d.tum.prev_cash_cents, null);
    assert.equal(d['180g'].prev_cash_cents, null, 'veri başlamadan önceki dönem karşılaştırılmaz');
  } finally { f.close(); }
});

test('Kargodaki tahmin 30 günden eski bekleyen paketi de sayar', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f);
    paket(f, 'a', 'trendyol', gun(-3));
    paket(f, 'b', 'trendyol', gun(-3));
    paket(f, 'yol', 'trendyol', gun(-45), {durum: 'shipped'});
    const p = await f.ok('/ec/panorama');
    assert.equal(p.pending.packages, 1, '45 gün önceki kargodaki paket');
    assert.equal(p.pending.from, gun(-45));
    assert.equal(p.pending.calculated, 1, 'geçmiş teslimlerden tahmin edildi');
    const r = await f.ok(`/ec/performance?mode=pending&from=${p.pending.from}&to=${p.pending.to}`);
    assert.equal(p.pending.cash_cents, r.rows.reduce((t, row) => t + (row.cash_cents ?? 0), 0));
  } finally { f.close(); }
});

test('Hiç teslim yokken ana sayfa boş ama hatasız döner', async () => {
  const f = appFixture(); await f.setup(); try {
    const p = await f.ok('/ec/panorama');
    assert.equal(p.first_delivered, null);
    assert.equal(p.daily.length, 0);
    assert.ok(p.periods.every(x => x.packages === 0 && x.cash_cents === 0));
    assert.equal(p.pending.packages, 0);
  } finally { f.close(); }
});
