# Yapılacaklar

Son güncelleme: 2026-09-25

## SENDE — panelden yapman gerekenler

- [ ] **Şifre yenile (ÖNCELİKLİ)** — HB servis anahtarı sohbet geçmişine iki kez düştü. Bağlantı kuruldu ve çalışıyor; anahtarı Hepsiburada panelinden yenile, sonra Bağlantılar → Hepsiburada → "Bağlantıyı güncelle" ile yenisini gir.
- [ ] **Banka ekstresi yükle** — Trendyol ödemelerinin yattığı hesabın ekstresi. Banka ekstresi → "Ekstre yükle". CSV/Excel, sütunları panel kendisi tanıyor (test edildi). Sonra "Hakediş eşleştirme" sekmesinden onayla; para ancak o zaman kasaya girer. **Ana Kasa'nın eksi görünmesi bununla çözülecek.**

## Açık işler

- [ ] **Rapor turu boşa 60 saniye dönüyor** — bakım turunda rapor işleri hiç iş üretmeden 59,6 saniye sürüyordu (sayaçların hepsi sıfır). Senkron öne alındığı için artık zarar vermiyor ama sebep bulunmadı. Aşama süreleri artık dolu turda da iz kaydına yazılıyor, oradan izlenebilir.
- [ ] **3 paket: pazaryeri teslim edemediğini söylüyor** — iş listesinde kırmızı satır olarak duruyor. Sipariş **4302703706**'nın İKİ paketi 21 Eylül'de teslim işaretli (kârı sayılıyor) ama HB teslim edilemedi diyor; sipariş **4103383882** hâlâ kargoda görünüyor. Gerçekte ne olduğuna (iade mi, yeniden gönderim mi, pazaryeri kaydı mı yanlış) sen karar vereceksin; sistem kendiliğinden geri almıyor çünkü teslimi geri çevirmek satışı ve stoğu da geri alır.
- [ ] **HB hakediş adayı** — eski not "paymentOrderId dönmüyor" diyordu; gerçek şemada o alan yok ama `Payment` (150) ve `TotalPayment` (2) türünde kayıtlar VAR ve `paymentDate` taşıyorlar. Banka ekstresi yüklenince bunlarla eşleştirme denenebilir. Henüz denenmedi.

- [ ] **Ay sonu — Seçkin TS1 / Plug Mix**: 2 adet Plug Mix iadesi + yeni TS1 faturası. Alış faturaları → YSK2026000000402 → "Tedarikçiye iade" 2 adet. SONRA `urun-duzeltme:plugmix-ts1-2026-09-23` referanslı stok hareketleri ters kayıtla geri alınmalı, yoksa 2 adet çift sayılır.
- [ ] **Komisyon farkı 514,96 TL** (278 siparişte, hepsi aynı yönde). %47'si paketten çıkarılan satırlar, %31'i indirim farkı, %21'i tek kalıba oturmuyor. Birkaç hafta sonra aynı siparişlere tekrar bak: Trendyol çıkarılan satırların komisyonunu iade ederse fark kapanır.
- [ ] **HB kargo tarifesi**: 400–599,99 bandı 139,19 → 130,39; 1000 TL+ bandı 268,79 → 230,99 (126 teslim paketten ölçüldü). Onay verilmedi.
- [ ] **Bütün tarifeler 31.12.2026'da bitiyor** — sonrasında fiyat hesaplanamaz. Aralık'ta hatırlat.
- [ ] **Ürün ölçüleri sahte**: 27 HB ürününün hepsi 10x10x10 cm / 1 kg.
- [ ] **Genel giderler girilmedi** (canlıda 1 kayıt / 152,45 TL). Girilene kadar "kâr" brüt katkıdır.
- [ ] **Cari birleştirme yok** — aynı cari iki kez açılmışsa tek kayda indirgenemiyor. Düzeltme ve arşivleme var, birleştirme kapsam dışı bırakıldı.
- [ ] **Güvenlik G10/G11** bilerek açık.

