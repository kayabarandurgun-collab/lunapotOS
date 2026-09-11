import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {labelsPdfBytes} from '../public/label-pdf.js';
import {cartonLabels} from '../public/carton-label.js';

// PDF, tarayıcı API'si olmadan doğrulanabilsin diye kit dışarıdan verilir (doc-engine testindeki yöntem).
async function kit() {
  const lib = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  return {lib, fontkit, fontBytes: readFileSync(new URL('../public/vendor/NotoSans-tr.ttf', import.meta.url))};
}
const MM = 72 / 25.4;
const lot = {lot_code: '2026-09-P001', product_name: 'Luna Saksı Gümüş Işıltı', product_sku: 'LN-S-01', unit: 'adet', produced_on: '2026-09-11', best_before: null};
const cartons = [2, 1].map(sequence => ({sequence, total_cartons: 2, quantity_milli: 12000, barcode: '4006381333931', snapshot: {}}));

test('Koli etiketleri her biri kendi ölçüsünde bir PDF sayfasıdır; sıra korunur', async () => {
  const k = await kit();
  const bytes = await labelsPdfBytes(cartonLabels(cartons, {lot}), {size: 'carton'}, k);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const doc = await k.lib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
  const {width, height} = doc.getPage(0).getSize();
  assert.ok(Math.abs(width - 100 * MM) < 0.01 && Math.abs(height - 70 * MM) < 0.01, '100 × 70 mm');
});

test('Türkçe harfli ürün adı ve Code 128 iç kodu da PDF’e yazılır', async () => {
  const k = await kit();
  const bytes = await labelsPdfBytes([{code: 'LP-000123', title: 'Şeffaf Çiçek Toprağı Ğ İ ı', rows: [['Parti', 'VARDIYA-A-01']], subtitle: 'Parti kodu ürün barkodu değildir.'}], {size: 'large'}, k);
  const doc = await k.lib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});

test('Boş liste ve geçersiz boyut reddedilir; içerik sığmıyorsa daha büyük etiket istenir', async () => {
  const k = await kit();
  await assert.rejects(labelsPdfBytes([], {size: 'carton'}, k), /etiket yok/);
  await assert.rejects(labelsPdfBytes(cartonLabels(cartons, {lot}), {size: 'dev'}, k), /boyutu geçersiz/);
  const crowded = {code: '4006381333931', title: 'X', rows: Array.from({length: 8}, (_, i) => ['Satır ' + i, 'değer']), subtitle: 'not'};
  await assert.rejects(labelsPdfBytes([crowded], {size: 'small'}, k), /Daha büyük etiket/);
});
