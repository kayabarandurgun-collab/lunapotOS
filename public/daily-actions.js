import {canRoute} from './permissions.js';
import {icon} from './ui-icons.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const commerce=[
 {id:'intake',route:'intake',write:true,title:'Belge yükle',detail:'Fatura, rapor veya belgeyi buraya bırak',href:'#intake',icon:'intake',words:'alış fatura pdf xml belge rapor excel xlsx csv yükle aktar'},
 {id:'warehouse',route:'stock',title:'Depodaki ürünler',detail:'Elindeki, ayrılmış ve kargodaki stok',href:'#stock',icon:'stock',words:'stok depo depodaki ürünler elimde kaç adet kaldı envanter'},
 {id:'count',route:'warehouse',write:true,title:'Depo sayımı',detail:'Say, kaydet; kaldığın yerden devam et',href:'#warehouse',icon:'warehouse',words:'stok say sayım sayim tedarik eksik mal'},
 {id:'unbilled',route:'stock',requires:'ledger',title:'Faturasız mal girişi',detail:'Mal geldi, faturası sonra gelecek',href:'#stock?action=unbilled',icon:'materialstock',words:'faturasız faturasiz geçici mal giriş teslim depo ekle'}
];
const production=[
 {id:'produce',route:'production',title:'Üretim kayıtları',detail:'Üretim emri, tüketim ve tamamlanan işler',href:'#production',icon:'production',words:'üretim üret üretilecek emir'},
 {id:'materials',route:'materialstock',title:'Hammadde deposu',detail:'Depodaki miktarlar ve mal hareketleri',href:'#materialstock',icon:'materialstock',words:'stok depo hammadde mal giriş'},
 {id:'recipes',route:'recipes',title:'Reçeteler',detail:'Ürün içeriği ve üretim tarifi',href:'#recipes',icon:'recipes',words:'reçete tarif karışım'},
 {id:'purchases',route:'accounts',title:'Alış ve stok',detail:'Üretim alanının faturaları ve ürün stoğu',href:'#accounts',icon:'invoices',words:'alış fatura mal giriş stok'}
];
export function dailyTasks(user,namespace='ec'){
 return (namespace==='ec'?commerce:namespace==='lp'?production:[]).filter(t=>canRoute(user,namespace,t.route,!!t.write)&&(!t.requires||canRoute(user,namespace,t.requires,true)));
}
export function dailyTaskMarkup(tasks,{prefix='',heading=true}={}){
 if(!tasks.length)return '';
 return (heading?'<div class="daily-heading"><div><span class="eyebrow">GÜNLÜK İŞLER</span><h2>Hızlı işlemler</h2></div><span>Doğrudan işine başla</span></div>':'')+'<nav class="daily-tasks" aria-label="Günlük işlemler">'+tasks.map(t=>'<a class="daily-task" data-daily-task="'+esc(t.id)+'" href="'+esc(prefix+t.href)+'" data-navigation-title="'+esc(t.title)+'" data-navigation-words="'+esc(t.words)+'"><span class="daily-task-icon">'+icon(t.icon)+'</span><div><strong>'+esc(t.title)+'</strong><small>'+esc(t.detail)+'</small></div><span class="daily-task-arrow" aria-hidden="true">↗</span></a>').join('')+'</nav>';
}
