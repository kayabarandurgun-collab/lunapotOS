// Alış faturası geçmişten öğrenerek tamamlanır: ürün bağlanır, muhasebeleşir, stoğa girer.
// Ürün TAHMİN EDİLMEZ: aynı tedarikçinin muhasebeleşmiş faturalarında aynı satır hangi karta
// bağlandıysa odur. Belirsizse fatura taslak kalır. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {matchFromHistory} from '../src/purchase-autopost-api.js';

const h = (description, product_id, product_name, extra = {}) =>
  ({description, external_code: '', invoice_unit: 'adet', invoice_quantity: 2, quantity_milli: 2000, product_id, product_name, ...extra});

test('Aynı açıklama (boşluk farkı önemsiz) aynı karta bağlanır', () => {
  const hit = matchFromHistory({description: 'Torf 40 Litre Genel Kullanım Torfu', invoice_unit: 'adet'},
    [h('Torf 40 Litre GenelKullanım Torfu', 'p40', 'Torf 40 L'), h('Torf 20 Litre GenelKullanım Torfu', 'p20', 'Torf 20 L')]);
  assert.deepEqual([hit.product_id, hit.ratio, hit.how], ['p40', 1000, 'aynı açıklama']);
});

test('Açıklama farklıysa aynı ürün kodunda adı TEK karta uyan seçilir; ortak kod tek başına yetmez', () => {
  const history = [
    h('BESİN3 BİTKİ BESİNİ 1000ML / Örnek Çiçek Açan Bitki Besini 1000 ml', 'cicek', 'Örnek Çiçek Açan Bitki Besini 1000 ml'),
    h('BESİN3 BİTKİ BESİNİ 1000ML / Örnek Orkide Bitki Besini 1000 ml', 'orkide', 'Örnek Orkide Bitki Besini 1000 ml'),
    h('BESİN3 BİTKİ BESİNİ 1000 ML / GENEL BİTKİ BESİNİ 1000 ML', 'genel', 'Örnek Genel Bitki Besini 1000 ml'),
    h('BESİN3 BİTKİ BESİNİ 1000ML / Örnek Yeşil Yapraklı Bitki Besini 1000 ml', 'yesil', 'Örnek Yeşil Yapraklı Bitki Besini 1000 ml'),
    h('BESİN1 BİTKİ BESİNİ 225 ML / Örnek Orkide Bitki Besini 225 ml', 'orkide225', 'Örnek Orkide Bitki Besini 225 ml')];
  const find = d => matchFromHistory({description: d, external_code: 'BESİN3', invoice_unit: 'adet'}, history)?.product_id ?? null;
  assert.equal(find('BESİN3 BİTKİ BESİNİ 1000 ML / Çiçek Açan Bitkiler İçin Bitki Besini'), 'cicek');
  assert.equal(find('BESİN3 BİTKİ BESİNİ 1000 ML / Orkideler için Bitki Besini'), 'orkide', 'başka boydaki (225 ml) orkide seçilmedi');
  assert.equal(find('BESİN3 BİTKİ BESİNİ 1000 ML / Genel Kullanım Bitki Besini'), 'genel');
  assert.equal(find('BESİN3 BİTKİ BESİNİ 1000 ML / Yeşil Bitki Besini'), null, '"Yapraklı" geçmiyor: tek karta tam uymadı, tahmin yok');
  assert.equal(find('BESİN3 BİTKİ BESİNİ 1000 ML'), null, 'yalnız kod: beş karttan hangisi olduğu bilinmez');
});

test('Geçmiş iki farklı karta işaret ediyorsa ya da stok karşılığı tutarsızsa bağlanmaz', () => {
  const line = {description: 'Torf 40', invoice_unit: 'adet'};
  assert.equal(matchFromHistory(line, [h('Torf 40', 'a', 'A'), h('Torf 40', 'b', 'B')]), null);
  assert.equal(matchFromHistory(line, [h('Torf 40', 'a', 'A'), h('Torf 40', 'a', 'A', {quantity_milli: 4000})]), null);
  assert.equal(matchFromHistory({...line, invoice_unit: 'koli'}, [h('Torf 40', 'a', 'A')]), null, 'birim farklı');
});

