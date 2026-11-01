import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {buyboxKarari, zararSiniri, aktifOlabilir, GUNLUK_SINIR} from '../src/buybox-motor.js';
import {hbSiraOku, tySiraOku, hbKilidi, tyKilidi, tySonucOku, hbYuklemeDurumu} from '../src/buybox-suruculer.js';
import {buyboxTuru, buyboxApi, BUYBOX_CRON} from '../src/buybox-api.js';

const K = {taban_cents: 17900, cekilme_cents: 19900, zarar_onay: 1}, T0 = 1_800_000_000_000;
const G = (priceCents, rivalCents, rank = 1, x = {}) => ({priceCents, rivalCents, rank, stock: 5, ...x});
const karar = (fiyat, rakip, sira, kural = K, x) => buyboxKarari(kural, G(fiyat, rakip, sira, x));

test('kullanıcının örneği baştan sona: 198, 180, 179 → 199, 185, 200 → 199, 250 → 249', () => {
  const adimlar = [[20000, 19800, 2, 19800], [19800, 18000, 2, 18000], [18000, 17900, 2, 19900], [19900, 18500, 2, 18500], [18500, 20000, 1, 19900], [19900, 25000, 1, 24900]];
  for (const [fiyat, rakip, sira, beklenen] of adimlar) {
    const c = karar(fiyat, rakip, sira);
    assert.equal(c.degistir, true, `${fiyat}/${rakip}`);
    assert.equal(c.yeniCents, beklenen, `${fiyat}/${rakip}`);
  }
});

test('rakip tabanın altındayken çekilmede kalır, fiyat dibe gitmez', () => {
  assert.equal(karar(19900, 17000, 2).neden, 'yerinde');
  assert.equal(karar(19900, 17900, 2).neden, 'yerinde');
  assert.equal(karar(18000, 100, 2).yeniCents, 19900);
});

test('aynı fiyatta sıra bizdeyse beklenir; sıra gelmezse taban izin veriyorsa 1 TL altı', () => {
  assert.equal(karar(18500, 18500, 1).neden, 'esit');
  assert.equal(karar(18500, 18500, null).neden, 'esit');
  assert.deepEqual([karar(18500, 18500, 2).yeniCents, karar(18500, 18500, 2).neden], [18400, 'alta_in']);
  assert.equal(karar(18000, 18000, 2).yeniCents, 17900);
});

test('yukarıda dengede kalır, ileri geri oynamaz', () => {
  assert.equal(karar(19900, 20000, 1).neden, 'onde');
  assert.equal(karar(18400, 18500, 1).neden, 'onde');
  assert.equal(karar(19900, 20000, 2).neden, 'fiyat_disi');
  let fiyat = 20000;
  const c = karar(fiyat, 19800, 2); fiyat = c.yeniCents;
  assert.equal(karar(fiyat, 19800, 1).degistir, false, 'eşitlendikten sonra sıra bizdeyse yeni hamle yok');
});

test('tavan yok; yalnız hatalı fiyatta fren var ve ayarla değişir; eşit çıkma seçeneği', () => {
  assert.equal(karar(19900, 59700, 1).yeniCents, 59600);
  const fren = karar(19900, 999900, 1);
  assert.deepEqual([fren.degistir, fren.neden], [false, 'hata_freni']);
  assert.equal(karar(19900, 999900, 1, {...K, guvenlik_cents: 1000000}).yeniCents, 999800);
  assert.equal(karar(19900, 25000, 1, {...K, yukari_esit: 1}).yeniCents, 25000);
});

test('rakip yoksa çekilme; rakip fiyatı bilinmiyorsa dokunmaz', () => {
  assert.equal(buyboxKarari(K, {priceCents: 18000, rakipVar: false, stock: 3}).yeniCents, 19900);
  assert.equal(buyboxKarari(K, {priceCents: 18000, rivalCents: null, rank: 1, stock: 3}).neden, 'rakip_bilinmiyor');
});

