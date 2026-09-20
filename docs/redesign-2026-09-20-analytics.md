# Backend analytics — 20 Eylül 2026

Etkin depo: C:/Users/baran/Desktop/site/lunapot-panel, temel 187b42e.

## Kapsam ve kaynak

- Kod sahipliği: src/panorama-api.js, src/urun-karlilik-api.js, tests/redesign-analytics.test.js.
- Bütün satış/ciro/kâr/ürün payları mevcut performanceReport → tumSatirlar satırlarından gelir. Yeni ekonomik formül, migration veya performans motoru değişikliği yok.
- Teslimler mevcut 92 günlük parçalar ve kararlı paket imleciyle okunur. 1.005 aynı gün paket testi eksiksiz/tekrarsız toplamı doğrular.
- Yalnız yerel, bellek içi SQLite verisiyle doğrulama yapıldı. Canlı veri yazımı, commit, push ve deploy yapılmadı.
- send_input aracı bu oturumda yok. API sözleşmesi ana ajana ve insights ajanına mevcut görev mesajlaşma aracıyla iletildi.

## Ortak tarih sözleşmesi

GET /api/ec/panorama?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/ec/urun-karlilik?from=YYYY-MM-DD&to=YYYY-MM-DD

Parametreler yoksa eski kapsam korunur. Verilirse her ikisi de tam birer kez bulunmalı; takvimde geçerli, sıfır dolgulu ISO tarih olmalı ve from <= to olmalıdır. Boş, tek sınır, yinelenen parametre, 30 Şubat, ters aralık ve saat içeren değerler veritabanına erişmeden HTTP 400 üretir. İki sınır dahildir.

Gelecek tarih reddedilmez: seçilen aralıktaki kayıtlar motorla aynı kapsamda okunur; gelecek için tahmini teslim yaratılmaz. Gelecekteki geniş aralık tek imleçli okumadır; binlerce boş 92 günlük sorgu üretmez. Hazır dönemler bugünde biter. Daily geçmiş seri korunur; geleceğe uzanan özel aralıkta sadece gerçek sonucu olan gelecek günler ayrıca eklenir (boş gelecek günleri üretilmez). Takvim günü Europe/Istanbul temelindedir.

## Panorama yanıtı

Mevcut as_of, today, first_delivered, unallocated_fee_cents, coverage, periods, daily, pending, notice korunur.

periods sırası: 1g, 7g, 14g, 30g, 90g, 180g, tum; açık tarih varsa sonda custom.
selected_period açık aralıkta periods içindeki custom nesnesinin aynısıdır; parametresiz null.
Her dönemde from/to ve gün sayısı vardır. 1g bugündür; son N gün bugünü dahil eder.
Özel aralıkta prev_cash_cents null; hazır dönemlerin mevcut karşılaştırma kapsamı korunur.

Her dönem:
- cash_cents: geriye uyumlu, hesaplanabilen nakit satırlarının toplamı; missing/calculated ile okunmalı.
- calculated_cash_cents: hesaplanabilen satır yokken null; gerçekten boş dönem 0.
- revenue_gross_cents: gross cirosu bilinen motor satırlarının toplamı; paket varken hiçbirinin cirosu bilinmiyorsa null; gerçekten boş dönem 0.
- revenue_calculated / revenue_missing: ciro bilinen/bilinmeyen paket sayısı. Eksik maliyet/KDV nedeniyle motor ciroyu vermiyorsa ek SQL ile ciro uydurulmaz.
- margin_bps: yalnız cash_cents ve revenue_gross_cents BİRLİKTE bilinen satırlar üzerinden round(ortak nakit × 10000 / ortak ciro). Ortak ciro <= 0 veya tarih parçası okunamadıysa null. 1173 = %11,73.
- margin_packages / margin_missing: bu ortak kapsamın paket sayıları.
- margin_revenue_gross_cents / margin_cash_cents: oran paydası ve payı; ortak satır yoksa null.
- status: complete, estimated veya incomplete. Eksik kayıt/başarısız parça incomplete; fees_estimated, cost_estimated veya assumptions_source estimated. Salt açıklama/iade notu tahmin sayılmaz.
- loss_cents, gain_cents, gains, losses, profit_ex_vat_cents, channels ve eski toplamlar korunur.
- partial okunamayan tarih parçasını belirtir. Böyle bir dönemde hiç satır okunamadıysa yeni ciro ve calculated_cash_cents null olur; eski cash_cents anlamı değişmez.

products:
- top / bottom / count: mevcut hesaplanan nakit katkısı sıralaması ve net pozitif adet kapsamı korunur.
- revenue_top: aynı ürün kapsamındaki en çok beş ürün, revenue_gross_cents azalan sırada. Ürünün herhangi bir paket payı eksikse ürün eksiksiz ciro sıralamasına alınmaz.
- Satır: product_id, name (tam ad), qty_milli, packages, cash_cents, per_unit_cents, revenue_gross_cents, revenue_missing, estimated.
- missing_packages: ürün payları motorca çıkarılamayan paket sayısı.

