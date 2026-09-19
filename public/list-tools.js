
// Presentation-only controls. No network calls or business record mutations.
//
// SADE TABLO ARAÇLARI. Bütün sayfalardaki tablolara aynı üç şey eklenir:
//  1. "Sırala" seçimi: tutar sütunlarında büyükten küçüğe / küçükten büyüğe, tarihlerde yeniden
//     eskiye, metinde A→Z. Başlığa tıklamak da sıralar (geniş ekranda).
//  2. 8+ satırlı tablolarda tek arama (sayfanın kendi araması varsa eklenmez).
//  3. SIĞMAYAN TABLO SAĞA KAYMAZ: tablo kabından genişse satırlar "etiket değer" düzeninde
//     alt alta akar (lt-stack). Kullanıcı yatay kaydırma istemiyor; ekran boyu değişince yeniden ölçülür.
// Kendi araçları olan tablo data-list-tools="off" ile tamamen dışarıda kalır. Sunucuda sıralanan
// sayfalı tablo data-list-sort="server" ile yalnız sığdırma ve etiket alır (sayfa kendi sıralar).
const text=cell=>cell?.innerText?.trim()||'';
const ilkSatir=cell=>text(cell).split('\n')[0].trim();
const folded=value=>value.toLocaleLowerCase('tr-TR');
const SAYI=/^[-−]?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^[-−]?\d+(?:,\d+)?$/;
export function sortValue(value){
 const v=value.replace(/₺|TL|TRY/g,'').replace(/\s*(adet|kg|gr|g|lt|l|ml|m|paket|koli)\.?$/i,'').replace(/^%\s*|\s*%$/g,'').trim();
 const date=/^(\d{2})[./](\d{2})[./](\d{4})/.exec(v);if(date)return date[3]+date[2]+date[1];
 if(/^\d{4}-\d{2}-\d{2}/.test(v))return v.slice(0,10).replaceAll('-','');
 if(SAYI.test(v))return Number(v.replace('−','-').replaceAll('.','').replace(',','.'));
 return folded(v);
}
// Sütun türü: çoğunluğu tarihse tarih, sayıysa tutar/sayı, değilse metin.
export function columnKind(values){
 const dolu=values.filter(Boolean);if(!dolu.length)return 'metin';
 const tarih=dolu.filter(v=>/^(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2})/.test(v)).length;
 if(tarih/dolu.length>=.7)return 'tarih';
 const sayi=dolu.filter(v=>typeof sortValue(v)==='number').length;
 if(sayi/dolu.length>=.7)return dolu.some(v=>/₺|TL/.test(v))?'tutar':'sayi';
 return 'metin';
}
const SECENEK={tutar:[['desc','büyükten küçüğe'],['asc','küçükten büyüğe']],sayi:[['desc','çoktan aza'],['asc','azdan çoğa']],tarih:[['desc','yeniden eskiye'],['asc','eskiden yeniye']],metin:[['asc','A → Z']]};
export const gecerli=(v,kind)=>kind==='metin'?v!=='':kind==='tarih'?/^\d{8}$/.test(v):typeof v==='number';
const make=(tag,content,cls)=>{const e=document.createElement(tag);if(content)e.textContent=content;if(cls)e.className=cls;return e;};
export function enhanceLists(){
 for(const table of document.querySelectorAll('main table:not([data-list-tools]),dialog table:not([data-list-tools])')){
  if(table.closest('form')||table.querySelector('input,select,textarea')||!table.tHead||table.tBodies.length!==1)continue;
  const rows=[...table.tBodies[0].rows],heads=[...table.tHead.rows[0].cells];
  if(heads.length<2||rows.some(r=>r.cells.length!==heads.length||[...r.cells].some(c=>c.colSpan>1||c.rowSpan>1)))continue;
  table.dataset.listTools='true';
  const sunucu=table.dataset.listSort==='server';
  const state={column:-1,ascending:true,kind:'metin'};
  const host=table.closest('.table-wrap,.v2-table-wrap')||table;
  // Kart düzeni için hücre etiketleri (CSS data-label kullanır).
  heads.forEach((h,i)=>{const label=text(h).replace(/[↕▲▼]/g,'').trim();rows.forEach(r=>r.cells[i].dataset.label=label||'İşlem');});
  const kendiArama=table.closest('main,dialog')?.querySelector('input[type=search]:not(.list-tools input),input[name=q],input[name=search]');
  const bar=make('div',null,'list-tools');
  let search=null,select=null;
  if(rows.length>=8&&!table.closest('dialog')&&!kendiArama){
   search=make('input');search.type='search';search.placeholder='Listede ara…';search.setAttribute('aria-label','Bu listedeki satırlarda ara');
   bar.append(search);search.addEventListener('input',apply);
  }
  // Sıralanabilir sütunlar: işlem ve boş başlıklar dışında hepsi; tür hücrelerden anlaşılır.
  const sutunlar=sunucu||rows.length<3?[]:heads.map((h,i)=>({i,label:text(h).replace(/[↕▲▼]/g,'').trim(),kind:columnKind(rows.map(r=>ilkSatir(r.cells[i])))}))
   // İşlem sütunu ve yalnız düğme taşıyan sütun sıralanmaz. /işlem/i 'İşlem' ile eşleşmez (Türkçe İ): tr-TR küçültülür.
   .filter(s=>s.label&&!folded(s.label).includes('işlem')&&!heads[s.i].querySelector('button,a')&&!rows.every(r=>!ilkSatir(r.cells[s.i])||r.cells[s.i].querySelector('button')));
  if(sutunlar.length){
   const label=make('label',null,'list-sort-select');label.append(make('span','Sırala'));
   select=make('select');select.setAttribute('aria-label','Listeyi sırala');
   select.append(new Option('Varsayılan sıra',''));
   // Tutar sütunları önce: en çok aranan "büyükten küçüğe".
   const sira={tutar:0,tarih:1,sayi:2,metin:3};
   for(const s of [...sutunlar].sort((a,b)=>sira[a.kind]-sira[b.kind]))for(const [yon,ad] of SECENEK[s.kind])select.append(new Option(s.label+': '+ad,s.i+':'+yon));
   label.append(select);bar.append(label);
   select.addEventListener('change',()=>{const [i,yon]=select.value.split(':');state.column=select.value?Number(i):-1;state.ascending=yon==='asc';state.kind=sutunlar.find(s=>s.i===state.column)?.kind||'metin';basliklar();apply();});
  }
  if(bar.childElementCount)host.before(bar);
  const basliklar=()=>heads.forEach((x,j)=>x.hasAttribute('aria-sort')&&x.setAttribute('aria-sort',j===state.column?(state.ascending?'ascending':'descending'):'none'));
  for(const s of sutunlar){
   const h=heads[s.i],b=make('button',s.label,'list-sort');b.type='button';b.setAttribute('aria-label',s.label+' alanına göre sırala');h.textContent='';h.append(b);h.setAttribute('aria-sort','none');
   // İlk tıklama tutar ve tarihte büyükten küçüğe, metinde A→Z.
   b.addEventListener('click',()=>{state.ascending=state.column===s.i?!state.ascending:s.kind==='metin';state.column=s.i;state.kind=s.kind;basliklar();
    if(select){const v=s.i+':'+(state.ascending?'asc':'desc');if([...select.options].some(o=>o.value===v))select.value=v;else select.selectedIndex=0;}apply();});
  }
  const empty=make('p','Aramaya uyan satır yok.','list-empty');empty.hidden=true;host.after(empty);
  function apply(){
   const query=search?folded(search.value.trim()):'';
   const i=state.column,sorted=i<0?rows:[...rows].sort((a,b)=>{const x=sortValue(ilkSatir(a.cells[i])),y=sortValue(ilkSatir(b.cells[i]));
    // Boş ya da türüne uymayan hücre ("Eksik veri", "—") her iki yönde de sona.
    const gx=gecerli(x,state.kind),gy=gecerli(y,state.kind);if(!gx||!gy)return gx===gy?0:gx?-1:1;
    const n=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'tr',{numeric:true});return state.ascending?n:-n;});
   sorted.forEach(r=>table.tBodies[0].append(r));
   let shown=0;for(const row of rows){const visible=!query||folded(text(row)).includes(query);row.hidden=!visible;if(visible)shown++;}
   empty.hidden=shown>0;
  }
  // Sığdırma: doğal genişlik kabı aşıyorsa satır düzenine geç. Ölçüm sınıf kaldırılarak yapılır.
  const kap=host===table?table.parentElement:host;
  const sigdir=()=>{table.classList.remove('lt-stack');table.classList.toggle('lt-stack',table.scrollWidth>kap.clientWidth+4);};
  sigdir();
  if('ResizeObserver' in window){let son=kap.clientWidth,bekleyen=0;new ResizeObserver(()=>{if(Math.abs(kap.clientWidth-son)<6||bekleyen)return;bekleyen=requestAnimationFrame(()=>{bekleyen=0;son=kap.clientWidth;sigdir();});}).observe(kap);}
 }
}
