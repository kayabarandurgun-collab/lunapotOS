CREATE TABLE lp_suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL,tax_id TEXT UNIQUE,contact TEXT NOT NULL DEFAULT '');
CREATE TABLE lp_stock_balances(product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK(quantity_milli>=0),value_cents INTEGER NOT NULL DEFAULT 0 CHECK(value_cents>=0));
INSERT INTO lp_stock_balances(product_id) SELECT id FROM products;
CREATE TRIGGER lp_stock_product AFTER INSERT ON products BEGIN INSERT INTO lp_stock_balances(product_id) VALUES(NEW.id); END;
CREATE TABLE lp_stock_movements(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,quantity_milli INTEGER NOT NULL CHECK(quantity_milli!=0),value_cents INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('opening','count','purchase','sale','return')),reference TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',occurred_on TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(kind,reference,product_id));
CREATE INDEX lp_stock_movements_product ON lp_stock_movements(product_id,created_at);
CREATE TRIGGER lp_stock_nonnegative BEFORE INSERT ON lp_stock_movements BEGIN
 SELECT CASE WHEN (SELECT quantity_milli FROM lp_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli<0 THEN RAISE(ABORT,'INSUFFICIENT_STOCK') END;
 SELECT CASE WHEN (SELECT value_cents FROM lp_stock_balances WHERE product_id=NEW.product_id)+NEW.value_cents<0 THEN RAISE(ABORT,'INVALID_STOCK_VALUE') END;
END;
CREATE TRIGGER lp_stock_apply AFTER INSERT ON lp_stock_movements BEGIN UPDATE lp_stock_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE product_id=NEW.product_id; END;
CREATE TRIGGER lp_stock_immutable_update BEFORE UPDATE ON lp_stock_movements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_stock_immutable_delete BEFORE DELETE ON lp_stock_movements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TABLE lp_sale_entries(id TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN ('trendyol','hepsiburada','other')),external_id TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,kind TEXT NOT NULL CHECK(kind IN ('sale','return')),parent_id TEXT REFERENCES lp_sale_entries(id),quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),revenue_cents INTEGER NOT NULL,cost_cents INTEGER NOT NULL,commission_cents INTEGER,shipping_cents INTEGER,other_cents INTEGER,fees_status TEXT NOT NULL CHECK(fees_status IN ('pending','confirmed')),restock INTEGER NOT NULL DEFAULT 0 CHECK(restock IN (0,1)),occurred_on TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(channel,external_id));
CREATE INDEX lp_sale_entries_date ON lp_sale_entries(occurred_on,channel);
CREATE INDEX lp_sale_entries_parent ON lp_sale_entries(parent_id);
CREATE TRIGGER lp_return_limit BEFORE INSERT ON lp_sale_entries WHEN NEW.kind='return' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_sale_entries WHERE id=NEW.parent_id AND kind='sale' AND product_id=NEW.product_id AND channel=NEW.channel) THEN RAISE(ABORT,'INVALID_RETURN') END;
 SELECT CASE WHEN NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM lp_sale_entries WHERE parent_id=NEW.parent_id),0)>(SELECT quantity_milli FROM lp_sale_entries WHERE id=NEW.parent_id) THEN RAISE(ABORT,'RETURN_EXCEEDS_SALE') END;
 SELECT CASE WHEN -NEW.revenue_cents-COALESCE((SELECT SUM(revenue_cents) FROM lp_sale_entries WHERE parent_id=NEW.parent_id),0)>(SELECT revenue_cents FROM lp_sale_entries WHERE id=NEW.parent_id) THEN RAISE(ABORT,'REFUND_EXCEEDS_SALE') END;
END;
CREATE TRIGGER lp_sale_stock AFTER INSERT ON lp_sale_entries WHEN NEW.kind='sale' BEGIN
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(NEW.id,NEW.product_id,-NEW.quantity_milli,-NEW.cost_cents,'sale',NEW.id,NEW.external_id,NEW.occurred_on);
END;
CREATE TRIGGER lp_return_stock AFTER INSERT ON lp_sale_entries WHEN NEW.kind='return' AND NEW.restock=1 BEGIN
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) VALUES(NEW.id,NEW.product_id,NEW.quantity_milli,-NEW.cost_cents,'return',NEW.id,NEW.external_id,NEW.occurred_on);
END;
CREATE TABLE lp_expenses(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,category TEXT NOT NULL CHECK(category IN ('shipping','commission','advertising','rent','packaging','loss','other')),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),occurred_on TEXT NOT NULL,paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)),notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER lp_count_loss AFTER INSERT ON lp_stock_movements WHEN NEW.kind='count' AND NEW.value_cents<0 BEGIN
 INSERT INTO lp_expenses(id,reference,category,amount_cents,occurred_on,paid,notes) VALUES(NEW.id,'count:'||NEW.id,'loss',-NEW.value_cents,NEW.occurred_on,0,NEW.notes);
END;
CREATE TABLE lp_purchase_invoices(id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL REFERENCES lp_suppliers(id),invoice_no TEXT NOT NULL,uuid TEXT UNIQUE,invoice_date TEXT NOT NULL,currency TEXT NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),source TEXT NOT NULL DEFAULT 'manual',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(supplier_id,invoice_no));
CREATE TABLE lp_purchase_lines(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES lp_purchase_invoices(id),description TEXT NOT NULL,external_code TEXT NOT NULL DEFAULT '',invoice_quantity REAL NOT NULL CHECK(invoice_quantity>0),invoice_unit TEXT NOT NULL,product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,quantity_milli INTEGER CHECK(quantity_milli>0),net_cents INTEGER NOT NULL CHECK(net_cents>=0),tax_cents INTEGER NOT NULL CHECK(tax_cents>=0));
CREATE INDEX lp_purchase_lines_invoice ON lp_purchase_lines(invoice_id);
CREATE TRIGGER lp_invoice_validate BEFORE UPDATE OF status ON lp_purchase_invoices WHEN NEW.status='posted' BEGIN
 SELECT CASE WHEN OLD.status!='draft' THEN RAISE(ABORT,'INVOICE_ALREADY_HANDLED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_purchase_lines WHERE invoice_id=NEW.id) OR EXISTS(SELECT 1 FROM lp_purchase_lines WHERE invoice_id=NEW.id AND (product_id IS NULL OR quantity_milli IS NULL)) THEN RAISE(ABORT,'UNMAPPED_INVOICE') END;
END;
CREATE TRIGGER lp_invoice_stock AFTER UPDATE OF status ON lp_purchase_invoices WHEN NEW.status='posted' BEGIN
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT id,product_id,quantity_milli,net_cents,'purchase',id,NEW.invoice_no,NEW.invoice_date FROM lp_purchase_lines WHERE invoice_id=NEW.id;
END;
CREATE TRIGGER lp_invoice_lock BEFORE UPDATE ON lp_purchase_invoices WHEN OLD.status!='draft' BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INVOICE'); END;
CREATE TRIGGER lp_invoice_line_lock BEFORE UPDATE ON lp_purchase_lines WHEN (SELECT status FROM lp_purchase_invoices WHERE id=OLD.invoice_id)!='draft' BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INVOICE'); END;
CREATE TABLE lp_integration_runs(id TEXT PRIMARY KEY,provider TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,record_count INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE lp_supplier_payments(id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL REFERENCES lp_suppliers(id),reference TEXT NOT NULL UNIQUE,amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),occurred_on TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE lp_fee_audit(id TEXT PRIMARY KEY,sale_id TEXT NOT NULL REFERENCES lp_sale_entries(id),old_values TEXT NOT NULL,new_values TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
