import test from 'node:test';import assert from 'node:assert/strict';
import {parseScaled, toQuantityMilli, toPriceCents, toBps, toCanonicalLine, SayiHatasi} from '../public/belge-sayi.js';
import {offerTotals} from '../public/offer-math.js';

// Atolyenin ozgun n() fonksiyonu yalniz ILK virgulu ceviriyordu: "1.234,56" NaN oluyordu.
// Bu adaptor tahmin YURUTMEZ ve fazla hassasiyeti sessizce yuvarlamaz.

test('Tek ondalik ayirici kabul edilir: virgul ya da nokta',()=>{
 assert.equal(toPriceCents('125'),12500);
 assert.equal(toPriceCents('125,50'),12550);
 assert.equal(toPriceCents('125.50'),12550);
 assert.equal(toPriceCents('0,01'),1);
 assert.equal(toPriceCents('0'),0);
 assert.equal(toQuantityMilli('2'),2000);
 assert.equal(toQuantityMilli('0,333'),333);
 assert.equal(toQuantityMilli('1,5'),1500);
});

test('Binlik ayirici REDDEDILIR: tahmin yurutulmez',()=>{
 for(const kotu of ['1.234,56','1,234.56','1.234.567','1,234,567']){
  assert.throws(()=>toPriceCents(kotu),SayiHatasi,kotu+' kabul edildi');
  assert.throws(()=>toPriceCents(kotu),/tek ondalık ayırıcı|birden fazla ayırıcı/,kotu);
 }
});

test('Fazla ondalik SESSIZCE yuvarlanmaz, duzeltme istenir',()=>{
 // Fiyat 2, miktar 3, oran 2 ondalik.
 assert.throws(()=>toPriceCents('125,555'),/en çok 2 ondalık/);
 assert.throws(()=>toQuantityMilli('0,3333'),/en çok 3 ondalık/);
 assert.throws(()=>toBps('10,005'),/en çok 2 ondalık/);
 // Sinirda olan kabul edilir.
 assert.equal(toPriceCents('125,55'),12555);
 assert.equal(toQuantityMilli('0,333'),333);
 assert.equal(toBps('10,25'),1025);
});

test('Bos birim fiyat SIFIR SAYILMAZ',()=>{
 assert.equal(toPriceCents(''),null);
 assert.equal(toPriceCents(null),null);
 assert.equal(toPriceCents(undefined),null);
 assert.equal(toPriceCents('   '),null);
 // Satir cevriminde bos fiyat acik hata verir.
 assert.throws(()=>toCanonicalLine({name:'A',unit:'adet',qty:'1',price:'',discount:'0',vat:'20'},0),
  /Boş fiyat sıfır sayılmaz/);
 // Miktar bos birakilamaz.
 assert.throws(()=>toQuantityMilli(''),/boş bırakılamaz/);
});

test('Bos oran sifir orandir; eksi deger reddedilir',()=>{
 assert.equal(toBps(''),0);
 assert.equal(toBps(null),0);
 assert.equal(toBps('0'),0);
 assert.throws(()=>toPriceCents('-5'),/eksi olamaz/);
 assert.throws(()=>toQuantityMilli('-1'),/eksi olamaz/);
});

test('Sayi olmayan giris reddedilir',()=>{
 for(const kotu of ['abc','12a','1e5','--1','.',',','0x10','1 234']){
  assert.throws(()=>toPriceCents(kotu),SayiHatasi,kotu+' kabul edildi');
 }
 // Bosluk kirpilir, ic bosluk reddedilir.
 assert.equal(toPriceCents(' 125 '),12500);
});

test('Oran %100 ustu ve aralik disi deger reddedilir',()=>{
 assert.equal(toBps('100'),10000);
 assert.throws(()=>toBps('100,01'),/aralığın dışında/);
 assert.throws(()=>toBps('150'),/aralığın dışında/);
 assert.throws(()=>toQuantityMilli('0'),/aralığın dışında/);
});

