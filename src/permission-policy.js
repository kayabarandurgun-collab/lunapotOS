import {can,any,modules} from '../public/permissions.js';
import {FIELDS} from '../public/report-core.js';
const deny=()=>{throw Object.assign(Error('Bu ekran veya işlem için yetkiniz yok. Yöneticiniz Ekip ve yetkiler ekranından izin verebilir.'),{status:403});};
export function permit(user,path,method){
 if(user.owner||path==='/api/auth/logout')return;
 if(path.startsWith('/api/admin'))deny();
 if(path.startsWith('/api/webshop/')){if(!can(user,'ec','webshop',!['GET','HEAD'].includes(method)))deny();return;}
 const match=path.match(/^\/api\/(ec|lp)(\/.*)?$/),ns=match?.[1]||'lp',sub=match?(match[2]||''):path.slice(4);
 if(user[ns+'_access']==='none')deny();
 const write=!['GET','HEAD'].includes(method),parts=sub.split('/').filter(Boolean),head=parts[0];
 // Ham belge/PDF ve OCR metninin içindeki tutarlar anahtar bazlı gizlenemez.
 // Liste ve sayfa bağlantıları açık kalır; içerik ayrıca mevcut tutar iznini ister.
 if(match&&(/^\/invoices\/documents\/[\w-]+(?:\/part)?$/.test(sub)&&!write
   ||sub==='/invoices/documents/ocr'&&method==='POST')&&!can(user,ns,'amounts'))deny();
 if(!head||!match&&head==='data'){if(write)deny();return;}
 if(['settings','connections','integrations','recovery','attention'].includes(head)){if(head==='settings'&&!write&&sub==='/settings'&&can(user,ns,ns==='ec'?'invoices':'accounts'))return;deny();}
 // Banka ekstresi ve hakediş–banka eşleştirme YALNIZ e-ticarettedir ve cari/nakit (ledger)
 // yetkisiyle çalışır: public/permissions.js routeAliases zaten bank→ledger diyor, menü bu ekranı
 // ledger yetkisi olan personele gösteriyordu ama uç yalnız yöneticiye açıktı. Eşleştirme ucu
 // KASAYA PARA YAZAR; okumak için ledger okuma, onay/geri alma için ledger YAZMA yetkisi gerekir.
 // Ledger yazma yetkisi olan personel zaten /api/ec/ledger/cash ile kasa hareketi yazabiliyor;
 // bu eşleme yeni bir güç vermez, var olan yetkiyi aynı ekranda tutar.
 if(head==='money-calendar'){if(!match||method!=='GET'||!can(user,ns,'ledger')||!can(user,ns,'amounts'))deny();return;}
 if(head==='business-result'){if(!match||ns!=='ec'||method!=='GET'||!['performance','expenses','amounts'].every(k=>can(user,ns,k)))deny();return;}
 if(head==='workbench'){if(!match||!Object.keys(modules[ns]||{}).some(k=>k!=='amounts'&&can(user,ns,k,write)))deny();return;}
 if(head==='bank'){if(ns!=='ec'||!match)deny();if(!can(user,'ec','ledger',write))deny();return;}
 if(head==='marketplace-receivables'){if(ns!=='ec'||!match||sub!=='/marketplace-receivables'||method!=='GET'||!can(user,'ec','ledger')||!can(user,'ec','orders'))deny();return;}
 let feature;
 if(!match){if(!['products','materials','recipes'].includes(head))deny();feature=head;}
 else if(head==='production'){feature=parts[1]==='material-stock'?'materialstock':parts.length===1&&!write?'production-read':'production';}
 else feature=({'party-profiles':'ledger',warehouse:ns==='ec'?'stock':null,'product-profile':ns==='ec'?'stock':'accounts',products:ns==='ec'?'stock':'products',stock:ns==='ec'?'stock':'accounts',sales:ns==='ec'?'sales':'accounts',documents:ns==='ec'?'invoices':'accounts',returns:ns==='ec'?'sales':'accounts',fees:ns==='ec'?'sales':'accounts',expenses:ns==='ec'?'expenses':'accounts',invoices:ns==='ec'?'invoices':'accounts',purchases:ns==='ec'?'invoices':'accounts',suppliers:ns==='ec'?'ledger':'accounts',payments:'ledger',catalog:'catalog',ledger:'ledger',statement:'ledger',offers:'offers',pricing:'pricing',reconciliation:'reconciliation',orders:'orders',reports:'orders',performance:'performance',panorama:'performance',
  // Ekranların arka plan uçları ekranın kendi yetkisiyle: Kaça satmalıyım = fiyat ekranı, ürün kârlılığı = stok ekranı.
  // Yalnız e-ticaret alanında; üretim alanında eşleme yok (kapalı kalır).
  'fiyat-hesap':ns==='ec'?'pricing':null,'urun-karlilik':ns==='ec'?'stock':null})[head];
 // Barkod yalnizca uretim alanindadir. Okumak icin kart gorme yetkisi yeter;
 // bagla/degistir icin depo ya da uretim yetkisi gerekir.
 // Parti ve koli etiketi uretim kayitlarina aittir; okumak icin urun gormek yeter.
// /api/ec/sales/documents satis KAYDI degil, satis FATURA BELGESIDIR: fatura yetkisi gerekir.
 if(head==='sales'&&parts[1]==='documents'){if(ns!=='ec'||!match)deny();if(!can(user,ns,'invoices',write))deny();return;}
 if(head==='lots'){if(ns!=='lp'||!match)deny();if(!any(user,'lp',write?['production','materialstock']:['products','production','materialstock','recipes'],write))deny();return;}
 if(head==='barcodes'){if(ns!=='lp'||!match)deny();if(!any(user,'lp',write?['materialstock','production']:['materials','products','materialstock','production','recipes'],write))deny();if(method==='DELETE'&&!user.permissions?.delete_records)deny();return;}
 if(feature==='production-read'){if(!any(user,'lp',['production','materialstock']))deny();return;}
 if(!feature||!can(user,ns,feature,write&&sub!=='/pricing/quote'))deny();
 if(method==='DELETE'&&(!user.permissions?.delete_records||ns==='lp'&&head==='products'&&!can(user,'lp','recipes',true)))deny();
 if(head==='orders'&&parts.at(-1)==='estimate'&&!can(user,ns,'pricing'))deny();
}
export function filterAccounting(x,user,ns){if(!user||user.owner)return x;if(ns==='lp')return can(user,ns,'accounts')?x:{...x,stock:[],sales:[],expenses:[],suppliers:[],invoices:[],movements:[],expense_schedules:[],other_income:[],pending_fee_cents:null};return {...x,stock:any(user,ns,['stock','sales','invoices'])?x.stock:[],sales:can(user,ns,'sales')?x.sales:[],expenses:can(user,ns,'expenses')?x.expenses:[],expense_schedules:can(user,ns,'expenses')?x.expense_schedules:[],other_income:can(user,ns,'expenses')?x.other_income||[]:[],suppliers:can(user,ns,'invoices')?x.suppliers.map(({balance_cents,purchase_cents,paid_cents,...s})=>s):[],invoices:can(user,ns,'invoices')?x.invoices:[],movements:can(user,ns,'stock')?x.movements:[],pending_fee_cents:any(user,ns,['reconciliation','performance'])?x.pending_fee_cents:null};}
export function filterProductionData(x,user){if(!user||user.owner)return x;return {...x,products:any(user,'lp',['products','recipes','costs'])?x.products:[],materials:any(user,'lp',['materials','recipes','costs'])?x.materials:[],recipes:any(user,'lp',['recipes','costs'])?x.recipes:[],activity:[]};}
export function filterProductionStock(x,user){if(!user||user.owner||can(user,'lp','production'))return x;return {...x,recipes:[],jobs:[]};}
export function filterInsights(x,user,ns){if(!user||user.owner||can(user,ns,'invoices'))return x;return {...x,purchase_invoices:[],purchase_invoices_truncated:false,fee_evidence:x.fee_evidence.map(({invoice_id,invoice_no,invoice_date,description,...e})=>e)};}

