// Geçmişten kesinti tahmini: kargodaki paket ve kesintisi ekstreye henüz yazılmamış teslim
// "hesaplanmadı" diye dışarıda kalmaz. TEMSİLİ veri; gerçek pazaryeri dosyası değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const D = '2026-09-10';

async function kur(f) {
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf','trendyol','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
  const urun = async (sku) => {
    const p = await f.ok('/ec/products', {name: 'Ürün ' + sku, sku, stock_unit: 'adet', min_stock: 0});
    await f.ok('/ec/stock', {product_id: p.id, quantity: 100, unit_cost: 50, kind: 'opening', reference: 'A-' + sku, notes: 'Açılış', occurred_on: '2026-09-01'});
    f.sqlite.prepare("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,2000,5000,0,0,0,100,100,100,500,1)").run(p.id);
    return p.id;
  };
  const a = await urun('A'), b = await urun('B');
  let n = 0;
  // Teslim edilmiş paket: satış 240 TL (KDV dahil), kesintiler KDV hariç.
  const teslim = async (urunId, adet, {kargo = 50, komisyon = 30, diger = 5, iade = false, kesinti = true} = {}) => {
    const no = 'T' + (++n);
    const o = await f.ok('/ec/orders', {channel: 'trendyol', external_id: no, order_no: no, occurred_on: D,
      lines: [{external_id: no + '-1', sku: 'S', name: 'İlan', product_id: urunId, quantity: adet, gross: 240 * adet, vat_rate: 20}]});
    await f.ok('/ec/orders/' + o.id + '/reserve', {});
    await f.ok('/ec/orders/' + o.id + '/ship', {occurred_on: D, reference: 'K-' + no});
    await f.ok('/ec/orders/' + o.id + '/deliver', {occurred_on: D});
    const s = f.sqlite.prepare("SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?").get(o.id);
    if (kesinti) await f.ok('/ec/sales/' + s.id + '/fees', {commission: komisyon, shipping: kargo, other: diger, fees_status: 'confirmed'});
    if (iade) await f.ok('/ec/sales/' + s.id + '/return', {external_id: 'IADE-' + no, quantity: adet, revenue: 200 * adet, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', restock: true, occurred_on: D});
    return o.id;
  };
  const kargoda = async (urunId, adet) => {
    const no = 'K' + (++n);
    const o = await f.ok('/ec/orders', {channel: 'trendyol', external_id: no, order_no: no, occurred_on: D,
      lines: [{external_id: no + '-1', sku: 'S', name: 'İlan', product_id: urunId, quantity: adet, gross: 240 * adet, vat_rate: 20}]});
    await f.ok('/ec/orders/' + o.id + '/reserve', {});
    await f.ok('/ec/orders/' + o.id + '/ship', {occurred_on: D, reference: 'K-' + no});
    return o.id;
  };
  const rapor = mode => f.ok('/ec/performance?' + new URLSearchParams({mode, from: D, to: D}));
  return {a, b, teslim, kargoda, rapor};
}

test('Kargodaki paket: aynı içerik yoksa aynı ürünün en yakın adetli teslimi, o da yoksa kanal ortancası kullanılır; hiçbiri boş kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, b, teslim, kargoda, rapor} = await kur(f);
    await teslim(a, 1, {kargo: 40});
    await teslim(a, 1, {kargo: 60});   // aynı içerik iki teslim: ortanca 50
    await teslim(a, 3, {kargo: 90});
    const ayni = await kargoda(a, 1), yakin = await kargoda(a, 2), baska = await kargoda(b, 1);
    const r = await rapor('pending');
    const by = id => r.rows.find(x => x.id === id);
    assert.equal(by(ayni).shipping_cents, 5000, 'aynı içerik: iki teslimin ortancası');
    assert.equal(by(ayni).history_source, 'content');
    assert.equal(by(yakin).history_source, 'product', 'aynı ürün, adedi en yakın teslimler');
    assert.equal(by(baska).history_source, 'channel', 'bu ürünün teslimi yok: kanal ortancası');
    assert.equal(r.channels[0].missing, 0, 'hiçbir paket tahminsiz kalmadı');
    for (const x of [by(ayni), by(yakin), by(baska)]) assert.ok(Number.isSafeInteger(x.cash_cents), 'nakit tahmini var: ' + (x.cash_note || ''));
  } finally { f.close(); }
});

test('İade edilen paket tahminde örnek alınmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, teslim, kargoda, rapor} = await kur(f);
    await teslim(a, 1, {kargo: 50});
    await teslim(a, 1, {kargo: 150, iade: true});   // dönüş kargosu dahil; örnek alınmamalı
    const k = await kargoda(a, 1);
    const r = await rapor('pending');
    assert.equal(r.rows.find(x => x.id === k).shipping_cents, 5000);
  } finally { f.close(); }
});

test('Teslim edilmiş ama kesintisi ekstreye henüz yazılmamış paket tahminle hesaplanır ve işaretlenir', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, teslim, rapor} = await kur(f);
    await teslim(a, 1, {kargo: 50});
    const bekleyen = await teslim(a, 1, {kesinti: false});
    const r = await rapor('delivered');
    const row = r.rows.find(x => x.id === bekleyen);
    assert.equal(row.fees_estimated, true, 'tahmin olduğu işaretlendi');
    assert.equal(row.shipping_cents, 5000);
    assert.ok(row.profit_cents !== null && Number.isSafeInteger(row.cash_cents), 'hesaplandı: ' + (row.cash_note || ''));
    assert.match(row.cost_note, /henüz yazmadı/);
    assert.equal(r.channels[0].missing, 0, '"hesaplanmadı" kalmadı');
  } finally { f.close(); }
});

