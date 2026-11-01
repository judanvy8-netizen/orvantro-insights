CREATE TABLE IF NOT EXISTS auth_flows (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('admin','workspace')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_flows_expiry ON auth_flows(expires_at);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_subject ON auth_sessions(subject, created_at);
