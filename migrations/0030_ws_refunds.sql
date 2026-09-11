-- Web mağaza SANDBOX iadeleri (iyzico /payment/refund, kalem bazında paymentTransactionId ile).
--
-- iyzico belgesi, sorgu yanıtındaki itemTransactions[].paymentTransactionId ve paidPrice
-- değerlerinin iade için saklanmasını ister. Bu değerler ödeme doğrulanırken ws_payments'a yazılır.
-- İade gerçek para hareketi DEĞİLDİR (mode=sandbox, is_test=1); muhasebe defterine yazılmaz.
ALTER TABLE ws_payments ADD COLUMN item_transactions_json TEXT;

CREATE TABLE ws_refunds(
 id TEXT PRIMARY KEY,
 payment_id TEXT NOT NULL REFERENCES ws_payments(id),
 order_id TEXT NOT NULL REFERENCES ws_orders(id),
 transaction_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','succeeded','failed')),
 provider_reference TEXT,
 reason TEXT NOT NULL DEFAULT '',
 actor TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ws_refunds_order ON ws_refunds(order_id,created_at);
-- Aynı kalem işlemi için aynı anda tek canlı iade: çift tıklama / eşzamanlı istek ikinci iadeyi açamaz.
-- Sonucu bilinmeyen istek ('requested') de yeniden iadeyi engeller.
CREATE UNIQUE INDEX ws_refunds_one_live ON ws_refunds(payment_id,transaction_id) WHERE status IN ('requested','succeeded');

CREATE TRIGGER ws_refund_validate BEFORE INSERT ON ws_refunds BEGIN
 SELECT iif((SELECT status FROM ws_payments WHERE id=NEW.payment_id) IS NOT 'verified',RAISE(ABORT,'WS_REFUND_UNVERIFIED'),NULL);
 SELECT iif((SELECT order_id FROM ws_payments WHERE id=NEW.payment_id) IS NOT NEW.order_id,RAISE(ABORT,'WS_REFUND_ORDER'),NULL);
 -- Toplam iade doğrulanmış tahsilatı aşamaz.
 SELECT iif(COALESCE((SELECT SUM(amount_cents) FROM ws_refunds WHERE payment_id=NEW.payment_id AND status IN ('requested','succeeded')),0)+NEW.amount_cents
   > (SELECT verified_cents FROM ws_payments WHERE id=NEW.payment_id),RAISE(ABORT,'WS_REFUND_EXCEEDS'),NULL);
END;
-- Yalnızca requested → succeeded/failed; tutar, işlem ve sipariş değişmez; sonuçlanan kayıt donar.
CREATE TRIGGER ws_refund_frozen BEFORE UPDATE ON ws_refunds BEGIN
 SELECT iif(OLD.status!='requested' OR NEW.status NOT IN ('succeeded','failed') OR NEW.payment_id!=OLD.payment_id
   OR NEW.order_id!=OLD.order_id OR NEW.transaction_id!=OLD.transaction_id OR NEW.amount_cents!=OLD.amount_cents,
   RAISE(ABORT,'WS_REFUND_IMMUTABLE'),NULL);
END;
CREATE TRIGGER ws_refund_no_delete BEFORE DELETE ON ws_refunds BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
