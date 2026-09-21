// Sentetik finans kurgusu; canlı veritabanı, rapor dosyası veya kimlik bilgisi kullanılmaz.
// SET PAYI ≠ TEK BAŞINA KÂR. Aynı ürün kendi ilanında para kazanırken çok bileşenli set ilanının
// içinde para kaybedebilir: pazaryerinin ödediği TEK tutar bileşenlere gelir payıyla bölünür, her
// ürün ise kendi gerçek maliyetini taşır. Bu dosya canlıdaki örüntüyü kurar: 3 bileşenli set paketi
// zarar ederken bir bileşenin payı artıda, aynı ürün tek satışta kârda.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {performanceReport} from '../src/performance-api.js';
import {aggregateSales} from '../src/sales-presentation.js';
import {productList} from '../public/product-list.js';
import {setProfitList} from '../public/accounting-ui.js';
import {scrubAmounts} from '../src/permission-policy.js';

const today = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const day = n => new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
const env = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const sum = (xs, key) => xs.reduce((n, x) => n + x[key], 0);
const ADLAR = [['p1', 'Yaprak Temizleyici 250 ml'], ['p2', 'Genel Bitki Besini 225 ml'], ['p3', 'Orkide Toprağı 3 L']];

function setup(f, vat = 2000) {
  for (const [id, name] of ADLAR) {
    f.sqlite.prepare('INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,?)').run(id, name, id, 'adet');
    f.sqlite.prepare('INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES(?,?,?,0,0,0,100,100,100,500,1)').run(id, vat, 1000);
  }
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=1000000000,value_cents=1000000000');
  for (const ch of ['trendyol', 'hepsiburada']) {
    f.sqlite.prepare('INSERT INTO ec_report_stores(id,provider,code,name) VALUES(?,?,?,?)').run(ch, ch, ch, ch);
    f.sqlite.prepare("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES(?,?,'finance',?,1,'{}',?,'test')")
      .run('pf-' + ch, ch, ch, JSON.stringify({fee_amounts_include_vat: true, fee_vat_bps: vat}));
    f.sqlite.prepare("INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,sheet,headers_json,row_count,chunk_count,status,created_by) VALUES(?,?,'finance','synthetic.xlsx',1,?,'2026-09-01T00:00','S','[]',1,1,'applied','test')")
      .run('file-' + ch, ch, (ch === 'trendyol' ? 'a' : 'b').repeat(64));
  }
}

// Sahibin fiyatladığı İLAN: katalog eşleştirmesi ve yapılandırılmış gelir payları (toplam %100).
function mapping(f, id, components, {code = id, name = 'Set ilanı ' + id, source = 'trendyol'} = {}) {
  f.sqlite.prepare("INSERT INTO ec_catalog_mappings(id,source,supplier_id,match_by,match_value,external_code,external_name,source_unit,active,version) VALUES(?,?,'','code',?,?,?,'',0,1)").run(id, source, code, code, name);
  for (const [i, c] of components.entries()) f.sqlite.prepare('INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES(?,?,?,?,?)')
    .run(id + '-c' + i, id, c.id, c.quantity ?? 1000, c.share);
  f.sqlite.prepare('UPDATE ec_catalog_mappings SET active=1 WHERE id=?').run(id);
}

function pack(f, id, lines, {status = 'delivered', channel = 'trendyol', date = today, order = id, vat = 2000} = {}) {
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','test')").run(id, channel, id, order, date);
  for (const [i, line] of lines.entries()) {
    const lid = id + '-l' + i, units = line.units ?? 1, revenue = line.components.reduce((n, c) => n + c.revenue, 0);
    f.sqlite.prepare('INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,?,?,?,?,?)')
      .run(lid, id, lid, 'Pazaryeri ilan adı', units * 1000, revenue, Math.round(revenue * (10000 + vat) / 10000), vat);
    let shares = 10000;
    for (const [j, c] of line.components.entries()) {
      const cid = lid + '-c' + j, sid = cid + '-sale', q = (c.quantity ?? 1) * units * 1000;
      const share = c.share ?? (j === line.components.length - 1 ? shares : Math.floor(10000 / line.components.length));
      shares -= share;
      if (!['draft', 'reserved'].includes(status)) f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',?,?,?,0,?,0,?,?)")
        .run(sid, channel, sid, c.id, q, c.revenue, c.cost, c.shipping ?? 0, c.shipping === null ? 'pending' : 'confirmed', date);
      f.sqlite.prepare('INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit,mapping_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(cid, lid, c.id, q, share, ['draft', 'reserved'].includes(status) ? null : sid, 'adet', line.mapping ?? null);
    }
  }
  if (status !== 'draft') f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
  if (!['draft', 'reserved'].includes(status)) f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date, id);
  if (status === 'delivered') f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date, id);
}

