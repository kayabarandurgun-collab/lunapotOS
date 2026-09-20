# Rapor ve panorama yenilemesi — 20 Eylül 2026

## Ana ajan için entegrasyon sözleşmesi
- Yalnız yeni `public/insights-design.css` dosyasını ortak stillerden **sonra** HTML head ve SW varlık listesine ekleyin. Bu ajan ortak kabuğu değiştirmez.
- `public/date-range.js`: `DATE_PRESETS`, `isISODate`, `validateDateRange`, `presetDateRange`, `parseDateRange`, `dateRangeQuery`, `dateRangeLink`, `dateRangeLabel`, `dateFilterMarkup`, `bindDateFilter`, `todayInIstanbul`.
- `parseDateRange(location.hash, {today, firstDate, defaultPreset:'30g'})` → `{preset, from, to, error}`. Geçersiz tarih hata döndürür; API isteğinden önce kontrol edin. Açık tarihler URL'de sabittir.
- `dateRangeQuery(range)` → `from=YYYY-MM-DD&to=YYYY-MM-DD`. `tum` başlangıcı bilinmiyorsa boş sorgu döner; kâr raporu ilk tarihi panorama yanıtından çözer. Boş sorgunun her API'de tüm dönem anlamına geldiğini varsaymayın.
- `dateRangeLink('#orders?status=delivered', range, {result:'loss'})` → güvenli hash bağlantısı, diğer parametreleri korur; `donem/from/to` yeniler.
- `dateFilterMarkup(range,{busy,basis:'Teslim tarihi',firstDate})` HTML üretir. `bindDateFilter(root,{onChange,signal,today,firstDate})` delegasyonla çalışır; callback gezintiye veya yeni yüklemeye karar verir. `custom` düğmesi tarih alanına odaklanır, form doğrulanmadan istek yapmaz.
- Presetler: `1g/7g/14g/30g/90g/180g/tum/custom`. Bugün dahil son N gün. `from/to` sipariş ve ürün performansı bağlantılarına taşınır; stok bakiyesi tarihten bağımsız güncel anlık görüntüdür.
- Panorama mevcut hesap motorunun `periods/daily/pending` çıktısını kullanır. Ek alanlar: `margin_bps`, `revenue_missing`, `products.revenue_top`, `records.{revenue,profit}`, `inventory.{net_cents,gross_cents,missing_vat_products,negative_products}`. Bilinmeyen parasal değer sıfır gösterilmez.

## Doğrulama
- `node --test tests/redesign-dates.test.js`: **22/22 geçti**. Dönem sınırları, artık yıl, eksik/ters/tekrarlı tarihler, hash ve bağlantılar, ortak marj kapsamı, eksik stok, XSS kaçışı, tam alınamayan dönem, parasal yetkiyle maskelenmiş günlük değerler, ürün/rekor eksik kapsamı, ürün sekmesi ve tarih formunun ilk durumu kapsanır.
- `tests/performance-tools.test.js` ile mevcut CSV, kanal/sonuç filtresi ve ekonomik sonuç kontrolleri geçti. Analitik ajanın `tests/redesign-analytics.test.js` dosyasıyla entegrasyon çalıştırması da geçti (o dosya bu ajan tarafından değiştirilmedi).
- Mevcut Edge ve Playwright ile yalnız yakalanan temsili HTTP yanıtları üzerinde **21 tarayıcı kontrolü**: 1360 masaüstü, 360/390 pano ve veri tablosu, rapor ve paket ayrıntısı, ayarlar, bağlantı formu ve ham kaynak ayrıntısı. Sayfa yatay taşması ve JS hatası **yok**.
- Grafik ok tuşları, Ciro/Kazanç sekmelerinin ok tuşları, özel tarih doğrulaması ve API sorgusu, kanal/sonuç/mod hash güncellemesi, CSV, hata sonrası yeniden deneme ve erişilebilir pencere kapatma doğrulandı.
- Computer Use aracı ortamın `helper_unknown_error/apply deny-read ACLs` hatası nedeniyle açılamadı. Görsel kontrol yalıtılmış, başsız yerel Edge ile tamamlandı; gerçek kullanıcı oturumu/verisi kullanılmadı.
- Geçici yerel test kanıtı: `%TEMP%/lunapot-insights-redesign-check/results.json` ve aynı dizindeki ekran görüntüleri. Görüntülerde ortak stil + eski stil dosyalarının birlikte yüklenmesi sınandı.

