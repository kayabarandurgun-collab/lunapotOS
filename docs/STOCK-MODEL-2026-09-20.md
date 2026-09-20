# Fiziksel stok ve sayım — 2026-09-20

## Sonuç ve alan sözleşmesi

Uygulandı. `GET /api/ec` muhasebe yanıtında mevcut `stock[]` alanları korunur:

| Alan | Tip / anlam |
| --- | --- |
| `on_hand_milli` | integer/null; `quantity_milli` ile aynı kayıtlı fiziksel depo bakiyesi |
| `reserved_milli` | integer/null; bırakılmamış rezervasyon, depoda henüz gönderilmemiş miktar |
| `available_milli` | integer/null; yalnız `on_hand_milli - reserved_milli`; eksi bakiye korunur |
| `in_transit_milli` | integer/null; gerçek sevk edilmiş bileşenlerin iadeden sonra kalan miktarı |
| `in_transit_known_milli` | integer/null; doğrulanabilen bileşenlerin ara toplamı; eksik toplamın yerine geçmez |
| `in_transit_status` | `complete`, `incomplete`, `not_supported` |
| `in_transit_notes` | string[]; ürün bağlantısı veya değişmiş kaynak nedeniyle belirsizlik açıklamaları |

Örnek: depoda 17, ayrılan 2, kargoda 3 → `on_hand=17000`, `reserved=2000`, `available=15000`, `in_transit=3000`. Kargodaki 3 ikinci kez düşülmez. Miktarlar satış dönemi filtresinden bağımsız günceldir; milli stok biriminin binde biridir. EC tüm kanallar dahildir. LP'de paket transit kaynağı olmadığından transit `null/not_supported`; ek alanlar mevcut bakiyeyi değiştirmez.

## Paylaşılan pending kapsamı

`src/stock-availability.js` dışa aktarır:

- `pendingPackageScopeSql(alias='p')`: yalnız dışlama SQL koşulu. Çağıran durum/kanal/tarih süzgecini ekler. Asıl satışlarını tamamen karşılayan iadeler ve aynı kanal/sipariş numarasında teslim edilmiş DUZELTME-CIFT kopyası bulunan shipped asılları dışlar. İzinli alias biçimi kontrol edilir.
- `stockTransitQuery`: yalnız actual `shipped`, bileşen ve bağlı satış okuması. GET'in mevcut DB batch'ine bir SELECT eklenir; ürün/paket başına API sorgusu yoktur.
- `physicalStock(stockRows,transitRows,workspace='ec')`: saf zenginleştirme, yazma yapmaz.

Finans sorumlusu `performanceReport` pending okumasını ve teslim raporunun bekleyen sayısını aynı helper'a bağladı. Marketplace karşılaştırması Trendyol/Hepsiburada altkümesidir; fiziksel stok `other` kanalını da kapsar. Rezervasyonlar transit değildir; performans pending hazırlananları ayrıca içerir.

Sentetik kanıt: 125 saklı shipped − 3 tam iade − 6 teslim ikizi = **116 gerçek sevk**. 8 reserved ayrı; performans pending **124**. Gerçek canlı verinin sayıları okunmadı. Test aynı paket kimliklerini performans yanıtıyla birebir karşılaştırır.

Kısmi iade `sale_id` üzerinden yalnız ilgili bileşenden düşer. DUZELTME-CIFT teknik ters kaydı yeni sevk değildir. Tekrar okuma hiçbir hareket oluşturmaz; yinelenen okuma satırında aynı satış ikinci kez sayılmaz. Eksik ürün eşleşmesi veya değişmiş kaynak başka ürünleri de etkileyebileceğinden tüm transit toplamları bilinmiyor gösterilir; doğrulanmış ara toplamlar korunur. Yalnız belirli ürünün satış/birim bağlantısı eksikse belirsizlik o ürünle sınırlıdır. Depo bakiyesi bundan etkilenmez. Bu bir taşıyıcı canlı konum servisi değildir; kayıtlı sevk/teslim/iade verisini okur.

## Ekran ve sayım

Kartlar/tablo: kullanılabilir, depoda kayıtlı, depoda ayrılan, depodan çıkmış kargoda. Birimleri farklı marka toplamları birleştirilmez; eksi bakiyeler gizlenmez. Bilinmeyen miktar sıfır yazılmaz. Maliyet ayrıntıları KDV dahil birincil ve KDV hariç ikincildir; KDV oranı bilinmiyorsa brüt uydurulmaz.

