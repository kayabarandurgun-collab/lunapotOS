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
  const fetcher=async(url,options)=>{fetchCount++;assert.equal(url.origin,'https://apigw.trendyol.com');assert.equal(url.pathname,'/integration/order/sellers/1234/v2/orders');assert.equal(url.searchParams.get('size'),'50');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(options.headers.Authorization.startsWith('Basic '));return Response.json({content:[order()],totalPages:2,totalElements:80});};
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

// Cloudflare Workers redirect:'error' değerini kabul etmiyor: istek daha ağa çıkmadan TypeError ile
// düşüyordu ve HER sağlayıcı çağrısı canlıda başarısızdı. Node bu değeri desteklediği için hata ne
// testlerde ne yerel denemede görünüyordu. Bayrak 'manual'; yönlendirmeyi izlememe amacı korunmalı.
test('Sağlayıcı isteği yönlendirmeyi izlemez: 3xx reddedilir, kimlik ikinci adrese gitmez', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  let cagri = 0;
  const fetcher = async (url, options) => {
   cagri++;
   assert.equal(options.redirect, 'manual');
   assert.equal(url.origin, 'https://apigw.trendyol.com');
   return new Response(null, {status: 302, headers: {Location: 'https://baska-adres.example/kimlik-topla'}});
  };
  await assert.rejects(() => syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 0})), /yönlendirdi/);
  assert.equal(cagri, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 0);
 } finally { f.sqlite.close(); }
});

// Trendyol V2 supplierId alanını kullanmıyor ve 0 gönderiyor. Ham karşılaştırmada '0' hiçbir zaman
// satıcı kimliğine eşit olmadığı için HER sipariş yabancı mağaza sanılıyor ve senkron hiç
// çalışamıyordu. Dolu olmayan alan karşılaştırmaya girmemeli; gerçekten yabancı kimlik hâlâ durdurmalı.
test('Boş satıcı alanı (0) siparişi yabancı saymaz; gerçekten yabancı kimlik durdurulur', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const sahte = (paket) => async () => Response.json({content: [paket], totalPages: 1, totalElements: 1});
  // supplierId:0 + doğru lines.sellerId → kabul edilmeli
  const kabul = await syncProvider(f.env, 'trendyol', query,
   sahte({...order(), supplierId: 0, lines: [{...order().lines[0], sellerId: Number(credentials.seller_id)}]}),
   async () => ({created: 1}));
  assert.equal(kabul.records.length, 1);
  // Gerçekten başka mağazanın kimliği → reddedilmeli
  await assert.rejects(() => syncProvider(f.env, 'trendyol', {...query, page: 1},
   sahte({...order(), shipmentPackageId: 99, supplierId: 0, lines: [{...order().lines[0], sellerId: 9999999}]}),
   async () => ({created: 0})), /eşleşmiyor/);
  await assert.rejects(() => syncProvider(f.env, 'trendyol', {...query, page: 1},
   sahte({...order(), shipmentPackageId: 98, supplierId: 9999999}),
   async () => ({created: 0})), /eşleşmiyor/);
 } finally { f.sqlite.close(); }
});

// size=500 düzeltmesi yapıldığında yanıt doğrulaması sabit 50'de kalmıştı: finans uçları 500 satır
// isteyip 50'den fazlasını reddediyordu. Hakediş (komisyonun geldiği uç) bu yüzden hiç geçemiyordu.
test('Finans yanıtı istenen sayfa boyutu kadar satır taşıyabilir; sipariş ucu 50 sınırında kalır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const satis = (n) => ({content: Array.from({length: n}, (_, i) => ({id: 'S' + i, orderNumber: 'O' + i, transactionType: 'Sale', credit: 10, commissionAmount: 1})), totalPages: 1});
  // Finans: 500 satır gelebilmeli (istenen size ile aynı)
  const fin = await syncProvider(f.env, 'trendyol', {kind: 'sale', from: '2026-09-01', to: '2026-09-09', page: 0},
   async (url) => { assert.equal(url.searchParams.get('size'), '500'); return Response.json(satis(500)); }, async () => ({created: 0}));
  assert.equal(fin.records.length, 500);
  // Sipariş ucu 50 istiyor: 51 satır dönerse yanıt hâlâ reddedilmeli
  await assert.rejects(() => syncProvider(f.env, 'trendyol', query,
   async (url) => { assert.equal(url.searchParams.get('size'), '50'); return Response.json({content: Array.from({length: 51}, () => order()), totalPages: 1}); },
   async () => ({created: 0})), /sayfa boyutu/);
 } finally { f.sqlite.close(); }
});

