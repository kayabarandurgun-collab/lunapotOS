// Rapor Kutusu → Telegram bildirimi. Bir dosyanın işlenmesi bitince kanala tek özet düşer.
// TEMSİLİ test verisi: gerçek Trendyol sütun adları DEĞİLDİR.
// AĞA ÇIKILMAZ: global fetch taklit edilir; testte secret de yoktur, kanal adresleri uydurmadır.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {xlsxBytes} from '../public/doc-engine.js';
import {readTable, sha256Hex} from '../public/xlsx-read.js';

const ORDER_COLUMNS = [
  {header: 'Sipariş No'}, {header: 'Paket No'}, {header: 'Kalem No'}, {header: 'Barkod'}, {header: 'Ürün'},
  {header: 'Adet', type: 'number'}, {header: 'Durum'}, {header: 'Sipariş Tarihi'}, {header: 'Tutar'}, {header: 'Kargo'}
];
const ORDER_MAPPING = {order_no: 'Sipariş No', package_id: 'Paket No', line_id: 'Kalem No', barcode: 'Barkod', product_name: 'Ürün',
  quantity: 'Adet', status: 'Durum', order_date: 'Sipariş Tarihi', gross: 'Tutar', cargo_package: 'Kargo'};
const line = (order, pkg, lineId, gross = '240,00') =>
  [order, pkg, lineId, 'NOVA-1', 'Ürün NOVA-1', 1, 'Kargoda', '01.09.2026', gross, '50,00'];

async function fixture() {
  const f = appFixture(); await f.setup();
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('nova','Nova','NV','adet')");
  const store = async (provider = 'trendyol', code = 'TY-1') => (await f.ok('/ec/reports/stores', {provider, code, name: 'Mağaza ' + code})).id;
  const profile = (kind, columns, mapping) => f.ok('/ec/reports/profiles', {provider: 'trendyol', kind, headers: columns.map(c => c.header), mapping, options: {}});
  async function upload(storeId, rows, name, snapshot = '2026-09-01T10:00') {
    const bytes = new Uint8Array(xlsxBytes([{name: 'Rapor', columns: ORDER_COLUMNS, rows}]));
    const table = await readTable(bytes, {name});
    const created = await f.ok('/ec/reports/files', {store_id: storeId, kind: 'orders', filename: name, size_bytes: bytes.length, sha256: await sha256Hex(bytes), snapshot_at: snapshot,
      sheet: table.sheet, headers: table.headers, date1904: table.date1904, row_count: table.rows.length, chunk_count: 1, warnings: table.warnings});
    await f.ok('/ec/reports/files/' + created.id + '/chunk', {index: 0, data: Buffer.from(bytes).toString('base64')});
    await f.ok('/ec/reports/files/' + created.id + '/rows', {rows: table.rows});
    await f.ok('/ec/reports/files/' + created.id + '/seal', {});
    return created;
  }
  const applyAll = async fileId => { let r; do { r = await f.ok('/ec/reports/files/' + fileId + '/apply', {}); } while (!r.done); return r; };
  return {f, store, profile, upload, applyAll};
}

// Giden her isteği toplayan taklit fetch. `cevap(sira)` bir Error döndürürse ağ hatası,
// {ok:false} döndürürse Telegram'ın reddi taklit edilir.
function telegramTaklidi(cevap = () => ({ok: true, result: {message_id: 1}})) {
  const cagrilar = [], eski = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const govde = JSON.parse(options?.body || '{}');
    cagrilar.push({url: String(url), ...govde});
    const c = cevap(cagrilar.length);
    if (c instanceof Error) throw c;
    return new Response(JSON.stringify(c), {status: c.ok === false ? 400 : 200, headers: {'Content-Type': 'application/json'}});
  };
  return {cagrilar, geri: () => { globalThis.fetch = eski; }};
}
// Bildirim hatası console'a yazılır; test çıktısını kirletmemesi için toplanır.
function sessizKonsol() {
  const kayit = [], eski = console.error;
  console.error = (...a) => kayit.push(a.join(' '));
  return {kayit, geri: () => { console.error = eski; }};
}
const secretler = env => { env.TELEGRAM_BOT_TOKEN = 'test-token'; env.TELEGRAM_CHAT_ORDERS = '-1001'; env.TELEGRAM_CHAT_ERRORS = '-1002'; };

