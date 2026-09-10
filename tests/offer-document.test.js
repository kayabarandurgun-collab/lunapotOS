import test from 'node:test';
import assert from 'node:assert/strict';
import {offerTotals} from '../public/offer-math.js';
import {offerBlocks, offerPdfDocument, offerSheets, offerCsvRows, offerPrintHtml, statusName, kindName, money} from '../public/offer-document.js';
import {xlsxBytes, docxBytes, csvBytes, pdfBytes, keyValuePairs, tableColumns} from '../public/doc-engine.js';
import {pdfKit} from './helpers/pdf-kit.js';

const BUGUN = '2026-09-10';

function payload(overrides = {}) {
  const totals = offerTotals([
    {description: 'Terracotta saksı 30 cm', unit: 'adet', quantity_milli: 40000, unit_price_cents: 12550, vat_bps: 2000, discount_bps: 1000},
    {description: 'Toprak 20 L', unit: 'çuval', quantity_milli: 100000, unit_price_cents: 8900, vat_bps: 1000}
  ]);
  const offer = {kind: 'quote', document_no: 'TKF-2026-0007', revision: 2, status: 'sent', ...overrides.offer};
  return {
    offer,
    snapshot: {
      party: {name: 'Şişli Çiçekçilik Ltd. Şti.', tax_id: '1234567890'},
      workspace: 'ec', kind: offer.kind, title: 'Bahar sezonu saksı teklifi',
      issue_date: '2026-09-01', valid_until: offer.kind === 'contract' ? null : '2026-09-30',
      terms: 'Teslim: 15 iş günü.\nFiyatlar fabrika teslimdir.',
      currency: 'TRY', totals,
      notice: 'Bu belge bir ticari tekliftir; resmî fatura değildir. İndirilmesi, yazdırılması veya iletilmesi kabul ya da imza anlamına gelmez.',
      ...overrides.snapshot
    },
    today: overrides.today || BUGUN
  };
}

test('Belge satırları miktar, iskonto ve KDV ile birlikte yazılır', () => {
  const data = payload();
  const table = offerBlocks(data).find(b => b.type === 'table');
  assert.deepEqual(tableColumns(table).map(c => c.header), ['Açıklama', 'Miktar', 'Birim fiyat', 'İskonto', 'Net', 'KDV', 'Toplam']);
  assert.equal(table.rows[0][1], '40 adet');
  assert.equal(table.rows[0][2], money(12550));
  assert.equal(table.rows[0][3], '%10');
  assert.equal(table.rows[1][3], '—', 'iskontosuz satır boş bırakılmaz');
  assert.equal(table.rows[1][5], '%10');
});

test('Tutar özeti KDV oranı başına ayrışır ve genel toplamla biter', () => {
  const summary = offerBlocks(payload()).filter(b => b.type === 'keyvalue').at(-1);
  const pairs = keyValuePairs(summary);
  assert.deepEqual(pairs.at(-1)[0], 'Genel toplam');
  assert.ok(pairs.some(([l]) => l === 'KDV %20'));
  assert.ok(pairs.some(([l]) => l === 'KDV %10'));
  assert.ok(pairs.some(([l]) => l === 'İskonto'));
  const totals = payload().snapshot.totals;
  assert.equal(pairs.at(-1)[1], money(totals.total_cents));
});

test('Kabul uyarısı ve durum her belgede görünür', () => {
  const data = payload();
  assert.match(offerBlocks(data).map(b => b.text || '').join(' '), /kabul ya da imza anlamına gelmez/);
  assert.match(offerPrintHtml(data), /kabul ya da imza anlamına gelmez/);
  // Geçerlilik günü hem satırda hem dondurulmuş görüntüde bulunabilir; belge ikisini
  // birleştirip okur, yoksa "süresi doldu" demeyi sessizce atlardı.
  const headings = offerBlocks(data).find(b => b.type === 'keyvalue');
  assert.deepEqual(keyValuePairs(headings).find(([l]) => l === 'Durum'), ['Durum', 'Yanıt bekleniyor']);
  const late = offerBlocks({...data, today: '2026-10-01'}).find(b => b.type === 'keyvalue');
  assert.deepEqual(keyValuePairs(late).find(([l]) => l === 'Durum'), ['Durum', 'Süresi doldu']);
  assert.equal(statusName({status: 'sent', valid_until: '2026-09-30'}, '2026-10-01'), 'Süresi doldu');
  assert.equal(statusName({status: 'accepted', valid_until: '2026-09-30'}, '2026-10-01'), 'Kabul edildi');
});

