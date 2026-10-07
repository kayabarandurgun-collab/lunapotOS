-- KAYIP KARGO İŞARETİ.
--
-- Kargo bir paketi kaybettiğinde pazaryeri bunu iade olarak raporlar. 15 dakikalık bakım turu
-- (otomatik-bakim.js, 'iade' adımı) /returns-apply'ı confirm:true ile kendiliğinden çağırıyor ve o
-- uç HER İADEDE restock:true geçiyordu (report-stock-link-api.js, "Mal geri döndü" notu). Normal
-- iadede bu doğrudur, mal gerçekten rafa döner. Kayıp pakette mal DÖNMEZ: kimse bir şeye basmadan
-- panel stoğa bir adet ekler, raf boş kalır. 06.10.2026'da 392 adet / 11.075 TL temizlenen hayalet
-- stoğun kargo tarafından doğan hâli.
--
-- Pazaryeri raporunda "kayboldu" diye bir alan YOK; "teslim edilemedi" de kayıp demek değildir
-- (mal çoğunlukla satıcıya geri döner, pendingReturns zaten yeniden gönderim kanıtı arıyor). Bunu
-- yalnızca malın peşine düşen kişi bilir, o yüzden işaret ELLE konur ve paket başınadır.
--
-- İşaret konduğunda iade yine yazılır (pazaryeri parayı geri alıyor, gelir dönmeli) ama mal rafa
-- konmaz: maliyet gider olarak kalır. Kargo şirketinin ödeyeceği tazminat ayrı bir kayıttır.
ALTER TABLE ec_order_packages ADD COLUMN goods_lost INTEGER NOT NULL DEFAULT 0 CHECK(goods_lost IN (0,1));

-- Neden kayıp sayıldığı (kargo dosya numarası, görüşme notu). İşaret kaldırılınca boşalır.
ALTER TABLE ec_order_packages ADD COLUMN goods_lost_note TEXT NOT NULL DEFAULT '';
