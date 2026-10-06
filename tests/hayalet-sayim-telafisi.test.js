// HAYALET RAF SAYIMI TELAFİSİ. Panelin iki parçası aynı kaydı farklı anlıyordu:
// ledger-api.js:380 faturasız mal girişinin GELEN MİKTARINI 'GECICI-SAYIM-<irsaliye>' sayımı
// olarak yazar; report-stock-link-api.js o kaydı RAF ANLIK GÖRÜNTÜSÜ sanıp arada satılan adedi
// 'GECICI-SAYIM-<irsaliye>-SAT-<paket>' referansıyla geri ekliyordu. Gelen miktar + satılan
// miktar = hayalet stok (canlıda 341 hareket / 398 adet / 13.492,34 TL, ölçüm 05.10.2026).
//
// Bu dosya iki şeyi tutar:
//  1) fifo-cost.js'in `dus` kümesi: geri çekilmiş sayım ve TAM aynası hiç oynatılmaz. Yama
//     olmadan ayna orantili()'ye düşer, raftaki gerçek partileri sale:null tüketir ve fatura
//     kapanışı o adetleri KAYIP sanıp uydurma kayıp gideri yazar (ec_close_cost_revaluations
//     kind='kayip' → accounting.js:159 'loss' gideri).
//  2) 0072 göçü: mekanizma kapatılır, hayaletlere birebir tam ayna yazılır, değeri karşılanmayan
//     ürün ELENİR (kırpılmaz).
// Stok kartı etiketleri tests/ux-2026-10-03-purchase-stock.test.js'te tutulur.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {appFixture} from './helpers/app-fixture.js';
import {fifoHesap} from '../src/fifo-cost.js';

const GELIS = '2026-09-20', FATURA = '2026-09-30';
const GOC = '0072_sayim_telafisi_geri_alindi.sql';

async function kur() {
  const f = appFixture(); await f.setup();
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");   // canlıdaki ayar
  const supplier = (await f.ok('/ec/suppliers', {name: 'Tropikal Benzeri A.Ş.', tax_id: '1234567890', contact: ''})).id;
  const product = (await f.ok('/ec/products', {name: 'Perlit 10 L', sku: 'P-10', stock_unit: 'adet', min_stock: 0})).id;
  return {f, supplier, product};
}
// 10 adet, birim 100 TL → sayım hareketi +10.000 milli / +100.000 kuruş, cari borç 1.200 TL.
const gecici = (f, supplier, product, reference, adet = 10, unit = 100) => f.ok('/ec/ledger/provisional', {
  supplier_id: supplier, occurred_on: GELIS, reference, notes: '',
  lines: [{product_id: product, quantity: adet, unit_cost: unit, vat_bps: 2000}]});
const receiptId = (f, reference) => f.sqlite.prepare('SELECT id FROM ec_provisional_receipts WHERE reference=?').get(reference).id;
const sayimId = (f, reference) => f.sqlite.prepare("SELECT id FROM ec_stock_movements WHERE kind='count' AND reference=?").get(reference).id;
const stok = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});

