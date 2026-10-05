// AKŞAM ÖZETİ. Günde bir kez (Türkiye saatiyle akşam) "bugün neye bakman gerekiyor" mesajı.
// Liste YENİDEN HESAPLANMAZ: panelin İş listesi (attention-api.js) ne sayıyorsa o okunur, böylece
// ekranla mesaj asla çelişmez.
//
// TUTAR YAZILMAZ, YALNIZ SAYI. Telegram kanalını gören herkes mesajı okur; panelde bu liste
// yalnız yöneticiye açıktır (personelden tutar gizleme işi tam bu yüzden yapıldı). Kural burada
// TESTLE kanıtlanır: özet metninde hiçbir para biçimi geçmez.
//
// AĞA ÇIKILMAZ ve SAHİBİNİN TELEFONUNA MESAJ GİTMEZ: gönderim taklit edilir.
// TEMSİLİ veri; gerçek sipariş/fatura DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {appFixture} from './helpers/app-fixture.js';
import {aksamOzeti, aksamOzetiMetni, AKSAM_CRON, BAKIM_CRON} from '../src/aksam-ozeti.js';

// Türkiye kalıcı UTC+03: 17:00Z = TR 20:00. Testler akşam turunu bu damgayla çalıştırır.
const AKSAM = Date.parse('2026-10-05T17:00:00Z');
const ERTESI_AKSAM = Date.parse('2026-10-06T17:00:00Z');

// PARA BİÇİMİ SÜZGECİ: ₺ / TL / kuruş / "1.234,56" gibi ondalıklı tutarların hiçbiri geçmemeli.
// Tarih (2026-10-05) ve düz sayı (144) bilerek bu desene girmez.
const PARA = /₺|\bTL\b|\bkuruş\b|\blira\b|\d[.,]\d{2}\b/i;

const secretler = env => { env.TELEGRAM_BOT_TOKEN = 'test-token'; env.TELEGRAM_CHAT_ORDERS = '-1001'; };
function gonderimTaklidi(sonuc = () => true) {
  const mesajlar = [];
  return {mesajlar, gonder: async (env, metin) => { mesajlar.push(metin); return sonuc(mesajlar.length); }};
}
async function kur() {
  const f = appFixture(); await f.setup();
  secretler(f.env);
  return f;
}
const izSatiri = f => f.sqlite.prepare("SELECT * FROM ec_bildirim_izi WHERE anahtar='aksam-ozeti'").get();
const aktivite = f => f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Akşam özeti%' ORDER BY created_at DESC,rowid DESC").all().map(r => r.d);

// İş listesinin kendi alan adlarıyla temsili bir sonuç: metin kuralları bundan sınanır.
const liste = (over = {}) => ({
  as_of: '2026-10-05',
  orders: {total: 0, changed: 0, unmapped: 0, missing_amounts: 0, reserved: 0, long_shipping: 0, undelivered: 0, ...over.orders},
  stock: {total: 0, low: 0, no_history: 0, ...over.stock},
  invoices: {drafts: 0, awaiting_receipt: 0, ...over.invoices},
  sales: {total: 0, unconfirmed: 0, delivered_unconfirmed: 0, losses: 0, ...over.sales},
  tariffs: {shipping_active: 1, commission_active: 1, shipping_expiring: 0, commission_expiring: 0, ...over.tariffs},
  reports: {total: 1, last_applied: '2026-10-05 08:00:00', yarim: 0, bakim_sorunu: 0, ...over.reports}
});

test('Sıfır olan satır hiç yazılmaz; yalnız gerçekten iş olan satırlar geçer', () => {
  const metin = aksamOzetiMetni(liste({sales: {delivered_unconfirmed: 144}, stock: {low: 3}}), {simdi: AKSAM});
  assert.match(metin, /144/);
  assert.match(metin, /3 ürün/);
  // Sıfır olan başlıkların hiçbiri geçmemeli.
  for (const kelime of ['rapor dosyası', 'ilan eşleşmesi', 'yolda', 'taslak', 'tarife']) assert.doesNotMatch(metin, new RegExp(kelime), kelime + ' sıfırken yazılmamalı: ' + metin);
  assert.ok(metin.split('\n').filter(s => s.startsWith('•')).length === 2, 'iki satır olmalı: ' + metin);
});

