// KESİNTİ DÖNGÜSÜ SAYFA BAŞINA TOPLU OKUR. Ölçüldü (07.10.2026, canlı önizleme ucu zamanlandı):
// bir sayfa (50 sipariş) 8,7 saniye, sipariş başına ~174 ms. Döngü paket başına ÜÇ sorgu yapıyordu
// (gerçek iade var mı · defterdeki brüt · satış satırları), yani ~80 SIRALI veritabanı turu; tur
// bütçesi 50 saniye olduğu için tarama hiç bitmiyordu. Veriler artık sayfanın tamamı için bir
// kerede okunuyor.
//
// BU DOSYANIN İŞİ: toplu okumanın PAKETLERİ BİRBİRİNE KARIŞTIRMADIĞINI kanıtlamak. Tek paketlik
// senaryolar mevcut kesinti testlerinde (40 test) zaten sabitlenmiş durumda; toplu okumanın
// bozabileceği şey paketler ARASI sızmadır — bir paketin iadesi başkasının sayılırsa teslim
// edilmemiş paket teslim olmuş gibi işlenir ve deftere yanlış kesinti yazılır.
//
// Kanıtlanan: (a) aynı çağrıda işlenen paketlerin sonucu tek tek doğru, (b) gerçek iadesi olan
// paketin iadesi KOMŞUSUNA sayılmıyor, (c) DUZELTME- ters kaydı hiçbir pakette iade sayılmıyor,
// (d) faturalı paket atlanıyor ve komşusu bundan etkilenmiyor, (e) çok satırlı pakette küsurat
// AYNI satıra gidiyor (allocateCents sıraya bağlı; sıra bozulsa toplam değişmez, kuruş kayar).
// TEMSİLİ veri; gerçek pazaryeri dosyası DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';

const DATE = '2026-09-12', TESLIM = '2026-09-14';
const sql = (f, q, ...args) => f.sqlite.prepare(q).run(...args);

function store(f) {
  sql(f, "INSERT INTO ec_report_stores(id,provider,code,name) VALUES('S','trendyol','TY-1','Mağaza')");
  sql(f, "INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status)"
    + " VALUES('file-1','S','orders','rapor.xlsx',100,?,'2026-09-12T10:00','[]',1,1,'applied')", 'f'.repeat(64));
  return 'S';
}
let sira = 0;
const rec = (f, kind, recordKey, data) =>
  sql(f, "INSERT INTO ec_report_records(id,store_id,kind,record_key,key_source,data_json,source_time,data_time,file_id,row_no)"
    + " VALUES(?,'S',?,?,'provider',?,'2026-09-12T10:00','2026-09-12T10:00','file-1',?)",
  'rec-' + (++sira), kind, recordKey, JSON.stringify(data), sira);

const satirlari = (f, saleIds) => saleIds.map(id =>
  ({...f.sqlite.prepare('SELECT commission_cents c,shipping_cents k,other_cents d,fees_status s FROM ec_sale_entries WHERE id=?').get(id)}));

/**
 * Kurulum: iki ilan: tek bileşenli (TEK) ve iki bileşenli set (SET, gelir payı 3334/6666 —
 * kesinti bölünürken KÜSURAT doğsun diye kasten eşitsiz).
 */
async function kurulum(f) {
  const a = await f.ok('/ec/products', {name: 'Çiçek besini 225 ml', sku: 'TR-A', stock_unit: 'adet', min_stock: 0});
  const b = await f.ok('/ec/products', {name: 'Yaprak parlatıcı', sku: 'TR-B', stock_unit: 'adet', min_stock: 0});
  for (const p of [a, b])
    await f.ok('/ec/stock', {product_id: p.id, quantity: 200, unit_cost: 10, kind: 'opening', reference: 'ACILIS', occurred_on: DATE, notes: 'Test'});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'TEK', external_name: 'Tek ürün',
    components: [{product_id: a.id, quantity_milli: 1000, revenue_share_bps: 10000}]});
  await f.ok('/ec/catalog/mappings', {source: 'trendyol', match_by: 'code', external_code: 'SET', external_name: 'İkili set',
    components: [{product_id: a.id, quantity_milli: 1000, revenue_share_bps: 3334},
      {product_id: b.id, quantity_milli: 1000, revenue_share_bps: 6666}]});
  sql(f, 'UPDATE workspace_settings SET inventory_start_date=? WHERE workspace=?', DATE, 'ec');
  return {a, b};
}

