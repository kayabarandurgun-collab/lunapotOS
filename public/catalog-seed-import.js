// Adapter for an authenticated SAME-ORIGIN client. No credentials, network default,
// SQL access or automatic posting. Sequential, resumable catalog-only writes.
export async function importCatalog(plan,client,{dryRun=true,acceptEstimatedRevenueAllocation=false}={}){
 if(plan.version!==1||!Array.isArray(plan.products)||!Array.isArray(plan.listings))throw Error('Katalog sürümü geçersiz.');
 const snapshot=await client('/catalog');
 const familySnapshot=await client('/invoices/families');
 if(snapshot.truncated)throw Error('Tüm bağlantılar yüklenemedi. İçe aktarmadan önce sayfalama eklenmeli.');
 const skus=new Set(),codes=new Set();
 for(const p of plan.products){if(!p.sku||skus.has(p.sku)||p.stock_unit!=='adet'||!['Klasmann','Tropikal','Gartengold'].includes(p.brand)||/saksı/i.test(p.name))throw Error('Ürün kimliği çakışıyor veya kapsam dışı.');skus.add(p.sku);}
 for(const l of plan.listings){const key=l.source+'|'+l.external_code;if(l.source!=='trendyol'||!l.external_code||codes.has(key))throw Error('İlan kodu çakışıyor.');codes.add(key);if(!l.components.length||l.components.length>10||new Set(l.components.map(c=>c.sku)).size!==l.components.length||l.components.some(c=>!skus.has(c.sku)||!Number.isSafeInteger(c.units)||c.units<=0||c.quantity_milli!==c.units*1000||!Number.isSafeInteger(c.revenue_share_bps)||c.revenue_share_bps<0)||l.components.reduce((s,c)=>s+c.revenue_share_bps,0)!==10000)throw Error('Set bileşeni veya dağılımı geçersiz.');}
 const report={dryRun,productsCreated:[],productsReused:[],mappingsCreated:[],mappingsReused:[],familiesCreated:[],familiesReused:[],pending:[...plan.pending],conflicts:[]};
 const ids=new Map();
 const signature=cs=>JSON.stringify(cs.map(c=>[c.product_id,c.quantity_milli,c.revenue_share_bps]).sort((a,b)=>a[0].localeCompare(b[0])));
 // Preflight every existing identity before any writes.
 for(const p of plan.products){const matches=snapshot.products.filter(x=>x.sku===p.sku);if(!matches.length&&snapshot.products.some(x=>String(x.name).trim().toLocaleLowerCase('tr-TR')===p.name.trim().toLocaleLowerCase('tr-TR')))report.conflicts.push({sku:p.sku,reason:'Aynı adlı mevcut kart farklı kod kullanıyor; yeni kart açmadan kimlik eşleştirilmeli.'});if(matches.length>1||matches.some(x=>x.stock_unit!==p.stock_unit||x.name!==p.name))report.conflicts.push({sku:p.sku,reason:'Var olan kartın kimliği farklı; otomatik üzerine yazılmaz.'});else if(matches.length){ids.set(p.sku,matches[0].id);report.productsReused.push(p.sku);}else ids.set(p.sku,'planned:'+p.sku);}
 const applicable=[];
 for(const l of plan.listings){
  if(l.status!=='ready'||l.revenue_policy==='proposed_equal_physical_units'&&!acceptEstimatedRevenueAllocation){report.pending.push({source_row:l.source_row,external_code:l.external_code,reason:l.status!=='ready'?l.evidence:'Karma setin yönetimsel gelir dağıtımı henüz kabul edilmedi.'});continue;}
  const matches=snapshot.mappings.filter(m=>m.active&&m.source===l.source&&m.match_by==='code'&&m.match_value===l.external_code);
  const desired=l.components.map(c=>({product_id:ids.get(c.sku),quantity_milli:c.quantity_milli,revenue_share_bps:c.revenue_share_bps}));
  if(matches.length>1||matches.length===1&&signature(snapshot.components.filter(c=>c.mapping_id===matches[0].id))!==signature(desired))report.conflicts.push({external_code:l.external_code,reason:'Etkin bağlantı farklı; sürümle değiştirilmeli.'});
  else if(matches.length)report.mappingsReused.push(l.external_code);else applicable.push(l);
 }
 const newFamilies=[];
 for(const family of plan.families||[]){
  if(family.stock_unit!=='adet'||family.allocation_required!==true||!Array.isArray(family.skus)||!family.skus.length||family.skus.some(s=>!skus.has(s))||new Set(family.skus).size!==family.skus.length)throw Error('Ürün ailesi geçersiz.');
  const matches=familySnapshot.families.filter(f=>f.name===family.name&&f.size_label===family.size_label);
  if(matches.length>1||matches.length===1&&(matches[0].stock_unit!=='adet'||matches[0].allocation_required!==1||JSON.stringify(matches[0].members.map(m=>m.sku).sort())!==JSON.stringify([...family.skus].sort())))report.conflicts.push({sku:family.name+' '+family.size_label,reason:'Ürün ailesinin üyeleri veya birimi farklı.'});
  else if(matches.length)report.familiesReused.push(family.size_label);else newFamilies.push(family);
 }
 if(report.conflicts.length)return report;
 for(const p of plan.products){if(!ids.get(p.sku).startsWith('planned:'))continue;if(!dryRun){const {source_rows,...body}=p;const r=await client('/products',body);if(!r?.id)throw Error('Ürün kayıt yanıtı doğrulanamadı: '+p.sku);ids.set(p.sku,r.id);}report.productsCreated.push(p.sku);}
 for(const l of applicable){if(!dryRun)await client('/catalog/mappings',{source:l.source,match_by:'code',external_code:l.external_code,external_name:l.external_name,components:l.components.map(c=>({product_id:ids.get(c.sku),quantity_milli:c.quantity_milli,revenue_share_bps:c.revenue_share_bps}))});report.mappingsCreated.push(l.external_code);}
 for(const family of newFamilies){if(!dryRun)await client('/invoices/families',{name:family.name,size_label:family.size_label,stock_unit:'adet',allocation_required:true,product_ids:family.skus.map(s=>ids.get(s))});report.familiesCreated.push(family.size_label);}
 return report;
}
