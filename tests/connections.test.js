import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {connectionsApi,syncProvider,encryptCredentials,decryptCredentials} from '../src/connections-api.js';
const key='ab'.repeat(32),credentials={seller_id:'1234',key:'sample-api-key',secret:'sample-api-password',user_agent:'1234 - SelfIntegration'};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let queryCount=0;
 const DB={prepare(sql){for(const table of ['catalog_mappings','catalog_mapping_components','order_line_components','provider_connections','provider_records','provider_cursors','integration_runs','order_packages','order_lines','products'])sql=sql.replace(new RegExp('\\b'+table+'\\b','g'),'ec_'+table);return {values:[],bind(...v){this.values=v;return this;},first(){queryCount++;return sqlite.prepare(sql).get(...this.values)||null;},all(){queryCount++;return {results:sqlite.prepare(sql).all(...this.values)};},run(){queryCount++;return sqlite.prepare(sql).run(...this.values);}};},async batch(items){sqlite.exec('BEGIN');try{const result=items.map(i=>i.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,WORKSPACE:'ec',CREDENTIAL_KEY:key};
 const call=(path='',body)=>connectionsApi(new Request('https://test.local/api/connections'+path,{method:body===undefined?'GET':'POST'}),env,'/api/connections'+path.split('?')[0],async()=>body);
 return {sqlite,env,call,queryCount:()=>queryCount,resetQueries:()=>{queryCount=0;}};
}
const query={kind:'orders',from:'2026-09-01',to:'2026-09-09',page:0};
const order=(overrides={})=>({shipmentPackageId:11,orderNumber:'ORD-1',orderDate:1788901200000,lastModifiedDate:1788901200000,currencyCode:'TRY',customerEmail:'private@example.test',shipmentAddress:{fullAddress:'PRIVATE ADDRESS'},status:'Created',lines:[{lineId:22,quantity:2,lineUnitPrice:100,vatRate:20,lineTyDiscount:0,stockCode:'T20',productName:'Torf',currencyCode:'TRY',commission:10}],...overrides});

test('AES-GCM random IV, provider/account binding, missing key failure and redacted status',async()=>{
 const f=fixture();try{
  const a=await encryptCredentials(f.env,'trendyol','1234',credentials),b=await encryptCredentials(f.env,'trendyol','1234',credentials);assert.notEqual(a,b);assert.deepEqual(await decryptCredentials(f.env,'trendyol','1234',a),credentials);
  await assert.rejects(()=>decryptCredentials(f.env,'hepsiburada','1234',a),/açılamadı/);
  await assert.rejects(()=>decryptCredentials({...f.env,CREDENTIAL_KEY:'cd'.repeat(32)},'trendyol','1234',a),/açılamadı/);
  f.env.CREDENTIAL_KEY='';assert.equal((await f.call()).encryption_ready,false);await assert.rejects(()=>f.call('/trendyol/configure',credentials),/kasası/);
  f.env.CREDENTIAL_KEY=key;const saved=await f.call('/trendyol/configure',credentials);assert.equal(saved.configured,true);
  const state=JSON.stringify(await f.call());assert.ok(!state.includes(credentials.key));assert.ok(!state.includes(credentials.secret));assert.ok(!state.includes('encrypted_credentials'));assert.equal((await f.call()).providers[0].stale,true);
  const row=f.sqlite.prepare('SELECT * FROM ec_provider_connections').get();assert.ok(!JSON.stringify(row).includes(credentials.secret));
  await assert.rejects(()=>f.call('/trendyol/configure',{...credentials,seller_id:'4321'}),/farklı mağazaya/);
  await assert.rejects(()=>connectionsApi(new Request('https://test.local/api/connections'),{...f.env,WORKSPACE:'lp'},'/api/connections',async()=>({})),/yalnızca/);
  await assert.rejects(()=>f.call('/edm/configure',{username:'user',password:'pass',url:'http://localhost'}),/doğrulanmadı/);
 }finally{f.sqlite.close();}
});
test('TY V2 one-page source sync strips unrelated PII, imports drafts, stores cursor and preserves changed revisions',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);let fetchCount=0,imports=0;
  const fetcher=async(url,options)=>{fetchCount++;assert.equal(url.origin,'https://apigw.trendyol.com');assert.equal(url.pathname,'/integration/order/sellers/1234/v2/orders');assert.equal(url.searchParams.get('size'),'50');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.headers.Authorization.startsWith('Basic '));return Response.json({content:[order()],totalPages:2,totalElements:80});};
  const importer=async(env,provider,records)=>{imports++;assert.equal(provider,'trendyol');assert.equal(records[0].lines[0].gross_cents,20000);assert.equal(records[0].lines[0].vat_bps,2000);return {created:1};};
  const result=await syncProvider(f.env,'trendyol',query,fetcher,importer);assert.equal(fetchCount,1);assert.equal(imports,1);assert.equal(result.hasMore,true);assert.equal(result.next_page,1);
  await syncProvider(f.env,'trendyol',query,fetcher,importer);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n,1);assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page,1);
  const privateDump=JSON.stringify(f.sqlite.prepare('SELECT * FROM ec_provider_records').all());assert.ok(!privateDump.includes('PRIVATE'));assert.ok(!privateDump.includes('private@example'));
  const state=await f.call();assert.equal(state.providers[0].stale,false);assert.ok(state.providers[0].last_success_at);
  const changed=await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[order({status:'Shipped',lastModifiedDate:1788902200000})],totalPages:1,totalElements:1}),importer);assert.equal(changed.changed,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n,2);
  let called=false;await syncProvider(f.env,'trendyol',query,fetcher,async()=>{called=true;});assert.equal(called,false,'Old snapshot must not overwrite newer local source state');
  await syncProvider(f.env,'trendyol',{...query,page:1},async()=>Response.json({content:[],totalPages:2,totalElements:80}),importer);
  await syncProvider(f.env,'trendyol',query,fetcher,importer);assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page,2,'Repeating old page must not regress progress');
  await assert.rejects(()=>syncProvider(f.env,'trendyol',{...query,page:3},fetcher,importer),/sırayla/);
 }finally{f.sqlite.close();}
});
test('Necessary customer invoice details stay in protected source detail, never broad inbox or sync output',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);
  const input=order({customerId:'PRIVATE-ID',identityNumber:'11111111111',customerFirstName:'TEST',customerLastName:'ALICI',invoiceNumber:'TEST-INV',invoiceLink:'javascript:alert(1)',invoiceAddress:{firstName:'TEST',lastName:'ALICI',address1:'TEST PRIVATE ADDRESS',city:'İstanbul',district:'Kadıköy',countryCode:'TR',taxNumber:'1234567890',taxOffice:'TEST',phone:'PRIVATE-PHONE',email:'PRIVATE-EMAIL',identityNumber:'11111111111'}});
  const result=await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[input],totalPages:1,totalElements:1}),async()=>({created:1}));
  const payload=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM ec_provider_records').get().payload_json);assert.equal(payload.customer.billing.address,'TEST PRIVATE ADDRESS');assert.equal(payload.customer.tax_id,'1234567890');assert.equal(payload.invoice.number,'TEST-INV');assert.equal(payload.invoice.url,null);
  const raw=JSON.stringify(payload);for(const forbidden of ['PRIVATE-ID','PRIVATE-PHONE','PRIVATE-EMAIL','11111111111','private@example.test'])assert.ok(!raw.includes(forbidden));
  assert.ok(!JSON.stringify(result).includes('TEST PRIVATE ADDRESS'));assert.equal(result.records[0].customer,undefined);
  const inbox=await f.call('/records?provider=trendyol&kind=orders');assert.ok(!JSON.stringify(inbox).includes('TEST PRIVATE ADDRESS'));assert.equal(inbox.records[0].payload.customer,undefined);assert.equal(inbox.records[0].payload.invoice,undefined);
 }finally{f.sqlite.close();}
});
test('HB exact finance query casing, SKU bound, fail-closed unknown response and Payment source semantics',async()=>{
 const f=fixture();try{
  const hb={...credentials,seller_id:'11111111-1111-1111-1111-111111111111',user_agent:'Lunapot-SelfIntegration'};
  await f.call('/hepsiburada/configure',hb);
  const financial=await syncProvider(f.env,'hepsiburada',{...query,kind:'finance'},async(url,options)=>{
   assert.equal(url.origin,'https://mpfinance-external.hepsiburada.com');assert.equal(url.searchParams.get('Offset'),'0');assert.equal(url.searchParams.get('Limit'),'50');assert.equal(url.searchParams.get('RecordDateStart'),'2026-09-01T00:00:00');assert.equal(url.searchParams.has('begindate'),false);assert.equal(options.method,'GET');
   return Response.json({items:[{id:'HB-F1',transactionType:'Payment',amount:120,orderNumber:'HB-O1',customerName:'PRIVATE'}],totalCount:1});
  });assert.equal(financial.records[0].interpretation,'unreconciled_financial_record_not_bank_transfer');assert.equal(financial.orders,null);
  const commission=await syncProvider(f.env,'hepsiburada',{kind:'commissions',skus:['HB-SKU-1'],page:0},async url=>{
   assert.equal(url.origin,'https://listing-external.hepsiburada.com');assert.equal(url.searchParams.get('skuList'),'HB-SKU-1');assert.equal(url.searchParams.has('offset'),false);return Response.json([{hepsiburadaSku:'HB-SKU-1',commissionRate:18}]);
  });assert.equal(commission.records[0].tax_basis,'unverified');assert.equal(commission.records[0].commission_bps,1800);assert.equal(commission.hasMore,false);
  await assert.rejects(()=>syncProvider(f.env,'hepsiburada',{kind:'commissions',skus:Array(51).fill('SKU')},async()=>{}),/1–50/);
  await assert.rejects(()=>syncProvider(f.env,'hepsiburada',{...query,kind:'finance'},async()=>Response.json({UnknownEnvelope:[{secret:'PRIVATE'}]})),/şeması/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_sale_entries').get().n,0);
 }finally{f.sqlite.close();}
});
test('Errors do not advance successful cursor or expose provider body; unsupported currencies and subsidy remain review',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);
  await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[order()],totalPages:2,totalElements:51}),async()=>({}));
  await assert.rejects(()=>syncProvider(f.env,'trendyol',{...query,page:1},async()=>new Response('secret reflected '+credentials.secret,{status:401})),/erişimi/);
  assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page,1);assert.ok(!JSON.stringify(await f.call()).includes(credentials.secret));
  await assert.rejects(()=>syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[],totalPages:250,totalElements:11000})),/10.000/);
  await assert.rejects(()=>syncProvider(f.env,'trendyol',{...query,to:'2026-09-30'},async()=>{throw Error('not called');}),/14 gün/);
  let imported=false;await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[order({shipmentPackageId:12,currencyCode:'USD'})],totalPages:1,totalElements:1}),async()=>{imported=true;});assert.equal(imported,false);
  const subsidized=order({shipmentPackageId:13,lines:[{...order().lines[0],lineTyDiscount:10}]});
  await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[subsidized],totalPages:1,totalElements:1}),async(e,p,records)=>{assert.equal(records[0].lines[0].gross_cents,null);assert.equal(records[0].lines[0].amounts_need_review,true);});
 }finally{f.sqlite.close();}
});
test('TY finance source precision retained; PaymentOrder is never bank posted',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);
  const result=await syncProvider(f.env,'trendyol',{...query,kind:'payments'},async url=>{assert.ok(url.pathname.endsWith('/otherfinancials'));assert.equal(url.searchParams.get('transactionType'),'PaymentOrder');return Response.json({content:[{id:'F1',transactionType:'PaymentOrder',credit:123.4567,debt:0,orderNumber:'O',customerName:'PRIVATE NAME'}],totalPages:1});});
  assert.equal(result.records[0].credit,123.4567);assert.equal(result.orders,null);assert.ok(!JSON.stringify(result).includes('PRIVATE NAME'));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_sale_entries').get().n,0);
 }finally{f.sqlite.close();}
});
test('50 source records fit Free D1 query budget and repeated page advances bounded draft imports',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);
  const content=Array.from({length:50},(_,i)=>order({shipmentPackageId:i+100,orderNumber:'ORDER-'+i}));
  const fetcher=async()=>Response.json({content,totalPages:1,totalElements:50});
  f.resetQueries();const first=await syncProvider(f.env,'trendyol',query,fetcher);assert.ok(f.queryCount()<45,'Query count '+f.queryCount());
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n,50);assert.ok(first.orders.created>0);assert.ok(first.deferredOrders>0);
  const firstCount=f.sqlite.prepare('SELECT count(*) n FROM ec_order_packages').get().n;
  f.resetQueries();const second=await syncProvider(f.env,'trendyol',query,fetcher);assert.ok(f.queryCount()<45);assert.ok(second.orders.created>0);assert.ok(f.sqlite.prepare('SELECT count(*) n FROM ec_order_packages').get().n>firstCount);assert.ok(second.deferredOrders<first.deferredOrders);
 }finally{f.sqlite.close();}
});
test('Malformed pages, lossy IDs, duplicate lines and cross-seller data never mark a source page complete',async()=>{
 const f=fixture();try{
  await f.call('/trendyol/configure',credentials);
  const invalid=[
   {content:[order()],totalPages:0,totalElements:1},
   {content:[order()],totalPages:1},
   {content:[order()],totalPages:1,totalElements:1,page:2},
   {content:[order({shipmentPackageId:Number.MAX_SAFE_INTEGER+1})],totalPages:1,totalElements:1},
   {content:[order({supplierId:999})],totalPages:1,totalElements:1},
   {content:[order({lines:[order().lines[0],order().lines[0]]})],totalPages:1,totalElements:1},
   {content:[order({lines:[{...order().lines[0],quantity:1.5}]})],totalPages:1,totalElements:1}
  ];
  for(const payload of invalid)await assert.rejects(()=>syncProvider(f.env,'trendyol',query,async()=>Response.json(payload)));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_cursors').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n,0);
  const missingDate=await syncProvider(f.env,'trendyol',query,async()=>Response.json({content:[order({lastModifiedDate:undefined})],totalPages:1,totalElements:1}));assert.equal(missingDate.orders,null);assert.equal(missingDate.reviewOnlyOrders,1);assert.ok(missingDate.message.includes('inceleme'));
 }finally{f.sqlite.close();}
});