// Canlı örüntü: 3'lü set iki kez satıldı, ikisi de paket düzeyinde ZARAR; ilk pakette p1'in payı ARTIDA.
// Aynı p1 kendi ilanında (tek) ve kendi 4'lü paketinde kârda.
function canliOrnek(f) {
  setup(f);
  mapping(f, 'set-ilan', [{id: 'p1', share: 4000}, {id: 'p2', share: 3000}, {id: 'p3', share: 3000}]);
  pack(f, 'set-1', [{mapping: 'set-ilan', components: [
    {id: 'p1', revenue: 30000, cost: 26000, shipping: 3800},
    {id: 'p2', revenue: 30000, cost: 28000, shipping: 6000},
    {id: 'p3', revenue: 30000, cost: 27000, shipping: 5000}]}]);
  pack(f, 'set-2', [{mapping: 'set-ilan', components: [
    {id: 'p1', revenue: 30000, cost: 30000, shipping: 1000},
    {id: 'p2', revenue: 30000, cost: 28000, shipping: 3000},
    {id: 'p3', revenue: 30000, cost: 29000, shipping: 3000}]}]);
  pack(f, 'tek-1', [{components: [{id: 'p1', revenue: 30000, cost: 26000, shipping: 1000}]}]);
  pack(f, 'cok-1', [{components: [{id: 'p1', quantity: 4, revenue: 100000, cost: 90000, shipping: 4000}]}]);
}
const report = f => performanceReport(env(f), {mode: 'delivered', from: day(-30), to: today, detay: true});

test('set payı ile tek satış ayrışır; paket ve şirket toplamları kuruşu kuruşuna aynı kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    canliOrnek(f);
    const r = await report(f), paket = new Map(r.rows.map(p => [p.id, p]));
    // PAKET DÜZEYİ DEĞİŞMEZ: set paketleri zarar, tek satışlar kâr.
    assert.equal(paket.get('set-1').cash_cents, -6960); assert.equal(paket.get('set-2').cash_cents, -4800);
    assert.equal(paket.get('tek-1').cash_cents, 3600); assert.equal(paket.get('cok-1').cash_cents, 7200);
    // Zarar eden set paketinin İÇİNDE p1'in payı ARTIDA: sorunun kendisi.
    assert.equal(paket.get('set-1').urunler.find(u => u.product_id === 'p1').cash_cents, 240);
    // ŞİRKET DÜZEYİ DEĞİŞMEZ.
    assert.equal(sum(r.rows, 'cash_cents'), -960);
    assert.equal(r.channels.find(c => c.channel === 'trendyol').cash_cents, -960);

    const k = await f.ok('/ec/urun-karlilik');
    assert.deepEqual(k.sales.rows, aggregateSales(r.rows).rows);
    assert.equal(sum(k.rows, 'kar_cents'), -960);

    const p1 = k.rows.find(u => u.product_id === 'p1');
    // TEK = kendi ilanı + kendi çoklu paketi; SET = çok bileşenli ilan. İkisi TOPLAMI verir.
    assert.equal(p1.tek_kar_cents, 10800); assert.equal(p1.set_kar_cents, -960); assert.equal(p1.kar_cents, 9840);
    assert.equal(p1.tek_paket, 2); assert.equal(p1.set_paket, 2); assert.equal(p1.paket, 4);
    assert.equal(p1.tek_adet_milli, 5000); assert.equal(p1.set_adet_milli, 2000); assert.equal(p1.adet_milli, 7000);
    assert.equal(p1.tek_ciro_cents, 156000); assert.equal(p1.set_ciro_cents, 72000); assert.equal(p1.ciro_cents, 228000);
    // Sahibin göreceği cümle: tek satışta adet başı 21,60 TL, set içinde 4,80 TL ZARAR.
    assert.equal(p1.tek_kar_adet_cents, 2160); assert.equal(p1.set_kar_adet_cents, -480);
    for (const u of k.rows) for (const [a, b, t] of [['tek_kar_cents', 'set_kar_cents', 'kar_cents'],
      ['tek_ciro_cents', 'set_ciro_cents', 'ciro_cents'], ['tek_adet_milli', 'set_adet_milli', 'adet_milli']]) {
      assert.equal(u[a] + u[b], u[t], u.product_id + ': ' + a + '+' + b + '=' + t);
    }
    // Yalnız set içinde satılan ürünün tek satışı YOKTUR: sıfır paket, sıfır adet.
    const p2 = k.rows.find(u => u.product_id === 'p2');
    assert.equal(p2.tek_paket, 0); assert.equal(p2.tek_adet_milli, 0); assert.equal(p2.tek_kar_cents, 0);
    assert.equal(p2.set_kar_cents, -6000); assert.equal(p2.kar_cents, -6000);
    // Eski alan adları çalışmaya devam eder.
    assert.equal(p1.bundle_cash_cents, -960); assert.equal(p1.single_cash_cents + p1.multipack_cash_cents, 10800);
    assert.equal(p1.role, 'stock_component_contribution');
  } finally { f.close(); }
});

