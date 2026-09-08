import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {catalogApi,resolveMapping,resolvePurchaseMappings} from '../src/catalog-api.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<='0011_catalog.sql').sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let queries=0;const scoped=ns=>({prepare(query){for(const table of ['catalog_mappings','catalog_mapping_components','catalog_mapping_audit','suppliers','stock_balances'])query=query.replace(new RegExp('\\b'+table+'\\b','g'),ns+'_'+table);if(ns==='ec')query=query.replace(/\bproducts\b/g,'ec_products');return {values:[],bind(...v){this.values=v;return this;},first(){queries++;return sql.prepare(query).get(...this.values)||null;},all(){queries++;return {results:sql.prepare(query).all(...this.values)};},run(){queries++;return sql.prepare(query).run(...this.values);}};},async batch(items){sql.exec('BEGIN');try{const results=items.map(i=>i.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}});
 sql.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('torf','Torf','TORF','kg'),('bag','Çuval','BAG','adet'); INSERT INTO products(id,name,sku) VALUES('lp','Lunapot','LP'); INSERT INTO ec_suppliers(id,name) VALUES('supplier','Tedarikçi'); INSERT INTO lp_suppliers(id,name) VALUES('lp-supplier','Lunapot Tedarikçisi');");
 const call=(ns,path='',body)=>catalogApi(new Request('https://test.local/api/catalog'+path,{method:body===undefined?'GET':'POST'}),{DB:scoped(ns),WORKSPACE:ns},'/api/catalog'+path,async()=>body);
 return {sql,scoped,call,count:()=>queries,reset:()=>{queries=0;},close:()=>sql.close()};
}
const set={source:'trendyol',external_code:'SET-TORF',external_name:'Torf + çuval seti',source_unit:'',components:[{product_id:'torf',quantity_milli:20000,revenue_share_bps:9500},{product_id:'bag',quantity_milli:1000,revenue_share_bps:500}]};
test('Marketplace aliases resolve exact keys into one master-stock component set; no guessed names',async()=>{
 const f=fixture();try{
  const mapping=await f.call('ec','/mappings',set);assert.equal(mapping.version,1);
  const resolved=await resolveMapping(f.scoped('ec'),{source:'trendyol',external_code:'SET-TORF'});assert.equal(resolved.mapping.id,mapping.id);assert.equal(resolved.components.length,2);assert.equal(resolved.components.reduce((sum,c)=>sum+c.revenue_share_bps,0),10000);assert.equal(resolved.components.find(c=>c.product_id==='torf').stock_unit,'kg');
  assert.equal(await resolveMapping(f.scoped('ec'),{source:'trendyol',external_code:'set-torf'}),null);assert.equal(await resolveMapping(f.scoped('ec'),{source:'hepsiburada',external_code:'SET-TORF'}),null);assert.equal(await resolveMapping(f.scoped('lp'),{source:'trendyol',external_code:'SET-TORF'}),null);
  await assert.rejects(()=>f.call('lp','/mappings',set),/bu çalışma alanında/);
  await assert.rejects(()=>f.call('ec','/mappings',{...set,external_code:'BAD',components:[{product_id:'bag',quantity_milli:500,revenue_share_bps:10000}]}),/kesirli/);
  await assert.rejects(()=>f.call('ec','/mappings',{...set,external_code:'BAD',components:[{product_id:'torf',quantity_milli:1000,revenue_share_bps:9900}]}),/%100/);
  assert.equal((await f.call('ec')).products.length,2);assert.equal((await f.call('lp')).products.length,1);
 }finally{f.close();}
});
test('Mapping edits create immutable revisions and archives retain historical components',async()=>{
 const f=fixture();try{
  const first=await f.call('ec','/mappings',set);
  await assert.rejects(()=>f.call('ec','/mappings',set),/zaten var/);
  const second=await f.call('ec','/mappings',{...set,replaces_id:first.id,components:[{product_id:'torf',quantity_milli:25000,revenue_share_bps:10000}]});assert.equal(second.version,2);
  assert.equal((await resolveMapping(f.scoped('ec'),{source:'trendyol',external_code:'SET-TORF'})).mapping.id,second.id);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_catalog_mapping_components WHERE mapping_id=?').get(first.id).n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ec_catalog_mapping_audit').get().n,2);
  assert.throws(()=>f.sql.exec('UPDATE ec_catalog_mapping_components SET quantity_milli=1'),/CATALOG_IMMUTABLE/);
  assert.throws(()=>f.sql.prepare('UPDATE ec_catalog_mappings SET active=1 WHERE id=?').run(first.id),/CATALOG_/);
  await assert.rejects(()=>f.call('ec','/mappings',{...set,replaces_id:second.id,external_code:'OTHER'}),/kaynak\/kod\/birim/);
  await f.call('ec','/mappings/'+second.id+'/archive',{});assert.equal(await resolveMapping(f.scoped('ec'),{source:'trendyol',external_code:'SET-TORF'}),null);
 }finally{f.close();}
});
test('Purchase mapping uses supplier+unit+exact code or explicitly confirmed full name, in one query',async()=>{
 const f=fixture();try{
  await f.call('ec','/mappings',{source:'purchase',supplier_id:'supplier',external_code:'PALLET',source_unit:'PAL',components:[{product_id:'torf',quantity_milli:500000,revenue_share_bps:10000}]});
  await f.call('ec','/mappings',{source:'purchase',supplier_id:'supplier',match_by:'name',external_name:'20 L Torf Karışımı',external_code:'',source_unit:'C62',components:[{product_id:'torf',quantity_milli:12000,revenue_share_bps:10000}]});
  f.reset();const matched=await resolvePurchaseMappings(f.scoped('ec'),'supplier',[{external_code:'PALLET',invoice_unit:'PAL'},{external_code:'',description:'20 L Torf Karışımı',invoice_unit:'C62'},{external_code:'WRONG',description:'20 L Torf Karışımı',invoice_unit:'C62'},{external_code:'',description:'20 l torf karışımı',invoice_unit:'C62'},{external_code:'PALLET',invoice_unit:'KG'}]);
  assert.equal(f.count(),1);assert.equal(matched[0].components[0].quantity_milli,500000);assert.equal(matched[1].mapping.match_by,'name');assert.deepEqual(matched.slice(2),[null,null,null]);
  assert.equal((await resolvePurchaseMappings(f.scoped('lp'),'lp-supplier',[{external_code:'PALLET',invoice_unit:'PAL'}]))[0],null);
  await assert.rejects(()=>f.call('ec','/mappings',{...set,source:'purchase',supplier_id:'supplier',source_unit:'C62'}),/tek stok kartına/);
  await assert.rejects(()=>f.call('ec','/mappings',{...set,match_by:'name'}),/yalnızca/);
 }finally{f.close();}
});
