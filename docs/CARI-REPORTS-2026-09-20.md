# Raporlardan hakediş — 20 Eylül 2026

E-ticaret cari ekranında rapor kanıtını okuma görünümü. Cari kart, borç/alacak, satış, gider, banka hareketi veya ödeme oluşturmaz. Müşteri borcu türetmez. Banka doğrulaması yapmaz.

## Bağlantı sözleşmesi

- `src/marketplace-receivables-api.js`: `marketplaceReceivablesApi(request, env, path, readBody)`.
- Worker dış yolu: yalnız `GET /api/ec/marketplace-receivables`; kapsamlı iç yol `/api/marketplace-receivables`.
- Worker yönlendirmesi ve `permission-policy` bağlantısı ana çalışma tarafından yapılmıştır. Modül de bağımsız olarak `WORKSPACE=ec`, `GET` ve birlikte `ledger` + `orders` okuma izinlerini zorunlu tutar. Yönetici için de yazma yöntemi kapalıdır.
- Tutar alanları yalnız `*_cents` adlarıyla nesne halinde döner; Worker mevcut `scrubAmounts` filtresini iç içe kanıt satırlarına da uygular. Ham JSON veya tutarlı metin içine gizlenmiş parasal değer döndürülmez.
- `public/business-ui.js` yalnız EC için **Raporlardan hakediş** sekmesi ekler; `mountMarketplaceReceivables(root, namespace='ec')` modülünü gerektiğinde yükler. Sekme değiştiğinde istekler iptal edilir.
- Yeni bağımlılık veya migration yoktur. Mobil kart görünümü `public/marketplace-receivables.css` dosyasındadır; mevcut stillerden sonra yüklenmeli ve servis çalışanı/varlık paketine dahil edilmelidir.

## Kaynak ve hesap sınırı

Yalnız güncel `ec_report_records` ile `ec_report_stores` okunur. Eski sürüm tablosu, sipariş defteri, satış defteri, cari defter ve banka satırlarıyla parasal birleşim yapılmaz. Her mağaza ayrı seçilir; aynı sağlayıcıdaki aynı sipariş numarası mağazalar arasında birleşmez.

`net_payout` alanı hakedişin sipariş, paket veya ödeme grubu kapsamını kanıtlamaz. Bu nedenle **hiçbir mağaza, dönem veya genel parasal toplam üretilmez**. Tek kapsamda aynı değeri bildiren kaynakların tutarı yalnız “raporda bildirilen net” kanıtı olarak görünür; kesin sipariş hakedişi veya tahsilat sayılmaz.

- Tek fiziksel kaynak satırının (`file_id`, `row_no`) komisyon, kargo, satış ve iade olaylarında tekrarlanan net bir kanıt satırı olur.
- Farklı dosyaların aynı kapsam/aynı değer bildirimi toplanmaz. Farklı netler, aynı dosyada birden fazla satır veya farklı paket/ürün/işlem kimlikleri varsa tek net tutar gösterilmez; kaynak bildirimler incelemeye açık kalır.
- Neti bulunmayan ek finans satırları varsa kapsam tamamlanmış varsayılmaz.
- İade, bildirilen netten yeniden düşülmez. `type=payout` ve `amount_cents` tek başına ne net hakediş ne banka tahsilatı kabul edilir.
- Eksik/geçersiz tutar sıfır yapılmaz. Kaynak açıkça sıfır veya eksi net bildiriyorsa işareti korunur.
- Müşteri adı, iletişim bilgileri, ham hücreler, dosya adları ve diğer serbest kaynak alanları yanıta alınmaz. Kanıt bağlantısı için yalnız dosya kimliği/satır numarası kullanılır.

## Tarih, görünüm ve sınırlar

Varsayılan kapsam `all`: tarihsiz ve referanssız kayıtlar dahil gösterilir. Mağaza seçimi zorunludur; açılışta mevcut rapor mağazaları listelenir. Otomatik son 30 gün süzgeci yoktur.

`from`/`to` yalnız finans `event_date` alanı kesin olarak tek gün olan sipariş gruplarına uygulanır. Sipariş tarihi, dosya tarihi ve `payout_date` işlem tarihi yerine kullanılmaz. Farklı günlere dağılmış/eksik/geçersiz tarihli grup “Tarihi belirsiz” bölümünde kalır. Referanssız kayıtlar fiziksel kaynak satırı bazında ayrı görünür. Bu iki bölüm tarih süzgeciyle sessizce kaybolmaz; kapsam metni bunu açıkça söyler.

