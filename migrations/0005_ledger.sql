-- Independent cari, allocations and cash ledgers for each workspace. All amounts are TRY kuruş.

ALTER TABLE ec_suppliers ADD COLUMN kind TEXT NOT NULL DEFAULT 'supplier' CHECK(kind IN ('supplier','customer','marketplace','other'));
ALTER TABLE ec_suppliers ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE ec_suppliers ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE ec_suppliers ADD COLUMN address TEXT NOT NULL DEFAULT '';
CREATE TABLE ec_party_entries(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES ec_suppliers(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0 AND ABS(amount_cents)<=100000000000),
 occurred_on TEXT NOT NULL,due_on TEXT,reference TEXT NOT NULL,description TEXT NOT NULL,
 source_key TEXT NOT NULL UNIQUE,source TEXT NOT NULL CHECK(source IN ('manual','opening','invoice','legacy_payment','cash','reversal')),
 reversal_of TEXT UNIQUE REFERENCES ec_party_entries(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_party_entry_party ON ec_party_entries(party_id,occurred_on);
CREATE TABLE ec_payment_allocations(
 id TEXT PRIMARY KEY,positive_entry_id TEXT NOT NULL REFERENCES ec_party_entries(id),negative_entry_id TEXT NOT NULL REFERENCES ec_party_entries(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),reference TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE ec_allocation_reversals(
 id TEXT PRIMARY KEY,allocation_id TEXT NOT NULL UNIQUE REFERENCES ec_payment_allocations(id),reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER ec_allocate_validate BEFORE INSERT ON ec_payment_allocations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_party_entries p JOIN ec_party_entries n ON n.party_id=p.party_id WHERE p.id=NEW.positive_entry_id AND n.id=NEW.negative_entry_id AND p.amount_cents>0 AND n.amount_cents<0) THEN RAISE(ABORT,'INVALID_ALLOCATION') END;
 SELECT CASE WHEN NEW.amount_cents+COALESCE((SELECT SUM(a.amount_cents) FROM ec_payment_allocations a WHERE a.positive_entry_id=NEW.positive_entry_id AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals r WHERE r.allocation_id=a.id)),0)>(SELECT amount_cents FROM ec_party_entries WHERE id=NEW.positive_entry_id) OR NEW.amount_cents+COALESCE((SELECT SUM(a.amount_cents) FROM ec_payment_allocations a WHERE a.negative_entry_id=NEW.negative_entry_id AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals r WHERE r.allocation_id=a.id)),0)>-(SELECT amount_cents FROM ec_party_entries WHERE id=NEW.negative_entry_id) THEN RAISE(ABORT,'OVER_ALLOCATION') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_party_entries e WHERE (e.id=NEW.positive_entry_id OR e.id=NEW.negative_entry_id) AND e.reversal_of IS NOT NULL AND e.reversal_of NOT IN (NEW.positive_entry_id,NEW.negative_entry_id)) THEN RAISE(ABORT,'REVERSED_ENTRY') END;