records:
- revenue / profit: null veya tek sipariş rekor nesnesi. profit burada KDV dahil cash_cents rekorudur, KDV hariç profit_cents değildir.
- Aynı channel + order_no altındaki seçili döneme giren paketler toplanır. Farklı kanallardaki aynı sipariş numarası karışmaz. Dönem dışındaki paketlerin tutarı içeri çekilmez.
- Nesne alanları: id, channel, order_no, external_id, package_ids, packages, revenue_gross_cents, cash_cents, revenue_missing, cash_missing, estimated.
- id/external_id siparişin kapsam içindeki bir paketine aittir; bütün paket kimlikleri package_ids içinde.
- Siparişin bir paketinde ilgili metrik bilinmiyorsa o metrikte rekor adayı olmaz. Bilinen zarar, bilinmeyen sahte sıfıra yenilmez. Eşitlikte kimlik sırası kararlıdır.
- orders, revenue_missing_orders, profit_missing_orders ve partial sıralamanın kapsamını belirtir.

pending bütün güncel bekleyenleri kapsayan eski sözleşmeyi korur; panorama özel tarih filtresi bu bölümün tarihini değiştirmez. Hata halinde yeni ciro/kapsam alanları da null döner.
daily mevcut hesaplanabilen nakit günlük serisidir; özel aralık gönderilse de tüm bugüne kadarki seri korunur. Gelecekte kayıt varsa seçilen aralıktaki gerçek sonuç günleri de sıralı eklenir; grafik ile custom toplamı eşleşir, uzak gelecek için dev boş takvim yaratılmaz.

## Güncel stok

inventory:
- scope: current; date_filter_applies: false; as_of.
- net_cents: mevcut stok defteri value_cents toplamı.
- gross_cents: ürün bazında round(value_cents × (10000 + güncel vat_bps) / 10000) toplamı. Stokta olup KDV profili bulunmayan ürün varsa null.
- calculated_gross_cents: yalnız KDV'si bilinen stokların hesaplanabilen brüt kısmı.
- missing_vat_products ve negative_products ürün sayılarıdır; liste değildir.
- products: miktarı veya defter değeri sıfırdan farklı stok kartlarının sayısı. Tamamen boş kartın eksik profili brüt toplamı engellemez. Beyan edilmiş %0 KDV bilinendir.
- gross_estimated: true; gross_basis: current_product_vat; partial eksik KDV varlığını belirtir.
- Negatif stok saklanmaz; negative_products ile açıklanır, defter net tutarı değiştirilmez. Arşivli karttaki stok da stoktur.
- Bu tutar tarihsel stok, satış değeri, kullanılabilir miktar veya fiili alış KDV toplamı değildir; mevcut defter değeri ve güncel KDV tahminidir.

## Ürün kârlılığı

Mevcut parasal/ürün alanları ve hesap korunur. Açık from/to:
- Teslimler sonuç tarihiyle (teslim veya teslim edilemeyip dönme tarihi) süzülür.
- Hazırlanan/kargodaki paketler occurred_on ile süzülür.
- Yanıttaki from/to seçilen aralıktır; date_basis = {delivered: delivered_on, pending: occurred_on}; pending_from ayrıca döner.
- Parametresiz bekleyen/teslim kapsamı eskisi gibidir.
- Stok bakiyesine geçmiş tarih görünümü uygulanmaz.

## Son doğrulama

Entegrasyon düzeltmeleri ana ajan tarafından uygulandı: permission-policy.js artık margin_bps alanını tutar yetkisiyle gizler; mevcut panorama testinin dönem listesi 1g içerir. Bu sahiplik dışı dosyalar bu ajan tarafından değiştirilmedi.

Kullanıcının istediği son hedefli regresyon **bir kez** çalıştırıldı: **34/34 geçti, 0 hata, 0 atlanan test**.
Kapsam: redesign-analytics (12 test), panorama, codex-kar-ortak, codex-kar-kapsam, codex-kargoda-kapsam, codex-kar-stopaj, codex-yetki-r25.

Doğrulananlar: tarih doğrulaması ve sınır günleri, aynı motorla ciro/nakit/marj eşitliği, bölünmüş siparişler, kanal ayrımı, bilinmeyen maliyet/KDV, zarar rekoru, brüt stok/%0 KDV/eksi stok, ürün tarih filtresi, 1.005 paket sayfalama, iadeler/stopaj/çift aktarım, tahminli kesinti, başarısız tarih parçası, uzak gelecek sorgu sınırı ve grafik toplamı, salt okunur davranış, yeni alanlar ve paylaşılan custom nesnede tutar gizleme.

Kod dosyalarının sözdizimi ve sahip olunan değişikliklerin boşluk kontrolü temiz. performance-api.js, migrationlar ve mevcut .node-version / scripts kullanıcı değişiklikleri bu ajan tarafından değiştirilmedi. Canlı veri yazımı, commit, push ve deploy yapılmadı.

Sonraki ayrı inceleme kapsamında dashboard ajanıyla custom dönem kapsamı ve null tutarların gösterim tutarlılığı kontrol edilebilir; bu teslimde yeni özellik veya ek kapsam açılmadı.
