import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.js';
import {scopedDB} from '../src/scoped-db.js';
import {physicalStock,pendingPackageScopeSql,stockTransitQuery} from '../src/stock-availability.js';
import {tumSatirlar} from '../src/performance-api.js';
const date='2026-09-19';
const stock=async f=>(await f.ok('/ec?from=2020-01-01&to=2020-01-02')).stock;
function products(f,ids=['A','B','C'],amount=20){
 for(const p of ids){
  f.sqlite.prepare("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES(?,?,?,'adet')").run(p,p,p);
  f.sqlite.prepare("INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,occurred_on) VALUES(?,?,?,?,'opening',?,?)").run('open-'+p,p,amount*1000,amount*1000,'open-'+p,date);
 }
}
async function mixed(f,external='MIX',quantity=1){
 await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:external,match_by:'code',components:[{product_id:'A',quantity_milli:1000,revenue_share_bps:3334},{product_id:'B',quantity_milli:1000,revenue_share_bps:3333},{product_id:'C',quantity_milli:1000,revenue_share_bps:3333}]});
 return f.ok('/ec/orders',{channel:'trendyol',external_id:external,order_no:external,occurred_on:date,lines:[{external_id:external+'-line',sku:external,name:'Üç farklı fiziksel ürün içeren set',quantity,net_revenue:quantity*60}]});
}
const ship=(f,id)=>f.ok('/ec/orders/'+id+'/ship',{reference:'ship-'+id,occurred_on:date});
function parcel(f,id,{status='shipped',order=id,channel='trendyol',product='A',quantity=1000}={}){
 const db=f.sqlite;
 db.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,source_fingerprint) VALUES(?,?,?,?,?,'synthetic')").run(id,channel,id,order,date);
 db.prepare("INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) VALUES(?,?,?,'Ürün',?,10000,12000,2000)").run('line-'+id,id,'line-'+id,quantity);
 if(status!=='reserved')db.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,fees_status,occurred_on) VALUES(?,?,?,?,'sale',?,10000,1000,'pending',?)").run('sale-'+id,channel,'sale-'+id,product,quantity,date);
 db.prepare("INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,sale_id) VALUES(?,?,?,?,10000,'adet',?)").run('part-'+id,'line-'+id,product,quantity,status==='reserved'?null:'sale-'+id);
 db.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
 if(status!=='reserved')db.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(date,id);
 if(status==='delivered')db.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(date,id);
}
function fullReturn(f,id,technical=false){
 f.sqlite.prepare("INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,parent_id,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,restock,occurred_on) SELECT ?,channel,?,product_id,'return',id,quantity_milli,-revenue_cents,-cost_cents,0,0,0,'confirmed',1,? FROM ec_sale_entries WHERE id=?")
 .run('return-'+id,(technical?'DUZELTME-CIFT-':'RETURN-')+id,date,'sale-'+id);
}

test('mixed set: reserve preserves onhand; ship removes exactly three physical components once; deliver never deducts again',async()=>{
 const f=appFixture();try{await f.setup();products(f);const p=await mixed(f);
  await f.ok('/ec/orders/'+p.id+'/reserve',{});
  for(const r of await stock(f))assert.deepEqual([r.quantity_milli,r.on_hand_milli,r.reserved_milli,r.available_milli,r.in_transit_milli],[20000,20000,1000,19000,0]);
  await ship(f,p.id);await ship(f,p.id);
  for(const r of await stock(f))assert.deepEqual([r.on_hand_milli,r.reserved_milli,r.available_milli,r.in_transit_milli],[19000,0,19000,1000]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE kind='sale'").get().n,3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_sale_entries WHERE kind='sale'").get().n,3);
  await f.ok('/ec/orders/'+p.id+'/deliver',{occurred_on:date});await f.ok('/ec/orders/'+p.id+'/deliver',{occurred_on:date});
  for(const r of await stock(f))assert.deepEqual([r.on_hand_milli,r.available_milli,r.in_transit_milli],[19000,19000,0]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_stock_movements WHERE kind='sale'").get().n,3);
 }finally{f.close();}
});

