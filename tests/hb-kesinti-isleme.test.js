// HEPSİBURADA FİNANS KAYITLARINDAN KESİNTİ İŞLEME.
// API'den çekilen finans kayıtları kaynak kutusunda duruyor, kesintiler yalnız elle yüklenen
// rapordan işleniyordu. Kanıtlanan: (a) eksik veriyle kesinti YAZILMAZ — bilinmeyen sıfır değildir,
// (b) defterde kesinleşmiş kayda dokunulmaz, (c) faturaya bağlı gider üstündür, (d) paketin
// kesintisi satışlara gelir oranında bölünür ve kuruş kaybolmaz, (e) stopaj gider sayılmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {pazaryeriKesintileriniIsle, paketKesintileri, kesintiTam} from '../src/pazaryeri-kesinti.js';

function fixture() {
 const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
 for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
  sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
 const db = {prepare(sql) {return {args: [], bind(...a) {this.args = a; return this;},
   all() {return {results: sqlite.prepare(sql).all(...this.args)};},
   first() {return sqlite.prepare(sql).get(...this.args) || null;},
   run() {return sqlite.prepare(sql).run(...this.args);}};},
  async batch(items) {sqlite.exec('BEGIN'); try {const r = items.map(i => i.run()); sqlite.exec('COMMIT'); return r;} catch (e) {sqlite.exec('ROLLBACK'); throw e;}}};
 return {sqlite, env: {DB: db, WORKSPACE: 'ec'}};
}

const finansKaydi = (f, {paket, siparis, tur, tutar}) =>
 f.sqlite.prepare("INSERT INTO ec_provider_records(id,provider,seller_id,kind,external_id,fingerprint,payload_json) VALUES(?,'hepsiburada','1','finance',?,?,?)")
  .run(crypto.randomUUID(), tur + '-' + paket + '-' + tutar, crypto.randomUUID(),
   JSON.stringify({package_no: paket, order_no: siparis, type: tur, amount: tutar}));

// Paket + satırı + satış kaydı: kesintinin yazılacağı yer.
function satisliPaket(f, {siparis, gelirler}) {
 const paketId = crypto.randomUUID();
 if (!f.sqlite.prepare("SELECT id FROM ec_products WHERE id='U1'").get()) {
  f.sqlite.prepare("INSERT INTO ec_products(id,name,sku) VALUES('U1','Torf','T1')").run();
  // Satış kaydı stok kontrolünden geçiyor (STOCK_RESERVED): yeterli stok tanımlanır.
  f.sqlite.prepare("INSERT INTO ec_stock_balances(product_id,quantity_milli,value_cents) VALUES('U1',1000000,100000) ON CONFLICT(product_id) DO UPDATE SET quantity_milli=1000000").run();
 }
 // Paket TASLAK açılır: satır eklemek yalnız taslakta serbest (ec_order_line_insert_lock).
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'hepsiburada',?,?,'2026-09-20','draft',?)")
  .run(paketId, 'RPT-' + siparis, siparis, 'fp-' + siparis);
 gelirler.forEach((gelir, i) => {
  const satirId = crypto.randomUUID(), satisId = crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES(?,'hepsiburada',?, 'U1','sale',1000,?,0,'pending','2026-09-21')")
   .run(satisId, 'order:' + siparis + ':' + i, gelir);
  f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli) VALUES(?,?,?,'Torf',1000)").run(satirId, paketId, 'L' + i);
  f.sqlite.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,sale_id) VALUES(?,?, 'U1',1000,10000,'adet',?)")
   .run(crypto.randomUUID(), satirId, satisId);
 });
 return paketId;
}

test('komisyon ve kargo geldiğinde kesinti satışlara yazılır; toplam korunur', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-1', gelirler: [6000, 4000]});
 finansKaydi(f, {paket: 'PKG-1', siparis: 'ORD-1', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-1', siparis: 'ORD-1', tur: 'ShipmentCostSharingExpense', tutar: -50});
 finansKaydi(f, {paket: 'PKG-1', siparis: 'ORD-1', tur: 'PaymentServiceCostReflection', tutar: -1.5});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 1, JSON.stringify(r));
 const s = f.sqlite.prepare('SELECT commission_cents k, shipping_cents kg, other_cents d, fees_status st FROM ec_sale_entries ORDER BY revenue_cents DESC').all();
 assert.equal(s[0].k + s[1].k, 3000, 'komisyon toplamı korunmalı');
 assert.equal(s[0].kg + s[1].kg, 5000, 'kargo toplamı korunmalı');
 assert.equal(s[0].d + s[1].d, 150, 'diğer gider toplamı korunmalı');
 assert.equal(s[0].k, 1800, 'gelir oranında bölünmeli (6000/10000)');
 assert.ok(s.every(x => x.st === 'confirmed'));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n, 2, 'her değişiklik iz bırakmalı');
});

test('kargo kaydı gelmemişse kesinti YAZILMAZ; bilinmeyen sıfır sayılmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-2', gelirler: [10000]});
 finansKaydi(f, {paket: 'PKG-2', siparis: 'ORD-2', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-2', siparis: 'ORD-2', tur: 'Payment', tutar: 900});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 0);
 assert.equal(r.incomplete, 1, 'eksik olarak sayılmalı: ' + JSON.stringify(r));
 const s = f.sqlite.prepare('SELECT commission_cents k, fees_status st FROM ec_sale_entries').get();
 assert.equal(s.k, null, 'komisyon yazılmamalı');
 assert.equal(s.st, 'pending', 'ödeme geldi diye kesinleşmemeli');
});