## 2026-09-24'te tamamlananlar

### Trendyol entegrasyonu — sabah hiç çalışmıyordu, artık çalışıyor
Dört engel üst üste binmişti: `redirect:'error'` (Cloudflare kabul etmiyor), `supplierId:0` (her sipariş yabancı mağaza sanılıyordu), yanıt sayfa boyutu 50'de takılıydı (hakediş hiç geçemiyordu), sipariş satırının durumu saklanmıyordu.
- "Yazmadan dene" (önizleme) modu · panelde düğmesi
- Teslim onayı: sipariş numarasıyla eşleşiyor, belirsizse dokunmuyor
- Mükerrer paket önleme: sistemde olan sipariş için ikinci paket açılmıyor
- Otomatik senkron: siparişler 4 saatte bir, finans 12–24 saatte bir
- **Gerçek senkron çalıştırıldı**: 592 sipariş kaydı, 58 paket teslim işaretlendi, 539 sipariş tanındı, 19 yeni taslak, 506 finans kaydı
- **Sonuç: teslim edilmiş paket 348 → 406, kârı hesaplanan 342 → 408, toplam kâr 15.508 → 17.676 TL, komisyonu bilinen 333 → 408**

### Hakediş akışı kuruldu
Banka ekstresi yüklenip satır eşleşince para pazaryeri alacak hesabına girer, oradan gerçek banka hesabına aktarılır. Deftere yazılan tutar her zaman bankanın tutarıdır; pazaryeri bildirimi yalnız kanıt. Belirsiz eşleşmede hiçbir şey yazılmaz. Yanlış eşleşme geri alınabilir, ham ekstre bozulmaz.

### Düzeltilebilirlik — beş eksik kapandı
Genel gider, cari, ürün kartı, kasa/banka hesabı, ürün ailesi: hepsi düzeltilebiliyor ve arşivlenebiliyor. Defterde iz bırakan kayıt silinmiyor, arşivleniyor; arşiv geçmişi gizlemiyor. Kalıcı silme ayrıca `delete_records` yetkisi istiyor.

### Diğer
- Telegram bildirimi (rapor işlenince özet, hatada ayrı kanal) — iki kanal da gerçek mesajla doğrulandı
- Ödemede kasa zorunlu (nakit, havale, kart) + var olan ödemeye kasa bağlama
- Seçkin'in 11.760 TL'lik kasasız ödemesi düzeltildi
- Ürün bağlantısı modalı: pay toplamı canlı, %100 değilken kaydet kapalı, ürün adı tam görünüyor
- Alış faturaları başlığındaki 99px taşma, faturasız mal girişinde silme düğmesi hizası
- Açık borç listesinde tek ödeme etiketi
- **Güvenlik açığı**: banka uçları yetki haritasında yoktu, yönetici dışı herkese 403 dönüyordu; menü ise ekranı gösteriyordu
- **Arayüz ölçeği**: düğme köşe 7–11px → 8px, yazı 10–14px → 13px, kalınlık 500–600 → 600, kart köşe 11–18px → 12px. Renk ve yazı tipi birebir korundu. `font` kısayolu tuzağı yedi yerde temizlendi.

### Bekleyen paket kalmadı (25.09)
Son iki ilanın karşılığı kullanıcıdan soruldu (uydurulmadı) ve bağlantıları kuruldu:
- **Pina Small 2 L Ayaklı Fiberglas Saksı · Mermer Desenli** — yeni stok kartı açıldı (`PINA-S-BYZ`), barkodla bağlandı (`8685283268006`).
- **Çiçek Vitamin Seti** — 5 bileşenli set, her birine %20 pay: kaktüs / menekşe / yeşil yapraklı / çiçek açan besin 225 ml + yaprak temizleyici 250 ml. İlanın kendi kodu (`ilac250-kaktus-menekse-cicekli-yesil`) içeriği bağımsız olarak doğruladı. Eşit pay, sistemdeki "5'li Bitki Besini Seti" ile aynı kural.

