export const modules={
 ec:{webshop:['Web Mağaza','Kendi sitenin müşterileri, test siparişleri, kargoları ve talepleri; pazaryerinden ayrı.'],orders:['Siparişler','Müşteri, kargo, satış tutarı, maliyet ve paket içeriği.'],performance:['Satış ve kâr','Tekli ürün, çoklu paket ve set satışlarının sonucu; iadeler ve kargodaki tahminler.'],sales:['Satış ve kesinti kayıtları','Tek tek satış, iade ve kesinti kaydı girme/düzeltme; ürün ve stok maliyeti.'],stock:['Depomdaki ürünler','Tek tek ürün stoğu, ayrılmış ve kargodaki miktarlar; depo sayımı ve hareketler.'],catalog:['Ürün eşleştirme ve setler','İlan ve alış eşleşmeleri; ürün ve tedarikçi adları.'],invoices:['Alış faturaları','Belge, tedarikçi, tutarlar, ürün stoğu ve mal teslimleri.'],ledger:['Cariler ve nakit','Cari bilgileri, borç/alacak, kasa, banka ve kapamalar.'],reconciliation:['Kesinti eşleştirme','Kesinti belgeleri ve bağlantılı satış tutarları.'],offers:['Teklif ve belgeler','Teklif, proforma ve sözleşme belgeleri; müşteri bilgileri ve belge tutarları.'],pricing:['Satış fiyatı hesapla','Maliyetler, kargo/komisyon tarifeleri ve fiyat hesabı.'],expenses:['Genel giderler','İşletme giderleri ve alış düzeltme farkları.'],brand_documents:['Belge Atölyesi','Teklif, proforma ve kurumsal evrak tasarımı; belgeye geçen müşteri, ürün ve tutar bilgileri.'],brand_logos:['Logo Kütüphanesi','Onaylı logo dosyaları; renk, yerleşim ve boyut seçip indirme.'],amounts:['Tutarlar ve maliyetler','Miktarların yanında para bilgisi: alış maliyeti, satış tutarı, kâr, cari bakiye ve fiyat. Kapatılırsa miktar ve sevk bilgisi görünmeye devam eder.']},
 lp:{products:['Ürünler','Ürün kartları ve satış fiyatları.'],materials:['Hammaddeler','Hammadde kartı, fiyat, tedarikçi ve depo miktarı.'],recipes:['Reçeteler','Reçeteler ve hesap için ürün/hammadde bilgileri.'],costs:['Maliyet hesaplama','Reçete, ürün ve hammadde maliyet bilgileri.'],production:['Üretim kayıtları','Üretim, tüketim, hammadde ve parti maliyetleri.'],materialstock:['Hammadde deposu','Hammadde miktarları, değerleri ve depo hareketleri.'],accounts:['Alış ve stok','Bu ortak ekrandaki alış, stok, satış ve gider kayıtları.'],catalog:['Ürün bağlantıları','Tedarikçi/marka eşleştirmeleri ve ürün adları.'],ledger:['Cariler ve nakit','Cari bilgileri, borç/alacak, kasa ve banka.'],offers:['Teklif ve belgeler','Teklif, proforma ve sözleşme belgeleri; müşteri bilgileri ve belge tutarları.'],reconciliation:['Kesinti eşleştirme','Kesinti belgeleri ve bağlantılı satışlar.'],brand_documents:['Belge Atölyesi','Teklif, proforma ve kurumsal evrak tasarımı; belgeye geçen müşteri, ürün ve tutar bilgileri.'],brand_logos:['Logo Kütüphanesi','Onaylı logo dosyaları; renk, yerleşim ve boyut seçip indirme.'],amounts:['Tutarlar ve maliyetler','Miktarların yanında para bilgisi: alış maliyeti, satış tutarı, kâr, cari bakiye ve fiyat. Kapatılırsa miktar ve sevk bilgisi görünmeye devam eder.']}
};
export const levels={none:0,read:1,write:2};
// Gecis kurali: tutar yetkisi bu surumden once kaydedilmis hesaplarda hic yer almaz.
// Kayitta anahtar yoksa eski davranis korunur (zarf ne veriyorsa o); yonetici acik secim
// kaydettiginde yeni harita gecerli olur. Boylece guncelleme kimsenin gorunumunu sessizce daraltmaz.
// Bu anahtarlar MIRASLA ACILMAZ. permissions:null olan eski hesapta zarf seviyesi butun
// anahtarlari acar; yeni bir ekran eklenince eski personel onu kimse secmeden kazanirdi.
// Yonetici Ekip ve yetkiler ekranindan acikca secene kadar kapali kalirlar.
const OPT_IN=new Set(['webshop','brand_documents','brand_logos']);
export function level(user,ns,key){if(user?.owner)return 'write';const envelope=user?.[ns+'_access']||'none';if(!modules[ns]?.[key])return 'none';
 const stored=user?.permissions?.[ns];if(OPT_IN.has(key)&&!stored?.[key])return 'none';const legacy=key==='amounts'&&stored&&!Object.hasOwn(stored,'amounts');
 const selected=!user?.permissions||legacy?envelope:stored?.[key]||'none';
 return levels[selected]<levels[envelope]?selected:envelope;}
