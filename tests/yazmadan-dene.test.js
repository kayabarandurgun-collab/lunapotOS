// YAZMADAN DENE (ÖNİZLEME) DÜĞMESİ. Bağlantılar ekranındaki form gövdesi her alanı METİN taşır
// (Object.fromEntries(new FormData(...)) → 'on'), sunucu ise preview alanında yalnız GERÇEK boolean
// kabul eder ve belirsiz değeri 400 ile reddeder (src/connections-api.js). Bu yüzden formdan çıkan
// girdi tek bir yerde dönüştürülür ve burada UCA KADAR gönderilerek sınanır.
// Kanıtlanan: bayrak gerçek boolean gider, uç kabul eder, önizlemede tek satır bile yazılmaz,
// özet metni kullanıcının anlayacağı Türkçe sayıları verir ve sayfa sayfa alma akışına girmez.
// AĞA ÇIKILMAZ: sağlayıcı isteği taklit edilir. TEMSİLİ veri; gerçek sipariş DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture} from './helpers/app-fixture.js';
import {senkronGirdisi, onizlemeOzeti} from '../public/operations-ui.js';

const KIMLIK = {seller_id: '1234', key: 'ornek-anahtar', secret: 'ornek-parola', user_agent: '1234 - SelfIntegration'};
const AN = Date.parse('2026-09-12T06:00:00Z');
// Formdan okunan ham gövde: her alan metindir, işaret kutusu 'on' taşır.
const FORM = {provider: 'trendyol', kind: 'orders', from: '2026-09-09', to: '2026-09-12', page: '0', skus: '', all_pages: 'on'};
const siparis = () => ({shipmentPackageId: 11, orderNumber: 'ORD-1', orderDate: AN, lastModifiedDate: AN, currencyCode: 'TRY', status: 'Created',
  lines: [{lineId: 22, quantity: 1, lineUnitPrice: 100, vatRate: 20, lineTyDiscount: 0, stockCode: 'TR-1', productName: 'Torf', currencyCode: 'TRY', commission: 10}]});

// Sağlayıcı taklidi: uç kendi varsayılan fetch'ini kullandığı için global fetch kısa süreliğine alınır.
function saglayici() {
  const cagrilar = [], eski = globalThis.fetch;
  globalThis.fetch = async url => {
    if (!String(url).startsWith('https://apigw.trendyol.com/')) throw Error('Beklenmeyen ağ isteği: ' + url);
    cagrilar.push(new URL(url).searchParams.get('page'));
    return Response.json({content: [siparis()], totalPages: 1, totalElements: 1});
  };
  return {cagrilar, geri: () => { globalThis.fetch = eski; }};
}
const sayim = (f, tablo) => f.sqlite.prepare('SELECT COUNT(*) n FROM ' + tablo).get().n;
const TABLOLAR = ['ec_provider_records', 'ec_provider_cursors', 'ec_integration_runs', 'ec_order_packages'];

test('Önizleme bayrağı gerçek boolean gider; uç kabul eder ve tek satır bile yazılmaz', async () => {
  const f = appFixture(); await f.setup(); const ty = saglayici(); try {
    f.env.CREDENTIAL_KEY = 'ab'.repeat(32);
    await f.ok('/ec/connections/trendyol/configure', KIMLIK);

    const onizlemeGirdi = senkronGirdisi(FORM, true);
    assert.equal(onizlemeGirdi.preview, true);
    assert.equal(typeof onizlemeGirdi.preview, 'boolean', "metin 'on' değil gerçek boolean gitmeli");
    assert.equal(onizlemeGirdi.all_pages, false, 'önizleme tek sayfa çalışır');
    assert.equal(onizlemeGirdi.page, 0);
    assert.deepEqual(onizlemeGirdi.skus, []);

    const cevap = await f.req('/ec/connections/trendyol/sync', onizlemeGirdi);
    assert.equal(cevap.status, 200, JSON.stringify(cevap.data));
    assert.equal(cevap.data.preview, true);
    assert.equal(cevap.data.importableOrders, 1);
    assert.ok(cevap.data.message.startsWith('ÖNİZLEME'), cevap.data.message);
    for (const t of TABLOLAR) assert.equal(sayim(f, t), 0, t + ' önizlemeden sonra boş kalmalı');

    // Aynı formun yazan dalı da boolean gönderir (false) ve uç onu reddetmez: bu kez YAZAR.
    const yazanGirdi = senkronGirdisi(FORM);
    assert.equal(yazanGirdi.preview, false);
    assert.equal(yazanGirdi.all_pages, true, 'işaret kutusu açıkken bütün sayfalar alınır');
    const yazan = await f.req('/ec/connections/trendyol/sync', yazanGirdi);
    assert.equal(yazan.status, 200, JSON.stringify(yazan.data));
    assert.equal(yazan.data.preview, false);
    assert.equal(sayim(f, 'ec_provider_records'), 1);
    assert.equal(sayim(f, 'ec_order_packages'), 1);

    // Dönüştürme atlanırsa uç ne yaptığını bilmeden yazmaz: ham metin 400 ile reddedilir.
    const ham = await f.req('/ec/connections/trendyol/sync', {...FORM, page: 0, skus: [], preview: 'on'});
    assert.equal(ham.status, 400);
    assert.match(ham.data.error, /true\/false/);
  } finally { ty.geri(); f.close(); }
});

test('Önizleme özeti kullanıcının anlayacağı Türkçe sayıları verir', () => {
  const ozet = onizlemeOzeti({page: 0, records: new Array(592), deliveredMarked: 58, alreadyKnownOrders: 539, importableOrders: 19,
    unchanged: 0, changed: 0, ambiguousDeliveries: 0, undatedDeliveries: 0, hasMore: false, warnings: [], preview: true});
  for (const ibare of ['592 kaynak kaydı', '58 paket teslim işaretlenecek', '539 sipariş zaten sistemde', '19 yeni taslak açılacak', 'hiçbir şey yazılmadı'])
    assert.ok(ozet.includes(ibare), ibare + ' özette yok: ' + ozet);
  // Sıfır sayılar yazılmaz: metin gereksiz rakamla dolmasın.
  assert.ok(!ozet.includes('0 '), ozet);
  // Devamı olan aralıkta kullanıcı bunun tek sayfa olduğunu bilmeli.
  assert.match(onizlemeOzeti({page: 2, records: [], hasMore: true, warnings: []}), /3\. sayfa/);
  assert.match(onizlemeOzeti({page: 0, records: [], hasMore: true, warnings: []}), /başka sayfalar/);
});

test('Bağlantılar ekranındaki senkron formu yazmadan deneme düğmesi sunar', () => {
  const kaynak = readFileSync(new URL('../public/operations-ui.js', import.meta.url), 'utf8');
  // Düğme aynı formu gönderir (type="submit") ama data-op taşımaz: kök tıklama dinleyicisi
  // [data-op] arıyor, gönderme akışıyla karışmamalı. Ayırt etme data-mode ile yapılır.
  assert.ok(kaynak.includes('type="submit" data-mode="preview">Yazmadan dene<'), 'senkron formunda "Yazmadan dene" gönder düğmesi yok');
  assert.ok(kaynak.includes("senkronGirdisi(x,b?.dataset.mode==='preview')"), 'gönderen düğme girdiyi tek dönüştürmeden geçirmeli');
});
