import {mountQuickLogin} from './quick-access-ui.js';
let disposeQuickLogin=null;
import {workspaceNavigation} from './workspace-navigation.js';
import {accessAllowed,staffHome} from './access-ui.js';
import {openRecipeStudio,requestRecipeLeave,disposeRecipeStudio} from './recipe-studio.js';
import {calculate,pricing,units} from './costs.js';
import {icon} from './ui-icons.js';
import {createRouteLoader,createSessionOwner} from './route-loader.js';
import {can} from './permissions.js';
const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amountsVisible=()=>can(currentUser,'lp','amounts');
const money=v=>!amountsVisible()?'Tutarları görme yetkin yok':v===null||v===undefined?'Bilinmiyor':new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY',maximumFractionDigits:2}).format(v);
const decimal=v=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:4}).format(v);
const legacyIcons={dashboard:'▦',products:'◇',materials:'▤',recipes:'▧',costs:'∑',accounts:'₺',ai:'✧'};
// Menu isleri konusuna gore gruplar; anahtarlar degismedigi icin mevcut #adresler ve hizli gecis calisir.
// Hammadde karti ile depo hareketi ayni grupta durur, iki ayri kart sistemi gibi gorunmez.
const titles={dashboard:'Genel durum',production:'Üretim kayıtları',products:'Ürünler',recipes:'Reçeteler',costs:'Maliyet hesaplama',materials:'Hammaddeler',materialstock:'Hammadde deposu',barcodes:'Barkod',lots:'Parti ve koli etiketi',accounts:'Alış ve stok',catalog:'Ürün bağlantıları',ledger:'Cariler ve nakit',offers:'Teklif ve belgeler',reconciliation:'Kesinti eşleştirme',settings:'Şirket ve yedek',ai:'Lunapot AI'};
let data={products:[],materials:[],recipes:[],activity:[]}, route=location.hash.slice(1)||'dashboard', search='', modal=null, editing=null, draftItems=[], refreshing=null;
let currentUser=null,authenticated=false,dataReady=false;
let installPrompt=null;
const routeLoader=createRouteLoader(),session=createSessionOwner();
let loggingOut=false,startupRetry=start,navigationRevision=0,deferredRenderCleanup=null;
const historyKey='lunapotProductionRoute',historyOwner=history.state?.[historyKey]?.owner||crypto.randomUUID();
let acceptedHash=location.hash,acceptedIndex=history.state?.[historyKey]?.index??0,observedIndex=acceptedIndex;
function stampHistory(index){history.replaceState({...history.state,[historyKey]:{owner:historyOwner,index}},'',location.href);return index;}
stampHistory(acceptedIndex);
function historyIndex(){const entry=history.state?.[historyKey];observedIndex=entry?.owner===historyOwner?entry.index:stampHistory(observedIndex+1);return observedIndex;}
function acceptLocation(){acceptedHash=location.hash;acceptedIndex=historyIndex();route=acceptedHash.slice(1)||'dashboard';}
async function navigateHash(){
 const revision=++navigationRevision,owner=session.capture(),nextHash=location.hash,nextIndex=historyIndex();
 if(nextHash===acceptedHash&&nextIndex===acceptedIndex)return; // Returning to the displayed history entry after cancellation.
 if(authenticated){
  const root=$('#modal-root'),allowed=await requestRecipeLeave(root);
  if(revision!==navigationRevision||!owner.isCurrent())return;
  if(!allowed){history.go(acceptedIndex-nextIndex);return;}
  disposeRecipeStudio(root);
 }
 if(revision!==navigationRevision||!owner.isCurrent())return;
 acceptedHash=nextHash;acceptedIndex=nextIndex;route=nextHash.slice(1)||'dashboard';search='';
 if(authenticated){if(dataReady)await render();else await refresh(owner);}
}
function resetSession(){
 ++navigationRevision;deferredRenderCleanup?.();disposeRecipeStudio($('#modal-root'));
 const owner=session.begin();authenticated=false;currentUser=null;dataReady=false;loggingOut=false;
 data={products:[],materials:[],recipes:[],activity:[]};refreshing=null;modal=null;editing=null;draftItems=[];
 disposeQuickLogin?.();disposeQuickLogin=null;routeLoader.begin();return owner;
}
async function api(path,options={},owner=session.capture()){
 owner.check();
 const response=await fetch('/api'+path,{...options,signal:owner.signal,headers:{'Content-Type':'application/json',...options.headers}});owner.check();
 let result;try{result=await response.json();}catch(error){owner.check();if(error.name==='AbortError')throw error;throw new Error('Sunucuya ulaşılamıyor. Lütfen tekrar deneyin.');}owner.check();
 if(!response.ok){if(response.status===401&&!path.startsWith('/auth/')){await start();owner.check();}throw new Error(result.error||'İşlem tamamlanamadı.');}
 return result;
}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),4500);}
const empty=(icon,title,text,action)=>`<div class="empty"><span class="empty-icon">${icon}</span><h3>${title}</h3><p>${text}</p>${action||''}</div>`;
const btn=(text,action,cls='primary')=>`<button class="${cls}" data-action="${action}">${text}</button>`;
const costAvailable=r=>amountsVisible()&&r&&r.items.every(i=>{const price=data.materials.find(m=>m.id===i.material_id)?.price;return price!==null&&price!==undefined;})&&['labor','packaging','overhead'].every(k=>r[k]!==null&&r[k]!==undefined);
const productCost=p=>{const recipe=data.recipes.find(r=>r.product_id===p.id);return !recipe?null:costAvailable(recipe)?calculate(recipe,data.materials):{unitCost:null};};
async function refresh(owner=session.capture()){
 if(!owner.isCurrent()||!authenticated||!currentUser)return false;
 if(refreshing)return refreshing.promise;
 const pending={promise:null};refreshing=pending;
 pending.promise=(async()=>{
  try{const result=await api('/data',{},owner);owner.check();if(!authenticated||!currentUser)return false;data=result;dataReady=true;await render();return owner.isCurrent()&&authenticated;}
  catch(error){if(!owner.isCurrent()||error.name==='AbortError')return false;throw error;}
  finally{if(refreshing===pending)refreshing=null;}
 })();return pending.promise;
}
function shell(){ $('#app').innerHTML=`<aside id="sidebar"><a class="brand" href="#dashboard"><img src="/icon.svg" alt=""><span>lunapot<span class="brand-sub">YÖNETİM PANELİ</span></span></a><nav aria-label="Ana menü">${workspaceNavigation('lp',titles,route,currentUser,icon)}</nav><div class="sidebar-foot"><a class="workspace-home" href="${currentUser?.owner?'/access':'/access#account'}">${currentUser?.owner?'Ekip ve yetkiler':'Hesabım'}</a><a class="workspace-home" href="/">▦ Tüm uygulamalar</a><div class="version"><span class="status-dot"></span> Lunapot v3.0</div><p>Üretimin her adımı,<br>tek bir yerde.</p></div></aside><div class="workspace"><header><button class="mobile-menu icon-button" data-action="menu" aria-label="Menüyü aç">☰</button><strong class="mobile-workspace">Lunapot</strong><div class="breadcrumb">Çalışma alanı <span>/</span> <strong>${titles[route]||titles.dashboard}</strong></div><div class="header-actions"><a class="app-launcher-link" href="/" aria-label="Ana ekran · Uygulamalar"><span aria-hidden="true">▦</span> Uygulamalar</a><span class="connection ${navigator.onLine?'':'offline'}">${navigator.onLine?'● Çevrimiçi':'● Çevrimdışı'}</span><button class="icon-button" data-action="refresh" aria-label="Verileri yenile">↻</button><button class="avatar" data-action="logout" aria-label="Oturumu kapat" title="Oturumu kapat">L</button></div></header><main id="content"></main><footer><span>Lunapot · Ürün ve maliyet yönetimi</span><button class="text-button" data-action="install">Telefona ekle ↗</button></footer></div><div id="modal-root"></div>`; }
function pageHeading(title,subtitle,action=''){return `<div class="page-heading"><div><span class="eyebrow">ÜRETİM / ${esc(titles[route]||'Çalışma masası')}</span><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;}
const routeViews={
 production:{load:()=>import('./production-ui.js'),mount:(module,root)=>module.mountProduction(root)},
 materialstock:{load:()=>import('./production-ui.js'),mount:(module,root)=>module.mountProduction(root,'materials')},
 accounts:{load:()=>import('./accounting-ui.js'),mount:(module,root)=>module.mountAccounting(root,'lp','overview',true)},
 catalog:{load:()=>import('./catalog-ui.js'),mount:(module,root)=>module.mountCatalog(root,'lp')},
 reconciliation:{load:()=>import('./reconciliation-ui.js'),mount:(module,root)=>module.mountReconciliation(root,'lp')},
 ledger:{load:()=>import('./business-ui.js'),mount:(module,root)=>module.mountBusiness(root,'lp','ledger')},
 lots:{load:()=>import('./lot-ui.js'),mount:(module,root)=>module.mountLots(root,'lp')},
 barcodes:{load:()=>import('./barcode-ui.js'),mount:(module,root)=>module.mountBarcodes(root,'lp')},
 offers:{load:()=>import('./offers-ui.js'),mount:(module,root)=>module.mountOffers(root,'lp')},
 settings:{load:()=>import('./operations-ui.js'),mount:(module,root)=>module.mountOperations(root,'lp','settings')}
};
function deferStudioRender(root){
 if(deferredRenderCleanup)return;
 const owner=session.capture(),observer=new MutationObserver(()=>{
  if(!root.isConnected||!owner.isCurrent()){deferredRenderCleanup?.();return;}
  if(root.querySelector('.recipe-studio'))return;
  deferredRenderCleanup?.();if(authenticated)render();
 });
 deferredRenderCleanup=()=>{observer.disconnect();deferredRenderCleanup=null;};
 observer.observe(root,{childList:true,subtree:true});
}
async function render(){
 if(!authenticated||!currentUser)return;
 const root=$('#modal-root');
 // Automatic refresh must retain the editor, its draft and focus without asking to discard.
 // Navigation asks requestRecipeLeave before it reaches this point; accepted saves/close release this deferral.
 if(root?.querySelector('.recipe-studio')){deferStudioRender(root);return;}
 deferredRenderCleanup?.();
 const view=routeLoader.begin();
 if(!accessAllowed(currentUser,'lp',$('#app')))return;
 if(!Object.hasOwn(titles,route))route='dashboard';
 const current=route;shell();const content=$('#content');
 content.classList.toggle('production-view',['dashboard','products','materials','recipes','costs','production','materialstock','lots','barcodes','ai'].includes(current));
 if(current==='dashboard'){
  content.innerHTML=currentUser.owner?dashboard():staffHome(currentUser,'lp');
  if(currentUser.owner)await view.mount(content,()=>import('./production-ui.js'),module=>module.mountProductionReadiness(content),{label:'Üretim hazırlığı',statusRoot:content.querySelector('[data-production-readiness]')});
 }
 if(current==='products')content.innerHTML=products();
 if(current==='materials')content.innerHTML=materials();
 if(current==='recipes')content.innerHTML=recipes();
 if(current==='costs'){content.innerHTML=costs();updateCalculation();}
 const feature=Object.hasOwn(routeViews,current)?routeViews[current]:null;
 if(feature)await view.mount(content,feature.load,module=>feature.mount(module,content),{label:titles[current]});
 if(current==='ai')content.innerHTML=pageHeading('Lunapot AI','İleride açılabilecek çalışma alanınız.')+`<section class="ai-panel"><span class="ai-symbol">✧</span><span class="pill neutral">Şu anda kapalı</span><h2>Yapay zekâ alanınız hazır.</h2><p>İlk sürümde yapay zekâ bağlantısı bulunmuyor.<br>Ürün, hammadde ve maliyet işlemlerinizi menüden yönetebilirsiniz.</p><div class="disabled-input">Lunapot AI'ya bir şey sor…<button disabled aria-label="AI kapalı">↑</button></div><small>API bağlantısı yok · AI kullanım ücreti yok</small></section>`;
 if(view.isCurrent(content)&&!navigator.onLine)content.insertAdjacentHTML('afterbegin','<div class="notice">İnternet bağlantısı yok. Verileri görüntülemek ve kaydetmek için bağlantınızı yeniden kurun.</div>');
}
function dashboard(){
 const completed=data.products.filter(p=>productCost(p)),missing=data.products.length-completed.length;
 return pageHeading('Üretim masası','Malzemeyi kontrol et, üretimi kaydet, kolileri hazırla.','<a class="primary" href="#production">Üretim kaydet →</a>')+`
 <div class="production-context"><span>Güncel durum</span><span>Reçete maliyetleri referans alış fiyatlarıyla hesaplanır.</span></div>
 <div class="production-metrics"><a href="#products"><span>Ürün kataloğu</span><strong>${data.products.length}</strong><small>Ürünleri ve fiyatları aç →</small></a><a href="#recipes"><span>Reçeteli ürün</span><strong>${completed.length}</strong><small>Reçetesi bulunan ürün</small></a><a href="#recipes" class="${missing?'needs-attention':''}"><span>Reçete bekleyen</span><strong>${missing}</strong><small>${missing?'Eksik reçeteleri tamamla →':'Tüm ürünlerin reçetesi var'}</small></a></div>
 <section class="card production-readiness" data-production-readiness aria-live="polite"><div class="card-heading"><h2>Bugün ne üretebilirim?</h2></div><p class="pad" role="status">Güncel hammadde stoku kontrol ediliyor…</p></section>
 <nav class="production-shortcuts" aria-label="Üretim iş akışı"><a href="#materialstock"><span>01 · Hammadde</span><strong>Depoyu kontrol et</strong><small>Giriş, sayım ve tüketim →</small></a><a href="#production"><span>02 · Üretim</span><strong>Tamamlanan işi kaydet</strong><small>Gerçek tüketim ve mamul girişi →</small></a><a href="#lots"><span>03 · Paketleme</span><strong>Koli etiketlerini hazırla</strong><small>Parti bilgisi ve baskı →</small></a></nav>
 <div class="production-dashboard-grid"><section class="card"><div class="card-heading"><div><h2>Reçete maliyetleri</h2><p class="help">Tahmini birim maliyet · KDV hariç</p></div><a href="#costs">Fiyat hesapla →</a></div>${completed.length?`<div class="table-wrap"><table><thead><tr><th>Ürün</th><th>Tahmini maliyet</th><th>Kayıtlı satış · KDV hariç</th></tr></thead><tbody>${completed.slice(0,6).map(p=>`<tr><td data-label="Ürün"><strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small></td><td data-label="Tahmini maliyet">${money(productCost(p).unitCost)}<small>KDV hariç</small></td><td data-label="Kayıtlı satış">${money(p.sale_price)}<small>KDV hariç · brüt fiyat için oran gerekir</small></td></tr>`).join('')}</tbody></table></div>`:empty('∑','İlk reçeteni hazırla','Hammadde ve ürün kartlarını ekledikten sonra birim maliyetini hesaplayabilirsin.',btn('Hammadde ekle','new-material'))}</section>
 <section class="card"><div class="card-heading"><h2>${!data.products.length||missing?'Hazırlığı tamamla':'Çalışma alanın hazır'}</h2><span class="pill">${[data.materials.length,data.products.length,data.recipes.length&&!missing].filter(Boolean).length}/3</span></div>${[['materials','Hammadde kartları',data.materials.length+' kart · referans alış fiyatları',data.materials.length],['products','Ürün kataloğu',data.products.length+' ürün · kod ve satış fiyatı',data.products.length],['recipes','Üretim reçeteleri',missing?missing+' ürünün reçetesi eksik':'Malzeme, fire ve giderler',data.recipes.length&&!missing]].map(([key,title,desc,done],i)=>`<a class="step" href="#${key}"><span class="step-number ${done?'done':''}">${done?'✓':i+1}</span><div><strong>${title}</strong><p>${desc}</p></div><span aria-hidden="true">→</span></a>`).join('')}<details class="production-help"><summary>Fiyat değişiklikleri nasıl yansır?</summary><p>Hammadde kartındaki fiyat, bağlı reçetelerin tahmini maliyetini günceller. Kaydedilmiş üretimin gerçekleşen maliyeti değişmez.</p></details></section></div>
 <section class="card production-activity"><div class="card-heading"><h2>Son kayıt hareketleri</h2><span class="muted">Son ${data.activity.length} kayıt</span></div>${data.activity.length?data.activity.map(a=>`<div class="activity-row"><span class="activity-dot" aria-hidden="true"></span><span>${esc(a.description)}</span><time>${new Date(a.created_at).toLocaleString('tr-TR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</time></div>`).join(''):'<p class="muted pad">Henüz hareket yok. Eklediğin kayıtlar burada listelenecek.</p>'}</section>`;
}
const toolsBar=(placeholder,count)=>`<div class="toolbar"><label class="production-search">Listede ara<input id="search" type="search" placeholder="${placeholder}" value="${esc(search)}"></label><span class="muted" role="status">${count} kayıt</span></div>`;
const matches=(...values)=>values.join(' ').toLocaleLowerCase('tr-TR').includes(search.toLocaleLowerCase('tr-TR'));
function products(){
 const list=data.products.filter(p=>matches(p.name,p.sku,p.category));
 return pageHeading('Ürün kataloğu','Ürün adı, satış fiyatı ve reçete hazırlığı.',btn('+ Ürün ekle','new-product'))+`<section class="card">${toolsBar('Ürün adı, kodu veya kategori',list.length)}<div class="production-context"><span>${data.products.filter(p=>productCost(p)).length} reçeteli ürün</span><span>Kayıtlı fiyatlar KDV hariçtir. Brüt fiyat için maliyet hesabında KDV oranını seç.</span></div>${list.length?`<div class="table-wrap"><table><thead><tr><th>Ürün / kod</th><th>Kategori</th><th>Tahmini birim maliyet</th><th>Kayıtlı satış</th><th>Reçete</th><th>İşlem</th></tr></thead><tbody>${list.map(p=>{const c=productCost(p),r=data.recipes.find(r=>r.product_id===p.id);return `<tr><td data-label="Ürün"><strong>${esc(p.name)}</strong><small>${esc(p.sku)}</small></td><td data-label="Kategori">${esc(p.category)||'—'}</td><td data-label="Tahmini maliyet">${c?money(c.unitCost):'Reçete gerekli'}${c?'<small>KDV hariç</small>':''}</td><td data-label="Kayıtlı satış">${money(p.sale_price)}<small>KDV hariç</small></td><td data-label="Reçete"><span class="pill ${c?'':'neutral'}">${c?'Hazır':'Eksik'}</span>${r?`<button class="text-button" data-edit="recipes" data-id="${r.id}">Aç</button>`:''}</td><td data-label="İşlem"><div class="production-row-actions"><button class="text-button" data-edit="products" data-id="${p.id}">Düzenle</button><button class="text-button danger" data-delete="products" data-id="${p.id}">Sil</button></div></td></tr>`;}).join('')}</tbody></table></div>`:empty('◇',search?'Ürün bulunamadı':'Henüz ürün yok',search?'Ürün adı, kodu veya başka bir kategori deneyin.':'İlk ürününü ekleyerek kataloğunu oluşturmaya başla.',search?'':btn('+ İlk ürünü ekle','new-product'))}</section>`;
}
function materials(){
 const list=data.materials.filter(m=>matches(m.name,m.supplier));
 return pageHeading('Hammadde kartları','Üretimde kullanılan malzemeler ve referans alış fiyatları.',btn('+ Hammadde ekle','new-material'))+`<section class="card">${toolsBar('Hammadde veya tedarikçi',list.length)}<div class="production-context"><span>Fiyat kartı · KDV hariç</span><a href="#materialstock">Güncel depo miktarlarını aç →</a></div>${list.length?`<div class="table-wrap"><table><thead><tr><th>Hammadde</th><th>Alış birimi</th><th>Referans birim fiyat</th><th>Tedarikçi</th><th>Bağlı reçete</th><th>İşlem</th></tr></thead><tbody>${list.map(m=>`<tr><td data-label="Hammadde"><strong>${esc(m.name)}</strong></td><td data-label="Alış birimi">${esc(m.unit)}</td><td data-label="Referans fiyat">${money(m.price)}${amountsVisible()?' / '+esc(m.unit):''}<small>KDV hariç</small></td><td data-label="Tedarikçi">${esc(m.supplier)||'Belirtilmedi'}</td><td data-label="Bağlı reçete">${data.recipes.filter(r=>r.items.some(i=>i.material_id===m.id)).length}</td><td data-label="İşlem"><div class="production-row-actions"><button class="text-button" data-edit="materials" data-id="${m.id}">Düzenle</button><button class="text-button danger" data-delete="materials" data-id="${m.id}">Sil</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('▤',search?'Hammadde bulunamadı':'Malzemelerinle başla',search?'Farklı bir hammadde veya tedarikçi adı deneyin.':'Üretimde kullandığın hammaddeleri alış birimi ve referans fiyatıyla ekle.',search?'':btn('+ İlk hammaddeyi ekle','new-material'))}</section><details class="production-help"><summary>Hammadde kartı ile depo arasındaki fark</summary><p>Farklı marka ve tedarikçi alışlarını aynı ana hammaddeye bağlayabilirsin. Karttaki fiyat reçete hesabında kullanılır; stok miktarı yalnızca depo hareketleriyle değişir.</p></details>`;
}
function recipePrerequisites(){
 if(data.products.length&&data.materials.length)return '';
 return '<section class="card pad" data-recipe-prerequisites tabindex="-1"><h2>Reçete için hazırlığı tamamla</h2><p>Reçete oluşturmak için en az bir ürün ve hammadde kartı gerekli.</p><div class="recipe-actions">'+(!data.products.length?'<a class="secondary" href="#products">Ürünlere git →</a>':'')+(!data.materials.length?'<a class="secondary" href="#materials">Hammaddelere git →</a>':'')+'</div></section>';
}
function recipes(){
 const list=data.recipes.filter(r=>{const p=data.products.find(p=>p.id===r.product_id);return matches(p?.name,p?.sku,r.notes);});
 return pageHeading('Üretim reçeteleri','Malzeme, fire ve giderlerden birim maliyete.',btn('+ Reçete oluştur','new-recipe'))+recipePrerequisites()+`<section class="card production-list-tools">${toolsBar('Ürün adı, kodu veya reçete notu',list.length)}</section>`+(list.length?`<div class="recipe-grid">${list.map(r=>{const p=data.products.find(p=>p.id===r.product_id),c=costAvailable(r)?calculate(r,data.materials):{unitCost:null};return `<article class="card recipe-card"><div class="recipe-top"><span class="eyebrow">${esc(p?.sku||'REÇETE')}</span><span class="pill">${r.items.length} hammadde</span></div><h2>${esc(p?.name||'Ürün bulunamadı')}</h2><p class="muted">${decimal(r.yield_qty)} adet üretim · %${decimal(r.waste_pct)} fire ek payı</p><div class="recipe-price"><span>Tahmini birim maliyet<small>KDV hariç · referans fiyatlarla</small></span><strong>${money(c.unitCost)}</strong></div><div class="recipe-actions"><button class="text-button" data-edit="recipes" data-id="${r.id}">Reçeteyi düzenle →</button><button class="text-button danger" data-delete="recipes" data-id="${r.id}">Sil</button></div></article>`;}).join('')}</div>`:`<section class="card">${empty('▧',search?'Reçete bulunamadı':'İlk reçeteni oluştur',search?'Ürün adı veya koduyla tekrar ara.':'Bir ürün seç, malzemeleri ve miktarlarını ekle. İşçilik ve paketleme dahil tahmini maliyetini gör.',search?'':btn('+ İlk reçeteyi oluştur','new-recipe'))}</section>`);
}
function costs(){const available=data.products.filter(p=>data.recipes.some(r=>r.product_id===p.id));return pageHeading('Satış fiyatını hesapla','Güncel reçete maliyetinden hedef marjına göre bir fiyat senaryosu oluştur.')+(available.length?`<div class="calculator-grid"><section class="card calculator-input"><h2>Fiyat senaryosu</h2><label>Ürün<select id="calc-product">${available.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><p class="help" id="calc-product-name"></p><div class="field-grid"><label>Sipariş adedi<input id="calc-qty" type="number" min="1" max="1000000" value="1"></label><label>Hedef brüt marj (%)<input id="calc-margin" type="number" min="0" max="99.9" step="0.1" value="30"></label><label>KDV oranı (%)<input id="calc-vat" type="number" min="0" max="100" step="0.1" value="20"></label></div><div class="notice subtle">Tahmini üretim hesabı. Seçilen KDV oranını ürünün için kontrol et.</div><details class="production-help"><summary>Bu fiyat nasıl hesaplanır?</summary><p>Hedef marj, brüt kârın KDV hariç satışa oranıdır. Satış = maliyet ÷ (1 − marj). İşçilik, paketleme ve diğer giderler reçete adedine bölünür. Bu senaryo siparişin net kazancını göstermez.</p></details></section><section class="card calculation" id="calculation" aria-live="polite"></section></div><section class="card breakdown"><div class="card-heading"><h2>Reçete maliyet dökümü</h2><span class="muted">KDV hariç</span></div><div id="cost-lines"></div></section>`:`<section class="card">${empty('∑','Hesaplamak için bir reçete gerekli','Ürününe reçete ekle; maliyet güncel hammadde fiyatlarından hesaplansın.',btn('Reçete oluştur →','new-recipe'))}</section>`);}
function updateCalculation(){if(!$('#calc-product'))return;try{const r=data.recipes.find(r=>r.product_id===$('#calc-product').value);if(!amountsVisible())throw Error('Tutarları görme yetkin yok');if(!costAvailable(r))throw Error('Maliyet için gerekli fiyat bilgisi eksik.');const c=calculate(r,data.materials),p=pricing(c.unitCost,Number($('#calc-margin').value),Number($('#calc-vat').value),Number($('#calc-qty').value));$('#calc-product-name').textContent=$('#calc-product').selectedOptions[0]?.textContent||'';$('#calculation').innerHTML=`<span class="eyebrow">ÖNERİLEN BİRİM SATIŞ · TAHMİNİ</span><strong class="big-price">${money(p.gross)}</strong><p class="muted">KDV dahil · seçilen %${esc($('#calc-vat').value)} oranıyla</p><div class="result-row"><span>KDV hariç satış</span><strong>${money(p.net)}</strong></div><div class="result-row"><span>Birim üretim maliyeti <small>KDV hariç</small></span><strong>${money(c.unitCost)}</strong></div><div class="result-row"><span>Birim brüt kâr</span><strong>${money(p.profit)}</strong></div><div class="order-summary"><div><span>Sipariş satışı · KDV dahil</span><strong>${money(p.gross*Number($('#calc-qty').value))}</strong></div><div><span>Toplam satış · KDV hariç</span><strong>${money(p.orderNet)}</strong></div><div><span>Toplam maliyet · KDV hariç</span><strong>${money(p.orderCost)}</strong></div><div><span>Toplam brüt kâr</span><strong>${money(p.orderProfit)}</strong></div></div>`;$('#cost-lines').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Kalem</th><th>Reçete miktarı</th><th>Tutar · KDV hariç</th></tr></thead><tbody>${c.lines.map(l=>`<tr><td data-label="Kalem">${esc(l.name)}</td><td data-label="Reçete miktarı">${decimal(l.quantity)} ${esc(l.unit)}</td><td data-label="Tutar · KDV hariç">${money(l.cost)}</td></tr>`).join('')}${[['Fire',c.waste],['İşçilik',r.labor],['Paketleme',r.packaging],['Diğer giderler',r.overhead]].map(([name,value])=>`<tr><td data-label="Kalem">${name}</td><td data-label="Miktar">—</td><td data-label="Tutar · KDV hariç">${money(value)}</td></tr>`).join('')}<tr class="total"><td data-label="Kalem">Toplam üretim</td><td data-label="Üretim adedi">${decimal(r.yield_qty)} adet</td><td data-label="Tutar · KDV hariç">${money(c.total)}</td></tr></tbody></table></div>`;}catch(e){$('#calculation').innerHTML=`<p class="error" role="alert">${esc(e.message)}</p>`;$('#cost-lines').innerHTML='';}}
const field=(label,name,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const select=(label,name,options,value)=>`<label>${label}<select name="${name}">${options.map(([v,text])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
function openEditor(kind,id){if(kind==='recipes'&&(!data.products.length||!data.materials.length)){if(!$('[data-recipe-prerequisites]'))$('#content').insertAdjacentHTML('afterbegin',recipePrerequisites());$('[data-recipe-prerequisites]').focus();return;}if(kind==='recipes'){const recipe=id?data.recipes.find(r=>r.id===id):null,owner=session.capture();openRecipeStudio($('#modal-root'),data,recipe,{user:currentUser,save:values=>api('/recipes'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(values)},owner),done:async()=>{if(owner.isCurrent()&&await refresh(owner))toast('Reçete kaydedildi.');}});return;}editing=id?data[kind].find(x=>x.id===id):null;modal=kind;const e=editing||{};let fields='';
 if(kind==='products')fields='<fieldset class="production-fieldset"><legend>Ürün bilgileri</legend>'+field('Ürün adı','name',e.name,'text','required maxlength="200" placeholder="Örn. Pina Small"')+`<div class="field-grid">${field('Ürün kodu','sku',e.sku,'text','required maxlength="80" placeholder="Örn. PINA-S"')}${field('Kategori','category',e.category,'text','maxlength="100" placeholder="Örn. Saksı"')}</div>`+'</fieldset><fieldset class="production-fieldset"><legend>Referans satış fiyatı</legend>'+field('Satış fiyatı · KDV hariç (TL)','sale_price',editing?(e.sale_price??''):0,'number','required min="0" max="1000000000" step="0.01"')+'<p class="help">Bu kartta KDV oranı bulunmaz. KDV dahil satış senaryosunu Maliyet hesaplama ekranında görebilirsin.</p></fieldset>';
 if(kind==='materials')fields=field('Hammadde adı','name',e.name,'text','required maxlength="200" placeholder="Örn. Polyester"')+`<div class="field-grid">${select('Alış birimi','unit',Object.keys(units).map(u=>[u,u]),e.unit||'kg')}${field('Birim alış fiyatı · KDV hariç (TL)','price',editing?(e.price??''):0,'number','required min="0" max="1000000000" step="0.0001"')}</div>`+field('Tedarikçi (isteğe bağlı)','supplier',e.supplier,'text','maxlength="500"')+'<p class="help">1 kg, 1 litre veya 1 adet için ödediğin fiyatı gir. Fiyat güncellendiğinde bağlı reçetelerin maliyetleri de değişir.</p>';
 if(kind==='recipes'){const available=data.products.filter(p=>p.id===e.product_id||!data.recipes.some(r=>r.product_id===p.id));if(!available.length){toast('Tüm ürünlerin reçetesi var. Mevcut reçeteyi düzenleyebilirsiniz.');return;}draftItems=(e.items||[{material_id:data.materials[0].id,quantity:1,unit:data.materials[0].unit}]).map(i=>({...i}));fields=select('Ürün','product_id',available.map(p=>[p.id,p.name]),e.product_id||available[0].id)+`<div class="field-grid">${field('Bu reçeteyle üretilen adet','yield_qty',e.yield_qty??1,'number','required min="0.000001" max="1000000000" step="any"')}${field('Hammadde fire ek payı (%)','waste_pct',e.waste_pct??0,'number','required min="0" max="100" step="0.1"')}</div><h3>Hammaddeler</h3><div id="recipe-lines"></div><button type="button" class="secondary" data-action="add-line">+ Hammadde satırı ekle</button><h3>Bu üretimin toplam giderleri (TL)</h3><div class="field-grid">${field('İşçilik','labor',e.labor??0,'number','required min="0" max="1000000000" step="0.01"')}${field('Paketleme','packaging',e.packaging??0,'number','required min="0" max="1000000000" step="0.01"')}${field('Diğer giderler','overhead',e.overhead??0,'number','required min="0" max="1000000000" step="0.01"')}</div><label>Reçete notu<textarea name="notes" maxlength="2000" rows="2">${esc(e.notes||'')}</textarea></label><p class="help">Fire yüzdesi hammadde tutarına eklenir. Tüm giderler üretim adedine bölünerek birim maliyet bulunur.</p>`;}
 $('#modal-root').innerHTML=`<dialog id="editor" class="production-dialog" aria-labelledby="production-editor-title"><form id="edit-form"><div class="dialog-heading"><h2 id="production-editor-title">${editing?'Düzenle':(kind==='products'?'Ürün ekle':kind==='materials'?'Hammadde ekle':'Reçete oluştur')}</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="Kapat">×</button></div><div class="form-body">${fields}<p id="form-error" class="error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close-modal">Vazgeç</button><button type="submit" class="primary">Kaydet</button></div></form></dialog>`;if(kind==='recipes')renderLines();$('#editor').showModal();}
function renderLines(){$('#recipe-lines').innerHTML=draftItems.map((item,index)=>`<div class="recipe-line" data-line="${index}"><label>Hammadde<select data-line-field="material_id">${data.materials.map(m=>`<option value="${m.id}" ${m.id===item.material_id?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label><label>Miktar<input type="number" data-line-field="quantity" value="${item.quantity}" required min="0.000001" max="1000000000" step="any"></label><label>Birim<select data-line-field="unit">${Object.keys(units).filter(u=>units[u][0]===units[data.materials.find(m=>m.id===item.material_id).unit][0]).map(u=>`<option ${u===item.unit?'selected':''}>${u}</option>`).join('')}</select></label><button type="button" class="icon-button danger" data-remove-line="${index}" aria-label="${index+1}. hammadde satırını kaldır">×</button></div>`).join('');}
function closeModal(){$('#editor')?.close();$('#modal-root').innerHTML='';modal=null;editing=null;}
async function save(event){event.preventDefault();const form=event.target,button=form.querySelector('[type="submit"]');button.disabled=true;const values=Object.fromEntries(new FormData(form));for(const key of ['sale_price','price','yield_qty','waste_pct','labor','packaging','overhead'])if(key in values)values[key]=Number(values[key]);if(modal==='recipes')values.items=draftItems;try{await api('/'+modal+(editing?'/'+editing.id:''),{method:editing?'PUT':'POST',body:JSON.stringify(values)});closeModal();await refresh();toast('Kaydedildi. Maliyetler güncellendi.');}catch(e){if($('#form-error'))$('#form-error').textContent=e.message;else toast(e.message);}finally{button.disabled=false;}}
function confirmDelete(kind,id){const record=data[kind].find(r=>r.id===id);$('#modal-root').innerHTML=`<dialog id="editor" class="production-dialog" aria-labelledby="production-editor-title"><div class="form-body"><h2 id="production-editor-title">Kaydı sil?</h2><p>${esc(record.name||'Seçili reçete')} silinecek.${kind==='products'?' Ürünün reçetesi de kaldırılacak.':''} Bu işlem geri alınamaz.</p><p id="delete-error" class="error" role="alert"></p></div><div class="dialog-footer"><button class="secondary" data-action="close-modal">Vazgeç</button><button class="danger-button" data-confirm-delete="${kind}" data-id="${id}">Evet, sil</button></div></dialog>`;$('#editor').showModal();}
function startupError(owner,message,retry=start){
 if(!owner.isCurrent())return;
 authenticated=false;currentUser=null;dataReady=false;loggingOut=false;routeLoader.begin();startupRetry=retry;
 $('#app').innerHTML=`<section class="loading" data-startup-error><h1>Lunapot açılamadı</h1><p role="alert">${esc(message||(navigator.onLine?'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip yeniden deneyin.':'İnternet bağlantısı yok. Güncel verileri yüklemek için bağlantınızı yeniden kurun.'))}</p><button type="button" class="primary" data-action="retry">Yeniden dene</button></section>`;
}
function startupPending(message,retrying=false){
 $('#app').innerHTML=`<section class="loading" aria-busy="true"><h1>Lunapot</h1><p role="status">${message}</p>${retrying?'<button type="button" class="primary" data-action="retry" disabled>Yeniden deneniyor…</button>':''}</section>`;
}
async function logout(){
 const owner=resetSession();loggingOut=true;startupPending('Oturum kapatılıyor…');
 try{await api('/auth/logout',{method:'POST',body:'{}'},owner);owner.check();await start();}
 catch(error){if(owner.isCurrent())startupError(owner,'Oturum kapatılamadı. Bağlantınızı kontrol edip yeniden deneyin.',logout);}
}
async function start(){
 const retry=$('[data-action="retry"]');if(retry)retry.disabled=true;
 const owner=resetSession();startupRetry=start;startupPending('Oturum kontrol ediliyor…',!!retry);
 try{
  const status=await api('/auth/status',{},owner);owner.check();
  authenticated=status.authenticated===true&&!!status.user;currentUser=authenticated?status.user:null;
  if(authenticated){acceptLocation();if(accessAllowed(currentUser,'lp',$('#app')))await refresh(owner);return;}
  const token=new URLSearchParams(location.hash.slice(1)).get('setup')||'';if(token)history.replaceState(null,'','/uretim/');
  $('#app').innerHTML=`<div class="auth-layout"><section class="auth-brand"><a class="brand" href="/"><img src="/icon.svg" alt=""><span>lunapot</span></a><div><span class="eyebrow">LUNAPOT YÖNETİM PANELİ</span><h1>Üretimini tanı.<br>Maliyetini bil.</h1><p>Ürünlerin, hammaddelerin ve reçetelerin<br>aynı çalışma alanında.</p></div><small>Ürün · Reçete · Maliyet</small></section><section class="auth-form"><form id="login-form"><span class="pill">Lunapot v3.0</span><h2>${status.initialized?'Tekrar hoş geldin.':'Lunapot’u hazırlayalım.'}</h2><p>${status.initialized?'Yönetim paneline erişmek için şifreni gir.':'Yalnızca sana ait bir yönetici şifresi belirle.'}</p>${!status.initialized?field('Kurulum anahtarı','token',token,'password','required autocomplete="off"'):''}${status.initialized?field('Kullanıcı adı · yöneticiysen boş bırak','username','','text','autocomplete="username" maxlength="60"'):''}${field(status.initialized?'Şifre':'Yeni şifre (en az 12 karakter)','password','','password',`required ${status.initialized?'':'minlength="12"'} maxlength="200" autocomplete="${status.initialized?'current-password':'new-password'}"`)}<p id="login-error" class="error" role="alert"></p><button type="submit" class="primary">${status.initialized?'Panele giriş yap →':'Kurulumu tamamla →'}</button><small>Verilerin şifreli bağlantı üzerinden saklanır.<br>Lunapot AI bu sürümde kapalıdır.</small></form></section></div>`;
  const form=$('#login-form');
  form.addEventListener('submit',async event=>{
   event.preventDefault();const button=form.querySelector('button');if(button.disabled||!owner.isCurrent()||!form.isConnected)return;button.disabled=true;
   disposeQuickLogin?.();disposeQuickLogin=null;
   try{
    await api('/auth/'+(status.initialized?'login':'setup'),{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))},owner);owner.check();
    route='dashboard';location.hash='dashboard';await start();
   }catch(error){if(owner.isCurrent()&&form.isConnected)form.querySelector('#login-error').textContent=error.name==='TypeError'?'Sunucuya ulaşılamıyor. Yeniden deneyin.':error.message;}
   finally{if(owner.isCurrent()&&form.isConnected)button.disabled=false;}
  });
  if(status.initialized)mountQuickLogin(form,{onSuccess:()=>{if(owner.isCurrent()&&form.isConnected)return start();}}).then(close=>{if(owner.isCurrent()&&form.isConnected)disposeQuickLogin=close;else close();});
 }catch(error){if(owner.isCurrent())startupError(owner);}
}
document.addEventListener('click',async event=>{const target=event.target.closest('button');if(!target||target.disabled)return;const owner=session.capture();try{if(target.dataset.edit){openEditor(target.dataset.edit,target.dataset.id);return;}if(target.dataset.delete){confirmDelete(target.dataset.delete,target.dataset.id);return;}if(target.dataset.confirmDelete){target.disabled=true;try{await api('/'+target.dataset.confirmDelete+'/'+target.dataset.id,{method:'DELETE',body:'{}'});closeModal();await refresh();toast('Kayıt silindi.');}catch(e){$('#delete-error').textContent=e.message;}finally{target.disabled=false;}return;}if(target.dataset.removeLine!==undefined){draftItems.splice(Number(target.dataset.removeLine),1);renderLines();return;}switch(target.dataset.action){case 'new-product':openEditor('products');break;case 'new-material':openEditor('materials');break;case 'new-recipe':openEditor('recipes');break;case 'close-modal':closeModal();break;case 'add-line':if(draftItems.length>=200){toast('En fazla 200 hammadde eklenebilir.');break;}draftItems.push({material_id:data.materials[0].id,quantity:1,unit:data.materials[0].unit});renderLines();break;case 'refresh':if(await refresh(owner))toast('Veriler güncellendi.');break;case 'retry':await startupRetry();break;case 'menu':$('#sidebar').classList.toggle('open');break;case 'logout':await logout();break;case 'install':if(installPrompt){await installPrompt.prompt();installPrompt=null;}else toast('Telefonda tarayıcı menüsünden “Ana Ekrana Ekle” seçeneğini kullan. iPhone’da Safari → Paylaş → Ana Ekrana Ekle.');break;}}catch(e){if(owner.isCurrent()&&e.name!=='AbortError')toast(e.message);}});
document.addEventListener('submit',event=>{if(event.target.id==='edit-form')save(event);});
document.addEventListener('input',event=>{const t=event.target;if(t.id==='search'){const cursor=t.selectionStart;search=t.value;render();$('#search').focus();$('#search').setSelectionRange(cursor,cursor);}if(t.id?.startsWith('calc-'))updateCalculation();if(t.dataset.lineField){const i=Number(t.closest('[data-line]').dataset.line);draftItems[i][t.dataset.lineField]=t.dataset.lineField==='quantity'?Number(t.value):t.value;}});
document.addEventListener('change',event=>{const t=event.target;if(t.id?.startsWith('calc-'))updateCalculation();if(t.dataset.lineField==='material_id'){const i=Number(t.closest('[data-line]').dataset.line);draftItems[i].material_id=t.value;draftItems[i].unit=data.materials.find(m=>m.id===t.value).unit;renderLines();}});
window.addEventListener('hashchange',()=>{navigateHash().catch(error=>{if(error.name!=='AbortError'&&authenticated)toast('Ekran açılamadı. Yeniden deneyin.');});});
function updateConnection(){const status=$('.connection');if(status){status.textContent=navigator.onLine?'● Çevrimiçi':'● Çevrimdışı';status.classList.toggle('offline',!navigator.onLine);}}
window.addEventListener('online',()=>{updateConnection();if(loggingOut)return;if(authenticated)refresh().catch(e=>{if(e.name!=='AbortError')toast(e.message);});else startupRetry();});window.addEventListener('offline',updateConnection);
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
start();
