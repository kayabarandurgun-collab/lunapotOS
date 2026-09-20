-- Device grants are independent of normal sessions; no PIN is enabled by migration.
CREATE TABLE trusted_devices (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 staff_id TEXT REFERENCES staff_users(id),
 password_version TEXT NOT NULL,
 pin_salt TEXT NOT NULL,
 pin_hash TEXT NOT NULL,
 label TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK(expires_at>created_at)
);
CREATE INDEX trusted_devices_account ON trusted_devices(staff_id,expires_at);
-- Also covers direct credential recovery/reset without depending on the calling API.
CREATE TRIGGER trusted_devices_admin_password AFTER UPDATE OF password_hash,salt ON admin BEGIN
 DELETE FROM trusted_devices WHERE staff_id IS NULL;
 DELETE FROM sessions WHERE staff_id IS NULL;
END;
CREATE TRIGGER trusted_devices_admin_delete AFTER DELETE ON admin BEGIN
 DELETE FROM trusted_devices WHERE staff_id IS NULL;
 DELETE FROM sessions WHERE staff_id IS NULL;
END;
CREATE TRIGGER trusted_devices_staff_reset AFTER UPDATE OF password_hash,salt,invite_hash,active ON staff_users
WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.salt IS NOT OLD.salt
 OR NEW.invite_hash IS NOT OLD.invite_hash OR NEW.active=0 BEGIN
 DELETE FROM trusted_devices WHERE staff_id=NEW.id;
 DELETE FROM sessions WHERE staff_id=NEW.id;
END;
ALTER TABLE sessions ADD COLUMN trusted_device_id TEXT REFERENCES trusted_devices(id);
CREATE INDEX sessions_trusted_device ON sessions(trusted_device_id);
CREATE TRIGGER trusted_devices_revoke_sessions BEFORE DELETE ON trusted_devices BEGIN
 DELETE FROM sessions WHERE trusted_device_id=OLD.id;
END;
