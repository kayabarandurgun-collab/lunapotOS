import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {kaliciIlanKodu} from '../public/orders-ui.js';

// Sipariş ekranındaki "Bu ilanı kalıcı bağla" kutusu yalnız satırın BARKODU doluyken çıkıyordu.
// Rapordan gelen satırda barkod her zaman boş (report-stock-link-api.js:275 ilan kodunu sku'ya
// yazıyor, barcode alanını hiç geçirmiyor), dolayısıyla kutu hiç görünmüyor ve elle yapılan
// eşleştirme hiçbir yere kaydedilmiyordu: aynı ilan her raporda yeniden soruluyordu.
// Canlı ölçüm 06.10.2026: HBV00000ANRQS / HBV00000ANRQT / TYBFFKRDZ781Q2C245, üçünde de barkod ''.

test('barkod varsa anahtar barkoddur', () => {
 assert.equal(kaliciIlanKodu({barcode:'8680000000001',sku:'HBV00000ANRQS'}),'8680000000001');
});

test('barkod yoksa ilan kodu kullanılır — rapordan gelen satırın tek anahtarı budur', () => {
 assert.equal(kaliciIlanKodu({barcode:'',sku:'HBV00000ANRQS'}),'HBV00000ANRQS');
 assert.equal(kaliciIlanKodu({sku:'TYBFFKRDZ781Q2C245'}),'TYBFFKRDZ781Q2C245');
});

// migration 0059: 29 ayrı ilanın kodu harfi harfine "merchantSku". O koda açılacak tek bağlantı
// 29 farklı ürünü aynı stok kartına bağlar ve stoğu kalıcı bozardı.
test('"merchantSku" kodu anahtar sayılmaz', () => {
 assert.equal(kaliciIlanKodu({barcode:'',sku:'merchantSku'}),'');
 assert.equal(kaliciIlanKodu({barcode:'',sku:'MERCHANTSKU'}),'');
 assert.equal(kaliciIlanKodu({barcode:'',sku:' merchantsku '}),'');
 assert.equal(kaliciIlanKodu({barcode:'8680000000002',sku:'merchantSku'}),'8680000000002','barkod varsa yine bağlanır');
 assert.equal(kaliciIlanKodu({barcode:'',sku:'merchantSku-12'}),'merchantSku-12','yalnız birebir eşleşen kod dışlanır');
});

test('kodsuz satırda kutu çıkmaz', () => {
 assert.equal(kaliciIlanKodu({barcode:'',sku:''}),'');
 assert.equal(kaliciIlanKodu({}),'');
 assert.equal(kaliciIlanKodu(null),'');
 assert.equal(kaliciIlanKodu({barcode:'   ',sku:'  '}),'');
});

const ui=readFileSync(new URL('../public/orders-ui.js',import.meta.url),'utf8');

test('kalıcı bağlantı kutusu barkoda değil, anahtara bağlı', () => {
 assert.match(ui,/\$\{kaliciIlanKodu\(l\)\?`<label class="full ol-kalici"/,'kutu kaliciIlanKodu ile açılmalı');
 assert.ok(!/\$\{l\.barcode\?`<label class="full ol-kalici"/.test(ui),'eski l.barcode kapısı kalmamalı');
 assert.match(ui,/data-kod="\$\{esc\(kaliciIlanKodu\(l\)\)\}"/,'anahtar kutuya yazılmalı');
});

// Çoklu paket ilanında bir satış birden çok adet düşürmeli. Başlıktan çıkarım yanılabildiği için
// ("Saksı 2 Adet Hediyeli") adet TAHMİN EDİLMEZ, kullanıcıya sorulur; yanlış kalıcı bağlantı
// stoğu kalıcı bozar.
test('kalıcı bağlantının miktarı sabit 1000 değil, kullanıcının yazdığı adet', () => {
 assert.match(ui,/data-kalici-adet/,'adet kutusu bulunmalı');
 assert.match(ui,/quantity_milli:adet\*1000/,'miktar yazılan adetten gelmeli');
 assert.ok(!/external_code:kalici\.dataset\.barkod/.test(ui),'eski barkod anahtarı kalmamalı');
 assert.match(ui,/adet<1\|\|adet>99/,'adet 1–99 arasında doğrulanmalı');
});
