# Lunapot tasarım yenilemesi — doğrulama altyapısı

Tarih: 20 Eylül 2026. Çalışma deposu: `C:/Users/baran/Desktop/site/lunapot-panel`.
Yalnız `scripts/design-preview.mjs`, `scripts/design-audit.mjs` ve bu belge düzenlendi. İş kodu, finansal motor, migration, ortak CSS, paket bağımlılıkları ve diğer ajanların dosyaları değiştirilmedi. Commit/push/deploy ve canlı veri işlemi yapılmadı.

## Hızlı başlangıç

Gereksinim: yerleşik `node:sqlite` destekli Node 22.13+; bu makinede Node **24.11.1** kullanıldı. SQLite experimental uyarısı beklenir. HTTP önizleme için ek paket kurulumu gerekmez.

```powershell
Set-Location C:/Users/baran/Desktop/site/lunapot-panel
node scripts/design-preview.mjs
```

Adres: **http://127.0.0.1:8790**. Port seçimi: `--port=8791`. Sunucu sadece IPv4 loopback üzerinde dinler; `localhost` Host başlığı özellikle reddedilir. İlk tarayıcı ziyareti gerçek sentetik yönetici ve müşteri oturum çerezlerini alır. Çerez tutmayan HTTP istemcisi `/__preview/start` yanıtındaki `Set-Cookie` değerlerini sonraki isteklere taşımalıdır.

Durdurma: Ctrl+C. Yeniden başlatma bellekteki bütün sentetik değişiklikleri sıfırlar. CSS/HTML/istemci JS her istekte diskten okunur; **worker/backend, migration veya fixture betiği değiştiğinde sunucuyu yeniden başlatın**. Mevcut süreci durdurmadan ikinci kez aynı portta başlatmak EADDRINUSE verir; başka süreci otomatik öldürmez.

## Yerel senaryolar ve roller

- Dolu: `http://127.0.0.1:8790/__preview/start?scenario=populated`
- Eksik: `http://127.0.0.1:8790/__preview/start?scenario=missing`
- Boş: `http://127.0.0.1:8790/__preview/start?scenario=empty`
- Tutar görmeyen ekip üyesi: `http://127.0.0.1:8790/__preview/start?role=reader`
- Yalnız müşteri: `http://127.0.0.1:8790/__preview/start?role=customer&next=/magaza/hesabim.html`
- Oturumsuz: `http://127.0.0.1:8790/__preview/start?role=anonymous`
- Senaryo, sayfa listesi, kayıt sayıları ve detay kimlikleri: `http://127.0.0.1:8790/__preview/health`

`scenario`, `role` ve URL-kodlanmış `next` birlikte verilebilir. Seçim tarayıcı çerezinde tutulur; üç senaryo birbirinden ayrı bellek veritabanıdır. Aynı senaryoyu kullanan sekmeler aynı sentetik veriyi paylaşır. Boş senaryo ticaret/üretim/katalog/sipariş açısından boştur; erişim testi için yönetici, iki ekip kaydı ve bir müşteri hesabı tutulur.

Gerekirse elle giriş: yönetici kullanıcı adı boş, şifre `synthetic-owner-password`; ekip `preview.reader` / `synthetic-reader-password`; müşteri `musteri@example.test` / `synthetic-customer-password`. Bunlar yalnız yerel sentetik kimlik bilgileridir.

## Fixture kapsamı

Gerçek `tests/helpers/app-fixture.js` bütün mevcut migration'ları `:memory:` SQLite'a yükler. HTTP isteklerini güncel `src/worker.js` karşılar; API yanıtı taklit edilmez. Statik asset bağlaması yerel `public/` dosyalarını güvenli yol sınırlarıyla sunar. `/`, `/uretim/`, `/eticaret/`, `/webmagaza/`, `/access` ve `public/magaza/*.html` kullanılır. Worker'ın üretim CSP'si aynen korunur. Yerel yanıtlara `Cache-Control: no-store` ve `X-Lunapot-Preview: synthetic-local-only` eklenir.