test('component partial return leaves other components in transit; restock alone increases onhand',async()=>{
 const f=appFixture();try{await f.setup();products(f);const p=await mixed(f,'PARTIAL',2);await f.ok('/ec/orders/'+p.id+'/reserve',{});await ship(f,p.id);
  for(const [product,restock] of [['A',true],['B',false]]){
   const s=f.sqlite.prepare("SELECT id FROM ec_sale_entries WHERE kind='sale' AND product_id=?").get(product);
   await f.ok('/ec/sales/'+s.id+'/return',{external_id:'RETURN-'+product,quantity:1,revenue:10,commission:0,shipping:0,other:0,fees_status:'confirmed',restock,occurred_on:date});
  }
  const rows=new Map((await stock(f)).map(r=>[r.id,r]));
  assert.deepEqual(['A','B','C'].map(id=>rows.get(id).on_hand_milli),[19000,18000,18000]);
  assert.deepEqual(['A','B','C'].map(id=>rows.get(id).in_transit_milli),[1000,1000,2000]);
  assert.deepEqual(['A','B','C'].map(id=>rows.get(id).available_milli),[19000,18000,18000]);
 }finally{f.close();}
});

test('125 stored shipped minus 3 full returns minus 6 delivered DUZ twins equals 116 real shipped; 8 reserved stay separate',async()=>{
 const f=appFixture();try{await f.setup();products(f,['A'],1000);
  for(let i=0;i<125;i++)parcel(f,'p'+i);
  for(let i=0;i<3;i++)fullReturn(f,'p'+i);
  for(let i=3;i<9;i++){parcel(f,'dup'+i,{order:'p'+i,status:'delivered'});fullReturn(f,'dup'+i,true);}
  for(let i=0;i<8;i++)parcel(f,'reserved'+i,{status:'reserved'});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_order_packages WHERE status='shipped'").get().n,125);
  const db=scopedDB(f.env.DB,'ec');
  const eligible=(await db.prepare("SELECT p.id,p.status FROM order_packages p WHERE p.status IN ('draft','reserved','shipped') AND "+pendingPackageScopeSql('p')).all()).results;
  assert.equal(eligible.filter(p=>p.status==='shipped').length,116);assert.equal(eligible.filter(p=>p.status==='reserved').length,8);
  const performance=await tumSatirlar({...f.env,DB:db,WORKSPACE:'ec'},{mode:'pending',from:date,to:date});
  assert.deepEqual(new Set(performance.rows.map(p=>p.id)),new Set(eligible.map(p=>p.id)),'shared scope matches performance after returns and twins');
  const r=(await stock(f))[0];assert.deepEqual([r.on_hand_milli,r.reserved_milli,r.available_milli,r.in_transit_milli],[878000,8000,870000,116000]);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_movements').get().n;await stock(f);await stock(f);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_stock_movements').get().n,before,'availability GET performs no movements');
 }finally{f.close();}
});

test('DUZ corrected shipped duplicate counts its original once; channel identity and other-channel physical stock are preserved',async()=>{
 const f=appFixture();try{await f.setup();products(f,['A'],100);
  parcel(f,'original',{order:'same'});parcel(f,'copy',{order:'same'});fullReturn(f,'copy',true);
  assert.equal((await stock(f))[0].in_transit_milli,1000);
  parcel(f,'delivered',{order:'same',status:'delivered'});fullReturn(f,'delivered',true);
  parcel(f,'hb',{order:'same',channel:'hepsiburada'});parcel(f,'other',{channel:'other'});
  const r=(await stock(f))[0];assert.equal(r.in_transit_milli,2000);assert.equal(r.available_milli,97000);
 }finally{f.close();}
});

test('missing mapping, missing sale and changed source stay unknown, with separate verified subtotal and no onhand modification',async()=>{
 const f=appFixture();try{await f.setup();products(f,['A','B'],30);parcel(f,'known');parcel(f,'stale');
  f.sqlite.prepare("UPDATE ec_order_packages SET source_changed=1 WHERE id='stale'").run();
  let rows=await stock(f);assert.ok(rows.every(r=>r.in_transit_milli===null&&r.in_transit_status==='incomplete'));
  assert.equal(rows[0].in_transit_known_milli,1000);assert.match(rows[0].in_transit_notes.join(' '),/kaynak bilgisi değişmiş/);
  f.sqlite.prepare("UPDATE ec_order_packages SET source_changed=0 WHERE id='stale'").run();
  // Legacy malformed imported shipment: direct fixture insert intentionally bypasses status transition validation.
  f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,occurred_on,status,source_fingerprint) VALUES('unmapped','trendyol','unmapped',?,'shipped','legacy')").run(date);
  rows=await stock(f);assert.equal(rows[0].in_transit_milli,null);assert.equal(rows[0].in_transit_known_milli,2000);assert.match(rows[0].in_transit_notes.join(' '),/eşleşmesi eksik/);
  assert.equal(rows[0].on_hand_milli,28000);assert.equal(rows[0].available_milli,28000);
 }finally{f.close();}
});