END;
CREATE TRIGGER ec_allocation_reverse_validate BEFORE INSERT ON ec_allocation_reversals BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_payment_allocations a JOIN ec_party_entries e ON e.id=a.positive_entry_id OR e.id=a.negative_entry_id WHERE a.id=NEW.allocation_id AND e.reversal_of IS NOT NULL) THEN RAISE(ABORT,'REVERSAL_LOCKED') END;
END;
CREATE TRIGGER ec_entry_reverse_validate BEFORE INSERT ON ec_party_entries WHEN NEW.source='reversal' OR NEW.reversal_of IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_party_entries WHERE reversal_of=NEW.reversal_of) THEN RAISE(ABORT,'INVALID_REVERSAL') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.reversal_of AND e.party_id=NEW.party_id AND e.amount_cents=-NEW.amount_cents AND e.reversal_of IS NULL AND e.source IN ('manual','opening','cash')) OR NEW.source!='reversal' THEN RAISE(ABORT,'INVALID_REVERSAL') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE (a.positive_entry_id=NEW.reversal_of OR a.negative_entry_id=NEW.reversal_of) AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals r WHERE r.allocation_id=a.id)) THEN RAISE(ABORT,'ENTRY_ALLOCATED') END;
END;
CREATE TRIGGER ec_entry_reverse_close AFTER INSERT ON ec_party_entries WHEN NEW.reversal_of IS NOT NULL BEGIN
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES('reverse:'||NEW.id,CASE WHEN NEW.amount_cents>0 THEN NEW.id ELSE NEW.reversal_of END,CASE WHEN NEW.amount_cents<0 THEN NEW.id ELSE NEW.reversal_of END,ABS(NEW.amount_cents),'reverse:'||NEW.id);
END;
CREATE TABLE ec_cash_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('cash','bank')),currency TEXT NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE ec_cash_transactions(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES ec_cash_accounts(id),party_entry_id TEXT UNIQUE REFERENCES ec_party_entries(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0 AND ABS(amount_cents)<=100000000000),
 occurred_on TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,description TEXT NOT NULL,reversal_of TEXT UNIQUE REFERENCES ec_cash_transactions(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_cash_transaction_account ON ec_cash_transactions(account_id,occurred_on);
CREATE TRIGGER ec_cash_validate BEFORE INSERT ON ec_cash_transactions BEGIN
 SELECT CASE WHEN NEW.party_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_party_entries e WHERE e.id=NEW.party_entry_id AND e.amount_cents=-NEW.amount_cents AND e.source IN ('cash','reversal')) THEN RAISE(ABORT,'INVALID_CASH_ENTRY') END;
 SELECT CASE WHEN NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_cash_transactions c LEFT JOIN ec_party_entries e ON e.id=NEW.party_entry_id WHERE c.id=NEW.reversal_of AND c.account_id=NEW.account_id AND c.amount_cents=-NEW.amount_cents AND c.reversal_of IS NULL AND ((c.party_entry_id IS NULL AND NEW.party_entry_id IS NULL) OR e.reversal_of=c.party_entry_id)) THEN RAISE(ABORT,'INVALID_REVERSAL') END;
END;
CREATE TRIGGER ec_invoice_party AFTER UPDATE OF status ON ec_purchase_invoices WHEN NEW.status='posted' BEGIN
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||NEW.id,NEW.supplier_id,-SUM(net_cents+tax_cents),NEW.invoice_date,NEW.invoice_no,'Alış faturası','invoice:'||NEW.id,'invoice' FROM ec_purchase_lines WHERE invoice_id=NEW.id HAVING SUM(net_cents+tax_cents)>0;
END;
CREATE TRIGGER ec_payment_party AFTER INSERT ON ec_supplier_payments WHEN NEW.amount_cents>0 BEGIN
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source) VALUES('payment:'||NEW.id,NEW.supplier_id,NEW.amount_cents,NEW.occurred_on,NEW.reference,NEW.notes,'payment:'||NEW.id,'legacy_payment');
END;
INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||i.id,i.supplier_id,-SUM(l.net_cents+l.tax_cents),i.invoice_date,i.invoice_no,'Alış faturası','invoice:'||i.id,'invoice' FROM ec_purchase_invoices i JOIN ec_purchase_lines l ON l.invoice_id=i.id WHERE i.status='posted' GROUP BY i.id HAVING SUM(l.net_cents+l.tax_cents)>0;
INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'payment:'||id,supplier_id,amount_cents,occurred_on,reference,notes,'payment:'||id,'legacy_payment' FROM ec_supplier_payments WHERE amount_cents>0;

CREATE TRIGGER ec_party_entries_immutable_update BEFORE UPDATE ON ec_party_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_party_entries_immutable_delete BEFORE DELETE ON ec_party_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_payment_allocations_immutable_update BEFORE UPDATE ON ec_payment_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_payment_allocations_immutable_delete BEFORE DELETE ON ec_payment_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_allocation_reversals_immutable_update BEFORE UPDATE ON ec_allocation_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_allocation_reversals_immutable_delete BEFORE DELETE ON ec_allocation_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_cash_transactions_immutable_update BEFORE UPDATE ON ec_cash_transactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_cash_transactions_immutable_delete BEFORE DELETE ON ec_cash_transactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_supplier_payments_immutable_update BEFORE UPDATE ON ec_supplier_payments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER ec_supplier_payments_immutable_delete BEFORE DELETE ON ec_supplier_payments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

