// BOZULUNCA HABER VER. Bakım turu 15 dakikada bir çalışıyor ama hata verdiğinde hiçbir yere haber
// gitmiyordu: tek bildirim koşulu (ozet.senkronTaslak || ozet.senkronTeslim) KALICI OLARAK ölüydü,
// çünkü pazaryeri API'leri 26.09.2026'da bilerek kapatıldı ve SENKRON_KAYNAKLARI boş bırakıldı —
// senkron döngüsü hiç çalışmadığı için o iki sayaç hep 0 kalıyor. Sessiz arıza en pahalısıdır.
//
// Kanıtlanan: (a) hata arıza kanalına düşer, (b) AYNI hata imzası günde bir kezden fazla gitmez,
// (c) yeni bir imza susturulmaz, (d) gönderim başarısızsa susturulmaz, ize yazılır ve sonraki tur
// yeniden dener, (e) tur tamamen çökse de haber gider, (f) bildirim yapılandırılmamışsa denenmez.
//
// AĞA ÇIKILMAZ ve SAHİBİNİN TELEFONUNA MESAJ GİTMEZ: gönderim her testte taklit edilir.
// TEMSİLİ veri; gerçek pazaryeri verisi DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {otomatikBakim, hataImzasi, arizaBildir, SENKRON_KAYNAKLARI_KAPALI} from '../src/otomatik-bakim.js';
import {telegramAriza} from '../src/telegram.js';

const KIMLIK = {seller_id: '1234', key: 'ornek-anahtar', secret: 'ornek-parola', user_agent: '1234 - SelfIntegration'};
// Türkiye günü sınırı sınanabilsin diye saatler UTC olarak sabitlendi (Türkiye kalıcı UTC+03):
// 09:00Z = TR 12:00 (aynı gün), 18:00Z = TR 21:00 (aynı gün), 21:30Z = TR 00:30 (ERTESİ gün).
const OGLE = Date.parse('2026-10-05T09:00:00Z');
const AKSAM = Date.parse('2026-10-05T18:00:00Z');
const ERTESI = Date.parse('2026-10-05T21:30:00Z');

// Gönderim taklidi: metinleri toplar, ağa çıkmaz. `sonuc` false dönerse Telegram'ın reddi taklit
// edilir (token yok, kanal silinmiş, ağ düştü — hepsi telegramGonder'den false olarak döner).
function gonderimTaklidi(sonuc = () => true) {
  const mesajlar = [];
  return {mesajlar, gonder: async (env, metin) => { mesajlar.push(metin); return sonuc(mesajlar.length); }};
}

// Canlıda bildirim secret'ları kurulu; testte uydurma değerler verilir ve ağa HİÇ çıkılmaz
// (gönderim taklit edilir). Secret'sız ortamın davranışı ayrı testte sınanır.
const secretler = env => { env.TELEGRAM_BOT_TOKEN = 'test-token'; env.TELEGRAM_CHAT_ORDERS = '-1001'; env.TELEGRAM_CHAT_ERRORS = '-1002'; };

async function kur() {
  const f = appFixture(); await f.setup();
  f.env.CREDENTIAL_KEY = 'ab'.repeat(32);
  secretler(f.env);
  await f.ok('/ec/connections/trendyol/configure', KIMLIK);
  return f;
}
// Sağlayıcı her istekte düşer: bakım turu 'senkron trendyol: ...' hatasıyla biter.
const bozukSaglayici = async () => new Response('bozuk', {status: 500});
// Hatalı bağlantı bilerek bir daha denenmiyor (otomatik-bakim.js:107). Aynı arızanın tekrarını
// sınamak için hata izi silinir: canlıda kullanıcı "Verileri al" dediğinde de aynısı olur.
const hataIziniSil = f => f.sqlite.exec('UPDATE ec_provider_connections SET last_error=NULL');
const iz = f => f.sqlite.prepare("SELECT description d FROM ec_activity WHERE description LIKE 'Otomatik bakım%' ORDER BY created_at DESC,rowid DESC").all().map(r => r.d);
const izSatirlari = f => f.sqlite.prepare('SELECT * FROM ec_bildirim_izi ORDER BY anahtar').all();

async function tur(f, simdi, gonder, over = {}) {
  hataIziniSil(f);
  return otomatikBakim(f.env, {simdi, senkronGetir: bozukSaglayici, kaynaklar: SENKRON_KAYNAKLARI_KAPALI, bildirimGonder: gonder, ...over});
}

