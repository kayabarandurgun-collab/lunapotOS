import test from 'node:test';
import assert from 'node:assert/strict';
import {productList,selectProducts} from '../public/product-list.js';
import {stockCountPreview,bindStockCountPreview} from '../public/accounting-ui.js';
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const helpers={esc,money:v=>v==null?'Tutar bilinmiyor':(v/100).toFixed(2)+' TL',qty:v=>String(v/1000),compact:true};
const product={id:'A',name:'Orkide <ürün>',sku:'ORK',brand:'Tropikal',category:'Besin',stock_unit:'adet',min_stock_milli:0,quantity_milli:8000,on_hand_milli:8000,reserved_milli:2000,available_milli:6000,in_transit_milli:3000,in_transit_known_milli:3000,in_transit_status:'complete',in_transit_notes:[],value_cents:10000,vat_bps:2000,average_purchase_cents:1000};
const data={sales:[],suppliers:[],productStats:new Map([['A',{adet_milli:4000,kar_cents:-999999,kar_adet_cents:-999999,ciro_cents:20000}]])};

test('cards and tables show physical stock and separately qualified sales quantity, without allocated profit ranking',()=>{
 for(const compact of [true,false])for(const stockView of ['cards','table']){
  const html=productList([product],data,{stockView},{...helpers,compact});
  for(const text of ['Kullanılabilir','Depoda · kayıtlı','Ayrılan · depoda','Kargoda · depodan çıktı','Setleri değil','tekrar düşülmez','Satış kullanım ayrıntıları','iadeler düşülmüş','#performance?view=sales','Orkide &lt;ürün&gt;'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('Toplam kâr'));assert.ok(!html.includes('Adet başı kâr'));assert.ok(!html.includes('9999.99'));
  assert.match(html,/>6(?: adet| <small>)/);assert.match(html,/>8</);assert.match(html,/>2</);assert.match(html,/>3</);assert.match(html,/>4 adet</);
 }
 const products=[{...product,id:'B',name:'B',available_milli:null},{...product,name:'A',available_milli:-1000}];
 assert.deepEqual(selectProducts(products,{stockSort:'available'}).map(p=>p.id),['A','B'],'unknown sorts after a known negative');
 assert.deepEqual(selectProducts(products,{stockSort:'profit'},new Map([['B',{kar_cents:999999}],['A',{kar_cents:-999999}]] )).map(p=>p.id),['A','B'],'old profit sort is safe name ordering');
 assert.deepEqual(selectProducts(products,{stockFilter:'low'}).map(p=>p.id),['A'],'unknown is not a known zero-stock product');
});

test('unknown transit and hidden money are never displayed as zero; totals keep unit boundaries and negative stock',()=>{
 const p={...product,value_cents:null,average_purchase_cents:null,in_transit_milli:null,in_transit_known_milli:1000,in_transit_status:'incomplete',in_transit_notes:['Kaynak <değişti>']};
 const html=productList([p,{...product,id:'KG',name:'Torf',stock_unit:'kg',quantity_milli:-2000,on_hand_milli:-2000,reserved_milli:0,available_milli:-2000}],{...data,productStats:null},{stockView:'cards'},helpers);
 assert.match(html,/Bilinmiyor/);assert.match(html,/Doğrulanabilen 1 · toplam eksik/);assert.match(html,/Kaynak &lt;değişti&gt;/);assert.match(html,/depoda kayıtlı 8 adet · -2 kg/);
 const card=html.slice(0,html.indexOf('Torf'));
 assert.ok(!card.includes('0.00 TL'));assert.match(card,/Tutar bilinmiyor/);
});

test('count preview uses physical onhand including reserved, never adds transit or set quantity',()=>{
 assert.deepEqual(stockCountPreview(product,'7'),{on_hand_milli:8000,counted_milli:7000,difference_milli:-1000});
 assert.deepEqual(stockCountPreview({...product,quantity_milli:999000},'8'),{on_hand_milli:8000,counted_milli:8000,difference_milli:0});
 assert.equal(stockCountPreview(product,'0').difference_milli,-8000);
 assert.equal(stockCountPreview(product,'8.125').difference_milli,125);
 for(const value of ['', ' ', '-1','NaN','8.0001','1000001'])assert.equal(stockCountPreview(product,value).counted_milli,null,value);
 assert.equal(stockCountPreview({...product,on_hand_milli:null},'8').difference_milli,null);
 assert.equal(stockCountPreview({...product,on_hand_milli:-2000},'1').difference_milli,3000);
});

test('count dialog binding updates on quantity, kind and product change, leaves input and write behavior untouched',()=>{
 const fields={product_id:{value:'A'},quantity:{value:''},kind:{value:'count'}},output={textContent:''},listeners={};
 const form={elements:{namedItem:n=>fields[n]},querySelector:()=>output,addEventListener:(type,fn)=>listeners[type]=fn};
 bindStockCountPreview(form,[product,{...product,id:'B',stock_unit:'kg',on_hand_milli:3000}]);
 assert.match(output.textContent,/Kayıtlı depo: 8 adet/);assert.match(output.textContent,/Girilen sayım: Henüz bilinmiyor/);
 fields.quantity.value='7';listeners.input();assert.match(output.textContent,/Fark: -1 adet/);assert.equal(fields.quantity.value,'7');
 fields.product_id.value='B';listeners.change();assert.match(output.textContent,/Kayıtlı depo: 3 kg/);assert.match(output.textContent,/Fark: \+4 kg/);
 fields.kind.value='opening';listeners.change();assert.match(output.textContent,/İlk açılış/);assert.ok(!output.textContent.includes('Fark:'));
});
