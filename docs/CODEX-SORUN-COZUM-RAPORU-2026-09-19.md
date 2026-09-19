# Lunapot Panel — Sorun, Çözüm ve Claude Uygulama Devir Raporu

Tarih: 19 Eylül 2026  
Aktif dal/HEAD: `main / d44924eefccf9a2fcb3cfd717e6900fea6c02347`  
Karar: **FAIL — bu rapordaki backend bulguları henüz düzeltilmedi.**

## 1. Kapsam ve kanıt standardı

Gereksinim kaynağı [Sistem Raporu](SISTEM-RAPORU-2026-09-19.md), özellikle **§0 Görev ve §5 Değişmez kurallar**. Kaynak dosya/satırları aktif depodan salt okunur doğrulandı. Eski `Documents/Codex/.../outputs/lunapot-panel` kopyası uygulama temeli değildir.

**25 bulgu: 13 P1 ve 12 P2.** Her maddede sorun, kaynak konumu, tekrar senaryosu, çözüm ve kabul testi bulunur. Fiyat önerisinin adet/kargo ve profil gideri sorunları R23 altında birlikte ele alınır.

- **P1:** Stok, maliyet, gelir veya kâr doğruluğunu doğrudan bozabilir; ilgili düzeltme yayını öncesinde ele alınmalı.
- **P2:** Rapor kapsamı, sınır durumları, öneri veya otomasyon ilerlemesi hatası; erteleme gerekçesi ve takip testi açık yazılmalı.
- **S — Sentetik kanıt:** Ana incelemede yerel fixture üzerinde doğrulandığı aktarılan tekrar. Aşağıdaki tekrarlar bu sınıftadır; aynı kaybın canlı müşteride gerçekleştiği iddiası değildir. Ham test çıktıları bu yazımda yeniden üretilmedi.
- **L — Canlı SELECT:** Önceki salt-okunur sorgulardan aktarılan olgular; §2'de ayrı. Bu rapor oturumunda canlı sorgu/yazma yapılmadı.
- **K — Kod:** Güncel dosya/satırların salt-okunur doğrulaması. Satırlar inceleme anına aittir; uygulama başında yeniden konumlandırılmalı.
- **Öneri:** Çözüm ve kabul testleri henüz uygulanmadı; tarifler mevcut testlerin bunları zaten kapsadığı anlamına gelmez.

Mevcut test takımı **552 test / 0 hata** ile geçti; yerel UI değişikliklerinden sonra tam takım yeniden çalıştırılarak aynı sonuç alındı. Yarış, yarım işlem, tarihsel kapasite ve ekran eşitliği açıkları bu yeşil sonucun dışında kalıyor. Yerel `node:sqlite` başarısı tek başına D1 batch/çalışma zamanı davranışını kanıtlamaz.

**Backend bulguları henüz düzeltilmedi.** Aynı çalışmada yerel arayüz iyileştirmeleri uygulandı; kapsam, önce/sonra görüntüleri ve testler [Tasarım Raporu](TASARIM-RAPORU-2026-09-19.md) içindedir. Canlı veri onarımı, migration, commit, push veya deploy yapılmadı.

## 2. Canlı olgular, kanıt sınırları ve güvenlik

| Aktarılan kanıt | Sonuç | Çıkarım sınırı |
|---|---|---|
| L: FIFO kuyruğu | `ec_cost_dirty` sayısı **0** | Boş kuyruk, tarihsel değerlerin doğruluğunu veya yarışın imkânsızlığını göstermez. |
| L: Teknik iade | **6 DUZELTME-CIFT düzeltme iadesi** | Gerçek müşteri iadesi gibi tekrar stoğa alınmamalı; asıl/kopya bağı korunmalı. |
| L: KDV | **9 satır %10**; ana belgenin eski sayısı 8 | İş kuralındaki %20 ile uyuşmazlık belge bazında araştırılmalı. Hepsini körlemesine %20 yapmak doğru onarım değildir; brüt ve özgün kaynak korunmalı. |
| L: Stopaj | Olaylar yalnız **HB** kanalında | R17 TY hatası şu an kanıtlanmış canlı kayıp değil; TY olayı geldiğinde çalışan hatalı dalın sentetik kanıtıdır. |
| L: Sıfır maliyet incelemesi | Şüpheli canlı satış örnekleri tamamen ters kayıtla kapanmıştı | Bunlardan eksik açık maliyet sonucu çıkarılmamalı; yeniden açık maliyet yaratılmamalı. R15 ayrı sentetik kapasite hatasıdır. |
| Önceki koşullu fiyat hesabı | Torf 20 L son maliyet **228 TL brüt** varsayımında başabaş **~481 TL**, +50 TL hedef **~543 TL** | Kanal, komisyon, stopaj, kargo ve hizmet varsayımlarına bağlı; uygulanmış veya kesin fiyat değildir. |

Yerel HEAD doğrulandı; **canlı çalışan sürüm ayrıca doğrulanmadı**. Ana belgedeki ilk canlı otomatik bakım turlarının doğrulama açığı da kapanmış sayılmaz. Toplam canlı zarar veya etkilenen sipariş sayısı bu sınırlı verilerden hesaplanamaz.

Kapsam notu: Güvenlik alt incelemesi otomatik içerik filtresinde durdu; kapsam eksik, exploit sonucu yok. R25 ayrıca doğrulanmış bir yetkili kullanıcı erişim hatasıdır; tam güvenlik incelemesinin yerine geçmez.

## 3. Çözümün koruması gereken iş kuralları

