-- Web mağaza kataloğu ↔ e-ticaret stok kartı eşlemesi ve TEK STOK KAYNAĞI.
--
-- Web varyantı gerçek stok tutmaz. Hangi e-ticaret kartından (ec_products) kaç birim tükettiği
-- yazılır. Gerçek stok ayırması ws_stock_reservations'ta durur ve pazaryeri ayırmalarıyla
-- (ec_order_reservations) AYNI bakiyeden düşülür.
--
-- TEST SİPARİŞLERİ GERÇEK STOK AYIRAMAZ: aşağıdaki tetik is_test=1 siparişin gerçek karttan
-- ayırma yapmasını reddeder. Mağaza test modundayken ws_catalog.stock (test stoğu) kullanılmaya
-- devam eder; gerçek ayırma ancak canlı satış geçişinde açılır.

CREATE TABLE ws_variant_components(
 id TEXT PRIMARY KEY,
 variant_id TEXT NOT NULL REFERENCES ws_catalog(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(variant_id,product_id)
);
CREATE INDEX ws_variant_components_product ON ws_variant_components(product_id);

CREATE TABLE ws_stock_reservations(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES ws_orders(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 released_on TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,product_id)
);
CREATE INDEX ws_stock_reservations_product ON ws_stock_reservations(product_id,released_on);

CREATE TRIGGER ws_stock_reservation_validate BEFORE INSERT ON ws_stock_reservations BEGIN
 -- Test siparişi gerçek stok kartından ayırma yapamaz.
 SELECT iif((SELECT is_test FROM ws_orders WHERE id=NEW.order_id)!=0,RAISE(ABORT,'WS_TEST_ORDER_REAL_STOCK'),NULL);
 -- Satılabilir = bakiye − pazaryeri ayırmaları − web ayırmaları. Yetmiyorsa ayırma yapılmaz.
 SELECT iif(COALESCE((SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id),0)
   - COALESCE((SELECT SUM(quantity_milli) FROM ec_order_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   - COALESCE((SELECT SUM(quantity_milli) FROM ws_stock_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   < NEW.quantity_milli,RAISE(ABORT,'WS_STOCK_UNAVAILABLE'),NULL);
END;
-- Ayırma kaydı yalnızca bir kez serbest bırakılır; miktarı ve kartı değişmez.
CREATE TRIGGER ws_stock_reservation_frozen BEFORE UPDATE ON ws_stock_reservations BEGIN
 SELECT iif(NEW.order_id!=OLD.order_id OR NEW.product_id!=OLD.product_id OR NEW.quantity_milli!=OLD.quantity_milli
   OR OLD.released_on IS NOT NULL,RAISE(ABORT,'WS_RESERVATION_IMMUTABLE'),NULL);
END;
CREATE TRIGGER ws_stock_reservation_no_delete BEFORE DELETE ON ws_stock_reservations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
-- Sipariş iptal edilince gerçek ayırma bir kez serbest kalır.
CREATE TRIGGER ws_release_real_stock AFTER UPDATE OF status ON ws_orders WHEN NEW.status='cancelled' AND OLD.status<>'cancelled' BEGIN
 UPDATE ws_stock_reservations SET released_on=CURRENT_TIMESTAMP WHERE order_id=NEW.id AND released_on IS NULL;
END;

-- Pazaryeri stok çıkışı artık web ayırmalarını da görür: web'in ayırdığı stok başka kanaldan tüketilemez.
-- Önceki tanım (0012) yalnızca ec_order_reservations'ı sayıyordu; davranışı aynen korunur, web kısmı eklenir.
DROP TRIGGER ec_stock_reservations_guard;
CREATE TRIGGER ec_stock_reservations_guard BEFORE INSERT ON ec_stock_movements WHEN NEW.quantity_milli<0 BEGIN
 SELECT CASE WHEN (SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli
   < COALESCE((SELECT SUM(quantity_milli) FROM ec_order_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   + COALESCE((SELECT SUM(quantity_milli) FROM ws_stock_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   THEN RAISE(ABORT,'STOCK_RESERVED') END;
END;
