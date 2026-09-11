-- Web mağaza siparişinin sevkte e-ticaret defterine satış olarak yazılması — CANLI GEÇİŞ YOLU.
--
-- Paralel muhasebe kurulmaz: satış mevcut ec_sale_entries tablosuna (kanal 'other', referans 'web:...')
-- pazaryeri siparişleriyle aynı desenle yazılır; stok çıkışını ec_sale_stock tetiği yapar.
--
-- TEST SİPARİŞLERİ DEFTERE GİRMEZ: ws_orders.is_test CHECK(is_test=1) değişmedi, bugün hiçbir sipariş
-- bu yola giremez. Aşağıdaki tetik ayrıca test siparişine satış bağı kurulmasını reddeder.

-- Set bileşenlerinin gelir payı (baz puan). Tek bileşende NULL = %100. Çok bileşende hepsi dolu ve toplamı 10000 olmalı.
ALTER TABLE ws_variant_components ADD COLUMN revenue_share_bps INTEGER
 CHECK(revenue_share_bps IS NULL OR (typeof(revenue_share_bps)='integer' AND revenue_share_bps BETWEEN 1 AND 10000));

-- Sipariş kalemi × stok kartı → satış kaydı. Aynı kalem aynı kart için ikinci kez deftere yazılamaz.
CREATE TABLE ws_sale_links(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES ws_orders(id),
 order_item_id TEXT NOT NULL REFERENCES ws_order_items(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 sale_id TEXT NOT NULL UNIQUE REFERENCES ec_sale_entries(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_item_id,product_id)
);
CREATE INDEX ws_sale_links_order ON ws_sale_links(order_id);
CREATE TRIGGER ws_sale_link_live_only BEFORE INSERT ON ws_sale_links BEGIN
 SELECT iif((SELECT is_test FROM ws_orders WHERE id=NEW.order_id) IS NOT 0,RAISE(ABORT,'WS_TEST_ORDER_LEDGER'),NULL);
END;
CREATE TRIGGER ws_sale_link_no_update BEFORE UPDATE ON ws_sale_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ws_sale_link_no_delete BEFORE DELETE ON ws_sale_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
