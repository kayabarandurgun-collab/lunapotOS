# Lunapot OS
Mobil ve web uyumlu, Cloudflare Workers + D1 üzerinde çalışan iki ayrı iş alanı.

- **Lunapot** (/): ürünler, hammaddeler, reçeteler, üretim maliyeti, alış/stok ve cari.
- **E-Ticaret** (/eticaret/): torf ve zirai ürünler; sipariş, stok ayırma, kargoya verme, satış kârlılığı, cari/nakit, alış ve mal teslimi.
- Lunapot AI kapalı; ücretli AI servisi bağlı değil.

## Çalışan özellikler
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

Ücretsiz D1 sınırları için paketler en fazla 10 satırdır. Büyük içe aktarımlar sayfalar halinde yürütülür. 25.000 satıra kadar iş verisi dışa aktarımı vardır; otomatik geri yükleme yoktur. Lunapot reçete maliyeti bir üretim tahminidir; hammadde depo hareketlerini otomatik tüketen üretim emri modülü henüz yoktur.

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
4. D1 migrations apply DB --remote ardından npm run deploy çalıştır.
5. İlk yöneticiyi kişisel şifreyle oluştur; HTTPS ve korumalı API'leri doğrula.

Ücretli plan, alan adı veya AI aboneliği gerekmez. Sağlayıcı ücretsiz kotaları ve pazaryeri/EDM servis hakkı kendi hesabında geçerlidir. Yerel test veritabanı (.wrangler veya work/) kesinlikle üretime kopyalanmaz.

## Güvenli işletim
Kaynak kodu ticari veri veya mağaza anahtarı içermez. İşlem geçmişi silinerek düzeltilmez; desteklenen ters kayıt/iade akışları kullanılır. Başlangıç stoğu ve tüm fiziksel hareketler kaydedilmeden depo doğruluğu varsayılmaz. Finans sonuçları tahsilat bakiyesinden ayrıdır; stopaj ve KDV işletme kârı gibi gösterilmez.

Testler gerçek müşteri/mağaza verisi olmadan yalıtılmış SQLite üzerinde çalışır. Canlı sağlayıcı testleri ve Worker CPU ölçümü yayın sonrası yapılmalıdır.
