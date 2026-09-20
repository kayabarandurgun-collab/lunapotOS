import test from 'node:test';
import assert from 'node:assert/strict';
import {DATE_PRESETS,isISODate,validateDateRange,presetDateRange,parseDateRange,dateRangeQuery,dateRangeLink,dateRangeLabel,dateFilterMarkup,bindDateFilter} from '../public/date-range.js';
import {panoramaBuckets,niceTicks,panoramaDetailMarkup} from '../public/panorama-ui.js';
import {performanceSummary,performanceChannels,loadPerformancePages} from '../public/performance-ui.js';
const today='2026-09-20';

test('Preset tarihleri bugünü sayar; ay, yıl ve artık yıl sınırları tutarlıdır',()=>{
 assert.deepEqual(DATE_PRESETS.map(p=>p.key),['1g','7g','14g','30g','90g','180g','tum','custom']);
 for(const p of DATE_PRESETS.filter(p=>p.days)){
  const range=presetDateRange(p.key,{today});
  assert.equal((Date.parse(range.to)-Date.parse(range.from))/86400000+1,p.days,p.key);
 }
 assert.equal(presetDateRange('7g',{today:'2026-01-03'}).from,'2025-12-28');
 assert.equal(presetDateRange('7g',{today:'2024-03-01'}).from,'2024-02-24');
 assert.equal(presetDateRange('1g',{today}).from,today);
});
test('Tarih doğrulama çökmeksizin takvim dışı, eksik, ters ve tekrarlanan alanları reddeder',()=>{
 for(const day of ['2026-02-29','2026-13-01','2026-00-11','2026-04-31','NaN','0000-01-01','2026-9-1','',null])assert.equal(isISODate(day),false,String(day));
 assert.equal(isISODate('2024-02-29'),true);
 for(const query of ['from=2026-01-01','to=2026-01-01','from=2026-02-02&to=2026-01-01','from=2026-01-01&from=2026-01-02&to=2026-01-03','from=2026-13-01&to=2026-13-02','donem=custom']){
  const range=parseDateRange(query,{today});assert.ok(range.error,query);assert.throws(()=>dateRangeQuery(range));
 }
 assert.equal(validateDateRange('2026-09-20','2026-09-20'),null);
});
test('Hash içindeki somut tarihler preset yeniden hesaplanarak değiştirilmez',()=>{
 const range=parseDateRange('#overview?donem=7g&from=2025-12-26&to=2026-01-01',{today});
 assert.deepEqual(range,{preset:'7g',from:'2025-12-26',to:'2026-01-01',error:null});
 assert.equal(dateRangeQuery(range),'from=2025-12-26&to=2026-01-01');
 assert.equal(parseDateRange('#orders?from=2024-02-01&to=2024-02-29',{today}).preset,'custom');
 assert.equal(parseDateRange('',{today}).from,'2026-08-22');
});
test('Tüm dönem bilinmeyen ilk tarihi uydurmaz ve API varsayılanıyla karıştırılmaz',()=>{
 const unknown=parseDateRange('donem=tum',{today});
 assert.deepEqual(unknown,{preset:'tum',from:'',to:'',error:null});
 assert.equal(dateRangeQuery(unknown),'');
 assert.equal(dateRangeLink('#overview?from=2025-01-01&to=2025-01-02',unknown),'#overview?donem=tum');
 const known=presetDateRange('tum',{today,firstDate:'2022-04-03'});
 assert.equal(known.from,'2022-04-03');assert.equal(known.to,today);
});
test('Rapor, sipariş ve stok bağlantıları tarihi ve kendi filtrelerini korur',()=>{
 const range=parseDateRange('from=2026-09-01&to=2026-09-20',{today});
 const link=dateRangeLink('#orders?watch=long_shipping&from=2020-01-01',range,{package:'id & / özel',channel:'trendyol',donus:'performance?from=2026-09-01&to=2026-09-20'});
 const query=new URLSearchParams(link.split('?')[1]);
 assert.equal(query.get('watch'),'long_shipping');assert.equal(query.get('package'),'id & / özel');assert.equal(query.get('from'),range.from);assert.equal(query.get('to'),range.to);assert.equal(query.getAll('from').length,1);
 assert.equal(new URLSearchParams(dateRangeLink('#stock?filter=low',range).split('?')[1]).get('filter'),'low');
 assert.equal(new URLSearchParams(dateRangeLink('#performance?result=loss',range,{channel:'hepsiburada'}).split('?')[1]).get('result'),'loss');
});
test('Tarih etiketleri yıl içerir; erişilebilir form hata ve yükleme durumlarını gösterir',()=>{
 const range=parseDateRange('from=2025-12-30&to=2026-01-02',{today});
 assert.match(dateRangeLabel(range),/2025.*2026/);
 const html=dateFilterMarkup({...range,error:'<script>bad</script>'},{busy:true,basis:'Sipariş tarihi'});
 assert.match(html,/aria-busy="true"/);assert.match(html,/name="from"/);assert.match(html,/name="to"/);assert.match(html,/disabled/);assert.match(html,/role="alert"/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
});
test('Ortak tarih formu geçersiz aralıkta istek yapmaz; düzeltince custom callback çağırır',()=>{
 const listeners={},changes=[],box={},fields={from:{value:'2026-09-20'},to:{value:'2026-09-01',setAttribute(){},focus(){}}};
 const form={matches:s=>s==='[data-date-form]',elements:{namedItem:key=>fields[key]},closest:()=>({querySelector:()=>box})};
 const root={addEventListener:(key,handler)=>listeners[key]=handler,removeEventListener:(key)=>delete listeners[key]};
 const unbind=bindDateFilter(root,{today,onChange:range=>changes.push(range)});
 listeners.submit({target:form,preventDefault(){}});assert.equal(changes.length,0);assert.equal(box.hidden,false);
 fields.to.value='2026-09-21';listeners.submit({target:form,preventDefault(){}});
 assert.equal(changes.length,1);assert.equal(changes[0].preset,'custom');assert.equal(changes[0].from,'2026-09-20');assert.equal(box.hidden,true);
 unbind();assert.equal(Object.keys(listeners).length,0);
});
test('Grafik günlük/haftalık/aylık gruplamada aynı nakit tutarını ve negatifleri korur',()=>{
 const daily=Array.from({length:450},(_,i)=>({date:new Date(Date.parse('2025-01-01')+i*86400000).toISOString().slice(0,10),trendyol:i%2?-700:1000,hepsiburada:300,packages:2}));
 for(const count of [1,31,32,400,450]){
  const period={from:daily[0].date,to:daily[count-1].date},actual=panoramaBuckets(daily,period);
  assert.equal(actual.unit,count<=31?'day':count<=400?'week':'month');
  assert.equal(actual.buckets.reduce((t,b)=>t+b.trendyol+b.hepsiburada,0),daily.slice(0,count).reduce((t,b)=>t+b.trendyol+b.hepsiburada,0));
  assert.equal(actual.buckets.reduce((t,b)=>t+b.packages,0),count*2);
 }
 assert.ok(niceTicks(-3800,11000).includes(0));assert.ok(niceTicks(0,0).length>1);
});
test('Rapor marjı yalnız ortak kapsamda hesaplanır; bilinmeyen nakit ve ciro sıfır değildir',()=>{
 const rows=[{cash_cents:500,revenue_gross_cents:2000},{cash_cents:-200,revenue_gross_cents:1000},{cash_cents:null,revenue_gross_cents:4000},{cash_cents:900,revenue_gross_cents:null}];
 const summary=performanceSummary(rows);
 assert.equal(summary.cash_cents,1200);assert.equal(summary.revenue_gross_cents,7000);assert.equal(summary.margin_bps,1000);assert.equal(summary.margin_packages,2);assert.equal(summary.missing,1);assert.equal(summary.revenue_missing,1);assert.equal(summary.losses,1);assert.equal(summary.loss_cents,-200);
 const unknown=performanceSummary([{cash_cents:null,revenue_gross_cents:null}]);assert.equal(unknown.cash_cents,null);assert.equal(unknown.revenue_gross_cents,null);assert.equal(unknown.margin_bps,null);
 const zero=performanceSummary([{cash_cents:0,revenue_gross_cents:0}]);assert.equal(zero.cash_cents,0);assert.equal(zero.margin_bps,null);
});
test('Panorama eksik tutarı, stok anlık görüntüsünü ve tüm ürün adını doğru işaretler',()=>{
 const p={key:'custom',label:'Özel',from:'2026-09-01',to:'2026-09-20',packages:1,calculated:0,missing:1,revenue_missing:1,cash_cents:0,revenue_gross_cents:null,margin_bps:null,losses:0,loss_cents:0,gains:0,gain_cents:0,products:{revenue_top:[{name:'Uzun ürün adı <script>test</script> 100 litre toprak karışımı',revenue_gross_cents:null,qty_milli:1000}],top:[]},channels:{}};
 const html=panoramaDetailMarkup({daily:[],inventory:{net_cents:450000,gross_cents:null,missing_vat_products:1,negative_products:1,gross_estimated:true,calculated_gross_cents:10000},pending:{from:p.from,to:p.to,packages:1,calculated:0,missing:1,cash_cents:0}},p);
 assert.match(html,/Eksik kapsam/);assert.match(html,/Güncel stok/);assert.match(html,/Tarih filtresinden bağımsız/);assert.match(html,/KDV hariç/);assert.match(html,/1 ürünün KDV oranı eksik/);assert.match(html,/Uzun ürün adı &lt;script&gt;test&lt;\/script&gt; 100 litre toprak karışımı/);assert.ok(!html.includes('<script>'));assert.match(html,/Hesap eksik/);assert.match(html,/Bilgi eksik/);
});

test('Tamamen alınamayan dönem sıfır nakit veya teslim yok gibi sunulmaz',()=>{
 const p={key:'custom',from:'2026-01-01',to:'2026-01-10',packages:0,calculated:0,calculated_cash_cents:null,cash_cents:0,profit_ex_vat_cents:0,revenue_gross_cents:null,partial:true,channels:{},products:{},records:{partial:true}};
 const html=panoramaDetailMarkup({daily:[],inventory:{},pending:null},p);
 assert.match(html,/Paket sayısı alınamadı/);assert.match(html,/Dönem verisinin bir bölümü alınamadı/);assert.match(html,/KDV hariç katkı: Bilgi eksik/);
 assert.ok(!html.includes('Bu aralıkta teslim kaydı yok'));
 const cash=html.match(/<article class="ins-kpi ins-kpi-primary">([\s\S]*?)<\/article>/)[1];assert.match(cash,/Bilgi eksik/);assert.ok(!cash.includes('₺0,00'));
});
test('Yetki nedeniyle gizli günlük tutarlar kovada sıfıra dönüşmez ve grafik çizilmez',()=>{
 const daily=[{date:'2026-09-01',trendyol:null,hepsiburada:null,packages:2},{date:'2026-09-02',trendyol:null,hepsiburada:null,packages:1}];
 const p={key:'custom',from:'2026-09-01',to:'2026-09-02',packages:3,calculated:3,cash_cents:null,profit_ex_vat_cents:null,revenue_gross_cents:null,channels:{},products:{},records:{}};
 assert.equal(panoramaBuckets(daily,p).buckets[0].trendyol,null);
 const longer=Array.from({length:35},(_,i)=>({date:new Date(Date.parse('2026-08-01')+i*86400000).toISOString().slice(0,10),trendyol:i?0:null,hepsiburada:100,packages:1}));
 assert.equal(panoramaBuckets(longer,{from:longer[0].date,to:longer.at(-1).date}).buckets[0].trendyol,null);
 const html=panoramaDetailMarkup({daily,inventory:{},pending:null},p);
 assert.ok(!html.includes('data-pn-chart'));assert.match(html,/Grafik için hesap bilgisi eksik/);assert.match(html,/data-label="Toplam"><b>Bilgi eksik/);
});
test('Ürün ve rekor kapsamı açıklanır; çok paketli rekor ana panonun tarihine döner',()=>{
 const p={key:'custom',from:'2026-09-01',to:'2026-09-20',packages:3,calculated:2,cash_cents:4000,loss_cents:0,gain_cents:4000,channels:{},products:{missing_packages:1,revenue_top:[{name:'Eksik ürün',qty_milli:1000,revenue_gross_cents:4000,revenue_missing:1}],top:[]},records:{revenue_missing_orders:1,profit_missing_orders:1,revenue:{id:'x',order_no:'123',packages:2,revenue_gross_cents:4000,cash_cents:1000}}};
 const html=panoramaDetailMarkup({daily:[],inventory:{},pending:null},p);
 assert.match(html,/ciro alt toplamdır/);assert.match(html,/1 paketin ürün dağılımı eksik/);assert.match(html,/2 paketin toplamı; bağlantı bir paketi açar/);assert.match(html,/1 sipariş ciro, 1 sipariş nakit/);assert.match(html,/donus=overview%3Fdonem%3Dcustom%26from%3D2026-09-01%26to%3D2026-09-20/);
 assert.match(html,/role="tablist"/);assert.match(html,/data-product-panel="profit" hidden/);
});
test('Hazır dönemde özel form kapalı, özel aralıkta ve hatada açıktır',()=>{
 const range=presetDateRange('7g',{today});
 assert.match(dateFilterMarkup(range),/<div data-date-custom hidden>/);
 assert.match(dateFilterMarkup({...range,preset:'custom'}),/<div data-date-custom >/);
 assert.match(dateFilterMarkup({...range,error:'Geçersiz tarih'}),/<div data-date-custom >/);
});

const pageScope={mode:'delivered',from:'2026-09-20',to:'2026-09-20'};
const reportPage=(rows,next,extra={})=>({...pageScope,rows,sonraki_imlec:next,channels:[{channel:'trendyol',packages:99999,cash_cents:99999999,awaiting_delivery:7,awaiting_delivery_since:'2026-08-01'},{channel:'hepsiburada',awaiting_delivery:0,awaiting_delivery_since:null}],unallocated_fee_cents:1500,as_of:'2026-09-20T12:00:00Z',notice:'Aynı ekonomik sonuç motoru',cost_notice:'Ortak giderler hariç',...extra});

test('Sayfalı yükleyici aynı gündeki 1005 paketi sırayla, tekilleştirerek ve tümü tamamlanınca döndürür',async()=>{
 const rows=Array.from({length:1005},(_,i)=>({id:'p'+String(i).padStart(4,'0'),channel:i%2?'hepsiburada':'trendyol',delivered_on:pageScope.to,cash_cents:i%11?-100:700,profit_cents:i%11?-80:600,revenue_gross_cents:1000}));
 const requests=[],progress=[];let inFlight=0,maxInFlight=0;
 const result=await loadPerformancePages({...pageScope,requestPage:async cursor=>{
  requests.push(cursor);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await Promise.resolve();inFlight--;
  return cursor===''?reportPage(rows.slice(0,1000),'p0999'):reportPage([{...rows[0],cash_cents:99999999},...rows.slice(1000)],null,{channels:[{channel:'trendyol',awaiting_delivery:99,awaiting_delivery_since:'2026-09-01'}],unallocated_fee_cents:9999});
 },onProgress:x=>progress.push(x)});
 assert.deepEqual(requests,['','p0999']);assert.equal(maxInFlight,1);assert.equal(result.rows.length,1005);assert.equal(result.rows[0].cash_cents,rows[0].cash_cents,'tekrarlanan ikiz ilk görüldüğü haliyle sayılır');
 assert.equal(result.pages_loaded,2);assert.equal(result.sonraki_imlec,null);
 assert.equal(result.unallocated_fee_cents,1500,'çalışma alanı metadata tutarı bir kez korunur');
 assert.equal(result.channels.find(c=>c.channel==='trendyol').awaiting_delivery,7);assert.equal(result.channels.find(c=>c.channel==='trendyol').awaiting_delivery_since,'2026-08-01');
 for(const channel of ['trendyol','hepsiburada']){
  const subset=rows.filter(r=>r.channel===channel),c=result.channels.find(x=>x.channel===channel);
  assert.equal(c.packages,subset.length);assert.equal(c.cash_calculated,subset.length);assert.equal(c.cash_cents,subset.reduce((s,r)=>s+r.cash_cents,0));assert.equal(c.profit_cents,subset.reduce((s,r)=>s+r.profit_cents,0));assert.equal(c.cash_losses,subset.filter(r=>r.cash_cents<0).length);
 }
 assert.deepEqual(progress,[{pages:1,packages:1000},{pages:2,packages:1005}]);
 assert.ok(progress.every(p=>!('rows'in p)&&!('cash_cents'in p)),'ilerleme kısmi mali sonuç yayımlamaz');
});
test('Boş veya kısa sayfa non-null imleçle devam eder; tümü null kanalda sıfır kâr uydurulmaz',async()=>{
 const requests=[],items=[{id:'z1',channel:'trendyol',cash_cents:null,profit_cents:null,revenue_gross_cents:null},{id:'z2',channel:'hepsiburada',cash_cents:0,profit_cents:0,revenue_gross_cents:0}];
 const result=await loadPerformancePages({...pageScope,mode:'pending',requestPage:async cursor=>{
  requests.push(cursor);return reportPage(cursor===''?[]:cursor==='filtered'?items.slice(0,1):items.slice(1),cursor===''?'filtered':cursor==='filtered'?'z1':null,{mode:'pending'});
 }});
 assert.deepEqual(requests,['','filtered','z1']);assert.equal(result.rows.length,2);
 const ty=result.channels.find(c=>c.channel==='trendyol'),hb=result.channels.find(c=>c.channel==='hepsiburada');
 assert.equal(ty.cash_cents,null);assert.equal(ty.calculated_cash_cents,null);assert.equal(ty.profit_cents,null);assert.equal(ty.calculated_profit_cents,null);assert.equal(ty.missing,1);assert.equal(ty.cash_calculated,0);
 assert.equal(hb.cash_cents,0);assert.equal(hb.profit_cents,0);assert.equal(hb.cash_calculated,1);
 const empty=performanceChannels([],[])[0];assert.equal(empty.packages,0);assert.equal(empty.cash_cents,null);assert.equal(empty.calculated_cash_cents,null);assert.equal(empty.awaiting_delivery,null);
});
test('Kanal toplamı tam ve hesaplanabilen kapsamı ayırır; nakit/profit null alanları bağımsız korunur',()=>{
 const rows=[{id:'a',channel:'trendyol',cash_cents:1000,profit_cents:null},{id:'b',channel:'trendyol',cash_cents:null,profit_cents:800},{id:'c',channel:'trendyol',cash_cents:-200,profit_cents:-150}];
 const c=performanceChannels(rows,[{channel:'trendyol',awaiting_delivery:0,awaiting_delivery_since:null}])[0];
 assert.equal(c.packages,3);assert.equal(c.cash_cents,null);assert.equal(c.profit_cents,null);assert.equal(c.calculated_cash_cents,800);assert.equal(c.calculated_profit_cents,650);assert.equal(c.cash_calculated,2);assert.equal(c.calculated,2);assert.equal(c.missing,1);assert.equal(c.cash_losses,1);assert.equal(c.losses,1);assert.equal(c.awaiting_delivery,0);
});
test('İkinci sayfa hatasında ilk 1000 paket tamamlanmış rapor olarak dönmez',async()=>{
 let published=false,calls=0;const progress=[];
 await assert.rejects(loadPerformancePages({...pageScope,requestPage:async cursor=>{
  calls++;if(cursor)throw Error('İkinci sayfa bağlantı hatası');return reportPage(Array.from({length:1000},(_,i)=>({id:'p'+i,channel:'trendyol',cash_cents:100,profit_cents:80})),'p999');
 },onProgress:x=>progress.push(x)}).then(()=>{published=true;}),/İkinci sayfa bağlantı hatası/);
 assert.equal(published,false);assert.equal(calls,2);assert.deepEqual(progress,[{pages:1,packages:1000}]);
});
test('Yeni seçim veya iptal eski yüklemenin sayfalarını yayımlamaz ve ek istek yapmaz',async()=>{
 let current=true,calls=0;const progress=[];
 await assert.rejects(loadPerformancePages({...pageScope,isCurrent:()=>current,requestPage:async()=>{calls++;current=false;return reportPage([{id:'a',channel:'trendyol',cash_cents:100}],null);},onProgress:p=>progress.push(p)}),{name:'AbortError'});
 assert.equal(calls,1);assert.deepEqual(progress,[]);
 const abort=new AbortController();calls=0;
 await assert.rejects(loadPerformancePages({...pageScope,signal:abort.signal,requestPage:async()=>{calls++;return reportPage([{id:'a',channel:'trendyol'}],'a');},onProgress:()=>abort.abort()}),{name:'AbortError'});
 assert.equal(calls,1);
 await assert.rejects(loadPerformancePages({...pageScope,signal:abort.signal,requestPage:async()=>{calls++;}}),{name:'AbortError'});assert.equal(calls,1);
 current=true;await assert.rejects(loadPerformancePages({...pageScope,isCurrent:()=>current,requestPage:async()=>reportPage([],null),onProgress:()=>{current=false;}}),{name:'AbortError'},'son sayfadan sonra bile eski yükleme yayımlanmaz');
});
test('Tekrarlı veya kayıp imleç ve farklı kapsam sessiz kısmi başarıya dönüşmez',async()=>{
 let calls=0;
 await assert.rejects(loadPerformancePages({...pageScope,requestPage:async()=>{calls++;return reportPage([],'repeat');}}),/bütün sayfaları/);assert.equal(calls,2);
 for(const invalid of [undefined,'',4])await assert.rejects(loadPerformancePages({...pageScope,requestPage:async()=>reportPage([],invalid)}),/bütün sayfaları/);
 for(const extra of [{mode:'pending'},{from:'2026-09-19'},{to:'2026-09-21'},{rows:null},{channels:null}])await assert.rejects(loadPerformancePages({...pageScope,requestPage:async()=>reportPage([],null,extra)}),/kapsam bilgisi/);
 await assert.rejects(loadPerformancePages({...pageScope,requestPage:async()=>reportPage([{channel:'trendyol'}],null)}),/kimliği/);
});

import {appFixture} from './helpers/app-fixture.js';
test('Gerçek performans API imleciyle 1005 aynı gün paketi ön yüz yükleyicisinde eksiksiz birleşir',async()=>{
 const f=appFixture();try{
  await f.setup();
  f.sqlite.exec("INSERT INTO ec_products(id,name,sku,stock_unit) VALUES('cursor-product','Temsili ürün','CURSOR','adet'); UPDATE ec_stock_balances SET quantity_milli=10000000,value_cents=46000000");
  const insert=f.sqlite.prepare("INSERT INTO ec_order_packages(id,channel,external_id,order_no,occurred_on,status,source_fingerprint) VALUES(?,'trendyol',?,?,'2026-09-20','draft','cursor-test')");
  f.sqlite.exec('BEGIN');for(let i=0;i<1005;i++){const id='ui-page-'+String(i).padStart(4,'0');insert.run(id,'E-'+id,'O-'+id);}
  f.sqlite.exec(`INSERT INTO ec_order_lines(id,package_id,external_id,name,quantity_milli,net_revenue_cents,gross_cents,vat_bps) SELECT 'l-'||id,id,'L-'||id,'Ürün',1000,11000,13200,2000 FROM ec_order_packages;
   INSERT INTO ec_sale_entries(id,channel,external_id,product_id,kind,quantity_milli,revenue_cents,cost_cents,commission_cents,shipping_cents,other_cents,fees_status,occurred_on) SELECT 's-'||id,'trendyol','S-'||id,'cursor-product','sale',1000,11000,4600,1610,3000,500,'confirmed','2026-09-20' FROM ec_order_packages;
   INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,sale_id,stock_unit) SELECT 'c-'||id,'l-'||id,'cursor-product',1000,10000,'s-'||id,'adet' FROM ec_order_packages;
   UPDATE ec_order_packages SET status='reserved'; UPDATE ec_order_packages SET status='shipped',shipped_on='2026-09-20'; UPDATE ec_order_packages SET status='delivered',delivered_on='2026-09-20'; COMMIT`);
  assert.equal((await f.req('/ec/performance?mode=delivered&from=2026-09-20&to=2026-09-20')).status,409,'imleçsiz eski sözleşme korunur');
  const requests=[],sizes=[];
  const report=await loadPerformancePages({...pageScope,requestPage:async cursor=>{
   requests.push(cursor);const data=await f.ok('/ec/performance?'+new URLSearchParams({...pageScope,cursor}));sizes.push(data.rows.length);return data;
  }});
  assert.deepEqual(requests,['','ui-page-0999']);assert.deepEqual(sizes,[1000,5]);assert.equal(report.rows.length,1005);assert.equal(new Set(report.rows.map(r=>r.id)).size,1005);assert.equal(report.rows.at(-1).id,'ui-page-1004');
  const channel=report.channels.find(c=>c.channel==='trendyol');assert.equal(channel.packages,1005);assert.equal(channel.awaiting_delivery,0);assert.equal(channel.cash_calculated,0);assert.equal(channel.calculated_cash_cents,null,'KDV bilgisi eksik paketler sıfır nakit sayılmaz');
 }finally{f.close();}
});


test('Açıklayıcı cost_note tek başına tahmin değildir; yalnız backend tahmin işaretleri sayılır',()=>{
 const confirmed={cash_cents:100,profit_cents:80,revenue_gross_cents:500,cost_note:'Kesinleşmiş iadenin kayıtlı maliyeti.'};
 assert.equal(performanceSummary([confirmed]).estimated,0);
 assert.equal(performanceSummary([confirmed,{...confirmed,fees_estimated:true},{...confirmed,cost_estimated:true},{...confirmed,assumptions_source:'history'}]).estimated,3);
});
