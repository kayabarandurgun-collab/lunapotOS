import {pendingStatusMarkup} from './panorama-ui.js';
import {parseDateRange,dateRangeQuery,dateRangeLink,dateRangeLabel,dateFilterMarkup,bindDateFilter,todayInIstanbul} from './date-range.js';
import {selectPerformanceRows,performanceCsv,resultLabels,csvCell} from './performance-tools.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>!Number.isFinite(v)?'Bilgi eksik':new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(v/100);
const names={trendyol:'Trendyol',hepsiburada:'Hepsiburada'},statuses={draft:'Hazırlanıyor',reserved:'Stok ayrıldı',shipped:'Kargoda',delivered:'Teslim edildi'};
const SIRALAR={yeni:'Yeni → eski',eski:'Eski → yeni',cok:'En çok kalan',az:'En az kalan'};
const sonucu=r=>Number.isFinite(r.cash_cents)?r.cash_cents:null;
const gunu=r=>(r.status==='delivered'?r.delivered_on:r.occurred_on)||r.occurred_on||'';
function sirala(rows,sira){
 const t=[...rows],son=(a,b,f)=>{const x=f(a),y=f(b);return x===null&&y===null?0:x===null?1:y===null?-1:null;};
 if(sira==='eski')return t.sort((a,b)=>gunu(a).localeCompare(gunu(b)));
 if(sira==='cok'||sira==='az')return t.sort((a,b)=>son(a,b,sonucu)??(sira==='cok'?sonucu(b)-sonucu(a):sonucu(a)-sonucu(b)));
 return t.sort((a,b)=>gunu(b).localeCompare(gunu(a)));
}
// Sipariş no'nun son 4 hanesi kalın: kullanıcı ekstreyi son 4 haneyle eşleştiriyor.
const siparisNo=v=>{const t=String(v||'');return t.length>4?esc(t.slice(0,-4))+'<b>'+esc(t.slice(-4))+'</b>':'<b>'+esc(t)+'</b>';};
const kisaGun=d=>d?new Date(d+'T12:00:00Z').toLocaleDateString('tr-TR',{day:'numeric',month:'short',timeZone:'UTC'}):'';
// PAKET DÖKÜMÜ: dar ekrana sığan satırlar. Özet satırında sipariş, ürün, tarih ve cebine kalan;
// dökümün tamamı (satış, maliyet, kesintiler, stopaj, notlar) satıra dokununca açılır.
function paketListesi(rows,pending,donus){
 return `<ol class="pf-list">${rows.map(r=>{
  const nakit=r.cash_cents!==null&&r.cash_cents!==undefined,deger=nakit?r.cash_cents:null;
  const costs=['shipping','commission','other'].map(k=>r[k+'_gross_cents']);
  const kesinti=costs.some(v=>v==null)||r.withholding_cents==null?null:costs.reduce((t,v)=>t+v,0)+Math.abs(r.withholding_cents);
  const rozet=[r.fees_estimated?'<span class="v2-badge warning">Kesinti tahmini</span>':'',r.tahmin_uyari?'<span class="v2-badge warning">Kaba tahmin</span>':'',r.returns?`<span class="v2-badge neutral">${r.returns} iade satırı</span>`:'',(r.missing||[]).length?'<span class="v2-badge danger">Bilgi eksik</span>':'',r.teslim_edilemedi?'<span class="v2-badge warning">Teslim edilemedi</span>':''].join('');
  // Adet uyumu zayıf tahmin (fee-history 'uzak'/'yok'): tutar aynı, dayanağının kaba olduğu yazılır.
  const notlar=[...(r.missing||[]),r.tahmin_uyari,r.cost_note,r.twin_of?'Çift kayıt düzeltildi: kopyanın yerine asıl kayıt hesaplandı.':'',pending&&r.assumptions_source==='identical_contents_template'?'Aynı içerikteki paketin kayıtlı ölçüleri kullanıldı.':'',pending&&r.tariff_date?'Tarife tarihi: '+r.tariff_date:'',!nakit&&r.cash_note?r.cash_note:''].filter(Boolean);
  return `<li class="pf-row"><details><summary><span class="pf-main"><span class="pf-order"><i class="pn-key ${r.channel==='trendyol'?'pn-ty':'pn-hb'}" aria-hidden="true"></i><span class="pf-no">${siparisNo(r.order_no||r.external_id)}</span><small>${esc(names[r.channel]||r.channel)} · ${pending?esc(statuses[r.status]||r.status)+' · sipariş ':r.teslim_edilemedi?'geri döndü ':'teslim '}${esc(kisaGun(gunu(r)))}</small></span>${r.urun?`<span class="pf-urun">${esc(r.urun)}</span>`:''}<span class="pf-nums">KDV dahil · Satış ${money(r.revenue_gross_cents)} · Maliyet ${money(r.cost_gross_cents)} · Kesinti ${money(kesinti)}</span>${rozet?`<span class="pf-badges">${rozet}</span>`:''}</span><span class="pf-cash"><small>${pending?'Tahmini':'Cebine kalan'}</small><strong class="${deger!==null&&deger<0?'error':''}">${nakit?money(deger):'—'}</strong></span></summary>`+
   `<div class="pf-detail"><dl>${[['Satış (KDV dahil)',r.revenue_gross_cents],['Ürün maliyeti (KDV dahil)',r.cost_gross_cents],['Kargo (KDV dahil)',r.shipping_gross_cents],['Komisyon (KDV dahil)',r.commission_gross_cents],['Diğer gider (KDV dahil)',r.other_gross_cents],['Stopaj',r.withholding_cents]].map(([l,v])=>`<div><dt>${l}</dt><dd>${money(v)}</dd></div>`).join('')}<div class="pf-total"><dt>${pending?'Tahmini nakit':'Cebine kalan'}</dt><dd>${nakit?money(deger):'—'}</dd></div></dl>${r.profit_cents!==null&&r.profit_cents!==undefined?`<p class="help">KDV hariç katkı (vergi beyanı için): ${money(r.profit_cents)}</p>`:''}${notlar.map(n=>`<p class="help">${esc(n)}</p>`).join('')}<a class="text-button" href="${esc(dateRangeLink('#orders',parseDateRange(donus),{package:r.id,donus}))}">Siparişi aç →</a></div></details></li>`;}).join('')}</ol>`;
}
// Aggregate only the server's economic-result rows; never reconstruct package profit here.
export function performanceSummary(rows) {
 const cashRows=rows.filter(r=>Number.isFinite(r.cash_cents));
 const revenueRows=rows.filter(r=>Number.isFinite(r.revenue_gross_cents));
 const common=rows.filter(r=>Number.isFinite(r.cash_cents)&&Number.isFinite(r.revenue_gross_cents));
 const sum=(list,key)=>list.length?list.reduce((total,r)=>total+r[key],0):null;
 const revenue=sum(common,'revenue_gross_cents'),cash=sum(common,'cash_cents');
 return {packages:rows.length,cash_cents:sum(cashRows,'cash_cents'),revenue_gross_cents:sum(revenueRows,'revenue_gross_cents'),
  missing:rows.length-cashRows.length,revenue_missing:rows.length-revenueRows.length,
  margin_bps:revenue>0?Math.round(cash*10000/revenue):null,margin_packages:common.length,
  estimated:rows.filter(r=>r.fees_estimated||r.cost_estimated||r.assumptions_source).length,
  losses:rows.length&&!cashRows.length?null:cashRows.filter(r=>r.cash_cents<0).length,loss_cents:!cashRows.length?null:cashRows.filter(r=>r.cash_cents<0).reduce((total,r)=>total+r.cash_cents,0)};
}
// Page-level channel totals cannot be added: packages may repeat after twin correction,
// and awaiting-delivery counts describe the entire scope on every page.
export function performanceChannels(rows, metadata = []) {
 const keys=[...new Set([...Object.keys(names),...metadata.map(c=>c.channel),...rows.map(r=>r.channel)])];
 return keys.map(channel=>{
  const items=rows.filter(r=>r.channel===channel),profit=items.filter(r=>Number.isFinite(r.profit_cents)),cash=items.filter(r=>Number.isFinite(r.cash_cents));
  const profitTotal=profit.length?profit.reduce((total,r)=>total+r.profit_cents,0):null;
  const cashTotal=cash.length?cash.reduce((total,r)=>total+r.cash_cents,0):null;
  const meta=metadata.find(c=>c.channel===channel);
  return {channel,packages:items.length,calculated:profit.length,missing:items.length-profit.length,
   profit_cents:items.length&&profit.length===items.length?profitTotal:null,calculated_profit_cents:profitTotal,losses:profit.filter(r=>r.profit_cents<0).length,
   cash_calculated:cash.length,cash_cents:items.length&&cash.length===items.length?cashTotal:null,calculated_cash_cents:cashTotal,cash_losses:cash.filter(r=>r.cash_cents<0).length,
   awaiting_delivery:meta?.awaiting_delivery??null,awaiting_delivery_since:meta?.awaiting_delivery_since??null};
 });
}
// Only a terminal cursor publishes a report. Progress deliberately exposes no money or rows.
// Empty result pages may still advance the cursor (returned/copy packages filtered by the engine).
export async function loadPerformancePages({mode,from,to,requestPage,signal,isCurrent=()=>true,onProgress=()=>{}}) {
 dateRangeQuery({from,to,error:null});
 if(!['delivered','pending'].includes(mode))throw Error('Rapor türü geçersiz.');
 const active=()=>{if(signal?.aborted||!isCurrent())throw Object.assign(Error('Rapor yüklemesi iptal edildi.'),{name:'AbortError'});};
 const seenIds=new Set(),seenCursors=new Set(['']),rows=[];
 let cursor='',first=null,pages=0;
 while(true){
  active();
  const page=await requestPage(cursor,signal);
  active();
  if(!page||!Array.isArray(page.rows)||!Array.isArray(page.channels)||page.mode!==mode||page.from!==from||page.to!==to)
   throw Error('Rapor sayfasının tarih ve kapsam bilgisi doğrulanamadı. Yeniden deneyin.');
  const next=page.sonraki_imlec;
  if(next!==null&&(typeof next!=='string'||!next||seenCursors.has(next)))
   throw Error('Raporun bütün sayfaları doğrulanamadı. Yeniden deneyin.');
  if(!first)first=page;
  for(const row of page.rows){
   if(!row||typeof row.id!=='string'||!row.id||typeof row.channel!=='string'||!row.channel)
    throw Error('Rapor paketinin kimliği doğrulanamadı. Yeniden deneyin.');
   // Same first-seen rule as tumSatirlar: a twin reached again must not count twice.
   if(!seenIds.has(row.id)){seenIds.add(row.id);rows.push(row);}
  }
  pages++;onProgress({pages,packages:rows.length});active();
  if(next===null){
   const channels=performanceChannels(rows,first.channels);active();
   return {...first,rows,channels,sonraki_imlec:null,pages_loaded:pages};
  }
  seenCursors.add(next);cursor=next;
 }
}

