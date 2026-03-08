-- Add text to sticker feature

-- New session states
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_text';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'processing_text';

-- New field for storing user's text
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS text_prompt text;

-- Localization
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.add_text', '✏️ Добавить текст'),
  ('en', 'btn.add_text', '✏️ Add text'),
  ('ru', 'text.prompt', 'Введите текст для стикера:'),
  ('en', 'text.prompt', 'Enter text for the sticker:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
