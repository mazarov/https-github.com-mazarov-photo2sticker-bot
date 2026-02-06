-- Add language_code column to store original Telegram language code
-- Used for analytics and geo-filtering free credits

ALTER TABLE users ADD COLUMN IF NOT EXISTS language_code text;

COMMENT ON COLUMN users.language_code IS 'Original Telegram language_code (e.g., ru, en, de, hi). Used for analytics and geo-filtering.';
