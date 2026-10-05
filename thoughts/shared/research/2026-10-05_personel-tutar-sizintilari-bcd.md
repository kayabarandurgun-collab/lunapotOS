# Personel tutar sızıntıları — B/C/D grupları

Kaynak: 2026-10-04/05 denetimi (34 ajan, 28 iddia → 22 onaylandı, 6 çürütüldü) + 3 ek bulgu.
Her bulgu `scrubAmounts` gerçekten çalıştırılarak kanıtlandı.
**A grubu** (personelin doğrudan TL okuduğu 7 yer) commit `ce8f565` ile KAPATILDI.
Aşağıdakiler AÇIK.

## Yöntem notu — bunu atlamayın

Genel ad kümesine (`MONEY_NAMES`) ad **EKLEMEYİN**: aynı adlar başka yanıtlarda tür
etiketidir (`kinds.sale` = "Satış finans kayıtları", `categories.packaging` = "Ambalaj",
`basis.withholding` = "deduction_positive"). Eklenirse o etiketler boşalır.
A grubunda kullanılan ve çalışan yöntem: **kapsayıcı/şema bazlı gizleme** —
`src/permission-policy.js` içindeki `REPORT_CONTAINERS`, `RECIPE_MONEY`, `estimateRow`
kalıplarına bakın ve aynısını sürdürün. Testler: `tests/amount-permission.test.js`.

## B — Zarar eden paket SAYILARI — 2 yer