Bağlantılar kurulunca kalan iki paketi de bakım turu kendiliğinden kapattı. **Ürün eşleşmesi bekleyen paket: 0.**

### Eşleştirmeyi artık sistem yapıyor (25.09)
Ölçüldü: eşleşme bekleyen 21 ilan barkodunun **20'sinin bağlantısı zaten vardı**. Sistem eşleştirmeyi yalnız sipariş içeri girerken bir kez deniyordu; o an tutmadıysa (bozuk ilan kodu) ya da bağlantı sonradan kurulduysa paket elle açılmayı bekliyordu.

Bakım turu artık bekleyen taslakları kendiliğinden yeniden deniyor. İlk turda **54 ilan eşleşti**, bekleyen paket 31 → 2. Kalan ikisinin kayıtlı bağlantısı yok; uydurulmadı, kullanıcıya soruldu.

Yalnız bileşeni de doğrudan ürünü de olmayan satıra dokunuluyor: kullanıcının seçimi değiştirilmiyor.

### Pazaryeri kesintisi API kayıtlarından işlenebiliyor (25.09)
HB'nin API finans kayıtları artık satışların gider alanlarına yazılabiliyor; bakım turu her tur deniyor. Uç: `POST connections/hepsiburada/fees` ({commit:false} önizleme).

**Bugün 0 satır yazıyor** ve bu doğru sonuç: kesintisi tam olan 103 paketin hepsinin gideri zaten rapordan işlenmiş. Değeri ileriye dönük — kesinti raporu yüklenmezse boşluğu bu kapatır.

