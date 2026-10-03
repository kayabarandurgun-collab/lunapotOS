# Mali doğruluk denetimi — 3 Ekim 2026

Depo: `C:/Users/baran/Desktop/site/lunapot-panel`, başlangıç `main / 1597e37`.
Kapsam: günlük alış/teslim, faturasız stok/açık maliyet, rapor aktarımı, set kârlılığı, tutar izinleri ve alan ayrımı. FA01–04 için dar backend düzeltmeleri; ardından açık kullanıcı yetkisiyle FA05 için yeni 0065 migration, ilgili backend ve testler değiştirildi. R01–R25 yeniden açılmadı; eski maliyet regresyonları korundu.

## Sonuç

**FA01–FA05 testle doğrulanıp düzeltildi. FA05 artık standart test paketinde; backend/test değişiklikleri donduruldu.** Bu sonuç tüm mali hesapların eksiksiz doğrulandığı veya canlı kayıtların onarıldığı anlamına gelmez.

| Kimlik | Öncelik | Kanıt / etki | Durum |
|---|---|---|---|
| FA01 | P1 | OCR kapısı, numara geçmişi yokken, yalnız iki geçmiş belge varken veya kalıplar karışıkken boş uyarıyı doğrulama sayıyordu. Yarım yüklemenin tekrarında hesaplanan biçim uyarısı yanıttan düşüyordu. | Düzeltildi: doğrulanamayan biçim açık uyarı döndürür; tekrar yanıtı uyarıyı korur. En az üç aynı kalıpla uyumlu numara otomatik yola devam eder. |
| FA02 | P1 | `amounts:none` olan fatura yetkili personel ham belge ayrıntısını ve OCR metnini HTTP 200 ile okuyabiliyordu. `extracted_json`, serbest metin ve base64 PDF, alan adına göre tutar gizlemesini aşıyordu. | Düzeltildi: alış belgesinin ham ayrıntısı, özgün parçası ve OCR için mevcut tutar izni gerekir (403). Liste ve sayfa bağlantısı uçları korunur. EC/LP ve izinli personel pozitif kontrolleri var. |
| FA03 | P2 | Bir adet 10 L ürün yerine iki adet 5 L gönderilmesi veya hediye eklenmesi, satılan tek ürünü raporda yeni set ilanına dönüştürüyordu. İkame ters kaydı satış adedini belirsizleştiriyor ve iade katkısına karışıyordu. | Düzeltildi: ilan kimliği özgün bileşenlerden gelir; fiziksel ek bileşenlerin maliyeti aynı ilanın kârında kalır. İkame müşteri iadesi sayılmaz. |
| FA04 | P1 | Otomatik başlık/katalog eşleştirmesi, satış KDV ayarı %20 olsa da ürün profilindeki %10'u yeniden yazıyordu: 240 TL brüt → 218,18 TL net; beklenen 200 TL. | Düzeltildi: eşleştirme ve eksik net tamamlama satış ayarını kullanır. Sentetik %8 ayarı da sınandı; oran koda gömülmedi. Tekrar aktarım ikinci satış/stok çıkışı üretmez. |
| FA05 | P1 | Faturasız girişin borç kapanışı yalnız tedarikçinin en eski açık kaydını seçiyor; ürün/miktar/belge bağı doğrulanmıyor. Stok kapanışı ise tedarikçiyi ayırmadan ürünün geçici sayımını tüketiyor. | Düzeltildi: 0065 ile ortak miktar tahsisi, kesin eski metadata bağı ve belirsizlikte gerekçeli 409. Geçmiş mali defter güncellenmez. |

## FA05: son tasarım

İlk iki kanıt: aynı tedarikçinin ilgisiz ürün faturası 1.200 TL geçici borcu yanlış kapatıyordu; başka tedarikçiden 2 adet aynı ürün geldiğinde stok 12 olması gerekirken 10 kalıyordu. Ayrı başarısız kanıt dosyası standart `tests/financial-audit-provisional.test.js` içine taşındı; artık geçiyor.

