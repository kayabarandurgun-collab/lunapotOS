-- FATURASIZ MAL GİRİŞİ (geçici mal kabul).
-- Vadeli çalışılan tedarikçi malı önce gönderir, faturayı vade gününde keser. O zamana kadar
-- mal rafta durur: stok eksiye düşmesin ve cari borcu görünsün diye burada "geçici" olarak kayda girer.
--
-- STOK: satırlar ec_stock_movements'a 'GECICI-SAYIM-<referans>' ile yazılır. Gerçek faturanın mal
-- teslimi yapıldığında src/accounting.js:provisionalClose bu sayımı teslim edilen adet kadar
-- KENDİLİĞİNDEN kapatır (0049 tetikleyicileriyle birlikte). Burada ikinci bir mekanizma YOKTUR;
-- çift stok girişini önleyen tek yer odur.
--
-- CARİ: geçici borç ec_party_entries'e source='manual', source_key='gecici:<id>' ile yazılır.
-- Fatura muhasebeleşince bu satır ters kayıtla (source='reversal') kapanır ve faturanın kendi
-- borcu ('invoice:<fatura>') yazılır. Böylece borç bir an bile iki kez durmaz.
--
-- ÇİFT KAPANIŞ OLAMAZ: invoice_id tekildir (bir fatura yalnız bir geçici girişi kapatır) ve
-- kapanış yalnız açık (invoice_id IS NULL) kayıt için yazılabilir.

CREATE TABLE ec_provisional_receipts(
 id TEXT PRIMARY KEY,
 supplier_id TEXT NOT NULL REFERENCES ec_suppliers(id),
 occurred_on TEXT NOT NULL,
 reference TEXT NOT NULL UNIQUE,
 notes TEXT NOT NULL DEFAULT '',
 entry_id TEXT UNIQUE REFERENCES ec_party_entries(id),
 invoice_id TEXT UNIQUE REFERENCES ec_purchase_invoices(id),
 closed_on TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((invoice_id IS NULL)=(closed_on IS NULL)));
CREATE INDEX ec_provisional_supplier ON ec_provisional_receipts(supplier_id,invoice_id);

CREATE TABLE ec_provisional_receipt_lines(
 id TEXT PRIMARY KEY,
 receipt_id TEXT NOT NULL REFERENCES ec_provisional_receipts(id),
 product_id TEXT NOT NULL REFERENCES ec_products(id),
 quantity_milli INTEGER NOT NULL CHECK(typeof(quantity_milli)='integer' AND quantity_milli>0),
 unit_cost_cents INTEGER NOT NULL CHECK(typeof(unit_cost_cents)='integer' AND unit_cost_cents>=0),
 vat_bps INTEGER NOT NULL DEFAULT 2000 CHECK(typeof(vat_bps)='integer' AND vat_bps BETWEEN 0 AND 10000),
 movement_id TEXT UNIQUE REFERENCES ec_stock_movements(id),
 UNIQUE(receipt_id,product_id));
CREATE INDEX ec_provisional_line_receipt ON ec_provisional_receipt_lines(receipt_id);

-- Kapanış yalnız bir kez: kapalı kaydın faturası değiştirilemez, açılamaz.
CREATE TRIGGER ec_provisional_close_once BEFORE UPDATE OF invoice_id ON ec_provisional_receipts BEGIN
 SELECT CASE WHEN OLD.invoice_id IS NOT NULL THEN RAISE(ABORT,'PROVISIONAL_ALREADY_CLOSED') END;
END;
