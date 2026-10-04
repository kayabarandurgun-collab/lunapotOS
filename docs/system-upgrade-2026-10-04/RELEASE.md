# Canlı yayın — 4 Ekim 2026

- Canlı adres: https://muhasebe.lunapot.com/eticaret/
- Sürüm: v175 / fca96b12-85c1-4cc5-b136-520a5f7ad749, trafik %100.
- Önceki çalışan sürüm: v174 / 38de9600-4d84-45cf-bdc4-3f80b0a2836b.
- Bakım modu kapalı; yayın doğrulaması: 2026-10-04T00:12:09.115Z.
- Uygulanan geçişler: 0066_party_profiles.sql, 0067_warehouse_workflows.sql, 0068_workbench.sql. Toplam 68 geçiş.
- Kurtarma noktası: 000007d0-00000000-000050fa-eb4fffe4b6a8182b3d1c65e68f37d940; zaman: 2026-10-04T00:09:01.629Z.
- Geçiş sırasında 28 eski stok/satış/cari/nakit toplamı birebir korundu; yabancı anahtar hatası yok; stok sürüm kayıtları tam.
- Yirmi canlı JS/CSS dosyası SHA256 ile test edilen yerel dosyaya eşit. Üretim/e-ticaret/erişim sayfaları 200. Korunan yeni uçlar oturumsuz isteğe 401 dönüyor.
- Gerçek veri üzerinde sahte kayıt, dosya yükleme veya sayım yapılmadı.
- Oturum açık canlı tarayıcı otomasyonu ortamın başlatma hatası nedeniyle kullanılamadı. Oturumlu yazma/okuma akışları gerçek Worker ve SQLite ile yalnız yerel sentetik ortamda doğrulandı; canlı doğrulama varlıklar, yayın durumu, veritabanı geçişi ve oturumsuz erişim sınırlarını kapsar.

## Geri dönüş
Yeni tablolar eklemedir; eski kayıtlar değiştirilmez. Acil kod geri dönüşünde önceki v174 sürümü kullanılabilir ve yeni tablolar yerinde bırakılır. Veritabanı zaman yolculuğu sonraki gerçek işlemleri silebileceği için otomatik uygulanmaz; gerekirse güncel güvenlik noktası ve kullanıcı kapsamı yeniden değerlendirilir.

## Son kanıtlar
- Genel test: 1.229 geçti, 0 hata; 27 koşullu tarayıcı testi varsayılan koşuda kapalı.
- Son bütünleşik tarayıcı grubu: 32/32 geçti, 0 atlanan.
- Yeni yazma akışları: 7/7 geçti, 0 atlanan.
- 81 adres, iki görünüm, 162 ekran taraması: 0 hata/uyarı.
- Derleme ve dolu şema geçişi başarılı.
- Aynı klasörde final-*.log, migration-result.txt, pre/post-migration.json, live-verified.json ayrıntılı yerel kanıttır.