// TESLİM ONAYI (PAZARYERİ API). Kâr yalnız teslim edilmiş pakette hesaplanıyor; Trendyol paketi
// teslim ettiği hâlde defterde 'shipped' kalan paket sessizce kârın dışında kalıyordu. Rapor
// tarafındaki aynı iş (report-inbox-api.js) burada API kaynağı için tekrarlanıyor.
// Trendyol V2 sipariş yanıtında AYRI bir teslim tarihi alanı YOKTUR: gerçekleşen teslim yalnız
// packageHistories içindeki {status:'Delivered',createdDate} satırında durur. Gün TR saatiyle (+03)
// hesaplanır, occurred_on ile aynı kural.
const teslimGecmisi = (t = Date.parse('2026-09-20T21:30:00Z')) => [
 {status: 'Created', createdDate: 1788901200000},
 {status: 'Shipped', createdDate: Date.parse('2026-09-18T06:00:00Z')},
 {status: 'Delivered', createdDate: t}
];
const teslimEdilmis = (overrides = {}) => order({status: 'Delivered', shipmentPackageStatus: 'Delivered', packageHistories: teslimGecmisi(), ...overrides});
// Durum makinesi tetiği draft→shipped geçişine izin vermez (draft→reserved→shipped yolu ayırma
// ister); kargodaki paket bu yüzden doğrudan o durumda yazılır.
// EŞLEŞME SİPARİŞ NUMARASIYLA KURULUR: yereldeki paketin external_id'si rapor/fatura yolundan gelmiş
// olabilir ve Trendyol'un paket kimliğiyle hiç örtüşmez, bu yüzden order_no ayrıca verilebilir.
const paketYaz = (f, externalID, status, delivered_on = null, source_changed = 0, order_no = 'ORD-' + externalID) => f.sqlite.prepare(
 "INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,external_status,source_fingerprint,delivered_on,source_changed) VALUES(?,'trendyol',?,?,'2026-09-05',?,'',?,?,?)"
).run('pkt-' + externalID, String(externalID), order_no, status, 'fp-' + externalID, delivered_on, source_changed);
const paketOku = (f, externalID) => f.sqlite.prepare('SELECT * FROM ec_order_packages WHERE external_id=?').get(String(externalID));

// DEĞİŞMEYEN KAYITLARA DA BAKILMALI: syncProvider parmak izi aynı olan paketi 'continue' ile atlar ve
// importOrders yalnız yeni/değişen paketler için çalışır. Teslim onayı o atlamanın ARKASINDA kalırsa
// tam olarak sorunlu paketler (teslim edilmiş ama defterde kargoda duranlar) hiç taranmaz.
test('Trendyol teslim ettiyse kargodaki paket teslim işaretlenir; tarih Trendyol\'dan gelir, değişmeyen kayıtta da çalışır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const fetcher = async () => Response.json({content: [teslimEdilmis()], totalPages: 1, totalElements: 1});

  // 1) Kaynak kaydı alınır. Paket henüz defterde yok: işaretlenecek bir şey de yok.
  const ilk = await syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 1}));
  assert.equal(ilk.deliveredMarked, 0);

  // 2) Paket kargoya verilmiş. Trendyol onu çoktan teslim ettiği için kaynak kaydı ARTIK DEĞİŞMİYOR:
  //    her çekişte 'aynı' sayılıp atlanıyor ve paket sonsuza kadar kargoda kalıyordu.
  paketYaz(f, 11, 'shipped', null, 0, 'ORD-1');

  const ikinci = await syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 0}));
  assert.equal(ikinci.unchanged, 1, 'kaynak kaydı değişmedi: atlanan (continue) yol');
  assert.equal(ikinci.deliveredMarked, 1, 'değişmeyen kayıt da teslim onayına girmeli');
  const teslim = paketOku(f, 11);
  assert.equal(teslim.status, 'delivered');
  assert.equal(teslim.delivered_on, '2026-09-21', 'teslim günü Trendyol\'un verdiği gündür (TR saati)');
  assert.equal(ikinci.undatedDeliveries, 0);
  assert.ok(ikinci.warnings.some(w => w.includes('teslim')), 'teslim onayı sonuçta bildirilmeli: ' + JSON.stringify(ikinci.warnings));

  // 3) Aynı sayfa bir daha çekilirse paket artık kargoda değil: ikinci kez işlenmez.
  const ucuncu = await syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 0}));
  assert.equal(ucuncu.deliveredMarked, 0, 'zaten teslim edilmiş paket tekrar işlenmez');
  assert.equal(paketOku(f, 11).delivered_on, '2026-09-21');

  // 4) Kaynak sonradan değişirse taslak aktarımı gerçek importOrders ile çalışır; teslim durumu geri alınmaz.
  await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [teslimEdilmis({lastModifiedDate: 1789939900000})], totalPages: 1, totalElements: 1}));
  assert.equal(paketOku(f, 11).status, 'delivered', 'taslak aktarımı teslim durumunu geri almamalı');
  assert.equal(paketOku(f, 11).delivered_on, '2026-09-21');
 } finally { f.sqlite.close(); }
});