Fixture ortamı test kurulum belirteci, bellek DB, yerel ASSETS ve `WS_MODE=demo` içerir; canlı bağlantı anahtarları veya uzak D1 bağlaması kullanılmaz. Worker sürecinin `fetch` çıkışı engellenir. Host/Origin denetimi loopback dışı kullanımını reddeder. Zamanlanmış bakım tetiklenmez. Yerel UI yazmaları yalnız bellekteki sentetik veriyi etkiler.

- 6 e-ticaret ürünü; uzun Türkçe adlar, farklı stok/maliyetler, KDV profili eksik bir kart.
- TY/HB üzerinde 28 teslim edilmiş + 8 kargoda paket; bugün, 7/14/30 gün sınırları ve 100 gün öncesine uzanan tarih dağılımı. 45 gündür bekleyen paket de bulunur.
- Dolu senaryoda 4 zarar eden teslim; kesin ve tahmini kesintiler. Paket/bileşen/satış ilişkileri mevcut panorama test modeliyle kurulur. Bu seed uçtan uca muhasebe fişi gönderim testi değildir.
- Eksik senaryoda kaynak değişikliği nedeniyle 1 teslim ve 1 bekleyen paketin ekonomik sonucu bilinmez; ek kesinti tahminleri, 1 negatif stok kartı ve bilinmeyen brüt depo değeri bulunur. Finansal sıfırla eksik değer karıştırılmaz.
- 1 tedarikçi, 3 satırlı kaydedilmiş alış faturası ve kısmi mal teslimi; fatura detayı sağlık yanıtında bulunur.
- 3 üretim ürünü, 4 hammadde ve depo açılışları, 2 reçete, 2 tamamlanmış üretim ve 2 parti. Bir ürünün reçetesi bilinçli olarak eksik.
- Tutar görmeyen okuma yetkili ekip hesabı ve davet bekleyen üye.
- Mevcut yerel mağaza örnek kartlarından üretilen katalog, 1 müşteri, yeni/hazırlanıyor/kargoda/teslim durumlarında 4 test siparişi, destek talebi ve uygulamanın oluşturduğu test posta kayıtları. Gerçek tahsilat veya posta gönderimi yok.

## Playwright ve denetim

Bu makinede proje bağımlılıklarında Playwright yok. Betik kurulu paketi şu konumdan bulur:
`C:/Users/baran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`.

Alternatif Node: `C:/Users/baran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
Paket yolu gerekirse `PLAYWRIGHT_MODULE_PATH`; tarayıcı yolu `--browser-executable=...` veya `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ile verilebilir. Sıra: proje paketi → bilinen Codex runtime; tarayıcı: Playwright Chromium → kurulu Chrome → kurulu Edge. **Paket/tarayıcı indirilmez.** Doğrulamada kurulu **Chrome 153.0.8010.52** kullanıldı; Playwright'ın kendi Chromium headless paketi mevcut değildi.

Bütün modüller hazır olduktan ve backend değişiklikleri için önizleme yeniden başlatıldıktan sonra:

```powershell
node scripts/design-audit.mjs --browser=required --widths=390,1440 --strict-layout --require-report-contract
```

Menü anahtarları ve bütün müşteri HTML sayfaları mevcut yerel kaynaklardan keşfedilir. Varsayılan dolu senaryoda her sayfa iki genişlikte açılır. Her sayfa için tam sayfa PNG, DOM taşma ölçümleri, etiket eksikleri, görünür pencerelerin ölçüleri, bozuk görseller, hata yanıtları, console/pageerror kayıtları `audit.json` ve `audit.md` ile yazılır. Ödeme sayfası sentetik bekleyen sipariş kimliğiyle açılır; dolu mağaza senaryosunda checkout için sentetik sepet seçimi hazırlanır. Hash tarih parametreleri `--path` içinde aynen korunur.

```powershell
# Beş kök ortam + mağaza, hesap ve ödeme için kısa görüntü turu:
node scripts/design-audit.mjs --browser=required --smoke --widths=390,1440

# Boş/eksik ekranlar, ayrıca dar telefon:
node scripts/design-audit.mjs --browser=required --smoke --scenarios=missing,empty --widths=360,390,1440

# Belirli pencereyi aç; form kaydetmez:
node scripts/design-audit.mjs --browser=required --path='/webmagaza/#orders' --open='button[data-order]' --widths=390,1440

# Browser olmadan yalnız HTTP ve yeni rapor alan sözleşmesi:
node scripts/design-audit.mjs --browser=off --smoke --scenarios=populated,missing,empty --require-report-contract
```

