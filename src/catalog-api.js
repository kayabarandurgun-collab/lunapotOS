const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const stmt=(db,sql,args=[])=>db.prepare(sql).bind(...args);
const all=async q=>(await q.all()).results;
const text=(v,label,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(label+' alanını kontrol edin.');return v.trim();};
const optional=(v,label,max=200)=>v===undefined||v===null||v===''?'':text(v,label,max);
function identity(input){
 const source=input.source;if(!['trendyol','hepsiburada','purchase','other'].includes(source))fail('Bağlantı kaynağı geçersiz.');
 const mode=input.match_by||'code';if(!['code','name'].includes(mode)||mode==='name'&&source!=='purchase')fail('Ad eşleşmesi yalnızca açıkça tanımlanmış tedarikçi bağlantısında kullanılabilir.');
 const result={source,supplier_id:optional(input.supplier_id,'Tedarikçi',100),match_by:mode,match_value:mode==='name'?text(input.external_name,'Tam fatura satır adı',300):text(input.external_code,'Dış ürün kodu'),source_unit:optional(input.source_unit,'Kaynak birim',30)};
 if(source==='purchase'&&(!result.supplier_id||!result.source_unit))fail('Alış bağlantısında tedarikçi ve fatura birimi gerekli.');
 if(source!=='purchase'&&result.supplier_id)fail('Pazaryeri bağlantısında tedarikçi seçilmez.');
 if(['trendyol','hepsiburada'].includes(source)&&result.source_unit)fail('Pazaryeri kaynak birimini boş bırakın; miktar satılan paket adedidir.');
 return result;
}
const joined='SELECT c.*,p.name product_name,p.sku,p.stock_unit FROM catalog_mapping_components c JOIN products p ON p.id=c.product_id';
export async function resolveMapping(db,input){
 const key=identity(input),matches=await all(stmt(db,'SELECT * FROM catalog_mappings WHERE source=? AND supplier_id=? AND match_by=? AND match_value=? AND source_unit=? AND active=1 LIMIT 2',Object.values(key)));
 if(matches.length>1)fail('Bu dış ürün kodunda çakışan bağlantı var; otomatik eşleştirilmedi.',409);
 if(!matches.length)return null;
 const mapping=matches[0],components=await all(stmt(db,joined+' WHERE c.mapping_id=? ORDER BY c.rowid',[mapping.id]));
 if(!components.length||components.reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000)fail('Kayıtlı ürün bağlantısının dağılımı doğrulanamadı.',409);
 return {mapping,components};
}
export async function resolvePurchaseMappings(db,supplierId,lines){
 const supplier=text(supplierId,'Tedarikçi',100);if(!Array.isArray(lines)||lines.length>40)fail('Alış eşleştirme satır sınırı aşıldı.');
 const data=await all(stmt(db,"SELECT m.*,c.id component_id,c.product_id,c.quantity_milli,c.revenue_share_bps,p.name product_name,p.sku,p.stock_unit FROM catalog_mappings m JOIN catalog_mapping_components c ON c.mapping_id=m.id JOIN products p ON p.id=c.product_id WHERE m.source='purchase' AND m.supplier_id=? AND m.active=1",[supplier]));
 return lines.map(line=>{
  const code=optional(line.external_code,'Dış ürün kodu'),name=optional(line.description,'Fatura satır adı',300),unit=optional(line.invoice_unit,'Fatura birimi',30);if((!code&&!name)||!unit)return null;
  const matches=data.filter(r=>r.match_by===(code?'code':'name')&&r.match_value===(code||name)&&r.source_unit===unit);
  if(matches.length>1)fail('Tedarikçi kodu/birimi çakışıyor; otomatik eşleştirilmedi.',409);if(!matches.length)return null;
  const {component_id,product_id,quantity_milli,revenue_share_bps,product_name,sku,stock_unit,...mapping}=matches[0];
  return {mapping,components:[{id:component_id,mapping_id:mapping.id,product_id,quantity_milli,revenue_share_bps,product_name,sku,stock_unit}]};
 });
}
async function execute(db,statements){try{await db.batch(statements);}catch(error){if(/UNIQUE/.test(error.message))fail('Bu kod ve birim için etkin bağlantı zaten var. Mevcut kaydı sürüm olarak düzenleyin.',409);if(/CATALOG_|FOREIGN KEY/.test(error.message))fail('Ürün bağlantısı geçersiz veya eski sürüm değişmiş; listeyi yenileyin.',409);throw error;}}
export async function catalogApi(request,env,path,readBody){
 if(!path.startsWith('/api/catalog'))return null;
 if(!['ec','lp'].includes(env.WORKSPACE))fail('Çalışma alanı geçersiz.',403);
 const db=env.DB;
 if(path==='/api/catalog'&&request.method==='GET'){
  const [mappings,components,products,suppliers]=await Promise.all([
   all(db.prepare('SELECT * FROM catalog_mappings ORDER BY created_at DESC,rowid DESC LIMIT 1001')),
   all(db.prepare(joined+' WHERE c.mapping_id IN (SELECT id FROM catalog_mappings ORDER BY created_at DESC,rowid DESC LIMIT 1000)')),
   all(db.prepare('SELECT p.id,p.name,p.sku,p.category,p.stock_unit,b.quantity_milli,b.value_cents FROM products p LEFT JOIN stock_balances b ON b.product_id=p.id ORDER BY p.name')),
   all(db.prepare('SELECT id,name,tax_id FROM suppliers ORDER BY name'))
  ]);
  return {mappings:mappings.slice(0,1000),components,products,suppliers,truncated:mappings.length>1000};
 }
 if(path==='/api/catalog/mappings'&&request.method==='POST'){
  const x=await readBody(request),key=identity(x),externalName=key.match_by==='name'?key.match_value:optional(x.external_name,'Dış ürün adı',300),externalCode=key.match_by==='name'?'':key.match_value;
  if(!Array.isArray(x.components)||!x.components.length||x.components.length>10||key.source==='purchase'&&x.components.length!==1)fail('Bağlantı 1–10 stok kartı içermeli; alış bağlantısı tek stok kartına aittir.');
  const ids=new Set(),components=x.components.map(c=>{
   const product=text(c.product_id,'Stok kartı',100);if(ids.has(product))fail('Aynı stok kartını iki kez eklemeyin.');ids.add(product);
   if(!Number.isSafeInteger(c.quantity_milli)||c.quantity_milli<=0||c.quantity_milli>1000000000)fail('Bileşen miktarı pozitif ve en fazla üç ondalık olmalı.');
   if(!Number.isSafeInteger(c.revenue_share_bps)||c.revenue_share_bps<0||c.revenue_share_bps>10000)fail('Gelir payı geçersiz.');
   return {id:crypto.randomUUID(),product_id:product,quantity_milli:c.quantity_milli,revenue_share_bps:c.revenue_share_bps};
  });
  if(components.reduce((sum,c)=>sum+c.revenue_share_bps,0)!==10000)fail('Bileşen gelir payları toplamı %100 olmalı.');
  if(key.source==='purchase'&&!await stmt(db,'SELECT id FROM suppliers WHERE id=?',[key.supplier_id]).first())fail('Tedarikçi bu çalışma alanında bulunamadı.',404);
  const products=await all(stmt(db,'SELECT id,stock_unit FROM products WHERE id IN (SELECT value FROM json_each(?))',[JSON.stringify([...ids])]));
  if(products.length!==ids.size)fail('Stok kartı bu çalışma alanında bulunamadı.',404);
  for(const c of components)if(products.find(p=>p.id===c.product_id).stock_unit==='adet'&&c.quantity_milli%1000!==0)fail('Adet stok kartına kesirli adet bağlanamaz.');
  let old=null;if(x.replaces_id){old=await stmt(db,'SELECT * FROM catalog_mappings WHERE id=? AND active=1',[text(x.replaces_id,'Önceki bağlantı',100)]).first();if(!old)fail('Önceki etkin bağlantı bulunamadı.',409);if(Object.keys(key).some(k=>old[k]!==key[k]))fail('Sürüm düzenlemede kaynak/kod/birim değişmez. Yeni kod için ayrı bağlantı ekleyin.');}
  const id=crypto.randomUUID(),version=old?old.version+1:1,statements=[];
  if(old)statements.push(stmt(db,'UPDATE catalog_mappings SET active=0,archived_at=CURRENT_TIMESTAMP WHERE id=?',[old.id]));
  statements.push(stmt(db,'INSERT INTO catalog_mappings(id,source,supplier_id,match_by,match_value,external_code,external_name,source_unit,version,replaces_id) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,key.source,key.supplier_id,key.match_by,key.match_value,externalCode,externalName,key.source_unit,version,old?.id??null]));
  statements.push(stmt(db,"INSERT INTO catalog_mapping_components(id,mapping_id,product_id,quantity_milli,revenue_share_bps) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.product_id'),json_extract(value,'$.quantity_milli'),json_extract(value,'$.revenue_share_bps') FROM json_each(?)",[id,JSON.stringify(components)]));
  statements.push(stmt(db,'UPDATE catalog_mappings SET active=1 WHERE id=?',[id]));
  statements.push(stmt(db,'INSERT INTO catalog_mapping_audit(id,mapping_id,action,previous_id,snapshot_json) VALUES(?,?,?,?,?)',[crypto.randomUUID(),id,old?'replaced':'created',old?.id??null,JSON.stringify({...key,external_name:externalName,components,version})]));
  await execute(db,statements);return {id,version,replaces_id:old?.id??null};
 }
 const archive=path.match(/^\/api\/catalog\/mappings\/([\w-]+)\/archive$/);
 if(archive&&request.method==='POST'){
  const row=await stmt(db,'SELECT * FROM catalog_mappings WHERE id=?',[archive[1]]).first();if(!row)fail('Bağlantı bulunamadı.',404);if(!row.active)return {id:row.id,archived:true};
  await execute(db,[stmt(db,'UPDATE catalog_mappings SET active=0,archived_at=CURRENT_TIMESTAMP WHERE id=?',[row.id]),stmt(db,'INSERT INTO catalog_mapping_audit(id,mapping_id,action,snapshot_json) VALUES(?,?,?,?)',[crypto.randomUUID(),row.id,'archived',JSON.stringify(row)])]);return {id:row.id,archived:true};
 }
 return null;
}
