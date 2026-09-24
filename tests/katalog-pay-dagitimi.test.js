// KATALOG PAY DAĞITIMI — "İç kayıt dağıtım payı (%)" toplamı neden ve nasıl %100 tutulur?
//
// Canlı kusur: kullanıcı tek bileşenli bir bağlantıya ikinci stok ürünü ekledi; ilk satır %100'de
// kaldı, yeni satırın payı boş geldi, ekranda hiçbir toplam görünmedi. Kullanıcı %100 + %63,62 =
// %163,62 ile KAYDET'e bastı ve uyarıyı ancak sunucudan (src/catalog-api.js) aldı.
// Kural: paylar bin baz puandır (10000 = %100). Kullanıcının ELLE yazdığı pay dokunulmazdır;
// kalan pay yalnızca otomatik (henüz elle düzenlenmemiş) satırlara eşit bölünür. Böylece yeni satır
// boş kalmaz, kayıtlı bir dağıtım da kendiliğinden bozulmaz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {paylariDagit,payDurumu} from '../public/catalog-ui.js';

test('Tek bileşene ikinci stok ürünü eklenince pay eşit bölünür; kullanıcı elle hesap yapmaz',()=>{
 assert.deepEqual(paylariDagit([{bps:10000,auto:true},{bps:null,auto:true}]),[5000,5000]);
 assert.deepEqual(paylariDagit([{bps:null,auto:true}]),[10000]);
 assert.equal(payDurumu(paylariDagit([{bps:10000,auto:true},{bps:null,auto:true}])).tam,true);
});

test('Elle girilen pay dokunulmazdır; kalan pay otomatik satırlara gider',()=>{
 assert.deepEqual(paylariDagit([{bps:9500,auto:false},{bps:null,auto:true}]),[9500,500]);
 // Kayıtlı bağlantının payları (auto:false) sürüm düzenlemesinde aynen korunur.
 assert.deepEqual(paylariDagit([{bps:9500,auto:false},{bps:500,auto:false}]),[9500,500]);
 assert.deepEqual(paylariDagit([{bps:9000,auto:false},{bps:0,auto:true},{bps:0,auto:true}]),[9000,500,500]);
});

test('Kuruş artığı dağıtılır; üç eşit bileşende toplam tam %100 olur',()=>{
 const uc=paylariDagit([{bps:null,auto:true},{bps:null,auto:true},{bps:null,auto:true}]);
 assert.deepEqual(uc,[3334,3333,3333]);
 assert.equal(uc.reduce((t,v)=>t+v,0),10000);
 assert.equal(payDurumu(uc).tam,true);
});

test('Elle girilen paylar %100ü aşarsa otomatik satır sıfır alır ve toplam uyarı verir',()=>{
 assert.deepEqual(paylariDagit([{bps:10000,auto:false},{bps:6362,auto:false},{bps:null,auto:true}]),[10000,6362,0]);
 const durum=payDurumu([10000,6362]);
 assert.equal(durum.tam,false);
 assert.equal(durum.toplam,16362);
 assert.equal(durum.fark,6362);
 assert.match(durum.metin,/%163,62/);
 assert.match(durum.metin,/%100 olmalı/);
 assert.match(durum.metin,/fazla/);
});

test('Eksik toplam farkını söyler; boş veya iki ondalığı aşan pay geçersiz sayılır',()=>{
 const eksik=payDurumu([8000,1000]);
 assert.equal(eksik.tam,false);
 assert.equal(eksik.fark,-1000);
 assert.match(eksik.metin,/%90/);
 assert.match(eksik.metin,/eksik/);
 const bos=payDurumu([5000,null]);
 assert.equal(bos.gecersiz,true);
 assert.equal(bos.tam,false);
 assert.match(bos.metin,/pay/i);
 assert.equal(payDurumu([10000]).tam,true);
 assert.match(payDurumu([10000]).metin,/%100/);
});
