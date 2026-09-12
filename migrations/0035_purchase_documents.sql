-- Tedarikçi alış belgeleri (PDF/XML) ve "her faturada yeniden dağıtılan" çeşit aileleri.
--
-- Kurallar:
--  1) Belgenin kendisi değiştirilemez biçimde saklanır; yükleme ve taslak aşaması BORÇ veya STOK yazmaz.
--  2) Aynı belge ikinci kez yüklenemez: dosya özeti, ETTN ve tedarikçi VKN + fatura no ayrı ayrı tekildir.
--     Dosya adı değişse de aynı belge yakalanır. Farklı satırlı aynı belge otomatik ÜSTÜNE YAZILMAZ.
--  3) Ürün ailesi (örn. bitki besini 500 ml) yalnızca ADAY kartları ve birim dönüşümünü hatırlar.
--     Çeşit ADETLERİ hiçbir yerde hatırlanmaz: her faturada kullanıcı yeniden girer ve onaylar.
--  4) Çeşit dağılımı artık tek çeşit için de yapılabilir (1–20). Asıl fatura satırı korunur,
--     toplam net ve KDV kuruşu değişmez.

CREATE TABLE ec_purchase_documents(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('pdf','xml')),
 filename TEXT NOT NULL,
 mime TEXT NOT NULL DEFAULT '',
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
 sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64),
 chunk_count INTEGER NOT NULL CHECK(chunk_count>0),
 page_count INTEGER,
 -- 0: metin katmanı yok (taranmış belge). Satırlar okunamaz; elle girilir.
 text_layer INTEGER NOT NULL DEFAULT 0 CHECK(text_layer IN (0,1)),
 supplier_tax_id TEXT NOT NULL DEFAULT '',
 doc_no TEXT NOT NULL DEFAULT '',
 doc_uuid TEXT NOT NULL DEFAULT '',
 extracted_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extracted_json)),
 warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
 status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','stored','linked')),
 invoice_id TEXT REFERENCES ec_purchase_invoices(id),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ec_purchase_document_uuid ON ec_purchase_documents(doc_uuid) WHERE doc_uuid!='';
CREATE UNIQUE INDEX ec_purchase_document_no ON ec_purchase_documents(supplier_tax_id,doc_no) WHERE supplier_tax_id!='' AND doc_no!='';
CREATE INDEX ec_purchase_documents_invoice ON ec_purchase_documents(invoice_id);
CREATE TABLE ec_purchase_document_chunks(document_id TEXT NOT NULL REFERENCES ec_purchase_documents(id), idx INTEGER NOT NULL CHECK(idx>=0), data_b64 TEXT NOT NULL, PRIMARY KEY(document_id,idx));
CREATE TRIGGER ec_purchase_doc_chunk_receiving BEFORE INSERT ON ec_purchase_document_chunks WHEN (SELECT status FROM ec_purchase_documents WHERE id=NEW.document_id) IS NOT 'receiving' BEGIN SELECT RAISE(ABORT,'DOCUMENT_SEALED'); END;
CREATE TRIGGER ec_purchase_doc_chunk_no_update BEFORE UPDATE ON ec_purchase_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_purchase_doc_chunk_no_delete BEFORE DELETE ON ec_purchase_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_purchase_doc_no_delete BEFORE DELETE ON ec_purchase_documents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Mühürlendikten sonra yalnızca durum, fatura bağlantısı ve okunan alanlar tamamlanabilir;
-- dosyanın kendisi ve özeti asla değişmez.
CREATE TRIGGER ec_purchase_doc_frozen BEFORE UPDATE ON ec_purchase_documents WHEN
 NEW.id!=OLD.id OR NEW.sha256!=OLD.sha256 OR NEW.kind!=OLD.kind OR NEW.size_bytes!=OLD.size_bytes
 OR NEW.chunk_count!=OLD.chunk_count OR NEW.filename!=OLD.filename OR NEW.created_at!=OLD.created_at
 OR (OLD.status='linked' AND (NEW.status!='linked' OR NEW.invoice_id IS NOT OLD.invoice_id)) BEGIN
 SELECT RAISE(ABORT,'DOCUMENT_IMMUTABLE');