test('Özet metninde TUTAR geçmez; yalnız sayı yazılır', () => {
  // Bütün sayaçlar dolu: en uzun metin üretilir ve para biçimi aranır.
  const dolu = liste({
    orders: {changed: 7, unmapped: 12, missing_amounts: 4, long_shipping: 9, undelivered: 2},
    stock: {low: 31}, invoices: {drafts: 5, awaiting_receipt: 6},
    sales: {unconfirmed: 236, delivered_unconfirmed: 144, losses: 18},
    tariffs: {shipping_active: 0, commission_active: 0, shipping_expiring: 1, commission_expiring: 2},
    reports: {yarim: 8, bakim_sorunu: 13, last_applied: '2026-09-20 08:00:00'}
  });
  const metin = aksamOzetiMetni(dolu, {simdi: AKSAM});
  assert.doesNotMatch(metin, PARA, 'özet metni tutar sızdırmamalı: ' + metin);
  // Sayılar binlik ayraçla yazılamaz: "1.234" para biçimine benzer ve kuralı belirsizleştirir.
  assert.doesNotMatch(metin, /\d[.,]\d/, 'sayılar ayraçsız yazılmalı: ' + metin);
  assert.ok(metin.length <= 3500, 'Telegram sınırını aşmamalı');
});

test('Hiç iş yoksa kısa bir "yolunda" mesajı gider: sessiz kanal bozuk kanaldan ayırt edilemez', () => {
  const metin = aksamOzetiMetni(liste(), {simdi: AKSAM});
  assert.doesNotMatch(metin, /•/, 'satır olmamalı: ' + metin);
  assert.match(metin, /bekleyen iş yok/i, metin);
  assert.ok(metin.split('\n').length <= 3, 'mesaj kısa olmalı: ' + metin);
  assert.doesNotMatch(metin, PARA);
});

test('Tarife tanımlı değilse SIFIR da iş sayılır; bitmek üzere olan tarife ayrıca yazılır', () => {
  const yok = aksamOzetiMetni(liste({tariffs: {shipping_active: 0, commission_active: 0}}), {simdi: AKSAM});
  assert.match(yok, /kargo tarifesi tanımlı değil/);
  assert.match(yok, /komisyon tarifesi tanımlı değil/);
  const biten = aksamOzetiMetni(liste({tariffs: {shipping_expiring: 2}}), {simdi: AKSAM});
  assert.match(biten, /2 kargo tarifesi/);
  assert.doesNotMatch(biten, /tanımlı değil/, 'tarife varken "yok" yazılmamalı: ' + biten);
});

test('Pazaryeri raporu günlerce işlenmediyse özet bunu söyler, taze veride susar', () => {
  const eski = aksamOzetiMetni(liste({reports: {last_applied: '2026-09-28 08:00:00'}}), {simdi: AKSAM});
  assert.match(eski, /7 gündür/, eski);
  const taze = aksamOzetiMetni(liste({reports: {last_applied: '2026-10-04 08:00:00'}}), {simdi: AKSAM});
  assert.doesNotMatch(taze, /gündür/, 'taze veride susmalı: ' + taze);
});

test('Akşam özeti panelin İş listesini okur ve kanala tek mesaj düşürür', async () => {
  const f = await kur(); const tg = gonderimTaklidi(); try {
    // Yarım kalmış bir rapor dosyası: İş listesinin reports.yarim sayacı bunu görür.
    f.sqlite.exec(`INSERT INTO ec_report_stores(id,provider,code,name) VALUES('st','trendyol','TY-1','Mağaza');
      INSERT INTO ec_report_files(id,store_id,kind,filename,size_bytes,sha256,snapshot_at,headers_json,row_count,chunk_count,status,created_at)
      VALUES('fl','st','orders','rapor.xlsx',100,'${'f'.repeat(64)}','2026-10-01T10:00','[]',1,1,'received',datetime('now','-3 hours'))`);
    const r = await aksamOzeti(f.env, {simdi: AKSAM, gonder: tg.gonder});
    assert.equal(r.sonuc, 'ok', JSON.stringify(r));
    assert.equal(tg.mesajlar.length, 1);
    assert.match(tg.mesajlar[0], /1 rapor dosyası/, tg.mesajlar[0]);
    assert.doesNotMatch(tg.mesajlar[0], PARA, 'canlı veriden gelen özet de tutar sızdırmamalı');
    assert.match(aktivite(f)[0], /Akşam özeti/, 'panelden görülebilmeli: ' + aktivite(f)[0]);

    // AYNI GÜN İKİNCİ TETİKLEME (Cloudflare cron'u yineleyebilir) mesajı ÇOĞALTMAZ.
    const ikinci = await aksamOzeti(f.env, {simdi: AKSAM + 60000, gonder: tg.gonder});
    assert.equal(tg.mesajlar.length, 1, 'günde bir mesaj: ' + JSON.stringify(tg.mesajlar));
    assert.equal(ikinci.sonuc, 'susturuldu');
    assert.equal(izSatiri(f).gun, '2026-10-05');

    // Ertesi akşam yeniden gider.
    await aksamOzeti(f.env, {simdi: ERTESI_AKSAM, gonder: tg.gonder});
    assert.equal(tg.mesajlar.length, 2);
    assert.equal(izSatiri(f).gun, '2026-10-06');
  } finally { f.close(); }
});

