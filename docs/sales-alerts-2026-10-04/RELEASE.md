# Akıllı takip v177 — yayın ve doğrulama

4 Ekim 2026. Canlı: https://muhasebe.lunapot.com/eticaret/#overview

## Yayın

- Worker sürümü: 77068919-6bf3-4c81-8078-e64fb3acc50d; etiket insights-v177.
- Dağıtım: 4a0d9aaf-c501-4e4c-b0db-00b30fd411ad; trafik %100.
- SW: lunapot-shell-v177-insights.
- DB bağı ae7a9444-838e-4d0f-b547-ce01c23f0328 ve RELEASE_MAINTENANCE=0, sürümün gerçek bağlarından doğrulandı. Wrangler özetindeki sıfırlı ID yerel preview ID'dir.
- Migration, veri onarımı veya sentetik canlı veri yok. Yeni uyarılar salt okunur.
- Geri dönüş sürümü v176: 04ccbd40-4721-4e80-8c35-6ef03baf5df6. Şema geri alma gerekmez. Geri dönüş uygulanmadı.

## Doğrulama

- Nihai özellik grubu: **109/109 başarılı**, hata/atlama yok; final-feature-tests.log. Bağımsız 30 vaka bu grubun içindedir; sayılar benzersiz toplam gibi eklenmemeli.
- Nihai etkin tarayıcı grubu: **73/73 başarılı**, hata/atlama yok; final-browser-tests.log. Gerçek yerel Chrome + Worker + SQLite. 1440/390/320 px, uyarı filtreleri, doğru HB/set fiyat bağlantısı, sipariş penceresi, tedarik ürün filtresi, tarih kapsamı, iki kaynağın ayrı hata/yeniden denemesi; mevcut dashboard/grafik/günlük iş ve personel akışları.
- Tam npm test: **1396 test; 1364 başarılı, 2 hata, 30 koşullu tarayıcı testi atlandı**. Paket tamamen yeşil diye sunulmamalı. final-unit-tests.log.
- Kalan iki hata yeni uyarılardan bağımsız eski mağaza önizleme araçlarında: seed-local-catalog örnek ürün bulamıyor; store-sync nova-copper-object.webp bekliyor. Kardeş lunapot-store-preview projesinin shop.js dosyası artık ürünleri LunapotCatalog üzerinden alıyor; eski araçlar hâlâ satır içi ürün formatını bekliyor. Aynı HEAD test/betikleri aynı dış kaynakla ayrı scratch dizininde çalıştırılarak **aynı iki hata** yeniden üretildi; dört dosya HEAD ile değişmemiş. baseline-external-tests.json/log. Bu teslim bu araçları veya dış tasarım deposunu değiştirmedi. /magaza canlı kapısı da değiştirilmedi.
- İlk geniş testin bulduğu arşivli ürün dosyası gerilemesi düzeltildi: ürün dosyası açık null alanlarla kalır, arşivli ürün alım önerilerine dönmez. Mevcut regresyon geçti.
- İlk tarayıcı grubundaki iki alanın aynı retry anahtarını paylaşması giderildi. Satış uyarısı ve dönem özeti ayrı düğmelerle aynı kaynağı güvenle yeniler; yeni toparlama testi geçti.
- Üretim paketi ve git diff --check başarılı. final-build.log.
- Mobil/masaüstü uyarı görüntüleri ayrıca görsel incelendi. screens/.

## Canlı kontroller

Altı değişen JS/CSS/SW dosyasının SHA256 özeti yerel dosyayla birebir aynı. /eticaret/ ve /access 200; oturumsuz /api/ec/panorama ve /api/ec/warehouse 401. Trafiğin yeni sürümde %100 olduğu tekrar okundu. Kanıt: version-verified.json, live-verified.json, source-snapshot.json, version-upload.log, deployment.log.

Oturum açık canlı ekran tarayıcı aracıyla açılamadı: CUA başlangıcı Windows sandbox deny-read ACL hatası verdi. Bu nedenle canlı hesap içindeki uyarı adetleri/tutarları ve üretim gecikmesi gözlemlendi diye iddia edilmiyor. Çerez veya şifre çıkarma yoluna gidilmedi. Hesap davranışı yerel gerçek uygulama üzerinde, canlı yayın ise dosya/sürüm/erişim seviyesinde doğrulandı.

## Kaynak ve devir

İlgili kaynak, test ve metin raporları yerel commit ile kaydedilir; commit kimliği local-commit.json dosyasındadır. Kullanıcının .node-version ve scripts/migrate-remote.mjs değişiklikleri korunur. GitHub main'e push yapılmadı; önceki otomatik onay reddi tekrar denenmedi. Canlı yayın Cloudflare sürümüyle tamamlandı.

Tek dosya devir: docs/CLAUDE-DEVIR-2026-10-04-AKILLI-UYARILAR.txt. Ayrıntılar: IMPLEMENTATION.md, backend.md, stock.md, review.md. İnceleme raporu önceki başarısız bulguları tarihçe olarak korur; başındaki nihai doğrulama geçerlidir.
