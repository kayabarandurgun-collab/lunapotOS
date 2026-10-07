// TARİFE UYARISI ÇOK GEÇ GELİYORDU. Canlı ölçüm 07.10.2026: kargo ve komisyon tarifelerinin
// HEPSİ 31.12.2026'da bitiyor (Trendyol 6+1, Hepsiburada 5+1 satır). Uyarı penceresi yedi gündü,
// yani uyarı 24 Aralık'ta — yılbaşı tatiline denk gelecek şekilde — çıkacaktı. Tarife bittiği an
// kesinti ve kâr hesabı dayanaksız kalıyor; yeni fiyat koşullarını almak bir haftadan uzun sürer.
//
// Devir belgesi "panel uyarmıyor" diyordu; DOĞRUSU uyarıyor ama bir hafta önceden. Pencere 30 güne
// çıkarıldı ve iki ekran da artık süre değil TARİH yazıyor: "7 gün içinde" gibi sabit bir metin
// pencere değişince sessizce yanlışa düşüyordu, zaten öyle olmuştu.
//
// Kanıtlanan: (a) 30 gün içinde bitecek tarife uyarı veriyor, (b) daha uzak tarife vermiyor,
// (c) uyarı metni bitiş TARİHİNİ taşıyor ve sabit "7 gün"/"bir hafta" metni hiçbir yerde kalmadı,
// (d) hiç tarife yoksa çıkan uyarı "bitiyor" değil "eksik" olanı, ikisi aynı anda çıkmıyor.
// TEMSİLİ veri; gerçek tarife DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';
import {attentionItems} from '../public/attention-ui.js';
import {aksamOzetiMetni} from '../src/aksam-ozeti.js';

const BOS = {
  orders: {}, stock: {total: 1, no_history: 0}, invoices: {}, sales: {},
  tariffs: {shipping_active: 1, commission_active: 1, shipping_expiring: 0, commission_expiring: 0,
    shipping_expires_on: null, commission_expires_on: null}
};
const baglanti = {providers: []};
const ayar = {tax_id: '1234567890', legal_name: 'Test'};
const tarifeSatiri = data => attentionItems(data, baglanti, ayar).find(x => /[Tt]arife/.test(x.title));

test('Bitiş tarihi uyarı metninde yazıyor, süre değil', () => {
  const satir = tarifeSatiri({...BOS, tariffs: {...BOS.tariffs, shipping_expiring: 11,
    shipping_expires_on: '2026-12-31', commission_expires_on: '2026-12-31'}});
  assert.ok(satir, 'uyarı çıkmalı');
  assert.match(satir.title, /31 Ara 2026/, 'tarih yazmalı: ' + satir.title);
  assert.ok(!/gün içinde|bir hafta/.test(satir.title), 'sabit süre metni kalmamalı: ' + satir.title);
  assert.equal(satir.href, '#pricing');
});

test('İki tarifeden EN YAKIN bitiş yazılır', () => {
  const satir = tarifeSatiri({...BOS, tariffs: {...BOS.tariffs, commission_expiring: 1,
    shipping_expires_on: '2027-06-30', commission_expires_on: '2026-11-15'}});
  assert.match(satir.title, /15 Kas 2026/, 'önce bitecek olan yazılmalı: ' + satir.title);
});

test('Bitecek tarife yoksa uyarı hiç çıkmaz', () => {
  assert.equal(tarifeSatiri(BOS), undefined);
});

test('Tarih bilinmiyorsa uyarı yine çıkar, uydurma tarih yazılmaz', () => {
  const satir = tarifeSatiri({...BOS, tariffs: {...BOS.tariffs, shipping_expiring: 2,
    shipping_expires_on: null, commission_expires_on: null}});
  assert.equal(satir.title, 'Bitmek üzere olan tarife');
});

// Sunucu tarafı: pencere gerçekten 30 gün mü, bitiş tarihi geliyor mu.
test('Sunucu 30 gün içinde bitecek tarifeyi sayar ve bitiş tarihini verir', async () => {
  const f = appFixture(); await f.setup(); try {
    const bugun = new Date().toLocaleDateString('sv-SE', {timeZone: 'Europe/Istanbul'});
    const gunEkle = n => new Date(Date.parse(bugun + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const tarife = (id, valid_to) => f.sqlite.prepare(
      'INSERT INTO ec_shipping_rates(id,label,channel,carrier,valid_from,valid_to,price_min_cents,billable_min_milli,desi_divisor,billable_step_milli,amount_cents,vat_bps,tax_included,source)'
      + " VALUES(?,?,'trendyol','test',?,?,0,0,3000,1000,5000,2000,1,'test')").run(id, id, bugun, valid_to);
    tarife('yakin', gunEkle(20));   // 30 günlük pencerenin İÇİNDE, eski 7 günlükte DEĞİL
    tarife('uzak', gunEkle(200));
    const r = await f.ok('/ec/attention');
    assert.equal(r.tariffs.shipping_expiring, 1, '20 gün sonra bitecek tarife sayılmalı: ' + JSON.stringify(r.tariffs));
    assert.equal(r.tariffs.shipping_expires_on, gunEkle(20), 'en yakın bitiş tarihi dönmeli');
  } finally { f.close(); }
});

test('Akşam özeti de süre değil tarih yazar', () => {
  const liste = {...BOS, tariffs: {...BOS.tariffs, shipping_expiring: 11, shipping_expires_on: '2026-12-31'},
    // last_applied SQLite biçiminde ('YYYY-MM-DD HH:MM:SS'); ISO damgası damga()'yı düşürüyor.
    reports: {total: 1, last_applied: new Date().toISOString().slice(0, 19).replace('T', ' ')}};
  const metin = aksamOzetiMetni(liste);
  assert.match(metin, /11 kargo tarifesi 31 Ara 2026 tarihinde bitiyor/, metin);
  assert.ok(!/bir hafta içinde/.test(metin), 'sabit "bir hafta" metni kalmamalı: ' + metin);
});

// Sabit süre metni geri sızmasın: pencere bir kez değişti ve metinler yanlış kaldı.
test('Hiçbir kaynakta sabit "7 gün"/"bir hafta" tarife metni kalmadı', () => {
  for (const yol of ['../public/attention-ui.js', '../src/aksam-ozeti.js']) {
    const kaynak = readFileSync(new URL(yol, import.meta.url), 'utf8');
    const satirlar = kaynak.split('\n').filter(l => !l.trim().startsWith('//') && /tarife/i.test(l));
    for (const l of satirlar)
      assert.ok(!/'7 gün|bir hafta içinde/.test(l), yol + ' sabit süre metni taşıyor: ' + l.trim());
  }
});