test('Akşam özeti gönderilemezse iz kaydına yazılır ve günü tüketmez', async () => {
  const f = await kur(); try {
    const kirik = gonderimTaklidi(() => false);
    const r = await aksamOzeti(f.env, {simdi: AKSAM, gonder: kirik.gonder});
    assert.equal(r.sonuc, 'basarisiz');
    assert.match(aktivite(f)[0], /gönderilemedi/, aktivite(f)[0]);
    assert.equal(izSatiri(f).gun, '', 'başarısız gönderim günü tüketmez');
    const tekrar = gonderimTaklidi();
    await aksamOzeti(f.env, {simdi: AKSAM + 60000, gonder: tekrar.gonder});
    assert.equal(tekrar.mesajlar.length, 1, 'aynı akşam yeniden denenir');
  } finally { f.close(); }
});

test('Bildirim kurulmamış ortamda akşam özeti ağa çıkmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const eski = globalThis.fetch;
    globalThis.fetch = async url => { throw Error('Beklenmeyen ağ isteği: ' + url); };
    try {
      const r = await aksamOzeti(f.env, {simdi: AKSAM});
      assert.equal(r.sonuc, 'kapali', JSON.stringify(r));
    } finally { globalThis.fetch = eski; }
  } finally { f.close(); }
});

test('Akşam özeti çökerse arıza kanalına düşer; hata yukarı fırlar', async () => {
  // Akşam özeti YENİ BİR SESSİZ ARIZA olmamalı: İş listesi sorgusu düşerse worker bunu yalnız
  // console'a yazardı. Burada İş listesinin okuduğu tablo düşürülür.
  const f = await kur(); const ariza = gonderimTaklidi(); try {
    // İş listesi sorgularını batch'e vermeden ÖNCE hazırlıyor, yani kapı prepare'dedir.
    const kirilgan = {prepare: sql => { if (/order_packages/.test(sql)) throw Error('D1 ulaşılamıyor'); return f.env.DB.prepare(sql); },
      batch: items => f.env.DB.batch(items)};
    const env = {...f.env, DB: kirilgan};
    await assert.rejects(() => aksamOzeti(env, {simdi: AKSAM, gonder: gonderimTaklidi().gonder, arizaGonder: ariza.gonder}), /D1 ulaşılamıyor/);
    assert.equal(ariza.mesajlar.length, 1, 'çöken özet sessiz kalmamalı: ' + JSON.stringify(ariza.mesajlar));
    assert.match(ariza.mesajlar[0], /akşam özeti çöktü/);
  } finally { f.close(); }
});

test('Akşam özeti 30 gündür görülmeyen susturma izlerini temizler', async () => {
  const f = await kur(); const tg = gonderimTaklidi(); try {
    f.sqlite.exec(`INSERT INTO ec_bildirim_izi(anahtar,ozet,gun,gorulme,son_gorulme_at) VALUES('eski','geçmiş arıza','2026-08-01',1,datetime('now','-40 days'));
      INSERT INTO ec_bildirim_izi(anahtar,ozet,gun,gorulme,son_gorulme_at) VALUES('yeni','dünkü arıza','2026-10-04',1,datetime('now','-2 days'))`);
    await aksamOzeti(f.env, {simdi: AKSAM, gonder: tg.gonder});
    const kalan = f.sqlite.prepare('SELECT anahtar FROM ec_bildirim_izi ORDER BY anahtar').all().map(r => r.anahtar);
    assert.deepEqual(kalan, ['aksam-ozeti', 'yeni'], 'yalnız 30 günden eski iz silinir: ' + JSON.stringify(kalan));
  } finally { f.close(); }
});

