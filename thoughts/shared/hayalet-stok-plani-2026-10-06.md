# NİHAİ PLAN — HAYALET RAF SAYIMI TELAFİSİ

**Kazanan tasarım: TASARIM 2** (tam ayna + `fifo-cost.js` `dus` kümesi). Gerekçe: üç tasarımın ikisi (1 ve 3) stok **adedini** doğru düzeltiyor ama üç ayrı mercek tarafından ölçülmüş biçimde, tam da önlediğini iddia ettiği **uydurma kayıp giderini** fatura anında yeniden üretiyor. Yalnız Tasarım 2'nin `fifo-cost.js` yaması bu zinciri kökten kesiyor; bir mercek bunu gerçek `fifoHesap` ile gerçek defter üzerinde 4 senaryo × 3 fiyat varyantında oynatıp **0,00 TL** ölçtü. Tasarım 2'nin ölümcül kusuru (`reference UNIQUE`) tek satırlık bir şema hatasıydı; aşağıda kapatıldı. Gereksiz ve ölçümle faydasız bulunan parçası (0070 kapısının gevşetilmesi) tamamen çıkarıldı.

**Veri düzeltmesi YAPILMALI.** "Fatura gelince kendiliğinden kapanır" iddiası YANLIŞ — kodu okuyarak doğruladım: `migrations/0065_provisional_allocations.sql:204-215` (`ec_provisional_closure_plan`) kapanış miktarını yalnız `SUM(ra.quantity_milli)` → `ec_provisional_receipt_allocations`'tan, yani **özgün irsaliye satırından** alıyor; `:216-219` (`ec_provisional_closure_validate`) kapanışın `NEW.quantity_milli=-p.quantity_milli` olmasını ZORUNLU kılıyor. Hayalet hiçbir tahsis satırına bağlı değil, dolayısıyla kapanış onu ne görür ne yutabilir. Aritmetik: sayım `+N`, hayalet `+G`, kapanış `−N`, fatura teslimi `+N` → panel `N+G`, gerçek `N`. **Hayalet kalıcı.**

---

## 0. Oturumda kendi okuyup doğruladığım şeyler (iddialara güvenmedim)

| Bulgu | Yer | Sonuç |
|---|---|---|
| Hayalet ayna → `orantili()` düşüyor | `src/fifo-cost.js:262` (son dal; `KAPANIS` regex `:219` tutmuyor) | ✓ DOĞRU |
| `orantili()` tükettiğini `sale:null` yazıyor | `src/fifo-cost.js:124` | ✓ DOĞRU |
| `kapanisIsle` onu KAYIP sayıyor | `src/fifo-cost.js:175` (`else kayipFark += h - hp.v`), `:197-198` | ✓ DOĞRU |
| Kayıp satırı GİDER olarak görünüyor | `src/accounting.js:159` (`'loss' category`), `src/money-planning-api.js:165-167` | ✓ DOĞRU — **doğrulama sorgusu `ec_expenses`'a bakarsa KÖRDÜR** |
| Değer tabanı koşulsuz | `migrations/0045_negative_stock.sql:39` — `allow_negative_stock` kaçışı YOK | ✓ DOĞRU (kırpma yerine **eleme** şart) |
| Hayalet referansı ÜRÜN TAŞIMIYOR | `src/report-stock-link-api.js:457` — `m.reference + '-SAT-' + packageId.slice(0,8)` | ✓ DOĞRU → Tasarım 2'nin `UNIQUE(reference)` şeması ölümcül |
| Çağrı try/catch İÇİNDE | `try` `:550`, `catch` `:654`, ikisi de `for` `:547` içinde | ✓ Tasarım 2'nin erteleme gerekçesi ve `:438`'deki yorum YANLIŞ → sert kapı 0072'ye GİREBİLİR |
| **`ec_stock_apply`'ın yürürlükteki gövdesi 0065:192'dir** | `grep "TRIGGER ec_stock_apply"`: 0002 → 0045 → 0047 → 0049 → **0065 (son)** | ✓ `0049:43-48`'in `GECICI-SAYIM-%` açık-maliyet formülü **YÜRÜRLÜKTE DEĞİL** → üç mercekteki "0049 hayalet körlüğü" bulgusu GEÇERSİZ, düzeltme gerekmiyor |
| Göç ATOMİK | `scripts/migrate-remote.mjs:36-41` — `d1_migrations` INSERT'i AYNI dosyada, `--file` import hatada geri alınıyor | ✓ Yarım göç ve göç içi cron penceresi YOK |
| Kırpma FIFO'yu bozuyor | `bekleyenCikis` `:110` → `gir()` `:102`: `p.q -= t; p.v -= 0` | ✓ Kaktüs kırpılırsa sonraki partinin birim maliyeti şişer → **kırpma değil eleme** |
| Teslim geri alma kapısı bakiye DEĞERİNE bakıyor | `migrations/0045_negative_stock.sql:55` → `RECEIPT_REVERSAL_COST` | ✓ Geri çekme bazı teslimlerin "geri al" düğmesini KALICI kapatır — §4'te beyan + ön kontrol |
| Mekanizmanın tüm yüzeyi | `grep` src/ public/ tests/: yalnız `report-stock-link-api.js` 445-466, 640, 646-649 + 0050 tetiği + 0070 kapısı | ✓ Başka okuyucu YOK |

---

## 1. İLERİ DÖNÜK KOD DÜZELTMESİ

### 1a. `src/fifo-cost.js` — **ZORUNLU, planın kalbi.** Bu olmadan göç UYGULANMAMALI.

