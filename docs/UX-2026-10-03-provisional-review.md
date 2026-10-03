# FA05 bağımsız inceleme — kapandı

**Karar: incelenen kapsamda açık, kanıtlı yayın engeli kalmadı.** PR01, PR02 ve PR03 aşağıdaki düzeltmelerle kapandı. Parent son tam koşuyu **1132 toplam / 1113 geçti / 19 atlandı / 0 hata**, hedef koşuyu **66/66 geçti** olarak bildirdi. Burada tam paket tekrar çalıştırılmadı; bağımsız PR03 ve eski handler atomik geri alma kontrolleri ayrıca geçti.

Repo: C:\Users\baran\Desktop\site\lunapot-panel. Başlangıç HEAD: 1597e37912d6d8870776aba19c8ac6fce0e2509e. Son kaynak kimliği ve kontrol: **03.10.2026 19:31:39 Türkiye / 16:31:39 UTC**. Sonuç aşağıdaki dosya özetlerine aittir.

Yalnız bu rapor değiştirildi. Banach/parent kaynakları, migration ve test dosyaları değiştirilmedi. Bütün yürütülen veri işlemleri sentetik ve bellek içi SQLite üzerindeydi; canlı okuma/yazma, SQL onarımı, migration uygulama, deploy veya commit yapılmadı.

## Kapanan bulgular

### PR01 — kısmi teslimde kuruş farkı: kapalı

Önceki sürümde 3 kg × 0,33 TL = 99 kuruş mal altı yarım kg teslimle kapanınca 102 kuruş düşüyor, stok değeri 96 kuruş kalıyordu; FIFO bunu düzeltmiyordu. Yeni kapanış görünümü eski hareketin değerini kümülatif farkla dağıtıyor; FIFO aynı planın değerini kullanıyor.

Bağımsız beş kontrol geçti:

| Durum | Son stok | Son değer | Eski değer kapanışı |
| --- | ---: | ---: | ---: |
| 3 kg / 99 kuruş, altı yarım kg teslim | 3000 milli | 99 kuruş | 99 kuruş |
| 0,003 kg × 3,33 TL, toplam 1 kuruş, üç teslim | 3 milli | 1 kuruş | 1 kuruş |
| Aynı 1 kuruşluk mal tamamen satılmış | 0 | 0 | 1 kuruş |
| Aynı eski mal, üç ayrı faturada toplam 3 kuruş gerçek maliyet | 3 milli | 3 kuruş | 1 kuruş |
| Üç ayrı fatura, mal tamamen satılmış | 0 | 0 | 1 kuruş |

Son FIFO kontrolünde ek writes/tamamla kalmadı.

### PR03 — sonraki girişin önceki teslimi engellemesi: kapalı

Eski karşı örnek: 12 Eylül tarihli, bağı doğrulanmış 10 kg faturasız giriş; aynı tedarikçi/ürünün 11 Eylül tarihli ayrı 2 kg faturası ve teslimi. Fatura 200, teslim 409 dönüyordu.

0065 korumaları artık muhasebeleştirmede fatura tarihini, teslimde teslim tarihini süzüyor. Özgün karşı örnek yeniden çalıştırıldı: **teslim 200, stok 12000 milli / 120000 kuruş, yanlış tahsis 0**. Post sırasının önce/sonra olması ve sonraki günün belirsiz eski kaydı için üç hedef regresyon testi de geçti. Aynı gün ve örtüşen eski kayıtların koruması sürüyor.

### PR02 — eski uygulama/yeni şema aralığı: tanımlanan bakım geçişiyle kapalı

İlk incelemede eski giriş kodu yeni şemaya movement_id=NULL satır bırakabiliyor; eski muhasebeleştirme kodu da yeni başlık kilidinde duruyordu. Trafik açık sürüm karışımı uygun değildi.

Somut önlemler doğrulandı:

- src/worker.js, yalnız RELEASE_MAINTENANCE==='1' iken bütün fetch yollarını 503 ile durduruyor. Cache-Control:no-store, Retry-After:30 ve güvenlik başlıkları korunuyor; scheduled işi başlatmıyor.
- Bağımsız kontrol altı farklı GET/POST/OPTIONS/HEAD isteği ve scheduled çağrısını kullandı. DB/ASSETS/AI alanlarına erişimi dahi hata veren getter'larla ölçüldü: **erişim 0**, bütün istekler 503, scheduled noop.
- 0065 yeni provisional satırında NULL movement_id değerini PROVISIONAL_LINK_REQUIRED ile reddediyor.
- HEAD/0064 ledger handler'ı yeni şemada çalıştırıldı: beklenen hata alındı; ec_party_entries, ec_stock_movements, ec_provisional_receipts ve ec_provisional_receipt_lines bütünüyle değişmeden kaldı. **Stok 0 / değer 0**; yarım borç, başlık, sayım veya bağsız satır kalmadı.
- Önceden var olan NULL satır değiştirilmedi; metadata bağı kuruldu ve sonraki kısmi fatura/teslim doğru kapandı.

