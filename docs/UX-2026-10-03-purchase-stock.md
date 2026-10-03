# Alış faturası ve depo — Claude devir notu

Doğru depo: `C:/Users/baran/Desktop/site/lunapot-panel`. Başlangıç HEAD: `1597e37`. Paylaşılan ağaç; başka kişilerin değişiklikleri korunuyor. Canlı kayıt/SQL, deploy ve commit yapılmadı. Ana önizleme `http://127.0.0.1:18730` durdurulmadı.

## Sonuç

- Depo önce gerçek ürün miktarlarını gösterir: kısa Faturasız mal girişi / Depo sayımı çubuğu, arama, fiziksel stok kartları. Marka, sıralama, görünüm ve diğer filtreler adlandırılmış kapalı ayrıntıda; satış dönemi, set sonuçları ve stok açıklamaları listeden sonra.
- İlk kullanılabilir miktar üst sınırı ölçüldü: 320 ve 390 px genişlikte **677 px**; 1440 px genişlikte **560 px**. Yatay taşma yok. Miktar ürün adının hemen altında; tedarikçi ve maliyet ayrıntıları aşağıda.
- Alış faturalarında PDF yükle görünür ana işlem; XML/elle giriş ikinci seçenekler. Mevcut `mountInvoiceUpload → mountPurchaseDocument` kullanılır; bağımsız yeni yükleyici yok. Dosya seçmeden önce mevcut otomatik muhasebeleştirme/teslim davranışı anlatılır.
- Faturasız giriş çok ürün alır; **yeni gelen miktar** `POST /api/ec/ledger/provisional` üzerinden gönderilir. 12 mevcut + 5 gelen = 17 önizlemesi. Bilinmeyen bakiye sıfır olmaz. Maliyet/KDV boşken tahmin edilmez; aynı ürünü iki satırda seçmek reddedilir. İsteğe bağlı vade/not ayrıntıda.
- Sayım varsayılan `kind=count`; **depoda sayılan toplam** `POST /api/ec/stock` üzerinden gider. İlk kurulum ayrı seçenek. Ayrılan ürünler sayımın içinde, kargodakiler dışında; setler bileşen bazında sayılır. İlan kârı ile fiziksel bileşen stoğu birleştirilmedi.

## Bağlantı ve seçici sözleşmesi

| Bağlantı | Açılan alan | Yetki |
|---|---|---|
| `#invoices?action=upload` | `[data-pd="file"]` | invoices yazma |
| `#stock?action=unbilled` | `[data-ac-form="unbilled"]` | stock okuma + ledger yazma |
| `#stock?action=count` | `[data-ac-form="stock"]` | stock yazma |

- Stok işlemlerine isteğe bağlı `&product=<id>` eklenebilir.
- İlk veri/yetki yüklemesinden sonra, aynı rotanın `hashchange` olayında ve `dispose.onHash` çağrısında çalışır. İşlem açılınca yalnız action/product adres çubuğundan silinir. Diğer filtreler korunur. Aynı bağlantı kapattıktan sonra yeniden açılır.
- Kayıt sonrası yenileme sürerken gelen action bekletilir; yeni form yükleme sonunda kaybolmaz. Dispose dinleyici, yükleyici ve arama zamanlayıcısını temizler.
- Liste yükleme düğmesi `[data-ac="purchase-document"]`; yükleyici kapat `[data-pd="close"]`. Modal kapat form içindeki `[data-ac="close"]`.
- `.stock-tasks` kompakt işlem çubuğudur; article yapısı yoktur. Ana düğmeler `[data-ac="unbilled"]` ve `[data-ac="stock"]` tekildir. Ürün satırında `product-unbilled` / `product-count` kullanılır.
- Faturasız satırlar `[data-unbilled-line]`; `product_id`, `quantity`, `unit_cost`, `vat_rate`. Yüzde KDV mevcut API için `vat_bps` değerine çevrilir. `quantity` gönderilen yeni miktardır; hesaplanan depo toplamı gönderilmez.
- Fatura yetkisi olmayan ledger yazma personelinin tedarikçileri yetkili `/ledger` yanıtından alınır. Müşteri carileri seçeneklere eklenmez. `amounts:none` kaydedilmiş maliyeti açmaz; yeni maliyet alanı boş kalır.