Satır 62-63 şu an:
```js
  // Geri alınan teslim ve ters kaydı: ikisi de oynatılmaz (teslim hiç olmamış).
  const dus = new Set(kabulR.filter(g => g.ters).flatMap(g => [g.id, g.ters]));
```
Yerine:
```js
  // Geri alınan teslim ve ters kaydı: ikisi de oynatılmaz (teslim hiç olmamış).
  // AYNI DOKTRİN GERİ ÇEKİLMİŞ GEÇİCİ SAYIM İÇİN (0070 iptali, 0072 telafi geri alımı): sayım da,
  // TAM aynası da oynatılmaz. Ayna normal yoldan oynatılsa eksi 'purchase' + kapanış olmayan
  // referans aşağıdaki son dala (:262 orantili) düşer; orantili raftaki BÜTÜN partilerden orantılı
  // tüketir ve her tüketimi lotKayit'e sale:null yazar (:124). Fatura kapanışı (kapanisIsle :175)
  // o adetleri KAYIP sanıp fatura farkını ec_close_cost_revaluations kind='kayip' yazar; bunu
  // accounting.js:159 ve money-planning-api.js:165 kayıp GİDERİ gösterir (canlıda ölçüldü:
  // Klasmann TS1'de -1.725,27 TL, 04.10.2026). Yalnız TAM ayna düşülür: miktar ve değerin tam
  // negatifi tutmayan kayıt eski yoldan oynar. Kapanışı yazılmış sayım düşülmez (kapanış sayım
  // partisini arar); o yüzden önce provisional-close var mı diye sorulur.
  const aynasi = new Map();
  for (const m of mv) {
    if (m.kind !== 'purchase' || m.quantity_milli >= 0 || !m.reference) continue;
    if (m.reference.startsWith('TELAFI-IPTAL-')) aynasi.set(m.reference.slice(13), m);
    else if (m.reference.startsWith('GECICI-IPTAL-')) aynasi.set('GECICI-SAYIM-' + m.reference.slice(13), m);
  }
  const dus = new Set(kabulR.filter(g => g.ters).flatMap(g => [g.id, g.ters]));
  for (const m of mv) {
    const a = m.kind === 'count' && aynasi.get(m.reference);
    if (!a || a.quantity_milli !== -m.quantity_milli || a.value_cents !== -m.value_cents) continue;
    if (mv.some(x => x.reference?.startsWith('provisional-close:' + m.id + ':'))) continue;
    dus.add(m.id); dus.add(a.id);
  }
```
Ayrıca dosya başındaki anlatıya, satır 11'in (`receipt-reverse`) hemen altına:
```js
//  · geri çekilmiş geçici sayım (0070 iptali, 0072 telafi geri alımı) hiç olmamış sayılır: sayım da
//    tam aynası da oynatılmaz; böylece ayna raftaki gerçek partileri tüketip kapanışta kayıp
//    gideri doğurmaz;
```

**Neden güvenli:**
- `dus` yalnız `:68` (`mv.filter(m => !dus.has(m.id))`) ve `:259`'da kullanılıyor; ikisi de hareket kimliğiyle çalışıyor. `kabulR` kimlikleri de hareket kimliğidir (`0065:188` teslimi `NEW.id` ile yazıyor).
- Hayalet modelin rafından, aynası da bakiyeden **aynı miktarda** değer/adet düşürdüğü için `sonraki` (`:296`) ile `kalanDeger` (`:295`) birlikte iner → `artik` 0, `guvenli` bozulmaz.
- Tam-eşleşme testi hem ileri hem geri güvenli: eşleşme tutmazsa davranış **bugünküyle birebir aynı** kalır. `ec_stock_movements` değişmez olduğu için (`0002:16-17`) yazılan çift sonsuza dek eşleşir.
- `TELAFI-IPTAL-` öneki `:52`'nin `':FA65-'` kontrolüne, `:219` `KAPANIS` regex'ine, `0065:216` (`substr(...,1,18)='provisional-close:'`) ve `0070:100` (`substr(...,1,13)='GECICI-IPTAL-'`) kapılarına **çarpmıyor** — her üçü de tek tek kontrol edildi.
- `GECICI-IPTAL-` genellemesi ölçümle gerekli: o desen bugün canlıda iki üründe (`Genel BB 1000 ml −40`, `Perlit 10 L −10`, 30.09 mükerrer irsaliye iptali) duruyor ve genelleme yapılmazsa uydurma kayıp 99,18 → 110,03 TL'ye **çıkıyor**; genellemeyle her fiyat varyantında 0,00 TL. TS1'in 23.09'daki elle kayıtları (`gecici-iptal:TS1-2026-09-23`, küçük harf) bu desene **uymuyor** → TS1 defteri bilinçli olarak dokunulmadan kalır (ayrı mutabakat).

### 1b. `src/report-stock-link-api.js` — mekanizma kaldırılır

| Satır | İşlem |
|---|---|
| **429-444** | Yorum bloğu silinir; yerine şu gerekçe yazılır: `GECICI-SAYIM-%` bir **raf anlık görüntüsü değil**, faturasız girişin GELEN MİKTARIDIR (`ledger-api.js:380`). Gerçek raf sayımı delta yazar (`accounting.js:185`, `0067:85`) ve rezervasyon çakışması 0067'nin `WAREHOUSE_RESERVED` kapısıyla çözülür. Telafi 341 hareket / 398 adet hayalet üretti, 0072 ile kapatıldı. (`:438`'deki "bu çağrı try/catch dışındadır" cümlesi de yanlıştı: `try` `:550`, `catch` `:654`.) |
| **445-466** | `sayimTelafisiHazirla()` **tamamen silinir** |
| **638-640** | İki yorum satırı + `if (cur?.status !== 'reserved' && GITTI.test(durum)) await sayimTelafisiHazirla(...)` **silinir**; `const linked = {occurred_on: occurred};` kalır |
| **646-647, 649** | `const telafi = "SELECT COUNT(*) …"`, `const once = …` ve `if (… > once) steps.push('raf sayımı satışla düzeltildi')` **silinir**. `await call(ordersApi, '/api/orders/'+id+'/ship', …)` ve `steps.push('gönderildi')` **AYNEN kalır** |

**DOKUNULMAZ:** `:537` ve `:543`'teki `GITTI` (hangi paketin işleneceğine karar veriyor), **`src/ledger-api.js:380`** (`GECICI-SAYIM-` 0065'in bütün bağ makinesinin — `ec_provisional_link_candidates`, `ec_provisional_line_movements` — çapasıdır; değiştirmek mevcut 41 sayımı yetim bırakır). Hata yazıcıda değil, okuyucunun o kaydı "raf fotoğrafı" sanmasındaydı.

### 1c. `public/stock-history-ui.js` — `movementLabel`, `GECICI-SAYIM-` satırının ÖNÜNE

