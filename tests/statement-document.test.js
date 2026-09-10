import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStatement, counterpartyDifference} from '../public/party-statement.js';
import {statementBlocks, statementPdfDocument, statementSheets, statementCsvRows, statementPrintHtml, balanceSentence, balancePhrase, differenceSentence, money} from '../public/statement-document.js';
import {xlsxBytes, docxBytes, csvBytes, pdfBytes, keyValuePairs, tableColumns} from '../public/doc-engine.js';
import {pdfKit} from './helpers/pdf-kit.js';

const entry = (id, occurred_on, amount_cents, extra = {}) =>
  ({id, occurred_on, amount_cents, reference: 'REF-' + id, description: 'Hareket ' + id, source: 'manual', created_at: occurred_on + 'T09:00:00Z', ...extra});

function payload(overrides = {}) {
  const statement = buildStatement({
    entries: [entry('devir', '2025-12-01', 30000), entry('a', '2026-01-05', 1234567, {due_on: '2026-02-05'}), entry('b', '2026-01-20', -234567)],
    from: '2026-01-01', to: '2026-01-31'
  });
  return {
    party: {name: 'Şişli Çiçekçilik Ltd. Şti.', tax_id: '1234567890'},
    workspace: 'ec',
    statement,
    difference: counterpartyDifference({closing_cents: statement.closing_cents, reported_cents: null}),
    meta: {},
    notice: 'Bu belge resmî fatura değildir.',
    ...overrides
  };
}

test('Belge özeti devir, dönem ve kapanışı aynı sayılarla anlatır', () => {
  const data = payload();
  assert.equal(data.statement.closing_cents, 1030000);
  const blocks = statementBlocks(data);
  const summary = blocks.find(b => b.type === 'keyvalue' && b.pairs.some(([label]) => label === 'Devir'));
  assert.deepEqual(summary.pairs.find(([label]) => label === 'Devir'), ['Devir', money(30000)]);
  assert.deepEqual(summary.pairs.find(([label]) => label === 'Dönem sonu bakiye'), ['Dönem sonu bakiye', money(1030000)]);
  const rows = blocks.find(b => b.type === 'table').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], '05.01.2026', 'tarihler belgede Türkçe biçimde yazılır');
  assert.equal(rows[0][1], '05.02.2026');
  assert.equal(rows[1][1], '—', 'vadesi olmayan satır boş bırakılmaz');
  assert.equal(rows.at(-1)[6], money(1030000), 'son satırın yürüyen bakiyesi kapanışa eşit');
});

test('Bildirim yokken belge sıfır fark yazmaz, kabul anlamına gelmediğini söyler', () => {
  const blocks = statementBlocks(payload());
  const texts = blocks.filter(b => b.type === 'text' || b.type === 'small').map(b => b.text).join(' ');
  assert.match(texts, /sıfır değil, bilinmiyor/);
  assert.match(texts, /indirilmekle veya iletilmekle kabul edilmiş sayılmaz/);
  // Ek ünlü uyumuna uymalı: "alacağımızdır" ama "borcumuzdur".
  assert.match(balanceSentence(1030000), /bizim alacağımızdır\.$/);
  assert.match(balanceSentence(-500), /bizim borcumuzdur\.$/);
  assert.match(balanceSentence(0), /bakiye kalmamıştır/);
  // Yön kelimeyle söylenir; ekranda çıplak eksili tutar kalmaz.
  assert.equal(balancePhrase(-1014090), money(1014090) + ' bizim borcumuz');
  assert.equal(balancePhrase(1014090), money(1014090) + ' bizim alacağımız');
  assert.equal(balancePhrase(0), 'bakiye yok');
  assert.equal(balancePhrase(null), money(null));
});

test('Defter belgeden sonra değiştiyse uyarı her çıktıda görünür', () => {
  const data = payload({meta: {document_no: 'MUT-2026-0001', revision: 1, status: 'sent', ledger_changed: true}});
  assert.match(statementBlocks(data).map(b => b.text || '').join(' '), /Belge değiştirilmemiştir/);
  assert.match(statementPrintHtml(data), /Belge değiştirilmemiştir/);
  assert.match(statementPdfDocument(data).subtitle, /MUT-2026-0001/);
});

