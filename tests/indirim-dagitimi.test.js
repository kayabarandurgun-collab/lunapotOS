// İNDİRİM DAĞITIMI — sipariş düzeyindeki indirim paketlere nasıl bağlanır?
//
// Canlı kanıt (TY 11617217215): iki paket — 1.199,00 TL "Pina Small 2 Litre Ayaklı Fiberglas Saksı"
// ve 177,00 TL orkide seti. Ekstre: sale 1.376,00 · komisyon −42,40 · kargo −92,98 · hizmet −11,98 ·
// net hakediş 64,64 ve ayrıca type=other_fee, source_field="ek:İndirim", −1.164,00.
// SATICI PANELİ indirimi satırlara KENDİSİ oranlıyor: saksı satırı "İndirim −1.011,55", orkide satırı
// "İndirim −152,45" (satır netleri 149,96 ve 19,64; üstüne sipariş düzeyinde hizmet −11,98 ve kargo
// −92,98 → Net Sipariş Tutarı 64,64). Yani gelire göre oranlama pazaryerinin kendi yaptığıdır;
// orkide paketindeki zarar gerçektir (saksı paketi "hediye" gerekçesiyle iptal edilmiş, indirim
// gerçekten cepten çıkmıştır). Kural: paket/satır başına indirim BİLİNİYORSA tam o tutar; yoksa
// gelire göre oranlanır ve bunun bildirilmiş değil ORANLANMIŞ olduğu satırda söylenir.
//
// TEMSİLİ veri: gerçek pazaryeri dosyası DEĞİLDİR; tutarlar canlı kanıttan alınmıştır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12', TESLIM = '2026-09-14', SIPARIS = '11617217215';
const sql = (f, q, ...a) => f.sqlite.prepare(q).run(...a);
let n = 0;

function magaza(f) {
  sql(f, "INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','trendyol','TY-1','Mağaza')");
  sql(f, 'INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)' +
    " VALUES('fl','st','orders','rapor.xlsx',100,?,'2026-09-12T10:00','[]',1,1,'applied')", 'f'.repeat(64));
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
}

/** Rapordaki sipariş satırı (paket başına bir satır); ürün eşleşmesi kayda yazılır. */
const satir = (f, {urun_id, ...d}) => sql(f, 'INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no,components_json)' +
  " VALUES(?,'st','order_line',?,'provider',?,'2026-09-12T10:00','2026-09-12T10:00','fl',?,?)", 'rec-' + (++n), 'L:' + d.line_id,
JSON.stringify({order_no: SIPARIS, order_date: DATE, delivered_date: TESLIM, status: 'Teslim Edildi', quantity: 1, vat_bps: 2000, ...d}), n,
JSON.stringify({components: [{product_id: urun_id, quantity_milli: 1000, revenue_share_bps: 10000}]}));

/** Finans olayı. Ekstrenin TEK satırından üretilen olaylar aynı satır numarasını taşır (geniş biçim). */
const olay = (f, d) => sql(f, 'INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)' +
  " VALUES(?,'st','finance_event',?,'composite',?,'2026-09-15T10:00','2026-09-15T10:00','fl',90)", 'fin-' + (++n),
'C:' + [SIPARIS, d.package_id || '', d.type, d.source_field || '', d.amount_cents].join('|'),
JSON.stringify({order_no: SIPARIS, event_date: TESLIM, net_payout: 6464, ...d}));

/** Pazaryerinin SİPARİŞ kaydı: paket ya da satır başına satıcı indirimi (TL) buradan bilinir. */
function siparisKaydi(f, paket, yuk) {
  sql(f, "INSERT OR IGNORE INTO ec_provider_connections(provider,seller_id,encrypted_credentials) VALUES('trendyol','S1','x')");
  sql(f, 'INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json,source_updated_at)' +
    " VALUES(?,'trendyol','S1','orders',?,?,?,'2026-09-13T10:00')", 'pr-' + (++n), paket, 'fp-' + n,
  JSON.stringify({external_id: paket, order_no: SIPARIS, package_platform_discount: 0, ...yuk}));
}

