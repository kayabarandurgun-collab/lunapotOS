// FA05: ana test paketindeki tedarikçi, fatura ve fiziksel stok değişmezleri.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
const DATE = '2026-09-12';
async function setup() {
  const f = appFixture(); await f.setup();
  const supplier = await f.ok('/ec/suppliers', {name: 'Tedarikçi A', tax_id: '1234567890', contact: ''});
  const a = await f.ok('/ec/products', {name: 'Torf', sku: 'TORF', stock_unit: 'adet', min_stock: 0});
  const b = await f.ok('/ec/products', {name: 'Saksı', sku: 'SAKSI', stock_unit: 'adet', min_stock: 0});
  const provisional = await f.ok('/ec/ledger/provisional', {supplier_id: supplier.id, occurred_on: DATE, reference: 'IRS-A',
    lines: [{product_id: a.id, quantity: 10, unit_cost: 100, vat_bps: 2000}]});
  return {f, supplier, a, b, provisional};
}
async function invoice(f, supplier, product) {
  const i = await f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: 'INV-B', invoice_date: DATE, currency: 'TRY',
    lines: [{description: 'Yeni mal', invoice_quantity: 2, invoice_unit: 'adet', product_id: product, stock_quantity: 2, net: 100, tax: 20}]});
  await f.ok('/ec/invoices/' + i.id + '/post', {});
  return i;
}
test('FA05: aynı tedarikçinin farklı ürün faturası eski faturasız mal borcunu kapatmamalı', async () => {
  const {f, supplier, b, provisional} = await setup(); try {
    await invoice(f, supplier.id, b.id);
    const actual = {
      balance: f.sqlite.prepare('SELECT SUM(amount_cents) n FROM ec_party_entries WHERE party_id=?').get(supplier.id).n,
      closed: f.sqlite.prepare('SELECT invoice_id FROM ec_provisional_receipts WHERE id=?').get(provisional.id).invoice_id !== null
    };
    assert.deepEqual(actual, {balance: -132000, closed: false}, '1200 TL torf borcu + yeni 120 TL saksı borcu birlikte durmalı');
  } finally { f.close(); }
});
test('FA05: farklı tedarikçinin yeni malı eski faturasız sayımı tüketmemeli', async () => {
  const {f, a} = await setup(); try {
    const other = await f.ok('/ec/suppliers', {name: 'Tedarikçi B', tax_id: '9876543210', contact: ''});
    const i = await invoice(f, other.id, a.id);
    const line = f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(i.id);
    await f.ok('/ec/invoices/' + i.id + '/receive', {occurred_on: DATE, reference: 'TESLIM-B', lines: [{id: line.id, quantity: 2}]});
    assert.equal(f.sqlite.prepare('SELECT quantity_milli n FROM ec_stock_balances WHERE product_id=?').get(a.id).n,
      12000, 'A tedarikçisinden 10 + B tedarikçisinden 2 = fiziksel 12 adet');
  } finally { f.close(); }
});

const stock = (f, product) => f.sqlite.prepare('SELECT quantity_milli q,value_cents v FROM ec_stock_balances WHERE product_id=?').get(product);
const balance = (f, party) => f.sqlite.prepare('SELECT SUM(amount_cents) n FROM ec_party_entries WHERE party_id=?').get(party).n;
async function draft(f, supplier, product, no, qty, net = qty * 100, extra = []) {
  return f.ok('/ec/invoices', {supplier_id: supplier, invoice_no: no, invoice_date: DATE, currency: 'TRY', lines:
    [{description: 'Torf', invoice_quantity: qty, invoice_unit: 'adet', product_id: product, stock_quantity: qty, net, tax: Math.round(net * 20) / 100}, ...extra]});
}
const post = (f, i) => f.ok('/ec/invoices/' + i.id + '/post', {});
async function receive(f, i, qty, ref, index = 0) {
  const lines = (await f.ok('/ec/invoices/' + i.id)).lines;
  return f.req('/ec/invoices/' + i.id + '/receive', {occurred_on: DATE, reference: ref, lines: [{id: lines[index].id, quantity: qty}]});
}
async function summary(f, id) { return (await f.ok('/ec/ledger/provisional')).receipts.find(r => r.id === id); }