## Düzeltilen gerçek hatalar

1. Yeni fatura dosyasına önceki dosyanın tedarikçi / birleşik PDF sayfa kimliği taşınabiliyordu. Dosya kimliği, sayfa, tedarikçi, satırlar ve önizleme her yeni dosyada sıfırlanır; oturum kuyruğu korunur.
2. Kontrol sonrası işlenen faturalar toplu özette taslak yazılabiliyor; bekleyen ve tamamlanan olarak iki kez sayılabiliyordu. Gerçek autocomplete sonucu kullanılır: stoğa girdi / muhasebeleşti / taslak ayrıdır. Belge bağlantı uyarıları başarılı muhasebeleştirmede de korunur.
3. Belge başlığına geri dönmek seçilen tedarikçiyi eski otomatik eşleşmeye döndürebiliyordu; açık kullanıcı seçimi korunur.
4. Faturasız hareket stok geçmişinde Sayım farkı yazıyordu. Yeni gelen mal ile fiziksel sayım ayrı adlandırılır. Alış bağlantısı “1 satışta düşer” yerine “1 fatura biriminde giriş” açıklar. Eksik tarihçe miktarı sıfıra çevrilmez.
5. Yenileme devam ederken doğrudan işlem açılması formu kaybettiriyordu; artık yükleme/kayıt tamamlanması beklenir.

## Testler

- **56 hedefli test geçti**: yeni saf UI testleri, stock-availability-ui, fatura-otomatik-kapi, faturasiz-mal-girisi, stock-history, amount-permission, purchase-documents, receipts, gecici-sayim-cok-satir ve set-urun-karlilik. Bunlar bellek SQLite kullanır; gerçek veri tabanına yazmaz.
- Son yerleşim değişiminden sonra saf UI testleri **9/9** geçti.
- Mevcut fatura yükleme hata/yeniden açma tarayıcı testleri geçti; eski stok tarayıcı testi filtrelerin ayrıntıya taşınmasından önce geçti. Yeni test artık ayrıntıyı açıp kart/tablo seçimini ve aramayı da doğrular.
- Yeni tarayıcı testi: 360/1280 sahibi akışları; 320/390/1440 stok görünürlüğü, kart/tablo, arama; salt okunur ret geçti. Stock-write + amounts-none ile kart/geçmiş maliyetlerinin gizlenmesi de geçti. Gönderimler tarayıcıda yakalanıp sentetik yanıtlanır; sunucuya yazılmaz, dış ağ engellenir.
- **SR01 fixed:** Ana ajan `access-ui.js` içinde yalnız ec/unbilled + stock okuma + ledger yazma için dar istisna ekledi. Bekleme/doğrulama nedeniyle kapalı düğme yeniden etkinleştirilmez. stock-read + ledger-write + amounts-none senaryosu artık geçiyor.
- **SR02 fixed:** Aynı `#invoices` rotasında Yeni işlem → Alış faturası yükle, asenkron yükleyici hazır olunca etkin dosya seçimine odaklanır. `focus({preventScroll:true})` kullanılır; izleyici bir kez odak verdikten sonra, yükleyici kapanınca veya rota bırakılınca temizlenir. Ana ajan menüde seçim/iptal odak dönüşünü ayırdı. 360/1280 px testte aynı rota iki kez yeniden açılır; odak PDF dosya seçimindedir, Tab XML seçimine gider ve sayfa kaymaz.
- Son SR01/SR02 doğrulaması: `ux-2026-10-03-purchase-stock-browser.test.js` **6/6 geçti**. Önceki birleşik purchase-stock + daily browser **12/12** sonucu ana ajan tarafından bildirildi. FA05 hâlâ ayrı sunucu çalışmasıdır.