// TRENDYOL FİNANS UÇLARI size=50 KABUL ETMİYOR: "Size değeri 500 ya da 1000 olmalıdır" diye 400
// döndürüyor. Sipariş ucu 50'yi kabul ettiği için hata yalnız komisyon/kesinti çekerken çıkıyordu
// ve entegrasyon hiç çalışamamıştı. Canlı API ile doğrulandı (2026-09-24).
test('TY finans uçları 500 sayfa boyutuyla çağrılır; sipariş ucu 50 kalır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const cagrilar = [];
  const fetcher = async url => {
   cagrilar.push({yol: url.pathname, size: url.searchParams.get('size'), tip: url.searchParams.get('transactionType')});
   return Response.json({content: [], totalPages: 0, totalElements: 0});
  };
  for (const kind of ['sale', 'return', 'deductions', 'payments'])
   await syncProvider(f.env, 'trendyol', {kind, from: '2026-09-09', to: '2026-09-23'}, fetcher, async () => ({created: 0}));

  assert.equal(cagrilar.length, 4, 'dört finans türü de çağrılmalı');
  for (const c of cagrilar) assert.equal(c.size, '500', c.yol + ' / ' + c.tip + ' için size 500 olmalı');
  assert.deepEqual(cagrilar.map(c => c.tip), ['Sale', 'Return', 'DeductionInvoices', 'PaymentOrder']);

  // Sipariş ucu 50 kabul ediyor; gereksiz yere büyütülmedi.
  const siparis = [];
  await syncProvider(f.env, 'trendyol', {kind: 'orders', from: '2026-09-09', to: '2026-09-20'},
   async url => { siparis.push(url.searchParams.get('size')); return Response.json({content: [], totalPages: 0, totalElements: 0}); },
   async () => ({created: 0}));
  assert.deepEqual(siparis, ['50'], 'sipariş ucunun sayfa boyutu değişmemeli');
 } finally { f.sqlite.close(); }
});