```js
 if(/^GECICI-SAYIM-.*-SAT-/.test(String(row.reference)))return 'Hatalı raf sayımı telafisi (0072)';
 if(String(row.reference).startsWith('TELAFI-IPTAL-'))return 'Raf sayımı telafisi geri alındı';
```
Sıra load-bearing: hayalet referansı da `GECICI-SAYIM-` ile başlıyor, bu yüzden bugün "Faturasız mal girişi" diye okunuyor. Yeni öneki etiketlemezsek 392 adetlik en büyük düzeltme stok kartında "Mal girişi" gibi görünürdü.

### 1d. Testler (ikisi de şu an yeşil, mevcut hatayı DOĞRU diye bağlamış)

- `tests/report-stock-link.test.js:488-502` — beklenti `/raf sayımı satışla düzeltildi.*gönderildi/` → `/gönderildi/`; `stockOf` 24000 → **16000**; `GECICI-SAYIM-X-SAT-%` hareketi `[]`. Test adı da düzeltilir.
- `tests/codex-rapor-stok.test.js:77-91` — fixture `allow_negative_stock`'u 1 yapmıyor (tarandı: 9 test dosyası yapıyor, bu değil). Telafi kalkınca `0050:82`'nin kapasite bonusu da kalkar ve raf (6) < sipariş (8) olduğu için `ORDER_INSUFFICIENT_STOCK` düşer. Test **ikiye bölünür**: (a) ayar 0 → paket taslak kalır, sebep stok yetersizliği; (b) ayar 1 → gönderilir, stok **−2**, `telafiler(f)` `[]`. **Canlıda ayar 1 olduğu için üretim davranışı (b)'dir.**
- `tests/codex-rapor-stok.test.js:52,71` — `telafiler(f)` `[]` beklentileri olduğu gibi geçer, değişiklik yok.

---

## 2. MEVCUT 398 HAYALET İÇİN KARAR

**392 adet / 11.075,00 TL geri çekilir (13 ürün). 6 adet / 2.417,34 TL (2 ürün) DOKUNULMAZ.**

Hiçbir şey yapmama seçeneğini üç ölçümle reddediyorum:
1. **Fatura kapanışı hayaleti kapatmıyor** (yukarıda kodla doğrulandı) — kendiliğinden geçmez.
2. **Sahip rafı panelde sayarsa 11.075,00 TL UYDURMA KAYIP GİDERİ doğar.** `migrations/0067_warehouse_workflows.sql:82-88` depo sayımını `kind='count'` + eksi `delta_value_cents` yazıyor, `migrations/0002_accounting.sql:33` (`ec_count_loss`) eksi değerli her sayımı `category='loss'` gidere çeviriyor. Bugün `ec_expenses`'ta 0 kayıp kaydı var. Sahip **tam bu günlerde rafları sayıyor** — bu, aciliyetin asıl sebebi.
3. **Panel stoğunun %38'i (392/1.035 adet), stok değerinin %26,5'i hayalet** ve sahip bununla sipariş kararı veriyor. İki ürünü elle saydı, ölçümle birebir tuttu: Perlit 10 L → 28 (saydığı 26-27), Orkide Toprağı → 151 (dediği "150'den az").

**Düzeltme biçimi: her hayalet harekete BİREBİR TAM AYNA**, `kind='purchase'`, eksi miktar, eksi değer, referans `TELAFI-IPTAL-<hayalet referansı>`, tarih **hayaletin kendi tarihi**.

