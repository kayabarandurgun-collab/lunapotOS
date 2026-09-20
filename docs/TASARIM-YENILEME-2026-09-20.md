# Lunapot çalışma alanları — tasarım yenilemesi
Tarih: 20 Eylül 2026
Temel sürüm: 187b42e. Çalışma deposu: C:/Users/baran/Desktop/site/lunapot-panel.

## Teslim kapsamı
Uygulama seçimi, e-ticaret, üretim, web mağaza yönetimi ve ekip/erişim ortak bir çalışma alanı tasarımına taşındı. Müşteriye açık mağazanın sayfa ailesi de kendi vitrin düzeniyle yenilendi. İşlem formlarının ve ekonomik kayıtların sözleşmeleri korunuyor.

- Ortak tipografi, renk, boşluk, yüzey, form, tablo/kart ve pencere sistemi; yerel Inter dosyası ve lisansı.
- Ortam değiştirici, izinlere göre menü, ekran araması, telefon alt menüsü, klavyeyle kapatma ve odak dönüşü.
- Pano: seçili dönemde ciro, cebine kalan, ortak kapsam nakit marjı, ürün sıralaması ve sipariş rekorları. Zarar satırları ve bilinmeyen/tahmini tutarlar ayrı.
- Güncel depo defterinin net değeri; brüt için güncel ürün KDV oranına dayalı ve açıkça etiketlenen tahmin. Tarih filtresi stok bakiyesini tarihsel stok diye sunmaz.
- Sipariş, ürün/stok, rapor yükleme, alış/satış belgesi, cari/nakit, banka, teklif, mutabakat, bağlantı ve ayar akışlarının okunabilirliği ve telefon düzeni.
- Üretim masası, mevcut stoktan reçete hazırlığı, ürün/hammadde kartları, reçete düzenleyici, maliyet, üretim, barkod, parti ve koli ekranları.
- Ekip listesi, aktif/bekleyen hesaplar, izin grupları, çalışan oluşturma/düzenleme ve kurtarma bilgileri.
- Web mağaza yönetiminin müşteriler, siparişler, ürünler, talepler, iletişim, e-posta ve satışa hazırlık ekranları; mağaza vitrini, ürün/rehber, hesap, sepet, ödeme ve yardım sayfaları.

## Teknik sınırlar ve korunan davranış
Finansal sonuçlar mevcut performanceReport satırlarından gelir. Stok/FIFO/muhasebe motoru ve geçmiş defter kayıtları bu tasarım çalışmasında değiştirilmedi. Şema geçişi gerekmiyor. Canlı pazaryeri bağlantısı, gerçek ödeme, e-posta ve mağaza host kısıtları değiştirilmedi.

Yeni para/marj alanları ve günlük grafik tutarları sunucuda tutar yetkisiyle gizleniyor. Ekran erişiminde rapor → sipariş, banka → cari izin eşlemesi mevcut sunucu izinleriyle aynı. Okuma yetkisi yazma yetkisine dönüşmez.

Seçilen tarih aralığı yalnız tarih destekleyen ekranlara taşınır. Banka ekranına desteklemediği bir tarih kapsamı eklenmez. Ürün performansı sonuçlanan paketlerde sonuç, bekleyenlerde sipariş tarihini kullanır; bu fark ekranda açıklanır.

## Doğrulama kaydı
- İlk tam regresyon: 660 test, 660 başarılı, 0 başarısız/atlanan.
- Yayın paketi kuru derlemesi başarılı.
- İlk geniş gerçek tarayıcı turu: 69 adres × 390/1440 px; eksik varlık/JavaScript hatası yok. İki mağaza taşması giderildi; ayar ekranındaki satır içi stil dış stil dosyasına taşındı.
- Ana ajan ana ekran, ekip, fiyat, pano, üretim, mağaza ve iş listelerinin ekran görüntülerini görsel olarak inceledi; eski stillerin kontrast/hiza çakışmalarını düzeltti.
- Ortak menü, çalışma alanı değişimi, fiyat girdileri, ekip izin presetleri ve giriş alanları yerel sentetik oturumlarla sınandı. Menü klavye odağı döngüsü ve kapatınca geri dönüşü ayrıca gerçek tarayıcıyla geçti.
- Üretim: 91 hedefli test; 63 temsili ve 22 gerçek yerel uygulama tarayıcı kontrolü.
- Ayrıntılı kapsam/kanıtlar: aynı dizindeki redesign-2026-09-20-analytics.md, insights.md, production.md, verification.md ve diğer alan notları.

Bütün işlev testi verileri geçicidir; canlı ticari veri üzerinde tasarım denemesi yapılmadı. Fiziksel kamera/yazıcı ve dış hizmetlerin gerçek işlemleri bu doğrulamanın kapsamı değildir.

## Nihai regresyon ve paket
Son tam test: **671/671 başarılı, 0 başarısız, 0 atlanan**. Son kuru yayın derlemesi başarılı; 231 uygulama varlığı okundu. 81 önbellek varlığında eksik veya yinelenen yol yok.

Bin paketi aşan kâr raporu isteğe bağlı imleçle yüklenir. Gerçek worker + ön yüz yükleyicisi 1.005 aynı gün paketi 1.000 + 5 olarak eksiksiz ve tekrarsız birleştirdi. Bir sayfa hata verirse yarım rapor tamamlanmış gibi gösterilmez. Tutar gizleme, bilinmeyen sıfır ayrımı ve eski imleçsiz API davranışı testle korundu.

Yayın sürüm işareti: `lunapot-shell-v114-calisma-alanlari`. Yeni bir veritabanı geçişi yok. Dağıtım mevcut main → Cloudflare Workers Builds yolunu kullanır. Kullanıcının önceden bulunan `.node-version`, bakım/kurtarma betikleri, `.claude` ve kart kimlikleri dosyaları bu değişiklik kapsamında değildir.
## Son ortak tarayıcı turu
Yeniden başlatılan gerçek yerel worker üzerinde dolu/eksik/boş senaryolarda 78 HTTP ve 54 masaüstü/telefon ekran kontrolü; tutar yetkisi kapalı personelde 12 HTTP ve 18 ekran kontrolü; değişen ekranlarda 12 hedefli kontrol başarılı. Eksik varlık, JavaScript hatası, CSP ihlali ve yatay taşma kalmadı. Son kontrast taramasında bulunan üç eski renk kuralı ortak CSS ve mağaza alt bilgisinde düzeltildi.

Mağaza alanının önceki ayrı adaptör testiyle birlikte kapsamı 23 müşteri sayfası ve 8 yönetim görünümüdür. Ortak önizlemeye oturum çereziyle girilen gerçek tarayıcı akışı da geçti; localhost Host kısıtı veya çerezsiz istemcinin yönlendirmesi canlı ürün engeli değildir.