test('Sözleşmede imza alanı vardır, teklifte yoktur', () => {
  const contract = payload({offer: {kind: 'contract', document_no: 'SZL-2026-0001', revision: 1, status: 'sent'}});
  assert.match(offerPrintHtml(contract), /kaşe ve imza/);
  assert.ok(offerBlocks(contract).some(b => b.type === 'keyvalue' && keyValuePairs(b).some(([l]) => l.includes('kaşe ve imza'))));
  assert.doesNotMatch(offerPrintHtml(payload()), /kaşe ve imza/);
  assert.equal(kindName('contract'), 'Sözleşme');
  assert.equal(kindName('proforma'), 'Proforma fatura');
});

test('Tutar yetkisi kapalıyken belge sıfır değil "yetkiniz yok" yazar', () => {
  const base = payload();
  const hidden = {
    ...base,
    snapshot: {
      ...base.snapshot,
      totals: {
        ...base.snapshot.totals,
        gross_cents: null, discount_cents: null, net_cents: null, vat_cents: null, total_cents: null,
        vat_breakdown: base.snapshot.totals.vat_breakdown.map(v => ({...v, net_cents: null, vat_cents: null})),
        rows: base.snapshot.totals.rows.map(r => ({...r, unit_price_cents: null, net_cents: null, vat_cents: null, total_cents: null}))
      }
    }
  };
  const table = offerBlocks(hidden).find(b => b.type === 'table');
  assert.equal(table.rows[0][2], 'Görme yetkiniz yok');
  assert.equal(table.rows[0][1], '40 adet', 'miktar görünmeye devam eder');
  assert.equal(offerSheets(hidden)[1].rows[0][3], '', 'Excel sayı sütununda gizli tutar sıfıra dönmez');
  assert.equal(offerCsvRows(hidden)[1][8], '');
  assert.doesNotMatch(offerPrintHtml(hidden), /₺0,00/);
});

test('Excel, CSV ve Word aynı belgeden tutarlı üretilir', () => {
  const data = payload();
  const sheets = offerSheets(data);
  assert.deepEqual(sheets.map(s => s.name), ['Belge', 'Satırlar']);
  assert.equal(sheets[1].rows[0][2], 40, 'Excel miktarı gerçek sayı olmalı');
  assert.equal(sheets[1].rows[0][3], 125.5);
  assert.equal(sheets[1].rows[0][4], 10, 'iskonto yüzde olarak yazılır');
  assert.equal(sheets[1].rows[1][8], 9790);

  const csv = new TextDecoder().decode(csvBytes(offerCsvRows(data)));
  assert.ok(csv.split('\r\n')[1].includes('125,5'), 'CSV Türkçe ondalık ayırıcı kullanır');

  const docx = new TextDecoder().decode(docxBytes(offerBlocks(data), {footer: ''}));
  assert.ok(docx.includes('Genel toplam'), 'özet Word belgesine girmeli');
  assert.ok(docx.includes('Birim fiyat'), 'tablo başlıkları Word belgesine girmeli');
  assert.ok(docx.includes('Fiyatlar fabrika teslimdir'), 'koşullar Word belgesine girmeli');

  assert.equal(new TextDecoder().decode(xlsxBytes(sheets).slice(0, 2)), 'PK');
});

test('PDF gerçekten üretilir', async () => {
  const bytes = await pdfBytes(offerPdfDocument(payload()), await pdfKit());
  assert.equal(new TextDecoder('latin1').decode(bytes.slice(0, 5)), '%PDF-');
  assert.ok(bytes.length > 3000);
});
