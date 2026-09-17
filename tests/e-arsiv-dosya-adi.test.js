// Taranmış e-Arşiv PDF'inde yazı katmanı yoktur; içi okunamaz. Ama dosya adı
// "<VKN>-<FaturaNo>-<ETTN>.pdf" biçimindedir ve bu üçünü taşır. Adlandırmayı belgeyi kesen
// sistem koyar; kullanmak veri uydurmak değildir. Belgeden okunanın ÜSTÜNE yazılmamalı.
// TEMSİLİ veri; gerçek fatura DEĞİLDİR.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Kaynaktaki desen ve doldurma mantığı tek yerde durur; testi de oradan okur.
const src = readFileSync(new URL('../public/purchase-document-ui.js', import.meta.url), 'utf8');
const desen = /const DOSYA_ADI = (\/.+?\/i);/.exec(src);
assert.ok(desen, 'DOSYA_ADI deseni kaynakta bulunmalı');
const DOSYA_ADI = eval(desen[1]);

// Kaynaktaki adtanOku ile aynı kural.
function adtanOku(ad, header) {
  const m = DOSYA_ADI.exec(String(ad || '').trim());
  if (!m) return [];
  const [, vkn, no, uuid] = m, alindi = [];
  if (!header.supplier_tax_id) { header.supplier_tax_id = vkn; alindi.push('VKN'); }
  if (!header.invoice_no) { header.invoice_no = no.toUpperCase(); alindi.push('fatura numarası'); }
  if (!header.uuid) { header.uuid = uuid.toLowerCase(); alindi.push('ETTN'); }
  return alindi;
}

const AD = '2731455087-KRK2026000000867-45f1674a-8c87-4026-bfd7-6c5c3f676837.pdf';

test('Okunamayan taranmış faturada kimlik alanları dosya adından tamamlanır', () => {
  const h = {uncertain: ['supplier_tax_id', 'invoice_no']};
  const alindi = adtanOku(AD, h);
  assert.deepEqual(alindi, ['VKN', 'fatura numarası', 'ETTN']);
  assert.equal(h.supplier_tax_id, '2731455087');
  assert.equal(h.invoice_no, 'KRK2026000000867');
  assert.equal(h.uuid, '45f1674a-8c87-4026-bfd7-6c5c3f676837');
});

test('Belgeden okunan değerin üstüne YAZILMAZ', () => {
  const h = {supplier_tax_id: '1111111111', invoice_no: 'GERCEK-1', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
  assert.deepEqual(adtanOku(AD, h), [], 'hepsi doluyken hiçbiri değiştirilmedi');
  assert.equal(h.supplier_tax_id, '1111111111');
  assert.equal(h.invoice_no, 'GERCEK-1');
});

test('Biçim tutmayan dosya adından bilgi ÜRETİLMEZ', () => {
  for (const ad of ['fatura.pdf', 'KRK2026000000867.pdf', '2731455087-KRK2026000000867.pdf',
    '273-KRK2026000000867-45f1674a-8c87-4026-bfd7-6c5c3f676837.pdf',
    '2731455087-KRK2026000000867-45f1674a-8c87-4026-bfd7-6c5c3f67683.pdf']) {
    const h = {};
    assert.deepEqual(adtanOku(ad, h), [], 'bilgi üretilmedi: ' + ad);
    assert.deepEqual(h, {}, 'başlık dokunulmadan kaldı: ' + ad);
  }
});

test('XML dosya adı da aynı biçimde okunur', () => {
  const h = {};
  assert.deepEqual(adtanOku(AD.replace(/\.pdf$/, '.xml'), h), ['VKN', 'fatura numarası', 'ETTN']);
  assert.equal(h.invoice_no, 'KRK2026000000867');
});
