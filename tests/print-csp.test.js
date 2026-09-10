import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStatement, counterpartyDifference} from '../public/party-statement.js';
import {statementPrintHtml} from '../public/statement-document.js';
import {offerTotals} from '../public/offer-math.js';
import {offerPrintHtml} from '../public/offer-document.js';
import {labelPrintHtml} from '../public/barcode-label.js';

// Panelin güvenlik politikası style-src 'self' der: satır içi style="" öznitelikleri VE
// gömülü <style> blokları uygulanmaz. Yazdırma penceresi stilleri gömülü verdiği için
// bütün çıktılar sessizce stilsiz basılıyordu — tarayıcıda görülüp düzeltildi.
// Bu test aynı hatanın geri gelmesini engeller.
const inlineStyle = /<style[\s>]|\sstyle\s*=/i;

const statement = () => {
  const s = buildStatement({
    entries: [{id: 'a', occurred_on: '2026-01-05', amount_cents: 120000, reference: 'F-1', description: 'Satış', source: 'manual', created_at: '2026-01-05T09:00:00Z'}],
    from: '2026-01-01', to: '2026-01-31'
  });
  return {
    party: {name: 'Şişli Çiçekçilik Ltd. Şti.', tax_id: '1234567890'},
    workspace: 'ec', statement: s,
    difference: counterpartyDifference({closing_cents: s.closing_cents, reported_cents: null}),
    meta: {}, notice: 'Bu belge resmî fatura değildir.'
  };
};

const offer = () => ({
  offer: {kind: 'contract', document_no: 'SZL-2026-0001', revision: 1, status: 'sent'},
  snapshot: {
    party: {name: 'Şişli Çiçekçilik Ltd. Şti.', tax_id: '1234567890'},
    workspace: 'lp', kind: 'contract', title: 'Sözleşme', issue_date: '2026-09-01', valid_until: null,
    terms: 'Teslim: 15 iş günü.', currency: 'TRY',
    totals: offerTotals([{description: 'Saksı', unit: 'adet', quantity_milli: 1000, unit_price_cents: 10000, vat_bps: 2000}]),
    notice: 'Bu belge bir ticari tekliftir.'
  },
  today: '2026-09-10'
});

test('Yazdırma çıktılarında satır içi stil bulunmaz', () => {
  const ciktilar = {
    mutabakat: statementPrintHtml(statement()),
    teklif: offerPrintHtml(offer()),
    etiket: labelPrintHtml([{code: '8690632012346', title: 'Torf', subtitle: 'Klasmann'}], {size: 'medium'})
  };
  for (const [ad, html] of Object.entries(ciktilar)) {
    assert.doesNotMatch(html, inlineStyle, ad + ' çıktısı satır içi stil içeriyor; CSP bunu uygulamaz');
    assert.ok(html.includes('class='), ad + ' çıktısı biçimlendirmeyi sınıflarla vermeli');
  }
});

test('Yazdırma penceresi stilleri ayrı bir dosyadan alır', () => {
  const engine = readFileSync(new URL('../public/doc-engine.js', import.meta.url), 'utf8');
  const printBlock = engine.slice(engine.indexOf('export function printDocument'));
  assert.ok(printBlock.includes('/print.css'), 'yazdırma penceresi print.css bağlamalı');
  // Kapanış etiketi yalnızca gerçek işaretlemede bulunur; açıklama satırlarında geçmez.
  assert.doesNotMatch(printBlock.slice(0, printBlock.indexOf('\n}')), /<\/style>/, 'gömülü <style> bloğu kalmamalı');

  const css = readFileSync(new URL('../public/print.css', import.meta.url), 'utf8');
  for (const kural of ['@page', 'body', '.muted', '.right', '.note', '.labels.small', '.labels.medium', '.labels.large'])
    assert.ok(css.includes(kural), 'print.css içinde ' + kural + ' bulunmalı');
});

test('Etiket boyutu sınıfla verilir, ölçüler stil dosyasındadır', () => {
  const css = readFileSync(new URL('../public/print.css', import.meta.url), 'utf8');
  // Kucuk etikete uzun kod sigmaz; her boyut kendi tasiyabildigi kodla denenir.
  for (const [size, genislik, kod] of [['small', '38mm', 'TORF20'], ['medium', '50mm', 'LP-ABCDEF0123'], ['large', '70mm', 'LP-ABCDEF0123']]) {
    const html = labelPrintHtml([{code: kod, title: 'Etiketsiz ürün'}], {size});
    assert.ok(html.includes(`class="labels ${size}"`), size + ' sınıfı verilmeli');
    assert.doesNotMatch(html, /\d+mm/, 'ölçü HTML içine gömülmemeli');
    assert.ok(css.includes(genislik), size + ' genişliği stil dosyasında tanımlı olmalı');
  }
});
