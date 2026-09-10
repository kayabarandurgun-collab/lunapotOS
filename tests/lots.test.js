import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';

const gun = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const BUGUN = gun(0);

async function fixture() {
  const f = appFixture(); await f.setup();
  f.sqlite.exec("INSERT INTO products(id,name,sku,stock_unit) VALUES('urun','Saksı Toprağı 5 L','LP-TOPRAK-5L','adet'),('diger','Perlit Torbası','LP-PERLIT','adet')");
  f.sqlite.exec("INSERT INTO lp_barcodes(id,code,target_kind,product_id,source,brand) VALUES('b1','8690632012346','product','urun','gs1','Lunapot')");
  return {f, urun: 'urun', diger: 'diger'};
}

const parti = (extra = {}) => ({product_id: 'urun', produced_on: BUGUN, quantity: 600, pack_size: 12, note: 'Sabah vardiyası', ...extra});

test('Parti kodu otomatik üretilir ve ürüne bağlanır', async () => {
  const {f} = await fixture(); try {
    const lot = await f.ok('/lp/lots', parti());
    assert.equal(lot.lot_code, BUGUN.slice(0, 7) + '-P001');
    assert.equal(lot.product_name, 'Saksı Toprağı 5 L');
    assert.equal(lot.quantity_milli, 600000);
    assert.equal(lot.pack_size_milli, 12000);
    assert.equal(lot.unit, 'adet');
    assert.equal(lot.status, 'open');
    assert.equal(lot.printed_cartons, 0);

    const ikinci = await f.ok('/lp/lots', parti());
    assert.equal(ikinci.lot_code, BUGUN.slice(0, 7) + '-P002', 'sıra ilerlemeli');

    const kendi = await f.ok('/lp/lots', parti({lot_code: 'VARDIYA-A-01'}));
    assert.equal(kendi.lot_code, 'VARDIYA-A-01', 'kendi kodunu yazabilmeli');
    assert.equal((await f.req('/lp/lots', parti({lot_code: 'VARDIYA-A-01'}))).status, 409, 'aynı parti kodu iki kez olamaz');
  } finally { f.close(); }
});

test('Parti kodu ürün barkodundan ayrıdır ve karışmaz', async () => {
  const {f} = await fixture(); try {
    const lot = await f.ok('/lp/lots', parti());
    // Parti kodu barkod tablosunda aranınca bulunmaz: ikisi ayrı kimliklerdir.
    assert.equal((await f.ok('/lp/barcodes/lookup?code=' + encodeURIComponent(lot.lot_code))).found, false);
    // Ürünün barkodu ise partiden bağımsız olarak bulunur.
    const okuma = await f.ok('/lp/barcodes/lookup?code=8690632012346');
    assert.equal(okuma.found, true);
    assert.equal(okuma.link.card_name, 'Saksı Toprağı 5 L');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) c FROM lp_barcodes').get().c, 1, 'parti açmak barkod oluşturmamalı');
  } finally { f.close(); }
});

test('Parti açmak ve etiket basmak stok hareketi üretmez', async () => {
  const {f} = await fixture(); try {
    const once = f.sqlite.prepare('SELECT COUNT(*) c FROM lp_material_movements').get().c;
    const lot = await f.ok('/lp/lots', parti());
    await f.ok(`/lp/lots/${lot.id}/cartons`, {count: 5});
    const sonra = f.sqlite.prepare('SELECT COUNT(*) c FROM lp_material_movements').get().c;
    assert.equal(sonra, once, 'parti ve koli etiketi stok hareketi oluşturmamalı');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) c FROM lp_production_jobs').get().c, 0, 'üretim işi de oluşmamalı');
  } finally { f.close(); }
});

test('Koli etiketleri sırayla numaralanır ve toplamı taşır', async () => {
  const {f} = await fixture(); try {
    const lot = await f.ok('/lp/lots', parti());
    const ilk = await f.ok(`/lp/lots/${lot.id}/cartons`, {count: 3});
    assert.deepEqual(ilk.printed.map(c => c.sequence), [1, 2, 3]);
    assert.ok(ilk.printed.every(c => c.total_cartons === 3));
    assert.ok(ilk.printed.every(c => c.quantity_milli === 12000), 'koli içi adet partiden gelir');
    assert.ok(ilk.printed.every(c => c.barcode === '8690632012346'), 'ürünün barkodu basılır');

    const devam = await f.ok(`/lp/lots/${lot.id}/cartons`, {count: 2});
    assert.deepEqual(devam.printed.map(c => c.sequence), [4, 5], 'numaralar kaldığı yerden devam eder');
    assert.equal(devam.cartons.length, 5);
    assert.ok(devam.printed.every(c => c.total_cartons === 5), 'toplam koli sayısı güncellenir');
    assert.match(devam.notice, /değiştirilemez ve silinemez/);
  } finally { f.close(); }
});

test('Basılan koli miktarı partideki miktarı aşamaz', async () => {
  const {f} = await fixture(); try {
    // 600 adet / koli 12 adet = en fazla 50 koli.
    const lot = await f.ok('/lp/lots', parti());
    await f.ok(`/lp/lots/${lot.id}/cartons`, {count: 50});
    const fazla = await f.req(`/lp/lots/${lot.id}/cartons`, {count: 1});
    assert.equal(fazla.status, 409);
    assert.match(fazla.data.error, /partideki miktarı aşıyor/);
  } finally { f.close(); }
});