test('Bakım hata verince arıza kanalına haber düşer; aynı imza gün içinde bir daha gitmez', async () => {
  const f = await kur(); const tg = gonderimTaklidi(); try {
    const ilk = await tur(f, OGLE, tg.gonder);
    assert.match(ilk.hatalar.join(' '), /senkron trendyol/, 'tur gerçekten hata vermeli: ' + JSON.stringify(ilk));
    assert.equal(tg.mesajlar.length, 1, 'ilk arıza kanala düşer');
    assert.match(tg.mesajlar[0], /senkron trendyol/, tg.mesajlar[0]);
    assert.equal(ilk.bildirim.gonderildi, 1);
    assert.equal(ilk.bildirim.sonuc, 'ok');
    assert.match(iz(f)[0], /bildirim/, 'gönderim sonucu panelden görülebilmeli: ' + iz(f)[0]);

    // Aynı arıza 15 dakika sonra da, akşam da aynı: kanal susar ama susturma SAYILIR.
    const ikinci = await tur(f, OGLE + 15 * 60000, tg.gonder);
    const ucuncu = await tur(f, AKSAM, tg.gonder);
    assert.equal(tg.mesajlar.length, 1, 'aynı imza günde bir kez: ' + JSON.stringify(tg.mesajlar));
    assert.equal(ikinci.bildirim.susturuldu, 1);
    assert.equal(ucuncu.bildirim.gonderildi, 0);
    const satirlar = izSatirlari(f);
    assert.equal(satirlar.length, 1, 'tek imza tek satır: ' + JSON.stringify(satirlar));
    assert.equal(satirlar[0].gonderim, 1);
    assert.equal(satirlar[0].gorulme, 3, 'susturulan tekrarlar da sayılır');
    assert.equal(satirlar[0].gun, '2026-10-05');

    // Türkiye günü dönünce aynı arıza yeniden hatırlatılır: 21:30Z = TR 06.10 saat 00:30.
    await tur(f, ERTESI, tg.gonder);
    assert.equal(tg.mesajlar.length, 2, 'ertesi Türkiye gününde yeniden gönderilir');
    assert.equal(izSatirlari(f)[0].gun, '2026-10-06');
  } finally { f.close(); }
});

test('Yeni bir hata imzası susturulmaz; susturma imza başınadır', async () => {
  const f = await kur(); const tg = gonderimTaklidi(); try {
    await arizaBildir(f.env, ['senkron trendyol: 500 bozuk'], {simdi: OGLE, gonder: tg.gonder});
    assert.equal(tg.mesajlar.length, 1);
    // Aynı imza + YENİ imza: yalnız yeni olan gönderilir, eskisi mesajın içine girmez.
    const r = await arizaBildir(f.env, ['senkron trendyol: 500 bozuk', 'dosya: sütun eşleşmedi'], {simdi: AKSAM, gonder: tg.gonder});
    assert.equal(tg.mesajlar.length, 2, 'yeni arıza susturulmamalı');
    assert.equal(r.gonderildi, 1);
    assert.equal(r.susturuldu, 1);
    assert.match(tg.mesajlar[1], /sütun eşleşmedi/);
    assert.doesNotMatch(tg.mesajlar[1], /bozuk/, 'bugün gönderilmiş arıza tekrar yazılmaz');
    assert.equal(izSatirlari(f).length, 2);
  } finally { f.close(); }
});

test('Hata imzası değişken kimlikleri ve sayıları yutar, farklı arızaları ayırır', async () => {
  const a = hataImzasi('dosya: 3f2a1b4c-0d5e-4f6a-8b9c-1d2e3f4a5b6c satırı okunamadı (42 kayıt)');
  const b = hataImzasi('dosya: 9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d satırı okunamadı (7 kayıt)');
  assert.equal(a, b, 'aynı arıza farklı dosya kimliğiyle iki kez bildirilmemeli');
  assert.notEqual(a, hataImzasi('dosya: sütun eşleşmedi'), 'farklı arıza ayrı imza almalı');
  assert.ok(a.length <= 200, 'imza sınırsız büyümez');
});

test('Gönderim başarısızsa susturulmaz; ize yazılır ve sonraki tur yeniden dener', async () => {
  const f = await kur(); const tg = gonderimTaklidi(() => false); try {
    const ilk = await tur(f, OGLE, tg.gonder);
    assert.equal(tg.mesajlar.length, 1, 'gönderim denenmeli');
    assert.equal(ilk.bildirim.sonuc, 'basarisiz');
    assert.equal(ilk.bildirim.gonderildi, 0);
    assert.match(iz(f)[0], /arıza bildirimi gönderilemedi/, 'bot kapanırsa panelden görülsün: ' + iz(f)[0]);
    assert.equal(izSatirlari(f)[0].son_sonuc, 'basarisiz');
    assert.equal(izSatirlari(f)[0].gun, '', 'başarısız gönderim günü tüketmez');

    // Aynı gün içinde yeniden denenir: başarısız gönderim arızayı susturmaz.
    const basarili = gonderimTaklidi();
    await tur(f, OGLE + 15 * 60000, basarili.gonder);
    assert.equal(basarili.mesajlar.length, 1, 'başarısız gönderim sonraki turda tekrar denenir');
    assert.equal(izSatirlari(f)[0].gun, '2026-10-05');
    assert.equal(izSatirlari(f)[0].son_sonuc, 'ok');
  } finally { f.close(); }
});

