export function parseInvoiceXML(source){
 if(source.length>2000000||/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('XML dosyası çok büyük veya desteklenmeyen bir tanım içeriyor.');
 const doc=new DOMParser().parseFromString(source,'application/xml');
 if(doc.getElementsByTagName('parsererror').length||doc.documentElement.localName!=='Invoice')throw new Error('Geçerli bir UBL fatura XML dosyası seçin.');
 const child=(node,name)=>Array.from(node?.children||[]).find(e=>e.localName===name);
 const children=(node,name)=>Array.from(node?.children||[]).filter(e=>e.localName===name);
 const val=(node,name)=>child(node,name)?.textContent.trim()||'';
 const number=(value,label)=>{if(!/^-?\d+(\.\d+)?$/.test(value))throw new Error(label+' okunamadı.');const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(label+' geçersiz.');return n;};
 const root=doc.documentElement,currency=val(root,'DocumentCurrencyCode'),type=val(root,'InvoiceTypeCode');
 if(currency!=='TRY')throw new Error('Yalnızca TRY faturalar destekleniyor.');
 if(!['SATIS','ISTISNA'].includes(type))throw new Error('Bu fatura türü otomatik içe aktarmaya uygun değil; elle kontrol edilmeli.');
 const supplier=child(child(root,'AccountingSupplierParty'),'Party');
 const identities=children(supplier,'PartyIdentification').map(n=>child(n,'ID'));
 const tax=identities.find(n=>['VKN','TCKN'].includes(n?.getAttribute('schemeID')))?.textContent.trim()||'';
 const name=val(child(supplier,'PartyName'),'Name')||val(child(supplier,'PartyLegalEntity'),'RegistrationName');
 const receiver=child(child(root,'AccountingCustomerParty'),'Party');
 const receiverTax=children(receiver,'PartyIdentification').map(n=>child(n,'ID')).find(n=>['VKN','TCKN'].includes(n?.getAttribute('schemeID')))?.textContent.trim()||'';
 const lines=children(root,'InvoiceLine').map(line=>{
  const item=child(line,'Item'),quantity=child(line,'InvoicedQuantity');
  return {description:val(item,'Name'),external_code:val(child(item,'SellersItemIdentification'),'ID'),invoice_quantity:number(quantity?.textContent.trim()||'','Fatura miktarı'),invoice_unit:quantity?.getAttribute('unitCode')||'adet',net:number(val(line,'LineExtensionAmount'),'Satır net tutarı'),tax:children(line,'TaxTotal').reduce((sum,t)=>sum+number(val(t,'TaxAmount'),'Vergi tutarı'),0)};
 });
 if(!lines.length||lines.length>40)throw new Error('1–40 satırlı faturalar destekleniyor.');
 const totals=child(root,'LegalMonetaryTotal'),net=lines.reduce((s,l)=>s+l.net,0),taxTotal=lines.reduce((s,l)=>s+l.tax,0);
 if(Math.abs(net-number(val(totals,'TaxExclusiveAmount'),'Fatura net toplamı'))>.011||Math.abs(net+taxTotal-number(val(totals,'TaxInclusiveAmount'),'Fatura vergi dahil toplamı'))>.011)throw new Error('Fatura toplamı satırlarla eşleşmiyor. Belge düzeyindeki iskonto, masraf veya vergiler elle incelenmeli.');
 return {invoice_no:val(root,'ID'),uuid:val(root,'UUID'),invoice_date:val(root,'IssueDate'),currency,source:'xml',supplier_name:name,supplier_tax_id:tax,receiver_tax_id:receiverTax,lines};
}
