// Dedicated synthetic records for the local UI preview; never called by the production worker.
export async function seedInsightsPreview(f){
 const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'}),day=n=>new Date(Date.parse(today)+n*86400000).toISOString().slice(0,10);
 const supplier=await f.ok('/ec/suppliers',{name:'Tropikal — sentetik tedarikçi'});
 f.sqlite.prepare("INSERT INTO ec_products(id,name,sku,stock_unit,min_stock_milli,supplier_id) VALUES('signal-food','Tropikal genel bitki besini 225 ml — sentetik','SIGNAL-FOOD','adet',3000,?)").run(supplier.id);
 f.sqlite.exec("INSERT INTO ec_price_profiles(product_id,vat_bps,replacement_cost_cents,packaging_cents,other_cents,withholding_bps,length_mm,width_mm,height_mm,weight_grams,units_per_parcel) VALUES('signal-food',2000,8000,0,0,0,100,100,100,100,1)");
 await f.ok('/ec/stock',{product_id:'signal-food',kind:'opening',quantity:33,unit_cost:80,reference:'SIGNAL-OPEN',occurred_on:day(-40),notes:'Sentetik uyarı doğrulaması'});
 const mapping=await f.ok('/ec/catalog/mappings',{source:'hepsiburada',external_code:'SIGNAL-FOOD',external_name:'Tropikal genel bitki besini 225 ml — sentetik',components:[{product_id:'signal-food',quantity_milli:1000,revenue_share_bps:10000}]});
 f.sqlite.prepare("INSERT INTO ec_warehouse_reorder_settings(product_id,lead_days,cover_days,pack_milli,notes,revision) VALUES('signal-food',3,7,1000,'Yerel uyarı kontrolü',1)").run();
 for(let i=0;i<28;i++){
  const date=day(-27+i),id='SIGNAL-'+String(i).padStart(2,'0');
  const p=await f.ok('/ec/orders',{channel:'hepsiburada',external_id:id,order_no:id,occurred_on:date,lines:[{external_id:id+'-line',mapping_id:mapping.id,sku:'SIGNAL-FOOD',name:'Bitki besini',quantity:1,gross:120,vat_rate:20}]});
  await f.ok('/ec/orders/'+p.id+'/reserve',{});await f.ok('/ec/orders/'+p.id+'/ship',{occurred_on:date,reference:id+'-ship'});
  const sale=f.sqlite.prepare('SELECT c.sale_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=?').get(p.id);
  await f.ok('/ec/sales/'+sale.sale_id+'/fees',{commission:15,shipping:5,other:.10,fees_status:'confirmed'});
  await f.ok('/ec/orders/'+p.id+'/deliver',{occurred_on:date});
 }
}
