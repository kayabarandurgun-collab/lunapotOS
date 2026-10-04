import {dateRangeLink,dateRangeLabel} from './date-range.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>Number.isSafeInteger(v);
const money=v=>number(v)?new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(v/100):'Bilgi eksik';
const compact=v=>new Intl.NumberFormat('tr-TR',{notation:'compact',maximumFractionDigits:1}).format(v/100)+' ₺';
const percent=v=>new Intl.NumberFormat('tr-TR',{style:'percent',maximumFractionDigits:1}).format(v);
const range=p=>({preset:p.key||'custom',from:p.from,to:p.to,error:null});
const report=(p,extra={})=>dateRangeLink('#performance',range(p),{view:'packages',...extra});
const costs=[['cost','Satılan malların alış değeri','cost'],['commission','Komisyon','commission'],['shipping','Kargo','shipping'],['other','Diğer pazaryeri kesintileri','other'],['withholding','Stopaj','withholding']];
export const metricAmount=m=>number(m?.total_cents)?m.total_cents:number(m?.known_cents)?m.known_cents:null;
export function metricNote(m){
 if(!m)return 'Bilgi eksik';
 if(m.missing_packages||m.missing_packages===null||m.partial)return (m.missing_packages?m.missing_packages+' paket eksik':'Kapsam eksik')+(number(m.known_cents)?' · hesaplanabilen tutar':'');
 if(!number(m.total_cents)&&!number(m.known_cents))return 'Bilgi eksik';
 return m.estimated_packages?m.estimated_packages+' pakette tahmini tutar':'Kayıtlı tutar';
}
const amount=m=>money(metricAmount(m));
const complete=m=>number(m?.total_cents)&&!m.missing_packages&&!m.partial;
export function dashboardKpis(p){
 const f=p.financials||{},cash=f.cash,revenue=f.revenue;
 // Older clients/fixtures may not have the new detail contract. Only existing authoritative
 // cash/revenue can fall back; a missing cost or fee contract is never manufactured as zero.
 const oldCash=p.calculated===0&&(p.packages>0||p.partial)?null:p.calculated_cash_cents??p.cash_cents;
 const cashValue=cash?metricAmount(cash):oldCash,rev=revenue?metricAmount(revenue):p.revenue_gross_cents;
 const margin=p.margin_bps==null?'Oran hesaplanamadı':percent(p.margin_bps/10000)+' nakit marjı';
 return '<div class="ins-kpis" aria-label="Seçili dönemin özeti">'
 +'<article class="ins-kpi ins-kpi-primary"><span>Cebine kalan <small>KDV dahil satış sonucu</small></span><strong class="'+(cashValue<0?'is-negative':'')+'">'+money(cashValue)+'</strong><small>'+esc(margin)+(p.margin_missing?' · '+p.margin_missing+' paket kapsam dışında':'')+'</small><small>KDV hariç katkı: '+money(p.calculated===0&&(p.packages>0||p.partial)?null:p.profit_ex_vat_cents)+'</small><small>'+esc(cash?metricNote(cash):p.missing?'Hesaplanabilen paketlerin sonucu':'Ortak giderler hariç · tahsilat değildir.')+'</small><a class="overview-business-result" href="'+esc(dateRangeLink('#business-result',range(p)))+'">Giderler sonrası sonucu gör →</a></article>'
 +'<article class="ins-kpi"><span>Ciro <small>KDV dahil · iade etkisiyle</small></span><strong>'+money(rev)+'</strong><small>'+esc(revenue?metricNote(revenue):p.revenue_missing?'Ciro bilgisi eksik':'Sonuçlanan satışlar')+'</small><small>'+(p.packages??'—')+' sonuçlanan paket</small><a href="'+esc(report(p))+'">Satış dökümü →</a></article>'
 +'<article class="ins-kpi"><span>Satılan malların alış değeri <small>KDV dahil tahmini</small></span><strong>'+amount(f.cost)+'</strong><small>'+esc(metricNote(f.cost))+'</small><small>Satışa düşen maliyet · alış KDV’si ürün kartındaki oranla tahmini.</small><a href="#dashboard-money-flow" data-dashboard-scroll="money-flow">Maliyet dağılımı ↓</a></article>'
 +'<article class="ins-kpi"><span>Pazaryeri kesintileri <small>KDV dahil · stopaj dahil</small></span><strong>'+amount(f.fees)+'</strong><small>'+esc(metricNote(f.fees))+'</small><small>Komisyon + kargo + diğer + stopaj</small><a href="#dashboard-money-flow" data-dashboard-scroll="money-flow">Kesintileri incele ↓</a></article></div>';
}
export function dashboardMoneyFlow(p){
 const f=p.financials||{},all=costs.every(([k])=>complete(f[k]))&&complete(f.revenue)&&complete(f.cash);
 const revenue=f.revenue?.total_cents,canChart=all&&revenue>0&&costs.every(([k])=>f[k].total_cents>=0)&&f.cash.total_cents>=0&&revenue===costs.reduce((sum,[k])=>sum+f[k].total_cents,0)+f.cash.total_cents;
 const segments=[...costs,['cash','Cebine kalan','cash']];
 let cursor=0;
 const bar=canChart?'<svg viewBox="0 0 600 26" role="img" aria-label="Cironun maliyet, kesinti ve kalan dağılımı">'+segments.map(([key,label,color])=>{const value=f[key].total_cents,w=value/revenue*600,x=cursor;cursor+=w;return '<rect x="'+x+'" y="0" width="'+w+'" height="26" class="dash-fill-'+color+'"><title>'+esc(label+': '+money(value))+'</title></rect>';}).join('')+'</svg>':'';
 return '<section class="dash-card dash-money-flow" id="dashboard-money-flow" data-dashboard-anchor="money-flow" aria-labelledby="dash-flow-title"><div class="dash-card-head"><div><span class="eyebrow">SEÇİLİ DÖNEM · KDV DAHİL</span><h2 id="dash-flow-title">Satıştan ne kalıyor?</h2></div><a href="'+esc(report(p))+'" aria-label="Maliyet ve kesintilerin paket dökümü">Döküm ↗</a></div><div class="dash-flow-revenue"><span>Satış geliri</span><strong>'+amount(f.revenue)+'</strong></div>'
 +'<div class="dash-allocation">'+bar+'</div><dl class="dash-cost-lines">'+costs.map(([key,label,color])=>'<div><dt><i class="dash-dot dash-fill-'+color+'" aria-hidden="true"></i>'+label+'<small>'+esc(metricNote(f[key]))+'</small></dt><dd>'+amount(f[key])+'</dd></div>').join('')+'<div class="dash-flow-total"><dt>Cebine kalan<small>Ortak giderler ve gelir vergisi hariç</small></dt><dd class="'+(metricAmount(f.cash)<0?'is-negative':'')+'">'+amount(f.cash)+'</dd></div></dl><p class="dash-note">Alış KDV’si güncel ürün oranıyla tahmin edilir; geçmiş fatura toplamı değildir. Kesintiler bankadan yapılmış ödeme anlamına gelmez. '+(canChart?'':all?'İade veya zarar içeren dönemde tutarları satır satır incele.':'Eksik tutarlar sıfır sayılmaz; tam dağılım grafiği gösterilmez.')+'</p><details class="dash-financial-detail"><summary>Kayıtlı ve tahmini tutarları ayır</summary><dl class="dash-cost-lines">'+costs.map(([key,label])=>'<div><dt>'+label+'</dt><dd><small>Kayıt '+money(f[key]?.recorded_cents)+'</small><small>Tahmin '+money(f[key]?.estimated_cents)+'</small></dd></div>').join('')+'</dl><p class="dash-note">'+esc(f.notice||'Mevcut maliyetin KDV dahil karşılığı ürün kartındaki güncel oranla tahmin edilir.')+'</p></details></section>';
}
export function dashboardLifetime(data){
 const p=data.periods?.find(x=>x.key==='tum');
 if(!p)return '<section class="dash-lifetime"><h2>İlk satıştan bugüne</h2><p>Toplam geçmiş bilgisi alınamadı.</p></section>';
 const f=p.financials||{};
 return '<section class="dash-lifetime" data-dashboard-anchor="lifetime" aria-label="İlk satıştan bugüne toplamlar"><div class="dash-card-head"><div><span class="eyebrow">TÜM ZAMANLAR · KDV DAHİL</span><h2>İlk satıştan bugüne</h2><p>'+esc(dateRangeLabel(range(p)))+' · Üstteki tarih filtresinden bağımsız</p></div><a href="'+esc(dateRangeLink('#overview',range(p)))+'">Tüm dönemi aç ↗</a></div><dl>'+[['revenue','Toplam ciro'],...costs.map(([k,t])=>[k,t]),['cash','Toplam kalan']].map(([key,label])=>'<div data-lifetime-metric="'+key+'"><dt>'+label+'</dt><dd>'+amount(f[key])+'</dd><small>'+esc(metricNote(f[key]))+'</small></div>').join('')+'</dl><p class="dash-note">Alış değeri ve kalan tutar, ürün kartındaki KDV oranıyla tahmin içerir. Kesintiler satış kayıtlarıdır; banka ödemesi değildir.</p></section>';
}
export function dashboardChannels(p){
 const channels=p.financials?.channels||{};
 return '<section class="dash-card dash-channels" aria-labelledby="dash-channels-title"><div class="dash-card-head"><div><span class="eyebrow">AYNI DÖNEM, İKİ PAZARYERİ</span><h2 id="dash-channels-title">Hangi kanal daha verimli?</h2></div></div><div class="dash-channel-grid">'+[['trendyol','Trendyol','TY'],['hepsiburada','Hepsiburada','HB']].map(([key,label,initials])=>{
 const f=channels[key],cash=metricAmount(f?.cash),rev=f?.revenue?.total_cents,valid=complete(f?.revenue)&&complete(f?.cash)&&rev>0;
 const ratio=valid?f.cash.total_cents/rev:null;
 const pct=ratio==null?'Marj hesaplanamadı':percent(ratio)+' kalan';
 return '<a class="dash-channel" href="'+esc(report(p,{channel:key}))+'"><div class="dash-channel-heading"><span class="dash-channel-logo '+key+'">'+initials+'</span><strong>'+label+'</strong><span aria-hidden="true">↗</span></div><div class="dash-channel-result"><strong class="'+(cash<0?'is-negative':'')+'">'+money(cash)+'</strong><span>'+esc(pct)+'</span></div><svg viewBox="0 0 300 9" class="dash-channel-meter" aria-hidden="true"><rect width="300" height="9" rx="4" class="dash-track"/>'+(ratio!==null?'<rect width="'+Math.min(1,Math.abs(ratio))*300+'" height="9" rx="4" class="'+(ratio<0?'dash-fill-loss':'dash-fill-cash')+'"/>':'')+'</svg><dl><div><dt>Ciro</dt><dd>'+amount(f?.revenue)+'</dd></div><div><dt>Alış değeri</dt><dd>'+amount(f?.cost)+'</dd></div><div><dt>Kesintiler</dt><dd>'+amount(f?.fees)+'</dd></div></dl><small>'+esc(metricNote(f?.cash))+'</small></a>';
 }).join('')+'</div><p class="dash-note">Marj = kalan / ciro. Karşılaştırma aynı tarih aralığındadır; ortak giderler dahil değildir.</p></section>';
}
export function dashboardOutcomes(p){
 const unknown=p.partial?null:p.missing||0,known=p.calculated??null;
 const parts=[{key:'profit',name:'Kâr bırakan',n:p.gains,color:'cash'},{key:'loss',name:'Zarar eden',n:p.losses,color:'loss'},{key:'neutral',name:'Başa baş',n:number(known)&&number(p.gains)&&number(p.losses)?Math.max(0,known-p.gains-p.losses):null,color:'other'},{key:'missing',name:'Hesap bekleyen',n:unknown,color:'pending'}];
 const valid=!p.partial&&parts.every(x=>number(x.n)),total=valid?parts.reduce((s,x)=>s+x.n,0):0;let offset=0;
 const ring='<svg viewBox="0 0 140 140" role="img" aria-label="Paket sonuçlarının dağılımı"><circle cx="70" cy="70" r="53" fill="none" stroke-width="13" class="dash-track-stroke"/>'+(total?parts.map(x=>{const size=x.n/total*100,o=offset;offset+=size;return '<circle cx="70" cy="70" r="53" fill="none" stroke-width="13" pathLength="100" stroke-dasharray="'+size+' '+(100-size)+'" stroke-dashoffset="'+(-o)+'" transform="rotate(-90 70 70)" class="dash-stroke-'+x.color+'"><title>'+esc(x.name+': '+x.n+' paket')+'</title></circle>';}).join(''):'')+'<text x="70" y="70" text-anchor="middle" class="dash-ring-number">'+(valid?total:'—')+'</text><text x="70" y="90" text-anchor="middle" class="dash-ring-label">paket</text></svg>';
 return '<section class="dash-card dash-outcomes"><div class="dash-card-head"><div><span class="eyebrow">SONUÇLANAN PAKETLER</span><h2>Satışların sağlık durumu</h2></div></div><div class="dash-outcome-content">'+ring+'<ul>'+parts.map(x=>'<li><a href="'+esc(report(p,x.key==='neutral'?{}:{result:x.key}))+'"><i class="dash-dot dash-fill-'+x.color+'" aria-hidden="true"></i><span>'+x.name+'</span><b>'+(x.n??'—')+'</b></a></li>').join('')+'</ul></div><div class="dash-loss-detail"><span>Zarar eden paketlerin toplamı'+(p.missing?' · hesaplanabilenler':'')+'</span><strong>'+money(p.partial||p.calculated===0&&(p.missing>0||p.packages>0)?null:p.loss_cents)+'</strong></div><p class="dash-note">İadelerin etkisi dahil. Başa baş satırı tüm paket dökümüne gider.</p></section>';
}
export function dashboardTrendBuckets(daily,p){
 const rows=daily.filter(r=>r.date>=p.from&&r.date<=p.to).sort((a,b)=>a.date.localeCompare(b.date));
 const groups=[];
 if(rows.length<=31)groups.push(...rows.map(r=>[r]));
 else if(rows.length<=400){for(let end=rows.length;end>0;end-=7)groups.unshift(rows.slice(Math.max(0,end-7),end));}
 else {for(const row of rows){const last=groups.at(-1);if(last&&last[0].date.slice(0,7)===row.date.slice(0,7))last.push(row);else groups.push([row]);}}
 const sum=(part,key)=>part.every(r=>number(r[key]))?part.reduce((s,r)=>s+r[key],0):null;
 return groups.map(part=>({from:part[0].date,to:part.at(-1).date,days:part.length,unit:rows.length>400?'month':rows.length>31?'week':'day',revenue_cents:sum(part,'revenue_cents'),cash_cents:sum(part,'cash_cents'),outflow_cents:part.every(r=>number(r.cost_cents)&&number(r.fees_cents))?part.reduce((s,r)=>s+r.cost_cents+r.fees_cents,0):null,estimated_packages:part.reduce((s,r)=>s+(r.estimated_packages||0),0)}));
}
const series=[['revenue_cents','Ciro','revenue'],['outflow_cents','Maliyet ve kesintiler','cost'],['cash_cents','Kalan','cash']];
const dateShort=v=>new Date(v+'T12:00:00Z').toLocaleDateString('tr-TR',{day:'numeric',month:'short',timeZone:'UTC'});
const dateFull=v=>new Date(v+'T12:00:00Z').toLocaleDateString('tr-TR',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
const bucketLabel=b=>dateFull(b.from)+(b.from!==b.to?' – '+dateFull(b.to):'');
export function dashboardTrendMarkup(data,p){
 const buckets=dashboardTrendBuckets(data.financial_daily||[],p);
 return '<section class="dash-card dash-trend" aria-labelledby="dash-trend-title"><div class="dash-card-head"><div><span class="eyebrow">SEÇİLİ DÖNEM · KDV DAHİL</span><h2 id="dash-trend-title">Satış ve maliyet birlikte</h2></div><span class="dash-period-size">'+({month:'Aylık',week:'Haftalık',day:'Günlük'}[buckets[0]?.unit]||'Günlük')+'</span></div><div class="dash-series" role="group" aria-label="Grafikte gösterilecek tutarlar">'+series.map(([key,label,color])=>'<button type="button" data-dash-series="'+key+'" aria-pressed="true"><i class="dash-dot dash-fill-'+color+'" aria-hidden="true"></i>'+label+'</button>').join('')+'</div><div class="dash-trend-stage" data-dash-trend></div><p class="dash-trend-readout" data-dash-readout aria-live="polite">Grafiğe dokun veya ok tuşlarıyla değerleri incele.</p><details class="dash-data-table"><summary>Grafiğin rakamlarını aç</summary><div class="table-wrap"><table data-list-tools="off"><caption>Ciro, maliyet ve kalan · KDV dahil</caption><thead><tr><th>Dönem</th><th>Ciro</th><th>Maliyet ve kesintiler</th><th>Kalan</th></tr></thead><tbody>'+buckets.map(b=>'<tr><td data-label="Dönem">'+esc(bucketLabel(b))+'</td><td data-label="Ciro">'+money(b.revenue_cents)+'</td><td data-label="Maliyet ve kesintiler">'+money(b.outflow_cents)+'</td><td data-label="Kalan">'+money(b.cash_cents)+'</td></tr>').join('')+'</tbody></table></div></details><p class="dash-note">İade etkileri dahil. Eksik hesap olan zaman aralıkları çizgide boş bırakılır; tahmini tutarlar içerebilir.</p></section>';
}
const svg=(tag,attrs={})=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));return el;};
export function mountDashboardCharts(root,data,p,{signal}={}){
 const host=root.querySelector('[data-dash-trend]');if(!host)return ()=>{};
 const readout=root.querySelector('[data-dash-readout]'),buckets=dashboardTrendBuckets(data.financial_daily||[],p),visible=new Set(series.map(s=>s[0]));
 let observer,disposed=false,selected=-1;
 const draw=()=>{
  if(disposed||signal?.aborted)return;host.replaceChildren();
  const values=buckets.flatMap(b=>[...visible].map(k=>b[k])).filter(number);
  if(!values.length){host.innerHTML='<p class="dash-chart-empty">'+(buckets.length?'Grafik için hesap bilgisi eksik.':'Bu dönemde grafik oluşturacak satış kaydı yok.')+'</p>';readout.textContent='Başka bir tarih aralığı seçebilir veya paket dökümünü inceleyebilirsin.';return;}
  const W=Math.max(260,host.clientWidth||600),H=246,L=W<450?48:60,R=12,T=18,B=30,iw=W-L-R,ih=H-T-B;
  const min=Math.min(0,...values),max=Math.max(0,...values),span=Math.max(100,max-min),step=10**Math.floor(Math.log10(span/4)),unit=[1,2,2.5,5,10].map(x=>x*step).find(x=>x>=span/4),lo=Math.floor(min/unit)*unit,hi=Math.max(lo+unit,Math.ceil(max/unit)*unit);
  const x=i=>L+iw*(buckets.length===1?.5:i/(buckets.length-1)),y=v=>T+(hi-v)/(hi-lo)*ih;
  const chart=svg('svg',{viewBox:'0 0 '+W+' '+H,width:W,height:H,role:'img',tabindex:0,'aria-label':'Ciro, maliyet ve kalan grafiği. Ok tuşları ile zaman aralıklarını inceleyin.'});
  for(let v=lo;v<=hi+unit/2;v+=unit){chart.append(svg('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),class:v===0?'dash-zero':'dash-grid'}));const label=svg('text',{x:L-8,y:y(v)+4,'text-anchor':'end',class:'dash-axis'});label.textContent=v===0?'0':compact(v);chart.append(label);}
  const tickEvery=Math.max(1,Math.ceil(buckets.length/Math.max(2,Math.floor(iw/95))));
  buckets.forEach((b,i)=>{if(i%tickEvery&&i!==buckets.length-1)return;const t=svg('text',{x:x(i),y:H-6,'text-anchor':i===0?'start':i===buckets.length-1?'end':'middle',class:'dash-axis'});t.textContent=buckets[0].from.slice(0,4)!==buckets.at(-1).to.slice(0,4)?new Date(b.to+'T12:00:00Z').toLocaleDateString('tr-TR',{month:'short',year:'2-digit',timeZone:'UTC'}):dateShort(b.to);chart.append(t);});
  for(const [key,,color]of series){if(!visible.has(key))continue;let path='',connected=false;
   buckets.forEach((b,i)=>{if(!number(b[key])){connected=false;return;}path+=(connected?'L':'M')+x(i)+','+y(b[key]);connected=true;});
   chart.append(svg('path',{d:path,fill:'none',class:'dash-line dash-stroke-'+color}));
   buckets.forEach((b,i)=>{if(number(b[key]))chart.append(svg('circle',{cx:x(i),cy:y(b[key]),r:buckets.length<35?3:2,class:'dash-fill-'+color}));});
  }
  const cursor=svg('line',{x1:L,x2:L,y1:T,y2:T+ih,class:'dash-cursor',visibility:'hidden'});chart.append(cursor);
  const show=i=>{selected=i;const b=buckets[i];cursor.setAttribute('x1',x(i));cursor.setAttribute('x2',x(i));cursor.setAttribute('visibility','visible');readout.textContent=bucketLabel(b)+' · '+series.filter(([k])=>visible.has(k)).map(([k,label])=>label+' '+money(b[k])).join(' · ')+(b.estimated_packages?' · tahmini tutar içerir':'');};
  const point=event=>{const rect=chart.getBoundingClientRect(),pos=(event.clientX-rect.left)*W/rect.width;show(Math.max(0,Math.min(buckets.length-1,Math.round((pos-L)/iw*(buckets.length-1)))));};
  chart.addEventListener('pointermove',point);chart.addEventListener('pointerdown',point);chart.addEventListener('focus',()=>show(selected<0?buckets.length-1:selected));
  chart.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();show(event.key==='Home'?0:event.key==='End'?buckets.length-1:Math.max(0,Math.min(buckets.length-1,(selected<0?buckets.length-1:selected)+(event.key==='ArrowLeft'?-1:1))));});
  host.append(chart);if(selected>=0)show(selected);
 };
 const click=event=>{const anchor=event.target.closest('[data-dashboard-scroll]');if(anchor){event.preventDefault();root.querySelector('[data-dashboard-anchor="'+anchor.dataset.dashboardScroll+'"]')?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});return;}const button=event.target.closest('[data-dash-series]');if(!button)return;const key=button.dataset.dashSeries;if(visible.has(key)){if(visible.size===1)return;visible.delete(key);}else visible.add(key);for(const b of root.querySelectorAll('[data-dash-series]'))b.setAttribute('aria-pressed',String(visible.has(b.dataset.dashSeries)));draw();};
 root.addEventListener('click',click,{signal});draw();let width=host.clientWidth;
 if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(()=>{if(disposed||!host.isConnected||Math.abs(width-host.clientWidth)<4)return;width=host.clientWidth;draw();});observer.observe(host);}
 const dispose=()=>{if(disposed)return;disposed=true;observer?.disconnect();root.removeEventListener('click',click);signal?.removeEventListener('abort',dispose);};signal?.addEventListener('abort',dispose,{once:true});return dispose;
}
