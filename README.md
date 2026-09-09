# Lunapot OS 2.2
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

Ücretsiz D1 sınırları için paketler en fazla 10 ilan satırı ve toplam 20 stok bileşenidir. Büyük içe aktarımlar sayfalar halinde yürütülür. 25.000 satıra kadar iş verisi dışa aktarımı vardır; otomatik geri yükleme yoktur. Lunapot reçete maliyeti bir üretim tahminidir; hammadde depo hareketlerini otomatik tüketen üretim emri modülü henüz yoktur.

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

Faturada çeşit kırılımı yoksa varyant adetleri tahmin edilmez. Aynı fiziksel ürünün farklı pazaryeri adları tek stok kartına bağlanabilir; gerçek çeşit stoğu için ilk güvenilir teslim dağılımı/tedarikçi dökümü gerekir. Resmî EDM fatura gönderimi, alış iade/düzeltme, üretim emri, çalışan yetkileri ve otomatik yedek geri yükleme açık işlerdir.

2.2 doğrulaması: 73 otomatik test geçti; ayrı yerel D1 üzerinde karma paket hesabı, teslim öncesi/sonrası rapor ayrımı ve aynı içerikteki paketin otomatik ölçü eşleşmesi kontrol edildi. Üretim ve e-ticaret arasında ana ekrandan geçiş aynı oturumla çalışır. Yeni 0015 geçişi iki tahmin ayarı tablosu ekler; ticari veri aktarmaz.
