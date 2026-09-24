-- HAKEDİŞ–BANKA EŞLEŞTİRME: pazaryerinden gelen paranın deftere girmesi.
--
-- SORUN: Tedarikçiye yapılan ödemeler deftere yazılıyordu, pazaryerinden gelen para hiçbir
-- hesaba girmiyordu. Ana Kasa bu yüzden eksi bakiye gösteriyordu. Hakediş bildirimleri
-- (ec_provider_records, kind='sale' / kind='payments') kaynak kutusudur; tek başına para değildir.
--
-- KARAR: KAYDI DOĞURAN ŞEY BANKA SATIRIDIR. Pazaryerinin bildirdiği tutarla ön kayıt AÇILMAZ.
-- Bir kayıt ancak (1) yüklenmiş bir banka ekstresi satırı ve (2) kullanıcının açık onayı
-- birlikte varken doğar. Böylece "Source inbox only" kuralı (0008_connections.sql) delinmez:
-- provider_records yalnızca ADAY LİSTESİ için okunur.
--
-- HESAP YAPISI: her pazaryeri için AYRI alacak hesabı ("Trendyol Alacağı", "Hepsiburada Alacağı").
--   * kind CHECK'i ('cash','bank') ile sabittir ve aynı liste src/ledger-api.js ile src/bank-api.js
--     içinde tekrar eder. CHECK'i genişletmek tabloyu yeniden kurmayı gerektirirdi; oysa
--     ec_cash_transactions, ec_bank_files ve ec_bank_lines yabancı anahtarla buraya bağlı.
--     Bu yüzden YENİ BİR kind DEĞERİ EKLENMEDİ. Alacak hesabı kind='bank', role='marketplace_clearing'.
--   * role ve provider iki kolondur: role hesabın işini, provider hangi pazaryerine ait olduğunu
--     söyler. Tek kolona ("marketplace_clearing:trendyol") sıkıştırmak pazaryeri başına tekillik
--     denetimini dizinle kurmayı imkânsız kılardı.
--
-- role/provider lp tarafına da eklenir. Banka ekstresi yalnız e-ticarettedir, ama src/ledger-api.js
-- kasa/banka SQL'i çalışma alanından bağımsızdır (scopedDB tablo adını değiştirir, kolon listesini
-- değil): kolon yalnız bir alanda bulunsaydı aynı sorgu öbür alanda patlardı.

ALTER TABLE ec_cash_accounts ADD COLUMN role TEXT;
-- CHECK son eklenen kolona yazılır; role'e bakabilmesi için role'ün önce var olması gerekir.
-- Üç değerli mantık tuzağı: "role='x' AND provider IN (...)" ifadesi provider NULL iken NULL döner
-- ve SQLite NULL'ı ihlal SAYMAZ. Bu yüzden CASE ve açık "IS NOT NULL" ile her dal 0/1 üretir.
ALTER TABLE ec_cash_accounts ADD COLUMN provider TEXT CHECK(CASE
 WHEN role IS NULL THEN provider IS NULL
 WHEN role='marketplace_clearing' THEN provider IS NOT NULL AND provider IN ('trendyol','hepsiburada')
 ELSE 0 END);
ALTER TABLE lp_cash_accounts ADD COLUMN role TEXT;
ALTER TABLE lp_cash_accounts ADD COLUMN provider TEXT CHECK(CASE
 WHEN role IS NULL THEN provider IS NULL
 WHEN role='marketplace_clearing' THEN provider IS NOT NULL AND provider IN ('trendyol','hepsiburada')
 ELSE 0 END);

-- Bir pazaryerinin tek alacak hesabı olur; ikinci hesap parayı iki yere böler.
CREATE UNIQUE INDEX ec_cash_accounts_clearing ON ec_cash_accounts(provider) WHERE role='marketplace_clearing';
CREATE UNIQUE INDEX lp_cash_accounts_clearing ON lp_cash_accounts(provider) WHERE role='marketplace_clearing';

