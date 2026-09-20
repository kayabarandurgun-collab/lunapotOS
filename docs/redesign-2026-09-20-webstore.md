# Web mağaza ve müşteri mağazası — 20 Eylül 2026

Durum: **Kapsam tamamlandı; birleştirmeye hazır.** Etkin depo `C:/Users/baran/Desktop/site/lunapot-panel`, istenen temel `187b42e`. Commit, push, deploy ve canlı veri yazımı yapılmadı. Assets dosyaları değişmedi.

## Ortak sisteme bağlantı

- `webshop.html`: `workspace-redesign webstore-admin`; `/workspace-design.css` kendi `/webshop.css` dosyasından önce yüklenir.
- `webshop.js`: `setWorkspaceUser` doğrudan `/workspace-frame.js` üzerinden kullanılır. Sayfa yenilenmeden giriş sonrası ortak çalışma alanı menüsünün yetkileri güncellenir (tarayıcıda doğrulandı).
- Yeni müşteri mağazası CSS dosyası: **`public/magaza/store-redesign.css`**. 23 HTML şablonunda en son stil katmanı olarak bağlıdır. Müşteri mağazasında `workspace-redesign` kullanılmaz.
- Ana ajanın ortak shell/SW sürümlemesine dahil etmesi gereken yeni varlık yukarıdaki CSS dosyasıdır. Ortak shell, SW, backend ve diğer ajanların dosyaları değiştirilmedi.

## Değişen davranış ve tasarım

- Yeşil/kırık beyaz yüzeyler, sade yazı hiyerarşisi, mevcut fotoğraf ve marka dosyaları; katalogda filtre/liste önceliği, tam ürün adları, görünür form/arama etiketleri.
- Ortak başlık, altbilgi ve mobil menü; tüm sayfalarda test mağazası/gerçek ödeme alınmadığı uyarısı. Aktif menü bağlantısı uzantısız rotalarda da belirlenir; içerik atlama bağlantısı ana bölüme gider.
- Webshop'un sekiz görünümü, ürün/stoğa eşleme/sipariş pencereleri yeniden düzenlendi. Mobilde navigasyon açılır bölüm; tablolar etiket/değer kartlarıdır, veri `overflow:hidden` ile kesilmez.
- Yönetim özeti tüm kayıtları döndürdüğü için yanıltıcı “bugün” ifadesi kaldırıldı. Yeni tarih filtresi veya finans formülü eklenmedi. Stok test stoğu olarak adlandırılır.
- Mevcut brüt/test tutarları KDV dahil etiketiyle gösterilir. API'nin sağlamadığı KDV hariç tutar/ürün özelliği hesaplanıp uydurulmaz. Bilinmeyen tutar sıfıra çevrilmez; yetkiyle gizlenen yönetim tutarı ayrı gösterilir.
- Ürün ayrıntısındaki başlangıç fiyatı mevcut varyant fiyat tablosundan okunur; fiyatlar kuruşları kaybetmeden gösterilir. Mevcut ödeme, stok, hesap ve API işleyişi korunur.
- Kaydetme hatası yönetim penceresini kapatmaz; girilen değerler korunur ve hata odaklanır. Katalog güncellenme/başarısızlık durumu, hesap başlangıç hatasında tekrar deneme ve aktif ödeme adımı eklenir.
- Mobil pencerelerde kaydırılabilir içerik, erişilebilir sabit kapat alanı ve satın alma/kaydetme kontrolleri. Şifre sıfırlama penceresinin kapat düğmesi başlık içinde kalır.

## Doğrulanan rota envanteri

Yönetim: `/webmagaza/` (worker alias: `/webshop`), hash görünümleri `overview`, `orders`, `customers`, `catalog`, `requests`, `readiness`, `contact`, `outbox`.

Müşteri mağazası: `/magaza/` ve aşağıdaki **23 fiziksel HTML rotası**. `index`, `home`, `shop` aynı mevcut ana sayfa girişleridir; bağlantılar kaldırılmadı.

