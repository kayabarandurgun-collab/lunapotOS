import {dailyTasks,dailyTaskMarkup} from './daily-actions.js';
import {can} from './permissions.js';
import {icon} from './ui-icons.js';
// Kart simgeleri yazı karakteri (↗ ◇ ✎ ▦) değil, panelin kendi çizgi ikonları; amblem ayrı img.
for(const el of document.querySelectorAll('.portal-icon[data-icon]'))el.innerHTML=icon(el.dataset.icon);
// Preserve saved links to the original production panel, including setup links.
if(location.hash.length>1)location.replace('/uretim/'+location.search+location.hash);
document.querySelector('#today').textContent=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric'}).format(new Date());
let prompt=null;
const install=document.querySelector('#install'),status=document.querySelector('#status');
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;install.hidden=false;});
install.addEventListener('click',async()=>{if(!prompt)return;const current=prompt;prompt=null;install.hidden=true;try{await current.prompt();await current.userChoice;}catch{status.textContent='Tarayıcı menüsündeki Ana Ekrana Ekle seçeneğini kullanabilirsin.';}});
window.addEventListener('appinstalled',()=>{prompt=null;install.hidden=true;});
function online(){status.textContent=navigator.onLine?'':'İnternet bağlantısı yok. Kayıtlarını görüntülemek ve kaydetmek için yeniden bağlan.';}
window.addEventListener('online',online);window.addEventListener('offline',online);online();
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});

fetch('/api/auth/status').then(r=>r.json()).then(s=>{
 if(s.user?.owner)document.querySelector('#manage-access').hidden=false;
 const quick=document.querySelector('#quick-start');
 if(s.authenticated&&s.user){const tasks=dailyTasks(s.user,'ec');quick.innerHTML=dailyTaskMarkup(tasks,{prefix:'/eticaret/'});quick.hidden=!tasks.length;}
 if(s.user&&!s.user.owner){if(!can(s.user,'ec','webshop'))document.querySelector('.application.webstore').hidden=true;for(const [ns,selector] of [['lp','.application.production'],['ec','.application.commerce']])if(s.user[ns+'_access']==='none')document.querySelector(selector).hidden=true;}
}).catch(()=>{});