-- Onaylanan eşleştirme. Üç kasa hareketi tek yazma kümesinde doğar:
--   1) alacak hesabına +B   (para pazaryerinden geldi)
--   2) alacak hesabından -B ) virman çifti: para alacak hesabından gerçek bankaya geçti
--   3) ekstrenin bankasına +B)
-- Net etki: gerçek banka +B, alacak hesabı 0. ANA KASA HİÇ ETKİLENMEZ.
-- Alacak hesabının bakiyesi sıfırdan farklıysa açıklanmamış para vardır; ekranda yazar.
CREATE TABLE ec_bank_matches(
 id TEXT PRIMARY KEY,
 bank_line_id TEXT NOT NULL REFERENCES ec_bank_lines(id) ON DELETE RESTRICT,
 provider TEXT NOT NULL CHECK(provider IN ('trendyol','hepsiburada')),
 -- Pazaryerinin ödeme emri kimliği. Kaynak kayıtta yoksa 'kayit:'||external_id kullanılır;
 -- uydurma sıra numarası üretilmez.
 payment_order_id TEXT NOT NULL,
 -- DEFTERE YAZILAN TUTAR HER ZAMAN BANKA SATIRININ TUTARIDIR. Pazaryerinin bildirdiği tutar
 -- yalnızca kanıt olarak saklanır (reported_cents); kuruş farkı defteri bozmaz.
 matched_cents INTEGER NOT NULL CHECK(typeof(matched_cents)='integer' AND matched_cents>0 AND matched_cents<=100000000000),
 reported_cents INTEGER CHECK(reported_cents IS NULL OR typeof(reported_cents)='integer'),
 clearing_account_id TEXT NOT NULL REFERENCES ec_cash_accounts(id) ON DELETE RESTRICT,
 clearing_in_id TEXT NOT NULL UNIQUE REFERENCES ec_cash_transactions(id) ON DELETE RESTRICT,
 transfer_out_id TEXT NOT NULL UNIQUE REFERENCES ec_cash_transactions(id) ON DELETE RESTRICT,
 transfer_in_id TEXT NOT NULL UNIQUE REFERENCES ec_cash_transactions(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','reversed')),
 reason TEXT NOT NULL DEFAULT '',
 reversal_reason TEXT NOT NULL DEFAULT '',
 reversed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ÇİFT SAYIM KORUMASI. Kısmi dizin yalnız yaşayan eşleştirmeyi kapsar: geri alınan kayıt
-- listede kalır ama aynı satır yeniden eşleştirilebilir.
CREATE UNIQUE INDEX ec_bank_match_line ON ec_bank_matches(bank_line_id) WHERE status='confirmed';
CREATE UNIQUE INDEX ec_bank_match_order ON ec_bank_matches(provider,payment_order_id) WHERE status='confirmed';
CREATE INDEX ec_bank_match_durum ON ec_bank_matches(status,created_at);

-- Para bağları değişmez; yalnız geri alma damgası yazılabilir ve yalnız bir kez.
CREATE TRIGGER ec_bank_match_immutable BEFORE UPDATE ON ec_bank_matches
 WHEN NEW.id!=OLD.id OR NEW.bank_line_id!=OLD.bank_line_id OR NEW.provider!=OLD.provider
   OR NEW.payment_order_id!=OLD.payment_order_id OR NEW.matched_cents!=OLD.matched_cents
   OR NEW.reported_cents IS NOT OLD.reported_cents OR NEW.reason!=OLD.reason
   OR NEW.clearing_account_id!=OLD.clearing_account_id OR NEW.clearing_in_id!=OLD.clearing_in_id
   OR NEW.transfer_out_id!=OLD.transfer_out_id OR NEW.transfer_in_id!=OLD.transfer_in_id
   OR NEW.created_at!=OLD.created_at OR OLD.status='reversed' BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_BANK_MATCH');
END;

CREATE TRIGGER ec_bank_match_no_delete BEFORE DELETE ON ec_bank_matches BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_BANK_MATCH');
END;