### [yuksek] Sipariş listesinin kâr/zarar süzgeci, zarar eden siparişlerin tam listesini tutar yetkisi olmayan personele enumere ettiriyor.
- alan: sonuc=zarar süzgeci (sorgu parametresi) + filtrelenmiş packages dizisi
- üreten: src/orders-api.js:139
- gösteren: public/orders-ui.js:128 · ekranda görünür: true
- personel ne çıkarır: orders-api.js:139 'hepsi=hepsi.filter(... sonuc==='kar'?n>0:n<0)' — süzme SUNUCUDA, nakit sonuca göre yapılıyor ve yetki kontrolü yok (orders-query.js:17 yalnız değer doğruluyor). orders-ui.js:128 'Zarar edenler' düğmesini herkese basıyor. Personel düğmeye basıp zarar eden paketlerin TAMAMINI sayfa sayfa listeleyebiliy
- önerilen düzeltme: En az degisiklikle, iki dosya (sunucu tarafi tek basina sizintiyi kapatir; arayuz degisikligi olmazsa dugmeler bosa basar): 1) SUNUCU — C:/Users/baran/Desktop/site/lunapot-panel/src/orders-api.js a) Dosya basina (satir 5'ten sonra): import {can} from '../public/permissions.js'; b) satir 127'den hemen sonra ekle: const paraGorur=!env.USER||can(env.USER,'ec','amounts'); // env.USER worker.js:164'te zaten set ediliyor; owner icin can() true if(!paraGorur&&son

### [orta] Genel durum API'si her dönem için zarar ve kâr eden paket sayısını personelin tarayıcısına gönderiyor.
- alan: losses / gains (periods[].losses, periods[].gains, pending.losses)
- üreten: src/panorama-api.js:74
- gösteren: public/panorama-ui.js:47 · ekranda görünür: false
- personel ne çıkarır: ÖLÇÜLDÜ: {losses:2, gains:1} aynen geçiyor, loss_cents/gain_cents null oluyor. /api/ec/panorama personele açık (permission-policy.js:30 'panorama'→'performance'; önizlemedeki reader rolünde performance=read) ve performance-ui.js:245 'Tüm zamanlar' seçildiğinde bu ucu personel adına GERÇEKTEN çağırıyor. Yanıt 7 dönemin 
- önerilen düzeltme: Tek satırlık, en az değişiklikli kesin düzeltme — C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js, MONEY_NAMES kümesi (satır 58-62): 62. satırdaki son diziye 'losses' ve 'gains' ekle: 'report_gross','ledger_gross','missing_gross','commission','shipping','other','package_gross','package_seller_discount','package_platform_discount','losses','gains' Neden bu yeterli ve güvenli: - worker.js:165 tüm panorama yanıtını scrubAmounts'tan geçirdiğ

## C — Para sırasına göre SIRALAMALAR — 11 yer

### [yuksek] Rapor kutusu özeti teslim edilen paketlerin kaçının zarar ettiğini sayı olarak personele yazıyor.
- alan: losing / profitable / uncomputed / delivered / not_delivered / computed
- üreten: src/report-inbox-api.js:822
- gösteren: public/report-inbox-ui.js:277 · ekranda görünür: true
- personel ne çıkarır: ÖLÇÜLDÜ: scrubAmounts sonrası {profitable:462, losing:3, uncomputed:21, delivered:520} aynen geçiyor; yalnız *_cents alanları null oluyor. Ekranda 'Kâr bırakan 462 / Zarar eden 3 / Hesaplanamayan 21' düğmeleri basılı. Personel (orders=read yeterli, #reports ekranı) mağaza bazında kaç paketin para kaybettirdiğini ve kaç
- önerilen düzeltme: Iki dosya, iki kucuk ekleme. Sunucu tarafi tek basina yeter (sizinti orada kapanir); arayuz eklemesi bos tile gostermemek icin. 1) SUNUCU - C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js, scrubAmounts icinde. 'dailyCash' sema tanima satirinin (satir 75-76) hemen ardina ayni usulle ikinci bir sema tanima ekle: const orderOutcome=ns==='ec'&&Array.isArray(value.worst)&&Array.isArray(value.blocked) &&['packages','delivered','profitable','lo

### [yuksek] 'En çok zarar ettiren paketler' tablosu sipariş no ve ürün adlarıyla, zarar büyüklüğüne göre sıralı olarak personele gidiyor.
- alan: worst[] (cash_result_cents'e göre artan sıralı dizi: order_no, products, order_date, delivered_on)
- üreten: src/report-inbox-api.js:838
- gösteren: public/report-inbox-ui.js:285 · ekranda görünür: true
- personel ne çıkarır: ÖLÇÜLDÜ: worst dizisi sunucuda report-inbox-api.js:820'de 'sort((a,b)=>a.cash_result_cents-b.cash_result_cents)' ile EN KÖTÜDEN iyiye diziliyor; scrubAmounts sadece hücre değerlerini null yapıyor, dizinin SIRASI aynen kalıyor. report-inbox-ui.js:66'daki istemci yeniden sıralaması null-null çıkarması (NaN) üretiyor, yan
- önerilen düzeltme: EN AZ DEGISIKLIKLE, TEK NOKTADAN (mevcut 'sales_alerts' kalibinin aynisi): 1) src/permission-policy.js — scrubAmounts() icindeki walk() dongusu, su anda: if(key==='sales_alerts'){out[key]=null;continue;} Bu satirin yanina ekle: if(key==='worst'||key==='profitable'||key==='losing'){out[key]=null;continue;} Bu uc anahtar tum src/ icinde SADECE src/report-inbox-api.js:837,838,846'da uretiliyor (grep ile dogrulandi), baska yanitla cakismaz. 'blocked' DOKUNULMA

### [yuksek] Set (ilan) kârlılığı listesi sunucudan en zararlı ilan en üstte gelecek şekilde sıralı basılıyor; personel ilanların kârlılık sıralamasını okuyor.
- alan: setler[] (paket_basina_cents'e göre artan sıralı dizi: ad, bilesim, bilesenler)
- üreten: src/urun-karlilik-api.js:156
- gösteren: public/accounting-ui.js:89 · ekranda görünür: true
- personel ne çıkarır: ÖLÇÜLDÜ: setler dizisi urun-karlilik-api.js:156'da 'sort((a,b)=>(a.paket_basina_cents??Infinity)-(b.paket_basina_cents??Infinity))' ile en kötü paket başına sonuç en üste alınıyor; scrubAmounts tutarları null yapıyor ama sıra aynen kalıyor. public/accounting-ui.js:81-82'deki yorum da bunu söylüyor: 'sıralama sunucudan 
- önerilen düzeltme: En az degisiklikle kesin duzeltme — tek nokta: C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js, scrubAmounts icindeki walk() dongusu, satir 79 (`if(key==='sales_alerts'){out[key]=null;continue;}` satirinin hemen yanina): A) Kesin ve en kucuk degisiklik (sales_alerts ile ayni kalip, siralama sinyalini tamamen yok eder): if(key==='setler'){out[key]=null;continue;} Guvenli: public/accounting-ui.js:124 `k.setler||[]` ile [] yapar, public/acc

### [orta] Ürün ve satış biçimi sıralamaları (en çok/en az kazandıran) kâr büyüklüğüne göre dizili olarak personele gidiyor.
- alan: periods[].products.top / .bottom / .revenue_top ve periods[].sales.top / .bottom / .revenue_top
- üreten: src/panorama-api.js:106
- gösteren: public/panorama-ui.js:64 · ekranda görünür: false
- personel ne çıkarır: ÖLÇÜLDÜ: top ['Torf 20 L','Saksi 14 cm','Perlit 10 L'] ve bottom tam tersi sırada geliyor, cash_cents hepsinde null. Sıralama panorama-api.js:106-109 (ve sales-presentation.js:246-247) sunucuda kâra göre yapıldığı için ürün ADLARI kâr sırasında kalıyor: ilk eleman en çok kazandıran, bottom'ın ilk elemanı en çok kaybett
- önerilen düzeltme: Tek satirlik, en az degisiklik — siralamayi anahtar bazli gizlemeye dahil et: DOSYA: C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js SATIR: 78 (MONEY_NAMES kumesinin son satiri, 'package_platform_discount' sonrasi) YAPILACAK: kumeye 'top','bottom','revenue_top' ekle: 'report_gross','ledger_gross','missing_gross','commission','shipping','other','package_gross','package_seller_discount','package_platform_discount', // Sıralamanın KENDİSİ p

### [orta] Dönemin en yüksek ciro ve en çok para bırakan siparişinin kimliği (sipariş no, kanal, tarih) personele bildiriliyor.
- alan: periods[].records.revenue ve periods[].records.profit (order_no, external_id, channel, packages)
- üreten: src/panorama-api.js:130
- gösteren: public/panorama-ui.js:79 · ekranda görünür: false
- personel ne çıkarır: ÖLÇÜLDÜ: records.profit {order_no:'4612345678', channel:'trendyol'} aynen geçiyor, cash_cents null. best('cash_cents') (panorama-api.js:129) rekoru sunucuda seçtiği için tutar gizlense de 'en çok cebine kalan sipariş HANGİSİ' bilgisi açık; personel o siparişi #orders penceresinde açıp içeriğinden (ürün, adet, kanal) pa
- önerilen düzeltme: Dosya: C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js — scrubAmounts içindeki nesne döngüsü, satır 79 (`if(key==='sales_alerts'){out[key]=null;continue;}`) hemen ARDINA tek satır ekle: if(key==='records'&&item&&typeof item==='object'&&!Array.isArray(item)&&Object.hasOwn(item,'revenue')&&Object.hasOwn(item,'profit')&&Object.hasOwn(item,'orders')){out[key]=null;continue;} Neden bu biçim: `records` genel bir anahtar adı (ör. operations-ui.

### [yuksek] Set (ilan) karliligi listesi sunucuda EN KOTU PAKET BASINA SONUC EN USTTE siralanir ve bu sira tutar yetkisi olmayan personelin ekraninda aynen cizilir.
- alan: setler[] (dizi sirasi; ogeler: ad, paket, adet_milli, bilesenler)
- üreten: src/urun-karlilik-api.js:156
- gösteren: public/accounting-ui.js:226 · ekranda görünür: true
- personel ne çıkarır: Depomdaki urunler ekraninda 'Satis donemi ve set sonuclari' acildiginda listenin BASINDAKI ilan en cok zarar ettiren, SONUNDAKI en cok kazandiran ilandir. Tutarlar 'Hesaplanamadi'/'bilinmiyor' yazsa da personel ilanlarin karlilik siralamasinin tamamini okur. OLCUM: scrubAmounts'tan gecirilen 3 setli ornek, setProfitLis
- önerilen düzeltme: KOK NEDEN: para alanini null'lamak siralamayi null'lamiyor. Sira bagimsiz bir parasal sinyaldir ve tek suzgec noktasi (scrubAmounts) siralari hic ele almiyor. EN AZ DEGISIKLIKLE KESIN DUZELTME — src/permission-policy.js, scrubAmounts icindeki for dongusu (satir 77-81), mevcut 'sales_alerts' kuralinin (satir 79) HEMEN YANINA, ayni kalipta: // Sira da parasal bir sinyaldir: en kotu paket basina sonuc en ustte dizilmis liste (urun-karlilik-api.js:156) // tuta

### [yuksek] Rapor yukleme ekranindaki 'En cok zarar ettiren paketler' tablosu, tutarlar '—' olsa da en kotuden en iyiye sirali olarak personele cizilir.
- alan: worst[] (dizi sirasi; ogeler: order_no, products, order_date, delivered_on)
- üreten: src/report-inbox-api.js:846
- gösteren: public/report-inbox-ui.js:285 · ekranda görünür: true
- personel ne çıkarır: Baslik zaten 'En cok zarar ettiren paketler'; dizi report-inbox-api.js:822'de cash_result_cents'e gore ARTAN (en kotu basta) siralanir ve en fazla 50 satir gonderilir. Personel hangi siparisin en buyuk zarar oldugunu, hangi urunleri icerdigini ve sirayi ogrenir. Istemcideki yeniden siralama (report-inbox-ui.js:66, a.co
- önerilen düzeltme: EN AZ DEGISIKLIKLE KESIN DUZELTME — iki noktada, ikisi de sunucu tarafi (arayuze guvenilmez): 1) C:/Users/baran/Desktop/site/lunapot-panel/src/report-inbox-api.js:846 ve 848 worst[] ve blocked[] dizileri para buyuklugune gore sirali oldugu icin DIZININ KENDISI parasal bilgidir; icindeki *_cents null'lanmasi yetmez. orderSummary()'ye user parametresi gecirilip (worker.js:165 handler zinciri zaten current.user'i tasiyor degil — bu yuzden en kucuk degisiklik 

### [orta] Panorama yanitindaki satis bicimi siralamalari (top / bottom / revenue_top) tutar yetkisi olmayan personelin tarayicisina para sirasiyla eksiksiz iner.
- alan: periods[].sales.top, .sales.bottom, .sales.revenue_top (ayrica selected_period.sales.*)
- üreten: src/sales-presentation.js:244
- gösteren: public/performance-ui.js:245 · ekranda görünür: false
- personel ne çıkarır: OLCUM: scrubAmounts sonrasi sales.top = ['Yildiz urun','Orta urun','Zararli urun'] (kar azalan), sales.bottom = ['Zararli urun','Orta urun','Yildiz urun'] (kar artan), sales.revenue_top ciro azalan — dizi BOSALMIYOR, yalniz cash_cents/revenue_gross_cents null oluyor; name, packages, units_milli duruyor. Personelin acab
- önerilen düzeltme: Dosya: C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js (scrubAmounts, satir 63-81) 1) Satir 63'un hemen ustune (MONEY_NAMES tanimindan sonra) ekle: // Para sirasina gore dizilmis siralamalar: tutarlar null'lansa bile DIZILIS kar/ciro buyuklugunu // aciga vuruyor (ilk = en kazandiran, bottom[0] = zarar eden). sales_alerts gibi butunuyle gizlenir. const RANK_KEYS=new Set(['top','bottom','revenue_top']); 2) Satir 79'daki sales_alerts satiri

### [orta] Panorama'nin urun siralamasi (urunSirasi) para buyuklugune gore dizili uc liste uretir ve hic bir ekran kullanmadigi halde personele gonderilir.
- alan: periods[].products.top, .products.bottom, .products.revenue_top
- üreten: src/panorama-api.js:106
- gösteren: public/performance-ui.js:245 · ekranda görünür: false
- personel ne çıkarır: src/panorama-api.js:106 top'u cash_cents azalan, :108 bottom'u cash_cents artan, :109 revenue_top'u revenue_gross_cents azalan siralar; her oge name + qty_milli + packages tasir ve panorama-api.js:191'de her donemin icine konur. scrubAmounts yalniz cash_cents / revenue_gross_cents / per_unit_cents'i null yapar, DIZININ
- önerilen düzeltme: BIRINCIL (en az degisiklik, tek nokta, sahip ve testler etkilenmez) — C:/Users/baran/Desktop/site/lunapot-panel/src/permission-policy.js, scrubAmounts icindeki walk() fonksiyonu: 1) 'dailyCash' tespitinin hemen altina (dosyadaki `const dailyCash=...` satirindan sonra) sekil tespiti ekle: const urunSirasi=value.role==='stock_component_contribution'&&Array.isArray(value.top)&&Array.isArray(value.bottom)&&Array.isArray(value.revenue_top); 2) Ayni for dongusun

### [orta] 'Tek siparişte rekorlar' kaydi, en yuksek cirolu ve en cok kar birakan SIPARISIN KIMLIGINI (siparis no, kanal, paket id) tutar yetkisi olmayan personele gonderir.
- alan: periods[].records.revenue, periods[].records.profit (order_no, external_id, channel, id, package_ids)
- üreten: src/panorama-api.js:129
- gösteren: public/panorama-ui.js:120 · ekranda görünür: false
- personel ne çıkarır: best(field) tek bir kazanani secer; tutar null'lansa bile 'bu siparis donemin en yuksek cirolu siparisi' bilgisi kimligin kendisinde saklidir. OLCUM: reader rolu icin scrubAmounts'tan gecen records.revenue = {order_no:'TY-9001', channel:'trendyol', revenue_gross_cents:null}, records.profit = {order_no:'HB-7733', cash_c
- önerilen düzeltme: En az degisiklikle kesin duzeltme — src/permission-policy.js, scrubAmounts icindeki walk dongusu (satir 77-81), key==='sales_alerts' kuralinin (satir 79) hemen yanina sema tanimali ikinci bir kural ekle: for(const [key,item] of Object.entries(value)){ if(key==='sales_alerts'){out[key]=null;continue;} + // Tek siparis rekoru: tutar null'lansa bile 'donemin en yuksek cirolu siparisi' bilgisi + // siparis kimliginin KENDISINDE saklidir. Blogu sema ile taniyip

### [orta] Urun karliligi ucu, hic bir ekranin okumadigi iki para-sirali satis bicimi siralamasini (teslim edilenler ve kargodakiler) personele gonderir.
- alan: sales.top / sales.bottom / sales.revenue_top ve pending.sales.top / .bottom / .revenue_top
- üreten: src/urun-karlilik-api.js:157
- gösteren: public/accounting-ui.js:124 · ekranda görünür: false
- personel ne çıkarır: urun-karlilik-api.js:146 aggregateSales(teslim) ve :158 aggregateSales(kargoda) cagirir; ikisi de sales-presentation.js:244-246'daki kar azalan / kar artan / ciro azalan dizileri tasir. accounting-ui.js:124 yanittan yalniz rows, setler, notice, set_notice okur — 'sales' ve 'pending' payload'da bosa gider ama agda gorun
- önerilen düzeltme: Dosya: C:/Users/baran/Desktop/site/lunapot-panel/src/urun-karlilik-api.js, satir 157-158. Hicbir ekran bu uc diziyi okumadigi icin en az degisiklikli kesin duzeltme ONLARI YANITTAN CIKARMAK (gizlemek degil — ustelik null'lamak sirayi silmez, scrubAmounts anahtar bazli calistigi icin siralamayi hicbir sekilde kurtaramaz): 1) 157. satirin hemen oncesine (146'dan sonra) siralamasiz bir yardimci koy: const siralamasiz = ({top, bottom, revenue_top, ...x}) => x;

## D — Yanlış "sorun yok" izlenimi — 2 yer

### [yuksek] Kesinti eşleştirme ekranı personele 'Dağıtılmayı bekleyen kesinti yok.' diyor ve bekleyen belge satırı sayısını 0 gösteriyor
- alan: fee_lines[].remaining_cents ve pending_cents (GET /api/ec/reconciliation)
- üreten: src/reconciliation-api.js:22
- gösteren: public/reconciliation-ui.js:23 · ekranda görünür: true
- personel ne çıkarır: Ekranın varsayılan görünümü state.filter='pending' (reconciliation-ui.js:11). Liste süzgeci l.remaining_cents>0 olduğu için null tüm satırları atar ve table() boş durumu basar: 'Dağıtılmayı bekleyen kesinti yok.' Aynı şekilde satır 18'deki pending=fee_lines.filter(l=>l.remaining_cents>0) boş kalır ve 'Bekleyen belge sa
- önerilen düzeltme: EN AZ DEGISIKLIKLE KESIN DUZELTME — parasal olmayan bir DURUM BAYRAGI uret, arayuz tutar yerine onu okusun. (Tutarlar gizli kalmaya devam eder; yalnizca "bu satir bekliyor mu" bilgisi personele dogru gider.) 1) C:/Users/baran/Desktop/site/lunapot-panel/src/reconciliation-api.js:22 fee_lines map'ine parasal olmayan bir bayrak ekle ve bekleyen satir sayisini sunucuda hesapla. Mevcut: return {fee_lines:feeLines.slice(0,1000).map(l=>({...l,remaining_cents:l.ne

### [yuksek] Her bekleyen kesinti faturası satırına personelde yeşil 'Tamamlandı' rozeti basılıyor
- alan: fee_lines[].remaining_cents (GET /api/ec/reconciliation)
- üreten: src/reconciliation-api.js:22
- gösteren: public/reconciliation-ui.js:23 · ekranda görünür: true
- personel ne çıkarır: Satır sonu ifadesi: l.remaining_cents>0 ? 'Satışlara dağıt' düğmesi : '<span class="v2-badge success">Tamamlandı</span>'. null ile her satır YEŞİL 'Tamamlandı' rozeti alır. 'Tüm kesinti faturaları' görünümünde personel, hiç dağıtılmamış faturaları bile tamamlanmış görür — bu sadece bilgi eksikliği değil, aktif biçimde 
- önerilen düzeltme: Kok neden: `null`, `null>0 === false` oldugu icin 'tam dagitildi' ile ayni dala dusuyor. En az degisiklikle kesin duzeltme — iki nokta, ikisi de public/reconciliation-ui.js: (1) Satir 23 (renderList, fee_lines satir sonu hucresi). Su ifade: l.remaining_cents>0?btn('Satışlara dağıt','allocate',l.id,true):'<span class="v2-badge success">Tamamlandı</span>' yerine null'u ucuncu bir durum yap: l.remaining_cents===null||l.remaining_cents===undefined ?'<span clas

## Tamamlık eleştirisinin ek bulguları — 3

### [yuksek] Siparişler ekranının 'Sonuç' süzgeci, kâr eden ve zarar eden paket SAYILARINI sunucudan hazır alıp tutar yetkisi olmayan personelin ekranına basıyor: 'Zarar edenler (8)'.
- alan: sonuc_counts.zarar / sonuc_counts.kar / sonuc_counts.hepsi (GET /api/ec/orders)
- üreten: src/orders-api.js:138
- düzeltme: src/orders-api.js:138'de sayıları yetkiye bağla: const sonucSayilari = (env.USER?.owner || can(env.USER,'ec','amounts')) ? {hepsi:...,kar:...,zarar:...} : null; (dosya zaten public/permissions.js'ten can import edebiliyor). Alternatif ve tek noktada çözüm: src/permission-policy.js:79'daki sales_alerts kuralının yanına 

### [orta] Kâr raporu ucu, kanal başına zarar eden paket sayısını (losses ve cash_losses) tutar yetkisi olmayan personelin tarayıcısına gönderiyor; bütün kuruş alanları null olsa bile sayılar sağlam geliyor.
- alan: channels[].losses ve channels[].cash_losses (GET /api/ec/performance)
- üreten: src/performance-api.js:541
- düzeltme: src/performance-api.js:541-542'de iki sayıyı da tutar yetkisine bağla (yoksa null): losses: amountsOK ? complete.filter(r=>r.profit_cents<0).length : null ve cash_losses: amountsOK ? nakitli.filter(r=>r.cash_cents<0).length : null. Tek noktada çözüm tercih edilirse src/permission-policy.js'deki MONEY_NAMES kümesine 'lo

### [orta] Dağıtılmamış kesinti uyarısı personelde sessizce kayboluyor: unallocated_fee_cents null'landığı için 'Mutabakat bekliyor — dönem sonucu tamamlanmış sayılmaz' kutusu personelin açabildiği Kâr raporu ekranında HİÇ oluşmuyor.
- alan: unallocated_fee_cents (GET /api/ec/performance yanıt kökü)
- üreten: src/permission-policy.js:54
- düzeltme: Tutarı sızdırmadan uyarıyı koru: src/performance-api.js'de yanıta parasal olmayan bir bayrak ekle (ör. unallocated_fee_pending: pendingFees.cents>0) ve public/performance-ui.js:221 koşulunu `state.unallocated_fee_pending || state.unallocated_fee_cents>0` yap; kutu metninde money(...) çağrısını tutar null ise atla ('Hen

## Çürütülenler — yeniden araştırmayın

- unallocated_fee_cents — İddia doğrulandı (confirmed=true). reaches_staff=false ve shown_in_ui=false, iddiayı çürütmek için değil, kusurun YÖNÜNÜ doğru yazmak için: unallocated_fee_cents personele hiç ulaşmıyor (scrubAmounts 
- unallocated_fee_cents (GET /api/ec/panorama kökü) — Iddia edilen gosterim noktasi personele ulasmiyor. panorama-ui.js:89 yalnizca #overview ekraninda calisir ve public/ecommerce.js:56 sahip olmayan her kullaniciyi bu ekrandan cikarip staffHome'a yonlen
- unallocated_fee_cents (GET /api/ec/panorama kökü) — Iddianin markup olcumu dogru ama tasidigi sonuc yanlis: "personel ekranda hicbir kapsam uyarisi gormez" cumlesi, personelin o ekrani gordugunu varsayiyor. Gormuyor. public/ecommerce.js:56 owner olmaya
- unallocated_fee_cents (GET /api/ec/performance) — İddia metni "uyarı kutusu personelde hiç görünmüyor" diyor; bu ÖLÇÜLDÜ ve DOĞRU (yukarıdaki çıktı). Ancak harness'ın aradığı sınıf olan "personel parasal sonucu çıkarıyor" anlamında SIZINTI YOK: alan 
- pending_fee_cents (GET /api/lp ve GET /api/ec) — kanit yok
- sales_alerts (GET /api/ec/panorama) — IDDIA CURUTULDU - cunku Akilli Takip ekrani personele HIC acilmiyor. public/ecommerce.js:56 `if(current==='overview'&&!currentUser.owner){content.innerHTML=staffHome(currentUser,'ec');return;}` satiri

## Genel durum ekranı personele HİÇ açılmıyor

`public/ecommerce.js:56` sahip olmayan kullanıcıyı `#overview` ekranından çeviriyor.
Devirde "panorama kesinti yok diyor" diye yazan endişe ORADA geçersizdir; aynı hata
kesinti eşleştirme (reconciliation) ekranında GERÇEKTİR — D grubuna bakın.
