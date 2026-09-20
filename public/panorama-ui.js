import {parseDateRange,dateRangeLink,dateRangeLabel,dateFilterMarkup,bindDateFilter} from './date-range.js';
// GENEL DURUM (ana sayfa). Teslim edilenlerin cebine kalanı altı dönemde yan yana; seçili dönemin
// günlük/haftalık grafiği, Trendyol–Hepsiburada payı, kargodakilerin tahmini ve ürün sıralaması.
// Veri: GET /api/ec/panorama (kâr raporuyla aynı hesap). Grafik satır içi SVG'dir: CSP dış betik ve
// satır içi stile izin vermez; renkler ui-polish.css sınıflarından gelir. Etiketler textContent ile yazılır.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TL=new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'});
const money=v=>v==null||!Number.isFinite(v)?'Bilgi eksik':TL.format(v/100);
const kisa=v=>{const a=Math.abs(v/100);return (v<0?'−':'')+(a<1000?Math.round(a).toLocaleString('tr-TR'):new Intl.NumberFormat('tr-TR',{notation:'compact',maximumFractionDigits:a<10000?1:0}).format(a))+' ₺';};
const sayi=v=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:3}).format(v/1000);
const AY=['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
const gunAd=d=>+d.slice(8)+' '+AY[+d.slice(5,7)-1];
const KANAL={trendyol:'Trendyol',hepsiburada:'Hepsiburada'},KANALLAR=['trendyol','hepsiburada'],SINIF={trendyol:'pn-ty',hepsiburada:'pn-hb'};
const ONCEKI={'1g':'düne','7g':'önceki 7 güne','14g':'önceki 14 güne','30g':'önceki 30 güne','90g':'önceki 90 güne','180g':'önceki 180 güne'};
const scope=p=>({preset:p.key||'custom',from:p.from,to:p.to,error:null});
const rapor=(p,ek={})=>dateRangeLink('#performance',scope(p),{view:'packages',...ek});
const bucketTotal=b=>Number.isFinite(b.trendyol)&&Number.isFinite(b.hepsiburada)?b.trendyol+b.hepsiburada:null;
const svgEl=(tag,attrs={})=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};

// Grafik kovaları: 31 güne kadar günlük; 400 güne kadar bugünden geriye 7 günlük; sonrası takvim ayı.
export function panoramaBuckets(daily,period){
 const gunler=daily.filter(g=>g.date>=period.from&&g.date<=period.to);
 const sum=(part,key)=>part.every(g=>Number.isFinite(g[key]))?part.reduce((t,g)=>t+g[key],0):null;
 const topla=(part,label)=>({from:part[0].date,to:part.at(-1).date,label,days:part.length,
  trendyol:sum(part,'trendyol'),hepsiburada:sum(part,'hepsiburada'),packages:part.reduce((t,g)=>t+g.packages,0)});
 if(gunler.length<=31)return {unit:'day',buckets:gunler.map(g=>topla([g],gunAd(g.date)))};
 if(gunler.length<=400){
  const out=[];for(let son=gunler.length-1;son>=0;son-=7){const part=gunler.slice(Math.max(0,son-6),son+1);out.unshift(topla(part,part.length>1?gunAd(part[0].date)+'–'+gunAd(part.at(-1).date):gunAd(part[0].date)));}
  return {unit:'week',buckets:out};
 }
 const aylar=new Map();for(const g of gunler){const k=g.date.slice(0,7);aylar.set(k,[...(aylar.get(k)||[]),g]);}
 return {unit:'month',buckets:[...aylar.values()].map(part=>topla(part,AY[+part[0].date.slice(5,7)-1]+' '+part[0].date.slice(0,4)))};
}

// Eksen için yuvarlak adımlar (1, 2, 2,5, 5 × 10ⁿ).
export function niceTicks(min,max,count=4){
 if(max===min){max=min+10000;}
 const kaba=(max-min)/count,us=10**Math.floor(Math.log10(kaba)),adim=[1,2,2.5,5,10].map(x=>x*us).find(x=>x>=kaba);
 const lo=Math.floor(min/adim)*adim,hi=Math.ceil(max/adim)*adim,out=[];
 for(let v=lo;v<=hi+adim/2;v+=adim)out.push(Math.round(v));
 return out;
}

