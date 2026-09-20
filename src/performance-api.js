import {effectiveNet} from './purchase-adjustment-api.js';
import {packageProfit} from './package-profit.js';
import {compositionKey,estimatePackage,parcelTemplateKey,useParcelTemplate} from './order-estimate-api.js';
import {kesintiTahmincisi} from './fee-history.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const day=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Tarih geçersiz.');return v;};
const all=async s=>(await s.all()).results;
// TESLİM EDİLEMEYİP DÖNEN PAKET ölçütü (kâr raporu ve ana sayfanın ilk tarihi AYNI ölçütü kullanır):
// satışı var, gerçek iadesi satışı karşılıyor. DUZELTME-CIFT çift aktarım düzeltmesidir, iade sayılmaz.
const SATILAN="(SELECT COALESCE(SUM(s.quantity_milli),0) FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id=order_packages.id AND s.kind='sale')";
const IADE="(SELECT COALESCE(SUM(r.quantity_milli),0) FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE l.package_id=order_packages.id AND r.kind='return' AND r.external_id NOT LIKE 'DUZELTME-CIFT-%')";
const IADE_TARIHI="(SELECT MAX(r.occurred_on) FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE l.package_id=order_packages.id AND r.kind='return')";
const DONEN=`channel IN ('trendyol','hepsiburada') AND status IN ('shipped','reserved') AND ${SATILAN}>0 AND ${IADE}>=${SATILAN}`;
// Kargodaki tahminde maliyet: stok ortalaması; stok sıfır/eksiyse (faturası gelmemiş mal) ürünün son alış fiyatı.
const birimMaliyet=c=>c.stock_quantity_milli>0&&c.value_cents>0?Math.round(c.value_cents*c.quantity_milli/c.stock_quantity_milli):c.son_alis?Math.round(c.son_alis*c.quantity_milli/1000):null;
// KARGODAKİ TAHMİNİN ÜRÜN PAYLARI: ürünün KDV dahil satışı − KDV dahil maliyeti; paket düzeyindeki kesinti,
// stopaj ve yuvarlama artığı ürünlere KDV dahil satış oranında dağılır, son ürün artığı alır. Toplam her
// zaman paketin cash_cents'idir. Kaynak: paketin kendi satış kayıtları, yoksa ilan satırı ve stok maliyeti.
function urunPaylari(row,own,lines,parts,v,mv,maliyet){
 const m=new Map(),inc=(x,b)=>Math.round(x*(10000+b)/10000);
 const ekle=(id,q,gelir,gider,b)=>{const u=m.get(id)||{product_id:id,qty_milli:0,revenue_gross_cents:0,cash_cents:0},brut=inc(gelir,v);u.qty_milli+=q;u.revenue_gross_cents+=brut;u.cash_cents+=brut-inc(gider,b);m.set(id,u);};
 if(own.length)for(const e of own)ekle(e.product_id,e.quantity_milli,e.revenue_cents,e.cost_cents,mv);
 else for(const c of parts)ekle(c.product_id,c.quantity_milli,Math.round((lines.find(l=>l.id===c.line_id)?.net_revenue_cents||0)*c.revenue_share_bps/10000),maliyet(c)||0,mv);
 const urunler=[...m.values()],pay=urunler.reduce((t,u)=>t+Math.max(0,u.revenue_gross_cents),0),artik=row.cash_cents-urunler.reduce((t,u)=>t+u.cash_cents,0);let kalan=artik;
 urunler.forEach((u,i)=>{const d=i===urunler.length-1?kalan:Math.round(artik*Math.max(0,u.revenue_gross_cents)/(pay||1));u.cash_cents+=d;kalan-=d;});
 return urunler;
}
// ÇİFT AKTARIM KOPYASI: satışlarının tamamı DUZELTME-CIFT ile sıfırlanmış paket. Teknik ters kayıttır;
// asıl kayıtla birlikte TEK ekonomik pakettir, stopaj paydasında ikinci paket sayılmaz (Codex R18).
const KOPYA=q=>`(EXISTS(SELECT 1 FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id=${q}.id AND s.kind='sale') AND NOT EXISTS(SELECT 1 FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id=${q}.id AND s.kind='sale' AND s.quantity_milli>(SELECT COALESCE(SUM(r.quantity_milli),0) FROM sale_entries r WHERE r.parent_id=s.id AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%')))`;
// Stopaj pazaryeri hakedisinden DUSULUR (nakit azalir) ama gider degildir: mahsup edilebilir.
// Bu yuzden nakit sonuctan dusulur, KDV haric katkida yer almaz. Kaynagi rapor kaydidir; uydurulmaz.
// Stopaj SIPARIS duzeyinde bildirilir ve siparişin iptal olmayan EKONOMİK paketlerine bölünür (ikiz kopya
// sayılmaz). Kuruş artığı paket kimliği sırasıyla ilk paketlere yazılır: payların toplamı olaya EŞİTTİR.
// Kayit ayni kanalin magazasindan okunur; siparis numaralari kanallar arasinda karismaz.
// "=+order_packages.order_no": tekli + sütunun TEXT eğilimini kaldırır; yoksa SQLite (store_id,kind,order_no)
// ifade indeksini kullanamıyor, her pakette bütün finans kayıtlarını tarıyordu (canlıda 3,4 sn → 13 ms).
// Rapor kayıtlarında sipariş no her zaman metindir (json_type='text'), sonuç aynıdır.
// Kâr raporu, sipariş penceresi ve liste bu parçayı ve stopajPayi'ni paylaşır.
export const STOPAJ_SQL=`(SELECT COALESCE(SUM(json_extract(r.data_json,'$.amount_cents')),0) FROM ec_report_records r JOIN ec_report_stores st ON st.id=r.store_id AND st.provider=order_packages.channel WHERE r.kind='finance_event' AND json_extract(r.data_json,'$.type')='withholding' AND json_extract(r.data_json,'$.order_no')=+order_packages.order_no) stopaj_cents,`
 +`(SELECT COUNT(*) FROM order_packages q WHERE q.order_no=order_packages.order_no AND q.channel=order_packages.channel AND q.status!='cancelled' AND NOT ${KOPYA('q')}) stopaj_paket,`
 +`(SELECT COUNT(*) FROM order_packages q WHERE q.order_no=order_packages.order_no AND q.channel=order_packages.channel AND q.status!='cancelled' AND q.id<order_packages.id AND NOT ${KOPYA('q')}) stopaj_sira`;
