-- YANLIŞ GİRİLEN CARİ ve KASA/BANKA HESABI: düzeltme ve arşiv.
--
-- Canlıda cari ve hesap yalnızca EKLENEBİLİYORDU. Yanlış yazılan cari adı, VKN, telefon ya da
-- adres düzeltilemiyor; boşuna açılan "Vadeli Kasa" listeden kaldırılamıyordu. Bu göç iki kartın
-- arşiv kapısını açar.
--
-- NEDEN SİLME DEĞİL ARŞİV:
--  * Cari, defterdeki her hareketin sahibidir. Hareketi, faturası, mutabakat belgesi ya da
--    teklifi olan cari silinirse geçmişin sahibi kaybolur. Bu yüzden uçta bağlantılar tek tek
--    sorulur: hiçbir yerde kullanılmayan kart gerçekten silinir, kullanılan kart arşivlenir.
--  * Kasa/banka hesabı aynı sebeple: hareketi olan hesap silinemez. Arşivlenen hesap geçmiş
--    kasa hareketlerinde ve bakiyede yerinde durur, yalnız yeni ödeme/tahsilat seçiminden düşer.
--
-- ARŞİV GEÇMİŞİ GİZLEMEZ: kayıt yerinde kalır, ad ve VKN geçmiş satırlarda okunmaya devam eder.
-- Kaydedilmiş mutabakat belgesi zaten kendi anlık görüntüsünü taşır (0023); arşiv onu değiştirmez.
--
-- archived_at NULL = etkin kayıt. Kolonlar eklenirken mevcut bütün satırlar etkin kalır.

ALTER TABLE ec_suppliers ADD COLUMN archived_at TEXT;
ALTER TABLE lp_suppliers ADD COLUMN archived_at TEXT;
ALTER TABLE ec_cash_accounts ADD COLUMN archived_at TEXT;
ALTER TABLE lp_cash_accounts ADD COLUMN archived_at TEXT;

-- Seçim listeleri "etkin olanlar, ada göre" sırasıyla okunur.
CREATE INDEX ec_suppliers_live ON ec_suppliers(archived_at,name);
CREATE INDEX lp_suppliers_live ON lp_suppliers(archived_at,name);
CREATE INDEX ec_cash_accounts_live ON ec_cash_accounts(archived_at,name);
CREATE INDEX lp_cash_accounts_live ON lp_cash_accounts(archived_at,name);