Neden böyle:
- `kind='count'` **olamaz**: eksi değerli sayım `ec_count_loss` ile uydurma gider yazar (0070'in 720 TL'lik dersi).
- `kind='purchase'` + eksi miktar: `ec_stock_apply` (`0065:200` `NEW.quantity_milli>0`) kapanış üretmez, `ec_count_loss` (`kind='count'`) uyanmaz.
- **Ürün × irsaliye toplamı değil, hareket başına tam ayna**: `dus` kümesinin çalışması buna bağlı. Toplu/kırpılmış kayıt tam ayna olmaz, `dus`'a girmez, `orantili()`'ye düşer ve uydurma kayıp giderini geri getirir.
- **Tarih hayaletin kendi tarihi (bugün değil)**: hayalet hiç oynatılmadığı için tarih FIFO'ya hiç değmiyor; buna karşılık geçmiş stok raporları da (örn. "30 Eylül stoğu") doğru çıkıyor. Tasarım 1 ve 3'ün "bugüne tarihle ki zincirin sonunda kalsın" güvencesi kırılgandı (11 taslak paket 15.08'e kadar geriye uzanıyor ve rapor hattı satışı SİPARİŞ tarihiyle yazıyor, `:272`/`:568`); `dus` o güvenceyi gereksiz kılıyor.

**Kapsam dışı — kırpma DEĞİL, ELEME:** bir ürünün bugünkü stok değeri kendi hayalet değerini karşılamıyorsa o ürüne **hiç dokunulmaz**. Değer karşılanamıyorsa o değer ya çoktan COGS'a akmıştır ya daha önce elle geri çekilmiştir; iki durumda da otomatik çıkarma yanlıştır.
- **Klasmann TS1 Torf 210 L** — 2 adet / 2.333,34 TL. Hayaleti 23.09'da elle `gecici-iptal:TS1-2026-09-23` (−15 adet = 13 sayım + 2 telafi) ile **zaten geri çekilmiş**. Bakiye değeri 1.600,00 < 2.333,34 → elenir. İkinci kez çekmek `−733,34` demekti.
- **Tropikal Kaktüs ve Sukulent BB 225 ml** — 4 adet / 84,00 TL. Bakiye değeri 0,00; o 84,00 TL satışlara akmış (`migrations/0047_open_cost.sql:74-77` `ec_sale_stock` açık satışta bakiyenin tamamını süpürüyor, `ec_cost_settlements`'a hiç uğramadan). Panel **−10** kalır, gerçek **−14**. Kırpıp `−4 adet / 0 kuruş` yazmak FIFO'ya sıfır değerli 4 adetlik bekleyen çıkış bırakır (`:110` → `:102`: `p.q -= t; p.v -= 0`) ve sonraki Kaktüs alışının birim maliyetini ~%67 şişirir — aynı 84 TL **ikinci kez** tahsil edilirdi. 4 adet hayalet, gizli maliyet sapmasından az zararlı.

---

## 3. `migrations/0072_sayim_telafisi_geri_alindi.sql`

Dosyanın başına ev usulü anlatı bloğu: hangi iki kod parçası aynı kaydı farklı anladı, ölçülen 392 adet / 11.075,00 TL, TS1 ile Kaktüs'ün neden elendiği, `kind='purchase'` seçiminin iki ayrı gerekçesi (`ec_count_loss` **ve** `fifo-cost.js`'in `dus` kümesi), teslim geri alma kapısının kalıcı daralması (§4).

```sql
-- 1) MUSLUK KAPANIR. Bekleyen niyetler etkisizleşir; ec_report_count_offset_lock (0050:57)
--    applied_at'in bir kez konmasına AÇIKÇA izin veriyor. Niyet silinmez, güncellenmez.
UPDATE ec_report_count_offsets SET applied_at=CURRENT_TIMESTAMP WHERE applied_at IS NULL;

-- 2) Bekleyen niyet bir daha stok hareketine dönemez.
DROP TRIGGER ec_report_count_offset_on_ship;

-- 3) SERT KAPI: faturasız giriş sayımına bir daha telafi niyeti YAZILAMAZ. Kod bu göçten ÖNCE
--    yayınlandığı için bu kapıya çarpacak çağıran yoktur; yine de JS tarafında mekanizmanın
--    yeniden açılmasını kalıcı olarak engeller. ABORT, report-stock-link-api.js:550-654
--    arasındaki try/catch tarafından yakalanır: yalnız o sipariş 'skipped' olur, tur çökmez.
CREATE TRIGGER ec_report_count_offset_retired BEFORE INSERT ON ec_report_count_offsets BEGIN
 SELECT iif(substr((SELECT m.reference FROM ec_stock_movements m WHERE m.id=NEW.count_movement_id),1,13)='GECICI-SAYIM-',
  RAISE(ABORT,'PROVISIONAL_COUNT_NOT_SHELF'),NULL);
END;

-- 4) İZ TABLOSU (ekleme-sadece; 0065/0069 uyumlu). DİKKAT: tekillik anahtarı (reference,product_id)
--    çiftidir, reference TEK BAŞINA DEĞİL: hayalet referansı ürün taşımıyor
--    (report-stock-link-api.js:457 ref = <sayım ref>+'-SAT-'+packageId.slice(0,8)), bu yüzden tek
--    pakette iki ürün varsa iki hareket AYNI referansı taşır. Sistemin kendi anahtarı da böyledir:
--    ec_stock_movements UNIQUE(kind,reference,product_id) (0002:9).
CREATE TABLE IF NOT EXISTS ec_sayim_telafi_iptali(
 movement_id TEXT PRIMARY KEY REFERENCES ec_stock_movements(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),
 value_cents INTEGER NOT NULL CHECK(value_cents>=0),
 reference TEXT NOT NULL,
 occurred_on TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(reference,product_id));
CREATE TRIGGER ec_sayim_telafi_iptali_no_update BEFORE UPDATE ON ec_sayim_telafi_iptali BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_sayim_telafi_iptali_no_delete BEFORE DELETE ON ec_sayim_telafi_iptali BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- 5) UYGUN KÜMENİN ANLIK GÖRÜNTÜSÜ. Ayrı ifade olması ZORUNLU: aynı INSERT içinde ec_stock_apply
--    her satırda bakiyeyi değiştirir ve bağıntılı uygunluk testi satır satır kayardı.
--    Kural: ürünün bugünkü stok DEĞERİ kendi hayalet değerini karşılamıyorsa o ürüne dokunulmaz
--    (TS1 ve Kaktüs böyle elenir). Kırpma YOK: kırpma adet/değer ayrışması ve FIFO artığı doğurur.
INSERT INTO ec_sayim_telafi_iptali(movement_id,product_id,quantity_milli,value_cents,reference,occurred_on)
SELECT m.id,m.product_id,m.quantity_milli,m.value_cents,m.reference,m.occurred_on
FROM ec_stock_movements m
WHERE m.kind='count' AND m.quantity_milli>0 AND m.value_cents>=0
 AND m.reference LIKE 'GECICI-SAYIM-%-SAT-%'
 AND NOT EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind='purchase'
   AND x.product_id=m.product_id AND x.reference='TELAFI-IPTAL-'||m.reference)
 AND NOT EXISTS(SELECT 1 FROM ec_sayim_telafi_iptali t WHERE t.movement_id=m.id)
 AND m.product_id IN (
   SELECT g.product_id FROM
    (SELECT product_id,SUM(value_cents) v FROM ec_stock_movements
     WHERE kind='count' AND quantity_milli>0 AND value_cents>=0 AND reference LIKE 'GECICI-SAYIM-%-SAT-%'
     GROUP BY product_id) g
    JOIN ec_stock_balances b ON b.product_id=g.product_id
   WHERE b.value_cents>=g.v);

-- 6) ÖLÇÜM KAPISI (0050:11-14 ec_report_write_guard deseni). "Bugün ölçtüm, yarın koştur"
--    varsayımı KODA BAĞLANIR: hariç tutma artık ada değil VERİYE bağlı, ve kümenin ölçüldüğü
--    günden kaymış olması SESSİZ değil GÜRÜLTÜLÜ hata verir. Rakamlar 05.10.2026 ölçümüdür;
--    koşturmadan önce §Uygulama'daki sorguyla yeniden okunur.
CREATE TABLE ec_0072_guard(code TEXT NOT NULL);
CREATE TRIGGER ec_0072_guard_abort BEFORE INSERT ON ec_0072_guard BEGIN
 SELECT RAISE(ABORT,'SAYIM_TELAFI_OLCUM_DEGISTI');
END;
INSERT INTO ec_0072_guard(code)
SELECT 'olcum-degisti' FROM (SELECT
  (SELECT COUNT(*) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hn,
  (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hq,
  (SELECT COALESCE(SUM(value_cents),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hv,
  (SELECT COUNT(*) FROM ec_sayim_telafi_iptali) un,
  (SELECT COUNT(DISTINCT product_id) FROM ec_sayim_telafi_iptali) up,
  (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_sayim_telafi_iptali) uq,
  (SELECT COALESCE(SUM(value_cents),0) FROM ec_sayim_telafi_iptali) uv,
  COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0) ayar) x
WHERE x.hn!=341 OR x.hq!=398000 OR x.hv!=1349234          -- bütün hayalet
   OR x.un!=335 OR x.up!=13 OR x.uq!=392000 OR x.uv!=1107500  -- geri çekilecek
   OR x.hq-x.uq!=6000 OR x.hv-x.uv!=241734                -- ELENEN tam olarak TS1 + Kaktüs
   OR x.ayar!=1;                                          -- 0045 adet tabanı ve STOCK_RESERVED kapalı olmalı
DROP TRIGGER ec_0072_guard_abort;
DROP TABLE ec_0072_guard;

-- 7) AYNA HAREKETLERİ. Anlık görüntüden okur, bakiyeden okumaz. Hareket başına BİREBİR tam ayna:
--    fifo-cost.js'in dus kümesi tam-eşleşme arar; toplu ya da kırpılmış kayıt eşleşmez, orantili()'ye
--    düşer ve fatura kapanışında uydurma kayıp gideri yazdırır.
INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
SELECT 'telafi-iptal-'||t.movement_id,t.product_id,-t.quantity_milli,-t.value_cents,'purchase',
 'TELAFI-IPTAL-'||t.reference,
 'Raf sayımı telafisi geri alındı (0072): faturasız giriş sayımı raf sayımı değildir.',t.occurred_on
FROM ec_sayim_telafi_iptali t
WHERE NOT EXISTS(SELECT 1 FROM ec_stock_movements x WHERE x.kind='purchase'
 AND x.product_id=t.product_id AND x.reference='TELAFI-IPTAL-'||t.reference);
```

### Değer tabanı neden ERİŞİLEMEZ
`ec_stock_nonnegative`'in değer kolu (`0045:39`) koşulsuzdur. Uygunluk kuralı gereği her ürün için `bakiye_değer ≥ Σ hayalet_değer`; aynaların toplamı tam `−Σ hayalet_değer`. Dolayısıyla hangi sırada uygulanırsa uygulansın ara toplam hiçbir an 0'ın altına inmez. `0045:22`'deki tablo düzeyi `CHECK(value_cents>=0)` de ikinci emniyet kemeri. **TS1 dahil edilse `−733,34` ile `INVALID_STOCK_VALUE` atar ve tek ifade olduğu için bütün satırları düşürür** — eleme bu yüzden hem doğru hem zorunlu.

### İdempotentlik — dürüst cevap
| İfade | İkinci koşuda |
|---|---|
| 1 (`UPDATE … applied_at IS NULL`) | 0 satır |
| 4 (`CREATE TABLE IF NOT EXISTS`) | sessiz geçer |
| 5 (`NOT EXISTS` × 2) | 0 satır |
| 7 (`NOT EXISTS` + `UNIQUE(kind,reference,product_id)`) | 0 satır; `INSERT OR IGNORE` **kullanılmıyor**, sessizce yutulmaz |
| 2, 3, 6 (DDL) | `already exists` / `no such trigger` ile **patlar** |

DDL ifadeleri idempotent değil — bu, bu depodaki **bütün** göçler için geçerli ve tekillik `d1_migrations` ile sağlanıyor (`scripts/migrate-remote.mjs:28`). **Yarım uygulanma imkânsız:** `migrate-remote.mjs:36-41` dosyayı `d1_migrations` INSERT'iyle **birlikte tek `--file`** olarak gönderiyor ve D1 file import'u hatada tamamını geri alıyor. Yani 0072 ya tamamen uygulanır ya hiç; elle ikinci kez koşturulsa ilk DDL'de durur ve hiçbir şey değişmez. (Tasarım 1 ve 3'ün "yarım uygulanırsa yeniden koştur" güvencesi yanlıştı; doğru güvence budur.)

