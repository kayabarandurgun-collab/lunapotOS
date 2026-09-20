# Lunapot Panel — Claude Uygulama ve Yayın Raporu

Tarih: 20 Eylül 2026
Dal / HEAD: `main / ac8988a` (başlangıç: `d44924e`)
Canlı: https://muhasebe.lunapot.com — yayın sürümü `lunapot-shell-v113-kalan-isler-guvenlik`
Karar: **Codex raporundaki 25 bulgunun 25'i doğrulandı; 24'ü kodda düzeltildi, 1'i (R15) düzeltildi + veri onarımı bilinçli olarak yapılmadı (salt okunur önizleme olarak bırakıldı). Kod, migration ve UI canlıya alındı.**

## 1. Özet

| Konu | Durum |
|---|---|
| Codex P1 (13 bulgu) | 13/13 doğrulandı, 13/13 düzeltildi |
| Codex P2 (12 bulgu) | 12/12 doğrulandı, 11/12 düzeltildi; R15 yalnız önizleme (gerekçe §4) |
| Test | 618 → **631 test, 631 geçti, 0 hata** (başlangıç 552) |
| Migration | 0049 (maliyet motoru), 0050 (rapor akışı korumaları), 0051 (hız indeksleri) — üçü de canlıda |
| Canlı veri onarımı | **Yapılmadı.** Yeni motorun geçmişe etkisi ölçüldü: 37 üründe toplam **2 kuruş** (§6) |
| Güvenlik | Codex'te yarım kalan denetim tamamlandı: **yüksek risk yok**, 3 orta + 8 düşük bulgu; hepsi kapatıldı (§5) |
| Hız | Sipariş listesi 4,5 sn → **0,7–1,4 sn**; kâr raporu 2,2 sn → **0,5 sn** (§7) |
| Tasarım | Codex'in commerce-design.css çalışması yayında; iki düzeltmeyle (§4-E8) |

## 2. Kanıt standardı