function delta(p){
 if(p.partial||p.missing||p.cash_cents==null||p.prev_cash_cents==null)return null;
 const fark=p.cash_cents-p.prev_cash_cents,yon=fark>0?'up':fark<0?'down':'flat',ok=fark>0?'▲':fark<0?'▼':'■';
 // Önceki dönem çok küçükse (veri yeni başlamış) yüzde yanıltır (%1.842 gibi): fark tutar olarak yazılır.
 const oran=p.prev_cash_cents>0?Math.round(fark*100/p.prev_cash_cents):null;
 const metin=oran!==null&&Math.abs(oran)<=200?'%'+Math.abs(oran).toLocaleString('tr-TR'):kisa(Math.abs(fark));
 return {yon,metin:ok+' '+metin,uzun:(ONCEKI[p.key]||'önceki döneme')+' göre '+(fark>=0?'+':'−')+money(Math.abs(fark))+' (önceki: '+money(p.prev_cash_cents)+')'};
}

function periodButton(p,selected,route='#overview'){
 return `<a class="pn-period${p.key===selected?' is-selected':''}" href="${esc(dateRangeLink(route,scope(p)))}" ${p.key===selected?'aria-current="true"':''}><span class="pn-period-label">${esc(p.label)}</span><strong>${p.packages?money(p.calculated===0?null:p.cash_cents):p.partial?'Hesap eksik':'Teslim yok'}</strong><small>Ciro ${money(p.revenue_gross_cents)}</small><span class="pn-period-loss">${p.losses??'—'} zarar · ${money(p.loss_cents)}</span>${p.partial||p.missing?'<small>Eksik kapsam</small>':p.estimated?'<small>Tahmini tutar içerir</small>':''}</a>`;
}
function shareBar(p){
 const channels=p.channels||{},total=KANALLAR.reduce((sum,k)=>sum+Math.max(0,channels[k]?.cash_cents||0),0);
 return `<div class="pn-share-rows">${KANALLAR.map(k=>{const c=channels[k];
  if(!c)return `<div class="ins-empty">${KANAL[k]} · Bilgi alınamadı</div>`;
  return `<a href="${esc(rapor(p,{channel:k}))}"><span class="ins-channel-name"><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i>${KANAL[k]}</span><strong class="${c.cash_cents<0?'is-negative':''}">${c.packages===0?(p.partial?'Kapsam eksik':'Paket yok'):money(c.calculated===0?null:c.cash_cents)}</strong><small>${c.packages??'—'} paket · ${c.calculated??'—'} hesaplandı</small>${c.revenue_gross_cents!=null?`<small>Ciro ${money(c.revenue_gross_cents)}</small>`:''}<div class="pn-product-meter" aria-hidden="true"><span class="${SINIF[k]}" data-pay="${total?Math.round(Math.max(0,c.cash_cents||0)*1000/total):0}"></span></div></a>`;}).join('')}</div><p class="help">Çubuklar pozitif nakit toplamındaki payı gösterir. Zarar tutarları ayrıca görünür.</p>`;
}