test('Basılmış etiket değiştirilemez, silinemez; kapalı partiye basılamaz', async () => {
  const {f} = await fixture(); try {
    const lot = await f.ok('/lp/lots', parti());
    const basim = await f.ok(`/lp/lots/${lot.id}/cartons`, {count: 2});
    const etiket = basim.printed[0].id;
    assert.throws(() => f.sqlite.exec(`UPDATE lp_carton_labels SET quantity_milli=1 WHERE id='${etiket}'`), /CARTON_IMMUTABLE/);
    assert.throws(() => f.sqlite.exec(`DELETE FROM lp_carton_labels WHERE id='${etiket}'`), /IMMUTABLE_LEDGER/);
    assert.throws(() => f.sqlite.exec(`UPDATE lp_lots SET lot_code='BASKA' WHERE id='${lot.id}'`), /LOT_IMMUTABLE/);

    assert.equal((await f.req('/lp/lots/' + lot.id, {status: 'closed'})).status, 400, 'gerekçesiz kapatılamaz');
    await f.ok('/lp/lots/' + lot.id, {status: 'closed', status_note: 'Sevkiyat tamamlandı.'});
    const kapali = await f.req(`/lp/lots/${lot.id}/cartons`, {count: 1});
    assert.equal(kapali.status, 409, 'kapalı partiye etiket basılamaz');

    // Kapanmis parti yeniden acilabilir ama SESSIZCE degil: gerekce kayda gecer.
    assert.equal((await f.req('/lp/lots/' + lot.id, {status: 'open'})).status, 400, 'gerekçesiz yeniden açılamaz');
    const acildi = await f.ok('/lp/lots/' + lot.id, {status: 'open', status_note: 'Eksik koli çıktı, sayım yeniden yapıldı.'});
    assert.equal(acildi.status, 'open');
    assert.equal(acildi.status_note, 'Eksik koli çıktı, sayım yeniden yapıldı.');
  } finally { f.close(); }
});

test('Barkodu olmayan ürüne koli etiketi basılmaz; başka ürünün barkodu kullanılamaz', async () => {
  const {f} = await fixture(); try {
    const barkodsuz = await f.ok('/lp/lots', parti({product_id: 'diger'}));
    const sonuc = await f.req(`/lp/lots/${barkodsuz.id}/cartons`, {count: 1});
    assert.equal(sonuc.status, 409);
    assert.match(sonuc.data.error, /tanımlı barkodu yok/);

    const lot = await f.ok('/lp/lots', parti());
    const yanlis = await f.req(`/lp/lots/${lot.id}/cartons`, {count: 1, barcode: '4006381333931'});
    assert.equal(yanlis.status, 404, 'tanımsız barkod kabul edilmez');
  } finally { f.close(); }
});

test('Parti girdileri doğrulanır', async () => {
  const {f} = await fixture(); try {
    assert.equal((await f.req('/lp/lots', parti({product_id: 'yok'}))).status, 404);
    assert.equal((await f.req('/lp/lots', parti({quantity: 0}))).status, 400);
    assert.equal((await f.req('/lp/lots', parti({quantity: -5}))).status, 400);
    assert.equal((await f.req('/lp/lots', parti({produced_on: '2026-13-01'}))).status, 400);
    assert.equal((await f.req('/lp/lots', parti({best_before: gun(-30)}))).status, 400, 'son kullanma üretimden önce olamaz');
    assert.equal((await f.req('/lp/lots', parti({lot_code: '-kotu kod'}))).status, 400);
    const lot = await f.ok('/lp/lots', parti());
    assert.equal((await f.req(`/lp/lots/${lot.id}/cartons`, {count: 0})).status, 400);
    assert.equal((await f.req(`/lp/lots/${lot.id}/cartons`, {count: 501})).status, 400);
  } finally { f.close(); }
});

test('Parti ekranı çalışma alanına ve yetkiye uyar', async () => {
  const {f} = await fixture(); try {
    assert.equal((await f.req('/ec/lots')).status, 403, 'parti yalnızca üretim modülünde');
    const lot = await f.ok('/lp/lots', parti());

    const depo = await f.ok('/admin/users', {name: 'Üretim', username: 'uretim', permissions: {ec: {}, lp: {production: 'write'}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: depo.invite_path.split('invite=')[1], password: 'uretim-personel-sifresi'});
    const login = await f.req('/auth/login', {username: 'uretim', password: 'uretim-personel-sifresi'});
    assert.equal((await f.req(`/lp/lots/${lot.id}/cartons`, {count: 1}, login.cookie)).status, 200);

    const okuyucu = await f.ok('/admin/users', {name: 'Reçeteci', username: 'recete', permissions: {ec: {}, lp: {recipes: 'read'}, delete_records: false}});
    await f.req('/auth/accept-invite', {token: okuyucu.invite_path.split('invite=')[1], password: 'recete-personel-sifresi'});
    const okuyucuLogin = await f.req('/auth/login', {username: 'recete', password: 'recete-personel-sifresi'});
    assert.equal((await f.req('/lp/lots', undefined, okuyucuLogin.cookie)).status, 200, 'ürün görebilen partiyi görebilir');
    assert.equal((await f.req('/lp/lots', parti(), okuyucuLogin.cookie)).status, 403, 'okuma yetkisi parti açamaz');
  } finally { f.close(); }
});
