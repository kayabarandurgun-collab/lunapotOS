# Ana ekran yenilemesi

## Kullanıcıya görünen değişiklikler
- Dört ana ölçü artık ciro, kalan, satılan malların KDV dahil tahmini alış değeri ve pazaryeri kesintileri. Güncel depo değeri ayrı yerde.
- Yeni üç serili etkileşimli grafik: ciro / maliyet + kesinti / kalan. Seriler açılıp kapanır, son seri açık kalır, dokunma ve klavye oklarıyla rakamlar okunur. Veri tablosu bulunur.
- Satıştan ne kalıyor: alış değeri, komisyon, kargo, diğer pazaryeri kesintileri, stopaj, kalan; kayıt/tahmin dökümü. Tam mutabakatı olmayan/eksi parçalı kapsamda yüzdelik şerit uydurulmaz.
- İlk satıştan bugüne: tarih filtresinden ayrı tüm zamanlar yedi toplam.
- Aynı dönemde Trendyol / Hepsiburada maliyet, kesinti, ciro, kalan ve marj karşılaştırması.
- Paket sonuçları halka grafiği; kâr, zarar, başa baş, hesap bekleyen dökümlerine bağlantı.
- Depo/kargo güncel bilgisi ve günlük işler dönemden ayrı. Sayfa içi hızlı geçişler tarihi bozmadan kaydırır.
- Mobil rapor, alış faturası, sayım ve ödeme takvimindeki küçük dokunma hedefleri düzeltildi.

## Hesabın doğruluğu ve sınırları
- Finansal kaynak ortak performanceReport paketleri; ayrı kâr formülü oluşturulmadı, defter kayıtları değişmedi. Salt okunur yeni metadata/özet.
- Bilinen komisyon, maliyet bilinmiyor diye kaybolmaz. Her kalemin kapsamı ayrı; toplam kesinti aynı pakette dört kesinti kalemi de bilinen ortak kapsamdır.
- Kayıtlı kesinti bankadan ödenmiş nakit değildir. Genel işletme giderleri mevcut İşletme sonucu ekranında; satış sonucu kartlarından ulaşılır.
- FIFO geçmiş alış KDV’sini satışla eşleyen bir defter taşımıyor. KDV dahil maliyet güncel ürün oranıyla tahmindir; kesin tarihsel fatura toplamı iddiası yok. Bu sınır ana kartta, detayda ve tüm zamanlar bölümünde yazılı.
- Fiziksel stok bileşen bazında; kazanç sıralaması satılan tekli/paket/set bazında kalır. Müşteri carisi açılmadı.
- Yetki politikası korunur: komisyon oranları mevcut bilinçli izin gereği görünür olabilir; para/maliyet/kâr tutarları amount yetkisi olmadan gizlenir. Oranları toptan engelleme denemesi mevcut kontratı doğrulayan test üzerine geri alındı.

## Bağımsız incelemede kapatılan sorunlar
- Eski kanal grafiğinde bilinmeyen günün sıfır gibi görünmesi.
- KDV tahmini işaretinin dönem ve rekor kartlarında kaybolması.
- Hiç hesaplanamayan dönemde zarar toplamının sıfır gösterilmesi.
- Aylık grafiğin ilk ayı kısaysa haftalık etiketi ve yıl bilgisinin eksikliği.
- Sipariş numarası olmayan paketin kimliğinin gerçek sipariş numarasıyla çakışması.

## Yayın
Yeni şema geçişi yok. Mevcut kullanıcı verisine düzeltme/toplu yazma yapılmaz. Sürüm ve tamamlanmış test kanıtları RELEASE.md içinde tutulur.