test('Kaça satmalıyım: geçmiş kesintilerle cebine kalan, başabaş ve hedef fiyat (KDV dahil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, teslim} = await kur(f);
    await teslim(a, 1, {kargo: 50, komisyon: 30, diger: 5});   // komisyon oranı 30/200 = %15
    const r = await f.ok('/ec/fiyat-hesap?' + new URLSearchParams({product_id: a, channel: 'trendyol', qty: 1, price: '240', target: '30'}));
    // 240 − maliyet 60 − kargo 60 − hizmet 6 − komisyon 36 = 78
    assert.equal(r.fiyatla.cebine, 24000 - 6000 - 6000 - 600 - 3600);
    assert.equal(r.basabas.fiyat, Math.ceil(12600 / 0.85));
    assert.ok(r.basabas.cebine >= 0 && r.basabas.cebine < 5, 'başabaşta cebine ~0');
    assert.equal(r.hedef.fiyat, Math.ceil((3000 + 12600) / 0.85));
    assert.ok(r.hedef.cebine >= 3000, 'hedef sağlandı');
    assert.equal((await f.req('/ec/fiyat-hesap?product_id=' + a)).status, 400, 'kanal seçilmeli');
  } finally { f.close(); }
});

test('Ürünün bu kanalda teslimi yoksa kargo diğer kanaldaki teslimlerinden; iadesi tamamlanmış paket kargodakilerde görünmez', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, b, teslim, kargoda, rapor} = await kur(f);
    f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf2','hepsiburada','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
    await teslim(a, 1, {kargo: 400});   // hacimli ürün A yalnız Trendyol'da teslim edildi
    // Hepsiburada'da başka bir ürünün teslimi (kanal ortalaması 40 TL kargo)
    const hbTeslim = await f.ok('/ec/orders', {channel: 'hepsiburada', external_id: 'H1', order_no: 'H1', occurred_on: D,
      lines: [{external_id: 'H1-1', sku: 'S', name: 'İlan', product_id: b, quantity: 1, gross: 240, vat_rate: 20}]});
    await f.ok('/ec/orders/' + hbTeslim.id + '/reserve', {}); await f.ok('/ec/orders/' + hbTeslim.id + '/ship', {occurred_on: D, reference: 'KH1'}); await f.ok('/ec/orders/' + hbTeslim.id + '/deliver', {occurred_on: D});
    const hs = f.sqlite.prepare("SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?").get(hbTeslim.id);
    await f.ok('/ec/sales/' + hs.id + '/fees', {commission: 40, shipping: 40, other: 2, fees_status: 'confirmed'});
    const hbKargo = await f.ok('/ec/orders', {channel: 'hepsiburada', external_id: 'H2', order_no: 'H2', occurred_on: D,
      lines: [{external_id: 'H2-1', sku: 'S', name: 'İlan', product_id: a, quantity: 1, gross: 240, vat_rate: 20}]});
    await f.ok('/ec/orders/' + hbKargo.id + '/reserve', {}); await f.ok('/ec/orders/' + hbKargo.id + '/ship', {occurred_on: D, reference: 'KH2'});
    // Trendyol'da kargoya verilip iadesi tamamlanan paket
    const donen = await kargoda(a, 1);
    const ds = f.sqlite.prepare("SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?").get(donen);
    await f.ok('/ec/sales/' + ds.id + '/return', {external_id: 'IADE-D', quantity: 1, revenue: 200, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', restock: true, occurred_on: D});
    const r = await rapor('pending');
    const row = r.rows.find(x => x.id === hbKargo.id);
    assert.equal(row.history_source, 'product_other_channel');
    assert.equal(row.shipping_cents, 40000, 'kargo diğer kanaldaki gerçek teslimden');
    assert.equal(r.rows.find(x => x.id === donen), undefined, 'iadesi tamamlanan paket kargodakilerde değil');
  } finally { f.close(); }
});

test('Ürün kârlılığı: satılan adet iadeler düşülerek, ciro ve kâr KDV dahil; kesintisi yoksa tahmin ve işaret', async () => {
  const f = appFixture(); await f.setup(); try {
    const {a, b, teslim, kargoda} = await kur(f);
    await teslim(a, 1, {kargo: 50, komisyon: 30, diger: 5});
    await teslim(a, 2, {kargo: 50, komisyon: 60, diger: 5, iade: true});   // 2 adet satıldı, hepsi iade
    await kargoda(a, 1);                                                  // kesintisi yok: tahmin
    const r = await f.ok('/ec/urun-karlilik');
    const x = r.rows.find(y => y.product_id === a);
    assert.equal(x.adet_milli, 2000, '1 + 2 − 2 iade + 1 kargoda');
    // Birinci satış: 240 − 60 − (30+50+5)×1,2 = 78
    assert.equal(r.rows.find(y => y.product_id === b), undefined, 'satılmayan ürün yok');
    assert.equal(x.tahmini_paket, 1);
    assert.ok(x.kar_adet_cents !== null);
  } finally { f.close(); }
});
