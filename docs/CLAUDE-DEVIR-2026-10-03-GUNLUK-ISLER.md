# Lunapot Panel — Kullanım, Tasarım ve Doğruluk Çalışması

Tarih: 3 Ekim 2026
Doğru depo: C:/Users/baran/Desktop/site/lunapot-panel
Başlangıç: main / 1597e37, canlı arayüz v172; veritabanı 0064.

Bu belge Claude için tek giriş noktasıdır. Eski Documents/Codex çalışma kopyası güncel değildir. Kullanıcı günlük işleri bulamıyordu; yalnız görsel rötuş değil, arayüz ve iş akışlarının uygulanmasını, muhasebe kusurlarının giderilmesini ve bu raporu istedi. Önceki talimatında testlerden sonra yeniden onay istemeden yayını yetkilendirdi.

## Kullanıcının artık izleyeceği yollar

| Yapılacak iş | Yeni yol | Girilecek bilgi |
|---|---|---|
| Pazaryeri raporu | Ana ekran → Rapor yükle | Trendyol/Hepsiburada dosyası; tanınmayan bilgi gerekiyorsa sorulur |
| Alış faturası | Ana ekran → Alış faturası yükle | Özgün PDF/XML; mevcut otomatik okuma ve kontrol kapıları korunur |
| Depoda ne var | Ana ekran → Depodaki ürünler veya mobil Depo | Fiziksel miktar, ayrılmış miktar ve kargodaki ürünler ayrı |
| Mal geldi, fatura sonra | Ana ekran → Faturasız mal girişi | Tedarikçi, irsaliye/referans, yalnız yeni gelen miktar, KDV hariç maliyet |
| Raf sayımı | Depo → Depo sayımı yap | Depoda gerçekten bulunan toplam miktar; yeni gelen miktarla karıştırılmaz |

Stok fiziksel bileşen bazında kalır; set stoğu saydırılmaz. Satış ve kâr satılan ilan/tekli/çoklu paket/set bazında kalır. Kargoya verilen mallar depodan çıkmıştır; depo sayımına kargodakiler eklenmez. Yeni müşteri carisi oluşturulmadı.

## Arayüz ve iş akışları

- Ortak günlük iş kayıtları daily-actions.js içindedir. Ana ekran, uygulama giriş ekranı, Yeni işlem penceresi ve arama aynı hedefleri kullanır. Faturasız araması Türkçe karaktersiz de çalışır.
- E-ticaret menüsünün ilk sırası genel durum, rapor yükleme, alış faturaları, depo, siparişler ve satış/kâr oldu. Gelişmiş ekranlar korunur, gündelik işlerin önüne geçmez.
- Mobil alt çubuk Özet / Raporlar / Faturalar / Depo / Menü. İzin olmayan seçenekler gösterilmez. 320 px genişlik de sınanır.
- Koyu yeşil menü, açık ana yüzey, tutarlı yazı/boşluk/düğme düzeni, sade görev kartları. Uzun grafikler ve ürün/set analizleri isteğe bağlı açılır. Ayrı analizlerin açılma tercihleri birbirine karışmaz.
- Depoda eylemler kısa araç çubuğunda, gelişmiş filtreler ve satış dönemi ayrıntıda. İlk stok miktarının üst kenarı 320/390 px telefonda 677 px, 1440 px masaüstünde 560 px ölçüldü.
- Rapor yükleme dosya seçimiyle başlar. Belirsiz mağaza/tür sorulurken dosya kaybolmaz. Gelişmiş bakım ayrı; ilk yükleme hatası yanlış boş kurulum ekranına dönüşmez. Siparişlerde geç gelen arama yanıtı güncel aramayı ezmez; müşteri/teslimat ayrıntısı gider belgesi varlığına bağlı değildir.
- Faturada yeni dosya seçimi önceki tedarikçi/sayfa/belge kimliğini temizler. Kullanıcının yaptığı açık tedarikçi seçimi korunur. Toplu işlem sonucu taslak, muhasebeleşen ve stoğa giren faturayı ayırır.
- Üretim, reçete, teklif, cari ve ekip ekranlarında isteğe bağlı ayrıntılar sadeleştirildi; klavye, eksik bilgi, hata sonrası tekrar ve salt okunur davranışları düzeltildi. Cari listesinde ilk 30 tedarikçiyle sınırlı görünüm kaldırıldı.
- Personelde stock:read + ledger:write faturasız mal girişi için yeterlidir; tüm stok yazma yetkisi verilmez. Ortak görüntüleme kilidindeki yalnız bu form için dar istisna, formun kendi bekleme/doğrulama kilidini açmaz. Sunucu izin kontrolü korunur.
- Kurulum açıklaması manuel rapor akışını anlatır. SENKRON_KAYNAKLARI boşken otomatik pazaryeri bağlantısı çalışıyormuş gibi söz vermez.

