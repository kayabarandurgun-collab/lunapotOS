# GÜNCEL DURUM — 14 Eylül 2026 (canlıya geçiş turu)

Bu bölüm dosyanın en güncel kaydıdır; aşağıdaki bölümler tarihsel kalır.

## Sistem canlıda ve satışların tamamı stoktan düşmüş durumda

Bekleyen 3 paket de sevk edildi: taslak **0**, sevk **243**, satış kaydı **329**,
stok hareketi **417**. Her paket kendi tarihiyle işlendi (TEA…085 ve TEA…086 →
2026-09-01, HB-5515871961 → 2026-09-10); tarih uydurulmadı.

## Eksik 29 sipariş panele girildi; uçlar parçalı hale getirildi (15 Eylül)

Kullanıcı ana sayfadaki 178 rakamının elindeki veriden az olduğunu fark etti. İki ayrı şey vardı:

**1. Ekran son 30 günle sınırlı** — bu kusur değil, kartın tanımı. Panelde toplam 211 teslim
edilmiş paket vardı, kart bunların son 30 gününü gösteriyordu.

**2. 29 teslim edilmiş sipariş panele HİÇ girmemişti** — 39.490,63 TL brüt. Rapor 192 TY + 65 HB
teslim paketi gösterirken panelde 161 TY + 50 HB vardı.

### Neden girmemişler

Hepsi aynı gerekçeyle durmuştu: **"Kalem kimliği eksik; uydurma kimlikle stok çıkışı yapılmaz."**
Bu dosyalarda satır numarası sütunu yok. Sistemde bunun için açık bir istisna var
(`line_identity_from_package_sku`) ama AÇIKÇA beyan edilmesi gerekiyor — doğru tasarım.

Beyanın doğru olduğu veriden doğrulandı, varsayılmadı: 29 paketin hepsi tek satırlık, barkodları
dolu, aynı pakette aynı barkod tekrarı YOK, ürünlerin tamamının katalog eşleşmesi var.
Yani paket+barkod zaten tekil kimlik; kimlik uydurulmuş olmuyor.

### Aktarım sırasında çıkan iki sorun

**KDV sütunu yok:** 22 taslak açıldı ama rezervasyon "KDV hariç satış tutarı eksik" ile durdu.
Kullanıcı "KDV tamamen %20 olmalı" dediği için `/map` adımında %20 girildi ve zincir tamamlandı.

**Bölünmüş sipariş:** kalan 7 paketin hepsi TEK siparişin (11590920604) parçalarıydı. Bir önceki
turda eklediğim "mevcut siparişe bağlan" koruması bunları incelemeye atıyordu. Oysa 1 sipariş →
N paket durumunda her parça KENDİ kaydı olmalı. Düzeltildi: aday başka bir pazaryeri paketine
bağlıysa bağlanmaz, normal taslak akışı sürer. Test eklendi.

**Gönderim tarihi raporda yok.** Uydurulmadı: sistemdeki mevcut 243 paketin hepsinde
gönderim = sipariş tarihi olduğu ölçüldü ve aynı kural sürdürüldü. Teslim tarihleri gerçek.

### Uçlar parçalı hale getirildi (503 düzeltmesi)

Sipariş sayısı artınca `/orders/summary` ve `/apply-fees` tek istekte 225 siparişi tarayıp
worker süre sınırını aştı (**503**). İkisi de artık `cursor` ile parçalı çalışıyor:
`next_cursor` doluyken çağıran döngüye devam eder, ekran parçaları toplar. Sıralama sabit
(`ORDER BY o`) — parçalı okumada hiçbir sipariş iki kez işlenmez veya atlanmaz. Test eklendi.

### Sonuç

| | Önce | Sonra |
|---|---|---|
| Satış kaydı | 329 | **368** |
| Stok hareketi | 419 | **458** |
| Teslim edilen paket | 211 | **253** |
| Stok değeri | 39.879,42 TL | **32.762,42 TL** |
| Bağsız teslim edilmiş paket | 29 | **0** |

Ana sayfa: **220 / 220 paket hesaplandı** · katkı ₺13.935,53 · kâr bırakan ₺17.558,61 ·
zarar eden ₺3.623,08 · Trendyol ₺12.575,52 · Hepsiburada ₺1.360,01.

Kesinleşmiş 339 satış kaydında: gelir 119.658,11 − maliyet 44.927,94 − kesinti 61.777,77
= **12.952,40 TL katkı**.

**Beklenen yan etki:** `KL-TS1-210L` stoğu −2'den **−8**'e indi. 6 adet daha satılmış ama alışı
girilmemiş; o adetlerin maliyeti sıfır görünüyor. Alış faturası girilince düzelir. Kullanıcıya
aktarım öncesinde bildirildi ve onayı alındı.

Yazma öncesi tam yedek alındı: `yedekler/yedek-2026-09-15-29siparis-oncesi.sql` (125 MB).

---
## Ana sayfa kârı çalışır hale geldi — üç ayrı kusur (15 Eylül)

Kullanıcı ana sayfanın boş olduğunu bildirdi: "0 / 178 paket hesaplandı, Bilgi bekleniyor".
Üç ayrı kusur vardı; üçü de giderildi. **Defter hiç değişmedi** (satış 329, stok hareketi 419,
stok değeri 39.879,42 TL — önce ve sonra birebir aynı).

### 1. Teslim edilmeyen siparişin kârı hesaplanıyordu

Kullanıcının en baştaki kuralıydı, uygulanmamıştı: teslim edilmemiş pakette komisyon kesilmiş
görünse de KARGO kesinleşmez (iade, yeniden gönderim, ceza). Artık `contribution_cents` yalnızca
teslim edilmiş pakette dolar. Ölçüt pazaryerinin durum metni DEĞİL, eşleştirilmiş **teslim tarihi**
alanıdır: durum sözcükleri pazaryerine göre değişir, tarih alanı değişmez. Paketin BÜTÜN
satırlarında tarih olmalı; yarısı teslim edilmiş paket teslim sayılmaz.

Hesabın kendisi bozulmadı: net satış, maliyet ve kesintiler durur, tahmin de durur
("Kargodaki tahminim" ekranı bunu kullanır). Yalnız "gerçekleşmiş kâr" verilmez.

### 2. Kesintiler rapordan deftere hiç geçmiyordu

329 satış kaydının HEPSİNDE komisyon/kargo/diğer alanları boştu. Çünkü bu alanları dolduran tek
yol alış faturası gider satırıydı ve orada 0 kayıt vardı. Oysa tutarlar rapor kayıtlarında duruyordu.

Yeni uç: `GET/POST /api/ec/reports/apply-fees`. Rapordaki kesintileri ERP'de bağlı, **teslim edilmiş**
paketlerin satış kayıtlarına yazar. Fatura İSTEMEZ. Kurallar:

- Yazma **SET**'tir, toplama değil → aynı rapor tekrar aktarılsa tutar çoğalmaz (test edilmiş).
- Tutar, paketin satış kayıtlarına gelirleri oranında ve **toplamı korunarak** bölünür.
- Faturaya bağlanmış (`fee_allocations`) kayda dokunulmaz; fatura her zaman üstündür.
- Komisyon veya kargo raporda yoksa **sıfır yazılmaz**, paket atlanır: eksik veri uydurulmaz.
  "Diğer" kalemi gerçekten alınmamış olabilir; yalnız o 0 kabul edilir.
- Deftere yazılan tutar, ekranda görünen KDV hariç tutarın AYNISIDIR (`net_cents`).
- Üç bileşen de rapordan bilindiği için `fees_status=confirmed`. Sonradan fatura gelirse
  devralma koruması (`FEE_TAKEOVER_REQUIRED`) yine devrededir.

Canlıda uygulandı: TY 163 paket / 231 kayıt, HB 63 paket / 70 kayıt. 301 denetim izi yazıldı.

### 3. HB siparişleri İPTAL edilmiş kopya paketlere bağlıydı

HB'nin rapora bağlı 67 paketinin hepsi `cancelled` durumdaydı, bu yüzden satış kaydı yoktu ve HB
ana sayfada hiç görünmüyordu. Kök neden: **bağlayıcı, aynı pazaryeri siparişinin panelde zaten
var olup olmadığına hiç bakmıyordu** — doğrudan `RPT-<özet>` kimlikli yeni paket açıyordu.
Gerçek kayıtlar `HB-5505412182` biçimindeydi, rapordaki paket no ise `5505412182`.

`HB-` önekini koda gömmek yanlış olurdu (kodda hiç geçmiyor, o kimlikler elle girilmiş).
Doğru iş anahtarı **sipariş numarası**: HB 67/67, TY 176/176 eşleşiyor. Artık:

- Taslak açmadan önce aynı kanalda aynı `order_no` ile iptal olmayan paket aranır (`outcome: match`).
- Sipariş numarası MAĞAZA içinde tekildir, pazaryeri genelinde değil: başka mağazanın kayıtlarına
  bağlı paket aday sayılmaz. Mevcut "iki mağaza karışmaz" testi bu hatayı yakaladı ve düzeltildi.
- Birden fazla aday varsa (bölünmüş sipariş) otomatik bağlanmaz; eski davranış sürer.
- **İptal edilmiş** siparişe bağlı kayıt "bağlı" sayılmaz: iptal paketin defterde karşılığı yoktur,
  bağ eskimiştir, gerçek siparişe yönlendirilir.

Canlıda 65 paket / 71 rapor satırı gerçek siparişlerine bağlandı. Stok ve satış tutarı değişmedi.

### Ekranda ne göründü

Ana sayfa: **178 / 178 paket hesaplandı** · katkı ₺2.890,97 · kâr bırakan ₺5.936,27 ·
zarar eden ₺3.045,30 · Trendyol ₺1.730,46 · Hepsiburada ₺1.160,51.
İş listesinde "212 zarar gösteren satış" ve "29 kesintisi doğrulanmamış satış" başlıkları açıldı.

Rapor Kutusu > Sipariş sonuçları ekranına ayrıca mağaza geneli özet eklendi: teslim edilen,
kâr bırakan, zarar eden, hesaplanamayan sayıları; karta tıklanınca **zarar eden paketler** ve
**hesaplanamayanlar neyin eksik olduğuyla** listelenir. Kesinti aktarımı da bu ekrandan
önizlenip uygulanır (önizleme hiçbir şey yazmaz).

### KDV

Kullanıcı "KDV tamamen %20 olmalı" dedi. Ürün kartlarının 37/37'si zaten %20. Sipariş
satırlarında 6 satır %10 ile donmuş durumda (HB ilanından gelen eski kayıtlar) — bunlar
`ec_order_lines.vat_bps` içinde ve satış kaydı üretmiş durumda; değiştirmek defteri
değiştirmek olur. AÇIK KALDI.

### Testler

429 test geçiyor. Yeni: teslim kuralı (2), kesinti köprüsü (4), mevcut siparişe bağlanma (3).
İki gerçek koruma test sırasında ortaya çıktı: rapor kayıtları güncellenemiyor
(`REPORT_RECORD_VERSION`) ve silinemiyor (`IMMUTABLE_LEDGER`).

---
## Kâr hesabı çalışır hale geldi — fatura GEREKMİYORMUŞ (15 Eylül)

**Kullanıcı haklıydı, ben yanlış ekrana bakıyordum.** "Komisyon ve kargo faturasına
ihtiyacımız yok ki, TY ve HB sipariş kayıtlarının içinde yok mu zaten bu veriler?"
diye sordu. Doğruymuş. Sistemde İKİ ayrı kâr görünümü var:

