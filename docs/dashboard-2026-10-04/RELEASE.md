# Ana ekran v176 — yayın ve doğrulama

4 Ekim 2026. Canlı: https://muhasebe.lunapot.com/eticaret/#overview

## Yayın
- Worker: lunapot-panel
- Sürüm: 04ccbd40-4721-4e80-8c35-6ef03baf5df6 (dashboard-v176)
- Dağıtım: bec00787-a939-4000-863c-2b822fc284e7; 2026-10-04T13:34:22.90542Z; trafik %100.
- SW önbelleği: lunapot-shell-v176-dashboard.
- DB bağı: ae7a9444-838e-4d0f-b547-ce01c23f0328. RELEASE_MAINTENANCE=0. Yüklenen sürümden doğrulandı.
- Bu yayında migration ve tarihsel muhasebe verisi onarımı yok. Yeni hesap özetleri salt okunur.
- Geri dönüş için önceki v175 sürümü: fca96b12-85c1-4cc5-b136-520a5f7ad749. Gerektiğinde bu Worker sürümüne dönmek yeterlidir; bu teslim için şema geri alma gerekmez. Geri dönüş uygulanmadı.

## Tamamlanan kontroller
- Tam Node test paketi: 1290 test, 1261 başarılı, 0 hata, 29 koşullu tarayıcı testi varsayılan çalıştırmada atlandı. final-unit-tests.log.
- Tarayıcı grubu ayrıca etkinleştirildi: 67/67 başarılı, 0 hata, 0 atlanan. final-browser-tests.log. Bu sayı önceki gruba benzersiz test toplamı gibi eklenmemeli.
- Kritik iş akışları bu 67 içinde 21/21: rapor dosyasının gerçek eşleştirme ekranına taşınması, fatura inceleme, sayım ve faturasız giriş önizlemesi, depo sekmeleri, cari dosyası, takvim ve görev ekranı. Tarayıcıdan kayıt/ödeme/rapor uygulama gönderilmedi. Ayrıntı: workflows.md.
- Geniş yerel tarama: 81 rota × 2 genişlik = 162 DOM/ekran kontrolü; 45 HTTP kontrolü; 0 hata, 0 uyarı. Tüm 162 ekran insan tarafından tek tek değerlendirilmedi. Ana ekranın masaüstü/mobil görüntüleri ve analitik ayrıntılar ayrıca görsel incelendi.
- Ana ekran 1440, 390 ve 320 px; grafik seri seçimi, dokunma/klavye, tarih, boş/bilinmeyen veri, yetkisiz tutarlar ve bağımsız hata toparlama kontrol edildi.
- Üretim paketi başarıyla oluşturuldu. final-build.log. Değişikliklerin boşluk kontrolü geçti.

## Canlı doğrulama
- 7 değişen JS/CSS/SW dosyasının SHA256 özeti yerel dosyayla birebir aynı.
- /eticaret/, /uretim/, /access HTTP 200.
- /eticaret/ HTML içeriği yerel kabuğu ve yeni dashboard.css bağlantısını içeriyor. Cloudflare kapanış body etiketinden önce challenge-platform betiği ekliyor; ilk ham HTML hash farkının sebebi bu. Yerel prefix/suffix korunması doğrulandı.
- Oturumsuz /api/ec/panorama ve /api/ec/performance HTTP 401.
- Son dağıtım yeni sürümde %100 olarak doğrulandı.
- Kanıt: live-verified.json, version-verified.json, deployments-after.json, deployment.log.

## Doğrulamanın sınırı
Codex tarayıcı aracının sandbox başlangıcı başarısız olduğundan oturum açık canlı muhasebe ekranı bu turda otomatik gezilemedi. Yerel gerçek Chrome + Worker + SQLite sentetik veriyle çalıştırıldı; canlıda dosyalar, kabuk, dağıtım ve oturumsuz erişim koruması kontrol edildi. Canlı hesap tutarlarının tek tek mutabakatı veya bütün canlı yazma akışlarının çalıştırıldığı iddia edilmez.

## Hesap sınırları
Satılan malın net maliyeti mevcut ortak defter/FIFO sonucundan gelir; tarihsel alış parti KDV'si satışla saklanmadığından KDV dahil değer güncel ürün KDV oranıyla tahmindir. Bu işaret ana kart, ayrıntı ve tüm zamanlar toplamında görünür. Tarihsel kesin brüt maliyet için ayrı satış-parti/KDV izleme gerekir. Bilinmeyen tutar sıfır yapılmaz. Kayıtlı kesinti bankadan ödenmiş nakit diye etiketlenmez. Genel işletme giderleri ve gelir/kurumlar vergisi satış sonucu toplamının dışındadır; mevcut işletme sonucu ekranına bağlantı vardır.

## Kaynak durumu
Yalnız bu teslimin kaynak/test/metin raporları yerel commit'e alınır; önceki kullanıcı değişiklikleri .node-version ve scripts/migrate-remote.mjs korunur. Ekran kanıtları/loglar yerelde kalır. GitHub main push bu teslimde yapılmaz; önceki otomatik onay reddi tekrar denenmez. Canlı yayın Cloudflare sürüm işlemiyle tamamlanmıştır.
