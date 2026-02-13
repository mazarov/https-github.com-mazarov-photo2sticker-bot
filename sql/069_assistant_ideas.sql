-- Add sticker_ideas_state to sessions for assistant ideas feature
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sticker_ideas_state jsonb DEFAULT NULL;

-- Add assistant_wait_idea to session_state enum
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'assistant_wait_idea';