## Doğrulanıp düzeltilen hesap ve veri sorunları

1. FA01: OCR fatura numarası geçmişi yetersiz/karışıkken boş uyarı doğrulama sayılıyordu. En az üç uyumlu örnek olmadan biçim doğrulanmış sayılmaz; yükleme tekrarında uyarı korunur.
2. FA02: Tutar yetkisi olmayan personel ham PDF/base64/OCR ayrıntısından paraya erişebiliyordu. Ham belge/parça/OCR için tutar izni de gerekir; sunucu 403 verir.
3. FA03: İkame ürün/hediye, özgün tekli ilanı yeni bir setmiş gibi raporluyordu; teknik düzeltme gerçek müşteri iadesiyle karışıyordu. Özgün satılan ürün kimliği korunur; değişen fiziksel ürünlerin maliyeti aynı satışa gider.
4. FA04: Otomatik ürün eşlemesi ürün profilindeki eski KDV ile işletmenin satış KDV ayarını ezebiliyordu. Eşleme ve eksik net tamamlama ortak satış ayarını kullanır. Oran sabit olarak koda yazılmadı.
5. FA05: Aynı tedarikçinin ilgisiz faturası faturasız mal borcunu kapatabiliyor; farklı tedarikçiden aynı ürün, eski fiziksel girişi tüketebiliyordu. Yeni tasarım tedarikçi + ürün + kalan miktar tahsisidir; borç, mal teslimi ve açık maliyet aynı tahsise dayanır. Kısmi ve çok satırlı işlemler ayrı test edilir.
6. Üretim kapasitesi: açıkça bilinmeyen stok artık sıfır değil; miktar ve kapasite bilinmiyor gösterilir, üretim engellenir. Gerçek sıfır ve hiç hareketi olmayan ürünün mevcut sıfır kuralı korunur.
7. Cari görünümü: ters kayıt tek başına Faturalandı kanıtı sayılmaz. Kısmen faturalandı, faturalandı ve eski bağı belirsiz kayıtlar ayrılır.

8. İş verisi yedeği: yeni bağlantı tabloları eski sorgu sınırını aşıyordu. Dörder tabloyu tek sorguda okuyan yöntem veri ve kolonları birebir korur; faturasız giriş satırları da artık küçük JSON arşivine dahildir. 25.000 satır ve 45 tablo sınırı, çalışma alanı ayrımı ve sırların dışlanması korunur.

## Eski kayıtlar ve güvenli geçiş

Canlıya yalnız salt okunur sorgularla bakıldı: 6 faturasız giriş, 32 satırın tamamında movement_id boş. Referans + ürün + tarih + miktar + değer eşleşmesi her satır için tam bir aday verdi; 32 ayrı stok hareketi var, hiçbirinde eski provisional-close yok. Bunlar yanlış bakiye kanıtı değildir; ilişki alanının eksikliğini gösterir.

0065 tasarımında muhasebe kayıtlarını silmek/değiştirmek veya geçmiş maliyetleri tahminen düzeltmek yoktur. Kesin ve iki yönde tekil ilişkiler yeni değişmez bağlantı kaydına alınır; belirsiz ilişkiler otomatik kabul edilmez. 0065 canlıda uygulandı: 32 tekil ilişki oluştu, özgün 32 NULL alan değiştirilmedi. Aşağıdaki yayın kaydı nihai sonuçtur.

## Test yaklaşımı ve sınırları

Yerel önizleme gerçek Worker kodunu bellek içi SQLite ve sentetik veriyle çalıştırır. Tarayıcı testleri dış ağı ve gerçek iş kaydı gönderimini engeller; bazı hata/başarı yanıtları tarayıcıda taklit edilir. Sunucu mali testleri SQLite içinde gerçek kayıt işlemlerini yürütür. Canlıya deneme siparişi, fatura, stok veya müşteri eklenmez.

Ara doğrulama: 69 sayfanın 390/1440 px görünümünde toplam 138 ekran ve 45 HTTP kontrolü; yakalanmamış tarayıcı hatası ve sayfa yatay taşması yok. Bu tarama muhasebe doğruluğunun veya tam erişilebilirlik uyumunun kanıtı değildir. Son değişen akışlar ayrıca hedefli test edilir.

