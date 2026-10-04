import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {appFixture} from './helpers/app-fixture.js';
import {findPlaywright} from '../scripts/design-audit.mjs';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {xlsxBytes} from '../public/doc-engine.js';

const enabled=process.env.WORKBENCH_BROWSER==='1';
test('real browser + worker + SQLite: retained files, source actions, task assignment and responsive disposal',{skip:!enabled,timeout:180000},async()=>{
 const f=appFixture();await f.setup();
 const owner={id:'owner',name:'Yönetici',owner:true},root=resolve('public');
 const fetchOriginal=globalThis.fetch;globalThis.fetch=async()=>{throw Error('WORKBENCH_TEST_EXTERNAL_NETWORK_BLOCKED');};
 let server,browser;
 const errors=[],requests=[];
 try{
  f.sqlite.exec("INSERT INTO staff_users(id,username,name,ec_access,lp_access) VALUES('wb-staff','wb-person','Ayşe','write','read')");
  const store=(await f.ok('/ec/reports/stores',{provider:'trendyol',code:'WB-1',name:'Deneme mağazası'})).id;
  const columns=[{header:'Sipariş No'},{header:'Paket No'},{header:'Kalem No'},{header:'Barkod'},{header:'Ürün'},{header:'Adet'},{header:'Durum'},{header:'Sipariş Tarihi'},{header:'Tutar'}];
  await f.ok('/ec/reports/profiles',{provider:'trendyol',kind:'orders',headers:columns.map(c=>c.header),mapping:{order_no:'Sipariş No',package_id:'Paket No',line_id:'Kalem No',barcode:'Barkod',product_name:'Ürün',quantity:'Adet',status:'Durum',order_date:'Sipariş Tarihi',gross:'Tutar'},options:{}});
  // A same-origin fixture UI mounts the real production module; API calls run the real worker.
  let serial=Promise.resolve();
  server=createServer((req,res)=>{
   const next=serial.then(async()=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){
     const ns=url.searchParams.get('ns')==='lp'?'lp':'ec',reader=url.searchParams.get('reader')==='1';
     const user=reader?{id:'wb-staff',name:'Ayşe',ec_access:'read',permissions:{ec:{invoices:'read',orders:'read',amounts:'read'}}}:owner;
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
     res.end('<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace-design.css"><link rel="stylesheet" href="/workbench.css"><link rel="stylesheet" href="/report-inbox.css"><link rel="stylesheet" href="/purchase-document.css"><style>body{margin:0;font-family:Arial,sans-serif}button,input,select{font:inherit}</style><main id="root"></main><script type="module">import{mountWorkbench}from"/workbench-ui.js";window.disposeWorkbench=mountWorkbench(document.querySelector("#root"),'+JSON.stringify(ns)+','+JSON.stringify(user)+',location.hash==="#intake"?"intake":"tasks");window.addEventListener("hashchange",()=>window.disposeWorkbench.onHash());</script></html>');return;
    }
    if(url.pathname.startsWith('/api/')){
     const chunks=[];for await(const chunk of req)chunks.push(chunk);
     const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
     requests.push({path:url.pathname,method:req.method,body:input});
     // Force the reports mount to be asynchronous so a drop on an unready root fails this test.
     if(url.pathname==='/api/ec/reports'&&req.method==='GET')await new Promise(r=>setTimeout(r,180));
     const r=await f.req(url.pathname.slice(4)+url.search,input);
     res.writeHead(r.status,{'Content-Type':'application/json'});res.end(JSON.stringify(r.data));return;
    }
    const file=resolve(root,'.'+url.pathname);
    if(!file.startsWith(root+requireSeparator())){res.writeHead(403);res.end();return;}
    try{const bytes=readFileSync(file),type=({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.ttf':'font/ttf'})[extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);}
    catch{res.writeHead(404);res.end();}
   });
   serial=next.catch(error=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const {api}=await findPlaywright();assert.ok(api,'Installed Playwright is required for WORKBENCH_BROWSER=1.');
  browser=await api.chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#intake');
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Invoice document example - no financial amounts',{x:40,y:750,size:15,font});
  const pdfBytes=Buffer.from(await pdf.save({useObjectStreams:false}));
  await page.locator('[data-wb-file]').setInputFiles({name:'original-invoice.pdf',mimeType:'application/pdf',buffer:pdfBytes});
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-pd-form="document"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'));
  const doc=f.sqlite.prepare("SELECT * FROM ec_purchase_documents WHERE filename='original-invoice.pdf'").get();
  assert.equal(doc.status,'stored');
  const stored=f.sqlite.prepare('SELECT data_b64 FROM ec_purchase_document_chunks WHERE document_id=? ORDER BY idx').all(doc.id);
  assert.deepEqual(Buffer.concat(stored.map(c=>Buffer.from(c.data_b64,'base64'))),pdfBytes,'chosen File reached existing storage byte-for-byte');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_purchase_invoices').get().n,0,'unreadable totals did not become a financial invoice');
  await page.locator('[data-wb-action="close-source"]').click();


  // XML uses the exact selected source bytes; image goes through the existing PDF/OCR path.
  const xmlBytes=Buffer.from('<Invoice><ID>WBXML-1</ID><IssueDate>2026-09-01</IssueDate><InvoiceTypeCode>SATIS</InvoiceTypeCode><DocumentCurrencyCode>TRY</DocumentCurrencyCode><InvoiceLine><InvoicedQuantity unitCode="adet">1</InvoicedQuantity><LineExtensionAmount>10</LineExtensionAmount><TaxTotal><TaxAmount>2</TaxAmount></TaxTotal><Item><Name>Kontrol bekleyen ürün</Name></Item></InvoiceLine><LegalMonetaryTotal><TaxExclusiveAmount>10</TaxExclusiveAmount><TaxInclusiveAmount>12</TaxInclusiveAmount></LegalMonetaryTotal></Invoice>');
  await page.locator('[data-wb-file]').setInputFiles({name:'retained-invoice.xml',mimeType:'application/xml',buffer:xmlBytes});
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-pd-form="document"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'));
  const xmlDoc=f.sqlite.prepare("SELECT id,status FROM ec_purchase_documents WHERE filename='retained-invoice.xml'").get();
  assert.equal(xmlDoc.status,'stored');assert.deepEqual(Buffer.from(f.sqlite.prepare('SELECT data_b64 FROM ec_purchase_document_chunks WHERE document_id=?').get(xmlDoc.id).data_b64,'base64'),xmlBytes);
  await page.locator('[data-wb-action="close-source"]').click();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.locator('[data-wb-file]').setInputFiles({name:'photo-invoice.png',mimeType:'image/png',buffer:png});
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-pd-form="document"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'));
  const imageDoc=f.sqlite.prepare("SELECT * FROM ec_purchase_documents WHERE filename='photo-invoice.pdf'").get();
  assert.equal(imageDoc.status,'stored');assert.equal(imageDoc.text_layer,0,'image does not pretend to contain known text');
  assert.match(Buffer.from(f.sqlite.prepare('SELECT data_b64 FROM ec_purchase_document_chunks WHERE document_id=?').get(imageDoc.id).data_b64,'base64').toString('latin1'),/EmbeddedFile/);
  await page.locator('[data-wb-action="close-source"]').click();

  // Real spreadsheet -> existing mapping/check step -> existing raw file/chunk/rows/seal endpoints.
  const reportBytes=Buffer.from(xlsxBytes([{name:'Rapor',columns,rows:[['WB-ORDER','WB-PKG','WB-LINE','MISSING','Deneme',1,'Kargoda','01.09.2026','120,00']]}]));
  await page.locator('[data-wb-file]').setInputFiles({name:'retained-report.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:reportBytes});
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-rb-act="upload"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-wb-handoff]')?.textContent.includes('seçilen işleme aktarıldı'));
  await page.locator('[data-rb-act="upload"]').click();
  await page.locator('[data-rb-act="apply"]').first().waitFor();
  const report=f.sqlite.prepare("SELECT * FROM ec_report_files WHERE filename='retained-report.xlsx'").get();
  assert.equal(report.status,'received');assert.equal(report.store_id,store);
  const reportStored=f.sqlite.prepare('SELECT data_b64 FROM ec_report_file_chunks WHERE file_id=? ORDER BY idx').all(report.id);
  assert.deepEqual(Buffer.concat(reportStored.map(c=>Buffer.from(c.data_b64,'base64'))),reportBytes);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_report_rows WHERE file_id=?').get(report.id).n,1);

  // Ambiguous CSV keeps the same file while the user explicitly chooses finance.
  await page.locator('[data-wb-action="close-source"]').click();
  await page.locator('[data-wb-file]').setInputFiles({name:'ambiguous.csv',mimeType:'text/csv',buffer:Buffer.from('Alan;Bilgi\nA;B')});
  await page.locator('[data-choice="orders"]').waitFor();
  assert.equal(await page.locator('[data-choice="orders"]').count(),1);
  await page.locator('[data-choice="finance"]').click();
  await page.locator('[data-rb-form="map"]').waitFor();
  assert.equal(await page.locator('[data-rb="kind"]').inputValue(),'finance');
  assert.match(await page.locator('[data-wb-child]').innerText(),/ambiguous.csv/);

  // Custom task persists actual staff choice and dates; reload renders from SQLite.
  await page.goto(base+'/#workbench');
  await page.locator('[data-wb-action="new"]').click();
  await page.locator('dialog [name="title"]').fill('Tedarikçiden belge iste');
  await page.locator('dialog [name="feature"]').selectOption('invoices');
  await page.locator('dialog [name="assignee_id"]').selectOption('wb-staff');
  await page.locator('dialog [name="due_on"]').fill('2026-11-06');
  await page.locator('dialog [type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('dialog')).catch(async error=>{console.error(await page.locator('dialog').innerText());throw error;});
  const task=f.sqlite.prepare("SELECT * FROM ec_workbench_tasks WHERE title='Tedarikçiden belge iste'").get();
  assert.equal(task.assignee_id,'wb-staff');assert.equal(task.assignee_name,'Ayşe');assert.equal(task.due_on,'2026-11-06');
  await page.reload();await page.getByText('Tedarikçiden belge iste',{exact:true}).waitFor();
  const source=page.locator('[data-wb-task="report_file:'+report.id+'"]');
  await source.locator('[data-wb-action="edit"]').click();
  assert.equal(await page.locator('dialog [name="status"] option[value="done"]').count(),0);
  await page.locator('[data-wb-action="cancel-edit"]').first().click();
  await source.locator('[data-wb-action="source"]').click();
  await page.locator('[data-wb-action="apply-report"]').waitFor();
  assert.equal(f.sqlite.prepare('SELECT status FROM ec_report_files WHERE id=?').get(report.id).status,'received','opening preview did not apply');
  await page.locator('[data-wb-action="apply-report"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-wb-child]'));
  assert.equal(f.sqlite.prepare('SELECT status FROM ec_report_files WHERE id=?').get(report.id).status,'applied','real existing report action executed');


  // A real review stays open until the embedded, existing review screen records a decision.
  f.sqlite.prepare("INSERT INTO ec_report_reviews(id,store_id,file_id,row_no,kind,record_key,reason,detail,incoming_json) VALUES('wb-review',?,?,1,'order_line','review-key','bad_value','Eksik kaynak alanı','{}')").run(store,report.id);
  await f.ok('/ec/workbench/tasks/report_review%3Awb-review',{version:0,status:'in_progress'});
  await page.locator('[data-wb-action="reload"]').click();
  await page.locator('[data-wb-task="report_review:wb-review"] [data-wb-action="source"]').click();
  await page.locator('[data-rb-act="reject"][data-id="wb-review"]').waitFor();
  assert.equal(f.sqlite.prepare("SELECT status FROM ec_report_reviews WHERE id='wb-review'").get().status,'open');
  await page.locator('[data-rb-act="reject"][data-id="wb-review"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-wb-child]')?.getAttribute('aria-busy')==='false');
  assert.equal(f.sqlite.prepare("SELECT status FROM ec_report_reviews WHERE id='wb-review'").get().status,'rejected');
  await page.locator('[data-wb-action="close-source"]').click();


  // Existing invoice review is embedded through its real search and review controls.
  f.sqlite.exec("INSERT INTO ec_suppliers(id,name) VALUES('wb-existing-supplier','Kontrol tedarikçisi'); INSERT INTO ec_purchase_invoices(id,supplier_id,invoice_no,invoice_date) VALUES('wb-existing-invoice','wb-existing-supplier','WB-EXISTING','2026-09-01')");
  await page.locator('[data-wb-action="reload"]').click();
  await page.locator('[data-wb-task="invoice_draft:wb-existing-invoice"] [data-wb-action="source"]').click();
  await page.locator('dialog').waitFor().catch(async e=>{console.error(await page.locator('[data-wb-child]').innerText());console.error(requests.slice(-8));throw e;});
  assert.match(await page.locator('dialog').innerText(),/WB-EXISTING/);
  await page.locator('dialog [data-ac="close"]').first().click();
  await page.locator('[data-wb-action="close-source"]').click();

  // Saved document survives refresh and resumes from server bytes without selecting again.
  await page.locator('[data-wb-task="invoice_document:'+doc.id+'"] [data-wb-action="source"]').click();
  await page.locator('[data-wb-action="continue"]').waitFor();
  assert.match(await page.locator('.wb-picked').innerText(),/original-invoice.pdf/);
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-pd-form="document"]').waitFor();
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_purchase_documents WHERE filename='original-invoice.pdf'").get().n,1,'resume uses existing dedupe/reread path');

  // Mobile and desktop layout; selected file data never enters browser persistent storage.
  await page.locator('.wb-heading-actions a[href="#workbench"]').click();await page.getByText('Tedarikçiden belge iste',{exact:true}).waitFor();
  mkdirSync('docs/system-upgrade-2026-10-04/workbench-artifacts',{recursive:true});
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:950});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow at '+width);
   await page.screenshot({path:'docs/system-upgrade-2026-10-04/workbench-artifacts/tasks-'+width+'.png',fullPage:true});
  }
  await page.goto(base+'/#intake');
  await page.locator('[data-wb-file]').waitFor();
  await page.screenshot({path:'docs/system-upgrade-2026-10-04/workbench-artifacts/intake-1440.png',fullPage:true});

  await page.locator('[data-wb-file]').setInputFiles({name:'cancelled-report.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:reportBytes});
  await page.locator('[data-wb-action="continue"]').click();
  await page.locator('[data-wb-action="close-source"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-wb-file]')?.disabled===false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ec_report_files WHERE filename='cancelled-report.xlsx'").get().n,0,'closing during mount does not upload the retained file');

  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
  await page.goto(base+'/?reader=1#workbench');
  await page.locator('.wb-summary').waitFor();
  assert.equal(await page.locator('.wb-heading-actions a[href="#intake"]').count(),0,'readonly daily workbench does not advertise intake');
  await page.goto(base+'/?reader=1#intake');
  await page.getByText('Belge yükleme yetkisi gerekiyor',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-wb-file]').count(),0);
  await page.goto(base+'/?ns=lp#workbench');
  await page.locator('[data-wb-action="new"]').waitFor();
  assert.equal(await page.locator('[data-wb-message].is-error').count(),0);
  await page.evaluate(()=>{window.disposeWorkbench();document.querySelector('#root').replaceChildren();});
  const count=requests.length;
  await page.waitForTimeout(220);assert.equal(await page.locator('#root').innerHTML(),'');assert.equal(requests.length,count,'disposed module starts no new requests');
  assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(r=>server.close(r));
  globalThis.fetch=fetchOriginal;f.close();
 }
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
