import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import worker from '../src/worker.js';
import {planRecovery,applyRecovery,validateTimestamp} from '../scripts/recovery.mjs';
const date='2026-09-09',origin='https://lunapot.test';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()){
  const sql=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');if(file>='0020')for(const q of unstable_splitSqlQuery(sql))sqlite.exec(q);else sqlite.exec(sql);
 }
 let count=0;
 const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},first(){count++;return sqlite.prepare(sql).get(...this.args)||null;},all(){count++;return {results:sqlite.prepare(sql).all(...this.args)};},run(){count++;return sqlite.prepare(sql).run(...this.args);}};},async batch(statements){sqlite.exec('BEGIN');try{const rows=statements.map(s=>s.all());sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'test-bootstrap-only'};let cookie='';
 async function req(path,body,auth=cookie){const r=await worker.fetch(new Request(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:auth},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 async function setup(){const r=await req('/auth/setup',{token:env.SETUP_TOKEN,password:'test-owner-password-123'});assert.equal(r.status,200);cookie=r.cookie;}
 async function ok(path,body){const r=await req(path,body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
 async function invoice({net=100,tax=20,quantity=10,type='product',treatment='general',category='rent'}={}){const s=(await ok('/ec/suppliers',{name:'Test Tedarikçi',tax_id:'1234567890'})).id;const p=type==='product'?(await ok('/ec/products',{name:'Torf',sku:crypto.randomUUID(),stock_unit:'adet',min_stock:0})).id:null;const i=(await ok('/ec/invoices',{supplier_id:s,invoice_no:crypto.randomUUID(),invoice_date:date,currency:'TRY',lines:[{description:type==='product'?'Torf':'Hizmet',invoice_quantity:quantity,invoice_unit:'adet',product_id:p,stock_quantity:quantity,net,tax,line_type:type,expense_treatment:treatment,expense_category:category}]})).id;await ok('/ec/invoices/'+i+'/post',{});const l=(await ok('/ec/invoices/'+i)).lines[0].id;return {s,p,i,l};}
 const receive=(i,l,quantity,reference=crypto.randomUUID())=>ok('/ec/invoices/'+i+'/receive',{occurred_on:date,reference,lines:[{id:l,quantity}]});
 const adjust=(i,l,kind,values={})=>req('/ec/invoices/'+i+'/adjustments',{line_id:l,kind,net:0,tax:0,stock_net:0,occurred_on:date,reference:crypto.randomUUID(),reason:'Test belgesine dayalı düzeltme',...values});
 const balance=p=>({...sqlite.prepare('SELECT quantity_milli,value_cents FROM ec_stock_balances WHERE product_id=?').get(p)});
 const party=s=>sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM ec_party_entries WHERE party_id=?').get(s).n;
 return {sqlite,req,ok,setup,invoice,receive,adjust,balance,party,cookie:()=>cookie,queries:()=>count,reset:()=>{count=0;},close:()=>sqlite.close()};
}
test('Çalışan daveti tek kullanımlık; modül ve yazma yetkisi sunucuda uygulanır, kapatma oturumları keser',async()=>{
 const f=fixture();try{await f.setup();const created=await f.ok('/admin/users',{username:'test.staff',name:'Test Çalışan',ec_access:'read',lp_access:'none'});const token=created.invite_path.split('=')[1];
  assert.equal((await f.req('/auth/accept-invite',{token,password:'test-staff-password-123'},'')).status,200);assert.equal((await f.req('/auth/accept-invite',{token,password:'test-staff-password-456'},'')).status,400);
  let login=await f.req('/auth/login',{username:'test.staff',password:'test-staff-password-123'},'');assert.equal(login.status,200);let cookie=login.cookie;
  assert.equal((await f.req('/ec',undefined,cookie)).status,200);assert.equal((await f.req('/lp',undefined,cookie)).status,403);assert.equal((await f.req('/data',undefined,cookie)).status,403);
  for(const path of ['/ec/products','/admin/users','/ec/connections/trendyol','/ec/settings'])assert.equal((await f.req(path,{},cookie)).status,403,path);
  assert.equal((await f.req('/ec/settings/backup',undefined,cookie)).status,403);assert.equal((await f.req('/admin/users',undefined,cookie)).status,403);
  await f.ok('/admin/users/'+created.id,{name:'Test Çalışan',ec_access:'write',lp_access:'none',active:true});assert.equal((await f.req('/ec',undefined,cookie)).status,401);
  cookie=(await f.req('/auth/login',{username:'test.staff',password:'test-staff-password-123'},'')).cookie;
  assert.equal((await f.req('/ec/products',{name:'Yetkili ürün',sku:'AUTH',stock_unit:'adet',min_stock:0},cookie)).status,200);assert.equal((await f.req('/ec/settings',{legal_name:'X',tax_id:'1234567890'},cookie)).status,403);
  await f.ok('/admin/users/'+created.id,{name:'Test Çalışan',ec_access:'write',lp_access:'none',active:false});assert.equal((await f.req('/ec',undefined,cookie)).status,401);assert.equal((await f.req('/auth/login',{username:'test.staff',password:'test-staff-password-123'},'')).status,401);
  const list=await f.ok('/admin/users');assert.ok(!JSON.stringify(list).includes('password_hash'));assert.ok(!JSON.stringify(list).includes(token));assert.ok(list.audit.length>=3);
 }finally{f.close();}
});
test('Yenilenen ve süresi dolan davet kullanılamaz; üretim personeli yalnızca üretimi görür',async()=>{
 const f=fixture();try{await f.setup();const a=await f.ok('/admin/users',{username:'production.staff',name:'Üretim',ec_access:'none',lp_access:'write'});const old=a.invite_path.split('=')[1];const b=await f.ok('/admin/users/'+a.id+'/invite',{});assert.equal((await f.req('/auth/accept-invite',{token:old,password:'test-strong-password-123'},'')).status,400);
  f.sqlite.prepare('UPDATE staff_users SET invite_expires_at=0 WHERE id=?').run(a.id);assert.equal((await f.req('/auth/accept-invite',{token:b.invite_path.split('=')[1],password:'test-strong-password-123'},'')).status,400);
  const c=await f.ok('/admin/users/'+a.id+'/invite',{});await f.ok('/auth/accept-invite',{token:c.invite_path.split('=')[1],password:'test-strong-password-123'});const cookie=(await f.req('/auth/login',{username:'production.staff',password:'test-strong-password-123'},'')).cookie;
  assert.equal((await f.req('/data',undefined,cookie)).status,200);assert.equal((await f.req('/ec',undefined,cookie)).status,403);assert.equal((await f.req('/materials',{name:'Yetkili malzeme',unit:'kg',price:10},cookie)).status,201);
 }finally{f.close();}
});
test('Fiyat indirimi stok ve dönem payını ayırır; tam iade düzeltilmiş borcu ve maliyeti kapatır',async()=>{
 const f=fixture();try{await f.setup();const {s,p,i,l}=await f.invoice();await f.receive(i,l,10);
  const r=await f.adjust(i,l,'price',{net:20,tax:4,stock_net:20});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(f.balance(p),{quantity_milli:10000,value_cents:8000});assert.equal(f.party(s),-9600);
  await f.ok('/ec/invoices/'+i+'/returns',{occurred_on:date,reference:'RETURN-DISCOUNT',reason:'İndirimli ürün iadesi',lines:[{id:l,quantity:10}]});assert.equal(f.party(s),0);assert.deepEqual(f.balance(p),{quantity_milli:0,value_cents:0});
  const blocked=await f.req('/ec/invoices/'+i+'/adjustments/'+r.data.adjustment_id+'/reverse',{occurred_on:date,reference:'BAD',reason:'Önce iade geri alınmalı'});assert.equal(blocked.status,409);
  const f2=await f.invoice();await f.receive(f2.i,f2.l,10);await f.adjust(f2.i,f2.l,'price',{net:-10,tax:-2,stock_net:-4});assert.equal(f.balance(f2.p).value_cents,10400);const ac=await f.ok('/ec?from='+date+'&to='+date);assert.equal(ac.expenses.filter(e=>e.category==='purchase_correction').reduce((s,e)=>s+e.amount_cents,0),600);
 }finally{f.close();}
});
test('Gelmeyen ürün iptalinde yalnızca kalan miktar kapanır; tam teslim ve borç kuruşları korunur',async()=>{
 const f=fixture();try{await f.setup();const {s,p,i,l}=await f.invoice({net:1,tax:.2,quantity:3});await f.receive(i,l,1);
  const cancel=await f.adjust(i,l,'cancel',{quantity:2});assert.equal(cancel.status,200,JSON.stringify(cancel.data));assert.equal((await f.ok('/ec/invoices/'+i)).lines[0].cancelled_milli,2000);assert.equal((await f.ok('/ec/purchases?status=awaiting')).total,0);assert.equal((await f.ok('/ec/attention')).invoices.awaiting_receipt,0);assert.equal(f.party(s),-40);
  assert.equal((await f.req('/ec/invoices/'+i+'/receive',{occurred_on:date,reference:'OVER',lines:[{id:l,quantity:1}]})).status,409);
  assert.equal((await f.adjust(i,l,'cancel',{quantity:1})).status,409);
  await f.ok('/ec/invoices/'+i+'/returns',{occurred_on:date,reference:'LAST-RETURN',reason:'Teslim alınan da iade',lines:[{id:l,quantity:1}]});assert.equal(f.party(s),0);assert.equal(f.balance(p).quantity_milli,0);
 }finally{f.close();}
});
test('Hizmet indirimi genel gideri düzeltir; ters kaydı cari ve gideri eski haline getirir',async()=>{
 const f=fixture();try{await f.setup();const {s,i,l}=await f.invoice({type:'expense'});const r=await f.adjust(i,l,'service',{net:30,tax:6});assert.equal(r.status,200);assert.equal(f.party(s),-8400);let ac=await f.ok('/ec?from='+date+'&to='+date);assert.equal(ac.expenses.reduce((n,e)=>n+e.amount_cents,0),7000);
  await f.ok('/ec/invoices/'+i+'/adjustments/'+r.data.adjustment_id+'/reverse',{occurred_on:date,reference:'REV',reason:'Yanlış tutar'});assert.equal(f.party(s),-12000);ac=await f.ok('/ec?from='+date+'&to='+date);assert.equal(ac.expenses.reduce((n,e)=>n+e.amount_cents,0),10000);
  assert.equal((await f.adjust(i,l,'service',{net:101,tax:20})).status,409);assert.equal((await f.req('/lp/invoices/'+i+'/adjustments',{})).status,403);
 }finally{f.close();}
});
test('Kesinti düzeltmesi tüm mutabakat ve kâr uyarılarında aynı kalan bedeli gösterir',async()=>{
 const f=fixture();try{await f.setup();const {i,l}=await f.invoice({type:'expense',category:'shipping',treatment:'sales_fee'});await f.adjust(i,l,'service',{net:20,tax:4});assert.equal((await f.ok('/ec')).pending_fee_cents,8000);assert.equal((await f.ok('/ec/performance')).unallocated_fee_cents,8000);assert.equal((await f.ok('/ec/reconciliation')).fee_lines[0].remaining_cents,8000);
  const p=(await f.ok('/ec/products',{name:'Satış ürünü',sku:'SALE',stock_unit:'adet',min_stock:0})).id;await f.ok('/ec/stock',{product_id:p,kind:'opening',quantity:1,unit_cost:1,reference:'O',notes:'Test',occurred_on:date});const sale=(await f.ok('/ec/sales',{product_id:p,channel:'other',external_id:'S',quantity:1,revenue:200,occurred_on:date})).id;
  await f.ok('/ec/reconciliation/allocate',{invoice_line_id:l,reference:'FEE',lines:[{sale_id:sale,amount:80}]});assert.equal((await f.adjust(i,l,'service',{net:1,tax:.2})).status,409);assert.equal((await f.ok('/ec')).pending_fee_cents,0);
 }finally{f.close();}
});
test('Kurtarma planı salt okunur; eski, değişmiş veya farklı veritabanı planı uygulanamaz',async()=>{
 const now=Date.parse('2026-09-09T12:00:00Z'),a='00000011-00000002-000050e1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',b='00000010-00000002-000050e1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',calls=[];
 const run=async args=>{calls.push(args);return {bookmark:args.includes('--timestamp')?b:a};};
 const plan=await planRecovery(run,'2026-09-09T14:00:00+03:00',now);assert.equal(plan.target_time,'2026-09-09T11:00:00.000Z');assert.equal(calls.length,2);assert.ok(calls.every(x=>x.includes('info')));
 await assert.rejects(()=>applyRecovery(run,plan,'wrong',now));await assert.rejects(()=>applyRecovery(run,{...plan,database_id:'other'},b,now));await assert.rejects(()=>applyRecovery(run,plan,b,now+16*60000));await assert.rejects(()=>applyRecovery(async()=>({bookmark:b}),plan,b,now));assert.throws(()=>validateTimestamp('2026-09-01T00:00:00Z',now));assert.throws(()=>validateTimestamp('2026-09-09T12:00:00',now));
 const result=await applyRecovery(run,plan,b,now);assert.equal(result.undo_bookmark,a);assert.equal(calls.at(-1)[2],'restore');
});
