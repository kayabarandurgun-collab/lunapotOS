import test from 'node:test';
import assert from 'node:assert/strict';
import {cartonLabel, cartonLabels, stepIssue, cartonSummary, CARTON_STEPS, CARTON_NOTICE} from '../public/carton-label.js';
import {labelPrintHtml, labelPlan} from '../public/barcode-label.js';

const lot = (extra = {}) => ({
  id: 'l1', lot_code: '2026-09-P001', product_name: 'Saksı Toprağı 5 L', product_sku: 'LP-TOPRAK-5L',
  unit: 'adet', produced_on: '2026-09-10', best_before: '2028-09-10',
  quantity_milli: 600000, pack_size_milli: 12000, status: 'open', printed_cartons: 0, ...extra
});

const carton = (extra = {}) => ({
  id: 'c1', sequence: 3, total_cartons: 50, quantity_milli: 12000, barcode: '8690632012346',
  snapshot: {
    lot_code: '2026-09-P001', product_name: 'Saksı Toprağı 5 L', product_sku: 'LP-TOPRAK-5L',
    produced_on: '2026-09-10', best_before: '2028-09-10', unit: 'adet'
  },
  ...extra
});

test('Koli etiketi barkodu, partiyi ve koli sırasını ayrı ayrı taşır', () => {
  const label = cartonLabel(carton());
  assert.equal(label.code, '8690632012346', 'barkod alanına ÜRÜN barkodu basılır');
  assert.equal(label.title, 'Saksı Toprağı 5 L');
  const rows = Object.fromEntries(label.rows);
  assert.equal(rows['Parti'], '2026-09-P001');
  assert.equal(rows['Koli'], '3 / 50');
  assert.equal(rows['İçindeki'], '12 adet');
  assert.equal(rows['Üretim'], '10.09.2026');
  assert.equal(rows['Son kullanma'], '10.09.2028');
  assert.equal(rows['Ürün kodu'], 'LP-TOPRAK-5L');
  // Parti kodu barkod alanına ASLA girmez.
  assert.notEqual(label.code, '2026-09-P001');
  assert.match(label.subtitle, /Parti kodu ürün barkodu değildir/);
});

test('Etiket basım anındaki görüntüden üretilir; parti sonradan değişse de değişmez', () => {
  const eski = carton();
  const degismis = cartonLabel(eski, {lot: lot({product_name: 'Yeni ad', best_before: '2030-01-01'})});
  assert.equal(degismis.title, 'Saksı Toprağı 5 L', 'dondurulmuş ad korunur');
  assert.equal(Object.fromEntries(degismis.rows)['Son kullanma'], '10.09.2028');
  // Görüntü yoksa parti bilgisi yedek olarak kullanılır.
  const yedek = cartonLabel({...eski, snapshot: undefined}, {lot: lot({product_name: 'Yedek ad'})});
  assert.equal(yedek.title, 'Yedek ad');
});

test('Son kullanma tarihi yoksa satır hiç yazılmaz', () => {
  const label = cartonLabel(carton({snapshot: {...carton().snapshot, best_before: null}}));
  assert.ok(!label.rows.some(([etiket]) => etiket === 'Son kullanma'), 'boş tarih satırı basılmamalı');
});

test('Etiketler sıraya göre üretilir', () => {
  const labels = cartonLabels([carton({sequence: 3}), carton({sequence: 1}), carton({sequence: 2})]);
  assert.deepEqual(labels.map(l => Object.fromEntries(l.rows)['Koli']), ['1 / 50', '2 / 50', '3 / 50']);
  assert.throws(() => cartonLabels([]), /Basılacak koli etiketi yok/);
});