async function urun(f, {ad, sku, barkod}) {
  const p = await f.ok('/ec/products', {name: ad, sku, stock_unit: 'adet', min_stock: 0});
  await f.ok('/ec/stock', {product_id: p.id, quantity: 20, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test açılışı'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: barkod, external_name: ad,
    components: [{product_id: p.id, quantity_milli: 1000, revenue_share_bps: 10000}]});
  return p;
}

/** Paketi deftere bağlar, gönderir, teslim eder. */
async function deftere(f, paket) {
  const a = await f.ok('/ec/reports/stock-link/apply', {store_id: 'st', package_id: paket, complete_package_confirmed: true});
  await f.ok('/ec/orders/' + a.package_id + '/reserve', {});
  await f.ok('/ec/orders/' + a.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-' + paket});
  await f.ok('/ec/orders/' + a.package_id + '/deliver', {occurred_on: TESLIM});
  return a.package_id;
}
const kesintiOf = (f, erp) => ({...f.sqlite.prepare('SELECT s.commission_cents,s.shipping_cents,s.other_cents,s.fees_status FROM ec_order_line_components c' +
  ' JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_sale_entries s ON s.id=c.sale_id WHERE l.package_id=?').get(erp)});
const paket = (r, no) => r.results.find(x => x.package_id === no);
const giderSatiri = (p, tur) => p.fees.find(x => x.type === tur) || {};
const gider = (p, tur) => giderSatiri(p, tur).actual_cents ?? 0;
const metinler = p => [...(p.contribution_missing || []), ...(p.notes || [])];

/** Canlı şekil: iki paket, bütün kalemler sipariş düzeyinde (paket numarası YOK). */
async function canliSekil(f, {indirim = 116400} = {}) {
  magaza(f);
  const s = await urun(f, {ad: 'Pina Small 2 Litre Ayaklı Fiberglas Saksı', sku: 'PINA-2L', barkod: 'SAKSI-1'});
  const o = await urun(f, {ad: 'Orkide Toprağı 3 Lt + Orkide Besini 225 Ml', sku: 'ORKIDE-SET', barkod: 'ORKIDE-1'});
  satir(f, {package_id: 'PK-SAKSI', line_id: 'L-SAKSI', barcode: 'SAKSI-1', product_name: 'Pina Small 2 Litre', gross: 119900, urun_id: s.id});
  satir(f, {package_id: 'PK-ORKIDE', line_id: 'L-ORKIDE', barcode: 'ORKIDE-1', product_name: 'Orkide seti', gross: 17700, urun_id: o.id});
  olay(f, {type: 'sale', source_field: 'sale', amount_cents: 137600});
  olay(f, {type: 'commission', source_field: 'commission', amount_cents: -4240});
  olay(f, {type: 'cargo', source_field: 'cargo', amount_cents: -9298});
  olay(f, {type: 'service', source_field: 'service', amount_cents: -1198});
  if (indirim) olay(f, {type: 'other_fee', source_field: 'ek:İndirim', amount_cents: -indirim});
}
// Satıcı panelindeki satır indirimleri: 1.011,55 / 152,45 (toplam 1.164,00).
const PANEL_SAKSI = 101155, PANEL_ORKIDE = 15245;

test('Rapor paket başına indirim vermiyorsa pazaryerinin kendi yaptığı gibi gelire göre oranlanır', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    const erp = await deftere(f, 'PK-ORKIDE');            // canlıdaki gibi: saksı paketi henüz defterde değil
    const orkide = paket(await f.ok('/ec/reports/orders?store_id=st'), 'PK-ORKIDE');
    // Gelire göre oranlama: 1.164,00 × 177,00 / 1.376,00 = 149,73. Satıcı panelinin kendi satır
    // dağıtımı 152,45; taban tutarlar birebir aynı olmadığı için yuvarlama farkı kalır (2,72 TL).
    assert.equal(gider(orkide, 'other_fee'), -14973, JSON.stringify(orkide.fees));
    assert.ok(Math.abs(-14973 + PANEL_ORKIDE) <= 300, 'pazaryerinin kendi satır indirimiyle aynı büyüklükte olmalı');
    assert.equal(giderSatiri(orkide, 'other_fee').discount_prorated, true, 'oranlandığı işaretlenmeli');
    assert.ok(metinler(orkide).some(t => /gelire göre oranlandı/.test(t) && /paket başına bildirilmiş değil/.test(t)),
      'oranlandığı söylenmeli: ' + JSON.stringify(metinler(orkide)));

    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 1, 'indirim sipariş düzeyinde geldi diye paket bekletilmez: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, erp), {commission_cents: 545, shipping_cents: 1196, other_cents: 154 + 14973, fees_status: 'confirmed'},
      'hizmet payı + oranlanmış indirim payı yazıldı');
  } finally { f.close(); }
});

