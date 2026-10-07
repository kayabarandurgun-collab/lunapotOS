// PAZARYERİNDE İPTAL EDİLMİŞ AÇIK SİPARİŞ PANELDE "HAZIRLIK BEKLİYOR"DA KALIYORDU. Canlı ölçüm
// 07.10.2026: 9 taslak paket, hepsi Trendyol'da iptal (8 'Cancelled', 1 'UnDeliveredAndReturned'),
// en eskisi 15.08. Sebep tahmin edilmedi, ÖLÇÜLDÜ: iptali işleyen tek yol rapor kayıtlarından
// geçiyor (report-stock-link-api.js /auto) ve bu dokuz paketin HİÇ rapor kaydı yok — onları API
// senkronu açmıştı, senkron 26.09'da kapatıldı ve bir daha kimse bakmadı. İptal bilgisi paketin
// kendi external_status alanında duruyordu.
//
// Kanıtlanan: (a) rapor kaydı OLMAYAN iptal taslağı da kapanır, (b) ayrılmış paket de kapanır ve
// stok serbest kalır, (c) GÖNDERİLMİŞ/TESLİM EDİLMİŞ pakete ASLA dokunulmaz, (d) açık ama iptal
// olmayan sipariş (canlıdaki beş rezerve: 'Toplanmaya Başlandı') dokunulmaz, (e) iş ikinci turda
// tekrarlanmaz, (f) bakım turu bu işi yapar ve iz kaydına yazar.
// TEMSİLİ veri; gerçek sipariş DEĞİLDİR. Ağa çıkılmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';
import {pazaryeriIptalleriniKapat, PAZARYERI_IPTAL} from '../src/orders-api.js';
import {otomatikBakim, SENKRON_KAYNAKLARI_KAPALI} from '../src/otomatik-bakim.js';

const GUN = '2026-09-01';

// Paketler doğrudan tabloya yazılır: canlıdaki dokuzunu açan API senkronu KAPATILDI, yani onların
// doğduğu yol koddan artık çağrılamıyor. Ölçülen durum birebir kurulur.
function kur() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const DB = {prepare(sql) { return {args: [], bind(...a) { this.args = a; return this; },
    first() { return sqlite.prepare(sql).get(...this.args) || null; },
    all() { return {results: sqlite.prepare(sql).all(...this.args)}; },
    run() { return sqlite.prepare(sql).run(...this.args); }}; },
    async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => s.all()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }};
  // orders-api scoped isimlerle yazıyor; fixture'daki gibi 'ec_' öneki eklenir.
  const scoped = {...DB, prepare(sql) {
    for (const t of ['order_packages', 'order_lines', 'order_line_components', 'order_reservations'])
      sql = sql.replace(new RegExp('\\b' + t + '\\b', 'g'), 'ec_' + t);
    return DB.prepare(sql);
  }};
  const paket = (id, status, external_status, occurred_on = GUN) =>
    sqlite.prepare('INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,external_status,source_fingerprint) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, 'trendyol', 'PKG-' + id, 'ORD-' + id, occurred_on, status, external_status, 'parmak-' + id);
  const durum = id => sqlite.prepare('SELECT status,cancel_reason FROM ec_order_packages WHERE id=?').get(id);
  return {sqlite, env: {DB: scoped, WORKSPACE: 'ec'}, paket, durum, close: () => sqlite.close()};
}

test('Rapor kaydı olmayan iptal taslağı da kapanır; sebep pazaryeri durumunu taşır', async () => {
  const f = kur(); try {
    f.paket('p1', 'draft', 'Cancelled');
    const r = await pazaryeriIptalleriniKapat(f.env);
    assert.equal(r.cancelled, 1, JSON.stringify(r));
    assert.equal(f.durum('p1').status, 'cancelled');
    assert.match(f.durum('p1').cancel_reason, /Pazaryeri durumu: Cancelled/,
      'neden kayda geçmeli: kullanıcı neden kapandığını görsün');
  } finally { f.close(); }
});

// Canlıdaki dokuzuncu paket bu: mal gitti, dönmüş. Panelde TASLAK, yani satış hiç yazılmadı ve
// stok hiç hareket etmedi — kapatılacak olan boş bir taslaktır, ters kayıt gereken bir satış değil.
test("'UnDeliveredAndReturned' de iptal sayılır", async () => {
  const f = kur(); try {
    f.paket('p2', 'draft', 'UnDeliveredAndReturned');
    assert.equal((await pazaryeriIptalleriniKapat(f.env)).cancelled, 1);
    assert.equal(f.durum('p2').status, 'cancelled');
  } finally { f.close(); }
});

test('Ayrılmış paket de kapanır (ayrılan stok serbest kalır)', async () => {
  const f = kur(); try {
    f.paket('p3', 'reserved', 'Cancelled');
    assert.equal((await pazaryeriIptalleriniKapat(f.env)).cancelled, 1);
    assert.equal(f.durum('p3').status, 'cancelled');
  } finally { f.close(); }
});

// EN ÖNEMLİ KORUMA. Canlıda 33 GÖNDERİLMİŞ pakette external_status hâlâ 'Toplanmaya Başlandı'
// yazıyor: bu alan ilerleyen pakette BAYAT kalıyor. Bayat bir 'Cancelled' gönderilmiş pakete
// düşerse satış ters kaydedilmeden iptal edilir ve defter bozulur. O yüzden kapı statüde.
test('Gönderilmiş ve teslim edilmiş pakete ASLA dokunulmaz', async () => {
  const f = kur(); try {
    f.paket('p4', 'shipped', 'Cancelled');
    f.paket('p5', 'delivered', 'Cancelled');
    const r = await pazaryeriIptalleriniKapat(f.env);
    assert.equal(r.cancelled, 0, JSON.stringify(r));
    assert.equal(r.checked, 0, 'gönderilmiş paket adaylara bile girmemeli');
    assert.equal(f.durum('p4').status, 'shipped');
    assert.equal(f.durum('p5').status, 'delivered');
  } finally { f.close(); }
});

