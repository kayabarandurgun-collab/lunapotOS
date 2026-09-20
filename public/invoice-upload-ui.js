import {can} from './permissions.js';

export const invoiceReadOnlyHelp='Bu hesap yalnızca faturaları görüntüleyebilir. PDF, XML veya hazır kayıt yüklemek ve elle fatura girmek için işlem yapma yetkisi gerekir. Kayıtlı faturaları İncele ile açabilirsin.';
export const canUploadInvoice=(user,namespace)=>can(user,namespace,namespace==='ec'?'invoices':'accounts',true);
export function invoiceImportActions(user,namespace){
 const readonly=!canUploadInvoice(user,namespace),extra=readonly?' disabled aria-describedby="invoice-readonly-help" title="Bu hesap yalnızca faturaları görüntüleyebilir."':'';
 return '<button class="primary" type="button" data-ac="purchase-document"'+extra+'>PDF fatura yükle</button>'+
  (namespace==='ec'?'<button class="secondary" type="button" data-ac="staged-import"'+extra+'>Hazır kayıt dosyası yükle</button>':'')+
  '<button class="secondary" type="button" data-ac="invoice"'+extra+'>+ Fatura gir</button><label class="secondary ac-file">UBL XML içe aktar<input type="file" accept=".xml,application/xml,text/xml" id="ac-xml"'+extra+'></label>';
}
// Keep document parsing out of the initial route; read-only users never mount an upload form.
export function mountInvoiceUpload(root,namespace,{user,onClose,signal}={}){
 const controller=new AbortController();let disposeDocument=null;
 const dispose=()=>{controller.abort();disposeDocument?.();signal?.removeEventListener('abort',dispose);};
 signal?.addEventListener('abort',dispose,{once:true});
 const back=()=>{dispose();onClose?.();};
 if(signal?.aborted){dispose();return dispose;}
 if(!canUploadInvoice(user,namespace)){
  root.innerHTML='<section class="card pad"><h2>Faturalar yalnızca görüntülenebilir</h2><p>'+invoiceReadOnlyHelp+'</p><button class="secondary" type="button" data-upload-back>Faturalara dön</button></section>';
  root.querySelector('[data-upload-back]').addEventListener('click',back,{signal:controller.signal});return dispose;
 }
 async function load(){
  root.innerHTML='<p class="loading" role="status">Fatura yükleme alanı açılıyor…</p>';
  try{
   const {mountPurchaseDocument}=await import('./purchase-document-ui.js');
   if(controller.signal.aborted||!root.isConnected)return;
   disposeDocument=mountPurchaseDocument(root,namespace,{onClose:result=>{dispose();onClose?.(result);}});
  }catch(error){
   if(controller.signal.aborted||!root.isConnected)return;
   root.innerHTML='<section class="card pad"><h2>Yükleme alanı açılamadı</h2><p role="alert">Bağlantını kontrol et. Sayfayı yeniledikten sonra Faturalar bölümünden PDF fatura yükle seçeneğini tekrar açabilirsin.</p><button class="secondary" type="button" data-upload-retry>Sayfayı yenile</button> <button class="secondary" type="button" data-upload-back>Faturalara dön</button></section>';
   // Failed native ESM jobs (including dependencies) persist for this document.
   // Reload the current route; another import of the same URL cannot recover them.
   root.querySelector('[data-upload-retry]').addEventListener('click',()=>{
    if(controller.signal.aborted||!root.isConnected)return;
    dispose();location.reload();
   },{once:true,signal:controller.signal});
   root.querySelector('[data-upload-back]').addEventListener('click',back,{signal:controller.signal});
  }
 }
 load();return dispose;
}
