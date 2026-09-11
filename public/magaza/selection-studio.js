/* Side-by-side product presentation; uses the supplied original transparent images. */
(()=>{
 const root=document.querySelector('.selection-studio');if(!root)return;
 const controls=root.querySelector('.selection-tools'),status=root.querySelector('.selection-status');
 const images=[...root.querySelectorAll('[data-selection-image]')],motion=matchMedia('(prefers-reduced-motion: reduce)');
 const empty={
  'nova-white':{src:'assets/nova-white-part-closed.png',box:[120,430,902,842],size:[1149,1369]},
  'nova-black':{src:'assets/nova-black-part-closed.png',box:[212,793,563,527],size:[1122,1402]},
  'luna-white':{src:'assets/luna-part-closed.png',box:[121,291,881,936],size:[1122,1402]},
  'luna-black':{src:'assets/luna-black-part-closed.png',box:[145,336,837,875],size:[1122,1402]}
 };
 const planted={'nova-white':'assets/nova-white-planted.png','nova-black':'assets/nova-black-planted.png','luna-white':'assets/luna-white-planted.png','luna-black':'assets/luna-black-planted.png'};
 let serial=0,selection={tone:'white',view:'planted'};
 controls.hidden=false;
 async function change(){
  const id=++serial,tone=controls.querySelector('[name=selection-tone]:checked').value,view=controls.querySelector('[name=selection-view]:checked').value;
  const entries=images.map(svg=>{const model=svg.dataset.selectionImage,key=model+'-'+tone,asset=view==='planted'?{src:planted[key],box:[0,0,1122,1402],size:[1122,1402]}:empty[key];return {svg,model,asset}});
  root.setAttribute('aria-busy','true');
  try{
   await Promise.all(entries.map(({asset})=>{const img=new Image();img.src=asset.src;return img.decode()}));if(id!==serial)return;
   for(const {svg,model,asset} of entries){const image=svg.querySelector('image');svg.setAttribute('viewBox',asset.box.join(' '));image.setAttribute('href',asset.src);image.setAttribute('width',asset.size[0]);image.setAttribute('height',asset.size[1]);svg.setAttribute('aria-label',(model==='nova'?'Nova':'Luna')+' '+(tone==='white'?'beyaz':'siyah')+' mermer, '+(view==='planted'?'bitkili görünüm':'sadece saksı'));svg.getAnimations().forEach(a=>a.cancel());if(!motion.matches)svg.animate([{opacity:.25},{opacity:1}],{duration:280,easing:'ease-out'})}
   selection={tone,view};status.textContent=(tone==='white'?'Beyaz mermer':'Siyah mermer')+' · '+(view==='planted'?'Bitkili görünüm':'Sadece saksı');
  }catch{if(id!==serial)return;controls.querySelector('[name=selection-tone][value='+selection.tone+']').checked=true;controls.querySelector('[name=selection-view][value='+selection.view+']').checked=true;status.textContent='Görsel yüklenemedi. Önceki görünüm korunuyor; tekrar deneyebilirsin.'}
  finally{if(id===serial)root.removeAttribute('aria-busy')}
 }
 controls.addEventListener('change',change);
 motion.addEventListener('change',e=>{if(e.matches)images.forEach(svg=>svg.getAnimations().forEach(a=>a.cancel()))});
})();
