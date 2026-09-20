import {mountQuickLogin} from './quick-access-ui.js';
let disposeQuickLogin=null;
import {workspaceNavigation} from './workspace-navigation.js';
import {accessAllowed,staffHome} from './access-ui.js';
import {icon} from './ui-icons.js';
import {createRouteLoader,createSessionOwner} from './route-loader.js';
const app=document.querySelector('#commerce-app');let authenticated=false,currentUser=null,mountedRoute='';
const routeLoader=createRouteLoader(),session=createSessionOwner();
let loggingOut=false,startupRetry=start;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Menu sirasi ve adlari: once gunluk karar isleri, sonra kayit tutma. Anahtarlar degismez;
// mevcut #adres baglantilari ve hizli gecis aynen calisir. Ekran yetkileri ve verileri birlesmez.
const views={overview:'Genel durum',performance:'Satış ve kâr',orders:'Siparişler',reports:'Rapor Kutusu',pricing:'Satış fiyatı hesapla',stock:'Depomdaki ürünler',catalog:'Ürünler ve setler',invoices:'Alış faturaları',documents:'Fatura belgeleri',sales:'Satış ve kesinti kayıtları',reconciliation:'Kesinti eşleştirme',ledger:'Cariler ve nakit',bank:'Banka ekstresi',offers:'Teklif ve belgeler',expenses:'Genel giderler',integrations:'Bağlantılar',settings:'Şirket ve yedek'};
function resetSession(){
 const owner=session.begin();authenticated=false;currentUser=null;mountedRoute='';loggingOut=false;
 disposeQuickLogin?.();disposeQuickLogin=null;routeLoader.begin();return owner;
}
async function auth(path,body,owner=session.capture()){
 owner.check();const response=await fetch('/api/auth/'+path,{signal:owner.signal,...(body?{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})});owner.check();
 const result=await response.json();owner.check();if(!response.ok)throw new Error(result.error||'İşlem tamamlanamadı.');return result;
}
const routeViews={
 performance:{load:()=>import('./performance-ui.js'),mount:(module,root)=>module.mountPerformance(root)},
 catalog:{load:()=>import('./catalog-ui.js'),mount:(module,root)=>module.mountCatalog(root,'ec')},
 reconciliation:{load:()=>import('./reconciliation-ui.js'),mount:(module,root)=>module.mountReconciliation(root,'ec')},
 ledger:{load:()=>import('./business-ui.js'),mount:(module,root)=>module.mountBusiness(root,'ec','ledger',currentUser)},
 pricing:{load:()=>import('./business-ui.js'),mount:(module,root)=>module.mountBusiness(root,'ec','pricing',currentUser)},
 offers:{load:()=>import('./offers-ui.js'),mount:(module,root)=>module.mountOffers(root,'ec')},
 orders:{load:()=>import('./orders-ui.js'),mount:(module,root)=>module.mountOrders(root,'ec')},
 reports:{load:()=>import('./report-inbox-ui.js'),mount:(module,root)=>module.mountReports(root,'ec')},
 bank:{load:()=>import('./bank-ui.js'),mount:(module,root)=>module.mountBank(root,'ec')},
 documents:{load:()=>import('./sales-document-ui.js'),mount:(module,root)=>module.mountSalesDocuments(root,'ec')},
 overview:{load:()=>import('./operations-ui.js'),mount:(module,root)=>module.mountOperations(root,'ec','overview')},
 settings:{load:()=>import('./operations-ui.js'),mount:(module,root)=>module.mountOperations(root,'ec','settings')},
 integrations:{load:()=>import('./operations-ui.js'),mount:(module,root)=>module.mountOperations(root,'ec','integrations')},
 ...Object.fromEntries(['stock','invoices','sales','expenses'].map(current=>[current,{load:()=>import('./accounting-ui.js'),mount:(module,root)=>module.mountAccounting(root,'ec',current)}]))
};
async function render(){
 if(!authenticated||!currentUser)return;
 const view=routeLoader.begin();
 if(!accessAllowed(currentUser,'ec',app))return;
 const route=location.hash.slice(1).split('?')[0],current=Object.hasOwn(views,route)?route:'overview';mountedRoute=route;
 app.innerHTML='<aside id="sidebar"><a class="brand" href="/eticaret/"><img src="/ecommerce-icon.svg" alt=""><span>lunapot<span class="brand-sub">E-TİCARET ÇALIŞMA ALANI</span></span></a><div class="workspace-label">PAZARYERİ OPERASYONLARI</div><nav aria-label="E-ticaret menüsü">'+workspaceNavigation('ec',views,current,currentUser,icon)+'</nav><div class="sidebar-foot"><a class="workspace-home" href="/access'+(currentUser?.owner?'':'#account')+'">'+(currentUser?.owner?'Ekip ve yetkiler':'Hesabım')+'</a><a class="workspace-home" href="/">▦ Tüm uygulamalar</a><div class="version"><span class="status-dot"></span> E-Ticaret v3.0</div><p>Ayrı defter · Ayrı stok</p></div></aside><div class="workspace"><header><button class="mobile-menu icon-button" id="commerce-menu" aria-label="Menüyü aç" aria-expanded="false">☰</button><strong class="mobile-workspace">E-Ticaret</strong><div class="breadcrumb"><span>E-Ticaret</span><span>/</span><strong>'+views[current]+'</strong></div><div class="header-actions"><a class="app-launcher-link" href="/" aria-label="Ana ekran · Uygulamalar"><span aria-hidden="true">▦</span> Uygulamalar</a><span class="connection">'+(navigator.onLine?'● Çevrimiçi':'● Çevrimdışı')+'</span><button class="text-button" id="commerce-logout">Çıkış</button></div></header><main id="commerce-content"></main><footer><span>E-Ticaret · Ön muhasebe</span><span>TRY · Tek depo</span></footer></div>';
 const content=document.querySelector('#commerce-content');

 document.querySelector('#commerce-menu').onclick=e=>{const open=document.querySelector('#sidebar').classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',String(open));};
 document.querySelector('#commerce-logout').onclick=logout;
 if(current==='overview'&&!currentUser.owner){content.innerHTML=staffHome(currentUser,'ec');return;}
 const feature=routeViews[current];
 await view.mount(content,feature.load,module=>feature.mount(module,content),{label:views[current]});
}
function startupError(owner,message,retry=start){
 if(!owner.isCurrent())return;
 authenticated=false;currentUser=null;loggingOut=false;routeLoader.begin();startupRetry=retry;
 app.innerHTML='<section class="loading" data-startup-error><h1>E-Ticaret açılamadı</h1><p role="alert">'+esc(message||(navigator.onLine?'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip yeniden deneyin.':'İnternet bağlantısı yok. Güncel verileri yüklemek için bağlantınızı yeniden kurun.'))+'</p><button type="button" class="primary" id="commerce-retry">Yeniden dene</button></section>';
 document.querySelector('#commerce-retry').onclick=()=>startupRetry();
}
function startupPending(message,retrying=false){
 app.innerHTML='<section class="loading" aria-busy="true"><h1>E-Ticaret</h1><p role="status">'+message+'</p>'+(retrying?'<button type="button" class="primary" id="commerce-retry" disabled>Yeniden deneniyor…</button>':'')+'</section>';
}
async function logout(){
 const owner=resetSession();loggingOut=true;startupPending('Oturum kapatılıyor…');
 try{await auth('logout',{},owner);owner.check();await start();}
 catch(error){if(owner.isCurrent())startupError(owner,'Oturum kapatılamadı. Bağlantınızı kontrol edip yeniden deneyin.',logout);}
}
async function start(){
 const retry=document.querySelector('#commerce-retry');if(retry)retry.disabled=true;
 const owner=resetSession();startupRetry=start;startupPending('Oturum kontrol ediliyor…',!!retry);
 try{
  const state=await auth('status',undefined,owner);owner.check();
  authenticated=state.authenticated===true&&!!state.user;currentUser=authenticated?state.user:null;
  if(authenticated){await render();return;}
  const token=new URLSearchParams(location.hash.slice(1)).get('setup')||'';if(token)history.replaceState(null,'','/eticaret/');
 app.innerHTML='<div class="auth-layout"><section class="auth-brand"><a class="brand" href="/eticaret/"><img src="/ecommerce-icon.svg" alt=""><span>E-Ticaret</span></a><div><span class="eyebrow">SATIŞ · STOK · ÖN MUHASEBE</span><h1>Satıştan geriye<br>ne kalıyor?</h1><p>Siparişten teslimata, maliyetten kâra.<br>İşinin tamamını aynı yerden takip et.</p></div><small>Torf & zirai ürünler</small></section><section class="auth-form"><form id="commerce-login"><span class="pill">E-Ticaret çalışma alanı</span><h2>'+(state.initialized?'Tekrar hoş geldin.':'Yönetici hesabını oluştur.')+'</h2><p>'+(state.initialized?'Sana ait çalışma alanına giriş yap.':'Lunapot ve e-ticaret için yönetici girişini hazırla.')+'</p>'+(!state.initialized?'<label>Kurulum anahtarı<input name="token" type="password" value="'+esc(token)+'" required autocomplete="off"></label>':'')+(state.initialized?'<label>Kullanıcı adı · yöneticiysen boş bırak<input name="username" autocomplete="username" maxlength="60"></label>':'')+'<label>Şifre<input name="password" type="password" required '+(!state.initialized?'minlength="12"':'')+' maxlength="200" autocomplete="'+(state.initialized?'current-password':'new-password')+'"></label><button class="primary" type="submit">'+(state.initialized?'Çalışma alanını aç →':'Kurulumu tamamla →')+'</button><p id="commerce-error" class="error" role="alert"></p><small>Cariler ve stoklar Lunapot üretim alanından ayrıdır.</small></form></section></div>';
  const form=document.querySelector('#commerce-login');
  form.onsubmit=async event=>{
   event.preventDefault();const button=form.querySelector('button');if(button.disabled||!owner.isCurrent()||!form.isConnected)return;button.disabled=true;
   disposeQuickLogin?.();disposeQuickLogin=null;
   try{await auth(state.initialized?'login':'setup',Object.fromEntries(new FormData(form)),owner);owner.check();await start();}
   catch(error){if(owner.isCurrent()&&form.isConnected)form.querySelector('#commerce-error').textContent=error.name==='TypeError'?'Sunucuya ulaşılamıyor. Yeniden deneyin.':error.message;}
   finally{if(owner.isCurrent()&&form.isConnected)button.disabled=false;}
  };
  if(state.initialized)mountQuickLogin(form,{onSuccess:()=>{if(owner.isCurrent()&&form.isConnected)return start();}}).then(close=>{if(owner.isCurrent()&&form.isConnected)disposeQuickLogin=close;else close();});
 }catch(error){if(owner.isCurrent())startupError(owner);}
}
// Aynı ekranın içinde adres değişirse (ör. sipariş penceresi açılıp geri tuşuyla kapanınca) ekran
// baştan kurulmaz; ekran kendisi karşılar. Böylece liste, filtre ve sayfa kaybolmaz.
window.addEventListener('hashchange',()=>{if(!authenticated)return;const route=location.hash.slice(1).split('?')[0];if(route===mountedRoute&&routeLoader.onHash())return;render();});
window.addEventListener('online',()=>{if(!authenticated&&!loggingOut)startupRetry();});
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
start();
