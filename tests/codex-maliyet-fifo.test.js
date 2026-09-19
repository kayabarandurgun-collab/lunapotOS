// CODEX R09/R10/R11/R12/R16 — FIFO değerlemesi. Her senaryoda ölçülen şey ekonomik sonuçtur:
// satış/iade maliyeti, kalan stok miktarı/değeri, kayıp gideri ve ikinci FIFO turunun etkisizliği.
// Tutarlar KDV hariç kuruş. TEMSİLİ veri; gerçek belge değildir.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {fifoRevalue} from '../src/fifo-cost.js';

async function kur(f) {
  f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
  const supplier = (await f.ok('/ec/suppliers', {name: 'Sentetik Torf', tax_id: '9340990552'})).id;
  const product = (await f.ok('/ec/products', {name: 'Torf 20 L', sku: 'SNT-T20', stock_unit: 'adet', min_stock: 0})).id;
  return {supplier, product};
}
// Fatura → muhasebe → teslim. Dönen: {invoice, line, receipt}.
async function alis(f, supplier, product, no, date, qty, unitNet) {
  const invoice = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, uuid: '', invoice_date: date, currency: 'TRY', source: 'pdf', notes: '',
    lines: [{description: 'Torf 20 L', external_code: '', invoice_quantity: qty, invoice_unit: 'adet', net: qty * unitNet, tax: qty * unitNet / 5, line_type: 'product', product_id: product, stock_quantity: qty}]})).id;
  await f.ok('/ec/invoices/' + invoice + '/post', {});
  const line = (await f.ok('/ec/invoices/' + invoice)).lines[0].id;
  await f.ok('/ec/invoices/' + invoice + '/receive', {occurred_on: date, reference: 'TESLIM-' + no, lines: [{id: line, quantity: qty}]});
  const receipt = (await f.ok('/ec/invoices/' + invoice)).receipts[0].id;
  return {invoice, line, receipt};
}
const satis = async (f, product, ref, date, qty = 1) => (await f.ok('/ec/sales', {channel: 'trendyol', external_id: ref, product_id: product, quantity: qty,
  revenue: 500 * qty, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: date})).id;
const iade = (f, sale, ref, date, qty = 1) => f.ok('/ec/sales/' + sale + '/return', {external_id: ref, quantity: qty, revenue: 500 * qty, restock: true, occurred_on: date});
const sayim = (f, product, qty, date, ref = 'SAYIM-' + date, unit = 0) => f.ok('/ec/stock', {product_id: product, quantity: qty, unit_cost: unit, kind: 'count', reference: ref, notes: 'Raf sayımı', occurred_on: date});
const maliyet = (f, ref) => f.sqlite.prepare('SELECT cost_cents FROM ec_sale_entries WHERE external_id=?').get(ref).cost_cents;
const bakiye = (f, p) => ({...f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(p)});
const kayip = f => f.sqlite.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM ec_expenses WHERE category='loss'").get().n;
const satisToplam = (f, p) => f.sqlite.prepare('SELECT COALESCE(SUM(cost_cents),0) n FROM ec_sale_entries WHERE product_id=?').get(p).n;
// İkinci tur: kuyruk boş, yeni fark yok.
async function durgun(f) {
  const r = await fifoRevalue(f.env.DB, 50);
  assert.equal(r.changed, 0, 'ikinci FIFO turu yeni fark yazmaz');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cost_dirty').get().n, 0, 'maliyet kuyruğu boş');
}

// ---- R09 ---------------------------------------------------------------------------------------

test('R09: ikinci kabulün ters kaydı ilk katmanı tüketmez; satış 100, kalan 300 (200/200 değil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 100);
    const b = await alis(f, supplier, product, 'B', '2026-08-02', 1, 200);
    await f.ok('/ec/invoices/' + b.invoice + '/receipts/' + b.receipt + '/reverse', {occurred_on: '2026-08-03', reference: 'DUZELT-B', reason: 'Yanlış ürüne teslim girildi'});
    await alis(f, supplier, product, 'C', '2026-08-04', 1, 300);
    await satis(f, product, 'S1', '2026-08-05');
    assert.equal(maliyet(f, 'S1'), 10000, 'geçerli en eski katman A');
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 30000}, 'kalan C');
    await durgun(f);
  } finally { f.close(); }
});

