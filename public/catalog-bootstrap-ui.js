import {importCatalog} from './catalog-seed-import.js';
export function openCatalogBootstrap(api,onDone){
 const dialog=document.createElement('dialog');dialog.className='catalog-bootstrap';
 dialog.innerHTML='<form method="dialog"><button class="text-button" aria-label="Kapat">✕</button></form><h2>Hazır ürün kataloğu</h2><p>Tekli ambalaj kartları açılır. Çoklu paket ve set ilanları bu kartlara bağlanır. Başlangıç stok miktarı değiştirilmez.</p><label>Hazırlanmış katalog dosyası<input type="file" accept=".json,application/json" data-file></label><label class="catalog-option"><input type="checkbox" data-allocation> Karma set gelirini fiziksel adet oranında dağıt. Bu, ürün bazında yaklaşık bir yönetim dağılımıdır; gerçek tekli satış fiyatı değildir.</label><div role="status" data-summary>Dosya seçilmesini bekliyor.</div><details><summary>Ürünler ve bekleyen eşleştirmeler</summary><div data-detail></div></details><p role="alert" data-error></p><div class="product-actions"><button class="secondary" data-preview>Kontrol et</button><button class="primary" data-apply disabled>Kataloğu uygula</button></div>';
 document.body.append(dialog);dialog.showModal();
 let plan=null,busy=false,ready=false;const $=s=>dialog.querySelector(s);
 const close=()=>{if(!busy){dialog.remove();onDone?.();}};dialog.addEventListener('close',close);dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 const options=()=>({acceptEstimatedRevenueAllocation:$('[data-allocation]').checked});
 function show(report){
  $('[data-summary]').textContent=(report.dryRun?'Ön kontrol: ':'Kaydedildi: ')+report.productsCreated.length+' yeni kart, '+report.productsReused.length+' mevcut kart, '+report.mappingsCreated.length+' yeni ilan bağlantısı, '+report.mappingsReused.length+' mevcut bağlantı, '+report.familiesCreated.length+' yeni çeşit ailesi, '+report.pending.length+' bekleyen, '+report.conflicts.length+' çakışma.';
  const detail=$('[data-detail]');detail.replaceChildren();
  for(const p of plan.products){const line=document.createElement('p');line.textContent=p.name+' · '+p.sku+' · adet';detail.append(line);}
  for(const p of [...report.pending,...report.conflicts]){const line=document.createElement('p');line.textContent='Kontrol: '+(p.sku||p.external_code||p.name||'')+' — '+(p.reason||'');detail.append(line);}
 }
 async function run(dryRun){
  if(busy)return;busy=true;$('[data-error]').textContent='';dialog.querySelectorAll('button,input').forEach(x=>x.disabled=true);
  try{if(!plan)throw Error('Önce katalog JSON dosyasını seçin.');const report=await importCatalog(plan,api,{dryRun,...options()});show(report);ready=dryRun&&report.conflicts.length===0;if(!dryRun)ready=false;}
  catch(e){ready=false;$('[data-error]').textContent=e.message+' Daha önce kaydedilen kartlar korunur; yeniden kontrol edip devam edebilirsiniz.';}
  finally{busy=false;dialog.querySelectorAll('button,input').forEach(x=>x.disabled=false);$('[data-apply]').disabled=!ready;}
 }
 $('[data-file]').addEventListener('change',async e=>{ready=false;$('[data-apply]').disabled=true;plan=null;try{const f=e.target.files[0];if(!f)return;if(f.size>2000000)throw Error('Katalog dosyası 2 MB’tan küçük olmalı.');plan=JSON.parse(await f.text());await run(true);}catch(e){$('[data-error]').textContent=e.message;}});
 $('[data-allocation]').addEventListener('change',()=>{ready=false;$('[data-apply]').disabled=true;$('[data-summary]').textContent='Dağıtım seçimi değişti. Yeniden kontrol edin.';});
 $('[data-preview]').addEventListener('click',()=>run(true));$('[data-apply]').addEventListener('click',()=>{if(ready)run(false);});
 return ()=>{dialog.remove();};
}