/** 0050:66-69'un gönderim tetiğinin yazdığı telafi hareketinin birebir aynısı. */
function hayalet(db, {id, product, qty, value, ref, date = GELIS}) {
  db.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)' +
    " VALUES(?,?,?,?,'count',?,?,?)").run(id, product, qty, value, ref,
    'Geçici sayım, sayımdan önceki satış kadar artırıldı. Raf değişmez; fatura gelince kapanır.', date);
}
/** 0072'nin yazdığı ayna hareketinin birebir aynısı (göç olmadan fifo yamasını sınamak için). */
function ayna(db, {id, product, qty, value, ref, date = GELIS}) {
  db.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)' +
    " VALUES(?,?,?,?,'purchase',?,?,?)").run(id, product, -qty, -value, 'TELAFI-IPTAL-' + ref,
    'Raf sayımı telafisi geri alındı (0072).', date);
}
async function faturaVeTeslim(f, supplier, product, no, adet, net) {
  const inv = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, invoice_date: FATURA, currency: 'TRY',
    lines: [{description: 'Perlit 10 L', external_code: 'P-10', invoice_quantity: adet, invoice_unit: 'adet',
      product_id: product, stock_quantity: adet, net, tax: net / 5}]})).id;
  await f.ok('/ec/invoices/' + inv + '/post', {});
  const line = f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(inv).id;
  await f.ok('/ec/invoices/' + inv + '/receive', {occurred_on: FATURA, reference: 'TESLIM-' + no, lines: [{id: line, quantity: adet}]});
  return inv;
}
// DOĞRU PROB. `SELECT COUNT(*) FROM ec_expenses WHERE category='loss'` KÖRDÜR: kayıp gideri
// satırı API katmanında ec_close_cost_revaluations'tan üretilir (accounting.js:159,
// money-planning-api.js:165). Canlıda da ec_expenses 0 dönerken kâr ekranında -1.725,27 TL
// duruyordu. Ayrıca motor her non-GET ec isteğinden sonra çalışıyor (worker.js:30), bu yüzden
// fifoHesap()'ın döndürdüğü `tamamla` o an BOŞ olabilir: yazılmış satır `tamamlanan` ile düşülür.
const kayipDefter = f => f.sqlite.prepare("SELECT value_cents v FROM ec_close_cost_revaluations WHERE kind='kayip' ORDER BY rowid").all().map(x => x.v);
const kayipGideri = async f => (await f.ok('/ec?from=2026-09-01&to=2026-10-31')).expenses.filter(e => e.category === 'loss').map(e => e.amount_cents);

// ---- 1) fifo-cost.js: geri çekilmiş sayım ve tam aynası oynatılmaz --------------------------

test('Hayalet sayım ve TAM aynası oynatılmaz: fatura kapanışı uydurma kayıp gideri yazmaz', async () => {
  const {f, supplier, product} = await kur(); try {
    await gecici(f, supplier, product, 'IRSA');                       // 10 adet / 1.000 TL
    const ref = 'GECICI-SAYIM-IRSA-SAT-pkg12345';
    hayalet(f.sqlite, {id: 'sayim-telafi-1', product, qty: 4000, value: 40000, ref});
    assert.deepEqual(stok(f, product), {q: 14000, v: 140000}, 'hayalet 4 adet fazla gösterir');
    ayna(f.sqlite, {id: 'telafi-iptal-1', product, qty: 4000, value: 40000, ref});
    assert.deepEqual(stok(f, product), {q: 10000, v: 100000}, 'ayna hayaleti geri çeker');

    await faturaVeTeslim(f, supplier, product, 'F-1', 10, 900);       // gerçek fatura 90 TL/adet
    // Yama olmadan ölçülen: ayna orantili()'ye düşer, sayım partisinden 2,857 adet sale:null
    // tüketir, kapanış o adetleri KAYIP sanar ve -28,57 TL uydurma gider yazar.
    assert.deepEqual(kayipDefter(f), [], 'kapanış KAYIP farkı yazmamalı: ayna gerçek partiyi tüketmedi');
    assert.deepEqual(await kayipGideri(f), [], 'kâr ekranında kayıp gideri satırı yok');
    const h = await fifoHesap(f.env.DB, product);
    assert.deepEqual(h.tamamla.filter(t => t.kind === 'kayip'), [], 'bekleyen kayıp tamamlaması da yok');
    assert.equal(h.artik, 0, 'model değeri bakiyeyle uzlaşır');
    assert.equal(h.guvenli, true);
    assert.deepEqual(stok(f, product), {q: 10000, v: 90000}, 'fatura fiyatına çekilmiş 10 adet kalır');
  } finally { f.close(); }
});