---

## 4. ÖLÇÜLMÜŞ ETKİ

### Stok — 13 ürün (KDV hariç)

| ürün | adet: panel → gerçek | değer: panel → gerçek |
|---|---|---|
| Tropikal Orkide Toprağı 3 L | 264 → **151** | 6.864,00 → 3.926,00 |
| Tropikal Yaprak Temizleyici 250 ml | 157 → **55** | 3.925,00 → 1.375,00 |
| Tropikal Orkide BB 225 ml | 229 → **121** | 4.809,00 → 2.541,00 |
| Tropikal Perlit Karışımlı Toprak 10 L | 43 → **28** | 2.967,00 → 1.932,00 |
| Tropikal Yaprak Parlatıcı 750 ml | 11 → **5** | 1.650,00 → 750,00 |
| Tropikal Genel BB 225 ml | 71 → **47** | 1.491,00 → 987,00 |
| Tropikal Genel BB 1000 ml | 22 → **12** | 1.012,01 → 552,01 |
| Tropikal Çiçek Açan BB 1000 ml | 22 → **20** | 1.012,00 → 920,00 |
| Tropikal Orkide BB 1000 ml | 10 → **8** | 460,00 → 368,00 |
| Tropikal Çiçek Açan BB 225 ml | 14 → **10** | 294,00 → 210,00 |
| Tropikal Yeşil Yapraklı BB 225 ml | 12 → **8** | 252,00 → 168,00 |
| Tropikal Perlit Karışımlı Toprak 5 L | 9 → **8** | 324,00 → 288,00 |
| Tropikal Orkide BB 500 ml | 13 → **12** | 416,00 → 384,00 |
| **TOPLAM** | **−392 adet** | **−11.075,00 TL** |

Dokunulmayan: Klasmann TS1 2 adet / 2.333,34 TL · Tropikal Kaktüs ve Sukulent BB 225 ml 4 adet / 84,00 TL (panel −10 kalır, gerçek −14).

Stok varlığı **41.782,01 → 30.707,01 TL**. `src/panorama-api.js:134-145` KDV dahil de gösterdiği için brüt ≈ **−13.290,00 TL**. **Bu bir kayıp değil, hiç var olmamış varlığın silinmesidir.**

### Cari borç: **SIFIR ETKİ** ✓ VERIFIED
`ec_stock_movements` üzerindeki yürürlükteki bütün tetikler tek tek okundu — `ec_stock_immutable_update/delete` (0002:16-17), `ec_count_loss` (0002:33), `ec_stock_nonnegative` (0045:37), `ec_stock_reservations_guard` (0045:99), `ec_cost_dirty_mark` (0049:19), `ec_stock_apply` (0065:192, yürürlükteki gövde), `ec_provisional_closure_validate` (0065:216), `ec_provisional_cancel_movement_validate` (0070:99). **Hiçbiri `ec_party_entries`, `ec_payment_allocations` ya da `ec_provisional_receipts`'e yazmıyor.** `ec_provisional_line_balances.cancelled` yalnız `'GECICI-IPTAL-'||r.reference` tam eşitliğine, `legacy_closed_milli` yalnız `provisional-close:` önekine bakıyor; `TELAFI-IPTAL-` ikisine de uymuyor → hiçbir faturasız giriş satırı "iptal" sayılmaz, `eligible` değişmez, fatura kapanış yolu ve tedarikçi borcu olduğu gibi kalır.