END;

-- Ürün ailesi: aynı boy/hacmin çeşitleri. Adetler DEĞİL, yalnız aday kartlar hatırlanır.
CREATE TABLE ec_product_families(
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 size_label TEXT NOT NULL DEFAULT '',
 stock_unit TEXT NOT NULL,
 allocation_required INTEGER NOT NULL DEFAULT 1 CHECK(allocation_required IN (0,1)),
 archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(name,size_label)
);
CREATE TABLE ec_product_family_members(family_id TEXT NOT NULL REFERENCES ec_product_families(id), product_id TEXT NOT NULL REFERENCES ec_products(id), PRIMARY KEY(family_id,product_id));
CREATE INDEX ec_product_family_members_product ON ec_product_family_members(product_id);
CREATE TRIGGER ec_family_member_unit BEFORE INSERT ON ec_product_family_members
 WHEN (SELECT stock_unit FROM ec_products WHERE id=NEW.product_id) IS NOT (SELECT stock_unit FROM ec_product_families WHERE id=NEW.family_id) BEGIN
 SELECT RAISE(ABORT,'FAMILY_UNIT');
END;

-- Tedarikçinin tek kalem yazdığı satır → ürün ailesi. Birim dönüşümü hatırlanır, adetler hatırlanmaz.
CREATE TABLE ec_purchase_family_links(
 id TEXT PRIMARY KEY,
 supplier_id TEXT NOT NULL REFERENCES ec_suppliers(id),
 match_by TEXT NOT NULL CHECK(match_by IN ('code','name')),
 match_value TEXT NOT NULL,
 source_unit TEXT NOT NULL,
 family_id TEXT NOT NULL REFERENCES ec_product_families(id),
 units_per_invoice_unit_milli INTEGER NOT NULL CHECK(units_per_invoice_unit_milli>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(supplier_id,match_by,match_value,source_unit)
);

ALTER TABLE ec_purchase_line_splits ADD COLUMN family_id TEXT REFERENCES ec_product_families(id);
-- Tek çeşit alınmış olabilir: alt sınır 1'e iner. Diğer bütün korumalar aynı kalır.
DROP TRIGGER ec_split_validate;
CREATE TRIGGER ec_split_validate BEFORE INSERT ON ec_purchase_line_splits BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.original_line_id AND l.invoice_id=NEW.invoice_id AND i.status='draft' AND l.line_type='product' AND l.split_id IS NULL AND l.net_cents=json_extract(NEW.original_json,'$.net_cents') AND l.tax_cents=json_extract(NEW.original_json,'$.tax_cents') AND l.invoice_quantity=json_extract(NEW.original_json,'$.invoice_quantity') AND l.invoice_unit=json_extract(NEW.original_json,'$.invoice_unit') AND l.product_id IS json_extract(NEW.original_json,'$.product_id') AND l.quantity_milli IS json_extract(NEW.original_json,'$.quantity_milli') AND l.catalog_mapping_id IS json_extract(NEW.original_json,'$.catalog_mapping_id')) THEN RAISE(ABORT,'SPLIT_CHANGED') END;
 SELECT CASE WHEN json_array_length(NEW.allocations_json)<1 OR json_array_length(NEW.allocations_json)>20 OR (SELECT COUNT(*) FROM ec_purchase_lines WHERE invoice_id=NEW.invoice_id)-1+json_array_length(NEW.allocations_json)>40 THEN RAISE(ABORT,'SPLIT_LIMIT') END;
 SELECT CASE WHEN (SELECT SUM(json_extract(value,'$.quantity_milli')) FROM json_each(NEW.allocations_json))!=NEW.total_quantity_milli OR (SELECT SUM(json_extract(value,'$.net_cents')) FROM json_each(NEW.allocations_json))!=json_extract(NEW.original_json,'$.net_cents') OR (SELECT SUM(json_extract(value,'$.tax_cents')) FROM json_each(NEW.allocations_json))!=json_extract(NEW.original_json,'$.tax_cents') THEN RAISE(ABORT,'SPLIT_TOTAL') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) a LEFT JOIN ec_products p ON p.id=json_extract(a.value,'$.product_id') WHERE p.id IS NULL OR p.stock_unit!=NEW.stock_unit) THEN RAISE(ABORT,'SPLIT_UNIT') END;
 -- Aile verildiyse her çeşit o ailenin üyesi olmalı: benzer isimli başka hacim bağlanamaz.
 SELECT CASE WHEN NEW.family_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) a WHERE NOT EXISTS(SELECT 1 FROM ec_product_family_members m WHERE m.family_id=NEW.family_id AND m.product_id=json_extract(a.value,'$.product_id'))) THEN RAISE(ABORT,'SPLIT_FAMILY') END;
