# Lunapot görsel sistem ve hareket tasarımı

9 Eylül 2026. Çalışma yalnızca yeni panelde yapıldı. Bu tur yereldir; origin yayını, DNS geçişi veya gerçek TY/HB/EDM bağlantısı yapılmadı.

## Gerçekten incelenen açık kaynaklar

- [shadcn/ui Dialog kaynak kodu](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/dialog.tsx): pencere/arka plan geçişleri, kısa süreler, yuvarlak yüzey ve klavye odağı incelendi. [MIT lisansı](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) kontrol edildi. Lunapot React/Tailwind kullanmadığı için bileşen veya bağımlılık kopyalanmadı; mevcut native dialog için kendi CSS'i yazıldı.
- [Radix animasyon rehberi](https://www.radix-ui.com/primitives/docs/guides/animation): CSS ile açılma ve kapanma durumlarını ele alma yaklaşımı incelendi. Bizim pencereler yalnızca açılışta kısa hareket yapar; kapanış işlevini bekletmez.
- [Radix tasarım ilkeleri](https://github.com/radix-ui/primitives/blob/main/philosophy.md): erişilebilirlik, bileşen davranışı ile görünümün ayrılması, sade bileşim yaklaşımı incelendi. Mevcut yetki ve muhasebe işlemleri görsel koddan ayrıldı.
- [Animate.css temel kaynak dosyası](https://github.com/animate-css/animate.css/blob/main/source/_base.css): süre, tekrar ve prefers-reduced-motion/print davranışları incelendi. Lunapot'ta azaltılmış hareket tercihinde animasyonlar tamamen kapalı; bekleme göstergesi en fazla üç döngü oynar.

Önceki Dribbble incelemesi bu açık kaynak kod araştırmasından ayrıdır. Bu tur üçüncü taraf kod veya görsel varlık kopyalanmadı; çalışma özgün CSS ve vanilla JavaScript ile yapıldı. Yeni paket, CDN, uzak font, ücretli tema veya analiz servisi eklenmedi.

## Uygulanan görünüm

- E-ticarette mürdüm / lavanta, üretimde koyu yeşil; ortak menü yapısı ve belirgin aktif bölüm.
- Yan menüde hafif renk geçişi, yuvarlak seçili alan, dengeli ikon vurgusu.
- Kartlarda düşük yoğunluklu gölge; boş ekranlarda sakin arka plan.
- Birincil düğmelerde hafif derinlik, ikincil düğmelerde net sınır; formlarda ortak köşe ve odak görünümü.
- Sekmelerde gruplanmış yüzey, tablolarda daha okunaklı başlık ve satır vurgusu.
- Para ve stok değerlerinde sabit genişlikli rakamlar. Değerler sıfırdan sayarak animasyonla gösterilmez.
- Sayfa başlığı / ana kartlarda 260–300 ms giriş; ana kartlarda en fazla 65 ms sıralama farkı.
- Pencere girişinde 190 ms; açılır ayrıntıda 160 ms; düğme ve form tepkisinde 140 ms.
- Hover etkileri uygun fareli cihazlarda; dokunmatik ekranda yapışan hover kaldırma efekti uygulanmaz. Hareket azaltma ve yazdırma için hareketler kapalı.

## Hızlı geçiş

Üst çubuktaki arama düğmesi veya Ctrl/⌘ + K ile açılır. Türkçe harfleri normalize ederek ekran adları aranır. Ok tuşlarıyla seçim, Enter ile geçiş, Escape ile kapatma ve önceki odağa dönme desteklenir. Mevcut bir pencere açıkken ikinci pencere açılmaz.

Liste mevcut kullanıcının menüsünden oluşturulur; hidden yetki öğeleri alınmaz. Telefonun kapalı çekmecesi, yetki nedeniyle gizlenmiş öğeyle karıştırılmaz. İş verisi aranmaz; sunucuya istek gönderilmez, yetki veya kayıt değiştirilmez. Yetkilendirme sunucuda kalır.

## Dosyalar ve doğrulama

- public/ui-motion.css: hareket, kart yüzeyi ve etkileşimler.
- public/ui-navigation.css, public/ui-navigation.js: menü/denetim tasarımı ve hızlı geçiş.
- public/ui-shell.js: mevcut sunum geliştirme döngüsüne hızlı geçiş eklenir.
- index, production, ecommerce, access HTML: ortak iki stil dosyası.
- public/sw.js: PWA kabuğu v18, yeni CSS/JS dosyalarını içerir.

Yerel test: gerçek Worker, sentetik SQLite ve izole Chrome. 1440, 390, 320 genişlikte mevcut sipariş/kâr/stok akışları, fiyat formu, arama ve pencere geçişleri; salt okunur personelde gizli ekranların arama listesine girmemesi; klavye odağı; azaltılmış hareket; üretim/erişim/uygulama seçicide telefon taşması; gerçek PWA kurulumu kontrol edildi. İş API kayıtları önbellekte yok. JS hatası görülmedi. Sonuçlar work/ui-design-results.json, betik work/ui-design-check.cjs. work klasörü public repoya eklenmemeli.

Bu tur muhasebe hesapları değişmedi. Önceki turdaki 133 testin sonucu korunuyor; bu tur için tarayıcı ve derleme doğrulaması yapıldı. Gerçek canlı entegrasyon testi yapılmış sayılmaz.
