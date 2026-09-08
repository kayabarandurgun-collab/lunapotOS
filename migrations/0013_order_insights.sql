-- Local document drafts only. This table never represents an issued GIB/EDM invoice.
CREATE TABLE ec_sales_invoice_drafts(id TEXT PRIMARY KEY,package_id TEXT NOT NULL REFERENCES ec_order_packages(id),version INTEGER NOT NULL CHECK(version>0),status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'),snapshot_json TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(package_id,version),UNIQUE(package_id,fingerprint));
CREATE INDEX ec_sales_invoice_draft_package ON ec_sales_invoice_drafts(package_id,version);
CREATE TRIGGER ec_sales_invoice_draft_no_update BEFORE UPDATE ON ec_sales_invoice_drafts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INVOICE_DRAFT'); END;
CREATE TRIGGER ec_sales_invoice_draft_no_delete BEFORE DELETE ON ec_sales_invoice_drafts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INVOICE_DRAFT'); END;
