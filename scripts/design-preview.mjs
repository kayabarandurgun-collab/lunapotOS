#!/usr/bin/env node
/** Local synthetic preview. No credentials, remote D1, provider or mail bindings. */
import {createServer} from 'node:http';
import {createServer as createSecureServer} from 'node:https';
import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {appFixture} from '../tests/helpers/app-fixture.js';
import worker from '../src/worker.js';
import {modules} from '../public/permissions.js';
import {LEGAL_VERSION} from '../src/webshop-legal.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');
const PASSWORD = 'synthetic-owner-password';
const CUSTOMER_PASSWORD = 'synthetic-customer-password';
const STAFF_PASSWORD = 'synthetic-reader-password';
const HOST = '127.0.0.1';
const SCENARIOS = ['populated', 'missing', 'empty'];
const ROLES = ['owner', 'reader', 'customer', 'anonymous'];
const today = () => new Date().toLocaleDateString('sv-SE', {timeZone:'Europe/Istanbul'});
const day = offset => new Date(Date.parse(today()) + offset * 86400000).toISOString().slice(0,10);
const insert = (f, table, record) => {
  const keys = Object.keys(record);
  f.sqlite.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(record));
};
const cookiePair = response => response.headers.get('set-cookie')?.split(';')[0] || '';

async function call(f, path, body, cookie = f.ownerCookie) {
  const response = await worker.fetch(new Request('http://127.0.0.1/api' + path, {
    method:body === undefined ? 'GET' : 'POST',
    headers:{Origin:'http://127.0.0.1', 'Content-Type':'application/json', Cookie:cookie || ''},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})
  }), f.env);
  const data = await response.json();
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status} ${JSON.stringify(data)}`);
  return {data, cookie:cookiePair(response)};
}

async function seedCommerce(f, missing) {
  const names = [
    'Lunapot profesyonel iç mekân bitkileri için perlit katkılı doğal torf 20 litre — uzun ürün adı',
    'Orkide bakım karışımı çam kabuğu ve ponza seti 10 litre',
    'Nova kendinden sulamalı saksı — adaçayı yeşili büyük boy',
    'Luna masaüstü saksı — kırık beyaz ve doğal ahşap taban',
    'Hassas köklü bitkiler için ince taneli perlit 5 litre',
    'KDV profili eksik örnek ürün — kontrol bekliyor'
  ];
  f.products = [];
  for (const [i,name] of names.entries()) {
    const id = `preview-product-${i+1}`;
    insert(f,'ec_products',{id,name,sku:`DEMO-${i+1}`,category:i<2?'Toprak ve karışımlar':'Saksı ve bakım',sale_price:240+i*80,stock_unit:'adet',min_stock_milli:10000,brand:'Lunapot — sentetik'});
    if (i !== 5) insert(f,'ec_price_profiles',{product_id:id,vat_bps:2000,replacement_cost_cents:6400+i*1100,packaging_cents:750,other_cents:200,withholding_bps:100,length_mm:180,width_mm:180,height_mm:240,weight_grams:1200,units_per_parcel:1});
    f.products.push({id,name});
  }
  // Real ledger opening movements; balances and FIFO follow the application's API.
  for (const [i,p] of f.products.entries()) await f.ok('/ec/stock',{product_id:p.id,kind:'opening',quantity:120+i*10,unit_cost:64+i*11,reference:`SENTETIK-ACILIS-${i}`,occurred_on:day(-120),notes:'Yerel önizleme; gerçek stok değildir.'});
  for (const channel of ['trendyol','hepsiburada']) {
    insert(f,'ec_report_stores',{id:`preview-${channel}`,provider:channel,code:channel==='trendyol'?'TY':'HB',name:`Sentetik ${channel} mağazası`});
    insert(f,'ec_report_profiles',{id:`preview-profile-${channel}`,provider:channel,kind:'finance',signature:`preview-${channel}`,version:1,mapping_json:'{}',options_json:JSON.stringify({fee_amounts_include_vat:true,fee_vat_bps:2000}),created_by:'local-preview'});
  }
  const supplier = await f.ok('/ec/suppliers',{name:'Örnek Bahçe Ürünleri — sentetik tedarikçi',email:'tedarikci@example.test',contact:'Yerel test kaydı'});
  const invoice = await f.ok('/ec/invoices',{supplier_id:supplier.id,invoice_no:'SENTETIK-ALIS-2026-001',invoice_date:day(-3),currency:'TRY',notes:'Gerçek belge değildir.',lines:f.products.slice(0,3).map((p,i)=>({description:p.name,product_id:p.id,invoice_quantity:20,invoice_unit:'adet',stock_quantity:20,net:1800+i*400,tax:360+i*80}))});
  await f.ok(`/ec/invoices/${invoice.id}/post`,{});
  const detail = await f.ok(`/ec/invoices/${invoice.id}`);
  await f.ok(`/ec/invoices/${invoice.id}/receive`,{reference:'SENTETIK-KISMI-TESLIM',occurred_on:day(-2),lines:detail.lines.map(l=>({id:l.id,quantity:10}))});
  f.invoiceId = invoice.id;
  // Same package/component model as tests/panorama.test.js. Deliberately includes losses.
  for (let i=0;i<36;i++) {
    const pending = i>=28, incomplete = missing ? i%3===0 : i===26;
    const p=f.products[i%5], id=`preview-package-${String(i+1).padStart(3,'0')}`;
    const occurred=day(pending ? -(i===35?45:(i-28)) : -[0,0,1,2,3,5,6,7,9,12,13,14,18,21,25,29,30,40,60,90,100,4,8,15,22,0,2,6][i]);
    const revenue=i%7===0?6000:18000+(i%5)*5700;
    const cost=6400+(i%5)*1100;
    const channel=i%2?'hepsiburada':'trendyol';
    insert(f,'ec_order_packages',{id,channel,external_id:`SENTETIK-PAKET-${i+1}`,order_no:`SENTETIK-${channel==='trendyol'?'TY':'HB'}-${1000+i}`,occurred_on:occurred,status:'draft',source_fingerprint:`synthetic-${i}`});
    insert(f,'ec_order_lines',{id:`line-${id}`,package_id:id,external_id:`LINE-${i}`,sku:`DEMO-${i%5+1}`,name:p.name,quantity_milli:1000,net_revenue_cents:revenue,gross_cents:Math.round(revenue*1.2),vat_bps:2000});
    insert(f,'ec_sale_entries',{id:`sale-${id}`,channel,external_id:`SYNTHETIC-${i}`,product_id:p.id,kind:'sale',quantity_milli:1000,revenue_cents:revenue,cost_cents:cost,commission_cents:incomplete?null:Math.round(revenue*.14),shipping_cents:incomplete?null:3100,other_cents:incomplete?null:600,fees_status:incomplete?'pending':'confirmed',occurred_on:occurred,notes:'Sentetik tasarım doğrulaması'});
    insert(f,'ec_order_line_components',{id:`component-${id}`,line_id:`line-${id}`,product_id:p.id,quantity_milli:1000,revenue_share_bps:10000,sale_id:`sale-${id}`,stock_unit:'adet'});
    f.sqlite.prepare("UPDATE ec_order_packages SET status='reserved' WHERE id=?").run(id);
    f.sqlite.prepare("UPDATE ec_order_packages SET status='shipped',shipped_on=? WHERE id=?").run(occurred,id);
    if (!pending) f.sqlite.prepare("UPDATE ec_order_packages SET status='delivered',delivered_on=? WHERE id=?").run(occurred,id);
  }
  await seedSoldOfferings(f);
  seedReportEvidence(f);
  if (missing) {
    f.sqlite.exec("UPDATE workspace_settings SET allow_negative_stock=1 WHERE workspace='ec'");
    f.sqlite.exec("UPDATE ec_order_packages SET source_changed=1 WHERE id IN ('preview-package-001','preview-package-030')");
    // A changed source yields unknown economic results; it must never become zero.
    // A missing VAT profile and a negative snapshot exercise inventory caveats.
    // This is fixture-only data; production code and ledger rules are untouched.
    f.sqlite.prepare('UPDATE ec_stock_balances SET quantity_milli=-2000,value_cents=0 WHERE product_id=?').run(f.products[5].id);
  }
}


function seedReportEvidence(f) {
  for(const [i,channel] of ['trendyol','hepsiburada'].entries()){
    const file='preview-finance-evidence-'+channel;
    insert(f,'ec_report_files',{id:file,store_id:'preview-'+channel,kind:'finance',filename:'SENTETIK-HAKEDIS-'+channel+'.xlsx',size_bytes:20,sha256:String(i+7).repeat(64),snapshot_at:today()+'T10:00:00Z',headers_json:'[]',row_count:6,chunk_count:1,status:'applied',profile_id:'preview-profile-'+channel});
    const add=(key,row_no,data)=>insert(f,'ec_report_records',{id:file+'-'+key,store_id:'preview-'+channel,kind:'finance_event',record_key:'SENTETIK-'+key,key_source:'provider',file_id:file,row_no,data_json:JSON.stringify(data)});
    const common={order_no:'SENTETIK-BILDIRIM-1',package_id:'SENTETIK-P1',event_id:'SENTETIK-F1',event_date:channel==='trendyol'?day(-2):null,net_payout:20000};
    add('sale',1,{...common,type:'sale',amount_cents:25000});add('commission',1,{...common,type:'commission',amount_cents:-4000});add('service',1,{...common,type:'service',amount_cents:-1000});
    add('undated',2,{order_no:'SENTETIK-TARIHSIZ',package_id:'SENTETIK-P2',event_id:'SENTETIK-F2',event_date:null,type:'refund',amount_cents:-3000,net_payout:9000});
    add('scope1',3,{order_no:'SENTETIK-KAPSAM-KONTROL',package_id:'SENTETIK-P3',event_id:'SENTETIK-F3',event_date:day(-1),type:'sale',amount_cents:14000,net_payout:10000});
    add('scope2',4,{order_no:'SENTETIK-KAPSAM-KONTROL',package_id:'SENTETIK-P4',event_id:'SENTETIK-F4',event_date:day(-1),type:'sale',amount_cents:15000,net_payout:11000});
    add('missing',5,{order_no:'SENTETIK-NET-EKSIK',event_id:'SENTETIK-F5',event_date:day(-3),type:'sale',amount_cents:10000,net_payout:null});
    add('unreferenced',6,{event_id:'SENTETIK-F6',event_date:day(-3),type:'payout',amount_cents:15000,net_payout:15000});
  }
}

async function seedSoldOfferings(f) {
  const items=[['preview-soil-3','Orkide toprağı 3 litre',20],['preview-food-225','Orkide bitki besini 225 ml',21],['preview-cleaner-250','Yaprak temizleyici 250 ml',25]];
  for(const [id,name,cost] of items){
    insert(f,'ec_products',{id,name,sku:id,category:'Bitki bakımı',brand:'Lunapot — sentetik',stock_unit:'adet',min_stock_milli:5000,sale_price:cost*3});
    insert(f,'ec_price_profiles',{product_id:id,vat_bps:2000,replacement_cost_cents:cost*100,packaging_cents:0,other_cents:0,withholding_bps:0,length_mm:150,width_mm:150,height_mm:200,weight_grams:500,units_per_parcel:1});
    await f.ok('/ec/stock',{product_id:id,kind:'opening',quantity:80,unit_cost:cost,reference:'SENTETIK-'+id,occurred_on:day(-40),notes:'Sadece yerel set doğrulaması'});
  }
  const bundle=await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'DEMO-ORCHID-KIT',external_name:'Orkide bakım seti · 3 ürün',components:items.map(([id],i)=>({product_id:id,quantity_milli:1000,revenue_share_bps:i===2?3334:3333}))});
  const multi=await f.ok('/ec/catalog/mappings',{source:'trendyol',external_code:'DEMO-FOOD-4',external_name:'Orkide besini · 4lü paket',components:[{product_id:items[1][0],quantity_milli:4000,revenue_share_bps:10000}]});
  const cases=[['set-1','delivered',bundle.id,'DEMO-ORCHID-KIT','Orkide bakım seti · 3 ürün',299],['set-2','delivered',bundle.id,'DEMO-ORCHID-KIT','Orkide bakım seti · 3 ürün',125],['set-extra','delivered',bundle.id,'DEMO-ORCHID-KIT','Orkide bakım seti · 3 ürün',310],['set-shipped','shipped',bundle.id,'DEMO-ORCHID-KIT','Orkide bakım seti · 3 ürün',299],['set-preparing','reserved',bundle.id,'DEMO-ORCHID-KIT','Orkide bakım seti · 3 ürün',299],['four','delivered',multi.id,'DEMO-FOOD-4','Orkide besini · 4lü paket',240],['four-return','returned',multi.id,'DEMO-FOOD-4','Orkide besini · 4lü paket',240]];
  for(const [ref,state,mapping_id,sku,name,gross] of cases){
    const lines=[{external_id:'line-'+ref,mapping_id,sku,name,quantity:1,gross,vat_rate:20}];
    if(ref==='set-extra')lines.push({external_id:'extra-'+ref,product_id:items[1][0],sku:items[1][0],name:items[1][1],quantity:1,gross:75,vat_rate:20});
    const pkg=await f.ok('/ec/orders',{channel:'trendyol',external_id:'SENTETIK-'+ref,order_no:'SENTETIK-'+ref,occurred_on:day(-4),lines});
    await f.ok('/ec/orders/'+pkg.id+'/reserve',{});if(state==='reserved')continue;
    await f.ok('/ec/orders/'+pkg.id+'/ship',{occurred_on:day(-3),reference:'SENTETIK-SEVK-'+ref});
    const sales=f.sqlite.prepare('SELECT s.* FROM ec_sale_entries s JOIN ec_order_line_components c ON c.sale_id=s.id JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?').all(pkg.id);
    const sum=sales.reduce((t,x)=>t+x.revenue_cents,0);
    let shipping=5000,service=1000;
    for(const [i,sale] of sales.entries()){
      const ship=i===sales.length-1?shipping:Math.round(5000*sale.revenue_cents/sum),other=i===sales.length-1?service:Math.round(1000*sale.revenue_cents/sum);shipping-=ship;service-=other;
      await f.ok('/ec/sales/'+sale.id+'/fees',{commission:Math.round(sale.revenue_cents*.15)/100,shipping:ship/100,other:other/100,fees_status:'confirmed'});
      if(state==='returned')await f.ok('/ec/sales/'+sale.id+'/return',{external_id:'SENTETIK-IADE-'+sale.id,quantity:sale.quantity_milli/1000,revenue:sale.revenue_cents/100,restock:true,commission:0,shipping:0,other:0,fees_status:'confirmed',occurred_on:day(-1),notes:'Paket teslim edilemedi; ürün depoya döndü. Yerel sentetik örnek.'});
    }
    if(state==='delivered')await f.ok('/ec/orders/'+pkg.id+'/deliver',{occurred_on:day(-2)});
  }
}

async function seedProduction(f) {
  const products=[];
  for (const [i,name] of ['Nova büyük boy kendinden sulamalı saksı — orman yeşili uzun ürün adı','Luna seramik görünümlü masaüstü saksı — kırık beyaz','Nova mini saksı — reçete hazırlığı bekliyor'].entries()) products.push((await f.ok('/products',{name,sku:`LP-DEMO-${i+1}`,category:'Saksı',sale_price:490+i*150})).id);
  const materials=[];
  for (const [i,name] of ['Mineral döküm karışımı','Su bazlı bağlayıcı','Adaçayı pigmenti','Koruyucu kraft ambalaj'].entries()) {
    const unit=i===2?'g':i===3?'adet':'kg';
    const m=await f.ok('/materials',{name,unit,price:[48,110,2,14][i],supplier:'Sentetik üretim tedarikçisi'});
    await f.ok('/lp/production/material-stock',{material_id:m.id,kind:'opening',quantity:[85,30,800,250][i],unit_cost:[48,110,2,14][i],reference:`SENTETIK-HAM-${i}`,occurred_on:day(-20),notes:'Yerel sentetik hammadde açılışı'});
    materials.push({id:m.id,unit});
  }
  for (let i=0;i<2;i++) {
    const recipe=await f.ok('/recipes',{product_id:products[i],yield_qty:10,waste_pct:3,labor:180,packaging:140,overhead:60,notes:'Sentetik reçete; test için düzenlenebilir.',items:[{material_id:materials[0].id,quantity:3+i,unit:'kg'},{material_id:materials[1].id,quantity:1,unit:'kg'},{material_id:materials[2].id,quantity:25,unit:'g'}]});
    const job=await f.ok('/lp/production/jobs',{recipe_id:recipe.id,quantity:10,labor:180,packaging:140,overhead:60,reference:`SENTETIK-URETIM-${i+1}`,occurred_on:day(-2+i),notes:'Gerçek üretim değildir.',create_lot:true,lot_code:`DEMO-LOT-${i+1}`,items:[{material_id:materials[0].id,quantity:3.1+i},{material_id:materials[1].id,quantity:1.03},{material_id:materials[2].id,quantity:26}]});
    f.productionJobId ||= job.id;
  }
}

async function seedStaff(f) {
  const permissions=Object.fromEntries(['ec','lp'].map(ns=>[ns,Object.fromEntries(Object.keys(modules[ns]).map(key=>[key,key==='amounts'?'none':'read']))]));
  const invite=await f.ok('/admin/users',{username:'preview.reader',name:'Deniz Örnek — tutar görmeyen ekip üyesi',permissions});
  const token=new URL(invite.invite_path,'http://127.0.0.1').hash.slice(1).split('=')[1];
  await call(f,'/auth/accept-invite',{token,password:STAFF_PASSWORD},'');
  f.readerCookie=(await call(f,'/auth/login',{username:'preview.reader',password:STAFF_PASSWORD},'')).cookie;
  await f.ok('/admin/users',{username:'preview.invited',name:'Ece Örnek — davet bekliyor',permissions});
}

async function seedStore(f, empty) {
  const registration=await call(f,'/store/auth/register',{email:'musteri@example.test',name:'Ada Örnek — sentetik müşteri',password:CUSTOMER_PASSWORD,terms_version:LEGAL_VERSION},'');
  f.customerCookie=registration.cookie;
  if (empty) return;
  // Read the existing local demo cards as data; never evaluate browser source.
  const shopSource=await readFile(resolve(PUBLIC,'magaza/shop.js'),'utf8');
  for (const [object] of shopSource.matchAll(/\{id:'[^']+'[^{}]*\}/g)) {
    const field=key=>object.match(new RegExp(key+":'([^']*)'"))?.[1];
    const product=field('id'), name=field('name'), category=field('category'), image=field('image');
    const price=Number(object.match(/price:(\d+(?:\.\d+)?)/)?.[1]);
    if(!product||!name||!image||!Number.isFinite(price)) continue;
    for(const size of category==='toprak'?['Standart']:['Küçük','Büyük']) insert(f,'ws_catalog',{id:product+'-'+({'Standart':'standart','Küçük':'kucuk','Büyük':'buyuk'}[size]),product_id:product,name,size,image,category,price_cents:Math.round(price*(size==='Büyük'?1.5:1)*100),stock:24,active:1});
  }
  await call(f,'/store/catalog');
  const variants=f.sqlite.prepare('SELECT * FROM ws_catalog WHERE active=1 ORDER BY id').all();
  if (!variants.length) throw new Error('The demo catalog did not initialize.');
  f.sqlite.exec('UPDATE ws_catalog SET stock=24');
  for (let i=0;i<4;i++) {
    const variant=variants[i%variants.length];
    const q=(await call(f,'/store/quote',{items:[{variant_id:variant.id,qty:i===1?2:1}],address:{name:'Ada Örnek',phone:'05000000000',city:'İstanbul',district:'Örnek ilçe',line:'Sentetik Sokak No: 1 — gerçek teslimat adresi değildir'},same_billing:true},f.customerCookie)).data;
    const order=(await call(f,'/store/orders',{quote_id:q.id,legal_version:LEGAL_VERSION,preinformation:true,contract:true},f.customerCookie)).data;
    f.webOrderId ||= order.id;
    if (i>0) {
      await call(f,`/store/orders/${order.id}/demo-payment`,{outcome:'success'},f.customerCookie);
      await call(f,`/webshop/orders/${order.id}`,{status:'preparing'});
      if (i>1) await call(f,`/webshop/orders/${order.id}`,{status:'shipped',carrier:'Sentetik Kargo',tracking:`DEMO-TAKIP-${i}`});
      if (i>2) await call(f,`/webshop/orders/${order.id}`,{status:'delivered'});
    }
  }
  await call(f,'/store/requests',{kind:'support',order_id:f.webOrderId,message:'Sentetik müşteri talebi: uzun ürün adı ve teslimat durumunu kontrol etmek istiyorum.'},f.customerCookie);
}

async function createFixture(scenario) {
  const f=appFixture();
  try {
    f.env.WS_MODE='demo';
    await f.setup();
    f.ownerCookie=(await f.req('/auth/login',{password:PASSWORD})).cookie;
    if (!f.ownerCookie) throw new Error('Preview owner authentication failed.');
    if (scenario!=='empty') {await seedCommerce(f,scenario==='missing');await seedProduction(f);}
    await seedStaff(f);
    await seedStore(f,scenario==='empty');
    f.env.ASSETS={fetch:assets};
    return f;
  } catch(error) {f.close();throw error;}
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.mp4':'video/mp4','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8'};
async function assets(request) {
  const pathname=decodeURIComponent(new URL(request.url).pathname);
  const candidate=resolve(PUBLIC,'.'+pathname);
  for (const file of [candidate, candidate+'.html',resolve(candidate,'index.html')]) {
    const rel=relative(PUBLIC,file);
    if (rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel)) continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      const actual=await realpath(file), actualRel=relative(await realpath(PUBLIC),actual);
      if (actualRel.startsWith('..'+sep)||actualRel==='..'||isAbsolute(actualRel)) continue;
      return new Response(await readFile(file),{headers:{'Content-Type':MIME[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}});
    } catch(error) {if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;}
  }
  return new Response('Yerel dosya bulunamadı.',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
}

export async function previewPages() {
  const pages=['/','/uretim/','/eticaret/','/webmagaza/','/access'];
  for (const [source,marker,prefix] of [['app.js','titles','/uretim/'],['ecommerce.js','views','/eticaret/']]) {
    const content=await readFile(resolve(PUBLIC,source),'utf8');
    const block=content.match(new RegExp('const\\s+'+marker+'\\s*=\\s*\\{([^}]+)\\}'))?.[1]||'';
    for (const m of block.matchAll(/(?:^|,)\s*([\w]+)\s*:/g)) pages.push(prefix+'#'+m[1]);
  }
  const ws=await readFile(resolve(PUBLIC,'webshop.js'),'utf8');
  for (const match of ws.matchAll(/view\s*===\s*['"]([\w-]+)['"]/g)) pages.push('/webmagaza/#'+match[1]);
  for (const file of await readdir(resolve(PUBLIC,'magaza'))) if(file.endsWith('.html')) pages.push('/magaza/'+(file==='index.html'?'':file));
  return [...new Set(pages)];
}

export async function startPreview({port=8790,scenario='populated',tls=null}={}) {
  if (!SCENARIOS.includes(scenario)) throw new Error('Unknown preview scenario.');
  if (!Number.isInteger(port)||port<0||port>65535) throw new Error('Invalid port.');
  const protocol=tls?'https':'http';
  const serverFactory=tls?handler=>createSecureServer(tls,handler):createServer;
  // Worker provider calls use fetch. Deny even loopback egress from the worker process.
  const originalFetch=globalThis.fetch;
  const blockedFetch=async()=>{throw new Error('LOCAL_PREVIEW_NETWORK_DISABLED');};
  globalThis.fetch=blockedFetch;
  const fixtures=new Map();
  async function fixture(name) {
    if (!fixtures.has(name)) fixtures.set(name,createFixture(name));
    return fixtures.get(name);
  }
  let server;
  try {
    await fixture(scenario);
    let serial=Promise.resolve();
    server=serverFactory((req,res)=>{
      const job=serial.then(()=>handle(req,res));
      serial=job.catch(()=>{});
      job.catch(error=>{console.error(error);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Local preview failure',detail:error.message}));});
    });
    async function handle(req,res) {
      const origin=`${protocol}://${HOST}:${server.address().port}`;
      if (req.headers.host!==`${HOST}:${server.address().port}`) {res.writeHead(403);res.end('Loopback Host required.');return;}
      if (req.headers.origin&&req.headers.origin!==origin) {res.writeHead(403);res.end('Same-origin preview only.');return;}
      const url=new URL(req.url,origin);
      if(url.origin!==origin) {res.writeHead(403);res.end();return;}
      const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(p=>p.trim().split(/=(.*)/s).slice(0,2)).filter(p=>p[0]));
      const selected=SCENARIOS.includes(cookies.preview_scenario)?cookies.preview_scenario:scenario;
      if(url.pathname==='/__preview/health') {
        const f=await fixture(selected);
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({local_preview:true,synthetic:true,origin,scenario:selected,today:today(),from:day(-120),scenarios:SCENARIOS,roles:ROLES,network:'blocked',worker:'src/worker.js',fixture:'tests/helpers/app-fixture.js',pages:await previewPages(),counts:{packages:f.sqlite.prepare('SELECT COUNT(*) n FROM ec_order_packages').get().n,delivered:f.sqlite.prepare("SELECT COUNT(*) n FROM ec_order_packages WHERE status='delivered'").get().n,pending:f.sqlite.prepare("SELECT COUNT(*) n FROM ec_order_packages WHERE status='shipped'").get().n,products:f.sqlite.prepare('SELECT COUNT(*) n FROM ec_products').get().n,webOrders:f.sqlite.prepare('SELECT COUNT(*) n FROM ws_orders').get().n},detail:{invoice:f.invoiceId,productionJob:f.productionJobId,webOrder:f.webOrderId}}));return;
      }
      if(url.pathname==='/__preview/start') {
        const name=url.searchParams.get('scenario')||scenario,role=url.searchParams.get('role')||'owner';
        if(!SCENARIOS.includes(name)||!ROLES.includes(role)) {res.writeHead(400);res.end('Invalid scenario or role.');return;}
        const next=new URL(url.searchParams.get('next')||'/',origin);
        if(next.origin!==origin||next.pathname.startsWith('/__preview/')) {res.writeHead(400);res.end('Local application path required.');return;}
        const f=await fixture(name);
        let auth=role==='owner'?f.ownerCookie:role==='reader'?f.readerCookie:'';
        if(auth&&!(await f.req('/auth/status',undefined,auth)).data.authenticated){
          const fresh=await f.req('/auth/login',{username:role==='reader'?'preview.reader':'',password:role==='reader'?STAFF_PASSWORD:PASSWORD},'');
          if(fresh.status!==200||!fresh.cookie)throw new Error('Synthetic preview session could not be renewed.');
          auth=fresh.cookie;if(role==='owner')f.ownerCookie=auth;else f.readerCookie=auth;
        }
        const customer=['owner','customer'].includes(role)?f.customerCookie:'';
        const setCookies=[`preview_scenario=${name}; Path=/; HttpOnly; SameSite=Strict`,`preview_role=${role}; Path=/; HttpOnly; SameSite=Strict`,`${auth||'lunapot_session='}; Path=/; HttpOnly; SameSite=Strict`,`${customer||'ws_customer='}; Path=/; HttpOnly; SameSite=Strict`];
        res.writeHead(302,{'Location':next.pathname+next.search+next.hash,'Set-Cookie':setCookies,'Cache-Control':'no-store'});res.end();return;
      }
      // First browser visit gets real, fixture-created owner and customer sessions.
      if(!cookies.preview_role&&!url.pathname.startsWith('/api/')) {
        res.writeHead(302,{Location:'/__preview/start?next='+encodeURIComponent(url.pathname+url.search),'Cache-Control':'no-store'});res.end();return;
      }
      const f=await fixture(selected);
      const chunks=[];let length=0;
      for await(const chunk of req) {length+=chunk.length;if(length>1100000){res.writeHead(413);res.end('Preview body too large.');return;}chunks.push(chunk);}
      const method=req.method||'GET';
      const headers=new Headers();
      for(const [key,value] of Object.entries(req.headers)) if(value!==undefined&&!['host','content-length','connection','transfer-encoding'].includes(key)) headers.set(key,Array.isArray(value)?value.join(', '):value);
      const response=await worker.fetch(new Request(url,{method,headers,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})}),f.env);
      const output=Object.fromEntries(response.headers);
      output['cache-control']='no-store';
      output['x-lunapot-preview']='synthetic-local-only';
      const setCookies=response.headers.getSetCookie();if(setCookies.length)output['set-cookie']=setCookies;
      res.writeHead(response.status,output);
      res.end(method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
    }
    await new Promise((yes,no)=>{server.once('error',no);server.listen(port,HOST,yes);});
    return {server,origin:`${protocol}://${HOST}:${server.address().port}`,async close(){await new Promise(done=>server.close(done));for(const pending of fixtures.values()){try{(await pending).close();}catch{}}if(globalThis.fetch===blockedFetch)globalThis.fetch=originalFetch;}};
  } catch(error) {for(const pending of fixtures.values()){try{(await pending).close();}catch{}}if(globalThis.fetch===blockedFetch)globalThis.fetch=originalFetch;throw error;}
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(args.includes('--help')) {
    console.log('Node 22.13+ (recommended 24). node scripts/design-preview.mjs [--port=8790] [--scenario=populated|missing|empty]\nAlways binds 127.0.0.1. Real worker, memory SQLite, synthetic sessions, no external network.');
  } else {
    const value=(key,fallback)=>args.find(a=>a.startsWith(key+'='))?.slice(key.length+1)||fallback;
    const key=value('--tls-key',''),cert=value('--tls-cert','');
    if(Boolean(key)!==Boolean(cert))throw new Error('Both local TLS key and certificate are required.');
    const tls=key?{key:await readFile(resolve(key)),cert:await readFile(resolve(cert))}:null;
    const preview=await startPreview({port:Number(value('--port','8790')),scenario:value('--scenario','populated'),tls});
    console.log(`LOCAL SYNTHETIC PREVIEW READY ${preview.origin}\nHealth: ${preview.origin}/__preview/health\nScenario: ${preview.origin}/__preview/start?scenario=missing\nEmpty: ${preview.origin}/__preview/start?scenario=empty\nReader: ${preview.origin}/__preview/start?role=reader\nAnonymous: ${preview.origin}/__preview/start?role=anonymous\nStop: Ctrl+C; restart resets all memory data. No live services are configured.`);
    let closing=false;
    const stop=async()=>{if(closing)return;closing=true;await preview.close();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }
}
