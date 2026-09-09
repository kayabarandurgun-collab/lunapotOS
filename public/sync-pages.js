// Sequential, resumable pull. A completed source page may still have draft work
// deferred by the server's per-request budget, so drain that page first.
export async function pullSourcePages({requestPage,startPage=0,allPages=true,signal,onProgress=()=>{},maxRequests=100}){
 if(!Number.isInteger(startPage)||startPage<0||startPage>10000)throw Error('Başlangıç sayfası geçersiz.');
 let page=startPage,pages=0,records=0,created=0,requests=0,counted=false;
 const warnings=new Set();
 const snapshot=(status,error='')=>({status,page,pages,records,created,requests,warnings:[...warnings],error});
 while(requests<maxRequests){
  if(signal?.aborted)return snapshot('paused');
  onProgress(snapshot('running'));
  let r;
  try{r=await requestPage(page,signal);}catch(error){return snapshot(signal?.aborted?'paused':'error',signal?.aborted?'':error.message);}
  requests++;
  if(!r||r.page!==page||typeof r.hasMore!=='boolean'||!Array.isArray(r.records)||!Number.isInteger(r.next_page)||r.next_page!==page+1)return snapshot('error','Kaynak sayfa sırası doğrulanamadı.');
  if(!counted){records+=r.records.length;counted=true;}
  created+=r.orders?.created||0;
  if(r.orderImportWarning)return snapshot('error',r.orderImportWarning);
  if(r.deferredOrders>0){
   if(!(r.orders?.created>0))return snapshot('error','Bu sayfadaki sipariş taslaklarında ilerleme olmadı. Kaynak kayıtlarını inceleyin.');
   continue;
  }
  for(const warning of r.warnings||[])warnings.add(warning);
  pages++;page=r.next_page;counted=false;
  if(!r.hasMore)return snapshot('complete');
  if(!allPages)return snapshot('paused');
 }
 return snapshot('paused','Bir işlemdeki veri alma sınırına ulaşıldı. Kaldığın yerden devam edebilirsin.');
}