async function invoice(f, supplier, no, lines) {
  return (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: '2026-09-15',
    currency: 'TRY', source: 'pdf', notes: '', lines: lines.map(([description, qty, net]) =>
      ({description, external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net, tax: net / 5, line_type: 'product'}))})).id;
}

test('Bütün satırlar geçmişten bulunursa fatura muhasebeleşir ve fatura tarihiyle stoğa girer', async () => {
  const f = appFixture(); await f.setup(); try {
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
    const p20 = (await f.ok('/ec/products', {name: 'Torf 20 L', sku: 'SNT-T20', stock_unit: 'adet', min_stock: 0})).id;
    const p40 = (await f.ok('/ec/products', {name: 'Torf 40 L', sku: 'SNT-T40', stock_unit: 'adet', min_stock: 0})).id;
    // Geçmiş: elle bağlanıp muhasebeleşmiş fatura.
    const old = await invoice(f, supplier, 'SNT-1', [['Torf 20 Litre GenelKullanım', 5, 500], ['Torf 40 Litre GenelKullanım', 3, 600]]);
    const detail = await f.ok('/ec/invoices/' + old);
    await f.ok('/ec/invoices/' + old, {lines: [{id: detail.lines[0].id, product_id: p20, stock_quantity: 5}, {id: detail.lines[1].id, product_id: p40, stock_quantity: 3}]});
    await f.ok('/ec/invoices/' + old + '/post', {});

    const draft = await invoice(f, supplier, 'SNT-2', [['Torf 40 Litre Genel Kullanım', 4, 1200], ['Torf 20 Litre Genel Kullanım', 4, 760]]);
    const result = await f.ok('/ec/invoices/' + draft + '/autocomplete', {});
    assert.equal(result.status, 'posted');
    assert.equal(result.received, true);
    assert.deepEqual(result.mapped.map(m => m.product_name), ['Torf 40 L', 'Torf 20 L']);

    const done = await f.ok('/ec/invoices/' + draft);
    assert.equal(done.status, 'posted', 'cari borç yazıldı');
    assert.deepEqual(done.lines.map(l => [l.product_id, l.quantity_milli, l.received_milli]), [[p40, 4000, 4000], [p20, 4000, 4000]]);
    assert.deepEqual(done.receipts.map(r => r.occurred_on), ['2026-09-15', '2026-09-15'], 'teslim fatura tarihiyle');

    // Tekrar çağrı ikinci teslim yaratmaz.
    assert.equal((await f.ok('/ec/invoices/' + draft + '/autocomplete', {})).status, 'posted');
    assert.equal((await f.ok('/ec/invoices/' + draft)).receipts.length, 2);
  } finally { f.close(); }
});

test('Bir satır bile bulunamazsa fatura taslak kalır; bulunanlar kaydedilir, borç ve stok yazılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
    const p20 = (await f.ok('/ec/products', {name: 'Torf 20 L', sku: 'SNT-T20', stock_unit: 'adet', min_stock: 0})).id;
    const old = await invoice(f, supplier, 'SNT-1', [['Torf 20 Litre', 5, 500]]);
    const detail = await f.ok('/ec/invoices/' + old);
    await f.ok('/ec/invoices/' + old, {lines: [{id: detail.lines[0].id, product_id: p20, stock_quantity: 5}]});
    await f.ok('/ec/invoices/' + old + '/post', {});

    const draft = await invoice(f, supplier, 'SNT-2', [['Torf 20 Litre', 2, 200], ['Hiç alınmamış ürün', 1, 100]]);
    const result = await f.ok('/ec/invoices/' + draft + '/autocomplete', {});
    assert.equal(result.status, 'draft');
    assert.deepEqual(result.missing, ['Hiç alınmamış ürün']);
    const still = await f.ok('/ec/invoices/' + draft);
    assert.equal(still.status, 'draft');
    assert.deepEqual(still.lines.map(l => l.product_id), [p20, null], 'bulunan satır bağlandı, diğeri boş kaldı');
    assert.equal(still.receipts.length, 0);
  } finally { f.close(); }
});
