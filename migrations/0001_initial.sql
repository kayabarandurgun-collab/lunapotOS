CREATE TABLE materials (
 id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 unit TEXT NOT NULL CHECK(unit IN ('kg','g','L','ml','adet','m','m2')),
 price REAL NOT NULL CHECK(price >= 0), supplier TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
 category TEXT NOT NULL DEFAULT '', sale_price REAL NOT NULL DEFAULT 0 CHECK(sale_price >= 0),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE recipes (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
 yield_qty REAL NOT NULL DEFAULT 1 CHECK(yield_qty > 0), waste_pct REAL NOT NULL DEFAULT 0 CHECK(waste_pct BETWEEN 0 AND 100),
 labor REAL NOT NULL DEFAULT 0 CHECK(labor >= 0), packaging REAL NOT NULL DEFAULT 0 CHECK(packaging >= 0),
 overhead REAL NOT NULL DEFAULT 0 CHECK(overhead >= 0), notes TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE recipe_items (
 id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
 quantity REAL NOT NULL CHECK(quantity > 0), unit TEXT NOT NULL, UNIQUE(recipe_id, material_id)
);
CREATE INDEX recipe_items_material ON recipe_items(material_id);
CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE activity (id TEXT PRIMARY KEY, description TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
