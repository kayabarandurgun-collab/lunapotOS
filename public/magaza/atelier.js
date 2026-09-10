/* Progressive visual layer. Product, cart and customer APIs remain owned by their modules. */
(() => {
 'use strict';
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const accountIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>';
 document.querySelectorAll('.account-link>span').forEach(el=>{el.innerHTML=accountIcon});
 const filename=location.pathname.split('/').pop()||'index.html';
 const home=['index.html','home.html','shop.html'].includes(filename);
 document.querySelectorAll('.category-nav>a,.mobile-bottom>a').forEach(a=>{
  const dest=new URL(a.href,location.href);
  if((home&&(a.classList.contains('home-nav')||a.closest('.mobile-bottom')&&['index.html','home.html','shop.html',''].includes(dest.pathname.split('/').pop())))||(!home&&dest.pathname===location.pathname&&!dest.search))a.setAttribute('aria-current','page');
 });
 if(!reduced.matches&&'IntersectionObserver' in window){
  const seen=new WeakSet(),io=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){if(!seen.has(e.target)){seen.add(e.target);e.target.classList.add('atelier-enter');e.target.addEventListener('animationend',()=>e.target.classList.remove('atelier-enter'),{once:true})}io.unobserve(e.target)}},{threshold:.12});
  document.querySelectorAll('.category-tiles>a,.form-story-image,.form-story-copy,.companion-section,.store-intro').forEach(el=>io.observe(el));
 }
 // Static comparison: only verified form and surface descriptions; no invented dimensions.
 const story=document.querySelector('.form-story-copy'),picture=document.querySelector('.form-story-image img');
 if(story&&picture){
  const switcher=document.createElement('div');switcher.className='form-switch';switcher.setAttribute('role','group');switcher.setAttribute('aria-label','Saksı formunu karşılaştır');
  switcher.innerHTML='<button type="button" data-form="nova" aria-pressed="true">Nova · Yuvarlak</button><button type="button" data-form="luna" aria-pressed="false">Luna · İnce</button>';
  const note=document.createElement('p');note.className='form-comparison-note';note.setAttribute('aria-live','polite');note.textContent='Nova · Yuvarlak hatlar, bakır görünümlü damarlar.';
  story.querySelector('.feature-lines').before(switcher,note);
  const choices={nova:{image:'nova-copper-object.webp',alt:'Nova saksının yuvarlak formu ve bakır damarları',text:'Nova · Yuvarlak hatlar, bakır görünümlü damarlar.'},luna:{image:'luna-silver-object.webp',alt:'Luna saksının ince silüeti ve gümüş görünümlü damarları',text:'Luna · İnce silüet, gümüş görünümlü damarlar.'}};
  let request=0;
  switcher.addEventListener('click',async e=>{
   const button=e.target.closest('[data-form]');if(!button)return;const id=++request,selected=choices[button.dataset.form],im=new Image();im.src='assets/'+selected.image;
   try{await im.decode()}catch{return}if(id!==request)return;
   picture.getAnimations().forEach(a=>a.cancel());picture.src=im.src;picture.alt=selected.alt;note.textContent=selected.text;
   switcher.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
   story.querySelector('a.button').href='magaza.html?category='+button.dataset.form+'#collection';story.querySelector('a.button').textContent=(button.dataset.form==='nova'?'Nova':'Luna')+' koleksiyonunu incele ↗';
   if(!reduced.matches)picture.animate([{opacity:.35,transform:'scale(.97)'},{opacity:1,transform:'scale(1)'}],{duration:420,easing:'cubic-bezier(.22,.7,.2,1)'});
  });
 }
 // Reflect actual catalog state. Each chip removes only its own filter.
 const grid=document.querySelector('.store-catalog-page #products');
 if(grid&&typeof state!=='undefined'){
  const context=document.createElement('div');context.className='filter-context';context.setAttribute('role','group');context.setAttribute('aria-label','Seçili filtreler');grid.before(context);
  const result=document.querySelector('#result-count');result?.setAttribute('role','status');result?.setAttribute('aria-live','polite');
  const labels={all:'Tüm ürünler','saksı':'Saksılar',toprak:'Toprak & bakım',nova:'Nova koleksiyonu',luna:'Luna koleksiyonu',budget:'500 TL altı',favorites:'Favorilerim'};
  function sync(){
   context.replaceChildren();
   const entries=[];if(state.filter!=='all')entries.push(['filter',labels[state.filter]||state.filter]);if(state.query)entries.push(['query','Arama: '+state.query]);if(state.max)entries.push(['max',state.max+' TL altı']);
   for(const [key,label] of entries){const b=document.createElement('button');b.type='button';b.dataset.clearFilter=key;b.setAttribute('aria-label',label+' filtresini kaldır');b.append(document.createTextNode(label));const x=document.createElement('span');x.textContent='×';x.setAttribute('aria-hidden','true');b.append(x);context.append(b)}
   document.querySelectorAll('.category-nav>a').forEach(a=>{const c=a.dataset.shopCategory||new URL(a.href,location.href).searchParams.get('category');if(c){if(c===state.filter)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')}});
  }
  context.addEventListener('click',e=>{const key=e.target.closest('[data-clear-filter]')?.dataset.clearFilter;if(!key)return;if(key==='filter')state.filter='all';if(key==='query'){state.query='';document.querySelector('#store-query').value=''}if(key==='max'){state.max='';document.querySelector('#budget-select').value=''}renderProducts();sync();const next=context.querySelector('button')||[...document.querySelectorAll('.filter-trigger,[data-filter="all"]')].find(el=>el.getClientRects().length);next?.focus({preventScroll:true})});
  new MutationObserver(sync).observe(grid,{childList:true});sync();
 }
})();
