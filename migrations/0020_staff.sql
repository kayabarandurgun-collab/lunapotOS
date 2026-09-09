CREATE TABLE staff_users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,name TEXT NOT NULL,ec_access TEXT NOT NULL DEFAULT 'none' CHECK(ec_access IN ('none','read','write')),lp_access TEXT NOT NULL DEFAULT 'none' CHECK(lp_access IN ('none','read','write')),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),salt TEXT,password_hash TEXT,invite_hash TEXT UNIQUE,invite_expires_at INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE sessions ADD COLUMN staff_id TEXT REFERENCES staff_users(id);
CREATE INDEX sessions_staff ON sessions(staff_id);
CREATE TABLE access_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER staff_permission_sessions AFTER UPDATE OF active,ec_access,lp_access,invite_hash ON staff_users BEGIN DELETE FROM sessions WHERE staff_id=NEW.id; END;
CREATE TRIGGER staff_no_delete BEFORE DELETE ON staff_users BEGIN SELECT RAISE(ABORT,'DISABLE_STAFF_INSTEAD'); END;
CREATE TRIGGER access_audit_no_update BEFORE UPDATE ON access_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER access_audit_no_delete BEFORE DELETE ON access_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