**Yalova Seçkin −5.520,00 TL (3 adet: 30.09 irsaliye `000002` 1 adet/1.680,00 + 05.10 irsaliye `0000879` 2 adet/3.840,00, tahsis yok, ay başında ödenecek)** ve Tropikal'in açık irsaliye borçları **kuruşu kuruşuna yerinde kalır**. Ayna hareketi `ec_purchase_returns` kaydı da yaratmaz (alış iadesi ayrı tablodan doğuyor, `src/purchase-return-api.js:30-38`).

### Kâr raporu
- **Geçmiş satış maliyeti DEĞİŞMEZ.** Hayalet ve aynası hiç oynatılmıyor → model değeri ile bakiye aynı miktarda iner, `artik` 0 kalır, `ec_cost_revaluations` satırı doğmaz. Ayrıca `orantili()`/`dagit()` yapısal olarak bir satışın `brut`'una hiç dokunamaz (yalnız raftaki kuyruk parçalarını değiştirir) — yani güvence iki katmanlı.
- **Uydurma kayıp gideri: 0,00 TL.** Ayna `kind='purchase'` olduğu için `ec_count_loss` uyanmaz **ve** `dus` kümesi sayesinde `kapanisIsle`'nin `kayipFark` kolu hiç tetiklenmez. Bu ikinci kapı olmasa 4 bekleyen Tropikal faturası geldiğinde kapanmayı bekleyen 1.653 adet / 52.763,00 TL üzerinden gider yazılırdı (canlı emsal: TS1'de 4 adette 1.725,27 TL = sayım değerinin %31'i).
- **Birim maliyet SAPMAZ.** 13 ürünün hepsinde parti birim değeri TEK (2.100 / 2.500 / 2.600 / 3.200 / 3.600 / 4.600 / 6.900 / 15.000 kuruş). Örn. Orkide Toprağı: 686.400/264 = 2.600 → 392.600/151 = 2.600. `src/orders-api.js:327,358` ve `src/webshop-ledger.js:74` ortalaması ne geçmişte yanlış maliyet verdi ne gelecekte verecek.
- **Önlenen zarar: 11.075,00 TL** uydurma kayıp gideri (sahip rafı panelde sayınca doğacaktı). Düzeltmeden sonra aynı sayım yalnız GERÇEK eksiği gider yazar (örn. Orkide Toprağı 151 → ~140 = 11 adet × 26,00 = **286,00 TL** meşru kayıp).
- **Düzelmeyen kalıntı, dürüstçe:** Kaktüs'ün **84,00 TL**'si Eylül satış maliyetinde kalır; Eylül kârı o kadar iyimser kalır. Geriye dönük düzeltmek `ec_cost_revaluations` yazmak demektir, geçmiş kâr raporunu değiştirir, kapsam dışı. Ayrıca 04.10'da TS1 için yazılmış **−1.725,27 TL**'lik mevcut `kayip` satırı değişmez kayıttır, yerinde kalır; ayrı TS1 mutabakatına aittir.
- **Ekranlar:** depo listesi ve ikmal önerisi (`warehouse-api.js:19-40`), web mağaza (`webshop-catalog.js:64`), paket kârlılığı (`performance-api.js:204,231`), fiyatlama (`pricing-api.js:21`), tedarikçiye iade değeri (`purchase-return-api.js:38`) gerçek adete iner. **Az-stok uyarı seli olmaz:** `min_stock_milli>0` olan ürün 0, `ec_warehouse_reorder_settings` boş — `attention-api.js:25-28` eşik 0'a baktığı için bu ekran etkisi bugün canlıda teorik.

### BEYAN EDİLMESİ GEREKEN GERİ DÖNÜŞSÜZ ETKİ
`migrations/0045_negative_stock.sql:55` (`ec_receipt_reversal_validate`) bir teslimin değerini **ürünün toplam bakiye değeriyle** karşılaştırıyor: `b.value_cents<g.value_cents` → `RECEIPT_REVERSAL_COST`. Bakiye değeri 11.075,00 TL düştüğü için **bugün geri alınabilen bazı mal teslimleri bundan sonra kalıcı olarak geri alınamaz** (ölçülen: 5 teslim, toplam 4.920,00 TL — `Genel BB 1000 ml/TRP2026000001043`, `Genel BB 225 ml/TRP2026000001041`, `Orkide BB 1000 ml/TRP2026000001058`, `Perlit 10 L/TRP2026000001080`, `Yeşil Yapraklı 225 ml/TRP2026000001037`). Panelde karşılığı `public/accounting-ui.js:409` "Yanlış teslimi geri al" düğmesidir ve 409 ile reddedilecek. Geri dönüş yok (0002:16-17 IMMUTABLE_LEDGER). **Bu bilinçli bir takastır ve göçten ÖNCE sahibe sorulmalıdır** (§Uygulama, adım 2).

İkinci beyan: `src/provisional-inventory.js:4-5` `provisionalClose` kapanış değerini o anki stok değerine **sessizce kırpıyor** ve `0065:216-218` kırpılmış değeri (`BETWEEN -p.value_cents AND 0`) bilerek kabul ediyor; eksiği `0049`'un `tamamla` kaydı karşılıyor. Geri çekme bu yastığı 11.075,00 TL küçültüyor. Birinci mertebede sorun yok — teslim (+değer) `src/accounting.js:349`'da `provisionalClose`'dan **önce** aynı `db.batch`'e giriyor. Ama Tropikal faturaları geldiğinde `fifo-cost.js:298`'in `guvenli` bayrağı bazı ürünlerde `false` olabilir; o zaman motor o ürün için **hiçbir şey yazmayıp** yalnız `console.error` basar (`:312-314`) ve maliyet düzeltmesi sessizce atlanır. **Bu yüzden faturalar girildikten sonra ürün başına `GET /api/ec/cost-fifo/preview?product_id=…` kontrolü zorunludur** (§Uygulama, adım 6).

