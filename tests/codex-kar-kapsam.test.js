// CODEX R19 / R20 / R21 — KAPSAM. Ana sayfa ve kâr raporu hiçbir sonuçlanmış paketi sessizce düşürmez:
// ilk teslimden önce iade tarihiyle sonuçlanan paket, 101'den fazla dönen paket ve 1.000'den fazla
// bekleyen paket eksiksiz sayılır. Bir bölüm yine de hesaplanamazsa bu AÇIKÇA söylenir, hazır kartlar
// kullanılabilir kalır ve eksik toplam sıfır/tam gibi gösterilmez.
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {performanceReport} from '../src/performance-api.js';
import {scopedDB} from '../src/scoped-db.js';

const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
const gun = n => new Date(Date.parse(bugun) + n * 86400000).toISOString().slice(0, 10);
const ecEnv = f => ({...f.env, WORKSPACE: 'ec', DB: scopedDB(f.env.DB, 'ec')});
const DONEN = -Math.round((1610 + 3000 + 500) * 1.2);   // teslim edilemeyip dönen paket: −61,32

function kur(f) {
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('p1','Torf 10 L','T10','adet')");
  f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('p1',2000,0,0,0,0,100,100,100,500,1)");
  f.sqlite.exec('UPDATE ec_stock_balances SET quantity_milli=10000000,value_cents=46000000');
  f.sqlite.exec("INSERT INTO ec_report_profiles(id,provider,kind,signature,version,mapping_json,options_json,created_by) VALUES('pf-hb','hepsiburada','finance','sig',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t'),('pf-ty','trendyol','finance','sig2',1,'{}','{\"fee_amounts_include_vat\":true,\"fee_vat_bps\":2000}','t')");
}
const hazir = f => ({
  pk: f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,?,?,?,?,'draft','t')"),
  ln: f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Ürün',1000,11000,13200,2000)"),
  se: f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) VALUES(?,?,?,'p1','sale',1000,11000,4600,1610,3000,500,'confirmed',?)"),
  cm: f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) VALUES(?,?,'p1',1000,10000,?,'adet')"),
  st: f.sqlite.prepare('UPDATE ec_order_packages SET status=?,shipped_on=COALESCE(shipped_on,?),delivered_on=? WHERE id=?'),
  ia: f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?")
});
// durum: draft (satış yok) | shipped | delivered. iade: tarih verilirse satışın tamamı iade edilir.
function paket(f, s, id, kanal, tarih, {durum = 'delivered', iade = null, duz = false} = {}) {
  s.pk.run(id, kanal, 'E-' + id, 'S-' + id, tarih);
  s.ln.run('l-' + id, id, 'L-' + id);
  if (durum === 'draft') { s.cm.run('c-' + id, 'l-' + id, null); return; }
  s.se.run('s-' + id, kanal, 'X-' + id, tarih);
  s.cm.run('c-' + id, 'l-' + id, 's-' + id);
  s.st.run('reserved', null, null, id); s.st.run('shipped', tarih, null, id);
  if (durum === 'delivered') s.st.run('delivered', tarih, tarih, id);
  if (iade) s.ia.run('r-' + id, (duz ? 'DUZELTME-CIFT-' : 'IADE-') + id, iade, 's-' + id);
}
const toplu = (f, fn) => { f.sqlite.exec('BEGIN'); try { fn(); f.sqlite.exec('COMMIT'); } catch (e) { f.sqlite.exec('ROLLBACK'); throw e; } };
const toplam = rows => rows.reduce((t, r) => t + (r.cash_cents ?? 0), 0);

test('R19: ilk teslimden önce iade tarihiyle sonuçlanan paket tüm zamanlar ve dönem toplamına girer', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f); const s = hazir(f);
    paket(f, s, 'donen', 'trendyol', gun(-12), {durum: 'shipped', iade: gun(-10)});   // teslim edilemedi → −61,32
    paket(f, s, 'duz', 'trendyol', gun(-40), {durum: 'shipped', iade: gun(-30), duz: true});  // teknik ters kayıt
    paket(f, s, 'a', 'trendyol', gun(-3));                                              // ilk teslim: 15,48
    const p = await f.ok('/ec/panorama');
    const d = Object.fromEntries(p.periods.map(x => [x.key, x]));
    assert.equal(d.tum.from, gun(-10), 'tüm zamanlar ilk SONUÇ tarihinden başlar (DUZ ters kaydı sayılmaz)');
    assert.equal(d.tum.cash_cents, 1548 + DONEN, '−61,32 tüm zamanlara girdi');
    assert.equal(d['14g'].cash_cents, 1548 + DONEN, 'son 2 hafta da kapsar');
    assert.equal(d['7g'].cash_cents, 1548);
    const r = await f.ok(`/ec/performance?from=${d.tum.from}&to=${bugun}`);
    assert.equal(d.tum.cash_cents, toplam(r.rows), 'kâr raporuyla aynı');
    assert.equal(p.daily.reduce((t, g) => t + g.trendyol + g.hepsiburada, 0), d.tum.cash_cents, 'grafik de aynı olay tarihini kullanır');
    assert.equal(p.daily[0].date, gun(-10));
  } finally { f.close(); }
});

