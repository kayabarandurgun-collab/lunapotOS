export const units = {kg:['mass',1000],g:['mass',1],L:['volume',1000],ml:['volume',1],adet:['count',1],m:['length',1],m2:['area',1]};
export function convert(quantity, from, to) {
  if (!units[from] || !units[to] || units[from][0] !== units[to][0]) throw new Error('Uyumsuz ölçü birimleri.');
  return quantity * units[from][1] / units[to][1];
}
export function calculate(recipe, materials) {
  if (!recipe) return null;
  const lines = recipe.items.map(item => {
    const material = materials.find(m => m.id === item.material_id);
    if (!material) throw new Error('Reçetede bulunamayan hammadde var.');
    return {...item, name:material.name, cost:convert(item.quantity,item.unit,material.unit)*material.price};
  });
  const raw = lines.reduce((s,l)=>s+l.cost,0);
  const waste = raw * recipe.waste_pct / 100;
  const total = raw + waste + recipe.labor + recipe.packaging + recipe.overhead;
  return {lines,raw,waste,total,unitCost:total/recipe.yield_qty};
}
export function pricing(cost, margin, vat, quantity) {
  if (![cost,margin,vat,quantity].every(Number.isFinite) || cost<0 || margin<0 || margin>=100 || vat<0 || vat>100 || quantity<=0) throw new Error('Hesaplama değerlerini kontrol edin.');
  const net = cost/(1-margin/100);
  return {net,gross:net*(1+vat/100),profit:net-cost,orderCost:cost*quantity,orderNet:net*quantity,orderProfit:(net-cost)*quantity};
}
