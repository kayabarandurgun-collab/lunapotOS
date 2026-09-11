/* Progressive navigation and local FAQ filtering. No account or checkout writes. */
(()=>{'use strict';
 const nav=document.querySelector('.category-nav');
 const canonical=u=>{const p=new URL(u,location.href).pathname.replace(/\.html$/,'').replace(/\/$/,'');return p.replace(/\/index$/,'')};
 if(nav){
  const menu=document.createElement('details');menu.className='mobile-site-menu';
  const summary=document.createElement('summary');summary.innerHTML='<span class="mobile-menu-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>Menü</span><span class="mobile-menu-current"></span><span class="mobile-menu-arrow" aria-hidden="true">+</span>';summary.setAttribute('aria-controls','mobile-site-links');
  const links=document.createElement('nav');links.className='mobile-menu-links';links.id='mobile-site-links';links.setAttribute('aria-label','Mobil ana menü');
  const seen=new Set();for(const original of nav.querySelectorAll('a[href]')){const a=document.createElement('a');a.href=original.getAttribute('href');a.textContent=original.textContent.trim();const current=canonical(a.href)===canonical(location.href);if(current){a.setAttribute('aria-current','page');summary.querySelector('.mobile-menu-current').textContent=a.textContent}seen.add(canonical(a.href));links.append(a)}
  const secondary=document.createElement('nav');secondary.className='mobile-menu-secondary';secondary.setAttribute('aria-label','Bilgi ve yardım');for(const original of document.querySelectorAll('.utility-links a[href]')){if(seen.has(canonical(original.href)))continue;const a=document.createElement('a');a.href=original.getAttribute('href');a.textContent=original.textContent.trim();if(canonical(a.href)===canonical(location.href)){a.setAttribute('aria-current','page');summary.querySelector('.mobile-menu-current').textContent=a.textContent}secondary.append(a)}
  menu.append(summary,links,secondary);nav.after(menu);document.body.classList.add('site-shell-ready');
  menu.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu.open){menu.open=false;summary.focus();e.preventDefault()}});
  document.addEventListener('pointerdown',e=>{if(menu.open&&!menu.contains(e.target))menu.open=false});
  const wide=matchMedia('(min-width:701px)');wide.addEventListener('change',()=>{if(wide.matches)menu.open=false});
 }
 const layout=document.querySelector('.faq-layout');
 if(layout){
  const sections=[...layout.querySelectorAll('.faq-section')],items=sections.flatMap(s=>[...s.querySelectorAll('details')]);
  const search=document.createElement('form');search.className='faq-search';search.setAttribute('role','search');search.setAttribute('aria-label','Yardım sorularında ara');search.innerHTML='<label for="faq-query">Aklındaki soruyu bul</label><div class="faq-search-row"><input id="faq-query" type="search" maxlength="80" autocomplete="off" placeholder="Örneğin: hazne, toprak, toplu sipariş"><button type="button" hidden>Temizle</button></div><p class="faq-search-status" role="status" aria-live="polite"></p>';
  const empty=document.createElement('p');empty.className='faq-no-results';empty.hidden=true;empty.innerHTML='Bu aramayla eşleşen bir soru yok. Farklı bir kelime dene veya <a href="iletisim.html">bize sor</a>.';
  const input=search.querySelector('input'),clear=search.querySelector('button'),status=search.querySelector('[role=status]');let previous=null;
  const normalize=v=>v.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu,'').replace(/ı/g,'i').trim();
  function filter(){const query=normalize(input.value),words=query.split(/\s+/);if(query&&!previous)previous=items.map(i=>i.open);let count=0;items.forEach((item,index)=>{const match=!query||words.every(w=>normalize(item.textContent).includes(w));item.hidden=!match;if(query)item.open=match;else if(previous)item.open=previous[index];if(match)count++});if(!query)previous=null;sections.forEach(s=>s.hidden=[...s.querySelectorAll('details')].every(d=>d.hidden));clear.hidden=!query;empty.hidden=count>0;status.textContent=query?count+' soru bulundu.':items.length+' soruda ara veya aşağıdaki konulardan başla.'}
  input.addEventListener('input',filter);search.addEventListener('submit',e=>e.preventDefault());clear.addEventListener('click',()=>{input.value='';filter();input.focus()});layout.before(search);layout.after(empty);layout.querySelector('.faq-nav')?.addEventListener('click',e=>{if(e.target.closest('a[href^="#"]')){input.value='';filter()}});filter();
 }
})();
