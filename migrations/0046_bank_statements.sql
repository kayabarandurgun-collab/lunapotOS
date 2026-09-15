-- Banka ekstresi aktarımı.
--
-- Mevcut Rapor Kutusu tabloları DEĞİŞTİRİLMEDİ: onların kind/provider CHECK kısıtlarını
-- genişletmek üç tabloyu yeniden kurmayı gerektirirdi ve içlerinde binlerce kayıt ile
-- koruma tetikleri var. Banka ayrı bir alan olduğu için tablolar EKLENEREK çözülür.
--
-- Bu aktarım tek başına mali kayıt OLUŞTURMAZ. Ekstre satırları önce olduğu gibi saklanır;
-- hangi hakedişe veya ödemeye denk geldiği ayrıca eşleştirilir. Böylece yanlış eşleşme
-- defteri bozmaz, ham ekstre her zaman elde kalır.

CREATE TABLE ec_bank_files(
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES ec_cash_accounts(id) ON DELETE RESTRICT,
 filename TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
 row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count>=0),
 period_from TEXT,
 period_to TEXT,
 status TEXT NOT NULL DEFAULT 'loading' CHECK(status IN ('loading','applied')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- Aynı hesaba aynı dosya ikinci kez yüklenemez.
 UNIQUE(account_id,sha256)
);

CREATE TABLE ec_bank_lines(
 id TEXT PRIMARY KEY,
 file_id TEXT NOT NULL REFERENCES ec_bank_files(id) ON DELETE RESTRICT,
 account_id TEXT NOT NULL REFERENCES ec_cash_accounts(id) ON DELETE RESTRICT,
 occurred_on TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0),
 balance_cents INTEGER,
 description TEXT NOT NULL DEFAULT '',
 reference TEXT NOT NULL DEFAULT '',
 counterparty TEXT NOT NULL DEFAULT '',
 -- Aynı hareketin iki dosyada tekrar gelmesi ikinci kez yazılmaz. Anahtar bankanın verdiği
 -- dekont numarası varsa ondan, yoksa tarih+tutar+açıklama+bakiyeden kurulur.
 record_key TEXT NOT NULL,
 -- Hangi pazaryeri hakedişine / ödemeye denk geldiği. Boş kalabilir; uydurulmaz.
 matched_party_id TEXT REFERENCES ec_suppliers(id),
 matched_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(account_id,record_key)
);

CREATE INDEX ec_bank_lines_tarih ON ec_bank_lines(account_id,occurred_on);
CREATE INDEX ec_bank_lines_dosya ON ec_bank_lines(file_id);

-- Ekstre satırı ham kayıttır: tutarı, tarihi ve kimliği sonradan değiştirilemez.
-- Yalnızca eşleştirme alanları güncellenebilir.
CREATE TRIGGER ec_bank_line_immutable BEFORE UPDATE ON ec_bank_lines
 WHEN NEW.occurred_on!=OLD.occurred_on OR NEW.amount_cents!=OLD.amount_cents
   OR NEW.record_key!=OLD.record_key OR NEW.account_id!=OLD.account_id
   OR NEW.file_id!=OLD.file_id OR NEW.id!=OLD.id BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_BANK_LINE');
END;

CREATE TRIGGER ec_bank_line_no_delete BEFORE DELETE ON ec_bank_lines BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_BANK_LINE');
END;

-- Mühürlenmiş dosyanın özeti ve kapsamı değişmez.
CREATE TRIGGER ec_bank_file_sealed BEFORE UPDATE ON ec_bank_files
 WHEN OLD.status='applied' AND (NEW.sha256!=OLD.sha256 OR NEW.account_id!=OLD.account_id
   OR NEW.row_count!=OLD.row_count OR NEW.status!='applied') BEGIN
 SELECT RAISE(ABORT,'BANK_FILE_SEALED');
END;

CREATE TRIGGER ec_bank_file_no_delete BEFORE DELETE ON ec_bank_files
 WHEN OLD.status='applied' BEGIN
 SELECT RAISE(ABORT,'BANK_FILE_SEALED');
END;
