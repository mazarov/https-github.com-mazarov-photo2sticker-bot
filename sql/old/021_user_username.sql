-- Add Telegram username to users table for easy lookup

ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;

-- Index for searching by username
CREATE INDEX IF NOT EXISTS users_username_idx ON users (username);