test('Tur tamamen çökse de haber gider; hata yukarı fırlar', async () => {
  const f = await kur(); const tg = gonderimTaklidi(); try {
    // Bakımın İLK sorgusu düşürülür: tur hiçbir adıma gelemeden çöker. Bildirim izi tablosu
    // çalışmaya devam eder, yani çökme de susturma kuralına girer.
    const kirilgan = {prepare: sql => { if (/ec_report_files/.test(sql)) throw Error('D1 ulaşılamıyor'); return f.env.DB.prepare(sql); }, batch: (...a) => f.env.DB.batch(...a)};
    const env = {...f.env, DB: kirilgan};
    await assert.rejects(() => otomatikBakim(env, {simdi: OGLE, bildirimGonder: tg.gonder}), /D1 ulaşılamıyor/);
    assert.equal(tg.mesajlar.length, 1, 'çöken tur sessiz kalmamalı');
    assert.match(tg.mesajlar[0], /çöktü/i, tg.mesajlar[0]);
    assert.match(tg.mesajlar[0], /D1 ulaşılamıyor/);
    await assert.rejects(() => otomatikBakim(env, {simdi: AKSAM, bildirimGonder: tg.gonder}));
    assert.equal(tg.mesajlar.length, 1, 'aynı çökme günde bir kez bildirilir');
  } finally { f.close(); }
});

test('Veritabanı susturma izini okuyamasa da arıza haberi gider', async () => {
  const tg = gonderimTaklidi();
  const env = {DB: {prepare: () => { throw Error('D1 ulaşılamıyor'); }, batch: () => { throw Error('D1 ulaşılamıyor'); }}};
  secretler(env);
  const r = await arizaBildir(env, ['bakım turu çöktü: D1 ulaşılamıyor'], {simdi: OGLE, gonder: tg.gonder});
  assert.equal(tg.mesajlar.length, 1, 'susturma okunamıyorsa haber yine gider: veritabanı arızası en önemli haberdir');
  assert.equal(r.gonderildi, 1);
});

test('Bildirim yapılandırılmamış ortamda gönderim hiç denenmez', async () => {
  // Secret KURULMAZ: yerel geliştirme ve test ortamının hâli budur.
  const f = appFixture(); await f.setup(); try {
    const eski = globalThis.fetch;
    globalThis.fetch = async url => { throw Error('Beklenmeyen ağ isteği: ' + url); };
    try {
      // Secret yok: telegramAriza çağrılsa bile ağa çıkmaz, ama hiç denenmediği de ölçülür.
      const r = await arizaBildir(f.env, ['senkron trendyol: 500 bozuk'], {simdi: OGLE, gonder: telegramAriza});
      assert.equal(r.sonuc, 'kapali', JSON.stringify(r));
      assert.equal(izSatirlari(f).length, 0, 'kapalı kanal susturma izi kirletmez');
    } finally { globalThis.fetch = eski; }
  } finally { f.close(); }
});

test('Arıza haberi hata kanalını seçer, kurulu değilse özet kanalına düşer', async () => {
  const mesajlar = [], eski = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw Error('Beklenmeyen ağ isteği: ' + url);
    mesajlar.push(JSON.parse(options?.body || '{}'));
    return Response.json({ok: true, result: {message_id: mesajlar.length}});
  };
  try {
    assert.equal(await telegramAriza({TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ORDERS: '-1001', TELEGRAM_CHAT_ERRORS: '-1002'}, 'arıza'), true);
    assert.equal(mesajlar.at(-1).chat_id, '-1002', 'hata kanalı varsa oraya gider');
    // Hata kanalı secret'ı kurulmamışsa haber KAYBOLMAZ: özet kanalına düşer.
    assert.equal(await telegramAriza({TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ORDERS: '-1001'}, 'arıza'), true);
    assert.equal(mesajlar.at(-1).chat_id, '-1001', 'hata kanalı yoksa özet kanalına düşer');
  } finally { globalThis.fetch = eski; }
});