Çıktı varsayılan olarak `%TEMP%/lunapot-design-audit/<timestamp>/` altında; `--out=ABSOLUTE_PATH` ile değişir. Kod 1 başarısız denetimi, kod 0 seçilen denetim kapsamının geçtiğini belirtir. `--browser=required` tarayıcı yoksa başarısız olur. `--browser=auto --allow-http-fallback` sadece HTTP'ye geçebilir; rapor bunu açıkça yazar, görüntü denetimi yapılmış saymaz.

Entegrasyon sürerken `--allow-asset-404` eksik stil/script/görsel/font 404'lerini uyarı olarak kaydeder; nihai turda kullanmayın. CSP ihlalleri ve JavaScript çalışma hataları geçiştirilmez. Servis worker engellenir; tarayıcı isteği yalnız bu yerel origin'e gidebilir ve GET/HEAD dışındaki ağ yazmaları engellenir. `--open` ancak tek `--path` ile kullanılabilir. Görüntü alınması tasarımın insan tarafından onaylandığı anlamına gelmez.

## Yapılan doğrulama — sınırlı kapsam

- İki betik Node sözdizimi denetiminden geçti.
- Üç senaryoda **78 HTTP kontrolü, 0 hata**; özel tarih filtresi ve yeni panorama alanları `--require-report-contract` ile kontrol edildi. Son çıktı: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/2026-09-20T11-18-03-851Z/audit.json`.
- Dolu/eksik/boş durumlarının paket sayıları, eksik ekonomik sonuçları, negatif stok ve bilinmeyen brüt değerleri ayrıca gerçek API yanıtından doğrulandı.
- Kimliksiz `/api/data` 401; yabancı Origin ve farklı Host 403. API oturumu taklit edilmedi.
- **Yalnız uygulama seçimi `/` sayfasında** 390 ve 1440 pikselde gerçek Playwright ekran görüntüsü ve DOM denetimi yapıldı: 2 PNG, 2 DOM kontrolü, taşma/çalışma hatası yok. Çıktı: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/2026-09-20T11-15-26-162Z/`.
- CUA tarayıcı kernel'i ACL hatası nedeniyle kullanılamadı; yukarıdaki görüntüler yükseltilmiş exec üzerinden kurulu Playwright/Chrome ile alındı.

Tam sayfa/pencere taraması, 360 px tasarım kabulü, bütün form eylemleri, klavye/ekran okuyucu turu ve tam regresyon testleri yapılmadı; kullanıcı talimatıyla modül entegrasyonu sonrası ana ajan çalıştıracak. Genişlik ölçümü içeriğin overflow:hidden ile kesilmediğini tek başına kanıtlamaz; PNG/DOM bulguları ayrıca incelenmelidir. Alış PDF eki, Rapor Kutusu dosya/parça akışı, banka ekstresi, iadeler ve bütün hata/yükleniyor durumları seed edilmedi. Canlı sağlayıcı, gerçek ödeme, e-posta veya finansal doğruluk onayı bu betiklerin kapsamı değildir. Yeni CSS dosyası yok.

## Geniş tarama — 20 Eylül 2026, 14:22–14:26 İstanbul

Ana ajan talebiyle entegrasyon devam ederken **69 adres × 390/1440 px = 138 ekran görüntüsü ve DOM kontrolü** tamamlandı. Önceki bölümdeki "tam sayfa taraması yapılmadı" notu bu kapsam için güncellenmiştir; bütün formların kaydedilmesi ve insan görsel onayı hâlâ yapılmadı. UI veya iş kodu değiştirilmedi.

Kalıcı rapor klasörleri (bu makinenin yerel geçici dosya alanında; otomatik temizlenmedi):

- Geniş tarama: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-broad-2026-09-20/` → `audit.json`, `audit.md`, 138 PNG, `finding-details.json`.
- Etkileşim: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-interactions-2026-09-20/` → `interactions.json`, `interactions.md`, 19 PNG.
- Yardım tekrar: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-recheck-yardim-2026-09-20/` → temiz 390 px PNG ve rapor.
- Yasal tekrar: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-recheck-yasal-2026-09-20/` → temiz 390 px PNG ve rapor.
- Ayarlar/açık açıklama tekrar: `C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-recheck-settings-2026-09-20/` → 390/1440 px PNG ve CSP bulgusu.

