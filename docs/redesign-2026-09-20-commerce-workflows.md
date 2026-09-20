# İşlem ve belge iş akışları — 20 Eylül 2026

Çalışma deposu: `C:/Users/baran/Desktop/site/lunapot-panel`. Başlangıç: `187b42e`.

## Kapsam ve entegrasyon

- Yeni alan stili: **`public/commerce-workflows.css`**. `workspace-design.css` ve `insights-design.css` sonrasında yüklenmeli; ortak HTML/SW dosyaları ana ajanın sorumluluğunda.
- Kapsam, görevlendirilen 12 JS modülü ve bu CSS ile sınırlı. `product-list.js` içindeki `prepareWorkflow(root)` yalnız tablo hücrelerini mobil etiketler ve eksik erişilebilir alan adlarıyla tamamlar. `list-tools` sıralaması, sunucu sıralaması ve form alan/ad/eylem bağları korunur.
- Başlık/eylem, filtre, özet, ana liste ve ayrıntı hiyerarşisi düzenlendi. Katalog anlatımı ve stok hareketleri açılabilir ayrıntıdadır. Bankada dosya/hareket işi öne, hesap yönetimi ve geçmiş ekstreler ikinci plana alındı.
- Sipariş ürün adlarında satır kısaltması kaldırıldı. Mobil listelerde tutar ve cebine kalan ayrı etiketlidir. Sipariş hash/sıralama/sayfa/pencere geri dönüş mekanizması değiştirilmedi.
- Teklif düzenleyicide etiketli satır kartları; mevcut `tr`, alan adları ve ekleme/silme olayları korunur. Pencereler telefonda tam genişlik, sabit erişilebilir başlık/alt eylemler ve kaydırılabilen içerik kullanır.
- Rapor yüklemede gerçek dört aşama görünür. PDF dosya seçicisi klavyeyle erişilebilir. Yükleme sırasında ilgili kontroller devre dışı ve durum duyurulur.
- Alış arşivindeki mevcut `alisBaglantiGovdesi()` hiç render edilmiyordu; sayfa–fatura bağlantısı gerçek görünüm akışına eklendi.
- Banka uç noktasının mevcut `page/page_size/total` sözleşmesiyle önceki/sonraki hareketler erişilebilir oldu. Hesap değiştiğinde eski hesabın satırları yeni hesap başlığı altında tutulmaz.
- Alış satırlarında ekle/sil/geri/bağlantı eylemi öncesinde girilen alanlar korunur. Boş sayısal alanlar yeniden çizimde sıfıra çevrilmez.

## Tarih ve para doğruluğu

- Stok ürün performansı ortak `date-range.js` arayüzünü kullanır: hazır dönem, özel aralık, doğrulama, URL `donem/from/to`, yenileme ve aynı ekranda hash değişimi. İstek: `/api/ec/urun-karlilik?from=YYYY-MM-DD&to=YYYY-MM-DD`. Tüm dönem parametresiz eski API kapsamını kullanır.
- Performansın teslim/iade sonuç tarihi ile bekleyenlerin sipariş tarihi ayrımı sunucunun `notice` açıklamasından gösterilir. Stok miktarı, ayrılan, kullanılabilir ve değerler **güncel** etiketlidir; dönem filtresi bunları geçmiş stok diye sunmaz.
- Satış/gider formları geçerli özel aralığı URL'den okur ve değiştirildiğinde URL'ye yazar. Cari hareketleri aralığı URL'den alır; mevcut açık uçlu tarih arama desteği korunur. Tarih filtreleri cari bakiyeyi değiştirmez.
- **Ana ajan için carryRange kararı:** `sales` ve `ledger` gerçek `from/to` tüketir. `invoices` (`/purchases`) ve `bank` tüketmez; ikisi de ortak tarih taşıma hedeflerinden çıkarılmalı. Alış faturası listesi ve banka ekstresi için desteklenmeyen tarih filtresi eklenmedi. Gezinmeyle taşınan URL aralığı korunur, bu listeler tarihli rapormuş gibi etiketlenmez. Banka ekstre net toplamının güncel banka bakiyesi olmadığı yazılıdır.
- Ürün maliyeti/depo değeri ve alış fatura toplamında KDV dahil birincil, net açık ikincildir. KDV/değer eksikse toplam uydurulmaz. Eksik paketli ürünün cironun hesaplanabilen kısmı toplam ciro diye gösterilmez; ana değer eksik olarak işaretlenir.
- Finansal hesap motoru, kayıt yetkileri, POST sözleşmeleri ve stok hareketi hesapları değiştirilmedi.

