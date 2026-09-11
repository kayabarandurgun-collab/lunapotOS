/* Separate photographic body layers; independent from planting animation. */
(()=>{
 const assets={
  nova:['assets/body-nova-core.png','assets/body-nova-color.png','assets/body-nova-marble.png','assets/body-nova-clear.png','assets/body-nova-final.png'],
  luna:['assets/body-luna-core.png','assets/body-luna-color.png','assets/body-luna-marble.png','assets/body-luna-clear.png','assets/body-luna-final.png']
 };
 const names=['Fiberglass iç yapı','Renk katmanı','Mermer efekti','Koruyucu yüzey'];
 function markup(id,tone,model){
  const files=assets[model]||assets.nova;
  return `<div class="body-parts" data-body-model="${model}"><div class="body-scene"><svg viewBox="0 0 1000 660" role="img" aria-labelledby="${id}-body-title"><title id="${id}-body-title">${model.toUpperCase()} gövdesinin dört katmanı</title><ellipse class="body-ground" cx="490" cy="580" rx="300" ry="18"/><g class="body-exploded">${files.slice(0,4).map((src,i)=>`<image class="body-layer body-layer-${i}" data-body-layer="${i}" href="${src}" preserveAspectRatio="xMidYMid meet"/>`).join('')}</g><image class="body-finished" href="${files[4]}" x="290" y="100" width="420" height="450" preserveAspectRatio="xMidYMid meet" opacity="0"/></svg>${names.map((name,i)=>`<button type="button" class="body-point body-point-${i}" data-point="${i}" aria-label="${name}" aria-pressed="false"><span>0${i+1}</span></button>`).join('')}</div><div class="body-scrubber"><div><label for="${id}-body-range">Gövdeyi elinle birleştir</label><output class="body-percent" for="${id}-body-range">%0</output></div><input id="${id}-body-range" type="range" min="0" max="100" step="1" value="0" aria-valuetext="Katmanlar açık, yüzde 0"><div class="body-range-ends"><span>Katmanlar açık</span><span>Birleşik gövde</span></div><p class="body-phase" role="status" aria-live="polite">Her katmanı ayrı ayrı keşfet.</p></div></div>`;
 }
 function attach(host){
  const root=host.querySelector('.body-parts'),model=root.dataset.bodyModel;
  const nodes=[...root.querySelectorAll('[data-body-layer]')],group=root.querySelector('.body-exploded'),finished=root.querySelector('.body-finished');
  const range=root.querySelector('input'),percent=root.querySelector('output'),phase=root.querySelector('.body-phase'),button=host.querySelector('.photo-assembly'),points=[...root.querySelectorAll('.body-point')];
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  let progress=0,frame=0,running=false,direction=1,last=0,phaseKey=-1;
  const clamp=v=>Math.min(1,Math.max(0,v)),ease=v=>v*v*(3-2*v);
  function label(){button.textContent=running?'Duraklat Ⅱ':progress>=1?'Katmanları aç ↗':progress>0?'Devam et ▷':'Gövdeyi birleştir ▷';button.setAttribute('aria-pressed',String(running))}
  function clearSelection(){host.dataset.step='-1';host.querySelectorAll('[data-point],.diagram-steps button').forEach(b=>b.setAttribute('aria-pressed','false'))}
  function render(value){
   progress=clamp(value);const shift=ease(progress)*220;
   const coreWidth=model==='luna'?350:370,coreHeight=model==='luna'?420:390;
   nodes.forEach((node,i)=>{
    const t=i?ease(clamp((progress-(i-1)*.1)/.7)):0;
    const start=i?[0,465,640,815][i]:70;
    const end=70+coreWidth*.61;
    node.setAttribute('x',String(i?start+(end-start)*t+shift:70+shift));
    node.setAttribute('y',String(i?155:110));node.setAttribute('width',String(i?145:coreWidth));node.setAttribute('height',String(i?350:coreHeight));
   });
   const fade=ease(clamp((progress-.78)/.22));group.setAttribute('opacity',String(1-fade));finished.setAttribute('opacity',String(fade));
   points.forEach(p=>{p.hidden=progress>.02});
   range.value=String(Math.round(progress*100));percent.value='%'+range.value;
   const key=progress===0?0:progress===1?2:1;
   const texts=['Her katmanı ayrı ayrı keşfet.','Katmanlar tek gövdede buluşuyor.','Gövde tamamlandı. Katmanları yeniden açabilirsin.'];
   if(key!==phaseKey){phase.textContent=texts[key];phaseKey=key}
   range.setAttribute('aria-valuetext',(key===0?'Katmanlar açık':key===2?'Birleşik gövde':'Birleşme')+', yüzde '+range.value);
   host.dataset.assembled=String(progress===1);host.dataset.assembling=String(running);label();
  }
  function pause(){cancelAnimationFrame(frame);frame=0;running=false;host.dataset.assembling='false';label()}
  function tick(now){if(!running)return;if(!last){last=now;frame=requestAnimationFrame(tick);return}const delta=Math.min(now-last,80)/4400;last=now;render(progress+direction*delta);if(progress===0||progress===1){pause();return}frame=requestAnimationFrame(tick)}
  function toggle(){if(running){pause();return}clearSelection();if(progress>=1)direction=-1;else if(progress<=0)direction=1;if(reduce.matches){render(direction>0?1:0);return}running=true;last=0;label();frame=requestAnimationFrame(tick)}
  range.addEventListener('input',()=>{pause();clearSelection();direction=1;render(Number(range.value)/100)});
  const onMotion=()=>{if(reduce.matches)pause()};reduce.addEventListener('change',onMotion);render(0);
  return {pause,toggle,reset(){pause();direction=1;render(0)},reveal(){pause();direction=1;render(0)},destroy(){pause();reduce.removeEventListener('change',onMotion)},get progress(){return progress}};
 }
 window.LunapotBodyParts={markup,attach};
})();
