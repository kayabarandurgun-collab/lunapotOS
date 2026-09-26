// OTOMATİK PAZARYERİ SENKRONU (zamanlanmış bakım). Cron 15 dakikada bir tetikleniyor ama pazaryerine
// her turda gitmek YANLIŞ olur: sağlayıcı istek sınırı ve ücretsiz D1 yazma bütçesi boşa gider.
// Kanıtlanan: (a) aralık dolmadan sağlayıcıya hiç gidilmez, (b) süre bütçesi biterse pencere yarıda
// bırakılır ve bir sonraki tur kaldığı sayfadan sürer, (c) sağlayıcı hatası bakımın geri kalanını
// çökertmez ve hatalı bağlantı bir daha kendiliğinden denenmez, (d) kayda değer iş olunca Telegram
// kanalına tek özet düşer, hiçbir şey değişmediyse susar.
// AĞA ÇIKILMAZ: sağlayıcı isteği de Telegram da taklit edilir. TEMSİLİ veri; gerçek sipariş DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {otomatikBakim, SENKRON_ISTEK, butceler, SENKRON_KAYNAKLARI_KAPALI} from '../src/otomatik-bakim.js';

// OTOMATİK SENKRON CANLIDA KAPALI (kullanıcı elle rapor yüklemeyi seçti), ama kuralları hâlâ
// sınanıyor: geri açıldığında aralık, pencere, bütçe ve hata davranışı aynen geçerli olmalı.
// Testler kural setini açıkça veriyor; üretimdeki liste boş olduğu için bakım hiçbir uca çıkmaz.
const KAYNAKLAR = SENKRON_KAYNAKLARI_KAPALI;

const KIMLIK = {seller_id: '1234', key: 'ornek-anahtar', secret: 'ornek-parola', user_agent: '1234 - SelfIntegration'};
// Bağlantı ve imleç damgalarını veritabanı CURRENT_TIMESTAMP ile kendisi atar; aralık ölçümünün
// anlamlı olması için turların "şimdi"si gerçek saatten türetilir, beklenen pencere de öyle.
const AN = Date.now();
const SAAT = 3600000, GUN = 86400000;
const satir = (n = 22) => [{lineId: n, quantity: 1, lineUnitPrice: 100, vatRate: 20, lineTyDiscount: 0, stockCode: 'TR-1', productName: 'Torf', currencyCode: 'TRY', commission: 10}];
const siparis = (over = {}) => ({shipmentPackageId: 11, orderNumber: 'ORD-1', orderDate: AN, lastModifiedDate: AN, currencyCode: 'TRY', status: 'Created', lines: satir(), ...over});

async function kur() {
  const f = appFixture(); await f.setup();
  f.env.CREDENTIAL_KEY = 'ab'.repeat(32);
  await f.ok('/ec/connections/trendyol/configure', KIMLIK);
  return f;
}

// Trendyol tarih alanları epoch milisaniye taşır; Türkiye gününe çevrilip okunur.
const gunTR = ms => new Date(Number(ms) + 3 * SAAT).toISOString().slice(0, 10);
// Sağlayıcı taklidi: istenen adresler toplanır, ağa çıkılmaz. Finans uçları boş döner (tek sayfa).
function saglayici(siparisCevabi = () => ({content: [siparis()], totalPages: 1, totalElements: 1})) {
  const cagrilar = [];
  const getir = async url => {
    const kind = url.pathname.includes('/v2/orders') ? 'orders' : url.searchParams.get('transactionType') || 'finance';
    const sayfa = Number(url.searchParams.get('page'));
    cagrilar.push({kind, page: sayfa, from: gunTR(url.searchParams.get('startDate')), to: gunTR(url.searchParams.get('endDate'))});
    if (kind !== 'orders') return Response.json({content: [], totalPages: 0});
    return Response.json(siparisCevabi(sayfa, cagrilar.length));
  };
  return {cagrilar, getir, siparisler: () => cagrilar.filter(c => c.kind === 'orders')};
}