- **Test-önce**: her bulgu için önce hatayı gösteren test yazıldı, çalıştırıldı, başarısız olduğu görüldü; sonra düzeltme yapıldı. Testler `tests/codex-*.test.js` altında bulgu kimliğiyle duruyor (13 dosya, 66 test) + bu oturumda eklenen 5 dosya.
- **Kod okuma**: satır numaraları uygulama anında yeniden konumlandırıldı; grep sonucuna dayanan iddia kullanılmadı.
- **Canlı doğrulama**: yayından sonra kullanıcının kendi oturumundan yalnız **okuma** yapıldı (panelin kendi API'si). Canlıya sentetik kayıt yazılmadı, veri onarımı çalıştırılmadı.
- **Doğrulanamayanlar** açıkça §8'de.
- İki bağımsız gözden geçirme (maliyet motoru + 0049; rapor akışı/kâr/yetki + 0050) yayın öncesi yapıldı: **yayını engelleyen bulgu çıkmadı**; çıkan iki "should-fix" §4-E1 ve §8-K2'de.

## 3. Codex bulguları: sonuç tablosu

Kısaltmalar: **D** = doğrulandı (hata üretildi), **F** = düzeltildi, test = kanıt dosyası.

### P1

| ID | Sonuç | Kök neden (doğrulandı) | Düzeltme | Test |
|---|---|---|---|---|
| R01 | D+F | Değişen kayıt UPDATE'i yalnız `version` kontrol ediyordu; aynı içerikli yeni gözlem eski değişikliği geri getirebiliyordu | Batch başında sürüm + gözlem zamanı + paket bağı koşulu (`ec_report_write_guard`); yazamayan işlem yan etki üretmez, dosya yeniden sınıflandırılır (4 deneme, sonra 409) | `codex-rapor-r01` (bariyerle iki yönde yarış) |
| R02 | D+F | İki FIFO aynı kirli ürünü okuyup aynı farkı iki kez yazıyordu (150→90 yerine 30) | `ec_cost_dirty` nesil (seq) taşır; yazma ve kuyruk temizliği aynı batch'te koşullu | `codex-maliyet-yaris` |
| R03 | D+F | Kabul batch'i kapanıştan önce bitiyordu; `posted` faturada otomatik tamamlama erken dönüyordu (10+10=20 adet) | Kapanış teslimle **aynı batch'te**; yarım kalan eski iş `completeProvisionalClose` ile tamamlanır | `codex-maliyet-yaris` |
| R04 | D+F | İade SUM'ı sipariş, dış sorgu paket düzeyindeydi: tek iade her pakete tam uygulanabiliyordu | Ortak tahsis modeli: tüketilen miktar/tutar düşülür, belirsiz olay incelemede kalır | `codex-rapor-iade` |
| R05 | D+F | Geçici sayım telafisi rezervasyon/gönderim kararı öncesinde yazılıyordu (24+8=32 kalıyordu) | Telafi yalnız niyet olarak kaydedilir; stok hareketi `reserved→shipped` ile aynı işlemde tetikle yazılır | `codex-rapor-stok` |
| R06 | D+F | Taslak tazelemesi yalnız SKU/miktar karşılaştırıyordu; 500→900 değişimi yutuluyordu | Brüt ve KDV de karşılaştırılır; taslak izli yeniden fiyatlanır, rezerveli kayıt gerekçeyle durur | `codex-rapor-stok` |
| R07 | D+F | Kapanış yalnız `purchase/opening/count` kabul ediyordu; fiziksel iade başka açık satışı kapatmıyordu | Yeni iade tetiği (0049): gerçekten dönen maliyetli kısım diğer açık satışları tarih sırasıyla kapatır | `codex-maliyet-acik` |
| R08 | D+F | Tetik iade değerini 0'a kırpıyor, FIFO ortalamadan yeniden maliyetlendiriyordu (sıfır miktarda 33,33 TL) | İade önce açık adetlerin tahminini geri alır, sonra gerçek maliyet payını taşır; FIFO iadeyi getirdiği adetten hesaplar | `codex-maliyet-acik` |
| R09 | D+F | Ters kayıt genel FIFO tüketimine düşüyordu (100/300 yerine 200/200) | Ters kayıt ve özgün kabul replay dışında tutulur; kapanış/açık satış kapatmış kabul geri alınamaz (tetik) | `codex-maliyet-fifo` |
| R10 | D+F | Sayım eksiği stok ortalamasından, FIFO en eski katmandan düşüyordu | Sayım eksiği/tedarikçi iadesi kayıtlı değeriyle, katmanlara oranla düşülür | `codex-maliyet-fifo` |
| R11 | D+F | Satılmış geçici sayım payı tahmini değerde kalıyordu (500/1.500 yerine 1.000/1.000) | Kapanış, sayımın adetlerini (önce satılmış, sonra raftaki) fatura fiyatına çeker; kayıp adedin farkı ayrı kayıtla gidere yazılır (`ec_close_cost_revaluations`) | `codex-maliyet-fifo` |
| R12 | D+F | Alış fiyat düzeltmesi FIFO'ya hiç girmiyordu (100/60 yerine 80/80) | Düzeltme kaynak katmana bağlanır; raftaki pay adil payıyla sınırlı, fazlası satılmışa yansır; ürün yeniden hesaplanmak üzere işaretlenir | `codex-maliyet-fifo` |
| R13 | D+F | Ürün kârlılığı bilinmeyen maliyeti/gideri 0 sayıyordu (70,68 / 76,80) | Ürün kârlılığı artık `performanceReport` paket satırlarını ürünlere dağıtır; hesaplanamayan paket varsa ürün kârı `null` + hesaplanan kısım + eksik sayısı + nedeni | `codex-kar-ortak` |

### P2

| ID | Sonuç | Kök neden | Düzeltme | Test |
|---|---|---|---|---|
| R14 | D+F | Herhangi bir satırda iade varsa tüm paket atlanıyordu | Kümülatif iade/kalan miktar; teknik DUZ kayıtları ayrılır (R04 ile ortak model) | `codex-rapor-iade` |
| R15 | D (F kısmi) | 0047 tarihsel doldurması kaynağın kapasitesini izlemiyordu | Uygulanmış migration **değiştirilmedi**; kapasite aşımını listeleyen salt okunur önizleme eklendi (`GET /api/ec/cost-fifo/history-capacity`). **Canlıda kapasiteyi aşan kaynak: 0** | `codex-maliyet-acik` |
| R16 | D+F | Her iade bağımsız yuvarlanıyordu (33+33+33=99) | Kalan bakiye yöntemi: son iade kalan kuruşu alır (tam 100) | `codex-maliyet-fifo` |
| R17 | D+F | Gerçek stopaj sorgusu yalnız `hepsiburada` seçiyordu | Ortak paket satırından gelir; TY ve HB aynı yoldan (14,48) | `codex-kar-ortak` |
| R18 | D+F | Payda fiziksel paketleri sayıyordu; ikiz stopajı ikiye bölünüp tek pay sayılıyordu | DUZ kopyası paydada sayılmaz; kuruş artığı paket kimliği sırasıyla dağıtılır (toplam = olay) | `codex-kar-stopaj` |
| R19 | D+F | "Tüm zamanlar" yalnız ilk teslimden başlıyordu | İlk sonuç tarihi = ilk teslim **veya** daha erken tamamlanmış iade (`ilkSonucTarihi`); −61,32 TL doğru döneme girer | `codex-kar-kapsam` |
| R20 | D+F | `LIMIT 101` sonrası taşma sessizce düşüyordu | Tarih+kimlik imleciyle sayfalama; sınır aşımında açık 409 veya sonraki sayfa | `codex-kar-kapsam` |
| R21 | D+F | 1001 bekleyen paket bütün panoramayı kesiyordu | Bekleyenler imleçle parça parça; bölüm hata verirse `partial` + neden döner, hazır kartlar kullanılabilir kalır | `codex-kar-kapsam` |
| R22 | D+F | Sipariş listesi/penceresi ikinci nakit formülü kullanıyordu | Liste (`orders-api`), pencere (`order-insights-api`) ve Rapor Kutusu sonuçları ortak `paketSonuclari`'ndan; tahmin işareti, kaynağı ve eksik nedeni birlikte | `codex-kar-ortak`, `codex-rapor-sonuc` |
| R23 | D+F | "En yakın adet" seçiminde uygunluk sınırı yoktu; `packaging_cents`/`other_cents` okunmuyordu | Adet uyumu (`ayni/aralik/uzak/yok`); uyumsuzda kesin fiyat verilmez, senaryo sunulur; ambalaj/diğer gider KDV'siyle paket başına bir kez düşülür, dökümde ayrı satır | `codex-fiyat-r23` |
| R24 | D+F | Her tur aynı en eski 10 dosya; bekleme/ilerleme yoktu | Deneme sayısı + sonraki deneme zamanı (15 dk → 1 gün); hatasız dosyalar önce; ekranda "N kez denendi · sebep · yeniden saat" | `codex-rapor-bakim` |
| R25 | D+F | `fiyat-hesap` ve `urun-karlilik` rota eşlemesi yoktu; yetkili personel 403 alıyordu | Açık eşleme (`fiyat-hesap→pricing`, `urun-karlilik→stock`), yalnız e-ticaret; bilinmeyen rota kapalı kalır | `codex-yetki-r25` |

## 4. Codex raporunda olmayan, bu çalışmada bulunan hatalar

- **E1 — Aynı ürün faturada iki satırdayken geçici sayım iki kez ayrılıyordu.** Gözden geçirmede çıktı, örnek veriyle üretildi: 8 adetlik sayım + 5+5 adetlik iki satır → fazladan gelen 2 adet stoksuz satılmış satışı kapatmıyordu. Tetik artık aynı teslimin (fatura+referans) kapanmamış önceki satırlarını düşer. Test: `gecici-sayim-cok-satir`.
- **E2 — Stok geçmişi FIFO düzeltmelerini göstermiyordu**, bu yüzden dökümün "değer değişimi" toplamı ürün kartındaki stok değeriyle tutmuyordu. Düzeltme ve kapanış farkı satırları eklendi. Test: `stok-gecmisi-degerleme`.
- **E3 — Rapor Kutusu "Sipariş sonuçları" kendi nakit formülünü kullanıyordu**: eksik kesinti 0 sayılıyor (64,00 TL yerine 12,90 TL), çift aktarım kopyası ikinci kez sayılıyor, teslim edilemeyip dönen paketin gerçek gideri hiç görünmüyordu (−51,10 TL yerine boş). Ortak satıra bağlandı. Test: `codex-rapor-sonuc`.
- **E4 — `applyReportFees` DUZ teknik ters kaydını müşteri iadesi sayıyordu**: komisyonu gelmemiş pakete **0 komisyon** yazılıp `confirmed` işaretleniyordu ve bu, ikize kopyalanarak kâr raporuna giriyordu. Artık DUZ dışlanır. Test: `codex-duz-kesinti`. **Not: daha önce yazılmış sıfırlar kendiliğinden düzelmez**; §8-K1'deki sorgu adayları listeler.
- **E5 — Ürün kârlılığı "kargodakiler"i ana sayfadan farklı sayıyordu** (116 vs 124 paket; 8.231,06 vs 8.942,10 TL). Aynı kapsama alındı ve kapsam ekranda yazıyor. Test: `codex-kargoda-kapsam`.
- **E6 — Kargodaki tahminde adet uyumu hiç denetlenmiyordu** (R23'ün kâr tarafındaki karşılığı). Tutarlar değiştirilmedi; satır artık `tahmin_uyum` taşıyor ve uyumsuzda "kaba tahmin" uyarısı kâr raporunda, ana sayfada, listede ve pencerede görünüyor. Sentetik örnekte etki: 10 adetlik pakete 1 adetlik kargo uygulanınca tek pakette **324,00 TL**'ye kadar fazla tahmin. Formül bilerek değiştirilmedi (§8-K3).
- **E7 — Otomatik bakım yalnız iş yaptığında iz bırakıyordu**; hiçbir ekranda görünmüyordu, bu yüzden "cron çalışıyor mu?" sorusu Codex raporunda açık kalmıştı. Artık iş yokken de en çok 6 saatte bir iz yazılır ve "Şirket ve yedek" ekranında son 12 iş listelenir. Test: `otomatik-bakim-iz`. **Cron canlıda doğrulandı**: worker günlüğünde `"*/15 * * * *" @ 20.09.2026 12:30:31 - Ok`.
- **E8 — Tasarım:** Codex'in yeni ana sayfasında dönem kartlarından "zarar sayısı ve tutarı" kaldırılmıştı; kullanıcının açık isteği olduğu için geri kondu (`19 zarar · −302 ₺`). Ana sayfadaki günlük tablo telefonda yana kayıyordu; 540 px altında sığacak şekilde sıkılaştırıldı.
- **E9 — Hız (en büyük tek kazanç):** `json_extract(...)=order_packages.order_no` karşılaştırması sütunun TEXT eğilimi yüzünden `(store_id,kind,json_extract(order_no))` ifade indeksini kullanamıyordu; her paket için bütün finans kayıtları taranıyordu. Canlı ölçüm: aynı sorgu **3.379 ms / 2.603.973 satır okuma → 13 ms / 12.143 satır**, sonuç birebir aynı (112 paket, toplam stopaj −364,87 TL). Düzeltme `=+order_packages.order_no` (tekli + eğilimi kaldırır; rapor kayıtlarında sipariş no her zaman `text`).

## 5. Güvenlik denetimi (Codex'te yarım kalmıştı)

Kapsam: kimlik/yetki, enjeksiyon, XSS/CSP, CSRF, dosya yükleme/ayrıştırma, veri sızıntısı, hız sınırlama. Canlıya saldırı yapılmadı; bulgular kod okuma + bellek içi uygulamaya gerçek HTTP istekleriyle doğrulandı.

**Yüksek/engelleyici bulgu yok.** Kimlik doğrulama atlatma, SQL enjeksiyonu, XSS, CSRF açığı, kimliksiz veri sızıntısı ve yöneticiye yükselme yolu bulunamadı.

| # | Seviye | Bulgu | Durum |
|---|---|---|---|
| G1 | Orta | "Tutarlar" yetkisi olmayan personele üç uçta para sızıyordu (`report_gross`, `ledger_gross`, `missing_gross`; `totals.commission/shipping/other`; `package_gross`, `package_seller_discount`, `package_platform_discount`) — gerçek isteklerle kanıtlandı | **Kapatıldı**: alanlar gizleme listesine eklendi |
| G2 | Orta | Yönetici şifresi hiçbir ekrandan değiştirilemiyordu; şifre/çerez sızarsa 7 gün boyunca kapatma yolu yoktu | **Kapatıldı**: `POST /api/admin/password` + "Şirket ve yedek" ekranında form; değişince bütün yönetici oturumları kapanır, işlemi yapan cihaz yeni çerezle devam eder. Test: `yonetici-sifre` |
| G3 | Orta | Giriş denemesi sınırı yalnız IP başınaydı; IP değiştirerek aynı hesaba deneme sınırsızdı | **Kapatıldı**: hesap başına 25 deneme/15 dk |
| G4 | Düşük | Ham hata metni (SQL parçası içerebilir) `orders:read` olan personele dönüyordu | **Kapatıldı**: ayrıntı yalnız yöneticiye |
| G5 | Düşük | Panelin genel dosyasında Cloudflare hesap ve D1 veritabanı kimliği vardı (kimliksiz okunabiliyordu) | **Kapatıldı**: genel bağlantıyla değiştirildi |
| G6 | Düşük | Gövde sınırı `Content-Length` yokken ancak tamamı belleğe alındıktan sonra uygulanıyordu (kimliksiz çağrılabilen giriş ucu) | **Kapatıldı**: gövde akışla okunur, sınır aşılınca kesilir |
| G7 | Düşük | Denetim kaydı "eski oturumları kapatıldı" diyordu ama oturum silinmiyordu (davranış doğruydu, metin yanıltıcıydı) | **Kapatıldı**: metin gerçeğe çekildi |
| G8 | Düşük | `backfill-components` imleç regexi `[w-]` (yazım hatası) — her çağrı baştan başlıyordu | **Kapatıldı**: `[\w-]` |
| G9 | Düşük | HSTS'te `includeSubDomains` yoktu | **Kapatıldı** |
| G10 | Bilgi | `orders:write` yetkisi rapor uçları üzerinden stok/satış defterine yazabiliyor (tasarımla tutarlı, ama yetki metni bunu söylemiyor) | Açık bırakıldı; Codex'in görüşü isteniyor (§9-S3) |
| G11 | Bilgi | Pahalı uçlarda (kâr raporu, ürün kârlılığı, rapor önizleme) oturum başına hız sınırı yok | Açık bırakıldı; §9-S3 |

**Sağlam bulunan ve doğrulananlar (özet)**: oturum çerezi (HttpOnly, SameSite=Strict, Secure, 32 bayt token, yalnız SHA-256 saklanır), kurulum anahtarı ve davet akışı (tek kullanımlık, 24 saat, sabit zamanlı karşılaştırma), yetki kapısının **varsayılan-red** olması ve çalışma alanı yalıtımı (`ec`/`lp`), bağlı parametreli SQL (dinamik ad kullanılan her yerde beyaz liste/`^\w+$` denetimi), `esc()` kapsamı ve CSP'de `unsafe-inline`/`unsafe-eval` bulunmaması, POST'larda Origin ve JSON tipi zorunluluğu, iyzico webhook imzası + sunucu tarafı tutar doğrulaması, XLSX/PDF ayrıştırmasının tarayıcıda olması ve zip bomb sınırları, sağlayıcı anahtarlarının AES-GCM ile şifrelenmesi, service worker'ın `/api/`'yi hiç önbelleğe almaması.

**Kapsanamayanlar**: canlı Cloudflare yapılandırması (secret'ların gücü, WAF/Zero Trust kuralları), canlıdan gerçek başlık ölçümü, bağımlılık CVE taraması (ağ yok; `pdf-lib 1.17.1` bakımsız — ayrıca izlenmeli), `public/magaza/*` ön yüzünün tamamı, pdf/xlsx okuyucularının fuzz testi.

## 6. Yayın ve canlı doğrulama

**Sıra:** migration (eski kodla uyumlu) → kod → canlı kontrol. Her yayın öncesi `npm test` (631/631) ve `npm run build` (kuru derleme).

Migration'lar: `0049_maliyet_motoru`, `0050_report_pipeline_guards`, `0051_performans_indeksleri` — üçü de canlıda uygulandı, `d1_migrations` ile doğrulandı. Hiçbiri veri onarmaz; 0047/0048'e dokunulmadı.

Canlı okuma ile doğrulananlar (yayından önce ve sonra **aynı**):

| Ölçüm | Sonuç |
|---|---|
| Ana sayfa tüm zamanlar | 356 paket · **24.762,46 TL** (yayın öncesiyle aynı) |
| Son 1 ay | 302 paket · **23.381,02 TL** |
| Kargodakiler | 124 paket · **8.942,10 TL** (116 gönderilen + 8 hazırlanan) |
| Sipariş listesi ↔ kâr raporu | Teslim edilen **347/347 pakette kuruşu kuruşuna aynı**, fark 0 |
| Ürün kârlılığı ↔ ana sayfa | Teslim toplamı **24.762,46 TL** (eşit); kargoda toplamı artık 8.942,10 TL |
| Yeni maliyet motorunun geçmişe etkisi | 37 ürün tarandı: **2 kuruş** (TS1 Torf 210 L'de iki satışta 1'er kuruş), 4 satış güvenli atlandı |
| R15 kapasite önizlemesi | Kapasitesini aşan kaynak: **0** |
| Otomatik bakım (cron) | Worker günlüğü: `"*/15 * * * *" @ 20.09.2026 12:30:31 - Ok` |
| Telefon (375 px) | 12 ekranda sayfa taşması, yana kaydırma ve JS hatası yok |

## 7. Performans (canlı, aynı sorgular)

| Uç | Önce | Sonra |
|---|---|---|
| `GET /api/ec/orders` (487 paket) | 4.355–5.260 ms | **729–1.419 ms** |
| `GET /api/ec/performance` (30 gün, 302 satır) | 2.010–2.248 ms | **513 ms** |
| `GET /api/ec/panorama` | 2.464 ms | **1.018 ms** |
| `GET /api/ec/urun-karlilik` | 2.545 ms | **964 ms** |

Kazanç sırası: (1) stopaj sorgusunun indeksi kullanması (§4-E9), (2) bağımsız okumaların paralel çalışması, (3) 0051 indeksleri (sipariş no, teslim tarihi, bileşen-satış, rapor-paket, alış satırı ürünü, satış ürünü).

## 8. Kalan riskler ve açık işler

- **K1 — Geçmişte yazılmış sıfır komisyonlar (E4).** Kod artık üretmiyor ama eski kayıtlar kendiliğinden düzelmez. Adayları listeleyen salt okunur sorgu rapora eklendi (DUZ ters kaydı olan ve komisyonu 0 yazılmış satışlar). Onarım yapılmadı; kullanıcı kararı bekliyor.
- **K2 — 0049 öncesi açık kısmı iade edilmiş satışlar.** `ec_open_costs.cancelled_milli` eski kayıtlarda 0 olduğu için FIFO bu satışları **atlar** (yanlış yazmaz, düzeltmez). Canlıda 4 satış bu durumda; etkisi kuruş düzeyinde. Geri doldurma betiği yazılabilir ama riski kazancından büyük göründü.
- **K3 — Kargodaki tahminde adet uyumu (E6).** Uyarı eklendi, formül değiştirilmedi. Doğrusu için ya desi/paket modeline dayalı kargo tahmini ya da uyumsuz pakette tutarı `null` bırakmak gerekir; ikisi de kullanıcının gördüğü rakamı değiştireceği için Codex'in görüşü isteniyor.
- **K4 — Ana sayfa "kargodaki" kapsamı** artık hazırlanan (stok ayrılmış) paketleri de içeriyor ve iki ekranda da böyle yazıyor. Kullanıcı yalnız gerçekten kargoya verilmişleri isterse iki satır değişiklikle ayrılabilir.
- **K5 — Rapor Kutusu'nda ledger'a bağlanmamış satırlar** hâlâ kayıt tabanlı gösterilir (kapsam dışı, etiketli).
- **K6 — Güvenlik:** G10/G11 açık bırakıldı; ayrıca canlı Cloudflare yapılandırması ve bağımlılık CVE'leri denetlenmedi.
- **K7 — Yedek dışa aktarımı** 40 tablo/25.000 satır sınırında; yeni tablolar (0049/0050) bilinçli olarak dışarıda (ara hesap kayıtları). Tam kurtarma D1 zaman yolculuğuna dayanıyor.

## 9. Codex'e sorular

- **S1 (K2):** Eski `cancelled_milli=0` kayıtları için geri doldurma önerir misin, yoksa "temkinli atlama" kalıcı çözüm mü?
- **S2 (K3):** Kargodaki tahminde adet uyumsuzluğunda doğru davranış hangisi: (a) tutarı göster + uyarı (bugünkü), (b) tutarı `null` yap, (c) desi/paket modeliyle ölçekle?
- **S3 (G10/G11):** `orders:write` yetkisinin rapor uçlarından defter yazabilmesi kabul edilebilir mi; pahalı uçlara oturum başına hız sınırı önerir misin?
- **S4:** 0049'un getirdiği "kapanış tamamlama/kayıp farkı" kayıtlarının muhasebe sunumu (gider kalemi olarak nerede görünmeli) hakkında görüşün.

## 10. Kullanıcının yeni istekleri (uygulanmadı — Codex'ten planlanması isteniyor)

Kullanıcı, bu raporun ardından aşağıdaki işi Codex ile planlamak istiyor. **Bunlar bu oturumda yapılmadı.**

**Hedef: ana sayfanın (dashboard) ve genel olarak bütün ekranların baştan elden geçirilmesi.** İstenen içerik:

1. **Ciro (KDV dahil) her dönemde:** günlük, haftalık, iki haftalık, aylık, tüm zamanlar — bugünkü "cebine kalan" kartlarının yanında ciro da görünsün.
2. **Serbest tarih filtresi:** kullanıcının kendi başlangıç–bitiş tarihini seçebilmesi; bu filtre **her ekranda** (ana sayfa, kâr raporu, siparişler, ürün kârlılığı, stok) geçerli olsun.
3. **Kâr marjı:** ciroya oranla toplam kâr yüzdesi, aynı dönem seçenekleriyle.
4. **Ürün sıralamaları:** en çok ciro getiren ürün; ürün bazında ciro dökümü.
5. **Tek satışta rekorlar:** tek seferlik satışlardan en yüksek ciro yapan sipariş ve tek satışta en çok kâr bırakan sipariş.
6. **Depodaki toplam stok değeri:** ana sayfada tek rakam olarak (KDV dahil ve KDV hariç ayrımıyla).
7. Kullanıcının ifadesiyle "her şeyi yani": bu kalemlerin hepsi tek ekranda, telefonda da yana kaydırmadan okunabilir olmalı.

Uygulama tarafında dikkat edilmesi gereken, bu raporda kanıtlanmış kurallar:

- **Tek ekonomik sonuç:** ciro, kâr, marj ve sıralamalar `performanceReport` paket satırlarından üretilmeli; ayrı SQL toplamı yazılmamalı (yoksa R13/R22 sınıfı fark geri gelir).
- **Bilinmeyen sıfır değildir:** hesaplanamayan paket ciroya/kâra sessizce 0 olarak girmemeli; marj paydasında da aynı kapsam kullanılmalı.
- **Kapsam etiketi:** teslim edilen / kargodaki (tahmini) / hazırlanan ayrımı her rakamda yazmalı (bkz. E5, K4).
- **Stok değeri** `ec_stock_balances.value_cents` KDV hariçtir; ekranda KDV dahil gösterilecekse ürün KDV oranıyla büyütülmeli ve iki değer ayrı etiketlenmeli.
- **Hız:** serbest tarih aralığı büyük aralıklarda 1.000 paket sınırına girer; imleçli sayfalama (R20/R21) kullanılmalı. Ana sayfanın bugünkü süresi ~1 sn; yeni kartlar bunu bozmamalı.
- **Telefon:** yana kaydırma yok; geniş tablo yerine etiket-değer satırı (bkz. E8).

---

**Kapanış:** Codex raporundaki backend bulguları düzeltildi, testleri kalıcı olarak eklendi, migration'lar ve kod canlıya alındı, canlı rakamlar yayın öncesiyle birebir aynı kaldı ve geçmiş veriye dokunulmadı. Yapılmayan tek iş, §8'de açıkça listelenen veri onarımı ve §9'daki karar bekleyen maddelerdir.
