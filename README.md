# Lunapot OS 2.3

## 2.4 — E-ticaret stok ve alış düzeltmeleri

- Ürün alışlarında kısmi tedarikçi iadesi stok ve cari borcunu tek işlemde günceller. İade bedeli faturadan orantılı hesaplanır; stoktan güncel ağırlıklı maliyet çıkar. Aradaki fark Genel giderler ekranında ayrı, işaretli düzeltmedir; kanal satış katkısına yüklenmez. Resmî iade faturası düzenlenmez. Hizmet/fiyat farkı/iskontolu iade ve henüz teslim alınmamış alışın iptali bu akışa dahil değildir.
- İade geri alma geçmişi korur. İadeye bağlı cari kapama varsa önce bu kapama geri alınmalıdır. Yanlış mal teslimi güvenli stok ve maliyet koşullarında ters kayıtla düzeltilir; fatura borcu değişmez, tekrar teslim miktarı açılır. Satılmış veya ayrılmış stok korunur.
- Alış faturaları 50li sayfalarda tüm geçmişten aranabilir; fatura, ETTN, tedarikçi ve durum/teslim bekleyen filtreleri vardır. Taslaktan vazgeçme ekranda erişilebilir.
- Stokta eldeki, ayrılan ve kullanılabilir miktarlar ayrıdır; ürün/kod araması, kritik stok filtresi ve Türkçe ondalıklı CSV dışa aktarımı vardır. Sayım sırasında değişen stok eski sonuçla ezilmez.
- 0019 yalnızca e-ticarete yeni günlükler/görünümler ekler ve gelecekteki teslim doğrulamasını günceller; mevcut ticari kayıtları dönüştürmez.

TY/HB/EDM gerçek bağlantıları kullanıcıyla en son yapılacaktır. Otomatik yedek geri yükleme ve çalışan yetkileri halen ayrı geliştirme işleridir.

Mobil ve web uyumlu, Cloudflare Workers + D1 üzerinde çalışan iki ayrı iş alanı.

