import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {urunSuz,taslagaUrunYaz} from '../public/accounting-ui.js';

// Faturasız mal girişinde ürün 38 kalemlik açılır listeden seçiliyordu; kullanıcı 06.10.2026
// "açılır listeden bulmak çok zor" dedi. Yerine yazarak süzme geldi. Buradaki testler süzgecin
// ve "listede olmayan ürünü ekle" dönüşünün davranışını sabitliyor.

const depo=[
 {id:'p1',name:'Gartengold Genel Kullanım Organik Torf 10 L',sku:'GG-TORF-10L',stock_unit:'adet'},
 {id:'p2',name:'Gartengold Genel Kullanım Organik Torf 20 L',sku:'GG-TORF-20L',stock_unit:'adet'},
 {id:'p3',name:'Tropikal Kaktüs ve Sukulent Bitki Besini 225 ml',sku:'TR-KAKTUS-225ML',stock_unit:'adet'},
 {id:'p4',name:'İthal Perlit 10 L',sku:'ITH-PERLIT-10L',stock_unit:'adet'},
 // Arşivli kart listeden ancak stoğu VE değeri sıfırsa düşer (product-list.js:16); bakiyesi
 // kalan arşivli kart seçilebilir durmaya devam eder.
 {id:'p5',name:'Arşivlenmiş Eski Torf',sku:'ESKI-TORF',stock_unit:'adet',archived_at:'2026-05-01',quantity_milli:0,value_cents:0},
 {id:'p6',name:'Arşivli ama Stoğu Duran Torf',sku:'ARS-TORF',stock_unit:'adet',archived_at:'2026-05-01',quantity_milli:4000,value_cents:12000}
];

test('boş arama canlı kartları verir; tükenmiş arşivli kart çıkmaz, stoğu duran çıkar', () => {
 assert.deepEqual(urunSuz(depo,'').map(p=>p.id),['p1','p2','p3','p4','p6']);
});

test('kelimeler ad ve stok kodunda aranır, sıra önemsiz', () => {
 assert.deepEqual(urunSuz(depo,'torf 20').map(p=>p.id),['p2']);
 assert.deepEqual(urunSuz(depo,'20 torf').map(p=>p.id),['p2']);
 assert.deepEqual(urunSuz(depo,'gg-torf').map(p=>p.id),['p1','p2']);
 assert.deepEqual(urunSuz(depo,'ars-torf').map(p=>p.id),['p6']);
 assert.deepEqual(urunSuz(depo,'kaktus-225').map(p=>p.id),['p3']);
});

// 'I' ile 'İ' Türkçede ayrı harfler: düz toLowerCase() 'İthal' yazısını 'ithal' aramasıyla
// eşleştirmez ('İ'.toLowerCase() === 'i̇', birleşik nokta kalır).
test('Türkçe büyük harf katlaması tutar', () => {
 assert.deepEqual(urunSuz(depo,'ithal').map(p=>p.id),['p4']);
 assert.deepEqual(urunSuz(depo,'İTHAL').map(p=>p.id),['p4']);
 assert.deepEqual(urunSuz(depo,'kaktüs').map(p=>p.id),['p3']);
});

test('eşleşmeyen arama boş döner; listede olmayan ürün buradan anlaşılır', () => {
 assert.deepEqual(urunSuz(depo,'klasmann plug mix'),[]);
});

test('sınır uygulanır ve bozuk girdi çökertmez', () => {
 assert.equal(urunSuz(depo,'',2).length,2);
 assert.deepEqual(urunSuz(null,'torf'),[]);
 assert.deepEqual(urunSuz([null,undefined,...depo],'perlit').map(p=>p.id),['p4']);
 assert.deepEqual(urunSuz(depo,null).map(p=>p.id),['p1','p2','p3','p4','p6']);
 assert.deepEqual(urunSuz([{id:'x'}],'bos').map(p=>p.id),[]);
});

