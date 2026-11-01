-- Old events stay NULL: historical dimensions were never collected
ALTER TABLE analytics_events ADD COLUMN country TEXT;
ALTER TABLE analytics_events ADD COLUMN device TEXT;
ALTER TABLE analytics_events ADD COLUMN platform TEXT;
ALTER TABLE analytics_events ADD COLUMN browser TEXT;
