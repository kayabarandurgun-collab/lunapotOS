-- Stok eksiye düşebilsin mi? Varsayılan HAYIR.
-- Kaydı olmayan bir alıştan satılmış mal varsa, eksi bakiye bu boşluğu GİZLEMEZ, görünür kılar.
-- Koruma kaldırılmıyor, açık beyana bağlanıyor: yalnız allow_negative_stock=1 iken miktar
-- sıfırın altına inebilir. Değer koruması, eşleştirme, tutar, birim ve bileşen kuralları aynen durur.
-- Üretim alanı (lp_) hiç değişmez: orada eksi stok hâlâ yasaktır.
ALTER TABLE workspace_settings ADD COLUMN allow_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK(allow_negative_stock IN (0,1));

-- Miktar yasağı tablonun kendi CHECK kısıtındaydı; SQLite bunu tablo yeniden kurulmadan kaldıramaz.
-- Tabloya adıyla bakan tetikleyiciler önce düşürülür, sonra AYNEN geri yazılır (üçü sarta bağlanır).
DROP TRIGGER ec_stock_product;
DROP TRIGGER ec_stock_nonnegative;
DROP TRIGGER ec_stock_apply;
DROP TRIGGER ec_order_reserve_validate;
DROP TRIGGER ec_receipt_reversal_validate;
DROP TRIGGER ec_adjustment_validate;
DROP TRIGGER ec_adjustment_apply;
DROP TRIGGER ec_purchase_return_validate;
DROP TRIGGER ws_stock_reservation_validate;
DROP TRIGGER ec_stock_reservations_guard;

-- Tablo yeniden kurulur: miktar CHECK kısıtı kalkar, DEĞER kısıtı ve anahtarlar korunur.
CREATE TABLE ec_stock_balances_yeni(product_id TEXT PRIMARY KEY REFERENCES ec_products(id) ON DELETE RESTRICT,quantity_milli INTEGER NOT NULL DEFAULT 0,value_cents INTEGER NOT NULL DEFAULT 0 CHECK(value_cents>=0));
INSERT INTO ec_stock_balances_yeni(product_id,quantity_milli,value_cents) SELECT product_id,quantity_milli,value_cents FROM ec_stock_balances;
DROP TABLE ec_stock_balances;
ALTER TABLE ec_stock_balances_yeni RENAME TO ec_stock_balances;

-- Kaldırılan CHECK yerine aynı gücü koruyan set: beyan yokken bakiye eksiye DÜŞEMEZ.
-- Böylece hareket yolu dışından bir yazma olsa bile taban korunur.
CREATE TRIGGER ec_stock_quantity_floor BEFORE UPDATE OF quantity_milli ON ec_stock_balances
 WHEN NEW.quantity_milli<0 AND COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0)=0 BEGIN
  SELECT RAISE(ABORT,'INSUFFICIENT_STOCK');
END;

-- ec_stock_product (birebir aynı)
CREATE TRIGGER ec_stock_product AFTER INSERT ON ec_products BEGIN INSERT INTO ec_stock_balances(product_id) VALUES(NEW.id); END;
-- ec_stock_nonnegative (yalnız stok yeterliliği şartı eklendi)
CREATE TRIGGER ec_stock_nonnegative BEFORE INSERT ON ec_stock_movements BEGIN
 SELECT CASE WHEN COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0)=0 AND (SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli<0 THEN RAISE(ABORT,'INSUFFICIENT_STOCK') END;
 SELECT CASE WHEN (SELECT value_cents FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.value_cents<0 THEN RAISE(ABORT,'INVALID_STOCK_VALUE') END;
END;
-- ec_stock_apply (birebir aynı)
CREATE TRIGGER ec_stock_apply AFTER INSERT ON ec_stock_movements BEGIN UPDATE ec_stock_balances SET quantity_milli=quantity_milli+NEW.quantity_milli,value_cents=value_cents+NEW.value_cents WHERE product_id=NEW.product_id; END;
-- ec_order_reserve_validate (yalnız stok yeterliliği şartı eklendi)
CREATE TRIGGER ec_order_reserve_validate BEFORE UPDATE OF status ON ec_order_packages WHEN NEW.status='reserved' AND OLD.status!='reserved' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id) OR EXISTS(SELECT 1 FROM ec_order_lines l WHERE l.package_id=NEW.id AND (SELECT COALESCE(SUM(c.revenue_share_bps),0) FROM ec_order_line_components c WHERE c.line_id=l.id)!=10000) THEN RAISE(ABORT,'ORDER_UNMAPPED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id WHERE l.package_id=NEW.id)>20 THEN RAISE(ABORT,'ORDER_COMPONENT_LIMIT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_order_lines WHERE package_id=NEW.id AND net_revenue_cents IS NULL) THEN RAISE(ABORT,'ORDER_MISSING_AMOUNT') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_products p ON p.id=c.product_id WHERE l.package_id=NEW.id AND c.stock_unit!=p.stock_unit) THEN RAISE(ABORT,'ORDER_UNIT_CHANGED') END;
 SELECT CASE WHEN COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0)=0 AND EXISTS(SELECT c.product_id FROM ec_order_line_components c JOIN ec_order_lines l ON l.id=c.line_id JOIN ec_stock_balances b ON b.product_id=c.product_id WHERE l.package_id=NEW.id GROUP BY c.product_id HAVING SUM(c.quantity_milli)+COALESCE((SELECT SUM(r.quantity_milli) FROM ec_order_reservations r WHERE r.product_id=c.product_id AND r.released_on IS NULL),0)>b.quantity_milli) THEN RAISE(ABORT,'ORDER_INSUFFICIENT_STOCK') END;
