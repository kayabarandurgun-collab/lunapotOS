// GENEL DURUM (ana sayfa). Teslim edilenlerin cebine kalanı altı dönemde yan yana; seçili dönemin
// günlük/haftalık grafiği, Trendyol–Hepsiburada payı, kargodakilerin tahmini ve ürün sıralaması.
// Veri: GET /api/ec/panorama (kâr raporuyla aynı hesap). Grafik satır içi SVG'dir: CSP dış betik ve
// satır içi stile izin vermez; renkler ui-polish.css sınıflarından gelir. Etiketler textContent ile yazılır.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TL=new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'});
const money=v=>TL.format((v||0)/100);
const kisa=v=>{const a=Math.abs(v/100);return (v<0?'−':'')+(a<1000?Math.round(a).toLocaleString('tr-TR'):new Intl.NumberFormat('tr-TR',{notation:'compact',maximumFractionDigits:a<10000?1:0}).format(a))+' ₺';};
const sayi=v=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:3}).format(v/1000);
const AY=['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
const gunAd=d=>+d.slice(8)+' '+AY[+d.slice(5,7)-1];
const KANAL={trendyol:'Trendyol',hepsiburada:'Hepsiburada'},KANALLAR=['trendyol','hepsiburada'],SINIF={trendyol:'pn-ty',hepsiburada:'pn-hb'};
const ONCEKI={'7g':'önceki 7 güne','14g':'önceki 14 güne','30g':'önceki 30 güne','90g':'önceki 90 güne','180g':'önceki 180 güne'};
const rapor=(p,ek={})=>'#performance?'+new URLSearchParams({...ek,from:p.from,to:p.to});
const svgEl=(tag,attrs={})=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};

// Grafik kovaları: 31 güne kadar günlük; 400 güne kadar bugünden geriye 7 günlük; sonrası takvim ayı.
export function panoramaBuckets(daily,period){
 const gunler=daily.filter(g=>g.date>=period.from&&g.date<=period.to);
 const topla=(part,label)=>({from:part[0].date,to:part.at(-1).date,label,days:part.length,
  trendyol:part.reduce((t,g)=>t+g.trendyol,0),hepsiburada:part.reduce((t,g)=>t+g.hepsiburada,0),packages:part.reduce((t,g)=>t+g.packages,0)});
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
 if(p.prev_cash_cents===null||p.prev_cash_cents===undefined)return null;
 const fark=p.cash_cents-p.prev_cash_cents,yon=fark>0?'up':fark<0?'down':'flat',ok=fark>0?'▲':fark<0?'▼':'■';
 const metin=p.prev_cash_cents>0?'%'+Math.abs(Math.round(fark*100/p.prev_cash_cents)).toLocaleString('tr-TR'):kisa(Math.abs(fark));
 return {yon,metin:ok+' '+metin,uzun:(ONCEKI[p.key]||'önceki döneme')+' göre '+(fark>=0?'+':'−')+money(Math.abs(fark))+' (önceki: '+money(p.prev_cash_cents)+')'};
}

function periodButton(p,secili){
 const d=delta(p);
 return `<button type="button" class="pn-period${p.key===secili?' is-selected':''}" data-donem="${p.key}" aria-pressed="${p.key===secili}"><span class="pn-period-label">${esc(p.label)}</span><strong class="${p.cash_cents<0?'is-negative':''}">${p.packages?money(p.cash_cents):'—'}</strong><small>${p.packages} paket${p.losses?' · '+p.losses+' zarar':''}</small>${d?`<em class="pn-delta ${d.yon}" title="${esc(d.uzun)}">${esc(d.metin)}</em>`:''}</button>`;
}

function shareBar(p){
 const pay=KANALLAR.map(k=>({k,v:Math.max(0,p.channels[k].cash_cents)})),toplam=pay.reduce((t,x)=>t+x.v,0);
 const bar=toplam>0?`<div class="pn-share-bar" aria-hidden="true">${pay.filter(x=>x.v>0).map(x=>`<span class="${SINIF[x.k]}" data-pay="${Math.round(x.v*1000/toplam)}"></span>`).join('')}</div>`:'';
 return `${bar}<div class="pn-share-rows">${KANALLAR.map(k=>{const c=p.channels[k],oran=toplam>0&&c.cash_cents>0?Math.round(c.cash_cents*100/toplam):null;
  return `<a href="${rapor(p,{channel:k})}"><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i><span>${KANAL[k]}</span><strong class="${c.cash_cents<0?'is-negative':''}">${c.packages?money(c.cash_cents):'Paket yok'}</strong><small>${c.packages} paket${oran!==null?' · %'+oran:''}</small></a>`;}).join('')}</div>`;
}

