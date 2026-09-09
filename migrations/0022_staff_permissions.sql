ALTER TABLE staff_users ADD COLUMN permissions_json TEXT CHECK(permissions_json IS NULL OR json_valid(permissions_json));
CREATE TRIGGER staff_detailed_sessions AFTER UPDATE OF permissions_json ON staff_users BEGIN DELETE FROM sessions WHERE staff_id=NEW.id; END;