test('R09: kısmen tüketilmiş kabul geri alınınca satış gerçek katmana geçer; tek adete 900 TL kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    const b = await alis(f, supplier, product, 'B', '2026-08-01', 2, 100);   // yanlış girilmiş teslim
    await alis(f, supplier, product, 'A', '2026-08-02', 2, 500);
    await satis(f, product, 'S1', '2026-08-03');                              // FIFO bunu önce B'den sanıyordu
    await f.ok('/ec/invoices/' + b.invoice + '/receipts/' + b.receipt + '/reverse', {occurred_on: '2026-08-04', reference: 'DUZELT-B', reason: 'Teslim hiç gelmedi'});
    assert.equal(maliyet(f, 'S1'), 50000, 'B hiç gelmedi: satılan mal A');
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 50000}, 'kalan 1 adet A');
    await durgun(f);
  } finally { f.close(); }
});

test('R09: stoksuz satışı kapatmış ya da geçici sayımı kapatmış teslim geri alınamaz (açık kayıt yeniden açılamaz)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await satis(f, product, 'S1', '2026-08-01');                              // stoksuz: açık
    const a = await alis(f, supplier, product, 'A', '2026-08-02', 1, 100);     // S1'i kapattı
    const once = {...bakiye(f, product)};
    const r = await f.req('/ec/invoices/' + a.invoice + '/receipts/' + a.receipt + '/reverse', {occurred_on: '2026-08-03', reference: 'GERI-A', reason: 'Deneme'});
    assert.equal(r.status, 409);
    assert.deepEqual(bakiye(f, product), once, 'hiçbir şey değişmedi');
    const p2 = (await f.ok('/ec/products', {name: 'Torf 40 L', sku: 'SNT-T40', stock_unit: 'adet', min_stock: 0})).id;
    await sayim(f, p2, 1, '2026-08-04', 'GECICI-SAYIM-T40', 100);
    const b = await alis(f, supplier, p2, 'B', '2026-08-05', 1, 120);          // geçici sayımı kapattı
    assert.equal((await f.req('/ec/invoices/' + b.invoice + '/receipts/' + b.receipt + '/reverse', {occurred_on: '2026-08-06', reference: 'GERI-B', reason: 'Deneme'})).status, 409);
    assert.deepEqual(bakiye(f, p2), {q: 1000, v: 12000});
  } finally { f.close(); }
});

// ---- R10 ---------------------------------------------------------------------------------------

test('R10: sayım eksiği ve sonraki satış aynı kuruşları iki kez tüketmez; sıfır adette değer kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 1, 300);
    await alis(f, supplier, product, 'B', '2026-08-02', 1, 100);
    await sayim(f, product, 1, '2026-08-03');                                 // 1 adet kayıp
    await satis(f, product, 'S1', '2026-08-04');
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0}, 'stok bitti, değer de bitti');
    assert.equal(kayip(f) + satisToplam(f, product), 40000, 'kayıp + satış maliyeti = giren 400 TL');
    await durgun(f);
  } finally { f.close(); }
});

test('R10: iki farklı katmanda sayım eksiği; kalan stok değeri katmanlarla uzlaşır, FIFO kuyruğu takılmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await alis(f, supplier, product, 'A', '2026-08-01', 2, 100);
    await alis(f, supplier, product, 'B', '2026-08-02', 2, 300);
    await sayim(f, product, 3, '2026-08-03');
    await satis(f, product, 'S1', '2026-08-04');
    assert.equal(kayip(f) + satisToplam(f, product) + bakiye(f, product).v, 80000, 'başlangıç tam uzlaşır');
    await satis(f, product, 'S2', '2026-08-05', 2);
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0});
    assert.equal(kayip(f) + satisToplam(f, product), 80000);
    await durgun(f);
  } finally { f.close(); }
});

// ---- R11 ---------------------------------------------------------------------------------------

test('R11: satılmış geçici sayım gerçek fatura maliyetine geçer; satış/stok 1.000/1.000 (500/1.500 değil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await sayim(f, product, 10, '2026-08-05', 'GECICI-SAYIM-T20', 100);        // 10 × 100 TL (tahmini)
    await satis(f, product, 'S5', '2026-08-10', 5);
    await alis(f, supplier, product, 'AYSONU', '2026-08-31', 10, 200);         // gerçek fatura 10 × 200 TL
    assert.equal(maliyet(f, 'S5'), 100000, '5 × 200 TL');
    assert.deepEqual(bakiye(f, product), {q: 5000, v: 100000}, 'kalan 5 × 200 TL; çift stok yok');
    await durgun(f);
  } finally { f.close(); }
});

