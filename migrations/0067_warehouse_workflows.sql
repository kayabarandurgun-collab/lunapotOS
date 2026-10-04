-- Saved physical counts. EC only: LP production/material workflows have a different model.
-- Existing migrations and stock/FIFO triggers remain untouched. No CASE in trigger bodies.
CREATE TABLE ec_warehouse_stock_versions(
 product_id TEXT PRIMARY KEY REFERENCES ec_products(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0));
INSERT INTO ec_warehouse_stock_versions(product_id) SELECT product_id FROM ec_stock_balances;
CREATE TRIGGER ec_warehouse_balance_created AFTER INSERT ON ec_stock_balances BEGIN
 INSERT INTO ec_warehouse_stock_versions(product_id) VALUES(NEW.product_id);
END;
CREATE TRIGGER ec_warehouse_balance_changed AFTER UPDATE ON ec_stock_balances BEGIN
 UPDATE ec_warehouse_stock_versions SET revision=revision+1 WHERE product_id=NEW.product_id;
END;

CREATE TABLE ec_warehouse_sessions(
 id TEXT PRIMARY KEY,
 request_key TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 title TEXT NOT NULL,
 created_by TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','reviewed','applied')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 edit_token TEXT,
 review_token TEXT,
 occurred_on TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT,
 applied_at TEXT);
