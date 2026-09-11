-- Web mağaza hesap güvenliği, TEST posta kutusu ve iletişim mesajları.
--
-- HİÇBİR E-POSTA GÖNDERİLMEZ. ws_mail_outbox yalnızca yerel/test yakalayıcısıdır (mode='test').
-- Gerçek e-posta sağlayıcısı bağlanana kadar bağlantılar yönetim ekranındaki "Test e-postaları"
-- görünümünden (yalnızca yönetici) okunur.
--
-- Belirteçler veritabanında yalnızca SHA-256 özetiyle tutulur, tek kullanımlıktır ve süresi dolar.

ALTER TABLE ws_customers ADD COLUMN email_verified_at TEXT;

CREATE TABLE ws_account_tokens(
 token_hash TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES ws_customers(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 expires_at INTEGER NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ws_account_tokens_customer ON ws_account_tokens(customer_id,purpose);
-- Kullanılmış belirteç yeniden açılamaz; kimliği, sahibi, amacı ve süresi değişmez.
CREATE TRIGGER ws_account_token_single_use BEFORE UPDATE ON ws_account_tokens BEGIN
 SELECT iif(OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.token_hash!=OLD.token_hash OR NEW.customer_id!=OLD.customer_id
   OR NEW.purpose!=OLD.purpose OR NEW.expires_at!=OLD.expires_at,RAISE(ABORT,'WS_TOKEN_USED'),NULL);
END;
CREATE TRIGGER ws_account_token_no_delete BEFORE DELETE ON ws_account_tokens BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

CREATE TABLE ws_mail_outbox(
 id TEXT PRIMARY KEY,
 mode TEXT NOT NULL DEFAULT 'test' CHECK(mode='test'),
 customer_id TEXT REFERENCES ws_customers(id),
 order_id TEXT REFERENCES ws_orders(id),
 to_email TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('verify_email','reset_password','order_received','contact_received')),
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ws_mail_outbox_created ON ws_mail_outbox(created_at);
CREATE TRIGGER ws_mail_outbox_no_update BEFORE UPDATE ON ws_mail_outbox BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;

-- Her sipariş için sipariş/sözleşme bildirimi (test kutusuna). Tetik, bildirimin atlanamamasını sağlar.
CREATE TRIGGER ws_order_received_mail AFTER INSERT ON ws_orders BEGIN
 INSERT INTO ws_mail_outbox(id,customer_id,order_id,to_email,kind,subject,body)
 SELECT lower(hex(randomblob(16))),NEW.customer_id,NEW.id,c.email,'order_received','Siparişin alındı: '||NEW.number,
  'Merhaba '||c.name||','||char(10)||char(10)||NEW.number||' numaralı TEST siparişin alındı.'||char(10)||
  'Toplam: '||printf('%.2f',NEW.total_cents/100.0)||' TL (kargo dahil).'||char(10)||
  'Kabul ettiğin ön bilgilendirme ve mesafeli satış sözleşmesi sürümü: '||NEW.legal_version||'.'||char(10)||
  'Sözleşme metninin kabul anındaki kopyası hesabındaki sipariş detayında saklanır.'||char(10)||char(10)||
  'Bu bir test bildirimidir; gerçek tahsilat yapılmadı ve ürün gönderilmeyecek.'
 FROM ws_customers c WHERE c.id=NEW.customer_id;
END;

-- İletişim formu: mailto taslağı yerine sunucuda kayıt. Silinmez; yalnızca durum değişir.
CREATE TABLE ws_contact_messages(
 id TEXT PRIMARY KEY,
 customer_id TEXT REFERENCES ws_customers(id),
 name TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL,
 topic TEXT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','closed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ws_contact_messages_created ON ws_contact_messages(created_at);
CREATE TRIGGER ws_contact_frozen BEFORE UPDATE ON ws_contact_messages BEGIN
 SELECT iif(NEW.email!=OLD.email OR NEW.message!=OLD.message OR NEW.topic!=OLD.topic OR NEW.name!=OLD.name
   OR NEW.customer_id IS NOT OLD.customer_id,RAISE(ABORT,'WS_CONTACT_IMMUTABLE'),NULL);
END;
CREATE TRIGGER ws_contact_no_delete BEFORE DELETE ON ws_contact_messages BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEDGER'); END;
