import {effectiveNet} from './purchase-adjustment-api.js';
import {packageProfit} from './package-profit.js';
import {compositionKey,estimatePackage,parcelTemplateKey,useParcelTemplate} from './order-estimate-api.js';
import {kesintiTahmincisi} from './fee-history.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const day=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const all=async s=>(await s.all()).results;
export async function performanceApi(request,env,path){
 if(path!=='/api/performance'||request.method!=='GET')return null;
 if(env.WORKSPACE!=='ec')fail('Kanal kârlılığı e-ticaret alanına aittir.',403);
 const url=new URL(request.url),today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
 const from=day(url.searchParams.get('from')||new Date(Date.parse(today)-30*86400000).toISOString().slice(0,10)),to=day(url.searchParams.get('to')||today);
 if(from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 const mode=url.searchParams.get('mode')||'delivered';if(!['delivered','pending'].includes(mode))fail('Rapor türü geçersiz.');
 // Stopaj pazaryeri hakedisinden DUSULUR (nakit azalir) ama gider degildir: mahsup edilebilir.
// Bu yuzden nakit sonuctan dusulur, KDV haric katkida yer almaz. Kaynagi rapor kaydidir; uydurulmaz.
 // Stopaj SIPARIS duzeyinde bildirilir. Bolunmus siparisin her paketine tamami yazilirsa
 // ayni stopaj birden cok kez dusulur ve kar oldugundan DUSUK gorunur: paket sayisina bolunur.
 // Kayit ayni kanalin magazasindan okunur; siparis numaralari kanallar arasinda karismaz.
 const stopajSql="(SELECT COALESCE(SUM(json_extract(r.data_json,'$.amount_cents')),0) FROM ec_report_records r JOIN ec_report_stores st ON st.id=r.store_id AND st.provider=order_packages.channel WHERE r.kind='finance_event' AND json_extract(r.data_json,'$.type')='withholding' AND json_extract(r.data_json,'$.order_no')=order_packages.order_no) stopaj_cents,(SELECT COUNT(*) FROM order_packages q WHERE q.order_no=order_packages.order_no AND q.channel=order_packages.channel AND q.status!='cancelled') stopaj_paket";
 // Satışın stokta olmadan satılıp henüz alışla kapanmamış (açık) kısmı ve tahmin olup olmadığı.
 const SALES_SQL='SELECT s.*,l.package_id,l.vat_bps satir_kdv,pp.vat_bps,(SELECT o.open_milli-o.settled_milli FROM open_costs o WHERE o.sale_id=s.id) open_milli,(SELECT iif(o.estimate_cents IS NULL,1,0) FROM open_costs o WHERE o.sale_id=s.id) no_estimate FROM sale_entries s JOIN order_line_components c ON (s.id=c.sale_id OR s.parent_id=c.sale_id) JOIN order_lines l ON l.id=c.line_id LEFT JOIN price_profiles pp ON pp.product_id=s.product_id WHERE l.package_id IN (SELECT value FROM json_each(?))';
 const db=env.DB,packages=await all(db.prepare(`SELECT *,${stopajSql} FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND ${mode==='delivered'?"status='delivered' AND delivered_on BETWEEN ? AND ?":"status IN ('draft','reserved','shipped') AND occurred_on BETWEEN ? AND ?"} ORDER BY occurred_on DESC,id LIMIT 1001`).bind(from,to));
 if(packages.length>1000)fail('Bu aralıkta 1.000’den fazla paket var. Eksiksiz toplam için tarih aralığını daraltın.',409);
 // Çift aktarımın asıl kaydı "gönderildi" durumunda kalır ama teslimi kopyasıyla gelmiştir ve
 // teslim edilenlerin kârında ikiz olarak sayılır. Kargodakilerde ikinci kez görünmez.
 if(mode==='pending'&&packages.length){
  const teslimli=new Set((await all(db.prepare("SELECT DISTINCT q.channel||'|'||q.order_no k FROM order_packages q JOIN order_lines l ON l.package_id=q.id JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE q.status='delivered' AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%' AND q.order_no IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...new Set(packages.map(p=>p.order_no))])))).map(r=>r.k));
  for(let i=packages.length-1;i>=0;i--)if(packages[i].status==='shipped'&&teslimli.has(packages[i].channel+'|'+packages[i].order_no))packages.splice(i,1);
 }
 const ids=JSON.stringify(packages.map(p=>p.id));
 const [lines,components,sales,inputs=[],shippingRates=[],commissionRates=[]]=(await db.batch([
  db.prepare('SELECT * FROM order_lines WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT c.*,l.package_id,(SELECT pp.vat_bps FROM price_profiles pp WHERE pp.product_id=c.product_id) urun_kdv,COALESCE((SELECT NULLIF(pp.replacement_cost_cents,0) FROM price_profiles pp WHERE pp.product_id=c.product_id),(SELECT CAST(ROUND(pl.net_cents*1000.0/pl.quantity_milli) AS INTEGER) FROM purchase_lines pl JOIN purchase_invoices pi ON pi.id=pl.invoice_id WHERE pl.product_id=c.product_id AND pi.status='posted' AND pl.line_type='product' AND pl.quantity_milli>0 ORDER BY pi.invoice_date DESC,pi.created_at DESC LIMIT 1)) son_alis,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare(SALES_SQL).bind(ids),
  ...(mode==='pending'?[db.prepare('SELECT * FROM order_estimate_inputs WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT * FROM shipping_rates WHERE archived_at IS NULL LIMIT 1001'),
  db.prepare('SELECT * FROM commission_rates WHERE archived_at IS NULL LIMIT 1001')]:[])
 ])).map(r=>r.results);
 if(shippingRates.length>1000||commissionRates.length>1000)fail('Tarife sayısı sınırı aşıldı. Eski tarifeleri arşivleyin.',409);
 // Kesinti KDV orani UYDURULMAZ: pazaryerinin finans rapor profilinde beyan edilmisse oradan gelir.
 // Beyan yoksa o kanalin nakit sonucu bos birakilir ve sebebi yazilir.
 const feeVatRows=await all(db.prepare("SELECT provider,json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND json_extract(options_json,'$.fee_amounts_include_vat')=1 AND json_extract(options_json,'$.fee_vat_bps') IS NOT NULL"));
 const feeVat=new Map();
 for(const r of feeVatRows){if(feeVat.has(r.provider)&&feeVat.get(r.provider)!==r.bps)feeVat.set(r.provider,null);else if(!feeVat.has(r.provider))feeVat.set(r.provider,r.bps);}
 const group=items=>{const m=new Map();for(const r of items){const list=m.get(r.package_id)||[];list.push(r);m.set(r.package_id,list);}return m;};
 const lineMap=group(lines),partMap=group(components),saleMap=group(sales),inputMap=new Map(inputs.map(r=>[r.package_id,r]));
 // ÇİFT KAYIT İKİZİ. Eski aktarımda aynı pazaryeri paketi panele iki kez girdi: rapor kopyası
 // (teslim bilgisi ve pazaryeri kesintileri) ve satış faturası kaydı (satış ve maliyet). Kopyanın
 // defter satırları "DUZELTME-CIFT" iadesiyle sıfırlandı; asıl satış ikizde kaldı ama ikiz
 // "gönderildi" durumunda olduğu için teslim edilenlerin kârına HİÇ girmiyordu. Kopyanın yerine
 // ikiz hesaplanır: teslim tarihi ve rapor kesintileri kopyadan, satış ve maliyet ikizden.
 // Yalnız rapor okunur; hiçbir kayıt değişmez. İkiz bulunamazsa kopya olduğu gibi kalır.
 if(mode==='delivered'){
  const isDup=id=>{const e=saleMap.get(id)||[],s=e.filter(x=>x.kind==='sale');
   return s.length>0&&s.every(x=>e.filter(r=>r.kind==='return'&&r.parent_id===x.id&&String(r.external_id||'').startsWith('DUZELTME-CIFT-')).reduce((n,r)=>n+r.quantity_milli,0)>=x.quantity_milli);};
  const dups=packages.filter(p=>isDup(p.id));
  if(dups.length){
   const keys=JSON.stringify([...new Set(dups.map(p=>p.channel+'|'+p.order_no))]);
   const twins=await all(db.prepare("SELECT * FROM order_packages WHERE channel||'|'||order_no IN (SELECT value FROM json_each(?)) AND status IN ('shipped','delivered') AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY occurred_on,external_id").bind(keys,ids));
   const tids=JSON.stringify(twins.map(t=>t.id));
   const [tl,tc,ts]=(await db.batch([
    db.prepare('SELECT * FROM order_lines WHERE package_id IN (SELECT value FROM json_each(?))').bind(tids),
    db.prepare('SELECT c.*,l.package_id,(SELECT pp.vat_bps FROM price_profiles pp WHERE pp.product_id=c.product_id) urun_kdv,COALESCE((SELECT NULLIF(pp.replacement_cost_cents,0) FROM price_profiles pp WHERE pp.product_id=c.product_id),(SELECT CAST(ROUND(pl.net_cents*1000.0/pl.quantity_milli) AS INTEGER) FROM purchase_lines pl JOIN purchase_invoices pi ON pi.id=pl.invoice_id WHERE pl.product_id=c.product_id AND pi.status='posted' AND pl.line_type='product' AND pl.quantity_milli>0 ORDER BY pi.invoice_date DESC,pi.created_at DESC LIMIT 1)) son_alis,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(tids),
    db.prepare(SALES_SQL).bind(tids)])).map(r=>r.results);
   for(const [m,rows] of [[lineMap,tl],[partMap,tc],[saleMap,ts]])for(const [k,v] of group(rows))m.set(k,v);
   const free=twins.filter(t=>!isDup(t.id));
   const byOrder=g=>{const m=new Map();for(const p of g){const k=p.channel+'|'+p.order_no;m.set(k,[...(m.get(k)||[]),p]);}return m;};
   const freeBy=byOrder(free);
   for(const [k,list] of byOrder([...dups].sort((a,b)=>a.occurred_on.localeCompare(b.occurred_on)||a.external_id.localeCompare(b.external_id)))){
    const pool=freeBy.get(k)||[];
    list.forEach((dup,i)=>{
     const twin=pool[i];if(!twin)return;
     // Pazaryeri kesintileri kopyanın asıl satırında (iade edilmeden önceki hâli) kayıtlı.
     const dupSales=(saleMap.get(dup.id)||[]).filter(x=>x.kind==='sale');
     saleMap.set(twin.id,(saleMap.get(twin.id)||[]).map(e=>{
      if(e.kind!=='sale'||(e.commission_cents!==null&&e.shipping_cents!==null&&e.other_cents!==null))return e;
      const src=dupSales.find(d=>d.product_id===e.product_id);
      return src?{...e,commission_cents:e.commission_cents??src.commission_cents,shipping_cents:e.shipping_cents??src.shipping_cents,other_cents:e.other_cents??src.other_cents,fees_status:src.fees_status}:e;
     }));
     packages[packages.indexOf(dup)]={...twin,status:'delivered',delivered_on:dup.delivered_on,stopaj_cents:dup.stopaj_cents,stopaj_paket:dup.stopaj_paket,twin_of:dup.external_id};
    });
   }
  }
 }
 const templateKeys=(mode==='pending'?packages:[]).filter(p=>!inputMap.has(p.id)).map(p=>parcelTemplateKey(p,lineMap.get(p.id)||[],partMap.get(p.id)||[]));
 const templates=mode==='pending'&&templateKeys.length?await all(db.prepare('SELECT * FROM parcel_templates WHERE template_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(templateKeys))):[];
 const templateMap=new Map(templates.map(t=>[t.template_key,t]));
 // GEÇMİŞTEN KESİNTİ TAHMİNİ (bkz. fee-history.js): kargodaki paket ve kesintisi ekstreye henüz
 // yazılmamış teslim, gerçek teslimlerin ortancasıyla hesaplanır. Elle girilmiş ölçü/tarife önceliklidir.
 const tahmin=await kesintiTahmincisi(db);
 // DEFTER PAKETIN TAMAMINI TUTUYOR MU? Pazaryeri raporu pakette 2 satir gorurken defterde
 // 1 satir varsa, o paketin BUTUN kesintileri eksik ciroya yuklenir ve karli siparis zararli
 // gorunur. Sessizce yanlis rakam vermektense kar HESAPLANMAZ, sebebi yazilir.
 // Olcut satir SAYISIdir: tutar farki cogu zaman indirimdir (rapor liste fiyatini, defter
 // indirimli fiyati tutar) ve gercek bir eksiklik degildir.
 const raporSatir=new Map();
 if(mode==='delivered'&&ids!=='[]'){
  for(const r of await all(db.prepare("SELECT erp_package_id pid,COUNT(*) n FROM ec_report_records WHERE kind='order_line' AND erp_package_id IN (SELECT value FROM json_each(?)) GROUP BY erp_package_id").bind(ids)))
   raporSatir.set(r.pid,r.n);
 }
 const rows=packages.map(p=>{
  const packageLines=lineMap.get(p.id)||[],parts=partMap.get(p.id)||[];let entries=saleMap.get(p.id)||[];
  const row={twin_of:p.twin_of||null,id:p.id,channel:p.channel,order_no:p.order_no,external_id:p.external_id,status:p.status,occurred_on:p.occurred_on,delivered_on:p.delivered_on,profit_cents:null,cash_cents:null,cash_note:null,missing:[],revenue_net_cents:null,cost_net_cents:null,shipping_cents:null,commission_cents:null,other_cents:null};
  if(p.source_changed){row.missing.push('Kaynak sipariş değişti; farkı inceleyin.');return row;}
  if(mode==='delivered'){
   const profit=packageProfit(p,packageLines,parts,entries),total=profit.totals;
   if(profit.status==='incomplete_records'){row.missing=profit.reasons;return row;}
   // MALIYET SIFIR OLAMAZ. Alis kaydi olmayan bir maldan satis yapilinca (stok eksiye dustugu
   // icin birim maliyet 0 cikar) sistem mali BEDAVA sayiyor ve kar sisiyordu. Eksik veri sifir
   // sayilmaz: kar hesaplanmaz, sebebi yazilir. Alis belgesi girilince kendiliginde duzelir.
   // Tahmin de yoksa (ürünün hiç alışı yok) maliyet BİLİNMİYOR. Tahminli açık satış kâra girer, notla işaretlenir.
   const maliyetsiz=entries.filter(e=>e.kind==='sale'&&e.quantity_milli>0&&((e.cost_cents===0&&!(e.open_milli>0))||(e.open_milli>0&&e.no_estimate===1)));
   if(entries.some(e=>e.kind==='sale'&&e.open_milli>0&&e.no_estimate===0))
    row.cost_note='Mal stokta yokken satıldı: maliyetin bir kısmı son alış fiyatından TAHMİNİ. Alış faturası girilince kesinleşir.';
   if(maliyetsiz.length){
    row.missing=[...profit.reasons,'Satılan ürünün alış kaydı yok; maliyet tahmin de edilemiyor. Sıfır sayılmadı, kâr hesaplanmadı. Alış faturası girilince kendiliğinden kapanır.'];
    return row;
   }
   const raporN=raporSatir.get(p.id);
   if(raporN!==undefined&&raporN>packageLines.length){
    row.missing=[...profit.reasons,'Pazaryeri raporu bu pakette '+raporN+' satır gösteriyor, defterde '+packageLines.length+
     ' satır var. Eksik satırın cirosu yokken paketin bütün kesintileri kalan satıra yüklenir; kâr hesaplanmadı.'];
    return row;
   }
   // TESLİM EDİLDİ AMA KESİNTİ EKSTREDE YOK. Pazaryeri kargoyu teslimden birkaç gün sonra yazar
   // (canlıda HB 4659432212: teslim 18.09, ekstrede kargo 0). Paket "hesaplanmadı" diye dışarıda
   // kalmaz: eksik kesinti geçmiş teslimlerden TAHMİN edilir, satır işaretlenir; ekstre gelince kesinleşir.
   const eksikKesinti=entries.some(s=>s.kind==='sale'&&(s.shipping_cents===null||s.commission_cents===null||s.other_cents===null));
   const h=eksikKesinti&&profit.status==='pending'?tahmin(p.channel,parts):null;
   if(h){
    const satislar=entries.filter(s=>s.kind==='sale'),ciro=satislar.reduce((t,s)=>t+s.revenue_cents,0)||1;
    const pay=(tutar,s)=>Math.round(tutar*s.revenue_cents/ciro);
    entries=entries.map(s=>s.kind!=='sale'?s:{...s,shipping_cents:s.shipping_cents??pay(h.shipping,s),other_cents:s.other_cents??pay(h.other,s),commission_cents:s.commission_cents??Math.round(s.revenue_cents*h.commissionRate)});
    const tahminli=packageProfit(p,packageLines,parts,entries);
    Object.assign(profit,{profit_cents:tahminli.estimated_profit_cents,reasons:[]});
    row.fees_estimated=true;
    row.cost_note=(row.cost_note?row.cost_note+' ':'')+'Pazaryeri kesintiyi ekstreye henüz yazmadı; '+h.note.charAt(0).toLocaleLowerCase('tr-TR')+h.note.slice(1)+' Ekstre gelince kendiliğinden kesinleşir.';
   }
   row.revenue_net_cents=total.revenue;row.cost_net_cents=total.cost;
   const fee=key=>entries.every(s=>s[key]!==null)?entries.reduce((sum,s)=>sum+s[key],0):null;
   row.shipping_cents=fee('shipping_cents');row.commission_cents=fee('commission_cents');row.other_cents=fee('other_cents');
   row.missing=profit.reasons;row.profit_cents=profit.profit_cents;
   row.returns=entries.filter(s=>s.kind==='return').length;
   // NAKIT SONUC: KDV dahil satis - KDV dahil mal maliyeti - KDV dahil kesintiler.
   // Kullanicinin gordugu rakam budur; KDV haric katki ayrica durur.
   const fv=feeVat.get(p.channel);
   const incl=(v,bps)=>Math.round(v*(10000+bps)/10000);
   if(row.profit_cents===null)row.cash_note='Kâr kesinleşmediği için nakit sonuç da hesaplanmadı.';
   else if(entries.some(e=>e.vat_bps===null||e.vat_bps===undefined))row.cash_note='Ürünün KDV oranı tanımlı değil; nakit sonuç hesaplanmadı.';
   else if(fv===null||fv===undefined)row.cash_note='Bu pazaryerinin kesinti KDV durumu beyan edilmedi; nakit sonuç hesaplanmadı.';
   else{
    let nakit=0;
    // Satış kendi satır KDV'siyle (müşterinin ödediği tutar), maliyet alış KDV'siyle (ürün profili) büyür.
    for(const e of entries)nakit+=incl(e.revenue_cents,e.satir_kdv??e.vat_bps)-incl(e.cost_cents,e.vat_bps)
     -incl(e.commission_cents??0,fv)-incl(e.shipping_cents??0,fv)-incl(e.other_cents??0,fv);
    // Stopaj bankaya gireni azaltir: nakit sonuctan dusulur.
    const stopaj=Math.round(Math.abs(p.stopaj_cents||0)/Math.max(1,p.stopaj_paket||1));
    row.withholding_cents=stopaj?-stopaj:0;
    row.cash_cents=nakit-stopaj;
    row.revenue_gross_cents=entries.reduce((t,e)=>t+incl(e.revenue_cents,e.satir_kdv??e.vat_bps),0);
    row.cost_gross_cents=entries.reduce((t,e)=>t+incl(e.cost_cents,e.vat_bps),0);
    row.shipping_gross_cents=entries.reduce((t,e)=>t+incl(e.shipping_cents??0,fv),0);
    row.commission_gross_cents=entries.reduce((t,e)=>t+incl(e.commission_cents??0,fv),0);
    row.other_gross_cents=entries.reduce((t,e)=>t+incl(e.other_cents??0,fv),0);
   }
  }else{
   const direct=inputMap.get(p.id),template=templateMap.get(parcelTemplateKey(p,packageLines,parts));
   // Sıra: elle girilmiş paket varsayımı → aynı içerikli teslim geçmişi → aynı içeriğin kayıtlı
   // ölçüleri (tarife) → aynı ürün / kanal geçmişi. Tarife hizmet bedelini bilmez; geçmiş bilir.
   let h=direct?null:tahmin(p.channel,parts);
   if(h&&h.source!=='content'&&template)h=null;
   const saved=h?null:direct||template;
   if(!saved){
    if(!h){row.missing.push('Bu kanalda henüz kesintisi gelmiş teslim yok; kargo ve komisyon tahmin edilemedi. İlk teslimden sonra kendiliğinden tahmin edilir.');return row;}
    // Satış ve maliyet paketin kendi kaydından (gönderilmişse satış satırları, değilse ilan ve stok).
    const own=(saleMap.get(p.id)||[]).filter(e=>e.kind==='sale');
    const revenue=own.length?own.reduce((t,e)=>t+e.revenue_cents,0):packageLines.every(l=>l.net_revenue_cents!==null)?packageLines.reduce((t,l)=>t+l.net_revenue_cents,0):null;
    // Maliyet: stok ortalaması; stok sıfır/eksiyse (faturası gelmemiş mal) ürünün son alış fiyatı.
    const birimMaliyet=c=>c.stock_quantity_milli>0&&c.value_cents>0?Math.round(c.value_cents*c.quantity_milli/c.stock_quantity_milli):c.son_alis?Math.round(c.son_alis*c.quantity_milli/1000):null;
    const cost=own.length?own.reduce((t,e)=>t+e.cost_cents,0):parts.length&&parts.every(c=>birimMaliyet(c)!==null)?parts.reduce((t,c)=>t+birimMaliyet(c),0):null;
    if(revenue===null||cost===null){row.missing.push('Paketin satış tutarı veya ürün maliyeti bilinmiyor; tahmin yapılmadı.');return row;}
    const commission=Math.round(revenue*h.commissionRate);
    Object.assign(row,{revenue_net_cents:revenue,cost_net_cents:cost,shipping_cents:h.shipping,commission_cents:commission,other_cents:h.other,
     profit_cents:revenue-cost-h.shipping-commission-h.other,assumptions_source:'history',history_source:h.source,history_n:h.n,cost_note:h.note});
    const oranlar=[...new Set(packageLines.map(l=>l.vat_bps))],fv=feeVat.get(p.channel);
    if(oranlar.length!==1||oranlar[0]===null||oranlar[0]===undefined)row.cash_note='Paketin satırları farklı KDV oranında; nakit sonuç hesaplanmadı.';
    else if(fv===null||fv===undefined)row.cash_note='Bu pazaryerinin kesinti KDV durumu beyan edilmedi; nakit sonuç hesaplanmadı.';
    else{
     const v=oranlar[0],inc=(x,b)=>Math.round(x*(10000+b)/10000),mvs=[...new Set(parts.map(c=>c.urun_kdv))],mv=mvs.length===1&&mvs[0]!==null&&mvs[0]!==undefined?mvs[0]:v;
     row.revenue_gross_cents=inc(revenue,v);row.cost_gross_cents=inc(cost,mv);row.shipping_gross_cents=inc(h.shipping,fv);row.commission_gross_cents=inc(commission,fv);row.other_gross_cents=inc(h.other,fv);
     const stopaj=Math.round(row.revenue_gross_cents*h.withholdingRate);row.withholding_cents=stopaj?-stopaj:0;
     row.cash_cents=row.revenue_gross_cents-row.cost_gross_cents-row.shipping_gross_cents-row.commission_gross_cents-row.other_gross_cents-stopaj;
    }
    return row;
   }
   if(direct&&(saved.source_fingerprint!==p.source_fingerprint||saved.composition_key!==compositionKey(packageLines,parts))){row.missing.push('Paket içeriği değişti; ölçü ve gider varsayımlarını yenileyin.');return row;}
   try{
    const stored=JSON.parse(saved.input_json),x=direct?stored:useParcelTemplate(stored,packageLines,parts),estimate=estimatePackage(p,packageLines,parts,{...x,date:p.shipped_on||today},shippingRates,commissionRates,false),q=estimate.quote;
    if(q.status!=='estimated'){row.missing=q.missing;return row;}
    Object.assign(row,{profit_cents:q.estimated_profit_cents,revenue_net_cents:q.revenue_net_cents,cost_net_cents:q.cost_net_cents,shipping_cents:q.shipping_net_cents,commission_cents:q.commission_net_cents,other_cents:q.packaging_net_cents+q.other_net_cents,assumptions_source:direct?'package':'identical_contents_template',assumptions_saved_at:saved.updated_at,tariff_date:p.shipped_on||today,cost_basis:estimate.cost_basis});
    // TAHMINDE DE NAKIT. Tarife hesabi zaten KDV dahil hakedisi veriyor (estimated_payout_cents:
    // satis - komisyon brut - kargo brut - stopaj). Nakit sonuc bundan malin KDV DAHIL maliyetini
    // duser. KDV orani ilan satirindan gelir; satirlar farkli oranlardaysa oran UYDURULMAZ.
    const oranlar=[...new Set(packageLines.map(l=>l.vat_bps))];
    if(!Number.isSafeInteger(q.estimated_payout_cents))row.cash_note='Tarife tahmininde hakediş hesaplanamadı.';
    else if(oranlar.length!==1||oranlar[0]===null||oranlar[0]===undefined)row.cash_note='Paketin satırları farklı KDV oranında; nakit sonuç hesaplanmadı.';
    else{
     const v=oranlar[0],incl=x=>Math.round(x*(10000+v)/10000);
     const kendiGider=q.packaging_net_cents+q.other_net_cents;
     row.cash_cents=q.estimated_payout_cents-incl(q.cost_net_cents)-incl(kendiGider);
     row.revenue_gross_cents=q.price_cents;row.cost_gross_cents=incl(q.cost_net_cents);
     row.shipping_gross_cents=q.shipping_gross_cents;row.commission_gross_cents=q.commission_gross_cents;
     row.other_gross_cents=incl(kendiGider);row.withholding_cents=q.withholding_cents?-q.withholding_cents:0;
    }
   }catch{row.missing.push('Kayıtlı paket varsayımları hesaplanamadı; sipariş özetinden yenileyin.');}
  }
  return row;
 });
 // TESLIM ONAYI GELMEYEN PAKETLER. Kar yalniz teslim edilmis pakette hesaplanir; kargoda
 // duran paket sessizce disarida kalirsa ekran "0 bilgi bekliyor" der ve toplam oldugundan
 // dusuk gorunur. Kac paketin bu yuzden hesaba girmedigi SOYLENIR. Tek gruplu sayim; ucuzdur.
 const bekleyen=mode==='delivered'?await all(db.prepare("SELECT channel,COUNT(*) n,MIN(occurred_on) ilk FROM order_packages q WHERE channel IN ('trendyol','hepsiburada') AND status='shipped' AND occurred_on<=? AND NOT EXISTS(SELECT 1 FROM order_packages d JOIN order_lines l ON l.package_id=d.id JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE d.channel=q.channel AND d.order_no=q.order_no AND d.status='delivered' AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%') GROUP BY channel").bind(to)):[];
 const bekleyenMap=new Map(bekleyen.map(r=>[r.channel,r]));
 const pendingFees=mode==='delivered'?await db.prepare(`SELECT COALESCE(SUM(${effectiveNet(env.WORKSPACE)}-COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0)),0) cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee'`).first():{cents:0};
 const channels=['trendyol','hepsiburada'].map(channel=>{
  const items=rows.filter(r=>r.channel===channel),complete=items.filter(r=>r.profit_cents!==null);
  const subtotal=complete.reduce((sum,r)=>sum+r.profit_cents,0);
  const nakitli=items.filter(r=>r.cash_cents!==null&&r.cash_cents!==undefined);
  const nakitToplam=nakitli.reduce((sum,r)=>sum+r.cash_cents,0);
  return {channel,packages:items.length,calculated:complete.length,missing:items.length-complete.length,profit_cents:items.length&&complete.length===items.length?subtotal:null,calculated_profit_cents:complete.length?subtotal:null,losses:complete.filter(r=>r.profit_cents<0).length,
   cash_calculated:nakitli.length,cash_cents:items.length&&nakitli.length===items.length?nakitToplam:null,calculated_cash_cents:nakitli.length?nakitToplam:null,cash_losses:nakitli.filter(r=>r.cash_cents<0).length,
   awaiting_delivery:bekleyenMap.get(channel)?.n||0,awaiting_delivery_since:bekleyenMap.get(channel)?.ilk||null};
 });
 return {mode,from,to,unallocated_fee_cents:pendingFees.cents,as_of:new Date().toISOString(),channels,rows,notice:mode==='delivered'?'Teslim tarihi seçilen aralıktaki paketlerdir. Bu paketlere sonradan işlenen iadeler de dahildir. Yalnızca kesintileri doğrulanmış satışlar kesin hesaba girer.':'Sipariş tarihi seçilen aralıktaki hazırlık ve kargodaki paketlerdir. Kayıtlı paket varsayımlarıyla her açılışta yeniden hesaplanır; teslim edilenler dahil değildir.',cost_notice:'Tutarlar NAKİTtİr: KDV dahil satıştan KDV dahil ürün maliyeti ve kesintiler düşülür. KDV hariç katkı vergi beyanı için ayrıca durur. Ortak işletme giderleri ve gelir/kurumlar vergisi dahil değildir.'};
}
