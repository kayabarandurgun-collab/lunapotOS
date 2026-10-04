import {can,modules} from './permissions.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusNames={open:'Açık',in_progress:'Üzerinde çalışılıyor',snoozed:'Ertelendi',done:'Tamamlandı',resolved:'Kaynakta çözüldü',unavailable:'Kaynak doğrulanamadı'};
const day=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
const writableFeatures=(user,ns)=>Object.keys(modules[ns]||{}).filter(key=>key!=='amounts'&&can(user,ns,key,true));
// Bir belge hangi ekranda islenir. Fatura ekraninin kuyrugu tur bilgisini ILK dosyadan
// aldigi icin (purchase-document-ui.js kuyrugaAl) XML ve PDF AYRI gruplanir; karisik bir
// partide ilk dosya XML olsa digerleri de XML sanilirdi. Rapor ekraninin takeMany'si ise
// her dosyanin magazasini ve turunu kendi okur, bu yuzden butun raporlar TEK grupta gider:
// TY ve HB raporu bir arada birakilinca her biri dogru magazaya ayrilir.
export const INTAKE_GROUPS={'invoice:pdf':'Alış faturası','invoice:xml':'Alış faturası · UBL XML',report:'Pazaryeri raporu'};
export const intakeGroupKey=d=>d.type==='invoice'?'invoice:'+(d.format==='xml'?'xml':'pdf'):'report';
export const intakeTypeName=d=>d.type==='invoice'?'Alış faturası · '+String(d.format).toUpperCase():d.reportKind==='orders'?'Sipariş raporu':d.reportKind==='finance'?'Finans / kesinti raporu':'Rapor · türü seçilecek';

export function intakeChoices(user,ns){
 const out=[];
 if(can(user,ns,ns==='ec'?'invoices':'accounts',true)&&can(user,ns,'amounts'))out.push('invoice');
 if(ns==='ec'&&can(user,ns,'orders',true)&&can(user,ns,'amounts'))out.push('report');
 return out;
}

/** Content bytes take precedence over misleading extensions. No uploads or business writes here. */
export async function detectIntake(file,ns,user){
 if(!file||typeof file.arrayBuffer!=='function'||!file.size)throw Error('Boş dosya yüklenemez.');
 if(file.size>25*1024*1024)throw Error('Dosya 25 MB sınırını aşıyor.');
 const bytes=new Uint8Array(await file.arrayBuffer()),head=new TextDecoder().decode(bytes.subarray(0,8192)),allowed=intakeChoices(user,ns);
 let type,format,reportKind=null,ambiguous=false;
 const starts=(...values)=>values.every((n,i)=>bytes[i]===n);
 if(/^%PDF-/.test(head)){type='invoice';format='pdf';}
 else if(starts(137,80,78,71,13,10,26,10)){type='invoice';format='png';}
 else if(starts(255,216,255)){type='invoice';format='jpeg';}
 else if(starts(208,207,17,224))throw Error('Eski XLS dosyası desteklenmiyor. Excel’den XLSX veya CSV olarak kaydedin.');
 else if(/<(!doctype\s+html|html)\b/i.test(head))throw Error('Bu dosya bir web sayfası. Asıl PDF, XML, XLSX veya CSV dosyasını seçin.');
 else if(/<(?:[\w-]+:)?Invoice(?:\s|>)/i.test(head)){type='invoice';format='xml';}
 else if(/^\s*(?:<\?xml|<)/.test(head))throw Error('Bu XML bir UBL alış faturası değil. Invoice belgesini seçin.');
 else if(starts(80,75,3,4)||/\.(csv|tsv)$/i.test(file.name||'')){
  type='report';format=starts(80,75,3,4)?'xlsx':'csv';
  if(!allowed.includes(type))throw Error(ns==='lp'?'Pazaryeri raporları e-ticaret alanında yüklenir.':'Rapor yüklemek ve tutarları görmek için yetki gerekir.');
  const [{readTable},{detectReportKind}]=await Promise.all([import('./xlsx-read.js'),import('./report-core.js')]);
  const table=await readTable(bytes,{name:format==='xlsx'?'belge.xlsx':file.name});
  reportKind=detectReportKind(table.headers,[])||null;ambiguous=!reportKind;
 }else throw Error('Dosya desteklenmiyor. PDF, UBL XML, JPG, PNG, XLSX veya CSV seçin.');
 if(!allowed.includes(type))throw Error(type==='invoice'?'Alış belgesi yüklemek ve tutarları görmek için yetki gerekir.':'Bu çalışma alanında rapor yükleme yetkiniz yok.');
 if(type==='invoice'&&file.size>20*1024*1024)throw Error('Alış belgesi 20 MB sınırını aşıyor.');
 return {type,format,reportKind,ambiguous,bytes,filename:file.name,needsChoice:ambiguous||['pdf','png','jpeg'].includes(format)};
}

