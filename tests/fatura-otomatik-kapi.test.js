// GÖRÜNTÜDEN OKUNAN FATURANIN OTOMATİK İŞLENME KAPISI.
//
// Bu karar deftere BORÇ ve STOK yazdırır. Model harf hatası yapıyor (canlıda 03.10.2026 aynı
// faturayı üç kez farklı okudu: VKN iki ayrı değer, ETTN üç ayrı değer, fatura no bir fazla hane).
// Bu yüzden "kesin değil" işaretleri kaldırılmadı; onun yerine MODELDEN BAĞIMSIZ üç doğrulama
// aranıyor. Buradaki testlerin işi, o üçünden biri eksikken belgenin GEÇMEDİĞİNİ sabitlemek.
import test from 'node:test';
import assert from 'node:assert/strict';
import {otomatikEngelKarari} from '../public/purchase-document-ui.js';

// Canlıdan gelen gerçek fatura: satırların toplamı belgenin kendi ara toplamıyla birebir.
const temel = () => ({
  ocr: true, supplierId: 's1', formatWarning: '',
  header: {invoice_no: 'KRK2026000000902', invoice_date: '2026-09-30', uncertain: ['invoice_no', 'supplier_tax_id']},
  lines: [
    {description: 'Gartengold 20 Litre Torfu', invoice_quantity: 15, net: 2850, uncertain: ['net']},
    {description: 'Gartengold 5 Litre Torfu', invoice_quantity: 5, net: 300, uncertain: ['net']},
    {description: 'Gartengold 2.5 Litre Torfu', invoice_quantity: 5, net: 165, uncertain: ['net']},
    {description: 'Gartengold 10 Litre Torfu', invoice_quantity: 5, net: 550, uncertain: ['net']}],
  totals: {net: 3865, tax: null}
});

test('Üç doğrulama da tutuyorsa görüntüden okunan fatura otomatik işlenir', () => {
  assert.equal(otomatikEngelKarari(temel()), null);
});

test('Üç doğrulamadan biri eksikse otomatik işlenmez', () => {
  // 1) Tedarikçi VKN kayıtlı bir tedarikçiye eşleşmediyse.
  assert.match(otomatikEngelKarari({...temel(), supplierId: null}), /kesin okunamayan/);
  // 2) Fatura numarası tedarikçinin kalıbından sapıyorsa (sunucu uyarısı).
  assert.match(otomatikEngelKarari({...temel(), formatWarning: 'FARKLI biçimde'}), /kesin okunamayan/);
  // 3) Satırların toplamı belgenin kendi toplamını tutmuyorsa — EN GÜÇLÜ kanıt budur.
  const bozuk = temel(); bozuk.lines[0].net = 2851;
  assert.match(otomatikEngelKarari(bozuk), /toplamla tutmuyor/);
});

test('Görüntüden okunmamış belgede gevşetme UYGULANMAZ', () => {
  // Harf taşıyan belgede "kesin değil" işareti gerçek bir okuma sorunudur; eskisi gibi durdurur.
  assert.match(otomatikEngelKarari({...temel(), ocr: false}), /kesin okunamayan/);
});

test('Gevşetme yalnız "kesin değil" işaretini kaldırır; eksik veri kontrolleri yerinde kalır', () => {
  assert.match(otomatikEngelKarari({...temel(), header: {...temel().header, invoice_no: ''}}), /numarası veya tarihi/);
  assert.match(otomatikEngelKarari({...temel(), header: {...temel().header, invoice_date: ''}}), /numarası veya tarihi/);
  assert.match(otomatikEngelKarari({...temel(), lines: []}), /Satır okunamadı/);
  const miktarsiz = temel(); miktarsiz.lines[1].invoice_quantity = 0;
  assert.match(otomatikEngelKarari(miktarsiz), /eksik alan/);
  const tutarsiz = temel(); tutarsiz.lines[1].net = null;
  assert.match(otomatikEngelKarari(tutarsiz), /eksik alan/);
  assert.match(otomatikEngelKarari({...temel(), totals: {net: null}}), /toplam okunamadı/);
  // Kendi kestiğimiz fatura hiçbir koşulda alış olarak işlenmez.
  assert.match(otomatikEngelKarari({...temel(), header: {...temel().header, own_issued: true}}), /şirketiniz kesmiş/);
});