test('quantity-only reader sees physical fields but never money; count keeps existing reference/cost validation and actual warehouse scope',async()=>{
 const f=appFixture();try{await f.setup();products(f,['A'],20);parcel(f,'pending',{status:'reserved',quantity:2000});parcel(f,'out',{quantity:3000});
  await f.ok('/ec/stock',{product_id:'A',kind:'count',quantity:16,reference:'COUNT-physical',notes:'Ayrılan iki ürün dahil fiziksel depo',occurred_on:date});
  let r=(await stock(f))[0];assert.deepEqual([r.on_hand_milli,r.reserved_milli,r.available_milli,r.in_transit_milli],[16000,2000,14000,3000]);
  const bad=await f.req('/ec/stock',{product_id:'A',kind:'count',quantity:17,reference:'COUNT-more',notes:'Maliyeti eksik',occurred_on:date});assert.equal(bad.status,400);
  const noRef=await f.req('/ec/stock',{product_id:'A',kind:'count',quantity:15,reference:'',notes:'Referansı eksik',occurred_on:date});assert.equal(noRef.status,400);
  const staff=await f.ok('/admin/users',{name:'Depo',username:'warehouse',permissions:{ec:{stock:'read',orders:'read',amounts:'none'},lp:{},delete_records:false}});
  await f.req('/auth/accept-invite',{token:staff.invite_path.split('invite=')[1],password:'synthetic-warehouse-password'});
  const login=await f.req('/auth/login',{username:'warehouse',password:'synthetic-warehouse-password'});
  const response=await f.req('/ec?from=2026-09-01&to=2026-09-30',undefined,login.cookie);assert.equal(response.status,200);r=response.data.stock[0];
  assert.deepEqual([r.on_hand_milli,r.reserved_milli,r.available_milli,r.in_transit_milli],[16000,2000,14000,3000]);
  for(const [key,value] of Object.entries(r))if(key.endsWith('_cents'))assert.equal(value,null,key+' must be hidden');
  assert.equal(response.data.sales.length,0);
 }finally{f.close();}
});

test('negative stock remains negative without subtracting transit again; duplicate read rows count a sale once; null is never zero',()=>{
 const component={package_id:'p',component_id:'c',product_id:'A',sale_product_id:'A',sale_id:'s',sold_milli:3000,component_milli:3000,returned_milli:0,stock_unit:'adet',current_stock_unit:'adet'};
 const rows=physicalStock([{id:'A',quantity_milli:-2000,reserved_milli:1000},{id:'B',quantity_milli:null,reserved_milli:0}], [component,component]);
 assert.deepEqual([rows[0].on_hand_milli,rows[0].available_milli,rows[0].in_transit_milli],[-2000,-3000,3000]);
 assert.equal(rows[1].on_hand_milli,null);assert.equal(rows[1].available_milli,null);
 const missing=physicalStock([{id:'A',quantity_milli:7000,reserved_milli:0}],[{...component,sale_id:null}])[0];
 assert.equal(missing.in_transit_milli,null);assert.equal(missing.in_transit_known_milli,0);assert.equal(missing.available_milli,7000);
 const lp=physicalStock([{id:'LP',quantity_milli:5000,reserved_milli:0}],[],'lp')[0];assert.equal(lp.in_transit_milli,null);assert.equal(lp.in_transit_status,'not_supported');
 assert.throws(()=>pendingPackageScopeSql('p;DELETE'),/alias/);assert.match(stockTransitQuery,/status='shipped'/);
});

test('legacy shipped component without a linked sale is unknown only for its product; no virtual shipment is deducted',async()=>{
 const f=appFixture();try{await f.setup();products(f,['A','B'],20);parcel(f,'unlinked',{status:'reserved'});
  f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id='unlinked'").run(date);
  const rows=new Map((await stock(f)).map(r=>[r.id,r]));
  assert.equal(rows.get('A').in_transit_milli,null);assert.equal(rows.get('A').in_transit_status,'incomplete');assert.equal(rows.get('A').in_transit_known_milli,0);
  assert.match(rows.get('A').in_transit_notes.join(' '),/bağlantısı eksik/);
  assert.equal(rows.get('B').in_transit_milli,0);assert.equal(rows.get('B').in_transit_status,'complete');
  assert.equal(rows.get('A').on_hand_milli,20000);assert.equal(rows.get('A').available_milli,20000);
 }finally{f.close();}
});