// Tutar yetkisi kapali kullanici icin para bilgisi yanittan cikarilir.
// Tek noktada uygulanir: yeni bir uc eklendiginde gizlemeyi ayrica hatirlamak gerekmez.
// Miktar, sevk ve durum bilgisi aynen kalir; yalnizca parasal alanlar null olur.
const MONEY_KEY=/(^|_)(cents|price|sale_price|unit_cost)$|_cents$/;
// 'gross' ve 'net_revenue' TL cinsinden para alanlaridir (rapor-stok koprusu onizlemesi).
// Arayuzde gizlemek yetmez: tutar yetkisi olmayan calisan API yanitindan da okuyamamali.
// Kaça satmalıyım (fiyat-hesap) yanıtı Türkçe adlı para/oran alanları taşır; aynı kuralla gizlenir.
const MONEY_NAMES=new Set(['price','sale_price','unit_cost','amount','total_cost','rate_bps','revenue_share_bps','margin_bps','gross','net_revenue',
 'fiyat','maliyet','kargo','hizmet','komisyon','stopaj','paketleme','diger','cebine','istenen','birim_maliyet_kdv_dahil','komisyon_orani','stopaj_orani',
 // Güvenlik incelemesi: bu alanlar *_cents kalıbına uymuyordu ve tutar yetkisi olmayan personele sızıyordu
 // (rapor–defter farkı, kesinti dağıtımı toplamları, pazaryeri paket brütü ve indirimleri).
 'report_gross','ledger_gross','missing_gross','commission','shipping','other','package_gross','package_seller_discount','package_platform_discount',
 // Zarar/kar eden paket SAYILARI da parasal sonuctur: tutari gizlemek "kac paket zarar etti"
 // sorusunu kapatmiyordu, sayilar ekranda basiliydi (panorama donemleri, kar raporu kanallari).
 // Bu uc ad yanitlarda YALNIZ sayi olarak uretilir, hicbir yerde tur etiketi degildir:
 // panorama-api.js:74,77 · performance-api.js:541,542 · attention-api.js:39 (yalniz yoneticiye acik uc).
 // Paket, hesaplanabilen ve eksik SAYILARI is bilgisidir ve gizlenmez.
 'losses','gains','cash_losses']);
