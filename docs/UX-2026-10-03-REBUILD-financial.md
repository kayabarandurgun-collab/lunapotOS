# Lunapot — Yeniden Tasarım / Finansal Hesap Denetimi

Tarih: 4 Ekim 2026 (3 Ekim yeniden tasarım çalışmasının devamı).
Depo: C:/Users/baran/Desktop/site/lunapot-panel.
Başlangıç: main / 6400642. Önceki FA01–05 raporu okundu; aşağıdakiler yeni, bağımsız karşı örneklerdir.

**Durum: ayrılan finans kapsamındaki beş kusur düzeltildi. Yeni regresyonlar 14/14, ilişkili doğrulama 97/97. Şema/migration/canlı veri onarımı gerekmiyor.** Commit, push, yayın veya canlı okuma/yazma yapılmadı. Eşzamanlı çalışan diğer ajanların dosyaları değiştirilmedi.

## Gösterilebilir önce / sonra

| Bulgu | Mevcut kodda gösterilen yanlış sonuç | Düzeltme sonrası |
|---|---|---|
| FB01 — Kargodaki ürünlerin farklı alış KDV oranları | Her biri net 100 TL olan %10 ve %20 KDV'li iki ürün, %20 satış oranıyla toplam **240 TL** maliyet gösteriyordu. 480 TL satışta nakit **240 TL** idi. | Maliyet **110 + 120 = 230 TL**, nakit **250 TL**. Hazırlanan/kargodaki ve aynı verili teslim sonucu tutarlı. Hem geçmiş hem kayıtlı tarife yolunda. |
| FB02 — Paket giderini bileşenlere dağıtma | 2 kuruş kargo üç eşit bileşene ayrı yuvarlanıp **3 kuruş** oluyordu. 10 kuruş toplam tahminde 7 kuruş zaten biliniyorsa diğer satıra 5 eklenip **12 kuruş** oluyordu. | Toplam **2 kuruş** korunur. Kısmen bilinen örnek **7 + 3 = 10 kuruş** olur; 15 kuruş gerçek gider varken 10 kuruş geçmiş tahmini bunu azaltmaz. |
| FB03 — Stopaj ürün payları | Dört eşit ürüne 2 kuruş stopaj dağıtımı **−1, −1, −1, +1** idi: son üründe sahte vergi iadesi / ek nakit. | **−1, −1, 0, 0**. Ürün ve satılan ilan paylarının toplamı paketle eşit; hiçbir gider payı artıya dönmez. |
| FB04 — Başabaşta ayrı kuruş yuvarlamaları | Net 39 kuruş maliyet → brüt 47 kuruş; %5 komisyon ve %1 stopajla önerilen **50 kuruş** satışın gerçek dökümü **−1 kuruş** zarar veriyordu. | Öneri dökümle yeniden doğrulanır: bu örnekte **51 kuruş → 0**. İstenen 94 kuruş hedef de eksik kalmaz. |
| FB05 — Güvenilir kesinti örneği | Teslim edilmiş fakat kesintisi hâlâ `pending` bir paketin girilmiş 100 TL kargosu, gerçek/doğrulanmış geçmiş diye öğreniliyordu. | Tamamen doğrulanmış (`confirmed`) kesintiler gerekir. Tek örnek onaysızsa tahmin yok; doğrulandığında 100 TL örnek kullanılabilir. |

## Kod ve sözleşme

