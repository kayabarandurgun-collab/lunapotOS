# Akıllı takip — uygulama notları

Bu çalışma v176 ana ekranının üzerine, kullanıcının tekrarlayan zarar/iade/teslimat ve azalan stok taleplerini uygular. Gerçek çalışma deposu C:/Users/baran/Desktop/site/lunapot-panel. Documents altındaki eski kopya kullanılmadı.

## Kullanıcıya görünen davranış

Ana ekranda Bugün neye dikkat etmelisin? bölümü; Tümü, Fiyat, İade, Teslimat, Stok filtreleri, kanıt siparişleri ve ilgili işleme doğrudan bağlantılar bulunur. Sonuçlar seçilmiş tarih aralığından bağımsız güncel kontrolü gösterir. İlk dört uyarı açık, kalanı genişletilebilir. Masaüstünde iki, telefonda tek sütun kullanılır.

Fiyat sinyali aynı pazaryerinde aynı tarihsel satılan ürün/set bileşimine aittir. Son 30 gün içindeki son beş iadesiz siparişin en az üçü zararlı, en yenisi zararlı ve örneklemin toplamı eksiyse uyarır. Bir kuruş da zarar sayılır. Bir siparişin paketleri birleştirilir; aynı gün içindeki sıralama sonucu belirsizleştiriyorsa fiyat tavsiyesi bekler. İade ve teslim edilememe ayrı değerlendirilir. Stoktaki bileşenlerden biri tek başına set zararı sayılmaz.

Stok sinyali fiziksel ürün tüketimini, son yedi/önceki yedi/otuz günlük hareketleri ve satılabilir stoğu gösterir. Uygun geçmiş varsa son yedi ve otuz gün hızlarından yükseği seçilir; tek günlük toplu satış yeni düzenli hız sayılmaz. Depoya dönmeyen iade tüketimi azaltmaz. Kargodakiler ikinci kez düşülmez. Bilinen tedarikçi, tedarik süresi, hedef gün ve alım ambalajına göre alım önerisi hesaplanır. Ana ekran ile tedarik planı aynı hesap ve eksiklik kurallarını kullanır. Aynı fiziksel ürünü kullanan satışlarda zarar uyarısı da varsa birlikte fiyat kontrolü önerilir.

Örnek sentetik doğrulama: günde bir/haftada yedi adet tüketim, beş adet satılabilir stok => yaklaşık beş gün. Tedarik üç gün, hedef pay yedi gün ise beş adet alım önerisi. HB satış başına 12 kuruş zarar => son beş siparişte 60 kuruş zarar uyarısı. Bunlar test verisidir; canlı işletme verisi olarak sunulmaz.

## Doğruluk ve erişim

- Satış sonuçları mevcut performanceReport/sales_items hesabından gelir; ikinci bir kâr formülü eklenmedi.
- Maliyet veya kesinti belirsizse fiyat önerisi verilmez. Alış KDV/stopaj varsayımı varsa tahmini etiketlenir.
- Tutar görme izni olmayan personelde sales_alerts tamamen null olur; zarar adı ve sayısından da bilgi çıkarılamaz.
- Tedarikçi yalnız ürün kartındaki etkin cari bağlantısından alınır. Marka adına bakılarak cari uydurulmaz.
- Eksik/çelişkili hareketler gün ve alım miktarı önerisini durdurur. Uyarı olmaması bütün kayıtların doğru/kârlı olduğu anlamına gelmez.
- Hiçbir fiyat, stok, sipariş veya cari kaydı bu uyarılarla otomatik değiştirilmez. Yeni zamanlanmış görev veya dış bildirim eklenmedi; ekran açıldığında ve Şimdi kontrol et ile hesaplanır.
- Şema geçişi yok. Önizleme senaryosu yalnız yerel Worker/SQLite test ortamında çalışır. Canlıya sentetik veri gönderilmez.

## Sınırlar

Kaydedilmemiş satış ve alışları bilemez. Açık alışların doğrulanmış geliş tarihleri olmadığı için alım önerisinden düşülmez; alım öncesi kontrol notu vardır. Müşteri iadeleri mevcut paket sonuç tarihi sözleşmesiyle gruplandırılır; bağımsız iade-olay tarihi raporu değildir. Tarihsel alış KDV bilgisi eksik olduğunda mevcut sistem tahmini ayrıca gösterir. Stok sorgusunun indeks kullanımı yerelde doğrulandı; canlıda giriş yapılmış kullanıcıyla gecikme ölçümü yapılmadı.

## Dosyalar

Backend: src/sales-alerts.js, src/stock-alerts.js, src/panorama-api.js, src/performance-api.js (yalnız iade tarihi metadata), src/warehouse-api.js, src/permission-policy.js, src/product-profile-api.js (arşivli ürün dosyasında açık bilinmeyen değerler).
UI: public/insight-alerts-ui.js, public/operations-ui.js, public/dashboard.css, public/fiyat-hesap-ui.js, public/warehouse-ui.js, public/sw.js.
Yerel önizleme: scripts/design-preview.mjs ve tests/helpers/insights-preview.js.
Testler: sales-alerts, stock-alerts, insight-alerts-ui, insight-alerts-browser, insight-alerts-review.

Nihai test/yayın sonuçları RELEASE.md dosyasındadır. Ayrıntılı motor sözleşmeleri backend.md ve stock.md; bağımsız inceleme review.md.
