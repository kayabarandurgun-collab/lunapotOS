-- Teklif / proforma / sozlesme. Bu belgeler TICARI TEKLIFTIR:
-- stok dusmez, cariye borc/alacak yazmaz, resmi fatura degildir.
-- Bu yuzden burada baska tabloya yazan hicbir tetik YOKTUR.
-- Gonderildikten sonra icerik donar; degisiklik yeni revizyon acar.
CREATE TABLE ec_offers(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('quote','proforma','contract')),
 party_id TEXT NOT NULL REFERENCES ec_suppliers(id),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 supersedes TEXT UNIQUE REFERENCES ec_offers(id),
 -- Zincir: teklif -> proforma -> sozlesme. Bir belgeden ayni turde ikinci belge uretilemez.
 source_offer_id TEXT REFERENCES ec_offers(id),
 title TEXT NOT NULL,
 issue_date TEXT NOT NULL,
 valid_until TEXT,
 terms TEXT NOT NULL DEFAULT '',
 gross_cents INTEGER NOT NULL CHECK(typeof(gross_cents)='integer' AND gross_cents>=0),
 discount_cents INTEGER NOT NULL CHECK(typeof(discount_cents)='integer' AND discount_cents>=0),
 net_cents INTEGER NOT NULL CHECK(typeof(net_cents)='integer' AND net_cents=gross_cents-discount_cents),
 vat_cents INTEGER NOT NULL CHECK(typeof(vat_cents)='integer' AND vat_cents>=0),
 total_cents INTEGER NOT NULL CHECK(typeof(total_cents)='integer' AND total_cents=net_cents+vat_cents AND total_cents<=100000000000),
 line_count INTEGER NOT NULL CHECK(typeof(line_count)='integer' AND line_count>0 AND line_count<=200),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','rejected','expired','cancelled')),
 status_note TEXT NOT NULL DEFAULT '',
 sent_at TEXT,
 decided_at TEXT,
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status_changed_by TEXT NOT NULL DEFAULT '',
 status_changed_at TEXT,
 CHECK(valid_until IS NULL OR valid_until>=issue_date),
 -- Sozlesmenin gecerlilik gunu olmaz; teklif ve proformada olmalidir.
 CHECK((kind='contract')=(valid_until IS NULL)),
 -- Reddetme ve iptal gerekcesiz kaydedilmez.
 CHECK(status NOT IN ('rejected','cancelled') OR status_note!=''),
 UNIQUE(document_no,revision),
 UNIQUE(source_offer_id,kind)
);
CREATE INDEX ec_offer_party ON ec_offers(party_id,issue_date);
CREATE INDEX ec_offer_kind ON ec_offers(kind,status);
CREATE VIEW ec_active_offers AS SELECT o.* FROM ec_offers o WHERE NOT EXISTS(SELECT 1 FROM ec_offers n WHERE n.supersedes=o.id);

CREATE TRIGGER ec_offer_validate BEFORE INSERT ON ec_offers BEGIN
 SELECT iif(NEW.supersedes IS NULL AND NEW.revision!=1,RAISE(ABORT,'OFFER_REVISION'),NULL);
 SELECT iif(NEW.supersedes IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_offers o WHERE o.id=NEW.supersedes AND o.party_id=NEW.party_id AND o.kind=NEW.kind AND o.document_no=NEW.document_no AND o.revision=NEW.revision-1 AND o.status NOT IN ('accepted','rejected','cancelled')),RAISE(ABORT,'OFFER_REVISION'),NULL);
 -- Zincir yalnizca kabul edilmis bir belgeden ve tek adim ileri kurulur.
 SELECT iif(NEW.source_offer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_offers s WHERE s.id=NEW.source_offer_id AND s.party_id=NEW.party_id AND s.status='accepted' AND ((s.kind='quote' AND NEW.kind='proforma') OR (s.kind='proforma' AND NEW.kind='contract'))),RAISE(ABORT,'OFFER_CHAIN'),NULL);
 SELECT iif(NEW.source_offer_id IS NOT NULL AND NEW.supersedes IS NOT NULL,RAISE(ABORT,'OFFER_CHAIN'),NULL);
