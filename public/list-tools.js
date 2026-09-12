
// Presentation-only controls. No network calls or business record mutations.
const states=new WeakMap();
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
  const bar=make('div',null,'list-tools');const search=make('input');search.type='search';search.placeholder='Bu sayfadaki satırlarda ara';search.setAttribute('aria-label','Bu tablodaki satırlarda ara');
  const clear=make('button','Temizle','secondary');clear.type='button';
  const count=make('span',null,'list-count');count.setAttribute('role','status');
  const card=make('button','Kart görünümü','secondary');card.type='button';card.setAttribute('aria-pressed','false');
  const selected=new Set();
  const exportButton=make('button','Seçilenleri indir','secondary');exportButton.type='button';exportButton.disabled=true;
  const selectHead=make('th');const selectAll=make('input');selectAll.type='checkbox';selectAll.setAttribute('aria-label','Bu sayfadaki görünen satırları seç');selectHead.append(selectAll);table.tHead.rows[0].prepend(selectHead);
  const checkboxes=new Map();for(const r of rows){const cell=make('td');cell.className='list-select-cell';const box=make('input');box.type='checkbox';box.setAttribute('aria-label',text(r.cells[0])+' satırını seç');cell.append(box);r.prepend(cell);checkboxes.set(r,box);box.addEventListener('change',()=>{if(box.checked)selected.add(r);else selected.delete(r);selection();});}
  function selection(){const visible=rows.filter(r=>!r.hidden);selectAll.checked=visible.length>0&&visible.every(r=>selected.has(r));selectAll.indeterminate=visible.some(r=>selected.has(r))&&!selectAll.checked;exportButton.disabled=!selected.size;exportButton.textContent='Seçilenleri indir ('+selected.size+')';}
  selectAll.addEventListener('change',()=>{for(const r of rows.filter(r=>!r.hidden)){checkboxes.get(r).checked=selectAll.checked;if(selectAll.checked)selected.add(r);else selected.delete(r);}selection();});
  exportButton.addEventListener('click',()=>{const csvCell=v=>'"'+(/^[\s]*[=+@-]/.test(v)?"'"+v:v).replaceAll('"','""')+'"';const data=[heads.map(h=>text(h).replace(/ ↕$/,'')),...[...table.tBodies[0].rows].filter(r=>selected.has(r)).map(r=>[...r.cells].slice(1).map(text))];const url=URL.createObjectURL(new Blob(['\ufeff'+data.map(r=>r.map(csvCell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=make('a');a.href=url;a.download='secilen-kayitlar.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  const state={rows,search:'',column:-1,ascending:true,filters:[]};states.set(table,state);
  const host=table.closest('.table-wrap,.v2-table-wrap')||table;host.before(bar);bar.append(search);
  heads.forEach((h,i)=>{
   const label=text(h);rows.forEach(r=>r.cells[i+1].dataset.label=label||'İşlem');
   if(h.querySelector('button,a')||!label||/işlem/i.test(label))return;
   const b=make('button',label+' ↕','list-sort');b.type='button';b.setAttribute('aria-label',label+' alanına göre sırala');h.textContent='';h.append(b);h.setAttribute('aria-sort','none');
   b.addEventListener('click',()=>{state.ascending=state.column===i?!state.ascending:true;state.column=i;heads.forEach(x=>x.setAttribute('aria-sort','none'));h.setAttribute('aria-sort',state.ascending?'ascending':'descending');apply();});
   if(/^(durum|kategori|marka|kanal|birim|tedarikçi)$/i.test(label)){
    const values=[...new Set(rows.map(r=>text(r.cells[i+1])))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'tr'));
    if(values.length>1&&values.length<=60){const select=make('select');select.setAttribute('aria-label',label+' filtresi');const all=make('option','Tüm '+label.toLocaleLowerCase('tr-TR'));all.value='';select.append(all);values.forEach(v=>{const opt=make('option',v);opt.value=v;select.append(opt);});bar.append(select);state.filters.push({i,select});select.addEventListener('change',apply);}
   }
  });
  bar.append(clear,card,exportButton,count);
  const empty=make('p','Bu sayfada eşleşen satır yok. Filtreleri temizleyebilirsin.','list-empty');empty.hidden=true;host.after(empty);
  function apply(){
   const query=folded(search.value.trim());
   if(state.column>=0){const i=state.column;const sorted=[...rows].sort((a,b)=>{const x=sortValue(text(a.cells[i+1])),y=sortValue(text(b.cells[i+1]));const n=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'tr',{numeric:true});return state.ascending?n:-n;});sorted.forEach(r=>table.tBodies[0].append(r));}
   let shown=0;for(const row of rows){const visible=(!query||folded(text(row)).includes(query))&&state.filters.every(f=>!f.select.value||text(row.cells[f.i+1])===f.select.value);row.hidden=!visible;if(!visible){selected.delete(row);checkboxes.get(row).checked=false;}if(visible)shown++;}
   selection();count.textContent=shown+' / '+rows.length+' satır · bu sayfa';empty.hidden=shown>0;
  }
  search.addEventListener('input',apply);clear.addEventListener('click',()=>{search.value='';state.filters.forEach(f=>f.select.value='');state.column=-1;heads.forEach(h=>h.setAttribute('aria-sort','none'));rows.forEach(r=>table.tBodies[0].append(r));apply();search.focus();});
  card.addEventListener('click',()=>{const on=table.classList.toggle('list-cards');card.setAttribute('aria-pressed',String(on));card.textContent=on?'Tablo görünümü':'Kart görünümü';});
  apply();
 }
}