## Doğrulama

- 12 modülün `node --check` kontrolü ve sahip olunan dosyaların `git diff --check` kontrolü geçti.
- İlgili mevcut testler: `remaining`, `accounting`, `orders-siralama`, `orders-tracking`, `stock-history`, `purchase-documents`, `offers`, `report-inbox`, `bank`: **60/60 geçti**.
- Son alış formu koruması sonrasında `purchase-documents` + `e-arsiv-dosya-adi`: **9/9 geçti**.
- İlk tüm depo testi: **639 test, 638 geçti, 1 hata**. Hata `panorama.test.js` eski dönem listesinin yeni `1g` dönemini beklememesiydi; analitik ajanının alanıdır. Bu test dosyasına dokunulmadı.
- Ana ajan son bütün depo doğrulamasında **660 test + build geçtiğini** bildirdi; bu alanın yukarıdaki doğrudan çalıştırdığı testlerden ayrıdır.
- Bağımsız yerel Chromium denetimi: 360, 390, 1280 px; 13 ana görünüm ve ek pencereler/ara durumlar. **54 görünüm ölçümünde yatay taşma ve JS hatası yok**. Uzun ürün/tedarikçi adları, eksik KDV, eksi stok örnekleri kullanıldı.
- Etkileşim kontrolleri: stok hazır tarih → URL → yenilemede korunma; ters özel tarihte API çağrısının engellenmesi; satış/cari özel aralık aktarımı; sipariş sıralaması → ayrıntı → tarayıcı geri dönüşünde liste ve sıralamanın korunması; mobil pencere alt eylemlerinin ekranda kalması; teklif satırı eklenince yazılan ad/fiyatın korunması; banka eşleştirme görünümü; satış belgesi dosya kuyruğu; alış belgesi arşivinin görünmesi.
- Test API'leri sentetik veriydi, tüm gerçek yazma istekleri engellendi. Canlı veri, dış belge yükleme veya gerçek muhasebe kaydı kullanılmadı. Gerçek dosyalarla uçtan uca kaydetme/aktarma bu doğrulamanın kapsamında değildir.
- Araç ortamının standart sandbox ACL hatası nedeniyle dosya ve test komutları belirtilen yetkilendirilmiş erişimle çalıştırıldı; kalıcı izin değişikliği yapılmadı.

Commit, push ve deploy yapılmadı. Diğer ajanların dosyaları ve kullanıcının `.node-version` / `scripts` değişiklikleri korunmuştur.

## Son görsel düzeltmeler

- Seçili sipariş durumu sayacı açık adaçayı üzerinde koyu mürekkep rengine alındı; hesaplanan renk `rgb(32, 52, 47)`.
- Stok performansında yinelenen başlık kaldırıldı. Performans kapsamı ve stok ipuçları aynı satırdaki tek açılır alanda birleştirildi; güncel stok kapsamı görünür kaldı. Geniş ekranda ek filtre ve liste eylemleri aynı satırda.
- Grup toplamı bilinmiyorsa “Brüt hesaplanamadı · KDV hariç değer …”; net de eksikse “KDV hariç değer hesaplanamadı” yazılır. Hesaplama değiştirilmedi.
- 360/390/1440 px sentetik, yazmaya kapalı Chromium doğrulamasında 13 görünüm ölçümü geçti: taşma/JS hatası yok; kapsam açılması, tarih kalıcılığı ve geçersiz aralık, sipariş sıralama/geri dönüş kontrolleri geçti. İzole 1440 px görünümde ilk ürün kartı yaklaşık 598 px konumunda (gerçek shell ölçümü değildir).
- İki JS modülünün sözdizimi ve diff kontrolü, brüt/net başlığının üç veri durumu kontrolü geçti. Bu tur yalnız accounting-ui.js, product-list.js, commerce-workflows.css ve bu not değişti.
