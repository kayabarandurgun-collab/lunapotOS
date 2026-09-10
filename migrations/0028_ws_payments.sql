-- Web mağaza ödeme kayıtları (sağlayıcı: iyzico Ödeme Formu).
--
-- Bu tablo SANDBOX/TEST içindir. ws_orders.is_test=1 kısıtı değişmez; sandbox'ta doğrulanan
-- ödeme siparişte 'demo_paid' olarak işaretlenir çünkü gerçek para hareket etmez.
-- Gerçek tahsilat ayrı bir geçiş ve güvenlik kontrolü gerektirir; tek bayrakla açılmaz.
--
-- Tarayıcı dönüşü ödeme kanıtı DEĞİLDİR. Bir ödeme ancak sunucu sağlayıcıyı sorgulayıp
-- imza, tutar, para birimi ve sipariş kimliğini doğruladığında 'verified' olur.
CREATE TABLE ws_payments(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES ws_orders(id),
 provider TEXT NOT NULL CHECK(provider IN ('iyzico')),
 mode TEXT NOT NULL CHECK(mode IN ('sandbox')),
 token TEXT UNIQUE,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 currency TEXT NOT NULL DEFAULT 'TRY' CHECK(currency='TRY'),
 status TEXT NOT NULL DEFAULT 'initialized' CHECK(status IN ('initialized','verified','pending','failed','rejected','expired')),
 provider_payment_id TEXT,
 verified_cents INTEGER CHECK(verified_cents IS NULL OR typeof(verified_cents)='integer'),
 reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- Doğrulanmış ödeme tutarı sipariş tutarına eşit olmak zorunda.
 CHECK(status!='verified' OR (verified_cents=amount_cents AND provider_payment_id IS NOT NULL))
);
CREATE INDEX ws_payments_order ON ws_payments(order_id,created_at);

-- Aynı siparişte aynı anda yalnızca bir açık/doğrulanmış ödeme olabilir; çift tahsilat yolu kapanır.
CREATE UNIQUE INDEX ws_payments_one_open ON ws_payments(order_id) WHERE status IN ('initialized','pending','verified');

-- Doğrulanmış ödeme bir daha değişmez.
CREATE TRIGGER ws_payment_verified_frozen BEFORE UPDATE ON ws_payments WHEN OLD.status='verified' BEGIN
 SELECT RAISE(ABORT,'PAYMENT_IMMUTABLE');
END;
CREATE TRIGGER ws_payment_no_delete BEFORE DELETE ON ws_payments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Sağlayıcı bildirimleri: aynı bildirim (iyziReferenceCode) iki kez işlenmez.
CREATE TABLE ws_payment_events(
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 reference_code TEXT NOT NULL UNIQUE,
 token TEXT,
 event_type TEXT NOT NULL,
 status TEXT NOT NULL,
 signature_ok INTEGER NOT NULL CHECK(signature_ok IN (0,1)),
 outcome TEXT NOT NULL DEFAULT '',
 received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER ws_payment_events_no_update BEFORE UPDATE ON ws_payment_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
CREATE TRIGGER ws_payment_events_no_delete BEFORE DELETE ON ws_payment_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