- `src/performance-api.js`: FB01, FB02, FB03. KDV dahil maliyet bileşen bazında hesaplanır. Gönderilmiş pakette kendi sabit maliyeti; hazırlanan pakette ilgili tahmin motorunun stok maliyeti kullanılır. Yeni bilinen giderler korunur; yalnız eksik tutar için kalan tahmin dağıtılır. Gerçek defter kaydı değiştirilmez.
- `src/sales-presentation.js`: mevcut BigInt tabanlı en büyük kalan dağıtımı `allocateCents` olarak ortak kullanıma açıldı. Stopajın satılan ilan ve stok bileşeni görünümleri aynı payları alır. Stok ürünleri ayrı kalır; satılan set kimliği ve maliyeti ayrıştırılıp yeni ürün uydurulmaz.
- `src/fiyat-hesap-api.js`: eski `product_id` fiyat yolunda başabaş/hedefin kendi komisyon+stopaj dökümü kontrol edilir. Ulaşılmamış veya güvenli tamsayı dışındaki fiyat önerilmez. `mapping_id` yolunun mevcut hedef kontrolü korunur.
- `src/fee-history.js`: sorgu `fees_status` okur ve paketin herhangi bir satışının kesintisi onaylanmamışsa örneği dışlar. Ek sorgu veya yeni tablo yok.
- `src/urun-karlilik-api.js` **değiştirilmedi**; zaten ortak paket hesabını kullanır ve sonuçlar kendiliğinden aynı düzeltmeleri alır.

Alış KDV'si bilinmeyen **geçmiş tahmini** artık nakit tutarı üretmez; net katkı ayrı kalabilir ve neden açıklanır. Elle kaydedilmiş **tarife senaryosunda**, önceden mevcut satış KDV'sini maliyet varsayımı olarak kullanma davranışı korunur fakat artık `cash_note` içinde açıkça yazılır. Bilinen bileşen KDV'si hiçbir durumda bu varsayımla ezilmez. Tarife senaryosundaki gerçek sıfır stok değeri de yanlışlıkla profil yenileme maliyetine geçmez.

Bu değişiklik mevcut fiyat profili KDV'sini tarihsel alış belgesi KDV'sine dönüştüren bir şema tasarımı değildir. Yeni yasal vergi oranı veya muhasebe politikası eklenmedi. KDV oranları mevcut kayıt/girdilerden alınır.

## Test kanıtı

Yeni dosya: `tests/rebuild-financial.test.js`.

- Son hali: **14 test, 14 geçti, 0 hata**.
- Aynı testler, yalnız bu ajanın dört sunucu dosyası `HEAD` sürümüne döndürülmüş geçici kopyada: **13 kırmızı / 1 yeşil**. Sayısal karşı örnekler FB01–05 testlerinde gösterildi. Tarife bilinmeyen-KDV guardlarının iki kırmızısı eksik varsayım açıklamasından; sıfır değerli stok guardı eski kodda da yeşil ve yeni kaynak seçiminin korumasıdır.
- Kırmızı karşılaştırma çalışma deposunu değiştirmedi: `C:/Users/baran/AppData/Local/Temp/lunapot-financial-red-jKKhjb/red-output.txt`.
- İlişkili son doğrulama: **97/97**. Kapsam: yeni testler, satılan ilan/set, kâr ortak hesabı, stopaj, sayfalama/kapsam, sipariş tahmini, ilan fiyatı, R23, nakit sonuç ve önceki FA01–04 regresyonları.
- Yeni testler hem paket ↔ ilan hem paket ↔ stok bileşeni nakit korunmasını kontrol eder. Bilinmeyen KDV'nin null kalması, kısmen bilinen ücretler, kaydedilmiş gerçeklerin değişmemesi, kargodan teslime geçiş ve gönderim maliyeti korunması sınanır.

~~~powershell
node --test tests/rebuild-financial.test.js tests/sales-presentation.test.js tests/codex-kar-ortak.test.js tests/codex-kar-stopaj.test.js tests/order-estimate.test.js tests/offering-price.test.js tests/codex-fiyat-r23.test.js tests/codex-kar-kapsam.test.js tests/nakit-sonuc.test.js tests/financial-audit-2026-10-03.test.js
~~~

Tam paketin eşzamanlı çalışma anındaki sonucu: **1159 toplam / 1135 geçti / 19 ortam koşullu atlandı / 5 hata**. Son birleşik yayın doğrulaması değildir. Kalanlar:

