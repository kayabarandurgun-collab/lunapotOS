# Lunapot OS 2.1 — kayıt ve hesaplama kuralları

## Ayrı iş alanları
Lunapot `/`, e-ticaret `/eticaret/` adresindedir. Ürünler, stoklar, cariler, faturalar ve kasa/banka kayıtları ayrı tutulur. İki alan aynı yönetici oturumunu kullanır; çalışanlara göre ayrı erişim yetkisi henüz yoktur. Bir faturanın iki alanda tekrar işlenmesi ortak belge kontrolüyle engellenir.

## Sipariş ve stok
- İlk kullanımda gerçek açılış stoğu ve KDV hariç maliyet girilmelidir. Kaydedilmeyen fiziksel hareketler sistem tarafından bilinemez.
- E-ticaret siparişi taslak → stok ayırma → gönderim → teslim akışını izler. Ayırma fiziksel stoğu azaltmaz; gönderim azaltır ve satış kaydı oluşturur. Teslim ikinci satış oluşturmaz. Gönderim öncesi iptal ayrılan stoğu bırakır.
- Sipariş paketleri en fazla 10 ilan satırı ve 20 stok bileşenidir. İlan adedi tam sayıdır; açıkça tanımlanmış bileşen dönüşümüyle kg/litre gibi stok birimleri kullanılabilir. Sanal set için ayrı depo kartı açılmaz.
- Aynı kaynak sipariş tekrar çekildiğinde ikinci kez stok düşmez. Değişen kaynak, taslakta incelenip yenilenebilir; eski sürüm saklanır ve ürün eşleştirmesi yeniden istenir. Ayrılmış/gönderilmiş kaydın içeriği sessizce değişmez.
- Satış maliyeti ağırlıklı ortalamayla, kaydın işlendiği andaki stoktan hesaplanır. Geçmiş tarih girilmesi geçmiş değerlemeyi yeniden hesaplatmaz; eski kayıtlar kronolojik işlenmelidir.
- İade asıl satışa bağlıdır; sağlam dönen ürün eski maliyetiyle stoğa girer. Hasarlı veya gelmeyen ürün otomatik stoğa eklenmez. Sayım kaybı ayrıca gider oluşturur.
- Lunapot reçete maliyeti hesaplanır; hammaddeyi otomatik tüketen üretim emri henüz yoktur.

## Fatura ile mal teslimi ayrıdır
Fatura elle veya standart UBL XML ile taslak oluşturur. Ürün satırları kullanıcı tarafından eşleştirilir; isim benzerliğine güvenilerek stok kartı seçilmez. XML alıcı vergi numarası, ilgili alanın şirket ayarıyla uyuşmalıdır.

Faturayı muhasebeleştirme, KDV dahil cari borç doğurur. Stoğu değiştirmez. Mal teslimi kaydı fiziksel stoğu artırır; örneğin 3 birimin 2 birimi teslim alınabilir. Kalan miktar izlenir ve fazla teslim engellenir. Aynı belge UUID veya tedarikçi vergi numarası/fatura numarasıyla tekrar işlenemez.

Gider satırında genel gider veya satış kesintisi ayrımı yapılır. Satış kesintisi seçilen kargo/komisyon, ilgili satışlara ayrıca dağıtılır; genel giderde tekrar sayılmaz. Dağıtılmamış kesinti varken sonuç kesinleşmiş gösterilmez. Dağıtımlar üst sınır, mükerrerlik kontrolü ve ters kayıt geçmişi taşır.

XML: TRY, standart SATIS/ISTISNA, en fazla 40 satır ve 2 MB. Desteklenmeyen vergi, iskonto, para birimi veya tutarsız toplamda işlem durur. Bu işlem EDM/GİB kabul veya ret işlemi değildir. Muhasebeleşmiş alış faturası düzeltme/iptal ve alış iade belgesi akışları henüz tamamlanmadı.

## Cari ve kasa/banka
Müşteri, tedarikçi, pazaryeri ve diğer cariler tutulabilir. Pozitif cari bakiye işletmenin alacağını; negatif bakiye borcunu gösterir. Kısmi ödeme/tahsilat ve belge eşleştirmesi desteklenir. Kayıtlar izlenebilir ters hareketlerle düzeltilir.

Ödeme kaydı gerçek banka transferi yapmaz. Tedarikçi ödemesi aynı alış maliyetini yeniden giderleştirmez. Eski ödeme kayıtları için olmayan kasa hareketi uydurulmaz. Her çalışma alanının kasa ve carileri bağımsızdır.

## Tahmini kâr, gerçekleşen kâr ve taban fiyat
Tahmini katkı kârı = KDV hariç satış − ürün maliyeti − ambalaj/diğer doğrudan maliyet − komisyon − kargo. Genel giderler ayrıca faaliyet sonucuna girer. Vergi sonrası şirket kârı veya banka bakiyesi değildir.

