-- ELLE BELİRLENMİŞ SATIŞ MALİYETİ.
--
-- FIFO satışın maliyetine sahiptir: stok geçmişinden hesaplar ve her hesapta üstüne yazar
-- (fifo-cost.js:309-311 mevcut düzeltmeleri okuyup hedefine uymayanı geri alır). Bu doğru
-- kuraldır; geçmiş sağlamken kimse maliyeti elle oynatmasın diye böyle kurulmuş.
--
-- AMA GEÇMİŞ BOZUKSA ÇIKIŞ YOLU YOKTU. Canlıda iki satış hiçbir faturaya uymayan maliyet taşıyor:
--   · TY 11650792573 · Klasmann TS1 · 1.958,60 — en pahalı alış 1.400
--   · HB 4583700954  · SAB Substrate · 1.250   — 80 L'nin alışı 450; 250 L'lik çuval aynı karta
--     bağlanmış, FIFO onu 80 L satışına maliyet yazmış
-- Sebep ikisinde de kaynakta: TS1'de 23.09'da elle yazılan düzeltme geçici sayımın 15 adedini
-- sildi ama değerinin 7.000,04 TL'sini silmedi; depoda mal yok, para var kaldı ve FIFO o parayı
-- sonraki satışlara dağıttı. Kaynağı düzeltmenin yolu da kapalı: fatura `posted` ve değiştirilemez
-- (0002:46 IMMUTABLE_INVOICE), alış fiyatı düzeltmesi yalnız RAFTA KALAN mal kadar pay alabiliyor
-- (ADJUSTMENT_STOCK_VALUE) ve iki üründe de o mal çoktan satılmış.
--
-- Bu tablo FIFO'ya "bu satışın maliyeti elle belirlendi, bir daha hesaplama" der. Kilitli satış
-- fifoHesap'ta `tutarli` olmayan satışla AYNI kapıdan atlanır: yazılmaz, yalnız atlananlara girer.
--
-- STOK DEĞERİNE DOKUNULMAZ. Maliyet düzeltmesi ec_cost_revaluations üzerinden geçseydi tetik
-- (0048:25) bakiyeyi de oynatırdı ve rafta mal olmadan para doğardı — yani bugün temizlediğimiz
-- hayaletin aynısı. Bakiye zaten doğru; düzeltilen tek şey satışa yazılmış maliyettir.
--
-- Eski değer ve gerekçe saklanır: kim neyi neden değiştirdi, ekrandan görülebilsin.
CREATE TABLE ec_sale_cost_locks(
 sale_id TEXT PRIMARY KEY REFERENCES ec_sale_entries(id),
 previous_cost_cents INTEGER NOT NULL,
 cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Kayıt silinmez, değiştirilmez: maliyeti elle değiştirmek defter işidir, izi kalmalı.
CREATE TRIGGER ec_sale_cost_lock_no_delete BEFORE DELETE ON ec_sale_cost_locks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
