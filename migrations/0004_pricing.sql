CREATE TABLE ec_price_profiles (
 product_id TEXT PRIMARY KEY REFERENCES ec_products(id) ON DELETE RESTRICT,
 vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),
 replacement_cost_cents INTEGER NOT NULL CHECK(replacement_cost_cents>=0),
 packaging_cents INTEGER NOT NULL CHECK(packaging_cents>=0),
 other_cents INTEGER NOT NULL CHECK(other_cents>=0),
 withholding_bps INTEGER NOT NULL CHECK(withholding_bps BETWEEN 0 AND 10000),
 length_mm INTEGER NOT NULL CHECK(length_mm>0),width_mm INTEGER NOT NULL CHECK(width_mm>0),height_mm INTEGER NOT NULL CHECK(height_mm>0),
 weight_grams INTEGER NOT NULL CHECK(weight_grams>0),units_per_parcel INTEGER NOT NULL CHECK(units_per_parcel>0),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ec_shipping_rates (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, channel TEXT NOT NULL, carrier TEXT NOT NULL,
 valid_from TEXT NOT NULL,valid_to TEXT NOT NULL CHECK(valid_to>=valid_from),
 price_min_cents INTEGER NOT NULL CHECK(price_min_cents>=0),price_max_cents INTEGER CHECK(price_max_cents>price_min_cents),
 billable_min_milli INTEGER NOT NULL CHECK(billable_min_milli>=0),billable_max_milli INTEGER CHECK(billable_max_milli>billable_min_milli),
 desi_divisor INTEGER NOT NULL CHECK(desi_divisor>0),billable_step_milli INTEGER NOT NULL CHECK(billable_step_milli>0),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),
 tax_included INTEGER NOT NULL CHECK(tax_included IN(0,1)),source TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,archived_at TEXT
);
CREATE TABLE ec_commission_rates (
 id TEXT PRIMARY KEY,label TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',
 valid_from TEXT NOT NULL,valid_to TEXT NOT NULL CHECK(valid_to>=valid_from),
 price_min_cents INTEGER NOT NULL CHECK(price_min_cents>=0),price_max_cents INTEGER CHECK(price_max_cents>price_min_cents),
 rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),base TEXT NOT NULL CHECK(base IN('net','gross')),
 vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),tax_included INTEGER NOT NULL CHECK(tax_included IN(0,1)),source TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,archived_at TEXT
);
CREATE INDEX ec_shipping_effective ON ec_shipping_rates(channel,carrier,valid_from,valid_to);
CREATE INDEX ec_commission_effective ON ec_commission_rates(channel,valid_from,valid_to);
CREATE TRIGGER ec_shipping_immutable BEFORE UPDATE ON ec_shipping_rates WHEN NEW.id IS NOT OLD.id OR NEW.label IS NOT OLD.label OR NEW.channel IS NOT OLD.channel OR NEW.carrier IS NOT OLD.carrier OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_to IS NOT OLD.valid_to OR NEW.price_min_cents IS NOT OLD.price_min_cents OR NEW.price_max_cents IS NOT OLD.price_max_cents OR NEW.billable_min_milli IS NOT OLD.billable_min_milli OR NEW.billable_max_milli IS NOT OLD.billable_max_milli OR NEW.desi_divisor IS NOT OLD.desi_divisor OR NEW.billable_step_milli IS NOT OLD.billable_step_milli OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.vat_bps IS NOT OLD.vat_bps OR NEW.tax_included IS NOT OLD.tax_included OR NEW.source IS NOT OLD.source OR OLD.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER ec_shipping_no_delete BEFORE DELETE ON ec_shipping_rates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER ec_commission_immutable BEFORE UPDATE ON ec_commission_rates WHEN NEW.id IS NOT OLD.id OR NEW.label IS NOT OLD.label OR NEW.channel IS NOT OLD.channel OR NEW.sku IS NOT OLD.sku OR NEW.category IS NOT OLD.category OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_to IS NOT OLD.valid_to OR NEW.price_min_cents IS NOT OLD.price_min_cents OR NEW.price_max_cents IS NOT OLD.price_max_cents OR NEW.rate_bps IS NOT OLD.rate_bps OR NEW.base IS NOT OLD.base OR NEW.vat_bps IS NOT OLD.vat_bps OR NEW.tax_included IS NOT OLD.tax_included OR NEW.source IS NOT OLD.source OR OLD.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER ec_commission_no_delete BEFORE DELETE ON ec_commission_rates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;

