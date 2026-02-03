-- Generation progress message tracking
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS progress_message_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS progress_chat_id bigint;

-- Progress texts (7 steps)
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'progress.step1', '🔍 Анализирую фото... (1/7)'),
  ('en', 'progress.step1', '🔍 Analyzing photo... (1/7)'),
  ('ru', 'progress.step2', '🎨 Подбираю стиль... (2/7)'),
  ('en', 'progress.step2', '🎨 Selecting style... (2/7)'),
  ('ru', 'progress.step3', '✨ Генерирую изображение... (3/7)'),
  ('en', 'progress.step3', '✨ Generating image... (3/7)'),
  ('ru', 'progress.step4', '🖼 Обрабатываю результат... (4/7)'),
  ('en', 'progress.step4', '🖼 Processing result... (4/7)'),
  ('ru', 'progress.step5', '✂️ Удаляю фон... (5/7)'),
  ('en', 'progress.step5', '✂️ Removing background... (5/7)'),
  ('ru', 'progress.step6', '📐 Оптимизирую размер... (6/7)'),
  ('en', 'progress.step6', '📐 Optimizing size... (6/7)'),
  ('ru', 'progress.step7', '📦 Подготавливаю стикер... (7/7)'),
  ('en', 'progress.step7', '📦 Preparing sticker... (7/7)')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();

-- Remove old 3-step keys (optional cleanup)
DELETE FROM bot_texts_new WHERE key IN (
  'progress.generating_image',
  'progress.removing_bg',
  'progress.preparing'
);