- Yeni giriş satırı kendi stok hareketinin kimliğini saklar. Fatura muhasebeleştirilirken aynı **tedarikçi + ürün + kalan miktar**, geliş tarihi/başlık kayıt sırası/satır kimliğiyle eskiden yeniye tahsis edilir. Fatura tarihinden sonraki giriş kendiliğinden tüketilmez. Tek fatura çok giriş, tek giriş çok fatura ve kısmi miktar desteklenir.
- `ec_provisional_allocations` fatura miktarı ve özgün geçici brütten bırakılan payı; `ec_provisional_receipt_allocations` fiziksel teslim payını tutar. Kaynak/fatura/teslim miktarı aşılamaz. Tetikler aynı işlemde çalışır; tekrar/yarışta aynı miktar iki kez kullanılamaz.
- Geçici borç tam ters kayıtla silinmez: tahsis edilen pay kadar değişmez artı cari kaydı eklenir. Önce özgün açık borç kapatılır; önceden ödenmiş payın kredisi yeni faturaya aktarılır. Özgün ödeme/borç değişmez, para hareketi üretilmez. Fatura gerçek net/KDV tutarını taşır; vergi kuralı icat edilmedi.
- Stok kapanışı ve açık maliyet tetiği **aynı teslim tahsisini** kullanır. Kapanış mal kabulüyle aynı transaction içindedir. FIFO farklı fiyatlı fatura satırlarını tam teslim kimliğiyle ayırır. Brüt pay ve kaynak stok değerinde birikimli yuvarlama, son kuruşun korunmasını sağlar.
- 0065, yeni append-only `ec_provisional_movement_links` tablosuna yalnız kanıtlı eski metadata bağlarını ekler. Kanıt: `GECICI-SAYIM-<başlık referansı> + ürün + tarih + miktar + ROUND(miktar*birim_maliyet/1000)`. İki yönlü tekillik, başka satırın açık bağı olmaması, önceki kapanış/ters kayıt olmaması gerekir. Eski başlık/satır/stok/cari miktar-tutar-tarih ve `movement_id` alanları aynen kalır; etkin görünüm özgün kimlik veya yeni bağı kullanır.
- Parent salt okunur kontrolünde 6 açık başlık / 32 eski satır, 32 farklı tekil hareket ve sıfır eski kapanış bildirdi. Gerçek veri burada kopyalanmadı veya işlenmedi. Aynı **6 başlık/32 satır yapısı** sentetik yükseltmede sınandı: metadata bağları oluştu; eski başlık, satır, stok hareketi/bakiyesi ve cari defterler değişmedi; yeni fatura çift stok üretmedi.
- Bağ belirsizse aynı tedarikçi/ürünün muhasebeleştirme ve teslimi açık gerekçeli **409** ile durur. Başka tedarikçi/ürün etkilenmez. 0065 öncesinde zaten muhasebeleşmiş ve miktar tahsisi olmayan fatura da açık faturasız girişin yanına sessizce stok ekleyemez: teslim `PROVISIONAL_PENDING_LINK` üzerinden 409 alır. Böyle eski faturaya geriye dönük tahsis/onarım bu işte yapılmaz.
- Bağ/tahsis/kapama kayıtları güncellenemez/silinemez; otomatik cari kapamalar ve kullanılmış teslimler elle terslenemez. Yanlış metadata SQL seviyesinde reddedilir. Mevcut geçmiş koruma tetikleri kaldırılmadı.

## Final API ve parent/Ohm sözleşmesi

`POST /api/ec/ledger/provisional` gövdesi değişmedi; yanıtta ek `provisional_status:'open'` bulunur. `GET /api/ec/ledger/provisional` başlık/satır özetlerini döndürür. Cari listesinin geçici borç satırında `provisional_status`, `provisional_released_cents`, `provisional_remaining_cents`, `provisional_lines` vardır.

| Durum | Anlam |
|---|---|
| `open` | Doğrulanmış giriş; henüz faturaya tahsis edilmedi. Kesin metadata bağı kurulan eski açık giriş de bu durumdadır. |
| `partial` | Bir kısmı faturaya tahsis edildi. |
| `invoiced` | Tamamı faturaya tahsis edildi. **Fiziksel teslim tamamlandı veya ödeme yapıldı anlamına gelmez.** |
| `legacy_unlinked` | Miktar bağı doğrulanamıyor. Eski `invoice_id` dolu kayıtlar da bu grupta; bilinmeyen kalanlar `null`, sıfır değil. |

Satır alanları: `invoiced_milli`, `received_milli`, `remaining_to_invoice_milli`, `remaining_to_receive_milli`. Sonuncusu **faturalanmış ama henüz fiziksel kapanışı yapılmamış** miktardır. `remaining_cents` faturası beklenen geçici brüt paydır; ödeme bakiyesi değildir. `invoice_id` ve `reversed_by` yeni durumun kaynağı değildir. Tutar izni yoksa para alanları `null`; miktar/durum görünür. LP bu ucu kullanamaz (403). Parent business-ui etiketlerini üstlendi; final enum değişmeyecek.

## Bağımsız inceleme sonrası son düzeltmeler