export const can=(user,ns,key,write=false)=>levels[level(user,ns,key)]>=(write?2:1);
export const any=(user,ns,keys,write=false)=>keys.some(k=>can(user,ns,k,write));
// Bazi ekranlar mevcut bir yetkinin altinda calisir; her ekran icin yeni yetki acmak,
// kayitli personel yetkilerinde o anahtar bulunmadigi icin herkesi disarida birakirdi.
// 'documents' (Fatura belgeleri) alis ve satis fatura BELGELERINI gosterir: 'invoices' yetkisi.
const BRAND_ROUTES={'belge-atolyesi':'brand_documents','logo-kutuphanesi':'brand_logos'};
// Yetki anahtari ile rota adi ayni olmayabilir: personel kartlari rotaya gider.
const MODULE_ROUTE=Object.fromEntries(Object.entries(BRAND_ROUTES).map(([route,key])=>[key,route]));
export const moduleRoute=key=>MODULE_ROUTE[key]||key;
// Marka modulleri e-ticaretin ya da uretimin icinde DEGIL; /atolye/ ayri bir uygulamadir.
// Personel kartlari ve kisayollar oraya gider, calisma alani adreste tasinir.
export const moduleHref=(ns,key)=>key==='webshop'?'/webmagaza/'
 :MODULE_ROUTE[key]?'/atolye/#'+MODULE_ROUTE[key]+'?alan='+ns:'#'+key;
const routeAliases={ec:{documents:'invoices',reports:'orders',bank:'ledger',party:'ledger',warehouse:'stock',product:'stock',money:'ledger','business-result':'performance',...BRAND_ROUTES},lp:{party:'ledger',product:'accounts',money:'ledger',...BRAND_ROUTES}};
export const routeKey=(ns,route)=>routeAliases[ns]?.[route]||route;
// Match route-level OR permissions already enforced by the API; amount access alone is not a screen.
export function canRoute(user,ns,route,write=false){
 if(route==='money')return !write&&can(user,ns,'ledger')&&can(user,ns,'amounts');
 if(route==='business-result')return ns==='ec'&&!write&&['performance','expenses','amounts'].every(k=>can(user,ns,k));
 if(route==='workbench')return Object.keys(modules[ns]||{}).some(k=>k!=='amounts'&&can(user,ns,k,write));
 if(route==='intake')return can(user,ns,'amounts')&&(ns==='ec'?any(user,ns,['invoices','orders'],true):can(user,ns,'accounts',true));
 if(ns==='lp'&&route==='barcodes')return any(user,ns,write?['materialstock','production']:['materials','products','materialstock','production','recipes'],write);
 if(ns==='lp'&&route==='lots')return any(user,ns,write?['production','materialstock']:['products','production','materialstock','recipes'],write);
 return can(user,ns,routeKey(ns,route),write);
}
export function parsePermissions(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['ec','lp','delete_records'].includes(k)))throw Error('Yetki seçimini kontrol edin.');const out={ec:{},lp:{},delete_records:value.delete_records===true};if(value.delete_records!==undefined&&typeof value.delete_records!=='boolean')throw Error('Silme izni geçersiz.');for(const ns of ['ec','lp']){const group=value[ns]||{};if(typeof group!=='object'||Array.isArray(group)||Object.keys(group).some(k=>!modules[ns][k]))throw Error('Bilinmeyen yetki alanı.');for(const key of Object.keys(modules[ns])){const v=group[key]||'none';if(!Object.hasOwn(levels,v))throw Error('Yetki seviyesi geçersiz.');out[ns][key]=v;}}return out;}
export const envelope=(permissions,ns)=>Object.values(permissions[ns]).includes('write')?'write':Object.values(permissions[ns]).includes('read')?'read':'none';
