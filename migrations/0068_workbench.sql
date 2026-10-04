-- Daily workbench metadata only. Financial source records remain authoritative.
-- Keep statements compatible with Wrangler splitting: no CASE inside triggers.

CREATE TABLE ec_workbench_tasks(
 task_key TEXT PRIMARY KEY,
 source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL,
 feature TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
 assignee_id TEXT,
 assignee_name TEXT,
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND date(due_on) IS NOT NULL AND date(due_on)=due_on)),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
 snooze_until TEXT CHECK(snooze_until IS NULL OR (length(snooze_until)=10 AND date(snooze_until) IS NOT NULL AND date(snooze_until)=snooze_until)),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((assignee_id IS NULL AND assignee_name IS NULL) OR (assignee_id IS NOT NULL AND assignee_name IS NOT NULL)),
 CHECK(source_kind='custom' OR status!='done'),
 UNIQUE(source_kind,source_id)
);
CREATE INDEX ec_workbench_tasks_due ON ec_workbench_tasks(status,due_on,assignee_id);
CREATE TABLE ec_workbench_task_audit(
 id INTEGER PRIMARY KEY,
 task_key TEXT NOT NULL REFERENCES ec_workbench_tasks(task_key),
 version INTEGER NOT NULL,
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(task_key,version)
);
CREATE TRIGGER ec_workbench_tasks_version BEFORE UPDATE ON ec_workbench_tasks
 WHEN NEW.version!=OLD.version+1 OR NEW.task_key!=OLD.task_key OR NEW.source_kind!=OLD.source_kind OR NEW.source_id!=OLD.source_id OR NEW.feature!=OLD.feature OR NEW.created_at!=OLD.created_at
 BEGIN SELECT RAISE(ABORT,'WORKBENCH_VERSION_OR_IDENTITY'); END;
CREATE TRIGGER ec_workbench_tasks_no_delete BEFORE DELETE ON ec_workbench_tasks
 BEGIN SELECT RAISE(ABORT,'WORKBENCH_KEEP_HISTORY'); END;
CREATE TRIGGER ec_workbench_tasks_audit_insert AFTER INSERT ON ec_workbench_tasks
 BEGIN
 INSERT INTO ec_workbench_task_audit(task_key,version,actor_id,actor_name,snapshot_json)
 VALUES(NEW.task_key,NEW.version,NEW.actor_id,NEW.actor_name,
 json_object('namespace','ec','task_key',NEW.task_key,'source_kind',NEW.source_kind,'source_id',NEW.source_id,'feature',NEW.feature,'title',NEW.title,'notes',NEW.notes,'assignee_id',NEW.assignee_id,'assignee_name',NEW.assignee_name,'due_on',NEW.due_on,'status',NEW.status,'snooze_until',NEW.snooze_until,'version',NEW.version,'actor_id',NEW.actor_id,'actor_name',NEW.actor_name));
 END;
CREATE TRIGGER ec_workbench_tasks_audit_update AFTER UPDATE ON ec_workbench_tasks
 BEGIN
 INSERT INTO ec_workbench_task_audit(task_key,version,actor_id,actor_name,snapshot_json)
 VALUES(NEW.task_key,NEW.version,NEW.actor_id,NEW.actor_name,
 json_object('namespace','ec','task_key',NEW.task_key,'source_kind',NEW.source_kind,'source_id',NEW.source_id,'feature',NEW.feature,'title',NEW.title,'notes',NEW.notes,'assignee_id',NEW.assignee_id,'assignee_name',NEW.assignee_name,'due_on',NEW.due_on,'status',NEW.status,'snooze_until',NEW.snooze_until,'version',NEW.version,'actor_id',NEW.actor_id,'actor_name',NEW.actor_name));
 END;
CREATE TRIGGER ec_workbench_task_audit_no_update BEFORE UPDATE ON ec_workbench_task_audit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER ec_workbench_task_audit_no_delete BEFORE DELETE ON ec_workbench_task_audit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;

