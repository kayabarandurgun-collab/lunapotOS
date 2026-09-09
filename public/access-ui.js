import {modules,can,level} from './permissions.js';
let observer=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function accessAllowed(user,ns,root){
 observer?.disconnect();observer=null;
 if(!user||user.owner)return true;
 const route=location.hash.slice(1).split('?')[0]|| (ns==='ec'?'overview':'dashboard'),home=['overview','dashboard'].includes(route);
 if(user[ns+'_access']==='none'||!home&&!can(user,ns,route)){root.innerHTML='<section class="access-denied"><h1>Bu ekrana yetkin yok.</h1><p>'+esc(user.name)+', yöneticin bu ekranı hesabına açmamış.</p><a class="primary" href="'+(user[ns+'_access']==='none'?'/':ns==='ec'?'/eticaret/#overview':'/uretim/#dashboard')+'">Yetkili ekranlarıma dön</a><button class="text-button" id="access-logout">Çıkış yap</button></section>';root.querySelector('#access-logout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});location.reload();};return false;}
 const readonly=!can(user,ns,route,true);
 const apply=()=>{
  document.querySelectorAll('nav a[href="#settings"],nav a[href="#integrations"],a[href="/access"]').forEach(el=>{el.hidden=true;});
  document.querySelectorAll('a[href^="#"]').forEach(el=>{const key=el.getAttribute('href').slice(1).split('?')[0];if(!['overview','dashboard'].includes(key)&&!can(user,ns,key))el.hidden=true;});
  if(!user.permissions?.delete_records)document.querySelectorAll('[data-delete],[data-confirm-delete]').forEach(b=>{b.disabled=true;b.title='Kalıcı silme iznin yok.';});
  const header=document.querySelector('.workspace header');if(header&&!document.querySelector('#access-mode')){const div=document.createElement('div');div.id='access-mode';div.className='access-read-banner';div.textContent=user.name+' · '+(readonly?'Yalnızca görüntüleme yetkisi':'İşlem yapma yetkisi');header.after(div);}
  if(readonly){
   const groups={catalog:['new','edit','archive'],business:['party','account','entry','cash','allocation','reverse','profile','shipping','commission','archive'],order:['new','invoice-draft','source','map','reserve','ship','deliver','cancel'],reconcile:['allocate','reverse'],production:['new','material','reverse'],op:['configure','sync','resume-sync','backup']};
   for(const [group,actions] of Object.entries(groups))for(const action of actions)document.querySelectorAll('[data-'+group+'="'+action+'"]').forEach(b=>{b.disabled=true;b.title='Bu hesap yalnızca görüntüleyebilir.';});
   document.querySelectorAll('dialog button[type="submit"],input[type="file"]').forEach(b=>{b.disabled=true;});
   document.querySelectorAll('[data-edit],[data-delete],[data-action^="new-"],[data-ac="invoice"],[data-ac="product"],[data-ac="stock"],[data-ac="edit-product"],[data-ac="sale"],[data-ac="return"],[data-ac="fees"],[data-ac="expense"],[data-ac="receive-invoice"],[data-ac="purchase-return"],[data-ac="reverse-receipt"],[data-ac="reverse-purchase-return"],[data-ac="purchase-adjustment"],[data-ac="reverse-adjustment"],[data-ac="post-invoice"],[data-ac="cancel-invoice"]').forEach(b=>{b.disabled=true;b.title='Bu hesap yalnızca görüntüleyebilir.';});
  }
 };
 observer=new MutationObserver(apply);observer.observe(root,{childList:true,subtree:true});apply();return true;
}

export function staffHome(user,ns){return '<section class="access-hero"><span>KİŞİSEL ÇALIŞMA ALANIN</span><h1>Merhaba, '+esc(user.name)+'</h1><p>Yöneticinin açtığı ekranlar burada. Her kartta işlem yapma veya görüntüleme yetkini görebilirsin.</p></section><div class="staff-modules">'+Object.entries(modules[ns]).filter(([key])=>can(user,ns,key)).map(([key,[title,help]])=>'<a href="#'+key+'"><strong>'+title+'</strong>'+esc(help)+'<small>'+ (level(user,ns,key)==='write'?'Görüntüleme ve işlem →':'Yalnızca görüntüleme →')+'</small></a>').join('')+'</div>'; }
