-- Cari dossiers extend the existing supplier identity; no supplier or ledger rows are created.
-- Both namespaces, only additive objects. Trigger bodies intentionally have no CASE/END.
CREATE TABLE ec_party_profiles(
 party_id TEXT PRIMARY KEY REFERENCES ec_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 legal_name TEXT NOT NULL DEFAULT '',trade_name TEXT NOT NULL DEFAULT '',tax_office TEXT NOT NULL DEFAULT '',
 contacts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(contacts_json) AND json_type(contacts_json)='array'),
 addresses_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(addresses_json) AND json_type(addresses_json)='array'),
 banks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(banks_json) AND json_type(banks_json)='array'),
 tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
 payment_terms_days INTEGER CHECK(payment_terms_days IS NULL OR (typeof(payment_terms_days)='integer' AND payment_terms_days BETWEEN 0 AND 3650)),
 discount_bps INTEGER CHECK(discount_bps IS NULL OR (typeof(discount_bps)='integer' AND discount_bps BETWEEN 0 AND 10000)),
 lead_days INTEGER CHECK(lead_days IS NULL OR (typeof(lead_days)='integer' AND lead_days BETWEEN 0 AND 3650)),
 min_order_cents INTEGER CHECK(min_order_cents IS NULL OR (typeof(min_order_cents)='integer' AND min_order_cents BETWEEN 0 AND 100000000000)),
 responsible_staff_id TEXT REFERENCES staff_users(id) ON DELETE RESTRICT,
 updated_by TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER ec_party_profile_revision BEFORE UPDATE ON ec_party_profiles BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE NEW.party_id!=OLD.party_id OR NEW.revision!=OLD.revision+1;
END;
CREATE TRIGGER ec_party_profile_staff_insert BEFORE INSERT ON ec_party_profiles WHEN NEW.responsible_staff_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PROFILE_STAFF_ACCESS') WHERE NOT EXISTS(SELECT 1 FROM staff_users u WHERE u.id=NEW.responsible_staff_id AND u.active=1 AND u.ec_access IN ('read','write') AND (u.permissions_json IS NULL OR EXISTS(SELECT 1 FROM json_each(u.permissions_json,'$.ec') j WHERE j.value IN ('read','write') AND j.key!='amounts')));
END;
CREATE TRIGGER ec_party_profile_staff_update BEFORE UPDATE OF responsible_staff_id ON ec_party_profiles WHEN NEW.responsible_staff_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PROFILE_STAFF_ACCESS') WHERE NOT EXISTS(SELECT 1 FROM staff_users u WHERE u.id=NEW.responsible_staff_id AND u.active=1 AND u.ec_access IN ('read','write') AND (u.permissions_json IS NULL OR EXISTS(SELECT 1 FROM json_each(u.permissions_json,'$.ec') j WHERE j.value IN ('read','write') AND j.key!='amounts')));
END;
CREATE TABLE ec_party_profile_notes(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES ec_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),remind_on TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_by TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_party_profile_note_party ON ec_party_profile_notes(party_id,remind_on,created_at);
CREATE TRIGGER ec_party_profile_note_revision BEFORE UPDATE ON ec_party_profile_notes BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE NEW.party_id!=OLD.party_id OR NEW.id!=OLD.id OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.revision!=OLD.revision+1;
END;
CREATE TABLE ec_party_profile_files(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES ec_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 160),
 mime TEXT NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
 size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 5242880),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND 160),
 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','sealed')),
 write_token TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,sealed_at TEXT,
 UNIQUE(party_id,sha256),CHECK((state='sealed')=(sealed_at IS NOT NULL)));
CREATE INDEX ec_party_profile_file_party ON ec_party_profile_files(party_id,created_at);
CREATE TRIGGER ec_party_profile_file_limit BEFORE INSERT ON ec_party_profile_files BEGIN
 SELECT RAISE(ABORT,'PROFILE_FILE_LIMIT') WHERE (SELECT COUNT(*) FROM ec_party_profile_files WHERE party_id=NEW.party_id)>=100 OR COALESCE((SELECT SUM(size_bytes) FROM ec_party_profile_files WHERE party_id=NEW.party_id),0)+NEW.size_bytes>52428800;
END;
CREATE TRIGGER ec_party_profile_file_revision BEFORE UPDATE ON ec_party_profile_files BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE OLD.state='sealed' OR NEW.id!=OLD.id OR NEW.party_id!=OLD.party_id OR NEW.filename!=OLD.filename OR NEW.mime!=OLD.mime OR NEW.size_bytes!=OLD.size_bytes OR NEW.sha256!=OLD.sha256 OR NEW.chunk_count!=OLD.chunk_count OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.revision!=OLD.revision+1;
END;
CREATE TABLE ec_party_profile_file_chunks(
 file_id TEXT NOT NULL REFERENCES ec_party_profile_files(id) ON DELETE RESTRICT,
 idx INTEGER NOT NULL CHECK(typeof(idx)='integer' AND idx>=0),
 data_b64 TEXT NOT NULL CHECK(length(data_b64) BETWEEN 4 AND 43692),PRIMARY KEY(file_id,idx));
CREATE TRIGGER ec_party_profile_chunk_insert BEFORE INSERT ON ec_party_profile_file_chunks BEGIN
 SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM ec_party_profile_files f WHERE f.id=NEW.file_id AND f.state='uploading' AND NEW.idx<f.chunk_count);