test('İptal olmayan açık sipariş dokunulmaz', async () => {
  const f = kur(); try {
    // Canlıdaki beş rezerve paketin gerçek durumları.
    f.paket('p6', 'reserved', 'Toplanmaya Başlandı');
    f.paket('p7', 'reserved', 'Gönderime Hazır');
    f.paket('p8', 'draft', 'Yeni Sipariş');
    f.paket('p9', 'draft', '');   // şema external_status'u NOT NULL tutuyor; boşluk bu alanın "bilinmiyor"u
    const r = await pazaryeriIptalleriniKapat(f.env);
    assert.equal(r.cancelled, 0, JSON.stringify(r));
    for (const id of ['p6', 'p7', 'p8', 'p9'])
      assert.notEqual(f.durum(id).status, 'cancelled', id + ' kapatılmamalı');
  } finally { f.close(); }
});

test('İş ikinci turda tekrarlanmaz', async () => {
  const f = kur(); try {
    f.paket('p11', 'draft', 'Cancelled');
    assert.equal((await pazaryeriIptalleriniKapat(f.env)).cancelled, 1);
    const ikinci = await pazaryeriIptalleriniKapat(f.env);
    assert.equal(ikinci.cancelled, 0);
    assert.equal(ikinci.checked, 0, 'kapanmış paket aday listesine dönmemeli');
  } finally { f.close(); }
});

// LIMIT SÜZÜLMÜŞ SATIRLARA UYGULANIR. Süzgeç SQL'de daralmazsa, listenin başındaki açık
// siparişler LIMIT'i doldurup iptalleri sonsuza kadar gölgeler.
test('Açık siparişler kalabalık olsa da iptaller sıraya girer', async () => {
  const f = kur(); try {
    for (let i = 0; i < 30; i++) f.paket('acik' + i, 'draft', 'Toplanmaya Başlandı', '2026-08-01');
    f.paket('iptal', 'draft', 'Cancelled', '2026-09-30');
    const r = await pazaryeriIptalleriniKapat(f.env, {limit: 2});
    assert.equal(r.cancelled, 1, 'iptal paket limitin dışında kalmamalı: ' + JSON.stringify(r));
    assert.equal(f.durum('iptal').status, 'cancelled');
  } finally { f.close(); }
});

// Canlıda external_status alanında GEÇEN bütün metinler ölçüldü (07.10.2026); desen tam olarak
// iptal olanları seçmeli, ilerleyen bir paketi SEÇMEMELİ.
test('Desen canlıdaki durum metinlerini doğru ayırır', () => {
  for (const s of ['cancelled', 'undeliveredandreturned', 'iptal edildi', 'iade', 'refund'])
    assert.ok(PAZARYERI_IPTAL.test(s), s + ' iptal sayılmalı');
  for (const s of ['toplanmaya başlandı', 'gönderime hazır', 'kargolandı', 'kargoda', 'teslim edildi',
    'oluşturuldu', 'yeni sipariş', 'shipped', 'readytoship', 'picking', 'delivered'])
    assert.ok(!PAZARYERI_IPTAL.test(s), s + ' iptal SAYILMAMALI');
});

// İki yol aynı sözcüklere bakmalı: rapor kayıtlarından okuyan yol ile paketin kendi alanından
// okuyan yol ayrışırsa, bir paket bir yolda iptal sayılıp diğerinde sayılmaz.
test('Rapor yolu deseni kendi kopyasını TUTMAZ, ortak listeden alır', () => {
  const kaynak = readFileSync(new URL('../src/report-stock-link-api.js', import.meta.url), 'utf8');
  assert.match(kaynak, /import \{ordersApi, PAZARYERI_IPTAL\} from '\.\/orders-api\.js'/,
    'ortak desen içe alınmalı');
  assert.match(kaynak, /const CANCELLED = PAZARYERI_IPTAL;/, 'yerel desen ortak olana bağlanmalı');
  assert.ok(!/const CANCELLED = \/.*\/[a-z]*;/.test(kaynak), 'kopya desen literali kalmamalı');
});

// Bakım turu bu işi kullanıcı beklemeden yapar ve yaptığını iz kaydına yazar.
test('Bakım turu pazaryeri iptallerini kapatır ve iz kaydına yazar', async () => {
  const f = appFixture(); await f.setup(); try {
    f.sqlite.prepare('INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,external_status,source_fingerprint) VALUES(?,?,?,?,?,?,?,?)')
      .run('eski', 'trendyol', '4079004932', '11508732291', '2026-08-15', 'draft', 'Cancelled', 'parmak-eski');
    const r = await otomatikBakim(f.env, {simdi: Date.now(), kaynaklar: SENKRON_KAYNAKLARI_KAPALI});
    assert.deepEqual(r.hatalar, []);
    assert.equal(r.pazaryeriIptal, 1, JSON.stringify(r));
    assert.equal(f.sqlite.prepare('SELECT status FROM ec_order_packages WHERE id=?').get('eski').status, 'cancelled');
    const iz = f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım:%' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    assert.match(iz.d, /1 sipariş pazaryeri iptaliyle kapatıldı/, 'iz kaydı işi yazmalı: ' + iz.d);
    assert.ok('pazaryeri iptali' in r.adim, 'adım ölçülmeli: ' + JSON.stringify(r.adim));
  } finally { f.close(); }
});