İlk geniş turun sonucu: 45 HTTP kontrolü; 0 başarısız HTTP/API yanıtı, 0 eksik asset, 0 bozuk görünür görsel, 0 JavaScript pageerror. Altı hata kaydı üç ayrı nedenin tekrarlarıydı: dört CSP kaydı (iki ayar sayfası × iki genişlik), iki mobil mağaza taşması. Negatif kâr tutarlarına ve 45 gündür kargodaki pakete ait `.error` metinleri beklenen sentetik iş durumlarıdır; uygulama hatası sayılmadı.

### Sahibe göre eylem listesi

| Sahip / dosya | Bulgu | Son doğrulama |
| --- | --- | --- |
| Ortak şirket/ayarlar iş akışı — `public/operations-ui.js:54` | `/uretim/#settings` ve `/eticaret/#settings` içinde `pre.tip` üzerinde `style="white-space:pre-wrap;word-break:break-all"` bulunuyor. Gerçek CSP `style-src 'self'` nedeniyle `style-src-attr` ihlali oluşuyor. Tarayıcı olayı `operations-ui.js:48` innerHTML atamasını bildiriyor. Sabit deklarasyonları bir CSS sınıfına taşıyın ve style niteliğini kaldırın; CSP'yi gevşetmeyin. | **Açık.** 390 ve 1440 px'de tekrarlandı. “Yedekten geri dönme hakkında” açıklaması açılarak da kaydedildi; bunun dışında taşma/işlev kaybı görülmedi. |
| Müşteri mağazası — `public/magaza/yardim.html`, mağaza CSS | İlk turda 390 px görünümde 413 px belge; FAQ summary içindeki `+` simgeleri sağa taşıyordu. | **Eşzamanlı başka ajan düzenlemesi sonrası temiz.** Aynı harness ile 390 px yeniden geçti. İlk bulgu PNG'si ve yeni temiz PNG ayrı tutuldu. |
| Müşteri mağazası — `public/magaza/yasal.html`, mağaza CSS | İlk turda 390 px görünümde 464 px belge; yasal belge menüsü bağlantıları dışa uzanıyordu. | **Eşzamanlı başka ajan düzenlemesi sonrası temiz.** Yeniden yüklemede menü iki sütunlu grid; aynı 390 px harness kontrolü geçti. |
| Ortak shell/launcher/access | İlk kök sayfa, navigasyon ve etkileşimler. | Açık işlev/DOM/CSP bulgusu yok. İnsan görsel incelemesi ana ajanda. |
| Üretim / commerce / insights / web mağaza yönetimi | Diğer taranan route'lar. | İlk geniş turun kapsamı içinde pageerror, asset 404 veya belge taşması yok. Bu sonuç bütün alt pencerelerin ve gönderimlerin onayı değildir. |

### İstenen etkileşimler

**13/13 adım geçti; 19 ekran görüntüsü; 0 console/pageerror, 0 ağ yazması.** 390 ve 1440 px'de ayrı tarayıcı oturumları kullanıldı.

- Root: üç uygulama kartı görünür; yönetici erişim bağlantısı görünür; e-ticaret kartı doğru ortama gider.
- Çalışma alanı değiştirici: beş bağlantı; açılma, Escape ile kapanma, tetikleyiciye odak dönüşü ve üretime gerçek gezinme doğrulandı.
- Mobil menü (390): başlık düğmesiyle açılma, `aria-expanded`, görünür arka plan, Escape/odak dönüşü; alt menü düğmesiyle tekrar açılma ve Fiyat Hesaplama bağlantısıyla kapanma doğrulandı.
- Fiyat hesaplama: gerçek ürün seçimi; adet 2, KDV dahil fiyat 240.50, hedef 50; TY→HB geçişi. İlgili GET hesap uçları 200 döndü ve sonuçlar yeniden çizildi. Adet 0 yerel doğrulamayla reddedildi, 1'e geri dönünce hesap toparlandı. Fiyat/adet/hedef alanlarında etiket, yeterli boyut ve görünürlük var; yatay kırpılma yok.
- Ekip/erişim: “Çalışan ekle” alanı açıldı; kullanıcı adı/ad girildi; Depo personeli preset'i stok yazma/tutar kapalı seçti; Tümünü görüntüle preset'i read seçti; silme kutusu kapalı kaldı. Düzenleme formu mevcut kullanıcıyla açıldı. **Kaydet/kurulum bağlantısı gönderimi yapılmadı.**
- Oturumsuz e-ticaret girişinde kullanıcı/şifre alanları görünür ve etiketli. Giriş gönderilmedi.

