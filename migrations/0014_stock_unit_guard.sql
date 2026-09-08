-- The database guard closes a concurrent mapping/save race in the API check.
CREATE TRIGGER ec_product_unit_history_guard BEFORE UPDATE OF stock_unit ON ec_products WHEN NEW.stock_unit IS NOT OLD.stock_unit BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_catalog_mapping_components WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM ec_order_line_components WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM ec_stock_movements WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM ec_purchase_lines WHERE product_id=OLD.id) THEN RAISE(ABORT,'PRODUCT_UNIT_LOCKED') END;
END;
CREATE TRIGGER lp_product_unit_history_guard BEFORE UPDATE OF stock_unit ON products WHEN NEW.stock_unit IS NOT OLD.stock_unit BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM lp_catalog_mapping_components WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM lp_stock_movements WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM lp_purchase_lines WHERE product_id=OLD.id) THEN RAISE(ABORT,'PRODUCT_UNIT_LOCKED') END;
END;