END;

CREATE TABLE lp_purchase_documents(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('pdf','xml')),
 filename TEXT NOT NULL,
 mime TEXT NOT NULL DEFAULT '',
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
 sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64),
 chunk_count INTEGER NOT NULL CHECK(chunk_count>0),
 page_count INTEGER,
 text_layer INTEGER NOT NULL DEFAULT 0 CHECK(text_layer IN (0,1)),
 supplier_tax_id TEXT NOT NULL DEFAULT '',
 doc_no TEXT NOT NULL DEFAULT '',
 doc_uuid TEXT NOT NULL DEFAULT '',
 extracted_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extracted_json)),
 warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
 status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','stored','linked')),
 invoice_id TEXT REFERENCES lp_purchase_invoices(id),
 created_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX lp_purchase_document_uuid ON lp_purchase_documents(doc_uuid) WHERE doc_uuid!='';
CREATE UNIQUE INDEX lp_purchase_document_no ON lp_purchase_documents(supplier_tax_id,doc_no) WHERE supplier_tax_id!='' AND doc_no!='';
CREATE INDEX lp_purchase_documents_invoice ON lp_purchase_documents(invoice_id);
CREATE TABLE lp_purchase_document_chunks(document_id TEXT NOT NULL REFERENCES lp_purchase_documents(id), idx INTEGER NOT NULL CHECK(idx>=0), data_b64 TEXT NOT NULL, PRIMARY KEY(document_id,idx));
CREATE TRIGGER lp_purchase_doc_chunk_receiving BEFORE INSERT ON lp_purchase_document_chunks WHEN (SELECT status FROM lp_purchase_documents WHERE id=NEW.document_id) IS NOT 'receiving' BEGIN SELECT RAISE(ABORT,'DOCUMENT_SEALED'); END;
CREATE TRIGGER lp_purchase_doc_chunk_no_update BEFORE UPDATE ON lp_purchase_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_purchase_doc_chunk_no_delete BEFORE DELETE ON lp_purchase_document_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_purchase_doc_no_delete BEFORE DELETE ON lp_purchase_documents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_purchase_doc_frozen BEFORE UPDATE ON lp_purchase_documents WHEN
 NEW.id!=OLD.id OR NEW.sha256!=OLD.sha256 OR NEW.kind!=OLD.kind OR NEW.size_bytes!=OLD.size_bytes
 OR NEW.chunk_count!=OLD.chunk_count OR NEW.filename!=OLD.filename OR NEW.created_at!=OLD.created_at
 OR (OLD.status='linked' AND (NEW.status!='linked' OR NEW.invoice_id IS NOT OLD.invoice_id)) BEGIN
 SELECT RAISE(ABORT,'DOCUMENT_IMMUTABLE');
END;

