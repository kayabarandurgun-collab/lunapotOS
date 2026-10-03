# Stok ve alış faturası yeniden tasarımı

Çalışma tarihi: 4 Ekim 2026. Ana uygulamanın kobalt / açık yüzey tasarımına bağlıdır. Canlı işlem, git veya deploy yapılmadı.

## Uygulanan yapı
- **Depodaki ürünler:** marka grupları ve büyük ürün kartları yerine tek envanter listesi. Masaüstünde ürün kimliği, depoda kayıtlı, ayrılan, kargodaki ve kullanılabilir miktar aynı satırda. Telefonda fiziksel depo miktarı ürün adının yanında ana rakamdır; ayrılan/kargoda/kullanılabilir aşağıdadır. Set değil fiziksel ürün sayılır; kargodakiler stoğa tekrar eklenmez.
- Faturasız mal girişi ve depo sayımı üstte iki ayrı işlem. İkincil araçlar kapatılabilir. Maliyet, satış kullanımı ve ürün işlemleri satır içinde açılır; hareketlere doğrudan erişim var. Yetki, arşiv, eksik miktar, set payı ve kuruş gösterimi kuralları korunur.
- **Gerçek davranış düzeltmesi:** miktara/tedarikçiye göre sıralama sonradan marka gruplamasıyla bozuluyordu. Görünüm artık seçicinin global sırasını aynen korur. Regresyon testi eklendi.
- **Alış faturaları:** yeni belge alanı ve fatura geçmişi ayrıldı. Arama öncelikli; durum/sıralama ikinci planda. Mobilde ilk kayda erişimi geciktiren tekrar açıklama kaldırıldı.
- **Belge masası:** Dosya seç → Kontrol et → Kaydı tamamla; PDF bırakma alanı, XML/elle giriş, gerçek otomatik işlem açıklaması. Tedarikçi/satır/çeşit kontrol formları ve tüm veri alanları korunur. Masaüstünde özgün belge inceleme yanında açılır, mobilde isteğe bağlıdır. Kuyruk, hata/eksik kayıt, yeniden yükleme ve disposal davranışları değişmedi.
- 390px'de 153 sayısının 15/3 bölünmesi giderildi. Uzun sayılar kesilmez; 123.456.789 senaryosu tarayıcıda sınandı. Eski genel kart kurallarının yerleşime sızması yerel bileşen seçicileriyle engellendi.

## Dosyalar
- public/accounting-ui.js
- public/product-list.js
- public/purchase-document-ui.js
- public/stock-workflow.css (yerine yazıldı)
- public/purchase-doc.css (yerine yazıldı)
- tests/rebuild-stock-purchase.test.js
- tests/rebuild-stock-purchase-browser.test.js

## Doğrulama
- Yeni fold/sıralama/büyük sayı tarayıcı testleri: 320, 390, 1440px; taşma ve JS hatası yok. Yalnız sentetik yerel veri; dış ağ ve iş yazıları engellenir.
- Mevcut depo/alış tarayıcı akışları 6/6: owner 360/1280, tutar gizleme, ledger-write/stock-read, aynı route eylemi, faturasız giriş vs sayım POST gövdesi (intercept), disposal, readonly engeli.
- Fatura modülü ve bağımlılığı yüklenemediğinde kurtarma tarayıcı testleri 4/4 (EC ve LP).
- Son hedefli paket 50/50: yeni testler, remaining, gider-urun-duzeltme, komisyon-orani, set-urun-karlilik.
- Arayüz ölçeği önce 13/13 geçti; son paralel çalışma anında insights-design.css:388 içindeki sales-view-tabs>button border-radius:0 nedeniyle 2 ölçek testi kırmızı. Bu dosya bu paketin dışında; ana ajan ilgili sahipte düzeltebilir. Stok ve giriş saf işlev testleri geçti.
- Testte fatura filtre submit'i ardından sonraki işlem, eski form DOM'dan kalkıp yeniden yükleme bitince başlatılır; yalnız select değerini beklemek yeterli değildir.

## Fold görselleri
Yalnız sentetik demo. Tam sayfa değil, ilk ekran görüntüleridir.
- docs/ux-2026-10-03/rebuild-stock-purchase/stock-390.png
- docs/ux-2026-10-03/rebuild-stock-purchase/stock-1440.png
- docs/ux-2026-10-03/rebuild-stock-purchase/invoices-390.png
- docs/ux-2026-10-03/rebuild-stock-purchase/invoices-1440.png
- docs/ux-2026-10-03/rebuild-stock-purchase/upload-390.png
- docs/ux-2026-10-03/rebuild-stock-purchase/upload-1440.png
- docs/ux-2026-10-03/rebuild-stock-purchase/stock-large-390.png

## Devam
Ana ajan bütünleşik testleri, son önizleme sunucusu yeniden başlatmasını ve release'i yönetir. Bu pakette API/veritabanı/hareket matematiği değiştirilmedi. Kullanıcının muhasebe matematiği incelemesi diğer çalışma kolundadır.