test('FA05: kısmi faturalar ve teslimler borç/stoğu kalan miktarla kapatır; son kuruş kaybolmaz', async () => {
  const {f, supplier, a, provisional} = await setup(); try {
    assert.ok(f.sqlite.prepare('SELECT movement_id FROM ec_provisional_receipt_lines WHERE receipt_id=?').get(provisional.id).movement_id);
    const first = await draft(f, supplier.id, a.id, 'PART-1', 4, 480); await post(f, first);
    assert.equal(balance(f, supplier.id), -129600); // kalan eski 720 + gerçek yeni 576
    assert.equal(stock(f, a.id).q, 10000);
    assert.equal((await summary(f, provisional.id)).provisional_status, 'partial');
    assert.equal((await receive(f, first, 2, 'PART-DEL-1')).status, 200);
    assert.equal(stock(f, a.id).q, 10000);
    assert.ok([200, 409].includes((await receive(f, first, 2, 'PART-DEL-1')).status));
    assert.equal(stock(f, a.id).q, 10000);
    assert.equal((await receive(f, first, 2, 'PART-DEL-2')).status, 200);
    assert.equal(stock(f, a.id).v, 108000);
    const last = await draft(f, supplier.id, a.id, 'PART-2', 6, 720); await post(f, last);
    assert.equal((await receive(f, last, 6, 'PART-DEL-3')).status, 200);
    assert.equal(balance(f, supplier.id), -144000);
    assert.deepEqual({...stock(f, a.id)}, {q: 10000, v: 120000});
    const s = await summary(f, provisional.id);
    assert.equal(s.provisional_status, 'invoiced');
    assert.equal(s.remaining_cents, 0);
    assert.equal(s.lines[0].remaining_to_invoice_milli, 0);
    assert.equal(s.lines[0].remaining_to_receive_milli, 0);
  } finally { f.close(); }
});

test('FA05: bir fatura birden çok irsaliyeyi FIFO kapatır; tek üründeki farklı satır fiyatları korunur', async () => {
  const {f, supplier, a} = await setup(); try {
    const extra = await f.ok('/ec/ledger/provisional', {supplier_id: supplier.id, occurred_on: DATE, reference: 'IRS-SECOND',
      lines: [{product_id: a.id, quantity: 5, unit_cost: 60, vat_bps: 2000}]});
    const i = await draft(f, supplier.id, a.id, 'MULTI-LINE', 6, 600,
      [{description: 'İkinci satır', invoice_quantity: 6, invoice_unit: 'adet', product_id: a.id, stock_quantity: 6, net: 1200, tax: 240}]);
    await post(f, i);
    const lines = (await f.ok('/ec/invoices/' + i.id)).lines;
    await f.ok('/ec/invoices/' + i.id + '/receive', {occurred_on: DATE, reference: 'MULTI-DEL', lines: lines.map(l => ({id: l.id, quantity: 6}))});
    assert.equal(stock(f, a.id).q, 15000);
    assert.equal(stock(f, a.id).v, 198000); // 6*100 + 6*200 + kalan 3*60
    assert.equal(balance(f, supplier.id), -237600); // 1560 + 2160 - 1344
    const s = await summary(f, extra.id);
    assert.equal(s.lines[0].invoiced_milli, 2000);
    assert.equal(s.remaining_cents, 21600);
  } finally { f.close(); }
});