- **Kâr raporu (#performance):** resmî muhasebeye dayalı, `sale_entries.commission_cents`
  alanlarını okur. O alanlar ancak `fee_allocations` üzerinden dolar, o da alış faturası
  gider satırı ister. Bu ekran hâlâ fatura bekliyor ve beklemesi DOĞRU.
- **Sipariş sonuçları (Rapor Kutusu):** pazaryeri raporundan komisyon/kargo/hizmet
  kesintilerini paket bazında hesaplar. Fatura İSTEMEZ. Kullanıcının istediği buydu.

### Katkının hesaplanmasını engelleyen iki gerçek eksik

**1. KDV oranı hiçbir üründe tanımlı değildi.** `vatOf()` KDV'yi YALNIZCA
`ec_price_profiles` tablosundan okuyor; rapor kaydındaki `vat_bps` bu hesapta
kullanılmıyor (satır 261 üzerine yazıyor). Tablo boştu → net satış KDV hariç
hesaplanamıyor → katkı null.

HB dosyalarından ürün bazında gerçek oranlar çıkarıldı: 23 ürün %20, 2 ürün %10
(Torf+Cocopeat 5 L ve Yaprak Parlatıcı 750 ml), çelişki yok. Kullanıcıya soruldu;
"HB ilanlarında yanlış girilmiş, hepsi %20" dedi. 37 kartın hepsine %20 tanımlandı.
Boyut/ağırlık alanları tabloda ZORUNLU olduğu için yer tutucu konuldu (10×10×10 cm,
1000 g) ve bu kullanıcıya bildirildi: "Kaça satmalıyım?" ekranı gerçek ölçü ister.

**2. Bugün kurulan eşleştirmeler eski kayıtlara işlememişti.** `components_json` kayıt
oluşturulurken donduruluyor, `updated` dalında güncellenmiyor. Bunun için özel uç
varmış: `POST /reports/backfill-components` — yalnız `components_json IS NULL` olanları
doldurur, mevcut set içeriklerine dokunmaz. Çalıştırıldı: TY 10 + HB 36 = **46 kayıt**
dolduruldu, eşleşmesiz kayıt **0**.

### Sonuç: katkı hesaplanıyor

| | Trendyol | Hepsiburada |
|---|---|---|
| Sayfadaki sipariş | 108 | 96 |
| Katkısı hesaplanan | **108** | **93** |
| Eksikli | 0 | 3 |
| Sayfa katkı toplamı | **+6.816,57 TL** | **+3.304,78 TL** |

Hesap ELLE doğrulandı, beş siparişte de fark 0,00:
net satış − maliyet − kesintiler = sistemin katkısı. Kesinti iki kez sayılmıyor.
Örnek: 161,67 − 84,00 − 24,25 − 46,49 − 13,19 = **−6,26 TL**.

TY sayfasında 62 sipariş kârda, **46 sipariş zararda** — kargo ve komisyon küçük
siparişleri götürüyor. Bu artık görülebiliyor.

**Kalan 3 HB siparişi:** ürünün sipariş tarihinden ÖNCE stok girişi yok (satılmış ama
alışı sonradan girilmiş), maliyet bilinmiyor ve uydurulmadı.

---
## 11 ürün eşleştirmesi ve 8 inceleme kapatıldı (15 Eylül)

### Eşleştirmeler: 67 → 78

Eşleşmeyen 11 ilan koduna karşılık kuruldu. Beşi tek ürün, altısı SET.
Set bileşenleri ve boyları KULLANICIYA SORULDU, tahmin edilmedi:

| Kod | Bileşen |
|---|---|
| HBV00000X8JSU | TR-TOPRAK-10L |
| HBV00000CGXO5 | TR-TOPRAK-5L |
| HBV00000ANRQ2 | TR-ORKIDE-500ML |
| HBCV000007EJ06 | TR-CICEK-1000ML |
| TYBX0SEAAPVZ6CX475 | TR-PARLATICI-750ML |
| HBCV000002LBL0 | kaktüs toprağı 2,5 L + kaktüs besini 225 ml |
| HBCV00006H301U | orkide toprağı 3 L + orkide besini 225 ml + temizleyici 250 ml |
| HBCV000085GUAV | orkide toprağı 3 L **× 2 paket** |
| HBV00000RQMQE | orkide toprağı 3 L + orkide besini 225 ml |
| HBCV00002590HV | genel besin 500 + çiçek açtıran 500 + temizleyici 250 ml |
| 23245030333243 | 5 × 225 ml: kaktüs, çiçek, yeşil, menekşe, orkide (%20'şer) |

**Gelir payları maliyet oranında hesaplandı**, eşit bölünmedi. Örnek: kaktüs seti
toprak 24 TL / besin 21 TL → %53,33 ve %46,67. Sistem toplamın tam %100 olmasını
zorunlu tutuyor; her sette tutturuldu.

**BİR DÜZELTME:** Kullanıcı "yaprak temizleyici 225 ml" dedi ve HB ilan adı da 225
yazıyor. Alış geçmişine bakıldı: sistemde yalnız 250 ml (85 adet alınmış) ve 500 ml
(6 adet) var; alış faturalarında da sadece "250 ML" ve "500 ML" geçiyor. 225 ml hiç
alınmamış. İlan adı yanlış; 250 ml karta bağlandı ve bu kullanıcıya bildirildi.

### 8 açık inceleme kapatıldı

- **6 × erp_ambiguous:** aynı sipariş İKİ PAKETE bölünmüş (örn. sipariş 11590299167 →
  paket 4147140895 ve 4147140896). Sistem yanlış pakete bağlamaktansa bağlamamayı
  seçmiş. Kayıtlar YAZILMIŞ durumda, inceleme yalnızca uyarıydı → reddedildi.
- **2 × no_amount:** finans dosyalarının son "Toplam" satırı; tutarı olmadığı için
  mali kayıt olmamalı → reddedildi.

Açık inceleme 8 → **0**. Mali kayıt DEĞİŞMEDİ: satış 329, stok hareketi 419,
stok değeri 39.879,42 TL.

### Kâr ekranı için gereken zincir ölçüldü

`summary()` kesintileri doğrudan `sale_entries.commission_cents / shipping_cents /
other_cents` alanlarından okuyor; `fee_allocations` ayrı tabloda duruyor. ANCAK
`ec_fee_allocation_apply` tetikleyicisi, kesinti dağıtıldığında bu alanları otomatik
güncelliyor. Yani zincir şu: **pazaryeri komisyon/kargo faturası → gider satırı →
kesinti eşleştirme → sale_entries dolar → kâr hesaplanır.** Kısa yolu yok ve
olmaması doğru: sistem tahmini kesintiyle kâr hesaplamıyor.

### Günlük düzenin canlı kanıtı

9-HB-SIPARIS-D.csv, 7-HB-SIPARIS-C.csv dosyasının bir sonraki çekimiydi (aynı 89 satır,
aynı 22.195,90 TL). Sonuç: **Yeni 0 · Güncellenen 1 · Aynı (tekrar) 88** — yalnızca
kargodan teslime geçen tek paket güncellendi. Çift kayıt yok.

---
## Hepsiburada raporları girdi — iki profil kusuru düzeltildi (15 Eylül)

### 1. Sipariş profili teslim tarihini HİÇ okumuyormuş

HB sipariş profili v1'de `delivered_date` ve `status` eşlenmemişti. HB'de teslim tarihli
kayıt sayısının **sıfır** olmasının sebebi dosyalar değil, profilin kendisiydi.
Profil v2 (`bfc0bce6`): `delivered_date` → Teslim Tarihi, `status` → Paket Durumu,
`vat_bps` → KDV(%). Trendyol dökümünde KDV sütunu yoktu, HB'de var.

Geçmişteki iki tuzak yeniden ölçülüp KAPALI tutuldu: **Barkod bağlanmadı** (HB'de kargo
takip numarasıdır), **Kalem Numarası bağlanmadı** (sipariş içi sıra numarası; bağlansaydı
73 satır 7 kayda çökerdi). Ürün kimliği Satıcı Stok Kodu olarak kaldı, yani anahtar
biçimi `P:paket|sku` değişmedi ve mevcut kayıtlar çoğalmadı.

| Dosya | Sonuç |
|---|---|
| 5-A (5 satır) | Güncellenen 5 |
| 6-B (18 satır) | Güncellenen 18 |
| 7-C (89 satır) | Yeni 32 · Güncellenen 50 · Aynı (tekrar) 7 |

HB sipariş kaydı 73 → **105**, teslim tarihli 0 → **69**. Tutarlar dosyadan ayrıca
hesaplanıp ekranla karşılaştırıldı: 1.503,40 · 9.222,90 · 22.195,90 — üçü de birebir.

### 2. Finans raporunda KOMİSYON başka sütuna kaymış

Yeni HB finans dökümünde **"Komisyon (KDV dahil)" sütunu 96 satırın hiçbirinde dolu değil**;
komisyon başlıksız **"Sütun 13"** içinde (94 satırda dolu, satışa oranı %5,6–%24, ortanca
%20,4 — HB komisyon aralığı). Eski dosyada durum TERSİYDİ: komisyon doluydu ve Sütun 13
onun kopyasıydı, o yüzden v1'de bağlanmamıştı.

Eski profil bu dosyaya uygulansaydı **komisyon hiç girmeyecek, 5.586,26 TL kesinti**
**sessizce kaybolacaktı.** Mutabakat elle kuruldu:
29.676,30 − 6.078,04 − 186,92 − 194,67 + 147,70 − **5.586,26** = **17.778,11** =
dosyanın kendi net tutarı, kuruşu kuruşuna.

Profil v2 (`542010d0`): `commission` → **Sütun 13**, ek kesintiler İptal/İade → iade,
Ceza → diğer, Hizmet bedeli → hizmet; `undated: true` (HB finans dökümünde işlem tarihi
sütunu yoktur). Boş kalan "Komisyon (KDV dahil)" göz ardı edildi.

Sonuç: Yeni 504 · Güncellenen 45 · Aynı (tekrar) 306 · İnceleme 1 (dosyanın son toplam
satırı, tutarı olmadığı için mali kayıt olmadı).

### HB'de teslim işaretlenecek paket ÇIKMADI — ve bu doğru

Teslim edilen HB paketleri zaten işaretliydi (50'si önceki turda). Kargoda kalan 17 paket
raporda da "Kargoda"/"Gönderime Hazır" görünüyor. **Ama o 17 paketin hiçbiri yeni
raporlarda geçmiyor** (7–11 Eylül sevkleri, rapor 15 Eylül'e kadar olduğu halde).
İndirilen rapor bir tarih filtresiyle gelmiş olabilir; teslim durumları BİLİNMİYOR,
tahmin edilmedi. Sonraki haftalık raporda görünürlerse kendiliğinden güncellenecekler.

### Açık kalanlar

- **9 HB stok kodunun katalog eşleşmesi yok** (14 satır ürüne bağlanmadı):
  HBV00000X8JSU, HBV00000CGXO5, HBCV000002LBL0, HBV00000ANRQ2, HBCV000007EJ06,
  HBV00000RQMQE, HBCV000085GUAV, HBCV00006H301U, HBCV00002590HV. Son dördü SET.
- TY tarafında 2 barkod: 23245030333243, TYBX0SEAAPVZ6CX475.
- Kâr ekranı hâlâ hesaplamıyor: kesintiler Rapor Kutusu'nda ama satışlara bağlı değil;
  bağlanması için pazaryerinin kestiği komisyon/kargo FATURASI gerekiyor.

---
## Trendyol raporları girdi, teslimler işaretlendi (15 Eylül)

**Kullanıcının hedefi:** her gün son 7 günün raporunu Rapor Kutusu'na bırakmak; sistem yeni
siparişi yazsın, kargodakini teslime çevirsin, çift kayıt yapmasın, elle veri girilmesin.
Bu tur o düzenin kurulduğu ve ÖLÇÜLDÜĞÜ turdur.

### Trendyol sipariş profili kuruldu (daha önce yoktu)

Profil `7a88df7d`, sürüm 1, 56 sütunlu döküm. Eşleştirmede iki karar ölçüme dayandı:

- **Ürün kimliği = Barkod.** 153 satırda 26 farklı değer, tekrar oranı 0,83 → ürün gibi
  davranıyor; canlı katalogdaki 51 TY eşleştirmesi de aynı biçimde (`TYB…` ve düz rakam).
- **"Stok Kodu" sütunu BAĞLANMADI.** 153 satırın hepsinde tek değer var, o da `merchantSku`
  yazısının kendisi. Bağlansaydı bütün siparişler tek ürüne çökerdi (Hepsiburada'da
  `line_id` ile yaşanan çökmenin aynısı).
- `delivered_date` → **Teslim Tarihi**. Eski TY dökümünde bu sütun YOKTU; TY teslimleri
  bu yüzden işaretlenememişti. Yeni döküm bu alanı taşıyor.
- KDV oranı ve komisyon/kargo sütunları bağlanmadı: KDV sütunu dosyada yok (uydurulmaz),
  kesintiler finans raporunun işi (iki yerden sayılmasın).

### Çift kayıt testi — kullanıcının asıl endişesi

Yüklemeden ÖNCE yerelde ölçtüm: üç dosyada 251 satır → 239 ayrı anahtar, 12 tekrar
(A∩B=0, A∩C=1, B∩C=11). Sistem tam bu sayıları verdi:

| Dosya | Sonuç |
|---|---|
| 1-A (35 satır) | Yeni 35 |
| 2-B (63 satır) | Yeni 63 |
| 3-C (153 satır) | Yeni 141 · **Aynı (tekrar) 12** |
| Finans (224 satır → 2.016 kayıt) | Yeni 257 · **Güncellenen 103** · **Aynı 1.656** |

Canlıda TY sipariş kaydı **239** oldu — 251 satır yüklendi, 12 tekrar yeni kayıt açmadı.
Finans tarafında 103 kayıt GÜNCELLENDİ (çoğaltılmadı), 1.656 kayıt "aynı" deyip geçildi.
Her dosyanın satış toplamı dosyadan ayrıca hesaplanıp ekranla karşılaştırıldı: üçü de
kuruşu kuruşuna aynı (14.709,84 · 44.429,15 · 93.807,99).

**Finans mutabakatı:** ekran özeti 96.841,20 gösteriyordu, dosyanın net tutarı 83.333,48.
Aradaki 13.507,72 ek kesinti sütunlarıydı (İptal −9.256,58, İndirim −3.997,80, İade Kargo
−253,34) ve profil bunları zaten bağlamış. Bütün sütunlar toplanınca fark **0,00**.

### Trendyol teslimleri: 161 paket işaretlendi

Aday 162 paket; **çelişkili teslim tarihi 0**. Bir paket atlandı: `TEA2026000000028`,
raporda teslim 28 Temmuz, bizim sevk kaydımız 29 Temmuz — teslim sevkten önce görünüyor,
zorlanmadı. Kalan **161 paket kendi teslim tarihiyle** işaretlendi (17 Tem – 15 Eyl).

Teslim edildi 50 → **211**, kargoda 193 → **32**. Satış kaydı (329) ve stok hareketi (419)
DEĞİŞMEDİ: teslim işareti mali kayıt yazmaz.

### Açık kalanlar

- **7 inceleme**, hepsi `erp_ambiguous`: bir sipariş numarasına canlıda birden çok paket
  uyuyor; sistem yanlış pakete bağlamaktansa bağlamamayı seçti. Veri kaybı değil.
- **2 barkodun kataloğu yok:** `23245030333243` (5'li Besin Seti), `TYBX0SEAAPVZ6CX475`
  (Yaprak Parlatıcı Sprey). O satırlar ürüne bağlanmadı.
- **Kâr ekranı hâlâ hesaplamıyor.** Artık paketleri görüyor (TY 128 + HB 50) ama satış
  kayıtlarında komisyon/kargo alanları boş ve sistem bilinmeyeni sıfır saymıyor. Kesinti
  verisi Rapor Kutusu'nda duruyor; satışlara bağlanması için pazaryerinin kestiği
  komisyon/kargo FATURASININ alış belgesi olarak girilmesi gerekiyor. Ayrı iş.

---
## Yeni Tropikal faturası TRP2026000001080 (15 Eylül)

Belgenin yeni olduğu **kanıtlandı**: SHA-256 canlıda yok, `1080` numarası da yok
(en son `1074` idi). Uygulamanın kendi PDF okuyucusu bu belgede metin katmanı göremedi
(önceki 3 belgede de öyle), ama `pdftotext` metni çıkardı.

**Miktarlar üç ayrı yoldan doğrulandı, uydurulmadı:** ham akışta `Miktar 30 Adet 25 Adet`
yazılı · birim fiyatla bölme aynı sonucu veriyor (2.070÷69=30, 1.150÷46=25) · satır
toplamları belgenin kendi toplamıyla tutuyor.

| Kalem | Adet | Net | KDV |
|---|---|---|---|
| TR-TOPRAK-10L | 30 | 2.070,00 | 414,00 |
| TR-GENEL-1000ML | 25 | 1.150,00 | 230,00 |

`TOPRAK3` kodu geçmişte iki kez aynı karta eşlenmiş ve birim fiyatı da 69 TL — tahmin
değil, kayda dayanıldı.

**Çeşit riski önceden soruldu.** `B.BESİNİ3` kodu geçmişte çiçek/genel/kaktüs/orkideye
dağılmış; 500 ml'de tam burada yanılmıştık. Kullanıcı "artık yeni faturalarda çeşit
açıklamada yazıyor, önceki kayıtlar doğru" dedi ve faturanın kendi açıklaması
"GENEL BİTKİ BESİNİ 1000 ML" diyor.

**Sıra bilerek şöyle kuruldu:** önce `draft` girildi ve satırlar faturayla karşılaştırıldı
(2/2 birebir, 3.220,00 + 644,00 = **3.864,00 TL** = belgenin kendi toplamı), sonra `post`,
sonra mal kabulü. Çeşit yanlış çıksaydı draft aşamasında geri alınabilirdi — 500 ml hatası
faturayı muhasebeleştirdikten sonra ortaya çıktığı için düzeltilememişti.

**Sonuç (hepsi ölçüldü, farkı sıfır):** TR-TOPRAK-10L 7→**37**, TR-GENEL-1000ML 6→**31**.
Toplam stok 514→**569 adet**, 36.659,42→**39.879,42 TL** (artış tam olarak fatura neti).
Mal kabul değeri 3.220,00 = fatura neti. Posted fatura 30→**31**, borç 98.521,20→
**102.385,20 TL** (artış 3.864,00 = KDV dahil toplam).

**Eksik kalan:** belge panelin belge arşivine yüklenmedi; o akış tarayıcıdan dosya seçmeyi
gerektiriyor. Fatura kaydı ve mal kabulü tamamdır.

---
## Teslim işaretlemesi — Hepsiburada tamam, Trendyol tarih bekliyor

Kullanıcı "teslim edildi zaten çoğu" dedi ve **haklıydı**: kâr ekranının boş olmasının
sebebi teslim durumunun hiç aktarılmamış olmasıydı.

**Hepsiburada:** dökümde `Paket Durumu` ve `Teslim Tarihi` sütunları var. 67 paketin
**50'si** "Teslim edildi", durumu çelişen paket 0, hepsinin tek ve okunur tarihi var.
Canlıda 50/50 eşleşti, hiçbirinin teslim tarihi kendi sevkinden önce değil.
**50 paket kendi tarihiyle işaretlendi** (0 hata). Teslim 0 → **50**, kargoda 243 → **193**.
Mali kayıt değişmedi: satış 329, hareket 417, stok 514 adet / 36.659,42 TL — dördü de aynı.

**Trendyol yapılmadı.** 176 paketin 176'sı dökümde bulundu, **158'i "Teslim Edildi"**;
eşleştirme sipariş numarasıyla kusursuz çalışıyor. Ama dökümde **teslim tarihi sütunu yok**,
yalnız sipariş tarihi var. Sipariş tarihini teslim tarihi diye yazmak kaydı yanlışlar;
tarih **uydurulmadı**, kullanıcıdan teslim tarihi taşıyan rapor istendi.

### Kâr ekranı hâlâ hesaplamıyor — ayrı bir sebep

329 satış kaydının hepsinde komisyon, kargo ve diğer gider **NULL**, `fees_status=pending`.
`package-profit.js`: "Bilinmeyen tutarlar sıfır sayılmaz." Kesinti verisi Rapor Kutusu'nda
duruyor (2.187 finans kaydı) ama satışlara bağlanmamış: canlıda satış kesintisi olarak
işlenmiş gider satırı **0** (86 alış satırının hepsi `product`). Bu, pazaryeri komisyon/kargo
faturalarının girilmesini gerektiren ayrı bir iş.

---
## Stok eksiye düşebilir — ama yalnız açık beyanla (göç 0045)

Kullanıcı, kaydı olmayan bir alıştan satılmış mal olduğu için stoğun eksiye
düşebilmesini istedi. **Koruma kaldırılmadı, beyana bağlandı:**
`workspace_settings.allow_negative_stock`, varsayılan **0 (kapalı)**.

Teknik sürpriz: eksi yasağı tetikleyicilerde değil, `ec_stock_balances` tablosunun
kendi `CHECK(quantity_milli>=0)` kısıtındaydı. SQLite bunu tablo yeniden kurulmadan
kaldıramıyor. Ölçüldü: "yeni tablo → eskiyi düşür → adını değiştir" yolu **çalışmıyor**
(SQLite yeniden adlandırma sırasında bütün tetikleyicileri yeniden ayrıştırıyor).
Deponun kendi 0012 örneği izlendi: bağımlı **10 tetikleyici düşürüldü, tablo yeniden
kuruldu, 10'u da aynen geri yazıldı.**

Tetikleyici metinleri elle kopyalanmadı: `sqlite_master`'dan alınıp programla şarta
bağlandı, sonra **eklenen parça geri çıkarılıp orijinalle karşılaştırılarak** başka
hiçbir şeyin değişmediği kanıtlandı. Kaldırılan CHECK yerine aynı gücü koruyan
`ec_stock_quantity_floor` tetikleyicisi eklendi: beyan yokken bakiye eksiye düşemez.

**Yakalanan kendi hatam:** ilk yamada `ec_stock_reservations_guard` eski 0012
metninden yeniden yazılmıştı; yürürlükteki 0029 metni web mağaza ayırmalarını **da**
sayıyor. Yani web'in ayırdığı stok pazaryerinden tüketilebilir hale gelmişti. İki
webshop testi bunu yakaladı. Testler gevşetilmedi, yama düzeltildi.

Canlı doğrulama — göç öncesi ve sonrası **birebir aynı**: 37 kart, 519 adet,
36.659,42 TL, 412 hareket, 326 satış. Miktar CHECK'i kalktı, **değer koruması
duruyor**, 11 tetikleyici yerinde, üretim alanı `lp_` hiç değişmedi.
Geri dönüş işareti (göç öncesi):
`00000073-00000000-000050e6-a450eb0f69c84cf2b0c141d6466cadb9`.

## 500 ml çeşit düzeltmesi (kullanıcı bildirdi)

4 Eylül faturasında (TRP2026000001037) 500 ml satırındaki 12 adet yanlışlıkla
"Genel" yazılmış; aslı "Yeşil yapraklı". **Sistem, muhasebeleşmiş faturanın çeşit
dağılımını değiştirmeye izin vermiyor** (split geri alma yalnız `draft` iken).
Seçenekler kullanıcıya sunuldu, stok kartlarını düzeltmeyi seçti.

Uygulanan: yanlış karta yapılan mal kabulü uygulamanın kendi ucundan geri alındı
(−12 adet / −384,00 TL), doğru karta sayımla girildi (+12 adet / +384,00 TL).
`TR-GENEL-500ML` 22→**10** adet, 704,00→**320,00** TL · `TR-YESIL-500ML` −3→**9**
adet, 0→**384,00** TL. Toplam stok miktarı ve değeri değişmedi.

**Kapanmayan fark (bilerek):** fatura satırı hâlâ `TR-GENEL-500ML`'ye bağlı ve o
faturada 12 adet "teslim bekliyor" görünüyor. Bu, seçim öncesi kullanıcıya söylendi.

## Açık kalan tek gerçek eksik

`KL-TS1-210L` **−2 adet** (11 alınmış, 13 satılmış). Maliyeti 0 TL yazıldığı için o
satışların kârı olduğundan yüksek görünür. Eksi bakiye bu boşluğu gizlemiyor,
görünür kılıyor; eksik alış faturası girilince kapanır.

---
# 13 Eylül 2026 turu (tarihsel)

Bu bölüm dosyanın en güncel kaydıdır; aşağıdaki eski bölümler tarihsel kalır.

## Canlıya ne girdi

**Alış belgeleri (3 PDF, 30 fatura sayfası).** Tedarikçilerin "tüm zamanlar" dökümleri
diskteki özgün baytlarıyla okunup panelin kendi parçalı yükleme ucundan gönderildi:
karakuş 21 sayfa, tropikal 6, seçkin 3. Sunucu her belgenin SHA-256 özetini kendisi
doğruladı ve üçü de yerel dosyayla birebir aynı çıktı. Sayfa sayıları, kaynak
metinden çıkarılan sayfa planıyla birebir örtüştü.

**30 sayfa → fatura bağlantısı.** Canlıdaki 30 alış faturası TEKRAR OLUŞTURULMADI
(işlem öncesi ve sonrası sayım 30). Her faturanın özgün PDF sayfası bağlandı:
30 sayfa kaydı, 30 farklı fatura, 0 çelişki. Eşleştirme, PDF metnindeki "Fatura No"
ile canlıdaki invoice_no üzerinden yapıldı; sıra varsayımı kullanılmadı.
Faturalar `draft` kaldı: borç, mal kabul ve ödeme ayrı işlemlerdir.

**TY finans raporu.** 199 satır → 1.791 finans kaydı, 0 inceleme.
Satış 140.669,67 · komisyon −23.557,81 · kargo −21.272,73 · hizmet −1.962,71
· iade/iptal −10.696,58 · diğer −4.028,30 = **79.151,54 TL**, dosyanın kendi
"Net Tutar" toplamıyla kuruşu kuruşuna aynı.

**HB finans raporu.** 67 satır → 396 kayıt + 1 inceleme.
23.534,30 − 4.417,43 − 5.031,79 − 153,29 − 159,66 + 147,70 = **13.919,83 TL**,
yine dosyanın kendi netiyle birebir. İnceleme satırı dosyanın "Toplam" satırıdır;
tutarı olmadığı için mali kayıt olmadı.

## Bu turda kapatılan üç gerçek kusur

1. **Aynı türden ikinci tutar sütunu aktarılamıyordu.** TY dökümünde giden kargo ile
   iade kargosu ayrı sütunlar, indirim/ceza/iptal ise üç ayrı kesinti. "Alan başına tek
   sütun" kuralı bunlardan üçünü dışarıda bırakıyor ve **13.319,88 TL** sessizce
   düşüyordu; rapor kendi net tutarıyla tutmuyordu. Artık eşleşmeyen tutar sütunları
   adıyla soruluyor ve her biri ne olduğuna bağlanıyor (0043 değil, yalnız eşleştirme
   katmanı — göç gerekmedi).
2. **Tarihsiz rapor ekrandan aktarılamıyordu.** Sunucu "işlem tarihi yok" beyanını zaten
   kabul ediyordu ama formda karşılığı yoktu. Her iki pazaryeri raporunda da işlem
   tarihi yok; sipariş tarihini işlem tarihi diye yazmak kaydı yanlışlar.
3. **Eşleşmeyen sütun sorusu hiç görünmüyordu.** Aday seçen süzgeçte bozuk bir kaçış
   dizisi vardı (her karakteri siliyordu) ve yalnız ilk 40 satıra bakıyordu. Seçim
   `report-core`'a taşındı, dosyanın tamamını tarıyor ve testi var.

## Kapanış — satışlar stoğa indi, sayım yapılmadı (14 Eylül 2026)

Kullanıcı bütün satışların KDV oranının **%20** olduğunu bildirdi. Kaynakta oranı bulunmayan
14 paketin 16 satırına bu oran işlendi ve paketler sevk edildi. Oran önce uydurulmadı, soruldu.

**Canlı son durum**

| | |
|---|---|
| Sevk edilen paket | **240** (174 Trendyol + 66 Hepsiburada) |
| Satış kaydı | **282** |
| Alınan / satılan / stokta | 938 / 419 / **519 adet** |
| Stok değeri | **36.659,42 TL** |
| Tedarikçi borcu | 98.521,20 TL (değişmedi; satış borcu etkilemez) |
| Ürün kartı | 37 |

**Defter doğrulaması:** hareketi olan her ürün kartında `alınan − sevk = canlı stok`,
**fark sıfır**. Stok artık gerçekten alış eksi satış; hiçbir sayım kaydı yazılmadı.

**Kalan 3 taslak — kapatılmadı, veri bekliyor:**
- `KL-TS1-210L`: 11 alınmış, 13 satılmış; 2 adet sevk edilemiyor.
- `TR-YESIL-500ML`: hiç alınmamış, 3 adet satılmış. Çeşit dağılımında 500 ml'ye hiç
  "yeşil yapraklar" düşmemişti.

İkisi de ya 17 Şubat öncesi elde stok olduğunu ya da bir alış faturasının eksik olduğunu
gösterir. Tahminle kapatılmadı.

**İptal 68 paket:** 67'si KDV taşımayan köprü taslağı (aynı satışlar kaynak dosyadan yeniden
kuruldu), 1'i ilk deneme paketi. Hiçbiri stok hareketi üretmedi.

**Açık kalan ayar:** şirket ticari unvanı ve vergi numarası hâlâ boş.

## Satışlar stoğa düşürüldü — sayım yapılmadan (14 Eylül 2026)

Kullanıcı fiziksel sayım istemedi: "satışlar elimizde, stok alış eksi satış olmalı".
Haklıydı ve eldeki veri bunu karşıladı. **Hiçbir sayım kaydı yazılmadı.**

**Stok başlangıç tarihi: 2026-02-17.** Köprü, bu tarih girilmeden geçmiş siparişi bugünkü
stoktan düşmüyor. Tarih ilk alış faturasının günüdür — stoğun fiilen var olmaya başladığı gün.
Uydurulmadı.

**Trendyol.** Köprüde aday paket yoktu: TY raporu finans olayı taşır, ürün satırı değil.
Satırlar hazırlanmış fatura çıkarımından alındı. 193 faturanın **177'si** sipariş olarak
açıldı (189 satır). 16 fatura dışarıda kaldı: 9 satırda bileşen eşleşmesi, 8 satırda ilan
barkodu yok. KDV oranı 189 satırın 172'sinde dosyadan okundu; 17 satırda yok ve **uydurulmadı**.

**Hepsiburada — iki engel, iki dürüst düzeltme.**
1. Köprü her satırda sağlayıcı kalem kimliği şart koşuyordu. O alan bilerek eşlenmemişti
   (sipariş içi sıra numarası; eşlenirse 73 satır 7 kayda çöker). Sessiz geri düşüş
   eklenmedi — kimliksiz satırın incelemede kalması testi olan bilinçli bir kural.
   Bunun yerine **beyana bağlı** istisna eklendi: çağrı açıkça beyan ederse kimlik paket
   numarası + stok kodundan türetilir. Testi yazıldı; eski test aynen korundu ve geçiyor.
2. Sonra ikinci engel çıktı: sipariş şemasında **KDV alanı hiç yoktu**, satır neti
   hesaplanamadığı için sevk engelleniyordu. Şemaya satır bazlı KDV oranı alanı eklendi
   (tek profil seçeneği yanlış olurdu: HB dosyasında %10 ve %20 birlikte). Bu değişiklik
   zaten aktarılmış kayıtları düzeltmediği için köprüden açılan 67 taslak **gerekçesiyle
   iptal edildi** ve aynı satışlar kaynak dosyadan, satır bazlı KDV ile doğrudan kuruldu:
   67 paket, 73 satır, hepsi tam fiyatlı.

**Sevkiyat.** Stok yalnızca gönderim adımında düşer; taslak ve rezervasyon hareket yazmaz.
**226 paket** rezerve edilip sevk edildi (160 TY + 66 HB) ve **257 satış kaydı** oluştu.

**Doğrulama — defter birebir tutuyor.** 35 ürünün **35'inde** `alınan − sevk = canlı stok`,
fark **sıfır**. Toplam 938 adet alınmış, 383 adet satılmış, **555 adet** stokta.
Stok değeri 82.101,00 → **38.868,99 TL**. Tedarikçi borcu 98.521,20 TL değişmedi
(satış borcu etkilemez).

**Kalan 17 taslak, kapatılmadı:** 14'ü Trendyol, kaynakta KDV oranı olmadığı için tutar
hesaplanamıyor; 3'ü gerçek stok açığı. 68 paket iptal (67 KDV'siz köprü taslağı + 1 ilk deneme).

**İki gerçek açık, görünür bırakıldı:**
- `KL-TS1-210L`: 11 alınmış, 11 sevk edilmiş, 2 adet daha sevk bekliyor (TY'de 13 satılmış).
  Ya 17 Şubat öncesi elde stok vardı ya da bir alış faturası eksik.
- `TR-YESIL-500ML`: hiç alınmamış ama 3 adet sevk bekliyor. Kullanıcının çeşit dağılımında
  500 ml'ye hiç "yeşil yapraklar" düşmemişti; ya dağılım bu satırda eksik ya da alış eksik.

Testler 416/416. Dağıtımlar: 39d4d39b (köprü beyanı), dc1de430 (satır bazlı KDV).

## Alış zinciri tamamlandı — 30/30 (14 Eylül 2026)

Kullanıcı çeşit dağılımını doldurdu; kalan 11 Tropikal satırı da açıldı ve **30 faturanın
30'u** borca ve mal kabulüne geçti.

**Çeşit dağılımı.** Kullanıcıya iki sayfalı bir çalışma kitabı verildi; 11 satırın çeşit
kırılımını kendisi yazdı. 11 satırın 11'inde de çeşitlerin toplamı satır toplamıyla tuttu.
Tek çeşitli 3 satır doğrudan eşlendi (bölme ucu en az iki çeşit istiyor); kalan 8 satır
çeşit dağılımıyla bölündü ve 23 yeni satıra dönüştü. Net tutar ve KDV adetlere kuruş kuruş
orantılı dağıtıldı; toplam tutmazsa veritabanı `SPLIT_TOTAL` ile zaten reddediyor.

Dağılımda kartı olmayan iki kombinasyon çıktı ve açıldı: `TR-CICEK-500ML`,
`TR-KAKTUS-1000ML`. Daha önce `SAB-SUBSTRATE` açılmıştı (kullanıcı tane boylarını
ayırmak istemedi; 250 L ve 80 L torbalar aynı kartta "adet" olarak toplanıyor).

**Çeşit doğrulaması.** 15 besin kartının 15'inde canlı adet, kullanıcının verdiği dağılımla
birebir aynı — tek fark yok. Örnek: 225 ml genel 90 · orkide 70 · yeşil 30 · çiçek 10 ·
kaktüs 10 · menekşe 30 = 240.

**İki mutabakat, ikisi de sıfır farkla:**
- Borç: fatura net 82.101,00 + KDV 16.420,20 = **98.521,20 TL**; tedarikçi borcu
  98.521,20 TL (Karakuş 47.611,20 · Tropikal 30.750,00 · Seçkin 20.160,00). Fark 0,00.
  Bu rakam, paketin beyan ettiği "30 fatura / 98.521,20 TL" ile aynıdır.
- Maliyet: mal kabul değeri 82.101,00 TL; stok değeri 82.101,00 TL. Fark 0,00.

**Canlı durum:** 30 fatura posted, 86 alış satırı (23'ü çeşit bölmesinden), 86 stok hareketi
ve **hepsi `purchase` türünde** — beklenmedik hareket yok. 34 kartta stok. Satış kaydı 0,
sipariş paketi 0: rapor ve belge aktarımı hâlâ mali kayıt üretmiyor.

**Kalan tek şey: fiili sayım.** Çalışma kitabının "2 Stok sayimi" sayfası boş geldi.
Sayım gelmeden açılış ya da sayım düzeltmesi YAZILMADI. Sayım yazıldığında, alınan mal ile
bugün elde olan arasındaki fark Şubat–Haziran satışlarını temsil edecek ve **sayım
düzeltmesi olarak görünür** kalacak; o dönemin satış verisi elimizde olmadığı için
tahminle kapatılmayacak.

## Alış zinciri yürütüldü — 14 Eylül 2026

Kullanıcı ürün kimliği sorularını cevapladı; 24 bekleyen satırın 13'ü açıldı.

**Eşleştirme.** Klasmann "REC876 TS1 Fine 200 L" = `KL-TS1-210L`, Gartengold "80 L Genel
Kullanım Torfu" = `GG-TORF-COCO-80L` (ikisi de kullanıcı onayı). SAB Substrate için **tek**
yeni kart açıldı (`SAB-SUBSTRATE`); kullanıcı tane boylarının ayrılmasını istemedi, bu yüzden
250 L ve 80 L torbalar aynı kartta "adet" olarak toplanıyor — 1 adet bazen 250 L, bazen 80 L.
10 fatura / 13 satır eşlendi.

**Borca yazma.** 25 fatura `posted`, 0 hata. Borç yazıldıktan sonra stok hareketi sayısı
hâlâ 0 idi: muhasebeleştirme stok oluşturmuyor, stok yalnız mal kabulünden geliyor.

**Mal kabul.** 25 faturanın 44 ürün satırı, 253 adet. Stok 12 kartta oluştu.
Maliyet mutabakatı: mal kabulü yapılan satırların net toplamı 58.276,00 TL,
stok değeri 58.276,00 TL — **fark 0,00**.

**Tedarikçi borcu.** Karakuş 47.611,20 + Seçkin 20.160,00 + Tropikal 2.160,00 = 69.931,20 TL.

**HB ilanları.** Eşleşmeyen 4 ilan bağlandı: `HBCV0000DSXM6Q` → GG-TORF-5L;
`HBCV000007EJ04`, `HBV0000135Y1R`, `HBCV00006H2QMB` → TR-GENEL-1000ML (kullanıcı üçünün de
aynı ürünün ayrı ilanları olduğunu bildirdi). Canlı katalog 67 eşleştirme (51 TY + 16 HB).

**Kalan.** 5 Tropikal faturası `draft`: içlerinde çeşidi bilinmeyen 11 besin satırı var
(225 ml 240 adet, 500 ml 60, 1000 ml 110 = 410 adet). `UNMAPPED_INVOICE` kuralı bu faturaları
zaten muhasebeleştirmiyor. Çeşit dağılımı ve bugünkü fiili sayım kullanıcıdan bekleniyor.
Sayım farkı Şubat–Haziran satışlarını temsil edecek ve **sayım düzeltmesi olarak görünür**
kalacak; o dönemin satış verisi elimizde olmadığı için uydurulmayacak.

## Doğrulama sonuçları (canlı, aktarım sonrası)

**Mükerrer kontrolü — iki düzeyde kapalı.**
- Dosya düzeyi: aynı CSV ikinci kez yüklendi, panel "Bu dosya bu mağazaya daha önce
  yüklendi; ikinci kez işlenmez." dedi. Dosya sayısı 5 → 5, kayıt 2.260 → 2.260, değişmedi.
- Kayıt düzeyi: uygulanmış her dosya için önizleme yeniden çalıştırıldı; 1791, 396, 2, 12
  ve 59 kaydın **tamamı "aynı (tekrar)"** döndü, yeni 0. Örtüşen dönemli üç CSV dahil.

**Kuruş mutabakatı — sunucunun sakladığı satırlardan yeniden hesaplandı.**
- TY: satış 140.669,67 · komisyon −23.557,81 · kargo −21.117,73 · net hakediş 79.151,54
- HB: satış 23.534,30 · komisyon −4.417,43 · kargo −5.031,79 · net hakediş 13.919,83
- CSV brüt: 480,00 + 4.138,40 + 19.580,90 = 24.199,30
Not: yukarıdaki "kargo" alan toplamıdır; iade kargosunu da içeren olay toplamı −21.272,73'tür.

**Günlük kullanım akışı.** Fatura belgeleri: 19 satış belgesi / 193 sayfa, 3 alış belgesi /
30 sayfa. Alış faturaları: 30 (taslak). Rapor Kutusu: 5 dosya, 2 mağaza, 3 profil.
İnceleme sekmesinde 1 açık kayıt var ve karar verilebilir durumda.

**Mali etki yok.** Sipariş paketi 0, sipariş satırı 0, rezervasyon 0, ürün 34.
Rapor ve belge aktarımı stok hareketi, satış kaydı ya da fatura oluşturmadı.

## Geri dönüş noktası

Aktarım sonrası D1 kurtarma noktası (zaman yolculuğu işareti):
`0000005f-00000000-000050e5-aa5a397baace456759be91763c261d37`

Geri almak gerekirse `scripts/recovery.mjs` ile plan çıkarılır ve açık onayla uygulanır
(7 günlük ücretsiz pencere). Uygulama kodu geri alınmaz; yalnız veri geri sarılır.

## Kurallara uyum

- Oturum güvenliği atlatılmadı, sahte oturum üretilmedi, veritabanına doğrudan yazılmadı.
  Her şey panelin kendi kimlik doğrulamalı uçlarından geçti.
- Dosyalar elle base64'e çevrilmedi; diskten özgün baytlarıyla okundu.
- Canlıdaki 30 alış faturası ve 19 satış belgesi çoğaltılmadı.
- Tarih uydurulmadı; belirsiz satır incelemede bırakıldı.
- Özel belgeler ve müşteri verisi Git'e gönderilmedi.

**HB sipariş detayı (3 CSV).** 2 + 12 + 59 = **73 sipariş kalemi**, 0 sorun.
Brüt satış 480,00 + 4.138,40 + 19.580,90 = **24.199,30 TL**. Üç dosyanın dönemleri
örtüşüyor ama tek bir kalem bile iki kez sayılmadı: 73 satır 73 ayrı anahtar üretti,
çakışan anahtar 0. Birinci dosyadan sonra eşleştirme bir daha sorulmadı; başlık imzası
aynı olduğu için kayıtlı profil kendiliğinden kullanıldı.

İki eşleştirme kararı, veri kaybını önlemek için bilerek boş bırakıldı:
- **line_id** ("Kalem Numarası") bağlanmadı: sipariş içi sıra numarasıdır (10, 20, 30),
  evrensel kimlik değildir. Bağlansaydı 73 satır **7 kayda** çökerdi.
- **barcode** ("Barkod") bağlanmadı: HB'de bu kargo takip numarasıdır, ürün kimliği değil.
  Ürün kimliği "Satıcı Stok Kodu"dur. Bağlansaydı 73 satır 67'ye düşer, 11 sorun çıkardı.
- HB finansındaki başlıksız "Sütun 13" de bağlanmadı: 66 satırın 66'sında komisyonla
  birebir aynı; bağlansaydı komisyon iki kez düşülürdü.

## Kalan gerçek belirsizlikler (uydurulmadı, görünür bırakıldı)

- **Stok açılış tarihi ve sayımı bilinmiyor.** Bu yüzden hiçbir stok hareketi yazılmadı;
  canlıda stok, satış kaydı ve sipariş paketi 0 kaldı. Rapor kayıtları mali kayıt değildir.
- **Tropikal'in 11 satırında çeşit dağılımı belirsiz**; kesin fiziksel stok/maliyet yazılmadı.
- **13 ürün kimliği ve 4 HB ilanı (23 adet)** hâlâ eşleşmemiş durumda.
- **Her iki finans raporunda işlem tarihi yok.** Kayıtlar "tarihi bilinmeyen" olarak
  saklandı; sipariş tarihi işlem tarihi sayılmadı.
- **Dönem kapsamı:** satış raporları Temmuz–12 Eylül'ü kapsıyor, alışlar Şubat'a uzanıyor.
  Şubat–Haziran satışları elimizde yok; sıfır varsayılmadı.
- Eşleştirmeler "gerçek raporla doğrulandı" diye **işaretlenmedi**: o işaret pazaryeri
  ekranındaki toplamlarla karşılaştırma beyanıdır; karşılaştırma dosyanın kendi net
  tutarıyla yapıldı. İşaretlemek kullanıcıya bırakıldı.

---

# Devam belgesi — tek yetkili güncel durum

Bu dosya deponun **tek yetkili devam belgesidir**. Her iş, kodla **aynı committe** burayı da günceller.
Depo dışındaki eski başlangıç notları (`Desktop/site/CLAUDE-*.md`) tarihseldir; çelişki olursa **bu dosya geçerlidir**.
Sohbet geçmişine güvenilmez.

Son güncelleme: 13 Eylül 2026 (fatura belgeleri ekranı bağlandı)

## 13 Eylül 2026 — "Fatura belgeleri" ekranı: sunucu ucu artık kullanıcıya açık (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Kapatılan boşluk
Satış belgesi uçları vardı ama `public/` altında onları çağıran hiçbir şey yoktu; "satış arşivine
yükle" talimatı **var olmayan bir ekranı** işaret ediyordu. Aynı boşluk alış tarafındaki sayfa
bağlantısı ucunu da erişilemez bırakmıştı: mevcut 30 taslak, geldikleri birleşik PDF'in sayfalarına
bağlanamıyordu. Sunucu ucu yazmak ekran yapmak değildir.

Yeni ekran `public/sales-document-ui.js`, menüde **Fatura belgeleri** (`#documents`), iki sekme:
- **Satış faturaları** — çoklu dosya seçimi, dosya başına pazaryeri, türev aralığı, ilerleme ve sonuç;
  arşiv listesi ve sayfa görünümü.
- **Alış sayfa bağlantısı** — belge seçilir, sayfa no + fatura seçilerek bağlanır. Dolu sayfaya ikinci
  fatura ya da bağlı faturayı başka sayfaya bağlamak reddedilir.

Dosya seçici **görünür ve etiketli**; gizli input'a bağlı otomasyon beklenmiyor. Baytlar
`File.arrayBuffer` ile okunur, elle base64 üretilmez, mevcut parçalı yükleme ve sunucu tarafı
SHA-256 mühürlemesi korunur: ulaşan dosya seçilen dosya değilse mühürlenmez.

**Türev dosyalar.** 20 MB sınırı için bölünen PDF, adından tanınır (`parca2(sayfa23-43)`) ve özgün
dosya adı + sayfa aralığı ayrıca saklanır. Türev kendi baytlarıyla doğrulanır; özgün dosyayla aynı
özete sahip olması **beklenmez**.

### Yetki: yeni anahtar İCAT EDİLMEDİ
Yeni ekran için yeni bir yetki açmak, kayıtlı personel yetkilerinde o anahtar bulunmadığı için
**herkesi dışarıda bırakırdı** — ekran yapılmış ama erişilemez olurdu. Bunun yerine rota mevcut
`invoices` yetkisine eşlendi (`routeKey` artık gerçek eşleme yapıyor; daha önce kimliği
döndüren ölü koddu). Sunucuda da `/api/ec/sales/documents` fatura yetkisine bağlandı:
satış **kaydı** yetkisi, belge **arşivi** yetkisi değildir.

Doğrudan sınandı: `/api/ec/sales` satışçıya izin / faturacıya 403 · `/api/ec/sales/documents`
faturacıya izin / satışçıya 403 · `/api/ec/invoices/documents` faturacıya izin / satışçıya 403.

**Bu turda yakalanan kendi regresyonum:** yama `sales` girdisini eklemek yerine değiştirmişti;
`/api/ec/sales` yetki bulamayıp reddediliyordu. Geri kondu ve yukarıdaki sınamayla doğrulandı.

### Düzeltilen sayım hatası
Satış PDF klasörü fiilen **11 türev + 9 tekil = 20 dosya, 19 farklı hash**. İki `prod_…ce0c2893`
dosyası bayt bayt aynı: tek fatura, ikinci satış sayılmaz. Önceki "8 tekil + 12 parça" ifadesi yanlıştı.
Sayfa sayıları aralıklarla birebir: 22+21+21+21+12=97, 20+20+20+6=66, 20+2=22.

### Testler ve depo
**408/408** (4 yeni test: rota→yetki eşlemesi, satış belgesi ucunun iki yönlü yetki sınaması, türev
ayrıştırması), `npm run build` temiz. Servis çalışanı önbellek anahtarı `v38-belgeler` yapıldı,
yoksa mevcut kullanıcılara eski kabuk servis edilirdi.
Önceki dört commit GitHub'a gönderildi (`b539d60..c13724f`); yalnız kod ve devam belgesi,
özel belge/veri gönderilmedi.

### Kalan
Rapor dosyaları ve PDF'ler hâlâ canlıya taşınmadı. Ekranlar artık hazır; dosya seçimi kullanıcıda.
Canlı sayılar bu turda değişmedi: rapor dosyası 0, rapor kaydı 0, alış belgesi 0, sayfa bağlantısı 0,
satış belgesi 0, sipariş 0, stok hareketi 0.

---

## 13 Eylül 2026 — Sevk yarışı kapatıldı, sayfa bağlantısı geldi, katalog canlıya yazıldı (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Kod: dört inceleme bulgusu + üç yapısal eksik kapatıldı
- **Sevk yarışı (P1).** Önceki koruma siparişin KENDİ saklı özetini kendisiyle karşılaştırıyordu;
  rapor yeniden yüklenince bu alan değişmediği için koşul her zaman tutuyordu, yani koruma boştu.
  Artık bağlı rapor kaydının içeriği değiştiği anda tetikleyici siparişi `source_changed` işaretliyor,
  mevcut geçiş tetikleyicisi rezervasyon ve sevki ABORT ediyor. Sevk tek işlem olduğu için satış
  satırları ve stok çıkışı da birlikte geri alınıyor; uygulama 409 dönüyor.
- **NULL bağlantı (P2).** Bağlılık artık özet sütunundan değil rapor kayıtlarından belirleniyor.
  Bağlı ama özeti olmayan paket "aynı" sayılmıyor, incelemeye düşüyor. `report_linked` bayrağı
  sayesinde rapora bağlı OLMAYAN sipariş sıfır ek sorgu harcıyor (20 bileşenli sevk D1 bütçesinde kalıyor).
- **Parti sayacı (P2).** `pending_lines` artık faturaların veritabanındaki gerçek durumundan okunuyor;
  aynı dosya yeniden yüklendiğinde çözülmemiş satırlar 0 görünmüyor, kullanıcı eşleştirince gerçekten azalıyor.
- **Sayfa düzeyinde belge bağlantısı (YENİ, 0042).** Bir belge birden çok faturayı içerebiliyor.
  Karakuş'un 21 faturası tek PDF'te; eski bire bir `invoice_id` alanı bunu karşılamıyordu ve
  sayfa bilgisi yalnızca not alanında metin olarak kalıyordu.
- **Satış belgesi arşivi (YENİ, 0042).** Pazaryeri satış faturaları kendi tablosunda; sipariş paketine
  bağlanıyor. Boyut sınırı nedeniyle bölünerek yüklenen dosyada ÖZGÜN sayfa aralığı saklanıyor.
- **Tarihsiz finans (YENİ).** HB finans dökümünde işlem tarihi sütunu YOK. Sipariş tarihini ya da dosya
  adındaki aralığı işlem tarihi saymak veri uydurmaktır; profil bunu açıkça beyan ederse `event_date`
  boş kalıyor. Beyan etmeden zorunlu alan atlanamıyor, beyanla birlikte tarih sütunu eşlenemiyor.
- **Komisyon oranı (YENİ).** HB komisyon hücresi tutarı ve oranı birlikte veriyor. Tutar, oran ve ham
  metin AYRI alanlarda tutuluyor; oran ikinci bir kesinti olarak toplanmıyor.

Testler: **404/404** (7 yeni test), `npm run build` temiz.
Commitler: 2c204c2 (yarış + sayaç), d0aff6e (sayfa bağlantısı + tarihsiz finans), 1b852e7 (gövde sınırı).

### Canlı: yayınlandı ve katalog yazıldı
Yayın öncesi tam D1 yedeği alındı (depo dışında) ve geri dönüş işareti kaydedildi:
0000003a-00000012-000050e5-029413ec465b6bfcc8e99c2fd68b9a7d.
Migration **0041 + 0042** uygulandı ve doğrulandı. Dağıtım **587c7ad3-a06d-46ae-9822-fc15d62e2974**
(öncesi 48b3d3ce). Kontrol: /eticaret 200 · /uretim 200 · **/magaza 404 (kapalı kaldı)**.

| Ölçüm | Önce | Sonra |
|---|---:|---:|
| Ürün kartı | 32 | **34** |
| İlan bağlantısı (TY / HB) | 51 / 0 | **51 / 12** |
| Rapor mağazası | 0 | **2** |
| Alış faturası (taslak) | 30 | 30 |
| Rapor dosyası · sipariş · stok · satış | 0 | **0** |

Açılan kartlar: TR-ORKIDE-1000ML, TR-YESIL-500ML. Bağlanan 12 HB ilanı 97 satılan adedin **74'ünü**
kapsıyor. Kimliği belirsiz 4 ilan (23 adet) **bilerek bağlanmadı**: HBCV0000DSXM6Q, HBCV000007EJ04,
HBV0000135Y1R, HBCV00006H2QMB.

### Yerel prova: aktarımın tamamı gerçek uçlardan geçirildi (CANLI DEĞİL)
Bellek içi veritabanında canlı durum baştan kuruldu ve her adım gerçek API uçlarından geçti:
30 fatura / 71 satır / **98.521,20 TL**, **30/30 sayfa bağlantısı** (sıfır çelişki),
TY 1194 finans kaydı, HB 462 kayıt + 1 inceleme (yalnız "Toplam" satırı), HB detay 73 kayıt,
8 satış belgesi. Mutabakat kaynakla birebir: **TY 140.669,67 TL**, **HB 23.534,30 TL**.
Stok hareketi 0, satış 0, sipariş 0 — hiçbir mali kayıt yazılmadı. Bu sonuçlar canlı aktarım DEĞİLDİR.

### YAPILAMAYAN: rapor ve PDF dosyalarının canlıya taşınması
Tarayıcı aracı, sayfaya sonradan eklenen ya da gizli `input[type=file]` öğelerini erişilebilirlik
ağacında göstermiyor ve `file_upload` bir ref istiyor; Rapor Kutusu'nun sürükle-bırak girdisi de
gizli olduğu için hedeflenemedi. Baytları koda gömme yolu denendi ve **ikili dosyada bayt bozulması**
saptandı (10.066 bayt, aynı boyut, SHA 688d2e37 yerine 3e1bc851 olmalıydı). Bozuk belge arşive
ALINMADI. Parçalı gömme (8.000 karakter) doğrulandı ama 73 MB'lık PDF arşivi için uygun değil.

Dosyalar kullanıcı için tek klasörde hazırlandı: **C:/Users/baran/Desktop/LUNAPOT-YUKLE**
(1-rapor-kutusu 5 dosya, 2-alis-pdf 3 dosya, 3-satis-pdf 20 dosya, yönerge OKU-BENI.txt).

### Profil tuzakları (yükleme sırasında sihirbaz sorarsa)
- HB sipariş raporunda ürün kimliği **Satıcı Stok Kodu**; `Barkod` sütunu kargo takip numarasıdır.
- `Kalem Numarası` sipariş içi sıra numarasıdır; kalem kimliği olarak eşlenirse 73 satır 7 kayda çöker.
- HB finansında komisyon `Komisyon (KDV dahil)` sütunundan alınır; başlıksız son sütun aynı tutarın
  kopyasıdır ve eklenirse komisyon iki kez sayılır.

---
## 13 Eylül 2026 — Katalog ve 30 alış faturası CANLIYA aktarıldı (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Aktarım: uygulandı (canlı, kullanıcının yetkili oturumuyla, ekranlardan)
Kullanıcı panele girdi; aktarım gerçek ekranlardan yapıldı (Ürünler ve stok → "Katalog dosyası yükle",
Alış faturaları → "Hazır kayıt dosyası yükle"). Her adımda önce ön kontrol çalıştırıldı.

| Ölçüm | Önce | Sonra |
|---|---:|---:|
| Ürün kartı | 1 | **33** (32 yeni) |
| İlan bağlantısı | 0 | **51** |
| Çeşit ailesi (üye) | 0 | **3** (12 üye) |
| Tedarikçi | 0 | **3** |
| Alış faturası (hepsi taslak) | 0 | **30** |
| Fatura satırı | 0 | **71** |
| Fatura tutarı | 0 | **98.521,20 TL** |
| Stok hareketi | 0 | **0** |
| Cari borç kaydı | 0 | **0** |

**Tutar mutabakatı kaynakla birebir:** 9.852.120 kuruş. Tedarikçi kırılımı:
Karakuş 21 fatura / 40 satır / 47.611,20 TL · Tropikal 6 / 28 / 30.750,00 TL · Seçkin 3 / 3 / 20.160,00 TL.
Satır eşleşmesi: **47 satır ürüne bağlandı, 24 satır incelemede.**

**Stok ve borç bilerek 0:** taslak aşaması mali kayıt yazmaz. Borç "Muhasebeleştir", stok "Mal teslimi" ile oluşur.

### Mükerrer kontrolü canlıda kanıtlandı
Aynı dosya aynı özetle (`880a126a…`) ikinci kez uygulandı: **HTTP 200, deneme no 2, 0 yeni / 30 atlandı.**
Fatura 30'da kaldı, tutar değişmedi, parti sayaçları **birikmedi** (created:30, review:0, pending_lines:24).

### İnceleme kuyruğunda bekleyenler (uydurulmadı)
- **11 satır Tropikal çeşit dağılımı** — 410 adet / 14.424 TL (225 ml, 500 ml, 1000 ml). Her faturada ayrı girilecek.
- **13 satır ürün kimliği belirsiz** — 29 adet / 28.428 TL: Gartengold 80 L torf, Klasmann REC876 200 L (katalog 210 L),
  SAB Substrate 0–10 / 0–40 / 0–20 mm torfları.
- **Katalogda 8 ilan bekliyor:** hacmi yazmayan yaprak parlatıcı, 70 L torfun modeli (P/H), hacmi belirsiz yeşil
  yaprak besini, 5'li set şişe hacimleri, farklı markalı 500 ml temizleyici, çiçek vitamin seti, bitki besini+ilaç paketi.
- Karma setlerde gelir dağılımı **yönetimsel** (fiziksel adet oranında); gerçek tekli satış fiyatı değildir.

### Codex ikinci incelemesi (aynı turda)
Dört bulgu kapatıldı: kaynak denetimi stok eylemine taşındı, iptal sonrası sevk engellendi, parmak izine
ürün kimliği eklendi, önizleme salt okunur yapıldı. Ayrıca kendi kusurum düzeltildi: parti sayaçları
birikiyordu → parti = güncel durum, denemeler = append-only `import_attempts`.
Migration **0039 + 0040** canlıda. Dağıtım **4cbee44c-7c89-47ec-8f06-0b8b9bbed243**.

### Testler
`remaining.test.mjs` 4/4 · `review.test.mjs` 7/7 · tam panel **398/398** · build temiz.

### Sırada (YAPILMADI)
- 265 TY/HB finans özeti, 73 HB paket detayı, 193 TY satış faturası aktarımı.
- HB para hücresi (`-54.12 TL (%19.54)`) profil entegrasyonu; tarihsiz HB finansı `event_date=null`.
- Faturaların özgün PDF/sayfa bağlantısı; tek birleşik inceleme kuyruğu ekranı.
- Stok başlangıç tarihi ve açılış sayımı **hâlâ girilmedi** → geçmiş siparişler stoğa uygulanamaz.
- Canlıda "qwewqe" adlı eski deneme ürünü duruyor; kullanıcı kararı bekliyor (silinmedi).

---

## 13 Eylül 2026 — Codex ikinci incelemesi: dört bulgu + sayaç kusuru (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Düzeltilen dört bulgu (remaining.test.mjs: önce 0/4, şimdi **4/4**)
1. **Önizleme açılmadan rezervasyon engellenmiyordu.** Kaynak güncelliği denetimi artık
   `plan()` içinde değil, **stok eyleminin kendisinde**: `src/report-link-guard.js`
   rezervasyon ve gönderimden önce zorunlu çalışıyor. Koruma isteğe bağlı ekran ziyaretine bağlı değil.
2. **Rezerve edilip sonra iptal gelen paket sevk edilebiliyordu.** Artık ship de aynı denetimden
   geçiyor: 409, stok 20000'de kalıyor, satış kaydı oluşmuyor.
3. **Ürün kimliği değişimi fark edilmiyordu.** Parmak izi sürümlendi (`v2:`) ve kapsamına
   **barkod + satıcı stok kodu** eklendi. Aynı adet/tutar artık aynı ürün sayılmıyor.
4. **Önizleme veri yazıyordu.** `plan()` içindeki UPDATE kaldırıldı; önizleme **salt okunur**
   (test: total_changes farkı 0). Engel yazmaya değil, stok eylemindeki denetime bağlı.

**Atomiklik:** rezervasyon ve gönderim UPDATE'leri okunan `report_link_hash` değerine koşullu
(`WHERE id=? AND report_link_hash IS ?` + RETURNING). Satır güncellenmezse işlem 409 ile durur.

### Kendi kusurum: parti sayaçları birikiyordu
`counts_json` her denemede TOPLANIYORDU; yeniden denemede eski "inceleme" sayısı birikip dosyanın
satır sayısını aşabiliyordu. Artık:
- `import_batches.counts_json` = **dosyanın güncel satır durumu** (son tam değerlendirme),
- `ec_import_attempts` = **append-only deneme geçmişi** (actor, başlangıç, bitiş, sonuç; silinemez/değiştirilemez).

### Eski NULL içerik özetleri
Rapor bağlantısında özet **yoksa** artık "aynı" sayılmıyor; `changed` olarak incelemeye alınıyor.

### Migrationlar
- `0039_order_report_link.sql` — `ec_order_packages.report_link_hash` (+kısmi indeks). Salt ekleme.
- `0040_import_attempts.sql` — `ec/lp_import_attempts` append-only deneme tablosu.
- `tests/orders.test.js` sabit migration listesine 0039 eklendi (o dosya 0001–0012'yi elle yüklüyor).

### Testler
Codex `remaining.test.mjs` **4/4** · Codex `review.test.mjs` **7/7** · tam panel **398/398**
(5 yeni: 4 köprü entegrasyon + 1 deneme geçmişi) · `npm run build` başarılı. Beklentiler gevşetilmedi.
Yeni `tests/report-link-guard.test.js` **gerçek dosya yükleme yolundan** (xlsx → dosya → parça →
satır → mühür → uygula) geçiyor ve önizlemeyi hiç açmıyor.

### Canlı durum
- Migration **0039 + 0040 uygulandı ve doğrulandı**; mevcut veri etkilenmedi.
- Dağıtım sürümü **4cbee44c-7c89-47ec-8f06-0b8b9bbed243**.
- Kontrol: /eticaret 200 · /uretim 200 · /magaza **404** · oturumsuz API **401**.
- Yedek: tam D1 dışa aktarımı (depo dışında, 185 KB) · geri dönüş noktası
  `0000002e-00000000-000050e4-20dad41c94f48d88d2e4cc6cc2c37fde`.
- **CANLI KAYIT SAYILARI DEĞİŞMEDİ: ürün 1, alış faturası 0, rapor 0, sipariş 0, stok hareketi 0.**
  Gerçek veri aktarımı YAPILMADI.

### Tedarikçi unvanları çözüldü (kullanıcıya tekrar sorulmayacak)
Codex özgün PDF'lerden pypdf ile çıkardı; `supplier-names.json` + `supplier-evidence.json`
(dosya yolu, SHA-256, sayfa). Benim okuyucumun textLayer=false sonucu dosyanın metinsiz olduğunu
kanıtlamıyormuş — bu çıkarımım yanlıştı. Unvanlar Git'e konmadı; aktarım sırasında yük ile taşınır.

### Sırada (bu turda YAPILMADI)
- HB para hücresi (`-54.12 TL (%19.54)`) profil entegrasyonu: tutar, oran ve ham hücre ayrı.
  Yardımcı kod hazır ve doğrulandı (3 test + 66 gerçek hücre), **panele bağlanmadı**.
- Tarihsiz HB finansının `event_date=null` sipariş finans özeti olarak saklanması.
- 265 TY/HB özeti, 73 HB detayı, 193 TY satış faturası aktarımı; PDF/sayfa bağlantısı; tek inceleme kuyruğu.
- Gerçek kayıtların canlıya aktarımı: **kimlik doğrulamalı oturum gerekiyor**.

---

## 12 Eylül 2026 — Codex'in dört bulgusu düzeltildi + stok başlangıç tarihi (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Düzeltilen dört bulgu (Codex review.test.mjs: önce 2/7, şimdi **7/7**)
1. **P1 — Rapor güncellenince eski taslakla stok çıkışı yapılabiliyordu.** Bağlantı anındaki paket
   parmak izi (`import_items.content_hash`) saklanıyor. Sonraki okumada içerik değişmişse ya da
   rapor paketi iptal/iade gösteriyorsa köprü artık `existing` demiyor: `changed` diyor,
   `ec_order_packages.source_changed=1` işaretliyor ve mevcut tetik rezervasyon/gönderimi 409 ile
   durduruyor. Kanıt: adet 2→3 değişiminde reserve 409, stok 20000'de kaldı (eskiden 8 şişe düşüyordu).
   Rezerve/gönderilmiş sipariş sessizce yeniden yazılmıyor.
2. **P1 — Aynı dosyada eksik tedarikçi tamamlanınca 409 ve eksik denetim.** Dosya kaydı ile işleme
   denemesi ayrıldı: aynı SHA için yeni parti açılmıyor, **mevcut parti sürdürülüyor** ve her denemenin
   sonucu denetime ekleniyor. Kanıt: ikinci deneme 200, 1 created + 1 skipped, **2 fatura + 2 denetim kaydı**.
3. **P1 — Tutar yetkisi olmayan çalışan köprü önizlemesinden tutarı okuyabiliyordu.** `gross` ve
   `net_revenue` merkezî maskelemeye eklendi; `amounts:none` çalışan için artık `null` dönüyor.
4. **P2 — Aynı fatura kimliğinde farklı içerik sessizce atlanıyordu.** Kanonik içerik özeti
   (tarih, para birimi, toplamlar, sıralı satırlar) saklanıyor. Aynı kimlik + aynı içerik atlanır;
   aynı kimlik + **farklı içerik incelemeye** alınır, tutar sessizce üzerine yazılmaz.

Kendi eski testimdeki "aynı dosya 409 döner" beklentisi bu düzeltmenin tersiydi; düzeltilmiş sözleşmeye
güncellendi (mükerrer koruması aynı testte hâlâ doğrulanıyor: fatura sayısı artmıyor).

### Stok başlangıç tarihi
- `POST /api/{ns}/settings` artık `inventory_start_date` kabul ediyor. **Tarih uydurulmaz:**
  boş bırakılabilir, geçersiz veya **gelecek tarih reddedilir** (400).
- Ekran: **Şirket ve yedek** → "Stok başlangıç tarihi". Açılış miktarları için
  **Ürünler ve stok → "Stok / sayım gir"** kullanılıyor (mevcut ve test edilmiş akış).
- Tarih girilmeden bu tarihten önceki pazaryeri siparişleri bugünkü stoktan **düşülmüyor**
  (köprü `blocked`/`historical` diyor).

### Canlı durum
- **Migration 0038** (`content_hash`) canlıya uygulandı ve doğrulandı: ec+lp sütunları, migration kaydı.
  Mevcut kayıtlara dokunulmadı (0 fatura, 0 stok hareketi).
- Uygulama öncesi **tam D1 yedeği** alındı (depo dışında) · geri dönüş noktası
  `0000002b-00000000-000050e4-5d8dbbae3fff71138f0fbabdb417b81b`.
- **GERÇEK KAYITLAR CANLIYA HÂLÂ AKTARILMADI.** Aşağıdaki sayılar yerel provadandır.

### Testler
Codex `review.test.mjs` **7/7** · tam panel paketi **393/393** (2 yeni) · `npm run build` başarılı.
Test beklentileri gevşetilmedi.

### Yerel prova (bellek içi test veritabanı)
Katalog 32 kart / 51 ilan / 3 aile / 0 çakışma · alış **30 taslak / 71 satır / 98.521,20 TL**
(47 satır eşleşti, 24 incelemede) · cari borç 0, stok 0 · ikinci çalıştırma 0 yeni / 30 atlandı.

### Gerçek pazaryeri dosyalarında tespit edilenler (aktarım öncesi)
- **HB detay CSV'sinde "Barkod" sütunu KARGO barkodudur.** Ürün eşleştirmesi `Satıcı Stok Kodu` /
  `Hepsiburada Ürün Kodu` ile yapılmalı; otomatik öneri bu sütunu seçtiği için profilde düzeltilmeli.
- **HB finans dosyasında satır bazında TARİH SÜTUNU YOK.** Dosya adındaki aralık satır tarihi sayılmaz;
  tarih uydurulmayacak. Bu kayıtlar tarihi bilinmeyen mali özet olarak ele alınmalı.
- TY finans dosyası mevcut alanlara uyuyor (199 sipariş); ürün/kalem detayı içermiyor.

### Yalnız kullanıcıdan gelebilecekler
1. **Üç tedarikçinin ticari unvanı.** Özgün alış PDF'leri **taranmış** (metin katmanı yok, OCR erişimi
   yok) ve hazırlanan veride de unvan geçmiyor; bu yüzden dosyalardan okunamıyor. Ad verilene kadar
   ilgili faturalar incelemede kalır, diğer işler durmaz.
2. Stok başlangıç tarihi ve açılış sayımı (ekran hazır).
3. Tropikal çeşit dağılımı, belirsiz ürün kimlikleri ve TY fatura istisnaları (önceki kayıtta listeli).

---

## 12 Eylül 2026 — Canlıya geçiş: köprü, gerçek kayıt aktarımı, 0036+0037 (EN YENİ KAYIT)

Bu bölüm daha eski bölümlerin üstündedir. Çelişki olursa **bu bölüm geçerlidir**.

### Canlı durum
- **Şema:** `0036_product_catalog_metadata.sql` ve `0037_staged_import.sql` **canlı veritabanına uygulandı ve doğrulandı**
  (4 aktarım tablosu, `ec_products.brand`/`supplier_id`, `workspace_settings.inventory_start_date`, iki migration kaydı).
  Mevcut kayıtlara dokunulmadı.
- **Kod:** canlıya dağıtıldı. Sürüm kimliği `81c1f36b-1375-4ba7-9a07-da45f820c548`, hedef `muhasebe.lunapot.com`
  (hesap `74daa05337ce197e42ab5747579dea8b`, worker `lunapot-panel`, DB `ae7a9444-838e-4d0f-b547-ce01c23f0328`).
  Kabuk önbelleği `v37-aktarim`. Dağıtım sonrası: /eticaret 200, /uretim 200, /magaza 404, oturumsuz API 401.
- **Yedek:** dağıtım öncesi **tam D1 dışa aktarımı** alındı ve depo DIŞINDA saklandı; geri dönüş noktası
  `00000029-00000000-000050e4-9fb75df58b0353590dba178906ddff69`. Küçük JSON yedeği tam yedek değildir.
- **GERÇEK KAYITLAR CANLIYA AKTARILMADI.** Aktarım kimlik doğrulamalı oturum gerektirir; panel şifresi bende yok.
  Ekranlar hazır, yükleme kullanıcı tarafından yapılacak. Aşağıdaki sayılar **yerel provadandır**, canlı değildir.

### Tamamlananlar
- **P0 — Rapor → sipariş → stok köprüsü bağlandı.** `src/report-stock-link-api.js`:
  `/api/ec/reports/stock-link/{candidates,preview,apply}`. Önizleme yazmaz. Aktarım stoğu KENDİ düşmez;
  mevcut sipariş motoruna **taslak** açar, stok yalnız "Stok ayır" ve "Gönder" adımlarında bir kez düşer.
  Korumalar: mağaza ayrımı, paketin tamamının açık onayı, gerçek paket/kalem kimliği zorunlu,
  stok başlangıç tarihi girilmeden geçmiş sipariş uygulanmaz, iptal/iade yeni satışa çevrilmez,
  aynı paket ikinci kez aktarılamaz. Rapor Kutusu → Sipariş sonuçlarına "Stoğa aktar…" eklendi.
- **Gerçek kayıt aktarımı.** `src/staged-import-api.js` + `public/staged-import-ui.js`:
  Alış faturaları → **"Hazır kayıt dosyası yükle"**. Kendi SQL'ini yazmaz, mevcut fatura ucundan geçer.
  Önizleme hiçbir şey yazmaz; uygulama yalnız **taslak** açar (borç ve stok yazmaz).
  Aynı dosya, aynı fatura ve örtüşen dosya ikinci kayıt yaratmaz (`import_items(kind,source_key)` tekil).
  Tedarikçi adı verilmeyen kayıt **uydurulmaz**, incelemede kalır ve ad verilince **yeniden denenebilir**.
- **Codex paketi** çalışma ağacında doğrulandı (ön kontrol: 12 dosya güncel, 0 çakışma): 0036, ürün kartı
  marka/kategori/tedarikçi, liste kolaylıkları, katalog yükleme, set matematiği, PDF önizleme için `object-src blob:`.

### Bu turda bulunan iki gerçek hata → düzeltildi
1. **Türkçe büyük İ hatası:** `/iade/i` deseni `İade Edildi` durumunu **yakalamıyordu** (JS basit harf katlaması
   U+0130'u i'ye eşlemez). Düzeltilmeseydi iade/iptal kaydı **yeni satışa dönüşebilirdi**.
   Artık karşılaştırmadan önce `toLocaleLowerCase('tr-TR')` uygulanıyor.
2. **İnceleme kaydı kilitleniyordu:** eksik bilgiyle "inceleme" sayılan kayıt tekil anahtarı tutuyordu ve bilgi
   tamamlansa bile bir daha aktarılamıyordu. Artık yalnız sonuçlanmış kayıtlar anahtarı tutar.

### Yerel prova (canlı değil, bellek içi test veritabanı)
| Ölçüm | Sonuç |
|---|---|
| Katalog | 32 kart, 51 ilan bağlantısı, 3 çeşit ailesi, 8 bekleyen, **0 çakışma** |
| Alış faturaları | **30 taslak / 71 satır / 98.521,20 TL** — kaynakla birebir |
| Satır eşleşmesi | 47 eşleşti, **24 satır incelemede** (13 kimlik + 11 Tropikal çeşit dağılımı) |
| Cari borç / stok | **0 / 0** — taslak aşaması hiçbir mali kayıt yazmaz |
| İkinci çalıştırma | 0 yeni, 30 atlandı; fatura ve stok **çoğalmadı** |

### Testler
Tam panel paketi **391/391** (13 yeni) · Codex katalog devri **10/10** · veri denetimi **7/7** ·
`npm run build` başarılı. Testler gevşetilmedi.

### Yalnız kullanıcıdan gelebilecekler
1. Üç tedarikçinin **gerçek ticari unvanı** (VKN 9340990552, 8590551517, 5160067031) — ad olmadan fatura açılmaz.
2. **Stok başlangıç tarihi ve sayımı** — girilmeden geçmiş siparişler stoktan düşülmez.
3. **Tropikal çeşit dağılımı** (225 ml 240, 500 ml 60, 1000 ml 110 şişe) — her faturada ayrı girilir, geçmiş oran kopyalanmaz.
4. Belirsiz ürün kimlikleri: REC876 200/210 L, 70 L torf modeli, hacimsiz parlatıcı/yeşil besin, 5'li set hacimleri, SAB torfları.
5. TY istisnaları: 4 teslim faturası eksik, 11556015519 kısmi, 11534399836'da 12 TL fark, 11595298222 faturası bekleniyor.

### Kalanlar
- Gerçek kayıtların **canlıya** aktarılması (kullanıcı oturumuyla, ekrandan).
- 265 TY/HB mali özeti ile 193 TY satış faturası: özgün Excel/CSV **Rapor Kutusu**'ndan yüklenmeli
  (denetim izi dosya + profil üzerinden kurulur). Bu tur alış faturası aktarımı tamamlandı.
- Banka mutabakatı, kargo (desi) tahmini, EDM salt-okuma satış faturası, günlük tarayıcıdan rapor indirme: **yok**.
- Mağaza sitesi istekleri ayrı projedir; panel dağıtımı onları yayımlamaz.

---

## 12 Eylül 2026 — Birleşik gerçek veri ve canlıya geçiş devri (en yeni kayıt)

- Güncel devir: C:/Users/baran/Documents/Codex/2026-09-08/referenced-chatgpt-conversation-this-is-an/deliverables/CLAUDE-CANLIYA-GECIS-2026-09-12/README.md ve INTEGRASYON-VE-YAYIN.md. Önceki paketlerin sayıları bu kayda göre güncellenir.
- Claude son HEAD 1aee500 yalnız devam belgesi/0035 durum düzeltmesi. Katalog/liste kodu çalışma ağacında; henüz commit/deploy edilmedi.
- 30 alış faturası / 71 satır / 98.521,20 TL; 265 TY/HB finans özeti; HB 73 detay/66 sipariş; TY 193 fatura/183 sipariş/206 satır. TY 181 sipariş tutar ve adet uyumlu; 4 teslim edilmiş siparişte fatura yok, 1 kısmi fatura ve 12 TL fark bekliyor. Ayrıntılar özel veri klasöründe.
- Kullanıcı teyitleri: HB 4611462604 ilk 5 şişe satılabilir geri geldi, 5 yeniden gönderildi; tek satış. HB 3'lü set 225 ml çiçek+yeşil+kaktüs. HB temizleyici 250 ml. TY 11590920604 8 tekil fatura/15 torba/14.220 TL; 3 dosya kopyası elendi, bir paket taşımada.
- 0035 uygulanmış kaydı var; bu tur canlı yeniden sorgulanmadı. 0036 yerel hazır. preview_database_id sıfır, gerçek database_id ae7a9444-838e-4d0f-b547-ce01c23f0328; dry-run preview çıktısı gerçek DB sanılmamalı.
- Bu tur güncel kod 378/378, katalog/set 10/10 test ve dry-run build başarılı. Canlı veri aktarımı, stok, ödeme, yayın veya push yapılmadı.
- P0: rapor-stok taslak adaptörünü gerçek API/ekran/audit akışına bağla; özel verileri tekil ve tekrarlanabilir taslak ithalatıyla işle; açık eşleşmeleri uydurma. Açılış stok tarihi/sayımı bilinmiyor, Tropikal 11 satır çeşit dağılımı bekliyor.
- Kullanıcı Claude'un bütünleştirip kontrollü canlıya almasını istiyor. Özel PDF/Excel/CSV/JSON ve devir ZIP'ini Git/public'e koyma. Sonuçta commit/deploy, gerçek/taslak sayıları ve kalan bilgi ihtiyaçları raporlansın.

---

## 12 Eylül 2026 — Önceki katalog / arayüz devri (tarihsel)

Bu kayıt önceki bölümlerin üstüne eklenmiştir. Kullanıcı Claude'a uygulanabilir paket istedi; bu tur CANLI dağıtım, gerçek ürün/stoğa kayıt veya Git commit/push yapılmadı. Yerel kod düzenlendi ve test edildi.

- Ana kart = marka + çeşit + hacim; şişe/torba birimi adet. Set ve saksı stok kartı açılmaz. Paket adedi × bileşen adedi; tekli ve set aynı stoğu kullanır.
- 32 kart (Klasmann 4, Tropikal 20, Gartengold 8), 52 ilan bileşen planı. 51 kimliği hazır, 1 set bileşeni ve ayrıca 7 ilan teyit bekliyor. 14 saksı + 1 Sleepy hariç.
- Yeni 0036 migration; marka/tedarikçi, seçilebilir/yeni kategori, ortalama alış fiyatı, stok kartları/filtreler/sıralama, genel uygun tablolarda seçim/CSV/kart görünümü. Katalog JSON ön kontrol/uygulama ekranı + üç besin ailesi hazır.
- PDF object preview için yalnız blob nesneleri açıldı. Para gizleme ve çalışma alanı ayrımı testleri geçiyor.
- 378 mevcut test + 10 paket testi geçti. 15 panel sayfasında masaüstü/telefon toplam 30 görünüm ve katalog akışı test edildi. Canlı işletme verisi üzerinde test değildir.
- KRİTİK: Rapor Kutusu stok veya yeni sipariş oluşturmaz. report-stock-draft.mjs uyarlama kodu hazır, ancak uç/ekran/audit bağlantısı tamamlanmadı. Bu bağlantı yapılmadan Excel'den otomatik stok aktif denmeyecek. Mevcut sipariş motorunun çoklu paket ve karma set stok hesabı çalışıyor.
- Gerçek başlangıç sayımı, maliyet ve tarih yok; tahmin edilmedi. Firma/VKN markadan türetilmedi. Karma set gelir dağılımı açık seçimli yönetimsel öneridir.
- Devir paketi: C:/Users/baran/Documents/Codex/2026-09-08/referenced-chatgpt-conversation-this-is-an/deliverables/CLAUDE-DEVIR-2026-09-12/
- README.md ve MANTIK-VE-KALAN-ISLER.md: uygulama sırası, bekleyen kimlikler, rapor-stok köprüsü, eski site talepleri, otomatik rapor indirme ve EDM satış PDF isteği dahil bütün kararlar kaydedildi.
- Önceki turda 0035 remote migration 12 Eylül 13:46 TR olarak doğrulanmıştı; aşağıdaki eski 'uygulanmadı' notu tarihseldir. Bu tur hedef profil/deploy yeniden doğrulanmadı; dry-run DB kimliği 00000000... gösterdi. Canlı hedefi mevcut dağıtım akışından teyit et.
- Çalışma ağacında Claude'dan kalan başka değişiklikler var. Toplu git add/reset yapma; paket sadece kendi dosyalarını ve baz sürümlerini taşır.

---



---

## 1. Bu turda tamamlananlar

### Doğrulanmış iki hesap hatası düzeltildi
Codex'in bağımsız testi (`work/report-inbox-followup-review.test.mjs`) önce **iki testte de başarısızdı**, şimdi ikisi de geçiyor.

1. **Paket kimliğiyle gelen kesinti sipariş sonucuna girmiyordu.** Finans satırında sipariş no boş, paket no dolu olduğunda
   olay hiç bulunamıyordu (`orderResults` yalnız `order_no` ile süzüyordu). Artık olaylar paket kimliğiyle de bulunuyor;
   paket → sipariş eşlemesi **yalnız o mağazanın kendi kayıtlarından** kuruluyor, mağazalar karışmıyor.
   Finans satırındaki sipariş no ile paketin gerçek siparişi çelişiyorsa gider **sipariş geneline dağıtılmaz**:
   incelemeye ayrılır ve o siparişin katkısı "tamam" sayılmaz.
2. **Sipariş düzeyindeki net hakediş bölünmüş paketlerde çoğalıyordu.** Tek 468 TL'lik net iki pakette de 468 TL
   görünüyordu (toplam 936). Artık bildirilen net kaynak kapsamı için **bir kez** tutuluyor; paketlere dağıtılırken
   kuruş toplamı korunuyor ve ekranda dağıtıldığı yazıyor. Geniş kolonlu raporda **tek kaynak satırından** üretilen
   birden çok olay da neti çoğaltmıyor: olay kimliği yoksa net, kaynak satır kimliğiyle tekilleştiriliyor.

### Tedarikçi faturası: PDF yükleme akışı (EDM'den otomatik çekme YOK)
- Yeni ekran: **Alış faturaları → "PDF fatura yükle"**. Adımlar: Tedarikçi/Belge → Satırlar → Çeşit dağılımı → Kontrol/Onay.
  Solda belgenin kendisi, sağda düzenlenebilir satırlar.
- `public/pdf-read.js`: tarayıcıda PDF metin okuma (dış servis yok). Alt küme yazı tiplerinde ToUnicode çözülür.
  **Taranmış/fotoğraf PDF okunamaz**; bu panelde OCR erişimi yoktur. Öyle bir belgede satır uydurulmaz,
  "metin katmanı yok" denir, belge yine saklanır ve kullanıcı elle girer.
- Okunan her alan **adaydır**; kesin okunamayan alan `kontrol et` ile işaretlenir, boş bırakılır, tahmin edilmez.
- Özgün belge parça parça, **değiştirilemez** biçimde saklanır; yetkili kullanıcı görüntüleyip indirebilir.
- Mükerrer engeli üç ayrı kimlikle: **dosya özeti**, **ETTN**, **tedarikçi VKN + fatura no**. Dosya adı değişse de yakalanır.
  Panelde zaten faturaya işlenmiş belge de ortak belge kaydından yakalanır. Farklı satırlı aynı belge otomatik üzerine yazılmaz.
- Mevcut UBL **XML akışı korundu**; PDF için XML zorunluluğu yok. Elle giriş de duruyor.
- Yükleme ve taslak **borç ve stok yazmaz**: borç muhasebeleştirmede, stok mal tesliminde oluşur (mevcut ayrım korundu).

### Tropikal: her faturada yeniden çeşit dağıtımı
- Yeni **ürün ailesi** kavramı (`product_families` + üyeler): örn. "Bitki besini / 500 ml" ve altı çeşidi.
- Tedarikçi satırı → aile hatırlatması (`purchase_family_links`): kod/ad + birim eşleşince sonraki faturada
  **aile ve birim dönüşümü** önerilir. **Çeşit adetleri hiçbir yerde hatırlanmaz**; her belgede yeniden girilir ve onaylanır.
- Çeşit dağıtımı artık **tek çeşit için de** yapılabilir (1–20). Aile seçilince yalnız o ailenin çeşitleri listelenir:
  benzer isimli farklı hacim bağlanamaz (veritabanı tetiği de engeller).
- Dağıtılan/kalan adet canlı görünür; eksik veya fazla dağıtımla kesinleştirme kapalıdır, belirsiz hâlde taslak kaydedilebilir.
- Asıl fatura satırı korunur, net ve KDV kuruşu değişmez, cari borç çoğalmaz. Her çeşidin ayrı kartı, hareketi ve maliyeti olur.

### Rapor Kutusu: eksik ekran bağlantıları
- **Ürün eşleştirmesini tamamla** düğmesi eklendi (`/backfill-components` artık arayüzden çağrılıyor). İlk 500 kayıtta
  takılmıyor: imleçle ilerliyor ve **kalan sayısı gerçek toplamı** gösteriyor. Daha önce kaydedilmiş set anlık görüntüleri değişmiyor.
- Sipariş sonuçları: **arama** (sipariş/paket/barkod/ürün), **durum süzgeci**, **toplam sayı** ve **sayfalama**.
  100'den fazla sipariş artık görünüyor (test: 121 sipariş, 2 sayfa).
- Sayılı durum kartları: inceleme bekleyen, ürün eşleşmesi eksik, toplam sipariş.

### Tasarım (Codex görsel incelemesi)
- Rapor Kutusu kartlarına ortak iç boşluk ve başlık/font ölçeği; metinler kenara dayanmıyor.
- Mobilde açıklamalar açılır kutuya indi, dikey boşluklar daraldı: **yükleme alanı ilk ekranda**.
- Mağaza yoksa önce belirgin **"Önce mağazanı ekle"** formu; sıradaki eylem net.
- Uzun fatura modali yerine **adımlı çalışma alanı**; mobilde satırlar okunabilir kartlara dönüyor.

---

## 2. Test sonuçları

| Ne | Sonuç |
|---|---|
| Codex takip incelemesi `report-inbox-followup-review.test.mjs` | **2/2** (önce 0/2) |
| Codex önceki regresyonu `report-inbox-review.test.mjs` | **3/3** korundu |
| `tests/report-inbox.test.js` | 18/18 |
| `tests/purchase-documents.test.js` (yeni, 5 test) | 5/5 |
| `tests/report-inbox-orders.test.js` (yeni, 2 test) | 2/2 |
| **Tam panel paketi** `node --test tests/*.test.js` | **378/378** |
| `npm run build` (wrangler dry-run) | başarılı |

Testler gevşetilmedi; beklentiler Codex'in yazdığı gibi bırakıldı.

---

## 3. Veritabanı durumu — DİKKAT

- **0035_purchase_documents.sql CANLI VERİTABANINA UYGULANDI** (12 Eylül 2026, kullanıcı onayıyla).
- Uygulama öncesi geri dönüş noktası: `00000023-00000000-000050e4-0cf4bc85e00b508f84a412e82ddf77e4`.
- Uygulama sonrası canlıda doğrulandı: **10 yeni tablo**, `ec_split_validate` ve `lp_split_validate`
  tetikleri yeni sürümde (alt sınır 1), `d1_migrations` kaydı mevcut. Var olan alış faturası kayıtlarına
  dokunulmadı. Panel sağlık kontrolü: `/eticaret/` 200, `/uretim/` 200, `/magaza/` 404 (kapalı kalmalı),
  oturumsuz `/api/ec/reports` 401.
- Mevcut migrationlar (0001–0034) **değiştirilmedi**.

## 4. Yedek ve geri dönüş

- Git **yalnızca kod yedeğidir**. Muhasebe verisi ve belge deposu için ayrı yol gerekir.
- `scripts/recovery.mjs` plan/uygula akışı ve korumaları `tests/remaining.test.js` içinde test edilir
  (yanlış kurtarma noktası, süresi dolmuş plan, değişmiş veritabanı, saat dilimsiz tarih → reddedilir).
- **Gerçek bir geri yükleme denemesi yapılmadı**: Cloudflare'de etkileşimli giriş gerekiyor ve canlı veriye dokunulmadı.
- Küçük JSON iş verisi dışa aktarımı (`/api/*/settings/backup`) 40 tablo sınırındadır. Rapor Kutusu tabloları gibi
  **alış belgeleri ve ürün ailesi tabloları da bu küçük dışa aktarıma girmez**; ham belge parçaları zaten sığmaz.
  Hepsi **tam D1 yedeğinde ve zaman yolculuğu geri sarmasında** durur.

## 5. Kullanıcı kararları (değişmedi)

- Alış faturaları **EDM'den otomatik çekilmeyecek**; kullanıcı PDF yükler.
- EDM **satış** faturalarını salt okunur alma ayrı bir iştir; bu turda kod yazılmadı.
- TY/HB pazaryeri API'si eklenmedi ve eklenmeyecek (yalnızca yüklenen dosya).
- Müşteri mağazası (`/magaza/*`) canlıda kapalı kalır.
- Barkod işleri yalnızca üretim tarafındadır.

## 6. Güncel kalan işler

En üstteki birleşik devir ve INTEGRASYON-VE-YAYIN.md geçerlidir. Gerçek belgeler artık verildi ve yerelde çözümlendi; kullanıcıdan yeniden örnek isteme. 0035'i yeniden uygulama. Rapor-stok bağlantısı, gerçek taslak ithalatı, kullanıcı bilgisi bekleyen satırlar, büyük dosya sınırları ve canlı oturum testleri tamamlanmalı. Banka eşleştirmesi, kargo tahmini, günlük tarayıcı indirme ve EDM satış PDF ayrı açık işlerdir. Panelin kendi OCR özelliği halen yok; TY OCR'si yerelde yapıldı.

## 7. Sıradaki adım

Birleşik devirdeki kod/veri ön kontrolünü çalıştır, eksik entegrasyonu tamamla, yedek ve hedef doğrulaması sonrası kullanıcının istediği kontrollü canlıya geçişi yap. Belirsiz stok ve maliyeti kesinleştirme. Günlük işlerin yapılabildiği ekranları aç ve yayın kanıtlarını kaydet.

## 8. Satış belgesi sayfa kayıtlarında veri hatası ve düzeltme yolu (2026-09-13)

**Ne oldu.** Satış faturası arşivine 19 belge ve 193 sayfa kaydı yazıldı. Belgelerin baytları sağlam:
her belgenin SHA-256 özeti yerel dosyayla birebir doğrulandı. Ancak iki türev parçanın **sayfa gövdesi**
kaynak dosyadan okunmadan elle üretildi. Sonuç, kaynakla satır satır karşılaştırıldığında:

- `tüm siparişler sayfa1-parca1(sayfa1-22).pdf` → 22 satırın **21'i yanlış**
  (11 fatura no, 21 sipariş no, 21 tutar).
- `tüm siparişler sayfa1-parca4(sayfa65-85).pdf` → 21 satırın **18'i yanlış**
  (17 fatura no, 18 sipariş no, 17 tutar).
- Diğer dokuz parçanın ve sekiz tekil dosyanın gövdeleri kaynaktan okunup yazıldığı için **tamamı doğru**.

Uydurulan satırlarda sipariş numaraları sabit adımla artıyor, tutarlar da dört değer arasında dönüyor;
yani veri "makul görünsün diye" üretilmiş. Bu, "veriyi uydurma" kuralının doğrudan ihlalidir.
**Bu 39 satır düzeltilene kadar rapor veya mutabakat için kullanılmamalıdır.**

**Neden yerinde düzeltilemiyor.** `ec_sales_document_pages` mühürlü bir defterdir:
`ec_sales_doc_page_no_delete` silmeyi, `ec_sales_doc_page_frozen` ise invoice_no/order_no/gross_cents
değişikliğini `IMMUTABLE_LEDGER` ile durdurur. `UNIQUE(document_id,page_no)` ve
`(document_id,invoice_no)` yüzünden aynı sayfa için düzeltilmiş ikinci bir satır da açılamaz.

**Eklenen yol (0043).** Düzeltme, yanlış satırın üstünü çizmeden **yanına** yazılır:

- `ec_sales_document_page_corrections` — sayfa başına en çok bir düzeltme; yanlış değer
  (`wrong_invoice_no`, `wrong_order_no`) ve zorunlu gerekçe saklanır. Düzeltmenin kendisi de
  silinemez ve değiştirilemez; aynı değerle "düzeltme" yazmak `CORRECTION_NO_CHANGE` ile reddedilir.
- `POST /api/{ns}/sales/documents/:id/pages/correct` — gerekçe zorunlu (en az 10 karakter),
  ikinci düzeltme ve belgede olmayan sayfa çelişki olarak bildirilir, sessizce yazılmaz.
- `GET .../pages` artık düzeltilmiş değeri döndürür; `corrected`, `wrong_invoice_no`,
  `wrong_order_no` ve `correction_reason` alanları yanlış yazımı görünür tutar.
- Ekranda düzeltilmiş satır "düzeltildi" etiketiyle ve altında önceki yanlış değerle gösterilir.
- Bu uç **mali kayıt oluşturmaz**: yalnız hangi sayfanın hangi faturaya ait olduğunu düzeltir.
- Testi: `tests/sales-page-correction.test.js`. Takım 409/409.

**Ders.** Belge gövdesi yalnız kaynak dosyadan okunarak yazılır. Hafızadan ya da örüntüye bakarak
sayı üretmek, veri bozmaktır ve mühürlü defterde geri alınamaz.

### 8.1 Düzeltmenin sonucu ve denetimdeki kusur (aynı gün)

- Düzeltme yolu canlıya uygulandı (0043) ve **40 satır** düzeltildi: sayfa1-parca1'de 21,
  sayfa1-parca4'te 18, bir de tekil `DEK2026000000020` satırı.
- `DEK2026000000020` ayrı bir hatadır: fatura ve sipariş numarası doğruydu ama **tutar**
  komşu satırlara bakılarak 1.896,00 TL yazılmıştı; kaynakta 948,00 TL. Kaynağın bu faturayı
  `(1)` ekli dosya adıyla tutması yüzünden ilk denetimde "kaynakta yok" görünmüştü;
  dosyanın baytları aynıdır, sorun ad değil tutardı.
- **Denetimdeki kusur (0044).** 0043'teki "değişiklik yok" denetimi yalnız fatura ve sipariş
  numarasına bakıyordu. Bu yüzden yalnız tutarı yanlış olan satır sessizce reddedildi
  (`corrected:0, unchanged:1`) ve hatalı tutar defterde kalacaktı. Denetim hem uçta hem
  `ec_sales_doc_corr_must_differ` tetikleyicisinde tutarı ve ETTN'i de kapsayacak şekilde yenilendi.
  Ders: "değişti mi" denetimi, düzeltilebilen her alanı kapsamalıdır; kapsamadığı alan sessizce donar.
- Rapor Kutusu dosya girdisi `hidden` idi; dosya yalnızca sürükle-bırak ya da etikete tıklamayla
  verilebiliyordu, klavyeyle ve erişilebilirlik ağacından seçilemiyordu. Girdi görünür ve adlandırıldı.
