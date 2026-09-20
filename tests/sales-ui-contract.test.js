
import test from 'node:test';
import assert from 'node:assert/strict';
import {packageCsvWithGrossAmounts,salesModel,salesListMarkup,salesCsv,salesReturnsMarkup,loadPerformancePages,performanceSummary} from '../public/performance-ui.js';
import {panoramaSalesMarkup,panoramaDetailMarkup,pendingStatusMarkup} from '../public/panorama-ui.js';

const range={preset:'custom',from:'2026-09-01',to:'2026-09-20',error:null};
const component={product_id:'feed',name:'Orkide bitki besini',quantity_milli:1000,stock_unit:'adet'};
function item(key,kind,cash,extra={}){return {key,kind,name:kind==='multipack'?'Genel bitki besini · 4lü paket':kind==='bundle'?'Orkide üçlü set':'Orkide bitki besini',units_milli:1000,sold_units_milli:1000,returned_units_milli:0,components:[{...component,quantity_milli:kind==='multipack'?4000:1000}],revenue_gross_cents:12000,cost_gross_cents:4000,cash_cents:cash,sold_cash_cents:cash,return_cash_cents:0,allocation_note:'Ortak kargo paket hesabından paylaştırılır.',...extra};}
function parcel(id,items,extra={}){return {id,channel:'trendyol',order_no:'SENTETIK-'+id,status:'delivered',delivered_on:'2026-09-20',occurred_on:'2026-09-18',sales_items:items,
 ...Object.fromEntries(['revenue_gross_cents','cost_gross_cents','cash_cents'].map(k=>[k,items.every(i=>Number.isFinite(i[k]))?items.reduce((s,i)=>s+i[k],0):null])),...extra};}
const ordinary=()=>parcel('one',[item('single','single',2001),item('four','multipack',1000)]);
const failed=()=>parcel('returned',[item('four','multipack',-1001,{has_returns:true,units_milli:0,returned_units_milli:1000,revenue_gross_cents:0,cost_gross_cents:0,sold_cash_cents:0,return_cash_cents:-1001,component_returns:[{...component,quantity_milli:4000}]})],{teslim_edilemedi:true,returns:1});
const partial=()=>parcel('partial',[item('set','bundle',550,{has_returns:true,partial_return:true,units_milli:null,returned_units_milli:null,sold_cash_cents:1000,return_cash_cents:-450,component_returns:[component]})],{channel:'hepsiburada',returns:1});

