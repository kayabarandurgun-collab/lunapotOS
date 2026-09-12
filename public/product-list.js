
export const BRANDS=['Klasmann','Tropikal','Gartengold'];
export const CATEGORIES=['Torf ve yetiştirme ortamı','Bitki besini','Toprak düzenleyici','Bitki bakım ürünü','Saksı ve aksesuar'];
const norm=s=>String(s||'').toLocaleLowerCase('tr-TR');
export function selectProducts(products,state){
 const result=products.filter(p=>(!state.stockQuery||norm([p.name,p.sku,p.brand,p.category].join(' ')).includes(norm(state.stockQuery)))&&(!state.stockBrand||p.brand===state.stockBrand)&&(!state.stockCategory||p.category===state.stockCategory)&&(!state.stockSupplier||p.supplier_id===state.stockSupplier)&&(!state.stockFilter||(state.stockFilter==='empty'?p.quantity_milli===0:p.quantity_milli-(p.reserved_milli||0)<=p.min_stock_milli)));
 const sort=state.stockSort||'brand';
 return result.sort((a,b)=>sort==='quantity'?b.quantity_milli-a.quantity_milli:sort==='available'?(b.quantity_milli-(b.reserved_milli||0))-(a.quantity_milli-(a.reserved_milli||0)):sort==='value'?(b.value_cents??-1)-(a.value_cents??-1):sort==='brand'?(a.brand||'ZZZ').localeCompare(b.brand||'ZZZ','tr')||a.name.localeCompare(b.name,'tr'):a.name.localeCompare(b.name,'tr'));
}
export function saleAverage(sales,productId){
 const rows=sales.filter(s=>s.product_id===productId);
 if(!rows.length||rows.some(s=>s.revenue_cents==null))return null;
 const quantity=rows.reduce((sum,s)=>sum+(s.kind==='return'?-1:1)*s.quantity_milli,0);
 return quantity>0?Math.round(rows.reduce((sum,s)=>sum+s.revenue_cents,0)*1000/quantity):null;
}
export function productList(products,data,state,helpers){
 const {esc,money,qty}=helpers;
 const supplier=p=>data.suppliers.find(s=>s.id===p.supplier_id)?.name||'Tedarikçi seçilmedi';
 const price=p=>saleAverage(data.sales,p.id);
 const available=p=>p.quantity_milli-(p.reserved_milli||0);
 const cost=p=>p.quantity_milli>0&&p.value_cents!=null?Math.round(p.value_cents*1000/p.quantity_milli):null;
 const actions=p=>(helpers.editable===false?'':'<button type="button" class="text-button" data-ac="edit-product" data-id="'+esc(p.id)+'">Düzenle</button>')+'<button type="button" class="text-button" data-ac="stock-history" data-id="'+esc(p.id)+'">Hareketler →</button>';
 const status=p=>p.quantity_milli===0?'Stok yok':available(p)<=p.min_stock_milli?'Kritik stok':'Stokta';
 if(!products.length)return '<div class="card product-empty"><h2>Bu seçimde ürün bulunamadı</h2><p>Filtreleri temizleyebilir veya ürün listesini içe aktarmak için hazırlayabilirsin.</p></div>';
 if(state.stockView==='table')return '<div class="card table-wrap"><table class="ac-table"><thead><tr>'+['Ürün / Kod','Marka','Kategori','Tedarikçi','Eldeki','Ayrılan','Kullanılabilir','Ort. alış fiyatı','Ort. stok maliyeti','Ort. net satış','İşlem'].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+products.map(p=>'<tr><td>'+esc(p.name)+'<small>'+esc(p.sku)+'</small></td><td>'+esc(p.brand||'Belirtilmedi')+'</td><td>'+esc(p.category||'Kategorisiz')+'</td><td>'+esc(supplier(p))+'</td><td>'+qty(p.quantity_milli)+' '+esc(p.stock_unit)+'</td><td>'+qty(p.reserved_milli||0)+'</td><td>'+qty(available(p))+'</td><td>'+money(p.average_purchase_cents)+'</td><td>'+money(cost(p))+'</td><td>'+money(price(p))+'</td><td>'+actions(p)+'</td></tr>').join('')+'</tbody></table></div>';
 return '<div class="product-grid">'+products.map(p=>'<article class="card product-tile"><div class="product-eyebrow"><span>'+esc(p.brand||'Marka belirtilmedi')+'</span><span class="pill neutral">'+status(p)+'</span></div><h2>'+esc(p.name)+'</h2><p class="muted">'+esc(p.sku)+' · '+esc(p.category||'Kategorisiz')+'</p><p class="product-supplier">'+esc(supplier(p))+'</p><dl><div><dt>Kullanılabilir</dt><dd>'+qty(available(p))+' '+esc(p.stock_unit)+'</dd></div><div><dt>Eldeki / ayrılan</dt><dd>'+qty(p.quantity_milli)+' / '+qty(p.reserved_milli||0)+'</dd></div><div><dt>Ort. alış fiyatı</dt><dd>'+money(p.average_purchase_cents)+'</dd></div><div><dt>Ort. stok maliyeti</dt><dd>'+money(cost(p))+'</dd></div><div><dt>Ort. net satış</dt><dd>'+money(price(p))+'</dd></div></dl><div class="product-actions">'+actions(p)+'</div></article>').join('')+'</div>';
}
