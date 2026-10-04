import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {unstable_splitSqlQuery} from 'wrangler';
import {warehouseFixture} from './warehouse-fixture.test.js';
import {reorderProposal} from '../src/warehouse-api.js';
import {parseWarehouseNumber,warehouseEscape} from '../public/warehouse-ui.js';

test('0067 applies through Wrangler splitter to populated 0065 without changing old rows',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')&&f<'0066').sort())db.exec(readFileSync('migrations/'+file,'utf8'));
  db.exec("INSERT INTO ec_products(id,name,sku) VALUES('a','existing','a');INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('m','a',1000,200,'opening','m','2026-09-01')");
  const before=db.prepare('SELECT * FROM ec_stock_balances').all();const sql=readFileSync('migrations/0067_warehouse_workflows.sql','utf8');
  for(const part of unstable_splitSqlQuery(sql))db.exec(part);
  assert.deepEqual(db.prepare('SELECT * FROM ec_stock_balances').all(),before);assert.equal(db.prepare('SELECT revision FROM ec_warehouse_stock_versions').get().revision,0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close();}
});

test('replenishment explains unknown lead time, rounds packs and never subtracts shipped stock twice',()=>{
 const p={id:'a',name:'A',sku:'A',stock_unit:'adet',available_milli:2000,min_stock_milli:10000,in_transit_milli:50000};
 assert.equal(reorderProposal(p).suggested_milli,null);assert.equal(reorderProposal(p).min_gap_milli,8000);
 const r=reorderProposal(p,{lead_days:5,cover_days:5,pack_milli:3000},30000);assert.equal(r.target_milli,10000);assert.equal(r.suggested_milli,9000);
 assert.equal(reorderProposal({...p,available_milli:null},{lead_days:2}).suggested_milli,null);
 assert.equal(parseWarehouseNumber('0'),0);assert.equal(parseWarehouseNumber(''),null);assert.equal(parseWarehouseNumber('1,234'),1234);assert.equal(parseWarehouseNumber('12,34',100),1234);
 for(const x of ['-1','Infinity','1.1234','1e3'])assert.throws(()=>parseWarehouseNumber(x));assert.equal(warehouseEscape('<script>"'), '&lt;script&gt;&quot;');
});

test('set alternatives share physical components; demand is not counted twice; configs use optimistic concurrency',async()=>{
 const f=warehouseFixture();try{await f.setup();f.product('a',10000,10000);f.product('b',3000,3000);
 await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'SET',components:[{product_id:'a',quantity_milli:2000,revenue_share_bps:6000},{product_id:'b',quantity_milli:1000,revenue_share_bps:4000}]});
 await f.ok('/ec/catalog/mappings',{source:'hepsiburada',external_code:'SET-B',components:[{product_id:'a',quantity_milli:1000,revenue_share_bps:6000},{product_id:'b',quantity_milli:1000,revenue_share_bps:4000}]});
 await f.ok('/ec/sales',{product_id:'a',quantity:2,channel:'other',external_id:'demand',occurred_on:new Date().toISOString().slice(0,10),revenue:20,commission:0,shipping:0,other:0,notes:'Sold component'});
 const r=await f.call('');assert.equal(r.replenishment.sets.length,2);assert.deepEqual(r.replenishment.sets.map(s=>s.capacity),[3,3]);assert.equal(r.replenishment.proposals.find(p=>p.product_id==='a').demand_30_milli,2000);assert.equal(r.stock.length,2);
 await f.call('/settings/a',{revision:0,lead_days:5,cover_days:7,pack_milli:1000});await assert.rejects(()=>f.call('/settings/a',{revision:0,lead_days:3,cover_days:7,pack_milli:1000}),e=>e.status===409);
 assert.equal((await f.call('')).replenishment.proposals.find(p=>p.product_id==='a').lead_days,5);
 }finally{f.close();}
});

test('stock movement arriving between review and atomic apply causes full rollback, and edits invalidate review',async()=>{
 const f=warehouseFixture();try{f.product('a',10000,10000);let s=await f.create(['a']);s=await f.save(s,[{product_id:'a',counted_milli:8000}]);const review=await f.review(s);
 s=await f.save(review,[{product_id:'a',counted_milli:7000}]);await assert.rejects(()=>f.apply(review),e=>e.status===409);
 s=await f.review(s);const batch=f.env.DB.batch;let fired=false;f.env.DB.batch=async items=>{if(!fired){fired=true;f.sqlite.exec("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('race','a',1000,1000,'count','race',date('now'))");}return batch(items);};
 await assert.rejects(()=>f.apply(s),e=>e.status===409);f.env.DB.batch=batch;
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,0);
 assert.equal((await f.call('/sessions/'+s.session.id)).session.status,'reviewed');
 }finally{f.close();}
});

test('count blocks below reserved physical stock even when negative-stock setting permits sales',async()=>{
 const f=warehouseFixture();try{await f.setup();f.product('a',10000,10000);
 f.sqlite.exec("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,source_fingerprint) VALUES('rp','other','rp','2026-09-01','test');INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES('rl','rp','rl','Ürün',5000,5000,6000,2000);INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit) VALUES('rc','rl','a',5000,10000,'adet');UPDATE ec_order_packages SET status='reserved' WHERE id='rp'");
 f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
 let s=await f.create(['a']);s=await f.save(s,[{product_id:'a',counted_milli:4000}]);await assert.rejects(()=>f.review(s),e=>e.status===409&&/ayrılan/.test(e.message));
 }finally{f.close();}
});
