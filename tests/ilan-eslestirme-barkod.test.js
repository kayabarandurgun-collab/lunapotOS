// İLAN EŞLEŞTİRMESİNDE BARKOD ÖNCELİĞİ.
// Canlıda ölçüldü (2026-09-25): 29 Trendyol ilanının stok kodu harfi harfine "merchantSku" —
// satıcı panelinde alan ADI değer olarak girilmiş ve bu ilanlar birbirinden farklı ürünler
// (Torf 2,5 lt / 10 lt / 20 lt …). Eşleştirme barkodla kodu aynı torbaya attığı için o koda
// açılacak TEK bir bağlantı 29 ayrı ürünü aynı stok kartına bağlardı: stok ve kâr sessizce
// yanlış ürüne yazılırdı. Barkod ilana özgüdür, önce o denenir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {componentsFor} from '../src/report-inbox-api.js';

function fixture() {
 const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
 for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
  sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
 const db = {prepare(sql) {return {values: [], bind(...v) {this.values = v; return this;},
  first() {return sqlite.prepare(sql).get(...this.values) || null;},
  all() {return {results: sqlite.prepare(sql).all(...this.values)};},
  run() {return sqlite.prepare(sql).run(...this.values);}};}};
 return {sqlite, db};
}

const urunEkle = (f, id, ad, sku) => f.sqlite.prepare("INSERT INTO ec_products(id,name,sku) VALUES(?,?,?)").run(id, ad, sku);

function baglantiEkle(f, {id, kod, urun, olusturma}) {
 // Bileşenler bağlantı KAPALIYKEN eklenir, sonra etkinleştirilir: etkin bağlantının bileşenleri
 // değiştirilemiyor (ec_catalog_component_insert tetiği). Uygulamanın kendi sırası da budur.
 f.sqlite.prepare("INSERT INTO ec_catalog_mappings(id,source,match_by,match_value,external_code,active,version,created_at) VALUES(?,'trendyol','code',?,?,0,1,?)")
  .run(id, kod, kod, olusturma);
 f.sqlite.prepare("INSERT INTO ec_catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) VALUES(?,?,?,1000,10000)")
  .run('c-' + id, id, urun);
 f.sqlite.prepare("UPDATE ec_catalog_mappings SET active=1 WHERE id=?").run(id);
}

test('barkod bağlantısı varsa ilan koduna açılmış bağlantı kazanamaz', async () => {
 const f = fixture();
 urunEkle(f, 'TORF10', 'Organik Torf 10 lt', 'T10');
 urunEkle(f, 'YANLIS', 'Alakasız Ürün', 'X1');
 // Kod bağlantısı DAHA SONRA açıldı: eski sıralama (created_at DESC) onu seçerdi.
 baglantiEkle(f, {id: 'm-barkod', kod: 'TYB8V4XMGNM28OGU13', urun: 'TORF10', olusturma: '2026-09-01 10:00:00'});
 baglantiEkle(f, {id: 'm-kod', kod: 'merchantSku', urun: 'YANLIS', olusturma: '2026-09-20 10:00:00'});
 const sonuc = await componentsFor(f.db, 'trendyol', {barcode: 'TYB8V4XMGNM28OGU13', sku: 'merchantSku', order_date: '2026-09-24'});
 assert.equal(sonuc.mapping_id, 'm-barkod', 'barkod bağlantısı seçilmeli');
 assert.deepEqual(sonuc.components.map(c => c.product_id), ['TORF10']);
});

test('aynı sahte kodu taşıyan farklı ilanlar kendi barkodlarına bağlanır', async () => {
 const f = fixture();
 urunEkle(f, 'TORF10', 'Organik Torf 10 lt', 'T10');
 urunEkle(f, 'TORF25', 'Organik Torf 2,5 lt', 'T25');
 baglantiEkle(f, {id: 'm-10', kod: 'BARKOD-10', urun: 'TORF10', olusturma: '2026-09-01 10:00:00'});
 baglantiEkle(f, {id: 'm-25', kod: 'BARKOD-25', urun: 'TORF25', olusturma: '2026-09-01 10:00:00'});
 const a = await componentsFor(f.db, 'trendyol', {barcode: 'BARKOD-10', sku: 'merchantSku', order_date: '2026-09-24'});
 const b = await componentsFor(f.db, 'trendyol', {barcode: 'BARKOD-25', sku: 'merchantSku', order_date: '2026-09-24'});
 assert.deepEqual(a.components.map(c => c.product_id), ['TORF10']);
 assert.deepEqual(b.components.map(c => c.product_id), ['TORF25'], 'ikinci ilan birincinin ürününe kaymamalı');
});

test('barkod bağlantısı yoksa ilan kodu hâlâ kullanılır', async () => {
 const f = fixture();
 urunEkle(f, 'PINA', 'Pina Small Saksı', 'PINA-S-BYZ');
 baglantiEkle(f, {id: 'm-kod', kod: 'PINA-S-BYZ', urun: 'PINA', olusturma: '2026-09-01 10:00:00'});
 const sonuc = await componentsFor(f.db, 'trendyol', {barcode: 'BARKOD-YOK', sku: 'PINA-S-BYZ', order_date: '2026-09-24'});
 assert.equal(sonuc.mapping_id, 'm-kod');
});

test('hiç bağlantı yoksa eşleştirme uydurulmaz', async () => {
 const f = fixture();
 assert.equal(await componentsFor(f.db, 'trendyol', {barcode: 'YOK', sku: 'merchantSku', order_date: '2026-09-24'}), null);
 assert.equal(await componentsFor(f.db, 'trendyol', {order_date: '2026-09-24'}), null, 'kod da barkod da yoksa null');
});
