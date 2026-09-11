-- Rapor Kutusu: pazaryeri Excel raporlarının güvenli aktarımı. YALNIZCA e-ticaret (ec).
--
-- Bu katman stok, sevkiyat, satış kaydı veya fatura OLUŞTURMAZ. Tarihî aktarım raporlama içindir;
-- ERP'de zaten bulunan siparişe yalnızca bağlantı kurulur. Dosyanın kendisi ve her kaynak satırı
-- değiştirilemez biçimde saklanır. Kayıtlar sürümlüdür; eski rapor güncel bilgiyi geri alamaz.

CREATE TABLE ec_report_stores(
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK(provider IN ('trendyol','hepsiburada')),
 code TEXT NOT NULL,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(provider,code)
);

-- Kullanıcının onayladığı sütun eşleştirmesi. Aynı başlık imzalı dosyada tekrar sorulmaz.
-- sample_verified=0: gerçek örnekle karşılaştırılıp doğrulanmadı.
CREATE TABLE ec_report_profiles(
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK(provider IN ('trendyol','hepsiburada')),
 kind TEXT NOT NULL CHECK(kind IN ('orders','finance')),
 signature TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 mapping_json TEXT NOT NULL,
 options_json TEXT NOT NULL DEFAULT '{}',
 sample_verified INTEGER NOT NULL DEFAULT 0 CHECK(sample_verified IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(provider,kind,signature,version)
);
CREATE UNIQUE INDEX ec_report_profile_active ON ec_report_profiles(provider,kind,signature) WHERE active=1;

CREATE TABLE ec_report_files(
 id TEXT PRIMARY KEY,
 store_id TEXT NOT NULL REFERENCES ec_report_stores(id),
 kind TEXT NOT NULL CHECK(kind IN ('orders','finance')),
 filename TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 snapshot_at TEXT NOT NULL,
 sheet TEXT NOT NULL DEFAULT '',
 headers_json TEXT NOT NULL,
 date1904 INTEGER NOT NULL DEFAULT 0 CHECK(date1904 IN (0,1)),
 row_count INTEGER NOT NULL CHECK(row_count>=0),
 chunk_count INTEGER NOT NULL CHECK(chunk_count>0),
 profile_id TEXT REFERENCES ec_report_profiles(id),
 status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','received','applying','applied')),
 applied_row INTEGER NOT NULL DEFAULT 0,
 counts_json TEXT NOT NULL DEFAULT '{}',
 warnings_json TEXT NOT NULL DEFAULT '[]',
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- Aynı mağazaya aynı dosya ikinci kez yüklenemez.
 UNIQUE(store_id,sha256)
);
CREATE INDEX ec_report_files_store ON ec_report_files(store_id,created_at);
CREATE TRIGGER ec_report_file_no_delete BEFORE DELETE ON ec_report_files BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_file_frozen BEFORE UPDATE ON ec_report_files WHEN NEW.sha256!=OLD.sha256 OR NEW.store_id!=OLD.store_id OR NEW.kind!=OLD.kind
  OR NEW.headers_json!=OLD.headers_json OR NEW.row_count!=OLD.row_count OR NEW.snapshot_at!=OLD.snapshot_at OR NEW.applied_row<OLD.applied_row BEGIN
 SELECT RAISE(ABORT,'REPORT_FILE_IMMUTABLE');
END;

-- Ham dosya (denetim için) ve kaynak satırlar. Yalnızca dosya alınırken yazılır; sonra değişmez.
CREATE TABLE ec_report_file_chunks(file_id TEXT NOT NULL REFERENCES ec_report_files(id), idx INTEGER NOT NULL CHECK(idx>=0), data_b64 TEXT NOT NULL, PRIMARY KEY(file_id,idx));
CREATE TABLE ec_report_rows(file_id TEXT NOT NULL REFERENCES ec_report_files(id), row_no INTEGER NOT NULL, cells_json TEXT NOT NULL, PRIMARY KEY(file_id,row_no));
CREATE TRIGGER ec_report_chunk_receiving BEFORE INSERT ON ec_report_file_chunks WHEN (SELECT status FROM ec_report_files WHERE id=NEW.file_id) IS NOT 'receiving' BEGIN SELECT RAISE(ABORT,'REPORT_FILE_SEALED'); END;
CREATE TRIGGER ec_report_row_receiving BEFORE INSERT ON ec_report_rows WHEN (SELECT status FROM ec_report_files WHERE id=NEW.file_id) IS NOT 'receiving' BEGIN SELECT RAISE(ABORT,'REPORT_FILE_SEALED'); END;
CREATE TRIGGER ec_report_chunk_no_update BEFORE UPDATE ON ec_report_file_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_chunk_no_delete BEFORE DELETE ON ec_report_file_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_row_no_update BEFORE UPDATE ON ec_report_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_row_no_delete BEFORE DELETE ON ec_report_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Güncel kayıt: işletme(ec) + pazaryeri + mağaza + tür + sağlayıcı kimliği tekildir.
CREATE TABLE ec_report_records(
 id TEXT PRIMARY KEY,
 store_id TEXT NOT NULL REFERENCES ec_report_stores(id),
 kind TEXT NOT NULL CHECK(kind IN ('order_line','finance_event')),
 record_key TEXT NOT NULL,
 key_source TEXT NOT NULL CHECK(key_source IN ('provider','composite')),
 data_json TEXT NOT NULL,
 source_time TEXT,
 file_id TEXT NOT NULL REFERENCES ec_report_files(id),
 row_no INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 -- ERP'de zaten var olan pazaryeri paketine bağlantı (oluşturma yok).
 erp_package_id TEXT REFERENCES ec_order_packages(id),
 -- Set içeriğinin ilk aktarımdaki anlık görüntüsü: set tanımı sonradan değişse de eski sipariş değişmez.
 components_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(store_id,kind,record_key)
);
CREATE INDEX ec_report_records_order ON ec_report_records(store_id,kind,json_extract(data_json,'$.order_no'));
CREATE INDEX ec_report_records_package ON ec_report_records(store_id,kind,json_extract(data_json,'$.package_id'));
CREATE TRIGGER ec_report_record_no_delete BEFORE DELETE ON ec_report_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_record_version_up BEFORE UPDATE ON ec_report_records WHEN NEW.version<=OLD.version OR NEW.store_id!=OLD.store_id OR NEW.kind!=OLD.kind OR NEW.record_key!=OLD.record_key
  OR NEW.components_json IS NOT OLD.components_json AND OLD.components_json IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'REPORT_RECORD_VERSION');
