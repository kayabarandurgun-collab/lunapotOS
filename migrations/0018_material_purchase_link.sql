-- A material's purchasing card and recipe card share one physical inventory.
ALTER TABLE products ADD COLUMN inventory_kind TEXT NOT NULL DEFAULT 'finished' CHECK(inventory_kind IN ('finished','material'));
ALTER TABLE materials ADD COLUMN purchase_product_id TEXT REFERENCES products(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX material_purchase_card ON materials(purchase_product_id) WHERE purchase_product_id IS NOT NULL;
INSERT INTO products(id,name,sku,category,stock_unit,inventory_kind) SELECT 'raw-'||id,name,'HAM-'||id,'Hammadde',unit,'material' FROM materials;
UPDATE materials SET purchase_product_id='raw-'||id;
-- Carry forward existing manual material balances once, before enabling mirroring.
INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on) SELECT 'raw-initial-'||m.id,m.purchase_product_id,b.quantity_milli,b.value_cents,'opening','raw-initial-'||m.id,'Önceki hammadde defterinden aktarım',date('now') FROM materials m JOIN lp_material_balances b ON b.material_id=m.id WHERE b.quantity_milli>0;
DROP TRIGGER lp_material_create;
CREATE TRIGGER lp_material_create AFTER INSERT ON materials BEGIN
 INSERT INTO lp_material_balances(material_id) VALUES(NEW.id);
 INSERT INTO products(id,name,sku,category,stock_unit,inventory_kind) VALUES('raw-'||NEW.id,NEW.name,'HAM-'||NEW.id,'Hammadde',NEW.unit,'material');
 UPDATE materials SET purchase_product_id='raw-'||NEW.id WHERE id=NEW.id;
END;
CREATE TRIGGER lp_material_card_update AFTER UPDATE OF name,unit ON materials BEGIN UPDATE products SET name=NEW.name,stock_unit=NEW.unit WHERE id=NEW.purchase_product_id; END;
CREATE TRIGGER lp_material_card_delete AFTER DELETE ON materials BEGIN DELETE FROM lp_stock_balances WHERE product_id=OLD.purchase_product_id AND quantity_milli=0 AND value_cents=0; DELETE FROM products WHERE id=OLD.purchase_product_id; END;
CREATE TRIGGER lp_material_card_lock BEFORE UPDATE OF purchase_product_id ON materials WHEN OLD.purchase_product_id IS NOT NULL AND NEW.purchase_product_id IS NOT OLD.purchase_product_id BEGIN SELECT RAISE(ABORT,'MATERIAL_CARD_LOCKED'); END;
DROP TRIGGER lp_material_apply;
CREATE TRIGGER lp_material_apply AFTER INSERT ON lp_material_movements BEGIN
 UPDATE lp_material_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE material_id=NEW.material_id;
 INSERT INTO lp_stock_movements(id,product_id,quantity_milli,value_cents,kind,reference,notes,occurred_on,origin)
 SELECT NEW.id,purchase_product_id,NEW.quantity_milli,NEW.value_cents,iif(NEW.kind='opening','opening',iif(NEW.kind='count','count','purchase')),'material:'||NEW.reference,NEW.notes,NEW.occurred_on,iif(NEW.kind IN ('consume','reverse'),'production','manual') FROM materials WHERE id=NEW.material_id AND NOT EXISTS(SELECT 1 FROM lp_stock_movements WHERE id=NEW.id);
END;
CREATE TRIGGER lp_stock_to_material AFTER INSERT ON lp_stock_movements WHEN NOT EXISTS(SELECT 1 FROM lp_material_movements WHERE id=NEW.id) BEGIN
 INSERT INTO lp_material_movements(id,material_id,quantity_milli,value_cents,kind,reference,notes,occurred_on)
 SELECT NEW.id,id,NEW.quantity_milli,NEW.value_cents,iif(NEW.kind='opening','opening',iif(NEW.kind='count','count',iif(NEW.quantity_milli<0,'consume','receipt'))),'stock:'||NEW.id,NEW.notes,NEW.occurred_on FROM materials WHERE purchase_product_id=NEW.product_id;
END;
