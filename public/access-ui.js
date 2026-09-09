let observer=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function accessAllowed(user,ns,root){
 observer?.disconnect();observer=null;
 if(!user||user.owner)return true;
 if(user[ns+'_access']==='none'){root.innerHTML='<section class="access-denied"><h1>Bu panele yetkin yok.</h1><p>'+esc(user.name)+', yöneticin bu çalışma alanını hesabına açmamış.</p><a class="primary" href="/">Uygulamalara dön</a><button class="text-button" id="access-logout">Çıkış yap</button></section>';root.querySelector('#access-logout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});location.reload();};return false;}
 const readonly=user[ns+'_access']==='read';
 const apply=()=>{
  document.querySelectorAll('nav a[href="#settings"],nav a[href="#integrations"],a[href="/access"]').forEach(el=>{el.hidden=true;});
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
