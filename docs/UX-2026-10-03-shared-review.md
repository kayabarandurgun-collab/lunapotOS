# Ortak arayüz incelemesi — 03.10.2026 19:05

Salt okunur inceleme: C:\Users\baran\Desktop\site\lunapot-panel, main / başlangıç 1597e37 üzerindeki ortak çalışma ağacı. İncelenenler: public/daily-actions.js, workspace-frame.js, workspace-navigation.js, ui-navigation.js, operations-ui.js, panorama-ui.js. Bu turda yalnız bu belge yazıldı; kaynak veya test dosyası değiştirilmedi.

## Doğrulanmış bulgular

### SR01 — P1: stok görüntüleme + cari yazma rolü faturasız girişi kaydedemiyor

- Yeni görev doğru biçimde stock:read + ledger:write ile görünür: public/daily-actions.js:8,16–17. Fakat public/access-ui.js:12,22 yalnız aktif stok rotasının yazma yetkisine bakarak bütün dialog gönderim düğmelerini kapatır.
- Tekrar: ec_access=write; permissions.ec={stock:read, ledger:write, amounts:read}; stok ekranını aç → Yeni işlem → Faturasız mal girişi. Form açılır ve tedarikçi/ürün alanları kullanılabilir, fakat [data-ac-form=unbilled] [type=submit].disabled === true. “Gelen malı kaydet” kullanılamaz.
- Aynı sonuç amounts:none ile de doğrulandı. Dolayısıyla sorun tutar gizleme değil, rota çapındaki ortak kilit. stock:write + ledger:read rolünde görev görünmüyor; bu ters yetki denetimi doğru.
- Öneri: ortak erişim katmanı bu formun yazma yetkisini ledger üzerinden belirlemeli. Bütün stok ekranını yazılabilir yapmak veya genel dialog kilidini kaldırmak doğru olmaz. access-ui.js mevcut engelin kaynağıdır; yeni günlük görevle entegrasyon için ilgili sahip koordine edilmeli. Sunucudaki ledger yazma denetimi korunmalı.

### SR02 — P2: fatura görevi açıldıktan sonra klavye odağı hedefe gitmiyor

- public/workspace-frame.js:21–22 görev seçerek kapanmayı iptal/Escape ile aynı ele alıp her kapanışta başlatıcı düğmeye odak verir. Fatura yükleyicisinin intent açılışı da public/accounting-ui.js:170–183 içinde hedef odak sağlamaz.
- Tekrar (320 px): #invoices → Yeni işlem → Alış faturası yükle. Yükleme alanı görünür; hash tek seferlik action parametresini tüketip #invoices olur. Ancak document.activeElement hâlâ [data-new-task]; bir Tab sonra #commerce-logout (“Çıkış”) odaklanır. Başka rotadan gelindiğinde odak body üzerinde kaldı.
- Etki: klavye/ekran okuyucu kullanan kişi başlattığı dosya yükleme alanına taşınmaz, üst menüden dolaşmak zorunda kalır. Aynı rapor görevi dosya alanına doğru odaklanıyor.
- Öneri: görev seçimiyle kapanış ve iptal kapanışı ayrılmalı; başarılı intent tamamlanınca görünür yükleme düğmesi/başlığı odaklanmalı. Escape/iptal için mevcut başlatıcıya dönüş korunmalı. Fatura sahibiyle odak devri koordine edilmeli.

## Geçen dar kontroller

Yerel http://127.0.0.1:18730 sağlığı synthetic=true, local_preview=true, network=blocked. Kurulu Playwright/Chrome, 320×800. Ağda yalnız bu kökendeki GET/HEAD geçerli; oturum geçişleri için login/logout yanıtları tarayıcıda taklit edildi, sunucuya POST gönderilmedi. Sunucu durdurulmadı. Tam test paketleri tekrar çalıştırılmadı.

- Sahibin dört günlük işi; karma rolün yalnız depo/faturasız işleri; cari yazma izni olmayanda faturasız görevin yokluğu doğrulandı.
- Yeni işlem penceresi x=16..304, clientWidth=scrollWidth=286; sayfa genişliği 320. Üst başlık kontrolleri de görünür ekran sınırları içinde.
- Yeni işlem Escape ile kapanınca başlatıcı doğru odaklanır.
- Rapor yükleme aynı rotada iki kez çalıştı, action tüketildi, görünür/etkin dosya alanı odaklandı. Fatura yükleme kapatılıp aynı rotada yeniden açıldı; tek yükleyici var.
- Çıkıştan sonra yeni işlem düğmesi, alt menü ve dialog sayısı 0. Yönetici → çıkış → yalnız stok okuyan personel girişinde yalnız depo görevi var; eski yönetici görevleri taşınmıyor.
- “faturasiz” araması doğru görevi buluyor.
- Başlangıçta grafik ve ürün/set ayrıntıları kapalı. Grafiği açınca host/SVG genişliği 228 px; sayfa 320 px. Kapalı grafiğin kontrolleri görünür değil. Ürün kazanç/ciro sekmesi çalışıyor.
- operations-ui/panorama-ui farklarında ayrıca gösterilebilir regresyon doğrulanmadı. FA01–04 kaynak farkları içinden özellikle FA02 ham belge/OCR tutar izni kapısı incelendi; bu altı ortak dosyada somut ek entegrasyon kusuru gösterilmedi. Canlı backend veya yeniden başlatılmış finansal düzeltme sunucusu test edildiği iddia edilmiyor; FA05 bu incelemeye dahil edilmedi.

Devam kaydı: goal = ortak görev/navigasyon farklarında kanıtlı regresyon bulmak; now = SR01 ortak erişim katmanı ve SR02 fatura odak devri için sahiplerle düzeltme koordinasyonu. İnceleme tamamlandı; bulgular bu turda düzeltilmedi.
