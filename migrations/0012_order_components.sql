-- Listings and bundles consume snapshots of real products, never a virtual stock balance.
CREATE TABLE ec_order_line_components(id TEXT PRIMARY KEY,line_id TEXT NOT NULL REFERENCES ec_order_lines(id),product_id TEXT NOT NULL REFERENCES ec_products(id),quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),revenue_share_bps INTEGER NOT NULL CHECK(typeof(revenue_share_bps)='integer' AND revenue_share_bps BETWEEN 0 AND 10000),stock_unit TEXT NOT NULL,sale_id TEXT UNIQUE REFERENCES ec_sale_entries(id),mapping_id TEXT REFERENCES ec_catalog_mappings(id));
CREATE INDEX ec_order_component_line ON ec_order_line_components(line_id);
INSERT INTO ec_order_line_components(id,line_id,product_id,quantity_milli,revenue_share_bps,stock_unit,sale_id) SELECT 'legacy:'||l.id,l.id,l.product_id,l.quantity_milli,10000,p.stock_unit,l.sale_id FROM ec_order_lines l JOIN ec_products p ON p.id=l.product_id;
DROP TRIGGER ec_order_reserve_validate;
DROP TRIGGER ec_order_reserve_apply;
DROP TRIGGER ec_order_release;
DROP TRIGGER ec_stock_reservations_guard;
DROP TRIGGER ec_order_refresh_validate;
ALTER TABLE ec_order_reservations RENAME TO ec_order_reservations_legacy;
CREATE TABLE ec_order_reservations(id TEXT PRIMARY KEY,package_id TEXT NOT NULL REFERENCES ec_order_packages(id),line_id TEXT NOT NULL REFERENCES ec_order_lines(id),component_id TEXT NOT NULL UNIQUE REFERENCES ec_order_line_components(id),product_id TEXT NOT NULL REFERENCES ec_products(id),quantity_milli INTEGER NOT NULL CHECK(quantity_milli>0),released_on TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO ec_order_reservations(id,package_id,line_id,component_id,product_id,quantity_milli,released_on,created_at) SELECT r.id,r.package_id,r.line_id,c.id,r.product_id,r.quantity_milli,r.released_on,r.created_at FROM ec_order_reservations_legacy r JOIN ec_order_line_components c ON c.line_id=r.line_id;
DROP TABLE ec_order_reservations_legacy;
CREATE INDEX ec_order_reservation_product ON ec_order_reservations(product_id,released_on);
CREATE TRIGGER ec_order_component_insert_lock BEFORE INSERT ON ec_order_line_components BEGIN
 SELECT CASE WHEN (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=NEW.line_id)!='draft' THEN RAISE(ABORT,'ORDER_LOCKED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=(SELECT package_id FROM ec_order_lines WHERE id=NEW.line_id))>=20 THEN RAISE(ABORT,'ORDER_COMPONENT_LIMIT') END;
END;
CREATE TRIGGER ec_order_component_update_lock BEFORE UPDATE ON ec_order_line_components WHEN (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=OLD.line_id)!='draft' AND (NEW.id!=OLD.id OR NEW.line_id!=OLD.line_id OR NEW.product_id!=OLD.product_id OR NEW.quantity_milli!=OLD.quantity_milli OR NEW.revenue_share_bps!=OLD.revenue_share_bps OR NEW.stock_unit!=OLD.stock_unit OR NEW.mapping_id IS NOT OLD.mapping_id OR OLD.sale_id IS NOT NULL OR (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=OLD.line_id)!='shipped') BEGIN SELECT RAISE(ABORT,'ORDER_LOCKED'); END;
CREATE TRIGGER ec_order_component_delete_lock BEFORE DELETE ON ec_order_line_components WHEN (SELECT p.status FROM ec_order_lines l JOIN ec_order_packages p ON p.id=l.package_id WHERE l.id=OLD.line_id)!='draft' OR OLD.sale_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'ORDER_LOCKED'); END;
CREATE TRIGGER ec_order_reserve_validate BEFORE UPDATE OF status ON ec_order_packages WHEN NEW.status='reserved' AND OLD.status!='reserved' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id) OR EXISTS(SELECT 1 FROM ec_order_lines l WHERE l.package_id=NEW.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM ec_order_line_components c WHERE c.line_id=l.id)!=10000) THEN RAISE(ABORT,'ORDER_UNMAPPED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=NEW.id)>20 THEN RAISE(ABORT,'ORDER_COMPONENT_LIMIT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id AND net_revenue_cents IS NULL) THEN RAISE(ABORT,'ORDER_MISSING_AMOUNT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_products p ON p.id=c.product_id WHERE l.package_id=NEW.id AND c.stock_unit!=p.stock_unit) THEN RAISE(ABORT,'ORDER_UNIT_CHANGED') END;
 SELECT CASE WHEN EXISTS(SELECT c.product_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_stock_balances b ON b.product_id=c.product_id WHERE l.package_id=NEW.id GROUP BY c.product_id HAVING SUM(c.quantity_milli)+COALESCE((SELECT SUM(r.quantity_milli) FROM ec_order_reservations r WHERE r.product_id=c.product_id AND r.released_on IS NULL),0)>b.quantity_milli) THEN RAISE(ABORT,'ORDER_INSUFFICIENT_STOCK') END;
END;
CREATE TRIGGER ec_order_reserve_apply AFTER UPDATE OF status ON ec_order_packages WHEN NEW.status='reserved' AND OLD.status!='reserved' BEGIN
 INSERT INTO ec_order_reservations(id,package_id,line_id,component_id,product_id,quantity_milli) SELECT c.id,NEW.id,l.id,c.id,c.product_id,c.quantity_milli FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=NEW.id;
END;
CREATE TRIGGER ec_order_component_ship_validate BEFORE UPDATE OF status ON ec_order_packages WHEN NEW.status='shipped' AND OLD.status='reserved' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_products p ON p.id=c.product_id WHERE l.package_id=NEW.id AND c.stock_unit!=p.stock_unit) THEN RAISE(ABORT,'ORDER_UNIT_CHANGED') END;
END;
CREATE TRIGGER ec_order_release AFTER UPDATE OF status ON ec_order_packages WHEN NEW.status IN ('shipped','cancelled') AND OLD.status='reserved' BEGIN UPDATE ec_order_reservations SET released_on=CURRENT_TIMESTAMP WHERE package_id=NEW.id AND released_on IS NULL; END;
CREATE TRIGGER ec_stock_reservations_guard BEFORE INSERT ON ec_stock_movements WHEN NEW.quantity_milli<0 BEGIN
 SELECT CASE WHEN (SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli<COALESCE((SELECT SUM(quantity_milli) FROM ec_order_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0) THEN RAISE(ABORT,'STOCK_RESERVED') END;
END;
ALTER TABLE ec_order_refresh_audit ADD COLUMN old_components_json TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER ec_order_refresh_validate BEFORE INSERT ON ec_order_refresh_audit BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_order_packages p JOIN ec_provider_records r ON r.id=NEW.source_record_id AND r.external_id=p.external_id AND r.provider=p.channel AND r.kind='orders' WHERE p.id=NEW.package_id AND p.status='draft') OR EXISTS(SELECT 1 FROM ec_order_reservations WHERE package_id=NEW.package_id) OR EXISTS(SELECT 1 FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=NEW.package_id AND c.sale_id IS NOT NULL) THEN RAISE(ABORT,'ORDER_REFRESH_BLOCKED') END;
 SELECT CASE WHEN NEW.source_record_id IS NOT (SELECT r.id FROM ec_provider_records r JOIN ec_provider_connections c ON c.provider=r.provider AND c.seller_id=r.seller_id JOIN ec_order_packages p ON p.external_id=r.external_id AND p.channel=r.provider WHERE p.id=NEW.package_id AND r.kind='orders' ORDER BY r.source_updated_at DESC,r.last_seen_at DESC,r.rowid DESC LIMIT 1) THEN RAISE(ABORT,'ORDER_REFRESH_BLOCKED') END;
END;
DROP TRIGGER ec_order_refresh_audit_lock;
CREATE TRIGGER ec_order_refresh_audit_lock BEFORE UPDATE ON ec_order_refresh_audit WHEN OLD.applied!=0 OR NEW.applied!=1 OR NEW.id!=OLD.id OR NEW.package_id!=OLD.package_id OR NEW.source_record_id!=OLD.source_record_id OR NEW.old_package_json!=OLD.old_package_json OR NEW.old_lines_json!=OLD.old_lines_json OR NEW.old_components_json!=OLD.old_components_json OR NEW.new_fingerprint!=OLD.new_fingerprint OR NEW.created_at!=OLD.created_at BEGIN SELECT RAISE(ABORT,'ORDER_REFRESH_AUDIT_LOCKED'); END;