test('Aynası yarım (kırpılmış) hayalet ESKİ yoldan oynar: tam eşleşme şartı kırpmayı korur', async () => {
  const {f, supplier, product} = await kur(); try {
    await gecici(f, supplier, product, 'IRSA');
    const ref = 'GECICI-SAYIM-IRSA-SAT-pkg12345';
    hayalet(f.sqlite, {id: 'sayim-telafi-1', product, qty: 4000, value: 40000, ref});
    // Değeri kırpılmış ayna: adet tam, değer eksik. dus'a GİRMEZ → davranış bugünküyle birebir aynı.
    f.sqlite.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)' +
      " VALUES('telafi-iptal-1',?,-4000,-30000,'purchase',?,'Kırpılmış ayna',?)").run(product, 'TELAFI-IPTAL-' + ref, GELIS);

    await faturaVeTeslim(f, supplier, product, 'F-1', 10, 900);
    assert.deepEqual(kayipDefter(f), [-2857],
      'kırpılmış ayna hâlâ orantili()ye düşer ve kapanışta kayıp doğurur: 0072 kırpma YAZMAZ');
  } finally { f.close(); }
});

test('Faturasız giriş iptali (GECICI-IPTAL-) de oynatılmaz: mükerrer irsaliye kayıp gideri doğurmaz', async () => {
  const {f, supplier, product} = await kur(); try {
    await gecici(f, supplier, product, 'IRSA');                       // sağlam giriş
    await gecici(f, supplier, product, 'IRSA-MUKERRER');              // aynı mal ikinci kez girilmiş
    assert.equal(stok(f, product).q, 20000);
    const r = await f.req('/ec/ledger/provisional/' + receiptId(f, 'IRSA-MUKERRER') + '/iptal', {reason: 'Aynı teslimat iki kez girildi'});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(stok(f, product), {q: 10000, v: 100000});

    await faturaVeTeslim(f, supplier, product, 'F-1', 10, 900);
    // Yama GECICI-IPTAL-'e genellenmezse burada -50,00 TL uydurma kayıp doğuyor (ölçüldü).
    assert.deepEqual(kayipDefter(f), [], 'iptal aynası sağlam sayımın partisini tüketmemeli');
    assert.deepEqual(await kayipGideri(f), []);
    const h = await fifoHesap(f.env.DB, product);
    assert.equal(h.artik, 0);
  } finally { f.close(); }
});

test('Kapanışı yazılmış sayım dus kümesine girmez: kapanış kendi partisini bulmaya devam eder', async () => {
  const {f, supplier, product} = await kur(); try {
    await gecici(f, supplier, product, 'IRSA');
    await faturaVeTeslim(f, supplier, product, 'F-1', 10, 900);
    const sayim = sayimId(f, 'GECICI-SAYIM-IRSA');
    assert.ok(f.sqlite.prepare("SELECT 1 FROM ec_stock_movements WHERE reference LIKE 'provisional-close:'||?||':%'").get(sayim),
      'kapanış yazıldı');
    // Kapanışı olan sayıma (olmayacak bir durum, eski veri) tam ayna gelse bile sayım düşülmez:
    // düşülse kapanış kendi partisini bulamaz ve faturanın fiyatını yanlış adede yazardı.
    const h = await fifoHesap(f.env.DB, product);
    assert.equal(h.artik, 0);
    assert.equal(h.kalan_deger, stok(f, product).v, 'kapanış sonrası model değeri = bakiye');
    assert.deepEqual(kayipDefter(f), [], 'hayaletsiz akışta kayıp yok');
  } finally { f.close(); }
});

// ---- 2) 0072 göçü ---------------------------------------------------------------------------

/** 0072'den ÖNCEKİ şema: hayalet veri kurulur, sonra `upgrade()` ile göç uygulanır. */
function oncesi() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(x => x.endsWith('.sql') && x < GOC).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  return {sqlite, upgrade: () => sqlite.exec(readFileSync(new URL(GOC, dir), 'utf8')), close: () => sqlite.close()};
}
function urun(db, id, {q = 0, v = 0} = {}) {
  db.prepare('INSERT INTO ec_products(id,name,sku) VALUES(?,?,?)').run(id, id, id);
  if (q || v) db.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on)' +
    " VALUES(?,?,?,?,'opening',?,'2026-09-01')").run('ac-' + id, id, q, v, 'ACILIS-' + id);
}
/** Hayaletin malının/değerinin stoktan ÇIKMIŞ olması (TS1'de 23.09 elle geri çekme, Kaktüs'te
 *  değerin satışlara akması): bakiye değeri hayalet değerinin altına iner → ürün elenir. */
