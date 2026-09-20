// One generation owns the visible root and its cleanup, including failed/deferred imports.
const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function createRouteLoader(){
 let generation=0,active=null;
 function begin(){
  const revision=++generation,previous=active;active=null;
  previous?.dispose?.();
  const isCurrent=root=>revision===generation&&root.isConnected;
  async function mount(root,load,attach,{label='Ekran',statusRoot=root}={}){
   if(!isCurrent(root))return;
   statusRoot.innerHTML='<section class="card pad" data-route-loading role="status"><p>'+escapeHTML(label)+' yükleniyor…</p></section>';
   statusRoot.setAttribute('aria-busy','true');
   try{
    const module=await load();
    if(!isCurrent(root))return;
    statusRoot.removeAttribute('aria-busy');
    const dispose=attach(module);
    // A mount may synchronously trigger navigation; it must not capture the next view's cleanup.
    if(!isCurrent(root)){if(typeof dispose==='function')dispose();return;}
    active={root,dispose};
   }catch(error){
    if(!isCurrent(root))return;
    statusRoot.removeAttribute('aria-busy');
    statusRoot.innerHTML='<section class="card pad" data-route-error><h2>'+escapeHTML(label)+' yüklenemedi</h2><p role="alert">'+(navigator.onLine?'Ekran şu anda açılamıyor. Bağlantınızı kontrol edip yeniden deneyin.':'İnternet bağlantısı yok. Bağlantınızı kontrol edip yeniden deneyin.')+'</p><button type="button" class="primary" data-route-retry>Yeniden dene</button></section>';
    // Native ESM caches failed module jobs (including dependencies). Reload the same URL to retry them.
    statusRoot.querySelector('[data-route-retry]').addEventListener('click',()=>{if(isCurrent(root))location.reload();},{once:true});
   }
  }
  return {isCurrent,mount};
 }
 function onHash(){
  if(!active?.root.isConnected||typeof active.dispose?.onHash!=='function')return false;
  active.dispose.onHash();return true;
 }
 return {begin,onHash};
}

// Session ownership is separate from route ownership: an authenticated refresh may change routes.
export function createSessionOwner(){
 let generation=0,controller=new AbortController();
 const capture=()=>{
  const revision=generation,signal=controller.signal;
  const isCurrent=()=>revision===generation&&!signal.aborted;
  const check=()=>{if(!isCurrent())throw new DOMException('Oturum değişti.','AbortError');};
  return {signal,isCurrent,check};
 };
 return {capture,begin(){++generation;controller.abort();controller=new AbortController();return capture();}};
}