const SALES_KINDS={single:'Tekli',multipack:'Çoklu paket',bundle:'Set'};
function salesRankList(title,list,metric,p){
 if(!list?.length)return `<div class="pn-products-group"><h3>${title}</h3><p class="ins-empty">Bu kapsamda hesaplanabilen satış biçimi yok.</p></div>`;
 const max=Math.max(1,...list.filter(u=>Number.isFinite(u[metric])).map(u=>Math.abs(u[metric])));
 return `<div class="pn-products-group"><h3>${title}</h3><ol>${list.map(u=>`<li><a class="pn-sale-link" href="${esc(rapor(p,{view:'sales',item:u.key}))}"><div class="pn-product-line"><span class="pn-product-name">${esc(u.name)}</span><strong class="${u[metric]<0?'is-negative':''}">${money(u[metric])}</strong></div><span class="sales-kind">${esc(SALES_KINDS[u.kind]||'Biçim bilgisi eksik')}</span><div class="pn-product-meter" aria-hidden="true"><span class="${u[metric]<0?'neg':'pos'}" data-pay="${Number.isFinite(u[metric])?Math.round(Math.abs(u[metric])*1000/max):0}"></span></div><small>${u.units_milli==null?'Net satış adedi belirsiz':sayi(u.units_milli)+' net satış'} · ${metric==='cash_cents'?'Ciro '+money(u.revenue_gross_cents):'Cebine kalan '+money(u.cash_cents)}${u.partial_returns?' · kısmi iade':''}${u.missing?' · hesap eksik':''}</small></a></li>`).join('')}</ol></div>`;
}
export function panoramaSalesMarkup(p,{kind=''}={}){
 const sales=p.sales;
 const rows=Array.isArray(sales?.rows)?sales.rows.filter(r=>!kind||r.kind===kind):null;
 const rank=(metric,ascending=false)=>rows?[...rows].filter(r=>Number.isFinite(r[metric])).sort((a,b)=>(ascending?1:-1)*(a[metric]-b[metric])).slice(0,5):null;
 const top=rank('cash_cents')??sales?.top,bottom=rank('cash_cents',true)??sales?.bottom,revenue=rank('revenue_gross_cents')??sales?.revenue_top;
 return `<section class="pn-card pn-products" data-sales-rankings><div class="pn-head"><div><span class="eyebrow">SATIŞ BİÇİMLERİ · KDV DAHİL</span><h2>Satış biçimine göre kazanç</h2></div><a class="text-button" href="${esc(rapor(p,{view:'sales',kind}))}">Satış biçimlerini incele →</a></div><p class="help">Depoda ürün sayılır; burada sattığın tekli ürün, paket veya setin sonucu görünür.</p>
 ${!sales?'<p class="ins-quality">Satış biçimi bilgisi henüz alınamadı. Paket dökümünde mevcut sonuçları inceleyebilirsin.</p>':''}
 ${sales?.missing_packages?`<p class="ins-quality">${sales.missing_packages} paketin satış biçimi dağılımı eksik; dönem toplamı üstte korunur.</p>`:''}
 <div class="sales-rank-tools"><div class="ins-product-tabs" role="tablist" aria-label="Satış biçimi sıralaması"><button type="button" role="tab" id="pn-profit-tab" aria-controls="pn-profit-products" aria-selected="true" data-product-view="profit">Kazanç</button><button type="button" role="tab" id="pn-revenue-tab" aria-controls="pn-revenue-products" aria-selected="false" tabindex="-1" data-product-view="revenue">Ciro</button></div>${rows?`<label class="sales-rank-kind">Biçim<select data-panorama-kind><option value="">Tümü</option>${Object.entries(SALES_KINDS).map(([id,label])=>`<option value="${id}" ${kind===id?'selected':''}>${label}</option>`).join('')}</select></label>`:''}</div>
 <div id="pn-profit-products" role="tabpanel" aria-labelledby="pn-profit-tab" data-product-panel="profit">${salesRankList('En çok kazandıran',top,'cash_cents',p)}${bottom?.length?`<details><summary>En az kazandıran ve zarar eden satış biçimleri</summary>${salesRankList('Düşük sonuçlu satış biçimleri',bottom,'cash_cents',p)}</details>`:''}</div>
 <div id="pn-revenue-products" role="tabpanel" aria-labelledby="pn-revenue-tab" data-product-panel="revenue" hidden>${salesRankList('En çok ciro getiren',revenue,'revenue_gross_cents',p)}</div><p class="help">Tür seçimi yalnız sıralamayı değiştirir. İade ve geri dönüş etkileri dönem toplamının içindedir.</p></section>`;
}
export function pendingStatusMarkup(pending){
 return `<div class="sales-pending-status" aria-label="Bekleyen paketlerin durumu">${[['preparing','Hazırlanan'],['shipped','Kargoda']].map(([key,label])=>{const part=pending?.[key];return `<div><span>${label}</span><strong>${part?.packages??'—'} <small>paket</small></strong><small>${money(part?.cash_cents)} · tahmini</small>${part?.missing?`<small>${part.missing} paket hesap bekliyor</small>`:''}</div>`;}).join('')}</div>`;
}
function periodReturnsMarkup(returns){
 if(!returns)return '';
 return `<aside class="sales-return-summary" aria-label="İade ve geri dönüş etkisi"><span><b>${returns.failed_count??'—'}</b> teslim edilemedi <strong>${money(returns.failed_cash_cents)}</strong></span><span><b>${returns.returned_count??'—'}</b> iade içeren paket <strong>${money(returns.returned_cash_cents)}</strong></span><small>İade / geri dönüş nakit etkisi dönem toplamına dahildir.</small></aside>`;
}

