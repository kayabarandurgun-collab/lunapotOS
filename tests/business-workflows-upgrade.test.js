import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
const dir=new URL('../migrations/',import.meta.url),files=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
const old=files.filter(f=>Number(f.slice(0,4))<=65),next=files.filter(f=>/^006[678]_/.test(f));
const run=(db,list,split=false)=>{for(const f of list){const sql=readFileSync(new URL(f,dir),'utf8');if(split){for(const q of unstable_splitSqlQuery(sql))db.exec(q);}else db.exec(sql);}};
test('0066-0068 upgrade populated old schema without rewriting balances, sales or historic ledger rows',()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 try{
  run(db,old);
  db.prepare("INSERT INTO ec_products(id,name,sku) VALUES('upgrade-ec','Mevcut torf','UP-EC')").run();
  db.prepare("INSERT INTO products(id,name,sku,updated_at) VALUES('upgrade-lp','Mevcut saksı','UP-LP','2026-09-01')").run();
  for(const ns of ['ec','lp']){
   db.prepare('INSERT INTO '+ns+"_suppliers(id,name) VALUES('upgrade-party','Mevcut tedarikçi')").run();
   db.prepare('INSERT INTO '+ns+"_party_entries(id,party_id,amount_cents,occurred_on,due_on,reference,description,source_key,source) VALUES('upgrade-entry','upgrade-party',-12345,'2026-09-01','2026-10-10','UP-BORC','Kayıtlı borç','UP-SOURCE','opening')").run();
  }
  db.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('upgrade-stock','upgrade-ec',9000,12345,'opening','UP-STOCK','2026-09-01')").run();
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const before=Object.fromEntries(names.map(n=>[n,JSON.stringify(db.prepare('SELECT * FROM '+n).all())]));
  assert.equal(next.length,3);run(db,next,true);
  for(const n of names)assert.equal(JSON.stringify(db.prepare('SELECT * FROM '+n).all()),before[n],n+' historic data unchanged');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT revision FROM ec_warehouse_stock_versions WHERE product_id='upgrade-ec'").get().revision,0);
  db.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES('upgrade-new','upgrade-ec',1000,2000,'opening','UP-NEW','2026-10-04')").run();
  assert.equal(db.prepare("SELECT revision FROM ec_warehouse_stock_versions WHERE product_id='upgrade-ec'").get().revision,1);
  assert.equal(db.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='upgrade-ec'").get().quantity_milli,10000);
 }finally{db.close();}
});
test('new migration triggers survive Wrangler production splitting and match whole-file schema',()=>{
 const whole=new DatabaseSync(':memory:'),split=new DatabaseSync(':memory:');
 try{for(const db of [whole,split]){db.exec('PRAGMA foreign_keys=ON');run(db,old);}run(whole,next);run(split,next,true);
  const schema=db=>db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>({...x,sql:x.sql?.replace(/\s+/g,' ').replace(/;$/,'').trim()}));
  assert.deepEqual(schema(split),schema(whole));
  for(const f of next)for(const q of unstable_splitSqlQuery(readFileSync(new URL(f,dir),'utf8')).filter(s=>/CREATE TRIGGER/i.test(s)))assert.match(q.trim(),/END;?$/);
 }finally{whole.close();split.close();}
});
