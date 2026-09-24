# Yapılacaklar

Son güncelleme: 2026-09-25

## SENDE — panelden yapman gerekenler

- [ ] **Şifre yenile (ÖNCELİKLİ)** — HB servis anahtarı sohbet geçmişine iki kez düştü. Bağlantı kuruldu ve çalışıyor; anahtarı Hepsiburada panelinden yenile, sonra Bağlantılar → Hepsiburada → "Bağlantıyı güncelle" ile yenisini gir.
- [ ] **Banka ekstresi yükle** — Trendyol ödemelerinin yattığı hesabın ekstresi. Banka ekstresi → "Ekstre yükle". CSV/Excel, sütunları panel kendisi tanıyor (test edildi). Sonra "Hakediş eşleştirme" sekmesinden onayla; para ancak o zaman kasaya girer. **Ana Kasa'nın eksi görünmesi bununla çözülecek.**

## Açık işler

- [ ] **HB sipariş ucu boş dönüyor** — kimlik doğru (finans ucu aynı kimlikle 667 kayıt getirdi), ama `oms-external…/orders` beş ayrı günde de 200 + boş liste döndü. Sebep ölçülmedi: bu uç büyük ihtimalle yalnız işlem bekleyen siparişleri veriyor, teslim edilmişler başka uçtan geliyor olabilir. HB sipariş dokümanına bakılmalı. Sipariş verisi bu yüzden hâlâ rapor yolundan geliyor.
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

### Hepsiburada bağlandı ve ilk veri çekildi (25.09)
Bağlantı kuruldu, ilk gerçek testte finans ucu veri döndürdü ama tek kayıt bile geçmedi: para alanları `{value,currencyCode}` nesnesi olarak geliyor, okuyucu `{amount,currency}` arıyordu. Hata mesajı genel olduğu için "bağlantı çalışmıyor" sanılabilirdi; şema hatasında gelen alan adlarını log'a yazan teşhis eklendi, sebep canlı log'dan okundu. Düzeltildi, iki biçim de kabul ediliyor. Durum alanı da yanlış okunuyordu (`paymentStatus` değil `status`).

11–25 Eylül çekildi, **667 kaynak kaydı**: Stoppage 150, Payment 150, ShipmentCostSharingExpense 121, PaymentServiceCostReflection 119, Commission 119, ProcessingFeeExpense 5, TotalPayment 2, CampaignDiscount 1. Mükerrer yok. Bunlar kaynak kayıtlarıdır; deftere işlenmedi.

### Satış kayıtları ekranına sayfalama
1255 satır tek seferde basılıyordu (20.137 DOM öğesi, 2509 düğme). Artık 50'şer satır, altta "← Önceki / Sonraki →". Sayfa değişimi sunucuya gitmiyor. Genel durum toplamları ve satır işlemleri tüm kayıtları görmeye devam ediyor; hesap değişmedi. Sayfa hesabı ayrı sınandı (kayıt kaybolmuyor, numara liste dışına taşmıyor, boş liste çökmüyor).

### Bilinmesi gerekenler
- Hepsiburada aday üretmiyor: mevcut HB bağlayıcısı finans kaydında ödeme emri numarası döndürmüyor. Ekran bunu açıkça yazıyor, uydurma eşleşme üretmiyor.
- Hata alan bağlantı otomatik senkronda denenmiyor; kullanıcı bir kez elle çalıştırıp hatayı temizlemeli.
- Yayın sonrası tarayıcı eski kabuğu tutabiliyor; bir sayfa yenilemesi yetiyor, oturum düşmüyor.