END;
-- ec_receipt_reversal_validate (birebir aynı)
CREATE TRIGGER ec_receipt_reversal_validate BEFORE INSERT ON ec_receipt_reversals BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_goods_receipts g WHERE g.id=NEW.receipt_id AND g.occurred_on<=NEW.occurred_on),RAISE(ABORT,'RECEIPT_REVERSAL_INVALID'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_active_purchase_returns r JOIN ec_goods_receipts g ON g.line_id=r.line_id WHERE g.id=NEW.receipt_id),RAISE(ABORT,'RECEIPT_REVERSAL_RETURN'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_goods_receipts g JOIN ec_purchase_lines l ON l.id=g.line_id JOIN ec_stock_balances b ON b.product_id=l.product_id WHERE g.id=NEW.receipt_id AND (b.value_cents<g.value_cents OR (b.quantity_milli=g.quantity_milli AND b.value_cents!=g.value_cents))),RAISE(ABORT,'RECEIPT_REVERSAL_COST'),NULL);
END;
-- ec_adjustment_validate (birebir aynı)
CREATE TRIGGER ec_adjustment_validate BEFORE INSERT ON ec_purchase_adjustments BEGIN
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND i.status='posted' AND i.invoice_date<=NEW.occurred_on AND ((NEW.kind='service' AND l.line_type='expense') OR (NEW.kind IN ('price','cancel') AND l.line_type='product'))),RAISE(ABORT,'ADJUSTMENT_INVALID'),NULL);
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_adjustments a JOIN ec_purchase_lines l ON l.id=a.line_id WHERE l.invoice_id=(SELECT invoice_id FROM ec_purchase_lines WHERE id=NEW.line_id) AND a.reference=NEW.reference AND a.operation_id!=NEW.operation_id),RAISE(ABORT,'ADJUSTMENT_DUPLICATE'),NULL);
 SELECT iif((NEW.kind='cancel' AND (NEW.quantity_milli<=0 OR NEW.stock_cents!=0 OR NEW.net_cents<0 OR NEW.tax_cents<0)) OR (NEW.kind!='cancel' AND (NEW.quantity_milli!=0 OR NEW.net_cents*1.0*NEW.tax_cents<0 OR NEW.net_cents+NEW.tax_cents=0)) OR (NEW.kind='service' AND NEW.stock_cents!=0),RAISE(ABORT,'ADJUSTMENT_INVALID'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_active_purchase_adjustments a WHERE a.id=NEW.reversal_of AND a.line_id=NEW.line_id AND a.kind=NEW.kind AND a.quantity_milli=NEW.quantity_milli AND a.net_cents=NEW.net_cents AND a.tax_cents=NEW.tax_cents AND a.stock_cents=NEW.stock_cents AND a.occurred_on<=NEW.occurred_on),RAISE(ABORT,'ADJUSTMENT_REVERSED'),NULL);
 SELECT iif(NEW.kind='price' AND (EXISTS(SELECT 1 FROM ec_active_purchase_returns WHERE line_id=NEW.line_id) OR EXISTS(SELECT 1 FROM ec_active_purchase_adjustments WHERE line_id=NEW.line_id AND kind='cancel')),RAISE(ABORT,'ADJUSTMENT_CLOSED_LINE'),NULL);
 SELECT iif(NEW.kind IN ('price','service') AND EXISTS(SELECT 1 FROM ec_purchase_line_limits v WHERE v.id=NEW.line_id AND (v.effective_net-iif(NEW.reversal_of IS NULL,NEW.net_cents,-NEW.net_cents)<0 OR v.effective_tax-iif(NEW.reversal_of IS NULL,NEW.tax_cents,-NEW.tax_cents)<0)),RAISE(ABORT,'ADJUSTMENT_EXCEEDS'),NULL);
 SELECT iif(NEW.kind='service' AND (SELECT expense_treatment FROM ec_purchase_lines WHERE id=NEW.line_id)='sales_fee' AND COALESCE((SELECT SUM(amount_cents) FROM ec_fee_allocations WHERE invoice_line_id=NEW.line_id AND reversed_at IS NULL),0)>(SELECT effective_net-iif(NEW.reversal_of IS NULL,NEW.net_cents,-NEW.net_cents) FROM ec_purchase_line_limits WHERE id=NEW.line_id),RAISE(ABORT,'ADJUSTMENT_ALLOCATED_FEE'),NULL);
 SELECT iif(NEW.stock_cents!=0 AND (SELECT quantity_milli FROM ec_purchase_lines WHERE id=NEW.line_id)!=COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id),0),RAISE(ABORT,'ADJUSTMENT_RECEIVE_FIRST'),NULL);
 SELECT iif(NEW.stock_cents!=0 AND NOT EXISTS(SELECT 1 FROM ec_stock_balances b JOIN ec_purchase_lines l ON l.product_id=b.product_id WHERE l.id=NEW.line_id AND b.quantity_milli>0 AND b.value_cents-iif(NEW.reversal_of IS NULL,NEW.stock_cents,-NEW.stock_cents)>=0),RAISE(ABORT,'ADJUSTMENT_STOCK_VALUE'),NULL);
 SELECT iif(NEW.kind='cancel' AND NEW.reversal_of IS NULL AND NEW.quantity_milli+(SELECT cancelled_milli FROM ec_purchase_line_limits WHERE id=NEW.line_id)+COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id),0)>(SELECT quantity_milli FROM ec_purchase_lines WHERE id=NEW.line_id),RAISE(ABORT,'ADJUSTMENT_CANCEL_QUANTITY'),NULL);
 SELECT iif(NEW.kind='cancel' AND NEW.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ec_purchase_line_limits v JOIN ec_purchase_lines l ON l.id=v.id WHERE v.id=NEW.line_id AND NEW.net_cents=CAST(ROUND(v.effective_net*(NEW.quantity_milli+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_net AND NEW.tax_cents=CAST(ROUND(v.effective_tax*(NEW.quantity_milli+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_tax),RAISE(ABORT,'ADJUSTMENT_EXCEEDS'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE (a.positive_entry_id='adjustment:'||NEW.reversal_of OR a.negative_entry_id='adjustment:'||NEW.reversal_of) AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals r WHERE r.allocation_id=a.id)),RAISE(ABORT,'ADJUSTMENT_PARTY_ALLOCATED'),NULL);
END;
-- ec_adjustment_apply (birebir aynı)
CREATE TRIGGER ec_adjustment_apply AFTER INSERT ON ec_purchase_adjustments BEGIN
 UPDATE ec_stock_balances SET value_cents=value_cents-iif(NEW.reversal_of IS NULL,NEW.stock_cents,-NEW.stock_cents) WHERE product_id=(SELECT product_id FROM ec_purchase_lines WHERE id=NEW.line_id) AND NEW.stock_cents!=0;
 INSERT INTO ec_party_entries(id,party_id,amount_cents,occurred_on,reference,description,source_key,source) SELECT 'adjustment:'||NEW.id,i.supplier_id,iif(NEW.reversal_of IS NULL,NEW.net_cents+NEW.tax_cents,-NEW.net_cents-NEW.tax_cents),NEW.occurred_on,NEW.reference,'Alış düzeltmesi · '||i.invoice_no||' · '||NEW.reason,'adjustment:'||NEW.id,'invoice' FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND NEW.net_cents+NEW.tax_cents!=0;
 INSERT INTO ec_payment_allocations(id,positive_entry_id,negative_entry_id,amount_cents,reference) SELECT 'adjustment-reverse:'||NEW.id,'adjustment:'||iif(NEW.net_cents+NEW.tax_cents>0,NEW.reversal_of,NEW.id),'adjustment:'||iif(NEW.net_cents+NEW.tax_cents>0,NEW.id,NEW.reversal_of),ABS(NEW.net_cents+NEW.tax_cents),'adjustment-reverse:'||NEW.id WHERE NEW.reversal_of IS NOT NULL AND NEW.net_cents+NEW.tax_cents!=0;
END;
-- ec_purchase_return_validate (birebir aynı)
CREATE TRIGGER ec_purchase_return_validate BEFORE INSERT ON ec_purchase_returns BEGIN
 SELECT iif(EXISTS(SELECT 1 FROM ec_purchase_returns r JOIN ec_purchase_lines l ON l.id=r.line_id WHERE l.invoice_id=(SELECT invoice_id FROM ec_purchase_lines WHERE id=NEW.line_id) AND r.reference=NEW.reference AND r.operation_id!=NEW.operation_id),RAISE(ABORT,'PURCHASE_RETURN_REVERSED'),NULL);
 SELECT iif(NOT EXISTS(SELECT 1 FROM ec_purchase_lines l JOIN ec_purchase_invoices i ON i.id=l.invoice_id WHERE l.id=NEW.line_id AND l.line_type='product' AND i.status='posted' AND i.invoice_date<=NEW.occurred_on),RAISE(ABORT,'PURCHASE_RETURN_INVALID'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND NEW.quantity_milli+COALESCE((SELECT SUM(quantity_milli) FROM ec_active_purchase_returns WHERE line_id=NEW.line_id),0)>COALESCE((SELECT SUM(quantity_milli) FROM ec_effective_receipts WHERE line_id=NEW.line_id AND occurred_on<=NEW.occurred_on),0),RAISE(ABORT,'PURCHASE_RETURN_QUANTITY'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ec_purchase_line_limits v JOIN ec_purchase_lines l ON l.id=v.id WHERE l.id=NEW.line_id AND NEW.net_cents=CAST(ROUND(v.effective_net*(NEW.quantity_milli+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_net AND NEW.tax_cents=CAST(ROUND(v.effective_tax*(NEW.quantity_milli+v.closed_milli)/(l.quantity_milli*1.0)) AS INTEGER)-v.closed_tax),RAISE(ABORT,'PURCHASE_RETURN_VALUE'),NULL);
 SELECT iif(NEW.reversal_of IS NULL AND NEW.cost_cents!=(SELECT CAST(ROUND(b.value_cents*1.0*NEW.quantity_milli/MAX(b.quantity_milli,1.0)) AS INTEGER) FROM ec_stock_balances b JOIN ec_purchase_lines l ON l.product_id=b.product_id WHERE l.id=NEW.line_id),RAISE(ABORT,'PURCHASE_RETURN_VALUE'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_active_purchase_returns r WHERE r.id=NEW.reversal_of AND r.line_id=NEW.line_id AND r.quantity_milli=NEW.quantity_milli AND r.net_cents=NEW.net_cents AND r.tax_cents=NEW.tax_cents AND r.cost_cents=NEW.cost_cents AND r.occurred_on<=NEW.occurred_on),RAISE(ABORT,'PURCHASE_RETURN_REVERSED'),NULL);
 SELECT iif(NEW.reversal_of IS NOT NULL AND EXISTS(SELECT 1 FROM ec_payment_allocations a WHERE (a.positive_entry_id='purchase-return:'||NEW.reversal_of OR a.negative_entry_id='purchase-return:'||NEW.reversal_of) AND NOT EXISTS(SELECT 1 FROM ec_allocation_reversals x WHERE x.allocation_id=a.id)),RAISE(ABORT,'PURCHASE_RETURN_ALLOCATED'),NULL);
END;
-- ws_stock_reservation_validate (birebir aynı)
CREATE TRIGGER ws_stock_reservation_validate BEFORE INSERT ON ws_stock_reservations BEGIN
 -- Test siparişi gerçek stok kartından ayırma yapamaz.
 SELECT iif((SELECT is_test FROM ws_orders WHERE id=NEW.order_id)!=0,RAISE(ABORT,'WS_TEST_ORDER_REAL_STOCK'),NULL);
 -- Satılabilir = bakiye − pazaryeri ayırmaları − web ayırmaları. Yetmiyorsa ayırma yapılmaz.
 SELECT iif(COALESCE((SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id),0)
   - COALESCE((SELECT SUM(quantity_milli) FROM ec_order_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   - COALESCE((SELECT SUM(quantity_milli) FROM ws_stock_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   < NEW.quantity_milli,RAISE(ABORT,'WS_STOCK_UNAVAILABLE'),NULL);
END;
-- ec_stock_reservations_guard (yalnız stok yeterliliği şartı eklendi)
CREATE TRIGGER ec_stock_reservations_guard BEFORE INSERT ON ec_stock_movements WHEN NEW.quantity_milli<0 AND COALESCE((SELECT allow_negative_stock FROM workspace_settings WHERE workspace='ec'),0)=0 BEGIN
 SELECT CASE WHEN (SELECT quantity_milli FROM ec_stock_balances WHERE product_id=NEW.product_id)+NEW.quantity_milli
   < COALESCE((SELECT SUM(quantity_milli) FROM ec_order_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   + COALESCE((SELECT SUM(quantity_milli) FROM ws_stock_reservations WHERE product_id=NEW.product_id AND released_on IS NULL),0)
   THEN RAISE(ABORT,'STOCK_RESERVED') END;
END;
