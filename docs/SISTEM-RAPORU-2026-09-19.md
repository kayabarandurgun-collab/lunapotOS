# Lunapot Panel — Sistem Raporu (19 Eylül 2026)

> **Codex için:** Bu belge, `C:/Users/baran/Desktop/site/lunapot-panel` deposundaki sistemin tam
> fotoğrafıdır. Amaç: sistemi baştan sona analiz etmen, hataları/riskleri bulman ve iyileştirme
> önermen. Önce **§0 Görev**, sonra **§5 Değişmez kurallar** bölümünü oku. Kuralları bozan öneri
> kabul edilmez. Kod yorumları ve kullanıcı arayüzü Türkçedir.
>
> Canlı adres: https://muhasebe.lunapot.com (e-ticaret paneli: `/eticaret/`).
> Depo: github.com/kayabarandurgun-collab/lunapotOS, dal `main`.
> `Documents/Codex/2026-09-08/.../outputs/lunapot-panel` klasörü **ESKİ bir kopyadır, kullanma.**

---

## 0. Görev (Codex'ten istenen)

1. **Doğruluk denetimi:** Kâr hesabının (§4.3) her dalını oku; yanlış sonuç verebilecek durumları
   bul (çift sayım, eksik gider, yanlış tarih aralığı, KDV oranı, stopaj bölüşümü, iade/ikiz kayıt).
2. **Otomasyon denetimi:** Rapor Kutusu akışı (§4.1), otomatik iade/kesinti/aktarım kuralları ve
   yeni zamanlanmış bakım (§4.6) için yarış durumu, çift yazım, sonsuz döngü, yarım kalma riski.
3. **Veri bütünlüğü:** Tetikleyiciler (trigger), kilitler (`ec_order_line_lock`, fatura kilidi),
   FIFO yeniden değerleme (§4.2), çift aktarım (DUZELTME-CIFT) mirası.
4. **Performans/limitler:** Cloudflare Workers CPU ve D1 sorgu limitleri; `performance-api.js`
   ağır sorguları; `report-inbox-api.js` (111 KB tek dosya).
5. **Güvenlik:** kimlik doğrulama, personel yetkileri (`permission-policy.js`), CSP, dış veri
   (rapor dosyaları, PDF) ayrıştırma.
6. **İş önerisi:** Zarar eden ürün/kanal kombinasyonları için fiyat önerisi (§6.5).
7. Bulguları **önem sırasıyla**, dosya:satır göstererek, yeniden üretme adımıyla yaz. Kod
   değiştireceksen önce test yaz (`tests/`), sonra düzelt; `npm test` 0 hata olmadan yayına alma.

---

## 1. Özet

**Ne:** Tek kişilik e-ticaret işletmesinin (Dekovill; Trendyol ve Hepsiburada'da torf, bitki
toprağı, bitki besini satıyor; markalar Gartengold, Klasmann, SAB, Tropikal) ön muhasebe + stok +
sipariş + kârlılık paneli. Ayrıca aynı depoda ikinci çalışma alanı: **Lunapot Üretim** (`lp_`,
reçete/hammadde/üretim) ve henüz satışa açılmamış **Web mağaza** (`ws_`).

**Kullanıcı:** Operatör, geliştirici değil. Türkçe, kısa yanıt ister. Her rakamı pazaryeri
ekstresiyle ve el defteriyle karşılaştırır. "Hiçbir şey elle olmasın" ister.

**Durum (19.09.2026, canlıdan ölçüldü):**

