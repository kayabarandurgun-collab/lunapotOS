# Devam belgesi — tek yetkili güncel durum

Bu dosya deponun **tek yetkili devam belgesidir**. Her iş, kodla **aynı committe** burayı da günceller.
Depo dışındaki eski başlangıç notları (`Desktop/site/CLAUDE-*.md`) tarihseldir; çelişki olursa **bu dosya geçerlidir**.
Sohbet geçmişine güvenilmez.

Son güncelleme: 12 Eylül 2026 (Codex odaklı inceleme düzeltmeleri)

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