Ara sonuçlar: yönlendirme+ana ekran 78/78; günlük işler+depo 12/12; rapor/sipariş+ikincil ekranlar 23/23. Bunlar nihai tam test toplamına eklenip benzersiz test sayısı gibi sunulmaz.

Gerçek OCR modeli her fatura için garanti vermez. Teklif araması mevcut en son 300 kayıt kapsamındadır ve bu sınır görünürdür. Bilinmeyen maliyet/tutar sıfır sayılmaz. Bu çalışma tüm muhasebenin bağımsız mali müşavir denetiminden geçtiği iddiası değildir.

## Yayın güvenliği

Yeni 0065 şemasıyla eski worker birlikte yazma yapmamalıdır. RELEASE_MAINTENANCE=1 olduğunda tüm HTTP istekleri önbelleğe alınmayan 503 ve Retry-After:30 döndürür; zamanlanmış bakım da çalışmaz. Bayrak 0 veya yokken normal çalışma sürer. Bu davranış testte DB, dosya ve AI erişiminin hiç çağrılmamasıyla doğrulanır.

Yayın sırası: normal ve bakım sürümlerini önce trafiğe açmadan yükle → bakım sürümüne geç ve doğrula → süren istekler için kısa boşluk bırak → geri dönüş noktası/özet al → 0065'i versiyonlu geçiş aracıyla uygula → 32 kesin ilişki ve eski defter özetlerini kontrol et → normal sürümü aç. Yeni şema, eski koddan geciken bağsız yeni girişleri de reddetmelidir.

0065 sonrasında v172 koduna körlemesine geri dönülmez. Sorunda öncelikle bakım sürümüne dönülür ve ileriye doğru düzeltme yapılır. Veritabanı Time Travel geri yüklemesi bu çalışmanın yaptığı bir işlem değildir.

## Kaynaklar ve ayrıntılı kanıtlar

- GOV.UK hizmette gezinme: https://design-system.service.gov.uk/patterns/navigate-a-service/
- W3C reflow: https://www.w3.org/WAI/WCAG21/Understanding/reflow
- W3C hedef boyutu: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- Yerel ekranlar: docs/ux-2026-10-03/all-pages/ ve docs/ux-2026-10-03/workflows/
- Alt inceleme notları: docs/UX-2026-10-03-*.md. Bunlar çalışma sırasındaki anlık sonuçlardır; son yayın kaydı bu dosyadır.

## Yayın ve son doğrulama kaydı

**TAMAMLANDI — canlı v173.**

