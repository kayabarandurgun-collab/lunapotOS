import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {scopedDB} from '../src/scoped-db.js';
import {ordersApi} from '../src/orders-api.js';
import {ordersQuery} from '../src/orders-query.js';
import {attentionApi} from '../src/attention-api.js';
import {attentionItems} from '../public/attention-ui.js';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()){
  const sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');if(file>='0020')for(const q of unstable_splitSqlQuery(sql))sqlite.exec(q);else sqlite.exec(sql);
 }
 const raw={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},all(){return {results:sqlite.prepare(sql).all(...this.args)};},first(){return sqlite.prepare(sql).get(...this.args)||null;}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(i=>i.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB:scopedDB(raw,'ec'),WORKSPACE:'ec'},query=p=>ordersApi(new Request('https://test.local/api/ec/orders?'+new URLSearchParams(p)),env,'/api/orders');
 const insert=sqlite.prepare('INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint,shipment_reference,shipped_on) VALUES(?,?,?,?,?,?,?,?,?)');
 const add=(id,channel='trendyol',day='2026-09-09',status='draft',shipment=null,shipped=null)=>insert.run(id,channel,id,'order-'+id,day,status,'fixture',shipment,shipped);
 return {sqlite,env,query,add,close:()=>sqlite.close()};
}
test('Sipariş araması son 500 kaydın dışına erişir; sayfalama ve bağlı satırlar aynı filtreyi kullanır',async()=>{
 const f=fixture();try{
  f.add('old-target','hepsiburada','2025-01-01','draft','CARGO-%_42','2025-01-02');
  f.sqlite.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,gross_cents,vat_bps,net_revenue_cents) VALUES('old-line','old-target','line','Torf',1000,12000,2000,10000)").run();
  f.sqlite.exec('BEGIN');for(let i=0;i<521;i++)f.add('new-'+i);f.sqlite.exec('COMMIT');
  const first=await f.query({limit:50});assert.equal(first.packages.length,50);assert.equal(first.pagination.total,522);assert.equal(first.pagination.pages,11);assert.equal(first.pagination.has_more,true);assert.equal(first.lines.length,0);
  const next=await f.query({limit:50,page:2});assert.ok(!next.packages.some(p=>first.packages.some(x=>x.id===p.id)));
  const old=await f.query({q:'CARGO-%_42',channel:'hepsiburada',status:'draft',from:'2025-01-01',to:'2025-12-31',limit:50});
  assert.deepEqual(old.packages.map(p=>p.id),['old-target']);assert.deepEqual(old.lines.map(l=>l.id),['old-line']);assert.equal(old.pagination.total,1);
  assert.equal((await f.query({q:'order-old-target'})).packages[0].id,'old-target');
  assert.equal((await f.query({q:"' OR 1=1 --"})).packages.length,0);
  assert.equal((await f.query({q:'%'})).packages.length,1,'SQL wildcard must be literal');
  assert.equal((await f.query({q:'old-target',channel:'trendyol'})).pagination.total,0);
  const last=await f.query({limit:50,page:11});assert.equal(last.packages.length,22);assert.equal(last.pagination.has_more,false);assert.equal(last.lines[0].id,'old-line');
  assert.equal((await f.query({package:'old-target',page:99})).packages[0].id,'old-target');
 }finally{f.close();}
});
test('Takip filtreleri tamamlanmış paketleri uzun kargo listesine katmaz; iş listesi doğru kayıtlara bağlanır',async()=>{
 const f=fixture();try{
  const now=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}),back=n=>new Date(Date.parse(now)-n*86400000).toISOString().slice(0,10);
  f.add('seven','trendyol',back(10),'shipped','shipment7',back(7));f.add('six','hepsiburada',back(9),'shipped','shipment6',back(6));f.add('done','trendyol',back(12),'delivered','shipmentdone',back(10));f.add('draft');
  f.sqlite.exec("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli) VALUES('draft-line','draft','line','Torf',1000)");
  assert.deepEqual((await f.query({watch:'long_shipping'})).packages.map(p=>p.id),['seven']);
  assert.deepEqual((await f.query({watch:'unmapped'})).packages.map(p=>p.id),['draft']);
  assert.deepEqual((await f.query({watch:'missing_amounts'})).packages.map(p=>p.id),['draft']);
  const data=await attentionApi(new Request('https://test.local/api/ec/attention'),f.env,'/api/attention');assert.equal(data.orders.long_shipping,1);
  const items=attentionItems(data,{providers:[]},{tax_id:'123',legal_name:'Test'});assert.equal(items.find(i=>i.href==='#orders?watch=long_shipping').count,1);assert.equal(items.find(i=>i.href==='#orders?watch=unmapped').count,1);
 }finally{f.close();}
});
test('Takip sorguları geçersiz tarih, kanal, durum, sayfa ve filtreyi reddeder',()=>{
 for(const p of [{from:'2026-02-30'},{from:'2026-09-10',to:'2026-09-01'},{channel:'unknown'},{status:'paid'},{watch:'unknown'},{page:0},{page:1.5},{limit:501},{q:'x'.repeat(201)}])assert.throws(()=>ordersQuery('https://test.local?'+new URLSearchParams(p)),e=>e.status===400);
});
