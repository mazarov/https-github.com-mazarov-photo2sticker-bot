-- Add border column to assistant_sessions
ALTER TABLE assistant_sessions ADD COLUMN IF NOT EXISTS border boolean DEFAULT false;