CREATE TABLE lp_product_families(
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 size_label TEXT NOT NULL DEFAULT '',
 stock_unit TEXT NOT NULL,
 allocation_required INTEGER NOT NULL DEFAULT 1 CHECK(allocation_required IN (0,1)),
 archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(name,size_label)
);
CREATE TABLE lp_product_family_members(family_id TEXT NOT NULL REFERENCES lp_product_families(id), product_id TEXT NOT NULL REFERENCES products(id), PRIMARY KEY(family_id,product_id));
CREATE INDEX lp_product_family_members_product ON lp_product_family_members(product_id);
CREATE TRIGGER lp_family_member_unit BEFORE INSERT ON lp_product_family_members
 WHEN (SELECT stock_unit FROM products WHERE id=NEW.product_id) IS NOT (SELECT stock_unit FROM lp_product_families WHERE id=NEW.family_id) BEGIN
 SELECT RAISE(ABORT,'FAMILY_UNIT');
END;

CREATE TABLE lp_purchase_family_links(
 id TEXT PRIMARY KEY,
 supplier_id TEXT NOT NULL REFERENCES lp_suppliers(id),
 match_by TEXT NOT NULL CHECK(match_by IN ('code','name')),
 match_value TEXT NOT NULL,
 source_unit TEXT NOT NULL,
 family_id TEXT NOT NULL REFERENCES lp_product_families(id),
 units_per_invoice_unit_milli INTEGER NOT NULL CHECK(units_per_invoice_unit_milli>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(supplier_id,match_by,match_value,source_unit)
);

ALTER TABLE lp_purchase_line_splits ADD COLUMN family_id TEXT REFERENCES lp_product_families(id);
DROP TRIGGER lp_split_validate;
CREATE TRIGGER lp_split_validate BEFORE INSERT ON lp_purchase_line_splits BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_purchase_lines l JOIN lp_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.original_line_id AND l.invoice_id=NEW.invoice_id AND i.status='draft' AND l.line_type='product' AND l.split_id IS NULL AND l.net_cents=json_extract(NEW.original_json,'$.net_cents') AND l.tax_cents=json_extract(NEW.original_json,'$.tax_cents') AND l.invoice_quantity=json_extract(NEW.original_json,'$.invoice_quantity') AND l.invoice_unit=json_extract(NEW.original_json,'$.invoice_unit') AND l.product_id IS json_extract(NEW.original_json,'$.product_id') AND l.quantity_milli IS json_extract(NEW.original_json,'$.quantity_milli') AND l.catalog_mapping_id IS json_extract(NEW.original_json,'$.catalog_mapping_id')) THEN RAISE(ABORT,'SPLIT_CHANGED') END;
 SELECT CASE WHEN json_array_length(NEW.allocations_json)<1 OR json_array_length(NEW.allocations_json)>20 OR (SELECT COUNT(*) FROM lp_purchase_lines WHERE invoice_id=NEW.invoice_id)-1+json_array_length(NEW.allocations_json)>40 THEN RAISE(ABORT,'SPLIT_LIMIT') END;
 SELECT CASE WHEN (SELECT SUM(json_extract(value,'$.quantity_milli')) FROM json_each(NEW.allocations_json))!=NEW.total_quantity_milli OR (SELECT SUM(json_extract(value,'$.net_cents')) FROM json_each(NEW.allocations_json))!=json_extract(NEW.original_json,'$.net_cents') OR (SELECT SUM(json_extract(value,'$.tax_cents')) FROM json_each(NEW.allocations_json))!=json_extract(NEW.original_json,'$.tax_cents') THEN RAISE(ABORT,'SPLIT_TOTAL') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) a LEFT JOIN products p ON p.id=json_extract(a.value,'$.product_id') WHERE p.id IS NULL OR p.stock_unit!=NEW.stock_unit) THEN RAISE(ABORT,'SPLIT_UNIT') END;
 SELECT CASE WHEN NEW.family_id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(NEW.allocations_json) a WHERE NOT EXISTS(SELECT 1 FROM lp_product_family_members m WHERE m.family_id=NEW.family_id AND m.product_id=json_extract(a.value,'$.product_id'))) THEN RAISE(ABORT,'SPLIT_FAMILY') END;
END;