Tekrar çalıştırma (depo kökünden):

```powershell
node --test tests/ux-2026-10-03-purchase-stock.test.js tests/stock-availability-ui.test.js
$env:UI_PURCHASE_STOCK_BROWSER='1'
$env:UI_PURCHASE_STOCK_PREVIEW='http://127.0.0.1:18730'
node --test tests/ux-2026-10-03-purchase-stock-browser.test.js
```

## Sınırlar / koordinasyon

- **FA05:** Başka ajanın bildirdiği tedarikçi/ürün yanlış geçici kapanış hatası bu UI kapsamından çözülmedi. Sunucu düzeltmesi/migration 0065 ve eşleştirme sözleşmesi ana ekipte. Arayüz koşulsuz doğru otomatik kapanış sözü vermez; fatura sonrası stok/borcu kontrol etmeyi söyler. Önceki 56 testin geçmesi FA05'in çözüldüğü anlamına gelmez.
- Gerçek PDF/OCR servisi ve canlı muhasebe kaydı denenmedi. Mevcut otomatik işleme kuralları değiştirilmedi.
- Yalnız aşağıdaki altı public dosyası, iki yeni test ve bu not bu çalışmanın kapsamıdır.

## Devir durumu

```yaml
session: purchase-stock-2026-10-03
date: 2026-10-03
status: complete
outcome: SUCCEEDED
goal: Fatura yükleme ve fiziksel depo iş akışları sadeleştirildi ve yerel olarak doğrulandı.
now: SR01 ve SR02 tamamlandı; FA05 sunucu sözleşmesi gelirse UI alan uyumunu kontrol et.
test: UI_PURCHASE_STOCK_BROWSER=1 node --test tests/ux-2026-10-03-purchase-stock-browser.test.js
done_this_session:
  - task: Doğrudan işlem açılışı, yeni gelen miktar ve sayım ayrımı, miktarı öne alan depo.
    files: [public/accounting-ui.js, public/product-list.js, public/stock-workflow.css]
  - task: Tek yükleyici, dosyalar arası kimlik temizliği, doğru toplu sonuç ve stok geçmişi.
    files: [public/purchase-document-ui.js, public/purchase-doc.css, public/stock-history-ui.js]
blockers: []
questions: [FA05 sonrası geçici kapanış eşleştirme sözleşmesi.]
decisions:
  - authorization: stock okuma ve ledger yazma faturasız giriş için yeterli; invoices gerekmez.
  - no_bypass: Sunucu ve ortak erişim koruması kapsam dışı; atlanmadı.
findings:
  - refresh_race: Yeni hash eylemi yenileme sonuna kadar beklemeli.
  - file_identity: Her yeni dosyada birleşik PDF sayfa ve tedarikçi kimliği temizlenmeli.
worked: [Gerçek tarayıcıda yerel sentetik akış, yakalanan gönderim gövdesi, mobil piksel ölçümü.]
failed: [Önceki salt-okunur kaydet kilidi SR01 ile; yükleyicide kaybolan klavye odağı SR02 ile düzeltildi.]
next:
  - FA05 düzeltmesiyle tedarikçi ve ürün eşleştirmesini ana ekip doğrulasın.
  - Sunucu yeni eşleştirme alanları sunarsa faturasız giriş UI sözleşmesini karşılaştır.
files:
  created: [tests/ux-2026-10-03-purchase-stock.test.js, tests/ux-2026-10-03-purchase-stock-browser.test.js, docs/UX-2026-10-03-purchase-stock.md]
  modified: [public/accounting-ui.js, public/purchase-document-ui.js, public/product-list.js, public/stock-history-ui.js, public/stock-workflow.css, public/purchase-doc.css]
```
