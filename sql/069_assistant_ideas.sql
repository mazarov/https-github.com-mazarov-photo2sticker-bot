-- Add sticker_ideas_state to sessions for assistant ideas feature
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sticker_ideas_state jsonb DEFAULT NULL;
