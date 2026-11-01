CREATE TABLE analytics_events (
  event_key TEXT PRIMARY KEY NOT NULL CHECK(length(event_key) = 64),
  session_key TEXT NOT NULL CHECK(length(session_key) = 64),
  site TEXT NOT NULL CHECK(site IN ('orvantro', 'marginkit-pro-beta', 'orvantro-insights')),
  day TEXT NOT NULL CHECK(length(day) = 10),
  received_at INTEGER NOT NULL
) STRICT;

CREATE INDEX analytics_events_day_site_session
  ON analytics_events(day, site, session_key);

CREATE TABLE analytics_collection (
  site TEXT PRIMARY KEY NOT NULL CHECK(site IN ('orvantro', 'marginkit-pro-beta', 'orvantro-insights')),
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL
) STRICT;
