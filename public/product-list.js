
export const BRANDS=['Tropikal','Gartengold','Klasmann','SAB'];
export const CATEGORIES=['Torf ve yetiştirme ortamı','Bitki besini','Toprak düzenleyici','Bitki bakım ürünü','Saksı ve aksesuar'];
const norm=s=>String(s||'').toLocaleLowerCase('tr-TR');
// Siralama ve gosterim ayni tedarikci kaynagini kullanir: once kartta secili olan,
// yoksa alis gecmisinden turetilen. Ikisi de yoksa bos.
const tedarikciAdi=p=>p.supplier_name||p.last_supplier_name||'';
export function selectProducts(products,state,stats=null){
 const st=p=>stats?.get(p.id)||null;
 const result=products.filter(p=>(!state.stockQuery||norm([p.name,p.sku,p.brand,p.category,p.last_supplier_name].join(' ')).includes(norm(state.stockQuery)))&&(!state.stockBrand||p.brand===state.stockBrand)&&(!state.stockCategory||p.category===state.stockCategory)&&(!state.stockSupplier||p.supplier_id===state.stockSupplier||(!p.supplier_id&&p.last_supplier_id===state.stockSupplier))&&(!state.stockFilter||(state.stockFilter==='empty'?p.quantity_milli===0:p.quantity_milli-(p.reserved_milli||0)<=p.min_stock_milli)));
 const sort=state.stockSort||'brand';
 const say=(p,k)=>st(p)?.[k]??-Infinity;
 return result.sort((a,b)=>sort==='sold'?say(b,'adet_milli')-say(a,'adet_milli'):sort==='profit'?say(b,'kar_cents')-say(a,'kar_cents'):sort==='unitprofit'?say(b,'kar_adet_cents')-say(a,'kar_adet_cents'):sort==='quantity'?b.quantity_milli-a.quantity_milli:sort==='available'?(b.quantity_milli-(b.reserved_milli||0))-(a.quantity_milli-(a.reserved_milli||0)):sort==='value'?(b.value_cents??-1)-(a.value_cents??-1):sort==='supplier'?(tedarikciAdi(a)||'ZZZ').localeCompare(tedarikciAdi(b)||'ZZZ','tr')||a.name.localeCompare(b.name,'tr'):sort==='brand'?(a.brand||'ZZZ').localeCompare(b.brand||'ZZZ','tr')||a.name.localeCompare(b.name,'tr'):a.name.localeCompare(b.name,'tr'));
}
export function saleAverage(sales,productId){
 const rows=sales.filter(s=>s.product_id===productId);
 if(!rows.length||rows.some(s=>s.revenue_cents==null))return null;
 const quantity=rows.reduce((sum,s)=>sum+(s.kind==='return'?-1:1)*s.quantity_milli,0);
 return quantity>0?Math.round(rows.reduce((sum,s)=>sum+s.revenue_cents,0)*1000/quantity):null;
}
export function productList(products,data,state,helpers){
 const {esc,money,qty}=helpers;
 // Kartta tedarikci secili degilse alis gecmisinden TURETILIR ve boyle oldugu yazilir.
 // Kaynak alis faturasidir; tahmin yapilmaz. Hic alinmamis urunde alan bos kalir.
 const supplier=p=>data.suppliers.find(s=>s.id===p.supplier_id)?.name
   ||(p.last_supplier_name?p.last_supplier_name+' · alışlardan':'Tedarikçi seçilmedi');
 // Tutarlar KDV DAHİL gösterilir: kullanıcı ödediği ve tahsil ettiği parayı görür. Oran ürünün
 // fiyat profilinden, yoksa son alış faturasından gelir. Oran bilinmiyorsa KDV hariç tutar
 // "KDV hariç" diye işaretlenir; oran uydurulmaz.
 const gross=(p,v)=>v==null?null:p.vat_bps==null?v:Math.round(v*(10000+p.vat_bps)/10000);
 const tag=p=>p.vat_bps==null?' <small>KDV hariç · KDV oranı eksik</small>':' <small>KDV dahil</small>';
 const pair=(p,v)=>'<strong>'+money(p.vat_bps==null?null:gross(p,v))+'</strong><small>'+money(v)+' KDV hariç'+(p.vat_bps==null?' · KDV oranı eksik':'')+'</small>';
 const price=p=>saleAverage(data.sales,p.id);
 const available=p=>p.quantity_milli-(p.reserved_milli||0);
 const cost=p=>p.quantity_milli>0&&p.value_cents!=null?Math.round(p.value_cents*1000/p.quantity_milli):null;
 const actions=p=>(helpers.editable===false?'':'<button type="button" class="text-button" data-ac="edit-product" data-id="'+esc(p.id)+'">Düzenle</button>')+'<button type="button" class="text-button" data-ac="stock-history" data-id="'+esc(p.id)+'">Hareketler →</button>';
 // SATIŞ VE KÂR (seçili dönemde, kâr raporuyla aynı hesap): satılan adet iadeler düşülmüş; ciro ve kâr KDV dahil.
 // Kapsam: teslim edilenler + henüz teslim edilmemişler (gönderilen ve hazırlanan); ikincisi tahminidir
 // ve ana sayfanın "Kargodaki tahminim" kartıyla aynı paketlerdir.
 const st=p=>data.productStats?.get(p.id)||null;
 const revenue=p=>{const x=st(p);if(!x)return '—';return x.eksik_paket?'<span>Eksik veri</span><small>Hesaplanan ciro '+money(x.ciro_cents)+'</small>':money(x.ciro_cents);};
 const kar=v=>v==null?'Hesap eksik':'<span class="'+(v<0?'ol-neg':'ol-pos')+'">'+money(v)+'</span>';
 // Bilinmeyen maliyet/kesinti sıfır sayılmaz: toplam boş kalır, kaç paketin hesaplanmadığı ve nedeni yazılır.
 const tahminNot=p=>{const x=st(p);if(!x)return '';
  return (x.eksik_paket?'<small class="error" title="'+esc(x.eksik_neden||'')+'">'+x.eksik_paket+' paket hesaplanmadı'+(x.hesaplanan_kar_cents!=null?' · hesaplanan '+money(x.hesaplanan_kar_cents):'')+'</small>':'')
   +(x.tahmini_paket?'<small>'+x.tahmini_paket+' paket tahmini'+(x.kargoda_paket?' ('+x.kargoda_paket+' paket henüz teslim edilmedi)':'')+'</small>':'');};
 const performance=p=>state.stockRangeBusy?'<p class="help" role="status">Performans yükleniyor…</p>':!data.productStats?'<p class="help">Satış performansı alınamadı.</p>':!st(p)?'<p class="help">Bu dönemde ürün performans kaydı yok.</p>':'<section class="product-performance" aria-label="Seçili dönem satış performansı"><span class="eyebrow">Seçili dönem · KDV dahil</span><dl><div><dt>Satılan</dt><dd>'+qty(st(p).adet_milli)+' '+esc(p.stock_unit)+'</dd></div><div><dt>Ciro</dt><dd>'+revenue(p)+'</dd></div><div><dt>Cebine kalan</dt><dd>'+kar(st(p).kar_cents)+'</dd></div></dl>'+tahminNot(p)+'</section>';
 const status=p=>p.quantity_milli<0?'Eksi stok':p.quantity_milli===0?'Stok yok':available(p)<=p.min_stock_milli?'Kritik stok':'Stokta';
 if(!products.length)return '<div class="card product-empty"><h2>Bu seçimde ürün bulunamadı</h2><p>Filtreleri temizleyebilir veya ürün listesini içe aktarmak için hazırlayabilirsin.</p></div>';
 // MARKA GRUPLARI. Tropikal, Gartengold, Klasmann… her marka kendi başlığı altında; başlıkta
 // o markanın eldeki adedi ve stok değeri (KDV dahil). Markasız ürünler en sonda.
 const order=[...BRANDS];
 const groups=new Map();
 for(const p of products){const b=p.brand||'';if(!groups.has(b))groups.set(b,[]);groups.get(b).push(p);}
 const keys=[...groups.keys()].sort((a,b)=>(!a)-(!b)||((order.indexOf(a)+1||99)-(order.indexOf(b)+1||99))||a.localeCompare(b,'tr'));
 const head=(b,list)=>{
  const onHand=list.reduce((s,p)=>s+Math.max(0,p.quantity_milli),0);
  const missing=list.filter(p=>p.value_cents==null||p.vat_bps==null).length;
  const net=list.some(p=>p.value_cents==null)?null:list.reduce((s,p)=>s+p.value_cents,0);
  const value=missing?null:list.reduce((s,p)=>s+gross(p,p.value_cents),0);
  const eksi=list.filter(p=>p.quantity_milli<0).length;
  return '<div class="brand-head"><h2>'+esc(b||'Markası belirtilmemiş')+'</h2><span>'+list.length+' ürün · güncel eldeki '+qty(onHand)+' · '+(value==null?'Brüt hesaplanamadı':'Güncel stok değeri '+money(value)+' KDV dahil')+' · '+(net==null?'KDV hariç değer hesaplanamadı':'KDV hariç değer '+money(net))+(missing?' · '+missing+' ürünün değer/KDV bilgisi eksik':'')+(eksi?' · <b>'+eksi+' üründe eksi stok</b>':'')+'</span></div>';
 };
 if(!helpers.compact){
 const tableRows=list=>list.map(p=>'<tr><td>'+esc(p.name)+'<small>'+esc(p.sku)+'</small></td><td>'+esc(p.category||'Kategorisiz')+'</td><td>'+esc(supplier(p))+'</td><td>'+qty(p.quantity_milli)+' '+esc(p.stock_unit)+'</td><td>'+qty(p.reserved_milli||0)+'</td><td>'+qty(available(p))+'</td><td>'+money(gross(p,p.average_purchase_cents))+tag(p)+'</td><td>'+pair(p,cost(p))+'</td>'+(data.productStats?'<td>'+(st(p)?qty(st(p).adet_milli):'—')+'</td><td>'+(st(p)?revenue(p):'—')+'</td><td>'+(st(p)?kar(st(p).kar_cents)+tahminNot(p):'—')+'</td><td>'+(st(p)?kar(st(p).kar_adet_cents):'—')+'</td>':'<td>'+money(gross(p,price(p)))+tag(p)+'</td>')+'<td>'+actions(p)+'</td></tr>').join('');
 if(state.stockView==='table')return keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="card table-wrap"><table class="ac-table"><thead><tr>'+['Ürün / Kod','Kategori','Tedarikçi','Eldeki','Ayrılan','Kullanılabilir','Ort. alış (KDV dahil)','Birim stok maliyeti (KDV dahil)',...(data.productStats?['Satılan adet','Ciro (KDV dahil)','Toplam kâr','Adet başı kâr']:['Ort. satış (KDV dahil)']),'İşlem'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+tableRows(groups.get(b))+'</tbody></table></div></section>').join('');
 }
 const detailRows=p=>'<div><dt>Eldeki / ayrılan</dt><dd>'+qty(p.quantity_milli)+' / '+qty(p.reserved_milli||0)+'</dd></div><div><dt>Ort. alış fiyatı</dt><dd>'+money(gross(p,p.average_purchase_cents))+tag(p)+'</dd></div><div><dt>Ort. satış fiyatı</dt><dd>'+money(gross(p,price(p)))+tag(p)+'</dd></div>'+(data.productStats?'<div><dt>Satılan</dt><dd>'+(st(p)?qty(st(p).adet_milli):'—')+' '+esc(p.stock_unit)+'</dd></div><div><dt>Ciro</dt><dd>'+(st(p)?revenue(p):'—')+'</dd></div><div><dt>Toplam kâr</dt><dd>'+(st(p)?kar(st(p).kar_cents)+tahminNot(p):'—')+'</dd></div><div><dt>Adet başı kâr</dt><dd>'+(st(p)?kar(st(p).kar_adet_cents):'—')+'</dd></div>':'');
 const tableRows=list=>list.map(p=>'<tr><td class="product-table-name"><strong>'+esc(p.name)+'</strong><small>'+esc(p.sku)+' · '+esc(supplier(p))+'</small></td><td><strong class="'+(available(p)<0?'ol-neg':'')+'">'+qty(available(p))+' '+esc(p.stock_unit)+'</strong><small>Eldeki '+qty(p.quantity_milli)+' · Ayrılan '+qty(p.reserved_milli||0)+'</small></td><td>'+pair(p,cost(p))+'</td><td>'+pair(p,p.value_cents)+'</td><td><details class="product-details"><summary>Maliyet ve satış</summary><dl><div><dt>Kategori</dt><dd>'+esc(p.category||'Kategorisiz')+'</dd></div>'+detailRows(p)+'</dl></details></td><td>'+actions(p)+'</td></tr>').join('');
 if(state.stockView==='table')return keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="card table-wrap"><table class="ac-table product-table" data-list-sort="server"><thead><tr>'+['Ürün / Tedarikçi','Kullanılabilir stok','Birim maliyet · KDV dahil','Stok değeri · KDV dahil','Ayrıntılar','İşlem'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+tableRows(groups.get(b))+'</tbody></table></div></section>').join('');
 const tile=helpers.compact?p=>'<article class="card product-tile"><div class="product-eyebrow"><span>'+esc(p.category||'Kategorisiz')+'</span><span class="pill '+(available(p)<=p.min_stock_milli?'warning':'success')+'">'+status(p)+'</span></div><h3>'+esc(p.name)+'</h3><p class="product-code">'+esc(p.sku)+'</p><p class="product-supplier">'+esc(supplier(p))+'</p><div class="product-available '+(available(p)<0?'ol-neg':'')+'"><span>Güncel kullanılabilir stok</span><strong>'+qty(available(p))+' <small>'+esc(p.stock_unit)+'</small></strong></div><dl class="product-key-values"><div><dt>Birim stok maliyeti</dt><dd>'+pair(p,cost(p))+'</dd></div><div><dt>Güncel stok değeri</dt><dd>'+pair(p,p.value_cents)+'</dd></div></dl>'+performance(p)+'<details class="product-details"><summary>Maliyet ve satış ayrıntıları</summary><dl>'+detailRows(p)+'</dl></details><div class="product-actions">'+actions(p)+'</div></article>':p=>'<article class="card product-tile"><div class="product-eyebrow"><span>'+esc(p.category||'Kategorisiz')+'</span><span class="pill '+(p.quantity_milli<=0?'warning':'neutral')+'">'+status(p)+'</span></div><h2>'+esc(p.name)+'</h2><p class="muted">'+esc(p.sku)+'</p><p class="product-supplier">'+esc(supplier(p))+'</p><dl><div><dt>Kullanılabilir</dt><dd>'+qty(available(p))+' '+esc(p.stock_unit)+'</dd></div><div><dt>Eldeki / ayrılan</dt><dd>'+qty(p.quantity_milli)+' / '+qty(p.reserved_milli||0)+'</dd></div><div><dt>Ort. alış fiyatı</dt><dd>'+money(gross(p,p.average_purchase_cents))+tag(p)+'</dd></div><div><dt>Birim stok maliyeti</dt><dd>'+pair(p,cost(p))+'</dd></div><div><dt>Ort. satış fiyatı</dt><dd>'+money(gross(p,price(p)))+tag(p)+'</dd></div><div><dt>Güncel stok değeri</dt><dd>'+pair(p,p.value_cents)+'</dd></div>'+(data.productStats?'</dl><dl class="product-sales"><div><dt>Satılan</dt><dd>'+(st(p)?qty(st(p).adet_milli):'—')+' '+esc(p.stock_unit)+'</dd></div><div><dt>Ciro</dt><dd>'+(st(p)?revenue(p):'—')+'</dd></div><div><dt>Toplam kâr</dt><dd>'+(st(p)?kar(st(p).kar_cents)+tahminNot(p):'—')+'</dd></div><div><dt>Adet başı kâr</dt><dd>'+(st(p)?kar(st(p).kar_adet_cents):'—')+'</dd></div>':'')+'</dl><div class="product-actions">'+actions(p)+'</div></article>';
 return keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="product-grid">'+groups.get(b).map(tile).join('')+'</div></section>').join('');
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
