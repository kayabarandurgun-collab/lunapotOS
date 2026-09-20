# Lunapot — ürün stoğu, satış biçimleri ve ekip erişimi

Tarih: 20 Eylül 2026. Temel sürüm: c528144.

## Kullanıcının hedefi
Kullanıcı stokta toprak, besin ve temizleyiciyi ayrı ayrı sayar. Set adediyle depo sayımı yapmaz. Set gönderilince içindeki stok kalemleri mevcut sevk hareketiyle düşer. Yönetim ekranında satışın başarısı tekli ilan, aynı üründen çoklu paket veya karışık set olarak anlaşılır. İade/başarısız teslim gideri ayrı görünür ve genel sonuçtan kaybolmaz.

## Mimari kararlar
1. Stok defteri fiziksel ürün kimliğini korur. Eldeki, ayrılmış, kullanılabilir ve gerçekten kargodaki miktarlar ayrı okunur. Kargodaki miktar eldeki stoktan ikinci kez düşülmez. Depo sayımı o anda fiziksel olarak içerideki miktardır; hazırlanmış fakat çıkmamış paketler dahildir.
2. Satış görünümü sipariş satırının tarihsel bileşimine dayanır. Satır adı değişse de içerik aynıdır; içerik değişirse yeni satış biçimidir. Set ve çoklu paketler ayrı bir fiziksel stok yaratmaz. Katalog eşleme sürümü geçmiş satışın içeriğini değiştirmez.
3. Tek ekonomik kaynak performanceReport paket sonucudur. Satış biçimi ayrıntılarının toplamı paket sonucuna kuruşu kuruşuna eşittir. Paket ortak giderleri ikinci kez yazılmaz. Aynı pakette ayrı satılan ek ürün setin kârına yutulmaz. Bilinmeyen değer sıfıra dönüşmez. Bölüştürülen ortak gider açıkça etiketlenir.
4. Bileşene ayrılan gelir/kâr payı işletme kararı için o ürünün doğrudan kârlılığı diye sunulmaz. Eski API alanları uyumluluk için korunur, ana ekran sıralaması satılan biçime geçer. Tekli/çoklu/set satışı ve iade etkisi ayrıştırılır.
5. Bekleyen paketler hazırlanıyor ve kargoda diye ayrılır. İadesi tamamlananlar veya teslim edilmiş teknik ikizler kargoda sayılmaz. İade giderleri sonuçlanan dönemde korunur.
6. Personel kendi hesabıyla girer. Yönetici ekran başına kapalı/görüntüleme/işlem, parasal tutar ve silme izinlerini seçer. Yetki sunucuda uygulanır. Personelin kendi hesabı ve güvenilir cihazı yönetmesi yönetici yetkisi vermez.
7. Altı haneli kod önceden ana şifreyle doğrulanmış cihazda isteğe bağlı hızlı giriştir. İnternete açık ana parola şartı düşürülmez. Güvenilir cihaz rastgele HttpOnly belirteçle tanınır; PIN sunucuda tuzlu özetlenir, denemeler atomik sınırlanır; parola değişimi ve hesabın kapatılması güveni iptal eder. Kullanıcının mevcut parolası değiştirilmez, PIN kendisi tarafından seçilir.

## İş bölümü
- Bacon: ekonomik satır modeli, kâr/pano API, sentetik hesap testleri.
- Carson: fiziksel stok kapsamı, stok ve sayım ekranı.
- Wegener: personel akışı, kişisel hesap ve cihaz PIN'i, güvenlik testleri.
- Pascal: pano ve satış biçimleri arayüzü, filtre/detay/grafik.
- Lagrange: sipariş/katalog adları, set ve çoklu paket fiyat hesabı.
- Ana ajan: ortak gezinme/tasarım, bütünleştirme, izin denetimi, bağımsız test ve canlı yayın.

## Kabul örneği
Genel besin 225 ml: 20 şişe dörtlü paketlerde +67,22 TL; karışık setlerin içindeki 5 şişeye ayrılan pay −45,33 TL; geri dönen bir paketin gideri −52,48 TL. Net 25 adet, 1.215,58 TL ciro ve −30,59 TL toplam katkı. Arayüz bu üç etkiyi tek başına ürün başarısızlığı gibi sunmaz. Bu canlı bulgu yalnız okunmuştur; geliştirme testleri sentetik kopyalar kullanır.

## Doğrulama ve yayın
Hedefli stok/finans/erişim testleri; tam regresyon; derleme; boş/eksik/dolu ve tutar gizli personel ile gerçek tarayıcıda telefon/masaüstü. Yeni şema yalnız güvenilir cihaz kayıtları için gerekirse eklenir; eski ekonomik deftere onarım yazılmaz. Mevcut main → Cloudflare yayın hattı kullanılır. Kullanıcının daha önce verdiği doğrudan yayın yetkisi geçerlidir.

Güvenlik tasarım referansları: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html ve https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

## Sonradan eklenen cari talebi
Sipariş/finans raporları müşteri borcu oluşturmaz. Mevcut cari defterinin yanında mağaza bazında salt okunur hakediş bildirimleri sunulur. Güncel normalize kayıtlar kullanılır; aynı kaynak satırından türeyen komisyon/kargo/iade olayları net hakedişi çoğaltmaz. Çelişkili kapsam, eksik tarih ve banka kanıtı görünür kalır. Cari bakiye, tahsilat ve tedarikçi borcuna otomatik hareket yazılmaz. Görünüm için cari ve sipariş okuma izinleri birlikte gerekir; tutar görünürlüğü ayrıca uygulanır.

20 Eylül salt okunur canlı kontrol: Hepsiburada 1.411 finans kaydının 7’sinde işlem tarihi, Trendyol 3.183 kaydının hiçbirinde işlem tarihi mevcut. Ödeme/vade tarihi yok; banka ekstresi satırı 0. Bu bulgu kesin açık alacak değil, mevcut kanıtın sınırını gösterir.
