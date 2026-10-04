# Dashboard maliyet/kesinti backend — tamamlandı (4 Ekim 2026)

## UI sözleşmesi
Her periods[] öğesinde ve selected_period içinde financials var. Tüm zamanlar her zaman periods.find(p => p.key === 'tum').financials ile bulunur. Eski panorama alanları ve eski daily dizisi korunur.

Metrikler: revenue, cost, commission, shipping, other, withholding, fees, cash.
Her metrik: {total_cents, known_cents, known_packages, missing_packages, estimated_packages, recorded_cents, estimated_cents}.

- total_cents: yalnız eksiksiz okunmuş, ilgili kalemi bütün paketlerde bilinen kapsamda toplam. Eksikte null.
- known_cents: okunmuş paketlerde bilinen kısmın toplamı. Hiç bilinen yoksa null; gerçekten boş kapsamda 0.
- recorded_cents + estimated_cents = known_cents (bilinen tutar varsa). Kayıtlı, bankadan ödenmiş anlamına gelmez.
- estimated_packages: o METRİKTE tahmin olan paket sayısı. Yalnız kargosu tahmin edilen paketin bilinen komisyonu/diğeri kayıtlı kalır. Stopaj tahmini diğer kesintileri tahmini yapmaz.
- fees: commission + shipping + other + withholding; yalnız dört kalemi de bilinen ortak paket kapsamı. Ayrı ayrı bilinen, farklı paketlere ait tutarlar yanıltıcı bir kesinti toplamında birleştirilmez.
- Stopaj pozitif kesinti yönündedir (performans satırındaki negatif withholding_cents işareti çevrilir).
- financials.channels.trendyol / hepsiburada: aynı metrikler, packages ve coverage.
- financials.packages: okunma hatası yoksa paket sayısı; okunamayan tarih parçası varsa null.
- financials.coverage: {complete, read_packages, missing_packages, estimated_packages}. complete yalnız okuma kapsamını anlatır; tutar eksiklikleri ayrıca missing_packages ile görünür.
- Okuma hatasında metric.missing_packages=null (kaç paket kaybolduğunu bilmiyoruz), known_packages okunan kısmı sayar, total_cents=null. Bilinen tutarlar known_cents içinde kalır.
- financials.reconciliation_cents: revenue − cost − fees − cash; tam veride 0, eksikte null.
- financials.basis bir NESNEDİR: scope/date/amounts/cost_vat/fees/withholding/refunds/paid alanları. Kullanıcıya gösterilecek metin financials.notice.

financial_daily satırı:
{date, revenue_cents, cost_cents, fees_cents, cash_cents, packages, missing_packages, estimated_packages, partial}

Günlük tutar ilgili günün tam metriğidir; eksikse null. Okunamayan tarih parçası grafikte sıfır değil boşluk olur. Gelecek tarihli özel aralık sonuçları ayrıca eklenir; bugünün/tüm-zamanlar kartlarına karışmaz. fees_cents stopajı içerir.

## Önemli mevcut veri sınırı: tarihsel alış KDV’si
Mevcut performance-api.js maliyet brütünü net defter maliyeti × güncel ürün KDV oranıyla büyütüyor. Satışın kendi KDV oranını kullanmıyor; ancak FIFO satış→alış parti KDV bağlantısını saklamıyor. Dolayısıyla bunun geçmiş alış faturalarındaki kesin KDV dahil maliyet olduğunu iddia edemeyiz.

Bu teslimde ortak hesap tutarları/formülleri DEĞİŞMEDİ. cost_gross_basis='current_product_vat' ve cost_vat_estimated metadata’sı eklendi. Dashboard cost metriği profil KDV’si nedeniyle tahmini; cash de bundan etkileniyorsa tahmini. Komisyon/kargo/diğer gerçek kayıtları bu maliyet tahmini nedeniyle tahmini sayılmaz. Tam iadeyle sıfırlanan net maliyet 0 olarak kalır.

UI’da “KDV dahil ürün maliyeti” ve “KDV tahmini” işareti kullanılmalı. “Kesin alış faturası toplamı”, “bankadan ödendi” veya “tarihsel alış KDV’si doğrulandı” denmemeli. Tarihsel alış KDV’sini gerçekten kesinleştirmek için ayrı, test edilen satış-parti/KDV izleme çalışması gerekir. Sahte tarihsel oran türetilmedi, eski veriye onarım yapılmadı.

Stopaj mevcut ortak motorun kayıt/etkin tahmin ayarı politikasını korur. Kayıt yok ve kanalda tahmin kapalıysa ortak motorun sıfır tutarı korunur; burada yeni stopaj politikası kurulmadı.

