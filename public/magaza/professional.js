(() => {
 const name=location.pathname.split('/').pop();
 document.querySelectorAll('.utility-links a').forEach(a=>{if(a.getAttribute('href')===name)a.setAttribute('aria-current','page')});
 const header=document.querySelector('.header');
 const shadow=()=>header?.classList.toggle('is-scrolled',scrollY>20);shadow();addEventListener('scroll',shadow,{passive:true});
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');
 if(!reduce.matches&&'IntersectionObserver' in window){
  const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');observer.unobserve(e.target)}}),{threshold:.08});
  document.querySelectorAll('.brand-note,.value-grid article,.story-row,.project-note,.company-cta').forEach(el=>{el.classList.add('reveal-ready');observer.observe(el)});
  reduce.addEventListener('change',e=>{if(e.matches){observer.disconnect();document.querySelectorAll('.reveal-ready').forEach(el=>el.classList.add('is-visible'))}});
 }
 const form=document.querySelector('#contact-draft');
 if(form){
  const topic=document.querySelector('#contact-topic');const requested=new URLSearchParams(location.search).get('konu');
  if([...topic.options].some(o=>o.value===requested))topic.value=requested;
  form.addEventListener('submit',e=>{
   e.preventDefault();if(!form.reportValidity())return;
   const sender=document.querySelector('#contact-name').value.trim();const message=document.querySelector('#contact-message').value.trim();
   if(message.length<10){document.querySelector('#contact-status').textContent='Mesajını en az 10 karakterle anlatabilir misin?';return}
   const body=(sender?'Ad / firma: '+sender+'\n\n':'')+message;
   const href='mailto:info@lunapot.com?subject='+encodeURIComponent('Lunapot | '+topic.value)+'&body='+encodeURIComponent(body);
   document.querySelector('#contact-status').textContent='E-posta uygulamanda taslak açılması istendi; henüz mesaj gönderilmedi. Uygulama açılmazsa mesajını info@lunapot.com adresine kendin gönderebilirsin.';
   const link=document.createElement('a');link.href=href;link.click();
  });
 }
})();
