import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseFixture} from './warehouse-fixture.test.js';
import {scopedDB} from '../src/scoped-db.js';
import {warehouseApi} from '../src/warehouse-api.js';
import {productProfileApi} from '../src/product-profile-api.js';
import {fifoHesap,fifoRevalue} from '../src/fifo-cost.js';

test('saved count survives clients; only counted physical products post atomically and repeated apply is idempotent',async()=>{
 const f=warehouseFixture();try{f.product('a',10000,10001);f.product('b',7000,3500);f.product('c',2000,2000);
  let s=await f.create(['a','b','c'],'same-phone-request');assert.equal(s.lines.length,3);
  assert.equal((await f.create(['a','b','c'],'same-phone-request')).session.id,s.session.id);
  s=await f.save(s,[{product_id:'a',counted_milli:8000},{product_id:'b',counted_milli:9000,unit_cost_cents:600}]);
  const resumed=await f.call('/sessions/'+s.session.id);assert.equal(resumed.summary.counted,2);assert.equal(resumed.summary.uncounted,1);
  s=await f.review(resumed);assert.equal(s.summary.delta_value_cents,-800);
  const result=await f.apply(s);assert.equal(result.session.status,'applied');assert.equal((await f.apply(s)).repeated,true);
  assert.deepEqual({...f.sqlite.prepare("SELECT quantity_milli,value_cents FROM ec_stock_balances WHERE product_id='a'").get()},{quantity_milli:8000,value_cents:8001});
  assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='c'").get().quantity_milli,2000);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,2);
  assert.equal(f.sqlite.prepare("SELECT amount_cents FROM ec_expenses WHERE category='loss'").get().amount_cents,2000);
  assert.ok(f.sqlite.prepare("SELECT 1 FROM ec_cost_dirty WHERE product_id='a'").get());
  await fifoRevalue(f.env.DB,100);assert.equal((await fifoHesap(f.env.DB,'a')).artik,0);assert.equal((await fifoHesap(f.env.DB,'b')).artik,0);
 }finally{f.close();}
});

test('unknown gain cost blocks review and direct DB apply; explicitly zero is known, not unknown',async()=>{
 const f=warehouseFixture();try{f.product('a');let s=await f.create(['a']);s=await f.save(s,[{product_id:'a',counted_milli:2000}]);
  assert.equal(s.lines[0].delta_value_cents,null);await assert.rejects(()=>f.review(s),e=>e.status===400&&/maliyet/.test(e.message));
  assert.throws(()=>f.sqlite.prepare("UPDATE ec_warehouse_sessions SET status='reviewed',revision=revision+1,review_token='x',occurred_on=date('now','+3 hours') WHERE id=?").run(s.session.id),/WAREHOUSE_COST_REQUIRED/);
  s=await f.save(s,[{product_id:'a',counted_milli:2000,unit_cost_cents:0}]);s=await f.review(s);await f.apply(s);
  assert.equal(f.sqlite.prepare("SELECT value_cents FROM ec_stock_balances WHERE product_id='a'").get().value_cents,0);
 }finally{f.close();}
});

test('net-zero movement and value-only change invalidate count; explicit recount captures fresh baseline',async()=>{
 const f=warehouseFixture();try{f.product('a',10000,10000);let s=await f.create(['a']);s=await f.save(s,[{product_id:'a',counted_milli:9000}]);
  const move=f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,'a',?,?,'count',?,date('now'))");
  move.run('in',1000,1000,'in');move.run('out',-1000,-1000,'out');
  await assert.rejects(()=>f.review(s),e=>e.status===409);s=await f.call('/sessions/'+s.session.id);assert.equal(s.lines[0].conflict,1);
  s=await f.save(s,[{product_id:'a',counted_milli:9000,recount:true}]);s=await f.review(s);
  f.sqlite.exec("UPDATE ec_stock_balances SET value_cents=value_cents+1 WHERE product_id='a'");await assert.rejects(()=>f.apply(s),e=>e.status===409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,0);
 }finally{f.close();}
});

test('concurrent saves reject stale revision; concurrent applies post once; late trigger failure rolls back entire count',async()=>{
 const f=warehouseFixture();try{f.product('a',10000,10000);f.product('b',10000,10000);let s=await f.create();
  const writes=await Promise.allSettled([f.save(s,[{product_id:'a',counted_milli:9000}]),f.save(s,[{product_id:'b',counted_milli:8000}])]);
  assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);assert.equal(writes.filter(x=>x.status==='rejected')[0].reason.status,409);
  s=await f.call('/sessions/'+s.session.id);s=await f.save(s,[{product_id:'a',counted_milli:9000},{product_id:'b',counted_milli:8000}]);s=await f.review(s);
  f.sqlite.exec("CREATE TRIGGER warehouse_test_failure BEFORE INSERT ON ec_stock_movements WHEN NEW.product_id='b' AND NEW.reference LIKE 'warehouse:%' BEGIN SELECT RAISE(ABORT,'TEST_FAILURE'); END;");
  await assert.rejects(()=>f.apply(s),/TEST_FAILURE/);assert.equal(f.sqlite.prepare("SELECT quantity_milli FROM ec_stock_balances WHERE product_id='a'").get().quantity_milli,10000);
  assert.equal((await f.call('/sessions/'+s.session.id)).session.status,'reviewed');f.sqlite.exec('DROP TRIGGER warehouse_test_failure');
  const applies=await Promise.all([f.apply(s),f.apply(s)]);assert.ok(applies.some(a=>a.repeated));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE reference LIKE 'warehouse:%'").get().n,2);
 }finally{f.close();}
});

test('read endpoints are SQL read-only; namespace and staff write/amount permissions are enforced',async()=>{
 const f=warehouseFixture();try{f.product('a',10000,20000);let s=await f.create(['a']);const read={ec_access:'read',permissions:{ec:{stock:'read',amounts:'none'}}};
  const before=f.sqlite.prepare('SELECT total_changes() n').get().n;const data=await f.call('',undefined,'ec',read);const after=f.sqlite.prepare('SELECT total_changes() n').get().n;
  assert.equal(before,after);assert.equal(data.stock[0].value_cents,null);assert.equal((await f.call('/sessions/'+s.session.id,undefined,'ec',read)).lines[0].snapshot_value_cents,null);
  await assert.rejects(()=>f.call('/sessions',{request_key:'x',title:'No'},'ec',read),e=>e.status===403);
  await assert.rejects(()=>f.call('',undefined,'lp',read),e=>e.status===403);assert.equal((await f.call('',undefined,'lp')).supported,false);
  await assert.rejects(()=>f.call('/sessions/'+s.session.id,undefined,'lp'),e=>e.status===400);
  await assert.rejects(()=>f.create(['set-does-not-exist']),e=>e.status===404||e.status===400);
  assert.equal((await f.profile('a','ec',read)).product.value_cents,null);
 }finally{f.close();}
});