Erişim formundaki 17×17 px checkbox kendi ölçüsü küçük olsa da görünür metin etiketiyle birlikte tıklanabilir; yalnız kutu boyutu nedeniyle yeni hata yazılmadı. Fiyat hesabı finansal regresyon testi değildir; etkileşim/yeniden hesaplama akışı kontrol edildi.

### Tekrarlama

```powershell
node scripts/design-audit.mjs --browser=required --widths=390,1440 --strict-layout --require-report-contract --out=C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-broad-next
node scripts/design-audit.mjs --browser=required --path='/eticaret/#settings' --open='summary:has-text("Yedekten geri dönme hakkında")' --widths=390,1440 --strict-layout
```

İlk tur sürerken diğer ajanlar dosya değiştirdiği için bu 138 görüntü atomik bir sürüm anlık görüntüsü değildir. Mağaza taşmalarının giderildiği hedefli tekrarlarla doğrulandı. Gelecek tam kabul turunda modüller tamamlanmış ve backend yeniden başlatılmış olmalıdır. Tarama hiçbir UI dosyasını değiştirmedi; mevcut sunucu aynı adreste çalışmaya devam ediyor.

## Son durum — 20 Eylül 2026, 14:43 İstanbul

Bu bölüm önceki açık CSP ve sınırlı test notlarını günceller. Kullanıcının talebiyle 8790 sunucusu bir kez yeniden başlatıldı; PID 27956, güncel cursor API ve günlük money-redaction kodu yüklü. İkinci sunucu oluşturulmadı.

- Owner populated/missing/empty: 78 HTTP, 54 görüntü/DOM, 0 hata/taşma.
- Reader: 12 HTTP, 18 görüntü/DOM, 0 hata/taşma.
- Hazır frontend `loadPerformancePages` ile Tüm dönem + ec/lp settings: 12/12 hedefli kontrol geçti. Cursor parametresi gerçek tarayıcı isteklerinde var, terminal `sonraki_imlec:null`; reader günlük TY/HB ve cash alanları null.
- `tests/redesign-analytics.test.js` + `tests/redesign-dates.test.js` çalıştırıldı, exit 0; 1005 satır cursor/loader kontrolleri dahil. Ana ajanın bildirdiği tam test 660/660 ve build pass bilgisi ayrıca kayda alındı; bu görev tam takımı tekrar çalıştırmadı.
- `recovery-command` CSP düzeltmesi ec/lp 390/1440 px'de açık açıklamayla geçti. **CSP bulgusu kapandı.** Yardım/yasal mobil taşmaları kapandı.
- Erişim hero: başlık 12.14:1, açıklama 4.59:1 kontrast; fiyat formu mobilde 316×42 px görünür/etiketli alanlar. Son root/switcher/Escape/focus/mobil menü/erişim preset/fiyat hesaplama tekrarları geçti.
- Önceden başlatılan kontrast ölçümü 11:35 UTC'de tamamlandı (138 görünüm, 0 belge taşması). “Yeni geniş tarama yapma” talimatından sonra yalnız hedefli kontroller yapıldı.

**Açık görsel kabul engelleri**, son kez 14:43 İstanbul'da hedefli doğrulandı:

1. Müşteri mağazası `.studio-footer .footer-top a`: `#e5edff` metin / `#e8eee4` zemin, ~1.01:1; başlıklar da beyaz. Yeni açık footer'a koyu metin override'ı gerekli.
2. Ortak shell/launcher `.ui-skip-link:focus`: `#20342f` / `#234633`, ~1.25:1; klavyeyle görünürken yazı okunmuyor. Genel anchor mirasına karşı açık metin rengi gerekli.
3. Commerce ortak iş akışı `.v2-stat.highlight .v2-stat-value`: beyaz / `#e8eee4`, ~1.18:1. “Dağıtılmayı bekleyen” tutarını etkiler (ec/lp reconciliation). `commerce-workflows.css:21` açık zemin, `design.css:112` beyaz çocuk metni birlikte kalıyor; tutar override'ı gerekli.

