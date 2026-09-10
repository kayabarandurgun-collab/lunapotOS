-- Cari mutabakat belgesi. Kaydedilen ekstre goruntusu DEGISMEZ; defter sonradan
-- degisirse belge duzeltilmez, yeni revizyon acilir. Bildirim yoksa mutabik sayilmaz.
CREATE TABLE ec_party_statements(
 id TEXT PRIMARY KEY,
 party_id TEXT NOT NULL REFERENCES ec_suppliers(id),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 period_from TEXT NOT NULL,
 period_to TEXT NOT NULL,
 opening_cents INTEGER NOT NULL CHECK(typeof(opening_cents)='integer'),
 debit_cents INTEGER NOT NULL CHECK(typeof(debit_cents)='integer' AND debit_cents>=0),
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents>=0),
 closing_cents INTEGER NOT NULL CHECK(typeof(closing_cents)='integer' AND closing_cents=opening_cents+debit_cents-credit_cents),
 row_count INTEGER NOT NULL CHECK(typeof(row_count)='integer' AND row_count>=0),
 fingerprint TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','agreed','disputed','cancelled')),
 reported_cents INTEGER CHECK(reported_cents IS NULL OR typeof(reported_cents)='integer'),
 reported_perspective TEXT CHECK(reported_perspective IS NULL OR reported_perspective IN ('ours','theirs')),
 reported_note TEXT NOT NULL DEFAULT '',
 reported_at TEXT,
 supersedes TEXT UNIQUE REFERENCES ec_party_statements(id),
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status_changed_by TEXT NOT NULL DEFAULT '',
 status_changed_at TEXT,
 CHECK(period_from<=period_to),
 -- Bildirim tutari ile bakis acisi birlikte bulunur; biri olmadan digeri anlamsizdir.
 CHECK((reported_cents IS NULL)=(reported_perspective IS NULL)),
 -- Karsi taraf bildirmeden mutabik ya da ihtilafli olunamaz: bilinmeyen sifir degildir.
 CHECK(status NOT IN ('agreed','disputed') OR reported_cents IS NOT NULL),
 CHECK(status!='agreed' OR closing_cents=CASE reported_perspective WHEN 'theirs' THEN -reported_cents ELSE reported_cents END),
 CHECK(status!='disputed' OR closing_cents!=CASE reported_perspective WHEN 'theirs' THEN -reported_cents ELSE reported_cents END),
 UNIQUE(document_no,revision)
);
CREATE INDEX ec_party_statement_party ON ec_party_statements(party_id,period_to);
CREATE VIEW ec_active_party_statements AS SELECT s.* FROM ec_party_statements s WHERE NOT EXISTS(SELECT 1 FROM ec_party_statements n WHERE n.supersedes=s.id);
CREATE TRIGGER ec_party_statement_validate BEFORE INSERT ON ec_party_statements BEGIN
 SELECT iif(NEW.supersedes IS NULL AND NEW.revision!=1,RAISE(ABORT,'STATEMENT_REVISION'),NULL);
 SELECT iif(NEW.supersedes IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_party_statements s WHERE s.id=NEW.supersedes AND s.party_id=NEW.party_id AND s.document_no=NEW.document_no AND s.revision=NEW.revision-1 AND s.status NOT IN ('agreed','cancelled')),RAISE(ABORT,'STATEMENT_REVISION'),NULL);
END;
-- Kaydedilen goruntu ve tutarlar hicbir kosulda guncellenmez; yalnizca durum ve bildirim yazilir.
CREATE TRIGGER ec_party_statement_immutable BEFORE UPDATE ON ec_party_statements BEGIN
 SELECT iif(NEW.id!=OLD.id OR NEW.party_id!=OLD.party_id OR NEW.document_no!=OLD.document_no OR NEW.revision!=OLD.revision
   OR NEW.period_from!=OLD.period_from OR NEW.period_to!=OLD.period_to
   OR NEW.opening_cents!=OLD.opening_cents OR NEW.debit_cents!=OLD.debit_cents OR NEW.credit_cents!=OLD.credit_cents
   OR NEW.closing_cents!=OLD.closing_cents OR NEW.row_count!=OLD.row_count OR NEW.fingerprint!=OLD.fingerprint
   OR NEW.snapshot_json!=OLD.snapshot_json OR NEW.created_at!=OLD.created_at OR NEW.created_by_name!=OLD.created_by_name
   OR COALESCE(NEW.supersedes,'')!=COALESCE(OLD.supersedes,''),RAISE(ABORT,'STATEMENT_IMMUTABLE'),NULL);
 SELECT iif(OLD.status IN ('agreed','cancelled'),RAISE(ABORT,'STATEMENT_CLOSED'),NULL);
 SELECT iif(NEW.status='draft' AND OLD.status!='draft',RAISE(ABORT,'STATEMENT_STATUS'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_party_statements n WHERE n.supersedes=OLD.id),RAISE(ABORT,'STATEMENT_SUPERSEDED'),NULL);
