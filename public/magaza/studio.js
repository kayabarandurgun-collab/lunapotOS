/* Storefront-only presentation and mobile filter controls. */
(() => {
 'use strict';
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const grid=document.querySelector('#products');
 let filterDone;
 function refreshCards(){
  if(typeof products==='undefined')return;
  grid.querySelectorAll('.product-card').forEach(card=>{
   if(card.dataset.studioReady)return;card.dataset.studioReady='true';
   const open=card.querySelector('.product-open'),p=products.find(p=>p.id===open?.dataset.product);
   if(p?.category==='saksı'){
    const img=open.querySelector('img');img.src='assets/'+p.id+'-object.webp';
    // Load the lifestyle alternate only on pointer intent; no extra downloads on mobile.
    open.addEventListener('pointerenter',e=>{if(e.pointerType!=='mouse'||reduced.matches||open.querySelector('.product-lifestyle'))return;const alternate=document.createElement('img');alternate.className='product-lifestyle';alternate.src='assets/'+p.image;alternate.alt='';alternate.setAttribute('aria-hidden','true');open.append(alternate)},{once:true});
   }
  });
  if(document.body.classList.contains('store-catalog-page')&&typeof state!=='undefined'){
   const names={all:'Tüm ürünler','saksı':'Saksılar',toprak:'Toprak & bakım',nova:'Nova koleksiyonu',luna:'Luna koleksiyonu',budget:'500 TL altı seçimler',favorites:'Favorilerin'};
   document.querySelector('.collection-heading h2').textContent=state.query?'Arama sonuçları':names[state.filter]||'Tüm ürünler';
   if(filterDone)filterDone.textContent=grid.querySelectorAll('.product-card').length+' ürünü göster';
  }
 }
 if(grid){refreshCards();new MutationObserver(refreshCards).observe(grid,{childList:true})}
 const controls=document.querySelector('.store-catalog-page .collection-tools');
 if(controls){
  const mq=matchMedia('(max-width:700px)'),anchor=document.createComment('Desktop filter position');controls.before(anchor);
  const trigger=document.createElement('button');trigger.type='button';trigger.className='filter-trigger';trigger.setAttribute('aria-controls','studio-filter-dialog');trigger.setAttribute('aria-expanded','false');trigger.innerHTML='Filtrele ve sırala <span aria-hidden="true">☷</span>';anchor.parentNode.insertBefore(trigger,anchor);
  const dialog=document.createElement('dialog');dialog.id='studio-filter-dialog';dialog.className='filter-dialog';dialog.setAttribute('aria-labelledby','studio-filter-title');dialog.innerHTML='<div class="dialog-head"><h2 id="studio-filter-title">Sana göre seç.</h2><button class="close" type="button" data-filter-close aria-label="Filtreleri kapat">×</button></div><button type="button" class="filter-done" data-filter-close>Ürünleri göster</button>';document.body.append(dialog);filterDone=dialog.querySelector('.filter-done');
  function close(){dialog.close()}
  trigger.addEventListener('click',()=>{if(!dialog.open){dialog.showModal();trigger.setAttribute('aria-expanded','true')}});
  dialog.addEventListener('click',e=>{if(e.target.closest('[data-filter-close]'))close();if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientY<r.top||e.clientY>r.bottom||e.clientX<r.left||e.clientX>r.right)close()}});
  dialog.addEventListener('close',()=>{trigger.setAttribute('aria-expanded','false');if(trigger.getClientRects().length)trigger.focus({preventScroll:true});else document.querySelector('.tabs button')?.focus({preventScroll:true})});
  function relocate(){if(mq.matches)filterDone.before(controls);else{if(dialog.open)close();anchor.after(controls)}}
  mq.addEventListener('change',relocate);relocate();refreshCards();
 }
 if(!reduced.matches&&'IntersectionObserver' in window){
  const io=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){if(!reduced.matches)e.target.animate([{opacity:.5,transform:'translateY(22px)'},{opacity:1,transform:'translateY(0)'}],{duration:650,easing:'cubic-bezier(.2,.7,.15,1)'});io.unobserve(e.target)}},{threshold:.12});
  document.querySelectorAll('.discover-card,.care-editorial,.footer-invitation').forEach(el=>io.observe(el));
 }
})();