END;

-- Taslak duzenlenebilir. Gonderildigi anda icerik donar ve bir daha degismez.
CREATE TRIGGER ec_offer_content_frozen BEFORE UPDATE ON ec_offers BEGIN
 SELECT iif(NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.party_id!=OLD.party_id OR NEW.document_no!=OLD.document_no
   OR NEW.revision!=OLD.revision OR NEW.created_at!=OLD.created_at OR NEW.created_by_name!=OLD.created_by_name
   OR COALESCE(NEW.supersedes,'')!=COALESCE(OLD.supersedes,'') OR COALESCE(NEW.source_offer_id,'')!=COALESCE(OLD.source_offer_id,''),RAISE(ABORT,'OFFER_IMMUTABLE'),NULL);
 SELECT iif(OLD.status!='draft' AND (NEW.snapshot_json!=OLD.snapshot_json OR NEW.total_cents!=OLD.total_cents
   OR NEW.net_cents!=OLD.net_cents OR NEW.vat_cents!=OLD.vat_cents OR NEW.gross_cents!=OLD.gross_cents
   OR NEW.discount_cents!=OLD.discount_cents OR NEW.line_count!=OLD.line_count OR NEW.title!=OLD.title
   OR NEW.issue_date!=OLD.issue_date OR COALESCE(NEW.valid_until,'')!=COALESCE(OLD.valid_until,'') OR NEW.terms!=OLD.terms),RAISE(ABORT,'OFFER_SENT_IMMUTABLE'),NULL);
 SELECT iif(OLD.status IN ('accepted','rejected','cancelled'),RAISE(ABORT,'OFFER_CLOSED'),NULL);
 SELECT iif(NEW.status='draft' AND OLD.status!='draft',RAISE(ABORT,'OFFER_STATUS'),NULL);
 -- Yanit beklemeyen belge kabul veya ret alamaz: indirmek ya da yazdirmak kabul degildir.
 SELECT iif(NEW.status IN ('accepted','rejected') AND OLD.status!='sent',RAISE(ABORT,'OFFER_NOT_SENT'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_offers n WHERE n.supersedes=OLD.id),RAISE(ABORT,'OFFER_SUPERSEDED'),NULL);
END;
CREATE TRIGGER ec_offer_no_delete BEFORE DELETE ON ec_offers BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TABLE lp_offers(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('quote','proforma','contract')),
 party_id TEXT NOT NULL REFERENCES lp_suppliers(id),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 supersedes TEXT UNIQUE REFERENCES lp_offers(id),
 -- Zincir: teklif -> proforma -> sozlesme. Bir belgeden ayni turde ikinci belge uretilemez.
 source_offer_id TEXT REFERENCES lp_offers(id),
 title TEXT NOT NULL,
 issue_date TEXT NOT NULL,
 valid_until TEXT,
 terms TEXT NOT NULL DEFAULT '',
 gross_cents INTEGER NOT NULL CHECK(typeof(gross_cents)='integer' AND gross_cents>=0),
 discount_cents INTEGER NOT NULL CHECK(typeof(discount_cents)='integer' AND discount_cents>=0),
 net_cents INTEGER NOT NULL CHECK(typeof(net_cents)='integer' AND net_cents=gross_cents-discount_cents),
 vat_cents INTEGER NOT NULL CHECK(typeof(vat_cents)='integer' AND vat_cents>=0),
 total_cents INTEGER NOT NULL CHECK(typeof(total_cents)='integer' AND total_cents=net_cents+vat_cents AND total_cents<=100000000000),
 line_count INTEGER NOT NULL CHECK(typeof(line_count)='integer' AND line_count>0 AND line_count<=200),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','rejected','expired','cancelled')),
 status_note TEXT NOT NULL DEFAULT '',
 sent_at TEXT,
 decided_at TEXT,
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status_changed_by TEXT NOT NULL DEFAULT '',
 status_changed_at TEXT,
 CHECK(valid_until IS NULL OR valid_until>=issue_date),
 -- Sozlesmenin gecerlilik gunu olmaz; teklif ve proformada olmalidir.
 CHECK((kind='contract')=(valid_until IS NULL)),
 -- Reddetme ve iptal gerekcesiz kaydedilmez.
 CHECK(status NOT IN ('rejected','cancelled') OR status_note!=''),
 UNIQUE(document_no,revision),
 UNIQUE(source_offer_id,kind)
);
CREATE INDEX lp_offer_party ON lp_offers(party_id,issue_date);
CREATE INDEX lp_offer_kind ON lp_offers(kind,status);
CREATE VIEW lp_active_offers AS SELECT o.* FROM lp_offers o WHERE NOT EXISTS(SELECT 1 FROM lp_offers n WHERE n.supersedes=o.id);