function productList(title,list,enBuyuk,bos){
 if(!list.length)return bos?`<div class="pn-products-group"><h3>${title}</h3><p class="help">${bos}</p></div>`:'';
 return `<div class="pn-products-group"><h3>${title}</h3><ol>${list.map(u=>`<li><div class="pn-product-line"><span class="pn-product-name">${esc(u.name)}</span><strong class="${u.cash_cents<0?'is-negative':''}">${money(u.cash_cents)}</strong></div><div class="pn-product-meter" aria-hidden="true"><span class="${u.cash_cents<0?'neg':'pos'}" data-pay="${Math.max(12,Math.round(Math.abs(u.cash_cents)*1000/(enBuyuk||1)))}"></span></div><small>${sayi(u.qty_milli)} adet · adet başı ${money(u.per_unit_cents)}${u.cash_cents<0?' · zarar':''}</small></li>`).join('')}</ol></div>`;
}

function detail(data,p){
 const d=delta(p),bekleyen=data.pending,b=panoramaBuckets(data.daily,p);
 const birim={day:'Günlük',week:'Haftalık',month:'Aylık'}[b.unit];
 const notlar=[];
 if(p.estimated)notlar.push(`${p.estimated} paketin kesintisi veya maliyeti geçmişten <b>tahmini</b>; ekstre ve fatura gelince kendiliğinden kesinleşir.`);
 if(p.missing)notlar.push(`<a href="${rapor(p,{result:'missing'})}">${p.missing} paket hesaba girmedi →</a>`);
 if(data.unallocated_fee_cents)notlar.push(`Satışlara dağıtılmamış ${money(data.unallocated_fee_cents)} kesinti faturası var. <a href="#reconciliation">Eşleştir →</a>`);
 notlar.push(`Vergi beyanı için KDV hariç katkı: ${money(p.profit_ex_vat_cents)}. Ortak giderler ve gelir vergisi hariçtir.`);
 const enBuyuk=Math.max(1,...[...p.products.top,...p.products.bottom].map(u=>Math.abs(u.cash_cents)));
 const pendingHtml=!bekleyen.packages?'<strong class="pn-pending-value">Kargoda paket yok</strong>':`<strong class="pn-pending-value ${bekleyen.cash_cents<0?'is-negative':''}">${money(bekleyen.cash_cents)}</strong><small>${bekleyen.packages} paket · tamamı tahmini${bekleyen.missing?' · '+bekleyen.missing+' paket hesaplanamadı':''}</small><div class="pn-pending-rows">${KANALLAR.filter(k=>bekleyen.channels[k].packages).map(k=>`<span><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i>${KANAL[k]} <b>${money(bekleyen.channels[k].cash_cents)}</b> <small>${bekleyen.channels[k].packages} paket</small></span>`).join('')}</div>`;
 return `<div class="pn-main"><section class="pn-card pn-hero" aria-label="${esc(p.label)} cebine kalan"><div class="pn-head"><div><span class="eyebrow">TESLİM EDİLENLER · ${esc(p.label.toLocaleUpperCase('tr-TR'))}</span><h2>Cebine kalan</h2></div><a class="text-button" href="${rapor(p)}">Paketleri gör →</a></div>`+
  `<strong class="pn-hero-value ${p.cash_cents<0?'is-negative':''}">${p.packages?money(p.cash_cents):'Bu dönemde teslim yok'}</strong>`+
  `<p class="pn-sub">${gunAd(p.from)} – ${gunAd(p.to)} · ${p.packages} paket · ciro ${money(p.revenue_gross_cents)}${p.losses?` · <a href="${rapor(p,{result:'loss'})}">${p.losses} zarar eden paket</a>`:''}${d?` · <span class="pn-delta ${d.yon}">${esc(d.metin)}</span> <span class="muted">${esc(ONCEKI[p.key]||'')} göre</span>`:''}</p>`+
  `<div class="pn-share">${shareBar(p)}</div>`+
  (b.buckets.length?`<div class="pn-chart-wrap"><div class="pn-chart-head"><h3>${birim} cebine kalan</h3><div class="pn-legend">${KANALLAR.map(k=>`<span><i class="pn-key ${SINIF[k]}" aria-hidden="true"></i>${KANAL[k]}</span>`).join('')}</div></div><div class="pn-chart" data-pn-chart></div><div class="pn-tip" role="status" hidden></div></div>`+
  `<details class="pn-table"><summary>Tablo olarak göster</summary><div class="table-wrap"><table data-list-tools="off"><thead><tr><th>${birim==='Günlük'?'Gün':'Dönem'}</th><th>Trendyol</th><th>Hepsiburada</th><th>Toplam</th><th>Paket</th></tr></thead><tbody>${[...b.buckets].reverse().map(x=>`<tr><td>${esc(x.label)}</td><td>${money(x.trendyol)}</td><td>${money(x.hepsiburada)}</td><td><b>${money(x.trendyol+x.hepsiburada)}</b></td><td>${x.packages}</td></tr>`).join('')}</tbody></table></div></details>`:'')+
  `<ul class="pn-notes">${notlar.map(n=>`<li>${n}</li>`).join('')}</ul></section>`+
  `<div class="pn-side"><a class="pn-card pn-pending" href="#performance?${new URLSearchParams({mode:'pending',from:bekleyen.from,to:bekleyen.to})}"><span class="eyebrow">HENÜZ TESLİM EDİLMEDİ</span><h2>Kargodakilerden tahminen kalacak</h2>${pendingHtml}<span class="pn-link">Paketleri gör →</span></a>`+
  `<section class="pn-card pn-products"><div class="pn-head"><div><span class="eyebrow">ÜRÜNLER · ${esc(p.label.toLocaleUpperCase('tr-TR'))}</span><h2>Ne kazandırdı?</h2></div><a class="text-button" href="#stock">Tümü →</a></div>${p.products.count?productList('En çok kazandıran',p.products.top,enBuyuk)+productList(p.products.bottom.some(u=>u.cash_cents<0)?'En az kazandıran / zarar ettiren':'En az kazandıran',p.products.bottom,enBuyuk):'<p class="help">Bu dönemde teslim edilen ürün yok.</p>'}</section></div></div>`;
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

export function mountPanorama(section,data,{signal}={}){
 const secim=()=>{const k=new URLSearchParams(location.hash.split('?')[1]||'').get('donem');return data.periods.some(p=>p.key===k)?k:'30g';};
 let secili=secim(),gozlem=null;
 const ciz=()=>{
  const p=data.periods.find(x=>x.key===secili),b=panoramaBuckets(data.daily,p).buckets;
  section.querySelector('[data-pn-detail]').innerHTML=detail(data,p);oranlar(section);
  const host=section.querySelector('[data-pn-chart]');
  if(host){drawChart(host,section.querySelector('.pn-tip'),b);gozlem?.disconnect();let son=host.clientWidth;
   gozlem=new ResizeObserver(()=>{if(Math.abs(host.clientWidth-son)<8)return;son=host.clientWidth;drawChart(host,section.querySelector('.pn-tip'),b);});gozlem.observe(host);}
 };
 section.removeAttribute('aria-busy');
 section.innerHTML=`<div class="pn-periods" role="group" aria-label="Dönem seç · teslim edilenlerden cebine kalan, KDV dahil">${data.periods.map(p=>periodButton(p,secili)).join('')}</div><div data-pn-detail></div>`;
 ciz();
 section.addEventListener('click',e=>{const b=e.target.closest('[data-donem]');if(!b||b.dataset.donem===secili)return;secili=b.dataset.donem;
  for(const x of section.querySelectorAll('[data-donem]')){const on=x.dataset.donem===secili;x.classList.toggle('is-selected',on);x.setAttribute('aria-pressed',String(on));}
  // Seçim adreste kalır (geri tuşu ve yenileme aynı dönemi açar); hashchange tetiklenmez, sayfa baştan kurulmaz.
  history.replaceState(null,'','#overview?donem='+secili);ciz();},{signal});
 signal?.addEventListener('abort',()=>gozlem?.disconnect());
}