1. **Tek ekonomik sonuç:** Performans, sipariş listesi/penceresi, panorama ve ürün kârlılığı aynı paket/tarih/kanal ve gerçekleşen-tahmini kapsamda aynı kuruş sonucunu üretmeli. Farklı kapsamlar açık etiketlenmeli.
2. **KDV dahil görünüm:** Satış kaynak satır oranıyla, maliyet belgeli ürün oranıyla, kesinti beyan edilmiş kesinti oranıyla hesaplanmalı. KDV hariç katkı ayrı küçük satırdır. Veri uyuşmazlığını formülde oran zorlayarak gizleme.
3. **Tarihsel FIFO:** Eski satış son alış fiyatına taşınmaz. Son fiyat yeni satış/fiyat önerisi girdisi olabilir; geçmiş maliyet kendi katman tüketimidir.
4. **Bilinmeyen sıfır değildir:** Güvenilir geçmiş varsa kaynaklı ve etiketli tahmin; yoksa `null` ve kısa sebep. Açık/tahmini/kesin maliyet ayrılmalı.
5. **Miktar/değer korunumu:** Bir olay bir kez ekonomik etki yaratır. İade satışı, settlement kaynak kapasitesini aşamaz. Stok, açık maliyet ve defter değeri uzlaşmalı; sıfır miktarda açıklanamayan değer kalmamalı.
6. **Değişmez iz:** Ters kayıt, sürüm, settlement/revaluation ile düzeltme; kilitli satış/fatura/hareketi sessiz toplu UPDATE ile onarma yok. Türetilen bakiyenin değişimi kaynak düzeltme kaydına dayanmalı.
7. **Güncellik:** Aynı içerikli yeni gözlem de zaman sınırını ilerletir. Eski dosya/yarış yeni gözlemi geri alamaz.
8. **Tekrar güvenliği:** Cron ve tarayıcı birlikte, kesilme/yeniden deneme altında aynı nihai sonucu üretmeli. Hatalı kayıt sağlıklı kuyruğu durdurmamalı.
9. **İade ayrımı:** DUZ teknik ters kaydı fiziksel müşteri iadesi değildir. Gerçek iadede kargo/hizmet giderleri gerekçesiz silinmez.
10. **UI:** Kısa Türkçe, tam ürün adı önde, yatay kaydırma yok, uzun iç ID'ler ana bilgi değil. Kesin öğrenilmiş eşleşme otomatik; gerçekten belirsiz ürün/adet uydurulmaz.

## 4. Önerilen çözüm sırası

| Sıra | Grup | Bulgular |
|---|---|---|
| 1 | Yarış ve yarım işlem | R01–R03 |
| 2 | Sipariş, stok ve iade | R04–R09, R14 |
| 3 | FIFO ve değerleme | R10–R12, R15–R16 |
| 4 | Ortak kâr ve kapsam | R13, R17–R22 |
| 5 | Fiyat önerisi, kuyruk ve yetkili erişim | R23–R25 |

Bu sıra bağımlılığı gösterir; R13 de P1'dir, P2 işlerin arkasına bırakılmamalı. R01/R02 çözülmeden toplu yeniden uygulama veya FIFO veri onarımı başlatılmamalı.

## 5. P1 bulgular

### R01 — P1: Eski değişmiş rapor yeni gözlemi eziyor (A2)