test('set (ilan) kârlılığı: paket sonucu kâr raporunun satırıyla kuruşu kuruşuna aynı', async () => {
  const f = appFixture(); await f.setup(); try {
    canliOrnek(f);
    const r = await report(f), paket = new Map(r.rows.map(p => [p.id, p]));
    const k = await f.ok('/ec/urun-karlilik');
    assert.ok(Array.isArray(k.setler), 'setler kırılımı yanıtta yok');
    assert.equal(k.setler.length, 1);
    const s = k.setler[0];
    // KURUŞU KURUŞUNA: setin sonucu, kâr raporunun o paketlerinin toplamıdır.
    assert.equal(s.kar_cents, paket.get('set-1').cash_cents + paket.get('set-2').cash_cents);
    assert.equal(s.kar_cents, -11760);
    assert.equal(s.paket, 2); assert.equal(s.adet_milli, 2000);
    assert.equal(s.ciro_cents, paket.get('set-1').revenue_gross_cents + paket.get('set-2').revenue_gross_cents);
    assert.equal(s.ciro_cents, 216000);
    assert.equal(s.paket_basina_cents, -5880);
    // Sahibin fiyatladığı ilan: adı ve YAPILANDIRILMIŞ gelir payları görünür.
    assert.equal(s.mapping_id, 'set-ilan'); assert.equal(s.ad, 'Set ilanı set-ilan');
    assert.deepEqual(s.bilesenler.map(c => [c.product_id, c.revenue_share_bps]), [['p1', 4000], ['p2', 3000], ['p3', 3000]]);
    assert.equal(s.bilesenler.find(c => c.product_id === 'p1').name, 'Yaprak Temizleyici 250 ml');
    // Kural tek cümlede söylenir.
    assert.match(k.set_notice, /tek başına/i);
    // Tek satış ve çoklu paket ilanları set listesine GİRMEZ.
    assert.equal(k.setler.some(x => x.bilesenler.length < 2), false);
  } finally { f.close(); }
});

