import test from 'node:test';import assert from 'node:assert/strict';
import {selectPerformanceRows,performanceCsv,reportDateRange,csvCell} from '../public/performance-tools.js';
const rows=[{id:'loss',channel:'trendyol',profit_cents:-150},{id:'missing',channel:'trendyol',profit_cents:null},{id:'zero',channel:'hepsiburada',profit_cents:0},{id:'profit',channel:'hepsiburada',profit_cents:1200}];
test('Kâr filtreleri bilinmeyenleri sıfır veya zarar saymaz; kanal seçimi korunur',()=>{
 assert.deepEqual(selectPerformanceRows(rows,{result:'loss'}).map(r=>r.id),['loss']);assert.deepEqual(selectPerformanceRows(rows,{result:'missing'}).map(r=>r.id),['missing']);assert.deepEqual(selectPerformanceRows(rows,{channel:'trendyol',result:'profit'}),[]);assert.equal(selectPerformanceRows(rows).length,4);
});
test('Hızlı tarih aralıkları ay/yıl ve artık yıl sınırlarını doğru kapsar',()=>{
 assert.deepEqual(reportDateRange('week','2026-01-03'),{from:'2025-12-28',to:'2026-01-03'});assert.deepEqual(reportDateRange('previous','2024-03-15'),{from:'2024-02-01',to:'2024-02-29'});assert.deepEqual(reportDateRange('month','2026-09-09'),{from:'2026-09-01',to:'2026-09-09'});assert.deepEqual(reportDateRange('today','2026-09-09'),{from:'2026-09-09',to:'2026-09-09'});
});
test('CSV bilinmeyen kârı, kesinti eksiklerini ve tahmin kapsamını açık tutar; formül metinlerini etkisizleştirir',()=>{
 const state={mode:'pending',from:'2026-09-01',to:'2026-09-09',as_of:'2026-09-09T12:00:00Z',unallocated_fee_cents:3500,cost_notice:'Ortak giderler hariç',rows:[{...rows[1],external_id:'=IMPORT("x")',order_no:'\t+formula',missing:['Kargo bilinmiyor'],status:'shipped'},rows[2]]};
 const csv=performanceCsv(state,{channel:'trendyol',result:'missing'});assert.match(csv,/TAHMİNİ/);assert.match(csv,/Bilgi eksik/);assert.match(csv,/Kargo bilinmiyor/);assert.match(csv,/Ortak giderler hariç/);assert.match(csv,/'=IMPORT/);assert.match(csv,/'\t\+formula/);assert.ok(!csv.includes('Hepsiburada'));assert.equal(csvCell(-15.5),'"-15,5"');assert.equal(csvCell('a"b'),'"a""b"');
});

import {appFixture} from './helpers/app-fixture.js';
test('Teslim edilmiş paket raporu, tahmin tarife sınırı aşılmış olsa da gerçek kayıtları hesaplar',async()=>{
 const f=appFixture();try{await f.setup();
 const insert=f.sqlite.prepare("INSERT INTO ec_commission_rates(id,label,channel,valid_from,valid_to,price_min_cents,rate_bps,base,vat_bps,tax_included,source) VALUES(?,'Sentetik tarife','trendyol','2026-01-01','2026-12-31',0,1000,'gross',2000,0,'Test')");
 f.sqlite.exec('BEGIN');for(let i=0;i<1001;i++)insert.run('tariff-'+i);f.sqlite.exec('COMMIT');
 assert.equal((await f.req('/ec/performance?mode=delivered')).status,200);
 assert.equal((await f.req('/ec/performance?mode=pending')).status,409,'Tahmin için sınırlı tarife verisiyle eksik hesap yapılmaz');
 }finally{f.close();}
});

import {decisionTotals} from '../public/decision-overview.js';

test('Karar özeti yalnızca hesaplanabilen paketleri toplar ve eksik varken dönem sonucunu kesin göstermez',()=>{
 const rows=[{profit_cents:5000},{profit_cents:-2000},{profit_cents:null}];
 const partial=decisionTotals({rows,unallocated_fee_cents:0});
 assert.equal(partial.calculated,2);
 assert.equal(partial.total,3);
 assert.equal(partial.profit,5000);
 assert.equal(partial.loss,2000);
 assert.equal(partial.net,null,'bilgisi eksik paket varken dönem sonucu kesin sayılmamalı');

 const whole=decisionTotals({rows:rows.slice(0,2),unallocated_fee_cents:0});
 assert.equal(whole.net,3000,'tüm paketler hesaplanınca net sonuç verilir');

 const pendingFees=decisionTotals({rows:rows.slice(0,2),unallocated_fee_cents:1500});
 assert.equal(pendingFees.net,null,'dağıtılmamış kesinti varken dönem sonucu kesin sayılmamalı');

 const none=decisionTotals({rows:[],unallocated_fee_cents:0});
 assert.equal(none.profit,null);
 assert.equal(none.net,null);
});