function recordCard(title,record,metric,p){
 if(!record)return `<article class="ins-record"><span class="eyebrow">${title}</span><strong>Henüz hesaplanamadı</strong><small>${p.partial?'Dönemin bir bölümü alınamadı.':'Seçili dönemde hesaplanabilen uygun kayıt yok.'}</small></article>`;
 const id=record.package_id||record.id;
 const href=id?dateRangeLink('#orders',scope(p),{package:id,donus:dateRangeLink('#overview',scope(p)).slice(1)}):rapor(p);
 return `<a class="ins-record" href="${esc(href)}"><span class="eyebrow">${title}</span><strong class="${record[metric]<0?'is-negative':''}">${money(record[metric])}</strong><span>${esc(record.order_no||record.external_id||'Sipariş ayrıntısı')} →</span><small>${esc(KANAL[record.channel]||record.channel||'')} · ${esc(record.delivered_on||record.date||'Seçili dönem')}${record.packages>1?' · '+record.packages+' paketin toplamı; bağlantı bir paketi açar':''}${record.cash_missing||record.revenue_missing?' · eksik kapsam':''}${record.estimated?' · tahmini':''}</small></a>`;
}
function pendingCard(pending){
 if(!pending)return `<section class="pn-card pn-pending"><h2>Bekleyen paketler</h2><p class="ins-empty">Tahmin bilgisi alınamadı.</p></section>`;
 const unknown=pending.partial||pending.calculated===0&&pending.packages>0;
 return `<section class="pn-card pn-pending"><span class="eyebrow">GÜNCEL BEKLEYENLER · TARİH FİLTRESİNDEN BAĞIMSIZ</span><h2>Bekleyen paketler</h2><strong class="pn-pending-value ${pending.cash_cents<0?'is-negative':''}">${unknown?'Hesap eksik':pending.packages===0?'Bekleyen paket yok':money(pending.cash_cents)}</strong><p>Güncel bekleyen toplamı · tahmini · KDV dahil</p>${pendingStatusMarkup(pending)}${pending.from&&pending.to?`<small>Sipariş tarihi: ${esc(dateRangeLabel(scope(pending)))}</small>`:''}${pending.missing?`<p class="ins-quality">${pending.missing} paket hesaplanamadı. Gösterilen tutar yalnız hesaplanabilen paketlere aittir.</p>`:''}${pending.kaba_tahmin?`<p class="ins-quality">${pending.kaba_tahmin} pakette benzer adette teslim geçmişi yok; tahmin kaba.</p>`:''}${pending.error?`<p class="error">${esc(pending.error)}</p>`:''}${pending.channels?`<details><summary>Bekleyenlerin kanal dağılımı</summary><div class="pn-pending-rows">${KANALLAR.map(k=>{const c=pending.channels[k];return c?`<span><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i>${KANAL[k]} <b>${c.calculated===0&&c.packages>0?'Bilgi eksik':money(c.cash_cents)}</b><small>${c.packages??'—'} paket</small></span>`:'';}).join('')}</div></details>`:''}${pending.from&&pending.to?`<a class="text-button" href="${esc(rapor(pending,{mode:'pending'}))}">Bekleyen paketleri incele →</a>`:''}</section>`;
}
// Markup stays pure for fixture tests. All money comes from the shared report API.
export function panoramaDetailMarkup(data,p,{dateControls='',kind=''}={}){
 const b=panoramaBuckets(data.daily||[],p),d=delta(p),inventory=data.inventory||{};
 const incomplete=!!(p.partial||p.missing||p.revenue_missing||data.unallocated_fee_cents),quality=incomplete?'Eksik kapsam':p.estimated?'Tahmini tutar içerir':p.packages?'Hesaplandı':'Teslim yok';
 const unit={day:'Günlük',week:'Haftalık',month:'Aylık'}[b.unit];
 const noCalculated=p.calculated===0&&(p.packages>0||p.partial);
 const cash=noCalculated?null:(p.calculated_cash_cents??p.cash_cents);
 const chartAvailable=b.buckets.length>0&&!noCalculated&&b.buckets.every(x=>bucketTotal(x)!==null);
 const emptyText=p.partial?'Dönem verisinin bir bölümü alınamadı':p.packages?'Bu aralıkta hesaplanabilen nakit sonucu yok':'Bu aralıkta teslim kaydı yok';
 const noRevenue=p.revenue_missing>0&&p.revenue_missing>=p.packages;
 const inventoryMissing=inventory.missing_vat_products>0||inventory.partial;
 return `<div class="ins-scope-line"><span>${esc(dateRangeLabel(scope(p)))} · ${p.partial&&!p.calculated?'Paket sayısı alınamadı':(p.packages??'—')+' sonuçlanan paket'}</span><span class="ins-status ${incomplete?'is-incomplete':p.estimated?'is-estimated':''}">${quality}</span></div>
  <div class="ins-kpis" aria-label="Seçili dönemin özeti">
   <article class="ins-kpi"><span>Ciro <small>KDV dahil</small></span><strong>${money(noRevenue?null:p.revenue_gross_cents)}</strong><small>${p.revenue_missing?`${p.revenue_missing} pakette ciro eksik`:'Seçili dönemde sonuçlanan satışlar'}${p.partial?' · eksik kapsam':''}</small></article>
   <article class="ins-kpi ins-kpi-primary"><span>Cebine kalan <small>KDV dahil</small></span><strong class="${cash<0?'is-negative':''}">${money(cash)}</strong><small>KDV hariç katkı: ${money(noCalculated?null:p.profit_ex_vat_cents)}</small>${d?`<small>${esc(d.metin)} · ${esc(d.uzun)}</small>`:''}</article>
   <article class="ins-kpi"><span>Nakit marjı</span><strong>${p.margin_bps==null?'—':new Intl.NumberFormat('tr-TR',{style:'percent',maximumFractionDigits:1}).format(p.margin_bps/10000)}</strong><small>${p.margin_bps==null?'Ortak ciro ve nakit kapsamı hesaplanamadı.':'Ciro ve nakdi birlikte hesaplanabilen '+(p.margin_packages??'—')+' paket.'}${p.margin_missing?' '+p.margin_missing+' paket kapsam dışında.':''}</small></article>
   <article class="ins-kpi ins-kpi-stock"><span>Depo değeri <small>Güncel stok</small></span><strong>${inventoryMissing?'Hesap eksik':money(inventory.gross_cents)}</strong><small>KDV dahil${inventory.gross_estimated?' tahmini':''}${inventoryMissing&&inventory.calculated_gross_cents!=null?' hesaplanabilen: '+money(inventory.calculated_gross_cents):''} · KDV hariç: ${money(inventory.net_cents)}</small><small>Tarih filtresinden bağımsız${inventory.missing_vat_products?' · '+inventory.missing_vat_products+' ürünün KDV oranı eksik':''}${inventory.negative_products?' · '+inventory.negative_products+' ürün eksi stokta':''}</small></article>
  </div>
  ${dateControls}
  ${periodReturnsMarkup(p.returns)}
  ${incomplete||p.estimated?`<aside class="ins-quality" aria-label="Hesap kapsamı">${p.partial?'<p>Bu dönemin bir bölümü alınamadı; toplamlar eksiktir.</p>':''}${p.missing?`<p><a href="${esc(rapor(p,{result:'missing'}))}">${p.missing} paket hesaplanamadı →</a> Gösterilen nakit toplamı hesaplanabilen ${p.calculated??'—'} pakete aittir.</p>`:''}${p.estimated?`<p>${p.estimated} paketin maliyeti veya kesintisi tahmini; belgeler eşleşince kesinleşir.</p>`:''}${data.unallocated_fee_cents?`<p>${money(data.unallocated_fee_cents)} kesinti satışlara dağıtılmadı. Dönem sonucu tamamlanmış sayılmaz. <a href="#reconciliation">Eşleştir →</a></p>`:''}</aside>`:''}
  <div class="ins-work-grid"><div data-overview-work hidden></div>${pendingCard(data.pending)}</div>
  <div class="ins-main-grid"><section class="pn-card ins-trend"><div class="pn-head"><div><span class="eyebrow">NAKİT AKIŞININ DAĞILIMI</span><h2>${unit} cebine kalan</h2></div><a class="text-button" href="${esc(rapor(p))}">Paket dökümü →</a></div><div class="pn-legend">${KANALLAR.map(k=>`<span><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i>${KANAL[k]}</span>`).join('')}</div>
   ${b.buckets.length?`${chartAvailable?'<div class="pn-chart-wrap"><div class="pn-chart" data-pn-chart></div><div class="pn-tip" role="status" hidden></div></div>':'<p class="ins-empty">Grafik için hesap bilgisi eksik.</p>'}<details class="pn-table"><summary>Grafiğin veri tablosu</summary><div class="table-wrap"><table data-list-tools="off"><caption>${unit} cebine kalan · KDV dahil</caption><thead><tr><th>Dönem</th><th>Trendyol</th><th>Hepsiburada</th><th>Toplam</th><th>Paket</th></tr></thead><tbody>${[...b.buckets].reverse().map(x=>`<tr><td data-label="Dönem">${esc(x.label)}</td><td data-label="Trendyol">${money(noCalculated?null:x.trendyol)}</td><td data-label="Hepsiburada">${money(noCalculated?null:x.hepsiburada)}</td><td data-label="Toplam"><b>${money(noCalculated?null:bucketTotal(x))}</b></td><td data-label="Paket">${x.packages}</td></tr>`).join('')}</tbody></table></div></details>`:`<div class="ins-empty"><h3>${emptyText}</h3><p>${p.partial||p.missing?'Eksik kayıtlar sıfır olarak değerlendirilmez.':'Başka bir dönem seçerek satışlarını inceleyebilirsin.'}</p></div>`}
   <div class="pn-split"><a href="${esc(rapor(p,{result:'profit'}))}"><small>Kâr bırakan ${p.gains??'—'} paket</small><strong>${money(noCalculated?null:p.gain_cents)}</strong></a><a class="is-loss" href="${esc(rapor(p,{result:'loss'}))}"><small>Zarar eden ${p.losses??'—'} paket</small><strong class="is-negative">${money(noCalculated?null:p.loss_cents)}</strong></a></div>
   <details class="pn-calculation-note"><summary>Hesap kapsamı ve yöntemi</summary><p>${esc(data.notice||'KDV dahil satıştan ürün maliyeti, pazaryeri kesintileri ve stopaj düşülür. Ortak giderler ve gelir vergisi dahil değildir.')}</p><p>Grafik hesaplanabilen paketlerin nakit sonucudur; eksik paketler sıfır kâr sayılmaz. 31 güne kadar günlük, 400 güne kadar haftalık, daha uzun aralıklarda aylık gösterilir.</p></details></section>
   <section class="pn-card ins-channels"><span class="eyebrow">SEÇİLİ DÖNEM</span><h2>Kanal dağılımı</h2>${shareBar(p)}</section></div>
  ${panoramaSalesMarkup(p,{kind})}
  <details class="ins-records-section"><summary>Tek siparişte rekorlar <span>Seçili dönem · KDV dahil</span></summary>${p.records?.partial||p.records?.revenue_missing_orders||p.records?.profit_missing_orders?`<p class="ins-quality">${p.records.partial?'Eksik dönem kapsamı. ':''}${p.records.revenue_missing_orders||0} sipariş ciro, ${p.records.profit_missing_orders||0} sipariş nakit bilgisi eksik olduğu için sıralamaya alınmadı.</p>`:''}<div class="ins-records">${recordCard('En yüksek ciro',p.records?.revenue,'revenue_gross_cents',p)}${recordCard('En çok cebine kalan',p.records?.profit,'cash_cents',p)}</div></details>`;
}