test('Tutar yetkisi kapalıyken belge sıfır değil "yetkiniz yok" yazar', () => {
  const data = payload();
  const hidden = {
    ...data,
    statement: {
      ...data.statement, opening_cents: null, debit_cents: null, credit_cents: null, closing_cents: null,
      rows: data.statement.rows.map(r => ({...r, receivable_cents: null, payable_cents: null, running_cents: null}))
    }
  };
  const rows = statementBlocks(hidden).find(b => b.type === 'table').rows;
  assert.equal(rows[0][4], 'Görme yetkiniz yok');
  assert.equal(rows[0][6], 'Görme yetkiniz yok');
  assert.match(balanceSentence(null), /yetkiniz yok/);
  assert.equal(statementSheets(hidden)[1].rows[0][4], '', 'Excel sayı sütununda gizli tutar sıfıra dönmemeli');
  assert.equal(statementCsvRows(hidden)[1][6], '');
  assert.doesNotMatch(statementPrintHtml(hidden), /₺0,00/);
});

test('Karşı taraf bildirdiğinde fark cümlesi ve özet satırı belgeye girer', () => {
  const base = payload();
  const difference = counterpartyDifference({closing_cents: base.statement.closing_cents, reported_cents: -1000000, perspective: 'theirs'});
  const data = payload({difference, meta: {document_no: 'MUT-2026-0001', revision: 2, status: 'disputed'}});
  // Bizde 10.300,00 alacak, karşı taraf 10.000,00 borç bildirdi: fark 300,00.
  assert.match(differenceSentence(difference), /₺300,00 fark/);
  const summary = statementBlocks(data).find(b => b.type === 'keyvalue' && b.pairs.some(([l]) => l === 'Devir'));
  assert.deepEqual(summary.pairs.find(([l]) => l === 'Karşı tarafın bildirdiği bakiye'), ['Karşı tarafın bildirdiği bakiye', money(1000000)]);
  assert.ok(summary.pairs.some(([l, v]) => l === 'Belge durumu' && v === 'İhtilaflı'));
});

test('Excel, CSV ve Word aynı ekstreden tutarlı üretilir', () => {
  const data = payload();
  const sheets = statementSheets(data);
  assert.deepEqual(sheets.map(s => s.name), ['Özet', 'Hareketler']);
  assert.equal(sheets[1].rows[0][0], '2026-01-05', 'Excel tarih sütunu ISO değer alır, biçimi hücre verir');
  assert.equal(sheets[1].rows[0][4], 12345.67, 'Excel tutarı gerçek sayı olmalı');
  assert.equal(sheets[1].rows[1][5], 2345.67);
  assert.equal(sheets[1].rows.at(-1)[6], 10300);

  const csv = new TextDecoder().decode(csvBytes(statementCsvRows(data)));
  assert.ok(csv.split('\r\n')[1].includes('12345,67'), 'CSV tutarı Türkçe ondalık ayırıcıyla sayı kalmalı');

  const docx = docxBytes(statementBlocks(data), {footer: data.notice});
  assert.ok(docx.length > 1000);
  assert.equal(new TextDecoder().decode(docx.slice(0, 2)), 'PK', 'Word paketi geçerli bir zip olmalı');

  const xlsx = xlsxBytes(sheets);
  assert.equal(new TextDecoder().decode(xlsx.slice(0, 2)), 'PK');
});

test('Özet ve başlık satırı PDF ile Word arasında kaybolmaz', () => {
  // PDF etiket/değer bloğunu bir noktada block.rows, belge ise block.pairs adıyla veriyordu:
  // blok sessizce boş çiziliyor ve özet PDF'te hiç görünmüyordu.
  const blocks = statementBlocks(payload());
  for (const block of blocks.filter(b => b.type === 'keyvalue'))
    assert.ok(keyValuePairs(block).length > 0, 'etiket/değer bloğu her biçimde okunabilmeli');
  const columns = tableColumns(blocks.find(b => b.type === 'table'));
  assert.deepEqual(columns.map(c => c.header), ['Tarih', 'Vade', 'Referans', 'Açıklama', 'Alacağımız', 'Borcumuz', 'Bakiye']);
  assert.ok(columns.every(c => c.width > 0), 'PDF sütun genişlikleri eşit dağılmasın');
  const docx = new TextDecoder().decode(docxBytes(blocks, {footer: ''}));
  assert.ok(docx.includes('Dönem sonu bakiye'), 'özet Word belgesine de girmeli');
  assert.ok(docx.includes('Alacağımız'), 'tablo başlıkları Word belgesine de girmeli');
});

test('PDF gerçekten üretilir ve mutabakat metnini taşır', async () => {
  const bytes = await pdfBytes(statementPdfDocument(payload({meta: {document_no: 'MUT-2026-0001', revision: 1, status: 'sent'}})), await pdfKit());
  assert.equal(new TextDecoder('latin1').decode(bytes.slice(0, 5)), '%PDF-');
  assert.ok(bytes.length > 3000);
});
