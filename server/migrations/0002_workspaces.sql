-- Authenticated workspace records are separate from anonymous analytics records
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX workspaces_creator ON workspaces(created_by);

CREATE TABLE workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
  subject TEXT,
  role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, email),
  UNIQUE(workspace_id, subject)
) STRICT;
CREATE INDEX workspace_members_identity ON workspace_members(email, subject, workspace_id);

CREATE TABLE workspace_scenarios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  simulator_json TEXT NOT NULL CHECK(json_valid(simulator_json) AND length(simulator_json) <= 4096),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX workspace_scenarios_workspace ON workspace_scenarios(workspace_id, updated_at, id);

-- Only active, subject-bound owners count toward the last-owner invariant
CREATE TRIGGER workspace_last_owner_update BEFORE UPDATE OF role ON workspace_members
WHEN OLD.role = 'owner' AND OLD.subject IS NOT NULL AND NEW.role <> 'owner'
  AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND subject IS NOT NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_owner_required');
END;
CREATE TRIGGER workspace_last_owner_delete BEFORE DELETE ON workspace_members
WHEN OLD.role = 'owner' AND OLD.subject IS NOT NULL
  AND EXISTS(SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
  AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND subject IS NOT NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_owner_required');
END;

-- Every child mutation advances the workspace ETag, preventing stale workspace deletion
CREATE TRIGGER workspace_member_insert AFTER INSERT ON workspace_members
WHEN (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = NEW.workspace_id) > 1
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, NEW.updated_at) WHERE id = NEW.workspace_id;
END;
CREATE TRIGGER workspace_member_update AFTER UPDATE ON workspace_members
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, NEW.updated_at) WHERE id = NEW.workspace_id;
END;
CREATE TRIGGER workspace_member_delete AFTER DELETE ON workspace_members
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE id = OLD.workspace_id;
END;
CREATE TRIGGER workspace_scenario_insert AFTER INSERT ON workspace_scenarios
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, NEW.updated_at) WHERE id = NEW.workspace_id;
END;
CREATE TRIGGER workspace_scenario_update AFTER UPDATE ON workspace_scenarios
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, NEW.updated_at) WHERE id = NEW.workspace_id;
END;
CREATE TRIGGER workspace_scenario_delete AFTER DELETE ON workspace_scenarios
BEGIN
  UPDATE workspaces SET version = version + 1, updated_at = MAX(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE id = OLD.workspace_id;
END;