// Yığılmış sütun grafiği: pozitifler sıfırdan yukarı (Trendyol altta), negatifler aşağı yığılır.
// Uçlar 4 px yuvarlak, taban düz; parçalar arasında 2 px yüzey boşluğu.
function drawChart(host,tip,buckets){
 host.textContent='';
 const W=Math.max(280,Math.floor(host.clientWidth||600)),H=W<520?190:230,L=W<520?44:54,R=6,T=10,B=24,iw=W-L-R,ih=H-T-B;
 const pos=b=>Math.max(0,b.trendyol)+Math.max(0,b.hepsiburada),neg=b=>Math.min(0,b.trendyol)+Math.min(0,b.hepsiburada);
 const ticks=niceTicks(Math.min(0,...buckets.map(neg)),Math.max(0,...buckets.map(pos))),lo=ticks[0],hi=ticks.at(-1);
 const y=v=>T+(hi-v)/(hi-lo)*ih,band=iw/buckets.length,bw=Math.max(2,Math.min(24,band*0.62));
 const toplamlar=buckets.map(b=>b.trendyol+b.hepsiburada);
 const svg=svgEl('svg',{width:W,height:H,viewBox:`0 0 ${W} ${H}`,class:'pn-svg',tabindex:'0',role:'img','aria-label':`Cebine kalan grafiği, ${buckets.length} ${buckets.length>1?'dönem':'gün'}. Toplam ${money(toplamlar.reduce((t,v)=>t+v,0))}. Değerler için ok tuşlarını kullanın ya da tabloyu açın.`});
 for(const t of ticks){
  svg.append(svgEl('line',{x1:L,x2:W-R,y1:y(t),y2:y(t),class:t===0?'pn-base':'pn-grid'}));
  const tx=svgEl('text',{x:L-6,y:y(t)+4,'text-anchor':'end',class:'pn-tick'});tx.textContent=t===0?'0':kisa(t);svg.append(tx);
 }
 const yol=(x0,x1,ust,alt,yuvarla)=>{const r=Math.min(4,(x1-x0)/2,alt-ust);
  if(yuvarla==='ust')return `M${x0},${alt}V${ust+r}Q${x0},${ust} ${x0+r},${ust}H${x1-r}Q${x1},${ust} ${x1},${ust+r}V${alt}Z`;
  if(yuvarla==='alt')return `M${x0},${ust}V${alt-r}Q${x0},${alt} ${x0+r},${alt}H${x1-r}Q${x1},${alt} ${x1},${alt-r}V${ust}Z`;
  return `M${x0},${ust}H${x1}V${alt}H${x0}Z`;};
 const gruplar=buckets.map((b,i)=>{
  const g=svgEl('g',{class:'pn-bar','data-i':i}),cx=L+band*(i+.5),x0=cx-bw/2,x1=cx+bw/2;
  for(const yon of [1,-1]){
   const parca=KANALLAR.filter(k=>yon>0?b[k]>0:b[k]<0);let taban=0;
   parca.forEach((k,j)=>{const a=y(taban),z=y(taban+b[k]);taban+=b[k];
    let ust=Math.min(a,z),alt=Math.max(a,z);
    // Yığında komşu parça varsa birleşme tarafından 1'er px kırpılır: 2 px boşluk.
    if(yon>0){if(j>0)alt-=1;if(j<parca.length-1)ust+=1;}else{if(j>0)ust+=1;if(j<parca.length-1)alt-=1;}
    if(alt-ust<0.5)return;
    g.append(svgEl('path',{d:yol(x0,x1,ust,alt,j===parca.length-1?(yon>0?'ust':'alt'):''),class:SINIF[k]}));});
  }
  svg.append(g);return g;
 });
 // X etiketleri: sığdığı kadar, son kova hep etiketli.
 const adim=Math.max(1,Math.ceil(buckets.length/Math.max(2,Math.floor(iw/74))));
 buckets.forEach((b,i)=>{if((buckets.length-1-i)%adim)return;const cx=L+band*(i+.5);
  const kenar=cx+34>W?'end':cx-34<L?'start':'middle',tx=svgEl('text',{x:kenar==='end'?W-R:kenar==='start'?Math.max(L,cx-bw/2):cx,y:H-6,'text-anchor':kenar,class:'pn-tick'});
  tx.textContent=b.days>1?gunAd(b.to):b.label;svg.append(tx);});
 // İsabet alanı: işaretten büyük, kovanın tamamı.
 buckets.forEach((b,i)=>svg.append(svgEl('rect',{x:L+band*i,y:T,width:band,height:ih,class:'pn-hit','data-i':i})));
 host.append(svg);
 let aktif=-1;
 const goster=i=>{
  aktif=i;gruplar.forEach((g,j)=>g.classList.toggle('is-active',j===i));svg.classList.toggle('has-active',i>=0);
  if(i<0){tip.hidden=true;return;}
  const b=buckets[i];tip.textContent='';
  const baslik=document.createElement('span');baslik.className='pn-tip-title';baslik.textContent=b.days>1?b.label+' ('+b.days+' gün)':b.label;
  const toplam=document.createElement('strong');toplam.textContent=money(b.trendyol+b.hepsiburada);
  tip.append(baslik,toplam);
  for(const k of KANALLAR){const r=document.createElement('span');r.className='pn-tip-row';const key=document.createElement('i');key.className='pn-line-key '+SINIF[k];const ad=document.createElement('span');ad.textContent=KANAL[k];const v=document.createElement('b');v.textContent=money(b[k]);r.append(key,ad,v);tip.append(r);}
  const pk=document.createElement('small');pk.textContent=b.packages+' paket teslim edildi';tip.append(pk);
  tip.hidden=false;
  const cx=L+band*(i+.5),w=tip.offsetWidth,sol=Math.min(Math.max(0,cx-w/2),W-w);
  tip.style.left=sol+'px';tip.style.top=Math.max(0,Math.min(y(Math.max(0,pos(b))),T+ih)-tip.offsetHeight-10)+'px';
 };
 const isaret=e=>{const r=svg.getBoundingClientRect(),x=(e.clientX-r.left)*W/r.width,i=Math.floor((x-L)/band);goster(i>=0&&i<buckets.length?i:-1);};
 svg.addEventListener('pointermove',isaret);svg.addEventListener('pointerdown',isaret);
 // Dokunmatikte parmak kalkınca da değer görünür kalır; başka yere dokununca odak gider ve kapanır.
 svg.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')goster(-1);});
 svg.addEventListener('focus',()=>goster(aktif>=0?aktif:buckets.length-1));
 svg.addEventListener('blur',()=>goster(-1));
 svg.addEventListener('keydown',e=>{
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();goster(Math.min(buckets.length-1,Math.max(0,(aktif<0?buckets.length-1:aktif)+(e.key==='ArrowLeft'?-1:1))));}
  else if(e.key==='Home'||e.key==='End'){e.preventDefault();goster(e.key==='Home'?0:buckets.length-1);}
  else if(e.key==='Escape')goster(-1);});
}