CREATE TABLE ec_warehouse_count_lines(
 session_id TEXT NOT NULL REFERENCES ec_warehouse_sessions(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 product_name TEXT NOT NULL,
 sku TEXT NOT NULL,
 stock_unit TEXT NOT NULL,
 snapshot_quantity_milli INTEGER NOT NULL,
 snapshot_value_cents INTEGER NOT NULL,
 snapshot_revision INTEGER NOT NULL,
 counted_milli INTEGER CHECK(counted_milli IS NULL OR (typeof(counted_milli)='integer' AND counted_milli BETWEEN 0 AND 1000000000)),
 unit_cost_cents INTEGER CHECK(unit_cost_cents IS NULL OR (typeof(unit_cost_cents)='integer' AND unit_cost_cents BETWEEN 0 AND 1000000000)),
 notes TEXT NOT NULL DEFAULT '',
 counted_at TEXT,
 PRIMARY KEY(session_id,product_id));
CREATE INDEX ec_warehouse_sessions_recent ON ec_warehouse_sessions(created_at);
CREATE INDEX ec_warehouse_count_product ON ec_warehouse_count_lines(product_id);
CREATE VIEW ec_warehouse_count_review AS
 SELECT l.*,b.quantity_milli current_quantity_milli,b.value_cents current_value_cents,v.revision current_revision,
 p.stock_unit current_stock_unit,
 COALESCE((SELECT SUM(r.quantity_milli) FROM ec_order_reservations r WHERE r.product_id=l.product_id AND r.released_on IS NULL),0)
 +COALESCE((SELECT SUM(r.quantity_milli) FROM ws_stock_reservations r WHERE r.product_id=l.product_id AND r.released_on IS NULL),0) reserved_milli,
 l.counted_milli-l.snapshot_quantity_milli delta_milli,
 iif(l.counted_milli IS NULL,NULL,iif(l.counted_milli=l.snapshot_quantity_milli,0,
 iif(l.counted_milli>l.snapshot_quantity_milli,CAST(ROUND((l.counted_milli-l.snapshot_quantity_milli)*l.unit_cost_cents/1000.0) AS INTEGER),
 -CAST(ROUND(l.snapshot_value_cents*1.0*(l.snapshot_quantity_milli-l.counted_milli)/MAX(l.snapshot_quantity_milli,1)) AS INTEGER)))) delta_value_cents,
 iif(v.revision IS NOT l.snapshot_revision OR p.stock_unit IS NOT l.stock_unit OR b.quantity_milli IS NOT l.snapshot_quantity_milli OR b.value_cents IS NOT l.snapshot_value_cents,1,0) conflict
 FROM ec_warehouse_count_lines l LEFT JOIN ec_stock_balances b ON b.product_id=l.product_id
 LEFT JOIN ec_warehouse_stock_versions v ON v.product_id=l.product_id LEFT JOIN ec_products p ON p.id=l.product_id;

CREATE TRIGGER ec_warehouse_session_guard BEFORE UPDATE ON ec_warehouse_sessions BEGIN
 SELECT iif(OLD.status='applied',RAISE(ABORT,'WAREHOUSE_APPLIED'),NULL);
 SELECT iif(NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key OR NEW.request_json IS NOT OLD.request_json
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1,RAISE(ABORT,'WAREHOUSE_REVISION'),NULL);
 SELECT iif(NEW.status='applied' AND (OLD.status!='reviewed' OR NEW.review_token IS NOT OLD.review_token OR NEW.review_token IS NULL),RAISE(ABORT,'WAREHOUSE_REVIEW_REQUIRED'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND NEW.occurred_on IS NOT date('now','+3 hours'),RAISE(ABORT,'WAREHOUSE_REVIEW_EXPIRED'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND NOT EXISTS(SELECT 1 FROM ec_warehouse_count_lines WHERE session_id=NEW.id AND counted_milli IS NOT NULL),RAISE(ABORT,'WAREHOUSE_EMPTY'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND EXISTS(SELECT 1 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND counted_milli IS NOT NULL AND conflict=1),RAISE(ABORT,'WAREHOUSE_STOCK_CHANGED'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND EXISTS(SELECT 1 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND counted_milli IS NOT NULL AND current_stock_unit='adet' AND counted_milli%1000!=0),RAISE(ABORT,'WAREHOUSE_UNIT'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND EXISTS(SELECT 1 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND delta_milli>0 AND unit_cost_cents IS NULL),RAISE(ABORT,'WAREHOUSE_COST_REQUIRED'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND EXISTS(SELECT 1 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND counted_milli IS NOT NULL AND counted_milli<reserved_milli),RAISE(ABORT,'WAREHOUSE_RESERVED'),NULL);
 SELECT iif(NEW.status IN('reviewed','applied') AND EXISTS(SELECT 1 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND abs(delta_value_cents)>1000000000000),RAISE(ABORT,'WAREHOUSE_VALUE_LIMIT'),NULL);
END;
CREATE TRIGGER ec_warehouse_line_update_guard BEFORE UPDATE ON ec_warehouse_count_lines BEGIN
 SELECT iif(NEW.counted_milli IS NOT NULL AND NEW.stock_unit='adet' AND NEW.counted_milli%1000!=0,RAISE(ABORT,'WAREHOUSE_UNIT'),NULL);
 SELECT iif(NEW.session_id IS NOT OLD.session_id OR NEW.product_id IS NOT OLD.product_id OR
  (SELECT status FROM ec_warehouse_sessions WHERE id=OLD.session_id)!='draft',RAISE(ABORT,'WAREHOUSE_LINE_LOCKED'),NULL);
END;
CREATE TRIGGER ec_warehouse_line_insert_guard BEFORE INSERT ON ec_warehouse_count_lines BEGIN
 SELECT iif((SELECT status FROM ec_warehouse_sessions WHERE id=NEW.session_id)!='draft',RAISE(ABORT,'WAREHOUSE_LINE_LOCKED'),NULL);
END;
CREATE TRIGGER ec_warehouse_line_no_delete BEFORE DELETE ON ec_warehouse_count_lines BEGIN SELECT RAISE(ABORT,'WAREHOUSE_LINE_LOCKED'); END;
CREATE TRIGGER ec_warehouse_session_no_delete BEFORE DELETE ON ec_warehouse_sessions BEGIN SELECT RAISE(ABORT,'WAREHOUSE_APPLIED'); END;
-- One statement changes the state and posts every difference, or rolls everything back.
-- Uncounted and unchanged rows generate no movement. Existing count loss/FIFO triggers run normally.
CREATE TRIGGER ec_warehouse_apply AFTER UPDATE OF status ON ec_warehouse_sessions WHEN NEW.status='applied' BEGIN
 INSERT INTO ec_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
 SELECT 'warehouse:'||NEW.id||':'||product_id,product_id,delta_milli,delta_value_cents,'count','warehouse:'||NEW.id,
 'Depo sayımı: '||NEW.title||iif(notes='','',' · '||notes),NEW.occurred_on
 FROM ec_warehouse_count_review WHERE session_id=NEW.id AND counted_milli IS NOT NULL AND delta_milli!=0;
END;
CREATE TABLE ec_warehouse_reorder_settings(
 product_id TEXT PRIMARY KEY REFERENCES ec_products(id) ON DELETE CASCADE,
 lead_days INTEGER CHECK(lead_days IS NULL OR (typeof(lead_days)='integer' AND lead_days BETWEEN 0 AND 365)),
 cover_days INTEGER NOT NULL DEFAULT 7 CHECK(typeof(cover_days)='integer' AND cover_days BETWEEN 0 AND 365),
 pack_milli INTEGER NOT NULL CHECK(typeof(pack_milli)='integer' AND pack_milli BETWEEN 1 AND 1000000000),
 notes TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
