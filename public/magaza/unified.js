// Shared behavior for the two-page local storefront. Only demo product selections
// are stored in this tab; no customer, payment, login or external API data.
const onHome=document.body.classList.contains('unified-home');
const selectionKey='lunapot-unified-preview-selections-v1';let storageUsable=true;
function saveSelections(){try{sessionStorage.setItem(selectionKey,JSON.stringify({cart:state.cart.map(({id,size,qty})=>({id,size,qty})),favorites:[...state.favorites]}))}catch{storageUsable=false}}
function loadSelections(){try{const raw=JSON.parse(sessionStorage.getItem(selectionKey)||'null');if(!raw||typeof raw!=='object')return;const safe=[];for(const row of (Array.isArray(raw.cart)?raw.cart:[]).slice(0,100)){if(!row||typeof row!=='object')continue;const p=products.find(p=>p.id===row.id);if(!p||!Number.isInteger(row.qty)||row.qty<1||row.qty>99)continue;const sizes=p.category==='toprak'?['Standart']:['Küçük','Büyük'];if(!sizes.includes(row.size))continue;const key=p.id+'-'+row.size,prior=safe.find(x=>x.key===key);if(prior){prior.qty=Math.min(99,prior.qty+row.qty);continue}safe.push({key,id:p.id,size:row.size,qty:row.qty,price:p.price*(row.size==='Büyük'?1.5:1)})}state.cart=safe;state.favorites=new Set((Array.isArray(raw.favorites)?raw.favorites:[]).filter(id=>products.some(p=>p.id===id)))}catch{storageUsable=false}}
loadSelections();
const baseRenderProducts=renderProducts;renderProducts=function(){baseRenderProducts();if(onHome&&state.filter==='all'&&!state.query&&!state.max){[...grid.querySelectorAll('.product-card')].slice(4).forEach(el=>el.remove());document.querySelector('#result-count').textContent='4 seçili ürün'}};
const baseRenderCart=renderCart;renderCart=function(){baseRenderCart();document.querySelectorAll('#cart-dialog .note').forEach(p=>{if(p.textContent.includes('Deneme sepeti yalnızca'))p.textContent=storageUsable?'Deneme sepetin bu sekmede ana sayfa ve mağaza arasında korunur. Gerçek sipariş oluşturulmaz.':'Deneme sepeti bu sayfada kullanılabilir. Tarayıcı depolaması kapalı olduğu için sayfalar arasında korunamaz.'})};
function storeUrl(category,q){const u=new URL('magaza.html',location.href);if(category&&category!=='all')u.searchParams.set('category',category);if(q)u.searchParams.set('q',q.slice(0,120));return u.href}
function navigateStore(category,q){saveSelections();location.assign(storeUrl(category,q))}
document.addEventListener('submit',e=>{if(onHome&&e.target.id==='store-search'){e.preventDefault();e.stopImmediatePropagation();navigateStore('all',document.querySelector('#store-query').value.trim())}},true);
document.addEventListener('click',e=>{if(!onHome)return;const b=e.target.closest('a,button');if(!b)return;if(b.dataset.shopCategory||b.dataset.filter||b.dataset.action==='favorites'){e.preventDefault();e.stopImmediatePropagation();navigateStore(b.dataset.shopCategory||b.dataset.filter||'favorites')}},true);
document.addEventListener('click',()=>saveSelections());window.addEventListener('pagehide',saveSelections);
// Back/forward cache restoration must see additions from the other page.
window.addEventListener('pageshow',e=>{if(e.persisted){loadSelections();renderProducts();updateCount()}});
if(!onHome){const params=new URLSearchParams(location.search),category=params.get('category');if(['all','saksı','toprak','nova','luna','budget','favorites'].includes(category))state.filter=category;state.query=(params.get('q')||'').slice(0,120);document.querySelector('#store-query').value=state.query;}
renderProducts();updateCount();

if(!onHome){const view=new URLSearchParams(location.search).get("view");if(view==="cart"){renderCart();openDialog("cart-dialog")}if(view==="search")openSearch();}
