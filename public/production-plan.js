import {convert} from './costs.js';

// Salt okunur uretim planlamasi. Stok dusmez, parti olusturmaz, rezervasyon yapmaz.
// Tuketim kurali gerceklesen uretimle ayni: recete verimi ve fire orani uygulanir.
// Ayni hammaddenin birden fazla recete satiri toplanir.
function perUnitNeed(recipe,items,materials){
 const need=new Map();
 for(const item of items){
  const material=materials.find(m=>m.id===item.material_id);
  if(!material)continue;
  const inStockUnit=convert(item.quantity,item.unit,material.unit);
  const scaled=inStockUnit/recipe.yield_qty*(1+recipe.waste_pct/100);
  need.set(material.id,(need.get(material.id)||0)+scaled);
 }
 return need;
}

export function productionPlan({recipe,items,materials,balances,quantity}){
 if(!recipe||!recipe.yield_qty)return {rows:[],max_units:0,blocked:true,reason:'Reçete bulunamadı.'};
 const target=Number(quantity);
 const need=perUnitNeed(recipe,items,materials);
 const available=id=>Math.max(0,Number(balances?.[id]||0));
 const rows=[...need].map(([id,per])=>{
  const material=materials.find(m=>m.id===id);
  const neededMilli=Number.isFinite(target)&&target>0?Math.round(per*target*1000):0;
  const have=available(id);
  return {material_id:id,name:material?.name||'Hammadde',unit:material?.unit||'',
   per_unit_milli:Math.round(per*1000),needed_milli:neededMilli,available_milli:have,
   missing_milli:Math.max(0,neededMilli-have)};
 }).sort((a,b)=>b.missing_milli-a.missing_milli||a.name.localeCompare(b.name,'tr'));

 // Eldeki stokla kac adet uretilebilir: her hammadde icin ayri hesaplanir, en dusugu belirler.
 // Bolme, gosterilen birim basi ihtiyac (milli) uzerinden yapilir; boylece kayan nokta
 // artigi yuzunden tam bolunen bir miktar bir eksik gorunmez.
 let max=Infinity;
 for(const row of rows){
  if(row.per_unit_milli<=0)continue;
  max=Math.min(max,Math.floor(row.available_milli/row.per_unit_milli));
 }
 if(!need.size)max=0;
 return {rows,max_units:max===Infinity?null:Math.max(0,max),
  blocked:rows.some(r=>r.missing_milli>0),
  reason:need.size?'':'Reçetede hammadde satırı yok.'};
}