/** Lossless image container for the existing PDF/OCR reader; the original bytes are attached. */
export async function imageInvoicePdf(bytes,format,filename,lib){
 const kit=lib|| (await (await import('./doc-engine.js')).loadPdfKit()).lib;
 const pdf=await kit.PDFDocument.create(),epoch=new Date('2000-01-01T00:00:00Z');
 pdf.setCreationDate(epoch);pdf.setModificationDate(epoch);pdf.setProducer('Lunapot belge yükleme');pdf.setCreator('Lunapot');
 if(format==='png'){if(bytes.length<24)throw Error('PNG dosyası eksik.');const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),pixels=header.getUint32(16)*header.getUint32(20);if(!pixels||pixels>40000000)throw Error('Görüntü çok büyük. 40 megapikselden küçük bir belge seçin.');}
 const picture=await(format==='png'?pdf.embedPng(bytes):pdf.embedJpg(bytes));
 if(!Number.isFinite(picture.width)||!Number.isFinite(picture.height)||picture.width*picture.height>40000000)throw Error('Görüntü çok büyük. 40 megapikselden küçük bir belge seçin.');
 const width=595.28,height=841.89,pad=18,scale=Math.min((width-2*pad)/picture.width,(height-2*pad)/picture.height);
 const page=pdf.addPage([width,height]);
 page.drawImage(picture,{x:(width-picture.width*scale)/2,y:(height-picture.height*scale)/2,width:picture.width*scale,height:picture.height*scale});
 await pdf.attach(bytes,'original-image.'+(format==='png'?'png':'jpg'),{mimeType:format==='png'?'image/png':'image/jpeg',description:'Özgün yüklenen görüntü',creationDate:epoch,modificationDate:epoch});
 const output=await pdf.save({useObjectStreams:false});
 if(output.length>20*1024*1024)throw Error('Görüntüden oluşan PDF 20 MB sınırını aşıyor.');
 return output;
}
function abortError(){return new DOMException('İşlem iptal edildi.','AbortError');}
const ZONE_TIMEOUT='Yükleme alanı henüz hazır değil. Seçilen dosya korunuyor; mağazayı tamamlayıp yeniden deneyin.';
// heartbeat verilirse sure ILERLEME DURDUGUNDA isler: degeri her degistiginde sayac bastan
// baslar. Toplu yuklemede dort gercek rapor binlerce satirla sabit bir sureyi asiyor; bekleme
// bosa dusunce ekran "hazir degil, yeniden dene" diyordu, oysa dosyalar arkada isleniyordu.
function waitFor(root,predicate,signal,timeout=45000,{heartbeat=null,message=ZONE_TIMEOUT}={}){
 return new Promise((resolve,reject)=>{
  let timer,observer,beat=heartbeat?heartbeat():null;
  const finish=(value,error)=>{clearTimeout(timer);observer?.disconnect();signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(null,abortError());
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(null,Error(message)),timeout);};
  const check=()=>{
   if(signal?.aborted)return abort();
   if(heartbeat){const now=heartbeat();if(now!==beat){beat=now;arm();}}
   try{const value=predicate();if(value)finish(value);}catch(e){finish(null,e);}
  };
  if(signal?.aborted)return abort();
  observer=new MutationObserver(check);observer.observe(root,{childList:true,subtree:true,attributes:true,characterData:true});
  signal?.addEventListener('abort',abort,{once:true});
  arm();
  check();
 });
}
/** Uses the real uploader's existing drop listener; retaining File is essential, not a route link. */
export async function handFileToUploader(root,file,{type,signal,reportKind}={}){
 // Cocuk ekranlarin birakma alanlari [...e.dataTransfer.files] okuyor ve girisleri 'multiple';
 // bu yuzden ayni turden butun dosyalar TEK devirde gider, ekran kendi toplu akisini isletir.
 const list=Array.isArray(file)?file:[file];
 if(!list.length)throw Error('Aktarilacak dosya yok.');
 const zone=await waitFor(root,()=>{
  if(root.getAttribute('aria-busy')==='true')return null;
  return root.querySelector(type==='invoice'?'[data-pd-drop]':'[data-rb-drop]');
 },signal);
 if(signal?.aborted)throw abortError();
 const transfer=new DataTransfer();for(const one of list)transfer.items.add(one);
 zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
 // The existing source-choice form owns store and report kind validation.
 if(type==='invoice'){
  await waitFor(root,()=>{
   if(root.getAttribute('aria-busy')==='true')return null;
   const error=root.querySelector('.pd-alert.error');if(error)throw Error(error.textContent);
   return !root.querySelector('[data-pd-drop]') && (root.querySelector('[data-pd-form="document"]')||list.some(one=>root.textContent.includes(one.name)));
  },signal,90000);
 }
 if(type==='report'){
  // Coklu birakmada rapor ekrani (takeMany) dosyalari kendi okur, yukler ve uygular; ara
  // kontrol formu HIC olusmaz, sonunda dosya basina sonucu olan toplu ozet basilir. Tek
  // dosyada ise eskisi gibi ara kontrol formu beklenir. Yanlis olcute bakmak askida birakir.
  await waitFor(root,()=>{
   if(root.getAttribute('aria-busy')==='true')return null;
   if(list.length>1)return root.querySelector('[data-rb-act="toplu-kapat"]');
   const error=root.querySelector('.rb-alert.error');if(error)throw Error(error.textContent);
   return root.querySelector('[data-rb-form="source"], [data-rb-form="map"], [data-rb-act="upload"]');
  },signal,list.length>1?180000:undefined,list.length>1?{
   // Rapor ekrani her dosyada ilerleme metni basar; o metin degistigi surece beklenir.
   heartbeat:()=>root.querySelector('.rb-busy')?.textContent||'',
   message:'Rapor ekranı uzun süre ilerleme bildirmedi. Dosyalar arkada işlenmiş olabilir: «Günlük akışa dön» deyip Raporlar ekranındaki dosya listesinden sonucu kontrol et. Aynı dosyaları yeniden yüklemeden önce oraya bak.',
  }:undefined);
 }
 if(type==='report'&&reportKind&&list.length===1){
  const state=await waitFor(root,()=>{
   if(root.getAttribute('aria-busy')==='true')return null;
   return root.querySelector('[data-rb-form="source"]')||root.querySelector('[data-rb-form="map"]')||root.querySelector('[data-rb-act="upload"]')||root.querySelector('.rb-alert.error');
  },signal);
  const select=state.matches('[data-rb-form="source"]')?state.querySelector('[name="kind"]'):null;
  if(select){
   select.value=reportKind;
   const store=state.querySelector('[name="store"]');
   if(!store||store.value)state.requestSubmit();
  }
 }
 return true;
}

