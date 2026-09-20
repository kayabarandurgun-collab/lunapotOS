import {enhanceWorkspaceFrame} from './workspace-frame.js';
import {enhanceLists} from './list-tools.js';
const listCss=document.createElement('link');listCss.rel='stylesheet';listCss.href='/list-tools.css';document.head.append(listCss);
import {enhanceNavigationSearch} from './ui-navigation.js';
// Presentation only: no business requests, records, or permission changes.
const mobile=matchMedia('(max-width:800px)');let sidebar=null,navObserver=null,scheduled=false;
const shade=document.createElement('button');shade.className='ui-menu-shade';shade.type='button';shade.tabIndex=-1;shade.hidden=true;shade.setAttribute('aria-label','Menüyü kapat');document.body.append(shade);
const skip=document.createElement('a');skip.className='ui-skip-link';skip.textContent='İçeriğe geç';document.body.prepend(skip);
const menuSelector='#commerce-menu,[data-action="menu"]',triggerSelector=menuSelector+',[data-dock-menu]';
const menu=()=>document.querySelector(menuSelector);
let menuOpen=false,menuOpener=null,pendingMenuOpener=null,closeDestination='opener',contentNavigation=false;
const visible=node=>!!node?.isConnected&&!node.closest('[hidden],[inert]')&&!!node.getClientRects().length&&getComputedStyle(node).visibility==='visible'&&node.checkVisibility?.({visibilityProperty:true})!==false;
const menuTargets=()=>[...(sidebar?.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')||[])].filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&visible(node));
function focusMenu(){menuTargets()[0]?.focus({preventScroll:true});}
function focusContent(){const main=document.querySelector('main');if(main){main.tabIndex=-1;main.focus({preventScroll:true});}}
function closeMenu(destination='opener'){closeDestination=destination;sidebar?.classList.remove('open');syncMenu();}
function syncMenu(){
 const open=mobile.matches&&!!sidebar?.classList.contains('open'),wasOpen=menuOpen;
 const lostSidebarFocus=mobile.matches&&!open&&!!sidebar?.contains(document.activeElement);
 menuOpen=open;if(sidebar)sidebar.inert=mobile.matches&&!open;
 shade.hidden=!open;document.body.classList.toggle('ui-menu-open',open);
 for(const button of document.querySelectorAll(triggerSelector)){
  button.setAttribute('aria-expanded',String(open));
  if(sidebar)button.setAttribute('aria-controls',sidebar.id);else button.removeAttribute('aria-controls');
  if(button.matches(menuSelector))button.setAttribute('aria-label',open?'Menüyü kapat':'Menüyü aç');
 }
 if(open&&!wasOpen){menuOpener=pendingMenuOpener||document.activeElement;pendingMenuOpener=null;closeDestination='opener';if(!document.querySelector('dialog[open]'))focusMenu();}
 if(!open&&(wasOpen||lostSidebarFocus)){
  const destination=closeDestination;closeDestination='opener';pendingMenuOpener=null;
  // Native modal dialogs own focus while open, including their normal return target.
  if(!document.querySelector('dialog[open]')){
   if(destination==='content')focusContent();
   else if(mobile.matches||!sidebar?.contains(document.activeElement)||!visible(document.activeElement)){
    const target=visible(menuOpener)?menuOpener:visible(menu())?menu():menuTargets()[0];
    target?.focus({preventScroll:true});
   }
  }
  menuOpener=null;
 }
}
// Capture the real opener before the bottom dock forwards a click to the header button.
document.addEventListener('click',event=>{const trigger=event.target.closest(triggerSelector);if(!trigger||menuOpen)return;if(trigger.matches('[data-dock-menu]')||!pendingMenuOpener)pendingMenuOpener=trigger;},true);
shade.addEventListener('click',()=>closeMenu());mobile.addEventListener('change',()=>closeMenu());
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||event.isComposing||event.target.closest('dialog')||!mobile.matches||!sidebar?.classList.contains('open')||document.querySelector('dialog[open]'))return;
 if(event.key==='Escape'){event.preventDefault();closeMenu();}
 if(event.key==='Tab'){
  const targets=menuTargets(),first=targets[0],last=targets.at(-1),active=document.activeElement;
  if(event.shiftKey&&(active===first||!targets.includes(active))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(active===last||!targets.includes(active))){event.preventDefault();first?.focus();}
 }
});
document.addEventListener('click',event=>{
 const link=event.target.closest('#sidebar a');if(!link||!menuOpen||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target==='_blank')return;
 const target=new URL(link.href,location.href);
 contentNavigation=target.pathname===location.pathname&&target.search===location.search&&!!target.hash;
 closeMenu('content');
});
document.addEventListener('focusin',event=>{if(!event.target.matches('main'))contentNavigation=false;});
window.addEventListener('hashchange',()=>{
 const moveToContent=contentNavigation;contentNavigation=false;closeMenu('content');
 // Route modules replace the complete shell during this event; focus its new main afterwards.
 if(moveToContent)requestAnimationFrame(()=>{if(!document.querySelector('dialog[open]')&&(document.activeElement===document.body||document.activeElement.matches('main')))focusContent();});
});
function enhance(){scheduled=false;enhanceWorkspaceFrame();enhanceNavigationSearch();enhanceLists();const next=document.querySelector('#sidebar');if(next!==sidebar){navObserver?.disconnect();sidebar=next;if(sidebar){navObserver=new MutationObserver(syncMenu);navObserver.observe(sidebar,{attributes:true,attributeFilter:['class']});}}syncMenu();
 const main=document.querySelector('main');if(main){skip.hidden=false;if(!main.id)main.id='workspace-main';main.tabIndex=-1;skip.href='#'+main.id;skip.onclick=e=>{e.preventDefault();closeMenu('content');main.focus();main.scrollIntoView({block:'start'});};}else skip.hidden=true;
 const header=document.querySelector('.workspace>header');if(header&&!header.querySelector('.mobile-workspace,.ui-mobile-title')){const title=document.createElement('strong');title.className='ui-mobile-title';title.textContent='Lunapot';header.querySelector('.mobile-menu')?.after(title);}
 for(const region of document.querySelectorAll('.table-wrap,.v2-table-wrap')){const overflow=region.scrollWidth>region.clientWidth+2;if(!region.dataset.uiRegion){region.dataset.uiRegion='true';region.setAttribute('role','region');region.setAttribute('aria-label','Veri tablosu');const hint=document.createElement('p');hint.className='ui-table-hint';hint.textContent='Diğer sütunlar için tabloyu yana kaydırabilirsin →';region.after(hint);}region.tabIndex=overflow?0:-1;const hint=region.nextElementSibling;if(hint?.classList.contains('ui-table-hint'))hint.hidden=!overflow;}
}
// Kaydedilmemis form uyarisi. Basarili kayit pencereyi kapattigi icin bayrak orada temizlenir;
// bu yuzden kaydettikten sonra gereksiz uyari cikmaz. Hicbir veri saklanmaz veya gonderilmez.
let unsavedDialog=null;
const dialogOf=node=>node instanceof Element?node.closest('dialog[open]'):null;
const markDirty=event=>{const dialog=dialogOf(event.target);if(dialog)unsavedDialog=dialog;};
document.addEventListener('input',markDirty);document.addEventListener('change',markDirty);
window.addEventListener('beforeunload',event=>{if(!unsavedDialog?.isConnected||!unsavedDialog.open)return;event.preventDefault();event.returnValue='';});
// Kaydetme sirasinda dugme durumu: modullerin hepsi gonderirken submit dugmesini kapatir.
// Burada ortak gorunur durum eklenir; istek bitip dugme yeniden acilinca isaret kalkar.
// Gecikmis istek basarili sayilmaz: isareti kaldiran sey yalnizca dugmenin yeniden acilmasidir.
document.addEventListener("submit",event=>{
 const button=event.submitter||event.target.querySelector("[type=submit]");if(!button)return;
 button.setAttribute("aria-busy","true");
 // Modul kendi gonderim isleyicisinde dugmeyi kapatir. Isaret, dugme yeniden acilinca kalkar.
 // Kapatma kalibini kullanmayan bir form varsa isaret ayni anda temizlenir, asili kalmaz.
 queueMicrotask(()=>{if(!button.disabled){button.removeAttribute("aria-busy");return;}
  const watch=new MutationObserver(()=>{if(!button.isConnected||!button.disabled){button.removeAttribute("aria-busy");watch.disconnect();}});
  watch.observe(button,{attributes:true,attributeFilter:["disabled"]});});
},true);
function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(enhance);}}
new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',schedule);document.fonts?.ready.then(schedule);schedule();

// Network state is visible on mobile as well; it never queues or replays a business write.
const connectionNotice=document.createElement('div');connectionNotice.className='ui-network-notice';connectionNotice.setAttribute('role','status');connectionNotice.setAttribute('aria-live','polite');document.body.append(connectionNotice);
function syncConnection(){const online=navigator.onLine;connectionNotice.hidden=online;connectionNotice.textContent=online?'':'İnternet bağlantısı yok. Yeni bir işlemi kaydedilmiş saymadan önce bağlantıyı ve işlem sonucunu kontrol et.';for(const label of document.querySelectorAll('.connection'))label.textContent=online?'● Çevrimiçi':'● Çevrimdışı';}
window.addEventListener('online',syncConnection);window.addEventListener('offline',syncConnection);syncConnection();