| Gösterge | Değer |
|---|---|
| Stok kartı / tedarikçi | 37 ürün / 5 tedarikçi |
| Alış faturası (muhasebeleşmiş) | 38 fatura, 98.646 TL net |
| Saklanan alış belgesi (PDF) | 10 (9'u faturalara bağlı; 37 faturanın hepsinin özgün sayfası var) |
| Rapor Kutusu | 27 dosya, 5.116 rapor kaydı |
| Sipariş paketi | TY: 241 teslim, 101 kargoda, 5 ayrılmış, 2 iptal · HB: 112 teslim, 24 kargoda, 3 ayrılmış, 67 iptal (aktarım artığı, gizli) |
| Satış defteri | 729 kayıt (11 iade) |
| Stok | 357 adet, 36.276 TL (KDV hariç maliyet) |
| Katalog eşleşmesi (ilan → stok kartı) | 87 etkin |
| Teslim edilenler, tüm zamanlar | **356 paket, cebine kalan 24.762,46 TL** (TY 242 pk 18.315,25 · HB 114 pk 6.447,21), ciro 182.716,55 TL, KDV hariç katkı 21.160,82 TL |
| Son 1 ay | 302 paket, 23.381,02 TL, 65 zarar eden (−1.480,39 TL) |
| Kargoda/hazırlık (tahmin) | 124 paket, tahmini 8.942,10 TL |
| Hesaplanamayan paket | **0** |
| Testler | 88 dosya, **552 test, 0 hata** |

---

## 2. Mimari

- **Çalışma ortamı:** Cloudflare Workers (`src/worker.js`, `export default {scheduled, fetch}`) +
  D1 (SQLite) + statik dosyalar (`public/`, `assets.run_worker_first`). Yapılandırma: `wrangler.jsonc`.
- **Yayın:** `main`'e push → Cloudflare Workers Builds → `wrangler deploy` (1–3 dk). Zamanlayıcı:
  `triggers.crons = ["*/15 * * * *"]` (19.09'da eklendi).
- **Veritabanı geçişleri:** `migrations/0001…0048`. **Otomatik uygulanmaz**: kod push'undan ÖNCE
  `npm run db:remote` (scripts/migrate-remote.mjs). Wrangler SQL ayrıştırıcısı tetikleyici içindeki
  `CASE … END`'i bozar → `iif()` kullanılır.
- **Çalışma alanları:** Tek D1, tablo önekiyle ayrılır: `ec_` (e-ticaret), `lp_` (üretim), `ws_`
  (web mağaza), öneksiz ortak (admin, sessions, staff_users, workspace_settings…).
  `src/scoped-db.js` yazılan SQL'deki çıplak tablo adlarını (`order_packages`) çalışma alanı önekine
  çevirir; `ec_` yazılmış adlara dokunmaz (kelime sınırı `\b`).
- **Yönlendirme:** `/api/ec/...` ve `/api/lp/...` → `worker.js` içindeki işleyici listesi sırayla
  denenir (`fifoApi, fiyatHesapApi, urunKarlilikApi, panoramaApi, stagedImportApi,
  purchaseDocumentApi, purchaseAutopostApi, salesDocumentApi, reportStockLinkApi, reportInboxApi,
  bankApi, lotApi, …, performanceApi, attentionApi, orderInsightsApi, orderEstimateApi, catalogApi,
  pricingApi, ledgerApi, settingsApi, ordersApi, connectionsApi, reconciliationApi`), kalan her şey
  `accountingApi`'ye (`src/accounting.js`) düşer. Her e-ticaret POST'undan sonra
  `maliyetiTazele` → `fifoRevalue(db, 8)`.
- **Kimlik/yetki:** Oturum çerezi (`lunapot_session`, HttpOnly, SameSite=Strict). Yönetici + personel
  (`staff_users`), ekran bazında yetki (`public/permissions.js`, `src/permission-policy.js`).
  Tutarlar yetkisiz personelden `scrubAmounts` ile gizlenir. Genel durum (ana sayfa) yalnız sahibe.
- **Güvenlik başlıkları:** `script-src 'self'; style-src 'self'` (satır içi stil/betik YOK — grafik
  satır içi SVG + CSS sınıflarıyla, genişlikler CSSOM ile), `frame-ancestors 'none'`, HSTS.
- **Ön yüz:** Çatısız (framework yok) ES modülleri. `public/ecommerce.js` yönlendirici (hash
  tabanlı: `#overview`, `#performance`, `#orders`, …). `ui-shell.js` her DOM değişiminde
  `list-tools.js`'i çalıştırır (tablolara sıralama/arama/sığdırma). Servis çalışanı `public/sw.js`
  ağ-öncelikli; **her yayında `CACHE` adı artırılır** (şu an `lunapot-shell-v106-otomatik-bakim`).
- **Tarayıcıda PDF/Excel:** `pdf-read.js` (kendi PDF metin okuyucusu, OCR yok), `xlsx-read.js`,
  `vendor/pdf-lib.min.js`, `vendor/fontkit.min.js`.

---

## 3. Veri modeli (e-ticaret, özet)

| Grup | Tablolar | Not |
|---|---|---|
| Katalog | `ec_products`, `ec_price_profiles` (KDV oranı, yedek maliyet, ölçüler), `ec_catalog_mappings` + `_components` + `_audit` (ilan kodu → stok kartı(ları), sürümlü), `ec_product_families` + `_members` (çeşit aileleri) | Setler: bir ilan → birden çok stok kartı (gelir payı bps) |
| Sipariş | `ec_order_packages` (draft → reserved → shipped → delivered / cancelled), `ec_order_lines`, `ec_order_line_components` (satır → stok kartı, `sale_id`), `ec_order_reservations`, `ec_order_estimate_inputs`, `ec_parcel_templates` | `ec_order_line_lock` teslimli satırı kilitler |
| Satış defteri | `ec_sale_entries` (kind sale/return; revenue/cost/commission/shipping/other KDV HARİÇ kuruş; `fees_status`), `ec_fee_audit`, `ec_fee_allocations` | Gönderimde satış yazılır; iade `parent_id` ile |
| Stok/maliyet | `ec_stock_movements`, `ec_stock_balances`, `ec_open_costs` (stoksuz satılan açık maliyet), `ec_cost_settlements`, `ec_cost_dirty` + `ec_cost_revaluations` (FIFO kuyruğu ve değiştirilemez düzeltme izi) | Değer eksiye düşmez |
| Alış | `ec_suppliers`, `ec_purchase_invoices` (draft/posted/cancelled; posted değiştirilemez), `ec_purchase_lines`, `ec_goods_receipts` (+ `ec_effective_receipts` görünümü), `ec_purchase_adjustments`, `ec_purchase_returns`, `ec_receipt_reversals`, `ec_purchase_line_splits`, `ec_purchase_documents` + `_chunks` (base64) + `_pages` (belge sayfası → fatura), `ec_purchase_family_links` | Posted fatura tetikleyicisi stok hareketi yazar |
| Rapor Kutusu | `ec_report_stores` (TY-LUNAPOT, HB-LUNAPOT), `ec_report_profiles` (sütun eşlemesi, kesinti KDV durumu), `ec_report_files` + `_file_chunks` + `_rows`, `ec_report_records` (kind order_line / finance_event; `record_key`, `source_time`, `erp_package_id`) + `_record_versions`, `ec_report_reviews`, `ec_report_outcomes`, `ec_report_apply_steps`, `ec_report_fee_evidence` | Kayıtlar dosyadan bağımsız "son hâl"; `source_time` son görülme |
| Cari/nakit/banka | `ec_party_entries`, `ec_payment_allocations`, `ec_cash_*`, `ec_bank_files`, `ec_bank_lines`, `ec_supplier_payments` | Banka ile hakediş eşleştirmesi henüz bağlanmadı |
| Diğer | `ec_expenses`, `ec_offers`, `ec_sales_documents` (pazaryeri satış faturaları), `ec_import_*` (denetlenebilir aktarım), `ec_activity` (etkinlik günlüğü) | |

Toplam: ~150 tablo, 8 görünüm, çok sayıda tetikleyici (kilitler, stok hareketi, doğrulamalar).

---

## 4. Uçtan uca akışlar

### 4.1 Pazaryeri raporu → Rapor Kutusu → sipariş / stok / satış / kesinti
Kullanıcı TY/HB'den indirdiği Excel/CSV'yi **Rapor Kutusu**'na (`#reports`) bırakır.
1. **Tanıma:** Mağaza ve rapor türü dosyanın sütunlarından tanınır (`report-inbox-ui.js`, profil).
2. **Yükleme:** parça parça (`/files/:id/chunk`, `/rows`), `/seal` (özet + satır sayısı doğrulaması).
3. **İşleme:** `/files/:id/apply` parti parti (kaldığı yerden). Kayıt anahtarı: sipariş satırı
   `P:<paket>|<sku>`, finans olayı bileşik anahtar. Değişen kayıt yeni sürüm açar; `source_time`
   ilerler ("son gözlem": aynı kesinti farklı raporlarda farklıysa en son görülen sayılır).
4. **Aktarım** (`/stock-link/auto`, `src/report-stock-link-api.js`): panelde karşılığı olmayan
   paket → sipariş taslağı → (eşleşmişse) stok ayır → rapor "kargolandı" diyorsa gönder (satış
   yazılır, stok düşer) → "teslim edildi" diyorsa teslim. Yeniden numaralanan paket bir kez sayılır
   (`eskittiMi`), taslak yenilenir (`tazeleTaslakBagi`). **19.09 yeni:** eşleşmemiş satırın ilan adı
   TEK stok kartının adıyla (ya da markasız adıyla) birebir aynıysa katalog bağlantısı kendiliğinden
   kurulur ve hatırlanır (`adAnahtari`).
5. **Teslim güncelleme** (`/sync-deliveries`), **iade** (`/stock-link/returns-apply` ←
   `pendingReturns` in `report-inbox-api.js`): (a) raporda tam iade tutarı, (b) tek satırlı kısmi iade
   (birim fiyatın katı), (c) teslim edilemeyen paket + siparişin başka paketi teslim edildi,
   (d) **19.09 yeni:** teslim edilemedi + pazaryerinin son ekstresinde satış 0'a indi.
6. **Kesinti yazma** (`/apply-fees`, `applyReportFees`): finans raporundaki komisyon/kargo/hizmet
   (KDV hariç) satış kayıtlarına gelir oranında bölünerek YAZILIR (toplama değil, SET). Faturaya bağlı
   kayda dokunulmaz. İndirim satış fiyatına zaten uygulanmışsa gider sayılmaz (19.09: kısmi iadede
   kalan adede oranlanarak da tanınır). Teslim edilmemiş pakete kesinti yazılmaz (iade edilmişse yazılır).

Adımlar 4–6 **ekranda** (kullanıcının açık sayfasında) dosya işlenince otomatik çalışır; aynı
adımlar artık sunucuda da her 15 dakikada tekrarlanır (§4.6).

### 4.2 Alış faturası → stok → maliyet
1. PDF yüklenir (`purchase-document-ui.js`). `pdf-read.js` metni okur (Type0/Identity-H +
   ToUnicode, **19.09: sıkıştırılmış nesne akışı /ObjStm**; kontrol karakteri ağırlıklı çıktı metin
   sayılmaz). "Tüm zamanlar" dökümü gibi çok faturalı PDF `splitInvoices` ile sayfa sayfa bölünür.
2. Başlık/satır/toplam tahmini (`guessHeader/guessLines/guessTotals`). Satır → ürün eşlemesi:
   elle hatırlanan bağlar (`catalog_mappings` source=purchase, `purchase_family_links`) + **geçmiş**
   (`public/purchase-match.js` `matchFromHistory`, sunucu ile ortak; `GET /api/invoices/match-history`).
   Kural: aynı açıklama → o kart; aynı gerçek ürün kodu tek karta gittiyse → o kart (yeni ölçü yoksa);
   kod çok çeşide gittiyse belgedeki çeşit adı seçer; yoksa aile (adet sorulur).
3. Otomatik yol (19.09'dan beri tek dosyada da): belirsiz alan yok, satır net/KDV toplamı belgeyle
   tutuyor, çeşit dağılımı yoksa taslak kaydedilir → `POST /invoices/:id/autocomplete`
   (`purchase-autopost-api.js`) eksik satırları geçmişten bağlar, **muhasebeleştirir** (cari borç) ve
   **fatura tarihiyle mal teslimi** yapar (stok).
4. **FIFO maliyet** (`fifo-cost.js`, 0048): satış maliyeti SATIŞ TARİHİNDEKİ en eski stoktan.
   Hareketi değişen ürün `ec_cost_dirty`'ye düşer; `fifoRevalue` farkı `ec_cost_revaluations` ile
   `sale_entries.cost_cents` ve stok değerine yazar. Stoksuz satış `ec_open_costs` ile açık kalır,
   alış gelince kapanır (tahmin: son alış fiyatı).
5. Fatura penceresinde "Özgün faturayı aç (sayfa N)" (`original-document.js`, pdf-lib ile sayfa ayırma).

### 4.3 Kâr hesabı (TEK FORMÜL) — `src/performance-api.js` `performanceReport`
Kâr raporu, sipariş listesi/penceresi, ana sayfa (`panorama-api.js`), ürün kârlılığı hep aynı mantık.
- **Cebine kalan (nakit)** = KDV dahil satış (satırın kendi KDV oranıyla) − KDV dahil maliyet (ürün
  profil oranı) − KDV dahil komisyon/kargo/hizmet (kesinti KDV oranı rapor profilinden; beyan yoksa
  hesaplanmaz) − stopaj (sipariş düzeyi, iptal olmayan paket sayısına bölünür).
- KDV hariç katkı yalnız "vergi beyanı için" küçük satırda.
- Teslim edilenler: `status='delivered'` ve `delivered_on` aralıkta. **19.09 yeni:** gönderilmiş ama
  iadesi tamamlanmış (teslim edilemeyip dönen) paket **iade tarihiyle** sonuçlanmış sayılır
  (satış 0, kesinti zarar; `teslim_edilemedi`).
- **Çift kayıt ikizi (DUZELTME-CIFT):** eski aktarımda aynı paket iki kez girmiş; kopyanın satışları
  `DUZELTME-CIFT-` iadeleriyle sıfırlanmış. Kopya teslimli, asıl kayıt "gönderildi" durumunda kalmış.
  Hesapta kopyanın yerine asıl kayıt (ikiz) kullanılır: teslim tarihi ve kesintiler kopyadan, satış ve
  maliyet ikizden. **Kayıt değiştirilmez.**
- **Eksik veri sıfır sayılmaz:** maliyeti bilinmeyen, rapor satır sayısı defterden fazla olan
  (19.09: yeniden numaralanan paketin eski numarası sayılmaz), kesinti KDV durumu beyan edilmemiş
  paketler "hesaplanmadı" + sebep. Kesintisi ekstreye henüz yazılmamış teslim → **geçmişten tahmin**
  (`fees_estimated`, "Kesinti tahmini" rozeti).
- `max=1000` paket sınırı (409); `panorama-api.js` tüm zamanları 92 günlük parçalara böler.

### 4.4 Kargodaki tahmin — `src/fee-history.js` `kesintiTahmincisi`
Örnek: aynı kanal + aynı içerik son 5 teslim → aynı ürün tek başına, en yakın adet 5 → aynı ürünün
DİĞER kanaldaki teslimleri (kargo/hizmet; komisyon bu kanalın oranı) → kanal son 30. ORTANCA alınır.
İadeli paket örnek alınmaz. Stopaj oranı ekstreden. Maliyet: paketin kendi satış kaydı; yoksa stok
ortalaması; stok ≤0 ise son alış. **Sınama (19.09, 263 paket, "diğer paketlerden tahmin"):** paket
başı ortalama mutlak hata 14,44 TL, sistematik sapma −2,79 TL, toplamda gerçekleşenden %5,5 düşük
(temkinli). Kargodaki paket başı tahmin 71,56 TL; son 30 günün gerçekleşeni 77,85 TL.

### 4.5 Ekranlar
- **Genel durum** (`#overview`, `panorama-ui.js` + `GET /api/panorama`): 6 dönem kartı (1h/2h/1a/3a/6a/tüm;
  zarar sayısı ve tutarı), seçili dönemin günlük/haftalık yığılmış sütun grafiği (TY #2a78d6 / HB
  #eb6834, satır içi SVG), kâr bırakan / zarar eden toplamları, TY/HB payı, kargodaki tahmin, en çok
  / en az kazandıran ürünler, iş listesi (`attention-api.js`), hızlı geçiş.
- **Kâr raporu** (`#performance`): kanal kartları + paket dökümü (tablo değil satır listesi; sipariş
  no'nun son 4 hanesi kalın — kullanıcı ekstreyi son 4 haneyle eşliyor), sıralama, CSV.
- **Siparişler** (`#orders`, `orders-ui.js`): kullanıcının "iyi" dediği ekran — **dokunmadan önce sor.**
- **Ürünler ve stok**, **Alış faturaları** (sunucuda sıralama `sort=date_asc|net_desc|net_asc`),
  **Fatura belgeleri**, **Satış ve kesinti kayıtları**, **Rapor Kutusu**, **Kaça satmalıyım**
  (`fiyat-hesap-api.js`), cari/banka/teklif/gider/ayarlar.
- Bütün tablolar `list-tools.js`: sığmıyorsa "etiket değer" satır düzeni (yatay kaydırma YOK),
  "Sırala" (tutar büyükten küçüğe…), 8+ satırda arama.

### 4.6 Otomatik bakım — `src/otomatik-bakim.js` (cron */15)
Son 10 dakikada rapor dosyası yüklendiyse tur atlanır. Aksi hâlde: yarım rapor dosyalarını bitir →
her mağaza için `/stock-link/auto` → `/sync-deliveries` → `/returns-apply` → `/apply-fees` → FIFO
kuyruğu. Sahte kullanıcı `{owner:true,id:'otomatik-bakim'}`. İş yaptıysa `ec_activity`'ye özet yazar.
**Doğrulanmadı:** canlıda ilk turların gerçekten çalıştığı (etkinlik kaydı yalnız iş olunca düşer).

---

## 5. Değişmez kurallar (kullanıcı kararları — bozma)

1. **Her tutar KDV dahil** gösterilir (satış, maliyet, kesinti, cebine kalan). KDV hariç yalnız küçük
   "vergi beyanı için" satırı. Bütün ürünlerde KDV %20 (HB bazı ilanlarda %10 yazıyor; satır kendi
   oranıyla geri çevrilir, 8 satır hâlâ %10 kayıtlı).
2. **Maliyet tarih bazlı FIFO.** Ürün maliyeti tek fiyata kilitlenmez; eski satış eski alış maliyetini
   alır (zamlar gerçek: ör. Torf 10 L bir partide 110 TL, 80 L 500→550→600). Yalnız yanlış OKUNMUŞ
   fatura satırı düzeltilir. (19.09'da 9 belgedeki bütün faturalar PDF ile karşılaştırıldı: hepsi birebir.)
3. **Eksik veri sıfır sayılmaz**, "hesaplanmadı" da denmemeye çalışılır: geçmişten tahmin + "tahmini" işareti.
4. **Hiçbir şey elle olmasın:** geçmişten öğren; yalnız gerçekten bilinemeyende (çeşit adetleri,
   birebir uymayan ilan adı) sor.
5. Kayıtlar değiştirilemez izle düzeltilir (ters kayıt, sürüm, denetim tablosu); sessiz UPDATE yok.
6. Arayüz: kısa Türkçe, sağa kaydırma yok, ürün adı önde ve tam, uzun iç kodlar (RPT-…) gösterilmez.
7. Satırlar ve rakamlar kâr raporu = sipariş penceresi = ana sayfa = ürün kârlılığı olmalı.

---

## 6. Canlı denetim sonuçları (19.09.2026)

### 6.1 Hakediş mutabakatı (satış + kesinti doğruluğu)
Her teslim edilen sipariş için sistemin hakedişi (KDV dahil satış − komisyon − kargo − hizmet −
stopaj) Rapor Kutusu'ndaki pazaryeri **net hakedişiyle** karşılaştırıldı:
- **Trendyol:** 226 siparişin 222'si 1 TL içinde aynı; HB 110'un 106'sı. Kalan farklar: çok paketli
  siparişte hakedişin paket başı yazılması (paket paket bakınca aynı) ve kesintisi henüz ekstreye
  yazılmamış 2 paket (tahmin).
- Bulunup düzeltilen gerçek hatalar: HB 4611462604 (teslim edilemeyen ilk gönderimin kesinti yarısı
  kâra girmiyordu, ~132 TL), TY 11581049903 (aynı), HB 4731515470 (yeniden numaralanan paket
  "hesaplanmadı"), HB 4221039448 (teslim edilemedi + satış iptal, iadesi işlenmemişti), TY 11534399836
  (kısmi iadede indirim iki kez düşülüyordu, −228,13 → −216,13).

### 6.2 Maliyet
Satışlarda kullanılan birim maliyet her ürün için alış faturalarının fiyat aralığında (Torf 40 L
300–330, 20 L 170–190, 10 L 100–110, Orkide Toprağı 26, Temizleyici 25, besinler 21/32/46 TL…;
Klasmann TS1 1.136 vs faturalar 1.166–1.400 — açılış/sayım değerinden kaynaklanıyor olabilir, bak).

### 6.3 Tahmin (bkz. §4.4) — temkinli, %5,5 düşük.

### 6.4 Zarar eden paketler
88 zarar: 83 normal satış (TY 68, HB 15; ortalama −14,36 TL/paket, yalnız 2'si −50 TL'den büyük),
2 müşteri iadesi, 2–3 teslim edilemedi. **83 normal satışın hepsi kargo olmasa kârlı.** Örnek
(ekstreyle birebir): TY …2473 Torf 20 L satış 403,38, komisyon 74,63, kargo 150,72, hizmet 13,19 →
hakediş 164,84, maliyet 204 → −39,16.

### 6.5 Ürün kârlılığı (gönderilmiş + teslim, KDV dahil, kargodakiler tahminle)
| Ürün | Adet | Toplam kâr | Adet başı |
|---|---|---|---|
| Klasmann TS1 Torf 210 L | 17 | 10.832,87 | 637,23 |
| Gartengold Torf 40 L | 22 | 6.893,49 | 313,34 |
| Gartengold Torf 20 L | 97 | 4.038,06 | 41,63 (TY'de 403–433 TL fiyatla zarar; başabaş ~452, +50 TL için ~513) |
| Gartengold Torf & Cocopeat 80 L | 4 | 2.340,84 | 585,21 |
| Gartengold Torf 10 L | 36 | 1.479,48 | 41,10 |
| Tropikal Yaprak Temizleyici 250 ml | 118 | 1.401,76 | 11,88 |
| Tropikal Orkide Toprağı 3 L | 159 | 1.358,02 | 8,54 |
| Tropikal Orkide Besini 225 ml | 105 | 1.238,10 | 11,79 |
| … | | | |
| Tropikal Genel Besini 225 ml | 48 | 82,71 | 1,72 |
| Tropikal 225 ml Çiçek Açan / Kaktüs / Menekşe | 5/6/4 | −11,59 / −14,59 / −17,46 | zarar |
| Tropikal Yeşil Yapraklı 500 ml | 4 | −10,30 | zarar |

---

## 7. 19.09.2026'da yapılanlar (commit sırasıyla, en yeni üstte)
```
d44924e Otomatik bakım: rapor sonrası işler sunucuda her 15 dakikada kendiliğinden tamamlanır
9053e6d Teslim edilemeyen ve pazaryerinin satışı iptal ettiği paket kendiliğinden iade edilir; kargo uyarısı temizlendi
eac1a42 Kâr: yeniden numaralanan paket hesaplanır; teslim edilemeyip dönen paketin kesintisi kâra girer
173389a Rapor aktarımı: ilk kez satılan ilan, adı stok kartıyla birebir aynıysa kendiliğinden eşlenir
4ec292d/03c5e80 Genel durum: zarar edenlerin tutarı (telefonda da)
77f697f Alış faturası kendiliğinden işlenir: ürün eşlemesi geçmişten, tek dosya da otomatik
4d54176 PDF okuyucu: /ObjStm açılır; çözülemeyen kod "metin" sayılmaz
3e4bb2f Alış faturası penceresinden özgün PDF açılır
493a58d/cfc6200 Bütün listeler: sağa kaymadan sığar, tutara göre sıralanır
4170fd7 Kâr raporu: paket dökümü sağa kaymadan okunur
4c383e9 Genel durum baştan: dönem kârları, grafik, kargodaki tahmin, ürün sıralaması
1cdf3f0 Kısmi iadede indirim ikinci kez kesinti yazılmıyor
```
Önceki oturumların devir notları: `thoughts/shared/handoffs/lunapot-panel/*.yaml` (en yenisi
`2026-09-19_12-08_genel-durum-kar-raporu-liste.yaml`). Diğer belgeler: `README.md`, `ACCOUNTING.md`,
`docs/DEVAM.md`, `docs/FATURA-YETENEK-MATRISI.md`, `docs/PAZARYERI-ARASTIRMA-2026-09-09.md`,
`docs/WEB-MAGAZA-DEVIR.md`.

---

## 8. Bilinen riskler, teknik borç, açık sorular (analiz et)

1. **Ekran güdümlü işleme:** Rapor Kutusu adımları tarayıcıda döngüyle çağrılıyor. Cron eklendi ama
   ikisi aynı anda çalışırsa (`sakinDakika=10` penceresi dışında uzun bir işleme) çift aktarım
   mümkün mü? `/stock-link/auto` ve `apply` uçlarında eşzamanlılık koruması (koşullu UPDATE, benzersiz
   anahtar) yeterli mi?
2. **Cron limitleri:** `otomatikBakim` tek turda çok iş yaparsa Workers CPU sınırı (varsayılan 30 sn)
   aşılabilir mi? Zaman bütçesi duvar saatiyle (`sureMs=50000`).
3. **`report-inbox-api.js` 111 KB**, `report-stock-link-api.js` 47 KB, `performance-api.js` 32 KB
   tek dosya ve yoğun tek satırlık kod (okunabilirlik, yan etki riski).
4. **Çift kayıt (DUZELTME-CIFT) mirası:** 6 "asıl kayıt" paketi kalıcı olarak `shipped`; kâr raporunda
   ikiz olarak doğru sayılıyor, uyarılardan dışlandı. Bu kalıcı ikiliği güvenle kapatmanın yolu?
5. **HB sipariş düzeyi kesintiler:** HB kesintiyi sipariş başına kesiyor; sistem paketlere bölüyor.
   Çok paketli HB siparişinde bölüşüm (gelir oranı / eşit) ve iade edilen paketin payı doğru mu?
6. **`performance-api` 1000 paket sınırı** ve her istekte `kesintiTahmincisi` (2.000 paket + bütün
   bileşen/satış satırı okur). Veri büyüdükçe maliyet.
7. **Tahmin yöntemi** %5,5 temkinli; ortanca + son 5 örnek. Daha iyi bir tahmin (ağırlıklı, desi
   bazlı kargo tarifesi) gerekir mi?
8. **Stale/ölü kod:** `public/decision-overview.js` (eski ana sayfa; testleri duruyor),
   `ec_stock_balances_yeni` tablosu (kullanımda mı? doğrulanmadı), eski `text_layer=0` işaretli alış belgeleri, yarım kalmış
   TRP2026000001080 tekil yüklemesi (`receiving`).
9. **Fixture ile D1 farkı:** testler `node:sqlite` üzerinde (`tests/helpers/app-fixture.js`). D1'e
   özgü davranışlar (bağlı parametre sayısı, `?NNN`, batch işlem semantiği) testte yakalanmayabilir.
10. **Banka mutabakatı yok:** hakediş banka hareketiyle eşleştirilmiyor (`bank_verified_cents` hep null).
11. **8 HB satırı %10 KDV'yle kayıtlı** (18–19.09 devir notuna göre; bugün yeniden sayılmadı; kullanıcı hepsi %20 diyor); nakit doğru ama KDV hariç ciro yanlış.
12. **Klasmann TS1 birim maliyeti** alış fiyatlarının altında (açılış/sayım değeri?).
13. **Güvenlik:** CSP sıkı; ama rapor dosyaları ve PDF'ler kullanıcıdan geliyor — ayrıştırıcılarda
    (xlsx-read, pdf-read, invoice-import XML) kötü niyetli girdi sınırları (boyut, akış sayısı) yeterli mi?

---

## 9. Çalıştırma, test, yayın

```bash
npm install
npm test                        # node --test tests/*.test.js  (552 test)
npm run dev                     # wrangler dev (yerel)
npx wrangler deploy --dry-run --outdir /tmp/dist   # derleme denetimi
npm run db:remote               # geçişleri CANLIYA uygula (kod push'undan ÖNCE)
```
- **Yayın kuralı:** `npm test > out; grep -q "^ℹ fail 0" out && git push origin main`. (18.09'da
  test kırıkken zincir push etmiş, canlı derleme düşmüştü.)
- Her yayında `public/sw.js` 1. satırdaki `CACHE` adını artır; `curl https://muhasebe.lunapot.com/sw.js`
  ile yeni adı bekle; tarayıcıda servis çalışanı önbelleğini temizleyip doğrula.
- Canlı D1'i salt okumak: `npx wrangler d1 execute lunapot-db --remote --json --command "SELECT …"`.
- Kaçış karakteri içeren düzenlemeleri betikle (python/node heredoc) yapma; ters bölüler kayboluyor.
- Test yardımcısı: `tests/helpers/app-fixture.js` → `f.ok('/ec/...', body)`, `f.req`, `f.sqlite`.

## 10. Dosya haritası (sunucu)

| Dosya | Görev |
|---|---|
| `worker.js` | giriş, kimlik, yönlendirme, güvenlik başlıkları, cron `scheduled` |
| `accounting.js` | genel muhasebe: ürün, stok, alış faturası, satış, iade, gider, cari (kalan her şey) |
| `orders-api.js` / `orders-query.js` | sipariş yaşam döngüsü (map/reserve/ship/deliver/cancel), liste ve süzgeç |
| `report-inbox-api.js` | Rapor Kutusu: dosya alma/işleme, sipariş özeti, kesinti yazma, iade adayları, teslim eşitleme |
| `report-stock-link-api.js` | rapor → sipariş → stok köprüsü, otomatik aktarım, otomatik iade |
| `report-link-guard.js` | rapora bağlı siparişin kaynak güncelliği |
| `performance-api.js` | kâr raporu (tek formül) |
| `panorama-api.js` | ana sayfa dönem özetleri |
| `fee-history.js` | geçmişten kesinti tahmini |
| `fifo-cost.js` | FIFO satış maliyeti ve yeniden değerleme |
| `package-profit.js` | paket kâr çekirdeği |
| `order-insights-api.js` / `order-estimate-api.js` | sipariş penceresi analizleri / tarife tahmini |
| `purchase-document-api.js` | alış belgeleri (PDF/XML), sayfa bağlantısı, ürün aileleri |
| `purchase-autopost-api.js` | alış faturasını geçmişten tamamlama + `match-history` |
| `purchase-*-api.js` | düzeltme, iade, bölme, arama |
| `catalog-api.js` | ilan/tedarikçi kodu → stok kartı bağlantıları (sürümlü) |
| `urun-karlilik-api.js`, `fiyat-hesap-api.js`, `pricing-api.js` | ürün kârlılığı, "Kaça satmalıyım", tarifeler |
| `attention-api.js` | iş listesi sayaçları |
| `otomatik-bakim.js` | zamanlanmış bakım |
| `scoped-db.js`, `permission-policy.js`, `access-api.js`, `login-limits.js` | çalışma alanı, yetki, erişim |
| `webshop-*.js`, `payment-iyzico.js` | web mağaza (satışa kapalı, iyzico sandbox) |
| `lot-api.js`, `barcode-api.js`, `production-api.js` | üretim alanı (lp) |