ALTER TABLE lp_suppliers ADD COLUMN kind TEXT NOT NULL DEFAULT 'supplier' CHECK(kind IN ('supplier','customer','marketplace','other'));
ALTER TABLE lp_suppliers ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE lp_suppliers ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE lp_suppliers ADD COLUMN address TEXT NOT NULL DEFAULT '';
CREATE TABLE lp_party_entries(
 id TEXT PRIMARY KEY,party_id TEXT NOT NULL REFERENCES lp_suppliers(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0 AND ABS(amount_cents)<=100000000000),
 occurred_on TEXT NOT NULL,due_on TEXT,reference TEXT NOT NULL,description TEXT NOT NULL,
 source_key TEXT NOT NULL UNIQUE,source TEXT NOT NULL CHECK(source IN ('manual','opening','invoice','legacy_payment','cash','reversal')),
 reversal_of TEXT UNIQUE REFERENCES lp_party_entries(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX lp_party_entry_party ON lp_party_entries(party_id,occurred_on);
CREATE TABLE lp_payment_allocations(
 id TEXT PRIMARY KEY,positive_entry_id TEXT NOT NULL REFERENCES lp_party_entries(id),negative_entry_id TEXT NOT NULL REFERENCES lp_party_entries(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),reference TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE lp_allocation_reversals(
 id TEXT PRIMARY KEY,allocation_id TEXT NOT NULL UNIQUE REFERENCES lp_payment_allocations(id),reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER lp_allocate_validate BEFORE INSERT ON lp_payment_allocations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_party_entries p JOIN lp_party_entries n ON n.party_id=p.party_id WHERE p.id=NEW.positive_entry_id AND n.id=NEW.negative_entry_id AND p.amount_cents>0 AND n.amount_cents<0) THEN RAISE(ABORT,'INVALID_ALLOCATION') END;
 SELECT CASE WHEN NEW.amount_cents+COALESCE((SELECT SUM(a.amount_cents) FROM lp_payment_allocations a WHERE a.positive_entry_id=NEW.positive_entry_id AND NOT EXISTS(SELECT 1 FROM lp_allocation_reversals r WHERE r.allocation_id=a.id)),0)>(SELECT amount_cents FROM lp_party_entries WHERE id=NEW.positive_entry_id) OR NEW.amount_cents+COALESCE((SELECT SUM(a.amount_cents) FROM lp_payment_allocations a WHERE a.negative_entry_id=NEW.negative_entry_id AND NOT EXISTS(SELECT 1 FROM lp_allocation_reversals r WHERE r.allocation_id=a.id)),0)>-(SELECT amount_cents FROM lp_party_entries WHERE id=NEW.negative_entry_id) THEN RAISE(ABORT,'OVER_ALLOCATION') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lp_party_entries e WHERE (e.id=NEW.positive_entry_id OR e.id=NEW.negative_entry_id) AND e.reversal_of IS NOT NULL AND e.reversal_of NOT IN (NEW.positive_entry_id,NEW.negative_entry_id)) THEN RAISE(ABORT,'REVERSED_ENTRY') END;
END;
CREATE TRIGGER lp_allocation_reverse_validate BEFORE INSERT ON lp_allocation_reversals BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lp_payment_allocations a JOIN lp_party_entries e ON e.id=a.positive_entry_id OR e.id=a.negative_entry_id WHERE a.id=NEW.allocation_id AND e.reversal_of IS NOT NULL) THEN RAISE(ABORT,'REVERSAL_LOCKED') END;
END;
CREATE TRIGGER lp_entry_reverse_validate BEFORE INSERT ON lp_party_entries WHEN NEW.source='reversal' OR NEW.reversal_of IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lp_party_entries WHERE reversal_of=NEW.reversal_of) THEN RAISE(ABORT,'INVALID_REVERSAL') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_party_entries e WHERE e.id=NEW.reversal_of AND e.party_id=NEW.party_id AND e.amount_cents=-NEW.amount_cents AND e.reversal_of IS NULL AND e.source IN ('manual','opening','cash')) OR NEW.source!='reversal' THEN RAISE(ABORT,'INVALID_REVERSAL') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lp_payment_allocations a WHERE (a.positive_entry_id=NEW.reversal_of OR a.negative_entry_id=NEW.reversal_of) AND NOT EXISTS(SELECT 1 FROM lp_allocation_reversals r WHERE r.allocation_id=a.id)) THEN RAISE(ABORT,'ENTRY_ALLOCATED') END;
END;
CREATE TRIGGER lp_entry_reverse_close AFTER INSERT ON lp_party_entries WHEN NEW.reversal_of IS NOT NULL BEGIN
 INSERT INTO lp_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) VALUES('reverse:'||NEW.id,CASE WHEN NEW.amount_cents>0 THEN NEW.id ELSE NEW.reversal_of END,CASE WHEN NEW.amount_cents<0 THEN NEW.id ELSE NEW.reversal_of END,ABS(NEW.amount_cents),'reverse:'||NEW.id);
