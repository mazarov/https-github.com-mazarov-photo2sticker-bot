-- Add last_photo_file_id to users table for reusing photos across sessions
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_photo_file_id TEXT;

COMMENT ON COLUMN users.last_photo_file_id IS 'Last uploaded photo telegram_file_id — reused when switching modes';
