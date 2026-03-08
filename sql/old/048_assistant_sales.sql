-- Add sales agent columns to assistant_sessions
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS paywall_shown boolean DEFAULT false;
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS paywall_shown_at timestamptz;
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS sales_attempts integer DEFAULT 0;