// TEK YÖN: yalnız 'shipped' → 'delivered'. Durum makinesi (ec_order_transition tetiği) başka geçişi
// ABORT eder ve bütün parti geri alınır; bu yüzden eleme WHERE ile yapılır, zorlanmaz.
test('Teslim onayı yalnız kargodaki paketi ilerletir: draft/reserved/iptal/zaten teslim edilmiş değişmez', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 201, 'draft'); paketYaz(f, 202, 'reserved'); paketYaz(f, 203, 'cancelled');
  paketYaz(f, 204, 'delivered', '2026-01-01'); paketYaz(f, 205, 'shipped');
  // Kaynağı değişmiş (source_changed=1) kargodaki paket de teslim edilebilmeli: durum makinesi bu
  // bayrağı yalnız 'reserved'/'shipped' HEDEFİ için engeller, teslim için değil.
  paketYaz(f, 206, 'shipped', null, 1);
  const content = [201, 202, 203, 204, 205, 206].map((p, i) => teslimEdilmis({shipmentPackageId: p, orderNumber: 'ORD-' + p, lines: [{...order().lines[0], lineId: 900 + i}]}));

  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content, totalPages: 1, totalElements: 6}), async () => ({created: 0}));
  assert.equal(sonuc.deliveredMarked, 2, 'yalnız kargodaki paketler teslim işaretlenir');
  assert.equal(paketOku(f, 206).status, 'delivered', 'kaynağı değişmiş kargodaki paket de teslim edilir');
  assert.equal(paketOku(f, 201).status, 'draft');
  assert.equal(paketOku(f, 202).status, 'reserved');
  assert.equal(paketOku(f, 203).status, 'cancelled');
  assert.equal(paketOku(f, 204).delivered_on, '2026-01-01', 'zaten teslim edilmiş paketin tarihi ezilmez');
  assert.equal(paketOku(f, 205).status, 'delivered');
  assert.equal(paketOku(f, 205).delivered_on, '2026-09-21');
  // Geçersiz bir geçiş denenseydi tetik partiyi geri alırdı: kaynak kayıtları yazılmış olmalı.
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 6, 'parti geri alınmamalı');
 } finally { f.sqlite.close(); }
});

// ÖNİZLEME YAZMAZ: sayı görünür, paket kargoda kalır.
test('Önizlemede teslim onayı yazılmaz ama kaç paketin işaretleneceği doğru döner', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 11, 'shipped', null, 0, 'ORD-1');
  const fetcher = async () => Response.json({content: [teslimEdilmis()], totalPages: 1, totalElements: 1});

  const onizleme = await syncProvider(f.env, 'trendyol', {...query, preview: true}, fetcher, async () => ({created: 0}));
  assert.equal(onizleme.deliveredMarked, 1, 'önizleme kaç paketin teslim işaretleneceğini söylemeli');
  assert.equal(paketOku(f, 11).status, 'shipped', 'önizleme paketi değiştirmemeli');
  assert.equal(paketOku(f, 11).delivered_on, null);

  const gercek = await syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 0}));
  assert.equal(gercek.deliveredMarked, onizleme.deliveredMarked, 'sayı önizlemeyle gerçek senkronda aynı olmalı');
  assert.equal(paketOku(f, 11).status, 'delivered');
  assert.equal(paketOku(f, 11).delivered_on, '2026-09-21');
 } finally { f.sqlite.close(); }
});

