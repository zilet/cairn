-- Apply with: wrangler d1 execute cairn-feedback --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  version     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  arch        TEXT NOT NULL,
  node        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS instances_last_seen ON instances(last_seen);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  contact     TEXT,
  version     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  diagnostics TEXT
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_at);

-- Rate-limit counters. `key` embeds a hashed (daily-salted) IP or an instance id;
-- rows older than two days are swept by the cron.
CREATE TABLE IF NOT EXISTS rate (
  key    TEXT NOT NULL,
  bucket TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);

-- Global daily caps on GitHub / webhook forwards (one row per UTC day per channel;
-- swept by the cron). Incremented atomically with an upsert.
CREATE TABLE IF NOT EXISTS forward_counts (
  day     TEXT NOT NULL,
  channel TEXT NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (day, channel)
);
