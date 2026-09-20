import {parseDateRange,dateRangeQuery,dateRangeLink,dateRangeLabel,dateFilterMarkup,bindDateFilter} from './date-range.js';
import {renderIntegrationGuide} from './integration-guide.js';
import {mountPanorama} from './panorama-ui.js';
import {pullSourcePages} from './sync-pages.js';
import {attentionItems} from './attention-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>n==null?'Bilgi bekleniyor':new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(n/100);
const date=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
const names={trendyol:'Trendyol',hepsiburada:'Hepsiburada',edm:'EDM'};
const kinds={orders:'Siparişler',sale:'Satış finans kayıtları',return:'İade finans kayıtları',deductions:'Kesinti faturaları',payments:'Hakediş kayıtları',finance:'Muhasebe hareketleri',commissions:'Güncel komisyon bilgisi'};
const field=(label,name,value='',type='text',extra='')=>type==='hidden'?'<input type="hidden" name="'+esc(name)+'" value="'+esc(value)+'">':'<label>'+esc(label)+'<input name="'+name+'" type="'+type+'" value="'+esc(value)+'" '+extra+'></label>';
const select=(label,name,values)=>'<label>'+esc(label)+'<select name="'+name+'">'+values.map(([v,t])=>'<option value="'+esc(v)+'">'+esc(t)+'</option>').join('')+'</select></label>';
const link=(href,title,desc)=>'<a class="step" href="'+href+'"><span class="step-number">→</span><div><strong>'+title+'</strong><p>'+desc+'</p></div></a>';
const heading=(title,sub)=>'<div class="page-heading"><div><span class="eyebrow">ÇALIŞMA ALANI · YÖNETİM</span><h1>'+title+'</h1><p>'+sub+'</p></div></div>';
const table=(heads,rows)=>rows.length?'<div class="table-wrap insights-table"><table><thead><tr>'+heads.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map((x,i)=>'<td data-label="'+esc(heads[i])+'">'+x+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<div class="empty"><h3>Henüz kayıt yok</h3><p>Bağlantıdan alınan kayıtlar burada görünecek.</p></div>';
function download(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
// Overview owns its stable work node; panorama only borrows it while displaying a period.
// Each source settles independently. A failed read must never become a zero or an empty task list.
function mountOverview(root,api,signal){
 const sources={
  summary:{path:'',label:'Stok ve kesinti bilgisi'},
  connections:{path:'/connections',label:'Bağlantı durumu'},
  settings:{path:'/settings',label:'Şirket bilgileri'},
  attention:{path:'/attention',label:'Günlük iş kayıtları'}
 };
 const viewState={};let periodAbort,periodDispose,dateDispose,periodRevision=0,rangeKey='',disposed=false;
 const active=()=>!disposed&&!signal.aborted;
 const errorMessage=error=>error.message==='Failed to fetch'?'Sunucuya ulaşılamadı. Bağlantını kontrol edip yeniden dene.':error.message;
 const range=()=>parseDateRange(location.hash);
 root.setAttribute('aria-busy','false');
 root.innerHTML='<div class="page-heading overview-heading"><div><span class="eyebrow">E-TİCARET · GENEL DURUM</span><h1>İşinin özeti</h1><p>Satış, kâr ve bekleyen işler. Tutarlar KDV dahil.</p></div><div class="ac-actions"><a class="secondary" data-overview-orders>Siparişleri gör</a><a class="primary" href="#reports">Rapor yükle <span aria-hidden="true">↗</span></a></div></div><section class="panorama" data-panorama aria-label="Dönem özeti"></section><section class="attention-center" aria-label="Bugünün iş listesi"></section><section class="pn-quick" aria-label="Hızlı geçiş"><a class="pn-card" href="#pricing"><span class="pn-quick-icon" aria-hidden="true">₺</span><div><strong>Kaça satmalıyım?</strong><small>Tekli ürün, çoklu paket veya set için satış fiyatını değerlendir</small></div></a><a class="pn-card" href="#stock?filter=low"><span class="pn-quick-icon" aria-hidden="true">▤</span><div data-overview-stock></div></a><a class="pn-card" href="#reports"><span class="pn-quick-icon" aria-hidden="true">⇪</span><div><strong>Rapor Kutusu</strong><small>Trendyol / Hepsiburada dosyasını bırak; sipariş, kesinti ve iade kendiliğinden işlenir</small></div></a></section><div data-overview-setup></div><div class="notice subtle">Bu alanın carileri, stokları ve raporları Lunapot üretim panelinden ayrıdır. Rakamlar yalnızca kaydedilmiş işlemleri içerir; henüz bağlanmamış mağaza satışları dahil değildir.</div>';
 const section=root.querySelector('[data-panorama]'),dailyWork=root.querySelector('.attention-center');
 const unavailable=(key)=>{const source=sources[key];return source.data?'':source.error?'<p class="notice" role="alert" data-overview-unavailable="'+key+'"><strong>'+source.label+' alınamadı.</strong> '+esc(source.error)+' <button type="button" class="secondary" data-overview-retry="'+key+'">'+source.label+' için yeniden dene</button></p>':'<p class="loading" role="status" data-overview-loading="'+key+'">'+source.label+' yükleniyor…</p>';};
 function renderAux(){
  if(!active())return;
  const ac=sources.summary.data,connections=sources.connections.data,settings=sources.settings.data,attention=sources.attention.data;
  const complete=Object.values(sources).every(s=>s.data),extraOpen=dailyWork.querySelector('.ins-attention-extra')?.open;
  // The shared helper needs metadata objects. Suppress its metadata items when their source
  // is unavailable, and explicitly list those missing checks below instead of inferring status.
  const items=attention?attentionItems(attention,connections||{providers:[]},settings?.settings||{},ac?.pending_fee_cents??null).filter(item=>settings||item.href!=='#settings'):[];
  const itemMarkup=item=>'<a class="attention-item '+item.tone+'" href="'+esc(item.href)+'"><span class="attention-count">'+item.count+'</span><div><strong>'+esc(item.title)+'</strong><p>'+esc(item.detail)+'</p></div><span aria-hidden="true">↗</span></a>';
  dailyWork.innerHTML='<div class="attention-heading"><div><span class="eyebrow">ÖNCE BUNLARA BAK</span><h2>Bugünün iş listesi</h2><p>Tüm kayıtlardaki açık işler'+(attention?' · '+esc(attention.as_of):'')+' · Aynı paket birden fazla başlıkta görünebilir.</p></div><span class="v2-badge '+(complete&&!items.length?'success':'warning')+'">'+(attention?items.length+(complete?' başlık':' bilinen başlık · kapsam eksik'):sources.attention.error?'İş listesi alınamadı':'İş listesi yükleniyor')+'</span></div>'+
   Object.keys(sources).map(unavailable).join('')+
   (attention?'<div class="attention-grid">'+(items.length?(items.length>3?items.slice(0,2):items).map(itemMarkup).join(''):'<p class="help">'+(complete?'Kontrol edilen kayıtlarda bekleyen iş bulunmadı. Mağaza aktarımının ve fiziksel stok hareketlerinin eksiksiz olması gerekir.':'Alınabilen kayıtlarda iş bulunmadı; alınamayan kontrollerin durumu bilinmiyor.')+'</p>')+'</div>':'')+
   (items.length>3?'<details class="ins-attention-extra" '+(extraOpen?'open':'')+'><summary>Diğer '+(items.length-2)+' kontrolü göster</summary><div class="attention-grid">'+items.slice(2).map(itemMarkup).join('')+'</div></details>':'');
  const low=ac?.stock.filter(p=>p.quantity_milli-(p.reserved_milli||0)<=p.min_stock_milli),available=ac?.stock.filter(p=>p.quantity_milli-(p.reserved_milli||0)>0).length;
  root.querySelector('[data-overview-stock]').innerHTML=ac?'<strong>'+low.length+' kritik / tükenen ürün</strong><small>'+(low.length?esc(low.slice(0,2).map(p=>p.name).join(', '))+(low.length>2?' ve '+(low.length-2)+' ürün daha':''):ac.stock.length+' ürün kartı · '+available+' üründe satılabilir stok')+'</small>':'<strong>Stok bilgisi '+(sources.summary.error?'alınamadı':'yükleniyor')+'</strong><small>Kritik stok sayısı ve satılabilir ürün bilgisi henüz bilinmiyor.</small>';
  const setup=root.querySelector('[data-overview-setup]'),setupOpen=setup.querySelector('details')?.open;
  const setupKnown=ac&&settings&&connections,setupDone=settings?.settings.tax_id&&ac?.stock.length;
  const configured=connections?.providers.filter(p=>p.configured).length;
  const steps=setupKnown?[!!settings.settings.tax_id,ac.stock.length>0,available>0,configured>0].filter(Boolean).length:null;
  setup.innerHTML=setupKnown&&setupDone?'':'<div class="dashboard-grid"><details class="card setup-guide" '+(setupOpen?'open':'')+'><summary class="card-heading"><h2>İşe başlamak için</h2><span class="pill">'+(steps===null?'Kurulum durumu eksik':steps+'/4 başlangıç adımı')+'</span></summary>'+
   link('#settings','Şirketini tanımla',settings?(settings.settings.tax_id?'Alış faturalarının alıcısı doğrulanıyor.':'Unvan ve vergi numarası faturaların doğru alana gelmesini sağlar.'):'Şirket bilgisi alınamadı; kurulum durumu bilinmiyor.')+
   link('#stock','Ürünlerini ve açılış stoğunu ekle',ac?ac.stock.length+' ürün · '+available+' üründe kullanılabilir stok var.':'Stok bilgisi alınamadı; ürün ve stok sayısı bilinmiyor.')+
   link('#pricing','Maliyet ve tarifelerini belirle','Paket ölçüsü, kargo ve komisyonla satıştan önce kârını gör.')+
   link('#integrations','Satış kanallarını bağla',connections?configured+' bağlantıda erişim bilgisi tanımlı.':'Bağlantı bilgisi alınamadı; kanalların durumu bilinmiyor.')+'</details></div>';
 }
 async function loadAux(key){
  const source=sources[key];if(!active()||source.loading)return;
  source.loading=true;source.error=null;renderAux();
  try{const data=await api(source.path);if(active())source.data=data;}
  catch(error){if(active()&&error.name!=='AbortError')source.error=errorMessage(error);}
  finally{source.loading=false;if(active())renderAux();}
 }
 const changeRange=next=>{if(active())location.hash=dateRangeLink(location.hash||'#overview',next);};
 function periodFallback(selected,error){
  const open=viewState.disclosures?.['ins-date-disclosure']??(selected.preset==='custom'||!!selected.error);
  section.innerHTML='<details class="ins-date-disclosure" '+(open?'open':'')+'><summary>Tarih <span>'+esc(dateRangeLabel(selected))+'</span></summary>'+dateFilterMarkup(selected)+'</details>'+(error?'<div class="notice" role="alert"><strong>Dönem özeti alınamadı.</strong> '+esc(errorMessage(error))+' <button type="button" class="secondary" data-overview-retry="panorama">Dönem özeti için yeniden dene</button> <a href="'+esc(dateRangeLink('#performance',{...selected,error:null}))+'">Satış ve kârı aç →</a></div>':'<p class="loading" role="status">Ciro, nakit ve dönem özeti hesaplanıyor…</p>');
  const unbind=bindDateFilter(section,{signal,onChange:changeRange});
  dateDispose=()=>{const details=section.querySelector('.ins-date-disclosure');if(details){viewState.disclosures??={};viewState.disclosures['ins-date-disclosure']=details.open;}unbind();};
 }
 async function loadPeriod(force=false){
  if(!active())return;
  const selected=range(),query=dateRangeQuery({...selected,error:null}),key=JSON.stringify(selected);
  if(!force&&rangeKey===key)return;rangeKey=key;
  const revision=++periodRevision;
  periodAbort?.abort();periodDispose?.();periodDispose=null;dateDispose?.();dateDispose=null;
  // Detach the borrowed node before replacing panorama's markup, preserving its disclosures.
  section.after(dailyWork);
  periodAbort=new AbortController();
  const requestSignal=AbortSignal.any([signal,periodAbort.signal]);
  root.querySelector('[data-overview-orders]').href=dateRangeLink('#orders',{...selected,error:null});
  section.setAttribute('aria-busy','true');periodFallback(selected);
  try{
   const data=await api('/panorama'+(query?'?'+query:''),undefined,requestSignal);
   if(!active()||revision!==periodRevision)return;
   dateDispose?.();dateDispose=null;
   periodDispose=mountPanorama(section,data,{signal,dailyWork,viewState,onRangeChange:changeRange});
  }catch(error){
   if(!active()||revision!==periodRevision||error.name==='AbortError')return;
   section.after(dailyWork);dateDispose?.();dateDispose=null;periodFallback(selected,error);
  }finally{if(active()&&revision===periodRevision)section.setAttribute('aria-busy','false');}
 }
 const retry=event=>{const button=event.target.closest('[data-overview-retry]');if(!button||!active())return;const key=button.dataset.overviewRetry;if(key==='panorama')void loadPeriod(true);else if(sources[key])void loadAux(key);};
 root.addEventListener('click',retry,{signal});
 const dispose=()=>{disposed=true;periodRevision++;periodAbort?.abort();periodDispose?.();dateDispose?.();root.removeEventListener('click',retry);};
 dispose.onHash=()=>{void loadPeriod();};
 renderAux();void loadPeriod();for(const key of Object.keys(sources))void loadAux(key);
 return dispose;
}

export function mountOperations(root,namespace,view){
 root.classList.add('insights-operations');
 const abort=new AbortController(),$=s=>root.querySelector(s);let state=null,busy=false,recordPage=0,recordProvider='',recordKind='',syncAbort=null,resumeSync=null;
 const api=async(path,body,requestSignal=abort.signal)=>{const r=await fetch('/api/'+namespace+path,{signal:requestSignal,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});let x;try{x=await r.json();}catch{throw Error('Sunucuya ulaşılamadı.');}if(!r.ok)throw Error(x.error||'İşlem tamamlanamadı.');return x;};
 if(view==='overview'){const stop=mountOverview(root,api,abort.signal);const dispose=()=>{abort.abort();stop();root.classList.remove('insights-operations');root.removeAttribute('aria-busy');};dispose.onHash=stop.onHash;return dispose;}
 const notice=m=>{const box=$('#op-error');if(box){box.hidden=false;box.textContent=m;}};
 const close=()=>{$('dialog')?.close();$('dialog')?.remove();};
 function dialog(title,action,body){close();root.insertAdjacentHTML('beforeend','<dialog class="ins-dialog" aria-labelledby="op-dialog-title"><form data-op-form="'+action+'"><div class="dialog-heading"><h2 id="op-dialog-title">'+title+'</h2><button class="icon-button" type="button" data-op="close" aria-label="Kapat">×</button></div><div class="form-body">'+body+'<p class="error" id="op-form-error" role="alert"></p></div><div class="dialog-footer"><button class="secondary" type="button" data-op="close">Vazgeç</button><button class="primary" type="submit">Devam et</button></div></form></dialog>');$('dialog').showModal();}
 async function load(){
  root.setAttribute('aria-busy','true');
  root.innerHTML='<p class="loading" role="status">Çalışma alanı hazırlanıyor…</p>';
  if(view==='settings'){
   state=await api('/settings');if(abort.signal.aborted)return;
   root.innerHTML=heading('Şirket ve yedek','Bu bilgiler yalnızca '+(namespace==='ec'?'E-Ticaret':'Lunapot')+' çalışma alanına aittir.')+'<div id="op-error" class="notice" hidden></div><div class="v2-grid cols-2"><section class="card"><div class="card-heading"><h2>Faturaların doğru adresi</h2></div><form data-op-form="settings" class="form-body">'+field('Ticari unvan','legal_name',state.settings.legal_name,'text','maxlength="200" required')+field('VKN / TCKN','tax_id',state.settings.tax_id,'text','pattern="[0-9]{10,11}" required inputmode="numeric"')+field('Stok başlangıç tarihi','inventory_start_date',state.settings.inventory_start_date||'','date','max="'+new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'})+'"')+'<p class="help">Bu tarihten <b>önceki</b> pazaryeri siparişleri bugünkü stoktan otomatik düşülmez; raporda kalır ve ayrıca incelenir. Tarihi tahmin etme; gerçek sayım gününü yaz. Boş bırakırsan geçmiş siparişler stoğa hiç uygulanmaz. Açılış miktarlarını <a href="#stock">Ürünler ve stok</a> ekranındaki “Stok / sayım gir” ile kaydet.</p>'+'<p class="help">İki işletme aynı şirkete aitse aynı vergi numarası kullanılabilir. Defterler yine ayrı kalır; aynı fatura ikinci kez işlenmez.</p>'
     // Eksi stok BEYANLA acilir. Ayar API'de vardi ama ekranda yoktu: kullanici alis faturasi
     // gecikince satisini kaydedemiyor, sebebini de goremiyordu. Miktar eksiye duser, stok
     // DEGERI hicbir durumda eksiye dusmez.
     +'<label class="op-check"><input type="checkbox" name="allow_negative_stock" '+(state.settings.allow_negative_stock?'checked':'')+'> Stok eksiye düşebilsin</label>'
     +'<p class="help">Alış faturası henüz girilmemiş bir maldan satış yaptıysan, kapalıyken o satışı kaydedemezsin. Açarsan kayıt geçer ve <b>eksi bakiye</b> görünür: bu, eksik alış belgesini gizlemez, tam tersine ekranda tutar. Stok <b>değeri</b> her durumda eksiye düşmez. Belgeyi girince bakiye kendiliğinden düzelir.</p>'
     +'<button class="primary" type="submit">Şirket bilgilerini kaydet</button></form></section><section class="card"><div class="card-heading"><h2>Geri dönüş noktası</h2></div><div class="form-body"><p><strong>Otomatik yedek açık.</strong> Veritabanı sürekli geri alınabilir durumda tutuluyor (Cloudflare D1 “zaman yolculuğu”). Ayrıca bir şey kurmana veya ödeme yapmana gerek yok.</p><details><summary>Yedekten geri dönme hakkında</summary><p class="muted">Bir hata olursa veritabanı geçmiş bir ana geri döndürülebilir. Bu işlem <strong>bilerek düğme değildir</strong>: yanlış bir tıklama o günün bütün işini siler. Geri dönmek gerekirse komutu elle çalıştırmak gerekir:</p><pre class="tip recovery-command">wrangler d1 time-travel info DB\nwrangler d1 time-travel restore DB --bookmark=&lt;yukarıdaki kod&gt;</pre><p class="muted">Geri dönüş penceresi sınırlıdır; uzun süre saklamak istediğin durumlar için aşağıdaki JSON dışa aktarmayı kullan ve dosyayı kendi bilgisayarında sakla.</p></details></div></section><section class="card"><div class="card-heading"><h2>Verilerin sende kalsın</h2></div><div class="form-body"><p>Bu çalışma alanının ürün, cari, fatura ve hareketlerini JSON olarak indir.</p><button class="secondary" data-op="backup">İş verilerini indir</button><p class="help">Şifreler ve bağlantı anahtarları dahil edilmez. Bu dosya iş verileri arşividir. Tam kurtarma Cloudflare’ın otomatik tuttuğu son 7 günlük geçmiş üzerinden yapılır.</p><p><a class="secondary" href="/access#recovery">Otomatik yedek ve kurtarma</a></p><div class="notice subtle">Lunapot AI kapalı. Ücretli yapay zekâ servisi bağlı değil.</div></div></section>'
    // Sunucunun kendiliğinden yaptığı işler: 15 dakikalık otomatik bakımın çalıştığı buradan görülür.
    +(state.jobs?.length?'<section class="card"><div class="card-heading"><h2>Sunucunun kendiliğinden yaptığı işler</h2></div><div class="form-body"><ul class="op-jobs">'
      +state.jobs.map(j=>'<li><span>'+esc(j.description)+'</span><small>'+esc(new Date(String(j.created_at).replace(' ','T')+'Z').toLocaleString('tr-TR',{timeZone:'Europe/Istanbul',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))+'</small></li>').join('')
      +'</ul><p class="help">Rapor yükledikten sonra kalan işler sunucuda her 15 dakikada kendiliğinden tamamlanır. Yapılacak iş yoksa en çok 6 saatte bir "iş yoktu" satırı yazılır.</p></div></section>':'')
    // Yönetici şifresi ekrandan değiştirilebilir; değişince bütün açık oturumlar kapanır (güvenlik incelemesi).
    +(state.owner?'<section class="card"><div class="card-heading"><h2>Yönetici şifresi</h2></div><form data-op-form="password" class="form-body">'
      +field('Şu anki şifre','current_password','','password','required autocomplete="current-password"')
      +field('Yeni şifre (en az 12 karakter)','password','','password','required minlength="12" autocomplete="new-password"')
      +'<p class="help">Şifreyi değiştirince senin dışındaki bütün açık oturumlar kapanır. Şifren ya da telefonun başkasının eline geçtiyse bunu kullan.</p>'
      +'<button class="primary" type="submit">Şifreyi değiştir</button></form></section>':'')
    +'</div>';
  }else{
   state=await api('/connections');if(abort.signal.aborted)return;
   root.innerHTML=heading('Mağazalarınla bağlantı kur','Siparişleri ve finans belgelerini resmî servislerden al, kaynaklarını takip et.')+'<div id="op-error" class="notice" hidden></div>'+(!state.encryption_ready?'<div class="notice">Güvenli anahtar kasası henüz sunucuda kurulmadı. Erişim bilgileri kaydedilmez.</div>':'')+'<div class="recipe-grid">'+state.providers.map(p=>'<section class="card recipe-card"><span class="pill '+(p.configured?'':'neutral')+'">'+(p.configured?(!p.last_success_at?'Test bekliyor':p.stale?'Veri güncel değil':'Veri alındı'):'Bağlantı bekliyor')+'</span><h2>'+esc(p.name)+'</h2><p>'+esc(p.id==='edm'?'EDM servis erişimi doğrulanmayı bekliyor. Alış Faturaları ekranında XML içe aktarımı kullanılabilir.':p.configured?'Son başarılı işlem: '+(p.last_success_at||'Henüz yok'):'Mağazana ait API erişim bilgilerini güvenli kasaya ekle.')+'</p>'+(p.last_error?'<p class="error">'+esc(p.last_error)+'</p>':'')+(p.id!=='edm'?'<div class="ac-actions"><button class="secondary" data-op="configure" data-provider="'+p.id+'" '+(!state.encryption_ready?'disabled':'')+'>'+ (p.configured?'Bağlantıyı güncelle':'Bağlantı kur')+'</button><button class="primary" data-op="sync" data-provider="'+p.id+'" '+(!p.configured?'disabled':'')+'>Verileri al</button></div>':'<a href="#invoices" class="text-button">Fatura içe aktar →</a>')+'</section>').join('')+'</div>'+renderIntegrationGuide()+'<div class="notice"><strong>Bağlantıların kapsamı</strong><p>Trendyol siparişleri inceleme taslağına alınabilir. Hepsiburada kayıtları kaynak kutusunda incelenir; otomatik paket eşleştirmesi henüz tamamlanmadı. Zamanlanmış çekim ve resmî EDM fatura gönderimi henüz etkin değil.</p></div><div class="notice subtle">Siparişler önce incelemeye alınır. Finans kayıtlarının alınması, kesintilerin satışlara işlendiği veya paranın bankaya geçtiği anlamına gelmez. Komisyon tarifeleri Fiyat ve kâr ekranında tarihleriyle kontrol edilir.</div><section class="card breakdown"><div class="card-heading"><h2>Kaynak kayıtları</h2></div><form class="ac-filters" data-op-form="records">'+select('Kaynak','provider',[['trendyol','Trendyol'],['hepsiburada','Hepsiburada']])+select('Veri türü','kind',Object.entries(kinds))+'<button class="secondary" type="submit">Kayıtları göster</button></form><div id="op-records"></div></section><section class="card breakdown"><div class="card-heading"><h2>Son bağlantı işlemleri</h2></div>'+table(['Zaman','Kanal','Kayıt','Sonuç'],state.runs.map(r=>[esc(r.created_at),esc(names[r.provider]||r.provider),esc(r.record_count),esc(r.message)]))+'</section>';
  }
  if(view==='settings'){
   const labels=['Stok başlangıç tarihinin etkisi','Ayrı çalışma alanları','Eksi stok kullanımı'];
   root.querySelectorAll('[data-op-form="settings"] > p.help').forEach((note,index)=>{const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=labels[index]||'Ayar hakkında';note.before(details);details.append(summary,note);});
  }
  root.setAttribute('aria-busy','false');
 }
 root.addEventListener('click',async e=>{const b=e.target.closest('[data-op]');if(!b)return;const action=b.dataset.op,provider=b.dataset.provider;if(action==='close'){close();return;}if(action==='stop-sync'){syncAbort?.abort();return;}if(busy)return;try{
  if(action==='resume-sync'&&resumeSync){busy=true;await runSync(resumeSync);return;}
  if(action==='retry'){busy=true;await load();return;}
  if(action==='configure'){dialog(names[provider]+' bağlantısı','configure',field('Sağlayıcı','provider',provider,'hidden')+field(provider==='trendyol'?'Satıcı ID':'Merchant ID','seller_id','','text','required autocomplete="off"')+field(provider==='trendyol'?'API key':'API kullanıcı adı','key','','password','required autocomplete="off"')+field(provider==='trendyol'?'API secret':'API şifresi / servis anahtarı','secret','','password','required autocomplete="off"')+field('Entegrasyon kimliği (User-Agent)','user_agent','','text','required autocomplete="off"')+'<p class="help">Mağaza panelindeki API bilgilerini kullanın. Bu alan mağaza giriş şifresi için değildir. Kayıttan sonra anahtarlar tekrar gösterilmez.</p>');return;}
  if(action==='sync'){const p=state.providers.find(p=>p.id===provider);dialog(names[provider]+' · Verileri al','sync',field('Sağlayıcı','provider',provider,'hidden')+select('Alınacak kayıtlar','kind',p.capabilities.map(k=>[k,kinds[k]||k]))+'<div class="field-grid">'+field('Başlangıç','from',new Date(Date.now()-6*86400000).toISOString().slice(0,10),'date','required')+field('Bitiş','to',date(),'date','required')+'</div>'+field('Başlangıç sayfası · ilk alımda 0','page',0,'number','required min="0" max="10000" step="1"')+field('HB komisyon SKU kodları (virgülle ayır)','skus','','text','maxlength="4000"')+'<label><input type="checkbox" name="all_pages" checked> Seçilen tarih aralığının tüm sayfalarını sırayla al</label><p class="help">İlerlemeyi izleyebilir ve duraklatabilirsin. Sayfa açıkken çalışır; zamanlanmış arka plan aktarımı değildir. Aynı kayıtlar tekrar alınırsa çoğaltılmaz.</p>');return;}
  if(action==='backup'){busy=true;b.disabled=true;download(await api('/settings/backup'),'lunapot-'+namespace+'-'+date()+'.json');notice('İş verileri dosyası indirildi.');}
  if(action==='next-records'){recordPage++;await records();}
 }catch(error){if(action==='retry')loadError(error);else notice(error.message);}finally{busy=false;b.disabled=false;}},{signal:abort.signal});
 async function runSync(input){
  close();syncAbort=new AbortController();const signal=AbortSignal.any([abort.signal,syncAbort.signal]);resumeSync=null;
  $('#op-error').insertAdjacentHTML('afterend','<div class="sync-progress" role="status"><strong>Kaynak verileri alınıyor</strong><progress aria-label="Veri alımı devam ediyor"></progress><p data-sync-text></p><button type="button" class="secondary" data-op="stop-sync">Duraklat</button></div>');
  const r=await pullSourcePages({startPage:input.page,allPages:input.all_pages,signal,requestPage:(page,requestSignal)=>api('/connections/'+input.provider+'/sync',{...input,page},requestSignal),onProgress:p=>{const el=$('[data-sync-text]');if(el)el.textContent=p.pages+' sayfa alındı · '+p.records+' kaynak kaydı · '+p.created+' yeni sipariş taslağı. '+(p.page+1)+'. sayfa işleniyor.';}});
  if(abort.signal.aborted)return;
  if(r.status!=='complete')resumeSync={...input,page:r.page};
  await load();
  notice((r.status==='complete'?'Seçilen kapsamın kaynak sayfaları alındı. ':r.status==='error'?'Veri alımı durdu. ':'Veri alımı duraklatıldı. ')+r.pages+' sayfa · '+r.records+' kaynak kaydı · '+r.created+' yeni taslak. '+r.error+' '+r.warnings.join(' ')+' Finans kayıtları henüz muhasebeye işlenmedi.');
  if(resumeSync)$('#op-error').insertAdjacentHTML('beforeend','<p><button type="button" class="secondary" data-op="resume-sync">Kaldığım yerden devam et</button></p>');
 }
 async function records(){const r=await api('/connections/records?provider='+encodeURIComponent(recordProvider)+'&kind='+encodeURIComponent(recordKind)+'&page='+recordPage);$('#op-records').innerHTML='<p class="pad muted">Sayfa '+(recordPage+1)+' · Kaynak kayıtları henüz mali sonuç değildir.</p>'+table(['Kaynak kimliği','Son görülme','İçerik'],r.records.map(r=>[esc(r.external_id),esc(r.last_seen_at),'<details><summary>Kaydı incele</summary><pre>'+esc(JSON.stringify(r.payload,null,2))+'</pre></details>']))+(r.hasMore?'<button class="secondary" data-op="next-records">Sonraki sayfa</button>':'');}
 root.addEventListener('submit',async e=>{if(!e.target.dataset.opForm)return;e.preventDefault();if(busy)return;busy=true;e.target.setAttribute('aria-busy','true');const b=e.submitter;if(b)b.disabled=true;try{const x=Object.fromEntries(new FormData(e.target)),action=e.target.dataset.opForm;
  if(action==='password'){const r=await fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(x)});
   const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Şifre değiştirilemedi.');
   e.target.reset();notice('Şifre değişti. Diğer cihazlardaki oturumlar kapatıldı.');}
  if(action==='settings'){x.allow_negative_stock=e.target.querySelector('[name=allow_negative_stock]')?.checked===true;await api('/settings',x);await load();notice('Şirket bilgileri kaydedildi.');}
  if(action==='configure'){await api('/connections/'+x.provider+'/configure',x);close();await load();notice('Erişim bilgileri kaydedildi. Bağlantıyı doğrulamak için verileri alın.');}
  if(action==='sync')await runSync({...x,page:Number(x.page),skus:x.skus.split(',').map(s=>s.trim()).filter(Boolean),all_pages:x.all_pages==='on'});
  if(action==='records'){recordPage=0;recordProvider=x.provider;recordKind=x.kind;await records();}
 }catch(error){const box=$('#op-form-error');if(box)box.textContent=error.message;else if($('#op-error'))notice(error.message);else loadError(error);}finally{busy=false;e.target.setAttribute('aria-busy','false');if(b)b.disabled=false;}},{signal:abort.signal});
 function loadError(error){if(error.name==='AbortError'||abort.signal.aborted)return;root.setAttribute('aria-busy','false');root.innerHTML='<div class="notice" role="alert">'+esc(error.message)+' <button class="secondary" type="button" data-op="retry">Yeniden dene</button></div>';}
 load().catch(loadError);
 return ()=>{abort.abort();close();root.classList.remove('insights-operations');root.removeAttribute('aria-busy');};
}