- **Konum:** [report-inbox-api.js:1175–1182](../src/report-inbox-api.js#L1175).
- **Kök neden:** Değişen kaydın UPDATE koşulu yalnız `version` denetliyor. Aynı içerikli yeni gözlem `source_time` ilerletirken sürümü artırmıyor; önceden sınıflanmış eski değişiklik sürüm koşulunu hâlâ sağlıyor.
- **Tekrar / kanıt (S+K):** Eski ama değişmiş dosyanın sınıflandırmasını beklet; daha yeni, içeriği aynı dosyanın gözlem zamanını yazdır; eski işlemi sürdür. İçerik ve zaman eski görüntüye dönebiliyor.
- **Çözüm:** İçerik sürümü ve gözlem zamanını birlikte karşılaştıran koşullu yazma. Yazma etki etmediyse sürüm/outcome/teslim yan etkilerini başarılı sayma; güncel kaydı yeniden sınıflandır. Kaynak değişimi ve denetim sürümü atomik olmalı.
- **Kabul testi:** Bariyer kontrollü iki paralel uygulama, iki yürütme sırasında da en yeni gözlemi korur; kayıp UPDATE sahte sürüm üretmez; üçüncü tekrar etkisizdir.

### R02 — P1: Paralel FIFO aynı farkı iki kez uyguluyor (F1)

- **Konum:** [fifo-cost.js:98–102](../src/fifo-cost.js#L98); etki [0048_fifo_cost.sql:23–25](../migrations/0048_fifo_cost.sql#L23).
- **Kök neden:** İki yürütücü aynı kirli ürünü/eski maliyeti okuyup aynı delta'yı hesaplıyor. Rastgele audit ID'si mantıksal tekillik sağlamıyor; iki INSERT da maliyete ekleniyor.
- **Tekrar / kanıt (S+K):** Aynı ürünün okumalarını iki işte tamamlatıp yazmaları peş peşe bırak. Aynı fark iki kez uygulanıyor. Örnekte 150 TL netten 90 TL nete inmesi gereken maliyet, iki adet −60 TL farkla 30 TL nete iniyor.
- **Çözüm:** Ürün hareket nesli/sürümüyle koşullu sahiplenme ve tekil değerleme işlemi. Farkı beklenen eski maliyete karşı yaz; audit ve dirty temizliği atomik olsun. İş sırasında gelen yeni hareketin dirty işaretini temizleme.
- **Kabul testi:** Cron/istek yarışı tek delta üretir; tekrar sıfır fark verir. Hesap sırasında yeni hareket eklenirse yeni nesil kuyrukta kalır veya ayrıca doğru işlenir.

### R03 — P1: Kabul kaydoluyor, geçici kapanış yarım kalıyor (F8)

- **Konum:** [accounting.js:183–184](../src/accounting.js#L183), [purchase-autopost-api.js:50](../src/purchase-autopost-api.js#L50).
- **Kök neden:** Kabul batch'i kapanıştan önce tamamlanıyor. Kapanış hata verince iş yarım; otomatik tamamlama `posted` faturada erken dönüyor.
- **Tekrar / kanıt (S+K):** Kabul kaydından sonra `closeProvisionalCounts` hatası enjekte et; otomatik tamamlamayı yeniden çağır. Kabul kalıyor, gerekli kapanış tamamlanmıyor. 10 adet geçici sayım + 10 adet gerçek kabul 20 adet bırakıyor; yeniden deneme bunu kapatmıyor.
- **Çözüm:** D1'in desteklediği atomik batch/tetikleyici sınırında birleştir veya kalıcı adım durumu ve tekil işlem anahtarıyla sürdürülebilir yap. `posted`, teslim/kapanışın da bittiği varsayımı olmamalı.
- **Kabul testi:** Hata öncesi/sonrası yeniden denemede tek kabul ve gerekli tek kapanış; çift stok yok. Tam bitmiş işlemin tekrarı etkisiz.

### R04 — P1: Sipariş iadesi her pakete tam uygulanıyor (A1)

- **Konum:** [report-inbox-api.js:820–825](../src/report-inbox-api.js#L820).
- **Kök neden:** İade SUM'ı sipariş, dış sorgu paket düzeyinde. Aynı finans iadesi her paket için yeniden kullanılabiliyor.
- **Tekrar / kanıt (S+K):** Aynı siparişte iki paket ve yalnız birini karşılayan tek iade olayı oluştur; iade uygulamasını çalıştır. Bir iade iki stok iadesine dönüşebiliyor.
- **Çözüm:** Finans olayını paket/satır tahsisine bağla; tüketilmiş miktar/tutarı düş. Paket kimliği yoksa yalnız kesin kanıtla tahsis et; tutar benzerliğinden iki pakete de tam iade üretme.
- **Kabul testi:** İki paket/tek olay toplamda olayın miktar/tutarını aşmaz. Tekrar ve paralel uygulama aynı sonucu verir; belirsiz olay gerekçesiyle incelemede kalır.

### R05 — P1: Hazırlanan sipariş stoğu artırıyor, iptal geri almıyor (A3)

- **Konum:** [report-stock-link-api.js:483–487](../src/report-stock-link-api.js#L483).
- **Kök neden:** Geçici sayım telafisi rezervasyon başarısı ve gönderim kararı öncesinde yazılıyor; sonraki stok düşüşü gerçekleşmeyebiliyor.
- **Tekrar / kanıt (S+K):** Siparişten sonraki tarihli GECICI-SAYIM ile yalnız hazırlanan siparişi aktar; ardından iptal et. Telafi artışı sevkle/iptalle karşılanmadan kalıyor. 24 adet sayım ve 8 adet hazırlık siparişinde stok 32 oluyor; iptal sonrası da 32 kalıyor.
- **Çözüm:** Telafiyi fiilen gerçekleşen tekil gönderimle atomik bağla. Hazırlık/rezervasyon tek başına telafi yaratmamalı. Mevcut sahipsiz telafileri denetimli ters kayıt adayları olarak belirle.
- **Kabul testi:** Hazırlık→iptal fiziksel stoğu değiştirmez; rezervasyon hatası artış bırakmaz; gönderim ve tekrar toplamda bir satış ve bir gerekli telafi üretir.

### R06 — P1: Taslak tazelemesi fiyat değişimini yutuyor (A4)

- **Konum:** [report-stock-link-api.js:313–319](../src/report-stock-link-api.js#L313).
- **Kök neden:** Eşitlik yalnız SKU/miktarla kuruluyor; brüt/net/KDV eşitlenmeden hash yenileniyor ve `source_changed` temizleniyor.
- **Tekrar / kanıt (S+K):** SKU/miktar sabitken rapor brütünü 500→900 değiştir; tazele ve gönder. Eski 500 işleniyor.
- **Çözüm:** Hash onayından önce bütün ekonomik alanları karşılaştır. Değişebilir taslağı iz bırakarak eşitle; rezerveli kaydı güvenli durum geçişiyle yenile. Kilitli kaydı sessiz değiştirme; durum ve mali değişikliği ayır.
- **Kabul testi:** 500→900 ya 900 ile doğru tamamlanır ya açık gerekçeyle durur; eski tutarı doğru kaynak diye onaylamaz. Yalnız durum değişikliği ilerleyebilir.

### R07 — P1: Gerçek iade başka açık satışı kapatmıyor (F3)

- **Konum:** [0047_open_cost.sql:57–61](../migrations/0047_open_cost.sql#L57).
- **Kök neden:** Kapanış yalnız `purchase/opening/count` girişlerini kabul ediyor; fiziksel stok/değer getiren `return` dışarıda.
- **Tekrar / kanıt (S+K):** Maliyeti bilinen satıştan fiziksel iade ve aynı üründe başka açık satış oluştur. İade diğer satış için settlement üretmiyor. 1 adet × 100 TL net giriş, iki satış ve ilk satışın iadesinde fiziksel miktar 0 iken 100 TL değer ve diğer satışın açık maliyeti kalabiliyor.
- **Çözüm:** İadenin kendi açık satışını iptal eden kısmıyla gerçekten geri dönen maliyetli kısmını ayır. Yalnız gerçek girişin kullanılabilir miktar/değerini diğer açık satışlara tarih sırasıyla tahsis et; R08 ile birlikte tasarla.
- **Kabul testi:** Maliyetli geri giriş diğer satışı kapasitesi kadar kapatır. Hiç stoktan çıkmamış açık kısmın iadesi yeni maliyet/değer yaratmaz; tekrar tekildir.

### R08 — P1: Kısmi açık iadede miktar sıfır, değer pozitif (F4)

- **Konum:** [0047_open_cost.sql:88–92](../migrations/0047_open_cost.sql#L88), [fifo-cost.js:82–86](../src/fifo-cost.js#L82).
- **Kök neden:** Tetikleyici açık miktar/tahmin payını azaltırken FIFO toplam satış adedine ve iadeye ayrı dağıtım yapıyor; açık/kapanmış/iade payları ortak tahsis hesabına dayanmıyor.
- **Tekrar / kanıt (S+K):** Kısmen maliyetlenmiş, kalanı açık satışı kısmi iade ve FIFO'dan geçir. Sıfır stok miktarına karşı pozitif değer kalabiliyor. 1 × 100 + 1 × 200 TL net giriş, 3 adet satış ve 1 adet iade örneğinde kalan değer 33,33 TL net.
- **Çözüm:** Karşılanmış, açık, iade ve kalan miktarları tek modelde tut; iadeyi kaynak maliyet tahsisine bağla. Revaluation yalnız gerçek farkı yazsın; bakiyeyi zorla sıfırlayıp belirtinin üstünü örtme.
- **Kabul testi:** Açık kısım önce/sonra iade edilen iki sırada miktar, değer ve settlement korunur; sıfır miktarda açıklanamayan değer kalmaz; ikinci FIFO etkisizdir.

### R09 — P1: Kabul ters kaydı yanlış FIFO katmanını tüketiyor (F5)

- **Konum:** [fifo-cost.js:67–72](../src/fifo-cost.js#L67).
- **Kök neden:** Kaynak katmana yönlendirme yalnız `provisional-close` için var; diğer negatif hareket ters çevrilen kabul yerine genel FIFO tüketimine düşüyor.
- **Tekrar / kanıt (S+K):** Farklı maliyetli iki giriş oluştur; ikinci kabulü ters çevir; sonraki satışın FIFO'sunu hesapla. İlk katman tüketilip yanlış maliyet kalabiliyor. A=100, B=200 TL net; B terslenip C=300 eklenerek 1 adet satıldığında satış/kalan 200/200 yerine 100/300 olmalı.
- **Çözüm:** Ters kayıt ile özgün kabul/hareket arasında açık kaynak bağı kullan. Etkili katmanları bu bağla kur; tüketilmiş kaynak için denetlenebilir değerleme farkı üret. Referans metnini tahmin edip ilk katmana düşme.
- **Kabul testi:** İkinci kabulün ters kaydı ilkini bozmaz; sonraki satış geçerli kalan katmanı kullanır. Kısmen tüketilmiş kabul de miktar/değer korunumunu sağlar.

### R10 — P1: Negatif sayım ortalaması FIFO ile ayrışıyor (F6)

- **Konum:** [accounting.js:118](../src/accounting.js#L118), [fifo-cost.js:72](../src/fifo-cost.js#L72).
- **Kök neden:** Sayım eksiği stok ortalamasından değerleniyor; FIFO aynı miktarı en eski katmandan çıkarıp sayım değerini uzlaştırmıyor.
- **Tekrar / kanıt (S+K):** İki farklı maliyetli katman üzerinde negatif sayım, sonra satış ve FIFO çalıştır. Kalan stok değeri katman tüketimiyle uyuşmuyor.
- **Çözüm:** Sayımı olay tarihindeki FIFO katman değeriyle yaz veya farkı değişmez sayım değerleme kaydıyla uzlaştır. Sayım kaybı ve satış maliyeti aynı kuruşları iki kez tüketmemeli.
- **Kabul testi:** Sayım değeri + sonraki satış maliyeti + kalan katman değeri başlangıcı tam uzlaştırır; geriye tarihli sayım da doğru yeniden hesaplanır; tekrar etkisizdir.

### R11 — P1: Satılmış geçici sayım gerçek fatura maliyetine geçmiyor (F7)

- **Konum:** [accounting.js:55–59](../src/accounting.js#L55), [fifo-cost.js:67–72](../src/fifo-cost.js#L67).
- **Kök neden:** Kapanış geçici sayımın kendi birim değeriyle miktar/değer düşüyor; daha önce satılmış payın gerçek fatura ile maliyet bağı kurulmuyor.
- **Tekrar / kanıt (S+K):** Geçici sayımdan satış yap; farklı gerçek maliyetli fatura/kabul ekle ve kapanış/FIFO çalıştır. Satılmış kısmın maliyeti geçici değerde kalıyor. 10 × 100 TL net geçici sayımdan 5 satış, sonra 10 × 200 TL net fatura: satış/stok 500/1.500 çıkıyor; beklenen 1.000/1.000.
- **Çözüm:** Geçici miktarı gerçek kabul miktarı/maliyetine eşleyen kalıcı tahsis kur. Raftaki ve satılmış payı uzlaştır; satılmış pay farkını audit'li revaluation ile yaz. İlgisiz tarihsel katmanları son fiyata taşıma.
- **Kabul testi:** Kısmen/tamamen satılmış geçici sayım doğru gerçek maliyete geçer; kısmi fatura yalnız kendi miktarını kapatır; çift stok veya tekrarda yeni fark oluşmaz.

### R12 — P1: Fiyat düzeltmesi FIFO hesabında kayboluyor (F2)

- **Konum:** [fifo-cost.js:14–17](../src/fifo-cost.js#L14), [43–72](../src/fifo-cost.js#L43).
- **Kök neden:** Katman yeniden oynatımı miktarlı hareketlere dayanıyor; alış fiyat düzeltmesi/yalnız değer etkisi ilgili katmanın efektif maliyetine bağlanmıyor.
- **Tekrar / kanıt (S+K):** Kabul ve satıştan sonra alış fiyat düzeltmesi yap; FIFO'yu çalıştır. İlgili maliyet etkisi hesaba katılmıyor. 2 × 100 TL net alışa 40 TL indirim ve 1 adet satış örneğinde satış/stok 100/60 çıkıyor; 80/80 olmalı.
- **Çözüm:** Etkin alış düzeltmelerini kaynak katmana ve kapsamına bağla; yalnız değer hareketini açıkça işle. Satılan/kalan payı düzeltme türüne göre dağıt; ters kayıt aynı bağı izlesin.
- **Kabul testi:** Artış, azalış ve ters kayıtta satılan maliyet + stok değeri düzeltilmiş toplamı verir; miktar değişmez; ikinci FIFO sonucu korur.

### R13 — P1: Ürün kârlılığı bilinmeyen maliyet/gideri sıfırlıyor

- **Konum:** [urun-karlilik-api.js:44–60](../src/urun-karlilik-api.js#L44); açık maliyet karşılığı [performance-api.js:30](../src/performance-api.js#L30).
- **Kök neden:** Ürün hesabı açık maliyet/tahmin durumunu ortak kâr hesabından almıyor. Tahmin yoksa gider 0, kesinti KDV'si varsayılan oran oluyor.
- **Tekrar / kanıt (S+K):** Maliyet/kesinti bilinmeyen fixture'larda performans `null` iken ürün kârı 70,68 veya 76,80 TL çıkıyor.
- **Çözüm:** Ortak paket sonucunu ürünlere dağıt; maliyet/gider bilinme durumu, tahmin kaynağı ve nedeni korunmalı. Bilinemeyen payı toplamda sıfırlama; hesaplanan kısım ve eksik kapsamı birlikte ver.
- **Kabul testi:** İki tekrar dört görünümde aynı kapsamda aynı belirsizliği üretir. Güvenilir tahmin gelince hepsi aynı tutar ve tahmini işaretine geçer; gerçek sıfır gider belirsizden ayrılır.

## 6. P2 bulgular

### R14 — P2: İlk kısmi iade kalan iadeyi engelliyor (A5)

- **Konum:** [report-inbox-api.js:831–836](../src/report-inbox-api.js#L831).
- **Kök neden:** Herhangi bir satırda iade bulunması tüm paketi atlatıyor; kümülatif iade/kalan miktar hesaplanmıyor.
- **Tekrar / kanıt (S+K):** Kısmi iadeden sonra kalan adedi kapsayan yeni rapor getir. İkinci işlem “zaten girilmiş” diye atlanıyor.
- **Çözüm:** Gerçek iadeleri ve olay tahsislerini satır bazında düşüp kalan miktarı hesapla; teknik DUZ kayıtlarını ayır. R04 tekil olay tahsisini paylaş.
- **Kabul testi:** Parçalı iki iade satışı aşmadan tamamlanır; rapor tekrarı ilave iade üretmez; bir satırın iadesi diğerini kilitlemez.

### R15 — P2: 0047 tarihsel doldurma ilk kabulü kapasitesiz kullanıyor (F9)

- **Konum:** [0047_open_cost.sql:110–116](../migrations/0047_open_cost.sql#L110).
- **Kök neden:** Her açık satış bağımsız ilk sonraki girişi seçiyor; önceki kapanışların kaynak miktar tüketimi izlenmiyor. Toplam stok değeri kontrolü kaynak kapasitesi değildir.
- **Tekrar / kanıt (S+K):** Birden fazla tarihsel açık satışı aynı ilk girişe yönelten migration fixture'ında giriş kapasitesi aşılabiliyor. Tam terslenmiş canlı sıfır maliyetli satışlar bunun kanıtı değildir.
- **Çözüm:** Uygulanmış eski migration'ı değiştirerek canlıyı onarmaya çalışma. Yeni migration/onarım akışında kaynakları tarih sırası ve kalan kapasiteyle tahsis et; yanlış geçmiş tahsisleri denetlenebilir düzeltmeyle uzlaştır.
- **Kabul testi:** Hiçbir girişin kapanışları kapasiteyi aşmaz; sonraki giriş doğru sırada kullanılır; tam terslenmiş satış açılmaz; ikinci onarım etkisizdir.

### R16 — P2: Kısmi iadeler son kuruşu kaybediyor (F10)

- **Konum:** [fifo-cost.js:85–86](../src/fifo-cost.js#L85).
- **Kök neden:** Her iade bağımsız yuvarlanıyor; önceki iadelerin tüketimi ve son iadeye kalan maliyet izlenmiyor.
- **Tekrar / kanıt (S+K):** 3 birimlik, toplam 100 kuruş maliyetli satışı birer birer iade et: 33+33+33=99.
- **Çözüm:** Kümülatif tahsis veya son iadeye kalan kuruş yöntemi. Önceki paylar ve toplam satış maliyeti korunmalı.
- **Kabul testi:** Üç iade toplamı tam 100 kuruş; son miktarda maliyet bakiyesi sıfır. Farklı parçalara bölme ve yeniden çalıştırma toplamı değiştirmez.

### R17 — P2: TY stopajı ürün kârlılığından eksik

- **Konum:** [urun-karlilik-api.js:29–32](../src/urun-karlilik-api.js#L29).
- **Kök neden:** Gerçek stopaj sorgusu yalnız `hepsiburada` paketlerini seçiyor.
- **Tekrar / kanıt (S+K):** TY satışına stopaj olayı eklenen fixture'da 14,48 yerine 15,48 TL. **Canlı TY stopaj olayı yok; mevcut canlı kayıp değil, gelecekte bu veri gelince görünür olacak hatadır.**
- **Çözüm:** Desteklenen kanalların stopajını doğru mağaza/sipariş bağlamında ortak hesap yolundan al; gerçek olay varken tahminle değiştirme.
- **Kabul testi:** TY ve HB stopajı tüm kâr görünümlerinde bir kez düşer; aynı sipariş numarası farklı kanallarda birbirine karışmaz.

### R18 — P2: İkiz stopajı ikiye bölünüp tek pay sayılıyor

- **Konum:** [performance-api.js:28](../src/performance-api.js#L28), [105](../src/performance-api.js#L105), [195](../src/performance-api.js#L195).
- **Kök neden:** Payda fiziksel paket kayıtlarını sayıyor; DUZ birleştirmesinden sonra tek ekonomik paket kalıyor.
- **Tekrar / kanıt (S+K):** Asıl/kopya, DUZ ters kaydı ve stopaj oluştur. İkiye bölünen stopajın yalnız tek payı nakit sonuca giriyor.
- **Çözüm:** Teknik ikizleri ekonomik paket kimliğiyle birleştirip sonra stopaj tahsis et. Gerçek bölünmüş paketleri ikiz sayma; kalan kuruşu koru.
- **Kabul testi:** İkizli sipariş ve gerçek iki paketli siparişin tahsis toplamları ayrı ayrı finans olayına eşittir. 6 canlı DUZ örneği silinmeden uzlaştırma adayları olarak incelenir.

### R19 — P2: Panorama ilk teslimden önceki iadeyi kaçırıyor

- **Konum:** [panorama-api.js:72–81](../src/panorama-api.js#L72), dönem başlangıcı [93](../src/panorama-api.js#L93).
- **Kök neden:** Başlangıç yalnız ilk teslim; daha erken iade tarihiyle sonuçlanan teslim edilemeyen paketler dışarıda.
- **Tekrar / kanıt (S+K):** İlk teslimden önce tamamen dönmüş paket: performans −61,32 TL, panorama kapsamında 0.
- **Çözüm:** İlk tarihi teslim ve gerçek tamamlanmış iadelerin birleşiminden bul; kart, grafik ve toplam aynı olay tarihini kullansın. Hiç teslim yok ama iade var durumunu kapsa.
- **Kabul testi:** −61,32 TL doğru dönem/tüm zamanlar toplamına girer; teslimsiz-iadeli veri boş görünmez; DUZ teknik iadeleri gerçek sonuçlanma sayılmaz.

### R20 — P2: İade sorgusu 102. kaydı sessizce düşürüyor

- **Konum:** [performance-api.js:41–43](../src/performance-api.js#L41).
- **Kök neden:** `LIMIT 101` sonrası taşma kontrolü veya devam sayfası yok.
- **Tekrar / kanıt (S+K):** Aynı aralıkta 102 uygun tamamlanmış iade oluştur; son kayıt ve tutarı toplamdan kayboluyor.
- **Çözüm:** Kararlı tarih+ID imleciyle tamamını al veya açık kapsam/taşma durumu döndür. Toplam ucu eksik veriyi tam toplam gibi sunmamalı.
- **Kabul testi:** 100/101/102 sınırlarında miktar ve kuruş toplamı doğru; sayfalar arasında tekrar/eksik yok; aynı güne yığılmış kayıtlar da kapsanır.

### R21 — P2: 1001 bekleyen paket tüm panoramayı bozuyor

- **Konum:** [panorama-api.js:112](../src/panorama-api.js#L112), sınır [performance-api.js:31–32](../src/performance-api.js#L31).
- **Kök neden:** Bekleyenlerin tüm tarihi tek çağrıya gidiyor; 1000 sınırının 409 hatası bütün yanıtı kesiyor.
- **Tekrar / kanıt (S+K):** 1001 bekleyen paketle panoramayı çağır; gerçekleşen dönem kartları da engelleniyor.
- **Çözüm:** Bekleyenleri kararlı imleçle/parçalarla al; tek güne yığılmayı da çöz. Eksik bölümün kapsamını açık döndür, hazır bölümleri koru; eksik toplamı sıfır yapma.
- **Kabul testi:** 1000/1001 ve aynı güne yığılmış 1001 paket doğru sayılır; diğer kartlar kullanılabilir kalır; paket iki kez eklenmez.

### R22 — P2: Sipariş penceresi/listesi kesinti tahminini paylaşmıyor

- **Konum:** [order-insights-api.js:53–57](../src/order-insights-api.js#L53).
- **Kök neden:** Yerel nakit hesabı bütün gerçek kesintileri bekliyor; performansın geçmişten tahmin yolu paylaşılmıyor.
- **Tekrar / kanıt (S+K):** Gerçek kesintisi eksik, güvenilir geçmişi olan pakette performans 15,48 TL; ayrıntı/liste `null`.
- **Çözüm:** Ortak paket sonucunu tutar, tahmin kaynağı ve eksik sebebiyle sun. Ön yüz ikinci kâr formülü kurmasın; ekstre geldiğinde bütün görünümler birlikte gerçeğe geçsin.
- **Kabul testi:** Aynı paket bütün görünümlerde 15,48 TL ve “tahmini”; geçmiş yoksa ortak eksik nedeni. Gerçek kesinti gelince tutar ve rozet birlikte güncellenir.

### R23 — P2: Fiyat önerisinde adet uyumsuz kargo ve eksik profil gideri

- **Konum:** [fee-history.js:68–75](../src/fee-history.js#L68), [fiyat-hesap-api.js:22](../src/fiyat-hesap-api.js#L22), [35–42](../src/fiyat-hesap-api.js#L35); gider alanları [pricing-api.js:39](../src/pricing-api.js#L39).
- **Kök neden:** “En yakın adet” seçiminde uygunluk sınırı/paket ölçeği yok; seçilen kargo sabit tutar olarak kullanılıyor. Ayrıca fiyat ucu `packaging_cents` ve profil `other_cents` alanlarını okumuyor. Önceki nihai listedeki tek fiyatlandırma bulgusunun iki alt hata yoludur.
- **Tekrar / kanıt (S+K):** Yalnız 1 adetlik geçmiş varken 100 adet için fiyat iste: tek adet kargosu kullanılıyor. Aynı koşullarda pozitif paketleme/diğer profil gideri tanımla: bu giderler sonuçtan düşülmüyor.
- **Çözüm:** Adet/paket/desi uyumu ve güven sınırı ekle; doğrulanmış çoklu paket modeli yoksa kesin öneriyi durdur veya açık senaryo sun. Körlemesine 100 ile çarpma. Profil giderlerini birim/paket ve KDV sözleşmesine göre bir kez ekle; pazaryeri hizmetiyle çift sayma. Başabaş ve hedef aynı gider kırılımını kullansın.
- **Kabul testi:** 1→100 örneği tek paket kargosuyla kesin fiyat vermez; uyumlu çoklu paket geçmişi doğru çalışır. Yalnız profil gideri artırılınca aynı fiyattaki nakit sonuç düşer, başabaş/hedef yükselir. Sıfır gider, çoklu adet ve hizmetin çift sayılmaması ayrıca doğrulanır.

### R24 — P2: İlk 10 hatalı dosya sağlıklı 11. dosyayı engelliyor (A6)

- **Konum:** [otomatik-bakim.js:34–36](../src/otomatik-bakim.js#L34).
- **Kök neden:** Her tur aynı en eski 10 dosya; hata sonrası bekleme zamanı veya ilerleyen imleç yok.
- **Tekrar / kanıt (S+K):** İlk 10 sürekli hatalı, 11. sağlıklı dosyayla birkaç bakım turu: 11. seçilmiyor.
- **Çözüm:** Deneme sayısı/sonraki deneme zamanı ve gerekçeli inceleme durumu; adil sıra veya imleçle ilerleme. Dosyayı silme/işlendi sayma; süre bütçesini koru.
- **Kabul testi:** İlk 10 hata sürerken 11. sınırlı tur içinde tamamlanır; hatalılar görünür/yeniden denenebilir kalır; tarayıcı/cron yarışı R01'i bozmaz.

### R25 — P2: Yeni uçların yetki rota eşlemeleri eksik

- **Konum:** [permission-policy.js:15](../src/permission-policy.js#L15), [24](../src/permission-policy.js#L24); yönetici erken dönüşü [4](../src/permission-policy.js#L4).
- **Kök neden:** `pricing` ve `stock` yetki eşlemeleri var; yeni `fiyat-hesap` ve `urun-karlilik` rota başlıkları haritada yok. Yetkili personel `!feature` nedeniyle 403 alıyor; owner erken dönüşü sorunu yönetici testinde gizliyor.
- **Tekrar / kanıt (S+K, saf fonksiyon):** Ana ajan rota-yetki karşılaştırmasını saf fonksiyonla doğruladı: fiyat okuma yetkili personelde pricing yolu geçerken fiyat-hesap; stok okuma yetkilide ürün kârlılığı yolu reddediliyor, owner geçiyor. Kısa rota gösterimleri `/api/pricing`, `/api/fiyat-hesap`, `/api/urun-karlilik`; sunucu yetki kontrolünde e-ticaret yolları `/api/ec/...` ve mevcut giriş fonksiyonu `permit` kullanılır. Canlı personel oturumu testi yapıldığı iddia edilmiyor.
- **Çözüm:** `fiyat-hesap` için `pricing`, `urun-karlilik` için ilgili stok okuma yetkisi eşlemesini açık ekle; çalışma alanı, HTTP yöntemi ve tutar gizleme kurallarını koru. Bilinmeyen rotaları genel olarak serbest bırakma veya owner yolunu personele açma.
- **Kabul testi:** Fiyat/stok okuma yetkili personel ilgili GET uçlarını kullanır; yetkisiz personel 403 alır. Okuma yetkisi yazmaya dönüşmez; tutar yetkisi olmayan yanıtlarda gizleme korunur; owner davranışı aynı kalır. Hem saf `permit` hem istek yönlendirme entegrasyonu denenir.

## 7. UI iyileştirmeleri ve ana ajanla iş bölümü

Görsel düzenlemeler yerel projede tamamlandı; canlıya yayınlanmadı. Claude değişen dosyaları ve görsel kabul kanıtını [Tasarım Raporu](TASARIM-RAPORU-2026-09-19.md) üzerinden devralmalıdır. Mevcut UI değişikliklerini koruyarak backend çözümlerini bu veri sözleşmelerine bağlamalıdır.

Bu belgenin UI için veri/davranış kabul şartları:

- **Tutarın durumu:** Gerçekleşen, tahmini ve veri eksik ayrımı bütün kâr yüzeylerinde aynı. `null`, `0,00 TL` diye biçimlendirilmemeli; kısa neden ve ilgili belge/işleme geçiş gösterilmeli.
- **Kırılım:** Satış, maliyet, komisyon, kargo, hizmet, stopaj; fiyat önerisinde ayrıca paketleme/diğer giderler anlaşılır KDV dahil kalemler olmalı. “Cebine kalan” ortak giderler/gelir vergisi sonrası işletme net kârı diye sunulmamalı.
- **Dönem/kapsam:** Teslim edilen, iade tarihiyle sonuçlanan ve kargodaki tahmin ayrılmalı. Limit veya bölüm hatası eksik toplamı tam göstermemeli; hazır kartlar kullanılabilir kalmalı.
- **Tahmin şeffaflığı:** Kaynak kanal, örnek sayısı, adet/paket uyumu ve maliyet tarihi erişilebilir olmalı. Fiyat önerisinin varsayımları yanında gösterilmeli.
- **Okunabilirlik:** Dar ekranda yatay kaydırmasız etiket/değer düzeni; tam ürün adı; siparişin son dört hanesiyle eşleştirme. Uzun iç ID ana başlık olmasın; zarar yalnız renkle değil eksi işareti ve metinle anlaşılsın.
- **Otomasyon durumu:** Bekleyen, yeniden denenecek ve gerçekten kullanıcı kararı gerektiren kayıt ayrılmalı. Hatalı iş tamamlandı görünmemeli; normal akışı operatöre elle tekrarlatmak çözüm değildir.
- **Yetkili personel:** Fiyat/stok ekranı okunabiliyorsa arka plandaki ilgili GET de aynı yetkiyle çalışmalı. R25 çözümü para gizleme veya yazma yetkisini genişletmemeli.
- **Görsel kabul:** Dar/geniş ekran, boş/yükleniyor/hata, klavye odağı, tahminden gerçeğe geçiş ve dört ekranda aynı paket tutarı kontrol edilmeli. Yeni düzen muhasebe farkını gizlememeli.

Ana belgedeki eski sipariş ekranı sınırından sonra kullanıcı bu oturumda arayüzü bütünüyle inceleyip düzeltme yetkisi verdi. Sipariş penceresindeki yerel düzenlemeler tasarım raporunda kayıtlıdır. R22 veri sözleşmesi ayrıca düzeltilmelidir.

## 8. Claude uygulama, veri onarımı ve yayın planı

### Faz 0 — Aktif durumu ve dosya sahipliğini koru

Dal/HEAD ve `git status` yeniden doğrulanmalı. İlk okumada mevcut ilgisiz değişiklikler: [.node-version](../.node-version), [migrate-remote.mjs](../scripts/migrate-remote.mjs), [recovery.mjs](../scripts/recovery.mjs); ayrıca `.claude/`, [Sistem Raporu](SISTEM-RAPORU-2026-09-19.md), [kart-idleri.json](../kart-idleri.json) ve iki devir notu: [02:06](../thoughts/shared/handoffs/lunapot-panel/2026-09-19_02-06_maliyet-duzeltme-ana-sayfa-tasarim.yaml), [12:08](../thoughts/shared/handoffs/lunapot-panel/2026-09-19_12-08_genel-durum-kar-raporu-liste.yaml). Bunlar rapor tarafından oluşturulmadı/değiştirilmedi; reset, temizleme, toplu stage veya üzerine yazma yapılmamalı. Ana ajanın bu sıradaki UI değişiklikleri de korunmalı.

### Faz 1 — Önce kırmızı regresyon testleri

R01–R25 kabul senaryolarını kalıcı, deterministik testlere dönüştür. Uygun başlangıçlar: [rapor kutusu](../tests/report-inbox.test.js), [rapor siparişleri](../tests/report-inbox-orders.test.js), [stok bağlantısı](../tests/report-stock-link.test.js), [FIFO](../tests/fifo-maliyet.test.js), [muhasebe](../tests/accounting.test.js), [mal kabulü](../tests/receipts.test.js), [alış otomasyonu](../tests/alis-otomatik-tamamla.test.js), [alış iadeleri](../tests/purchase-returns.test.js), [paket kârı](../tests/package-profit.test.js), [panorama](../tests/panorama.test.js), [ayrıntı](../tests/order-insights.test.js), [fiyat](../tests/pricing.test.js), [bakım](../tests/otomatik-bakim.test.js), [yetki](../tests/permissions.test.js), [tutar gizleme](../tests/amount-permission.test.js).

Sadece mesajı veya uygulamanın kendi formülünü tekrar eden test yazma. Son stok miktarı/değeri, satış/iade maliyeti, kaynak kapasitesi, denetim kayıt sayısı ve ekranlar arası kuruş eşitliğini ölç. Yarışları okuma/yazma bariyeriyle, yarım işlemi belirli adıma hata enjeksiyonuyla üret. D1'e özgü davranışlar ayrı test ortamında doğrulanmalı; canlıya sentetik kayıt yazılmamalı.

### Faz 2 — Kaynak düzeltmeleri ve ortak hesap sözleşmesi

Önce R01–R03; sonra stok/iade ve FIFO grupları. Açık maliyet, iade ve geçici katman birbirinden kopuk yamalar olmamalı. Ortak refaktör birden çok bulguyu kapatabilir; her bulgunun testi ayrı kalmalı. R13/R17/R18/R22 ortak paket kârı/tahsis, R19–R21 ortak kapsam/sayfalama üzerinden; R23 fiyat güveni ve gider kırılımıyla çözülmeli. R24 ilerlemeyi, R25 mevcut yetkilerin doğru rota karşılığını tamamlamalı.

Eski migration dosyasını değiştirmek uygulanmış veritabanını düzeltmez. Şema/tetikleyici değişiklikleri yeni sıralı ve geçiş boyunca uyumlu migration olmalı. [Sistem Raporu §2](SISTEM-RAPORU-2026-09-19.md) içindeki D1/migration ayrıştırma kısıtları korunmalı.

### Faz 3 — Canlı veri için salt-okunur etki listesi

Kod düzelince geçmiş veri kendiliğinden doğru sayılmaz. Ayrı önizleme, kaynak kimlikleriyle şu adayları çıkarmalı: çok paketli iade tahsisleri, gönderimsiz sayım telafileri, yarım kabul/kapanış, kapasite aşan settlement, yanlış ters katman, fiyat/geçici maliyet farkları, miktar-değer uyuşmazlığı ve ikiz stopaj payları.

Her aday: ürün/paket/satış/kaynak kimliği, mevcut/beklenen miktar-değer, kanıt belge/olayı, düzeltme türü ve önce/sonra farkı. **Aday olmak otomatik hata kanıtı değildir.** Tam terslenmiş sıfır maliyetli satışları ve DUZ kayıtlarını körlemesine onarma. %10 KDV'li 9 satırı belge ve brüt/net ilişkisiyle ayrıca uzlaştır; doğrulanmış brüt geliri ve özgün izi koru.

### Faz 4 — Test kopyasında onarım provası

Yedek/snapshot ve geri dönüş planıyla önce canlı dışı kopyada prova. Düzeltmeler sabit mantıksal işlem kimliğiyle tekil; kesilme sonrası devam edebilir olmalı. İkinci tam çalışma yeni fark yaratmamalı. Önce/sonra stok, açık maliyet, net satış/iade, kanal/paket kâr toplamları birlikte uzlaştırılmalı. `dirty=0` sadece kuyruk sonlandırma kontrolüdür; doğruluk ölçütünün yerine geçmez.

### Faz 5 — Kontrollü yayın ve ayrı veri onarımı

Bu faz **uygulanmadı**. Önce kod, migration, test sonuçları, onarım önizlemesi ve geri dönüş adımları somut teslim edilmeli. Üretim uygulaması mevcut kullanıcı yetkisi ve yayın süreci kapsamında ayrıca yürütülmeli.

- `npm test` tamamı geçmeli; yeni regresyonlarla test sayısı artabilir. Eski 552'nin geçmesi tek başına kapanış değildir. Ana UI tesliminin final koşusu ayrıca kaydedilmeli.
- [package.json](../package.json) içindeki `npm run build` kuru derleme kontrolü; D1 parametre/batch sınırları hedef çalışma ortamında doğrulanmalı.
- Ana belgeye göre `main` push'u yayını tetikler; sıradan yedekleme değildir. Gerekli migration koddan önce uyumlu sırada planlanmalı; eski/yeni worker geçişinde şema uyumu korunmalı.
- Onarım sırasında cron ve tarayıcı yazmaları kontrol edilmeli. R01/R02 çalışmadan toplu tekrar başlatılmamalı. Bu rapor hiçbir canlı DB yazma veya deploy komutunu çalıştırmaz.
- UI yayını varsa [sw.js](../public/sw.js) önbellek sürümü ve tasarım raporu kontrolleri birlikte ele alınmalı.
- Yayın sonrası sürüm/sağlık, örnek paket-ürün uzlaşması, kuyruk ilerlemesi ve hata sayıları doğrulanmalı. Geri dönüş audit kayıtlarını silmek değil, uyumlu kod dönüşü ve gerekiyorsa telafi kaydıdır.
- Tamamlanmayan güvenlik kapsamı ayrıca takip edilmeli; R25'in düzelmesi tam güvenlik denetimi anlamına gelmez.

## 9. Torf 20 L koşullu fiyat örneği

Ana raporun eski örneğinde maliyet 204 TL, başabaş yaklaşık 452 TL ve +50 TL hedef yaklaşık 513 TL idi. Önceki incelemeden aktarılan **son alış maliyeti 228 TL KDV dahil** kabulüyle, aynı ücret/oran varsayımlarında başabaş **~481 TL**, +50 TL hedef **~543 TL** oluyor.

Bunlar koşullu örneklerdir. R23 gider ve adet/kargo uyumu kontrol edilmeden ilanlara uygulanmamalı. Tam komisyon/stopaj/kargo/hizmet girdi dökümü bu devirde bulunmadığından Claude güncel girdilerle yeniden üretip yanında göstermeli; sayıları sabit iş kuralı veya kanallar arası ortak fiyat yapmamalı. Son alışın 228 olması eski FIFO satışını 228'e taşımak için gerekçe değildir.

## 10. Claude'a net devir ve kapanış sözleşmesi

1. Ana belgenin §0/§5 kurallarını, bu raporu ve ayrı tasarım teslimini oku; aktif HEAD/dosya sahipliğini doğrula. Claude raporu beklemektedir; backend uygulamasının yapılmış olduğu varsayılmamalı.
2. R01–R25 kimliklerini koru. Her madde için önce başarısız regresyon, sonra düzeltme/geçen test ve gerekiyorsa veri onarım planını göster.
3. P1'leri kapat; ertelenen P2 için gerekçe/takip bırak. Kaynak düzeltmesi ile canlı onarımı ayrı durumlar olarak bildir.
4. Teslim edilen UI düzenini koru; hesap API sözleşmesini tasarım teslimiyle eşleştir. Yeni değişiklikten önce güncel çalışma ağacını kontrol et.
5. Son teslimde **backend kodu / UI / test / canlı onarım / yayın / güvenlik** durumlarını ayrı raporla. Yapılmayan adımı tamamlandı gösterme.

Kapanış ölçütleri: yeni regresyonlar ve tam takım başarılı; tekrar/eşzamanlılık güvenli; kaynak kapasitesi, miktar/değer ve kuruş toplamları korunmuş; aynı kapsamda dört kâr görünümü eşit; veri onarımının ikinci koşusu etkisiz; UI, yayın ve güvenlik durumu ayrı kanıtlarıyla açık. **Bu rapordaki backend bulguları henüz düzeltilmedi; belge uygulanacak işi devreder.**