test('Tek paketli siparişte sipariş düzeyli indirim yine o pakete yazılır', async () => {
  const f = appFixture(); await f.setup(); try {
    magaza(f);
    const s = await urun(f, {ad: 'Pina Small 2 Litre Ayaklı Fiberglas Saksı', sku: 'PINA-2L', barkod: 'SAKSI-1'});
    satir(f, {package_id: 'PK-SAKSI', line_id: 'L-SAKSI', barcode: 'SAKSI-1', product_name: 'Pina Small 2 Litre', gross: 119900, urun_id: s.id});
    olay(f, {type: 'commission', source_field: 'commission', amount_cents: -4240});
    olay(f, {type: 'cargo', source_field: 'cargo', amount_cents: -9298});
    olay(f, {type: 'service', source_field: 'service', amount_cents: -1198});
    olay(f, {type: 'other_fee', source_field: 'ek:İndirim', amount_cents: -116400});
    const erp = await deftere(f, 'PK-SAKSI');
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 1, 'tek pakette indirim bağlanır: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, erp), {commission_cents: 4240, shipping_cents: 9298, other_cents: 1198 + 116400, fees_status: 'confirmed'},
      'tek paketli siparişte indirim paketin kendisinindir');
  } finally { f.close(); }
});

test('Rapor PAKET başına indirim veriyorsa oranlama yapılmaz, tam o tutar kullanılır', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    siparisKaydi(f, 'PK-SAKSI', {package_seller_discount: PANEL_SAKSI / 100});
    siparisKaydi(f, 'PK-ORKIDE', {package_seller_discount: PANEL_ORKIDE / 100});
    const saksi = await deftere(f, 'PK-SAKSI'), orkide = await deftere(f, 'PK-ORKIDE');
    const r = await f.ok('/ec/reports/orders?store_id=st');
    assert.equal(giderSatiri(paket(r, 'PK-ORKIDE'), 'other_fee').discount_prorated, false, 'bildirilmiş tutar oranlanmış sayılmaz');
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 2, 'iki paket de yazıldı: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, orkide), {commission_cents: 545, shipping_cents: 1196, other_cents: 154 + PANEL_ORKIDE, fees_status: 'confirmed'},
      'panelin söylediği 152,45 birebir; oranlamayla çıkan 149,73 değil');
    assert.deepEqual(kesintiOf(f, saksi), {commission_cents: 3695, shipping_cents: 8102, other_cents: 1044 + PANEL_SAKSI, fees_status: 'confirmed'});
  } finally { f.close(); }
});

test('Rapor SATIR başına indirim veriyorsa satırların toplamı o paketin indirimidir', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    siparisKaydi(f, 'PK-SAKSI', {lines: [{seller_discount: 1000}, {seller_discount: PANEL_SAKSI / 100 - 1000}]});
    siparisKaydi(f, 'PK-ORKIDE', {lines: [{seller_discount: PANEL_ORKIDE / 100}]});
    const orkide = await deftere(f, 'PK-ORKIDE');
    const r = await f.ok('/ec/reports/orders?store_id=st');
    assert.equal(gider(paket(r, 'PK-ORKIDE'), 'other_fee'), -PANEL_ORKIDE, 'satır indirimlerinin toplamı');
    assert.equal(gider(paket(r, 'PK-SAKSI'), 'other_fee'), -PANEL_SAKSI);
    await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(kesintiOf(f, orkide).other_cents, 154 + PANEL_ORKIDE);
  } finally { f.close(); }
});