test('bilinmeyen maliyet sıfır sayılmaz: şekil kırılımı da neden söyler', async () => {
  const f = appFixture(); await f.setup(); try {
    setup(f);
    mapping(f, 'set-ilan', [{id: 'p1', share: 4000}, {id: 'p2', share: 3000}, {id: 'p3', share: 3000}]);
    pack(f, 'tek-1', [{components: [{id: 'p1', revenue: 30000, cost: 26000, shipping: 1000}]}]);
    // Maliyeti bilinmeyen set paketi: ürünün SET tarafı boş kalır, TEK tarafı bilinmeye devam eder.
    pack(f, 'set-bilinmiyor', [{mapping: 'set-ilan', components: [
      {id: 'p1', revenue: 30000, cost: 0, shipping: 1000},
      {id: 'p2', revenue: 30000, cost: 28000, shipping: 1000},
      {id: 'p3', revenue: 30000, cost: 27000, shipping: 1000}]}]);
    const k = await f.ok('/ec/urun-karlilik');
    const p1 = k.rows.find(u => u.product_id === 'p1');
    assert.equal(p1.kar_cents, null); assert.equal(p1.set_kar_cents, null); assert.equal(p1.set_ciro_cents, null);
    assert.equal(p1.tek_kar_cents, 3600, 'tek satış bilinmeye devam eder');
    assert.equal(p1.set_eksik_paket, 1); assert.equal(p1.tek_eksik_paket, 0);
    assert.ok(p1.eksik_neden, 'eksik nedeni söylenir');
    assert.equal(p1.set_kar_adet_cents, null);
    assert.equal(p1.set_adet_milli, 1000, 'miktar bilinir, tutar bilinmez');
    const s = k.setler[0];
    assert.equal(s.kar_cents, null); assert.equal(s.paket_basina_cents, null); assert.equal(s.eksik_paket, 1);
    assert.equal(s.paket, 1); assert.equal(s.adet_milli, 1000);
  } finally { f.close(); }
});

// ---- Stok ekranı: iki rakam ayrı ayrı, kısa Türkçe etiketlerle -------------------------------
const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const helpers = {esc, money: v => v == null ? 'Tutar bilinmiyor' : (v / 100).toFixed(2) + ' TL', qty: v => String(v / 1000), compact: true};
const urun = {id: 'p1', name: 'Yaprak Temizleyici 250 ml', sku: 'YT250', brand: 'Tropikal', category: 'Bakım', stock_unit: 'adet',
  min_stock_milli: 0, quantity_milli: 8000, on_hand_milli: 8000, reserved_milli: 0, available_milli: 8000,
  in_transit_milli: 0, in_transit_status: 'complete', in_transit_notes: [], value_cents: 10000, vat_bps: 2000, average_purchase_cents: 1000};

test('stok ekranı ürünün tek satış ve set içi sonucunu AYRI gösterir, karışık tek rakam yoktur', async () => {
  const f = appFixture(); await f.setup(); try {
    canliOrnek(f);
    const k = await f.ok('/ec/urun-karlilik');
    const data = {sales: [], suppliers: [], productStats: new Map(k.rows.map(r => [r.product_id, r]))};
    for (const stockView of ['cards', 'table']) {
      const html = productList([urun], data, {stockView}, helpers);
      assert.ok(html.includes('Tek satıştan'), 'tek satıştan etiketi'); assert.ok(html.includes('Set içinden'), 'set içinden etiketi');
      assert.ok(html.includes('108.00 TL'), 'tek satış sonucu'); assert.ok(html.includes('-9.60 TL'), 'set içi sonuç');
      assert.ok(html.includes('adet başına 21.60 TL') && html.includes('adet başına -4.80 TL'), 'adet başına iki ayrı rakam');
      assert.ok(html.includes('2 adet · 2 paket'), 'set içi miktar ve paket sayısı');
      // Kural tek cümlede söylenir; karışık toplam (93,60 TL) hiç yazılmaz.
      assert.match(html, /set payı o ürünün tek başına kârı değildir/i);
      assert.ok(!html.includes('98.40 TL'), 'karışık tek rakam gösterilmez');
      assert.ok(!html.includes('Toplam kâr') && !html.includes('Adet başı kâr'), 'eski çıplak bileşen gösterimi geri gelmez');
    }
  } finally { f.close(); }
});