Kurallar: bir pakete kesinti yazılması için hem komisyonunun hem kargo payının gelmiş olması gerekir (ölçüldü: kesintiler ayrı günlerde geliyor, 167 paketin 59'unda ödeme var ama komisyon/kargo yok — "ödeme geldi ⇒ tamam" kabul edilmiyor). Stopaj gider değil, kampanya indirimi anlamı ölçülmediği için dışarıda. Defterde kesinleşmiş kayda ve faturaya bağlı gidere dokunulmuyor.

### Trendyol kesintisi API'den işlenemiyor — ölçüldü (25.09)
Bekleyen 535 satışın **506'sı Trendyol**. Trendyol satış finans kaydı komisyonu sipariş bazında veriyor, ama **kargo yalnız fatura düzeyinde**: "Kargo Fatura 425,88 TL" kaleminde sipariş numarası ve barkod BOŞ, hangi siparişe ne düştüğü yok. Komisyonu yazıp kargoyu sıfır saymak ev kuralına aykırı olduğu için yapılmadı. Bu dağıtım "Kesinti eşleştirme" ekranının işi ve kullanıcı kararı gerektiriyor.

### HB raporları hâlâ gerekli (25.09)
Ölçüldü ve dürüstçe yazılıyor: HB'nin sipariş ucu yalnız paketlenmeyi bekleyen siparişleri veriyor, o yüzden **HB siparişleri API'den gelmiyor** — rapor yüklemesi gerekiyor. Çekilen 667 finans kaydı da şu an yalnız kaynak kaydı olarak duruyor; **kesintiler muhasebeye hâlâ rapordan işleniyor**. API finans kayıtlarını kesinti işlemeye bağlamak yapılmadı.

### Bozuk ilan kodu sorunu çözüldü: kalıcı bağlantı barkodla (25.09)
Satıcı Trendyol'daki ilan kodunu düzeltemiyor, o yüzden çözüm sistem tarafında kuruldu. İlan barkodu artık sipariş satırında saklanıyor (migration 0059) ve geçmiş taslak satırlar ham kayıttan dolduruldu — canlıda 56 satırın 55'i doldu, eşleşmeyen satıra uydurma yazılmadı.

Eşleştirme penceresinde doğrudan ürün seçilince **"bu ilanı barkoduyla kalıcı bağla"** seçeneği çıkıyor (varsayılan işaretli). Bir kez işaretlenince aynı ilanın sonraki siparişleri kendiliğinden eşleşiyor. Sipariş aktarımındaki kendiliğinden eşleşme de barkodu önce deniyor.

Kalıcı bağlantı kurulamazsa ayrıca bildiriliyor; paketin eşleşmesi her hâlükârda kaydediliyor.

### Teslim edilemeyen paket artık görünüyor (25.09)
HB'nin "teslim edilemedi" ucunu kimse okumuyordu. Paket teslim edilememişse bizde teslim duran paketin kârı yanlış sayılmış olur ve bunu görmenin yolu yoktu. Artık iş listesinde kırmızı satır çıkıyor ve tıklayınca ilgili paketler süzülüyor. Durum KENDİLİĞİNDEN geri alınmıyor: teslimi geri çevirmek satışı ve stok çıkışını da geri almak demek, o karar kullanıcınındır. İlk taramada 3 paket çıktı.

Üç paket durumu da (teslim, kargoya verildi, teslim edilemedi) otomatik senkrona eklendi.

### HB teslimleri artık API'den onaylanıyor (25.09)
HB teslim kaydı paketi teslim edilmiş işaretliyor; eşleşme sipariş numarasından kuruluyor (yerel HB paketlerinin kimliği `RPT-…`, HB'nin paket numarasıyla kesişmiyor). Trendyol'daki kural aynen: aday yalnız kargodaki paket, siparişin kargoda tek paketi varsa işaretlenir, teslim tarihi gelmezse dokunulmaz, gün Türkiye gününe çevrilir.

İlk çalıştırma: **18 paket** teslim edilmiş işaretlendi (24–25 Eylül'ün raporu yüklenmemişti). HB teslim edilmiş paket 173 → **191**, kargoda 25 → 7. Ana ekranda kargoda görünen paket 152 → 134, bekleyen tutar ₺6.327 → ₺3.484.

Otomatik senkron teslim kaydını siparişle aynı sıklıkta (4 saat) çekiyor.

### İlan eşleştirmesinde barkod önceliği (25.09)
"31 ürün eşleşmesi bekleyen paket" uyarısı incelenirken çıktı: 29 paketin ilan kodu harfi harfine `merchantSku` ve bu ilanlar birbirinden farklı ürünler. Eşleştirme barkodla kodu aynı torbaya atıyordu; o koda açılacak tek bir bağlantı 29 ayrı ürünü aynı stok kartına bağlar, stok ve kâr sessizce yanlış ürüne yazılırdı. Barkod artık önce geliyor.

### "530 kesintisi doğrulanmamış" uyarısı normal çıktı (25.09)
Ölçüldü: 522'si 18–23 Eylül'ün satışı, yani pazaryeri kesinti belgesini henüz kesmemiş — olağan akış. Gerçekten takılı kalan 8 satış var. Siparişten oluşan satış komisyon/kargo alanları boş ve `pending` doğuyor (tasarım gereği); rapor ya da kesinti eşleştirmesi gelince kesinleşiyor.

### Otomatik veri çekimi durmuştu — düzeltildi (25.09)
Trendyol **22,5 saattir** hiç çekilmiyordu. Cron 15 dakikada bir çalışıyor, bağlantıda hata yok, aralık dolmuş, imleçlerde yarım pencere yok — buna rağmen sağlayıcıya hiç çıkılmamıştı. Ekranda tek yazan "yapılacak iş yoktu" idi.

Sebep ölçüldü (iz kaydına teşhis eklenerek): `dosya 0.2sn, rapor 59.6sn, senkron 59.7sn`. Rapor işleri 50 saniyelik tur bütçesinin tamamını yiyor, en sonda duran pazaryeri senkronuna sıra hiç gelmiyordu. Bütçenin yarısını ayırmak yetmedi (tek bir uzun çağrı payı aşıyor); **senkron rapor işlerinden öne alındı** ve kendi payını aşamaz hâle getirildi.

Sonuç ölçüldü: `262 pazaryeri kaydı tarandı, 11 yeni sipariş taslağı, 12 paket teslim işaretlendi`. Teslim edilmiş TY paketi 406 → **418**. Senkrona neden sıra gelmediği ve aşama süreleri artık iz kaydına yazılıyor; bir daha sessizce durmaz.

### HB teslim, kargo ve teslim edilemedi paketleri (25.09)
Sipariş ucunun boş dönmesi hata değilmiş: HB dokümanı "bu metod ödemesi tamamlanmış YENİ siparişleri (Paketlenecek statüdekileri) listeler" diyor. Paketi hemen hazırlayan satıcıda doğal olarak boş kalıyor. Teslim edilen, kargoya verilen ve teslim edilemeyen paketler ayrı uçlarda: `/packages/merchantid/{id}/delivered · /shipped · /undelivered`. Üçü de panele eklendi ve canlıda doğrulandı (23.09: 11 teslim, 8 kargo, 0 teslim edilemedi).

Yol boyunca üç sessiz hata çıktı:
- Alan adları **PascalCase** geliyor. Kod camelCase arayınca kayıt SAYISI doğru görünüyor ama sipariş numarası, barkod ve **teslim tarihi boş** okunuyordu. Teslim tarihi olmayan paket hiçbir zaman işaretlenemez.
- Boş sonuçta uç `items` yerine **null** gönderiyor; bu "kayıt yok" demek, şema hatası değil. Sorgunun tamamı reddediliyordu.
- Kendi kodumda teslim tarihi yerine "kaydın son işlem tarihi" kullanılıyordu — tarih uydurmak olurdu, kârı yanlış güne yazardı. Eski test yakaladı.

Bu uçlar yalnız **son 1 ayı** veriyor ve tek seferde en fazla bir gün.

### Hepsiburada bağlandı ve ilk veri çekildi (25.09)
Bağlantı kuruldu, ilk gerçek testte finans ucu veri döndürdü ama tek kayıt bile geçmedi: para alanları `{value,currencyCode}` nesnesi olarak geliyor, okuyucu `{amount,currency}` arıyordu. Hata mesajı genel olduğu için "bağlantı çalışmıyor" sanılabilirdi; şema hatasında gelen alan adlarını log'a yazan teşhis eklendi, sebep canlı log'dan okundu. Düzeltildi, iki biçim de kabul ediliyor. Durum alanı da yanlış okunuyordu (`paymentStatus` değil `status`).

11–25 Eylül çekildi, **667 kaynak kaydı**: Stoppage 150, Payment 150, ShipmentCostSharingExpense 121, PaymentServiceCostReflection 119, Commission 119, ProcessingFeeExpense 5, TotalPayment 2, CampaignDiscount 1. Mükerrer yok. Bunlar kaynak kayıtlarıdır; deftere işlenmedi.

### Satış kayıtları ekranına sayfalama
1255 satır tek seferde basılıyordu (20.137 DOM öğesi, 2509 düğme). Artık 50'şer satır, altta "← Önceki / Sonraki →". Sayfa değişimi sunucuya gitmiyor. Genel durum toplamları ve satır işlemleri tüm kayıtları görmeye devam ediyor; hesap değişmedi. Sayfa hesabı ayrı sınandı (kayıt kaybolmuyor, numara liste dışına taşmıyor, boş liste çökmüyor).

### Bilinmesi gerekenler
- Hepsiburada aday üretmiyor: mevcut HB bağlayıcısı finans kaydında ödeme emri numarası döndürmüyor. Ekran bunu açıkça yazıyor, uydurma eşleşme üretmiyor.
- Hata alan bağlantı otomatik senkronda denenmiyor; kullanıcı bir kez elle çalıştırıp hatayı temizlemeli.
- Yayın sonrası tarayıcı eski kabuğu tutabiliyor; bir sayfa yenilemesi yetiyor, oturum düşmüyor.
