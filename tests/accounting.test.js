import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {summary,contribution,milli} from '../public/accounting-math.js';
import {previewIntegration} from '../src/integrations.js';

async function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {values:[],bind(...args){this.values=args;return this;},first(){return sqlite.prepare(sql).get(...this.values)||null;},all(){return {results:sqlite.prepare(sql).all(...this.values)};},run(){return sqlite.prepare(sql).run(...this.values);}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(i=>i.all());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SETUP_TOKEN:'unit-test-token'};let cookie='';
 async function request(path,method='GET',body){const response=await worker.fetch(new Request('https://test.local/api'+path,{method,headers:{Origin:'https://test.local','Content-Type':'application/json',Cookie:cookie},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);return {response,status:response.status,data:await response.json()};}
 const auth=await request('/auth/setup','POST',{token:env.SETUP_TOKEN,password:'accounting-test-password'});assert.equal(auth.status,200);cookie=auth.response.headers.get('set-cookie').split(';')[0];
 const post=async(path,data,status=200)=>{const result=await request(path,'POST',data);assert.equal(result.status,status,JSON.stringify(result.data));return result.data;};
 const get=async workspace=>(await request('/'+workspace+'?from=2026-01-01&to=2026-12-31')).data;
 return {DB,sqlite,request,post,get,close:()=>sqlite.close()};
}
const date='2026-09-08';
const sale=(product,external='S-1',quantity=2,revenue=100)=>({product_id:product,external_id:external,channel:'trendyol',quantity,revenue,commission:10,shipping:5,other:0,fees_status:'confirmed',occurred_on:date});

test('Çalışma alanları ayrı: ürün, stok, fatura ve raporlarda veri karışmaz',async()=>{
 const f=await fixture();try{
  const lp=(await f.request('/products','POST',{name:'Lunapot Saksı',sku:'ORTAK-KOD',sale_price:0})).data.id;
  const ec=(await f.post('/ec/products',{name:'Torf 20 L',sku:'ORTAK-KOD',stock_unit:'adet',min_stock:5})).id;
  assert.equal((await f.get('lp')).stock.length,1);assert.equal((await f.get('ec')).stock.length,1);
  assert.equal((await f.get('ec')).stock[0].name,'Torf 20 L');assert.equal((await f.get('lp')).stock[0].name,'Lunapot Saksı');
  await f.post('/ec/stock',{product_id:lp,quantity:10,unit_cost:20,kind:'opening',reference:'X',notes:'Test',occurred_on:date},404);
  await f.post('/lp/sales',sale(ec),404);
  await f.post('/ec/stock',{product_id:ec,quantity:10,unit_cost:20,kind:'opening',reference:'ACILIS',notes:'Açılış',occurred_on:date});
  assert.equal((await f.get('ec')).stock[0].quantity_milli,10000);assert.equal((await f.get('lp')).stock[0].quantity_milli,0);
  assert.equal((await f.request('/lp/integrations')).status,403);
  assert.equal((await f.request('/data')).data.products.length,1);
 }finally{f.close();}
});

test('Satış, fatura onayı, ortalama maliyet, ödeme, iade ve sayım bütünlüğü',async()=>{
 const f=await fixture();try{
  const p=(await f.post('/ec/products',{name:'Torf',sku:'T20',stock_unit:'adet',min_stock:0})).id;
  await f.post('/ec/stock',{product_id:p,quantity:10,kind:'opening',reference:'A',notes:'Açılış',occurred_on:date},400);
  await f.post('/ec/stock',{product_id:p,quantity:10,unit_cost:20,kind:'opening',reference:'A',notes:'Açılış',occurred_on:date});
  await f.post('/ec/stock',{product_id:p,quantity:10,unit_cost:20,kind:'opening',reference:'A2',notes:'Açılış',occurred_on:date},409);
  const s=(await f.post('/ec/sales',sale(p))).id;
  let state=await f.get('ec');assert.equal(state.stock[0].quantity_milli,8000);assert.equal(state.stock[0].value_cents,16000);assert.equal(state.sales[0].cost_cents,4000);assert.equal(contribution(state.sales[0]),4500);
  await f.post('/ec/sales',sale(p),409);await f.post('/ec/sales',sale(p,'TOO-MANY',99,1000),409);state=await f.get('ec');assert.equal(state.sales.length,1);assert.equal(state.stock[0].quantity_milli,8000);
  await f.post('/ec/sales/'+s+'/fees',{commission:12,shipping:5,other:0,fees_status:'confirmed'});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_fee_audit').get().n,1);
  const supplier=(await f.post('/ec/suppliers',{name:'Torf Tedarikçisi',tax_id:'1234567890'})).id;
  assert.equal((await f.post('/ec/suppliers',{name:'Aynı şirket',tax_id:'1234567890'})).id,supplier);
  const invoice={supplier_id:supplier,invoice_no:'F-001',uuid:'unique-invoice-uuid',invoice_date:date,currency:'TRY',lines:[{description:'Torf 20 L',invoice_quantity:10,invoice_unit:'C62',net:300,tax:60}]};
  const inv=(await f.post('/ec/invoices',invoice)).id;
  assert.equal((await f.get('ec')).stock[0].quantity_milli,8000);
  await f.post('/ec/invoices',invoice,409);await f.post('/ec/invoices/'+inv+'/post',{},409);
  assert.equal((await f.request('/lp/invoices/'+inv)).status,404);
  const detail=(await f.request('/ec/invoices/'+inv)).data;
  await f.post('/ec/invoices/'+inv,{lines:[{id:detail.lines[0].id,product_id:p,stock_quantity:10}]});
  await f.post('/ec/invoices/'+inv+'/post',{});await f.post('/ec/invoices/'+inv+'/post',{},409);
  assert.equal((await f.get('ec')).stock[0].quantity_milli,8000,'Fatura tek başına fiziksel stok artırmaz');
  await f.post('/ec/invoices/'+inv+'/receive',{occurred_on:date,reference:'DELIVERY-1',lines:[{id:detail.lines[0].id,quantity:4}]});
  await f.post('/ec/invoices/'+inv+'/receive',{occurred_on:date,reference:'DELIVERY-2',lines:[{id:detail.lines[0].id,quantity:6}]});
  await f.post('/ec/invoices/'+inv+'/receive',{occurred_on:date,reference:'DELIVERY-OVER',lines:[{id:detail.lines[0].id,quantity:1}]},409);
  state=await f.get('ec');assert.equal(state.stock[0].quantity_milli,18000);assert.equal(state.stock[0].value_cents,46000);assert.equal(state.suppliers[0].purchase_cents,36000);
  await f.post('/ec/payments',{supplier_id:supplier,reference:'PAY-1',amount:100,occurred_on:date});assert.equal((await f.get('ec')).suppliers[0].paid_cents,10000);
  await f.post('/ec/sales',sale(p,'S-2',3,150));state=await f.get('ec');assert.equal(state.sales.find(x=>x.id===s).cost_cents,4000);assert.equal(state.sales.find(x=>x.external_id==='S-2').cost_cents,7667);
  await f.post('/ec/sales/'+s+'/return',{external_id:'RET-1',quantity:1,revenue:50,commission:-6,shipping:0,other:0,fees_status:'confirmed',restock:true,occurred_on:date});
  state=await f.get('ec');assert.equal(state.stock[0].quantity_milli,16000);assert.equal(state.stock[0].value_cents,40333);assert.equal(state.sales.find(x=>x.external_id==='RET-1').cost_cents,-2000);
  await f.post('/ec/sales/'+s+'/return',{external_id:'RET-OVER',quantity:2,revenue:50,restock:true,occurred_on:date},409);
  await f.post('/ec/sales/'+s+'/return',{external_id:'REFUND-OVER',quantity:1,revenue:60,restock:true,occurred_on:date},409);
  await f.post('/ec/sales/'+s+'/return',{external_id:'RET-2',quantity:1,revenue:50,commission:0,shipping:0,other:0,fees_status:'confirmed',restock:false,occurred_on:date});
  assert.equal((await f.get('ec')).stock[0].quantity_milli,16000);
  await f.post('/ec/stock',{product_id:p,quantity:15,kind:'count',reference:'COUNT-1',notes:'Sayımda 1 torba eksik',occurred_on:date});
  state=await f.get('ec');assert.equal(state.stock[0].quantity_milli,15000);assert.equal(state.expenses[0].category,'loss');assert.equal(state.expenses[0].amount_cents,2521);
  await f.post('/ec/products/'+p,{name:'Yeni ad',sku:'T20',stock_unit:'kg',min_stock:0},409);
  assert.throws(()=>f.sqlite.exec('DELETE FROM ec_stock_movements'),/IMMUTABLE_LEDGER/);
 }finally{f.close();}
});

test('Eksik giderler kârı kesinleştirmez; sıfır değer bilinen giderdir',()=>{
 const e={revenue_cents:10000,cost_cents:2000,commission_cents:null,shipping_cents:0,other_cents:0,fees_status:'confirmed'};
 assert.equal(contribution(e),null);assert.equal(summary([e],[]).profit,null);
 e.commission_cents=0;assert.equal(summary([e],[]).profit,8000);
 e.fees_status='pending';assert.equal(summary([e],[]).profit,null);assert.equal(summary([e],[]).estimatedProfit,8000);
 assert.throws(()=>milli(.0001));assert.throws(()=>milli(-1));
});

test('Kısmi iadelerde kuruş yuvarlaması asıl maliyeti aşmaz',async()=>{
 const f=await fixture();try{
  const p=(await f.post('/ec/products',{name:'Örnek',sku:'ROUND',stock_unit:'adet',min_stock:0})).id;
  await f.post('/ec/stock',{product_id:p,quantity:3,unit_cost:.3333,kind:'opening',reference:'R-OPEN',notes:'Test',occurred_on:date});
  const s=(await f.post('/ec/sales',sale(p,'R-SALE',3,3))).id;
  for(let i=0;i<3;i++)await f.post('/ec/sales/'+s+'/return',{external_id:'R-RET-'+i,quantity:1,revenue:1,commission:0,shipping:0,other:0,fees_status:'confirmed',restock:true,occurred_on:date});
  const state=await f.get('ec');assert.equal(state.sales.reduce((sum,x)=>sum+x.cost_cents,0),0);assert.equal(state.stock[0].value_cents,99);
 }finally{f.close();}
});

test('Trendyol önizlemesi sabit resmî adrese salt okunur istek yapar; kimlik bilgisi ve müşteri verisi dönmez',async()=>{
 const f=await fixture();try{
  const env={DB:{prepare:()=>({bind(){return this;},run:async()=>{}})},WORKSPACE:'ec',TRENDYOL_SELLER_ID:'123',TRENDYOL_API_KEY:'test-key',TRENDYOL_API_SECRET:'test-secret'};
  let count=0;
  const response=await previewIntegration(env,'trendyol',{from:'2026-09-01',to:'2026-09-08',kind:'sale',page:0},async(url,options)=>{count++;assert.equal(url.origin,'https://apigw.trendyol.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers['User-Agent'],'123 - SelfIntegration');return Response.json({totalPages:2,content:[{id:'1',orderNumber:'O-1',credit:100,commissionAmount:12,customerName:'Private customer',address:'Private address'}]});});
  assert.equal(count,1);assert.equal(response.hasMore,true);assert.equal(response.records.length,1);assert.ok(!JSON.stringify(response).includes('Private'));assert.ok(!JSON.stringify(response).includes('test-secret'));
  await assert.rejects(()=>previewIntegration({...env,WORKSPACE:'lp'},'trendyol',{},async()=>{throw new Error('Should not request');}),/yalnızca/);
  await assert.rejects(()=>previewIntegration(env,'trendyol',{from:'2026-08-01',to:'2026-09-08',kind:'sale'},async()=>{throw new Error('Should not request');}),/15 gün/);
 }finally{f.close();}
});
