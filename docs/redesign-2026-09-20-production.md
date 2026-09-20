# Üretim tasarım yenilemesi — 20 Eylül 2026

Çalışma deposu: `C:/Users/baran/Desktop/site/lunapot-panel`. Yalnızca ayrılan üretim dosyaları değiştirildi; ortak kabuk, muhasebe, backend ve diğer ajanların dosyalarına müdahale edilmedi. Commit/push/deploy ve canlı veri yazımı yapılmadı.

## Değişen dosyalar

- `public/app.js`: üretim masası, ürün/hammadde/reçete listeleri, aramalar, KDV dahil fiyat senaryosu, kart formları.
- `public/production-ui.js`: mevcut salt okunur üretim API'sinden günlük hazırlık, mevcut `productionPlan` motoruyla kapasite; depo/üretim özetleri, yerel arama ve durum filtresi, gruplu üretim ve stok pencereleri.
- `public/recipe-studio.js`: üretim tanımı, malzeme seçimi, tüketim ve gider grupları; tam ürün adı, eksik stok/fiyat gösterimi.
- `public/lot-ui.js`: parti özeti, arama/durum filtresi, etiket adımları ve erişilebilir pencereler.
- `public/barcode-ui.js`: barkod arama/listesi, sayım, kart bağlantısı ve etiket pencereleri; stok bilgisi yokken fark sıfırdan hesaplanmaz.
- `public/production-design.css` (yeni): yalnızca `.production-view`, `.production-dialog` ve üretime özel sınıflar. Sidebar/workspace/header/bottom-nav biçimlendirmez.

## Ana ajan entegrasyonu

- `production-design.css`, `workspace-design.css` sonrasında yüklenmeli; `body.workspace-redesign` kullanır. Kontrolde ana ajanın `production.html` içine bağlantıyı eklediği görüldü.
- Ortak service worker güncellemesinde yeni CSS'yi önbellek listesine ekleyin. `sw.js` bu ajanın kapsamı dışında ve değiştirilmedi.
- `#sidebar`, `.nav-link`, `.workspace > header` sözleşmeleri korunur. Diğer modüller üretim içerik sınıfını almaz.

## Davranış ve veri kapsamı

- `costs.js`, `production-plan.js`, stok/maliyet motorları ve API yazma sözleşmeleri değişmedi. Form isimleri, kayıt/silme/geri alma, barkod okuyucu/kamera, PDF ve baskı eylemleri korundu.
- Ana masa mevcut `GET /api/lp/production` çağrısıyla güncel hazırlığı gösterir. Her reçetenin kapasitesi ayrı hesaplanır; toplam/rezervasyon veya tarihsel stok diye sunulmaz. Eksik stok bilgisi kapasite sıfırı değildir.
- Üretim/hammadde hareketleri son 200 kayıt; partiler üretim tarihine göre son 300; barkodlar kart adına göre ilk 500 bağlantı. Arama bu yüklenen kapsamda; toplu barkod baskısı aramadan bağımsız açık bağlantıları kapsar. Sınırlar ekranda yazılıdır.
- Fiyat hesaplayıcı seçilen KDV oranıyla brüt fiyatı birincil, net fiyatı ikincil gösterir. Reçete/gerçekleşen üretim/depo maliyetlerinde KDV bilgisi olmadığı için brüt tutar uydurulmaz; net maliyet açıkça etiketlidir.
- Yetki veya veri eksikliği nedeniyle fiyat gelmezse maliyet/satış bilinmiyor olarak gösterilir; hesaplayıcı sıfır maliyet üretmez. Tahmini reçete maliyeti ile üretim anında sabitlenen gerçek stok maliyeti ayrıdır.
- 760 px altında tablolar etiket/değer satırlarına dönüşür. Tam adlar sarılır, tablo kesilmez. Telefon pencereleri ekran genişliğinde; içerik kaydırılırken kapat/kaydet görünür kalır.

## Doğrulama

- Beş JS dosyasında `node --check`: başarılı. Ayrılan JS dosyalarında `git diff --check`: başarılı.
- 91 mevcut test geçti: `app`, `production-plan`, `production-variants`, `lots`, `barcode`, `barcodes-api`, `barcode-label`, `barcode-ean`, `carton-label`, `label-pdf`, `print-csp`, `permissions`, `amount-permission`, `repeat-submit`.
- Yerel Playwright/Chrome, canlı servis yerine örnek veri sunan `127.0.0.1` sunucusu: 1440, 390 ve 360 px genişliklerde toplam 63 ekran/pencere/boş-durum yerleşimi; 0 yatay taşma, 0 JavaScript hatası. Üretim masası ve telefon formu ekran görüntüleri ayrıca incelendi.
- Ek etkileşimler: reçete miktarı ve maliyet güncelleme, üretim tüketimi/işçilik/ambalaj/diğer gider payload'ı, ürün fiyatı payload'ı, çift gönderim koruması, hata sonrası yeniden etkinleşme, Escape ile kapatıp yeniden açma, parti araması, stok bilgisi olmayan barkod sayımı, eksik fiyat, boş listeler.
- Üretim örneği: 10 adet, 2,75 kg gerçek tüketim, 100 TL işçilik, 50 TL ambalaj, 25 TL diğer gider; mevcut reçete ölçekleme hesabıyla aynı. Fiyat örneği: 72,50 TL maliyet, %50 marj, %20 KDV → 145 TL net / 174 TL brüt.
- Etkileşim testindeki 3 yazma denemesi yalnız yerel sahte sunucuya gitti ve bilerek 400 yanıtı aldı; kalıcı kayıt oluşturulmadı. Canlı yazma, kamera donanımı ve fiziksel yazıcı testi yapılmadı. PDF/barkod çıktısı mevcut otomatik testlerle doğrulandı.
- Geçici tarayıcı kontrolü ve görüntüler: `%TEMP%/lunapot-production-qa.cjs`, `%TEMP%/lunapot-production-qa/`. Bunlar depoya eklenmedi.

## Ana ajanın 8790 önizlemesinde ek kontrol

Gerçek Chrome ile `http://127.0.0.1:8790/production.html` açıldı (`localhost` Host adı sunucu tarafından reddediliyor). 360/390 px'de 9 üretim rotası ve üretim/reçete pencereleri dahil 22 ek kontrol: 0 taşma, 0 JS hatası, 0 yazma isteği; pencere alt eylemleri görünür. `body.lunapot.workspace-redesign` korunuyor; ortak CSS ve `production-design.css` doğru sırayla yüklü. Başka yeni CSS bağlantısı gerekmiyor.
