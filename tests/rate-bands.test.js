import test from 'node:test';
import assert from 'node:assert/strict';
import {bandLabel,competingRates,rateBandIssues,bandWarnings} from '../public/rate-bands.js';

// Ornek rakamlar yereldir; gercek pazaryeri tarifesi degildir.
const ship=(o={})=>({id:o.id||'s'+Math.random(),label:o.label||'Kargo',channel:'trendyol',carrier:'yurtici',
 valid_from:'2026-01-01',valid_to:'2026-12-31',billable_min_milli:0,billable_max_milli:10000,
 price_min_cents:0,price_max_cents:20000,archived_at:null,...o});
const commission=(o={})=>({id:o.id||'c'+Math.random(),label:o.label||'Komisyon',channel:'trendyol',
 valid_from:'2026-01-01',valid_to:'2026-12-31',sku:'',category:'',
 price_min_cents:0,price_max_cents:20000,archived_at:null,...o});

test('Bant etiketi üst sınırın hariç olduğunu bir kuruş aşağısıyla anlatır',()=>{
 assert.equal(bandLabel({price_min_cents:0,price_max_cents:20000}),'₺0,00 – ₺199,99');
 assert.equal(bandLabel({price_min_cents:20000,price_max_cents:null}),'₺200,00 ve üzeri');
});

test('Bitişik bantlar çakışmaz, bir kuruşluk boşluk bildirilir',()=>{
 const existing=[ship({id:'alt',label:'Alt bant',price_min_cents:0,price_max_cents:20000})];

 const adjacent=ship({id:'ust',label:'Üst bant',price_min_cents:20000,price_max_cents:null});
 const clean=rateBandIssues('shipping',existing,adjacent);
 assert.deepEqual(clean.overlaps,[],'bitişik bantlar çakışma sayılmamalı');
 assert.deepEqual(clean.gaps,[],'bitişik bantlar arasında boşluk olmamalı');

 const oneKurusLate=ship({id:'ust',label:'Üst bant',price_min_cents:20001,price_max_cents:null});
 const gapped=rateBandIssues('shipping',existing,oneKurusLate);
 assert.equal(gapped.gaps.length,1,'bir kuruşluk boşluk fark edilmeli');
 assert.equal(gapped.gaps[0].from_cents,20000);
 assert.equal(gapped.gaps[0].to_cents,20001);
 assert.match(gapped.gaps[0].text,/₺200,00 – ₺200,00/);

 const oneKurusEarly=ship({id:'ust',label:'Üst bant',price_min_cents:19999,price_max_cents:null});
 const overlapped=rateBandIssues('shipping',existing,oneKurusEarly);
 assert.equal(overlapped.overlaps.length,1,'bir kuruş erken başlayan bant çakışmalı');
 assert.equal(overlapped.overlaps[0].id,'alt');
});

test('Sonraki bandın başlangıcı önceki bandın bitişinden önerilir',()=>{
 const existing=[ship({id:'a',price_min_cents:0,price_max_cents:15000}),ship({id:'b',price_min_cents:15000,price_max_cents:40000})];
 const next=ship({id:'c',price_min_cents:40000,price_max_cents:null});
 assert.equal(rateBandIssues('shipping',existing,next).suggested_next_min_cents,null,'sonsuza uzanan bant sonrası öneri olmaz');
 const bounded=ship({id:'c',price_min_cents:40000,price_max_cents:90000});
 assert.equal(rateBandIssues('shipping',existing,bounded).suggested_next_min_cents,90000);
});

test('Farklı dönem, desi, kanal veya taşıyıcı çakışma sayılmaz',()=>{
 const candidate=ship({id:'yeni'});
 const others=[
  ship({id:'gecmis',valid_from:'2025-01-01',valid_to:'2025-12-31'}),
  ship({id:'buyukdesi',billable_min_milli:10000,billable_max_milli:30000}),
  ship({id:'baskakanal',channel:'hepsiburada'}),
  ship({id:'baskatasiyici',carrier:'aras'}),
  ship({id:'arsivli',archived_at:'2026-05-01'})
 ];
 assert.deepEqual(competingRates('shipping',others,candidate),[],'kapsam dışı tarifeler rekabet etmemeli');
 assert.deepEqual(rateBandIssues('shipping',others,candidate).overlaps,[]);
});