// Telegram taklidi: yalnız api.telegram.org isteklerini toplar, başka adrese çıkılmaz.
function telegramTaklidi(env) {
  const mesajlar = [], eski = globalThis.fetch;
  env.TELEGRAM_BOT_TOKEN = 'test-token'; env.TELEGRAM_CHAT_ORDERS = '-1001';
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw Error('Beklenmeyen ağ isteği: ' + url);
    mesajlar.push(JSON.parse(options?.body || '{}'));
    return Response.json({ok: true, result: {message_id: mesajlar.length}});
  };
  return {mesajlar, geri: () => { globalThis.fetch = eski; }};
}

test('Senkron aralığı dolmadan pazaryerine gidilmez; aralık dolunca pencere yeniden kurulur', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    const ilk = await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.deepEqual(ilk.hatalar, []);
    assert.equal(ilk.senkronTaslak, 1, 'ilk turda sipariş taslağı açılmalı: ' + JSON.stringify(ilk));
    const ilkSiparis = ty.siparisler()[0];
    assert.equal(ilkSiparis.page, 0);
    assert.equal(ilkSiparis.to, gunTR(AN), 'pencere bugüne kadar kurulur');
    assert.equal(ilkSiparis.from, gunTR(AN - 3 * GUN), 'hiç senkron yapılmamışsa 3 günlük pencere');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 1);

    // 15 dakika ve 3 saat sonra: aralık dolmadığı için tek istek bile çıkmaz.
    const oncekiCagri = ty.cagrilar.length;
    for (const ms of [15 * 60000, 3 * SAAT]) {
      const r = await otomatikBakim(f.env, {simdi: AN + ms, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
      assert.deepEqual(r.hatalar, []);
      assert.equal(ty.cagrilar.length, oncekiCagri, ms / SAAT + ' saat sonra sağlayıcıya gidilmemeli');
    }

    // 5 saat sonra: sipariş aralığı doldu, pencere son başarılı senkrondan kuruldu (en az 2 gün).
    await otomatikBakim(f.env, {simdi: AN + 5 * SAAT, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    const sonraki = ty.siparisler().at(-1);
    assert.equal(sonraki.from, gunTR(AN + 5 * SAAT - 2 * GUN), 'son senkron bugünse pencere 2 güne iner');
    assert.equal(sonraki.to, gunTR(AN + 5 * SAAT));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n, 1, 'aynı paket ikinci kez açılmadı');
  } finally { f.close(); }
});