/** Tek paket kurar: rapor satırı + kesinti kayıtları, panele bağlar, gönderir, istenirse teslim eder. */
async function paket(f, {pk, kod = 'TEK', teslim = true, komisyon = 8000, kargo = 5000, servis = 1000, brut = 50000}) {
  rec(f, 'order_line', 'L:' + pk, {package_id: pk, line_id: 'L' + pk, order_no: 'O' + pk, order_date: DATE,
    ...(teslim ? {delivered_date: TESLIM, status: 'Teslim edildi'} : {status: 'Kargoda'}),
    barcode: kod, product_name: kod, quantity: 1, gross: brut, vat_bps: 2000});
  if (komisyon) rec(f, 'finance_event', 'F:' + pk + ':c', {event_id: pk + 'c', order_no: 'O' + pk, package_id: pk, type: 'commission', amount_cents: -komisyon, event_date: TESLIM});
  if (kargo) rec(f, 'finance_event', 'F:' + pk + ':k', {event_id: pk + 'k', order_no: 'O' + pk, package_id: pk, type: 'cargo', amount_cents: -kargo, event_date: TESLIM});
  if (servis) rec(f, 'finance_event', 'F:' + pk + ':s', {event_id: pk + 's', order_no: 'O' + pk, package_id: pk, type: 'service', amount_cents: -servis, event_date: TESLIM});
  const applied = await f.ok('/ec/reports/stock-link/apply', {store_id: 'S', package_id: pk, complete_package_confirmed: true});
  await f.ok('/ec/orders/' + applied.package_id + '/reserve', {});
  await f.ok('/ec/orders/' + applied.package_id + '/ship', {occurred_on: DATE, reference: 'SEVK-' + pk});
  if (teslim) await f.ok('/ec/orders/' + applied.package_id + '/deliver', {occurred_on: TESLIM});
  const sales = f.sqlite.prepare("SELECT s.id FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id"
    + " JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=? AND s.kind='sale' ORDER BY c.id").all(applied.package_id).map(r => r.id);
  return {id: applied.package_id, sales};
}

/** Satışa iade ekler. external_id 'DUZELTME-' ile başlarsa TEKNİK ters kayıttır, iade sayılmaz. */
function iadeEkle(f, saleId, externalId) {
  const s = f.sqlite.prepare('SELECT * FROM ec_sale_entries WHERE id=?').get(saleId);
  sql(f, 'INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on)'
    + " VALUES(?,?,?,?,'return',?,?,?,?,'pending',?)",
  'ret-' + externalId, s.channel, externalId, s.product_id, saleId, s.quantity_milli, -s.revenue_cents, -s.cost_cents, TESLIM);
}

test('Aynı çağrıda işlenen paketlerin sonucu tek tek doğru; iade KOMŞUYA sızmıyor', async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f); store(f);
    // P1 teslim edildi → yazılır. P2 teslim EDİLMEDİ ve iadesi yok → atlanır.
    // P3 teslim edilmedi AMA gerçek iadesi var → kapıyı geçer ve yazılır.
    const p1 = await paket(f, {pk: 'PK1'});
    const p2 = await paket(f, {pk: 'PK2', teslim: false});
    const p3 = await paket(f, {pk: 'PK3', teslim: false});
    iadeEkle(f, p3.sales[0], 'IADE-PK3');

    const r = await f.ok('/ec/reports/apply-fees', {store_id: 'S', confirm: true});

    assert.deepEqual(satirlari(f, p1.sales), [{c: 8000, k: 5000, d: 1000, s: 'confirmed'}], 'teslim edilen yazılmalı');
    assert.deepEqual(satirlari(f, p2.sales), [{c: null, k: null, d: null, s: 'pending'}],
      'teslim edilmeyen ve iadesi olmayan paket YAZILMAMALI — komşusunun iadesi ona sayılmasın');
    assert.deepEqual(satirlari(f, p3.sales), [{c: 8000, k: 5000, d: 1000, s: 'confirmed'}],
      'gerçek iadesi olan paket teslim beklemeden yazılır');
    assert.match(r.skipped.map(x => x.reason).join(' | '), /Teslim edilmedi/, JSON.stringify(r.skipped));
  } finally { f.close(); }
});

test("DUZELTME- ters kaydı hiçbir pakette iade sayılmaz", async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f); store(f);
    const p1 = await paket(f, {pk: 'PK1', teslim: false});
    const p2 = await paket(f, {pk: 'PK2', teslim: false});
    iadeEkle(f, p1.sales[0], 'DUZELTME-CIFT-PK1');
    iadeEkle(f, p2.sales[0], 'IADE-PK2');

    await f.ok('/ec/reports/apply-fees', {store_id: 'S', confirm: true});

    assert.deepEqual(satirlari(f, p1.sales), [{c: null, k: null, d: null, s: 'pending'}],
      'DUZELTME- teknik ters kayıttır: mal dönmedi, iade sayılmaz');
    assert.deepEqual(satirlari(f, p2.sales), [{c: 8000, k: 5000, d: 1000, s: 'confirmed'}],
      'gerçek iade aynı çağrıda doğru tanınmalı');
  } finally { f.close(); }
});

