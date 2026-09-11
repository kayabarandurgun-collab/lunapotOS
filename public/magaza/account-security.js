/* Hesap güvenliği ve iletişim formu — sunucu bağlantısı (Claude, arka uç).
   Yalnızca mağaza API'si demo modundayken devreye girer; 8795 önizlemesinde mevcut davranış
   (mailto taslağı, sıfırlama notu) aynen kalır. Tasarım dosyalarını değiştirmez, mevcut sınıfları
   kullanır ve satır içi stil yazmaz (Worker CSP: style-src 'self'). Hiçbir e-posta gönderilmez. */
(()=>{
 const post=async(path,body)=>{const r=await fetch('/api/store'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let x={};try{x=await r.json()}catch{}if(!r.ok)throw Error(x.error||'İşlem tamamlanamadı.');return x};
 const ready=fetch('/api/store/config').then(r=>r.ok?r.json():null).then(c=>!!c&&c.mode==='demo').catch(()=>false);

 // İletişim formu: mailto taslağı yerine sunucu kaydı.
 const form=document.querySelector('#contact-draft');
 if(form){
  ready.then(on=>{
   if(!on)return;
   form.dataset.server='true';
   if(!form.querySelector('[name=email]')){
    const label=document.createElement('label');label.htmlFor='contact-email';label.textContent='E-posta adresin';
    const input=document.createElement('input');input.id='contact-email';input.name='email';input.type='email';input.autocomplete='email';input.maxLength=254;input.required=true;input.placeholder='Sana buradan döneceğiz';
    const before=form.querySelector('label[for=contact-topic]');form.insertBefore(label,before);form.insertBefore(input,before);
   }
   const intro=[...form.querySelectorAll('p')].find(p=>/taslak/.test(p.textContent));if(intro)intro.textContent='Mesajın doğrudan bize ulaşır.';
   const note=form.querySelector('.contact-form-end span');if(note)note.textContent='Test sürümü: mesaj kaydedilir, yanıt e-postası gönderilmez.';
   const button=form.querySelector('button[type=submit]');if(button)button.textContent='Mesajı gönder';
  });
  // Yakalama aşamasında: sunucu bağlıyken mailto işleyicisine hiç ulaşılmaz.
  document.addEventListener('submit',async e=>{
   if(e.target!==form||form.dataset.server!=='true')return;
   e.preventDefault();e.stopImmediatePropagation();
   if(!form.reportValidity())return;
   const status=document.querySelector('#contact-status'),button=form.querySelector('button[type=submit]'),x=Object.fromEntries(new FormData(form));
   button.disabled=true;
   try{const r=await post('/contact',{name:x.name||undefined,email:x.email||undefined,topic:x.topic,message:x.message});status.textContent=r.message;form.reset()}
   catch(err){status.textContent=err.message}
   finally{button.disabled=false}
  },true);
 }

 // Hesabım: e-posta doğrulama, şifre sıfırlama ve "Şifremi unuttum".
 if(!/\/hesabim(\.html)?$/.test(location.pathname))return;
 const params=new URLSearchParams(location.search);
 const clean=key=>{params.delete(key);history.replaceState(null,'',location.pathname+(params.toString()?'?'+params:'')+location.hash)};
 let dialogSerial=0;
 function panel(title,html=''){
  const origin=document.activeElement,d=document.createElement('dialog');d.className='flow-card account-security';
  const descriptions={'Şifre sıfırlama':'Hesabında kullandığın e-posta adresini yaz. Şifreni yenilemek için bir bağlantı isteyebilirsin.','Yeni şifre belirle':'En az 12 karakterden oluşan yeni bir şifre seç. İşlem tamamlandığında yeniden giriş yapabilirsin.','E-posta doğrulama':'Hesabının e-posta adresini doğruluyoruz.'};
  const header=document.createElement('header');header.className='security-header';
  const kicker=document.createElement('span');kicker.className='kicker';kicker.textContent='LUNAPOT / HESABIM';header.append(kicker);
  const h=document.createElement('h2');h.id='security-title-'+(++dialogSerial);h.textContent=title;header.append(h);d.setAttribute('aria-labelledby',h.id);
  const desc=document.createElement('p');desc.id='security-desc-'+dialogSerial;desc.className='security-description';desc.textContent=descriptions[title]||'';header.append(desc);d.setAttribute('aria-describedby',desc.id);d.append(header);
  const body=document.createElement('div');body.className='security-body';body.innerHTML=html;d.append(body);
  const close=document.createElement('button');close.type='button';close.className='security-close';close.textContent='×';close.setAttribute('aria-label','Pencereyi kapat');close.onclick=()=>d.close();d.append(close);
  const status=document.createElement('p');status.className='security-status';status.setAttribute('role','status');status.setAttribute('aria-atomic','true');status.hidden=true;d.append(status);
  const footer=document.createElement('footer');footer.className='security-footer';const back=document.createElement('button');back.type='button';back.className='security-back';back.textContent='Giriş ekranına dön';back.onclick=()=>d.close();footer.append(back);d.append(footer);
  d.addEventListener('close',()=>{d.remove();if(origin&&origin.isConnected)origin.focus()});document.body.append(d);d.showModal();return d;
 }
 const message=(d,text,state='success')=>{const p=d.querySelector('[role=status]');p.hidden=false;p.textContent=text;d.dataset.state=state;};

 ready.then(async on=>{
  if(!on)return;
  const verify=params.get('dogrula'),reset=params.get('sifirla');
  if(verify){
   clean('dogrula');
   const d=panel('E-posta doğrulama');message(d,'Bağlantın kontrol ediliyor…','pending');
   try{await post('/account/verify',{token:verify});message(d,'E-posta adresin doğrulandı.')}catch(err){message(d,err.message,'error')}
  }
  if(reset){
   clean('sifirla');
   const d=panel('Yeni şifre belirle','<form id="reset-confirm"><label>Yeni şifre<input name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password" placeholder="En az 12 karakter"></label><button class="button primary wide">Şifremi değiştir</button></form>');
   d.querySelector('form').addEventListener('submit',async e=>{
    e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
    try{message(d,(await post('/account/reset',{token:reset,password:e.target.password.value})).message);e.target.hidden=true;d.querySelector('.security-description').textContent='Yeni şifren hazır. Hesabına tekrar giriş yapabilirsin.'}catch(err){message(d,err.message,'error');b.disabled=false}
   });
  }
  // Giriş formu her çizildiğinde bir kez "Şifremi unuttum" eklenir.
  const addForgot=()=>{
   const login=document.querySelector('form#login');if(!login||login.querySelector('[data-forgot]'))return;
   login.querySelectorAll('.form-note').forEach(p=>{if(/henüz bağlı değil/.test(p.textContent))p.textContent='Şifreni unuttuysan sıfırlama bağlantısı isteyebilirsin.'});
   const b=document.createElement('button');b.type='button';b.className='button subtle';b.dataset.forgot='';b.textContent='Şifremi unuttum';login.append(b);
  };
  new MutationObserver(addForgot).observe(document.body,{childList:true,subtree:true});addForgot();
  document.addEventListener('click',e=>{
   if(!e.target.closest('[data-forgot]'))return;
   const d=panel('Şifre sıfırlama','<form id="reset-request"><label>E-posta<input name="email" type="email" required maxlength="254" autocomplete="email"></label><button class="button primary wide">Sıfırlama bağlantısı iste</button></form>');
   d.querySelector('form').addEventListener('submit',async ev=>{
    ev.preventDefault();const button=ev.target.querySelector('button');button.disabled=true;button.textContent='Bağlantı hazırlanıyor…';
    try{message(d,(await post('/account/reset/request',{email:ev.target.email.value})).message)}catch(err){message(d,err.message,'error')}finally{button.disabled=false;button.textContent='Sıfırlama bağlantısı iste'}
   });
  });
 });
})();