Ürün/paket ölçüleri, ağırlık, paket adedi, tarihli komisyon ve kargo baremleri girilir. Tarifenin kaynağı belirtilir. Eksik veya çakışan tarife, bilinmiyor olarak gösterilir; sıfır sayılmaz. Hesaplayıcıya girilen satış bedeli toplam paket bedelidir. Taban fiyat, hedef katkıyı ve barem aralığı değişimlerini dikkate alır. Varsayımlar değiştiğinde sonuç da değişir.

Ön hakediş yalnızca tanımlı komisyon, kargo ve stopajı düşer. Diğer platform kesintileri ayrıca doğrulanmalıdır. Ürün maliyeti nakit hakedişinden düşülmez. Stopaj kâr gideri gibi sayılmaz. Teslim durumu tek başına komisyon ve kargoyu kesinleştirmez; gerçek finans belgesiyle karşılaştırma gerekir.

Satış giderleri tahmini veya doğrulanmış olarak izlenir. Eksik giderli satışın kesin kârı hesaplanmaz. Paket kargosu her ürün satırına bütünüyle tekrar yazılmaz; satışa dağıtılan kesinti genel giderde yeniden kullanılmaz.

## Bağlantılar ve açık işler
- Trendyol V2 sipariş/finans ve Hepsiburada sipariş/finans/komisyon servisleri için salt okunur, sayfalı bağlantı kodu vardır. Gerçek mağaza anahtarlarıyla henüz doğrulanmadı.
- Erişim bilgileri sunucuda AES-GCM ile şifrelenir. Bağlantıyı kaydetmek başarılı veri çekildiği anlamına gelmez; son başarı/hata ayrı gösterilir.
- Uygun Trendyol kayıtları inceleme taslağına gelir. HB kayıtları kaynak gelen kutusundadır; otomatik paket oluşturma tamamlanmadı. Finans kaydı otomatik cari/banka kaydı değildir.
- Komisyon servisi gözlemi gelecekteki haftalık kampanya tarifelerinin tamamını garanti etmez. Gerçek hesap yanıtı ve geçerlilik tarihleri doğrulanmalıdır.
- EDM canlı gelen fatura çekimi, üretim servis adresi ve API hakkı doğrulanana kadar kapalıdır. XML içe aktarımı kullanılabilir.
- Otomatik zamanlanmış çekim ve webhook açık değildir. Pazaryerine fiyat/stok/sipariş değişikliği gönderilmez.

## Sınırlar ve işletim
Dönem raporları en fazla 5.000 satış/gider kaydı yükler; fazla kayıtta dönem daraltılır. Fatura ve stok geçmişi son 200 kaydı gösterir. İş verileri 25.000 satıra kadar dışa aktarılabilir; kimlik bilgileri dahil edilmez. Otomatik geri yükleme yoktur. PWA arayüzü önbelleğe alınır; ticari API verileri çevrimdışı saklanmaz.

Ücretli plan veya AI servisi etkinleştirilmedi. Cloudflare ücretsiz katmanı hedeflenir; sağlayıcı kotaları ile pazaryeri/EDM API erişim koşulları ayrıca geçerlidir. Üretim yayını, gerçek mağaza testleri ve üretim performans ölçümü tamamlanmadan tam otomatik işletim varsayılmamalıdır.

## Ürün bağlantıları ve setler
Stok kartı fiziksel üründür; ilan/tedarikçi bağlantısı bu kartın dış sistemdeki karşılığıdır. Bir ilan bir veya daha fazla stok kartına ve açık miktarlara bağlanabilir. Set satışı bütün bileşenler için yeterli stok varsa ayrılır; gönderimde bir kez çıkar. Satış tutarı açık yüzdelerle bileşenlere dağıtılır ve toplam kuruş korunur. Bu oran ürün maliyetini değiştirmez. İadeler satışın bileşen kayıtlarından izlenir.

Alış bağlantısı tedarikçi + kod + fatura birimiyle çözülür. Kod yoksa yalnızca önceden kaydedilmiş tam ad + tedarikçi + birim kullanılır; yaklaşık ad eşleşmesi yoktur. Örneğin 1 KOLI = 12 adet. Bağlantı değişikliği yeni sürüm oluşturur; geçmiş fatura/sipariş miktarını değiştirmez.

Sipariş penceresindeki alış faturaları son teslim kayıtlarıdır; ağırlıklı ortalama stokta belirli satışın kesin olarak belirli alış partisinden çıktığı iddia edilmez. Resmî EDM belgesinin kendisi canlı bağlantı doğrulanana kadar indirilemez; içe alınan alış kaydı incelenebilir.

Fatura taslağı müşteri ve sipariş tutarlarının sabit sürümüdür; stok/cari hareketi, resmî ETTN veya EDM/GİB gönderimi oluşturmaz. Aynı taslak tekrar kaydedildiğinde çoğalmaz. Müşteri bilgileri korumalı ayrıntıda tutulur; kaynak gelen kutusunun toplu listesine dökülmez. İş verisi yedeği fatura taslağındaki alıcı bilgisini içerir.