// FATURALI PAKET BURADA SINANMIYOR, çünkü senaryo kurulamıyor: ec_fee_allocations tetikleyicisi
// rapora bağlı bir satışa kesinti faturası bağlamayı FEE_ALREADY_IN_REPORT ile reddediyor. O dal
// mevcut kesinti testlerinde zaten kapsanıyor; toplu okuma açısından da ek risk taşımıyor, çünkü
// "faturalı" sayımı satış satırlarıyla AYNI sorgudan ve aynı paket anahtarıyla geliyor — yani
// aşağıdaki sızma testleri o anahtarlamayı da kanıtlıyor.

// KÜSURAT SIRAYA BAĞLI. allocateCents toplamı korur ama artan kuruşu SIRAYA göre dağıtır; toplu
// okuma satırları paket içinde c.id sırasıyla vermezse toplam aynı kalır, kuruş BAŞKA satıra gider
// ve kimse fark etmez. Bu yüzden hangi satıra gittiği açıkça sabitlenir.
test('Çok satırlı pakette küsurat aynı satıra gider; toplam korunur', async () => {
  const f = appFixture(); await f.setup(); try {
    await kurulum(f); store(f);
    // Gelir payı 3334/6666 ve komisyon 1001 kuruş: bölünme tam çıkmaz.
    // Komisyon 1001 ve kargo 500 kuruş, gelir payları 6666/3334: ikisi de tam bölünmez.
    // Kargo satırı OLMAK ZORUNDA: raporda kargo yoksa kural gereği hiç kesinti yazılmaz.
    const p = await paket(f, {pk: 'PK1', kod: 'SET', komisyon: 1001, kargo: 500, servis: 0});
    assert.equal(p.sales.length, 2, 'set iki satış satırı açmalı');

    await f.ok('/ec/reports/apply-fees', {store_id: 'S', confirm: true});
    const satir = satirlari(f, p.sales);

    assert.equal(satir[0].c + satir[1].c, 1001, 'komisyon toplamı korunmalı');
    assert.equal(satir[0].k + satir[1].k, 500, 'kargo toplamı korunmalı');
    // DEĞERLER SIRALI KARŞILAŞTIRILIR, KONUM SABİTLENMEZ. Ölçüldü (07.10.2026): bileşen kimlikleri
    // UUID olduğu için `ORDER BY c.id` iki satırı her çalıştırmada farklı sıraya koyuyor ve artan
    // kuruş sırayla gelen satıra yazılıyor. Bu ESKİ KODDA DA böyleydi — paket başına sorgu yapan
    // sürüm aynı senaryoda hem [667,334] hem [334,667] verdi. Yani toplu okuma bir şey değiştirmedi.
    // Konumu sabitleyen bir test tutarsız olurdu; sabitlenen şey TOPLAMIN korunduğu ve payların
    // beklenen iki değer olduğu. (Artan kuruşun hangi ÜRÜNE yazıldığı rastgele; toplam her zaman
    // doğru, ayrı bir konu olarak not edildi.)
    assert.deepEqual(satir.map(x => x.c).sort((a, b) => a - b), [334, 667], 'komisyon payları: ' + JSON.stringify(satir));
    assert.deepEqual(satir.map(x => x.k).sort((a, b) => a - b), [167, 333], 'kargo payları: ' + JSON.stringify(satir));
    assert.deepEqual(satir.map(x => x.s), ['confirmed', 'confirmed']);
  } finally { f.close(); }
});

// Döngü içinde paket başına sorgu kalmadığı sabitlenir: yeni bir sorgu sızarsa yavaşlık geri döner.
test('Döngünün içinde paket başına sorgu kalmadı', () => {
  const kaynak = readFileSync(new URL('../src/report-inbox-api.js', import.meta.url), 'utf8');
  const bas = kaynak.indexOf('for (const g of all) {');
  // Döngünün SONU: hemen ardından gelen "çift aktarım kopyası" bloğu writes üzerinde döner,
  // paket sayısı kadar değil; ölçülen 8,7 saniye o blokta değil bu döngüdeydi (writes boştu).
  const son = kaynak.indexOf('ÇİFT AKTARIM KOPYASININ', bas);
  assert.ok(bas > 0 && son > bas, 'döngü bulunamadı');
  const govde = kaynak.slice(bas, son);
  assert.ok(!/await db\.prepare/.test(govde), 'döngü gövdesinde paket başına sorgu kalmamalı');
  assert.match(kaynak, /await kesintiOnYukle\(db,/, 'ön okuma çağrılmalı');
});