// Rapor dosyasi para alanlari ('sale','net_payout','cargo','service','withholding' gibi) report-core
// FIELDS'ten gelir. GENEL kumeye KONULAMAZ: ayni adlar baska yanitlarda TUR ETIKETIDIR
// (operations-ui kinds.sale='Satis finans kayitlari', money-planning categories.packaging='Ambalaj',
// dashboard-summary basis.withholding='deduction_positive'). Bu yuzden yalnizca rapor kapsayicilarinin
// ICINDE gizlenir; kapsayici adi uzerinden taninir.
const REPORT_MONEY=new Set(Object.values(FIELDS).flat().filter(f=>f.type==='money').map(f=>f.key));
const REPORT_CONTAINERS=new Set(['totals','incoming','prior']);
// Recete gider kolonlari (migrations/0001_initial.sql). Recete satiri, uretim adedi ve fire payini
// birlikte tasimasiyla taninir; boylece ayni adi kategori etiketi olarak kullanan yanitlar bozulmaz.
const RECIPE_MONEY=new Set(['labor','packaging','overhead']);
// Serbest metne gomulen tutar anahtar bazli gizlenemez: metnin kendisi maskelenir
// ("Raporun bildirdigi hakedis (1.023,75 TL) ..." gibi notlar ve atlama gerekcelerinde).
// KURUSLU bicim sart kosulur; boylece siparis/paket numaralari ve adet gibi tam sayilar
// olduğu gibi kalir, yalnizca para gider.
// SIRA DA PARASAL BIR SINYALDIR. Hucre degerini null'lamak dizilisi null'lamiyor: para
// buyukluguyle dizilmis bir listede ilk oge en cok kazandiran, son oge en cok kaybettirendir.
// Uye olmanin KENDISI de sizdirir ('worst' = zarar eden paketler), bu yuzden bu listeler
// BOSALTILIR. Null YAPILMAZ: tuketici kod diziyi yayiyor ve .length okuyor
// (report-inbox-ui.js [...p.worst], s.worst.length), null gelirse ekran hic cizilmez.
// Uretenler: report-inbox-api.js worst · panorama-api.js urunSirasi · sales-presentation.js
// aggregateSales. Hicbir yanitta bu adlar tur etiketi degildir.
const RANK_EMPTY=new Set(['worst','top','bottom','revenue_top']);
// Set (ilan) listesi para sirasina gore dizilir ama BOSALTILAMAZ: ilan adi, satis adedi,
// paket sayisi ve bilesenler personelin isini yapmasi icin gerekir. Yalniz dizilis bozulur:
// ada gore alfabetik sirayla gider, kar sirasi kaybolur.
const RANK_SORTED={setler:'ad'};
const alfabetik=(list,field)=>Array.isArray(list)
 ?[...list].sort((a,b)=>String(a?.[field]??'').localeCompare(String(b?.[field]??''),'tr')):list;
