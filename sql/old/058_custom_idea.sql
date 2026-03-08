-- Custom idea: user types a word/phrase, GPT generates a tailored sticker idea
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS waiting_custom_idea boolean DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS custom_idea jsonb DEFAULT NULL;
