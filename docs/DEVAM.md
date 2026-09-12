# Devam belgesi — tek yetkili güncel durum

Bu dosya deponun **tek yetkili devam belgesidir**. Her iş, kodla **aynı committe** burayı da günceller.
Depo dışındaki eski başlangıç notları (`Desktop/site/CLAUDE-*.md`) tarihseldir; çelişki olursa **bu dosya geçerlidir**.
Sohbet geçmişine güvenilmez.

Son güncelleme: 12 Eylül 2026

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

- **0035_purchase_documents.sql** yazıldı ve **yalnızca yerelde/testlerde** uygulandı.
- **Uzak (canlı) veritabanına HENÜZ UYGULANMADI.** Uygulamak Cloudflare oturumu gerektirir; bu turda yapılmadı.
- Bu migration uygulanmadan **PDF yükleme ve çeşit ailesi ekranları canlıda çalışmaz**.
- Uygulama komutu: `npm run db:remote` (bookmark alıp doğrulayan betik). Sonrasında bu belge güncellenmeli.
- Mevcut migrationlar (0001–0034) **değiştirilmedi**; 0035 yalnızca yeni nesne ekler ve çeşit dağıtımının
  alt sınırını 1'e indirir.

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

## 6. Kalanlar / açık işler

1. **0035'i canlı veritabanına uygula** (yukarıdaki uyarı).
2. **Gerçek belgeyle doğrulama:** Tropikal PDF örneği ile sütun/satır okuma, toplam ve KDV kontrolü.
   PDF satır çıkarma sezgiseldir; gerçek belge görülmeden "çalışıyor" denemez.
3. **Gerçek TY/HB Excel örneği:** sütun adları, işlem türü metinleri, işaret kuralı, kesintilerin KDV durumu,
   sipariş düzeyindeki kesintinin paketlere gerçekte nasıl yansıdığı.
4. **Taranmış belge (OCR):** panelde erişim yok. İstenirse ayrı bir karar ve erişim gerekir.
5. **Büyük dosyanın gerçek Worker/D1 sınırlarında** parti parti işlenmesi ölçülmedi (bellek içi test bunu kanıtlamaz).
6. **Banka eşleştirmesi** yok.
7. **Kargo (desi) tarifesiyle tahmin** bağlanmadı.
8. **Günlük tarayıcı indirme yardımcısı** yok.
9. Ekranlar tarayıcıda elle denenmedi (yönetici girişi gerekiyor); sözdizimi ve uçlar testlerle doğrulandı.

## 7. Sıradaki adım

Kullanıcı bir **gerçek Tropikal alış faturası PDF'i** ve bir **gerçek Trendyol sipariş + finans Excel'i** versin.
Önce 0035 canlıya uygulanır, sonra bu iki belgeyle sütun/satır okuma ve toplamlar birlikte doğrulanır.