Kapanış, parent'ın belirttiği bakım sırasına bağlıdır: gate/final sürümlerini etkinleştirmeden hazırlama → gate yayımlama ve 503 doğrulama → 30 saniye boşalma aralığı → 0065 → final sürüm ve doğrulama. Bu plan **uygulanmadı**; inceleme kod ve sentetik davranış doğrulamasıdır. Eski/yeni sürümleri bakım kilidi olmadan eşzamanlı yazdırma uyumluluğu iddia edilmiyor.

## Metadata, mali akış ve dışa aktarım

- Sentetik 6 giriş / 32 eski NULL satır, **32 ayrı metadata bağına** dönüştü. Özgün cari, stok ve giriş satırları birebir aynı kaldı; metadata UPDATE/DELETE reddedildi. Kullanıcının bildirdiği canlı 6/32 eşleşmeler yeniden canlıda sorgulanmadı.
- Değer eşleşmeyen eski kayıt bağlanmadı; zorlanan yanlış bağ INSERT'i reddedildi. Eski tahsissiz muhasebeleşmiş faturanın belirsiz teslimi 409 ile durdu. Eski stok ilişkisi bilinmiyorsa miktar/tutar sıfır yapılmıyor.
- İnceleme boyunca tedarikçi/ürün ayrımı, kısmi miktar ve KDV kuruşu, önceden ödeme, FIFO, açık maliyet, tekrar kapanış ve defter değişmezliği kontrolleri geçti. Durumlar open | partial | invoiced | legacy_unlinked.
- Parent'ın src/settings-api.js dışa aktarım düzeltmesi incelendi. business-export-budget testi **1/1 geçti**: seçilen bütün tablolar ve tahsis kolonları özgün içerikleriyle korunuyor; sorgu bütçesi aşılmıyor. Yeni bir export engeli gösterilmedi.

## Son dar testler

- PR03 adıyla seçilen uygulama/yükseltme testleri: **3/3 geçti**.
- PR02 upgrade / eski handler atomik geri alma testi: **1/1 geçti**.
- release-maintenance.test.js: **2/2 geçti**.
- business-export-budget.test.js: **1/1 geçti**.
- Bunlardan bağımsız son üç sentetik kontrol: eski NULL yazısının tam geri alınması, özgün PR03 karşı örneğinin 200 dönmesi, mevcut eski NULL kaydın korunup yeni metadata ile çalışması; hepsi geçti.
- Önceki dar FA05 turu 12/12 ve yukarıdaki beş kuruş senaryosu geçmişti. Banach/parent'ın daha geniş toplamları ayrıca kendileri tarafından raporlandı; bu belge onların son tam koşusunu bağımsız çalıştırmış sayılmaz.

Gerçek Cloudflare/D1 üretim eşzamanlılığı, canlı sürüm yayılımı, bakım süresinin sahadaki yeterliliği ve canlı 32 ilişkinin içeriği bu turda sınanmadı. Parent'ın son tam test sonucu yukarıda kaynağı belirtilerek kaydedildi. Gate/final sürümlerinin hazırlığı, etkin olmayan sürüm yüklemesi ve canlı geçiş bu incelemede yapılmadı; parent bu aşamalara henüz geçilmediğini bildirdi. Yeni bir kanıtlı hata çıkmadıkça bu inceleme kapsamında ek test genişletilmeyecek.

## İncelenen son sürüm

SHA-256:

| Dosya | Özet |
| --- | --- |
| migrations/0065_provisional_allocations.sql | a6adb7e89163f1c590a29a0f6338e61c6a92fbefccf3897ff2e3216f737733c4 |
| src/provisional-inventory.js | fdf4ec643fc663ea4b234850330430177889870de89c3b800ecff858994973de |
| src/accounting.js | ec4651d9ca029203561c43b27b403d8fa7147d368aaf66b6dad78522b32e5785 |
| src/ledger-api.js | 154789510759052d5ff78d07837503f5e8645180de803fe05a39ca6740da172c |
| src/fifo-cost.js | eed1730776c6f127cf81677b953a9a86a9cd0edb4e2e291c362aa818df2f213a |
| src/worker.js | 2facf9db9271409022f6cd7cc4c6d81187265609c4bb4d72592f16946dbd41ce |
| src/settings-api.js | 156216c474f94294edba51316eb30ec65b1ee4a665a04ef7908a1773f4397e30 |

Devam kaydı: status=complete; outcome=NO_DEMONSTRATED_RELEASE_BLOCKER_IN_REVIEWED_SCOPE; açık inceleme bulgusu=yok; parent son tam test sonucu başarılı olarak bildirildi; sürüm hazırlığı ve yetkili yayın koordinasyonu ayrı. Değişen tek yol: docs/UX-2026-10-03-provisional-review.md.
