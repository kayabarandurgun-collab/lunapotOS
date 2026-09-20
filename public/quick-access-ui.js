const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value*1000).toLocaleString('tr-TR'):'Henüz kullanılmadı';
async function api(path,body){
 const response=await fetch('/api/auth/'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw Error(data.error||'İşlem tamamlanamadı.');return data;
}
function styles(){if(!document.querySelector('link[href="/access-design.css"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/access-design.css';document.head.append(link);}}
const pinField=(name,label)=>`<label>${label}<input type="password" name="${name}" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required></label>`;

// Mount beside the ordinary password form. No automatic login, browser storage or captured PIN.
// Returns a disposer. onSuccess refreshes the caller's current user and renders its workspace.
export async function mountQuickLogin(container,{onSuccess=()=>location.reload(),onPassword}={}){
 styles();let disposed=false;const host=document.createElement('section');host.className='quick-access-login';
 if(container.tagName==='FORM')container.before(host);else container.prepend(host);
 const dispose=()=>{disposed=true;host.remove();};
 try{
  const status=await api('quick/status');if(disposed||!host.isConnected)return dispose;
  if(!status.available){host.remove();return dispose;}
  host.innerHTML=`<form><h2>6 haneli kodla giriş</h2><p>Bu tarayıcıda daha önce doğruladığın hesabı aç.</p>${pinField('pin','6 haneli giriş kodun')}<p class="error" role="alert" data-message></p><button class="primary" type="submit">Kodla giriş yap</button></form><div class="quick-actions"><button type="button" class="text-button" data-password>Şifreyle giriş yap</button><button type="button" class="text-button" data-forget>Bu cihazı unut</button></div>`;
  const form=host.querySelector('form'),message=host.querySelector('[data-message]');let busy=false;
  form.addEventListener('submit',async event=>{
   event.preventDefault();event.stopPropagation();if(busy||!form.reportValidity())return;busy=true;const button=form.querySelector('button[type=submit]');button.disabled=true;message.textContent='';
   try{await api('quick/login',{pin:form.elements.pin.value});form.reset();if(!disposed)await onSuccess();}
   catch(error){if(!disposed)message.textContent=error.message;}
   finally{form.reset();busy=false;button.disabled=false;}
  });
  host.querySelector('[data-password]').onclick=()=>{
   if(onPassword)onPassword();else{const scope=container.tagName==='FORM'?container:container;Array.from(scope.querySelectorAll('input[autocomplete="current-password"]')).find(el=>!host.contains(el))?.focus();}
  };
  host.querySelector('[data-forget]').onclick=async event=>{
   if(busy)return;busy=true;event.currentTarget.disabled=true;
   try{await api('quick/forget',{});dispose();}catch(error){message.textContent=error.message;busy=false;host.querySelector('[data-forget]').disabled=false;}
  };
 }catch{host.remove();} // Primary password remains usable if optional quick status is unavailable.
 return dispose;
}

export async function mountAccountControls(container,user){
 styles();let disposed=false;
 container.innerHTML=`<section class="card account-controls" id="account"><span class="eyebrow">HESABIM</span><h2>${esc(user.name)} · Giriş ve cihazlar</h2><p>Kendi şifreni ve bu hesaba ait güvenilir cihazlarını yönet.</p><p class="notice" role="status" data-account-message hidden></p><div class="account-settings-grid"><section><h3>Bu cihazda 6 haneli giriş</h3><p>Önce mevcut şifrenle doğrula, sonra kendi kodunu belirle. Yeni cihazlarda normal şifren gerekir. Kod 30 gün boyunca yalnızca bu tarayıcıda kullanılabilir.</p><p class="help">Ortak bilgisayarda bu özelliği açma. Çıkış yapmak kaydı kaldırmaz; kaldırmak için “Bu cihazı unut” seç.</p><form data-enroll><label>Cihaz adı<input name="label" maxlength="80" required placeholder="Örn. kişisel dizüstü bilgisayarım" autocomplete="off"></label><label>Mevcut şifren<input name="current_password" type="password" maxlength="200" autocomplete="current-password" required></label>${pinField('pin','Yeni 6 haneli kod')}${pinField('pin_confirm','Kodu tekrar gir')}<button class="primary" type="submit">Bu cihazda hızlı girişi aç</button></form></section><section><h3>Şifremi değiştir</h3><p>Şifre değişince diğer oturumların ve bütün güvenilir cihaz kayıtların kapanır. Bu cihazda açık kalırsın.</p><form data-password-change><label>Mevcut şifren<input name="current_password" type="password" maxlength="200" autocomplete="current-password" required></label><label>Yeni şifren · en az 12 karakter<input name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label><label>Yeni şifreni tekrar gir<input name="password_confirm" type="password" minlength="12" maxlength="200" autocomplete="new-password" required></label><button class="primary" type="submit">Şifremi değiştir</button></form></section></div><section><h3>Güvenilir cihazlarım</h3><p class="help">En fazla 10 cihaz kaydedebilirsin. Bir kaydı kaldırmak o cihazın kodla açtığı oturumları da kapatır.</p><div data-devices>Yükleniyor…</div><button type="button" class="text-button" data-forget-current>Bu cihazı unut</button></section></section>`;
 const message=container.querySelector('[data-account-message]'),devices=container.querySelector('[data-devices]');let busy=false;
 const show=text=>{if(disposed)return;message.textContent=text;message.hidden=false;};
 async function refresh(){const data=await api('quick/devices');if(disposed)return;devices.innerHTML=data.devices.length?'<ul class="trusted-device-list">'+data.devices.map(d=>`<li><div><strong>${esc(d.label)}${d.current?' · Bu cihaz':''}</strong><small>Son giriş: ${esc(date(d.last_used_at))}<br>Geçerli olduğu tarih: ${esc(date(d.expires_at))}</small></div><button type="button" class="secondary" data-revoke="${esc(d.id)}">${d.current?'Bu cihazı unut':'Cihazı kaldır'}</button></li>`).join('')+'</ul>':'<p>Henüz kayıtlı güvenilir cihazın yok.</p>';}
 async function perform(form,action,success){if(busy||!form.reportValidity())return;busy=true;const button=form.querySelector('button[type=submit]');button.disabled=true;try{await action();form.reset();show(success);await refresh();}catch(error){show(error.message);}finally{for(const input of form.querySelectorAll('input[type=password]'))input.value='';busy=false;button.disabled=false;}}
 container.querySelector('[data-enroll]').onsubmit=event=>{
  event.preventDefault();event.stopPropagation();const form=event.currentTarget;
  perform(form,async()=>{if(form.elements.pin.value!==form.elements.pin_confirm.value)throw Error('İki giriş kodu aynı olmalı.');await api('quick/enroll',{label:form.elements.label.value,current_password:form.elements.current_password.value,pin:form.elements.pin.value});},'Bu cihaz kaydedildi. Sonraki girişinde kendi 6 haneli kodunu kullanabilirsin.');
 };
 container.querySelector('[data-password-change]').onsubmit=event=>{
  event.preventDefault();event.stopPropagation();const form=event.currentTarget;
  perform(form,async()=>{if(form.elements.password.value!==form.elements.password_confirm.value)throw Error('İki yeni şifre aynı olmalı.');await api('password',{current_password:form.elements.current_password.value,password:form.elements.password.value});},'Şifren değişti. Diğer oturumların ve hızlı giriş kayıtların kapatıldı.');
 };
 container.addEventListener('click',async event=>{
  const button=event.target.closest('[data-revoke],[data-forget-current]');if(!button||busy)return;busy=true;button.disabled=true;
  try{await api(button.hasAttribute('data-forget-current')?'quick/forget':'quick/revoke',button.dataset.revoke?{id:button.dataset.revoke}:{});const status=await api('status');if(!status.authenticated){location.reload();return;}show('Cihaz kaydı kaldırıldı.');await refresh();}catch(error){show(error.message);}finally{busy=false;button.disabled=false;}
 });
 try{await refresh();}catch(error){show(error.message);devices.textContent='Cihazlar yüklenemedi. Sayfayı yeniden açabilirsin.';}
 return ()=>{disposed=true;container.replaceChildren();};
}
