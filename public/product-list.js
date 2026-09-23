export const BRANDS=['Tropikal','Gartengold','Klasmann','SAB'];
export const CATEGORIES=['Torf ve yetiştirme ortamı','Bitki besini','Toprak düzenleyici','Bitki bakım ürünü','Saksı ve aksesuar'];
const norm=s=>String(s||'').toLocaleLowerCase('tr-TR');
const known=v=>Number.isSafeInteger(v)?v:null;
// Oran bin baz puandır (2000 = %20,0). Tutar yetkisi kapalı personelde tutarlar boş gelir, oran kalır.
const yuzde=bps=>new Intl.NumberFormat('tr-TR',{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1}).format(bps/10000);
const KANAL_ADI={trendyol:'Trendyol',hepsiburada:'Hepsiburada'};
const DONEM_ADI=[['son_30','son 30 gün'],['onceki_30','önceki 30 gün'],['tum','seçili dönem']];
const onHand=p=>known(p.on_hand_milli===undefined?p.quantity_milli:p.on_hand_milli);
const reserved=p=>known(p.reserved_milli);
const available=p=>p.available_milli===undefined?(onHand(p)===null||reserved(p)===null?null:onHand(p)-reserved(p)):known(p.available_milli);
const supplierName=p=>p.supplier_name||p.last_supplier_name||'';
export function selectProducts(products,state,stats=null){
 const result=products.filter(p=>(!state.stockQuery||norm([p.name,p.sku,p.brand,p.category,supplierName(p)].join(' ')).includes(norm(state.stockQuery)))&&(!state.stockBrand||p.brand===state.stockBrand)&&(!state.stockCategory||p.category===state.stockCategory)&&(!state.stockSupplier||p.supplier_id===state.stockSupplier||(!p.supplier_id&&p.last_supplier_id===state.stockSupplier))&&(!state.stockFilter||(state.stockFilter==='empty'?onHand(p)===0:available(p)!==null&&available(p)<=p.min_stock_milli)));
 // Legacy profit sort values no longer rank allocated component profit as intrinsic profit.
 const sort=['profit','unitprofit'].includes(state.stockSort)?'name':state.stockSort||'brand';
 const descending=(a,b)=>(b??-Infinity)-(a??-Infinity);
 return result.sort((a,b)=>{
  const n=sort==='sold'?descending(stats?.get(a.id)?.adet_milli,stats?.get(b.id)?.adet_milli):sort==='quantity'?descending(onHand(a),onHand(b)):sort==='available'?descending(available(a),available(b)):sort==='transit'?descending(known(a.in_transit_milli),known(b.in_transit_milli)):sort==='value'?descending(a.value_cents,b.value_cents):sort==='supplier'?(supplierName(a)||'ZZZ').localeCompare(supplierName(b)||'ZZZ','tr'):sort==='brand'?(a.brand||'ZZZ').localeCompare(b.brand||'ZZZ','tr'):0;
  return n||a.name.localeCompare(b.name,'tr');
 });
}
export function saleAverage(sales,productId){
 const rows=sales.filter(s=>s.product_id===productId);
 if(!rows.length||rows.some(s=>s.revenue_cents==null))return null;
 const quantity=rows.reduce((sum,s)=>sum+(s.kind==='return'?-1:1)*s.quantity_milli,0);
 return quantity>0?Math.round(rows.reduce((sum,s)=>sum+s.revenue_cents,0)*1000/quantity):null;
}
export function productList(products,data,state,helpers){
 const {esc,money,qty}=helpers;
 const quantity=v=>known(v)===null?'Bilinmiyor':qty(v);
 const supplier=p=>(data.suppliers||[]).find(s=>s.id===p.supplier_id)?.name||(p.last_supplier_name?p.last_supplier_name+' · alışlardan':'Tedarikçi seçilmedi');
 const gross=(p,v)=>v==null||p.vat_bps==null?null:Math.round(v*(10000+p.vat_bps)/10000);
 const pair=(p,v)=>'<strong>'+money(gross(p,v))+'</strong><small>'+money(v)+' KDV hariç'+(p.vat_bps==null?' · KDV oranı eksik':'')+'</small>';
 const cost=p=>onHand(p)>0&&p.value_cents!=null?Math.round(p.value_cents*1000/onHand(p)):null;
 const actions=p=>(helpers.editable===false?'':'<button type="button" class="text-button" data-ac="edit-product" data-id="'+esc(p.id)+'">Düzenle</button>')+'<button type="button" class="text-button" data-ac="stock-history" data-id="'+esc(p.id)+'">Hareketler →</button>';
 const st=p=>data.productStats?.get(p.id)||null;
 // TEK SATIŞTAN / SET İÇİNDEN. Aynı ürünün iki ayrı sonucu ayrı gösterilir; karışık tek rakam yoktur.
 // Bilinmeyen sıfır yazılmaz, nedeni yazılır. Tutarlar KDV dahil cebine kalandır.
 const shapeCell=(x,p,key,label)=>{
  const packages=known(x[key+'_paket']),value=known(x[key+'_kar_cents']),unit=known(x[key+'_kar_adet_cents']),missing=known(x[key+'_eksik_paket']);
  const body=!packages?'<strong>—</strong><small>Bu dönemde yok</small>'
   :value===null?'<strong>Bilinmiyor</strong><small>'+esc(missing?missing+' pakette '+(x.eksik_neden||'kâr hesaplanamadı'):'Kâr hesaplanamadı')+'</small>'
   :'<strong class="'+(value<0?'ol-neg':'ol-pos')+'">'+money(value)+'</strong><small>'+quantity(x[key+'_adet_milli'])+' '+esc(p.stock_unit)+' · '+packages+' paket'+(unit===null?'':' · adet başına '+money(unit))+'</small>';
  return '<div><dt>'+label+'</dt><dd>'+body+'</dd></div>';
 };
 const shape=(x,p)=>'<dl class="product-shape">'+shapeCell(x,p,'tek','Tek satıştan')+shapeCell(x,p,'set','Set içinden')+'</dl><p class="help">Tutarlar KDV dahil, cebine kalandır. Bir bileşenin set payı o ürünün tek başına kârı değildir: pazaryeri set için tek tutar öder, bu tutar gelir payına göre bölünür.</p>';
 // ORTALAMA KOMİSYON ORANI. Pazaryerinin kestiği komisyon kampanya dönemlerinde değişir: burada
 // AĞIRLIKLI oran (Σ komisyon ÷ Σ KDV dahil satış) ve arkasındaki paket sayısı yazar; oranların
 // ortalaması değildir. Kanal kırılımı ve dönem karşılaştırması sunucudan hazır gelir.
 // Bilinmeyen oran SIFIR yazılmaz ("bilinmiyor"), paketi olmayan dönem "veri yok" der.
 const komisyonBlogu=x=>{
  const bps=known(x.komisyon_oran_bps),paket=known(x.komisyon_paket)||0;
  const kanallar=(x.komisyon_kanallar||[]).filter(k=>known(k.oran_bps)!==null).map(k=>esc(KANAL_ADI[k.kanal]||k.kanal)+' '+yuzde(k.oran_bps)+' ('+(known(k.paket)||0)+' paket)').join(' · ');
  const donem=x.komisyon_donemler||{};
  // DÖNEM PENCERELERİ ekranın tarih filtresinden bağımsız hesaplanır, ama satırlar filtreye göre
  // gelir. Filtre darsa (ör. 30 gün) 'önceki 30 gün' penceresi yüklenen aralığın tamamen dışında
  // kalır; orada 'veri yok' demek YANLIŞ olur (kayıt var, sadece süzülmüş). Aralık dışı olduğunu
  // söyler ve her dönemin gerçek tarihlerini yazarız.
  const seri=DONEM_ADI.map(([k,ad])=>{
   const d=donem[k];
   if(known(d?.oran_bps)!==null)return ad+' '+yuzde(d.oran_bps)+' ('+(known(d.paket)||0)+' paket)';
   const disarida=d?.filtre_disi;
   return ad+' '+(disarida?'seçili tarih aralığının dışında':'veri yok');
  }).join(' · ');
  const body=bps===null?'<strong>Bilinmiyor</strong><small>Komisyonu bilinen teslim edilmiş paket yok</small>'
   :'<strong>'+yuzde(bps)+'</strong><small>'+paket+' paket'+(kanallar?' · '+kanallar:'')+'</small>';
  return '<dl><div><dt>Ortalama komisyon oranı · KDV dahil satışa göre</dt><dd>'+body+'</dd></div></dl>'
   +(bps===null?'':'<p class="help">Komisyon oranı: '+seri+'</p>')
   +'<p class="help">Teslim edilen paketlerden, ağırlıklı: toplam komisyon ÷ toplam KDV dahil satış. Oran deftere yazılan satışa göredir; pazaryeri indirimli tutardan komisyon kesiyorsa tarife oranı daha yüksektir.</p>';
 };
 const sales=p=>{
  const x=st(p);
  const amount=state.stockRangeBusy?'<p role="status">Satış miktarı yükleniyor…</p>':!data.productStats?'<p>Satış miktarı alınamadı.</p>':!x?'<p>Bu dönemde ürün satış kaydı yok.</p>':shape(x,p)+komisyonBlogu(x)+'<dl><div><dt>Satış / sipariş miktarı · iadeler düşülmüş</dt><dd>'+quantity(x.adet_milli)+' '+esc(p.stock_unit)+'</dd></div></dl>';
  return '<details class="product-details product-sales"><summary>Satış kullanım ayrıntıları</summary>'+amount+'<p class="help">Seçili dönemde teslim edilen, kargodaki ve hazırlanan siparişlerdeki ürün miktarıdır; iadeler düşülür. Tekli satış, çoklu paket ve set içinde kullanılan miktarlar birlikte olabilir. Depo bakiyesi değildir.</p><p class="help">Set gelirinin bileşene dağıtılan payı, ürünün tek başına kârı değildir. İade gideri ve satış sonuçları paket bazında incelenir.</p><a href="#performance?view=sales">Satış performansını incele →</a></details>';
 };
 const transit=p=>'<strong>'+quantity(p.in_transit_milli)+'</strong>'+(p.in_transit_status==='incomplete'&&known(p.in_transit_known_milli)!==null?'<small>Doğrulanabilen '+quantity(p.in_transit_known_milli)+' · toplam eksik</small>':'')+(p.in_transit_notes||[]).map(n=>'<small class="stock-transit-note">'+esc(n)+'</small>').join('');
 const physical=p=>'<dl class="stock-physical"><div><dt>Depoda · kayıtlı</dt><dd>'+quantity(onHand(p))+'</dd></div><div><dt>Ayrılan · depoda</dt><dd>'+quantity(reserved(p))+'</dd></div><div><dt>Kargoda · depodan çıktı</dt><dd>'+transit(p)+'</dd></div></dl>';
 const status=p=>onHand(p)===null||available(p)===null?'Stok bilgisi eksik':onHand(p)<0?'Eksi stok':onHand(p)===0?'Stok yok':available(p)<=p.min_stock_milli?'Kritik stok':'Stokta';
 const costDetails=p=>'<details class="product-details"><summary>Maliyet ayrıntıları · KDV dahil</summary><dl><div><dt>Ort. alış fiyatı</dt><dd>'+pair(p,p.average_purchase_cents)+'</dd></div><div><dt>Ort. satış payı · defter satırlarından</dt><dd>'+pair(p,saleAverage(data.sales||[],p.id))+'</dd></div><div><dt>Birim stok maliyeti</dt><dd>'+pair(p,cost(p))+'</dd></div><div><dt>Güncel stok değeri</dt><dd>'+pair(p,p.value_cents)+'</dd></div></dl><p class="help">Satış payı, set ve çoklu paket dağılımlarını içerebilir; tekli satış fiyatı değildir.</p></details>';
 if(!products.length)return '<div class="card product-empty"><h2>Bu seçimde ürün bulunamadı</h2><p>Filtreleri temizleyebilir veya ürün listesini içe aktarmak için hazırlayabilirsin.</p></div>';
 const groups=new Map();
 for(const p of products){const b=p.brand||'';if(!groups.has(b))groups.set(b,[]);groups.get(b).push(p);}
 const keys=[...groups.keys()].sort((a,b)=>(!a)-(!b)||((BRANDS.indexOf(a)+1||99)-(BRANDS.indexOf(b)+1||99))||a.localeCompare(b,'tr'));
 const head=(b,list)=>{
  // Never add kg, litres and pieces into a fictitious count; retain negative ledger balances.
  const units=new Map();for(const p of list){const unit=p.stock_unit||'';if(!units.has(unit))units.set(unit,[]);units.get(unit).push(onHand(p));}
  const balances=[...units].map(([u,qs])=>quantity(qs.some(q=>q===null)?null:qs.reduce((s,q)=>s+q,0))+' '+esc(u)).join(' · ');
  return '<div class="brand-head"><h2>'+esc(b||'Markası belirtilmemiş')+'</h2><span>'+list.length+' ürün · depoda kayıtlı '+balances+'</span></div>';
 };
 const introduction='<div class="stock-model-note"><p><strong>Fiziksel ürün stoğu</strong> · Kullanılabilir = depoda kayıtlı − ayrılan. Ayrılan ürünler hâlâ depodadır. Kargodakiler sevkiyatta stoktan çıktı; tekrar düşülmez.</p><p>Setleri değil, içindeki stok ürünlerini tek tek sayın. Bu miktarlar günceldir; satış dönemi filtresinden etkilenmez.</p></div>';
 const tableRows=list=>list.map(p=>'<tr><td class="product-table-name"><strong>'+esc(p.name)+'</strong><small>'+esc(p.sku)+' · '+esc(supplier(p))+'</small></td><td><strong class="'+(available(p)!==null&&available(p)<0?'ol-neg':'')+'">'+quantity(available(p))+' '+esc(p.stock_unit)+'</strong></td><td>'+quantity(onHand(p))+'</td><td>'+quantity(reserved(p))+'</td><td>'+transit(p)+'</td><td>'+costDetails(p)+sales(p)+'</td><td>'+actions(p)+'</td></tr>').join('');
 if(state.stockView==='table')return introduction+keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="card table-wrap"><table class="ac-table product-table" data-list-sort="server"><thead><tr>'+['Ürün / Tedarikçi','Kullanılabilir','Depoda · kayıtlı','Ayrılan · depoda','Kargoda · depodan çıktı','Ayrıntılar','İşlem'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+tableRows(groups.get(b))+'</tbody></table></div></section>').join('');
 const tile=p=>'<article class="card product-tile stock-physical-card"><div class="product-eyebrow"><span>'+esc(p.category||'Kategorisiz')+'</span><span class="pill '+(available(p)===null||available(p)<=p.min_stock_milli?'warning':'success')+'">'+status(p)+'</span></div><h3>'+esc(p.name)+'</h3><p class="product-code">'+esc(p.sku)+'</p><p class="product-supplier">'+esc(supplier(p))+'</p><div class="product-available '+(available(p)!==null&&available(p)<0?'ol-neg':'')+'"><span>Kullanılabilir fiziksel stok</span><strong>'+quantity(available(p))+' <small>'+esc(p.stock_unit)+'</small></strong></div>'+physical(p)+costDetails(p)+sales(p)+'<div class="product-actions">'+actions(p)+'</div></article>';
 return introduction+keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="product-grid">'+groups.get(b).map(tile).join('')+'</div></section>').join('');
}

// Label tables, including editable rows that list-tools intentionally leaves alone.
// Defer until the current render is complete; never reorder rows or change form names.
export function prepareWorkflow(root){
 queueMicrotask(()=>{
  if(!root.isConnected)return;
  for(const table of root.querySelectorAll('table:not([data-list-tools="off"])')){
   const heads=[...(table.tHead?.rows[0]?.cells||[])];
   if(!heads.length)continue;
   table.classList.add('workflow-table');
   for(const body of table.tBodies)for(const row of body.rows){
    let column=0;
    for(const cell of row.cells){
     const label=heads.slice(column,column+cell.colSpan).map(h=>h.textContent.trim()).filter(Boolean).join(' / ')||'İşlem';
     cell.dataset.label=label;
     for(const input of cell.querySelectorAll('input,select,textarea')){
      if(!input.labels?.length&&!input.hasAttribute('aria-label')&&!input.hasAttribute('aria-labelledby'))input.setAttribute('aria-label',label);
     }
     column+=cell.colSpan;
    }
   }
  }
 });
}
