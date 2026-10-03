import test from 'node:test';
import assert from 'node:assert/strict';
import {productList,selectProducts} from '../public/product-list.js';
const helpers={esc:v=>String(v??''),money:v=>v==null?'Bilinmiyor':String(v),qty:v=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:3}).format(v/1000)};
const product=(id,brand,quantity)=>({id,sku:id,name:id,brand,stock_unit:'adet',on_hand_milli:quantity,quantity_milli:quantity,reserved_milli:0,available_milli:quantity,in_transit_milli:0,min_stock_milli:0,value_cents:null,vat_bps:2000});
test('warehouse register keeps global quantity order instead of silently grouping again by brand',()=>{
 const products=[product('low','Tropikal',1000),product('high','SAB',9000),product('middle','Gartengold',5000)];
 const sorted=selectProducts(products,{stockSort:'quantity'});assert.deepEqual(sorted.map(p=>p.id),['high','middle','low']);
 for(const stockView of ['cards','table']){const html=productList(sorted,{suppliers:[],sales:[]},{stockView},helpers);assert.ok(html.indexOf('<h3>high</h3>')<html.indexOf('<h3>middle</h3>'));assert.ok(html.indexOf('<h3>middle</h3>')<html.indexOf('<h3>low</h3>'));}
});
test('warehouse distinguishes unknown quantities and long numeric values without shortening their digits',()=>{
 const html=productList([product('large','SAB',123456789000),{...product('unknown','SAB',0),on_hand_milli:null,available_milli:null}],{suppliers:[],sales:[]},{stockView:'cards'},helpers);
 assert.match(html,/is-extra-wide[^>]*>123\.456\.789</);assert.match(html,/is-unknown[^>]*>Bilinmiyor</);assert.doesNotMatch(html,/123[,.]4[MBK]/);
});
