CREATE TABLE social_snapshots (
  channel TEXT NOT NULL CHECK(channel IN ('youtube','instagram','discord','x')),
  day TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json) AND length(metrics_json) < 2048),
  PRIMARY KEY(channel, day)
) STRICT;
CREATE TABLE integration_status (
  channel TEXT PRIMARY KEY,
  last_attempt INTEGER NOT NULL,
  last_success INTEGER,
  error TEXT
) STRICT;
CREATE TABLE report_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
INSERT INTO report_settings(id, enabled) VALUES (1, 1);
CREATE TABLE report_runs (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