test('FA05: eşzamanlı iki fatura aynı geçici miktarı iki kez kullanamaz; tekrar post yan etki üretmez', async () => {
  const {f, supplier, a} = await setup(); try {
    const x = await draft(f, supplier.id, a.id, 'RACE-1', 7), y = await draft(f, supplier.id, a.id, 'RACE-2', 7);
    await Promise.all([post(f, x), post(f, y)]);
    assert.equal(balance(f, supplier.id), -168000);
    assert.equal(f.sqlite.prepare('SELECT SUM(quantity_milli) q FROM ec_provisional_allocations').get().q, 10000);
    const before = f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n;
    assert.equal((await f.req('/ec/invoices/' + x.id + '/post', {})).status, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_party_entries').get().n, before);
    await Promise.all([receive(f, x, 7, 'RACE-X'), receive(f, y, 7, 'RACE-Y')]);
    assert.equal(stock(f, a.id).q, 14000);
  } finally { f.close(); }
});

test('FA05: ilişkisiz eski sayım tedarikçi tahminiyle kapanmaz', async () => {
  const f = appFixture(); await f.setup(); try {
    const s = await f.ok('/ec/suppliers', {name: 'Eski', tax_id: '1234567890'});
    const p = await f.ok('/ec/products', {name: 'Eski sayım', sku: 'LEGACY', stock_unit: 'adet', min_stock: 0});
    await f.ok('/ec/stock', {product_id: p.id, quantity: 10, unit_cost: 100, kind: 'count', reference: 'GECICI-SAYIM-ESKI', occurred_on: DATE, notes: 'Eski ilişkisiz raf sayımı'});
    const i = await draft(f, s.id, p.id, 'LEGACY-NEW', 2); await post(f, i);
    assert.equal((await receive(f, i, 2, 'LEGACY-DEL')).status, 200);
    assert.equal(stock(f, p.id).q, 12000);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_allocations').get().n, 0);
  } finally { f.close(); }
});

test('FA05: başka tedarikçinin gerçekten yeni malı açık maliyeti kapatır; tahsisli eski mal kapatmaz', async () => {
  const {f, supplier, a} = await setup(); try {
    f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
    await f.ok('/ec/sales', {channel: 'trendyol', external_id: 'OPEN-15', product_id: a.id, quantity: 15,
      revenue: 3000, commission: 0, shipping: 0, other: 0, fees_status: 'confirmed', occurred_on: DATE, notes: 'Sentetik fazla satış'});
    const original = await draft(f, supplier.id, a.id, 'MATCHED-4', 4); await post(f, original);
    assert.equal((await receive(f, original, 4, 'MATCHED-DEL')).status, 200);
    const open = () => f.sqlite.prepare('SELECT SUM(open_milli-settled_milli) n FROM ec_open_costs WHERE product_id=?').get(a.id).n;
    assert.equal(open(), 5000);
    const other = await f.ok('/ec/suppliers', {name: 'Yeni tedarikçi', tax_id: '9876543210'});
    const i = await draft(f, other.id, a.id, 'OTHER-2', 2); await post(f, i);
    assert.equal((await receive(f, i, 2, 'OTHER-DEL')).status, 200);
    assert.equal(open(), 3000);
    assert.equal(stock(f, a.id).q, -3000);
  } finally { f.close(); }
});

test('FA05: kuruşlu maliyetin üç kısmi faturası özgün brütü tam kapatır', async () => {
  const {f, supplier, b} = await setup(); try {
    const p=await f.ok('/ec/ledger/provisional',{supplier_id:supplier.id,occurred_on:DATE,reference:'ODD',lines:[{product_id:b.id,quantity:0.003,unit_cost:33.33,vat_bps:2000}]});
    assert.equal(p.amount_cents,-12);
    for(let j=0;j<3;j++){
      const i=await draft(f,supplier.id,b.id,'ODD-'+j,0.001,0.04);await post(f,i);assert.equal((await receive(f,i,0.001,'ODD-DEL-'+j)).status,200);
      assert.equal((await summary(f,p.id)).remaining_cents,12-4*(j+1));
    }
    assert.equal(f.sqlite.prepare('SELECT SUM(released_cents) n FROM ec_provisional_allocations a JOIN ec_provisional_receipt_lines p ON p.id=a.provisional_line_id WHERE p.receipt_id=?').get(p.id).n,12);
    assert.equal(stock(f,b.id).q,3);
    assert.equal(stock(f,b.id).v,12);
  }finally{f.close();}
});
for(const paid of [400,1200])test('FA05: önceden '+paid+' TL ödenmiş giriş kısmi faturalanınca ödeme korunur, kredi yalnız açık borca aktarılır',async()=>{
  const {f,supplier,a,provisional}=await setup();try{
    const payment=await f.ok('/ec/ledger/payments',{party_id:supplier.id,amount:paid,occurred_on:DATE,method:'cek',due_on:'2026-10-01',reference:'PREPAID-'+paid});
    const original=f.sqlite.prepare('SELECT * FROM ec_payment_allocations WHERE positive_entry_id=?').all(payment.id);
    for(const [no,qty,net] of [['PAID-A',4,480],['PAID-B',6,720]]){const i=await draft(f,supplier.id,a.id,no,qty,net);await post(f,i);}
    assert.equal(balance(f,supplier.id),-144000+paid*100);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM ec_payment_allocations WHERE positive_entry_id=?').all(payment.id),original);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_cash_transactions').get().n,0,'faturalama para hareketi üretmez');
    const ledger=await f.ok('/ec/ledger');
    assert.equal(ledger.open_invoices.reduce((n,r)=>n+r.debt_cents-r.paid_cents,0),144000-paid*100);
    assert.equal(ledger.entries.find(e=>e.source_key==='gecici:'+provisional.id).provisional_status,'invoiced');
  }finally{f.close();}
});