- Canlı: https://muhasebe.lunapot.com/eticaret/#overview
- Yayın sonrası kontrol zamanı: 2026-10-03T16:42:16.567Z (UTC).
- Önbellek: lunapot-shell-v173-gunluk-isler.
- Etkinleştirilen normal Worker sürümü: a8fd7992-690e-4ae2-a1ea-46942b979f5e (trafiğin %100'ü).
- Hazır bakım sürümü: ed5f7ad0-8628-45bd-b253-a5e76fc97edf. Normal sürümde RELEASE_MAINTENANCE=0; bakım sürümünde 1.
- 0065_provisional_allocations.sql uygulandı ve geçiş kaydı bir kez yazıldı. SHA-256: a6adb7e89163f1c590a29a0f6338e61c6a92fbefccf3897ff2e3216f737733c4.
- 32 ilişki / 32 ayrı hareket / 32 uygun satır doğrulandı. Geçiş kendiliğinden fatura tahsisi yapmadı (0). Özgün eski satırlarda movement_id NULL kaldı; yeni metadata üzerinden okunuyor.
- Geçiş öncesi/sonrası 13 EC/LP mali toplam ve kayıt sayısı kontrolü aynı: stok miktarı/değeri, stok hareketleri, cari hareket/bakiye ve satış maliyeti dahil. Finansal geçmiş onarımı veya tahmini bakiye yazımı yapılmadı.
- Geri dönüş noktası alınarak geçildi. Tam sayısal kontrol kayıtları yerel docs/ux-2026-10-03/pre-migration.json ve post-migration.json içindedir; ticari toplamlar içerdiğinden Git'e eklenmedi.
- İlk normal sürüm etkinleştirme denemesi Cloudflare zaman aşımı nedeniyle tamamlanmadı; panel korumalı bakımda kaldı. Aynı hazırlanmış sürümün ikinci denemesi başarılı oldu. Migration tekrarlanmadı.
- Canlıda 9 public/asset/auth kontrolü 200; anonim finans uç noktası 401. Aktif yönetici hesabıyla canlıya sahte fatura/sipariş veya stok hareketi yazılmadı. Yerel tarayıcı testleri oturumlu, sentetik uygulama üzerinde yapıldı.

### Nihai doğrulama

- Tam test paketi: **1132 toplam, 1113 geçti, 19 ortam koşullu test atlandı, 0 hata**. Bakım kapısı, export, PR01–03 ve son 0065 dahildir.
- Son birleşik tarayıcı paketi: **39/39**; günlük işler, mobil depo, fatura yükleyici, rapor/sipariş, üretim/reçete, teklifler, cari ve personel.
- Önceki yönlendirme ve ana ekran paketi: **78/78**. Aynı testleri toplayıp benzersiz toplam diye sunmuyoruz.
- 69 sayfa × 2 genişlik: **138 görünüm**, yakalanmamış sayfa hatası ve yatay taşma bulunmadı. Son değişen stok/odak akışları ayrıca 320/390/1440 px hedefli testte doğrulandı.
- Yayın paketi: 246 statik dosya, Worker 973,66 KiB / sıkıştırılmış 246,12 KiB. Üretim D1 bağlamı sürüm metadata'sından doğrulandı.
- Bağımsız inceleme son 0065 hash'inde PR01 kuruş farkı, PR02 eski yazıcı/geçiş ve PR03 tarih kapsamını kapattı. İncelenen kapsamda kanıtlı açık yayın engeli yok.

### Yeniden kontrol komutları

PowerShell'de depo kökünden:

~~~powershell
node --test tests/*.test.js
node scripts/design-preview.mjs --port=18731
~~~

Önizleme ayrı terminalde açıkken:

~~~powershell
$env:DAILY_PREVIEW_URL='http://127.0.0.1:18731'
node --test tests/daily-workflows-browser.test.js
~~~

Diğer tarayıcı değişkenleri/test komutları alt notlardadır. Testler gerçek işletmeye yazmaz. Günlük test çıktıları docs/ux-2026-10-03/final-unit-tests.txt ve final-browser-tests.txt; incelenen dosyaların özetleri release-source.json.

### Devam kaydı

~~~yaml
session: lunapot-panel
date: 2026-10-03
status: complete
outcome: SUCCEEDED
goal: Günlük işleri bulunur yapmak; mobil düzeni ve doğrulanmış muhasebe/izin kusurlarını düzeltmek.
now: v173 canlı; sonraki kullanıcı talebinde bu belge ve mevcut Git durumu okunmalı.
test: node --test tests/*.test.js
done_this_session:
  - task: Ortak günlük işler, doğrudan yükleme ve depo akışları, mobil gezinme.
    files: [public/daily-actions.js, public/workspace-frame.js, public/accounting-ui.js, public/report-inbox-ui.js]
  - task: FA01-05, üretim bilinmeyen stok, yedek ve güvenli geçiş.
    files: [migrations/0065_provisional_allocations.sql, src/provisional-inventory.js, src/settings-api.js, src/worker.js]
blockers: []
questions: []
decisions:
  - stock: Fiziksel ürün sayımı ve satılan set kârı ayrı tutulur.
  - legacy: Kesin iki yönlü bağ metadata ile kurulur; belirsiz bağda işlem durur.
  - deployment: Önce bakım, sonra migration, kontroller ve normal sürüm.
findings:
  - provisional: Tedarikçi/ürün/miktar bağlantısı hem borç hem stok için ortak olmalı.
worked: [Sentetik tarayıcı, SQLite regresyonları, bağımsız karşı örnekler, canlı salt okuma.]
failed: [Geçici Cloudflare yetki/zaman aşımı; tekrar doğrulama ile çözüldü.]
next:
  - Sonraki istekte güncel depo ve bu yayın kaydı üzerinden devam et.
files:
  created: [public/daily-actions.js, public/daily-actions.css, src/provisional-inventory.js, migrations/0065_provisional_allocations.sql]
  modified: [public, src, tests]
~~~

Önceden var olan .node-version ve scripts/migrate-remote.mjs değişiklikleri, eski docs dosyaları, .Codex/, .claude/ ve kart-idleri.json bu çalışmanın parçası değildir; hedefli commit kullanılmalı. main'e push otomatik canlı yayın tetikler: önce uyumlu migration, sonra kod. Yeni kod 0065 olmadan yayınlanmamalı.