1. `tests/arayuz-olcek.test.js:185` — `commerce-workflows.css:271`, v2-stat için 12px köşe mevcut ortak token kontrolüne uymuyor.
2. `tests/sales-ui-contract.test.js:75` — eski `ins-kpis` / tarih filtresi sırası beklentisi.
3. `tests/workspace-sales-navigation.test.js:6` — eski personel menüsü sıra beklentisi.
4. `tests/connections.test.js:100` — `50 source records fit Free D1 query budget and repeated page advances bounded draft imports`; `created` okunurken sonuç null.
5. `tests/connections.test.js:533` — `Yerelde paketi olmayan sipariş eskisi gibi taslak açar; tanınan ve yeni sipariş aynı çağrıda ayrışır`; aynı null sonuç.

İki connections hatası, bu dört finans dosyası HEAD olan aynı geçici kopyada ayrıca **2/2 tekrarlandı**. Finans düzeltmesi olmadan da mevcutlar. Başka ajanın uygulama alanına girilmedi. Tam çıktı: `C:/Users/baran/AppData/Local/Temp/lunapot-rebuild-financial-full-tests.txt`. Parent birleşik değişiklikler tamamlanınca tekrar çalıştırmalı.

## Yayına etkisi ve sınırlar

- **Migration yok. Canlı veri düzeltmesi yok. Eski satış, stok, cari veya maliyet defteri değişmez.** Etki rapor/öneri okunurken görünür.
- Farklı KDV'li bekleyen paketlerin nakit tahmini değişebilir; eksik KDV'li geçmiş tahminleri hesaplanamayan kapsamına geçebilir. Kullanıcı artık bu eksikliği görür.
- Stopajın paket toplamı değişmez; ürün/ilan arasında birkaç kuruşun dağılımı düzelir.
- Doğrulanmamış tarihsel örnekleri dışlamak örnek sayısını azaltabilir. Doğrulanmış kayıt gelene kadar yanlış güven yerine eksik tahmin döner.
- Paket gideri tahmini gerçek gider değildir. Bilinen gider geçmiş toplamı aşıyorsa bilinmeyen kalan 0 varsayılır ve paket hâlâ tahmini işaretlidir; gerçek ekstre gelince yeniden hesaplanır.
- Başabaş düzeltmesi, cebine kalan tutarın negatif olmamasını/hedefe ulaşmasını doğrular; tüm olası kuruş fiyatları arasında küresel minimum araması değildir. Mevcut sınırlı fiyat arama sözleşmesi korunur.
- Bu sınırlı denetim tüm muhasebenin hatasız olduğu iddiası değildir; beş somut yeni kusurun regresyonlarla kapatılmasıdır.

## Devam / devir

~~~yaml
---
session: lunapot-panel
date: 2026-10-04
status: complete
outcome: SUCCEEDED
---

goal: Ayrılan finans dosyalarında beş yeni kanıtlı hesap kusurunu düzeltmek.
now: Parent UI/diğer backend değişikliklerini birleştirip tam test paketini yeniden çalıştırsın.
test: node --test tests/rebuild-financial.test.js
done_this_session:
  - task: Bileşen KDV'si, kuruş koruma, başabaş ve onaylı geçmiş düzeltmeleri.
    files: [src/performance-api.js, src/sales-presentation.js, src/fiyat-hesap-api.js, src/fee-history.js]
blockers: []
questions: []
decisions:
  - persistence: Salt okunur hesap değişikliği; migration veya tarihsel kayıt onarımı yok.
findings:
  - conservation: Paket/ilan/bileşen toplamları aynı ortak dağıtımı kullanmalı.
worked: [Yeni sentetik karşı örnekler, HEAD karşılaştırması, ilişkili 97 test]
failed: [Tam pakette eşzamanlı UI ve connections alanlarında beş hata; parent takibinde.]
next: [Birleşik test, parent yayın kararı ve ana Claude raporuna özet]
files:
  created: [tests/rebuild-financial.test.js, docs/UX-2026-10-03-REBUILD-financial.md]
  modified: [src/performance-api.js, src/sales-presentation.js, src/fiyat-hesap-api.js, src/fee-history.js]
~~~
