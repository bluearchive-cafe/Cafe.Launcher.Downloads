CREATE TABLE IF NOT EXISTS traffic_daily (
  day TEXT NOT NULL,
  route TEXT NOT NULL,
  tag TEXT NOT NULL,
  file TEXT NOT NULL,
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  status INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  handler_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, tag, file, method, source, status)
) WITHOUT ROWID;