- **PR03 düzeltildi:** muhasebeleştirmedeki belirsiz aday koruması `p.occurred_on <= NEW.invoice_date`; teslimde hem belirsiz hem tahsissiz açık aday koruması `p.occurred_on <= NEW.occurred_on` kullanır. 12 Eylül girişi, 10/11 Eylül faturası ve 11 Eylül ayrı fiziksel teslimini engellemez. Aynı günkü tahsissiz teslim hâlâ 409 alır. Faturanın önce/sonra kaydedildiği iki sıra ve eski belirsiz giriş senaryosu önce başarısız, düzeltme sonrası geçti.
- **PR02 DB koruması tamamlandı:** 0065 sonrası yeni provisional satırın `movement_id=NULL` INSERT'i `PROVISIONAL_LINK_REQUIRED` ile reddedilir. Geçmiş NULL satırlar güncellenmez ve kesin metadata bağları korunur. `tests/helpers/provisional-handler-0064.js`, 1597e37 içindeki gerçek eski faturasız giriş dalının sabit örneğidir; güncel worker veya git/network kullanmadan eski yazıcıyı sınar. Geçişten önce eski handler çalışır; geçişten sonra geciken aynı handler reddedilir ve borç/başlık/stok/satır batch'i bütünüyle geri alınır. Güncel handler açık hareket bağıyla çalışır. Bu test de düzeltme öncesinde başarısız gösterildi.
- Parent'ın `RELEASE_MAINTENANCE` kapısı ve cron durdurma testleri son hedefli tura dahil edildi. Trafik sıralaması parent'ta: final/kapı sürümlerini pasif yükle → kapıyı yayımla → devam eden istekleri tüket → migration → final sürümü yayımla. NULL INSERT engeli geciken eski yazıcıya ek DB korumasıdır; canlı geçiş yapılmadı.
- PR01 kuruş toplamı bağımsız incelemede de geçti. PR03/PR02 son kaynakları yeniden dondu; API enum/istek gövdesi değişmedi. Önceki bağımsız inceleme raporunun hashleri bu son değişikliklerden öncedir.
## Test kaydı

- Başlangıç tam `npm test`: **1077 toplam, 1062 geçti, 15 atlandı, 0 hata**, 62,4 sn.
- FA01–04 önce başarısız regresyonlarla gösterildi. Son yeni dosya **12/12**, ilgili 20 dosyalık tur **173/173** geçti.
- FA05 öncesi son tam tur: **1099 toplam, 1082 geçti, 17 atlandı, 0 hata**. Bu eski sonuç FA05 sonrası tam paket iddiası değildir.
- FA05 ilk iki kanıt **2/2 başarısızdı**; artık standart `*.test.js` içinde geçiyor. Ek 1 kuruş artığı ve eski posted fatura teslimi ayrı başarısız testlerle gösterilip düzeltildi.
- **PR03/PR02 sonrası dondurulan sürüm: 9 dosya, 66/66 geçti**, 0 hata/atlanan, 7,3 sn. Yeni iki FA05 dosyası **25/25**, parent bakım kapısı **2/2**; diğerleri mevcut borç/FIFO/açık maliyet/atomik hata ve tekrar testleri. Eski tedarikçisiz sayım fixture'ları açık tedarikçi bağına geçirildi; mali sonuç beklentileri gevşetilmedi.
- 0065 hem SQLite bütün dosya uygulamasıyla hem Wrangler SQL ayrıştırıcısının böldüğü komutlarla geçti. 6/32 yükseltme, metadata/tahsis değişmezliği, tutar izni, LP ayrımı, kısmi/tam önceki ödeme, farklı tedarikçi, eşzamanlı iki fatura ve tekrar sınandı.
- Önceki çalışma sürümlerindeki birleşik tur 1125 toplam / 5 hata göstermişti; export ve font düzeltmeleri parent tarafından tamamlandı. Eski posted teslim, PR03 tarih kapsamı ve PR02 eski yazıcı koruması bu ajan tarafından düzeltildi. **Son tam `npm test`: 1132 toplam, 1113 geçti, 19 atlandı, 0 hata; 52,2 sn.** Tam sonuç `lunapot-fa05-pr03-full.log` dosyasındadır.
- Parent dışa aktarım sorgularını tablo/satır/sütun atlamadan birleştirdi; provisional satırlar yedeğe geri eklendi. Export sınırı ve içerik regresyonları son tam turda geçti. Bakım kapısı ve UI font testleri de dahildir; dışa aktarım için açık hata kalmadı.

Son hedefli komut:

`node --test tests/financial-audit-provisional.test.js tests/financial-audit-provisional-upgrade.test.js tests/faturasiz-mal-girisi.test.js tests/gecici-sayim-cok-satir.test.js tests/acik-maliyet.test.js tests/codex-maliyet-yaris.test.js tests/codex-maliyet-fifo.test.js tests/fifo-maliyet.test.js tests/release-maintenance.test.js`

