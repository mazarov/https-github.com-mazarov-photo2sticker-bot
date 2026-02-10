-- UTM tracking: save traffic source on user registration
ALTER TABLE users ADD COLUMN IF NOT EXISTS start_payload text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_content text;

CREATE INDEX IF NOT EXISTS idx_users_utm_source ON users(utm_source);
CREATE INDEX IF NOT EXISTS idx_users_utm_campaign ON users(utm_campaign);