END;

CREATE TABLE ec_report_record_versions(
 id TEXT PRIMARY KEY,
 record_id TEXT NOT NULL REFERENCES ec_report_records(id),
 version INTEGER NOT NULL,
 file_id TEXT NOT NULL REFERENCES ec_report_files(id),
 row_no INTEGER NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('new','updated','accepted')),
 data_json TEXT NOT NULL,
 source_time TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(record_id,version)
);
CREATE TRIGGER ec_report_version_no_update BEFORE UPDATE ON ec_report_record_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_report_version_no_delete BEFORE DELETE ON ec_report_record_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Her satırın bu dosyadaki sonucu (yeni/aynı/eski/güncel/inceleme). Kaldığı yerden devamda tekrar yazılmaz.
CREATE TABLE ec_report_outcomes(file_id TEXT NOT NULL REFERENCES ec_report_files(id), row_no INTEGER NOT NULL, record_key TEXT NOT NULL, outcome TEXT NOT NULL,
 PRIMARY KEY(file_id,row_no,record_key));
-- Parti kilidi: aynı dosyanın aynı parçası iki kez işlenemez (iki sekme, yeniden deneme).
CREATE TABLE ec_report_apply_steps(file_id TEXT NOT NULL REFERENCES ec_report_files(id), from_row INTEGER NOT NULL, to_row INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(file_id,from_row));

CREATE TABLE ec_report_reviews(
 id TEXT PRIMARY KEY,
 store_id TEXT NOT NULL REFERENCES ec_report_stores(id),
 file_id TEXT NOT NULL REFERENCES ec_report_files(id),
 row_no INTEGER NOT NULL,
 kind TEXT NOT NULL,
 record_key TEXT NOT NULL,
 reason TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '',
 incoming_json TEXT NOT NULL,
 prior_json TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected')),
 resolved_by TEXT,
 resolved_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(file_id,row_no,record_key)
);
CREATE INDEX ec_report_reviews_open ON ec_report_reviews(status,created_at);
CREATE TRIGGER ec_report_review_once BEFORE UPDATE ON ec_report_reviews WHEN OLD.status!='open' BEGIN SELECT RAISE(ABORT,'REVIEW_RESOLVED'); END;

-- Kargo/komisyon faturası: rapordaki gidere KANIT olarak bağlanır; ikinci gider oluşturmaz.
CREATE TABLE ec_report_fee_evidence(
 id TEXT PRIMARY KEY,
 record_id TEXT NOT NULL UNIQUE REFERENCES ec_report_records(id),
 invoice_line_id TEXT NOT NULL REFERENCES ec_purchase_lines(id),
 amount_cents INTEGER NOT NULL,
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ec_report_fee_evidence_line ON ec_report_fee_evidence(invoice_line_id);
CREATE TRIGGER ec_report_fee_evidence_no_update BEFORE UPDATE ON ec_report_fee_evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Aynı fatura satırı hem rapordaki gidere kanıt hem kesinti eşleştirmesinde satışa gider olamaz.
CREATE TRIGGER ec_report_evidence_not_allocated BEFORE INSERT ON ec_report_fee_evidence
 WHEN EXISTS(SELECT 1 FROM ec_fee_allocations WHERE invoice_line_id=NEW.invoice_line_id AND reversed_at IS NULL) BEGIN
 SELECT RAISE(ABORT,'FEE_ALREADY_ALLOCATED');
END;
CREATE TRIGGER ec_fee_allocation_not_report_evidence BEFORE INSERT ON ec_fee_allocations
 WHEN EXISTS(SELECT 1 FROM ec_report_fee_evidence WHERE invoice_line_id=NEW.invoice_line_id) BEGIN
 SELECT RAISE(ABORT,'FEE_ALREADY_IN_REPORT');
END;