## Kapsam ve matematik
- Teslim paketleri teslim tarihinde, teslim edilemeden dönenler iade tarihinde yer alır.
- Bu paketlerin sonradan işlenen gerçek iadeleri mevcut ortak modelle netleştirilir.
- DUZELTME-CIFT teknik kopyaları ortak motorun tek ekonomik paket sonucuyla bir kez sayılır.
- Fiziki ürün maliyeti bileşenlerden gelir; bu değişiklik setleri yeni fiziksel stok kalemi yapmaz.
- Kargodaki bekleyenler sonuçlanmış satış toplamına eklenmez; mevcut pending bölümü ayrı kalır.
- Genel işletme giderleri ve gelir/kurumlar vergisi dahil değildir; stopaj gider değil nakit kesintisidir.
- Kuruşlar güvenli tamsayıdır. Toplam güvenli sayı aralığını aşarsa yuvarlanmış sahte toplam yerine null gelir.
- Tüm yeni para alanları *_cents ile mevcut sunucu tarafı tutar gizleme kuralından geçer. Gerçek personel oturumuyla doğrulandı.

## Dosyalar
- src/dashboard-summary.js — saf metrik, kanal ve günlük özet.
- src/panorama-api.js — mevcut dönem/özel aralık özetine ve yeni günlük seriye bağlantı.
- src/performance-api.js — kalem başına brüt metadata: erken dönüşlerde güvenle bilinen değerler; tahminden önceki ücret kayıtlarından recorded/estimated payları ve profil-KDV kaynağı. Mevcut legacy tutar/formül/erken dönüşleri değiştiren satır yok.
- tests/dashboard-financials.test.js — 15 anlamlı test (kalem başı kapsam düzeltmesi dahil).

## Doğrulama
Yeni testler 11/11 başarılı. Tam ilgili regresyon grubu yeni testin son overflow ekinden önce 89/89 başarılı; ardından yeni 11 test tekrar başarılı. Grup: panorama, redesign-analytics, codex-kar-ortak, codex-kar-stopaj, codex-kar-kapsam, nakit-sonuc, kesinti-tahmini, komisyon-orani, codex-yetki-r25, dashboard-financials.

Kanıtlar: her dönemin/kanalın/günlük serinin ortak paket hesabına eşitliği; gelir−maliyet−kesinti=nakit; seçili dönem/tüm-zamanlar ayrımı; farklı satış ve ürün KDV oranları; kayıtlı/tahmini kalem ayrımı; stopaj tahmini; eksik maliyet/KDV; hatalı tarih parçasında boş grafik; gerçek iade zararı ve DUZ ikiz; ortak bilinen kesinti kapsamı; gelecek aralık; gerçek personel tutar gizleme; güvenli tamsayı taşması.

Canlı sorgu, git işlemi, deploy veya migration değişikliği yapılmadı. .node-version ve scripts/migrate-remote.mjs dosyalarına dokunulmadı. Frontend/diğer ajan dosyaları değiştirilmedi.

## Review devamı — kalem başına kapsam düzeltmesi
İnceleme sorunu doğruladı: mevcut performans motorunda brüt kalemler yalnız bütün nakit girdileri tamamlandığında atanıyordu. Bilinmeyen maliyet veya tek eksik kargo yüzünden kayıtlı komisyon da dashboard’dan kayboluyordu. Yeni iki regresyon testi eski kodda null !== 1921 ile kırmızı oldu.

Düzeltme: tam ve değişmemiş paketlerde financial_parts her kalemin total_cents/recorded_cents/estimated_cents/estimated bilgisini bağımsız taşıyor. Ana özet önce mevcut otoritatif brüt alanı, yoksa bu güvenli metadata’yı okuyor. Mevcut cash/profit/brüt alan atamaları ve erken dönüşleri değişmedi. Kaynağı değişmiş veya satırları eksik paketlerden kısmi gelir/gider uydurulmuyor. Tahminle tamamlanan ücretler ürün KDV'si eksik olsa bile ayrıca gösteriliyor; maliyet ve cash null kalıyor.

KDV profili eksik olması pazaryeri fee KDV’si bilinen komisyon/kargoyu silmez. Stopaj mevcut ortak politika ve aynı kuruş bölüşümüyle gelir. Tam veri mutabakatı ve tüm mevcut sonuçları koruma testleri yeniden çalıştırılıyor. Read failure için missing_packages=null / complete=false sözleşmesi aynen kaldı.

Review sonrası son durum: dashboard testleri 15/15; aynı on dosyalık ilgili regresyon grubu 94/94 başarılı, 0 hata. Sözdizimi ve diff whitespace kontrolleri geçti. Canlı veri sorgusu veya deploy yapılmadı.


## Son bağımsız inceleme düzeltmeleri
Profil KDV tahmini dönem status ve rekor estimated işaretine taşındı. estimated_cost_vat ve estimated_document_pending ayrı sayılıyor. Sipariş numarası bulunmayan paket anahtarı artık order/package tür ayrımına sahip; gerçek sipariş kimliğiyle birleşmiyor. Ana ajan eski iki complete beklentisini kanıtlanan profil-KDV tahminine göre estimated olarak güncelledi; kapsamdaki tamlık ve belge bekleyen sayısını ayrıca doğruladı. Son toplu doğrulama RELEASE.md dosyasında.