// TARİH UYDURULMAZ. estimatedDeliveryStartDate/EndDate TAHMİN, agreedDeliveryDate TAAHHÜTTÜR;
// ikisi de gerçekleşen teslim günü değildir. Geçmiş satırı gelmeyen paket işaretlenmez, sayılır.
test('Teslim tarihi gelmeyen paket işaretlenmez; tahmini/taahhüt tarihler teslim tarihi sayılmaz', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 11, 'shipped', null, 0, 'ORD-1'); paketYaz(f, 12, 'shipped', null, 0, 'ORD-2');
  const tarihsiz = teslimEdilmis({packageHistories: [{status: 'Created', createdDate: 1788901200000}],
   estimatedDeliveryStartDate: Date.parse('2026-09-19T00:00:00Z'), estimatedDeliveryEndDate: Date.parse('2026-09-25T00:00:00Z'), agreedDeliveryDate: Date.parse('2026-09-22T00:00:00Z')});
  const gecmissiz = teslimEdilmis({shipmentPackageId: 12, orderNumber: 'ORD-2', packageHistories: undefined, lines: [{...order().lines[0], lineId: 33}]});

  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [tarihsiz, gecmissiz], totalPages: 1, totalElements: 2}), async () => ({created: 0}));
  assert.equal(sonuc.deliveredMarked, 0, 'güvenilir teslim tarihi yoksa paket işaretlenmez');
  assert.equal(sonuc.undatedDeliveries, 2, 'tarihsiz kalan paket sayısı bildirilmeli');
  for (const p of [11, 12]) { assert.equal(paketOku(f, p).status, 'shipped'); assert.equal(paketOku(f, p).delivered_on, null); }
  assert.ok(sonuc.warnings.some(w => w.includes('teslim tarihi')), JSON.stringify(sonuc.warnings));

  // Teslim edilmemiş paket (kargoda) hiçbir sayıya girmez.
  paketYaz(f, 13, 'shipped', null, 0, 'ORD-3');
  const yolda = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [order({shipmentPackageId: 13, orderNumber: 'ORD-3', status: 'Shipped', lines: [{...order().lines[0], lineId: 44}]})], totalPages: 1, totalElements: 1}), async () => ({created: 0}));
  assert.equal(yolda.deliveredMarked, 0);
  assert.equal(yolda.undatedDeliveries, 0);
  assert.equal(paketOku(f, 13).status, 'shipped');
 } finally { f.sqlite.close(); }
});

// EŞLEŞME ALANI: PAKET KİMLİĞİ DEĞİL, SİPARİŞ NUMARASI. Canlıda ölçüldü: yerel Trendyol paketlerinin
// external_id'si rapor/fatura yolundan geliyor (392 paket 'RPT-…' özeti, 176 paket 'TEA…' fatura
// numarası), API'nin verdiği sayısal shipmentPackageId ile KESİŞİMİ SIFIR. Paket kimliğine bakan
// teslim onayı bu yüzden canlıda hiçbir paketi işaretlemiyordu. Ortak alan yalnız order_no'dur.
test('Yerel paket kimliği Trendyol paket kimliğinden tamamen farklı olsa da sipariş numarasıyla teslim işaretlenir', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const yerel = 'RPT-9debe91de32375a87d94f6e14c9b5aed6e026676';
  paketYaz(f, yerel, 'shipped', null, 0, 'ORD-1');
  // Aynı siparişin iptal edilmiş paketi adaylığı engellemez: KARGODAKİ paket yine tektir. Yazma
  // paketin kendi kimliğiyle yapıldığı için kardeş paket hiç dokunulmadan kalmalı.
  paketYaz(f, 'RPT-iptal', 'cancelled', null, 0, 'ORD-1');

  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [teslimEdilmis()], totalPages: 1, totalElements: 1}), async () => ({created: 0}));
  assert.equal(sonuc.deliveredMarked, 1, 'paket kimlikleri örtüşmüyor ama sipariş numarası aynı');
  assert.equal(sonuc.ambiguousDeliveries, 0);
  assert.equal(paketOku(f, yerel).status, 'delivered');
  assert.equal(paketOku(f, yerel).delivered_on, '2026-09-21', 'teslim günü Trendyol geçmişinden gelir');
  assert.equal(paketOku(f, 'RPT-iptal').status, 'cancelled', 'kardeş paket değişmemeli');
 } finally { f.sqlite.close(); }
});