test('stok ekranında bilinmeyen sonuç SIFIR değil, nedenle gösterilir', () => {
  const stats = new Map([['p1', {adet_milli: 4000, kar_cents: null, tek_paket: 1, tek_kar_cents: null, tek_adet_milli: 1000,
    tek_kar_adet_cents: null, tek_eksik_paket: 1, set_paket: 0, set_adet_milli: 0, set_kar_cents: 0, set_eksik_paket: 0,
    eksik_neden: 'Satılan ürünün alış maliyeti bilinmiyor.'}]]);
  const html = productList([urun], {sales: [], suppliers: [], productStats: stats}, {stockView: 'cards'}, helpers);
  assert.ok(html.includes('1 pakette Satılan ürünün alış maliyeti bilinmiyor.'), 'eksik neden yazılır');
  assert.ok(html.includes('Bu dönemde yok'), 'hiç satılmayan şekil sıfır TL olarak yazılmaz');
  // Şekil kırılımının kendi bloğunda HİÇ tutar yoktur: bilinmeyen de, satılmayan da sıfır yazılmaz.
  const blok = html.slice(html.indexOf('<dl class="product-shape">'), html.indexOf('</dl>', html.indexOf('<dl class="product-shape">')));
  assert.ok(blok.includes('Bilinmiyor') && !blok.includes(' TL'), 'bilinmeyen sıfır sayılmaz: ' + blok);
});

test('stok ekranındaki set listesi ilanı, satış adedini, ciroyu ve paket başına kalanı verir', async () => {
  const f = appFixture(); await f.setup(); try {
    canliOrnek(f);
    const k = await f.ok('/ec/urun-karlilik');
    const html = setProfitList(k.setler, k.set_notice, helpers);
    assert.ok(html.includes('Set (ilan) kârlılığı · 1 ilan'), 'başlık');
    assert.ok(html.includes('Set ilanı set-ilan'), 'ilan adı');
    assert.ok(html.includes('-58.80 TL') && html.includes('paket başına kalan'), 'paket başına kalan');
    assert.ok(html.includes('2 satış · 2 paket · ciro 2160.00 TL · kalan -117.60 TL'), 'adet, ciro ve kalan');
    assert.ok(html.includes('Yaprak Temizleyici 250 ml %40 + Genel Bitki Besini 225 ml %30 + Orkide Toprağı 3 L %30'), 'bileşenler ve payları');
    assert.match(html, /tek başına kârı DEĞİLDİR/);
    assert.ok(html.includes('ol-neg'), 'zarar kırmızı işaretlenir');
    // Hesaplanamayan ilan sıfır TL yazmaz, nedenini yazar.
    const bos = setProfitList([{ad: 'Eksik ilan', paket: 1, adet_milli: 1000, ciro_cents: null, kar_cents: null,
      paket_basina_cents: null, eksik_paket: 1, bilesenler: [{product_id: 'p1', name: 'A', revenue_share_bps: null}]}], '', helpers);
    assert.ok(bos.includes('1 pakette hesaplanamadı') && bos.includes('ciro bilinmiyor · kalan bilinmiyor'), bos);
    assert.ok(!bos.includes('TL'), 'bilinmeyen sıfır sayılmaz');
    assert.equal(setProfitList([], '', helpers), '', 'set yoksa bölüm hiç çizilmez');
  } finally { f.close(); }
});

test('tutar yetkisi olmayan personel yeni şekil ve set alanlarında da rakam göremez', async () => {
  const f = appFixture(); await f.setup(); try {
    canliOrnek(f);
    const k = await f.ok('/ec/urun-karlilik');
    const gizli = scrubAmounts(k, {ec_access: 'read', permissions: {ec: {amounts: 'none'}}}, 'ec');
    let sayi = 0;
    const gez = v => { if (!v || typeof v !== 'object') return; for (const [key, x] of Object.entries(v)) {
      if (key.endsWith('_cents') || key === 'revenue_share_bps') { sayi++; assert.equal(x, null, key); } else gez(x); } };
    gez(gizli.rows); gez(gizli.setler);
    assert.ok(sayi > 20, 'yeni alanlar da taranır: ' + sayi);
    // Miktar, paket sayısı ve ilan adı görünür kalır: iş yapılabilmeli.
    assert.equal(gizli.setler[0].paket, 2); assert.equal(gizli.setler[0].adet_milli, 2000);
    assert.equal(gizli.setler[0].ad, 'Set ilanı set-ilan');
    assert.equal(gizli.rows.find(u => u.product_id === 'p1').set_adet_milli, 2000);
  } finally { f.close(); }
});