// YAZMADAN DENE (ÖNİZLEME): kullanıcı senkronu hiç çalıştırmadan ne geleceğini görmek istiyor.
// Ölçtüğümüz şey "hiç yazılmadı"dır: dört tablonun satır sayısı VE içeriği önce/sonra birebir aynı kalmalı.
test('Önizleme hiçbir şey yazmaz, taslak üretmez ve sayıları gerçek senkronla tutar', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const tablolar = ['ec_provider_records', 'ec_provider_cursors', 'ec_integration_runs', 'ec_provider_connections'];
  const goruntu = () => JSON.stringify(tablolar.map(t => f.sqlite.prepare('SELECT * FROM ' + t).all()));
  const sayfa = {content: [order(), order({shipmentPackageId: 12, orderNumber: 'ORD-2'})], totalPages: 1, totalElements: 2};
  const fetcher = async () => Response.json(sayfa);
  let aktarim = 0; const importer = async (env, provider, records) => {aktarim++; return {created: records.length};};

  const oncesi = goruntu();
  const onizleme = await syncProvider(f.env, 'trendyol', {...query, preview: true}, fetcher, importer);
  assert.equal(goruntu(), oncesi, 'önizleme hiçbir satır yazmamalı');
  assert.equal(aktarim, 0, 'önizlemede sipariş taslağı aktarımı hiç çağrılmaz');
  assert.equal(onizleme.preview, true);
  assert.equal(onizleme.orders, null, 'önizlemede taslak oluşmadığı için orders null kalır');
  assert.equal(onizleme.importableOrders, 2, 'gerçek senkronda kaç taslak oluşacağı görünmeli');
  assert.ok(onizleme.message.startsWith('ÖNİZLEME'), onizleme.message);
  for (const ibare of ['hiçbir şey yazılmadı', 'sipariş taslağı oluşturulmadı', 'imleç ilerlemedi', 'Kaynak kayıtlarıdır'])
   assert.ok(onizleme.message.includes(ibare), ibare + ' mesajda yok: ' + onizleme.message);
  for (const t of tablolar.slice(0, 3).concat('ec_order_packages'))
   assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ' + t).get().n, 0, t + ' önizlemeden sonra boş kalmalı');

  // Aynı girdiyle gerçek senkron: sayılar birebir tutmalı, ama bu kez YAZMALI.
  const gercek = await syncProvider(f.env, 'trendyol', query, fetcher, importer);
  for (const alan of ['records', 'unchanged', 'changed', 'reviewOnlyOrders', 'deferredOrders', 'oversizedOrders', 'importableOrders', 'hasMore', 'page', 'next_page', 'warnings'])
   assert.deepEqual(onizleme[alan], gercek[alan], alan + ' önizlemede ve gerçek senkronda aynı olmalı');
  assert.equal(gercek.preview, false);
  assert.equal(aktarim, 1, 'gerçek senkron taslak aktarımını çağırır');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_integration_runs').get().n, 1);

  // Önizleme OKUMAYA devam eder: "kaç değişmiş" sayısı ancak mevcut kayıtlar görülürse anlamlıdır.
  const degisen = {content: [order(), order({shipmentPackageId: 12, orderNumber: 'ORD-2', status: 'Shipped', lastModifiedDate: 1788902200000})], totalPages: 1, totalElements: 2};
  const ikinciOncesi = goruntu();
  const onizleme2 = await syncProvider(f.env, 'trendyol', {...query, preview: true}, async () => Response.json(degisen), importer);
  assert.equal(goruntu(), ikinciOncesi, 'ikinci önizleme de hiçbir satır değiştirmemeli');
  assert.equal(onizleme2.unchanged, 1);
  assert.equal(onizleme2.changed, 1);
  const gercek2 = await syncProvider(f.env, 'trendyol', query, async () => Response.json(degisen), importer);
  assert.equal(gercek2.unchanged, onizleme2.unchanged, 'değişmeyen kayıt sayısı önizlemeyle tutmalı');
  assert.equal(gercek2.changed, onizleme2.changed, 'değişen kayıt sayısı önizlemeyle tutmalı');

  // Sağlayıcı hata döndürdüğünde önizleme last_error ve integration_runs yazmaz; hata yine döner.
  const hataOncesi = goruntu();
  await assert.rejects(() => syncProvider(f.env, 'trendyol', {...query, preview: true}, async () => new Response('secret ' + credentials.secret, {status: 401}), importer), /erişimi/);
  assert.equal(goruntu(), hataOncesi, 'önizleme hata yolunda da iz bırakmamalı');
  await assert.rejects(() => syncProvider(f.env, 'trendyol', query, async () => new Response('secret ' + credentials.secret, {status: 401}), importer), /erişimi/);
  assert.ok(f.sqlite.prepare('SELECT last_error FROM ec_provider_connections').get().last_error, 'gerçek senkron hatası iz bırakır (karşı kontrol)');
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ec_integration_runs WHERE status='error'").get().n, 1);

  // İmleç yazılmadığı için sıra kuralı önizlemede uygulanmaz: istenen sayfaya yazmadan bakılabilir.
  const ileri = await syncProvider(f.env, 'trendyol', {...query, page: 5, preview: true}, async url => {assert.equal(url.searchParams.get('page'), '5'); return Response.json({content: [], totalPages: 9, totalElements: 300});}, importer);
  assert.equal(ileri.page, 5);
  assert.equal(ileri.preview, true);
  await assert.rejects(() => syncProvider(f.env, 'trendyol', {...query, page: 5}, fetcher, importer), /sırayla/, 'gerçek senkronda sıra kuralı aynen durmalı');
  assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page, 1, 'önizleme imleci ilerletmemeli');
  assert.equal(aktarim, 2, 'önizlemeler taslak aktarımını hiç çağırmadı');
 } finally { f.sqlite.close(); }
});

