-- STOPAJI RAPORLAMAYAN KANAL İÇİN TAHMİN.
-- Ölçüldü (28.09.2026): Hepsiburada teslim edilmiş 205 siparişin 205'inde stopajı bildiriyor,
-- Trendyol'un sipariş raporunda stopaj SÜTUNU YOK ve 548 siparişin hiçbirinde kayıt gelmiyor.
-- Kayıt yokken sıfır saymak o kanalın nakit sonucunu olduğundan yüksek gösteriyordu.
-- Oran pazaryerinin KENDİ verisinden çıkarıldı: stopaj / (KDV hariç satış) 100 bps'te kümeleniyor
-- (ima edilen çarpan 12000 = KDV %20). Dönem doğrulaması: HB'de tahmin 598,73 TL, gerçek 599,87 TL.
-- Boş bırakılan kanal için tahmin yapılmaz: varsayılan davranış değişmez, kimse farkında olmadan
-- kâr rakamı kaymaz. Kanal listesi virgülle ayrılır ('trendyol' ya da 'trendyol,hepsiburada').
ALTER TABLE workspace_settings ADD COLUMN withholding_estimate_channels TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN withholding_estimate_bps INTEGER NOT NULL DEFAULT 100;
