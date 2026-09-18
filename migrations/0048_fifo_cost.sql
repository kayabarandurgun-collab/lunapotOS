-- SATIŞ MALİYETİ SATIŞ TARİHİNE GÖRE (ilk giren ilk çıkar).
--
-- Satış kaydı maliyetini yazıldığı ANDAKİ stok ortalamasından alıyordu. Geçmiş siparişler sonradan
-- aktarıldığında (ya da geçmiş tarihli alış sonradan girildiğinde) Temmuz satışına Ağustos'taki
-- daha pahalı alışın payı biniyordu: 13 Temmuz'da yalnız 100 TL'lik mal varken maliyet 101,19 TL
-- yazılıyordu. Doğrusu: satış, kendi tarihinde stokta bekleyen EN ESKİ malı tüketir.
--
-- Stok hareketi defteri değişmez. Hareket eklenen ürün "kirli" işaretlenir; uygulama o ürünün
-- bütün hareketlerini tarih sırasıyla yeniden oynatır ve satışların maliyetini düzeltme kaydıyla
-- (ec_cost_revaluations) gerçeğe çeker. Düzeltme satıştan aldığı değeri stoğa, stoktan aldığını
-- satışa verir: toplam değer korunur.
CREATE TABLE ec_cost_dirty(product_id TEXT PRIMARY KEY);

CREATE TABLE ec_cost_revaluations(
 id TEXT PRIMARY KEY,
 sale_id TEXT NOT NULL REFERENCES ec_sale_entries(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 delta_cents INTEGER NOT NULL CHECK(delta_cents!=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ec_cost_revaluations_sale ON ec_cost_revaluations(sale_id);
CREATE TRIGGER ec_cost_revaluation_no_update BEFORE UPDATE ON ec_cost_revaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_cost_revaluation_no_delete BEFORE DELETE ON ec_cost_revaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ec_cost_revaluation_apply AFTER INSERT ON ec_cost_revaluations BEGIN
 UPDATE ec_sale_entries SET cost_cents=cost_cents+NEW.delta_cents WHERE id=NEW.sale_id;
 UPDATE ec_stock_balances SET value_cents=value_cents-NEW.delta_cents WHERE product_id=NEW.product_id;
END;

CREATE TRIGGER ec_cost_dirty_mark AFTER INSERT ON ec_stock_movements BEGIN
 INSERT OR IGNORE INTO ec_cost_dirty(product_id) VALUES(NEW.product_id);
END;

INSERT OR IGNORE INTO ec_cost_dirty(product_id) SELECT DISTINCT product_id FROM ec_stock_movements;