export const salesKindLabels=Object.freeze({single:'Tekli',multipack:'Çoklu paket',bundle:'Set'});
const quantity=v=>Number.isFinite(v)?new Intl.NumberFormat('tr-TR',{maximumFractionDigits:3}).format(v/1000):'Bilgi eksik';
const sumKnown=(rows,key)=>{const values=rows.map(r=>r[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0):null;};
const sumExact=(rows,key)=>rows.length&&rows.every(r=>Number.isFinite(r[key]))?sumKnown(rows,key):null;
const financialKeys=['revenue_gross_cents','cost_gross_cents','cash_cents','sold_cash_cents','return_cash_cents'];
const searchText=value=>String(value??'').toLocaleLowerCase('tr-TR').normalize('NFC');
const isReturn=r=>typeof r.has_returns==='boolean'?r.has_returns:!r.technical_correction&&(r.partial_return||Number(r.returned_units_milli)>0||(r.component_returns||[]).some(c=>c.quantity_milli>0));
const returnedPackage=r=>r.teslim_edilemedi||(Array.isArray(r.sales_items)?r.sales_items.some(isReturn):Number(r.returns)>0);

// Sum server order-line allocations only. No stock economics or client allocation.
export function salesModel(rows,{channel='',kind='',query='',item=''}={}) {
 const packages=rows.filter(r=>!channel||r.channel===channel),groups=new Map();
 let missingPackages=0;
 for(const row of packages){
  const items=Array.isArray(row.sales_items)?row.sales_items:[];
  const valid=items.filter(i=>i&&typeof i.key==='string'&&i.key&&Object.hasOwn(salesKindLabels,i.kind));
  if(!valid.length||valid.length!==items.length)missingPackages++;
  for(const entry of valid){
   let group=groups.get(entry.key);
   if(!group){group={key:entry.key,name:entry.name||'Satış adı eksik',kind:entry.kind,components:entry.components||[],entries:[],contributions:[]};groups.set(entry.key,group);}
   group.entries.push(entry);group.contributions.push({item:entry,package:row});
  }
 }
 const all=[...groups.values()].map(g=>{
  const fields=Object.fromEntries([...financialKeys,'units_milli','sold_units_milli','returned_units_milli'].map(k=>[k,sumExact(g.entries,k)]));
  return {...g,...fields,packages:new Set(g.contributions.map(c=>c.package.id)).size,
   channels:[...new Set(g.contributions.map(c=>c.package.channel))],partial_returns:g.entries.filter(e=>e.partial_return).length,
   missing:g.entries.filter(e=>!Number.isFinite(e.cash_cents)).length,calculated_cash_cents:sumKnown(g.entries,'cash_cents'),
   estimated:g.contributions.filter(c=>c.package.fees_estimated||c.package.cost_estimated||c.package.assumptions_source).length};
 });
 const needle=searchText(query).trim();
 const visible=all.filter(g=>(!kind||g.kind===kind)&&(!item||g.key===item)&&(!needle||searchText([g.name,...g.components.map(c=>c.name)].join(' ')).includes(needle)));
 const summary=Object.fromEntries(financialKeys.map(k=>[k,sumExact(packages,k)]));
 for(const k of ['revenue_gross_cents','cost_gross_cents','cash_cents'])summary['calculated_'+k]=sumKnown(packages,k);
 summary.packages=packages.length;summary.missing=packages.filter(r=>!Number.isFinite(r.cash_cents)).length;
 const entries=all.flatMap(g=>g.entries),allocated=sumExact(entries,'cash_cents');
 summary.allocated_cash_cents=missingPackages?null:allocated;
 const measures=['revenue_gross_cents','cost_gross_cents','cash_cents'];
 summary.mismatched_packages=packages.filter(r=>Array.isArray(r.sales_items)&&measures.some(k=>Number.isFinite(r[k])&&sumExact(r.sales_items,k)!==null&&sumExact(r.sales_items,k)!==r[k])).length;
 summary.reconciled=packages.length>0&&missingPackages===0&&summary.mismatched_packages===0&&measures.every(k=>summary[k]!==null&&sumExact(entries,k)===summary[k]);
 summary.difference_cents=summary.cash_cents!==null&&allocated!==null?summary.cash_cents-allocated:null;
 const returnRows=packages.filter(returnedPackage),failed=returnRows.filter(r=>r.teslim_edilemedi),returned=returnRows.filter(r=>!r.teslim_edilemedi);
 const returnEffect=list=>!list.length?(packages.some(r=>Number.isFinite(r.cash_cents))?0:null):list.every(r=>Array.isArray(r.sales_items)&&r.sales_items.length)?sumExact(list.flatMap(r=>r.sales_items),'return_cash_cents'):null;
 return {all,visible,summary,missing_packages:missingPackages,
  returns:{failed_count:failed.length,returned_count:returned.length,failed_cash_cents:returnEffect(failed),returned_cash_cents:returnEffect(returned)},filtered:!!(kind||needle||item)};
}
const saleTotalsMarkup=rows=>`<dl class="sales-amounts">${[['Ciro','revenue_gross_cents'],['Ürün maliyeti','cost_gross_cents'],['Cebine kalan','cash_cents']].map(([label,key])=>`<div><dt>${label}</dt><dd class="${rows[key]<0?'is-negative':''}">${money(rows[key])}</dd></div>`).join('')}</dl>`;
const returnedComponents=entry=>(entry.component_returns||[]).map(c=>{
 const component=(entry.components||[]).find(p=>p.product_id===c.product_id);
 return `${quantity(c.quantity_milli)} ${esc(c.stock_unit||component?.stock_unit||'')} ${esc(component?.name||'Bileşen adı eksik')}`;
}).join(' · ');
export function salesReturnsMarkup(returns) {
 return `<aside class="sales-return-summary" aria-label="İade ve teslim edilemeyenlerin etkisi"><span><b>${returns.failed_count}</b> teslim edilemedi <strong>${money(returns.failed_cash_cents)}</strong></span><span><b>${returns.returned_count}</b> iade içeren paket <strong>${money(returns.returned_cash_cents)}</strong></span><small>İade / geri dönüş nakit etkisi toplamın içinde; aşağıdaki filtrelerden etkilenmez.</small></aside>`;
}
export function salesListMarkup(model,{range,sort='cok',item='',donus='performance?view=sales'}={}) {
 const sorted=[...model.visible].sort((a,b)=>{
  if(sort==='name')return a.name.localeCompare(b.name,'tr');
  if(a.cash_cents===null)return b.cash_cents===null?0:1;if(b.cash_cents===null)return -1;
  return sort==='az'?a.cash_cents-b.cash_cents:b.cash_cents-a.cash_cents;
 });
 const total=model.summary;
 return `<section class="sales-report" aria-label="Satış biçimleri">
  <div class="sales-reconcile"><span><b>${model.visible.length}</b> satış biçimi${model.filtered?' · filtrelenmiş döküm':''}</span><span>${total.reconciled?'Satış biçimleri toplamı paket toplamıyla eşleşiyor.':model.missing_packages?`${model.missing_packages} paketin satış biçimi bilgisi eksik.`:total.mismatched_packages||total.difference_cents!==null&&total.difference_cents!==0?'Satış biçimi dağılımı paket toplamıyla eşleşmiyor.':'Toplam eşleştirmesi için hesap bilgisi eksik.'}</span></div>
  ${model.filtered?'<p class="help sales-scope-note">Tür ve arama yalnız bu dökümü daraltır. Üstteki dönem toplamı ve iade giderleri korunur.</p>':''}
  ${sorted.length?`<ol class="sales-list">${sorted.map(g=>`<li><details class="sales-row" ${item===g.key?'open':''}><summary><span class="sales-identity"><span class="sales-name">${esc(g.name)}</span><span class="sales-tags"><span class="sales-kind">${salesKindLabels[g.kind]}</span>${g.channels.map(c=>`<span>${esc(names[c]||c)}</span>`).join('')}${g.estimated?'<span>Tahmini tutar içerir</span>':''}</span><small>${g.units_milli===null?'Net satış adedi belirsiz':quantity(g.units_milli)+' net satış'} · ${g.packages} paket${g.partial_returns?' · kısmi iade':''}${g.missing?' · hesap eksik':''}</small></span>${saleTotalsMarkup(g)}<span class="sales-expand" aria-hidden="true">⌄</span></summary>
   <div class="sales-detail"><div class="sales-composition"><h3>Satış içeriği</h3>${g.components.length?`<ul>${g.components.map(c=>`<li><span>${esc(c.name||'Bileşen adı eksik')}</span><strong>${quantity(c.quantity_milli)} ${esc(c.stock_unit||'')}</strong></li>`).join('')}</ul>`:'<p class="help">Bileşen bilgisi alınamadı.</p>'}<p class="help">${[...new Set(g.entries.map(e=>e.allocation_note).filter(Boolean))].map(esc).join(' ')||'Kargo ve ortak kesintiler paket hesabından paylaştırılır; satır sonucu bağımsız kargo faturası değildir.'}</p></div>
    <div class="sales-contributions"><h3>Sonucu oluşturan paketler</h3>${g.contributions.map(c=>`<article><div class="sales-contribution-head"><a href="${esc(dateRangeLink('#orders',range,{package:c.package.id,donus}))}">${esc(c.package.order_no||c.package.external_id||c.package.id)} →</a><span>${esc(names[c.package.channel]||c.package.channel)} · ${esc(kisaGun(gunu(c.package)))}</span></div>${saleTotalsMarkup(c.item)}${returnedPackage(c.package)?`<p class="sales-return-note">${c.package.teslim_edilemedi?'Teslim edilemedi':c.item.partial_return?'Kısmi iade':'İade içeren paket'} · Satış etkisi ${money(c.item.sold_cash_cents)} · İade / geri dönüş etkisi ${money(c.item.return_cash_cents)}${returnedComponents(c.item)?'<br>İade edilen: '+returnedComponents(c.item):''}</p>`:''}<details class="sales-package-detail"><summary>Paketin tamamı · ${money(c.package.cash_cents)}</summary>${paketListesi([c.package],false,donus)}</details></article>`).join('')}</div></div>
   </details></li>`).join('')}</ol>`:`<div class="ins-empty"><h3>${model.all.length?'Bu seçimde satış biçimi bulunamadı':model.summary.packages?'Satış biçimi bilgisi henüz alınamadı':'Bu dönemde satış kaydı yok'}</h3><p>${model.all.length?'Tür veya arama filtresini değiştirerek yeniden inceleyebilirsin.':model.summary.packages?'Paket dökümünden mevcut sonuçları inceleyebilirsin.':'Başka bir tarih aralığı seçebilirsin.'}</p></div>`}</section>`;
}
export function salesCsv(state,selection={}) {
 const m=salesModel(state.rows,selection),amount=v=>Number.isFinite(v)?v/100:'Bilgi eksik';
 const data=[['Lunapot · Satış biçimleri · KDV dahil'],['Tarih aralığı',state.from,state.to],['Kanal',names[selection.channel]||'Tüm kanallar'],
 ['Tür',salesKindLabels[selection.kind]||'Tümü'],['Arama',selection.query||''],['Kapsam','Tür ve arama dökümü daraltır; dönem toplamı iade etkilerini içerir.'],
 ['Dönem paket sayısı',m.summary.packages],['Dönem ciro TL',amount(m.summary.revenue_gross_cents)],['Dönem ürün maliyeti TL',amount(m.summary.cost_gross_cents)],
 ['Dönem nakit TL',amount(m.summary.cash_cents)],['Hesaplanabilen dönem nakit TL',amount(m.summary.calculated_cash_cents)],
 ['Dağıtılmamış kesintiler TL',amount(state.unallocated_fee_cents)],['Teslim edilemeyen paket',m.returns.failed_count,'Nakit etkisi TL',amount(m.returns.failed_cash_cents)],
 ['İade içeren diğer paket',m.returns.returned_count,'Nakit etkisi TL',amount(m.returns.returned_cash_cents)],[],
 ['Satış adı','Tür','Net satış adedi','Paket sayısı','Kanallar','Ciro KDV dahil TL','Ürün maliyeti KDV dahil TL','Cebine kalan TL','Satış nakit etkisi TL','İade nakit etkisi TL','Kısmi iade','Hesap bilgisi'],
 ...m.visible.map(g=>[g.name,salesKindLabels[g.kind],g.units_milli===null?'Bilgi eksik':g.units_milli/1000,g.packages,g.channels.map(c=>names[c]||c).join(', '),
 ...financialKeys.map(k=>amount(g[k])),g.partial_returns?'Var':'Yok',g.missing?'Eksik':'Hesaplandı'])];
 return '\ufeff'+data.map(row=>row.map(csvCell).join(';')).join('\r\n');
}


// Preserve package CSV columns while preventing net-only amounts from occupying gross columns.
export function packageCsvWithGrossAmounts(state,selection={}) {
 const pairs={revenue_gross_cents:'revenue_net_cents',cost_gross_cents:'cost_net_cents',shipping_gross_cents:'shipping_cents',commission_gross_cents:'commission_cents',other_gross_cents:'other_cents'};
 const rows=state.rows.map(row=>{const safe={...row};for(const [gross,net] of Object.entries(pairs))if(!Number.isFinite(row[gross])){safe[gross]=null;safe[net]=null;}return safe;});
 return performanceCsv({...state,rows},selection);
}

export function mountPerformance(root){
 const abort=new AbortController(),today=todayInIstanbul();
 const route=new URLSearchParams(location.hash.split('?')[1]||'');
 let range=parseDateRange(route,{today}),mode=route.get('mode')==='pending'?'pending':'delivered',
  channel=Object.hasOwn(names,route.get('channel'))?route.get('channel'):'',
  result=Object.hasOwn(resultLabels,route.get('result'))?route.get('result'):'all',
  sira=Object.hasOwn(SIRALAR,route.get('sort'))?route.get('sort'):'yeni',
  view=route.get('mode')==='pending'?'packages':route.has('view')?(route.get('view')==='packages'?'packages':'sales'):route.has('result')||route.has('sort')?'packages':'sales',
  kind=Object.hasOwn(salesKindLabels,route.get('kind'))?route.get('kind'):'',query=route.get('q')||'',item=route.get('item')||'',
  salesSort=['cok','az','name'].includes(route.get('order'))?route.get('order'):'cok',
  dateOpen=!!range.error||range.preset==='custom',state=null,sequence=0,busy=false,error='',firstDate='',loadAbort=null;
 root.classList.add('insights-performance');
 const scopeHash=()=>dateRangeLink('#performance',{...range,error:null},{view,mode:mode==='pending'?'pending':'',channel,result:result==='all'?'':result,sort:sira==='yeni'?'':sira,kind,q:query,item,order:salesSort==='cok'?'':salesSort}).slice(1);
 const rememberScope=()=>history.replaceState(null,'','#'+scopeHash());
 function render(){
  if(abort.signal.aborted)return;
  const pending=mode==='pending',rows=selectPerformanceRows(state?.rows||[],{channel,result});
  const sales=salesModel(state?.rows||[],{channel,kind,query,item});
  const summary={...performanceSummary(selectPerformanceRows(state?.rows||[],{channel})),...(view==='sales'?sales.summary:{})};
  const controls=`<details class="ins-date-disclosure" ${dateOpen||range.error?'open':''}><summary>Tarih <span>${esc(dateRangeLabel(range))}</span></summary>${dateFilterMarkup(range,{busy,basis:pending?'Sipariş tarihi':'Teslim / sonuç tarihi',firstDate})}</details>
   <form class="ins-channel-filter sales-filters" data-performance-filter><label>Kanal<select name="channel" ${busy?'disabled':''}><option value="">Tüm kanallar</option>${Object.entries(names).map(([id,name])=>`<option value="${id}" ${channel===id?'selected':''}>${name}</option>`).join('')}</select></label>
   ${view==='sales'?`<label>Satış biçimi<select name="kind" ${busy?'disabled':''}><option value="">Tüm biçimler</option>${Object.entries(salesKindLabels).map(([id,label])=>`<option value="${id}" ${kind===id?'selected':''}>${label}</option>`).join('')}</select></label><label class="sales-search">Ürün veya set adı<input type="search" name="q" value="${esc(query)}" placeholder="Satış adı veya bileşen ara" ${busy?'disabled':''}></label>`:''}<button class="secondary" type="submit" ${busy?'disabled':''}>Uygula</button>
   ${view==='sales'?`<label>Sırala<select data-sales-sort><option value="cok" ${salesSort==='cok'?'selected':''}>En çok kalan</option><option value="az" ${salesSort==='az'?'selected':''}>En az kalan</option><option value="name" ${salesSort==='name'?'selected':''}>Ada göre</option></select></label>`:''}
   ${view==='sales'&&(kind||query||item)?'<button type="button" class="text-button" data-sales-reset>Tür ve aramayı temizle</button>':''}</form>`;
  root.setAttribute('aria-busy',String(busy));
  root.innerHTML=`<div class="page-heading"><div><span class="eyebrow">E-TİCARET / PERFORMANS</span><h1>${view==='sales'?'Satış biçimleri':'Paket sonuçları'}</h1><p>${view==='sales'?'Depoda ürün sayılır; burada sattığın tekli ürün, paket veya setin sonucu görünür.':pending?'Hazırlanan ve kargodaki paketlerin tahmini sonucu.':'Teslim edilen ve sonuçlanan paketlerin ciro ve nakit sonucu.'}</p></div><button type="button" class="primary" data-export ${busy||!(view==='sales'?sales.visible.length:rows.length)?'disabled':''}>Dökümü indir</button></div>
   <div class="performance-tabs sales-view-tabs" role="group" aria-label="Görünüm"><button type="button" class="secondary" data-view="sales" aria-pressed="${view==='sales'}" ${busy?'disabled':''}>Satış biçimleri</button><button type="button" class="secondary" data-view="packages" aria-pressed="${view==='packages'}" ${busy?'disabled':''}>Paket dökümü</button></div>
   <div class="performance-tabs" role="group" aria-label="Kâr raporu türü" ${view==='sales'?'hidden':''}><button type="button" data-mode="delivered" aria-pressed="${!pending}" class="secondary" ${busy?'disabled':''}>Teslim edilenler</button><button type="button" data-mode="pending" aria-pressed="${pending}" class="secondary" ${busy?'disabled':''}>Bekleyen paketler · Tahmin</button></div>
   ${busy||!state?controls:''}
   <div class="ins-error" data-performance-error role="alert" ${error?'':'hidden'}>${esc(error)}${error?'<button type="button" class="secondary" data-performance-retry>Yeniden dene</button>':''}</div>
   ${busy?'<div class="ins-loading" role="status"><span class="loading">Paketler ve hesaplar hazırlanıyor…</span></div>':state?`
   ${state.unallocated_fee_cents>0?`<aside class="ins-quality"><strong>Mutabakat bekliyor</strong><p>${money(state.unallocated_fee_cents)} kesinti henüz satışlara dağıtılmadı; dönem sonucu tamamlanmış sayılmaz. <a href="#reconciliation">Kesintileri eşleştir →</a></p></aside>`:''}
   <div class="ins-kpis ins-report-kpis" aria-label="Tarih ve kanal seçiminin özeti">
    <article class="ins-kpi"><span>Ciro <small>KDV dahil</small></span><strong>${money(summary.revenue_gross_cents)}</strong><small>${summary.revenue_missing?summary.revenue_missing+' pakette ciro eksik':summary.packages+(pending?' bekleyen paket':' sonuçlanan paket')}</small></article>
    <article class="ins-kpi ins-kpi-primary"><span>${pending?'Tahmini cebine kalan':'Cebine kalan'} <small>KDV dahil</small></span><strong class="${summary.cash_cents<0?'is-negative':''}">${money(summary.cash_cents)}</strong>${view==='sales'&&summary.missing&&summary.calculated_cash_cents!==null?`<small>Hesaplanabilen ${money(summary.calculated_cash_cents)}</small>`:''}<small>${summary.missing?summary.missing+' paket eksik · hesaplanabilen tutar':summary.estimated?summary.estimated+' paket tahmini tutar içerir':summary.packages?'Hesaplanan paket toplamı':'Bu seçimde paket yok'}</small></article>
    ${view==='sales'?`<article class="ins-kpi"><span>Ürün maliyeti <small>KDV dahil</small></span><strong>${money(summary.cost_gross_cents)}</strong><small>${summary.cost_gross_cents===null&&summary.calculated_cost_gross_cents!==null?'Hesaplanabilen '+money(summary.calculated_cost_gross_cents):'Paketlerdeki ürün maliyeti toplamı'}</small></article>`:`<article class="ins-kpi"><span>Nakit marjı</span><strong>${summary.margin_bps==null?'—':new Intl.NumberFormat('tr-TR',{style:'percent',maximumFractionDigits:1}).format(summary.margin_bps/10000)}</strong><small>Ciro ve nakdi hesaplanabilen ${summary.margin_packages} ortak paket</small></article>`}
    <article class="ins-kpi"><span>Zarar eden paketler</span><strong>${summary.losses??'—'}</strong><small>${money(summary.loss_cents)} · KDV dahil${summary.missing?' · eksik paketler dahil değil':''}</small></article>
   </div>
   ${pending?pendingStatusMarkup(Object.fromEntries([['preparing',['draft','reserved']],['shipped',['shipped']]].map(([key,statuses])=>{const group=(state.rows||[]).filter(r=>(!channel||r.channel===channel)&&statuses.includes(r.status));return [key,{packages:group.length,cash_cents:sumExact(group,'cash_cents'),missing:group.filter(r=>!Number.isFinite(r.cash_cents)).length}];}))) :''}
   ${view==='sales'?salesReturnsMarkup(sales.returns)+controls+salesListMarkup(sales,{range,sort:salesSort,item,donus:scopeHash()}):controls+(pending?'':salesReturnsMarkup(sales.returns))+`   <section class="ins-performance-channels" aria-label="Kanal hesapları">${Object.keys(names).map(k=>{
    const c=state.channels?.find(x=>x.channel===k),count=c?.packages??0,calculated=c?.cash_calculated??0;
    return `<article class="performance-card ${pending?'estimate':''} ${channel===k?'secili':''}"><div class="performance-card-head"><h2><i class="pn-key ${k==='trendyol'?'pn-ty':'pn-hb'}" aria-hidden="true"></i>${names[k]}</h2><button type="button" class="secondary" data-performance-channel="${k}" aria-pressed="${channel===k}">${channel===k?'Filtreyi kaldır':'Bu kanalı göster'}</button></div><span class="ins-status ${pending?'is-estimated':calculated<count?'is-incomplete':''}">${pending?'Tahmini':calculated<count?'Hesap eksik':'Hesaplandı'}</span><strong class="performance-value ${c?.cash_cents<0?'is-negative':''}">${count===0?'Paket yok':money(calculated<count?c?.calculated_cash_cents:c?.cash_cents)}</strong><p>${count} paket · ${calculated} hesaplandı · ${count-calculated} bilgi bekliyor</p>${calculated<count?'<p class="help">Gösterilen tutar yalnız hesaplanabilen paketlere aittir.</p>':''}${c?.cash_losses?`<p class="is-negative">${c.cash_losses} paket zarar gösteriyor.</p>`:''}${c?.calculated_profit_cents!=null?`<small>KDV hariç katkı: ${money(c.calculated_profit_cents)}</small>`:''}${c?.awaiting_delivery?`<details><summary>${c.awaiting_delivery} paketin teslim onayı bekleniyor</summary><p>${c.awaiting_delivery_since?'En eski sipariş: '+esc(c.awaiting_delivery_since)+'. ':''}Teslim onayı olmadığı için teslim toplamına girmedi.</p><a href="#orders?watch=long_shipping">Kargodakileri gör →</a></details>`:''}</article>`;
   }).join('')}</section>
   <section class="ins-report-list"><div class="pn-head"><div><span class="eyebrow">${pending?'TAHMİNİ PAKET SONUÇLARI':'PAKET DÖKÜMÜ'} · KDV DAHİL</span><h2>${rows.length} paket</h2></div><label class="pf-sort">Sırala<select data-performance-sort>${Object.entries(SIRALAR).map(([k,t])=>`<option value="${k}" ${sira===k?'selected':''}>${t}</option>`).join('')}</select></label></div><div class="performance-tools" role="group" aria-label="Paket sonucu filtresi">${Object.entries(resultLabels).map(([key,label])=>`<button type="button" class="secondary" data-result="${key}" aria-pressed="${result===key}">${label}<span>${selectPerformanceRows(state.rows,{channel,result:key}).length}</span></button>`).join('')}</div><p class="help">Özetler tarih ve kanal seçimine aittir. Sonuç filtresi yalnız aşağıdaki dökümü ve indirmeyi değiştirir.</p>${rows.length?paketListesi(sirala(rows,sira),pending,scopeHash()):'<div class="ins-empty"><h3>Bu seçimde paket bulunamadı</h3><p>Tarih, kanal veya sonuç filtresini değiştirerek tekrar inceleyebilirsin.</p></div>'}</section>
`}
   <details class="ins-report-notes"><summary>Kapsam, hesap yöntemi ve güncellik</summary><p>${esc(state.notice)}</p><p>${esc(state.cost_notice)}</p><p>Güncellendi: ${state.as_of&&Number.isFinite(Date.parse(state.as_of))?esc(new Date(state.as_of).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})):'Bilgi alınamadı'}</p></details>`:''}`;
 }
 async function getJson(url,signal=abort.signal){const response=await fetch(url,{signal}),data=await response.json();if(!response.ok)throw Error(data.error||'Rapor alınamadı.');return data;}
 async function load(focus=''){
  const mine=++sequence,requestedMode=mode;loadAbort?.abort();loadAbort=new AbortController();
  const requestSignal=AbortSignal.any([abort.signal,loadAbort.signal]);
  state=null;error='';busy=true;render();
  try{
   if(range.error)throw Error(range.error);
   if(range.preset==='tum'&&!range.from){
    const panorama=await getJson('/api/ec/panorama',requestSignal);if(mine!==sequence||abort.signal.aborted)return;
    firstDate=(mode==='pending'?panorama.pending?.from:panorama.first_delivered)||panorama.today||today;
    range={preset:'tum',from:firstDate,to:panorama.today||today,error:null};
   }
   const requestedRange={...range};
   const data=await loadPerformancePages({mode:requestedMode,from:requestedRange.from,to:requestedRange.to,signal:requestSignal,
    isCurrent:()=>mine===sequence&&!abort.signal.aborted,
    requestPage:(cursor,signal)=>{const query=new URLSearchParams(dateRangeQuery(requestedRange));query.set('mode',requestedMode);query.set('cursor',cursor);return getJson('/api/ec/performance?'+query,signal);},
    onProgress:progress=>{if(mine!==sequence||abort.signal.aborted)return;const status=root.querySelector('.ins-loading .loading');if(status)status.textContent=progress.pages+' sayfa · '+progress.packages.toLocaleString('tr-TR')+' paket alındı. Rapor tamamlanıyor…';}});
   if(mine!==sequence||abort.signal.aborted)return;
   state=data;rememberScope();
  }catch(e){if(e.name==='AbortError'||mine!==sequence||abort.signal.aborted)return;error=e.message||'Rapor alınamadı.';}
  if(mine!==sequence||abort.signal.aborted)return;
  busy=false;render();if(focus)root.querySelector(focus)?.focus();
 }
 root.addEventListener('toggle',e=>{if(e.target.matches('.ins-date-disclosure'))dateOpen=e.target.open;},{signal:abort.signal,capture:true});
 bindDateFilter(root,{signal:abort.signal,today,onChange:next=>{range=next;rememberScope();load(next.preset==='custom'?'[data-date-form] [name="from"]':'[data-date-preset="'+next.preset+'"]');}});
 root.addEventListener('submit',e=>{if(!e.target.matches('[data-performance-filter]'))return;e.preventDefault();if(busy)return;const values=new FormData(e.target);channel=values.get('channel');if(view==='sales'){kind=values.get('kind')||'';query=values.get('q')||'';item='';}rememberScope();render();root.querySelector('[name="channel"]')?.focus();},{signal:abort.signal});
 root.addEventListener('change',e=>{if(e.target.matches('[data-sales-sort]')){salesSort=e.target.value;rememberScope();render();root.querySelector('[data-sales-sort]')?.focus();return;}if(!e.target.matches('[data-performance-sort]'))return;sira=e.target.value;rememberScope();render();root.querySelector('[data-performance-sort]')?.focus();},{signal:abort.signal});
 root.addEventListener('click',e=>{
  const b=e.target.closest('[data-mode],[data-result],[data-export],[data-performance-channel],[data-performance-retry],[data-view],[data-sales-reset]');if(!b||b.disabled||busy)return;
  if(b.hasAttribute('data-performance-retry')){load();return;}
  if(b.hasAttribute('data-sales-reset')){kind='';query='';item='';rememberScope();render();root.querySelector('[name="q"]')?.focus();return;}
  if(b.dataset.view){view=b.dataset.view;if(view==='sales'&&mode==='pending'){mode='delivered';firstDate='';if(range.preset==='tum')range={preset:'tum',from:'',to:'',error:null};rememberScope();load();return;}rememberScope();render();root.querySelector('[data-view="'+view+'"]')?.focus();return;}
  if(b.dataset.mode){if(b.dataset.mode===mode)return;mode=b.dataset.mode;firstDate='';if(range.preset==='tum')range={preset:'tum',from:'',to:'',error:null};rememberScope();load('[data-mode="'+mode+'"]');return;}
  if(b.dataset.performanceChannel){channel=channel===b.dataset.performanceChannel?'':b.dataset.performanceChannel;rememberScope();render();root.querySelector('[data-performance-channel="'+b.dataset.performanceChannel+'"]')?.focus();return;}
  if(b.dataset.result){result=b.dataset.result;rememberScope();render();root.querySelector('[data-result="'+result+'"]')?.focus();return;}
  if(b.hasAttribute('data-export')&&state){const url=URL.createObjectURL(new Blob([view==='sales'?salesCsv(state,{channel,kind,query,item}):packageCsvWithGrossAmounts(state,{channel,result})],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='lunapot-'+view+'-'+mode+'-'+range.from+'-'+range.to+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 },{signal:abort.signal});
 load();return ()=>{abort.abort();root.classList.remove('insights-performance');root.removeAttribute('aria-busy');};
}