export const stopajPayi=p=>{const t=Math.abs(p.stopaj_cents||0),n=Math.max(1,p.stopaj_paket||0),b=Math.floor(t/n);return b+(Math.min(p.stopaj_sira||0,n-1)<t-b*n?1:0);};
// Teslim edilenlerin İLK SONUÇ tarihi: ilk teslim ya da (daha önceyse) teslim edilemeyip dönen paketin
// iade tarihi. Ana sayfa ve ürün kârlılığı "tüm zamanlar"ı buradan başlatır (Codex R19).
export async function ilkSonucTarihi(db,to){
 const r=await db.prepare(`SELECT (SELECT MIN(delivered_on) FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND status='delivered' AND delivered_on<=?) teslim,(SELECT MIN(${IADE_TARIHI}) FROM order_packages WHERE ${DONEN}) donen`).bind(to).first();
 return [r?.teslim,r?.donen].filter(d=>d&&d<=to).sort()[0]||null;
}
// Bir aralığın BÜTÜN paketleri: kararlı imleçle (paket kimliği) sayfa sayfa okunur; aynı güne yığılmış
// binlerce paket de eksiksiz ve tekrarsız gelir. Sınır hatası yerine sayfalama (Codex R20/R21).
export async function tumSatirlar(env,opts){
 const rows=[],gorulen=new Set();let imlec='',son=null;
 do{son=await performanceReport(env,{...opts,imlec});for(const r of son.rows)if(!gorulen.has(r.id)){gorulen.add(r.id);rows.push(r);}imlec=son.sonraki_imlec;}while(imlec);
 return {rows,unallocated_fee_cents:son?.unallocated_fee_cents||0};
}
// SİPARİŞ LİSTESİ VE PENCERESİ İÇİN paket sonucu: kâr raporunun (teslim edilenler) AYNI satırı; tahmin
// işareti ve eksik nedeniyle. Teslim kapsamında olmayan paket haritada yer almaz (Codex R22).
// Çift aktarım kopyası ikinci kez sayılmaz: sonucu asıl kayıtta durur.
export async function paketSonuclari(env,ids){
 const out=new Map(),liste=[...new Set(ids)];let hazir=null;
 const tahminAl=async()=>hazir||(hazir=await kesintiTahmincisi(env.DB));
 for(let i=0;i<liste.length;i+=800){
  const parca=liste.slice(i,i+800),iste=new Set(parca);
  for(const r of (await performanceReport(env,{mode:'delivered',ids:parca,tahminAl})).rows){
   if(iste.has(r.id))out.set(r.id,{cash_cents:r.cash_cents??null,profit_cents:r.profit_cents??null,withholding_cents:r.withholding_cents??null,
    estimated:!!(r.fees_estimated||r.cost_estimated),twin_of:r.twin_of,
    // Pencerenin "Paran nereye gidiyor?" dökümü de aynı satırdan (KDV dahil; tahmini kesintiler dahil).
    kalemler:r.cash_cents===null||r.cash_cents===undefined?null:{revenue_gross_cents:r.revenue_gross_cents,cost_gross_cents:r.cost_gross_cents,shipping_gross_cents:r.shipping_gross_cents,commission_gross_cents:r.commission_gross_cents,other_gross_cents:r.other_gross_cents},
    // Kaba tahmin uyarısı (benzer adette teslim geçmişi yok) listede ve pencerede de görünür.
    note:[r.cash_cents===null||r.cash_cents===undefined?(r.missing[0]||r.cash_note||null):(r.cost_note||(r.twin_of?'Çift aktarım düzeltildi: teslim ve pazaryeri kesintileri kopyadan ('+r.twin_of+'), satış ve maliyet bu kayıttan.':null)),r.tahmin_uyari||null].filter(Boolean).join(' ')||null});
   if(r.twin_dup_id&&iste.has(r.twin_dup_id)&&!out.has(r.twin_dup_id))out.set(r.twin_dup_id,{cash_cents:null,profit_cents:null,withholding_cents:null,estimated:false,copy_of:r.id,
    note:'Çift aktarım kopyası: bu paketin sonucu asıl kayıtta ('+r.external_id+') bir kez sayılır.'});
  }
 }
 return out;
}
export async function performanceApi(request,env,path){
 if(path!=='/api/performance'||request.method!=='GET')return null;
 if(env.WORKSPACE!=='ec')fail('Kanal kârlılığı e-ticaret alanına aittir.',403);
 const url=new URL(request.url),today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
 const from=day(url.searchParams.get('from')||new Date(Date.parse(today)-30*86400000).toISOString().slice(0,10)),to=day(url.searchParams.get('to')||today);
 if(from>to)fail('Başlangıç tarihi bitişten sonra olamaz.');
 const mode=url.searchParams.get('mode')||'delivered';if(!['delivered','pending'].includes(mode))fail('Rapor türü geçersiz.');
 return performanceReport(env,{mode,from,to});
}
// Kâr raporu, sipariş listesi/penceresi (paketSonuclari), ana sayfa (panorama-api.js) ve ürün kârlılığı
// (urun-karlilik-api.js) AYNI hesabı kullanır: tek formül, aynı paket aynı kuruş.
//  max:    aralıktaki paket sınırı (aşılırsa 409; ana sayfa ve ürün kârlılığı imleçle sayfalar)
//  tahmin: önceden kurulmuş kesinti tahmincisi (bölünmüş çağrılarda bir kez kurulur)
//  detay:  satıra ürün bazında nakit katkı (row.urunler; hesaplanamayanda row.urunler_eksik) eklenir
//  imlec:  verilirse (ilk sayfa '') paketler kimlik sırasıyla en çok max'lık sayfalarla döner ve
//          sonraki_imlec verilir; 409 yerine sayfalama (bkz. tumSatirlar). Verilmezse sınır aşımı 409.
//  ids:    tarih yerine bu paketler (sipariş listesi/penceresi; bkz. paketSonuclari). Yalnız teslim edilenler.
//  tahminAl: tahminci gerekirse bir kez kurar (bölünmüş çağrılarda paylaşılır).
export async function performanceReport(env,{mode,from,to,max=1000,tahmin:hazirTahmin=null,tahminAl=null,detay=false,imlec=null,ids:paketIdleri=null}){
 const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});
 // Satışın stokta olmadan satılıp henüz alışla kapanmamış (açık) kısmı ve tahmin olup olmadığı.
 const SALES_SQL='SELECT s.*,l.package_id,l.vat_bps satir_kdv,pp.vat_bps,(SELECT o.open_milli-o.settled_milli FROM open_costs o WHERE o.sale_id=s.id) open_milli,(SELECT iif(o.estimate_cents IS NULL,1,0) FROM open_costs o WHERE o.sale_id=s.id) no_estimate FROM sale_entries s JOIN order_line_components c ON (s.id=c.sale_id OR s.parent_id=c.sale_id) JOIN order_lines l ON l.id=c.line_id LEFT JOIN price_profiles pp ON pp.product_id=s.product_id WHERE l.package_id IN (SELECT value FROM json_each(?))';
 if(paketIdleri&&mode!=='delivered')fail('Paket sonucu yalnız teslim edilenler için verilir.');
 const sayfali=!paketIdleri&&imlec!==null&&imlec!==undefined,idJson=paketIdleri?JSON.stringify(paketIdleri):null;
 // Kapsam: tarih aralığı ya da verilen paketler. Kargodaki ikizin kopyası teslimliyse o da okunur (ikiz hesabı).
 const kapsam=paketIdleri?"(id IN (SELECT value FROM json_each(?)) OR channel||'|'||order_no IN (SELECT q.channel||'|'||q.order_no FROM order_packages q WHERE q.id IN (SELECT value FROM json_each(?)) AND q.status IN ('shipped','reserved')))":mode==='delivered'?'delivered_on BETWEEN ? AND ?':'occurred_on BETWEEN ? AND ?';
 const kapsamArg=paketIdleri?[idJson,idJson]:[from,to],sira=sayfali?' AND id>? ORDER BY id':' ORDER BY occurred_on DESC,id',siraArg=sayfali?[imlec]:[],sinir=paketIdleri?'':` LIMIT ${max+1}`;
 const db=env.DB,paketSoz=all(db.prepare(`SELECT *${mode==='delivered'?','+STOPAJ_SQL:''} FROM order_packages WHERE channel IN ('trendyol','hepsiburada') AND ${mode==='delivered'?"status='delivered'":"status IN ('draft','reserved','shipped')"} AND ${kapsam}${sira}${sinir}`).bind(...kapsamArg,...siraArg));
 // Dönenler paketlerle AYNI ANDA okunur (birbirini beklemez; D1'de her okuma bir gidiş-dönüştür).
 // TESLİM EDİLEMEYİP DÖNEN PAKET. Satış iadeyle sıfırlanır ama gidiş-dönüş kargosu ve hizmet bedeli
 // gerçek giderdir. Paket "gönderildi" durumunda kaldığı için kâra hiç girmiyor, o gider kayboluyordu
 // (canlıda HB 4611462604: kesintinin yarısı, ~132 TL; TY 11581049903). İadesi tamamlanan gönderilmiş
 // paket İADE TARİHİYLE sonuçlanmış sayılır; çift kayıt düzeltmesi (DUZELTME-CIFT) iade sayılmaz.
 // Dönenler de aynı paket sınırına girer: eskiden LIMIT 101 sonrası sessizce düşüyordu (Codex R20).
 const [packages,donen]=await Promise.all([paketSoz,mode!=='delivered'?[]:all(db.prepare(`SELECT *,${STOPAJ_SQL},${IADE_TARIHI} iade_tarihi FROM order_packages WHERE ${DONEN} AND ${paketIdleri?'id IN (SELECT value FROM json_each(?))':IADE_TARIHI+' BETWEEN ? AND ?'}${sayfali?' AND id>? ORDER BY id':''}${sinir}`).bind(...(paketIdleri?[idJson]:[from,to]),...siraArg))]);
 let sonraki_imlec=null;
 if(sayfali){
  const hepsi=[...packages,...donen.map(d=>({...d,status:'delivered',delivered_on:d.iade_tarihi,teslim_edilemedi:true}))].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(hepsi.length>max){hepsi.length=max;sonraki_imlec=hepsi[max-1].id;}
  packages.length=0;packages.push(...hepsi);
 }else{
  if(!paketIdleri&&packages.length+donen.length>max)fail('Bu aralıkta '+max.toLocaleString('tr-TR')+'’den fazla paket var. Eksiksiz toplam için tarih aralığını daraltın.',409);
  for(const d of donen)packages.push({...d,status:'delivered',delivered_on:d.iade_tarihi,teslim_edilemedi:true});
 }
 // Çift aktarımın asıl kaydı "gönderildi" durumunda kalır ama teslimi kopyasıyla gelmiştir ve
 // teslim edilenlerin kârında ikiz olarak sayılır. Kargodakilerde ikinci kez görünmez.
 if(mode==='pending'&&packages.length){
  const teslimli=new Set((await all(db.prepare("SELECT DISTINCT q.channel||'|'||q.order_no k FROM order_packages q JOIN order_lines l ON l.package_id=q.id JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE q.status='delivered' AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%' AND q.order_no IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...new Set(packages.map(p=>p.order_no))])))).map(r=>r.k));
  for(let i=packages.length-1;i>=0;i--)if(packages[i].status==='shipped'&&teslimli.has(packages[i].channel+'|'+packages[i].order_no))packages.splice(i,1);
  // İADESİ TAMAMLANMIŞ paket (teslim edilemedi / müşteri iade etti) yolda değildir: satış ve iade
  // birbirini kapatır. Kargodakiler tahminine girerse olmayan bir kâr eklenir.
  const iadeli=new Set((await all(db.prepare("SELECT l.package_id pid,SUM(CASE WHEN s.kind='sale' THEN s.quantity_milli ELSE 0 END) satilan,(SELECT COALESCE(SUM(r.quantity_milli),0) FROM sale_entries r WHERE r.parent_id IN (SELECT c2.sale_id FROM order_line_components c2 JOIN order_lines l2 ON l2.id=c2.line_id WHERE l2.package_id=l.package_id) AND r.kind='return') iade FROM order_lines l JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?)) GROUP BY l.package_id").bind(JSON.stringify(packages.map(p=>p.id))))).filter(r=>r.iade>0&&r.iade>=r.satilan).map(r=>r.pid));
  for(let i=packages.length-1;i>=0;i--)if(iadeli.has(packages[i].id))packages.splice(i,1);
 }
 const ids=JSON.stringify(packages.map(p=>p.id));
 const [feeVatRows,lines,components,sales,inputs=[],shippingRates=[],commissionRates=[]]=(await db.batch([
  // Kesinti KDV orani UYDURULMAZ: pazaryerinin finans rapor profilinde beyan edilmisse oradan gelir.
  // Beyan yoksa o kanalin nakit sonucu bos birakilir ve sebebi yazilir.
  db.prepare("SELECT provider,json_extract(options_json,'$.fee_vat_bps') bps FROM ec_report_profiles WHERE kind='finance' AND json_extract(options_json,'$.fee_amounts_include_vat')=1 AND json_extract(options_json,'$.fee_vat_bps') IS NOT NULL"),
  db.prepare('SELECT * FROM order_lines WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT c.*,l.package_id,(SELECT pp.vat_bps FROM price_profiles pp WHERE pp.product_id=c.product_id) urun_kdv,COALESCE((SELECT NULLIF(pp.replacement_cost_cents,0) FROM price_profiles pp WHERE pp.product_id=c.product_id),(SELECT CAST(ROUND(pl.net_cents*1000.0/pl.quantity_milli) AS INTEGER) FROM purchase_lines pl JOIN purchase_invoices pi ON pi.id=pl.invoice_id WHERE pl.product_id=c.product_id AND pi.status=\'posted\' AND pl.line_type=\'product\' AND pl.quantity_milli>0 ORDER BY pi.invoice_date DESC,pi.created_at DESC LIMIT 1)) son_alis,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare(SALES_SQL).bind(ids),
  ...(mode==='pending'?[db.prepare('SELECT * FROM order_estimate_inputs WHERE package_id IN (SELECT value FROM json_each(?))').bind(ids),
  db.prepare('SELECT * FROM shipping_rates WHERE archived_at IS NULL LIMIT 1001'),
  db.prepare('SELECT * FROM commission_rates WHERE archived_at IS NULL LIMIT 1001')]:[])
 ])).map(r=>r.results);
 if(shippingRates.length>1000||commissionRates.length>1000)fail('Tarife sayısı sınırı aşıldı. Eski tarifeleri arşivleyin.',409);
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
   const twins=await all(db.prepare(`SELECT *,${STOPAJ_SQL} FROM order_packages WHERE channel||'|'||order_no IN (SELECT value FROM json_each(?)) AND status IN ('shipped','delivered') AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY occurred_on,external_id`).bind(keys,ids));
   const tids=JSON.stringify(twins.map(t=>t.id));
   const [tl,tc,ts]=(await db.batch([
    db.prepare('SELECT * FROM order_lines WHERE package_id IN (SELECT value FROM json_each(?))').bind(tids),
    db.prepare('SELECT c.*,l.package_id,(SELECT pp.vat_bps FROM price_profiles pp WHERE pp.product_id=c.product_id) urun_kdv,COALESCE((SELECT NULLIF(pp.replacement_cost_cents,0) FROM price_profiles pp WHERE pp.product_id=c.product_id),(SELECT CAST(ROUND(pl.net_cents*1000.0/pl.quantity_milli) AS INTEGER) FROM purchase_lines pl JOIN purchase_invoices pi ON pi.id=pl.invoice_id WHERE pl.product_id=c.product_id AND pi.status=\'posted\' AND pl.line_type=\'product\' AND pl.quantity_milli>0 ORDER BY pi.invoice_date DESC,pi.created_at DESC LIMIT 1)) son_alis,b.quantity_milli stock_quantity_milli,b.value_cents,p.stock_unit current_stock_unit,s.cost_cents sale_cost_cents FROM order_line_components c JOIN order_lines l ON l.id=c.line_id JOIN stock_balances b ON b.product_id=c.product_id JOIN products p ON p.id=c.product_id LEFT JOIN sale_entries s ON s.id=c.sale_id WHERE l.package_id IN (SELECT value FROM json_each(?))').bind(tids),
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
     // Stopaj payı ikizin KENDİ ekonomik payıdır: kopya paydada sayılmaz, stopaj yarıya bölünmez (Codex R18).
     packages[packages.indexOf(dup)]={...twin,status:'delivered',delivered_on:dup.delivered_on,twin_of:dup.external_id,twin_dup_id:dup.id};
    });
   }
  }
 }
 const templateKeys=(mode==='pending'?packages:[]).filter(p=>!inputMap.has(p.id)).map(p=>parcelTemplateKey(p,lineMap.get(p.id)||[],partMap.get(p.id)||[]));
 const templates=mode==='pending'&&templateKeys.length?await all(db.prepare('SELECT * FROM parcel_templates WHERE template_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(templateKeys))):[];
 const templateMap=new Map(templates.map(t=>[t.template_key,t]));
 // GEÇMİŞTEN KESİNTİ TAHMİNİ (bkz. fee-history.js): kargodaki paket ve kesintisi ekstreye henüz
 // yazılmamış teslim, gerçek teslimlerin ortancasıyla hesaplanır. Elle girilmiş ölçü/tarife önceliklidir.
 // Tahminci yalnız GEREKİRSE kurulur (bütün teslimleri okur): kargodaki paket ya da kesintisi eksik teslim.
 const tahminGerekli=mode==='pending'?packages.length>0:[...saleMap.values()].some(l=>l.some(s=>s.kind==='sale'&&(s.shipping_cents===null||s.commission_cents===null||s.other_cents===null)));
 // Tahminci, rapor satır sayıları ve ürün adları birbirinden bağımsızdır: AYNI ANDA okunur.
 const tahminSoz=hazirTahmin?Promise.resolve(hazirTahmin):tahminGerekli?(tahminAl||(()=>kesintiTahmincisi(db)))():Promise.resolve(()=>null);
 // DEFTER PAKETIN TAMAMINI TUTUYOR MU? Pazaryeri raporu pakette 2 satir gorurken defterde
 // 1 satir varsa, o paketin BUTUN kesintileri eksik ciroya yuklenir ve karli siparis zararli
 // gorunur. Sessizce yanlis rakam vermektense kar HESAPLANMAZ, sebebi yazilir.
 // Olcut satir SAYISIdir: tutar farki cogu zaman indirimdir (rapor liste fiyatini, defter
 // indirimli fiyati tutar) ve gercek bir eksiklik degildir.
 const raporSatir=new Map(),urunIdleri=[...new Set([...partMap.values()].flat().map(c=>c.product_id))];
 const raporSoz=mode==='delivered'&&ids!=='[]'?all(db.prepare("SELECT erp_package_id pid,json_extract(data_json,'$.package_id') rpk,COUNT(*) n,MAX(source_time) t FROM ec_report_records WHERE kind='order_line' AND erp_package_id IN (SELECT value FROM json_each(?)) GROUP BY 1,2").bind(ids)):Promise.resolve([]);
 const adSoz=urunIdleri.length?all(db.prepare('SELECT id,name FROM products WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(urunIdleri))):Promise.resolve([]);
 // Beklenmeden önce hata verirse işlenmemiş ret sayılmasın; hata aşağıda await edilince yine yükselir.
 raporSoz.catch(()=>{});adSoz.catch(()=>{});
 const tahmin=await tahminSoz;
 if(mode==='delivered'&&ids!=='[]'){
  // YENİDEN NUMARALANAN PAKET: pazaryeri aynı siparişe yeni paket numarası verirse (canlıda HB
  // 4731515470: 5517911182 → 5518837752, aynı ürün ve adet) iki numaranın satırları da aynı
  // deftere bağlıdır. Eski numara sayılırsa "raporda 2 satır, defterde 1" denip kâr hesaplanmazdı.
  // Pakete bağlı rapor satırlarından yalnız EN SON görülen paket numarasınınkiler sayılır.
  for(const r of await raporSoz){
   const prev=raporSatir.get(r.pid);
   if(!prev||String(r.t)>String(prev.t))raporSatir.set(r.pid,{n:r.n,t:r.t});
  }
  for(const [k,v] of raporSatir)raporSatir.set(k,v.n);
 }
 // Satırda ürün adı gösterilir (stok kartı adı, pazaryeri ilan adı değil): "2 × Torf 20 L".
 const urunAdi=new Map((await adSoz).map(u=>[u.id,u.name]));
 const urunOzet=parts=>{const m=new Map();for(const c of parts)m.set(c.product_id,(m.get(c.product_id)||0)+c.quantity_milli);
  return [...m].map(([id,q])=>(q===1000?'':(q/1000).toLocaleString('tr-TR')+' × ')+(urunAdi.get(id)||'Ürün')).join(', ');};
 const rows=packages.map(p=>{
  const packageLines=lineMap.get(p.id)||[],parts=partMap.get(p.id)||[];let entries=saleMap.get(p.id)||[];
  const row={twin_of:p.twin_of||null,id:p.id,channel:p.channel,order_no:p.order_no,external_id:p.external_id,status:p.status,occurred_on:p.occurred_on,delivered_on:p.delivered_on,urun:urunOzet(parts),teslim_edilemedi:!!p.teslim_edilemedi,profit_cents:null,cash_cents:null,cash_note:null,missing:[],revenue_net_cents:null,cost_net_cents:null,shipping_cents:null,commission_cents:null,other_cents:null};
  if(p.twin_dup_id)row.twin_dup_id=p.twin_dup_id;
  if(p.source_changed){row.missing.push('Kaynak sipariş değişti; farkı inceleyin.');return row;}
  if(mode==='delivered'){
   const profit=packageProfit(p,packageLines,parts,entries),total=profit.totals;
   if(profit.status==='incomplete_records'){row.missing=profit.reasons;return row;}
   // MALIYET SIFIR OLAMAZ. Alis kaydi olmayan bir maldan satis yapilinca (stok eksiye dustugu
   // icin birim maliyet 0 cikar) sistem mali BEDAVA sayiyor ve kar sisiyordu. Eksik veri sifir
   // sayilmaz: kar hesaplanmaz, sebebi yazilir. Alis belgesi girilince kendiliginde duzelir.
   // Tahmin de yoksa (ürünün hiç alışı yok) maliyet BİLİNMİYOR. Tahminli açık satış kâra girer, notla işaretlenir.
   const maliyetsiz=entries.filter(e=>e.kind==='sale'&&e.quantity_milli>0&&((e.cost_cents===0&&!(e.open_milli>0))||(e.open_milli>0&&e.no_estimate===1)));
   if(entries.some(e=>e.kind==='sale'&&e.open_milli>0&&e.no_estimate===0)){
    row.cost_estimated=true;row.cost_note='Mal stokta yokken satıldı: maliyetin bir kısmı son alış fiyatından TAHMİNİ. Alış faturası girilince kesinleşir.';}
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
    // ADET UYUMU (R23) kâr yoluna da taşınır: tahmin benzer ADETTE teslime dayanmıyorsa satır işaretlenir.
    // Tutar değişmez; yalnız ne kadar kaba olduğu makine okunur alanla ve kısa notla söylenir.
    row.tahmin_uyum=h.uyum||null;row.tahmin_ornek_adet=h.ornekAdet||null;
    if(h.uyari)row.tahmin_uyari=h.uyari;
    row.cost_note=(row.cost_note?row.cost_note+' ':'')+'Pazaryeri kesintiyi ekstreye henüz yazmadı; '+h.note.charAt(0).toLocaleLowerCase('tr-TR')+h.note.slice(1)+' Ekstre gelince kendiliğinden kesinleşir.';
   }
   row.revenue_net_cents=total.revenue;row.cost_net_cents=total.cost;
   const fee=key=>entries.every(s=>s[key]!==null)?entries.reduce((sum,s)=>sum+s[key],0):null;
   row.shipping_cents=fee('shipping_cents');row.commission_cents=fee('commission_cents');row.other_cents=fee('other_cents');
   row.missing=profit.reasons;row.profit_cents=profit.profit_cents;
   row.returns=entries.filter(s=>s.kind==='return').length;
   if(p.teslim_edilemedi)row.cost_note=(row.cost_note?row.cost_note+' ':'')+'Teslim edilemedi / geri döndü: satış iadeyle sıfırlandı, kargo ve hizmet bedeli gider olarak yazıldı (iade tarihi '+p.delivered_on+').';
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
    const stopaj=stopajPayi(p);
    row.withholding_cents=stopaj?-stopaj:0;
    row.cash_cents=nakit-stopaj;
    row.revenue_gross_cents=entries.reduce((t,e)=>t+incl(e.revenue_cents,e.satir_kdv??e.vat_bps),0);
    row.cost_gross_cents=entries.reduce((t,e)=>t+incl(e.cost_cents,e.vat_bps),0);
    row.shipping_gross_cents=entries.reduce((t,e)=>t+incl(e.shipping_cents??0,fv),0);
    row.commission_gross_cents=entries.reduce((t,e)=>t+incl(e.commission_cents??0,fv),0);
    row.other_gross_cents=entries.reduce((t,e)=>t+incl(e.other_cents??0,fv),0);
    // Ürün bazında katkı: aynı satır formülü; stopaj ürünlere KDV dahil satış oranında dağılır,
    // yuvarlama artığı son ürüne yazılır. Toplamı her zaman paketin cash_cents'ine eşittir.
    if(detay){
     const m=new Map();
     for(const e of entries){
      const u=m.get(e.product_id)||{product_id:e.product_id,qty_milli:0,revenue_gross_cents:0,cash_cents:0};
      const brut=incl(e.revenue_cents,e.satir_kdv??e.vat_bps);
      u.qty_milli+=e.kind==='return'?-e.quantity_milli:e.quantity_milli;u.revenue_gross_cents+=brut;
      u.cash_cents+=brut-incl(e.cost_cents,e.vat_bps)-incl(e.commission_cents??0,fv)-incl(e.shipping_cents??0,fv)-incl(e.other_cents??0,fv);
      m.set(e.product_id,u);
     }
     const urunler=[...m.values()],pay=urunler.reduce((t,u)=>t+Math.max(0,u.revenue_gross_cents),0);let kalan=stopaj;
     urunler.forEach((u,i)=>{const d=i===urunler.length-1?kalan:Math.round(stopaj*Math.max(0,u.revenue_gross_cents)/(pay||1));u.cash_cents-=d;kalan-=d;});
     row.urunler=urunler;
    }
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
    const cost=own.length?own.reduce((t,e)=>t+e.cost_cents,0):parts.length&&parts.every(c=>birimMaliyet(c)!==null)?parts.reduce((t,c)=>t+birimMaliyet(c),0):null;
    if(revenue===null||cost===null){row.missing.push('Paketin satış tutarı veya ürün maliyeti bilinmiyor; tahmin yapılmadı.');return row;}
    const commission=Math.round(revenue*h.commissionRate);
    // tahmin_uyum: örneklerin adedi istenen adede ne kadar uyuyor (fee-history 'ayni'/'aralik'/'uzak'/'yok').
    // 'uzak'/'yok' ise tahmin_uyari kısa notu gelir; TUTAR DEĞİŞMEZ, belirsizlik görünür olur.
    Object.assign(row,{revenue_net_cents:revenue,cost_net_cents:cost,shipping_cents:h.shipping,commission_cents:commission,other_cents:h.other,
     profit_cents:revenue-cost-h.shipping-commission-h.other,assumptions_source:'history',history_source:h.source,history_n:h.n,cost_note:h.note,
     tahmin_uyum:h.uyum||null,tahmin_ornek_adet:h.ornekAdet||null});
    if(h.uyari)row.tahmin_uyari=h.uyari;
    const oranlar=[...new Set(packageLines.map(l=>l.vat_bps))],fv=feeVat.get(p.channel);
    if(oranlar.length!==1||oranlar[0]===null||oranlar[0]===undefined)row.cash_note='Paketin satırları farklı KDV oranında; nakit sonuç hesaplanmadı.';
    else if(fv===null||fv===undefined)row.cash_note='Bu pazaryerinin kesinti KDV durumu beyan edilmedi; nakit sonuç hesaplanmadı.';
    else{
     const v=oranlar[0],inc=(x,b)=>Math.round(x*(10000+b)/10000),mvs=[...new Set(parts.map(c=>c.urun_kdv))],mv=mvs.length===1&&mvs[0]!==null&&mvs[0]!==undefined?mvs[0]:v;
     row.revenue_gross_cents=inc(revenue,v);row.cost_gross_cents=inc(cost,mv);row.shipping_gross_cents=inc(h.shipping,fv);row.commission_gross_cents=inc(commission,fv);row.other_gross_cents=inc(h.other,fv);
     const stopaj=Math.round(row.revenue_gross_cents*h.withholdingRate);row.withholding_cents=stopaj?-stopaj:0;
     row.cash_cents=row.revenue_gross_cents-row.cost_gross_cents-row.shipping_gross_cents-row.commission_gross_cents-row.other_gross_cents-stopaj;
     if(detay)row.urunler=urunPaylari(row,own,packageLines,parts,v,mv,birimMaliyet);
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
     if(detay)row.urunler=urunPaylari(row,(saleMap.get(p.id)||[]).filter(e=>e.kind==='sale'),packageLines,parts,v,v,birimMaliyet);
    }
   }catch{row.missing.push('Kayıtlı paket varsayımları hesaplanamadı; sipariş özetinden yenileyin.');}
  }
  return row;
 });
 // Hesaplanamayan pakette de ürün ve adet bilinir: ürün kârlılığı eksik kapsamı ürün bazında söyler.
 if(detay)for(const row of rows)if(!row.urunler){
  const m=new Map(),ekle=(id,q)=>{const u=m.get(id)||{product_id:id,qty_milli:0};u.qty_milli+=q;m.set(id,u);},entries=(saleMap.get(row.id)||[]).filter(e=>mode==='delivered'||e.kind==='sale');
  if(entries.length)for(const e of entries)ekle(e.product_id,e.kind==='return'?-e.quantity_milli:e.quantity_milli);
  else for(const c of partMap.get(row.id)||[])ekle(c.product_id,c.quantity_milli);
  row.urunler_eksik=[...m.values()];
 }
 // Paket sonucu (liste/pencere) için özet sorguları gerekmez.
 const ozetli=mode==='delivered'&&!paketIdleri;
 // TESLIM ONAYI GELMEYEN PAKETLER. Kar yalniz teslim edilmis pakette hesaplanir; kargoda
 // duran paket sessizce disarida kalirsa ekran "0 bilgi bekliyor" der ve toplam oldugundan
 // dusuk gorunur. Kac paketin bu yuzden hesaba girmedigi SOYLENIR. Tek gruplu sayim; ucuzdur.
 const bekleyen=ozetli?await all(db.prepare("SELECT channel,COUNT(*) n,MIN(occurred_on) ilk FROM order_packages q WHERE channel IN ('trendyol','hepsiburada') AND status='shipped' AND occurred_on<=? AND NOT EXISTS(SELECT 1 FROM order_packages d JOIN order_lines l ON l.package_id=d.id JOIN order_line_components c ON c.line_id=l.id JOIN sale_entries r ON r.parent_id=c.sale_id WHERE d.channel=q.channel AND d.order_no=q.order_no AND d.status='delivered' AND r.kind='return' AND r.external_id LIKE 'DUZELTME-CIFT-%') GROUP BY channel").bind(to)):[];
 const bekleyenMap=new Map(bekleyen.map(r=>[r.channel,r]));
 const pendingFees=ozetli?await db.prepare(`SELECT COALESCE(SUM(${effectiveNet(env.WORKSPACE)}-COALESCE((SELECT SUM(a.amount_cents) FROM fee_allocations a WHERE a.invoice_line_id=l.id AND a.reversed_at IS NULL),0)),0) cents FROM purchase_lines l JOIN purchase_invoices i ON i.id=l.invoice_id WHERE i.status='posted' AND l.line_type='expense' AND l.expense_treatment='sales_fee'`).first():{cents:0};
 const channels=['trendyol','hepsiburada'].map(channel=>{
  const items=rows.filter(r=>r.channel===channel),complete=items.filter(r=>r.profit_cents!==null);
  const subtotal=complete.reduce((sum,r)=>sum+r.profit_cents,0);
  const nakitli=items.filter(r=>r.cash_cents!==null&&r.cash_cents!==undefined);
  const nakitToplam=nakitli.reduce((sum,r)=>sum+r.cash_cents,0);
  return {channel,packages:items.length,calculated:complete.length,missing:items.length-complete.length,profit_cents:items.length&&complete.length===items.length?subtotal:null,calculated_profit_cents:complete.length?subtotal:null,losses:complete.filter(r=>r.profit_cents<0).length,
   cash_calculated:nakitli.length,cash_cents:items.length&&nakitli.length===items.length?nakitToplam:null,calculated_cash_cents:nakitli.length?nakitToplam:null,cash_losses:nakitli.filter(r=>r.cash_cents<0).length,
   awaiting_delivery:bekleyenMap.get(channel)?.n||0,awaiting_delivery_since:bekleyenMap.get(channel)?.ilk||null};
 });
 return {mode,from,to,sonraki_imlec,unallocated_fee_cents:pendingFees.cents,as_of:new Date().toISOString(),channels,rows,notice:mode==='delivered'?'Teslim tarihi seçilen aralıktaki paketlerdir. Bu paketlere sonradan işlenen iadeler de dahildir. Yalnızca kesintileri doğrulanmış satışlar kesin hesaba girer.':'Sipariş tarihi seçilen aralıktaki hazırlık ve kargodaki paketlerdir. Kayıtlı paket varsayımlarıyla her açılışta yeniden hesaplanır; teslim edilenler dahil değildir.',cost_notice:'Tutarlar NAKİTtİr: KDV dahil satıştan KDV dahil ürün maliyeti ve kesintiler düşülür. KDV hariç katkı vergi beyanı için ayrıca durur. Ortak işletme giderleri ve gelir/kurumlar vergisi dahil değildir.'};
}
