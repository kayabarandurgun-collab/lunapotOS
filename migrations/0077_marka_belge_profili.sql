-- BELGE ATÖLYESİ: ANTET PROFİLİ VE DOKUZ KURUMSAL EVRAK TÜRÜ.
--
-- Bu göç YALNIZ EKLEYİCİDİR. Hiçbir mevcut satır değişmez, hiçbir tablo düşmez.
--
-- 1) ANTET ALANLARI. workspace_settings bugün yalnız legal_name ve tax_id tutuyor
--    (0006). Tam antetli belge için adres, telefon, e-posta, web, vergi dairesi,
--    banka adı ve IBAN gerekiyor. Bunlar BOŞ varsayılanla eklenir: hiçbir değer
--    uydurulmaz, kullanıcı Şirket ve yedek ekranından kendisi yazar. Boş kalan
--    alan belgede boş basılır, gizlenmez.
--
-- 2) DOKUZ YENİ EVRAK TÜRÜ. Teklif ve proforma MEVCUT ec_offers/lp_offers
--    kaydında kalır (0025); burada ikinci bir teklif havuzu KURULMAZ. Bu tablo
--    yalnız atölyenin diğer dokuz türünü tutar.
--
--    BU BELGELER MUHASEBE KAYDI DEĞİLDİR. Hiçbiri gerçek sipariş, fatura,
--    irsaliye, tahsilat ya da stok hareketi yaratmaz. Bu dosyada stok, defter,
--    kasa veya fatura tablolarına yazan TEK BİR tetik ya da sorgu yoktur.
--    'satinalma-siparisi' alış faturası veya stok girişi değildir;
--    'paket-listesi' sevk irsaliyesi yerine geçmez;
--    'teslim-tutanagi' mal kabulü başlatmaz;
--    'iade-formu' muhasebe iadesi veya geri ödeme açmaz.
--
--    source_kind/source_id yalnız BİLGİ amaçlı bağlantıdır: belge hangi teklife
--    ya da siparişe atıfta bulunuyor diye yazılır, finansal etkisi yoktur.

ALTER TABLE workspace_settings ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN tax_office TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN bank_name TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN bank_iban TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_settings ADD COLUMN signature_title TEXT NOT NULL DEFAULT '';

CREATE TABLE ec_brand_documents(
 id TEXT PRIMARY KEY,
 type TEXT NOT NULL CHECK(type IN ('siparis-onayi','satinalma-siparisi','paket-listesi',
  'teslim-tutanagi','iade-formu','teknik-bilgi','antet','toplanti-notu','dosya-kapagi')),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
 supersedes TEXT REFERENCES ec_brand_documents(id),
 party_id TEXT REFERENCES ec_suppliers(id),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','final','archived')),
 -- Belgenin kendi içeriği ve sunumu; tutarlar kanonik kuruş/milli/bps modelinde.
 content_json TEXT NOT NULL,
 presentation_json TEXT,
 -- Yalnız bilgi amaçlı kaynak atfı; stok ya da finans etkisi YOK.
 source_kind TEXT CHECK(source_kind IN ('offer','order','product')),
 source_id TEXT,
 -- Aynı create isteği iki kez gelirse kopya belge oluşmaz.
 idempotency_key TEXT,
 total_cents INTEGER CHECK(total_cents IS NULL OR total_cents >= 0),
 line_count INTEGER NOT NULL DEFAULT 0 CHECK(line_count >= 0 AND line_count <= 200),
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_no,revision),
 UNIQUE(idempotency_key),
 UNIQUE(supersedes)
);
CREATE INDEX ec_brand_doc_type ON ec_brand_documents(type,created_at DESC);
CREATE INDEX ec_brand_doc_party ON ec_brand_documents(party_id);
-- Dondurulmuş belge değişmez: değişiklik için yeni revizyon alınır.
CREATE TRIGGER ec_brand_doc_frozen BEFORE UPDATE OF content_json,presentation_json ON ec_brand_documents
WHEN OLD.status != 'draft' BEGIN SELECT RAISE(ABORT,'BRAND_DOC_FROZEN'); END;
-- Revizyon sırası atlanmaz ve aynı türde kalır.
CREATE TRIGGER ec_brand_doc_revision BEFORE INSERT ON ec_brand_documents
WHEN NEW.supersedes IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_brand_documents o WHERE o.id=NEW.supersedes
  AND o.type=NEW.type AND o.document_no=NEW.document_no AND o.revision=NEW.revision-1)
  THEN RAISE(ABORT,'BRAND_DOC_REVISION') END;
END;

CREATE TABLE lp_brand_documents(
 id TEXT PRIMARY KEY,
 type TEXT NOT NULL CHECK(type IN ('siparis-onayi','satinalma-siparisi','paket-listesi',
  'teslim-tutanagi','iade-formu','teknik-bilgi','antet','toplanti-notu','dosya-kapagi')),
 document_no TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
 supersedes TEXT REFERENCES lp_brand_documents(id),
 party_id TEXT REFERENCES lp_suppliers(id),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','final','archived')),
 content_json TEXT NOT NULL,
 presentation_json TEXT,
 source_kind TEXT CHECK(source_kind IN ('offer','order','product')),
 source_id TEXT,
 idempotency_key TEXT,
 total_cents INTEGER CHECK(total_cents IS NULL OR total_cents >= 0),
 line_count INTEGER NOT NULL DEFAULT 0 CHECK(line_count >= 0 AND line_count <= 200),
 created_by TEXT NOT NULL DEFAULT '',
 created_by_name TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(document_no,revision),
 UNIQUE(idempotency_key),
 UNIQUE(supersedes)
);
CREATE INDEX lp_brand_doc_type ON lp_brand_documents(type,created_at DESC);
CREATE INDEX lp_brand_doc_party ON lp_brand_documents(party_id);
CREATE TRIGGER lp_brand_doc_frozen BEFORE UPDATE OF content_json,presentation_json ON lp_brand_documents
WHEN OLD.status != 'draft' BEGIN SELECT RAISE(ABORT,'BRAND_DOC_FROZEN'); END;
CREATE TRIGGER lp_brand_doc_revision BEFORE INSERT ON lp_brand_documents
WHEN NEW.supersedes IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_brand_documents o WHERE o.id=NEW.supersedes
  AND o.type=NEW.type AND o.document_no=NEW.document_no AND o.revision=NEW.revision-1)
  THEN RAISE(ABORT,'BRAND_DOC_REVISION') END;
END;