const MONEY_TEXT=new Set(['notes','reason']);
const MONEY_IN_TEXT=/-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}/g;
const maskMoneyText=v=>typeof v==='string'?v.replace(MONEY_IN_TEXT,'(tutar gizli)'):Array.isArray(v)?v.map(maskMoneyText):v;
export function scrubAmounts(payload,user,ns){
 if(user?.owner||can(user,ns,'amounts'))return payload;
 // Aynı nesne yanıtta iki kez geçebilir: ikinci geçişte ÖZGÜN nesne değil, gizlenmiş kopyası döner.
 const seen=new WeakMap();
 const walk=(value,parent='')=>{
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return seen.get(value);
  const out=Array.isArray(value)?[]:{};seen.set(value,out);
  // Dizi ogeleri kapsayicinin adini DEVRALIR: totals/incoming/prior bir dizi icinde de gelebilir.
  if(Array.isArray(value))value.forEach((item,i)=>{out[i]=walk(item,parent);});
  else {
   // Panorama günlük satırında kanal anahtarları kuruştur; genel kanal metadata'sı değildir.
   // Şema nesnenin kendisinden tanınır: başka bir alandaki aynı nesne takma adı da gizlenir.
   const dailyCash=ns==='ec'&&typeof value.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value.date)&&Number.isSafeInteger(value.packages)
    &&['trendyol','hepsiburada'].every(k=>Object.hasOwn(value,k)&&(typeof value[k]==='number'||value[k]===null));
   const reportRow=REPORT_CONTAINERS.has(parent);
   const recipeRow=Object.hasOwn(value,'yield_qty')&&Object.hasOwn(value,'waste_pct');
   // Rapor kutusu tahmin satiri: tur + dayanak + deger ucunu birlikte yalniz bu satir tasir.
   const estimateRow=typeof value.type==='string'&&typeof value.basis==='string'&&Object.hasOwn(value,'value');
   // Tek siparis rekoru: tutar null'lansa bile "donemin en cok kazandiran siparisi" bilgisi
   // siparis KIMLIGININ kendisinde saklidir (panorama-api.js siparisRekorlari). 'records'
   // genel bir anahtar adi oldugu icin blok sema ile taninir; kapsam sayilari korunur.
   const orderRecords=Object.hasOwn(value,'revenue')&&Object.hasOwn(value,'profit')&&Object.hasOwn(value,'orders');
   for(const [key,item] of Object.entries(value)){
    // Loss labels and counts reveal financial outcomes too: hide the entire new signal.
    // recipe_json dondurulmus recete anlik goruntusudur: METIN oldugu icin walk icini acamaz,
    // icindeki iscilik/ambalaj/gider tutarlari suzgecten kurtuluyordu. Arayuz okumuyor.
    if(key==='sales_alerts'||key==='recipe_json'){out[key]=null;continue;}
    if(RANK_EMPTY.has(key)&&Array.isArray(item)){out[key]=[];continue;}
    if(RANK_SORTED[key]&&Array.isArray(item)){out[key]=alfabetik(walk(item,key),RANK_SORTED[key]);continue;}
    if(orderRecords&&(key==='revenue'||key==='profit')){out[key]=null;continue;}
    // Teslim edilen paketin kari hesaplandi mi sorusunun cevabi SAYIdir ve parasal sonuctur:
    // "462 kar birakan / 3 zarar eden" dugmeleri tutarlar gizliyken bile basiliydi.
    if(key==='profitable'||key==='losing'){out[key]=null;continue;}
    if(reportRow&&REPORT_MONEY.has(key)){out[key]=null;continue;}
    if(recipeRow&&RECIPE_MONEY.has(key)){out[key]=null;continue;}
    if(estimateRow&&(key==='value'||key==='low'||key==='high')){out[key]=null;continue;}
    if(MONEY_TEXT.has(key)){out[key]=maskMoneyText(walk(item,key));continue;}
    out[key]=MONEY_KEY.test(key)||MONEY_NAMES.has(key)||dailyCash&&(key==='trendyol'||key==='hepsiburada')?null:walk(item,key);
   }
  }
  return out;
 };
 return walk(payload);
}
