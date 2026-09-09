-- New, empty e-commerce journals. Existing posted documents remain immutable.
CREATE TABLE ec_purchase_returns (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES ec_purchase_lines(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 net_cents INTEGER NOT NULL CHECK(typeof(net_cents)='integer' AND net_cents>=0),
 tax_cents INTEGER NOT NULL CHECK(typeof(tax_cents)='integer' AND tax_cents>=0),
 cost_cents INTEGER NOT NULL CHECK(typeof(cost_cents)='integer' AND cost_cents>=0),
 operation_id TEXT NOT NULL, reference TEXT NOT NULL, occurred_on TEXT NOT NULL, reason TEXT NOT NULL,
 reversal_of TEXT UNIQUE REFERENCES ec_purchase_returns(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(line_id,reference)
);
CREATE INDEX ec_purchase_returns_line ON ec_purchase_returns(line_id);
CREATE TABLE ec_receipt_reversals (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES ec_goods_receipts(id),
 reference TEXT NOT NULL UNIQUE, occurred_on TEXT NOT NULL, reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE VIEW ec_active_purchase_returns AS SELECT r.* FROM ec_purchase_returns r WHERE r.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ec_purchase_returns x WHERE x.reversal_of=r.id);
CREATE VIEW ec_effective_receipts AS SELECT g.* FROM ec_goods_receipts g WHERE NOT EXISTS(SELECT 1 FROM ec_receipt_reversals x WHERE x.receipt_id=g.id);
CREATE TRIGGER ec_purchase_return_validate BEFORE INSERT ON ec_purchase_returns BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_returns r JOIN ec_purchase_lines l ON l.id=r.line_id WHERE l.invoice_id=(SELECT invoice_id FROM ec_purchase_lines WHERE id=NEW.line_id) AND r.reference=NEW.reference AND r.operation_id!=NEW.operation_id),RAISE(ABORT,'PURCHASE_RETURN_REVERSED'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND l.line_type='product' AND i.status='posted' AND i.invoice_date<=NEW.occurred_on),RAISE(ABORT,'PURCHASE_RETURN_INVALID'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_active_purchase_returns WHERE line_id=NEW.line_id),0)>COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id AND occurred_on<=NEW.occurred_on),0),RAISE(ABORT,'PURCHASE_RETURN_QUANTITY'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND (NEW.net_cents!=(SELECT CAST(ROUND(l.net_cents*(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_active_purchase_returns WHERE line_id=l.id),0))/(l.quantity_milli*1.0)) AS INTEGER)-COALESCE((SELECT SUM(net_cents) FROM ec_active_purchase_returns WHERE line_id=l.id),0) FROM ec_purchase_lines l WHERE l.id=NEW.line_id) OR NEW.tax_cents!=(SELECT CAST(ROUND(l.tax_cents*(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_active_purchase_returns WHERE line_id=l.id),0))/(l.quantity_milli*1.0)) AS INTEGER)-COALESCE((SELECT SUM(tax_cents) FROM ec_active_purchase_returns WHERE line_id=l.id),0) FROM ec_purchase_lines l WHERE l.id=NEW.line_id)),RAISE(ABORT,'PURCHASE_RETURN_VALUE'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND NEW.cost_cents!=(SELECT CAST(ROUND(b.value_cents*1.0*NEW.quantity_milli/MAX(b.quantity_milli,1.0)) AS INTEGER) FROM ec_stock_balances b JOIN ec_purchase_lines l ON l.product_id=b.product_id WHERE l.id=NEW.line_id),RAISE(ABORT,'PURCHASE_RETURN_VALUE'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_active_purchase_returns r WHERE r.id=NEW.reversal_of AND r.line_id=NEW.line_id AND r.quantity_milli=NEW.quantity_milli AND r.net_cents=NEW.net_cents AND r.tax_cents=NEW.tax_cents AND r.cost_cents=NEW.cost_cents AND r.occurred_on<=NEW.occurred_on),RAISE(ABORT,'PURCHASE_RETURN_REVERSED'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE (a.positive_entry_id='purchase-return:'||NEW.reversal_of OR a.negative_entry_id='purchase-return:'||NEW.reversal_of) AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),RAISE(ABORT,'PURCHASE_RETURN_ALLOCATED'),NULL);
END;
CREATE TRIGGER ec_purchase_return_apply AFTER INSERT ON ec_purchase_returns BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT NEW.id,l.product_id,iif(NEW.reversal_of IS NULL,-NEW.quantity_milli,NEW.quantity_milli),iif(NEW.reversal_of IS NULL,-NEW.cost_cents,NEW.cost_cents),'purchase','purchase-return:'||NEW.id,NEW.reference||' · '||NEW.reason,NEW.occurred_on FROM ec_purchase_lines l WHERE l.id=NEW.line_id;
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source) SELECT 'purchase-return:'||NEW.id,i.supplier_id,iif(NEW.reversal_of IS NULL,NEW.net_cents+NEW.tax_cents,-NEW.net_cents-NEW.tax_cents),NEW.occurred_on,NEW.reference,iif(NEW.reversal_of IS NULL,'Alış iadesi · ','Alış iadesi geri alındı · ')||i.invoice_no,'purchase-return:'||NEW.id,'invoice' FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND NEW.net_cents+NEW.tax_cents>0;
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) SELECT 'purchase-return-reverse:'||NEW.id,'purchase-return:'||NEW.reversal_of,'purchase-return:'||NEW.id,NEW.net_cents+NEW.tax_cents,'purchase-return-reverse:'||NEW.id WHERE NEW.reversal_of IS NOT NULL AND NEW.net_cents+NEW.tax_cents>0;
END;
CREATE TRIGGER ec_purchase_returns_no_update BEFORE UPDATE ON ec_purchase_returns BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_purchase_returns_no_delete BEFORE DELETE ON ec_purchase_returns BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_receipt_reversal_validate BEFORE INSERT ON ec_receipt_reversals BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_goods_receipts g WHERE g.id=NEW.receipt_id AND g.occurred_on<=NEW.occurred_on),RAISE(ABORT,'RECEIPT_REVERSAL_INVALID'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_active_purchase_returns r JOIN ec_goods_receipts g ON g.line_id=r.line_id WHERE g.id=NEW.receipt_id),RAISE(ABORT,'RECEIPT_REVERSAL_RETURN'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id JOIN ec_stock_balances b ON b.product_id=l.product_id WHERE g.id=NEW.receipt_id AND (b.value_cents<g.value_cents OR (b.quantity_milli=g.quantity_milli AND b.value_cents!=g.value_cents))),RAISE(ABORT,'RECEIPT_REVERSAL_COST'),NULL);
END;
CREATE TRIGGER ec_receipt_reversal_apply AFTER INSERT ON ec_receipt_reversals BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT NEW.id,l.product_id,-g.quantity_milli,-g.value_cents,'purchase','receipt-reverse:'||NEW.id,NEW.reference||' · '||NEW.reason,NEW.occurred_on FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id WHERE g.id=NEW.receipt_id;
END;
CREATE TRIGGER ec_receipt_reversals_no_update BEFORE UPDATE ON ec_receipt_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_receipt_reversals_no_delete BEFORE DELETE ON ec_receipt_reversals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
DROP TRIGGER ec_receipt_validate;
CREATE TRIGGER ec_receipt_validate BEFORE INSERT ON ec_goods_receipts BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND l.line_type='product' AND i.status='posted' AND i.invoice_date<=NEW.occurred_on),RAISE(ABORT,'RECEIPT_NOT_POSTED'),NULL);
 SELECT iif(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id),0)>(SELECT quantity_milli FROM ec_purchase_lines WHERE id=NEW.line_id),RAISE(ABORT,'RECEIPT_EXCEEDS_INVOICE'),NULL);
 SELECT iif(NEW.value_cents!=(SELECT CAST(ROUND(net_cents*(NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id),0))/(quantity_milli*1.0)) AS INTEGER)-COALESCE((SELECT SUM(value_cents) FROM ec_effective_receipts WHERE line_id=NEW.line_id),0) FROM ec_purchase_lines WHERE id=NEW.line_id),RAISE(ABORT,'RECEIPT_COST_MISMATCH'),NULL);
END;
