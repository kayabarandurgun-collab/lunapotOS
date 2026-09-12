-- Gerçek kayıtların denetlenebilir, tekrarlanabilir aktarımı + stok başlangıcı.
--
--  1) Her aktarım partisi kaynak dosyanın özetiyle kaydedilir. Aynı dosya ikinci kez uygulanamaz.
--  2) Her kaynak kayıt (fatura kimliği, paket kimliği...) BİR kez uygulanır: kimlik tekildir.
--     Böylece örtüşen/yinelenen yükleme ikinci satış, ikinci borç veya ikinci stok hareketi yaratmaz.
--  3) Stok başlangıç tarihi bilinmeden geçmiş sipariş bugünkü stoktan düşülmez. Tarih yoksa NULL kalır;
--     uydurulmaz.
ALTER TABLE workspace_settings ADD COLUMN inventory_start_date TEXT;

CREATE TABLE ec_import_batches(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('purchase_invoices','report_stock_link')),
 source_name TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 item_count INTEGER NOT NULL CHECK(item_count>=0),
 counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
 status TEXT NOT NULL DEFAULT 'applying' CHECK(status IN ('applying','applied')),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind,sha256)
);
CREATE TRIGGER ec_import_batch_no_delete BEFORE DELETE ON ec_import_batches BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_import_batch_frozen BEFORE UPDATE ON ec_import_batches WHEN
 NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.sha256!=OLD.sha256 OR NEW.item_count!=OLD.item_count BEGIN
 SELECT RAISE(ABORT,'IMPORT_BATCH_IMMUTABLE');
END;

-- Kaynak kimliği evrensel tekildir: aynı fatura başka bir partide yeniden uygulanamaz.
CREATE TABLE ec_import_items(
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL REFERENCES ec_import_batches(id),
 kind TEXT NOT NULL,
 source_key TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('created','skipped','review','failed')),
 target_kind TEXT NOT NULL DEFAULT '',
 target_id TEXT NOT NULL DEFAULT '',
 detail TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind,source_key)
);
CREATE INDEX ec_import_items_batch ON ec_import_items(batch_id);
CREATE TRIGGER ec_import_item_no_delete BEFORE DELETE ON ec_import_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_import_item_no_update BEFORE UPDATE ON ec_import_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TABLE lp_import_batches(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('purchase_invoices','report_stock_link')),
 source_name TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 item_count INTEGER NOT NULL CHECK(item_count>=0),
 counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
 status TEXT NOT NULL DEFAULT 'applying' CHECK(status IN ('applying','applied')),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind,sha256)
);
CREATE TRIGGER lp_import_batch_no_delete BEFORE DELETE ON lp_import_batches BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_import_batch_frozen BEFORE UPDATE ON lp_import_batches WHEN
 NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.sha256!=OLD.sha256 OR NEW.item_count!=OLD.item_count BEGIN
 SELECT RAISE(ABORT,'IMPORT_BATCH_IMMUTABLE');
END;
CREATE TABLE lp_import_items(
 id TEXT PRIMARY KEY,
 batch_id TEXT NOT NULL REFERENCES lp_import_batches(id),
 kind TEXT NOT NULL,
 source_key TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('created','skipped','review','failed')),
 target_kind TEXT NOT NULL DEFAULT '',
 target_id TEXT NOT NULL DEFAULT '',
 detail TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind,source_key)
);
CREATE INDEX lp_import_items_batch ON lp_import_items(batch_id);
CREATE TRIGGER lp_import_item_no_delete BEFORE DELETE ON lp_import_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_import_item_no_update BEFORE UPDATE ON lp_import_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