function cikis(db, id, product, q, v) {
  db.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on)' +
    " VALUES(?,?,?,?,'purchase',?,'2026-09-23')").run(id, product, q, v, 'ELLE-DUZELTME-' + id);
}
const aynalar = db => db.prepare("SELECT product_id p,quantity_milli q,value_cents v,reference r,occurred_on d" +
  " FROM ec_stock_movements WHERE kind='purchase' AND reference LIKE 'TELAFI-IPTAL-%' ORDER BY reference").all().map(x => ({...x}));
const bakiye = (db, p) => ({...db.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});

test('0072: hayaletin her hareketine birebir tam ayna yazılır, tarihi hayaletin kendi tarihidir', () => {
  const g = oncesi(); try {
    urun(g.sqlite, 'p1', {q: 20000, v: 200000});
    hayalet(g.sqlite, {id: 'h1', product: 'p1', qty: 4000, value: 40000, ref: 'GECICI-SAYIM-A-SAT-pak1'});
    hayalet(g.sqlite, {id: 'h2', product: 'p1', qty: 3000, value: 30000, ref: 'GECICI-SAYIM-A-SAT-pak2', date: '2026-09-22'});
    assert.deepEqual(bakiye(g.sqlite, 'p1'), {q: 27000, v: 270000});

    g.upgrade();

    assert.deepEqual(aynalar(g.sqlite), [
      {p: 'p1', q: -4000, v: -40000, r: 'TELAFI-IPTAL-GECICI-SAYIM-A-SAT-pak1', d: GELIS},
      {p: 'p1', q: -3000, v: -30000, r: 'TELAFI-IPTAL-GECICI-SAYIM-A-SAT-pak2', d: '2026-09-22'}],
      'hareket başına tam ayna; toplu ya da bugüne tarihli tek kayıt DEĞİL');
    assert.deepEqual(bakiye(g.sqlite, 'p1'), {q: 20000, v: 200000}, 'stok gerçek rafa iner');
    assert.equal(g.sqlite.prepare('SELECT COUNT(*) n FROM ec_sayim_telafi_iptali').get().n, 2, 'iz tablosu');
    // kind='count' + eksi değer yazılsa ec_count_loss uydurma kayıp gideri yazardı (0070'in dersi).
    assert.equal(g.sqlite.prepare('SELECT COUNT(*) n FROM ec_expenses').get().n, 0, 'uydurma kayıp gideri yok');
  } finally { g.close(); }
});

test('0072: değeri karşılanmayan ürün ELENİR, kırpılmaz; aynı üründeki hiçbir hareket yazılmaz', () => {
  const g = oncesi(); try {
    urun(g.sqlite, 'p1', {q: 20000, v: 200000});          // hayalet değeri karşılanır
    urun(g.sqlite, 'ts1', {q: 4000, v: 400000});
    urun(g.sqlite, 'kaktus');
    hayalet(g.sqlite, {id: 'h1', product: 'p1', qty: 4000, value: 40000, ref: 'GECICI-SAYIM-A-SAT-pak1'});
    // TS1 emsali: 2 adet / 2.333,34 TL hayalet, ama 23.09'da elle zaten geri çekilmiş.
    hayalet(g.sqlite, {id: 'h2', product: 'ts1', qty: 1000, value: 116667, ref: 'GECICI-SAYIM-B-SAT-pak1'});
    hayalet(g.sqlite, {id: 'h3', product: 'ts1', qty: 1000, value: 116667, ref: 'GECICI-SAYIM-B-SAT-pak2'});
    cikis(g.sqlite, 'ts1-elle', 'ts1', -4000, -473334);   // bakiye 2 adet / 1.600,00 TL < 2.333,34
    // Kaktüs emsali: değeri satışlara akmış, bakiye -10 adet / 0,00 TL.
    hayalet(g.sqlite, {id: 'h4', product: 'kaktus', qty: 4000, value: 8400, ref: 'GECICI-SAYIM-C-SAT-pak1'});
    cikis(g.sqlite, 'kaktus-satis', 'kaktus', -14000, -8400);
    assert.deepEqual(bakiye(g.sqlite, 'ts1'), {q: 2000, v: 160000});
    assert.deepEqual(bakiye(g.sqlite, 'kaktus'), {q: -10000, v: 0});
    const onceTs1 = bakiye(g.sqlite, 'ts1'), onceKaktus = bakiye(g.sqlite, 'kaktus');

    g.upgrade();

    assert.deepEqual(aynalar(g.sqlite).map(a => a.r), ['TELAFI-IPTAL-GECICI-SAYIM-A-SAT-pak1'],
      'yalnız değeri karşılanan ürün geri çekilir');
    assert.deepEqual(bakiye(g.sqlite, 'ts1'), onceTs1,
      'elenen ürünün defterine dokunulmaz (kırpma değer/adet ayrışması ve FIFO artığı doğururdu)');
    assert.deepEqual(bakiye(g.sqlite, 'kaktus'), onceKaktus, 'Kaktüs -10 kalır; 4 adet hayalet bilinçli açıkta');
    assert.equal(g.sqlite.prepare("SELECT COUNT(*) n FROM ec_sayim_telafi_iptali WHERE product_id!='p1'").get().n, 0);
    // TS1 dahil edilse -733,34 ile INVALID_STOCK_VALUE atar ve TEK ifade olduğu için bütün
    // satırları düşürürdü: eleme hem doğru hem zorunlu.
    assert.throws(() => g.sqlite.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on)' +
      " VALUES('x','ts1',-2000,-233334,'purchase','TELAFI-IPTAL-DENEME','2026-09-20')").run(), /INVALID_STOCK_VALUE/);
  } finally { g.close(); }
});

