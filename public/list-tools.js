
// Presentation-only controls. No network calls or business record mutations.
//
// SADE TABLO ARAÇLARI. Önceden her tabloya arama, durum/kategori seçicileri, "Temizle", "Kart
// görünümü", satır kutucukları, "Seçilenleri indir" ve satır sayacı ekleniyordu; sayfaların kendi
// filtreleri de olduğu için ekranda iki ayrı filtre duruyor, tablo kalabalıklaşıyordu.
// Artık yalnız: başlığa tıklayınca sıralama ve uzun tablolarda (15+ satır) tek bir küçük arama.
// Kendi araçları olan tablo data-list-tools="off" ile tamamen dışarıda kalır.
const text=cell=>cell?.innerText?.trim()||'';
const folded=value=>value.toLocaleLowerCase('tr-TR');
export function sortValue(value){
 const v=value.replace(/₺|TL|TRY/g,'').trim();
 const date=/^(\d{2})[./](\d{2})[./](\d{4})$/.exec(v);if(date)return date[3]+date[2]+date[1];
 if(/^-?\d+(?:\.\d{3})*(?:,\d+)?$/.test(v))return Number(v.replaceAll('.','').replace(',','.'));
 return folded(v);
}
const make=(tag,content,cls)=>{const e=document.createElement(tag);if(content)e.textContent=content;if(cls)e.className=cls;return e;};
export function enhanceLists(){
 for(const table of document.querySelectorAll('main table:not([data-list-tools]),dialog table:not([data-list-tools])')){
  if(table.closest('form')||table.querySelector('input,select,textarea')||!table.tHead||table.tBodies.length!==1)continue;
  const rows=[...table.tBodies[0].rows],heads=[...table.tHead.rows[0].cells];
  if(heads.length<2||rows.some(r=>r.cells.length!==heads.length||[...r.cells].some(c=>c.colSpan>1||c.rowSpan>1)))continue;
  table.dataset.listTools='true';
  const state={column:-1,ascending:true};
  const host=table.closest('.table-wrap,.v2-table-wrap')||table;
  // Dar ekranda kart düzeni için hücre etiketleri (CSS data-label kullanır).
  heads.forEach((h,i)=>{const label=text(h);rows.forEach(r=>r.cells[i].dataset.label=label||'İşlem');});
  let search=null;
  if(rows.length>=15&&!table.closest('dialog')){
   const bar=make('div',null,'list-tools');search=make('input');search.type='search';search.placeholder='Tabloda ara…';search.setAttribute('aria-label','Bu tablodaki satırlarda ara');
   bar.append(search);host.before(bar);search.addEventListener('input',apply);
  }
  heads.forEach((h,i)=>{
   const label=text(h);
   if(h.querySelector('button,a')||!label||/işlem/i.test(label))return;
   const b=make('button',label,'list-sort');b.type='button';b.setAttribute('aria-label',label+' alanına göre sırala');h.textContent='';h.append(b);h.setAttribute('aria-sort','none');
   b.addEventListener('click',()=>{state.ascending=state.column===i?!state.ascending:true;state.column=i;heads.forEach(x=>x.setAttribute('aria-sort','none'));h.setAttribute('aria-sort',state.ascending?'ascending':'descending');apply();});
  });
  const empty=make('p','Aramaya uyan satır yok.','list-empty');empty.hidden=true;host.after(empty);
  function apply(){
   const query=search?folded(search.value.trim()):'';
   if(state.column>=0){const i=state.column;const sorted=[...rows].sort((a,b)=>{const x=sortValue(text(a.cells[i])),y=sortValue(text(b.cells[i]));const n=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'tr',{numeric:true});return state.ascending?n:-n;});sorted.forEach(r=>table.tBodies[0].append(r));}
   let shown=0;for(const row of rows){const visible=!query||folded(text(row)).includes(query);row.hidden=!visible;if(visible)shown++;}
   empty.hidden=shown>0;
  }
 }
}