test('same stock product remains three distinct sold offerings and no stock-profit fallback is synthesized',()=>{
 const m=salesModel([ordinary(),partial(),{id:'old',channel:'trendyol',cash_cents:400,urunler:[{name:'Bare component profit',cash_cents:400}]}]);
 assert.deepEqual(m.all.map(g=>g.kind),['single','multipack','bundle']);
 assert.equal(m.missing_packages,1);assert.equal(m.all.some(g=>g.name==='Bare component profit'),false);assert.equal(m.summary.reconciled,false);
});
test('kind and search filters keep failed-delivery and partial-return effects in the exact date/channel total',()=>{
 const rows=[ordinary(),failed(),partial()],all=salesModel(rows),filtered=salesModel(rows,{kind:'single',query:'ORKİDE'});
 assert.deepEqual(filtered.summary,all.summary);assert.deepEqual(filtered.returns,all.returns);assert.equal(filtered.visible.length,1);
 assert.equal(all.summary.cash_cents,2550);assert.equal(all.summary.allocated_cash_cents,2550);assert.equal(all.summary.reconciled,true);
 assert.deepEqual(all.returns,{failed_count:1,returned_count:1,failed_cash_cents:-1001,returned_cash_cents:-450});
 const ty=salesModel(rows,{channel:'trendyol',kind:'single'});assert.equal(ty.summary.cash_cents,2000);assert.equal(ty.returns.returned_count,0);
});
test('zero-unit fully returned sales persist; partial component return never invents a net set count',()=>{
 const m=salesModel([failed(),partial()]);
 assert.equal(m.all[0].units_milli,0);assert.equal(m.all[0].cash_cents,-1001);assert.equal(m.all[1].units_milli,null);
 const html=salesListMarkup(m,{range});assert.match(html,/0 net satış/);assert.match(html,/Net satış adedi belirsiz/);assert.match(html,/Kısmi iade/);
 assert.match(html,/İade edilen: 1 adet Orkide bitki besini/);assert.match(html,/Ortak kargo paket hesabından paylaştırılır/);
});
test('hidden or unknown money stays unknown even when VAT-exclusive profit exists',()=>{
 const hidden=parcel('hidden',[item('single','single',null,{revenue_gross_cents:null,cost_gross_cents:null,sold_cash_cents:null,return_cash_cents:null})],{profit_cents:9000});
 const m=salesModel([hidden]);assert.equal(m.summary.cash_cents,null);assert.equal(m.all[0].cash_cents,null);assert.equal(m.summary.reconciled,false);
 const html=salesListMarkup(m,{range})+salesReturnsMarkup(m.returns);assert.match(html,/Bilgi eksik/);assert.doesNotMatch(html,/₺0,00/);assert.doesNotMatch(html.match(/<dl class="sales-amounts">([\s\S]*?)<\/dl>/)[1],/₺90,00/);
 const stats=performanceSummary([hidden]);assert.equal(stats.loss_cents,null);assert.equal(stats.losses,null);
});
test('mixed complete/incomplete groups have strict totals and a separately labelled known subtotal',()=>{
 const m=salesModel([ordinary(),parcel('unknown',[item('single','single',null)])]);
 assert.equal(m.all.find(g=>g.key==='single').cash_cents,null);assert.equal(m.all.find(g=>g.key==='single').calculated_cash_cents,2001);
 assert.equal(m.summary.cash_cents,null);assert.equal(m.summary.calculated_cash_cents,3001);assert.equal(m.summary.missing,1);
});
test('reconciliation checks revenue, cost and every package; cancelling mismatches cannot falsely match',()=>{
 const a=ordinary(),b=failed();a.cost_gross_cents+=1;b.cost_gross_cents-=1;
 const m=salesModel([a,b]);assert.equal(m.summary.difference_cents,0);assert.equal(m.summary.mismatched_packages,2);assert.equal(m.summary.reconciled,false);
 assert.match(salesListMarkup(m,{range}),/paket toplamıyla eşleşmiyor/);
});
test('multiple source lines preserve contributions without duplicating the package count',()=>{
 const m=salesModel([parcel('same',[item('single','single',2000),item('single','single',1000)])]);
 assert.equal(m.all[0].packages,1);assert.equal(m.all[0].contributions.length,2);assert.equal(m.all[0].cash_cents,3000);
});
test('search includes server component names and never truncates or injects markup',()=>{
 const name='Orkide üçlü set <script>alert(1)</script> çok uzun özgün satış adı';
 const m=salesModel([parcel('pkg',[item('set','bundle',2000,{name})])],{query:'BİTKİ BESİNİ'});
 assert.equal(m.visible.length,1);const html=salesListMarkup(m,{range,item:'set',donus:'performance?view=sales&kind=bundle'});
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/class="sales-row" open/);
 assert.match(html,/donus=performance%3Fview%3Dsales%26kind%3Dbundle/);
});
test('sales CSV includes unfiltered exact total, retained return effects and safe formula cells',()=>{
 const rows=[parcel('one',[item('single','single',2001,{name:'=HYPERLINK("bad")'})]),failed()];
 const csv=salesCsv({rows,from:range.from,to:range.to,unallocated_fee_cents:0},{kind:'single'});
 assert.match(csv,/"Dönem nakit TL";"10"/);assert.match(csv,/"Teslim edilemeyen paket";"1";"Nakit etkisi TL";"-10,01"/);
 assert.match(csv,/'=HYPERLINK/);assert.doesNotMatch(csv,/"Genel bitki besini · 4lü paket";/);
 const unknown=salesCsv({rows:[parcel('hidden',[item('s','single',null,{cost_gross_cents:null,revenue_gross_cents:null})])]},{});assert.match(unknown,/"Dönem ciro TL";"Bilgi eksik"/);
});
test('overview ranks sales only, keeps complete names, tags and date-scoped sales drilldown',()=>{
 const offering=item('four','multipack',1200),p={...range,key:'custom',sales:{rows:[offering],count:1},products:{top:[{name:'WRONG STOCK PROFIT',cash_cents:999999}]}};
 const html=panoramaSalesMarkup(p);assert.match(html,/Satış biçimine göre kazanç/);assert.match(html,/Genel bitki besini · 4lü paket/);assert.match(html,/Çoklu paket/);
 assert.doesNotMatch(html,/WRONG STOCK PROFIT/);assert.match(html,/view=sales/);assert.match(html,/item=four/);assert.match(html,/from=2026-09-01/);
 const noContract=panoramaSalesMarkup({...p,sales:undefined});assert.match(noContract,/Satış biçimi bilgisi henüz alınamadı/);assert.doesNotMatch(noContract,/WRONG STOCK PROFIT/);
 assert.doesNotMatch(panoramaSalesMarkup(p,{kind:'bundle'}),/Genel bitki besini/);
});
test('overview puts financial summary before date controls and separates pending statuses without borrowing total count',()=>{
 const p={key:'custom',...range,packages:1,calculated:1,cash_cents:2000,revenue_gross_cents:12000,channels:{},sales:{rows:[]}};
 const html=panoramaDetailMarkup({daily:[],pending:{packages:124,cash_cents:10000,preparing:{packages:100,cash_cents:7000},shipped:{packages:24,cash_cents:3000}}},p,{dateControls:'DATE-CONTROLS-MARKER'});
 assert.ok(html.indexOf('ins-kpis')<html.indexOf('DATE-CONTROLS-MARKER'));assert.match(html,/Hazırlanan<\/span><strong>100/);assert.match(html,/Kargoda<\/span><strong>24/);
 const unknown=pendingStatusMarkup({packages:124,cash_cents:0});assert.doesNotMatch(unknown,/124|₺0,00/);assert.match(unknown,/Bilgi eksik/);
});
test('paged sales reports publish only at terminal cursor and keep return-only pages',async()=>{
 const calls=[],scope={mode:'delivered',from:range.from,to:range.to};
 const rows=[ordinary(),failed(),partial()];
 const report=await loadPerformancePages({...scope,requestPage:async cursor=>{calls.push(cursor);const index=cursor?Number(cursor):0;return {...scope,channels:[],rows:index===1?[]:index===0?[rows[0]]:[rows[1],rows[2],rows[0]],sonraki_imlec:index<2?String(index+1):null};}});
 assert.deepEqual(calls,['','1','2']);assert.equal(report.rows.length,3);assert.equal(salesModel(report.rows).summary.cash_cents,2550);
});

test('technical twin correction remains outside real-return counts even when legacy return count is positive',()=>{
 const corrected=parcel('copy',[item('four','multipack',-100,{has_returns:false,technical_correction:true,units_milli:0,returned_units_milli:1000,return_cash_cents:-100,sold_cash_cents:0})],{returns:1});
 const m=salesModel([corrected]);assert.equal(m.returns.returned_count,0);assert.equal(m.returns.failed_count,0);assert.equal(m.summary.cash_cents,-100);
});

test('package CSV keeps original columns and filters but never relabels a net-only amount as VAT-inclusive',()=>{
 const row=parcel('net-only',[item('s','single',null)],{revenue_gross_cents:null,revenue_net_cents:10123,cost_gross_cents:null,cost_net_cents:5544,shipping_gross_cents:null,shipping_cents:1234});
 const csv=packageCsvWithGrossAmounts({rows:[row],mode:'delivered',from:range.from,to:range.to},{});
 assert.match(csv,/Satış KDV dahil TL/);assert.match(csv,/Bilgi eksik/);assert.doesNotMatch(csv,/"101,23"|"55,44"|"12,34"/);
 assert.equal(row.revenue_net_cents,10123,'source rows are not mutated');
});

test('an empty report cannot infer permission to reveal zero monetary return or loss values',()=>{
 const m=salesModel([]);assert.equal(m.summary.cash_cents,null);assert.equal(m.returns.failed_cash_cents,null);assert.equal(m.returns.returned_cash_cents,null);
 assert.equal(performanceSummary([]).loss_cents,null);assert.doesNotMatch(salesReturnsMarkup(m.returns),/₺0,00/);
});