END;
CREATE TRIGGER ec_party_profile_chunk_update BEFORE UPDATE ON ec_party_profile_file_chunks BEGIN SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED'); END;
CREATE TRIGGER ec_party_profile_chunk_delete BEFORE DELETE ON ec_party_profile_file_chunks BEGIN SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED'); END;
CREATE TABLE lp_party_profiles(
 party_id TEXT PRIMARY KEY REFERENCES lp_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 legal_name TEXT NOT NULL DEFAULT '',trade_name TEXT NOT NULL DEFAULT '',tax_office TEXT NOT NULL DEFAULT '',
 contacts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(contacts_json) AND json_type(contacts_json)='array'),
 addresses_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(addresses_json) AND json_type(addresses_json)='array'),
 banks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(banks_json) AND json_type(banks_json)='array'),
 tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
 payment_terms_days INTEGER CHECK(payment_terms_days IS NULL OR (typeof(payment_terms_days)='integer' AND payment_terms_days BETWEEN 0 AND 3650)),
 discount_bps INTEGER CHECK(discount_bps IS NULL OR (typeof(discount_bps)='integer' AND discount_bps BETWEEN 0 AND 10000)),
 lead_days INTEGER CHECK(lead_days IS NULL OR (typeof(lead_days)='integer' AND lead_days BETWEEN 0 AND 3650)),
 min_order_cents INTEGER CHECK(min_order_cents IS NULL OR (typeof(min_order_cents)='integer' AND min_order_cents BETWEEN 0 AND 100000000000)),
 responsible_staff_id TEXT REFERENCES staff_users(id) ON DELETE RESTRICT,
 updated_by TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER lp_party_profile_revision BEFORE UPDATE ON lp_party_profiles BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE NEW.party_id!=OLD.party_id OR NEW.revision!=OLD.revision+1;
END;
CREATE TRIGGER lp_party_profile_staff_insert BEFORE INSERT ON lp_party_profiles WHEN NEW.responsible_staff_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PROFILE_STAFF_ACCESS') WHERE NOT EXISTS(SELECT 1 FROM staff_users u WHERE u.id=NEW.responsible_staff_id AND u.active=1 AND u.lp_access IN ('read','write') AND (u.permissions_json IS NULL OR EXISTS(SELECT 1 FROM json_each(u.permissions_json,'$.lp') j WHERE j.value IN ('read','write') AND j.key!='amounts')));
END;
CREATE TRIGGER lp_party_profile_staff_update BEFORE UPDATE OF responsible_staff_id ON lp_party_profiles WHEN NEW.responsible_staff_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PROFILE_STAFF_ACCESS') WHERE NOT EXISTS(SELECT 1 FROM staff_users u WHERE u.id=NEW.responsible_staff_id AND u.active=1 AND u.lp_access IN ('read','write') AND (u.permissions_json IS NULL OR EXISTS(SELECT 1 FROM json_each(u.permissions_json,'$.lp') j WHERE j.value IN ('read','write') AND j.key!='amounts')));
END;
CREATE TABLE lp_party_profile_notes(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES lp_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),remind_on TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_by TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX lp_party_profile_note_party ON lp_party_profile_notes(party_id,remind_on,created_at);
CREATE TRIGGER lp_party_profile_note_revision BEFORE UPDATE ON lp_party_profile_notes BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE NEW.party_id!=OLD.party_id OR NEW.id!=OLD.id OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.revision!=OLD.revision+1;
END;
CREATE TABLE lp_party_profile_files(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES lp_suppliers(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>0),
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 160),
 mime TEXT NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
 size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 5242880),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND 160),
 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','sealed')),
 write_token TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,sealed_at TEXT,
 UNIQUE(party_id,sha256),CHECK((state='sealed')=(sealed_at IS NOT NULL)));
CREATE INDEX lp_party_profile_file_party ON lp_party_profile_files(party_id,created_at);
CREATE TRIGGER lp_party_profile_file_limit BEFORE INSERT ON lp_party_profile_files BEGIN
 SELECT RAISE(ABORT,'PROFILE_FILE_LIMIT') WHERE (SELECT COUNT(*) FROM lp_party_profile_files WHERE party_id=NEW.party_id)>=100 OR COALESCE((SELECT SUM(size_bytes) FROM lp_party_profile_files WHERE party_id=NEW.party_id),0)+NEW.size_bytes>52428800;
END;
CREATE TRIGGER lp_party_profile_file_revision BEFORE UPDATE ON lp_party_profile_files BEGIN
 SELECT RAISE(ABORT,'PROFILE_CONFLICT') WHERE OLD.state='sealed' OR NEW.id!=OLD.id OR NEW.party_id!=OLD.party_id OR NEW.filename!=OLD.filename OR NEW.mime!=OLD.mime OR NEW.size_bytes!=OLD.size_bytes OR NEW.sha256!=OLD.sha256 OR NEW.chunk_count!=OLD.chunk_count OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at OR NEW.revision!=OLD.revision+1;
END;
CREATE TABLE lp_party_profile_file_chunks(
 file_id TEXT NOT NULL REFERENCES lp_party_profile_files(id) ON DELETE RESTRICT,
 idx INTEGER NOT NULL CHECK(typeof(idx)='integer' AND idx>=0),
 data_b64 TEXT NOT NULL CHECK(length(data_b64) BETWEEN 4 AND 43692),PRIMARY KEY(file_id,idx));
CREATE TRIGGER lp_party_profile_chunk_insert BEFORE INSERT ON lp_party_profile_file_chunks BEGIN
 SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM lp_party_profile_files f WHERE f.id=NEW.file_id AND f.state='uploading' AND NEW.idx<f.chunk_count);
END;
CREATE TRIGGER lp_party_profile_chunk_update BEFORE UPDATE ON lp_party_profile_file_chunks BEGIN SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED'); END;
CREATE TRIGGER lp_party_profile_chunk_delete BEFORE DELETE ON lp_party_profile_file_chunks BEGIN SELECT RAISE(ABORT,'PROFILE_FILE_LOCKED'); END;
