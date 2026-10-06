import test from 'node:test';
import assert from 'node:assert/strict';
import {accountingIntent,unbilledStockPreview,stockCountPreview} from '../public/accounting-ui.js';
import {resetPurchaseFile,purchaseQueueResult} from '../public/purchase-document-ui.js';
import {movementLabel,linksBlock} from '../public/stock-history-ui.js';

test('purchase/warehouse links accept only actions for the current route',()=>{
 assert.deepEqual(accountingIntent('#invoices?action=upload','invoices'),{action:'upload',product:'',party:''});
 assert.deepEqual(accountingIntent('#stock?filter=low&action=unbilled&product=a%26b','stock'),{action:'unbilled',product:'a&b',party:''});
 assert.deepEqual(accountingIntent('#/stock?action=count','stock'),{action:'count',product:'',party:''});
 // Cariler ekranındaki düğme tek forma yönlendirir ve seçili tedarikçiyi taşır.
 assert.deepEqual(accountingIntent('#stock?action=unbilled&party=p1','stock'),{action:'unbilled',product:'',party:'p1'});
 for(const hash of ['#stock?action=upload','#reports?action=upload','#invoices?action=unbilled','#stock?action=delete','#stock'])assert.equal(accountingIntent(hash,'stock'),null);
 assert.equal(accountingIntent('#stock?action=count','invoices'),null);
});
test('incoming quantity adds to on-hand while stock count replaces its total',()=>{
 const product={on_hand_milli:12000,reserved_milli:2000,in_transit_milli:3000};
 assert.deepEqual(unbilledStockPreview(product,'5'),{on_hand_milli:12000,incoming_milli:5000,after_milli:17000});
 assert.equal(stockCountPreview(product,'5').difference_milli,-7000);
 assert.equal(unbilledStockPreview({on_hand_milli:null,quantity_milli:99000},'5').after_milli,null);
 assert.equal(unbilledStockPreview({on_hand_milli:-2000},'0.125').after_milli,-1875);
 for(const raw of ['', '0','-5','no','1.0001','1000001'])assert.equal(unbilledStockPreview(product,raw).incoming_milli,null);
});
test('new purchase file clears prior multi-invoice page and supplier identities but retains the session queue',()=>{
 const queue=[{file:'next.xml'}],catalog={products:[]},state={queue,catalog,supplierId:'old',sayfaNo:3,docId:'old-doc',parts:[{}],header:{invoice_no:'old'},previewUrl:'blob:old',lastAuto:{status:'posted'}};
 resetPurchaseFile(state);
 for(const name of ['supplierId','sayfaNo','docId','parts','header','previewUrl','lastAuto'])assert.equal(state[name],null,name);
 assert.equal(state.queue,queue);assert.equal(state.catalog,catalog);assert.deepEqual(state.lines,[]);
});
test('purchase queue reports posted invoices, stock receipt, incomplete drafts and attachment errors accurately',()=>{
 const info={ad:'test.pdf',fatura:'INV-1',notes:['Belge bağlanamadı']};
 assert.equal(purchaseQueueResult({status:'posted',received:true},info).sonuc,'islendi');
 assert.equal(purchaseQueueResult({status:'posted',received:false},info).sonuc,'muhasebelesti');
 const draft=purchaseQueueResult({status:'draft',reason:'Ürün eksik'},info);
 assert.equal(draft.sonuc,'taslak');assert.equal(draft.sebep,'Ürün eksik Belge bağlanamadı');
 assert.match(purchaseQueueResult({status:'posted',received:true},info).sebep,/Belge bağlanamadı/);
});
test('history distinguishes incoming unbilled goods from physical count and purchase links from sales',()=>{
 assert.equal(movementLabel({kind:'count',reference:'GECICI-SAYIM-IRS1'}),'Faturasız mal girişi');
 assert.equal(movementLabel({kind:'count',reference:'provisional-close:abc'}),'Faturasız giriş faturayla kapandı');
 assert.equal(movementLabel({kind:'count',reference:'COUNT1'}),'Sayım farkı');
 // 0072: hayalet telafisinin referansı da 'GECICI-SAYIM-' ile başlıyor. Etiketlenmezse 392 adetlik
 // en büyük düzeltme stok kartında "Faturasız mal girişi" diye okunurdu.
 assert.equal(movementLabel({kind:'count',reference:'GECICI-SAYIM-000879-SAT-ab12cd34'}),'Hatalı raf sayımı telafisi (0072)');
 assert.equal(movementLabel({kind:'purchase',reference:'TELAFI-IPTAL-GECICI-SAYIM-000879-SAT-ab12cd34'}),'Raf sayımı telafisi geri alındı');
 assert.equal(movementLabel({kind:'purchase',reference:'GECICI-IPTAL-000879'}),'Faturasız giriş iptal edildi');
 const html=linksBlock({product:{stock_unit:'adet'},links:[{source:'purchase',external_code:'X',quantity_milli:6000,component_count:1}]});
 assert.match(html,/1 fatura biriminde 6 adet giriş/);assert.doesNotMatch(html,/1 satışta/);
});