Çıplak bileşen Toplam kâr/Adet başı kâr gösterimi ve `profit`/`unitprofit` sıralama seçenekleri kaldırıldı; eski sıralama değerleri güvenli ürün adı sırasına gider. Satış miktarı ayrı ayrıntıdadır: iadeler düşülmüş teslim/kargo/hazırlık kapsamı açıklanır. `#performance?view=sales` bağlantısı ve set payının tek başına ürün kârı olmadığı açıklaması vardır. Yeni `/urun-karlilik` kırılımına bağımlılık yoktur.

EC CSV dört fiziksel miktarı, transit bilgi durumunu ve KDV dahil/hariç tutarları taşır. Bilinmeyen/gizli alan boş kalır; LP CSV biçimi korunur. EC satış defteri başlığı `Satış ve kesinti kayıtları`, sonuç etiketi `Kayıt katkısı`; bir satırlık set payı açıklaması gerçek satış sonucu ekranına bağlanır. LP satış başlığı/katkı metni korunur.

Sayım yalnız tek tek stok kartlarından seçilir; satış seti için sanal stok oluşturulmaz. Girilen toplam: depoda fiziksel bulunan, hazırlanmış ama gönderilmemiş DAHİL, gönderilmiş paketler HARİÇ. Kayıtlı depo / girilen sayım / fark canlı güncellenir; transit eklenmez. Önizlemenin son yüklenen bakiye olduğu açıklanır. Açılış seçimi, tarih/referans/gerekçe/maliyet alanları, artışta maliyet ve benzersiz referans doğrulaması, POST/FIFO algoritmaları korunur.

## Dosyalar ve entegrasyon

Sahip olunan değişiklikler: `src/stock-availability.js`, `src/accounting.js` (import + yalnız GET batch/stock zenginleştirme), `public/product-list.js`, `public/accounting-ui.js` (yetkilendirilen STOCK bölümü ve EC satış metinleri), `public/stock-workflow.css`, üç `tests/stock-availability*.test.js`, bu rapor.

Main `public/stock-workflow.css` bağlantısını, geniş tasarım/integrasyon testini ve yayınlamayı yapar. Stok sıralama seçeneklerini bu çalışma kaldırdı; main için kalan düzenleme yoktur. Önizleme sunucusu/scriptleri değiştirilmedi, sunucu başlatılmadı veya durdurulmadı. Şema, canlı DB, git/commit/push/deploy işlemi yapılmadı; başkalarının dosyaları geri alınmadı.

## Doğrulama

**49/49 hedefli Node testi geçti:** 12 yeni model/arayüz testi + 37 mevcut regresyon. Komut:

```text
node --test tests/stock-availability.test.js tests/stock-availability-ui.test.js tests/accounting.test.js tests/orders-components.test.js tests/amount-permission.test.js tests/remaining.test.js tests/negative-stock.test.js tests/repeat-submit.test.js tests/codex-kargoda-kapsam.test.js
```

Kapsam: rezervasyonda onhand değişmez; üç farklı set bileşeni tam bir kez çıkar; tekrar sevk/teslim ikinci stok düşmez; sağlam iade stoğa döner, restock=false dönmez; kısmi bileşen iadeleri diğerlerini etkilemez; DUZ/tam iade kapsamı; okuyucuda miktarlar korunur/para null; eksik satış/eşleşme/değişmiş kaynak; negatif bakiye ve tekrar transit düşmeme; sayım önizleme/girdi doğruluğu; mevcut maliyet/referans doğrulaması. Var olan dar orders-components fixture'ı `price_profiles` uyarıları yazdı; test başarısızlığı yok.

**1/1 ek gerçek tarayıcı testi geçti:** mevcut `http://127.0.0.1:8791/` sentetik önizleme, kurulu Chrome, owner/reader × 390/1440 px. 9 fiziksel kart API miktarlarıyla karşılaştırıldı; tablo, kâr sıralamasının yokluğu, ayrılmış ürünle sayım farkı, CSV, okuyucunun tutar/yazma kısıtı, EC yeni defter etiketleri ve LP eski etiketleri doğrulandı. Tarayıcı script hatası ve stok sayfası yatay taşması yok. Hiçbir defter formu gönderilmedi; dış ağ engellendi.

```powershell
$env:STOCK_PREVIEW_URL='http://127.0.0.1:8791/'
node --test tests/stock-availability-browser.test.js
```

Bu tarayıcı testi çevre değişkeni verilmedikçe normal test paketinde atlanır; sunucuyu main hazırlar. `node --check` değiştirilmiş JavaScript modüllerinde geçti. Tam paket/final yayın testleri main'e aittir.