CREATE TRIGGER lp_offer_validate BEFORE INSERT ON lp_offers BEGIN
 SELECT iif(NEW.supersedes IS NULL AND NEW.revision!=1,RAISE(ABORT,'OFFER_REVISION'),NULL);
 SELECT iif(NEW.supersedes IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lp_offers o WHERE o.id=NEW.supersedes AND o.party_id=NEW.party_id AND o.kind=NEW.kind AND o.document_no=NEW.document_no AND o.revision=NEW.revision-1 AND o.status NOT IN ('accepted','rejected','cancelled')),RAISE(ABORT,'OFFER_REVISION'),NULL);
 -- Zincir yalnizca kabul edilmis bir belgeden ve tek adim ileri kurulur.
 SELECT iif(NEW.source_offer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lp_offers s WHERE s.id=NEW.source_offer_id AND s.party_id=NEW.party_id AND s.status='accepted' AND ((s.kind='quote' AND NEW.kind='proforma') OR (s.kind='proforma' AND NEW.kind='contract'))),RAISE(ABORT,'OFFER_CHAIN'),NULL);
 SELECT iif(NEW.source_offer_id IS NOT NULL AND NEW.supersedes IS NOT NULL,RAISE(ABORT,'OFFER_CHAIN'),NULL);
END;

CREATE TRIGGER lp_offer_content_frozen BEFORE UPDATE ON lp_offers BEGIN
 SELECT iif(NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.party_id!=OLD.party_id OR NEW.document_no!=OLD.document_no
   OR NEW.revision!=OLD.revision OR NEW.created_at!=OLD.created_at OR NEW.created_by_name!=OLD.created_by_name
   OR COALESCE(NEW.supersedes,'')!=COALESCE(OLD.supersedes,'') OR COALESCE(NEW.source_offer_id,'')!=COALESCE(OLD.source_offer_id,''),RAISE(ABORT,'OFFER_IMMUTABLE'),NULL);
 SELECT iif(OLD.status!='draft' AND (NEW.snapshot_json!=OLD.snapshot_json OR NEW.total_cents!=OLD.total_cents
   OR NEW.net_cents!=OLD.net_cents OR NEW.vat_cents!=OLD.vat_cents OR NEW.gross_cents!=OLD.gross_cents
   OR NEW.discount_cents!=OLD.discount_cents OR NEW.line_count!=OLD.line_count OR NEW.title!=OLD.title
   OR NEW.issue_date!=OLD.issue_date OR COALESCE(NEW.valid_until,'')!=COALESCE(OLD.valid_until,'') OR NEW.terms!=OLD.terms),RAISE(ABORT,'OFFER_SENT_IMMUTABLE'),NULL);
 SELECT iif(OLD.status IN ('accepted','rejected','cancelled'),RAISE(ABORT,'OFFER_CLOSED'),NULL);
 SELECT iif(NEW.status='draft' AND OLD.status!='draft',RAISE(ABORT,'OFFER_STATUS'),NULL);
 -- Yanit beklemeyen belge kabul veya ret alamaz: indirmek ya da yazdirmak kabul degildir.
 SELECT iif(NEW.status IN ('accepted','rejected') AND OLD.status!='sent',RAISE(ABORT,'OFFER_NOT_SENT'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM lp_offers n WHERE n.supersedes=OLD.id),RAISE(ABORT,'OFFER_SUPERSEDED'),NULL);
END;
CREATE TRIGGER lp_offer_no_delete BEFORE DELETE ON lp_offers BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
