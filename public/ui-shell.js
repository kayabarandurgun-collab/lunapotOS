import {enhanceNavigationSearch} from './ui-navigation.js';
// Presentation only: no business requests, records, or permission changes.
const mobile=matchMedia('(max-width:800px)');let sidebar=null,navObserver=null,scheduled=false;
const shade=document.createElement('button');shade.className='ui-menu-shade';shade.type='button';shade.tabIndex=-1;shade.hidden=true;shade.setAttribute('aria-label','Menüyü kapat');document.body.append(shade);
const skip=document.createElement('a');skip.className='ui-skip-link';skip.textContent='İçeriğe geç';document.body.prepend(skip);
const menu=()=>document.querySelector('#commerce-menu,[data-action="menu"]');
function closeMenu(restore=false){sidebar?.classList.remove('open');if(restore)menu()?.focus();syncMenu();}
function syncMenu(){const open=mobile.matches&&!!sidebar?.classList.contains('open');shade.hidden=!open;document.body.classList.toggle('ui-menu-open',open);const button=menu();button?.setAttribute('aria-expanded',String(open));button?.setAttribute('aria-controls','sidebar');button?.setAttribute('aria-label',open?'Menüyü kapat':'Menüyü aç');}
shade.addEventListener('click',()=>closeMenu(true));mobile.addEventListener('change',()=>closeMenu());
document.addEventListener('keydown',e=>{if(!mobile.matches||!sidebar?.classList.contains('open')||document.querySelector('dialog[open]'))return;if(e.key==='Escape'){e.preventDefault();closeMenu(true);}if(e.key==='Tab'){const targets=[menu(),...sidebar.querySelectorAll('a,button,[tabindex="0"]')].filter(x=>x&&!x.disabled&&!x.hidden&&x.getClientRects().length);const first=targets[0],last=targets.at(-1);if(e.shiftKey&&(document.activeElement===first||!targets.includes(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!targets.includes(document.activeElement))){e.preventDefault();first?.focus();}}});
document.addEventListener('click',e=>{if(e.target.closest('#sidebar a'))closeMenu();});window.addEventListener('hashchange',()=>closeMenu());
function enhance(){scheduled=false;for(const busy of document.querySelectorAll("[aria-busy=true]"))if(!busy.disabled)busy.removeAttribute("aria-busy");enhanceNavigationSearch();const next=document.querySelector('#sidebar');if(next!==sidebar){navObserver?.disconnect();sidebar=next;if(sidebar){navObserver=new MutationObserver(syncMenu);navObserver.observe(sidebar,{attributes:true,attributeFilter:['class']});}}syncMenu();
 const main=document.querySelector('main');if(main){skip.hidden=false;if(!main.id)main.id='workspace-main';main.tabIndex=-1;skip.href='#'+main.id;skip.onclick=e=>{e.preventDefault();closeMenu();main.focus();main.scrollIntoView({block:'start'});};}else skip.hidden=true;
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