test('hiçbir yolla tabanın altına inmez', () => {
  for (let f = 15000; f <= 26000; f += 700) for (let r = 100; r <= 70000; r += 900) for (const s of [1, 2, null]) {
    const c = karar(f, r, s);
    if (c.degistir) assert.ok(c.yeniCents >= 17900, JSON.stringify({f, r, s, c}));
  }
});

test('zarar kilidi: sınır hesaplanır, altına inilmez, onay olmadan Aktif olunmaz', () => {
  assert.equal(zararSiniri({maliyet_cents: 10000, kargo_cents: 5000, komisyon_bp: 2000}), 18750);
  assert.equal(zararSiniri({maliyet_cents: null}), null);
  const r = {taban_cents: 17900, cekilme_cents: 19900, zarar_cents: 18750, zarar_onay: 0};
  assert.equal(karar(19000, 18000, 2, r).neden, 'zarar_kilidi');
  assert.equal(aktifOlabilir(r), false);
  assert.equal(aktifOlabilir({...r, zarar_onay: 1}), true);
  assert.equal(aktifOlabilir({...r, zarar_cents: null}), false);
  assert.equal(aktifOlabilir({...r, zarar_cents: 17000}), true);
});

test('kilit, stok, yön kilidi, günlük fren ve eksik ayar fiyatı durdurur', () => {
  assert.equal(karar(19000, 18000, 2, K, {kilit: 'kampanyada'}).neden, 'kilitli');
  assert.equal(karar(19000, 18000, 2, K, {stock: 0}).neden, 'stok_yok');
  assert.equal(karar(19000, 18000, 2, K, {dususKilit: true}).neden, 'yon_kilitli');
  assert.equal(karar(19000, 25000, 1, K, {artisKilit: true}).neden, 'yon_kilitli');
  assert.equal(karar(19000, 25000, 1, K, {dususKilit: true}).degistir, true);
  assert.equal(karar(19000, 18000, 2, {...K, changes_today: GUNLUK_SINIR}).neden, 'gunluk_sinir');
  assert.equal(karar(19000, 18000, 2, {taban_cents: 200, cekilme_cents: 100}).neden, 'ayar_yok');
  assert.equal(karar(null, 18000, 2).neden, 'fiyat_yok');
});

test('Trendyol: sıra 1 rakibi 2. fiyat, değilse rakip buybox sahibi; tek satıcı rakipsiz', () => {
  const m = tySiraOku({buyboxInfo: [{barcode: 'a', buyboxOrder: 1, buyboxPrice: 100, secondBuyboxPrice: 120, hasMultipleSeller: true}, {barcode: 'b', buyboxOrder: 3, buyboxPrice: 90.5, secondBuyboxPrice: 95, hasMultipleSeller: true}, {barcode: 'c', buyboxOrder: 1, buyboxPrice: 100, secondBuyboxPrice: 2999, hasMultipleSeller: false}]});
  assert.equal(m.get('A').rivalCents, 12000);
  assert.equal(m.get('B').rivalCents, 9050);
  assert.deepEqual([m.get('C').rakipVar, m.get('C').rivalCents], [false, null]);
});

test('Hepsiburada: belgesiz yanıtta yalnız bilinen alan okunur; tahmin edilmez', () => {
  assert.equal(hbSiraOku([{sku: 'hbv1', buyboxOrder: 2, buyboxPrice: 150}]).get('HBV1').rivalCents, 15000);
  assert.equal(hbSiraOku([{sku: 'hbv1', buyboxOrder: 1, buyboxPrice: 150}]).get('HBV1').rivalCents, null, 'sıra bizdeyken buybox fiyatı bizimkidir, rakip değil');
  assert.equal(hbSiraOku({data: [{sku: 'hbv1', siralama: 2}]}).get('HBV1').rank, null);
  assert.equal(hbSiraOku({mesaj: 'yok'}).size, 0);
  assert.equal(hbYuklemeDurumu({status: 'Done', priceValidations: [{description: 'x'}]}), 'hata');
  assert.equal(hbYuklemeDurumu({status: 'Processing'}), 'bekliyor');
});

