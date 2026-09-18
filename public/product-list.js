
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
 const tag=p=>p.vat_bps==null?' <small>KDV hariç</small>':'';
 const price=p=>saleAverage(data.sales,p.id);
 const available=p=>p.quantity_milli-(p.reserved_milli||0);
 const cost=p=>p.quantity_milli>0&&p.value_cents!=null?Math.round(p.value_cents*1000/p.quantity_milli):null;
 const actions=p=>(helpers.editable===false?'':'<button type="button" class="text-button" data-ac="edit-product" data-id="'+esc(p.id)+'">Düzenle</button>')+'<button type="button" class="text-button" data-ac="stock-history" data-id="'+esc(p.id)+'">Hareketler →</button>';
 // SATIŞ VE KÂR (bugüne kadar, kâr raporuyla aynı hesap): satılan adet iadeler düşülmüş; ciro ve kâr KDV dahil.
 const st=p=>data.productStats?.get(p.id)||null;
 const kar=v=>v==null?'—':'<span class="'+(v<0?'ol-neg':'ol-pos')+'">'+money(v)+'</span>';
 const tahminNot=p=>st(p)?.tahmini_paket?'<small>'+st(p).tahmini_paket+' paketin kesintisi tahmini</small>':'';
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
  const value=list.reduce((s,p)=>s+(gross(p,p.value_cents)||0),0);
  const eksi=list.filter(p=>p.quantity_milli<0).length;
  return '<div class="brand-head"><h2>'+esc(b||'Markası belirtilmemiş')+'</h2><span>'+list.length+' ürün · eldeki '+qty(onHand)+' · stok değeri '+money(value)+' (KDV dahil)'+(eksi?' · <b>'+eksi+' üründe eksi stok</b>':'')+'</span></div>';
 };
 const tableRows=list=>list.map(p=>'<tr><td>'+esc(p.name)+'<small>'+esc(p.sku)+'</small></td><td>'+esc(p.category||'Kategorisiz')+'</td><td>'+esc(supplier(p))+'</td><td>'+qty(p.quantity_milli)+' '+esc(p.stock_unit)+'</td><td>'+qty(p.reserved_milli||0)+'</td><td>'+qty(available(p))+'</td><td>'+money(gross(p,p.average_purchase_cents))+tag(p)+'</td><td>'+money(gross(p,cost(p)))+tag(p)+'</td>'+(data.productStats?'<td>'+(st(p)?qty(st(p).adet_milli):'0')+'</td><td>'+(st(p)?money(st(p).ciro_cents):'—')+'</td><td>'+(st(p)?kar(st(p).kar_cents)+tahminNot(p):'—')+'</td><td>'+(st(p)?kar(st(p).kar_adet_cents):'—')+'</td>':'<td>'+money(gross(p,price(p)))+tag(p)+'</td>')+'<td>'+actions(p)+'</td></tr>').join('');
 if(state.stockView==='table')return keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="card table-wrap"><table class="ac-table"><thead><tr>'+['Ürün / Kod','Kategori','Tedarikçi','Eldeki','Ayrılan','Kullanılabilir','Ort. alış (KDV dahil)','Birim stok maliyeti (KDV dahil)',...(data.productStats?['Satılan adet','Ciro (KDV dahil)','Toplam kâr','Adet başı kâr']:['Ort. satış (KDV dahil)']),'İşlem'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+tableRows(groups.get(b))+'</tbody></table></div></section>').join('');
 const tile=p=>'<article class="card product-tile"><div class="product-eyebrow"><span>'+esc(p.category||'Kategorisiz')+'</span><span class="pill '+(p.quantity_milli<=0?'warning':'neutral')+'">'+status(p)+'</span></div><h2>'+esc(p.name)+'</h2><p class="muted">'+esc(p.sku)+'</p><p class="product-supplier">'+esc(supplier(p))+'</p><dl><div><dt>Kullanılabilir</dt><dd>'+qty(available(p))+' '+esc(p.stock_unit)+'</dd></div><div><dt>Eldeki / ayrılan</dt><dd>'+qty(p.quantity_milli)+' / '+qty(p.reserved_milli||0)+'</dd></div><div><dt>Ort. alış fiyatı</dt><dd>'+money(gross(p,p.average_purchase_cents))+tag(p)+'</dd></div><div><dt>Birim stok maliyeti</dt><dd>'+money(gross(p,cost(p)))+tag(p)+'</dd></div><div><dt>Ort. satış fiyatı</dt><dd>'+money(gross(p,price(p)))+tag(p)+'</dd></div><div><dt>Stok değeri</dt><dd>'+money(gross(p,p.value_cents))+tag(p)+'</dd></div>'+(data.productStats?'</dl><dl class="product-sales"><div><dt>Satılan</dt><dd>'+(st(p)?qty(st(p).adet_milli):'0')+' '+esc(p.stock_unit)+'</dd></div><div><dt>Ciro</dt><dd>'+(st(p)?money(st(p).ciro_cents):'—')+'</dd></div><div><dt>Toplam kâr</dt><dd>'+(st(p)?kar(st(p).kar_cents):'—')+'</dd></div><div><dt>Adet başı kâr</dt><dd>'+(st(p)?kar(st(p).kar_adet_cents):'—')+'</dd></div>':'')+'</dl><div class="product-actions">'+actions(p)+'</div></article>';
 return '<p class="help">Tutarlar KDV dahildir.</p>'+keys.map(b=>'<section class="brand-group">'+head(b,groups.get(b))+'<div class="product-grid">'+groups.get(b).map(tile).join('')+'</div></section>').join('');
}
