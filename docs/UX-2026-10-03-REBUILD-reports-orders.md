# Raporlar ve Siparişler — yapısal arayüz yenilemesi

Tarih: 3 Ekim 2026 çalışması, doğrulama 4 Ekim 2026.
Repo: `C:\Users\baran\Desktop\site\lunapot-panel`
Durum: Bu bölümün kaynakları hazır ve sabit. Commit veya canlı dağıtım yapılmadı; birleşik dağıtım ana ajana ait.

## Kullanıcıya yansıyan değişiklik

Rapor ekranı artık tek uzun açıklama kartı değil. Masaüstünde solda gerçek dosya yükleme alanı, sağda rapor türü ve mağaza rehberi bulunur. Son yüklenen dosyalar aynı ekranın altında görünür. Mobilde rehber kapalı başlar; dosya seçimi ve son dosya daha önce görünür. Alış faturası için yanlış sayfada kalan kullanıcı doğrudan doğru yükleme ekranına gidebilir.

Dosya geçmişi yatay taşan altı sütunlu tablo yerine durum, mağaza ve devam işlemi açık dosya satırlarından oluşur. Dosya adı/mağaza araması ve işlenen/bekleyen filtresi eklendi. Yarım kalan dosyalar ana yükleme ekranından tek hareketle süzülür. İşlem ayrıntılarında işlenen satır, deneme sayısı, gerçek hata, yeniden deneme zamanı ve sonuç dağılımı korunur. Başarısız işleme dosyayı kaybetmez; aynı satırdaki Devam et yeniden kullanılabilir.

Siparişlerde durumlar ve sayılar tek şeritte, arama ve sıralama kısa bir araç satırındadır. Kâr/zarar, tarih ve takip filtreleri açılır paneldedir. Masaüstünde kanal düğmeleri, telefonda bütün kanalları koruyan seçim alanı kullanılır. Seçilen durum mobil şeritte görünür konuma kayar. Satırın ana kimliği sipariş numarasıdır; ürün ve stok bileşenleri ikinci düzeyde, durum ve finans sonucu ayrı sütunlardadır. Mobil satır, ürünün altına durum ve iki mali tutarı yerleştirir. Tahmini, teslim bekleyen ve eksik tutarlar birbirine dönüşmez.

## Kaynaklar

- `public/report-inbox-ui.js`: yükleme çalışma alanı, son dosyalar, dosya arama/süzme ve işlem durumları.
- `public/report-inbox.css`: belge çalışma alanının duyarlı bileşen stilleri. Banka, banka eşleştirme ve satış belge ekranlarının kullandığı ortak `rb-*` yardımcı sınıfları korunur.
- `public/orders-ui.js`: sipariş çalışma alanı, kısa filtreleme yapısı, mobil kanal seçimi, belirgin sipariş kimliği.
- `public/order-workbench.css`: yeni sipariş bileşenleri; ana ajan e-ticaret HTML dosyasında bağlantısını ekledi.
- `tests/ui-reports-orders-rebuild-browser.test.js`: yeni davranış ve ilk ekran testleri.
- `tests/ui-reports-orders-daily-browser.test.js`: önceki anlamlı davranışlar korunarak yeni mobil rehber/disclosure ve dosya sekmesi yapısına güncellenen seçiciler.

`src`, ana kabuk, HTML bağlantısı, genel tema dosyaları, veritabanı ve dağıtım bu alt görevde değiştirilmedi. Sipariş/fatura/stok hesap formülleri aynen kullanılır; bu bölüm muhasebe motorunu değiştirdiği iddiasında bulunmaz.

## Doğrulama

Son koşu: **32 test, 32 başarılı, 0 başarısız, 0 atlanan.**

```powershell
$env:REPORTS_ORDERS_PREVIEW_URL='http://127.0.0.1:18731'
$env:REPORTS_ORDERS_SCREENSHOT_DIR='docs/ux-2026-10-03/rebuild/reports-orders'
node --test tests/ui-reports-orders-daily-browser.test.js tests/ui-reports-orders-rebuild-browser.test.js tests/arayuz-olcek.test.js
```

Gerçek Chromium ile sentetik, ağ erişimi kapalı yerel Worker önizlemesi kullanıldı. 320, 390 ve 1440 piksel genişliklerinde tüm sayfanın yatay taşmaması, dosya seçiminin ilk ekranda olması, son dosyaların görünmesi ve sipariş listesinin açılmış filtrelerin altında kaybolmaması doğrulandı. Görseller ayrıca gözle incelendi; yalnız DOM testine dayanılmadı.

Doğrulanan davranışlar:

- Aynı sayfaya yeniden gelen `action=upload` niyeti, kalan hash parametreleri ve seçili rapor tarihi korunur.
- İlk GET hatası boş mağaza kurulumu gibi gösterilmez; yeniden deneme sunulur.
- Mağaza veya türü bilinmeyen seçilmiş dosya korunur; eksik bilgi sorulur.
- Dosya araması sıfır sonuçta açık temizleme yolu sunar.
- Yarım işlem filtresi tamamlanan dosyaları ayırır; temsili 503 hatasından sonra dosya ve yeniden deneme korunur. Bu POST tarayıcıda açıkça taklit edildi; gerçek iş kaydı yazılmadı.
- Salt okunur personel dosyalara bakabilir; yükleme ve yeni sipariş kapalıdır.
- Mobilde Diğer dahil bütün kanallar seçilebilir; durum ve kâr/zarar filtreleri sunucu sorgusuna ve adrese yansır.
- Sipariş detayı, klavye ile açma, geri/Escape, doğrudan paket bağlantısı, stok düzeltme penceresi ve sayfadan ayrılırken kapanma korunur.
- Arama yanıtları ters sırada gelse de son arama geçerlidir.
- Gelişmiş rapor araçları açılarak erişilir ve işlemden sonra açık kalır.

Ayrıca komisyon-oranı, satış biçimi ve gezinme/yetki sözleşmelerinin 22 testi başarılı koştu. Birleşik sistem testinin nihai sonucu ana ajanın raporunda yer alacaktır. İki JS dosyasında sözdizimi kontrolü, görev dosyalarında `git diff --check` temizdir.

## Görsel kanıt

Hepsi sentetik veridir. Son durum dosyaları:

- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-reports-1440.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-reports-390.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-reports-320.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-orders-1440.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-orders-390.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-orders-320.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-files-1440.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-files-390.png`
- `docs/ux-2026-10-03/rebuild/reports-orders/rebuild-report-error-390.png`

Sipariş ayrıntısı ve mevcut yükleme niyeti görüntüleri aynı dizinde `order-detail-*` ve `reports-*` adlarıyla ayrıca bulunur.

## Bilinen kapsam sınırı

Rapor API'si mevcut haliyle son 100 dosyayı döndürür (`src/report-inbox-api.js` liste sorgusu). Yeni dosya araması bu alınmış dosyalar üzerinde çalışır. Liste 100 dosyaya ulaştığında bu sınır masaüstü ve mobilde açıkça yazılır. Daha eski arşivde sunucu tarafı arama/sayfalama bu UI alt görevinin kapsamı değildir; eski dosyaların hiç olmadığı iddia edilmez.

Canlı veriye veya gerçek rapor dosyasına işlem yapılmadı. Yeni CSS ve HTML bağlantısının birlikte dağıtılması ve servis çalışanı önbellek sürümünün yükseltilmesi birleşik sürümün sorumluluğundadır.