Ham günlükler geçici dizinde: `lunapot-financial-audit-baseline-2026-10-03.log`, `lunapot-financial-audit-targeted-2026-10-03.log`, `lunapot-financial-audit-final-2026-10-03.log`, `lunapot-fa05-final-target.log`, `lunapot-fa05-pr03-target.log`, `lunapot-fa05-pr03-full.log`. Eşzamanlılık testleri aynı bellek içi SQLite'a eşzamanlı HTTP çağrılarıdır; canlı dağıtık D1 yük testi değildir.

## Değişen yollar

FA01–04:

- `src/purchase-document-api.js`
- `src/permission-policy.js`
- `src/sales-presentation.js`
- `src/report-stock-link-api.js`
- `tests/financial-audit-2026-10-03.test.js`

FA05:

- `migrations/0065_provisional_allocations.sql` — yeni şema, tetikler, kesin metadata bağı.
- `src/provisional-inventory.js` — yeni ortak kapanış/özet modülü.
- `src/accounting.js` — ortak tahsis üzerinden teslim ve açık 409 nedenleri.
- `src/ledger-api.js` — yeni girişte hareket bağı, durum/kalan alanları, EC sınırı.
- `src/fifo-cost.js` — tam teslim kimliği ve birikimli kuruş değeri.
- `tests/financial-audit-provisional.test.js` — eski ayrı kanıtın standart geçen sürümü; 14 test.
- `tests/financial-audit-provisional-upgrade.test.js` — 0064→0065 yükseltme ve eski handler; 11 test.
- `tests/helpers/provisional-handler-0064.js` — eski yazıcının sabit test örneği.
- `tests/faturasiz-mal-girisi.test.js`
- `tests/acik-maliyet.test.js`
- `tests/codex-maliyet-fifo.test.js`
- `tests/codex-maliyet-yaris.test.js`
- `tests/gecici-sayim-cok-satir.test.js`
- `docs/UX-2026-10-03-financial-audit.md`

Ayrı `tests/financial-audit-provisional-repro.mjs` standart teste taşındı; gizli/atlanan P1 kanıtı bırakılmadı.

## Sınırlar ve Claude devri

Bu ajan canlı okuma/yazma, SQL onarımı, canlı migration, deploy veya commit yapmadı. 0065 yalnız bellekte test edildi; canlı uygulanmış değildir. Parent canlıdan yalnız aggregate salt-okuma sonuçlarını paylaştı. Sonraki yetkili yayında 0065 ve worker birlikte ele alınmalıdır: eski worker yeni kapama kilitleriyle bazı akışlarda durabilir; yeni worker 0065 şemasını gerektirir. Canlı uygulama/onarım bu notla yetkilendirilmez.

Gerçek OCR modeli/tedarikçi PDF'leri ve Cloudflare/D1 üretim concurrency davranışı bu turda sınanmadı. Bütün muhasebe/vergi matematiğine genel doğruluk garantisi verilmez. Bağı belirsiz eski giriş veya eskiden posted olup miktar tahsisi bulunmayan fatura, ayrı inceleme gerektirir; miktar/tutar tahminiyle sessiz işlem yapılmaz.

`public/`, parent menü/daily-actions/mobile dock değişiklikleri, ilgisiz `.node-version`, `scripts/migrate-remote.mjs`, diğer belgeler, `.claude/`, `.Codex/` korunmuştur. UI etiket değişiklikleri backend hatası sayılmadı. Kaynak/testler donmuştur; bağımsız Locke incelemesi ve birleşik tam test parent koordinasyonundadır. FA02 ham belge izni reddi arayüzde normal yetki mesajı olarak gösterilmelidir.

Devir/süreklilik becerilerinin kaydı kullanıcı kapsamına uygun olarak bu tek belgede tutuldu; ayrı thoughts dosyası açılmadı.

```yaml
session: lunapot-panel-financial-audit
date: 2026-10-03
status: implementation_complete_frozen
outcome: FULL_SUITE_PASS_REVIEW_HANDOFF
goal: FA01–FA05 doğrulanmış mali/izin sorunlarını düzeltmek.
now: Kod/testler dondu; son tam test geçti; parent bağımsız son incelemeyi ve güvenli yayın sırasını birleştiriyor.
test: Tam paket 1132 toplam / 1113 geçen / 19 atlanan / 0 hata; hedefli 66/66; yeni FA05 25/25.
no_live_mutations: true
next:
  - Parent son bağımsız incelemeyi ve yayın koordinasyonunu tamamlar.
  - Yalnız yetkili sonraki yayında 0065 ve worker birlikte uygulanır.
```

Son donmuş 0065 SHA-256: `a6adb7e89163f1c590a29a0f6338e61c6a92fbefccf3897ff2e3216f737733c4`.