test('R11: kısmi fatura yalnız kendi miktarını kapatır; ikinci fatura kalanı kendi fiyatına taşır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await sayim(f, product, 10, '2026-08-05', 'GECICI-SAYIM-T20', 100);
    await satis(f, product, 'S5', '2026-08-10', 5);
    await alis(f, supplier, product, 'KISMI-6', '2026-08-20', 6, 200);
    assert.equal(maliyet(f, 'S5'), 100000, 'satılan 5 adet ilk faturanın malı');
    assert.deepEqual(bakiye(f, product), {q: 5000, v: 60000}, '1 × 200 + 4 × 100 (henüz faturasız)');
    await alis(f, supplier, product, 'KALAN-4', '2026-08-31', 4, 250);
    assert.equal(maliyet(f, 'S5'), 100000);
    assert.deepEqual(bakiye(f, product), {q: 5000, v: 120000}, '1 × 200 + 4 × 250');
    await durgun(f);
  } finally { f.close(); }
});

test('R11: tamamen satılmış geçici sayımın faturası tahminden ucuzsa satışlar gerçek fiyata iner; sıfır adette değer kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await sayim(f, product, 10, '2026-08-05', 'GECICI-SAYIM-T20', 200);        // tahmin 10 × 200 TL
    await satis(f, product, 'S10', '2026-08-10', 10);                          // hepsi satıldı
    await alis(f, supplier, product, 'AYSONU', '2026-08-31', 10, 100);          // gerçek fiyat 100 TL
    assert.equal(maliyet(f, 'S10'), 100000, '10 × 100 TL');
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0}, 'bakiye yetmediği için yarım kalan kapanış tamamlandı');
    await durgun(f);
  } finally { f.close(); }
});

test('R10/R11: geçici sayımdan kayba giden adedin gerçek fatura farkı kayıp giderine yazılır; stokta sahipsiz değer kalmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await sayim(f, product, 2, '2026-08-05', 'GECICI-SAYIM-T20', 90);          // 2 × 90 TL tahmin
    await sayim(f, product, 1, '2026-08-06');                                 // 1 adet kayıp (90 TL)
    await satis(f, product, 'S1', '2026-08-07');
    await alis(f, supplier, product, 'AYSONU', '2026-08-31', 2, 100);          // gerçek fiyat 100 TL
    assert.equal(maliyet(f, 'S1'), 10000);
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0});
    const d = await f.ok('/ec?from=2026-08-01&to=2026-08-31');
    assert.equal(d.expenses.filter(e => e.category === 'loss').reduce((n, e) => n + e.amount_cents, 0), 10000, 'kayıp 90 + fark 10 = 100 TL');
    assert.equal(kayip(f) + f.sqlite.prepare("SELECT COALESCE(SUM(value_cents),0) n FROM ec_close_cost_revaluations WHERE kind='kayip'").get().n + satisToplam(f, product), 20000, 'giren 2 × 100 TL');
    await durgun(f);
  } finally { f.close(); }
});

// ---- R12 ---------------------------------------------------------------------------------------

const duzelt = (f, a, body) => f.ok('/ec/invoices/' + a.invoice + '/adjustments', {line_id: a.line, kind: 'price', occurred_on: '2026-08-10', reason: 'Tedarikçi fiyat farkı faturası', ...body});

test('R12: stoğa yazılan indirim satılmış adedin payını da kapsıyorsa satış/stok 80/80 olur (100/60 değil)', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    const a = await alis(f, supplier, product, 'A', '2026-08-01', 2, 100);
    await satis(f, product, 'S1', '2026-08-05');
    await duzelt(f, a, {reference: 'FIYAT-FARKI-1', net: 40, tax: 8, stock_net: 40});
    assert.equal(maliyet(f, 'S1'), 8000);
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 8000});
    await satis(f, product, 'S2', '2026-08-12');
    assert.equal(maliyet(f, 'S2'), 8000, 'sonraki satış düzeltilmiş katmandan');
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0});
    await durgun(f);
  } finally { f.close(); }
});

