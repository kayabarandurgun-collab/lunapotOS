(() => {
 const slides=[{k:'EVİNE İYİ GELECEK ŞEYLER',title:'Biraz yeşil.',accent:'Çokça iyi his.',desc:'Sevdiğin saksılar, bitkine iyi gelen topraklar. Aradığın güzellik, düşündüğünden daha yakın.',image:'room.webp',alt:'Aydınlık bir odada Nova saksılar',link:'magaza.html',cta:'Mağazayı keşfet',caption:'Form, doku ve biraz yeşil.'},{k:'LUNA KOLEKSİYONU',title:'Sade bir form.',accent:'Güçlü bir his.',desc:'Zarif bir silüet, mermer görünümlü yüzeyler. Luna’nın farklı dokularıyla tanış.',image:'luna-silver.webp',alt:'Gümüş dokulu Luna saksı',link:'magaza.html?category=luna#collection',cta:'Luna’yı keşfet',caption:'Detaylarda saklı bir karakter.'},{k:'TOPRAK & BAKIM',title:'Her şey',accent:'kökten başlar.',desc:'Bitkinin ihtiyaçlarına yer aç. Toprak ve bakım seçeneklerini aynı yerde keşfet.',image:'soil.webp',alt:'Lunapot bitki toprağı paketi',link:'magaza.html?category=toprak#collection',cta:'Toprakları incele',caption:'Saksını tamamlayan küçük dokunuş.'}];
 const hero=document.querySelector('.carousel-section'),pause=document.querySelector('#hero-pause'),reduce=matchMedia('(prefers-reduced-motion: reduce)');
 let current=0,paused=reduce.matches||matchMedia('(max-width: 700px)').matches,hover=false,focused=false,timer,ticket=0,progressAnimation;
 const track=document.createElement('span');track.className='hero-progress';track.setAttribute('aria-hidden','true');const progress=document.createElement('span');track.append(progress);pause.before(track);
 function schedule(){clearTimeout(timer);progressAnimation?.cancel();if(!paused&&!hover&&!focused&&!document.hidden){if(!reduce.matches)progressAnimation=progress.animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration:6500,fill:'forwards',easing:'linear'});timer=setTimeout(()=>show((current+1)%slides.length,false),6500)}}
 function syncPause(){pause.textContent=paused?'▶':'Ⅱ';pause.setAttribute('aria-label',paused?'Geçişi başlat':'Geçişi duraklat')}
 async function show(index,manual=true){
  const n=++ticket,slide=slides[index],im=new Image();im.src='assets/'+slide.image;
  try{await im.decode()}catch{schedule();return}if(n!==ticket)return;
  const image=document.querySelector('#hero-image'),holder=image.parentElement;
  holder.querySelectorAll('.hero-outgoing').forEach(el=>el.remove());
  let outgoing;if(!reduce.matches&&index!==current){outgoing=image.cloneNode();outgoing.removeAttribute('id');outgoing.removeAttribute('fetchpriority');outgoing.alt='';outgoing.setAttribute('aria-hidden','true');outgoing.classList.add('hero-outgoing');holder.append(outgoing)}
  current=index;image.src=im.src;image.alt=slide.alt;image.classList.toggle('soil-scene',index===2);
  document.querySelector('#hero-kicker').textContent=slide.k;
  const title=document.querySelector('#hero-title');title.replaceChildren(document.createTextNode(slide.title),document.createElement('br'));const span=document.createElement('span');span.textContent=slide.accent;title.append(span);
  document.querySelector('#hero-description').textContent=slide.desc;const link=document.querySelector('#hero-link');link.href=slide.link;link.textContent=slide.cta+' ↗';document.querySelector('#hero-caption').textContent=slide.caption;document.querySelector('.hero-image-index').textContent='L / 0'+(index+1);
  document.querySelectorAll('[data-slide]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.slide)===index)));
  if(manual)document.querySelector('#hero-scene-status').textContent=(index+1)+' / 3 · '+slide.k;
  if(!reduce.matches){
   if(outgoing){const fade=outgoing.animate([{opacity:1},{opacity:0}],{duration:680,easing:'cubic-bezier(.22,.7,.2,1)',fill:'forwards'});fade.finished.then(()=>outgoing.remove()).catch(()=>outgoing.remove())}
   for(const el of [title,document.querySelector('#hero-description'),document.querySelector('#hero-kicker')]){el.getAnimations().forEach(a=>a.cancel());el.animate([{opacity:0,transform:'translateY(9px)'},{opacity:1,transform:'translateY(0)'}],{duration:450,easing:'cubic-bezier(.22,.7,.2,1)'})}
  }
  schedule();
 }
 document.querySelectorAll('[data-slide]').forEach(b=>b.addEventListener('click',()=>{paused=true;syncPause();show(Number(b.dataset.slide))}));pause.addEventListener('click',()=>{paused=!paused;syncPause();schedule()});
 hero.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;schedule()}});hero.addEventListener('pointerleave',()=>{hover=false;schedule()});
 hero.addEventListener('focusin',()=>{focused=true;schedule()});hero.addEventListener('focusout',e=>{if(!hero.contains(e.relatedTarget)){focused=false;schedule()}});document.addEventListener('visibilitychange',schedule);
 reduce.addEventListener('change',e=>{if(e.matches){paused=true;hero.querySelectorAll('*').forEach(el=>el.getAnimations().forEach(a=>a.cancel()));hero.querySelectorAll('.hero-outgoing').forEach(el=>el.remove());syncPause();schedule()}});syncPause();schedule();
 const base=renderProducts;renderProducts=function(){base();const chosen=['soil','nova-copper','luna-dark','luna-silver'];document.querySelectorAll('.product-card').forEach(card=>{const id=card.querySelector('[data-product]')?.dataset.product;if(!chosen.includes(id))card.remove()})};renderProducts();
 document.addEventListener('submit',e=>{if(e.target.id==='store-search'){e.preventDefault();e.stopImmediatePropagation();saveSelections();location.href='magaza.html?q='+encodeURIComponent(document.querySelector('#store-query').value.trim())}},true);
 document.addEventListener('click',e=>{const b=e.target.closest('[data-action="favorites"]');if(b){e.preventDefault();e.stopImmediatePropagation();saveSelections();location.href='magaza.html?category=favorites#collection'}},true);
 if(document.querySelector('#companion-products'))document.querySelector('#companion-products').innerHTML=products.filter(p=>['torf-ts1','potground-p'].includes(p.id)).map(p=>'<a href="magaza.html?category=toprak#collection"><img src="assets/'+p.image+'" alt="'+p.name+'" loading="lazy"><strong>'+p.name+'</strong><span>Ürünü keşfet ↗</span></a>').join('');
})();