test('defterde kesinleşmiş kayıt varsa paket atlanır; iki kaynak üst üste yazmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-3', gelirler: [5000, 5000]});
 f.sqlite.prepare("UPDATE ec_sale_entries SET fees_status='confirmed',commission_cents=111,shipping_cents=0,other_cents=0 WHERE external_id='order:ORD-3:0'").run();
 finansKaydi(f, {paket: 'PKG-3', siparis: 'ORD-3', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-3', siparis: 'ORD-3', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 0);
 assert.equal(r.alreadyConfirmed, 1);
 assert.equal(f.sqlite.prepare("SELECT commission_cents k FROM ec_sale_entries WHERE external_id='order:ORD-3:0'").get().k, 111, 'mevcut kayıt korunmalı');
});

test('aynı siparişin birden çok paketi varsa dokunulmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-4', gelirler: [5000]});
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'hepsiburada','RPT-ORD-4-B','ORD-4','2026-09-20','draft','fp2')").run(crypto.randomUUID());
 finansKaydi(f, {paket: 'PKG-4', siparis: 'ORD-4', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-4', siparis: 'ORD-4', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 0);
 assert.equal(r.ambiguous, 1);
});

test('stopaj ve ödeme gider olarak yazılmaz', () => {
 const p = paketKesintileri([
  {package_no: 'P', order_no: 'O', type: 'Commission', amount: -10},
  {package_no: 'P', order_no: 'O', type: 'ShipmentCostSharingExpense', amount: -20},
  {package_no: 'P', order_no: 'O', type: 'Stoppage', amount: -5},
  {package_no: 'P', order_no: 'O', type: 'Payment', amount: 300},
  {package_no: 'P', order_no: 'O', type: 'TotalPayment', amount: 300}
 ])[0];
 assert.equal(p.commission, 1000);
 assert.equal(p.shipping, 2000);
 assert.equal(p.other, 0, 'stopaj ve ödeme diğer gidere girmemeli');
 assert.equal(kesintiTam(p), true);
});

test('kampanya indirimi tek başına kesinti saymaz; paket bekleyen kalır', () => {
 const p = paketKesintileri([{package_no: 'P', order_no: 'O', type: 'CampaignDiscount', amount: 532.8}])[0];
 assert.equal(p.commission, 0);
 assert.equal(p.other, 0, 'anlamı ölçülmeden deftere yazılmamalı');
 assert.equal(kesintiTam(p), false);
});

test('satış kaydı olmayan pakete kesinti yazılmaz', async () => {
 const f = fixture();
 finansKaydi(f, {paket: 'PKG-5', siparis: 'ORD-5', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-5', siparis: 'ORD-5', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 0);
 assert.equal(r.unmatched, 1, 'yerel paket yoksa eşleşmemiş sayılır');
});

test('önizlemede hiçbir şey yazılmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-6', gelirler: [10000]});
 finansKaydi(f, {paket: 'PKG-6', siparis: 'ORD-6', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-6', siparis: 'ORD-6', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: false});
 assert.equal(r.applied, 1, 'ne olacağını söylemeli');
 assert.equal(f.sqlite.prepare('SELECT fees_status st FROM ec_sale_entries').get().st, 'pending', 'yazmamalı');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n, 0);
});

// EŞLEŞME ÖNCE PAKET NUMARASIYLA. Yerel paketlerin bir kısmının kimliği doğrudan pazaryerinin
// paket numarasıdır ('HB-…'); orada siparişe düşmeye gerek yok. Canlıda 46 paket "belirsiz" diye
// atlanıyordu, çoğu aslında bir İPTAL + bir teslim paketiydi.
test('paket numarası birebir tutuyorsa sipariş numarasına düşülmez', async () => {
 const f = fixture();
 const paketId = satisliPaket(f, {siparis: 'ORD-7', gelirler: [10000]});
 f.sqlite.prepare("UPDATE ec_order_packages SET external_id='HB-PKG-7' WHERE id=?").run(paketId);
 // Aynı siparişin ikinci paketi var: sipariş numarasıyla arasaydık belirsiz sayılırdı.
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'hepsiburada','RPT-ORD-7-B','ORD-7','2026-09-20','draft','fp7b')").run(crypto.randomUUID());
 finansKaydi(f, {paket: 'PKG-7', siparis: 'ORD-7', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-7', siparis: 'ORD-7', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.ambiguous, 0, JSON.stringify(r));
 assert.equal(r.applied, 1);
 assert.equal(f.sqlite.prepare('SELECT commission_cents k FROM ec_sale_entries').get().k, 3000);
});

test('iptal edilmiş paket aday sayılmaz; tek gerçek paket belirsiz olmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-8', gelirler: [10000]});
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint,cancel_reason) VALUES(?,'hepsiburada','RPT-ORD-8-IPTAL','ORD-8','2026-09-20','cancelled','fp8','müşteri vazgeçti')").run(crypto.randomUUID());
 finansKaydi(f, {paket: 'PKG-8', siparis: 'ORD-8', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-8', siparis: 'ORD-8', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.ambiguous, 0, JSON.stringify(r));
 assert.equal(r.applied, 1);
});

test('iptal dışında gerçekten iki paket varsa hâlâ dokunulmaz', async () => {
 const f = fixture();
 satisliPaket(f, {siparis: 'ORD-9', gelirler: [10000]});
 f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'hepsiburada','RPT-ORD-9-B','ORD-9','2026-09-20','draft','fp9b')").run(crypto.randomUUID());
 finansKaydi(f, {paket: 'PKG-9', siparis: 'ORD-9', tur: 'Commission', tutar: -30});
 finansKaydi(f, {paket: 'PKG-9', siparis: 'ORD-9', tur: 'ShipmentCostSharingExpense', tutar: -50});
 const r = await pazaryeriKesintileriniIsle(f.env, {commit: true});
 assert.equal(r.applied, 0);
 assert.equal(r.ambiguous, 1);
});