test('R19: hiç teslim yokken iade tarihiyle sonuçlanan paket ana sayfada boş görünmez', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f); const s = hazir(f);
    paket(f, s, 'donen', 'hepsiburada', gun(-8), {durum: 'shipped', iade: gun(-5)});
    const p = await f.ok('/ec/panorama');
    const tum = p.periods.find(x => x.key === 'tum');
    assert.equal(tum.packages, 1);
    assert.equal(tum.cash_cents, DONEN);
  } finally { f.close(); }
});

test('R20: 100 / 101 / 102 dönen paket aynı güne yığılsa da eksiksiz sayılır; sınır aşımı sessiz değil', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f); const s = hazir(f);
    paket(f, s, 'teslim', 'trendyol', gun(-3));
    let n = 0;
    const ekle = k => toplu(f, () => { for (let i = 0; i < k; i++) { n++; paket(f, s, 'd' + String(n).padStart(3, '0'), 'trendyol', gun(-4), {durum: 'shipped', iade: gun(-2)}); } });
    for (const [k, beklenen] of [[100, 100], [1, 101], [1, 102]]) {
      ekle(k);
      const r = await f.ok(`/ec/performance?from=${gun(-5)}&to=${bugun}`);
      const donen = r.rows.filter(x => x.teslim_edilemedi);
      assert.equal(donen.length, beklenen, beklenen + ' dönen paketin hepsi');
      assert.equal(new Set(donen.map(x => x.id)).size, beklenen, 'tekrar yok');
      assert.equal(toplam(r.rows), 1548 + beklenen * DONEN, 'kuruş toplamı eksiksiz');
    }
    // Sınır (max) aşılırsa eksik toplam verilmez: açık hata.
    await assert.rejects(() => performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-5), to: bugun, max: 40}), e => e.status === 409);
    // Sayfalı okuma: kararlı imleçle tekrarsız ve eksiksiz.
    const gorulen = new Map(); let imlec = '', sayfa = 0;
    do {
      const r = await performanceReport(ecEnv(f), {mode: 'delivered', from: gun(-5), to: bugun, max: 40, imlec});
      assert.ok(r.rows.length <= 40);
      for (const x of r.rows) { assert.ok(!gorulen.has(x.id), 'sayfalar arasında tekrar yok: ' + x.id); gorulen.set(x.id, x); }
      imlec = r.sonraki_imlec; sayfa++;
    } while (imlec && sayfa < 10);
    assert.equal(gorulen.size, 103);
    assert.equal(toplam([...gorulen.values()]), 1548 + 102 * DONEN);
  } finally { f.close(); }
});

test('R21: 1.000 / 1.001 bekleyen paket aynı güne yığılsa da ana sayfa çalışır; dönem kartları kullanılabilir', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f); const s = hazir(f);
    paket(f, s, 'teslim', 'trendyol', gun(-3));      // geçmiş: kesinti tahmini için örnek
    let n = 0;
    const ekle = k => toplu(f, () => { for (let i = 0; i < k; i++) { n++; paket(f, s, 'b' + String(n).padStart(4, '0'), 'trendyol', gun(-1), {durum: 'draft'}); } });
    for (const [k, beklenen] of [[1000, 1000], [1, 1001]]) {
      ekle(k);
      const p = await f.ok('/ec/panorama');
      assert.equal(p.pending.packages, beklenen, beklenen + ' bekleyen paket sayıldı');
      assert.equal(p.pending.calculated, beklenen);
      assert.equal(p.pending.cash_cents, beklenen * 1548, 'her paket bir kez');
      assert.ok(!p.pending.partial, 'eksiksiz');
      const tum = p.periods.find(x => x.key === 'tum');
      assert.equal(tum.cash_cents, 1548, 'teslim kartları etkilenmedi');
    }
  } finally { f.close(); }
});

test('R21: kargodaki bölüm hesaplanamazsa açıkça eksik döner; teslim kartları kullanılabilir kalır', async () => {
  const f = appFixture(); await f.setup(); try {
    kur(f); const s = hazir(f);
    paket(f, s, 'teslim', 'trendyol', gun(-3));
    paket(f, s, 'yolda', 'trendyol', gun(-1), {durum: 'draft'});
    // Tahmin tarifesi sınırı aşıldı: kargodakiler bölümü hesaplanamaz (409).
    const tarife = f.sqlite.prepare("INSERT INTO ec_commission_rates(id,label,channel,valid_from,valid_to,price_min_cents,rate_bps,base,vat_bps,tax_included,source) VALUES(?,'Sentetik tarife','trendyol','2026-01-01','2026-12-31',0,1000,'gross',2000,0,'Test')");
    toplu(f, () => { for (let i = 0; i < 1001; i++) tarife.run('tariff-' + i); });
    const p = await f.ok('/ec/panorama');
    assert.equal(p.pending.partial, true, 'eksik bölüm işaretlendi');
    assert.equal(p.pending.cash_cents, null, 'eksik toplam sıfır/tam gösterilmez');
    assert.match(p.pending.error, /Tarife/);
    assert.equal(p.periods.find(x => x.key === 'tum').cash_cents, 1548, 'teslim kartları hesaplandı');
    assert.equal(p.coverage.complete, false);
  } finally { f.close(); }
});
