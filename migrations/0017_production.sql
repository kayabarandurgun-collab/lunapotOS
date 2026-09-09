-- Raw material stock and completed production batches are independent of ecommerce.
CREATE TABLE lp_material_balances(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE RESTRICT,quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK(quantity_milli>=0),value_cents INTEGER NOT NULL DEFAULT 0 CHECK(value_cents>=0));
INSERT INTO lp_material_balances(material_id) SELECT id FROM materials;
CREATE TRIGGER lp_material_create AFTER INSERT ON materials BEGIN INSERT INTO lp_material_balances(material_id) VALUES(NEW.id); END;
CREATE TABLE lp_material_movements(id TEXT PRIMARY KEY,material_id TEXT NOT NULL REFERENCES materials(id),quantity_milli INTEGER NOT NULL CHECK(quantity_milli!=0),value_cents INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('opening','receipt','count','consume','reverse')),reference TEXT NOT NULL,notes TEXT NOT NULL,occurred_on TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(material_id,reference));
CREATE INDEX lp_material_history ON lp_material_movements(material_id,created_at);
CREATE TRIGGER lp_material_validate BEFORE INSERT ON lp_material_movements BEGIN
 SELECT CASE WHEN NEW.quantity_milli+(SELECT quantity_milli FROM lp_material_balances WHERE material_id=NEW.material_id)<0 OR NEW.value_cents+(SELECT value_cents FROM lp_material_balances WHERE material_id=NEW.material_id)<0 THEN RAISE(ABORT,'MATERIAL_STOCK_INSUFFICIENT') END;
 SELECT CASE WHEN NEW.kind='opening' AND EXISTS(SELECT 1 FROM lp_material_movements WHERE material_id=NEW.material_id) THEN RAISE(ABORT,'MATERIAL_OPENING_EXISTS') END;
END;
CREATE TRIGGER lp_material_apply AFTER INSERT ON lp_material_movements BEGIN
 UPDATE lp_material_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE material_id=NEW.material_id;
 INSERT INTO lp_expenses(id,reference,category,amount_cents,occurred_on,paid,notes) SELECT NEW.id,'material-count:'||NEW.id,'loss',-NEW.value_cents,NEW.occurred_on,0,NEW.notes WHERE NEW.kind='count' AND NEW.value_cents<0;
END;
CREATE TRIGGER lp_material_no_update BEFORE UPDATE ON lp_material_movements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_material_no_delete BEFORE DELETE ON lp_material_movements BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_material_unit_guard BEFORE UPDATE OF unit ON materials WHEN NEW.unit!=OLD.unit AND EXISTS(SELECT 1 FROM lp_material_movements WHERE material_id=OLD.id) BEGIN SELECT RAISE(ABORT,'MATERIAL_UNIT_LOCKED'); END;
CREATE TABLE lp_production_jobs(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,product_id TEXT NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,recipe_json TEXT NOT NULL CHECK(json_valid(recipe_json)),quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),labor_cents INTEGER NOT NULL CHECK(labor_cents>=0),packaging_cents INTEGER NOT NULL CHECK(packaging_cents>=0),overhead_cents INTEGER NOT NULL CHECK(overhead_cents>=0),total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents>=0),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','reversed')),occurred_on TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',reversed_on TEXT,reversal_reason TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE lp_production_items(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES lp_production_jobs(id),material_id TEXT NOT NULL REFERENCES materials(id),material_name TEXT NOT NULL,unit TEXT NOT NULL,planned_milli INTEGER NOT NULL CHECK(planned_milli>0),actual_milli INTEGER NOT NULL CHECK(actual_milli>0),cost_cents INTEGER NOT NULL CHECK(cost_cents>=0),stock_quantity_milli INTEGER NOT NULL,stock_value_cents INTEGER NOT NULL,UNIQUE(job_id,material_id));
CREATE INDEX lp_production_items_job ON lp_production_items(job_id);
CREATE TRIGGER lp_production_item_validate BEFORE INSERT ON lp_production_items BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM lp_production_jobs WHERE id=NEW.job_id AND status='draft') OR NOT EXISTS(SELECT 1 FROM lp_material_balances b JOIN materials m ON m.id=b.material_id WHERE m.id=NEW.material_id AND m.unit=NEW.unit AND b.quantity_milli=NEW.stock_quantity_milli AND b.value_cents=NEW.stock_value_cents AND b.quantity_milli>=NEW.actual_milli) THEN RAISE(ABORT,'PRODUCTION_STOCK_CHANGED') END;
END;
CREATE TRIGGER lp_production_item_no_update BEFORE UPDATE ON lp_production_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_production_item_no_delete BEFORE DELETE ON lp_production_items BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER lp_production_validate BEFORE UPDATE ON lp_production_jobs BEGIN
 SELECT CASE WHEN NOT ((OLD.status='draft' AND NEW.status='posted') OR (OLD.status='posted' AND NEW.status='reversed' AND length(NEW.reversal_reason)>0 AND NEW.reversed_on>=OLD.occurred_on)) OR NEW.reference!=OLD.reference OR NEW.product_id!=OLD.product_id OR NEW.product_name!=OLD.product_name OR NEW.recipe_json!=OLD.recipe_json OR NEW.quantity_milli!=OLD.quantity_milli OR NEW.labor_cents!=OLD.labor_cents OR NEW.packaging_cents!=OLD.packaging_cents OR NEW.overhead_cents!=OLD.overhead_cents OR NEW.total_cost_cents!=OLD.total_cost_cents OR NEW.occurred_on!=OLD.occurred_on OR NEW.notes!=OLD.notes THEN RAISE(ABORT,'PRODUCTION_LOCKED') END;
 SELECT CASE WHEN NEW.status='posted' AND ((SELECT COUNT(*) FROM lp_production_items WHERE job_id=NEW.id)<1 OR NEW.total_cost_cents!=NEW.labor_cents+NEW.packaging_cents+NEW.overhead_cents+(SELECT SUM(cost_cents) FROM lp_production_items WHERE job_id=NEW.id)) THEN RAISE(ABORT,'PRODUCTION_TOTAL') END;
END;
ALTER TABLE lp_stock_movements ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','production'));
CREATE TRIGGER lp_production_apply AFTER UPDATE OF status ON lp_production_jobs WHEN NEW.status='posted' BEGIN
 INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT id,material_id,-actual_milli,-cost_cents,'consume','production:'||NEW.id,NEW.reference,NEW.occurred_on FROM lp_production_items WHERE job_id=NEW.id;
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on,origin) VALUES('production:'||NEW.id,NEW.product_id,NEW.quantity_milli,NEW.total_cost_cents,'purchase','production:'||NEW.id,'Üretim: '||NEW.reference,NEW.occurred_on,'production');
END;
CREATE TRIGGER lp_production_reverse AFTER UPDATE OF status ON lp_production_jobs WHEN NEW.status='reversed' BEGIN
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on,origin) VALUES('production-reverse:'||NEW.id,NEW.product_id,-NEW.quantity_milli,-NEW.total_cost_cents,'purchase','production-reverse:'||NEW.id,'Üretim düzeltmesi: '||NEW.reference||' / '||NEW.reversal_reason,NEW.reversed_on,'production');
 INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT 'reverse:'||id,material_id,actual_milli,cost_cents,'reverse','production-reverse:'||NEW.id,NEW.reversal_reason,NEW.reversed_on FROM lp_production_items WHERE job_id=NEW.id;
END;
CREATE TRIGGER lp_production_no_delete BEFORE DELETE ON lp_production_jobs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
