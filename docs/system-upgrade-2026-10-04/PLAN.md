# Lunapot işletme çalışma alanı — onaylı uygulama
Kullanıcı 4 Ekim 2026 iki görsel referansı ve önceki bütün sistemsel önerileri onayladı.
Başlangıç: Desktop/site/lunapot-panel HEAD9282b24; v174 canlı. Önceden kalan kullanıcı dosyaları korunur.
## Tasarım
Yakın siyah menü, yazılı gezinme, beyaz yüzey, adaçayı/mavi/lavanta/bal tonlu kartlar. Gerçek sayılar, grafikler ve görevler. Mobilde minimum44px kontroller, tek sütun işlemler ve alt gezinme.
## Uygulama sahipliği
- Dirac: cari dosyaları,0066,party-profile API/UI,business-ui bağlantısı.
- Heisenberg: sayım,tedarik,ürün dosyası,0067,warehouse/product-profile API/UI,product-list bağlantısı.
- Laplace: ödeme takvimi ve dönem işletme sonucu,money-planning API/UI.
- Poincare: birleşik belge girişi,görevler,0068,workbench API/UI.
- Ana ajan: tasarım temeli,menü/rota,Worker/scopedDB/yetkiler,yedek,servis önbelleği,entegrasyon/test/yayın/devir.
## İş kuralları
Müşteri carisi otomatik açılmaz. Depoda fiziksel ürün sayılır; setler satış biçimidir. Para kuruş,miktar milli; bilinmeyen sıfır yapılmaz. Sayım stok hareketiyle çatışırsa açık doğrulama gerekir. Faturaya bağlanan geçici giriş bir daha stok artırmaz. Rapor tahsilatı banka parası değildir. İşletme sonucu vergi sonrası net kâr diye adlandırılmaz. E-belge sağlayıcı erişimi yoksa çalışma varmış gibi gösterilmez.
## Doğrulama
Yeni özelliklerin gerçek SQLite/Worker regresyonları,temel tamtest,yerel sentetik Chrome mobil/masaüstü uçtanuca akışlar,veri yalıtımı ve personel yetkileri,migration splitter/yükseltme,derleme,canlı yalnız okuma teyitleri. Hiçbir sentetik işlem canlıya yazılmaz.
## Harici sınır
Mevcut e-belge ve banka erişimleri incelenir; yeni sağlayıcı hesabı/yetkisi uydurulmaz. Önceki GitHub main push otomatikdenetim engeli aşılmaz. Dış bağlantılar için eksik erişimler raporlanır.