## Son uygulama ve kapsam
- Pano: ciro, nakit, ortak kapsam marjı ve **güncel** net/brüt stok; klavyeyle erişilebilir mevcut grafik matematiği; kanal payları; Ciro/Kazanç ürün sekmeleri; tek siparişte rekorlar; mevcut dönemlerin zarar adet/tutarları ve bekleyen paket tahmini.
- Tamamen alınamayan dönem sıfır toplam veya teslim yok diye sunulmaz. Günlük kanal tutarı null ise kovada null kalır; grafik çizilmez, veri tablosu bilinmeyen gösterir. Eksik ürün katkıları ve eksik siparişlerin sıralamadan dışlanması açıklanır.
- Çok paketli rekorun toplam olduğu ve bağlantının bir paketi açtığı yazılır; geri dönüş tarih kapsamıyla ana panoyadır.
- Telefon akışı: hazır dönemde özel tarih alanları kapalıdır; Özel aralık düğmesi formu açıp odağı taşır. Ürünlerde tek sıralama açıktır. Başlangıç rehberi ve tüm dönem karşılaştırması kapalı açılır. İş listesinin ilk iki kontrolü görünür; üçten fazla başlık varsa diğerleri açılabilir bölümde korunur. Temsili özel-aralık panosu 390 px genişlikte kapalı ayrıntılarla 4240 px yüksekliğindeydi (gerçek veriyle yükseklik değişir).
- Performans: gerçek tarih/kanal/sonuç/sıralama kontrolleri, paket kartları, KDV dahil satırlar ve KDV hariç ikincil katkı, CSV ve hata/yeniden deneme. Hesap tutarları sunucunun ekonomik sonuç satırlarından toplanır; bağımsız paket hesap motoru yazılmaz.
- Operasyon: ayar/kaydet/şifre/yedek/bağlantı/senkronizasyon/duraklat/devam/kaynak sayfalama bağları ve form adları korunur. Tarih sorgusu sadece panorama isteğine eklenir; ayarlarda tarih filtresi yoktur.
- **Tüm dönem tamamlandı:** ön yüz her performans aralığını açık `cursor=` ile başlatır; `sonraki_imlec` null olana dek sırayla yükler. Kısa veya boş sayfa erken bitiş sayılmaz. Satırlar `id` ile ilk görülen esas alınarak tekilleştirilir. Tüm sayfalar gelmeden özet, liste veya CSV etkinleşmez; herhangi bir sayfa hatasında kısmi sonuç yayımlanmaz. İptal ve eski seçim yeni ekranı değiştiremez.
- Kanal adetleri ve nakit/KDV hariç katkı toplamları bütün ekonomik satırlardan hesaplanır; bilinmeyen değerler null kalır. `awaiting_delivery`, tarihi ve çalışma alanının dağıtılmamış kesintisi ilk sayfadan bir kez korunur. Yeni paket kâr formülü yoktur.
- Kalıcı yükleyici testleri: 1.005 aynı gün satırı, ardışık istekler, yinelenen kimlik, boş sayfada ilerleyen imleç, null/sıfır/negatif ayrımı, ikinci sayfa hatası, iptal/eski yükleme, hatalı/tekrarlı imleç, kapsam uyuşmazlığı. Gerçek bellek içi API üzerinden `[1000,5]` sayfalarıyla 1.005 paket birleşmesi de geçti; imleçsiz eski 409 sözleşmesi korunur.
- Tarayıcıda 1.000 satırlık ilk sayfa geldikten sonra son sayfa bekletildi: mali özet/listeler görünmedi, CSV devre dışı kaldı. Son sayfayla 1.005 satır ve doğru kanal toplamı açıldı. İkinci sayfa hatası kısmi rapor göstermedi; yeniden deneme tümünü yükledi.
- Tahmin etiketi yalnız `fees_estimated`, `cost_estimated` ve `assumptions_source` alanlarından gelir. Açıklayıcı `cost_note` tek başına tahmin sayılmaz; regresyon testi eklendi.
- Son hedefli çalışma: `node --test tests/redesign-dates.test.js tests/performance-tools.test.js` — **27/27 geçti**. Bu devam adımında ayarların `pre.tip` işaretlemesine veya parent'ın CSP stil sınıfına dokunulmadı.
- Değişen kapsam: `public/panorama-ui.js`, `public/operations-ui.js`, `public/performance-ui.js`, yeni `public/date-range.js`, `public/insights-design.css`, `tests/redesign-dates.test.js`, bu not. Ortak CSS/kabuk/ecommerce.js/HTML/SW değişiklikleri ana ajandadır.
- Canlı veri yazımı, commit, push veya deploy yapılmadı. Başka ajanların ve kullanıcının değişiklikleri korunur.