CREATE TABLE lp_workbench_tasks(
 task_key TEXT PRIMARY KEY,
 source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL,
 feature TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
 notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=2000),
 assignee_id TEXT,
 assignee_name TEXT,
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND date(due_on) IS NOT NULL AND date(due_on)=due_on)),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
 snooze_until TEXT CHECK(snooze_until IS NULL OR (length(snooze_until)=10 AND date(snooze_until) IS NOT NULL AND date(snooze_until)=snooze_until)),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>0),
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((assignee_id IS NULL AND assignee_name IS NULL) OR (assignee_id IS NOT NULL AND assignee_name IS NOT NULL)),
 CHECK(source_kind='custom' OR status!='done'),
 UNIQUE(source_kind,source_id)
);
CREATE INDEX lp_workbench_tasks_due ON lp_workbench_tasks(status,due_on,assignee_id);
CREATE TABLE lp_workbench_task_audit(
 id INTEGER PRIMARY KEY,
 task_key TEXT NOT NULL REFERENCES lp_workbench_tasks(task_key),
 version INTEGER NOT NULL,
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(task_key,version)
);
CREATE TRIGGER lp_workbench_tasks_version BEFORE UPDATE ON lp_workbench_tasks
 WHEN NEW.version!=OLD.version+1 OR NEW.task_key!=OLD.task_key OR NEW.source_kind!=OLD.source_kind OR NEW.source_id!=OLD.source_id OR NEW.feature!=OLD.feature OR NEW.created_at!=OLD.created_at
 BEGIN SELECT RAISE(ABORT,'WORKBENCH_VERSION_OR_IDENTITY'); END;
CREATE TRIGGER lp_workbench_tasks_no_delete BEFORE DELETE ON lp_workbench_tasks
 BEGIN SELECT RAISE(ABORT,'WORKBENCH_KEEP_HISTORY'); END;
CREATE TRIGGER lp_workbench_tasks_audit_insert AFTER INSERT ON lp_workbench_tasks
 BEGIN
 INSERT INTO lp_workbench_task_audit(task_key,version,actor_id,actor_name,snapshot_json)
 VALUES(NEW.task_key,NEW.version,NEW.actor_id,NEW.actor_name,
 json_object('namespace','lp','task_key',NEW.task_key,'source_kind',NEW.source_kind,'source_id',NEW.source_id,'feature',NEW.feature,'title',NEW.title,'notes',NEW.notes,'assignee_id',NEW.assignee_id,'assignee_name',NEW.assignee_name,'due_on',NEW.due_on,'status',NEW.status,'snooze_until',NEW.snooze_until,'version',NEW.version,'actor_id',NEW.actor_id,'actor_name',NEW.actor_name));
 END;
CREATE TRIGGER lp_workbench_tasks_audit_update AFTER UPDATE ON lp_workbench_tasks
 BEGIN
 INSERT INTO lp_workbench_task_audit(task_key,version,actor_id,actor_name,snapshot_json)
 VALUES(NEW.task_key,NEW.version,NEW.actor_id,NEW.actor_name,
 json_object('namespace','lp','task_key',NEW.task_key,'source_kind',NEW.source_kind,'source_id',NEW.source_id,'feature',NEW.feature,'title',NEW.title,'notes',NEW.notes,'assignee_id',NEW.assignee_id,'assignee_name',NEW.assignee_name,'due_on',NEW.due_on,'status',NEW.status,'snooze_until',NEW.snooze_until,'version',NEW.version,'actor_id',NEW.actor_id,'actor_name',NEW.actor_name));
 END;
CREATE TRIGGER lp_workbench_task_audit_no_update BEFORE UPDATE ON lp_workbench_task_audit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER lp_workbench_task_audit_no_delete BEFORE DELETE ON lp_workbench_task_audit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;

