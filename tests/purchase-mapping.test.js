import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {accountingApi} from '../src/accounting.js';
import {catalogApi} from '../src/catalog-api.js';
import {scopedDB} from '../src/scoped-db.js';
import {purchaseQuantity} from '../src/purchase-mapping.js';

function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let count=0;
 const raw={prepare(query){return {args:[],bind(...args){this.args=args;return this;},first(){count++;return sql.prepare(query).get(...this.args)||null;},all(){count++;return {results:sql.prepare(query).all(...this.args)};},run(){count++;return sql.prepare(query).run(...this.args);}};},async batch(items){sql.exec('BEGIN');try{const out=items.map(x=>x.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const call=(handler,ns,path,data)=>handler(new Request('https://test.local'+path,{method:data===undefined?'GET':'POST'}),{DB:scopedDB(raw,ns),ROOT_DB:raw,WORKSPACE:ns},path,async()=>data);
 const ac=(path,data,ns='ec')=>call(accountingApi,ns,'/api/accounting'+path,data),catalog=(path,data,ns='ec')=>call(catalogApi,ns,'/api/catalog'+path,data);
 return {sql,ac,catalog,reset(){count=0;},count:()=>count,close:()=>sql.close()};
}
const date='2026-09-09';
const product=sku=>({name:'Stok '+sku,sku,stock_unit:'adet',min_stock:0});
const sourceLine={description:'Üretici torf toprak 20 lt özel seri',external_code:'SUP-TORF',invoice_quantity:2,invoice_unit:'KOLI',net:120,tax:24};
const invoice=(supplier,number,lines=[sourceLine])=>({supplier_id:supplier,invoice_no:number,invoice_date:date,currency:'TRY',lines});

test('Supplier alias converts invoice cartons to one master stock card without changing money',async()=>{
 const f=fixture();try{
  const p=(await f.ac('/products',product('TORF20'))).id,s=(await f.ac('/suppliers',{name:'Üretici A',tax_id:'1234567890'})).id;
  const link=await f.catalog('/mappings',{source:'purchase',supplier_id:s,external_code:'SUP-TORF',external_name:'Başka alış adı',source_unit:'KOLI',components:[{product_id:p,quantity_milli:12000,revenue_share_bps:10000}]});
  const inv=await f.ac('/invoices',invoice(s,'ALIŞ-1')),detail=await f.ac('/invoices/'+inv.id),line=detail.lines[0];
  assert.equal(line.product_id,p);assert.equal(line.quantity_milli,24000);assert.equal(line.catalog_mapping_id,link.id);assert.equal(line.net_cents,12000);
  await f.ac('/invoices/'+inv.id+'/post',{});assert.equal(f.sql.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(p).quantity_milli,0);
  await f.ac('/invoices/'+inv.id+'/receive',{reference:'TESLIM-1',occurred_on:date,lines:[{id:line.id,quantity:24}]});
  const stock=f.sql.prepare('SELECT * FROM ec_stock_balances WHERE product_id=?').get(p);assert.equal(stock.quantity_milli,24000);assert.equal(stock.value_cents,12000);
  const other=(await f.ac('/suppliers',{name:'Üretici B',tax_id:'0987654321'})).id;
  const unmapped=await f.ac('/invoices',invoice(other,'OTHER'));assert.equal((await f.ac('/invoices/'+unmapped.id)).lines[0].product_id,null);
  const unit=await f.ac('/invoices',invoice(s,'UNIT',[{...sourceLine,invoice_unit:'ADET'}]));assert.equal((await f.ac('/invoices/'+unit.id)).lines[0].product_id,null);
 }finally{f.close();}
});

test('Purchase name alias is exact and scoped; changing catalog leaves historical invoice conversion intact',async()=>{
 const f=fixture();try{
  const p=(await f.ac('/products',product('A'))).id,b=(await f.ac('/products',product('B'))).id,s=(await f.ac('/suppliers',{name:'Üretici'})).id;
  const mapping={source:'purchase',supplier_id:s,match_by:'name',external_code:'',external_name:'Özel Üretim A',source_unit:'C62',components:[{product_id:p,quantity_milli:2000,revenue_share_bps:10000}]};
  const first=await f.catalog('/mappings',mapping),line={...sourceLine,external_code:'',description:'Özel Üretim A',invoice_unit:'C62'};
  const inv=await f.ac('/invoices',invoice(s,'OLD',[line])),old=(await f.ac('/invoices/'+inv.id)).lines[0];assert.equal(old.quantity_milli,4000);
  await f.catalog('/mappings',{...mapping,replaces_id:first.id,components:[{product_id:b,quantity_milli:3000,revenue_share_bps:10000}]});
  await f.ac('/invoices/'+inv.id,{lines:[{id:old.id,product_id:p,stock_quantity:4,catalog_mapping_id:first.id,line_type:'product'}]});
  assert.equal((await f.ac('/invoices/'+inv.id)).lines[0].product_id,p);
  const next=await f.ac('/invoices',invoice(s,'NEW',[line]));assert.equal((await f.ac('/invoices/'+next.id)).lines[0].product_id,b);
  const similar=await f.ac('/invoices',invoice(s,'SIMILAR',[{...line,description:'Özel Üretim AA'}]));assert.equal((await f.ac('/invoices/'+similar.id)).lines[0].product_id,null);
  await assert.rejects(()=>f.ac('/products/'+p,{...product('A'),stock_unit:'kg'}),e=>e.status===409);
 }finally{f.close();}
});

test('40-line invoice and receipt leave headroom for authentication under 50 D1 queries',async()=>{
 const f=fixture();try{
  const p=(await f.ac('/products',product('MANY'))).id,s=(await f.ac('/suppliers',{name:'Çok satır',tax_id:'1234567890'})).id;
  const lines=Array.from({length:40},(_,i)=>({...sourceLine,description:'Satır '+i,product_id:p,stock_quantity:2}));
  f.reset();const inv=await f.ac('/invoices',{...invoice(s,'MAX-40',lines),uuid:'42f3ddad-e981-4342-98ed-71eae73018db'});assert.ok(f.count()<50,'create count='+f.count());
  await f.ac('/invoices/'+inv.id+'/post',{});const detail=await f.ac('/invoices/'+inv.id);
  f.reset();await f.ac('/invoices/'+inv.id+'/receive',{reference:'FORTY',occurred_on:date,lines:detail.lines.map(l=>({id:l.id,quantity:2}))});assert.ok(f.count()<50,'receipt count='+f.count());
  assert.equal(f.sql.prepare('SELECT quantity_milli FROM ec_stock_balances WHERE product_id=?').get(p).quantity_milli,80000);
 }finally{f.close();}
});

test('Supplier conversion rejects fractional milli-units and unsafe products',()=>{
 assert.equal(purchaseQuantity(2,12000),24000);
 assert.throws(()=>purchaseQuantity(.001,333));assert.throws(()=>purchaseQuantity(1000000,1000000000));
});

test('Database blocks stock-unit changes after a mapping even if an earlier API check saw no history',async()=>{
 const f=fixture();try{
  const p=(await f.ac('/products',product('UNIT-GUARD'))).id;
  await f.catalog('/mappings',{source:'trendyol',external_code:'GUARD',components:[{product_id:p,quantity_milli:2000,revenue_share_bps:10000}]});
  assert.throws(()=>f.sql.prepare("UPDATE ec_products SET stock_unit='kg' WHERE id=?").run(p),/PRODUCT_UNIT_LOCKED/);
  f.sql.exec("INSERT INTO products(id,name,sku) VALUES('LP-GUARD','Lunapot stok','LP-GUARD')");
  await f.catalog('/mappings',{source:'other',external_code:'LP-ALIAS',components:[{product_id:'LP-GUARD',quantity_milli:1000,revenue_share_bps:10000}]},'lp');
  assert.throws(()=>f.sql.prepare("UPDATE products SET stock_unit='L' WHERE id='LP-GUARD'").run(),/PRODUCT_UNIT_LOCKED/);
 }finally{f.close();}
});