test('Süre bütçesi senkronu sınırlar; yarıda kalan pencere bir sonraki turda kaldığı sayfadan sürer', async () => {
  const f = await kur(); try {
    // Her sayfa "devamı var" diyor: tur başına istek sınırı olmasa bütün bütçeyi yerdi.
    const ty = saglayici(sayfa => ({content: [siparis({shipmentPackageId: 100 + sayfa, orderNumber: 'ORD-' + sayfa, lines: satir(200 + sayfa)})],
      totalPages: 50, totalElements: 2500}));
    const dolu = await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.deepEqual(dolu.hatalar, []);
    assert.equal(ty.siparisler().length, SENKRON_ISTEK, 'tur başına istek sınırı aşılmamalı');
    assert.deepEqual(ty.siparisler().map(c => c.page), [...Array(SENKRON_ISTEK).keys()], 'sayfalar sırayla çekilmeli');

    // Bütçe bitmişken yeni sayfa istenmez: sağlayıcıya hiç gidilmez, bakım yine sonuç döndürür.
    const oncekiCagri = ty.cagrilar.length;
    const bosBakim = await otomatikBakim(f.env, {simdi: AN + 5 * SAAT, sureMs: 1, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.equal(ty.cagrilar.length, oncekiCagri, 'süre bütçesi bitmişken sağlayıcıya gidilmemeli');
    assert.deepEqual(bosBakim.hatalar, []);

    // Yarıda kalan pencere kaybolmaz: sonraki tur AYNI pencerede kaldığı sayfadan devam eder.
    await otomatikBakim(f.env, {simdi: AN + 5 * SAAT, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    const devam = ty.siparisler().at(SENKRON_ISTEK);
    assert.equal(devam.page, SENKRON_ISTEK, 'sonraki tur kaldığı sayfadan sürmeli');
    assert.equal(devam.from, ty.siparisler()[0].from, 'yarım kalan pencere daraltılmadan bitirilmeli');
    assert.equal(devam.to, ty.siparisler()[0].to);
  } finally { f.close(); }
});

test('Sağlayıcı hatası bakımı çökertmez; hatalı bağlantı kendiliğinden yeniden denenmez', async () => {
  const f = await kur(); try {
    const cagrilar = [];
    const bozuk = async url => { cagrilar.push(String(url)); return new Response('bozuk', {status: 500}); };
    const r = await otomatikBakim(f.env, {simdi: AN, senkronGetir: bozuk, kaynaklar: KAYNAKLAR});
    assert.equal(cagrilar.length, 1, 'hata alan sağlayıcıda sıradaki kaynaklar zorlanmamalı');
    assert.match(r.hatalar.join(' '), /senkron trendyol/);
    assert.equal(r.senkronTaslak, 0);
    assert.ok(f.sqlite.prepare('SELECT last_error FROM ec_provider_connections').get().last_error, 'hata bağlantıya yazılır');
    // Bakımın geri kalanı çalıştı: tur sonundaki iz kaydı yazıldı.
    assert.match(f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım%' ORDER BY created_at DESC").get().d, /sorun/);

    const ikinci = await otomatikBakim(f.env, {simdi: AN + 5 * SAAT, senkronGetir: bozuk, kaynaklar: KAYNAKLAR});
    assert.equal(cagrilar.length, 1, 'çözülmemiş hatası olan bağlantı otomatik denenmez');
    assert.deepEqual(ikinci.senkronAtlandi, ['trendyol']);
    assert.deepEqual(ikinci.hatalar, []);
  } finally { f.close(); }
});

test('Telegram yalnız kayda değer iş olunca konuşur; değişen bir şey yoksa susar', async () => {
  const f = await kur(); const tg = telegramTaklidi(f.env); try {
    const ty = saglayici();
    await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.equal(tg.mesajlar.length, 1, 'yeni taslak açılınca tek özet düşer');
    assert.match(tg.mesajlar[0].text, /1 yeni sipariş taslağı/);
    assert.equal(tg.mesajlar[0].chat_id, '-1001');

    // İkinci tur aynı siparişi görür: taslak da teslim de yok, kanal susmalı.
    const ikinci = await otomatikBakim(f.env, {simdi: AN + 5 * SAAT, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.equal(ikinci.senkronTaslak, 0);
    assert.equal(tg.mesajlar.length, 1, 'değişen bir şey yokken bildirim gönderilmez');
  } finally { tg.geri(); f.close(); }
});

// SESSİZ AÇLIK. Rapor işleri süre bütçesini yiyip senkrona hiç sıra gelmediğinde dışarıdan
// "yapılacak iş yoktu" görünüyordu: ne hata, ne kayıt, ne de sebep. Canlıda Trendyol 22 saat
// çekilmediği hâlde iz kaydı "iş yoktu" diyordu ve sebep hiçbir yere yazılmıyordu.
test('Senkrona sıra gelmediğinde sebep iz kaydına yazılır; sessizce "iş yoktu" denmez', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    const r = await otomatikBakim(f.env, {simdi: AN, sureMs: 1, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.equal(ty.cagrilar.length, 0, 'bütçe yokken sağlayıcıya gidilmemeli');
    assert.deepEqual(r.hatalar, []);
    assert.ok(r.senkronSebep.some(s => /süre bütçesi bitti/.test(s)), 'sebep özete yazılmalı: ' + JSON.stringify(r.senkronSebep));
    const iz = f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım%' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    assert.match(iz.d, /Senkron:/, 'iz kaydı sebebi taşımalı: ' + iz.d);
    assert.match(iz.d, /süre bütçesi bitti/);
    assert.match(iz.d, /sn\]/, 'aşama süreleri yazılmalı');
  } finally { f.close(); }
});

test('Aralık dolmadan atlandığında da sebep yazılır; süre bitti ile karıştırılmaz', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    const r = await otomatikBakim(f.env, {simdi: AN + 60000, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.ok(r.senkronSebep.some(s => /aralık dolmadı/.test(s)), JSON.stringify(r.senkronSebep));
    assert.ok(!r.senkronSebep.some(s => /süre bütçesi/.test(s)), 'süre bitmediği hâlde süre denmemeli');
  } finally { f.close(); }
});

// BÜTÇE PAYLAŞIMI VE SIRA. Canlıda rapor turu 59,6 saniye sürüyordu: 50 saniyelik bütçe orada
// bitiyor, en sonda duran pazaryeri senkronuna hiç sıra gelmiyordu (Trendyol 22,5 saat çekilmedi).
// Senkron artık rapor işlerinden ÖNCE çalışır ve kendi payını aşamaz; ters yönde açlık doğmaz.
test('Senkron kendi payını aşamaz; rapor işlerine bütçe kalır', () => {
  let t = 0; const saat = () => t;
  const b = butceler(50000, saat);
  t = 24999; assert.equal(b.senkronVakti(), true, 'payı dolmadan sayfa istenebilir');
  t = 25001;
  assert.equal(b.senkronVakti(), false, 'senkron payını aşmamalı');
  assert.equal(b.raporVakti(), true, 'rapor işlerine bütçe kalmalı');
  assert.equal(b.vakitVar(), true);
  t = 50001; assert.equal(b.raporVakti(), false, 'tur bütçesi bitince rapor da durur');
});

test('Sağlayıcı payı korunur; bütçenin son saniyelerinde yeni sayfa istenmez', () => {
  let t = 0; const saat = () => t;
  const b = butceler(20000, saat);
  t = 9999; assert.equal(b.senkronVakti(), true);
  // Bütçenin yarısı 10 sn ama sağlayıcı payı 10 sn: hangisi önce dolarsa senkron durur.
  t = 10001; assert.equal(b.senkronVakti(), false, 'iki sınırdan sıkı olanı geçerli');
  assert.equal(b.vakitVar(), true);
});

test('Senkron rapor işlerinden ÖNCE çalışır: aşama damgası sırayı gösterir', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    const r = await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.deepEqual(r.hatalar, []);
    assert.ok(r.sure.senkron <= r.sure.rapor, 'senkron rapordan önce bitmeli: ' + JSON.stringify(r.sure));
    assert.ok(ty.siparisler().length > 0, 'sağlayıcıya çıkılmalı');
  } finally { f.close(); }
});

// Aşama süreleri iş yapılan turda da yazılır: bütçeyi hangi adımın yediği yalnız boş turlarda
// görülebiliyordu, oysa asıl merak edilen dolu tur (canlıda rapor turu 59,6 saniye sürüyordu).
test('Dolu turun iz kaydı da aşama sürelerini taşır', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    const r = await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir, kaynaklar: KAYNAKLAR});
    assert.ok(r.senkronKayit > 0, 'tur iş yapmalı');
    const iz = f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım:%' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    assert.match(iz.d, /\[.*sn\]$/, 'süreler iz kaydının sonunda olmalı: ' + iz.d);
    assert.match(iz.d, /senkron /);
    assert.match(iz.d, /rapor /);
  } finally { f.close(); }
});

// ÜRETİMDE KAPALI OLDUĞU SINANIR. Kullanıcı pazaryeri verisini elle rapor yükleyerek sürdürmeyi
// seçti; bakım turu varsayılan ayarla hiçbir sağlayıcıya ÇIKMAMALI. Kimlikler silinse de kod
// yanlışlıkla açık kalırsa bu test uyarır.
test('Varsayılan ayarda bakım hiçbir pazaryerine çıkmaz', async () => {
  const f = await kur(); try {
    const ty = saglayici();
    const r = await otomatikBakim(f.env, {simdi: AN, senkronGetir: ty.getir});
    assert.equal(ty.cagrilar.length, 0, 'sağlayıcıya istek gitmemeli');
    assert.equal(r.senkronKayit, 0);
    assert.deepEqual(r.hatalar, []);
  } finally { f.close(); }
});
