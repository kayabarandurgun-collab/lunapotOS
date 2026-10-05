-- BİLDİRİM İZİ: aynı haber kanalı doldurmasın.
--
-- NEDEN GEREKTİ: panel sahibine arıza haberi GÖNDERMİYORDU. Otomatik bakımın tek bildirim koşulu
-- `if (ozet.senkronTaslak || ozet.senkronTeslim)` idi; bu iki sayaç YALNIZ pazaryeri senkron
-- döngüsünde artıyor, o döngü de SENKRON_KAYNAKLARI boş olduğu için (API'ler 26.09.2026'da bilerek
-- silindi) hiç çalışmıyor. Yani 15 dakikada bir koşan bakım turu HİÇBİR koşulda mesaj göndermiyordu;
-- hatalar da bilerek kanal dışında bırakılmıştı (otomatik-bakim.js'teki eski yorum bunu yazıyor).
--
-- ESKİ YORUMUN GEREKÇESİ DOĞRUYDU, ÇÖZÜMÜ EKSİKTİ: "aynı hata her turda tekrar ederdi" — doğru,
-- bakım 15 dakikada bir koşuyor, yani tek bir bozuk bağlantı günde 96 mesaj üretir ve kanal
-- okunmaz hâle gelir. Hataları tamamen susturmak yerine SUSTURMA KAYDI tutulur: her arızanın
-- imzası ve son gönderim günü burada durur, aynı imza Türkiye günü başına EN FAZLA BİR KEZ gider.
-- Yeni (daha önce görülmemiş) bir arıza ise beklemeden gider; susturma imza başınadır, kanal
-- başına değil.
--
-- GÜN NEDEN TÜRKİYE GÜNÜ: defterdeki gün de Türkiye günüdür (otomatik-bakim.js'teki gunTR).
-- Sahibi "bugün bir haber aldım mı" sorusunu kendi takviminden sorar, UTC'den değil.
--
-- GÜN NEDEN BOŞ BAŞLAR: gönderim BAŞARISIZ olursa gün TÜKETİLMEMELİ. Telegram ulaşılamazsa ya da
-- token bozuksa mesaj aslında gitmemiştir; günü işaretlemek arızayı o gün boyunca susturur ve
-- tam da kapatmaya çalıştığımız sessizliği geri getirirdi. Boş gün "henüz hiç gönderilmedi"
-- demektir ve sıradaki tur yeniden dener.
--
-- GÖRÜLME SAYACI SUSTURULAN TEKRARLARI DA SAYAR: "bu arıza bir kez mi oldu, 96 kez mi" sorusunun
-- cevabı yalnız burada durur. Mesaj gitmediği turlarda da artar.
--
-- TABLO KÜÇÜK KALIR: otomatik bakım 30 gündür görülmeyen satırları siler (akşam özetinde, günde
-- bir kez; her turda silmek boşuna D1 yazması olurdu).
--
-- GERİYE DÖNÜK UYUMLU: yeni ve boş bir tablodur, hiçbir mevcut sorguya, görünüme veya tetiğe
-- dokunmaz. Uygulandığı anda davranış değişmez; kod tarafı satır yazmaya başlayınca susturma
-- yürürlüğe girer. Bu yüzden README'deki "önce db:remote, sonra deploy" sırası güvenlidir.
CREATE TABLE ec_bildirim_izi(
 anahtar TEXT PRIMARY KEY,              -- hata imzası (değişken kimlik/sayı silinmiş hâli)
 ozet TEXT NOT NULL,                    -- imzanın son görüldüğü ham metin (okunabilirlik için)
 gun TEXT NOT NULL DEFAULT '',          -- son BAŞARILI gönderimin Türkiye günü; '' = hiç gitmedi
 gorulme INTEGER NOT NULL DEFAULT 0,    -- susturulanlar dâhil kaç turda görüldü
 gonderim INTEGER NOT NULL DEFAULT 0,   -- kaç kez gerçekten gönderildi
 son_gorulme_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 son_gonderim_at TEXT,                  -- son gönderim DENEMESİ (başarısız da olsa)
 son_sonuc TEXT                         -- 'ok' | 'basarisiz' | NULL (hiç denenmedi)
);