// BELİRSİZSE DOKUNMA. Sipariş numarası paket kimliği kadar kesin değildir: bir sipariş birden çok
// pakete bölünebiliyor (canlıda 548 sipariş / 568 paket). Yerelde aynı siparişin İKİ paketi kargodaysa
// Trendyol'un teslim ettiği paketin hangisi olduğu bilinemez; yanlış paketi işaretlemek kârı yanlış
// pakete yazar. Rapor tarafındaki 'ambiguous_twin'/erpMatch kuralının aynısı: tek aday varsa bağla,
// yoksa hiç dokunma ve ayrı bir sayaçla bildir.
test('Aynı siparişin yerelde iki kargo paketi varsa hiçbiri teslim işaretlenmez; belirsiz olarak sayılır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 'RPT-a', 'shipped', null, 0, 'ORD-1');
  paketYaz(f, 'RPT-b', 'shipped', null, 0, 'ORD-1');
  const fetcher = async () => Response.json({content: [teslimEdilmis()], totalPages: 1, totalElements: 1});

  const onizleme = await syncProvider(f.env, 'trendyol', {...query, preview: true}, fetcher, async () => ({created: 0}));
  assert.equal(onizleme.deliveredMarked, 0);
  assert.equal(onizleme.ambiguousDeliveries, 1, 'önizleme de belirsizliği bildirmeli');

  const sonuc = await syncProvider(f.env, 'trendyol', query, fetcher, async () => ({created: 0}));
  assert.equal(sonuc.deliveredMarked, 0, 'belirsiz eşleşmede hiçbir paket işaretlenmez');
  assert.equal(sonuc.ambiguousDeliveries, 1);
  assert.equal(sonuc.undatedDeliveries, 0, 'tarih var; eksik olan eşleşmenin kesinliği');
  for (const p of ['RPT-a', 'RPT-b']) { assert.equal(paketOku(f, p).status, 'shipped'); assert.equal(paketOku(f, p).delivered_on, null); }
  assert.ok(sonuc.warnings.some(w => w.includes('kesin')), JSON.stringify(sonuc.warnings));
 } finally { f.sqlite.close(); }
});

// SİPARİŞİN ÇEKİLEN BÜTÜN PAKETLERİ TESLİM EDİLMİŞ OLMALI. Trendyol siparişi iki pakete bölmüşse ve
// yalnız biri teslim edildiyse, yereldeki tek kargo kaydının hangi paket olduğu bilinemez: işaretlenmez.
test('Siparişin çekilen paketlerinden biri teslim edilmemişse işaretlenmez; hepsi teslim edilince en geç gün yazılır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const yerel = 'TEA2026000000203';
  paketYaz(f, yerel, 'shipped', null, 0, 'ORD-1');
  const ikinciPaket = (overrides = {}) => teslimEdilmis({shipmentPackageId: 12, lines: [{...order().lines[0], lineId: 33}], ...overrides});

  const eksik = await syncProvider(f.env, 'trendyol', query, async () => Response.json({
   content: [teslimEdilmis(), ikinciPaket({status: 'Shipped', shipmentPackageStatus: 'Shipped', packageHistories: [{status: 'Shipped', createdDate: Date.parse('2026-09-18T06:00:00Z')}]})],
   totalPages: 1, totalElements: 2}), async () => ({created: 0}));
  assert.equal(eksik.deliveredMarked, 0, 'siparişin bir paketi hâlâ yolda');
  assert.equal(eksik.ambiguousDeliveries, 1);
  assert.equal(paketOku(f, yerel).status, 'shipped');
  assert.equal(paketOku(f, yerel).delivered_on, null);

  // İkinci paket de teslim edildi. Kâr TESLİMLE doğar; yereldeki tek kayıt siparişin tamamını temsil
  // ettiği için mal ancak SON paket ulaştığında müşterinin elindedir. En erken günü seçmek kârı mal
  // hâlâ yoldayken yazardı, bu yüzden EN GEÇ teslim günü kullanılır.
  const tam = await syncProvider(f.env, 'trendyol', query, async () => Response.json({
   content: [teslimEdilmis(), ikinciPaket({packageHistories: teslimGecmisi(Date.parse('2026-09-22T21:30:00Z'))})],
   totalPages: 1, totalElements: 2}), async () => ({created: 0}));
  assert.equal(tam.deliveredMarked, 1);
  assert.equal(tam.ambiguousDeliveries, 0);
  assert.equal(paketOku(f, yerel).status, 'delivered');
  assert.equal(paketOku(f, yerel).delivered_on, '2026-09-23', 'siparişin en geç teslim günü (TR saati)');
 } finally { f.sqlite.close(); }
});