/* ---------------- ZAMANLAMA: hangi cron neyi tetikler ---------------- */

test('wrangler zamanlamaları kodun beklediğiyle birebir aynı; akşam cron UTC 17:00 = TR 20:00', () => {
  // Zamanlama iki yerde yazılı: wrangler.jsonc tetikler Cloudflare'ı, sabitler worker'da ayrımı
  // yapar. İkisi ayrışırsa akşam özeti ya hiç gitmez ya 15 dakikada bir gider; o yüzden aynı
  // testte karşılaştırılır.
  // DOSYA ADI .jsonc AMA İÇERİĞİ KATI JSON OLMAK ZORUNDA: scripts/recovery.mjs onu düz
  // JSON.parse ile okuyor (felaket kurtarma yolu). Yorum eklenirse kurtarma betiği çöker, o
  // yüzden burada da yorum SÜZÜLMEDEN ayrıştırılır ve kural böylece bağlanır.
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(cfg.triggers.crons, [BAKIM_CRON, AKSAM_CRON], 'wrangler cron listesi: ' + JSON.stringify(cfg.triggers.crons));
  assert.equal(BAKIM_CRON, '*/15 * * * *');
  const [dakika, saat] = AKSAM_CRON.split(' ');
  assert.equal(dakika, '0');
  assert.equal(Number(saat) + 3, 20, 'Türkiye saati 20:00 olmalı (UTC+03), cron UTC koşar');
});

test('Scheduled olayı event.cron ile ayrılır: akşam deseni özet, diğer her şey bakım çalıştırır', async () => {
  const cagrilar = [];
  // Hiçbir gerçek iş yapılmaz: hangi yolun seçildiği ölçülür. DB'ye dokunulursa test düşer.
  const env = {DB: {prepare: () => { throw Error('Zamanlama testi veritabanına dokunmamalı'); }}, __test: cagrilar};
  const ctx = {waitUntil: p => cagrilar.push(p)};

  // Akşam deseni: yalnız özet. Bakım AYNI dakikada kendi olayıyla gelir, bu yüzden burada koşmaz.
  await worker.scheduled({cron: AKSAM_CRON}, env, ctx);
  assert.equal(cagrilar.length, 1);
  await cagrilar[0].catch(() => {});

  // 15 dakikalık desen ve bilinmeyen/boş cron: bakım. (Yerel tetiklemede event.cron boş gelir;
  // eski davranış korunur.)
  for (const olay of [{cron: BAKIM_CRON}, {cron: 'beklenmeyen'}, {}, undefined]) {
    const once = cagrilar.length;
    await worker.scheduled(olay, env, ctx);
    assert.equal(cagrilar.length, once + 1, 'her olay tek iş başlatmalı: ' + JSON.stringify(olay));
    await cagrilar.at(-1).catch(() => {});
  }
  assert.equal(cagrilar.length, 5);
});

test('Akşam cron tetiklendiğinde gerçekten özet gider, bakım turu koşmaz', async () => {
  // Uçtan uca: worker.scheduled → aksamOzeti → telegramBildir. Üretim koduna test kancası
  // KOYULMAZ; yalnız globalThis.fetch taklit edilir ve api.telegram.org dışına çıkılırsa test düşer.
  const f = await kur(); const mesajlar = [], eski = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw Error('Beklenmeyen ağ isteği: ' + url);
    mesajlar.push(JSON.parse(options?.body || '{}'));
    return Response.json({ok: true, result: {message_id: mesajlar.length}});
  };
  try {
    const bekleyenler = [];
    await worker.scheduled({cron: AKSAM_CRON}, f.env, {waitUntil: p => bekleyenler.push(p)});
    await Promise.all(bekleyenler);
    assert.equal(mesajlar.length, 1, 'akşam özeti gitmeli: ' + JSON.stringify(mesajlar));
    assert.equal(mesajlar[0].chat_id, '-1001', 'akşam özeti ÖZET kanalına düşer, arıza kanalına değil');
    assert.match(mesajlar[0].text, /Akşam özeti/);
    assert.equal(aktivite(f).length, 1);
    // Bakım turu kendi cron'uyla koşar; akşam olayı onun izini YAZMAZ.
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_activity WHERE description LIKE 'Otomatik bakım%'").get().n, 0);
  } finally { globalThis.fetch = eski; f.close(); }
});