test('Sihirbaz eksik bilgiyle ilerlemez ve nedenini söyler', () => {
  assert.deepEqual(CARTON_STEPS.map(s => s.key), ['lot', 'barcode', 'quantity', 'preview']);
  assert.match(stepIssue('lot', {}), /Bir parti seçin/);
  assert.equal(stepIssue('lot', {lot_id: 'l1'}, {lot: lot()}), null);
  assert.match(stepIssue('lot', {lot_id: 'l1'}, {lot: lot({status: 'closed'})}), /parti kapalı/);
  assert.match(stepIssue('barcode', {lot_id: 'l1'}), /barkodu seçin/);
  assert.match(stepIssue('quantity', {quantity_per_carton: 0, count: 5}), /sıfırdan büyük/);
  assert.match(stepIssue('quantity', {quantity_per_carton: 12, count: 0}), /1 ile 500/);
  assert.equal(stepIssue('quantity', {quantity_per_carton: 12, count: 50}, {lot: lot()}), null);
});

test('Partideki miktarı aşan koli sayısı önce ekranda durdurulur', () => {
  // 600 adet / koli 12 adet = 50 koli. 51. koli için mal yok.
  assert.match(stepIssue('quantity', {quantity_per_carton: 12, count: 51}, {lot: lot()}), /partideki miktarı aşıyor/);
  // Daha önce 48 koli basıldıysa yalnızca 2 koli kalır.
  const kalan = stepIssue('quantity', {quantity_per_carton: 12, count: 3}, {lot: lot({printed_cartons: 48})});
  assert.match(kalan, /48 koli basılmış/);
  assert.equal(stepIssue('quantity', {quantity_per_carton: 12, count: 2}, {lot: lot({printed_cartons: 48})}), null);
});

test('Basmadan önce özet ne basılacağını söyler', () => {
  const ozet = cartonSummary({lot_id: 'l1', barcode: '8690632012346', quantity_per_carton: 12, count: 5}, {lot: lot({printed_cartons: 10})});
  assert.equal(ozet.count, 5);
  assert.equal(ozet.first_sequence, 11);
  assert.equal(ozet.last_sequence, 15);
  assert.equal(ozet.quantity_per_carton_milli, 12000);
  assert.equal(ozet.total_quantity_milli, 60000);
  assert.equal(ozet.already_printed, 10);
  assert.equal(ozet.notice, CARTON_NOTICE);
});

test('Koli etiketi gerçekten basılabilir bir sayfa üretir', () => {
  const html = labelPrintHtml(cartonLabels([carton()]), {size: 'carton'});
  assert.ok(html.includes('class="labels carton"'));
  assert.ok(html.includes('2026-09-P001'), 'parti kodu okunabilir yazılmalı');
  assert.ok(html.includes('3 / 50'), 'koli sırası yazılmalı');
  assert.ok(html.includes('Saksı Toprağı 5 L'));
  assert.ok((html.match(/<rect/g) || []).length > 25, 'gerçek barlar çizilmeli');
  assert.doesNotMatch(html, /\sstyle\s*=/, 'satır içi stil CSP tarafından engellenir');

  const plan = labelPlan({code: '8690632012346', size: 'carton'});
  assert.equal(plan.symbology, 'ean13', 'GS1 barkodu kendi sembolojisiyle basılır');
});

test('Önceki etiketler farklı toplam taşıyorsa kullanıcı uyarılır', () => {
  // 3 koli basildiysa uzerlerinde "1/3" yazar; 4 koli daha basinca yeniler "4/7" der.
  // Bu basilmis kagidin gercegidir ama sahada karisir, o yuzden onceden soylenir.
  const ilk = cartonSummary({quantity_per_carton: 12, count: 3}, {lot: lot()});
  assert.equal(ilk.mixed_totals, null, 'ilk basimda uyari yok');

  const sonraki = cartonSummary({quantity_per_carton: 12, count: 4}, {lot: lot({printed_cartons: 3})});
  assert.match(sonraki.mixed_totals, /"3" toplamı yazıyor/);
  assert.match(sonraki.mixed_totals, /"7" diyecek/);
  assert.match(sonraki.mixed_totals, /tek seferde basın/);
});