// MÜKERRER PAKET AÇMA. Canlıda ölçüldü: yerel Trendyol paketlerinin external_id'si rapor/fatura
// yolundan geliyor ('RPT-…' 392, 'TEA…' 176), API ise sayısal paket kimliği veriyor; KESİŞİM SIFIR.
// syncProvider "bu paket zaten aktarılmış mı" kontrolünü external_id ile yaptığı için API'den gelen
// HER paket 'yeni' sayılıyor, importOrders → createPackage aynı sipariş için İKİNCİ bir paket açıyor
// ve üstüne mükerrer stok bileşeni ile satış kaydı üretiyordu (canlı önizlemede ~65 mükerrer paket).
// Ortak olan tek alan order_no'dur: o siparişin yerelde paketi varsa sipariş zaten sistemdedir.
test('Yerel paket kimliği tamamen farklı olsa da aynı sipariş numarası için ikinci paket açılmaz', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const yerel = 'RPT-abc';
  paketYaz(f, yerel, 'draft', null, 0, 'ORD-1');

  // Gerçek importOrders çalışsın: mükerrer paketi ancak yazma yolunun tamamı ölçülürse yakalarız.
  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [order()], totalPages: 1, totalElements: 1}));

  assert.equal(sonuc.alreadyKnownOrders, 1, 'sipariş zaten sistemde olduğu için tanınmalı');
  assert.equal(sonuc.importableOrders, 0, 'tanınan sipariş taslak listesine hiç girmemeli');
  assert.equal(sonuc.orders, null, 'aktarılacak paket kalmadığı için importOrders hiç çağrılmaz');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_order_packages').get().n, 1, 'mükerrer paket açılmamalı');
  // Kaynak kaydı YİNE saklanır: tanımak, kaynağı atmak demek değildir.
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 1, 'kaynak kaydı saklanmalı');
  // Var olan paketin kimliğine DOKUNULMAZ: UNIQUE(channel,external_id) kısıtı ve rapor bağlantısı
  // (report_link_hash/report_linked) bu kimliğe dayanıyor; güncellemek ikisini birden bozar.
  assert.equal(paketOku(f, yerel).external_id, yerel, 'var olan paketin kimliği değişmemeli');
  assert.equal(paketOku(f, yerel).order_no, 'ORD-1');
  assert.ok(sonuc.warnings.some(w => w.includes('zaten sistemde')), JSON.stringify(sonuc.warnings));
 } finally { f.sqlite.close(); }
});

// GERİYE DÖNÜK KIRILMA YOK: yerelde o siparişin hiç paketi yoksa sipariş gerçekten yenidir ve taslak
// eskisi gibi açılır. Aynı çağrıda tanınan ve yeni sipariş birlikte gelirse ikisi de doğru işlenir.
test('Yerelde paketi olmayan sipariş eskisi gibi taslak açar; tanınan ve yeni sipariş aynı çağrıda ayrışır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 'RPT-abc', 'draft', null, 0, 'ORD-1');

  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({
   content: [order(), order({shipmentPackageId: 12, orderNumber: 'ORD-2'})], totalPages: 1, totalElements: 2}));

  assert.equal(sonuc.alreadyKnownOrders, 1, 'yalnız ORD-1 tanınmalı');
  assert.equal(sonuc.importableOrders, 1, 'ORD-2 gerçekten yeni: taslak açılmalı');
  assert.equal(sonuc.orders.created, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_order_packages').get().n, 2, 'yalnız bir paket eklenmeli');
  assert.ok(paketOku(f, 12), 'yeni sipariş için paket açılmalı');
  assert.equal(paketOku(f, 12).order_no, 'ORD-2');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_provider_records').get().n, 2, 'iki kaynak kaydı da saklanır');
 } finally { f.sqlite.close(); }
});