END;
CREATE TRIGGER ec_party_statement_no_delete BEFORE DELETE ON ec_party_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TABLE lp_party_statements(
 id TEXT PRIMARY KEY,
 party_id TEXT NOT NULL REFERENCES lp_suppliers(id),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 period_from TEXT NOT NULL,
 period_to TEXT NOT NULL,
 opening_cents INTEGER NOT NULL CHECK(typeof(opening_cents)='integer'),
 debit_cents INTEGER NOT NULL CHECK(typeof(debit_cents)='integer' AND debit_cents>=0),
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents>=0),
 closing_cents INTEGER NOT NULL CHECK(typeof(closing_cents)='integer' AND closing_cents=opening_cents+debit_cents-credit_cents),
 row_count INTEGER NOT NULL CHECK(typeof(row_count)='integer' AND row_count>=0),
 fingerprint TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','agreed','disputed','cancelled')),
 reported_cents INTEGER CHECK(reported_cents IS NULL OR typeof(reported_cents)='integer'),
 reported_perspective TEXT CHECK(reported_perspective IS NULL OR reported_perspective IN ('ours','theirs')),
 reported_note TEXT NOT NULL DEFAULT '',
 reported_at TEXT,
 supersedes TEXT UNIQUE REFERENCES lp_party_statements(id),
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status_changed_by TEXT NOT NULL DEFAULT '',
 status_changed_at TEXT,
 CHECK(period_from<=period_to),
 -- Bildirim tutari ile bakis acisi birlikte bulunur; biri olmadan digeri anlamsizdir.
 CHECK((reported_cents IS NULL)=(reported_perspective IS NULL)),
 -- Karsi taraf bildirmeden mutabik ya da ihtilafli olunamaz: bilinmeyen sifir degildir.
 CHECK(status NOT IN ('agreed','disputed') OR reported_cents IS NOT NULL),
 CHECK(status!='agreed' OR closing_cents=CASE reported_perspective WHEN 'theirs' THEN -reported_cents ELSE reported_cents END),
 CHECK(status!='disputed' OR closing_cents!=CASE reported_perspective WHEN 'theirs' THEN -reported_cents ELSE reported_cents END),
 UNIQUE(document_no,revision)
);
CREATE INDEX lp_party_statement_party ON lp_party_statements(party_id,period_to);
CREATE VIEW lp_active_party_statements AS SELECT s.* FROM lp_party_statements s WHERE NOT EXISTS(SELECT 1 FROM lp_party_statements n WHERE n.supersedes=s.id);
CREATE TRIGGER lp_party_statement_validate BEFORE INSERT ON lp_party_statements BEGIN
 SELECT iif(NEW.supersedes IS NULL AND NEW.revision!=1,RAISE(ABORT,'STATEMENT_REVISION'),NULL);
 SELECT iif(NEW.supersedes IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lp_party_statements s WHERE s.id=NEW.supersedes AND s.party_id=NEW.party_id AND s.document_no=NEW.document_no AND s.revision=NEW.revision-1 AND s.status NOT IN ('agreed','cancelled')),RAISE(ABORT,'STATEMENT_REVISION'),NULL);
END;
CREATE TRIGGER lp_party_statement_immutable BEFORE UPDATE ON lp_party_statements BEGIN
 SELECT iif(NEW.id!=OLD.id OR NEW.party_id!=OLD.party_id OR NEW.document_no!=OLD.document_no OR NEW.revision!=OLD.revision
   OR NEW.period_from!=OLD.period_from OR NEW.period_to!=OLD.period_to
   OR NEW.opening_cents!=OLD.opening_cents OR NEW.debit_cents!=OLD.debit_cents OR NEW.credit_cents!=OLD.credit_cents
   OR NEW.closing_cents!=OLD.closing_cents OR NEW.row_count!=OLD.row_count OR NEW.fingerprint!=OLD.fingerprint
   OR NEW.snapshot_json!=OLD.snapshot_json OR NEW.created_at!=OLD.created_at OR NEW.created_by_name!=OLD.created_by_name
   OR COALESCE(NEW.supersedes,'')!=COALESCE(OLD.supersedes,''),RAISE(ABORT,'STATEMENT_IMMUTABLE'),NULL);
 SELECT iif(OLD.status IN ('agreed','cancelled'),RAISE(ABORT,'STATEMENT_CLOSED'),NULL);
 SELECT iif(NEW.status='draft' AND OLD.status!='draft',RAISE(ABORT,'STATEMENT_STATUS'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM lp_party_statements n WHERE n.supersedes=OLD.id),RAISE(ABORT,'STATEMENT_SUPERSEDED'),NULL);
END;
CREATE TRIGGER lp_party_statement_no_delete BEFORE DELETE ON lp_party_statements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