CREATE TABLE lp_price_profiles (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
 vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),
 replacement_cost_cents INTEGER NOT NULL CHECK(replacement_cost_cents>=0),
 packaging_cents INTEGER NOT NULL CHECK(packaging_cents>=0),
 other_cents INTEGER NOT NULL CHECK(other_cents>=0),
 withholding_bps INTEGER NOT NULL CHECK(withholding_bps BETWEEN 0 AND 10000),
 length_mm INTEGER NOT NULL CHECK(length_mm>0),width_mm INTEGER NOT NULL CHECK(width_mm>0),height_mm INTEGER NOT NULL CHECK(height_mm>0),
 weight_grams INTEGER NOT NULL CHECK(weight_grams>0),units_per_parcel INTEGER NOT NULL CHECK(units_per_parcel>0),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE lp_shipping_rates (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, channel TEXT NOT NULL, carrier TEXT NOT NULL,
 valid_from TEXT NOT NULL,valid_to TEXT NOT NULL CHECK(valid_to>=valid_from),
 price_min_cents INTEGER NOT NULL CHECK(price_min_cents>=0),price_max_cents INTEGER CHECK(price_max_cents>price_min_cents),
 billable_min_milli INTEGER NOT NULL CHECK(billable_min_milli>=0),billable_max_milli INTEGER CHECK(billable_max_milli>billable_min_milli),
 desi_divisor INTEGER NOT NULL CHECK(desi_divisor>0),billable_step_milli INTEGER NOT NULL CHECK(billable_step_milli>0),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),
 tax_included INTEGER NOT NULL CHECK(tax_included IN(0,1)),source TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,archived_at TEXT
);
CREATE TABLE lp_commission_rates (
 id TEXT PRIMARY KEY,label TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',
 valid_from TEXT NOT NULL,valid_to TEXT NOT NULL CHECK(valid_to>=valid_from),
 price_min_cents INTEGER NOT NULL CHECK(price_min_cents>=0),price_max_cents INTEGER CHECK(price_max_cents>price_min_cents),
 rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),base TEXT NOT NULL CHECK(base IN('net','gross')),
 vat_bps INTEGER NOT NULL CHECK(vat_bps BETWEEN 0 AND 10000),tax_included INTEGER NOT NULL CHECK(tax_included IN(0,1)),source TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,archived_at TEXT
);
CREATE INDEX lp_shipping_effective ON lp_shipping_rates(channel,carrier,valid_from,valid_to);
CREATE INDEX lp_commission_effective ON lp_commission_rates(channel,valid_from,valid_to);
CREATE TRIGGER lp_shipping_immutable BEFORE UPDATE ON lp_shipping_rates WHEN NEW.id IS NOT OLD.id OR NEW.label IS NOT OLD.label OR NEW.channel IS NOT OLD.channel OR NEW.carrier IS NOT OLD.carrier OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_to IS NOT OLD.valid_to OR NEW.price_min_cents IS NOT OLD.price_min_cents OR NEW.price_max_cents IS NOT OLD.price_max_cents OR NEW.billable_min_milli IS NOT OLD.billable_min_milli OR NEW.billable_max_milli IS NOT OLD.billable_max_milli OR NEW.desi_divisor IS NOT OLD.desi_divisor OR NEW.billable_step_milli IS NOT OLD.billable_step_milli OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.vat_bps IS NOT OLD.vat_bps OR NEW.tax_included IS NOT OLD.tax_included OR NEW.source IS NOT OLD.source OR OLD.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER lp_shipping_no_delete BEFORE DELETE ON lp_shipping_rates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER lp_commission_immutable BEFORE UPDATE ON lp_commission_rates WHEN NEW.id IS NOT OLD.id OR NEW.label IS NOT OLD.label OR NEW.channel IS NOT OLD.channel OR NEW.sku IS NOT OLD.sku OR NEW.category IS NOT OLD.category OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_to IS NOT OLD.valid_to OR NEW.price_min_cents IS NOT OLD.price_min_cents OR NEW.price_max_cents IS NOT OLD.price_max_cents OR NEW.rate_bps IS NOT OLD.rate_bps OR NEW.base IS NOT OLD.base OR NEW.vat_bps IS NOT OLD.vat_bps OR NEW.tax_included IS NOT OLD.tax_included OR NEW.source IS NOT OLD.source OR OLD.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
CREATE TRIGGER lp_commission_no_delete BEFORE DELETE ON lp_commission_rates BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TARIFF'); END;
