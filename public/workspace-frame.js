import {can} from './permissions.js';
import {navigationHref} from './workspace-navigation.js';
import {icon} from './ui-icons.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const areas=[
 {key:'home',title:'Çalışma alanım',detail:'Uygulamalar ve hızlı başlangıç',href:'/',icon:'overview'},
 {key:'ec',title:'E-ticaret',detail:'Sipariş, stok ve kârlılık',href:'/eticaret/#overview',icon:'orders'},
 {key:'lp',title:'Üretim',detail:'Reçete, hammadde ve üretim',href:'/uretim/#dashboard',icon:'production'},
 {key:'store',title:'Web Mağaza',detail:'Mağazan ve müşteri işlemleri',href:'/webmagaza/',icon:'stock'},
 {key:'access',title:'Ekip ve erişim',detail:'Çalışanlar, yetkiler ve kurtarma',href:'/access',icon:'settings'}
];
let user=null,ready=false,dialog=null,dock=null,authRevision=0;
export function setWorkspaceUser(next){authRevision++;user=next;ready=true;dialog?.close();document.querySelector('.workspace-identity')?.remove();if(!user)document.querySelector('.workspace-account')?.remove();enhanceWorkspaceFrame();}
const ns=()=>document.body.classList.contains('commerce')?'ec':document.body.classList.contains('lunapot')?'lp':document.body.classList.contains('webstore-admin')?'store':document.querySelector('#access-app')?'access':'home';
const allowed=a=>a.key==='home'||a.key==='access'&&!!user||user?.owner||(a.key==='ec'?['read','write'].includes(user?.ec_access):a.key==='lp'?['read','write'].includes(user?.lp_access):a.key==='store'?can(user,'ec','webshop'):false);
function showAreas(button){
 if(dialog||document.querySelector('dialog[open]'))return;
 const d=document.createElement('dialog');dialog=d;d.className='workspace-switch-dialog';
 d.setAttribute('aria-labelledby','workspace-switch-title');
 d.innerHTML='<div class="dialog-heading"><div><span class="eyebrow">LUNAPOT</span><h2 id="workspace-switch-title">Çalışma alanını değiştir</h2></div><button type="button" class="icon-button" aria-label="Kapat">×</button></div><nav class="workspace-switch-list" aria-label="Çalışma alanları">'+areas.filter(allowed).map(a=>'<a href="'+a.href+'"'+(a.key===ns()?' aria-current="page"':'')+'><span class="workspace-switch-icon">'+icon(a.icon)+'</span><div><strong>'+(a.key==='access'&&!user?.owner?'Hesabım':a.title)+'</strong><small>'+(a.key==='access'&&!user?.owner?'Şifrem ve hızlı giriş cihazlarım':a.detail)+'</small></div></a>').join('')+'</nav>';
 d.querySelector('button').onclick=()=>d.close();
 d.addEventListener('close',()=>{d.remove();dialog=null;if(button.isConnected)button.focus();},{once:true});
 d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
 document.body.append(d);d.showModal();
}
export function enhanceWorkspaceFrame(){
 if(!document.body.classList.contains('workspace-redesign'))return;
 const header=document.querySelector('.workspace>header .header-actions,.top-actions,.ws-top>div');
 if(header&&ready&&!header.querySelector('.workspace-switch')){
  const b=document.createElement('button');b.type='button';b.className='workspace-switch';b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-label','Çalışma alanını değiştir');
  b.innerHTML=icon('overview')+'<span>Çalışma alanı</span><small>⌄</small>';b.onclick=()=>showAreas(b);header.append(b);
  header.querySelector('.app-launcher-link')?.setAttribute('hidden','');
 }
 const sidebar=document.querySelector('#sidebar');
 if(sidebar&&ready&&!sidebar.querySelector('.workspace-identity')&&user){
  const identity=document.createElement('a');identity.className='workspace-identity';identity.href='/access#account';identity.dataset.navigationTitle='Hesabım';identity.setAttribute('aria-label','Hesabım: şifre ve hızlı giriş');
  const name=user.name||'İşletme yöneticisi';
  identity.innerHTML='<span class="identity-avatar" aria-hidden="true">'+esc(name.slice(0,2).toLocaleUpperCase('tr-TR'))+'</span><div><strong>'+esc(name)+'</strong><small>'+ (user.owner?'Yönetici · Hesabım':'Ekip üyesi · Hesabım')+'</small></div><span class="identity-arrow" aria-hidden="true">↗</span>';
  (sidebar.querySelector('.sidebar-foot')||sidebar).append(identity);
 }
 if(!sidebar){dock?.remove();dock=null;if(header&&user&&!header.querySelector('.workspace-account')){const a=document.createElement('a');a.className='workspace-account';a.href='/access#account';a.innerHTML=icon('settings')+'<span>Hesabım</span>';header.append(a);}return;}
 if(sidebar&&!sidebar.querySelector('[data-workspace-close]')){const close=document.createElement('button');close.type='button';close.className='workspace-menu-close';close.dataset.workspaceClose='';close.setAttribute('aria-label','Menüyü kapat');close.textContent='×';close.onclick=()=>{sidebar.classList.remove('open');document.querySelector('#commerce-menu,[data-action="menu"]')?.focus();};sidebar.prepend(close);}
 const workspace=ns(),keys=workspace==='ec'?['overview','orders','stock','performance']:['dashboard','production','recipes','materialstock'];
 const labels={overview:'Özet',orders:'Siparişler',stock:'Depo',performance:'Satış ve kâr',reports:'Raporlar',dashboard:'Özet',production:'Üretim',recipes:'Reçeteler',materialstock:'Depo'};
 const links=keys.map(key=>sidebar.querySelector('a[href="#'+key+'"]')).filter(a=>a&&!a.hidden&&a.style.display!=='none');
 const current=location.hash.slice(1).split('?')[0]||(workspace==='ec'?'overview':'dashboard');
 const signature=links.map(a=>a.hash).join('|')+'|'+current;
 if(!dock){dock=document.createElement('nav');dock.className='mobile-dock';dock.setAttribute('aria-label','Sık kullanılan ekranlar');document.body.append(dock);}
 if(dock.dataset.signature!==signature){
  dock.dataset.signature=signature;
  dock.innerHTML=links.map(a=>{const key=a.hash.slice(1),full=a.querySelector('.nav-text')?.textContent||labels[key],label=full.toLocaleLowerCase('tr-TR').includes(labels[key].toLocaleLowerCase('tr-TR'))?full:labels[key]+' · '+full;return '<a href="'+a.hash+'" aria-label="'+esc(label)+'"'+(key===current?' aria-current="page"':'')+'>'+icon(key)+'<span>'+labels[key]+'</span></a>';}).join('')+'<button type="button" data-dock-menu aria-label="Tüm ekranlar">'+icon('catalog')+'<span>Menü</span></button>';
  dock.querySelector('[data-dock-menu]').onclick=()=>document.querySelector('#commerce-menu,[data-action="menu"]')?.click();
 }
}
function carryRange(event){
 const a=event.target.closest('#sidebar a.nav-link,.mobile-dock a');if(!a||ns()!=='ec'||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 const href=navigationHref(a.getAttribute('href'),location.href);
 if(href===a.getAttribute('href'))return;
 event.preventDefault();location.assign(href);
}
document.addEventListener('click',carryRange);
const initialRevision=authRevision;
fetch('/api/auth/status').then(r=>r.ok?r.json():null).then(s=>{if(authRevision===initialRevision)setWorkspaceUser(s?.authenticated?s.user:null);}).catch(()=>{if(authRevision===initialRevision){ready=true;enhanceWorkspaceFrame();}});
