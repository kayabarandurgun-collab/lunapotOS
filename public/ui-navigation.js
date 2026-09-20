import {navigationHref} from './workspace-navigation.js';
// Search only destinations exposed by the current UI; never request or change business data.
const searchIcon='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const normalize=value=>value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
let palette=null;
function destinations(){
 const found=new Map();
 for(const link of document.querySelectorAll('#sidebar a.nav-link,#sidebar a.workspace-home,#sidebar a.workspace-identity,.workspace-account,.workspace .app-launcher-link,.launchpad a.application,.launchpad #manage-access')){
  if(link.closest('[hidden]')||getComputedStyle(link).display==='none'||(getComputedStyle(link).visibility==='hidden'&&!link.closest('#sidebar')))continue;
  const url=new URL(link.href,location.href);if(url.origin!==location.origin)continue;
  const copy=link.cloneNode(true);copy.querySelectorAll('svg,.nav-icon,.nav-badge,.features,.app-top,.app-open,p,small,[aria-hidden="true"]').forEach(n=>n.remove());
  const title=(link.dataset.navigationTitle||link.querySelector('.nav-text,h2,strong')?.textContent||copy.textContent).replace(/^[\s▦↗]+|[\s↗]+$/g,'').replace(/\s+/g,' ').trim();if(!title)continue;
  const href=navigationHref(url.pathname+url.search+url.hash,location.href);
  const current=link.classList.contains('active')||link.getAttribute('aria-current')==='page'||(url.pathname===location.pathname&&url.hash===location.hash&&url.search===location.search);
  if(!found.has(href))found.set(href,{href,title,current});
 }
 return [...found.values()];
}
function openPalette(){
 if(palette||document.querySelector('dialog[open]')||!destinations().length)return;
 const previous=document.activeElement,d=document.createElement('dialog');palette=d;d.className='ui-command';d.setAttribute('aria-labelledby','ui-command-title');
 d.innerHTML='<div class="ui-command-head"><div><span class="eyebrow">ÇALIŞMA ALANIN</span><h2 id="ui-command-title">Nereye geçmek istersin?</h2></div><button type="button" class="icon-button" data-command-close aria-label="Hızlı geçişi kapat">×</button></div><label class="ui-command-input">'+searchIcon+'<span class="ui-sr-only">Ekran ara</span><input type="search" placeholder="Ekran adı ara…" autocomplete="off" spellcheck="false" maxlength="100" aria-controls="ui-command-results" aria-describedby="ui-command-help"></label><p class="ui-command-count" role="status" aria-live="polite"></p><nav id="ui-command-results" aria-label="Bulunan ekranlar"></nav><div class="ui-command-foot" id="ui-command-help"><span>↑ ↓ seç · Enter aç</span><span>Esc kapat</span></div>';
 const input=d.querySelector('input'),list=d.querySelector('nav'),count=d.querySelector('[role=status]');
 function render(){
  const terms=normalize(input.value).split(/\s+/).filter(Boolean),rows=destinations().filter(e=>terms.every(t=>normalize(e.title).includes(t)));list.replaceChildren();count.textContent=rows.length+' ekran';
  for(const row of rows){const a=document.createElement('a');a.href=row.href;a.className='ui-command-result';const title=document.createElement('span');title.textContent=row.title;const hint=document.createElement('small');hint.textContent=row.current?'Buradasın':'→';if(!row.current)hint.setAttribute('aria-hidden','true');a.append(title,hint);if(row.current)a.setAttribute('aria-current','page');list.append(a);}
  if(!rows.length){const p=document.createElement('p');p.className='ui-command-empty';p.textContent='Bu adla ekran bulunamadı. Daha kısa bir kelime deneyebilirsin.';list.append(p);}
 }
 input.addEventListener('input',render);
 // The underlying workspace may change on browser Back/Forward while this dialog stays open.
 const refresh=()=>{const focused=list.contains(document.activeElement);render();if(focused)input.focus();};
 window.addEventListener('hashchange',refresh);
 d.addEventListener('click',e=>{
  if(e.target.closest('[data-command-close]'))d.close();
  const a=e.target.closest('.ui-command-result');if(!a||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
  e.preventDefault();const href=a.getAttribute('href');
  if(!destinations().some(row=>row.href===href)){render();input.focus();return;}
  d.close();location.assign(href);
 });
 d.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();d.close();return;}const links=[...list.querySelectorAll('a')],at=links.indexOf(document.activeElement);if(e.key==='ArrowDown'&&links.length){e.preventDefault();links[(at+1)%links.length].focus();}else if(e.key==='ArrowUp'&&links.length){e.preventDefault();if(at<=0)input.focus();else links[at-1].focus();}else if(e.key==='Enter'&&e.target===input&&links.length&&!e.isComposing){e.preventDefault();links[0].click();}});
 d.addEventListener('close',()=>{window.removeEventListener('hashchange',refresh);d.remove();palette=null;if(previous?.isConnected)previous.focus();},{once:true});
 document.body.append(d);render();d.showModal();input.focus();
}
export function enhanceNavigationSearch(){
 const host=document.querySelector('.workspace .header-actions,.launchpad .top-actions');if(!host||host.querySelector('[data-quick-nav]'))return;
 const shortcut=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
 const button=document.createElement('button');button.type='button';button.className='ui-quick-nav';button.dataset.quickNav='';button.setAttribute('aria-label','Hızlı geçiş: ekran ara');button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-keyshortcuts','Control+K Meta+K');button.innerHTML=searchIcon+'<span>Hızlı geçiş</span><kbd aria-hidden="true">'+shortcut+'</kbd>';button.addEventListener('click',openPalette);host.prepend(button);
}
window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&!e.isComposing&&e.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')&&document.querySelector('[data-quick-nav]')){e.preventDefault();openPalette();}});
