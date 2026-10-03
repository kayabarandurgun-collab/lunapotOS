// 0064 -> 0065 yükseltme: yalnız sentetik veride gerçek eski şema ve worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {scopedDB} from '../src/scoped-db.js';
import {provisionalHandler0064} from './helpers/provisional-handler-0064.js';
import {unstable_splitSqlQuery} from 'wrangler';
const sql65=readFileSync(new URL('../migrations/0065_provisional_allocations.sql',import.meta.url),'utf8');
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<'0065').sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},run(){return sqlite.prepare(sql).run(...this.args);},first(){return sqlite.prepare(sql).get(...this.args)||null;},all(){return {results:sqlite.prepare(sql).all(...this.args)};}};},async batch(items){sqlite.exec('BEGIN');try{const r=items.map(s=>s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'synthetic-upgrade'},origin='https://lunapot.test';let cookie='';
 async function req(path,body){const r=await worker.fetch(new Request(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json(),cookie:r.headers.get('Set-Cookie')?.split(';')[0]};}
 async function ok(path,body){const r=await req(path,body);assert.equal(r.status,200,JSON.stringify(r));return r.data;}
 return {sqlite,env,req,ok,upgrade:()=>sqlite.exec(sql65),async setup(){const r=await req('/auth/setup',{token:env.SETUP_TOKEN,password:'synthetic-owner-password'});assert.equal(r.status,200,JSON.stringify(r));cookie=r.cookie;},close:()=>sqlite.close()};
}
function legacy(f,{n=1,receipt='legacy',supplier='s1',reference='IRS-OLD',closed=false,reverse=false,duplicate=false}={}){
 const db=f.sqlite;
 db.prepare('INSERT OR IGNORE INTO ec_suppliers(id,name,tax_id) VALUES(?,?,?)').run(supplier,supplier,supplier==='s1'?'1234567890':'9876543210');
 db.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source) VALUES(?,?,?,'2026-09-10',?,'Eski giriş',?,'manual')").run('e:'+receipt,supplier,-n*120000,reference,'gecici:'+receipt);
 if(closed)db.prepare("INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES(?,?,?,'2026-09-30')").run('old:'+receipt,supplier,'OLD-'+receipt);
 db.prepare("INSERT INTO ec_provisional_receipts(id,supplier_id,occurred_on,reference,entry_id,invoice_id,closed_on) VALUES(?,?,'2026-09-10',?,?,?,?)").run(receipt,supplier,reference,'e:'+receipt,closed?'old:'+receipt:null,closed?'2026-09-30':null);
 for(let x=0;x<n;x++){
  const p='p'+x;db.prepare('INSERT OR IGNORE INTO ec_products(id,name,sku) VALUES(?,?,?)').run(p,p,p);
  db.prepare('INSERT INTO ec_provisional_receipt_lines(id,receipt_id,product_id,quantity_milli,unit_cost_cents,vat_bps) VALUES(?,?,?,10000,10000,2000)').run(receipt+':l'+x,receipt,p);
  for(let j=0;j<(duplicate?2:1);j++)db.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,10000,100000,'count',?,'2026-09-10')").run(receipt+'-m'+x+'-'+j,p,'GECICI-SAYIM-'+reference);
 }
 if(reverse)db.prepare("INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source,reversal_of) VALUES(?,?,?,'2026-09-11',?,'Ters kayıt',?,'reversal',?)").run('r:'+receipt,supplier,n*120000,'REV-'+receipt,'reverse:'+receipt,'e:'+receipt);
}
async function draft(f,supplier='s1',product='p0',no='NEW'){
 return f.ok('/ec/invoices',{supplier_id:supplier,invoice_no:no,invoice_date:'2026-09-30',currency:'TRY',lines:[{description:'Torf',invoice_quantity:2,invoice_unit:'adet',product_id:product,stock_quantity:2,net:240,tax:48}]});
}
async function receive(f,i){const l=f.sqlite.prepare('SELECT id FROM ec_purchase_lines WHERE invoice_id=?').get(i.id);return f.req('/ec/invoices/'+i.id+'/receive',{occurred_on:'2026-09-30',reference:'DEL-'+i.id,lines:[{id:l.id,quantity:2}]});}
const snapshot=f=>JSON.stringify(['ec_provisional_receipts','ec_provisional_receipt_lines','ec_stock_movements','ec_stock_balances','ec_party_entries'].map(t=>f.sqlite.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));