END;
CREATE TABLE lp_cash_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('cash','bank')),currency TEXT NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE lp_cash_transactions(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES lp_cash_accounts(id),party_entry_id TEXT UNIQUE REFERENCES lp_party_entries(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0 AND ABS(amount_cents)<=100000000000),
 occurred_on TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,description TEXT NOT NULL,reversal_of TEXT UNIQUE REFERENCES lp_cash_transactions(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX lp_cash_transaction_account ON lp_cash_transactions(account_id,occurred_on);
CREATE TRIGGER lp_cash_validate BEFORE INSERT ON lp_cash_transactions BEGIN
 SELECT CASE WHEN NEW.party_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lp_party_entries e WHERE e.id=NEW.party_entry_id AND e.amount_cents=-NEW.amount_cents AND e.source IN ('cash','reversal')) THEN RAISE(ABORT,'INVALID_CASH_ENTRY') END;
 SELECT CASE WHEN NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lp_cash_transactions c LEFT JOIN lp_party_entries e ON e.id=NEW.party_entry_id WHERE c.id=NEW.reversal_of AND c.account_id=NEW.account_id AND c.amount_cents=-NEW.amount_cents AND c.reversal_of IS NULL AND ((c.party_entry_id IS NULL AND NEW.party_entry_id IS NULL) OR e.reversal_of=c.party_entry_id)) THEN RAISE(ABORT,'INVALID_REVERSAL') END;
END;
CREATE TRIGGER lp_invoice_party AFTER UPDATE OF status ON lp_purchase_invoices WHEN NEW.status='posted' BEGIN
 INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||NEW.id,NEW.supplier_id,-SUM(net_cents+tax_cents),NEW.invoice_date,NEW.invoice_no,'Alış faturası','invoice:'||NEW.id,'invoice' FROM lp_purchase_lines WHERE invoice_id=NEW.id HAVING SUM(net_cents+tax_cents)>0;
END;
CREATE TRIGGER lp_payment_party AFTER INSERT ON lp_supplier_payments WHEN NEW.amount_cents>0 BEGIN
 INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source) VALUES('payment:'||NEW.id,NEW.supplier_id,NEW.amount_cents,NEW.occurred_on,NEW.reference,NEW.notes,'payment:'||NEW.id,'legacy_payment');
END;
INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'invoice:'||i.id,i.supplier_id,-SUM(l.net_cents+l.tax_cents),i.invoice_date,i.invoice_no,'Alış faturası','invoice:'||i.id,'invoice' FROM lp_purchase_invoices i JOIN lp_purchase_lines l ON l.invoice_id=i.id WHERE i.status='posted' GROUP BY i.id HAVING SUM(l.net_cents+l.tax_cents)>0;
INSERT INTO lp_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source)
 SELECT 'payment:'||id,supplier_id,amount_cents,occurred_on,reference,notes,'payment:'||id,'legacy_payment' FROM lp_supplier_payments WHERE amount_cents>0;

CREATE TRIGGER lp_party_entries_immutable_update BEFORE UPDATE ON lp_party_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_party_entries_immutable_delete BEFORE DELETE ON lp_party_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_payment_allocations_immutable_update BEFORE UPDATE ON lp_payment_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_payment_allocations_immutable_delete BEFORE DELETE ON lp_payment_allocations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_allocation_reversals_immutable_update BEFORE UPDATE ON lp_allocation_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_allocation_reversals_immutable_delete BEFORE DELETE ON lp_allocation_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_cash_transactions_immutable_update BEFORE UPDATE ON lp_cash_transactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_cash_transactions_immutable_delete BEFORE DELETE ON lp_cash_transactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_supplier_payments_immutable_update BEFORE UPDATE ON lp_supplier_payments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TRIGGER lp_supplier_payments_immutable_delete BEFORE DELETE ON lp_supplier_payments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