// Belirsiz bayrak TAHMİN EDİLMEZ: form gövdeleri alanları metin taşır ('on', 'false') ve yanlış
// yönde okumak (önizleme sanılan istek YAZARSA) geri alınamaz iş üretir. Reddetmek tek güvenli yol.
test('Belirsiz preview değeri reddedilir; alan yoksa eski davranış yazmaya devam eder', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  for (const deger of ['true', 'false', 'on', 1, 0, {}, []])
   await assert.rejects(() => syncProvider(f.env, 'trendyol', {...query, preview: deger}, async () => {throw Error('sağlayıcıya hiç gidilmemeli');}, async () => {throw Error('aktarım çağrılmamalı');}), /true\/false/, JSON.stringify(deger) + ' değeri reddedilmeli');
  await assert.rejects(() => f.call('/trendyol/sync', {...query, preview: 'true'}), /true\/false/, 'uç gövdesindeki metin değer de reddedilmeli');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_integration_runs').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_cursors').get().n, 0);

  // Alan hiç gelmezse veya açıkça false ise eski davranış korunur: normal senkron yazar.
  const yazan = await syncProvider(f.env, 'trendyol', {...query, preview: false}, async () => Response.json({content: [order()], totalPages: 1, totalElements: 1}), async () => ({created: 1}));
  assert.equal(yazan.preview, false);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT next_page FROM ec_provider_cursors').get().next_page, 1);
 } finally { f.sqlite.close(); }
});