test('FA05: miktar tahsisleri/metadata değişmez; çift kapasite, başka tedarikçi ve ters kayıt reddedilir',async()=>{
 const {f,supplier,a,provisional}=await setup();try{
  const i=await draft(f,supplier.id,a.id,'LOCK',2);await post(f,i);await receive(f,i,2,'LOCK-DEL');
  const allocation=f.sqlite.prepare('SELECT * FROM ec_provisional_allocations').get();
  for(const table of ['ec_provisional_allocations','ec_provisional_receipt_allocations','ec_provisional_receipt_lines']){
   assert.throws(()=>f.sqlite.exec('DELETE FROM '+table),/IMMUTABLE_LEDGER/);
  }
  assert.throws(()=>f.sqlite.exec('UPDATE ec_provisional_allocations SET quantity_milli=quantity_milli+1'),/IMMUTABLE_LEDGER/);
  assert.throws(()=>f.sqlite.prepare('INSERT INTO ec_provisional_allocations(id,provisional_line_id,invoice_line_id,quantity_milli,released_cents) VALUES(?,?,?,?,?)').run('too-much',allocation.provisional_line_id,allocation.invoice_line_id,1000,12000),/PROVISIONAL_OVER_ALLOCATION/);
  const other=await f.ok('/ec/suppliers',{name:'Farklı',tax_id:'9876543210'}),j=await draft(f,other.id,a.id,'WRONG-PARTY',2);await post(f,j);
  const line=f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(j.id);
  assert.throws(()=>f.sqlite.prepare('INSERT INTO ec_provisional_allocations(id,provisional_line_id,invoice_line_id,quantity_milli,released_cents) VALUES(?,?,?,?,?)').run('wrong',allocation.provisional_line_id,line.id,1000,12000),/PROVISIONAL_ALLOCATION_MISMATCH/);
  const credit=f.sqlite.prepare("SELECT id FROM ec_party_entries WHERE source_key LIKE 'gecici-fatura:%'").get();
  assert.equal((await f.req('/ec/ledger/reverse',{entry_id:credit.id,occurred_on:DATE,reference:'REV',reason:'Yanlış geri alma'})).status,409);
  const close=f.sqlite.prepare("SELECT id FROM ec_payment_allocations WHERE reference LIKE 'gecici-fatura:%'").get();
  assert.equal((await f.req('/ec/ledger/reverse',{allocation_id:close.id,reason:'Yanlış geri alma'})).status,409);
 }finally{f.close();}
});