// Oran çubukları CSP yüzünden satır içi stil yazamaz; genişlik CSSOM ile verilir (izinli).
function oranlar(root){for(const e of root.querySelectorAll('[data-pay]')){const v=+e.dataset.pay/10;if(e.parentElement.classList.contains('pn-share-bar'))e.style.flexGrow=String(v);else e.style.width=v+'%';}}

export function mountPanorama(section,data,{signal,onRangeChange,dailyWork,viewState={}}={}){
 if(signal?.aborted)return;
 const range=parseDateRange(location.hash,{today:data.today,firstDate:data.first_delivered||data.today});
 let period=data.periods.find(p=>p.key===range.preset&&p.from===range.from&&p.to===range.to);
 if(!period&&range.from&&range.to)period=data.periods.find(p=>p.from===range.from&&p.to===range.to)||data.selected_period;
 if(!period&&range.preset==='tum')period=data.periods.find(p=>p.key==='tum');
 if(!period)period=data.periods.find(p=>p.key==='30g')||data.periods[0];
 if(!period)throw Error('Dönem verisi alınamadı.');
 const rangeMismatch=range.from&&(period.from!==range.from||period.to!==range.to);
 const selected={...scope(period),error:range.error||(rangeMismatch?'Seçilen aralık alınamadı; gösterilen kapsam '+dateRangeLabel(scope(period))+'.':null)};
 section.setAttribute('aria-busy','false');section.classList.add('insights-panorama');
 section.innerHTML=panoramaDetailMarkup(data,period,{kind:viewState.kind||'',dateControls:`<details class="ins-date-disclosure" ${selected.error||selected.preset==='custom'?'open':''}><summary>Tarih <span>${esc(dateRangeLabel(selected))}</span></summary>${dateFilterMarkup(selected,{firstDate:data.first_delivered||data.today})}</details>`})+`<details class="ins-period-comparison"><summary>Bütün dönemler · nakit, ciro ve zarar</summary><div class="pn-periods">${data.periods.filter(p=>p.key!=='custom').map(p=>periodButton(p,selected.preset,location.hash||'#overview')).join('')}</div></details>`;
 if(dailyWork){section.querySelector('[data-overview-work]')?.replaceWith(dailyWork);section.querySelector('.ins-work-grid')?.classList.add('has-daily-work');}
 oranlar(section);
 const unbind=bindDateFilter(section,{signal,today:data.today,firstDate:data.first_delivered||data.today,onChange:next=>{if(onRangeChange)onRangeChange(next);else location.hash=dateRangeLink(location.hash||'#overview',next);}});
 const chooseProducts=key=>{viewState.productView=key;for(const button of section.querySelectorAll('[data-product-view]')){const active=button.dataset.productView===key;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}for(const panel of section.querySelectorAll('[data-product-panel]'))panel.hidden=panel.dataset.productPanel!==key;};
 const kindChange=event=>{if(!event.target.matches('[data-panorama-kind]'))return;const value=event.target.value;rememberDisclosures();viewState.kind=value;const active=section.querySelector('[data-product-view][aria-selected="true"]')?.dataset.productView||'profit';section.querySelector('[data-sales-rankings]').outerHTML=panoramaSalesMarkup(period,{kind:value});chooseProducts(active);restoreDisclosures();oranlar(section);section.querySelector('[data-panorama-kind]')?.focus();};
 section.addEventListener('change',kindChange,{signal});
 const productClick=event=>{const button=event.target.closest('[data-product-view]');if(button)chooseProducts(button.dataset.productView);};
 const productKey=event=>{const button=event.target.closest('[data-product-view]');if(!button||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const key=event.key==='Home'?'profit':event.key==='End'?'revenue':button.dataset.productView==='revenue'?'profit':'revenue';chooseProducts(key);section.querySelector('[data-product-view="'+key+'"]').focus();};
 section.addEventListener('click',productClick,{signal});section.addEventListener('keydown',productKey,{signal});
 chooseProducts(viewState.productView==='revenue'?'revenue':'profit');
 const disclosureKey=details=>details.className||details.querySelector(':scope > summary')?.textContent;
 const rememberDisclosures=()=>{viewState.disclosures??={};for(const details of section.querySelectorAll('details')){if(!dailyWork?.contains(details))viewState.disclosures[disclosureKey(details)]=details.open;}};
 const restoreDisclosures=()=>{for(const details of section.querySelectorAll('details')){const key=disclosureKey(details);if(!dailyWork?.contains(details)&&Object.hasOwn(viewState.disclosures||{},key))details.open=viewState.disclosures[key];}};
 restoreDisclosures();
 if(selected.error)section.querySelector('.ins-date-disclosure').open=true;
 const toggle=event=>{if(event.target.matches('details')&&!dailyWork?.contains(event.target))rememberDisclosures();};
 section.addEventListener('toggle',toggle,{capture:true,signal});
 const host=section.querySelector('[data-pn-chart]');let observer,disposed=false;
 if(host){const buckets=panoramaBuckets(data.daily||[],period).buckets;drawChart(host,section.querySelector('.pn-tip'),buckets);let width=host.clientWidth;
  if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(()=>{if(disposed||signal?.aborted||!host.isConnected)return;if(Math.abs(host.clientWidth-width)<8)return;width=host.clientWidth;drawChart(host,section.querySelector('.pn-tip'),buckets);});observer.observe(host);}}
 const dispose=()=>{if(disposed)return;disposed=true;rememberDisclosures();observer?.disconnect();unbind();signal?.removeEventListener('abort',dispose);section.removeEventListener('toggle',toggle,true);section.removeEventListener('click',productClick);section.removeEventListener('change',kindChange);section.removeEventListener('keydown',productKey);};signal?.addEventListener('abort',dispose,{once:true});return dispose;
}
