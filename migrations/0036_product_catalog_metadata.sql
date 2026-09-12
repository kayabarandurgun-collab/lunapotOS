-- Product identity only: never creates stock or accounting entries.
ALTER TABLE ec_products ADD COLUMN brand TEXT NOT NULL DEFAULT '' CHECK(length(brand)<=100);
ALTER TABLE ec_products ADD COLUMN supplier_id TEXT REFERENCES ec_suppliers(id) ON DELETE RESTRICT;
CREATE INDEX ec_products_brand_category ON ec_products(brand,category);