- `/magaza/bitki-yerlesimi.html`
- `/magaza/govde-katmanlari.html`
- `/magaza/hakkimizda.html`
- `/magaza/hesabim.html`
- `/magaza/home.html`
- `/magaza/iletisim.html`
- `/magaza/index.html`
- `/magaza/kurumsal.html`
- `/magaza/luna.html`
- `/magaza/magaza.html`
- `/magaza/nova.html`
- `/magaza/odeme.html`
- `/magaza/rehber-bitki-yerlesimi.html`
- `/magaza/rehber-nova-luna.html`
- `/magaza/rehber-saksi-secimi.html`
- `/magaza/rehber.html`
- `/magaza/saksilar.html`
- `/magaza/shop.html`
- `/magaza/test-odeme.html`
- `/magaza/toplu-siparis.html`
- `/magaza/toprak-bakim.html`
- `/magaza/yardim.html`
- `/magaza/yasal.html`

Ek alt görünümler: katalog `category=nova|luna|saksı|toprak|budget|favorites`, ürün seçenek/galeri/adet penceresi, filtre penceresi, sepet, hesap giriş/kayıt/sıfırlama, ödeme adres/fatura/özet, sipariş ayrıntısı, Nova/Luna teknik model seçimi, yardım arama/boş sonuçları. `yasal.html?doc=` anahtarlarının tamamı API yanıtından alınarak gezildi.

## Test kanıtı

- İlgili mevcut testler: **51 geçti, 0 hata**. `webshop`, `webshop-account`, `webshop-payment`, `webshop-catalog`, `webshop-ledger`, `magaza-media` test dosyaları. Gerçek ödeme/host kapısı, yetki sınırları, test kayıtlarının gerçek defterlerden ayrılması, stok ve tutar davranışı dahil.
- 23 mağaza sayfası + 8 yönetim görünümü, 360/390/1440 genişliklerde tarandı: **100 sayfa/görünüm yüklemesi; yatay taşma ve JavaScript hatası yok** (93 ana tarama + 7 görsel kontrol).
- **26 etkileşim kontrolü geçti:** filtre, ürün/varyant fiyatı, adet/sepet, adres/fatura/ödeme özeti, kayıt koşulları, şifre sıfırlama, yardım araması, seçim görselleri; yönetim sipariş/ürün/eşleme pencereleri, sunucu hatasında form korunması, yenilemesiz giriş sonrası frame yetkileri.
- Son mobil başlık/menü düzeninden sonra ayrıca **12 odaklı görünüm**: taşma/JS hatası yok. Yasal/koleksiyon/teknik model/yeni şifre alt görünüm taraması ayrıca kaydedildi.
- 23 HTML içindeki tüm yerel `href/src` hedefleri kontrol edildi: **eksik yerel dosya yok**. Değişen altı JS dosyasında `node --check` ve kapsamlı `git diff --check` geçti.
- Tarayıcı deneyi gerçek worker/API kodu, geçici statik dosya adaptörü ve **yalnız `:memory:` SQLite** ile `localhost:4182` üzerinde çalıştırıldı; hiçbir canlı çağrı/yazma yok. Deney sunucusu işlem sonunda kapatıldı.
- Deney araçları/raporları depo dışındadır: `%TEMP%/lunapot-store-redesign-20260920/` (`report.json`, `interactions.json`, `final-layout.json`, `subviews.json`, `screenshots/`). Kısa ekran görüntüleri görsel olarak da incelendi.

## Ortak önizleme sınırı

Ana ajanın `localhost:8790` önizlemesi bu oturumun GET isteklerine **403 “Loopback Host required.”** döndürdü; `127.0.0.1:8790/magaza/` ise yönlendirme döngüsüne girdi. Bu nedenle 8790 doğrulaması başarılı diye raporlanmıyor. Yukarıdaki rota ve UI kanıtı ayrı yerel test adaptörüne aittir; asıl worker'ın canlı host engelleri ayrıca mevcut testlerle doğrulandı. Ürün işlevi açısından açık kalan kapsam işi yok; ortak önizleme sunucusunun host/yönlendirme ayarı ana ajan/verifier tarafından kontrol edilmeli.

## Değişen dosyalar

- `public/webshop.html`, `public/webshop.js`, `public/webshop.css`
- `public/magaza/store-redesign.css` (yeni)
- `public/magaza/site-shell.js`, `shop.js`, `store-commerce.js`, `store-account.js`, `account-security.js`
- Yukarıdaki envanterde yer alan `public/magaza/*.html` dosyalarının tamamı (23)
- Bu kapsam/doğrulama notu