test('FA05 upgrade: 32 kesin bağlantı metadata olarak kurulur; eski defter hiç değişmez; farklı tedarikçi ayrılır',async()=>{
 const f=fixture();try{
  [5,5,5,5,6,6].forEach((n,k)=>legacy(f,{n,receipt:'legacy'+k,reference:'IRS-OLD-'+k}));const before=snapshot(f);f.upgrade();assert.equal(snapshot(f),before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_movement_links').get().n,32);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_receipt_lines WHERE movement_id IS NOT NULL').get().n,0);
  await f.setup();const receipts=(await f.ok('/ec/ledger/provisional')).receipts;assert.equal(receipts.length,6);assert.ok(receipts.every(r=>r.provisional_status==='open'));assert.equal(receipts.reduce((t,r)=>t+r.remaining_cents,0),3840000);
  const i=await draft(f);await f.ok('/ec/invoices/'+i.id+'/post',{});assert.equal((await receive(f,i)).status,200);
  assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM ec_stock_balances WHERE product_id='p0'").get().q,60000);
  await f.ok('/ec/suppliers',{name:'Diğer',tax_id:'9876543210'});const other=f.sqlite.prepare("SELECT id FROM ec_suppliers WHERE tax_id='9876543210'").get().id;
  const j=await draft(f,other,'p0','OTHER');await f.ok('/ec/invoices/'+j.id+'/post',{});assert.equal((await receive(f,j)).status,200);
  assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM ec_stock_balances WHERE product_id='p0'").get().q,62000);
  assert.throws(()=>f.sqlite.exec("UPDATE ec_provisional_movement_links SET movement_id='wrong'"),/IMMUTABLE_LEDGER/);
  assert.throws(()=>f.sqlite.exec("INSERT INTO ec_provisional_movement_links(provisional_line_id,movement_id) VALUES('legacy0:l0','legacy1-m0-0')"),/PROVISIONAL_LINK_MISMATCH/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_provisional_movement_links'),/IMMUTABLE_LEDGER/);
 }finally{f.close();}
});
for(const reason of ['reverse','quantity','shared','old-close'])test('FA05 upgrade: '+reason+' belirsizliğinde bağ uydurulmaz; post/receive açık 409 ile durur',async()=>{
 const f=fixture();try{
  legacy(f,{duplicate:reason==='duplicate',reverse:reason==='reverse'});
  if(reason==='quantity')f.sqlite.exec("UPDATE ec_provisional_receipt_lines SET quantity_milli=9000");
  if(reason==='shared'){
   // İkinci başlığın referansı ilk hareketin harf dizisini farklı biçimde paylaşamaz (UNIQUE);
   // aynı hareketi önceden açıkça kullanan satır yine tekil aday olmaktan çıkarır.
   f.sqlite.exec("INSERT INTO ec_provisional_receipts(id,supplier_id,occurred_on,reference) VALUES('other','s1','2026-09-10','OTHER'); INSERT INTO ec_provisional_receipt_lines(id,receipt_id,product_id,quantity_milli,unit_cost_cents,movement_id) VALUES('other:l','other','p0',10000,10000,'legacy-m0-0')");
  }
  if(reason==='old-close')f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('oldclose','p0',-1000,-10000,'purchase','provisional-close:legacy-m0-0:old:x','2026-09-11')");
  await f.setup();const already=await draft(f,'s1','p0','BEFORE');
  f.sqlite.prepare("UPDATE ec_purchase_invoices SET status='posted' WHERE id=?").run(already.id);
  const before=snapshot(f);f.upgrade();assert.equal(snapshot(f),before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_movement_links').get().n,0);
  assert.equal((await f.ok('/ec/ledger/provisional')).receipts.find(r=>r.id==='legacy').provisional_status,'legacy_unlinked');
  const i=await draft(f);const r=await f.req('/ec/invoices/'+i.id+'/post',{});
  assert.equal(r.status,409,JSON.stringify(r));assert.match(r.data.error,/eski.*bağ/i);
  assert.equal((await receive(f,already)).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_goods_receipts').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_allocations').get().n,0);
  await f.ok('/ec/suppliers',{name:'Bağımsız',tax_id:'9876543210'});const s=f.sqlite.prepare("SELECT id FROM ec_suppliers WHERE tax_id='9876543210'").get().id;
  const other=await draft(f,s,'p0','OTHER');await f.ok('/ec/invoices/'+other.id+'/post',{});assert.equal((await receive(f,other)).status,200);
 }finally{f.close();}
});
test('FA05 upgrade: eski invoice_id korunur ve doğrulanmış miktar sayılmaz',async()=>{
 const f=fixture();try{legacy(f,{closed:true});const before=snapshot(f);f.upgrade();assert.equal(snapshot(f),before);await f.setup();
 const s=(await f.ok('/ec/ledger/provisional')).receipts[0];assert.equal(s.provisional_status,'legacy_unlinked');assert.equal(s.invoice_id,'old:legacy');assert.equal(s.remaining_cents,null);assert.equal(s.lines[0].invoiced_milli,null);
 }finally{f.close();}
});
test('FA05: 0065 Wrangler tarafından bölündüğünde tetik gövdeleri korunur',()=>{
 const f=fixture();try{for(const part of unstable_splitSqlQuery(sql65))f.sqlite.exec(part);assert.ok(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='ec_provisional_allocations'").get());}finally{f.close();}
});

test('FA05 upgrade: aynı referans ve ürünün ikinci hareketi eski şemada da reddedilir',()=>{const f=fixture();try{assert.throws(()=>legacy(f,{duplicate:true}),/UNIQUE/);}finally{f.close();}});

test('FA05 upgrade: eski muhasebeleşmiş faturanın tahsissiz teslimi kesin bağlı eski girişi de çift sayamaz',async()=>{
 const f=fixture();try{
  legacy(f);await f.setup();const i=await draft(f);f.sqlite.prepare("UPDATE ec_purchase_invoices SET status='posted' WHERE id=?").run(i.id);
  f.upgrade();assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_movement_links').get().n,1);
  const before=snapshot(f),r=await receive(f,i);assert.equal(r.status,409,JSON.stringify(r));assert.match(r.data.error,/miktar bağı/);assert.equal(snapshot(f),before);
 }finally{f.close();}
});

test('PR03 upgrade: sonraki günün belirsiz eski girişi önceki faturayı/teslimi engellemez; kendi gününde koruma sürer',async()=>{
 const f=fixture();try{
  legacy(f);f.sqlite.exec("UPDATE ec_provisional_receipts SET occurred_on='2026-10-01'"); // eski metadata uyuşmazlığı; gelecekteki giriş
  f.upgrade();await f.setup();
  assert.equal((await f.ok('/ec/ledger/provisional')).receipts[0].provisional_status,'legacy_unlinked');
  const i=await draft(f);await f.ok('/ec/invoices/'+i.id+'/post',{});assert.equal((await receive(f,i)).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_allocations').get().n,0);
  assert.equal(f.sqlite.prepare("SELECT quantity_milli q FROM ec_stock_balances WHERE product_id='p0'").get().q,12000);
  const j=await draft(f,'s1','p0','ON-DATE');f.sqlite.prepare("UPDATE ec_purchase_invoices SET invoice_date='2026-10-01' WHERE id=?").run(j.id);
  const r=await f.req('/ec/invoices/'+j.id+'/post',{});assert.equal(r.status,409);assert.match(r.data.error,/eski.*bağ/);
 }finally{f.close();}
});

test('PR02 upgrade: 0064 handlerın migration sonrası bağsız yazısı bütün batch ile geri alınır',async()=>{
 const f=fixture();try{
  await f.setup();const supplier=await f.ok('/ec/suppliers',{name:'Eski yazıcı',tax_id:'1234567890'});
  const product=await f.ok('/ec/products',{name:'Geçiş Torf',sku:'UPGRADE-WRITER',stock_unit:'kg',min_stock:0});
  const db=scopedDB(f.env.DB,'ec'),body={supplier_id:supplier.id,occurred_on:'2026-09-12',reference:'BEFORE-GATE',lines:[{product_id:product.id,quantity:10,unit_cost:100,vat_bps:2000}]};
  const previous=await provisionalHandler0064(db,body);assert.ok(previous.id);
  assert.equal(f.sqlite.prepare('SELECT movement_id FROM ec_provisional_receipt_lines WHERE receipt_id=?').get(previous.id).movement_id,null);
  const original=snapshot(f);f.upgrade();assert.equal(snapshot(f),original);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_provisional_movement_links').get().n,1,'eski NULL kayıt kesin metadata bağıyla korunur');
  const before=snapshot(f);
  await assert.rejects(()=>provisionalHandler0064(db,{...body,reference:'LATE-OLD-WRITER'}),/PROVISIONAL_LINK_REQUIRED/);
  assert.equal(snapshot(f),before,'eski yazarın borç/başlık/stok/satır batchinin tamamı geri alınır');
  const current=await f.ok('/ec/ledger/provisional',{...body,reference:'CURRENT-WRITER'});assert.equal(current.provisional_status,'open');
  assert.ok(f.sqlite.prepare('SELECT movement_id FROM ec_provisional_receipt_lines WHERE receipt_id=?').get(current.id).movement_id,'güncel yazıcı açık bağıyla çalışır');
 }finally{f.close();}
});