test('Safe-integer siniri asilamaz',()=>{
 assert.throws(()=>toPriceCents('99999999999'),/aralığın dışında|çok büyük/);
 assert.throws(()=>toQuantityMilli('999999999999'),/aralığın dışında|çok büyük/);
 // Sinir degeri kabul edilir.
 assert.equal(toPriceCents('1000000000'),100000000000);
});

test('Kayan nokta hatasi girmez: 0,07 ve 8,15 tam cevrilir',()=>{
 // Number(8.15*100) === 814.9999... tuzagi; tamsayi aritmetigi kullanilir.
 assert.equal(toPriceCents('8,15'),815);
 assert.equal(toPriceCents('0,07'),7);
 assert.equal(toPriceCents('1,05'),105);
 assert.equal(toPriceCents('10,10'),1010);
 assert.equal(toPriceCents('99,99'),9999);
 // 2,675 fiyatta UC ondalik: yuvarlanmaz, reddedilir.
 assert.throws(()=>toPriceCents('2,675'),/en çok 2 ondalık/);
 // Miktarda uc ondalik gecerli ve tam cevrilir.
 assert.equal(toQuantityMilli('2,675'),2675);
 assert.equal(toQuantityMilli('0,007'),7);
});

test('Devir belgesindeki dogrulama ornegi birebir cikar: 358,00 TRY',()=>{
 const satirlar=[
  toCanonicalLine({name:'Örnek ürün A',unit:'adet',qty:'2',price:'125',discount:'10',vat:'20'},0),
  toCanonicalLine({name:'Örnek ürün B',unit:'adet',qty:'1',price:'80',discount:'0',vat:'10'},1)
 ];
 assert.deepEqual(satirlar[0],{description:'Örnek ürün A',unit:'adet',product_id:null,
  quantity_milli:2000,unit_price_cents:12500,discount_bps:1000,vat_bps:2000});
 const t=offerTotals(satirlar);
 // 2x125TL %10 isk %20 KDV -> brut 25000 / isk 2500 / net 22500 / KDV 4500 / toplam 27000
 assert.equal(t.rows[0].gross_cents,25000);
 assert.equal(t.rows[0].discount_cents,2500);
 assert.equal(t.rows[0].net_cents,22500);
 assert.equal(t.rows[0].vat_cents,4500);
 assert.equal(t.rows[0].total_cents,27000);
 // 1x80TL %0 isk %10 KDV -> 8800
 assert.equal(t.rows[1].total_cents,8800);
 // Birlikte 358,00 TRY
 assert.equal(t.total_cents,35800);
});

test('Satir yuvarlama ornegi: qty=0,333 price=0,10 vat=20 -> brut 3, KDV 1, toplam 4 kurus',()=>{
 const satir=toCanonicalLine({name:'Örnek',unit:'adet',qty:'0,333',price:'0,10',discount:'0',vat:'20'},0);
 assert.deepEqual(satir.quantity_milli,333);
 assert.deepEqual(satir.unit_price_cents,10);
 const t=offerTotals([satir]);
 assert.equal(t.rows[0].gross_cents,3);
 assert.equal(t.rows[0].vat_cents,1);
 assert.equal(t.rows[0].total_cents,4);
});

test('Hata mesaji hangi satirda oldugunu soyler',()=>{
 try{
  toCanonicalLine({name:'A',unit:'adet',qty:'1',price:'1.234,56',discount:'0',vat:'20'},2);
  assert.fail('hata beklendi');
 }catch(error){
  assert.match(error.message,/satır 3/);
  assert.ok(error instanceof SayiHatasi);
 }
});

test('parseScaled dogrudan kullanilabilir ve etiketi mesajda gecer',()=>{
 assert.equal(parseScaled('5',{decimals:0,label:'Adet'}),5);
 assert.throws(()=>parseScaled('5,5',{decimals:0,label:'Adet'}),/Adet en çok 0 ondalık/);
});
