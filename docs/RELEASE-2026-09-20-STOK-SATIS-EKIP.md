# Depo, satış ve ekip düzeni — 20 Eylül 2026

## Günlük kullanım
- **Depomdaki ürünler:** Depoda, ayrılmış, kullanılabilir ve kargodaki miktarlar ayrı. Sayımda fiziksel ürünleri say; set sayma ve gönderilmiş paketleri sayıya ekleme. Hazırlanmış ama henüz gönderilmemiş ürünler depoya dahil.
- **Satış ve kâr:** Tekli ürün, çoklu paket ve karışık set ayrı satış biçimleri. Aynı paketteki ek ürün ayrı kalır. Kısmi iadede gerçekte bilinmeyen net set adedi uydurulmaz; geri dönüş gideri toplamdan kaybolmaz.
- **Fiyat hesaplama:** Ürün yanında katalogdaki set/çoklu paket seçilebilir. Bileşen maliyetleri birleşir; paket kargosu bir kez uygulanır. Yetersiz tarihçe veya gider bilgisi varsa sonuç senaryo olarak açıklanır.
- **Ekip ve yetkiler:** Çalışan ekle, hazır rol seç, ekran/işlem/tutar/silme izinlerini düzenle. Çalışan kişisel kurulum bağlantısıyla kendi şifresini belirler. Bağlantı kendiliğinden kimseye gönderilmez.
- **Hesabım:** Mevcut şifrenle doğrulayıp bu tarayıcıya 6 haneli hızlı giriş açabilirsin. Yeni cihazda ana şifre gerekir. Bu güncelleme mevcut şifreni değiştirmez, kendiliğinden PIN açmaz. Cihazı unutmak ona bağlı kod oturumunu da kapatır.
- **Cari hesaplar → Raporlardan hakediş:** Mağazanın güncel rapor bildirimleri gösterilir. Örtüşen dosyalar veya bir satırdan türeyen kesintiler hakedişi çoğaltmaz. Tarihsiz, referanssız, çelişkili bildirimler açıklanır. Bu ekran cari bakiye veya bankada doğrulanmış tahsilat değildir; mevcut deftere hareket yazmaz.

## Doğrulama
Tam Node regresyon paketi: 767 kayıt, **764 başarılı, 0 hata**. Üç tarayıcı testi isteğe bağlıdır ve ayrıca yerel tarayıcı ortamında çalıştırılmıştır. Personel kurulum/davet/şifre/PIN/cihaz iptali gerçek HTTPS ve güvenli çerezlerle; üç yönetim giriş yüzeyi; stok ve satış ekranları; hakediş yönetici/tutar gizli personel; mobil menü ve beş ortam kontrol edildi. İki bağımsız incelemede bulunan giriş yarışları ve satışa özgü komisyon/kuruş dağılımı düzeltildi.

Tarayıcı: ana alanlarda 18 ekran görüntüsü + 26 HTTP kontrolü, satışta 12 senaryo, stokta yönetici/personel × mobil/masaüstü, hakedişte 4 senaryo. Belgelenmiş yerel kanıtlar geçici dizinlerde; gerçek ticari veri denemelerde kullanılmadı.

## Yayın notları
0052 güvenilir cihaz şeması kod yayınından önce uygulandı. Yalnız yeni erişim tabloları/sütunu ve iptal tetikleyicileri eklendi; mevcut mali defter için düzeltme yapılmadı. Uygulama önbellek sürümü: lunapot-shell-v115-stok-satis-ekip.

Kurtarma işlemi bakım sırasında yapılmalı; geri yüklenen eski oturumlar ve cihaz kayıtları doğrulanarak iptal edilmeden uygulama yeniden açılmamalı. Kurtarma yardımcısı bu temizliği denetler; doğrudan Cloudflare geri yüklemesi tek başına bu temizliği yapmaz.