İkincil ölçümler: dock etiketleri ~3.55:1; küçük tablo yardımcı metinleri ~3.86:1; bazı launcher yardımcı metinleri ~3.0:1. Kontrast adayları tekrar eden/dekoratif/ekran dışı içerikler de içerdiğinden ham aday sayısı hata sayısı olarak kullanılmadı.

Son birleşik rapor ve kanıt bağlantıları:
`C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-final-targeted-2026-09-20/summary.md`.

Ayrı korunan sonuçlar: `redesign-final-smoke-owner-2026-09-20`, `redesign-final-smoke-reader-2026-09-20`, `redesign-final-targeted-2026-09-20`, `redesign-final-contrast-2026-09-20` (aynı `%TEMP%/lunapot-design-audit/` üst klasöründe). UI dosyası değiştirilmedi. Yeni formlar kaydedilmedi; canlı veri/commit/push/deploy yok. Sunucu açık bırakıldı.


## Hedefli son kontrast kontrolü — 20 Eylül 2026, 14:49 İstanbul

Ana ajanın 14:44 düzeltmeleri ardından yalnız üç bileşen 390/1440 px'de gerçek Playwright/Chrome ile yeniden ölçüldü (ec/lp tutarı ayrı: toplam 8 hedefli görünüm). Yeni geniş tarama veya test takımı çalıştırılmadı. Ana ajan son tam test sonucunu 671/671 ve final build pass olarak bildirdi.

- **Kapandı:** Odaklanmış .ui-skip-link beyaz / #234633, **10.52:1**.
- **Kapandı:** ec/lp reconciliation .v2-stat.highlight .v2-stat-value #20342f / #e8eee4, **11.16:1**.
- **Açık:** Mağaza footer bağlantıları #e5edff / #e8eee4, **1.01:1**; başlıklar ve wordmark beyaz, **1.18:1**. Son canlı DOM kontrolü 11:49:44 UTC. Yeni store-redesign.css kuralı yüklenmiş olsa da studio.css içindeki daha yüksek özgüllük kazanıyor. Baskın seçiciler: .studio-footer .footer-top > div > a:not(.wordmark), .studio-footer .footer-top h3, .studio-footer .footer-top .wordmark. Düzeltmede aynı seçicilere body eklemek gibi yeterli özgüllük kullanılmalı. Footer round-link beyaz / #315c45 doğru durumda.
- Sekiz hedefli görünümde 0 console/pageerror, 0 belge taşması. CSP settings ve önceki populated/missing/empty+reader smoke sonuçları temiz kalır. İkincil helper renklerine yeni tarama yapılmadı.

Kanıt: C:/Users/baran/AppData/Local/Temp/lunapot-design-audit/redesign-final-targeted-2026-09-20/contrast-fixed.json ve 390/1440-fixed-*.png. Son durum: iki ciddi kontrast engeli kapalı, footer hâlâ açık; bütün engeller kapandı olarak onaylanamaz. UI dosyası değiştirilmedi; sunucu 8790'da açık.
## Ana ajan son kabulü
Son tam regresyon **671/671** geçti; son yayın kuru derlemesi başarılı. Yukarıdaki üç kontrast engeli son CSS düzeltmeleriyle **kapandı** ve ana ajan tarafından gerçek Chrome'da tekrar doğrulandı: odaktaki skip bağlantısı beyaz/koyu yeşil (10,52:1); mağazada tam “Tüm ürünler” bağlantısı `rgb(54,83,50)`/`rgb(232,238,228)`; mutabakat tutarı `rgb(32,52,47)`/`rgb(232,238,228)`. Üç hedefli kontrol de geçti. Dock, tablo ve launcher yardımcı metinleri ayrıca koyulaştırıldı.

Yayın öncesi doğrulanmış bir uygulama engeli kalmadı. Bunun kapsamı yukarıdaki yerel sentetik senaryolar ve salt okunur tarayıcı kontrolleridir; gerçek ticari işlem kaydedilmedi.
