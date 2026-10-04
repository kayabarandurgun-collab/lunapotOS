import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {appFixture} from './helpers/app-fixture.js';
import {findPlaywright} from '../scripts/design-audit.mjs';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {xlsxBytes} from '../public/doc-engine.js';

const enabled=process.env.WORKBENCH_BROWSER==='1';
const sep=()=>process.platform==='win32'?'\\':'/';

// Belge yükle ekranının amacı: kullanıcı sağa sola gitmeden hepsini tek yere bırakır.
// Bu test o sözü ölçer — Trendyol raporu, Hepsiburada raporu ve bir alış faturası AYNI
// anda bırakılır; her dosya kendi türüyle tanınmalı ve kendi ekranında işlenmeli.
test('Belge yükle: TY raporu, HB raporu ve alış faturası birlikte bırakılır, her biri doğru yere gider',{skip:!enabled,timeout:180000},async()=>{
 const f=appFixture();await f.setup();
 const owner={id:'owner',name:'Yönetici',owner:true},root=resolve('public');
 const fetchOriginal=globalThis.fetch;globalThis.fetch=async()=>{throw Error('COKLU_TEST_EXTERNAL_NETWORK_BLOCKED');};
 let server,browser;
 const errors=[];
 try{
  // İki pazaryeri, iki mağaza. Sütun imzaları AYRI ki mağaza tanıma her dosyayı ayırsın.
  const tyStore=(await f.ok('/ec/reports/stores',{provider:'trendyol',code:'TY-1',name:'Trendyol mağazam'})).id;
  const hbStore=(await f.ok('/ec/reports/stores',{provider:'hepsiburada',code:'HB-1',name:'Hepsiburada mağazam'})).id;
  const tyCols=['Sipariş No','Paket No','Kalem No','Barkod','Ürün','Adet','Durum','Sipariş Tarihi','Tutar'];
  const hbCols=['HB Sipariş Numarası','HB Paket Numarası','HB Kalem Numarası','HB Barkod','HB Ürün Adı','HB Miktar','HB Kargo Durumu','HB Sipariş Zamanı','HB Birim Fiyat'];
  const mapping=c=>({order_no:c[0],package_id:c[1],line_id:c[2],barcode:c[3],product_name:c[4],quantity:c[5],status:c[6],order_date:c[7],gross:c[8]});
  await f.ok('/ec/reports/profiles',{provider:'trendyol',kind:'orders',headers:tyCols,mapping:mapping(tyCols),options:{}});
  await f.ok('/ec/reports/profiles',{provider:'hepsiburada',kind:'orders',headers:hbCols,mapping:mapping(hbCols),options:{}});

  const sheet=(cols,row)=>Buffer.from(xlsxBytes([{name:'Rapor',columns:cols.map(header=>({header})),rows:[row]}]));
  const tyBytes=sheet(tyCols,['TY-ORDER','TY-PKG','TY-LINE','TYBARKOD','Trendyol ürünü',1,'Kargoda','01.09.2026','120,00']);
  const hbBytes=sheet(hbCols,['HB-ORDER','HB-PKG','HB-LINE','HBBARKOD','Hepsiburada ürünü',1,'Kargoda','02.09.2026','90,00']);
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Alis faturasi ornegi',{x:40,y:750,size:15,font});
  const pdfBytes=Buffer.from(await pdf.save({useObjectStreams:false}));

  let serial=Promise.resolve();
  server=createServer((req,res)=>{
   const next=serial.then(async()=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
     res.end('<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace-design.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/report-inbox.css"><link rel="stylesheet" href="/purchase-document.css"><style>body{margin:0;font-family:Arial,sans-serif}button,input,select{font:inherit}</style><main id="root"></main><script type="module">import{mountWorkbench}from"/workbench-ui.js";window.disposeWorkbench=mountWorkbench(document.querySelector("#root"),"ec",'+JSON.stringify(owner)+',"intake");</script></html>');return;
    }
    if(url.pathname.startsWith('/api/')){
     const chunks=[];for await(const chunk of req)chunks.push(chunk);
     const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
     const r=await f.req(url.pathname.slice(4)+url.search,input);
     res.writeHead(r.status,{'Content-Type':'application/json'});res.end(JSON.stringify(r.data));return;
    }
    const file=resolve(root,'.'+url.pathname);
    if(!file.startsWith(root+sep())){res.writeHead(403);res.end();return;}
    try{const bytes=readFileSync(file),type=({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.ttf':'font/ttf'})[extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);}
    catch{res.writeHead(404);res.end();}
   });
   serial=next.catch(error=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const {api}=await findPlaywright();assert.ok(api,'WORKBENCH_BROWSER=1 için kurulu Playwright gerekir.');
  browser=await api.chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');
  await page.locator('[data-wb-file]').waitFor();

  // Çoklu seçim gerçekten açık olmalı; yoksa kullanıcı tek tek yüklemeye mahkûm kalır.
  assert.equal(await page.locator('[data-wb-file]').getAttribute('multiple'),'');

  // ÜÇÜ BİRLİKTE.
  await page.locator('[data-wb-file]').setInputFiles([
   {name:'ty-siparis.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:tyBytes},
   {name:'hb-siparis.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:hbBytes},
   {name:'alis-fatura.pdf',mimeType:'application/pdf',buffer:pdfBytes},
  ]);

  // Her dosya ayrı tanınmış ve listede durumu yazıyor olmalı.
  await page.waitForFunction(()=>document.querySelectorAll('.wb-picked li').length===3);
  const satirlar=await page.locator('.wb-picked li').allInnerTexts();
  assert.equal(satirlar.length,3);
  assert.match(satirlar.join(' | '),/ty-siparis\.xlsx/);
  assert.match(satirlar.join(' | '),/hb-siparis\.xlsx/);
  assert.match(satirlar.join(' | '),/alis-fatura\.pdf/);
  assert.equal(satirlar.filter(t=>/Sipariş raporu/.test(t)).length,2,'iki dosya sipariş raporu olarak tanınmalı');
  assert.equal(satirlar.filter(t=>/Alış faturası/.test(t)).length,1,'bir dosya alış faturası olarak tanınmalı');
  assert.equal(await page.locator('.wb-picked li.is-error').count(),0,'hiçbir dosya tanınamadı hatası vermemeli');

  // İki hedef ekran => iki devam düğmesi. Raporlar tek grupta, fatura ayrı.
  assert.equal(await page.locator('[data-wb-action="continue"]').count(),2);
  assert.equal(await page.locator('[data-wb-action="continue"][data-group="report"]').count(),1);
  assert.equal(await page.locator('[data-wb-action="continue"][data-group="invoice:pdf"]').count(),1);

  // 1) İKİ RAPOR tek seferde rapor ekranına gider ve her biri KENDİ mağazasına ayrılır.
  await page.locator('[data-wb-action="continue"][data-group="report"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'),null,{timeout:60000});
  await page.waitForFunction(()=>/ty-siparis\.xlsx/.test(document.body.textContent||'')&&/hb-siparis\.xlsx/.test(document.body.textContent||''),null,{timeout:60000});
  const ekran=await page.locator('[data-wb-child]').innerText();
  assert.match(ekran,/ty-siparis\.xlsx/,'TY raporu rapor ekranına ulaşmalı');
  assert.match(ekran,/hb-siparis\.xlsx/,'HB raporu da AYNI devirde ulaşmalı — biri düşmemeli');
  assert.match(ekran,/Trendyol mağazam/,'TY dosyası Trendyol mağazasına ayrılmalı');
  assert.match(ekran,/Hepsiburada mağazam/,'HB dosyası Hepsiburada mağazasına ayrılmalı');
  assert.notEqual(tyStore,hbStore);

  // 2) Geri dönünce FATURA hâlâ bekliyor olmalı; parti kaybolmamalı.
  await page.locator('[data-wb-action="close-source"]').click();
  await page.locator('[data-wb-file]').waitFor();
  assert.equal(await page.locator('[data-wb-action="continue"]').count(),1,'raporlar bitti, yalnız fatura kalmalı');
  assert.equal(await page.locator('[data-wb-action="continue"][data-group="invoice:pdf"]').count(),1);
  assert.equal(await page.locator('.wb-picked li.is-done').count(),2,'aktarılan iki rapor işaretli kalmalı');

  // 3) Fatura kendi ekranında işlenir ve bayt bayt saklanır.
  await page.locator('[data-wb-action="continue"][data-group="invoice:pdf"]').click();
  await page.locator('[data-pd-form="document"]').waitFor({timeout:60000});
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'),null,{timeout:60000});
  const doc=f.sqlite.prepare("SELECT * FROM ec_purchase_documents WHERE filename='alis-fatura.pdf'").get();
  assert.ok(doc,'alış faturası saklanmalı');assert.equal(doc.status,'stored');
  const stored=f.sqlite.prepare('SELECT data_b64 FROM ec_purchase_document_chunks WHERE document_id=? ORDER BY idx').all(doc.id);
  assert.deepEqual(Buffer.concat(stored.map(c=>Buffer.from(c.data_b64,'base64'))),pdfBytes,'seçilen dosya bayt bayt ulaşmalı');

  assert.equal(await page.locator('[data-wb-message].is-error').count(),0);
  assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(r=>server.close(r));
  globalThis.fetch=fetchOriginal;f.close();
 }
});