test('Bitiş tarihi geçmiş tarife rekabet etmez, kesişen dönem eder',()=>{
 const candidate=ship({id:'yeni',valid_from:'2026-06-01',valid_to:'2026-12-31'});
 const expired=ship({id:'biten',valid_from:'2026-01-01',valid_to:'2026-05-31'});
 const straddling=ship({id:'kesisen',valid_from:'2026-05-01',valid_to:'2026-07-31'});
 assert.deepEqual(competingRates('shipping',[expired],candidate).map(r=>r.id),[]);
 assert.deepEqual(competingRates('shipping',[straddling],candidate).map(r=>r.id),['kesisen']);
});

test('Komisyonda SKU ve kategori önceliği ayrı kapsamdır',()=>{
 const genel=commission({id:'genel',sku:'',category:''});
 const skuya=commission({id:'skulu',sku:'TORF-20'});
 const kategoriye=commission({id:'kategorili',category:'saksi'});

 assert.deepEqual(competingRates('commission',[skuya,kategoriye],genel).map(r=>r.id),[],'daha özel tarifeler genel tarifeyle çakışmaz');
 assert.deepEqual(competingRates('commission',[genel,kategoriye],skuya).map(r=>r.id),[],'SKU tarifesi kendi kapsamındadır');
 assert.deepEqual(competingRates('commission',[commission({id:'ayniSku',sku:'TORF-20'})],skuya).map(r=>r.id),['ayniSku'],'aynı SKU aynı kapsamdır');
});

test('Uyarı metni çakışmayı ve boşluğu ayrı ayrı anlatır',()=>{
 const existing=[ship({id:'alt',label:'Alt bant',price_min_cents:0,price_max_cents:20000})];
 assert.deepEqual(bandWarnings('shipping',existing,ship({id:'x',price_min_cents:20000,price_max_cents:null})),[]);
 const overlap=bandWarnings('shipping',existing,ship({id:'x',label:'Yeni',price_min_cents:10000,price_max_cents:null}));
 assert.equal(overlap.length,1);
 assert.match(overlap[0],/çakışıyor/);
 const gap=bandWarnings('shipping',existing,ship({id:'x',label:'Yeni',price_min_cents:25000,price_max_cents:null}));
 assert.equal(gap.length,1);
 assert.match(gap[0],/hiçbir tarifeye girmiyor/);
});

import {appFixture} from './helpers/app-fixture.js';

// Ornek rakamlar yerel testtir; gercek pazaryeri tarifesi degildir.
const saveShipping=(f,o)=>f.req('/ec/pricing/shipping',{label:o.label,channel:'trendyol',carrier:'yurtici',
 valid_from:'2026-01-01',valid_to:'2026-12-31',vat_bps:2000,tax_included:true,source:'Yerel test verisi',
 desi_divisor:3000,billable_step_milli:1000,billable_min_milli:0,billable_max_milli:10000,amount_cents:o.amount,
 price_min_cents:o.min,price_max_cents:o.max});

test('Tarife kaydı bant boşluğunu ve çakışmasını bildirir ama kaydı engellemez',async()=>{
 const f=appFixture();await f.setup();try{
  const first=await saveShipping(f,{label:'Alt bant',amount:3000,min:0,max:20000});
  assert.equal(first.status,200);
  assert.deepEqual(first.data.warnings,[],'ilk bant için uyarı olmamalı');

  const adjacent=await saveShipping(f,{label:'Bitişik üst bant',amount:8000,min:20000,max:50000});
  assert.equal(adjacent.status,200);
  assert.deepEqual(adjacent.data.warnings,[],'bitişik bant uyarı üretmemeli');

  const gapped=await saveShipping(f,{label:'Boşluklu bant',amount:9000,min:50001,max:90000});
  assert.equal(gapped.status,200,'uyarı kaydı engellememeli');
  assert.equal(gapped.data.warnings.length,1);
  assert.match(gapped.data.warnings[0],/hiçbir tarifeye girmiyor/);

  const overlapping=await saveShipping(f,{label:'Çakışan bant',amount:9500,min:10000,max:30000});
  assert.equal(overlapping.status,200);
  assert.ok(overlapping.data.warnings.some(w=>/çakışıyor/.test(w)),'çakışma bildirilmeli');

  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ec_shipping_rates').get().n,4,'uyarılara rağmen dört tarife de kaydedilmeli');
 }finally{f.close();}
});