export function mountWorkbench(root,ns,user,mode='tasks'){
 const controller=new AbortController(),signal=controller.signal;
 let childDispose=null,childController=null,sequence=0,disposed=false,restoreFocus=null;
 const state={mode:mode==='intake'?'intake':'tasks',data:null,staff:[],busy:false,error:'',notice:'',filter:'open',query:'',feature:'',assignee:'',page:1,batch:[],embedded:false,editor:null,audit:null};
 const alive=()=>!disposed&&!signal.aborted&&root.isConnected;
 const stopChild=()=>{childController?.abort();childController=null;childDispose?.();childDispose=null;};
 const closeChild=()=>{stopChild();state.embedded=false;render();if(state.mode==='tasks')load();};
 const api=async(path,body,requestSignal=signal)=>{
  const response=await fetch('/api/'+ns+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:requestSignal===signal?signal:AbortSignal.any([signal,requestSignal])});
  let data;try{data=await response.json();}catch(error){if(error.name==='AbortError')throw error;throw Error('Sunucu yanıtı okunamadı. Yeniden deneyin.');}
  if(!response.ok)throw Object.assign(Error(data.error||'İşlem tamamlanamadı.'),{status:response.status});
  return data;
 };
 const setMessage=()=>{
  if(!alive())return;
  const alert=root.querySelector('[data-wb-message]');
  if(alert){alert.textContent=state.error||state.notice;alert.hidden=!alert.textContent;alert.setAttribute('role',state.error?'alert':'status');alert.classList.toggle('is-error',!!state.error);}
 };
 const run=async fn=>{
  if(state.busy||!alive())return;
  state.busy=true;state.error='';state.notice='';setMessage();
  root.querySelectorAll('[data-wb-busy]').forEach(x=>x.disabled=true);
  try{await fn();}catch(error){if(error.name!=='AbortError'&&alive()){state.error=error.message;if(error.status===409)state.notice='Listeyi yenileyip son sürümle devam edin.';}}
  finally{state.busy=false;if(alive()){root.querySelectorAll('[data-wb-busy],[data-wb-file]').forEach(x=>x.disabled=false);setMessage();}}
 };
 async function load(){
  const token=++sequence;
  try{
   const [data,people]=await Promise.all([api('/workbench'),writableFeatures(user,ns).length?api('/workbench/staff'):Promise.resolve({staff:[]})]);
   if(!alive()||token!==sequence)return;
   state.data=data;state.staff=people.staff;
   if(!state.embedded)render();
  }catch(error){if(error.name!=='AbortError'&&alive()&&token===sequence){state.error=error.message;if(!state.embedded)render();else setMessage();}}
 }
 const options=(values,selected)=>values.map(([value,label])=>'<option value="'+esc(value)+'" '+(value===selected?'selected':'')+'>'+esc(label)+'</option>').join('');
 function taskRows(){
  let rows=(state.data?.tasks||[]).filter(task=>{
   const status=task.effective_status;
   return (state.filter==='all'||state.filter==='open'&&!['done','resolved','snoozed'].includes(status)||state.filter==='overdue'&&task.overdue||state.filter==='mine'&&task.assignee_id===user?.id||state.filter==='closed'&&['done','resolved'].includes(status)||status===state.filter)
    &&(!state.feature||task.feature===state.feature)&&(!state.assignee||task.assignee_id===state.assignee)&&(!state.query||(task.title+' '+(task.source_label||'')+' '+task.notes).toLocaleLowerCase('tr-TR').includes(state.query.toLocaleLowerCase('tr-TR')));
  });
  const total=rows.length,maxPage=Math.max(1,Math.ceil(total/25));state.page=Math.min(state.page,maxPage);rows=rows.slice((state.page-1)*25,state.page*25);
  return '<div class="wb-task-list">'+(rows.length?rows.map(task=>'<article class="wb-task '+(task.overdue?'is-overdue':'')+'" data-wb-task="'+esc(task.task_key)+'"><div class="wb-task-copy"><div class="wb-task-meta"><span class="wb-status '+esc(task.effective_status)+'">'+esc(statusNames[task.effective_status])+'</span><span>'+esc(modules[ns]?.[task.feature]?.[0]||task.feature)+'</span></div><h3>'+esc(task.title)+'</h3>'+(task.source_label?'<p class="wb-source">'+esc(task.source_label)+'</p>':'')+'<p>'+esc(task.detail||task.notes||'Kendi eklediğin iş veya hatırlatma.')+'</p><div class="wb-task-meta"><span>'+esc(task.assignee_name||'Atanmamış')+'</span><span>'+(task.due_on?'Hedef: '+esc(task.due_on):'Tarih belirtilmedi')+'</span>'+(task.snooze_until&&task.effective_status==='snoozed'?'<span>'+esc(task.snooze_until)+' tarihine ertelendi</span>':'')+'</div></div><div class="wb-task-actions">'+(task.action?task.can_embed&&['invoice','invoice_document','invoice_upload','report_file','report_review','report_upload'].includes(task.action.type)?'<button type="button" class="primary" data-wb-action="source" data-key="'+esc(task.task_key)+'">'+esc(task.action.label)+'</button>':'<a class="secondary" href="'+esc(task.action.href)+'">'+esc(task.action.label)+'</a>':'')+(task.can_write&&!['resolved','unavailable'].includes(task.effective_status)?'<button type="button" class="secondary" data-wb-action="edit" data-key="'+esc(task.task_key)+'">Görevi düzenle</button>':'')+(task.version?'<button type="button" class="text-button" data-wb-action="audit" data-key="'+esc(task.task_key)+'">Geçmiş</button>':'')+'</div></article>').join(''):'<div class="wb-empty"><h2>Bu görünümde bekleyen iş yok</h2><p>Filtreleri değiştirebilir veya yeni bir hatırlatma ekleyebilirsin.</p></div>')+'</div><div class="wb-pager"><span>'+total+' iş · Sayfa '+state.page+' / '+maxPage+'</span><button class="secondary" type="button" data-wb-action="prev" '+(state.page<=1?'disabled':'')+'>Önceki</button><button class="secondary" type="button" data-wb-action="next" '+(state.page>=maxPage?'disabled':'')+'>Sonraki</button></div>';
 }
 function tasksView(){
  if(!state.data)return '<div class="wb-empty"><h2>'+ (state.error?'İşler yüklenemedi':'Günlük işler hazırlanıyor…')+'</h2><button class="secondary" data-wb-action="reload" type="button">Yeniden dene</button></div>';
  const all=state.data.tasks,open=all.filter(t=>!['done','resolved','snoozed'].includes(t.effective_status)).length,late=all.filter(t=>t.overdue).length,snoozed=all.filter(t=>t.effective_status==='snoozed').length;
  return '<section class="wb-summary" aria-label="İşlerin özeti">'+[['open','Açık işler',open,'sage'],['overdue','Tarihi geçen',late,'blue'],['snoozed','Ertelenen',snoozed,'lavender']].map(([filter,label,count,tone])=>'<button type="button" class="wb-summary-card '+tone+'" data-wb-filter="'+filter+'"><span>'+label+'</span><strong>'+count+'</strong><small>Listeyi göster →</small></button>').join('')+'</section><div class="wb-list-head"><div><h2>Önündeki işler</h2><p>Kaynak sorunlar, ilgili kayıt düzeldiğinde kapanır.</p></div>'+(writableFeatures(user,ns).length?'<button type="button" class="primary" data-wb-action="new">+ İş ekle</button>':'')+'</div><form class="wb-filters" data-wb-form="filters"><label>İş ara<input name="query" type="search" value="'+esc(state.query)+'" placeholder="Görev, belge veya sipariş"></label><label>Görünüm<select name="filter">'+options([['open','Açık işler'],['overdue','Tarihi geçen'],['mine','Bana atanan'],['snoozed','Ertelenen'],['closed','Tamamlanan'],['all','Tümü']],state.filter)+'</select></label><label>Bölüm<select name="feature">'+options([['','Tüm bölümler'],...state.data.features.map(f=>[f.key,f.label])],state.feature)+'</select></label><button class="secondary" type="submit">Göster</button></form>'+(state.data.limit_notice?'<p class="wb-notice">'+esc(state.data.limit_notice)+'</p>':'')+taskRows();
 }
 function intakeView(){
  const choices=intakeChoices(user,ns);
  if(!choices.length)return '<section class="wb-empty"><h2>Belge yükleme yetkisi gerekiyor</h2><p>Bu işlem için ilgili bölümde yazma ve tutarları görme yetkisi gerekir.</p></section>';
  // Parti: her dosya kendi turuyle durur. Ayni ekrana gidenler tek grupta toplanir ki
  // TY raporu + HB raporu + alis faturasi bir arada birakilsa bile her biri dogru yere gitsin.
  const items=state.batch,bekleyen=items.filter(i=>i.detection&&!i.done),gruplar=[];
  for(const it of bekleyen){const k=intakeGroupKey(it.detection),g=gruplar.find(x=>x.key===k);if(g)g.items.push(it);else gruplar.push({key:k,items:[it]});}
  const durum=i=>i.done?'Aktarıldı':i.error?i.error:i.detection?intakeTypeName(i.detection):'Tanınıyor…';
  const liste=items.length?'<ul class="wb-picked">'+items.map(i=>'<li class="'+(i.error?'is-error':i.done?'is-done':'')+'"><strong>'+esc(i.file.name)+'</strong><span>'+Math.ceil(i.file.size/1024)+' KB</span><span>'+esc(durum(i))+'</span></li>').join('')+'</ul>':'';
  const dugme=(group,choice,label)=>'<button type="button" class="primary" data-wb-action="continue" data-group="'+esc(group)+'" data-choice="'+esc(choice)+'" data-wb-busy>'+esc(label)+'</button>';
  const tek=bekleyen.length===1?bekleyen[0].detection:null;
  const buttons=gruplar.map(g=>{
   const n=g.items.length,rapor=g.key==='report';
   // Tek ve belirsiz rapor: turunu kullanici secer. Coklu raporda takeMany her dosyayi kendi tanir.
   if(rapor&&n===1&&g.items[0].detection.ambiguous)return [['orders','Sipariş raporu'],['finance','Finans / kesinti raporu']].map(([c,l])=>dugme(g.key,c,l)).join('');
   const kind=rapor?(n===1?g.items[0].detection.reportKind||'':''):'invoice';
   return dugme(g.key,kind,n>1?n+' '+(rapor?'rapor':g.key==='invoice:xml'?'UBL fatura':'fatura')+' ile devam et':rapor?'Pazaryeri raporu olarak devam et':'Alış faturası olarak devam et');
  }).join('');
  return '<div class="wb-intake-grid"><section class="wb-upload"><span class="wb-eyebrow">TEK YERDEN BAŞLA</span><h2>Belgelerini seç</h2><p>Hepsinin içeriğine bakalım; her dosya kendi türüne göre doğru işleme gider.</p><label class="wb-drop" data-wb-drop><span class="wb-upload-mark" aria-hidden="true">↑</span><strong>Dosyaları seç veya buraya bırak</strong><span>'+esc([choices.includes('invoice')?'PDF · UBL XML · JPG · PNG':'',choices.includes('report')?'XLSX · CSV':''].filter(Boolean).join(' · '))+'</span><input data-wb-file type="file" accept="'+(choices.includes('invoice')?'.pdf,.xml,.jpg,.jpeg,.png,':'')+(choices.includes('report')?'.xlsx,.csv,.tsv':'')+'" multiple aria-label="Belge dosyalarını seç" '+(state.busy?'disabled':'')+'></label>'+liste+(gruplar.length?'<div class="wb-choice"><h3>'+esc(gruplar.length>1?'Dosyalar tanındı. Her tür kendi ekranında işlenir.':tek?(tek.ambiguous?'Bu dosya hangi rapor?':tek.type==='invoice'?'Bu bir alış faturası mı?':'Pazaryeri raporu hazır'):gruplar[0].items.length+' dosya · '+INTAKE_GROUPS[gruplar[0].key])+'</h3><p>'+esc(gruplar.length>1?'Aynı anda birden çok tür bıraktın. Biriyle devam et; bitince «Günlük akışa dön» ile sıradakine geç.':tek?(tek.ambiguous?'Sütunlardan rapor türü kesin anlaşılmadı. Sipariş durumları için sipariş; komisyon, kargo ve hakediş için finans seç.':tek.type==='invoice'?'Doğrulanan ve eşleşen faturalar mevcut akışta otomatik muhasebeleşebilir ve stoğa alınabilir. Belge sana gelen alış faturasıysa devam et.':'Mağaza, sütun eşleştirmesi ve toplamlar mevcut rapor ekranında kontrol edilecek.'):'Hepsi aynı ekranda işlenir; mağaza ve sütun eşleştirmesi orada kontrol edilir.')+'</p>'+(bekleyen.some(i=>['png','jpeg'].includes(i.detection.format))?'<p>Fotoğraf, özgün görüntüsü eklenmiş bir PDF olarak mevcut OCR akışına iletilecek.</p>':'')+'<div class="wb-choice-actions">'+buttons+'</div></div>':'')+'</section><aside class="wb-intake-help"><span class="wb-eyebrow">BELGEDEN TAMAMLANAN İŞE</span><h2>Eksik kalan adım görünür olsun.</h2><ol><li><b>1</b><div><strong>Dosyanı tanıyalım</strong><p>İçeriği kontrol edilir. Emin olamadığımızda türünü sen seçersin.</p></div></li><li><b>2</b><div><strong>Mevcut kayıtla karşılaştıralım</strong><p>Belge ve ürün eşleşmesi aynı güvenli yükleme ekranında ilerler.</p></div></li><li><b>3</b><div><strong>İşini tamamla</strong><p>Kontrol bekleyen kayıtları Günlük işler bölümünde birine atayabilir, tarih verebilirsin.</p></div></li></ol>'+(ns==='ec'&&can(user,'ec','ledger',true)?'<div class="wb-intake-alt"><h3>Belgesi olmayan mal mı geldi?</h3><p>Fatura ya da irsaliye yoksa buraya bırakamazsın; mal girişini açıp yalnız gelen miktarı yaz. Faturası geldiğinde bu giriş kendiliğinden kapanır.</p><a class="secondary" href="#stock?action=unbilled">Faturasız mal girişi →</a></div>':'')+'</aside></div>';
 }
 function render(){
  if(!alive()||state.embedded)return;
  root.classList.add('workbench-root');
  root.innerHTML='<div class="wb-page"><header class="wb-heading"><div><span class="wb-eyebrow">'+(ns==='ec'?'E-TİCARET':'ÜRETİM')+'</span><h1>'+(state.mode==='intake'?'Belge yükle':'Günlük işler')+'</h1><p>'+(state.mode==='intake'?'Fatura ve raporlarını tek yerden başlat. Hepsini birlikte bırakabilirsin.':'Kontrol bekleyen kayıtlar ve ekibin yapacağı işler.')+'</p></div><nav class="wb-heading-actions" aria-label="İş akışı">'+(state.mode==='intake'||intakeChoices(user,ns).length?'<a class="secondary" href="'+(state.mode==='intake'?'#workbench':'#intake')+'">'+(state.mode==='intake'?'Günlük işler':'Belge yükle')+'</a>':'')+(state.mode==='tasks'?'<button type="button" class="secondary" data-wb-action="reload">Yenile</button>':'')+'</nav></header><p class="wb-notice" data-wb-message hidden></p><div data-wb-main>'+(state.mode==='intake'?intakeView():tasksView())+'</div><div data-wb-editor></div></div>';
  setMessage();if(state.editor)editor();if(state.audit)auditView();
 }
 function editor(){
  const host=root.querySelector('[data-wb-editor]'),t=state.editor;if(!host||!t)return;
  const create=!t.task_key,fields=state.data?.features.filter(f=>f.write)||writableFeatures(user,ns).map(key=>({key,label:modules[ns][key][0]}));
  const feature=t.feature||fields[0]?.key,staff=state.staff.filter(p=>p.features.includes(feature)),custom=create||t.source_kind==='custom';
  if(t.assignee_id&&!staff.some(p=>p.id===t.assignee_id))staff.push({id:t.assignee_id,name:t.assignee_name+' (önceki atama)'});
  host.innerHTML='<dialog class="wb-dialog" aria-labelledby="wb-edit-title"><form data-wb-form="task"><div class="wb-dialog-head"><h2 id="wb-edit-title">'+(create?'Yeni iş ekle':'Görevi düzenle')+'</h2><button type="button" class="secondary" data-wb-action="cancel-edit">Kapat</button></div>'+(custom?'<label>İşin adı<input name="title" value="'+esc(t.title||'')+'" maxlength="180" required></label>':'<h3>'+esc(t.title)+'</h3><p>Bu işin tamamlanması kaynak kaydın düzelmesine bağlıdır. Buradan yalnız takibini yönetebilirsin.</p>')+(create?'<label>Bölüm<select name="feature" data-wb-task-feature>'+options(fields.map(f=>[f.key,f.label]),feature)+'</select></label>':'')+'<div class="wb-form-grid"><label>Sorumlu<select name="assignee_id">'+options([['','Atanmamış'],...staff.map(p=>[p.id,p.name])],t.assignee_id||'')+'</select></label><label>Hedef tarih<input name="due_on" type="date" value="'+esc(t.due_on||'')+'"></label><label>Durum<select name="status">'+options([['open','Açık'],['in_progress','Üzerinde çalışılıyor'],...(custom?[['done','Tamamlandı']]:[])],t.status||'open')+'</select></label><label>Bu tarihe kadar ertele<input name="snooze_until" type="date" value="'+esc(t.snooze_until||'')+'"></label></div><label>Not<textarea name="notes" rows="3" maxlength="2000">'+esc(t.notes||'')+'</textarea></label><p role="alert" data-wb-form-error></p><div class="wb-dialog-footer"><button type="button" class="secondary" data-wb-action="cancel-edit">Vazgeç</button><button type="submit" class="primary" data-wb-busy>Kaydet</button></div></form></dialog>';
  const dialog=host.querySelector('dialog');dialog.addEventListener('cancel',()=>{state.editor=null;},{signal});dialog.showModal();
 }
 function auditView(){
  const host=root.querySelector('[data-wb-editor]');if(!host)return;
  host.innerHTML='<dialog class="wb-dialog" aria-labelledby="wb-audit-title"><div class="wb-dialog-head"><h2 id="wb-audit-title">Görev geçmişi</h2><button type="button" class="secondary" data-wb-action="cancel-edit">Kapat</button></div><ol class="wb-audit">'+state.audit.map(a=>'<li><strong>'+esc(a.actor_name)+' · Sürüm '+a.version+'</strong><p>'+esc(a.created_at)+'</p><p>'+esc(statusNames[a.snapshot?.status]||a.snapshot?.status)+' · '+esc(a.snapshot?.assignee_name||'Atanmamış')+' · '+esc(a.snapshot?.due_on||'Tarih yok')+'</p>'+(a.snapshot?.snooze_until?'<p>Ertelendi: '+esc(a.snapshot.snooze_until)+'</p>':'')+(a.snapshot?.notes?'<p>'+esc(a.snapshot.notes)+'</p>':'')+'</li>').join('')+'</ol></dialog>';
  host.querySelector('dialog').showModal();
 }
 async function chooseFiles(list){
  const picked=[...(list||[])];if(!picked.length)return;
  const files=picked.slice(0,20);
  await run(async()=>{
   state.batch=files.map(file=>({file,detection:null,error:'',done:false}));
   if(picked.length>files.length)state.notice='Tek seferde en cok 20 dosya; ilk 20 alindi.';
   render();
   // Bir dosyanin taninmamasi digerlerini DUSURMEZ: hata o satirda kalir, kalanlar islenir.
   for(const item of state.batch){
    try{item.detection=await detectIntake(item.file,ns,user);}
    catch(error){if(error.name==='AbortError')throw error;item.error=error.message;}
    if(!alive())return;
    render();
   }
   if(!state.batch.some(i=>i.detection))throw Error(state.batch[0].error||'Hicbir dosya taninamadi.');
  });
  if(alive()&&!state.embedded)render();
 }
 function beginEmbedded(title){
  stopChild();childController=new AbortController();state.embedded=true;
  const main=root.querySelector('[data-wb-main]');
  main.innerHTML='<section class="wb-embedded"><div class="wb-list-head"><h2>'+esc(title)+'</h2><button type="button" class="secondary" data-wb-action="close-source">Günlük akışa dön</button></div><p data-wb-handoff role="status"></p><div data-wb-preview></div><div data-wb-child></div></section>';
  return {host:main.querySelector('[data-wb-child]'),scope:childController.signal,hint:main.querySelector('[data-wb-handoff]')};
 }
 async function continueUpload(groupKey,choice){
  const items=state.batch.filter(i=>i.detection&&!i.done&&intakeGroupKey(i.detection)===(groupKey||intakeGroupKey(i.detection)));
  if(!items.length)return;
  const d=items[0].detection,adlar=items.map(i=>i.file.name).join(', ');
  if(!intakeChoices(user,ns).includes(d.type))throw Error('Belge yükleme yetkisi gerekiyor.');
  const {host,scope,hint}=beginEmbedded(d.type==='invoice'?'Alış belgesini kontrol et':'Pazaryeri raporunu kontrol et');
  hint.textContent='Seçilen dosya: '+adlar+'. '+(d.type==='report'?'Mağaza yoksa önce ekle; dosyan burada bekliyor.':'Belge mevcut yükleme akışına aktarılıyor.');
  try{
   const delivered=[];
   if(d.type==='invoice'){
    const {mountPurchaseDocument}=await import('./purchase-document-ui.js');
    if(scope.aborted||!alive())return;
    childDispose=mountPurchaseDocument(host,ns,{onClose:closeChild});
    // Her dosya KENDI tanisiyla donusturulur: ayni partide PDF, XML ve fotograf bir arada olabilir.
    for(const item of items){
     const file=item.file,f=item.detection;
     if(['png','jpeg'].includes(f.format)){
      const content=await imageInvoicePdf(f.bytes,f.format,file.name);
      if(scope.aborted||!alive())return;
      delivered.push(new File([content],file.name.replace(/\.[^.]+$/,'')+'.pdf',{type:'application/pdf',lastModified:0}));
     }else if(!file.name.toLowerCase().endsWith('.'+f.format))delivered.push(new File([file],file.name+'.'+f.format,{type:f.format==='xml'?'application/xml':'application/pdf',lastModified:file.lastModified}));
     else delivered.push(file);
    }
   }else{
    const {mountReports}=await import('./report-inbox-ui.js');
    if(scope.aborted||!alive())return;childDispose=mountReports(host,ns);
    for(const item of items){
     const file=item.file;
     delivered.push(item.detection.format==='xlsx'&&!/\.xlsx$/i.test(file.name)?new File([file],file.name+'.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',lastModified:file.lastModified}):file);
    }
   }
   await handFileToUploader(host,delivered,{type:d.type,signal:scope,reportKind:['orders','finance'].includes(choice)?choice:d.reportKind});
   if(scope.aborted||!alive())return;
   for(const item of items)item.done=true;
   const kalan=state.batch.filter(i=>i.detection&&!i.done).length;
   hint.textContent=adlar+' seçilen işleme aktarıldı. Sonucu aşağıda kontrol et.'+(kalan?' Bu grubu bitirince «Günlük akışa dön» ile kalan '+kalan+' dosyaya geç.':'');
  }catch(error){if(error.name==='AbortError'||scope.aborted||!alive())return;hint.textContent=error.message;hint.insertAdjacentHTML('afterend','<button type="button" class="secondary" data-wb-action="retry-handoff" data-group="'+esc(groupKey||intakeGroupKey(d))+'" data-choice="'+esc(choice)+'">Seçilen dosyayla yeniden dene</button>');throw error;}
 }
 async function openSource(task){
  if(!task?.can_embed)throw Error('Bu işlemi açmak için yazma ve tutar yetkisi gerekir.');
  if(['report_upload','invoice_upload'].includes(task.action.type)){state.mode='intake';state.notice='Yarım kalan '+task.source_label+' dosyasını yeniden seç.';render();return;}
  if(task.action.type==='invoice_document'){
   const meta=await api('/invoices/documents/'+encodeURIComponent(task.source_id));
   if(!alive())return;
   if(meta.status!=='stored'||meta.invoice_id)throw Error('Belge durumu değişti. Günlük işleri yenileyin.');
   if(!Number.isSafeInteger(meta.chunk_count)||meta.chunk_count<1||meta.chunk_count>50||meta.size_bytes>20*1024*1024)throw Error('Belge boyutu geçersiz.');
   const parts=[];
   for(let i=0;i<meta.chunk_count;i++){
    if(!alive())return;
    const part=await api('/invoices/documents/'+encodeURIComponent(task.source_id)+'/part?index='+i);
    parts.push(Uint8Array.from(atob(part.data),c=>c.charCodeAt(0)));
   }
   if(!alive())return;
   const file=new File(parts,meta.filename,{type:meta.mime|| (meta.kind==='xml'?'application/xml':'application/pdf')});
   if(file.size!==meta.size_bytes)throw Error('Belgenin saklanan parçaları eksik.');
   state.batch=[{file,detection:await detectIntake(file,ns,user),error:'',done:false}];
   if(!alive())return;
   // The same retained bytes return to the existing duplicate/reread-protected uploader.
   state.mode='intake';state.notice='Saklanan belge hazır. Devam etmeden önce türünü kontrol et.';render();return;
  }
  const {host,scope,hint}=beginEmbedded(task.title);
  hint.textContent=task.source_label||task.title;
  if(task.action.type==='invoice'){
   const {mountAccounting}=await import('./accounting-ui.js');
   if(scope.aborted||!alive())return;
   childDispose=mountAccounting(host,ns,'invoices',true);
   const form=await waitFor(host,()=>host.querySelector('[data-ac-form="invoice-filters"]'),scope);
   form.querySelector('[name="q"]').value=task.action.invoice_no;
   const submitter=form.querySelector('button[type="submit"]');form.requestSubmit(submitter);
   // The accounting form reenables its original submitter only after its busy guard clears.
   await waitFor(form,()=>!form.isConnected&&!submitter.disabled,scope);
   const button=await waitFor(host,()=>[...host.querySelectorAll('[data-ac="review-invoice"]')].find(b=>b.dataset.id===task.source_id),scope);
   if(!scope.aborted)button.click();
  }else if(task.action.type==='report_review'){
   const {mountReports}=await import('./report-inbox-ui.js');
   if(scope.aborted||!alive())return;
   childDispose=mountReports(host,ns);
   await waitFor(host,()=>host.getAttribute('aria-busy')!=='true'&&host.querySelector('[data-rb-tab="reviews"]'),scope);
   host.querySelector('[data-rb-tab="reviews"]').click();
   const button=await waitFor(host,()=>[...host.querySelectorAll('[data-rb-act="accept"]')].find(b=>b.dataset.id===task.source_id),scope);
   const row=button.closest('article');row?.classList.add('wb-highlight');row?.scrollIntoView({block:'nearest'});button.focus();
  }else if(task.action.type==='report_file'){
   const preview=await api('/reports/files/'+encodeURIComponent(task.source_id)+'/preview',undefined,scope);
   if(scope.aborted||!alive())return;
   const counts=preview.counts||{};
   host.innerHTML='<section class="wb-report-preview"><h3>'+esc(preview.file?.filename||task.source_label)+'</h3><p>Alınmış rapor, kayıtlarla karşılaştırıldı. Devam etmek mevcut rapor işleme akışını çalıştırır.</p><dl>'+Object.entries(counts).map(([key,value])=>'<div><dt>'+esc(({new:'Yeni kayıt',updated:'Değişen',same:'Aynı',older:'Eski',review:'İnceleme bekleyen'})[key]||key)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl><p>İnceleme gerektiren satırlar ayrı kalır. İşlem tamamlandığında görev kaynak durumundan kapanır.</p><button type="button" class="primary" data-wb-action="apply-report" data-key="'+esc(task.task_key)+'" data-wb-busy>Kontrol ettim, işlemeye devam et</button></section>';
  }
 }
 async function applyReport(task){
  if(!task?.can_embed||task.action?.type!=='report_file')throw Error('Rapor işlemi için yetki gerekir.');
  const scope=childController?.signal,hint=root.querySelector('[data-wb-handoff]');
  for(let page=0;page<150;page++){
   if(scope?.aborted||!alive())return;
   const result=await api('/reports/files/'+encodeURIComponent(task.source_id)+'/apply',{},scope);
   if(scope?.aborted||!alive())return;
   if(hint)hint.textContent='İşlenen satır: '+(result.applied_row??'—')+' / '+(result.row_count??'—');
   if(result.done){state.notice='Rapor işlendi. İnceleme bekleyen satırlar ayrı görevlerde görünür.';closeChild();return;}
  }
  throw Error('Bu tur tamamlandı; çok büyük rapor için İşlemeye devam et ile kaldığın yerden sürdürebilirsin.');
 }
 function closeEditor(){
  state.editor=null;state.audit=null;root.querySelector('[data-wb-editor]')?.replaceChildren();restoreFocus?.focus?.();restoreFocus=null;
 }
 root.addEventListener('click',event=>{
  const navigation=event.target.closest('.wb-heading-actions a');
  if(navigation&&navigation.getAttribute('href')===location.hash.split('?')[0]){
   event.preventDefault();stopChild();state.embedded=false;state.mode=navigation.getAttribute('href')==='#intake'?'intake':'tasks';state.editor=null;state.audit=null;state.error='';render();if(state.mode==='tasks')load();return;
  }
  const button=event.target.closest('[data-wb-action],[data-wb-filter]');if(!button||!root.contains(button))return;
  if(button.dataset.wbFilter){state.filter=button.dataset.wbFilter;state.page=1;render();return;}
  const action=button.dataset.wbAction,task=state.data?.tasks.find(t=>t.task_key===button.dataset.key);
  if(action==='reload'){state.error='';run(load);}
  if(action==='new'||action==='edit'){restoreFocus=button;state.editor=action==='new'?{}:task;editor();}
  if(action==='cancel-edit')closeEditor();
  if(action==='audit')run(async()=>{const data=await api('/workbench/tasks/'+encodeURIComponent(task.task_key)+'/audit');if(!alive())return;restoreFocus=button;state.audit=data.audit;auditView();});
  if(action==='prev'||action==='next'){state.page+=action==='prev'?-1:1;render();}
  if(action==='source')run(()=>openSource(task));
  if(action==='close-source')closeChild();
  if(action==='continue'||action==='retry-handoff')run(()=>continueUpload(button.dataset.group,button.dataset.choice));
  if(action==='apply-report')run(()=>applyReport(task));
 },{signal});
 root.addEventListener('change',event=>{
  if(event.target.matches('[data-wb-file]'))chooseFiles(event.target.files);
  if(event.target.matches('[data-wb-task-feature]')){
   const form=event.target.form,selected=form.querySelector('[name="assignee_id"]'),people=state.staff.filter(p=>p.features.includes(event.target.value));
   selected.innerHTML=options([['','Atanmamış'],...people.map(p=>[p.id,p.name])],people.some(p=>p.id===selected.value)?selected.value:'');
  }
 },{signal});
 root.addEventListener('submit',event=>{
  const form=event.target.closest('[data-wb-form]');if(!form)return;event.preventDefault();
  if(form.dataset.wbForm==='filters'){Object.assign(state,Object.fromEntries(new FormData(form)),{page:1});render();return;}
  if(form.dataset.wbForm==='task'&&!state.busy)run(async()=>{
   const t=state.editor;if(!t)return;
   const values=Object.fromEntries(new FormData(form)),input={...values,version:t.version||0,assignee_id:values.assignee_id||null,due_on:values.due_on||null,snooze_until:values.snooze_until||null};
   if(t.task_key&&input.assignee_id===t.assignee_id)delete input.assignee_id;
   try{await api('/workbench/tasks'+(t.task_key?'/'+encodeURIComponent(t.task_key):''),input);if(!alive())return;closeEditor();state.notice='Görev kaydedildi.';await load();}
   catch(error){if(alive())form.querySelector('[data-wb-form-error]').textContent=error.message;throw error;}
  });
 },{signal});
 root.addEventListener('dragover',event=>{if(event.target.closest('[data-wb-drop]'))event.preventDefault();},{signal});
 root.addEventListener('drop',event=>{if(!event.target.closest('[data-wb-drop]'))return;event.preventDefault();chooseFiles(event.dataTransfer.files);},{signal});
 const dispose=()=>{if(disposed)return;disposed=true;++sequence;stopChild();controller.abort();root.querySelector('dialog')?.close();root.classList.remove('workbench-root');state.batch=[];};
 dispose.onHash=()=>{
  const route=location.hash.split('?')[0],next=route==='#intake'?'intake':route==='#workbench'?'tasks':null;
  if(!next||!alive()||next===state.mode)return;stopChild();state.embedded=false;state.mode=next;state.editor=null;state.audit=null;state.error='';render();if(next==='tasks')load();
 };
 render();if(state.mode==='tasks')load();
 return dispose;
}