Süzgeçler: `store_id`, `section=all|dated|undated|unreferenced`, `from`, `to`, `page`. Sayfa 50 gruptur. Durum sayıları sayfa dışındaki kayıtları da kapsar. Mağaza başına 20.000 kaynak kaydı sınırı aşılırsa kısmi sonuç yerine açık 409 yanıtı döner. Her grupta ilk 12 net kanıt satırı gösterilir; sınır toplam kanıt sayısıyla açıklanır ve belirsizlik kararı bütün kayıtlarla verilir.

Banka eşleşme adayı üretilmez. Mevcut `/eticaret/#bank` ekranına bağlantı vardır; banka doğrulaması yapılmadığı her zaman görünür. Cari ekranındaki seçili kişi veya cari tarih aralığı rapor mağazası eşleştirmesi sayılmaz.

## Doğrulama

`node --test tests/marketplace-receivables.test.js`

10 test: aynı satırda tekrarlı net/iade, örtüşen güncel raporlar ve tarihî sürüm dışlama, bir siparişte birden fazla paket, mağaza ayrımı, bilinmeyen/karma tarih, ödeme olayı ve eksik/geçersiz/eksi/sıfır net, kişisel veri dışlama, gerçek Worker üzerinden çift yetki/tutar gizleme/yazma yasağı, güvenli HTML ve sayfalama.

Yazmasızlık kontrolü gerçek Worker isteği sırasında bellek veritabanını `PRAGMA query_only=ON` yapar ve toplam yazma sayısının değişmediğini doğrular. Testler sentetiktir; canlı veri kullanılmaz. Görsel tarayıcı kontrolü ana çalışmanın sentetik önizleme sürecindedir.

Son hedefli regresyon sonucu: `node --test tests/marketplace-receivables.test.js tests/ledger.test.js tests/party-statement.test.js tests/amount-permission.test.js` — **34/34 geçti** (10 yeni hakediş testi dahil). Mobil görsel düzeltme sonrasında `marketplace-receivables.css` bağlantısı gereklidir. Yeni arayüz dosyasının servis çalışanı paketine ana çalışma tarafından eklendiği bildirildi. 8791 sentetik önizlemedeki son mobil/görsel/yetki kontrolünü ana çalışma yürütüyor; bu sonuç tarayıcı kabulü olarak sunulmaz.


## Mobil görünüm ve sekme erişimi düzeltmesi

`marketplace-receivables` kapsayıcısı altında çalışan yeni CSS, 700 px ve altında rapor tablosunu tek sütunlu kartlara dönüştürür. `thead` görsel olarak gizlenirken erişilebilir kalır; hücrelerin `data-label` etiketleri görünür, tablo/satır/hücre rolleri korunur. Sipariş numarası bütün kart genişliğini kullanır, tutarlar bölünmez, kapsam/kanıt bölümü tam genişliktedir. Özet kartlarının ilk ikisi yan yana, üçüncüsü tam genişliktedir; süzgeçler tek sütundur; sayfalama metni düğmelerin üzerinde ayrı satıra çıkar. Diğer cari tablolarının stilleri değişmez.

`mountBusiness(root, namespace, view, user = null)` dördüncü kullanıcı argümanını kabul eder. EC rapor sekmesi yalnız yöneticiye veya birlikte cari ve sipariş okuma yetkisine sahip kullanıcıya görünür. Yetkili kullanıcı `/eticaret/#ledger?tab=receivables` adresiyle sekmeye doğrudan girebilir. Kullanıcı bilgisi yoksa sekme kapalı kalır; diğer sekmelerin açılış davranışı korunur.

Mobil düzeltmenin JavaScript sözdizimi kontrolleri geçti; yeni CSS’nin bağlantısını ve son görsel kontrolü ana çalışma tamamlar. Daha önceki 4/4 tarayıcı kontrolü bu son CSS değişikliğinin görsel kabulü değildir.

Son teslim notu: Mobil düzenlemeden sonra 10/10 hakediş testi yeniden geçti; iki değişen arayüz dosyasının sözdizimi kontrolleri başarılı. Ana çalışma `ecommerce.html` CSS bağlantısını ve servis çalışanı paketini tamamladı; dördüncü `currentUser` argümanını doğruladı. Ana çalışmanın CSS öncesi 764/764 regresyon ve başarılı paketleme sonucu ayrıca bildirildi; bu alt çalışma tam paketi tekrar çalıştırmadı. Son mobil görsel doğrulama ana çalışmada sürüyor. Bu teslimden sonra ilgili dosyalar donduruldu.

Ana entegrasyon: mobil ve masaüstü yönetici/tutar gizli personel 4/4 tarayıcı kontrolü geçti. Mobil tablo kartları görsel olarak kontrol edildi; genel istatistik CSS kuralına karşı sınırlı bir öncelik düzeltmesiyle üçüncü özet kartı tam genişlikte tutuldu.