test('0072: telafi mekanizması kapanır; bekleyen niyet uygulanmış sayılır, yenisi yazılamaz', () => {
  const g = oncesi(); try {
    urun(g.sqlite, 'p1', {q: 20000, v: 200000});
    g.sqlite.prepare('INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on)' +
      " VALUES('c1','p1',5000,50000,'count','GECICI-SAYIM-A','2026-09-20')").run();
    g.sqlite.prepare('INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,status,source_fingerprint)' +
      " VALUES('pk1','trendyol','O1','2026-09-18','reserved','fp1')").run();
    g.sqlite.prepare('INSERT INTO ec_report_count_offsets(id,package_id,product_id,count_movement_id,quantity_milli,value_cents,reference,notes,occurred_on)' +
      " VALUES('o1','pk1','p1','c1',2000,20000,'GECICI-SAYIM-A-SAT-pk1','niyet','2026-09-20')").run();

    g.upgrade();

    assert.equal(g.sqlite.prepare('SELECT COUNT(*) n FROM ec_report_count_offsets WHERE applied_at IS NULL').get().n, 0,
      'bekleyen niyet uygulanmış işaretlenir: bir daha harekete dönemez');
    assert.equal(g.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='ec_report_count_offset_on_ship'").get().n, 0,
      'gönderim tetiği kaldırıldı');
    // Gönderim artık telafi yazmaz.
    g.sqlite.prepare("UPDATE ec_order_packages SET status='shipped' WHERE id='pk1'").run();
    assert.equal(g.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'GECICI-SAYIM-%-SAT-%'").get().n, 0);
    // Sert kapı: faturasız giriş sayımına bir daha telafi niyeti yazılamaz.
    assert.throws(() => g.sqlite.prepare('INSERT INTO ec_report_count_offsets(id,package_id,product_id,count_movement_id,quantity_milli,value_cents,reference,notes,occurred_on)' +
      " VALUES('o2','pk1','p1','c1',1000,10000,'GECICI-SAYIM-A-SAT-pk2','niyet','2026-09-20')").run(),
      /PROVISIONAL_COUNT_NOT_SHELF/);
  } finally { g.close(); }
});

test('0072: iz tablosu değiştirilemez; veri ifadeleri ikinci koşuda ayna çoğaltmaz', () => {
  const g = oncesi(); try {
    urun(g.sqlite, 'p1', {q: 20000, v: 200000});
    hayalet(g.sqlite, {id: 'h1', product: 'p1', qty: 4000, value: 40000, ref: 'GECICI-SAYIM-A-SAT-pak1'});
    g.upgrade();
    assert.throws(() => g.sqlite.exec('UPDATE ec_sayim_telafi_iptali SET quantity_milli=1'), /IMMUTABLE_LEDGER/);
    assert.throws(() => g.sqlite.exec('DELETE FROM ec_sayim_telafi_iptali'), /IMMUTABLE_LEDGER/);

    // Veri ifadeleri (5 ve 7) ikinci koşuda 0 satır yazar: ikisi de NOT EXISTS ile korunuyor ve
    // INSERT OR IGNORE kullanmıyor (çakışma sessizce yutulmaz).
    const sql = readFileSync(new URL('../migrations/' + GOC, import.meta.url), 'utf8');
    const ifade = re => { const m = sql.match(re); assert.ok(m, 'göçün ifadesi bulundu: ' + re); return m[0]; };
    for (let i = 0; i < 2; i++) {
      g.sqlite.exec(ifade(/INSERT INTO ec_sayim_telafi_iptali\(\s*movement_id[\s\S]*?;/));
      g.sqlite.exec(ifade(/INSERT INTO ec_stock_movements\(id,product_id[\s\S]*?;/));
    }
    assert.equal(aynalar(g.sqlite).length, 1, 'ayna bir kez yazılı kalır');
    assert.equal(g.sqlite.prepare('SELECT COUNT(*) n FROM ec_sayim_telafi_iptali').get().n, 1);
    assert.deepEqual(bakiye(g.sqlite, 'p1'), {q: 20000, v: 200000});

    // DÜRÜST CEVAP: DDL ifadeleri idempotent DEĞİL (bu depodaki bütün göçler böyle; tekillik
    // d1_migrations ile sağlanır, scripts/migrate-remote.mjs:28). Elle ikinci kez koşturulsa ilk
    // DDL'de durur ve hiçbir şey değişmez — yarım uygulanma yok: migrate-remote.mjs:36-41 dosyayı
    // d1_migrations INSERT'iyle birlikte TEK --file olarak gönderir, D1 hatada tamamını geri alır.
    assert.throws(() => g.upgrade(), /no such trigger|already exists/);
    assert.equal(aynalar(g.sqlite).length, 1);
    assert.deepEqual(bakiye(g.sqlite, 'p1'), {q: 20000, v: 200000});
  } finally { g.close(); }
});

test('0072 ölçüm kapısı: ölçülen hayalet kümesi kaymışsa göç GÜRÜLTÜLÜ durur', () => {
  const g = oncesi(); try {
    urun(g.sqlite, 'p1', {q: 2000000, v: 20000000});
    // Kapı, ölçülen nüfusa (341 hareket) ulaşmış veritabanında devreye girer; ec_stock_movements
    // değişmez + ekleme-sadece olduğu için canlıda bu sayı yalnız ARTABILIR.
    for (let i = 0; i < 341; i++) hayalet(g.sqlite, {id: 'h' + i, product: 'p1', qty: 1000, value: 1000, ref: 'GECICI-SAYIM-A-SAT-p' + i});
    assert.throws(() => g.upgrade(), /SAYIM_TELAFI_OLCUM_DEGISTI/);
    assert.equal(aynalar(g.sqlite).length, 0, 'kapı atınca hiçbir ayna yazılmaz');
  } finally { g.close(); }
});

test('0072 Wrangler ayrıştırıcısından eksiksiz geçer (tetik gövdeleri bölünmez, CASE yok)', () => {
  const sql = readFileSync(new URL('../migrations/' + GOC, import.meta.url), 'utf8');
  assert.ok(!/\bCASE\b/i.test(sql.replace(/--.*$/gm, '')), 'tetikte CASE yok (iif kullanılır)');
  for (const t of unstable_splitSqlQuery(sql).filter(q => /CREATE TRIGGER/i.test(q))) assert.match(t.trim(), /END;?$/, t.slice(0, 60));
  // Doğrulama ec_expenses'a bakmaz: kayıp gideri API katmanında ec_close_cost_revaluations'tan üretilir.
  assert.ok(/ec_close_cost_revaluations/.test(sql), 'doğru probun adı göç anlatısında geçer');
});
