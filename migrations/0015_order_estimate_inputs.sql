-- Saved parcel assumptions are not ledger entries or settled profit.
CREATE TABLE ec_order_estimate_inputs (
 package_id TEXT PRIMARY KEY REFERENCES ec_order_packages(id),
 source_fingerprint TEXT NOT NULL,
 composition_key TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ec_parcel_templates (
 template_key TEXT PRIMARY KEY,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
