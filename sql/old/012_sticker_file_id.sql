-- Add telegram_file_id column to stickers table
-- This stores the Telegram file_id for the sticker to enable
-- direct sticker retrieval without depending on active session

ALTER TABLE stickers ADD COLUMN IF NOT EXISTS telegram_file_id text;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_stickers_telegram_file_id ON stickers(telegram_file_id);