Adresler: [Uygulamalar](https://lunapot-panel.lunapot-os.workers.dev/) · [Lunapot Üretim](https://lunapot-panel.lunapot-os.workers.dev/uretim/) · [E-Ticaret](https://lunapot-panel.lunapot-os.workers.dev/eticaret/).

- **Uygulamalar** (/): büyük simgeli ortak giriş, iki ayrı çalışma alanına geçiş. Eski /#dashboard gibi üretim bağlantıları /uretim/ altına taşınır. Her panelde ana ekrana dönüş vardır.
- **Lunapot Üretim** (/uretim/): ürünler, hammaddeler, reçeteler, üretim maliyeti, alış/stok ve cari.
- **E-Ticaret** (/eticaret/): torf ve zirai ürünler; sipariş, stok ayırma, kargoya verme, satış kârlılığı, cari/nakit, alış ve mal teslimi.
- Lunapot AI kapalı; ücretli AI servisi bağlı değil.

## Çalışan özellikler
- Tek gerçek stok kartına farklı tedarikçi/ilan kodları; tedarikçi ve fatura birimine özel dönüşüm, açıkça tanımlanmış tam ad bağlantısı.
- Sanal setler (2×A veya A+2×B); tüm bileşenlerde atomik rezervasyon/gönderim, eski siparişlerde değişmeyen eşleştirme sürümleri.
- Sipariş ayrıntı penceresi: gider grafiği, stok bileşenleri, müşteri/fatura bilgileri, son mal teslimleri, yerel satış faturası taslakları. Taslak resmî fatura değildir.
- ec/lp için ayrı ürün, stok, fatura, cari, banka/kasa defterleri.
- Tarihli komisyon/kargo baremleri, paket ölçüsü ve ağırlığı, açık KDV ayrımı, tahmini katkı kârı ve barem değişimlerini dikkate alan taban fiyat.
- Eksik tarife/maliyet bilinmiyor olarak kalır; sıfıra çevrilmez.
- Fatura muhasebeleştirme ile fiziksel mal teslimi ayrı; kısmi teslim, ağırlıklı ortalama stok maliyeti, iadeler, sayım farkı.
- Müşteri/tedarikçi/pazaryeri carileri, kısmi eşleştirme, kasa/banka hareketi ve izlenebilir ters kayıtlar. Gerçek banka transferi yapılmaz.
- Fatura UUID ve tedarikçi vergi numarası/fatura numarasıyla alanlar arası mükerrer kontrolü. XML alıcı VKN'si alanın şirketiyle doğrulanır.
- Satış kesintisi faturalarının satırlara dağıtılması; genel giderde tekrar sayılmasının önlenmesi.
- Yönetici oturumu, CSRF koruması, giriş deneme sınırı, güvenli bağlantı kasası, PWA arayüz önbelleği. İş verileri çevrimdışı saklanmaz.

## Bağlantıların gerçek durumu
Trendyol V2 siparişleri ve finans kayıtları ile Hepsiburada sipariş/finans/komisyon servisleri için sınırlı sayfalı, salt okunur bağlantı kodu vardır. Erişim anahtarları AES-GCM ile saklanır. Gerçek mağaza anahtarlarıyla canlı doğrulama yapılmadan bağlantı çalışıyor sayılmaz.

Trendyol siparişleri önce inceleme taslağına gelir. HB kayıtları kaynak gelen kutusundadır; otomatik paket veya muhasebe kaydı oluşmaz. Finans kaynak kayıtları otomatik banka tahsilatı değildir. Tarife gözlemi, gelecekteki haftalık tarife garantisi değildir. EDM üretim SOAP adresi ve API hakkı doğrulanana kadar canlı bağlantı kapalıdır; standart UBL XML içe aktarımı kullanılabilir. Zamanlanmış otomatik çekim etkin değildir. Değişen kaynak siparişleri ve desteklenmeyen vergi/fatura yapıları inceleme gerektirir.

Ücretsiz D1 sınırları için paketler en fazla 10 ilan satırı ve toplam 20 stok bileşenidir. Büyük içe aktarımlar sayfalar halinde yürütülür. 25.000 satıra kadar iş verisi dışa aktarımı vardır; otomatik geri yükleme yoktur. Lunapot reçete ekranı referans fiyatlarla tahmin yapar. Üretim kayıtları ise gerçekleşen hammadde tüketimini stok maliyetinden düşürür ve mamul girişini oluşturur.

## Yerel çalışma
Node.js 22+ gerekir (testlerde node:sqlite kullanılır).

    npm ci
    npx wrangler d1 migrations apply DB --local
    npm run dev
    npm test
    npm run build

.dev.vars dosyasına yalnızca yerel ortam için SETUP_TOKEN ve CREDENTIAL_KEY eklenir. CREDENTIAL_KEY 32 rastgele baytın 64 karakter hex gösterimidir. Anahtarlar kaynak kontrolüne dahil edilmez. İlk yönetici /#setup=KURULUM_ANAHTARI üzerinden kendi en az 12 karakterlik şifresini belirler.

## Cloudflare yayını
1. Ücretsiz Workers hesabında lunapot-db adlı D1 veritabanı oluştur.
2. wrangler.jsonc içindeki database_id alanını gerçek kimlikle değiştir.
3. Üretim SETUP_TOKEN ve CREDENTIAL_KEY değerlerini Wrangler secret olarak sakla.
4. npm run db:remote ardından npm run deploy çalıştır.
5. İlk yöneticiyi kişisel şifreyle oluştur; HTTPS ve korumalı API'leri doğrula.

Üretim hesabı ve D1 kimliği wrangler.jsonc içinde sabitlenmiştir. preview_database_id yalnızca mevcut yerel geliştirme veritabanı kimliğini korur; uzak önizleme veritabanı kurulmamıştır. Üretim sürüm önizleme adresleri kapalıdır.

GitHub `dekovillmimarlik-creator/lunapotOS` deposunun `main` dalı Cloudflare Workers Builds'e bağlıdır. Her gönderimde `npm test && npm run build` başarılı olursa `npx wrangler deploy` çalışır. Diğer dalların yayınları kapalıdır. Yeni veritabanı geçişleri otomatik yayın komutuna dahil değildir; uyumlu geçişleri kodu göndermeden önce `npm run db:remote` ile uygulayın. Derleme Node.js sürümü `.node-version` dosyasında sabitlenmiştir.

Uzak D1 sorgu uç noktası bazı trigger gövdelerini ayırırken `incomplete input` hatası verdiği için `db:remote` geçişleri resmî SQL dosyası içe aktarımıyla uygular. Her dosyanın geçiş kaydı aynı içe aktarımın içindedir; hata halinde dosya geri alınır. Komut yalnızca bekleyen dosyaları çalıştırır. Aynı anda birden fazla geçiş işlemi başlatmayın. Yerelde standart `db:local` kullanılabilir.

Ücretli plan, alan adı veya AI aboneliği gerekmez. Sağlayıcı ücretsiz kotaları ve pazaryeri/EDM servis hakkı kendi hesabında geçerlidir. Yerel test veritabanı (.wrangler veya work/) kesinlikle üretime kopyalanmaz.

## Güvenli işletim
Kaynak kodu ticari veri veya mağaza anahtarı içermez. İşlem geçmişi silinerek düzeltilmez; desteklenen ters kayıt/iade akışları kullanılır. Başlangıç stoğu ve tüm fiziksel hareketler kaydedilmeden depo doğruluğu varsayılmaz. Finans sonuçları tahsilat bakiyesinden ayrıdır; stopaj ve KDV işletme kârı gibi gösterilmez.

Testler gerçek müşteri/mağaza verisi olmadan yalıtılmış SQLite üzerinde çalışır. Canlı sağlayıcı testleri ve Worker CPU ölçümü yayın sonrası yapılmalıdır.

Paket tahmini 1–10 farklı ilan satırını, farklı KDV/komisyonları ve set bileşenlerini destekler. Kargo baremi toplam paket tutarından bir kez seçilir; komisyon her ilanın kendi SKU ve satır tutarından hesaplanır. Sabit işlem/ambalaj gideri paket başınadır. Karma pakette fiyatların ilanlara nasıl dağıtılacağı bilinmediğinden tek bir alt satış fiyatı verilmez; tek ilan/set için alt fiyat araması korunur.

Önceki 2.1 sürümü doğrulaması: 65 otomatik test, gerçek yerel D1 geçişleri ve ayrı tarayıcı test ortamında set tanımı, sipariş, gönderim, fatura dönüşümü ve taslak hazırlama. 9 Eylül 2026'da Cloudflare'a yayınlandı; 14 üretim geçişi, boş yabancı anahtar hata listesi, HTTPS sayfaları ve girişsiz API isteklerinde 401 doğrulandı. İlk yönetici şifresini hesap sahibi oluşturur. Canlı mağaza/EDM bağlantıları henüz doğrulanmadı.

## 2.2.0 — teslimat ve tahmin ayrımı
Ana sayfa ve Kanal kâr / zarar ekranı teslim edilmiş paketlerin kayıtlarını kullanır; TY ve HB ayrı kartlardadır. Kesintisi eksik paketler ve dağıtılmamış kesinti faturaları varsa sonuç tamamlanmış gösterilmez. Teslim tarihine göre seçilen paketlerin sonradan işlenen iadeleri de hesaba dahildir. Ortak işletme giderleri ve gelir/kurumlar vergisi bu satış katkısı raporuna dağıtılmaz.

Hazırlık/kargodaki tahminler ayrı sekmededir ve sipariş tarihine göre süzülür. Başarılı paket hesabı ölçü ve gider varsayımlarını saklar. Aynı kanal, ilan kodu, adet ve gerçek stok bileşenleri için bu varsayımlar öğrenilmiş paket şablonu olarak tekrar kullanılabilir. Stok maliyeti ve tarifeler rapor açılışında yeniden hesaplanır; gönderilmiş pakette sabit gönderim maliyeti ve gönderi tarihinin tarifesi kullanılır. Kaynak veya içerik değişmişse önceki paket varsayımları kullanılmaz. Farklı adetlerin ölçüsü kendiliğinden ölçeklenmez.

İş listesi tüm verilerde eşleşme, teslim, stok, kesinti ve tarife eksiklerini sayar. Kayıtsız işletmede kâr sıfır gösterilmez. Kaynak sayfalarını sırayla alma, duraklatma ve devam etme hazırdır; bu yalnızca sayfa açıkken kullanıcı başlatınca çalışır. Zamanlanmış aktarım yoktur.

Kullanıcı isteği: canlı TY/HB/EDM kurulumları en sona bırakılacak ve kullanıcıyla birlikte yapılacak. TY erişim bilgileri önceden kaydedildi; iki denemede ağ/bağlantı hatası alındı, başarılı kaynak aktarımı olmadı. HB ve EDM bağlı değil. Bu sürümün testi yalnızca sentetik yerel iş verileriyle yapıldı.

Faturada çeşit kırılımı yoksa varyant adetleri tahmin edilmez. Aynı fiziksel ürünün farklı pazaryeri adları tek stok kartına bağlanabilir; gerçek çeşit stoğu için ilk güvenilir teslim dağılımı/tedarikçi dökümü gerekir. Resmî EDM fatura gönderimi, alış iade/düzeltme, çalışan yetkileri ve otomatik yedek geri yükleme açık işlerdir.

2.2 doğrulaması: 73 otomatik test geçti; ayrı yerel D1 üzerinde karma paket hesabı, teslim öncesi/sonrası rapor ayrımı ve aynı içerikteki paketin otomatik ölçü eşleşmesi kontrol edildi. Üretim ve e-ticaret arasında ana ekrandan geçiş aynı oturumla çalışır. Yeni 0015 geçişi iki tahmin ayarı tablosu ekler; ticari veri aktarmaz.

## 2.3.0 — alıştan üretime ortak hammadde stoğu

Hammadde kartına bağlı satın alma stok kartı otomatik oluşturulur. Farklı marka/tedarikçi kodları katalogdaki alış bağlantılarıyla bu tek karta bağlanır. Fatura muhasebeleştirmesi cari borcu oluşturur; fiziksel mal teslimi hammadde deposunu besler. Aynı mal için ikinci manuel giriş yapılmaz. Kartın referans fiyatı ile gerçek ağırlıklı stok maliyeti ayrı tutulur.

Reçete stüdyosu depo kartlarında arama, toplu seçim, seçilenlerde arama ve miktar/birim düzenleme sunar. Bir reçetede 200 farklı hammadde desteklenir. 60 hammaddeli reçete kaydı ve üretim tüketimi test edilmiştir; satırlar tek JSON sorgusunda işlenerek D1 sorgu bütçesi korunur.

Tamamlanan üretim kaydı: reçete ve fire önerisi, gerçek tüketim, ek işçilik/ambalaj/diğer maliyet, sabit parti maliyeti, malzeme çıkışı ve mamul girişi. Stok yetersizliği ve çakışmalar bütün işlemi geri alır. Yanlış üretim kaydı, yeterli/ayrılmamış mamul stoğu varsa izlenebilir ters hareketle geri alınabilir. Fiziksel lot takibi yoktur.

Taslak alış faturasındaki tek ürün satırı 2–20 fiziksel çeşide dağıtılabilir. Aynı stok birimi ve eşit birim maliyet gerekir. Toplam miktar, net tutar ve KDV korunur; asıl tedarikçi satırı ve dağılım dayanağı değişmez kayıtta tutulur. Muhasebeleştirmeden önce geri alınıp düzeltilebilir. Faturanın tamamı dağılım sonrasında en fazla 40 satır içerir. Bilinmeyen çeşit adetleri tahmin edilmez.

80 otomatik test geçti. Üç yeni geçiş (0016–0018) gerçek yerel D1 ve Wrangler SQL ayrıştırmasıyla doğrulandı. Üretim, reçete stüdyosu, beş çeşit dağıtımı ve fatura muhasebeleştirmesi yalıtılmış test tarayıcısında denendi. Gerçek TY/HB/EDM servisleri çağrılmadı.


## 2.5.0 — çalışan yetkileri ve alış düzeltmeleri

/access ekranında mevcut yönetici çalışan hesabı oluşturur. Kullanıcı adı ve tek kullanımlık 24 saatlik bağlantı çalışana ayrı iletilir; çalışan şifresini kendisi belirler. E-ticaret ve üretim için erişim yok / görüntüleme / işlem yetkileri sunucuda uygulanır. Yetki değişikliği ve hesap kapatma eski oturumları sonlandırır. Çalışan şirket, bağlantı anahtarı, kullanıcı ve yedek yönetimini değiştiremez. Görüntüleme yetkisi seçilen paneldeki tüm ticari bilgileri kapsar; alan veya müşteri bazlı maskeleme değildir. Mevcut yönetici girişi korunur. Yetki değişiklikleri kaydedilir; tüm ticari işlemlerde kişi bazında ayrıntılı denetim izi bu sürümde yoktur.

E-ticaret işlenmiş alış faturasında Fatura düzeltmesi: ürün fiyatı/iskonto farkı, hizmet/kesinti düzeltmesi ve teslim edilmeyecek miktarın iptali. Pozitif bedel cari borcu azaltır; negatif bedel ek borçtur. Asıl fatura ve değişmez düzeltme geçmişi korunur. Stok payı yalnızca tam teslim edilmiş ürün için açıkça belirlenir; kalan net fark dönem gideridir. Geçmiş satış maliyeti yeniden yazılmaz. Kesinti faturaları satışlara mutabakatla dağıtılır; kullanılan payı aşan indirim önce dağıtımın geri alınmasını gerektirir. Düzeltme ve iptal, sonraki tedarikçi iadesinin tutarına ve kalan teslimine yansır; kuruş toplamları korunur. Resmî fatura kesilmez.

### Otomatik kurtarma ve işletim
Cloudflare D1 Time Travel ücretsiz planda sürekli açık, son 7 günlük veritabanı geçmişini saklayan kurtarma imkânıdır: https://developers.cloudflare.com/d1/reference/time-travel/ . Yeni ücretli yedek servisi kurulmadı. 9 Eylül 2026'da canlı mevcut ve geçmiş kurtarma noktaları salt okunur sorgularla doğrulandı. Canlı geri yükleme yapılmadı. /access#recovery ekranından Cloudflare veritabanına ve adımlara ulaşılır.

Kurtarma bütün D1 veritabanını, iki paneli ve kullanıcı hesaplarını birlikte geri alır. Kod, Worker gizli anahtarları ve Cloudflare hesap ayarları geri alınmaz. İşlem girişini durdurun; hedef tarihle uygulama şemasının uyumunu ve kurtarmadan sonra çalışan yetkilerini kontrol edin. Bu, bağımsız sağlayıcıya kopyalanan bir arşiv değildir.

Salt okunur plan: node scripts/recovery.mjs plan 2026-09-09T14:00:00+03:00

Plan ve güncel güvenlik noktası work/recovery altında saklanır. Gerektiğinde apply <plan-dosyası> <hedef-kurtarma-noktası> kullanılır; kimlik, 15 dakikalık plan süresi ve plan sonrası yeni yazı kontrol edilir, Wrangler'ın son onayı korunur. Komut iptal edilirse başarılı kurtarma varsayılmaz; Cloudflare sonucunu doğrulayın. İş verisi JSON dışa aktarımı ayrı bir analiz dosyasıdır, tam geri yükleme dosyası değildir.

97 otomatik test geçti; 0020 ve 0021 yerel D1'e uygulanarak ekranlar doğrulandı. TY/HB/EDM gerçek bağlantıları kullanıcının isteğiyle sona bırakılmıştır.


## 2.6.0 — ekran bazında personel yetkileri

Yönetici /access ekranında her personel için e-ticarette 10, üretimde 10 bölümün iznini ayrı seçer: erişim yok, görüntüleme, görüntüleme ve işlem. Depo / ön muhasebe / tümünü görüntüle / kapat hazır seçimleri kaydetmeden önce düzenlenebilir. Yeni kullanıcıda bütün ekranlar kapalıdır. İşlem izni o bölümdeki ekleme, düzenleme, teslim, iade ve ters kayıtları kapsar; kalıcı silme ayrıca açıkça seçilir. Ürün silme bağlı reçeteyi etkilediğinden reçete işlem izni de gerekir.

Personelin kişisel ana sayfası sadece yetkili bölüm kartlarını gösterir. API tarafında bölüm/işlem kontrolü uygulanır; bilinmeyen uçlar kapalıdır. Ortak muhasebe yanıtında kapalı satış, cari, fatura ve gider bölümleri döndürülmez; sipariş ayrıntısında kapalı alış belgeleri temizlenir. Üretim hammadde deposu yetkisi üretim partilerini/reçetelerini açmaz. Yönetici yetkisi ve girişi korunur. Güncelleme eski panel izinli hesapları otomatik genişletmez; yönetici ayrıntılı seçim kaydedince yeni harita kullanılır. İzin değişikliği oturumları keser.

Kapsam ekran ve işlem düzeyindedir: stok ekranı miktar ile maliyeti, sipariş ekranı müşteri ve satış/maliyet tutarını birlikte içerir. Maliyet sütununu, tek müşteriyi veya tek ürünü ayrıca maskeleyen izin bu sürümde yoktur. Reçete/maliyet hesabı için ürün ve hammadde bilgileri; fatura/satış girişi için ürün ve stok bilgileri ilgili iznin kapsamındadır. Her izin satırında bu içerik açıklanır. Üretimde Alış ve stok ortak ekranı kendi satış/gider alt sekmelerini de kapsar. Şirket ayarları, bağlantı anahtarı, kullanıcılar ve kurtarma sadece yöneticidedir.

102 otomatik test, yerel personel girişi, stok görüntüleme, kapalı cari adresinin engellenmesi ve yetki tablosu kontrolü. Gerçek çalışan veya mağaza bağlantısı oluşturulmadı.

### v2.6.1 — E-ticaret sipariş takibi

Sipariş araması artık tüm kayıtlarda paket, sipariş ve gönderi referansını tarar. Kanal, durum, sipariş tarihleri ve takip filtresi birlikte uygulanır; 50 paketlik sayfalar arasında geçilir. İş listesi, eşleşme/tutar eksikleri ve değişen kaynak kayıtları için doğrudan ilgili paketlere bağlanır. Gönderiminden 7 gün geçtiği halde kargoda görünen paketler ayrıca listelenir; bu eşik bir teslim taahhüdü değildir. Kargo referansı ve geçen gün liste içinde görünür.

105 otomatik test geçti; eski 500 kayıt sınırının dışındaki arama, SQL arama karakterleri, sayfalama, tarih doğrulaması, tamamlanmış paketlerin kargo uyarısından hariç tutulması test edildi. TY/HB/EDM gerçek veri bağlantıları bu sürümde açılmadı. Yeni veritabanı geçişi veya ücretli servis yoktur.
Yerel tarayıcıda 51 örnek siparişle sayfalama, kanal filtresi, arama, detaydan dönüş, geçersiz tarihten toparlanma ve 390 piksel telefon genişliği doğrulandı; tarayıcı hatası görülmedi.

### v2.6.2 — Teslimat ve kâr doğrulaması

Sipariş özeti ve kanal raporu aynı kâr doğrulama kuralını kullanır. Gönderimde oluşan satışın kesintileri doğrulansa bile teslimat tamamlanmadan kesin katkı gösterilmez; tutarlar tam ise tahmin olarak gösterilir. Kaynak sipariş değişmişse veya setin bir bileşeninin satış kaydı eksikse kâr doğrulanmaz. İade ve iade giderleri toplama dahildir. Ana ekranda dağıtılmamış kesinti belgeleri için açıklama düzeltildi.

108 test geçti. Yerel tarayıcıda giderleri doğrulanmış 44 TL katkılı örnek paket, kargodayken tahmin olarak gösterildi; teslim kaydından sonra sipariş özeti ile kanal raporu 44 TL doğrulanmış katkıda eşleşti. Test kayıtları sadece yerelde kaldı; gerçek mağaza bağlantısı ve yeni veritabanı geçişi yoktur.
