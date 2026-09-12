-- Aynı dosya partisi sürdürülürken her DENEME ayrı ve DEĞİŞTİRİLEMEZ olarak saklanır.
--
-- Neden: parti sayaçlarını toplamak bir deneme geçmişi değildir. Toplanınca yeniden denemede
-- eski "inceleme" sayısı birikiyor ve dosyanın satır sayısını aşabiliyordu.
--
-- Ayrım:
--   import_batches.counts_json  -> DOSYANIN GÜNCEL satır durumu (son tam değerlendirme)
--   import_attempts.counts_json -> O DENEMEDE yapılan işlemler (append-only geçmiş)
--
-- Denemeler silinemez ve güncellenemez; kim, ne zaman, hangi sonuç ve hata ile denedi izlenir.
CREATE TABLE ec_import_attempts(
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL REFERENCES ec_import_batches(id),
 attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
 actor TEXT NOT NULL DEFAULT '',
 started_at TEXT NOT NULL,
 finished_at TEXT NOT NULL,
 counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
 error TEXT NOT NULL DEFAULT '',
 UNIQUE(batch_id,attempt_no)
);
CREATE INDEX ec_import_attempts_batch ON ec_import_attempts(batch_id,attempt_no);
CREATE TRIGGER ec_import_attempt_no_update BEFORE UPDATE ON ec_import_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_import_attempt_no_delete BEFORE DELETE ON ec_import_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TABLE lp_import_attempts(
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL REFERENCES lp_import_batches(id),
 attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
 actor TEXT NOT NULL DEFAULT '',
 started_at TEXT NOT NULL,
 finished_at TEXT NOT NULL,
 counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
 error TEXT NOT NULL DEFAULT '',
 UNIQUE(batch_id,attempt_no)
);
CREATE INDEX lp_import_attempts_batch ON lp_import_attempts(batch_id,attempt_no);
CREATE TRIGGER lp_import_attempt_no_update BEFORE UPDATE ON lp_import_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_import_attempt_no_delete BEFORE DELETE ON lp_import_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
