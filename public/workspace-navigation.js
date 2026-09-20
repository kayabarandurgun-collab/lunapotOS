import {canRoute} from './permissions.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const layouts={
 ec:[['daily','Günlük işler',['overview','orders','stock','performance','pricing']],['flows','Ürün ve rapor işlemleri',['reports','catalog']],['records','Para ve belgeler',['invoices','documents','sales','reconciliation','ledger','bank','offers','expenses']],['manage','Yönetim',['integrations','settings']]],
 lp:[['daily','Günlük işler',['dashboard','production','materialstock','recipes','costs']],['catalog','Ürün ve hammadde',['products','materials','catalog']],['tracking','Takip ve etiket',['barcodes','lots']],['records','Para ve belgeler',['accounts','ledger','offers','reconciliation']],['manage','Yönetim',['settings','ai']]]
};
export function navigationGroups(namespace,titles,user){
 const home=namespace==='ec'?'overview':'dashboard';
 return (layouts[namespace]||[]).map(([key,label,routes])=>({key,label,routes:routes.filter(route=>Object.hasOwn(titles,route)&&(user?.owner||route===home&&!!user&&user[namespace+'_access']!=='none'||canRoute(user,namespace,route)))})).filter(group=>group.routes.length);
}
export function workspaceNavigation(namespace,titles,current,user,icon){
 const link=key=>'<a href="#'+key+'" class="nav-link'+(key===current?' active':'')+'"'+(key===current?' aria-current="page"':'')+'><span class="nav-icon">'+icon(key)+'</span><span class="nav-text">'+esc(titles[key])+'</span>'+(key==='ai'?'<span class="nav-badge">Kapalı</span>':'')+'</a>';
 return navigationGroups(namespace,titles,user).map(group=>group.key==='daily'?'<div class="nav-primary"><div class="nav-label">'+group.label+'</div>'+group.routes.map(link).join('')+'</div>':'<details class="nav-group"'+(group.routes.includes(current)?' open':'')+'><summary><span>'+group.label+'</span><span class="nav-group-indicator" aria-hidden="true">⌄</span></summary><div>'+group.routes.map(link).join('')+'</div></details>').join('');
}