test('yeni ürün taslağın ilk boş satırına yazılır, dolu satırlar oynamaz', () => {
 const taslak={supplier_id:'s1',reference:'IRS-1',lines:[
  {product_id:'p1',quantity:'5',unit_cost:'10',vat_rate:'20'},
  {product_id:'',quantity:'3',unit_cost:'',vat_rate:''}
 ]};
 const sonuc=taslagaUrunYaz(taslak,'yeni');
 assert.equal(sonuc.supplier_id,'s1');
 assert.equal(sonuc.reference,'IRS-1');
 assert.deepEqual(sonuc.lines[0],{product_id:'p1',quantity:'5',unit_cost:'10',vat_rate:'20'});
 assert.equal(sonuc.lines[1].product_id,'yeni');
 assert.equal(sonuc.lines[1].quantity,'3','boş satırın yazılmış miktarı korunur');
 assert.equal(taslak.lines[1].product_id,'','özgün taslak değişmez');
});

test('boş satır yoksa yeni ürün sona eklenir', () => {
 const sonuc=taslagaUrunYaz({lines:[{product_id:'p1',quantity:'5',unit_cost:'10',vat_rate:'20'}]},'yeni');
 assert.equal(sonuc.lines.length,2);
 assert.equal(sonuc.lines[1].product_id,'yeni');
});

test('taslak hiç yoksa tek satırlık taslak doğar', () => {
 assert.deepEqual(taslagaUrunYaz(null,'yeni').lines,[{product_id:'yeni',quantity:'',unit_cost:'',vat_rate:''}]);
 assert.deepEqual(taslagaUrunYaz(undefined,'yeni').lines,[{product_id:'yeni',quantity:'',unit_cost:'',vat_rate:''}]);
});

// Ürün kimliği yoksa taslağa dokunulmaz: kart kaydı başarısız olduğunda yarım kalan giriş
// bozulmamalı.
test('kimlik yoksa taslak olduğu gibi kalır', () => {
 const taslak={lines:[{product_id:'p1'}]};
 assert.equal(taslagaUrunYaz(taslak,''),taslak);
 assert.equal(taslagaUrunYaz(taslak,null),taslak);
});

// commerce-workflows.css:242 penceredeki içinde gizli alan bulunan HER label'ı display:none
// yapıyor (gizli alanın başıboş etiket metnini silmek için). Ürün seçicinin görünen kutusu ile
// gizli product_id alanı aynı label içindeyken kutu CANLIDA hiç görünmedi. Gizli alan label'ın
// DIŞINDA, sarmalayıcı div'in içinde kalmalı.
const ui=readFileSync(new URL('../public/accounting-ui.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/stock-workflow.css',import.meta.url),'utf8');
const kural=readFileSync(new URL('../public/commerce-workflows.css',import.meta.url),'utf8');

test('seçicinin gizli alanı label içinde değil', () => {
 assert.ok(ui.includes('<div class="ac-pick" data-ac-pick><label class="ac-pick-label">'),'sarmalayıcı div olmalı, label değil');
 assert.ok(ui.includes("</label>'"),'görünen kutunun etiketi gizli alandan önce kapanmalı');
 assert.ok(!ui.includes('<label class="ac-pick" data-ac-pick>'),'eski label sarmalayıcı kalmamalı');
 const basla=ui.indexOf('<div class="ac-pick" data-ac-pick>');
 const labelSonu=ui.indexOf("</label>'",basla),gizli=ui.indexOf('<input type="hidden" name=',basla);
 assert.ok(labelSonu>0&&gizli>labelSonu,'gizli alan label kapandıktan SONRA gelmeli');
});

test('gizleyen kural duruyor, görünen kutunun kendi biçimi var', () => {
 assert.ok(kural.includes('label:has(>input[type=hidden]){display:none}'),'kural hâlâ yürürlükte olmalı');
 assert.ok(css.includes('.ac-pick-label{display:grid'),'görünen kutunun kendi label biçimi olmalı');
});
