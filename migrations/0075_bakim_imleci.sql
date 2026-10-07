-- BAKIM TURUNUN KALDIĞI YER.
--
-- Ölçüldü (07.10.2026, canlı): kesinti aşaması turun 50 saniyelik bütçesinin 51,2 saniyesini
-- yiyordu. Sebep tahmin edilmedi, önizleme ucu zamanlandı: bir sayfa (50 sipariş) Trendyol'da
-- 8,7 sn, Hepsiburada'da 7,0 sn sürüyor; 771 + 327 siparişin tam taraması ~188 saniye demek.
-- Bütçe 50 saniye, yani tarama HİÇ BİTMİYOR ve her tur imleç sıfırdan başladığı için aynı ilk
-- sayfalar 15 dakikada bir yeniden okunuyordu. İki mağazanın ilk sayfasında yazılacak kesinti
-- sayısı SIFIR: harcanan 51 saniyenin tamamı zaten yazılmış kesintileri yeniden kontrol etmek.
--
-- Çözüm imleci turlar arasında hatırlamak: tur kaldığı yerden sürer, sona varınca başa döner.
-- Böylece tam tarama birkaç tura yayılır ve bütçe her turda baştaki aynı sayfalara gitmez.
-- Defter mantığına DOKUNULMUYOR: hangi kesintinin yazılacağına karar veren kod aynı, yalnız
-- sayfaların okunma SIRASI turlar arasında devam ediyor.
--
-- Tablo yoksa özellik KAPALI sayılır (imleç 0'dan başlar, yani bugünkü davranış). Göç gecikirse
-- bakım turu çalışmaya devam etmeli: 07.10'da yeni tablo okuyan kod göç gelmeden yayına çıktı ve
-- panelin yarısı 500 verdi.
CREATE TABLE ec_bakim_imleci(
 anahtar TEXT PRIMARY KEY,          -- 'kesinti:<magaza_id>' gibi; iş başına ayrı satır
 imlec INTEGER NOT NULL CHECK(imlec >= 0),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
