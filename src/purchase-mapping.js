import {resolvePurchaseMappings} from './catalog-api.js';
import {milli} from '../public/accounting-math.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409});};

// A saved supplier conversion applies to one invoice unit. Amounts are not changed.
export function purchaseQuantity(invoiceQuantity,componentQuantity){
 const source=milli(invoiceQuantity),product=source*componentQuantity;
 if(!Number.isSafeInteger(product)||product%1000!==0||product/1000>1000000000||product<=0)fail('Tedarikçi birim dönüşümü stok hassasiyetine uygun değil. Bağlantıyı kontrol edin.');
 return product/1000;
}
export async function applyPurchaseMappings(db,supplierId,lines,{autoAssign=true,existing=[]}={}){
 const candidates=await resolvePurchaseMappings(db,supplierId,lines);
 return lines.map((line,index)=>{
  if(line.line_type==='expense')return {...line,catalog_mapping_id:null};
  const prior=existing.find(old=>old.id===line.id),candidate=candidates[index],requested=line.catalog_mapping_id||null;
  if(requested&&prior?.catalog_mapping_id===requested&&prior.product_id===line.product_id&&prior.quantity_milli===milli(line.stock_quantity))return {...line,catalog_mapping_id:requested};
  if(requested&&candidate?.mapping.id!==requested)fail('Kayıtlı tedarikçi bağlantısı değişmiş. Güncel bağlantıları tekrar uygulayın.');
  if(!requested&&(!autoAssign||line.product_id||!candidate))return {...line,catalog_mapping_id:null};
  if(!candidate||candidate.components.length!==1)fail('Alış bağlantısı tek stok kartına bağlanmalı.');
  const component=candidate.components[0],quantity=purchaseQuantity(line.invoice_quantity,component.quantity_milli);
  if(requested&&((line.product_id&&line.product_id!==component.product_id)||(line.stock_quantity!=null&&milli(line.stock_quantity)!==quantity)))fail('Stok kartı veya miktarı kayıtlı tedarikçi dönüşümüyle uyuşmuyor. Bağlantıyı yeniden uygulayın veya elle eşleştirin.');
  return {...line,product_id:component.product_id,stock_quantity:quantity/1000,catalog_mapping_id:candidate.mapping.id};
 });
}