test('FA05: yeni durum/miktar uçları tutar iznini ve çalışma alanını korur',async()=>{
 const {f,provisional}=await setup();try{
  const u=await f.ok('/admin/users',{name:'Stok',username:'fa05-stock',permissions:{ec:{ledger:'read',amounts:'none'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:u.invite_path.split('invite=')[1],password:'synthetic-audit-password'});
  const cookie=(await f.req('/auth/login',{username:'fa05-stock',password:'synthetic-audit-password'})).cookie;
  const read=await f.req('/ec/ledger/provisional',undefined,cookie);assert.equal(read.status,200);
  const r=read.data.receipts.find(r=>r.id===provisional.id);assert.equal(r.amount_cents,null);assert.equal(r.remaining_cents,null);assert.equal(r.provisional_status,'open');assert.equal(r.lines[0].remaining_to_invoice_milli,10000);assert.equal(r.lines[0].remaining_cents,null);
  assert.equal((await f.req('/ec/ledger/provisional',{supplier_id:'x'},cookie)).status,403);
  assert.equal((await f.req('/lp/ledger/provisional')).status,403);
  assert.equal((await f.req('/lp/ledger/provisional',{})).status,403);
 }finally{f.close();}
});

for (const postedFirst of [true, false]) test('PR03: 12 Eylül girişinden önceki 11 Eylül teslimi engellenmez; post sırası '+(postedFirst?'önce':'sonra'),async()=>{
 const f=appFixture();await f.setup();try{
  const supplier=await f.ok('/ec/suppliers',{name:'PR03 Tedarikçi',tax_id:'1234567890'});
  const product=await f.ok('/ec/products',{name:'PR03 Torf',sku:'PR03-TORF',stock_unit:'kg',min_stock:0});
  const makeInvoice=async(no)=>{
   const i=await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:no,invoice_date:postedFirst?'2026-09-10':'2026-09-11',currency:'TRY',lines:[{description:'Torf',invoice_quantity:2,invoice_unit:'kg',product_id:product.id,stock_quantity:2,net:200,tax:0}]});
   await post(f,i);return i;
  };
  let past,overlap;
  if(postedFirst){past=await makeInvoice('PR03-PAST');overlap=await makeInvoice('PR03-OVERLAP');}
  const provisional=await f.ok('/ec/ledger/provisional',{supplier_id:supplier.id,occurred_on:'2026-09-12',reference:'PR03-IRS',lines:[{product_id:product.id,quantity:10,unit_cost:100,vat_bps:0}]});
  if(!postedFirst){past=await makeInvoice('PR03-PAST');overlap=await makeInvoice('PR03-OVERLAP');}
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_allocations').get().n,0,'fatura tarihinden sonraki giriş tahsis edilmez');
  const deliver=async(i,date)=>{
   const l=(await f.ok('/ec/invoices/'+i.id)).lines[0];
   return f.req('/ec/invoices/'+i.id+'/receive',{occurred_on:date,reference:'PR03-DEL-'+i.id,lines:[{id:l.id,quantity:2}]});
  };
  const r=await deliver(past,'2026-09-11');assert.equal(r.status,200,JSON.stringify(r));
  assert.deepEqual({...stock(f,product.id)},{q:12000,v:120000});
  assert.equal((await summary(f,provisional.id)).remaining_cents,100000);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_receipt_allocations').get().n,0,'geçmiş ayrı teslim sonraki girişi tüketmez');
  const blocked=await deliver(overlap,'2026-09-12');assert.equal(blocked.status,409,JSON.stringify(blocked));assert.match(blocked.data.error,/miktar bağı/);
  assert.deepEqual({...stock(f,product.id)},{q:12000,v:120000},'aynı günkü tahsissiz teslim çift stok yazamaz');
 }finally{f.close();}
});
