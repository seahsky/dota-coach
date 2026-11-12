-- One key/value table holds everything: profile, watcher jobs and log, reviews, map marks,
-- the map picture (in chunks) and the API cache. See worker/store.ts.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at) WHERE expires_at IS NOT NULL;