// CANLIDAKİ ASIL SENARYO: sipariş hem zaten sistemde hem de Trendyol tarafında teslim edilmiş.
// Taslak açılmamalı AMA teslim onayı çalışmaya devam etmeli. Teslim onayı 'continue' satırından
// ÖNCE toplandığı için tanıma bu sırayı bozmamalıdır.
test('Tanınan sipariş için taslak açılmaz ama paket yine teslim işaretlenir', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  const yerel = 'RPT-abc';
  paketYaz(f, yerel, 'shipped', null, 0, 'ORD-1');

  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [teslimEdilmis()], totalPages: 1, totalElements: 1}));

  assert.equal(sonuc.alreadyKnownOrders, 1);
  assert.equal(sonuc.importableOrders, 0);
  assert.equal(sonuc.deliveredMarked, 1, 'taslak açılmasa da teslim onayı çalışmalı');
  assert.equal(sonuc.ambiguousDeliveries, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ec_order_packages').get().n, 1, 'mükerrer paket açılmamalı');
  assert.equal(paketOku(f, yerel).status, 'delivered');
  assert.equal(paketOku(f, yerel).delivered_on, '2026-09-21');
  assert.equal(paketOku(f, yerel).external_id, yerel, 'teslim yazarken de kimlik değişmez');
 } finally { f.sqlite.close(); }
});

// PAKETİN KENDİ KİMLİĞİ YERELDE VARSA TANIMA DEVREYE GİRMEZ: createPackage o paketi external_id ile
// bulup günceller (kaynak değişikliği/çakışma bayrağı bu yolda işlenir). Tanıma bu yolu da kapatsaydı
// değişen kaynak bir daha hiç işlenmezdi.
test('Kimliği yerelde olan paket tanınan sipariş sayılmaz; kaynak değişikliği yine aktarılır', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 11, 'draft', null, 0, 'ORD-1');
  let aktarilan = null;
  const sonuc = await syncProvider(f.env, 'trendyol', query, async () => Response.json({content: [order()], totalPages: 1, totalElements: 1}),
   async (env, provider, records) => {aktarilan = records; return {created: 0, existing: 1};});

  assert.equal(sonuc.alreadyKnownOrders, 0, 'paketin kendi kimliği yerelde: bu tanıma değil güncellemedir');
  assert.equal(sonuc.importableOrders, 1);
  assert.equal(aktarilan.length, 1, 'kaynak güncellemesi importOrders ile işlenmeli');
  assert.equal(aktarilan[0].external_id, '11');
 } finally { f.sqlite.close(); }
});

// ÖNİZLEME YAZMAZ: tanıma sayısı görünür ama tek satır bile yazılmaz.
test('Önizlemede tanınan sipariş sayılır, hiçbir şey yazılmaz', async () => {
 const f = fixture(); try {
  await f.call('/trendyol/configure', credentials);
  paketYaz(f, 'RPT-abc', 'draft', null, 0, 'ORD-1');
  const tablolar = ['ec_provider_records', 'ec_provider_cursors', 'ec_integration_runs', 'ec_order_packages'];
  const goruntu = () => JSON.stringify(tablolar.map(t => f.sqlite.prepare('SELECT * FROM ' + t).all()));
  const fetcher = async () => Response.json({content: [order(), order({shipmentPackageId: 12, orderNumber: 'ORD-2'})], totalPages: 1, totalElements: 2});
  let aktarim = 0; const importer = async (env, provider, records) => {aktarim++; return {created: records.length};};

  const oncesi = goruntu();
  const onizleme = await syncProvider(f.env, 'trendyol', {...query, preview: true}, fetcher, importer);
  assert.equal(goruntu(), oncesi, 'önizleme hiçbir satır yazmamalı');
  assert.equal(aktarim, 0, 'önizlemede taslak aktarımı hiç çağrılmaz');
  assert.equal(onizleme.alreadyKnownOrders, 1);
  assert.equal(onizleme.importableOrders, 1);

  const gercek = await syncProvider(f.env, 'trendyol', query, fetcher, importer);
  assert.equal(gercek.alreadyKnownOrders, onizleme.alreadyKnownOrders, 'sayı önizlemeyle gerçek senkronda aynı olmalı');
  assert.equal(gercek.importableOrders, onizleme.importableOrders);
 } finally { f.sqlite.close(); }
});
