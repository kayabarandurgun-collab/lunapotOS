-- Rapor Kutusu düzeltmeleri (Codex incelemesi, 12 Eylül 2026).
--
-- 1) Güncellik iki ayrı zamanla izlenir:
--    · data_time  : veriyi EN SON DEĞİŞTİREN raporun anlık görüntü zamanı
--    · source_time: bu kaydı en son DOĞRULAYAN gözlemin zamanı (içerik değişmese de ilerler)
--    Böylece 3 Eylül raporu aynı durumu tekrar gördüğünde, sonradan yüklenen 2 Eylül raporu
--    "eski" sayılır ve güncel durumu geri alamaz.
-- 2) Kimliksiz ikiz anahtarları dosya mühürlenirken bir kez hesaplanır; her aktarım partisinde
--    bütün dosyanın yeniden okunması gerekmez.
ALTER TABLE ec_report_records ADD COLUMN data_time TEXT;
UPDATE ec_report_records SET data_time=source_time WHERE data_time IS NULL;

ALTER TABLE ec_report_files ADD COLUMN twin_keys_json TEXT;

-- Gözlem zamanı ilerletilebilmeli: veri değişmiyorsa sürüm artmadan yalnızca source_time yükselir.
DROP TRIGGER ec_report_record_version_up;
CREATE TRIGGER ec_report_record_version_up BEFORE UPDATE ON ec_report_records WHEN
 NEW.store_id!=OLD.store_id OR NEW.kind!=OLD.kind OR NEW.record_key!=OLD.record_key
 OR (NEW.components_json IS NOT OLD.components_json AND OLD.components_json IS NOT NULL)
 OR (NEW.data_json IS NOT OLD.data_json AND NEW.version<=OLD.version)
 OR (NEW.data_json IS OLD.data_json AND (NEW.version!=OLD.version OR NEW.source_time<OLD.source_time)) BEGIN
 SELECT RAISE(ABORT,'REPORT_RECORD_VERSION');
END;
