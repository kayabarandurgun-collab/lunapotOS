-- YANLIŞ GİRİLEN KAYDIN DÜZELTİLMESİ: genel gider ve e-ticaret ürün kartı arşivi.
--
-- Canlıda kayıt eklenebiliyor ama yanlış girilen düzeltilemiyordu. Bu göç iki kapıyı açar:
-- giderin düzeltilmesi/arşivlenmesi ve kullanılmayan ürün kartının kaldırılması.
--
-- NEDEN SİLME DEĞİL ARŞİV:
--  * Gider yazılmış bir defter satırıdır. Satır silinirse iz kaybolur; ayrıca expenses.reference
--    TEKİLDİR ve sabit gider üretiminin "bu ay yazıldı mı" ölçüsüdür. Satır silinseydi
--    "eksik ayları oluştur" düğmesi arşivlenen ayı sessizce geri getirirdi. Arşivlenen satır
--    mezar taşı gibi yerinde durur: listeden ve kâr hesabından düşer, ikinci kez üretilmez.
--  * Ürün kartı: hiçbir yerde kullanılmayan kart gerçekten silinir (uçta tek tek denetlenir);
--    stok hareketi, satış, fatura satırı, ilan eşleşmesi, sipariş ya da ürün ailesi bağı olan
--    kart silinmez, arşivlenir. Arşiv yalnız DEPOSU BOŞ kartta açılır; böylece arşivlemek
--    gerçek stoğu ekrandan gizleyemez.
--
-- archived_at NULL = etkin kayıt. Kolonlar eklenirken mevcut bütün satırlar etkin kalır.

ALTER TABLE ec_expenses ADD COLUMN archived_at TEXT;
ALTER TABLE lp_expenses ADD COLUMN archived_at TEXT;
CREATE INDEX ec_expenses_live ON ec_expenses(archived_at,occurred_on);
CREATE INDEX lp_expenses_live ON lp_expenses(archived_at,occurred_on);

-- Ürün kartı arşivi şimdilik yalnız e-ticaret ucundan kullanılır; kolon üretim alanının ortak
-- 'products' tablosuna da eklenir ki iki alanı okuyan tek sorgu ayrışmasın.
ALTER TABLE ec_products ADD COLUMN archived_at TEXT;
ALTER TABLE products ADD COLUMN archived_at TEXT;