test('platform kilitleri okunur: kampanya, askı, satış dışı', () => {
  const simdi = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(hbKilidi({isFrozen: true}, simdi), 'donuk');
  assert.equal(hbKilidi({price: 100, pricings: [{finalPrice: 80, startDate: '2026-11-01T00:00:00Z', endDate: '2026-11-02T00:00:00Z'}]}, simdi), 'kampanyada');
  assert.equal(hbKilidi({price: 100, pricings: [{finalPrice: 80, startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-02T00:00:00Z'}]}, simdi), null);
  assert.equal(tyKilidi({locked: true}), 'kilitli');
  assert.equal(tyKilidi({onSale: true, price: {salePrice: 222, priceSeenByCustomer: 169}}), 'kampanyada');
  assert.equal(tyKilidi({onSale: true, price: {salePrice: 222, priceSeenByCustomer: 222}}), null);
});

test('Trendyol yükleme sonucu ilan başına okunur', () => {
  const m = tySonucOku({items: [{requestItem: {barcode: 'A'}, status: 'SUCCESS'}, {requestItem: {barcode: 'B'}, status: 'FAILED', failureReasons: ['Liste fiyatı']}]}, ['A', 'B', 'C']);
  assert.equal(m.get('A').durum, 'tamam');
  assert.deepEqual([m.get('B').durum, m.get('B').neden], ['hata', 'Liste fiyatı']);
  assert.equal(m.get('C').durum, 'bekliyor');
});

function ortam() {
  const ham = new DatabaseSync(':memory:');
  ham.exec(readFileSync(new URL('../migrations/0079_buybox.sql', import.meta.url), 'utf8'));
  const ifade = (sql, a = []) => { const st = ham.prepare(sql); const o = {bind(...x) { a = x; return o; }, async first() { return st.get(...a) ?? null; }, async all() { return {results: st.all(...a)}; }, async run() { const r = st.run(...a); return {meta: {changes: Number(r.changes)}}; }}; return o; };
  const DB = {prepare: sql => ifade(sql), async batch(l) { const s = []; for (const i of l) s.push(await i.run()); return s; }};
  const istekler = [];
  const d = {hbFiyat: 200, hbSira: 2, hbLider: 198, hbGovde: null, hbYukleme: {status: 'Done'}, tyFiyat: 200, tyListe: 210, tyGovde: null, tyYukleme: null, tyHata: null, tyOnSale: true};
  const BUYBOX_FETCHER = async (url, o) => {
    istekler.push({url, method: o.method, body: o.body, auth: o.headers.Authorization, ua: o.headers['User-Agent']});
    const cevap = j => ({ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j)});
    if (url.includes('trendyol')) {
      if (url.includes('/price-and-inventory')) return d.tyHata ? {ok: false, status: 400, json: async () => ({}), text: async () => d.tyHata} : cevap({batchRequestId: 'ty-1'});
      if (url.includes('/batch-requests/')) return cevap(d.tyYukleme ?? {items: JSON.parse(istekler.filter(i => i.url.includes('price-and-inventory')).at(-1).body).items.map(i => ({requestItem: {barcode: i.barcode}, status: 'SUCCESS'}))});
      if (url.includes('/buybox-information')) return cevap(d.tyGovde ?? {buyboxInfo: [{barcode: 'BRK1', buyboxOrder: 2, buyboxPrice: 198, secondBuyboxPrice: 200, hasMultipleSeller: true}]});
      return cevap({content: [{title: 'Pina Saksı', variants: [{barcode: 'BRK1', stockCode: 'PINA', commission: 19.5, onSale: d.tyOnSale, productUrl: 'https://www.trendyol.com/x-p-1', stock: {quantity: 4}, price: {salePrice: d.tyFiyat, listPrice: d.tyListe, priceSeenByCustomer: d.tyFiyat}}]}]});
    }
    if (/price-uploads\/id/.test(url)) return cevap(d.hbYukleme);
    if (/price-uploads/.test(url)) return cevap({id: 'hb-1'});
    if (/buybox-orders/.test(url)) return cevap(d.hbGovde ?? [{sku: 'HBV1', buyboxOrder: d.hbSira, buyboxPrice: d.hbLider}]);
    return cevap({listings: [{hepsiburadaSku: 'HBV1', merchantSku: 'PINA', price: d.hbFiyat, availableStock: 4, isSalable: true}], totalCount: 1});
  };
  return {ham, d, istekler, env: {DB, WORKSPACE: 'ec', USER: {owner: true}, CREDENTIAL_KEY: 'a'.repeat(64), BUYBOX_FETCHER}};
}
const post = (env, yol, govde) => buyboxApi(new Request('https://x' + yol, {method: 'POST'}), env, yol, async () => govde);
const fiyatGonderimi = o => o.istekler.filter(i => i.method === 'POST' && /price-uploads$|price-and-inventory/.test(i.url));
const AYAR = {taban: '179', cekilme: '199', zarar_onay: true};
async function kurHb(o, mode = 'aktif', ayar = AYAR) {
  await post(o.env, '/api/buybox/baglanti', {platform: 'hb', magaza: 'Pazaria', seller_id: 'a'.repeat(8) + '-1111-2222-3333-' + 'b'.repeat(12), key: 'k', secret: 's3cret', user_agent: 'ua'});
  const id = o.ham.prepare("SELECT id FROM ec_buybox_connection WHERE platform='hb'").get().id;
  await post(o.env, '/api/buybox/ilanlar', {connection_id: id});
  await post(o.env, '/api/buybox/kural', {connection_id: id, sku: 'HBV1', ...ayar, mode});
  return id;
}
async function kurTy(o, mode = 'aktif') {
  await post(o.env, '/api/buybox/baglanti', {platform: 'ty', magaza: 'Pazaria', seller_id: '12345', key: 'k', secret: 's3cret'});
  const id = o.ham.prepare("SELECT id FROM ec_buybox_connection WHERE platform='ty'").get().id;
  await post(o.env, '/api/buybox/ilanlar', {connection_id: id});
  await post(o.env, '/api/buybox/kural', {connection_id: id, sku: 'BRK1', ...AYAR, mode});
  return id;
}
const kural = (o, sku = 'HBV1') => o.ham.prepare('SELECT * FROM ec_buybox_rules WHERE sku=?').get(sku);

test('yeni ilan Kapalı başlar: robot okumaz, fiyat göndermez', async () => {
  const o = ortam(); const id = await kurHb(o, 'kapali');
  o.istekler.length = 0;
  const r = await buyboxTuru(o.env, {simdi: T0});
  assert.equal(r.atlandi, 'calisacak_ilan_yok');
  assert.equal(o.istekler.length, 0);
  o.ham.prepare("UPDATE ec_buybox_rules SET mode='kapali' WHERE connection_id=?").run(id);
  assert.equal(kural(o).mode, 'kapali');
});

test('izle modunda fiyat GÖNDERİLMEZ, yalnız öneri yazılır', async () => {
  const o = ortam(); await kurHb(o, 'izle');
  const r = await buyboxTuru(o.env, {simdi: T0});
  assert.equal(r.degisen, 0); assert.equal(fiyatGonderimi(o).length, 0);
  assert.equal(kural(o).oneri_cents, 19800);
  assert.equal(kural(o).rival_cents, 19800);
});

test('Hepsiburada aktif: fiyat gider, sonuç gelmeden ikincisi gitmez, kimlik düz metin saklanmaz', async () => {
  const o = ortam(); await kurHb(o);
  assert.ok(!o.ham.prepare('SELECT encrypted_credentials e FROM ec_buybox_connection').get().e.includes('s3cret'));
  await buyboxTuru(o.env, {simdi: T0});
  assert.deepEqual(JSON.parse(fiyatGonderimi(o)[0].body), [{hepsiburadaSku: 'HBV1', price: 198}]);
  o.d.hbYukleme = {status: 'Processing'};
  await buyboxTuru(o.env, {simdi: T0 + 120000});
  assert.equal(fiyatGonderimi(o).length, 1, 'bekleyen yükleme varken yeni fiyat gitmemeli');
  o.d.hbYukleme = {status: 'Done'}; o.d.hbFiyat = 198; o.d.hbLider = 185;
  await buyboxTuru(o.env, {simdi: T0 + 240000});
  assert.deepEqual(JSON.parse(fiyatGonderimi(o)[1].body), [{hepsiburadaSku: 'HBV1', price: 185}]);
  assert.equal(o.ham.prepare("SELECT count(*) n FROM ec_buybox_events WHERE status='tamam'").get().n, 1);
});

test('Trendyol aktif: stok GÖNDERİLMEZ, yükselirken liste fiyatı taşınır, inerken korunur', async () => {
  const o = ortam(); await kurTy(o);
  await buyboxTuru(o.env, {simdi: T0});
  const inis = JSON.parse(fiyatGonderimi(o)[0].body).items[0];
  assert.deepEqual(inis, {barcode: 'BRK1', salePrice: 198, listPrice: 210});
  assert.ok(!('quantity' in inis), 'stok ezilmemeli');
  assert.ok(o.istekler[0].ua.includes('12345 - SelfIntegration'));
  o.d.tyFiyat = 198;
  o.d.tyGovde = {buyboxInfo: [{barcode: 'BRK1', buyboxOrder: 1, buyboxPrice: 198, secondBuyboxPrice: 250, hasMultipleSeller: true}]};
  await buyboxTuru(o.env, {simdi: T0 + 120000});
  assert.deepEqual(JSON.parse(fiyatGonderimi(o)[1].body).items[0], {barcode: 'BRK1', salePrice: 249, listPrice: 249});
});

test('Trendyol "15 dakika aynı istek" reddi arıza sayılmaz, ilan izlemeye düşmez', async () => {
  const o = ortam(); await kurTy(o);
  o.d.tyHata = '{"errors":[{"message":"15 dakika boyunca aynı isteği tekrarlı olarak atamazsınız!"}]}';
  const r = await buyboxTuru(o.env, {simdi: T0});
  assert.deepEqual([r.degisen, r.hatalar.length], [0, 0]);
  const k = kural(o, 'BRK1');
  assert.deepEqual([k.mode, k.last_reason, k.pending_upload_id], ['aktif', 'tekrar_bekliyor', null]);
});

test('reddedilen fiyat ilanı izlemeye alır', async () => {
  const o = ortam(); await kurHb(o);
  await buyboxTuru(o.env, {simdi: T0});
  o.d.hbYukleme = {status: 'Done', priceValidations: [{description: 'Fiyat aralık dışı'}]};
  await buyboxTuru(o.env, {simdi: T0 + 120000});
  const k = kural(o);
  assert.deepEqual([k.mode, k.last_error, k.pending_upload_id], ['izle', 'Fiyat aralık dışı', null]);
});

test('fiyat elle değişirse robot durur; yeni gönderilen fiyatın yansıması beklenir', async () => {
  const o = ortam(); await kurHb(o);
  o.d.hbLider = 200; o.d.hbSira = 1; o.d.hbGovde = [{sku: 'HBV1', buyboxOrder: 1, secondBuyboxPrice: 200}];
  o.d.hbFiyat = 199;
  await buyboxTuru(o.env, {simdi: T0});
  assert.equal(fiyatGonderimi(o).length, 0);
  assert.equal(kural(o).beklenen_cents, 19900);
  o.d.hbFiyat = 150;
  await buyboxTuru(o.env, {simdi: T0 + 120000});
  assert.equal(kural(o).last_reason, 'yansiyor', 'süre dolmadan elle denmez');
  assert.equal(fiyatGonderimi(o).length, 0);
  await buyboxTuru(o.env, {simdi: T0 + 16 * 60000});
  const k = kural(o);
  assert.deepEqual([k.mode, k.last_reason], ['izle', 'elle_degisti']);
  assert.match(k.last_error, /robot dışında/);
});

test('sıra okunamazsa ve robot durdurulunca fiyat gitmez; önceki tur bitmeden ikincisi girmez', async () => {
  const a = ortam(); await kurHb(a);
  a.d.hbGovde = [{sku: 'HBV1', baskaAlan: 1}];
  await buyboxTuru(a.env, {simdi: T0});
  assert.equal(fiyatGonderimi(a).length, 0);
  assert.equal(kural(a).last_reason, 'rakip_bilinmiyor');
  assert.deepEqual(JSON.parse(a.ham.prepare('SELECT sample_fields s FROM ec_buybox_connection').get().s), ['sku', 'baskaAlan']);

  const d = ortam(); const id = await kurHb(d);
  await post(d.env, '/api/buybox/duraklat', {paused: true});
  assert.equal((await buyboxTuru(d.env, {simdi: T0})).atlandi, 'calisacak_ilan_yok');
  assert.equal(fiyatGonderimi(d).length, 0);
  await post(d.env, '/api/buybox/duraklat', {connection_id: id, paused: false});

  d.ham.prepare('UPDATE ec_buybox_connection SET turda_at=?').run(T0);
  await buyboxTuru(d.env, {simdi: T0 + 60000});
  assert.equal(fiyatGonderimi(d).length, 0, 'tur kilidi');
  await buyboxTuru(d.env, {simdi: T0 + 120000});
  assert.equal(fiyatGonderimi(d).length, 1, 'kilit süresi dolunca devam');
});

test('yükleme sonucu sorgusu düşerse bağlantı kilitlenmez; süre dolunca ilan izlemeye düşer', async () => {
  const o = ortam(); await kurHb(o);
  await buyboxTuru(o.env, {simdi: T0});
  assert.equal(kural(o).pending_upload_id, 'hb-1');
  const asil = o.env.BUYBOX_FETCHER;
  o.env.BUYBOX_FETCHER = async (u, s) => /price-uploads\/id/.test(u) ? {ok: false, status: 404, json: async () => ({}), text: async () => ''} : asil(u, s);
  let r = await buyboxTuru(o.env, {simdi: T0 + 120000});
  assert.deepEqual(r.hatalar, []);
  assert.equal(kural(o).pending_upload_id, 'hb-1', 'süre dolmadan bekler');
  assert.equal(fiyatGonderimi(o).length, 1);
  r = await buyboxTuru(o.env, {simdi: T0 + 31 * 60000});
  const k = kural(o);
  assert.deepEqual([k.mode, k.pending_upload_id], ['izle', null]);
  assert.match(k.last_error, /30 dakikada/);
});

test('tur sürerken kullanıcı ilanı kapatırsa tur geri Aktif yazmaz ve fiyat göndermez', async () => {
  const o = ortam(); await kurHb(o);
  const asil = o.env.BUYBOX_FETCHER;
  o.env.BUYBOX_FETCHER = async (u, s) => { if (/buybox-orders/.test(u)) o.ham.prepare("UPDATE ec_buybox_rules SET mode='kapali'").run(); return asil(u, s); };
  await buyboxTuru(o.env, {simdi: T0});
  assert.equal(kural(o).mode, 'kapali');
  assert.equal(fiyatGonderimi(o).length, 0);
});

test('tur sürerken robot durdurulursa fiyat gitmez', async () => {
  const o = ortam(); await kurHb(o);
  const asil = o.env.BUYBOX_FETCHER;
  o.env.BUYBOX_FETCHER = async (u, s) => { if (/buybox-orders/.test(u)) o.ham.prepare('UPDATE ec_buybox_connection SET paused=1').run(); return asil(u, s); };
  await buyboxTuru(o.env, {simdi: T0});
  assert.equal(fiyatGonderimi(o).length, 0);
  assert.equal(kural(o).mode, 'aktif');
});

test('kapatılan ilanın bekleyen yüklemesi temizlenir, ilan okunmaz ve Aktife dönmez', async () => {
  const o = ortam(); await kurHb(o);
  await buyboxTuru(o.env, {simdi: T0});
  o.ham.prepare("UPDATE ec_buybox_rules SET mode='kapali'").run();
  o.d.hbYukleme = {status: 'Done', errors: [{message: 'red'}]};
  o.istekler.length = 0;
  await buyboxTuru(o.env, {simdi: T0 + 120000});
  const k = kural(o);
  assert.deepEqual([k.mode, k.pending_upload_id], ['kapali', null]);
  assert.ok(!o.istekler.some(i => /buybox-orders/.test(i.url)));
});

test('bir mağazanın arızası öbürünü durdurmaz', async () => {
  const o = ortam(); await kurHb(o); await kurTy(o);
  const asil = o.env.BUYBOX_FETCHER;
  o.env.BUYBOX_FETCHER = async (u, s) => { if (u.includes('hepsiburada')) throw new Error('ağ'); return asil(u, s); };
  const r = await buyboxTuru(o.env, {simdi: T0});
  assert.equal(r.hatalar.length, 1);
  assert.equal(r.degisen, 1);
  assert.match(o.ham.prepare("SELECT last_error e FROM ec_buybox_connection WHERE platform='hb'").get().e, /ulaşılamadı/);
  assert.equal(o.ham.prepare("SELECT turda_at t FROM ec_buybox_connection WHERE platform='hb'").get().t, null, 'kilit bırakılmalı');
});

test('ilan yeniden çekilince ayar ve biçim korunur; aynı anda iki platform aynı mağazada', async () => {
  const o = ortam(); const id = await kurHb(o); await kurTy(o, 'izle');
  o.d.hbFiyat = 210;
  await post(o.env, '/api/buybox/ilanlar', {connection_id: id});
  const k = kural(o);
  assert.deepEqual([k.mode, k.taban_cents, k.price_cents], ['aktif', 17900, 21000]);
  assert.equal(kural(o, 'BRK1').komisyon_bp, 1950);
  assert.equal(o.ham.prepare('SELECT count(*) n FROM ec_buybox_connection').get().n, 2);
});

test('toplu: Aktif yalnız ayarı tam ilana geçer; yüzde tabanı hesaplar ve Aktifi izlemeye düşürür', async () => {
  const o = ortam(); const id = await kurHb(o, 'kapali', {});
  let r = await post(o.env, '/api/buybox/toplu', {connection_id: id, skus: ['HBV1'], mode: 'aktif'});
  assert.deepEqual([r.secilen, r.degisen], [1, 0]);
  assert.equal(kural(o).mode, 'kapali');
  await post(o.env, '/api/buybox/toplu', {connection_id: id, skus: ['HBV1'], taban_yuzde: '10'});
  assert.deepEqual([kural(o).taban_cents, kural(o).cekilme_cents], [18000, 20000]);
  r = await post(o.env, '/api/buybox/toplu', {connection_id: id, skus: ['HBV1'], mode: 'aktif'});
  assert.equal(r.degisen, 0, 'zarar onayı olmadan Aktif olmaz');
  o.ham.prepare('UPDATE ec_buybox_rules SET zarar_onay=1').run();
  r = await post(o.env, '/api/buybox/toplu', {connection_id: id, skus: ['HBV1'], mode: 'aktif'});
  assert.equal(r.degisen, 1);
  await post(o.env, '/api/buybox/toplu', {connection_id: id, skus: ['HBV1'], taban_yuzde: '20'});
  assert.equal(kural(o).mode, 'izle');
});

test('API: yetki, doğrulama, zarar kilidi, deneme ve kimlik sızıntısı', async () => {
  const o = ortam(); const id = await kurHb(o, 'izle');
  const taban = {connection_id: id, sku: 'HBV1'};
  await assert.rejects(post({...o.env, USER: {owner: false}}, '/api/buybox/kural', {...taban, mode: 'aktif'}), /hesap sahibi/);
  await assert.rejects(post(o.env, '/api/buybox/kural', {...taban, taban: '', cekilme: '', mode: 'aktif'}), /taban ve çekilme/);
  await assert.rejects(post(o.env, '/api/buybox/kural', {...taban, taban: '300', cekilme: '200', mode: 'izle'}), /tabandan yüksek/);
  await assert.rejects(post(o.env, '/api/buybox/kural', {...taban, taban: '179', cekilme: '199', mode: 'aktif'}), /Maliyet girilmedi/);
  await assert.rejects(post(o.env, '/api/buybox/kural', {...taban, taban: '179', cekilme: '199', maliyet: '150', komisyon: '20', mode: 'aktif'}), /zarar sınırının/);
  assert.ok((await post(o.env, '/api/buybox/kural', {...taban, taban: '200', cekilme: '220', maliyet: '150', komisyon: '20', mode: 'aktif'})).kaydedildi);
  await assert.rejects(post(o.env, '/api/buybox/baglanti', {platform: 'ty', magaza: 'Lunapot', seller_id: 'abc', key: 'k', secret: 's'}), /biçimi/);
  await assert.rejects(post(o.env, '/api/buybox/baglanti', {platform: 'zz', magaza: 'Lunapot', seller_id: '1', key: 'k', secret: 's'}), /Platform/);
  const dene = await post(o.env, '/api/buybox/dene', {taban: '179', cekilme: '199', zarar_onay: true, fiyat: '180', rakip: '179', sira: '2'});
  assert.deepEqual([dene.degistir, dene.yeniCents, dene.neden], [true, 19900, 'cekil']);
  assert.equal(o.ham.prepare('SELECT taban_cents t FROM ec_buybox_rules').get().t, 20000, 'deneme kaydetmez');
  const g = await buyboxApi(new Request('https://x/api/buybox'), o.env, '/api/buybox', null);
  assert.ok(!JSON.stringify(g).includes('s3cret') && !JSON.stringify(g).includes('encrypted'));
  assert.equal(g.kurallar[0].sku, 'HBV1');
  assert.equal(g.baglantilar[0].platform, 'hb');
});

test('cron ve yayın ayarı uyumlu', () => {
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(cfg.triggers.crons.includes(BUYBOX_CRON));
});

test('Buybox ayrı çalışma alanıdır: e-ticaret menüsünde yok, kendi kabuğu ve ana ekran kartı var', () => {
  const oku = yol => readFileSync(new URL('../' + yol, import.meta.url), 'utf8');
  for (const dosya of ['public/ecommerce.js', 'public/app.js', 'public/workspace-navigation.js'])
    assert.equal(/buybox/i.test(oku(dosya)), false, dosya + ' içinde buybox izi kalmış');
  assert.ok(oku('public/buybox.html').includes('/buybox-app.js'));
  assert.ok(oku('public/buybox-app.js').includes("import('./buybox-ui.js')"));
  assert.match(oku('src/worker.js'), /path==='\/buybox'\|\|path==='\/buybox\/'/);
  assert.match(oku('public/index.html'), /class="application buybox" href="\/buybox\/"/);
});

test('iki mağazanın API bilgileri ayrı saklanır; başka mağaza adı kabul edilmez; değiştirme yalnız kendi kaydını etkiler', async () => {
  const o = ortam();
  const al = {platform: 'hb', seller_id: 'a'.repeat(8) + '-1111-2222-3333-' + 'b'.repeat(12), key: 'k', secret: 's', user_agent: 'ua'};
  const p = await post(o.env, '/api/buybox/baglanti', {...al, magaza: 'Pazaria'});
  const l = await post(o.env, '/api/buybox/baglanti', {...al, magaza: 'Lunapot', seller_id: 'c'.repeat(8) + '-1111-2222-3333-' + 'd'.repeat(12)});
  assert.notEqual(p.connection_id, l.connection_id);
  await assert.rejects(post(o.env, '/api/buybox/baglanti', {...al, magaza: 'Baska'}), /Mağaza seçilmedi/);
  const sonra = await post(o.env, '/api/buybox/baglanti', {...al, magaza: 'Pazaria', key: 'yeni'});
  assert.equal(sonra.connection_id, p.connection_id);
  assert.equal(o.ham.prepare('SELECT count(*) n FROM ec_buybox_connection').get().n, 2);
});