---

## 5. İŞLETME SAHİBİNE ONAY SORUSU

> Paneldeki Tropikal stokları olduğundan fazla görünüyor; sebebini buldum. Faturasız mal girişi yaptığında panel o malı bir kez stoğa alıyor, sonra o malı satınca **bir kez daha** ekliyor. Bu yüzden 13 Tropikal ürününde toplam **392 adet** ve **11.075 TL** gerçekte olmayan mal duruyor. Senin elle saydığın iki ürün bunu doğruluyor: Perlit 10 L panelde 43 → düzeltince **28** (sen 26-27 saydın), Orkide Toprağı 3 L panelde 264 → düzeltince **151** (sen "150'den az" dedin). En büyükleri: Orkide Toprağı **264 → 151**, Orkide Bitki Besini 225 ml **229 → 121**, Yaprak Temizleyici **157 → 55**, Perlit 10 L **43 → 28**, Genel Bitki Besini 225 ml **71 → 47**. Toplam stok değeri **41.782 TL → 30.707 TL** olacak. Bu bir zarar değil, hiç olmayan malın silinmesi: **tedarikçi borçlarının hiçbiri değişmiyor** (Seçkin'e 3 adet / 5.520 TL borç aynen duruyor, ay başında ödenecek) ve **geçmiş kâr rakamları da değişmiyor**. Düzeltmezsek sen rafı panelden saydığın gün panel 11.075 TL'lik **olmayan bir zarar** yazacak. Bir de: Klasmann TS1'in panelde 1 adet görünmesi bu hatadan değil, bugünün ikinci satışı pazaryeri raporundan henüz gelmediği için; o satış gelince kendiliğinden **0** olacak ve bu düzeltmeden sonra yanlış tekrar eklenmeyecek. **Bu rakamları onaylıyor musun?**

---

## 6. UYGULANMAMASI GEREKEN — CAZİP AMA YANLIŞ ADIMLAR

1. **Göçü koddan ÖNCE koşturmak.** README:62'nin "önce `db:remote`, sonra `deploy`" sırası bu göç için **GEÇERSİZ.** Önce `src/fifo-cost.js` yayına çıkmalı, sonra göç. Aksi halde 15 dakikalık cron aynaları ESKİ FIFO ile okur, `orantili()` sayım lotunu `sale:null` tüketir ve geçmiş satışlara ~321 adet **değişmez** `ec_cost_revaluations` satırı yazar (net para etkisi 2 TL altı ama kayıt çöpü), üstüne fatura geldiğinde `kayip` gideri doğar.
2. **`src/fifo-cost.js` yamasını atlamak ya da yalnız `TELAFI-IPTAL-` ile sınırlamak.** Yama olmadan bütün tasarımın merkez iddiası ("gider etkisi yoktur") çöker. `GECICI-IPTAL-` genellemesi olmadan mevcut durumdan **daha kötü** olur (99,18 → 110,03 TL, ölçüldü).
3. **0070'in `PROVISIONAL_CANCEL_OFFSET` kapılarını (`0070:129-134`) gevşetmek.** Üç mercek bağımsız ölçtü: 5 faturasız girişin 4'ü `PROVISIONAL_CANCEL_COST` (`0070:124-126`, 149/3/9 settlement) ve `PROVISIONAL_CANCEL_STOCK` (`0070:142`, `allow_negative_stock` bu kapıyı AÇMAZ) ile **zaten** kilitli; temizlik bu kapıyı daha da sıkıyor. Kazanç en iyi halde 1 irsaliye, bedel 10 kapılı bir tetiği elle yeniden yazmak (tek harf hatası `PROVISIONAL_CANCEL_PAID`/`_COST`/`_CLOSED` korumasını sessizce silebilir) ve bu kapıyı kapsayan **tek test yok**. Sahip bu irsaliyeleri iptal etmek istemiyor: mal geldi, borç gerçek. Beyan: **beş faturasız giriş bu göçten sonra da iptal edilemez kalır, bugünün 6.750,00 TL'lik girişi dahil.**
4. **`kind='count'` + eksi değer yazmak.** `ec_count_loss` (0002:33) uydurma kayıp gideri yazar — 0070'in 720 TL'lik dersi.
5. **Değeri kırpıp adedi tam yazmak (Tasarım 1 ve 3'ün yolu).** Kaktüs'te FIFO'ya sıfır değerli bekleyen çıkış bırakır, sonraki partinin birim maliyetini ~%67 şişirir, aynı 84 TL ikinci kez tahsil edilir. Ayrıca hangi ürünün kırpıldığı **her gün değişir** ve migration bunu hiç bildirmez.
6. **Hariç tutmayı ürün adı/kimliği sabitiyle yapmak.** §3 adım 6'daki ölçüm kapısı bunu veriye bağlıyor; sabit kimlik yazım hatasıyla sessiz çift düzeltmeye yol açar.
7. **Toplu (ürün × irsaliye) ya da bugüne tarihli tek hareket yazmak.** `dus` kümesi tam-eşleşme arar; toplu kayıt eşleşmez ve bütün değer güvencesi düşer.
8. **Doğrulamayı `SELECT COUNT(*) FROM ec_expenses WHERE category='loss'` ile yapmak.** Bu sorgu bugün 0 dönüyor, oysa aynı anda −1.725,27 TL'lik bir "loss" satırı kâr ekranında duruyor: o satır `ec_close_cost_revaluations`'ta ve gider satırı **API katmanında** üretiliyor (`accounting.js:159`). Doğru prob §Uygulama adım 6'da.
9. **`src/ledger-api.js:380`'e dokunmak.** `GECICI-SAYIM-` 0065'in bütün bağ makinesinin çapasıdır; değiştirmek mevcut 41 sayımı yetim bırakır.
10. **`migrations/0049:43-48`'deki `GECICI-SAYIM-%` formülüne `-SAT-` dışlaması eklemek.** O `ec_stock_apply` gövdesi **yürürlükte değil** (0065:191-201 ile değiştirilmiş, sonrasında override yok — `grep` ile doğrulandı). Üç mercekteki bu bulgu geçersiz; dokunmak en iyi halde etkisiz.
11. **`ec_order_reserve_validate`'i (0050:76-83) yeniden yazmak.** §3 adım 1 bekleyen niyetleri `applied` işaretlediği için `0050:82`'deki kapasite terimi kalıcı 0 olur; ayrıca `allow_negative_stock=1` o kontrolü tamamen bypass ediyor. 5 kapılı bir tetiği elle yeniden yazmak karşılıksız risk.
12. **Göçten ÖNCE panelde depo sayımı yapmak.** `ec_warehouse_apply` (0067:82-88) + `ec_count_loss` → **11.075,00 TL sahte kayıp gideri**, değişmez kayıt. Sahibe söylenmeli: **rafları panele girmeyi bu düzeltme bitene kadar beklet.**

---

## UYGULAMA SIRASI

1. **Kod:** `src/fifo-cost.js` (1a), `src/report-stock-link-api.js` (1b), `public/stock-history-ui.js` (1c), testler (1d). `npm test` yeşil. **`main`'e gönder → otomatik yayın.**
2. **Göçten ÖNCE, salt okuma:** bugün geri alınabilen ama geri çekmeden sonra geri alınamayacak teslimleri listele (`ec_goods_receipts` × `ec_stock_balances`, `0045:55` koşulu geri çekme sonrası bakiyeyle). Çıkan 5 teslim sahibe tek tek gösterilip "bu teslim miktarları doğru mu?" diye sorulur; yanlış olan varsa **bugün** panelden düzeltilir.
3. **Ölçümü yenile** (salt okuma) ve §3 adım 6'daki dokuz sabiti karşılaştır:
   ```sql
   SELECT (SELECT COUNT(*) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hn,
     (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hq,
     (SELECT COALESCE(SUM(value_cents),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%') hv,
     COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0) ayar;
   -- ve uygun küme:
   SELECT COUNT(*) un,COUNT(DISTINCT m.product_id) up,SUM(m.quantity_milli) uq,SUM(m.value_cents) uv
   FROM ec_stock_movements m WHERE m.kind='count' AND m.quantity_milli>0 AND m.value_cents>=0
    AND m.reference LIKE 'GECICI-SAYIM-%-SAT-%'
    AND m.product_id IN (SELECT g.product_id FROM (SELECT product_id,SUM(value_cents) v FROM ec_stock_movements
      WHERE kind='count' AND quantity_milli>0 AND value_cents>=0 AND reference LIKE 'GECICI-SAYIM-%-SAT-%'
      GROUP BY product_id) g JOIN ec_stock_balances b ON b.product_id=g.product_id WHERE b.value_cents>=g.v);
   ```
   Beklenen: `341 / 398000 / 1349234 / 1` ve `335 / 13 / 392000 / 1107500`. Kaymışsa **sabitleri körlemesine güncelleme**: elenen kümenin hâlâ tam olarak {TS1, Kaktüs} olduğunu doğrula, sebebini anla, sonra güncelle. (Beklenen tek kayma: bugünün 2 açık niyeti o pencerede harekete dönerse +3 adet / +78,00 TL; o hayaletler de aynı tedaviye uygundur.)
4. **`npm run db:remote`** → 0072. Ölçüm kapısı atarsa (`SAYIM_TELAFI_OLCUM_DEGISTI`) göçün tamamı geri alınır, veritabanı değişmez; adım 3'e dön.
5. **Göç sonrası doğrulama (salt okuma):**
   ```sql
   SELECT (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_stock_movements WHERE kind='count' AND reference LIKE 'GECICI-SAYIM-%-SAT-%')
        + (SELECT COALESCE(SUM(quantity_milli),0) FROM ec_stock_movements WHERE kind='purchase' AND reference LIKE 'TELAFI-IPTAL-%') net_adet,
     (SELECT COUNT(*) FROM ec_sayim_telafi_iptali) iz,
     (SELECT COUNT(*) FROM ec_report_count_offsets WHERE applied_at IS NULL) acik_niyet,
     (SELECT COUNT(*) FROM ec_close_cost_revaluations WHERE kind='kayip') kayip_satir,
     (SELECT COALESCE(SUM(value_cents),0) FROM ec_close_cost_revaluations WHERE kind='kayip') kayip_kurus,
     (SELECT COUNT(*) FROM ec_expenses WHERE category='loss') gider_loss;
   ```
   Beklenen: `net_adet = 6000` (yalnız elenen TS1+Kaktüs), `iz = 335`, `acik_niyet = 0`, **`kayip_satir = 1` ve `kayip_kurus = -172527` (bugünkü TS1 tabanı — ARTMAMALI)**, `gider_loss = 0`.
6. **FIFO turu sonrası, ürün başına:** `GET /api/ec/cost-fifo/preview?product_id=<13 ürün>` → her üründe `artik_cents = 0` ve `atlanan` boş; `tamamla` içinde `kind='kayip'` satırı **olmamalı**. Aynı kontrol **Tropikal faturaları girildikten sonra tekrar** yapılır (kapanış yastığı küçüldüğü için `guvenli=false` sessizliği burada görülür).
7. **Sahibe söyle:** rafları panele girmek artık güvenli; ilk gerçek sayımda çıkacak eksik meşru kayıp olarak yazılacak (Orkide Toprağı'nda beklenen ~11 adet / ~286 TL).

---

## KAPSAM DIŞI, AMA AÇIK KALAN İKİ İŞ
- **Klasmann TS1 mutabakatı.** Panelde +1 adet / 1.600,00 TL. Bu hatadan değil: 23.09'daki elle düzeltme setinden (`gecici-iptal:TS1-2026-09-23` −15 adet, `urun-duzeltme:plugmix-ts1-2026-09-23` +2 adet "Seçkin YSK2026000000402 faturası Plug Mix olarak kesilecek", `deger-duzeltme:ts1-a/-b` net 0 adet / −8.400,02 TL) ve bugünün ikinci satışının panele düşmemesinden geliyor. Satış aktarılınca 0 olur. Hafızadaki açık Plug Mix konusuyla birlikte kendi mutabakatını gerektiriyor.
- **Kaktüs ve Sukulent BB 225 ml**: 4 adet hayalet ve 84,00 TL COGS sapması bilinçli olarak açıkta bırakıldı; adet −10 kalır, gerçek −14. Ürünün defteri zaten ayrışmış (bakiye −10 adet / 0 kuruş).