test('Dosya işlenince kanala özet düşer; sıfır sayılar yazılmaz, tekrar apply ikinci bildirim göndermez', async () => {
  const {f, store, profile, upload, applyAll} = await fixture();
  const tg = telegramTaklidi();
  try {
    secretler(f.env);
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    // Üçüncü satır birincinin kimlik tekrarı: incelemeye düşer (uyarı satırı bunun için var).
    const rows = [line('1001', 'P1', 'L1'), line('1002', 'P2', 'L2'), line('1001', 'P1', 'L1')];
    const file = await upload(s, rows, 'eylül_raporu (1).xlsx');
    const r = await applyAll(file.id);
    assert.deepEqual([r.counts.new, r.counts.review], [2, 1]);

    assert.equal(tg.cagrilar.length, 1, 'dosya başına tek bildirim');
    const m = tg.cagrilar[0];
    assert.equal(m.url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.equal(m.chat_id, '-1001', 'özet sipariş kanalına gider');
    assert.equal(m.parse_mode, undefined, 'dosya adındaki (1) ve _ Markdown olarak yorumlanmamalı');
    const satir = m.text.split('\n');
    assert.equal(satir[0], '📥 Trendyol · Mağaza TY-1 — Sipariş raporu işlendi');
    assert.equal(satir[1], 'eylül_raporu (1).xlsx · 3 satır · 2 yeni sipariş');
    assert.equal(satir[2], '⚠️ 1 satır inceleme bekliyor');
    assert.equal(satir.length, 3);
    assert.ok(!/güncellendi|teslim/.test(m.text), 'sıfır olan sayı yazılmaz');

    // ÇİFT BİLDİRİM: zaten işlenmiş dosyaya tekrar apply çağrılırsa applyStep yine done:true döner.
    const tekrar = await f.ok('/ec/reports/files/' + file.id + '/apply', {});
    assert.equal(tekrar.done, true);
    assert.equal(tekrar.already, true, 'bu çağrı gerçek bir tamamlanma değil');
    assert.equal(tg.cagrilar.length, 1, 'işlenmiş dosya ikinci kez bildirilmez');
  } finally { tg.geri(); f.close(); }
});

test('Güncellenen satır ve inceleme yoksa uyarı satırı da yoktur', async () => {
  const {f, store, profile, upload, applyAll} = await fixture();
  const tg = telegramTaklidi();
  try {
    secretler(f.env);
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    await applyAll((await upload(s, [line('2001', 'P1', 'L1')], 'ilk.xlsx')).id);
    // Aynı sipariş yeni tutarla, daha yeni bir raporda: güncellenir.
    await applyAll((await upload(s, [line('2001', 'P1', 'L1', '300,00')], 'ikinci.xlsx', '2026-09-02T10:00')).id);
    assert.equal(tg.cagrilar.length, 2);
    assert.deepEqual(tg.cagrilar.map(m => m.text.split('\n')[1]),
      ['ilk.xlsx · 1 satır · 1 yeni sipariş', 'ikinci.xlsx · 1 satır · 1 sipariş güncellendi']);
    assert.ok(!tg.cagrilar.some(m => m.text.includes('⚠️')), 'inceleme yoksa uyarı satırı yok');
  } finally { tg.geri(); f.close(); }
});

test('Bildirim gidemezse (ağ hatası ya da Telegram reddi) rapor işleme bozulmaz', async () => {
  const {f, store, profile, upload, applyAll} = await fixture();
  const tg = telegramTaklidi(sira => sira === 1 ? new Error('ağa çıkılamadı') : {ok: false, description: 'chat not found'});
  const konsol = sessizKonsol();
  try {
    secretler(f.env);
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const birinci = await applyAll((await upload(s, [line('3001', 'P1', 'L1')], 'aglamayan.xlsx')).id);
    assert.deepEqual([birinci.done, birinci.counts.new], [true, 1]);
    const ikinci = await applyAll((await upload(s, [line('3002', 'P2', 'L2')], 'reddedilen.xlsx')).id);
    assert.deepEqual([ikinci.done, ikinci.counts.new], [true, 1]);
    assert.equal(tg.cagrilar.length, 2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_report_records').get().n, 2, 'kayıtlar yazıldı');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_files WHERE status='applied'").get().n, 2);
    assert.equal(konsol.kayit.length, 2, 'hata yalnızca console\'a yazılır');
  } finally { konsol.geri(); tg.geri(); f.close(); }
});

test('Secret yoksa bildirim sessizce atlanır', async () => {
  const {f, store, profile, upload, applyAll} = await fixture();
  const tg = telegramTaklidi();
  const konsol = sessizKonsol();
  try {
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const r = await applyAll((await upload(s, [line('4001', 'P1', 'L1')], 'secretsiz.xlsx')).id);
    assert.equal(r.counts.new, 1);
    assert.equal(tg.cagrilar.length, 0, 'token/kanal yoksa dışarı çıkılmaz');
    assert.equal(konsol.kayit.length, 0, 'eksik secret hata değildir');
  } finally { konsol.geri(); tg.geri(); f.close(); }
});

test('Beklenmeyen hata, hata kanalına düşer ve asıl hatayı gölgelemez', async () => {
  const {f, store, profile, upload} = await fixture();
  const tg = telegramTaklidi();
  try {
    secretler(f.env);
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const file = await upload(s, [line('5001', 'P1', 'L1')], 'bozuk.xlsx');
    const eskiBatch = f.env.DB.batch;
    f.env.DB.batch = async () => { throw new Error('D1 yazamadı'); };
    const cevap = await f.req('/ec/reports/files/' + file.id + '/apply', {});
    f.env.DB.batch = eskiBatch;
    assert.equal(cevap.status, 500, 'asıl hata yukarı fırlar');
    assert.equal(tg.cagrilar.length, 1);
    assert.equal(tg.cagrilar[0].chat_id, '-1002', 'hata, hata kanalına gider');
    assert.match(tg.cagrilar[0].text, /raporu işlenemedi/);
    assert.match(tg.cagrilar[0].text, /bozuk\.xlsx · D1 yazamadı/);
    assert.equal(f.sqlite.prepare("SELECT status FROM ec_report_files WHERE id=?").get(file.id).status, 'received', 'hiçbir şey yazılmadı');
  } finally { tg.geri(); f.close(); }
});

test('Kullanıcıya gösterilen denetimli uyarı hata kanalını doldurmaz', async () => {
  const {f, store, profile, upload} = await fixture();
  const tg = telegramTaklidi();
  try {
    secretler(f.env);
    const s = await store();
    await profile('orders', ORDER_COLUMNS, ORDER_MAPPING);
    const file = await upload(s, [line('6001', 'P1', 'L1')], 'profilsiz.xlsx');
    // Eşleştirme profili kalkarsa apply 409 ile durur: bu beklenen bir uyarı, ekranda okunur.
    f.sqlite.exec('UPDATE ec_report_files SET profile_id=NULL');
    const cevap = await f.req('/ec/reports/files/' + file.id + '/apply', {});
    assert.equal(cevap.status, 409);
    assert.equal(tg.cagrilar.length, 0, 'denetimli uyarı bildirilmez');
  } finally { tg.geri(); f.close(); }
});