test('Paket başına indirim bilinmese de iki pakete de yazılır; toplam korunur, hiçbiri beklemede kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    const saksi = await deftere(f, 'PK-SAKSI'), orkide = await deftere(f, 'PK-ORKIDE');
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 2, 'iki paket de yazıldı: ' + JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, saksi), {commission_cents: 3695, shipping_cents: 8102, other_cents: 1044 + 101427, fees_status: 'confirmed'});
    assert.deepEqual(kesintiOf(f, orkide), {commission_cents: 545, shipping_cents: 1196, other_cents: 154 + 14973, fees_status: 'confirmed'});
    // Sipariş toplamı korunur: kuruş artığı kaybolmaz, çoğalmaz.
    assert.equal(101427 + 14973, 116400);
    assert.equal(yazildi.totals.other, 1198 + 116400);
  } finally { f.close(); }
});

test('Paketin payı kendi cirosundan büyükse dağıtılmaz: anlamsız tutar yazmaktansa incelemeye kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    siparisKaydi(f, 'PK-SAKSI', {package_seller_discount: 0});
    siparisKaydi(f, 'PK-ORKIDE', {package_seller_discount: 1164});   // 1.164,00 TL indirim 177,00 TL'lik pakete sığmaz
    const orkide = await deftere(f, 'PK-ORKIDE');
    const p = paket(await f.ok('/ec/reports/orders?store_id=st'), 'PK-ORKIDE');
    assert.equal(gider(p, 'other_fee'), 0, 'paketin cirosunu aşan indirim yazıldı: ' + JSON.stringify(p.fees));
    assert.ok(metinler(p).some(t => /indirimi paketlere bağlanamadı/.test(t) && /ciro/.test(t)), JSON.stringify(metinler(p)));
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 0);
    assert.ok(yazildi.skipped.some(x => /indirimi paketlere bağlanamadı/.test(x.reason)), JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, orkide), {commission_cents: null, shipping_cents: null, other_cents: null, fees_status: 'pending'});
  } finally { f.close(); }
});

test('İndirim dışındaki kesintiler eskisi gibi gelire göre bölünür (komisyon, kargo, hizmet)', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f, {indirim: 0});
    const saksi = await deftere(f, 'PK-SAKSI'), orkide = await deftere(f, 'PK-ORKIDE');
    const yazildi = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(yazildi.applied, 2, JSON.stringify(yazildi.skipped));
    assert.deepEqual(kesintiOf(f, saksi), {commission_cents: 3695, shipping_cents: 8102, other_cents: 1044, fees_status: 'confirmed'});
    assert.deepEqual(kesintiOf(f, orkide), {commission_cents: 545, shipping_cents: 1196, other_cents: 154, fees_status: 'confirmed'});
    assert.deepEqual([3695 + 545, 8102 + 1196, 1044 + 154], [4240, 9298, 1198]);
  } finally { f.close(); }
});

test('Oranlanarak yazılmış kesinleşmiş kayıt ikinci aktarımda değişmez; denetim izi çoğalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    await canliSekil(f);
    const orkide = await deftere(f, 'PK-ORKIDE');
    await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    const once = kesintiOf(f, orkide), izOnce = f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n;
    const tekrar = await f.ok('/ec/reports/apply-fees', {store_id: 'st', confirm: true});
    assert.equal(tekrar.sale_entries_changed, 0, 'ikinci aktarım hiçbir kaydı değiştirmedi');
    assert.deepEqual(kesintiOf(f, orkide), once);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n, izOnce, 'denetim izi de çoğalmadı');
  } finally { f.close(); }
});