test('R12: stok payı yalnız eldeki adede yazılırsa geçmiş satış değişmez; sonraki satış ve yeni katman doğru', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    const a = await alis(f, supplier, product, 'A', '2026-08-01', 3, 100);
    await satis(f, product, 'S1', '2026-08-05');
    await duzelt(f, a, {reference: 'FIYAT-FARKI-2', net: 60, tax: 12, stock_net: 40});   // 2 eldeki adet × 20 TL
    assert.equal(maliyet(f, 'S1'), 10000, 'satılmış payı dönem gideri düzeltmesi taşır');
    await alis(f, supplier, product, 'B', '2026-08-11', 1, 100);
    await satis(f, product, 'S2', '2026-08-12');
    assert.equal(maliyet(f, 'S2'), 8000, 'düzeltilmiş A katmanından');
    assert.deepEqual(bakiye(f, product), {q: 2000, v: 18000}, '1 × 80 (A) + 1 × 100 (B)');
    await satis(f, product, 'S3', '2026-08-13', 2);
    assert.equal(maliyet(f, 'S3'), 18000);
    assert.deepEqual(bakiye(f, product), {q: 0, v: 0});
    await durgun(f);
  } finally { f.close(); }
});

test('R12: fiyat düzeltmesinin ters kaydı aynı bağı izler; miktar değişmez, maliyet eski haline döner', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    const a = await alis(f, supplier, product, 'A', '2026-08-01', 2, 100);
    await satis(f, product, 'S1', '2026-08-05');
    const d = await duzelt(f, a, {reference: 'FIYAT-FARKI-3', net: 40, tax: 8, stock_net: 40});
    await f.ok('/ec/invoices/' + a.invoice + '/adjustments/' + d.adjustment_id + '/reverse', {occurred_on: '2026-08-11', reference: 'GERI-AL-3', reason: 'Fark faturası iptal'});
    assert.equal(maliyet(f, 'S1'), 10000);
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 10000});
    await durgun(f);
  } finally { f.close(); }
});

test('R11/R12: geçici sayımı kapatan faturanın fiyat düzeltmesi sayılan (faturanın) mala yazılır; satış/stok 90/90', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    await sayim(f, product, 2, '2026-08-01', 'GECICI-SAYIM-T20', 90);
    await satis(f, product, 'S1', '2026-08-02');
    const a = await alis(f, supplier, product, 'AYSONU', '2026-08-05', 2, 100); // sayımı kapattı: S1 → 100
    assert.equal(maliyet(f, 'S1'), 10000);
    await duzelt(f, a, {reference: 'FIYAT-FARKI-4', net: 20, tax: 4, stock_net: 20});
    assert.equal(maliyet(f, 'S1'), 9000, 'satılmış adedin payı');
    assert.deepEqual(bakiye(f, product), {q: 1000, v: 9000}, 'raftaki adedin payı');
    await satis(f, product, 'S2', '2026-08-12');
    assert.equal(maliyet(f, 'S2'), 9000);
    await durgun(f);
  } finally { f.close(); }
});

// ---- R16 ---------------------------------------------------------------------------------------

test('R16: 100 kuruşluk 3 adetlik satışın üç ayrı iadesi tam 100 kuruş; son adette bakiye sıfır', async () => {
  const f = appFixture(); await f.setup(); try {
    const {supplier, product} = await kur(f);
    const invoice = (await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'KURUS', uuid: '', invoice_date: '2026-08-01', currency: 'TRY', source: 'pdf', notes: '',
      lines: [{description: 'Torf 20 L', external_code: '', invoice_quantity: 3, invoice_unit: 'adet', net: 1, tax: 0.2, line_type: 'product', product_id: product, stock_quantity: 3}]})).id;
    await f.ok('/ec/invoices/' + invoice + '/post', {});
    await f.ok('/ec/invoices/' + invoice + '/receive', {occurred_on: '2026-08-01', reference: 'T', lines: [{id: (await f.ok('/ec/invoices/' + invoice)).lines[0].id, quantity: 3}]});
    const s = await satis(f, product, 'S3', '2026-08-02', 3);
    assert.equal(maliyet(f, 'S3'), 100);
    for (const n of [1, 2, 3]) await iade(f, s, 'IADE-' + n, '2026-08-0' + (2 + n));
    const iadeler = f.sqlite.prepare("SELECT SUM(cost_cents) n FROM ec_sale_entries WHERE kind='return'").get().n;
    assert.equal(iadeler, -100, 'üç iade toplamı tam 100 kuruş');
    assert.equal(satisToplam(f, product), 0, 'bütün adetler döndü: satışta maliyet kalmadı');
    assert.deepEqual(bakiye(f, product), {q: 3000, v: 100});
    await durgun(f);
  } finally { f.close(); }
});
