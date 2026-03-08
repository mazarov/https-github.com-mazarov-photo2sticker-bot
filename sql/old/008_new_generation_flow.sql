-- New generation flow: states, fields, presets, and texts

-- Session state enum values
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'confirm_sticker';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_emotion';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_custom_emotion';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'processing_emotion';

-- Sessions fields
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_photo_file_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_sticker_file_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_sticker_storage_path text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_style_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_emotion text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS emotion_prompt text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS generation_type text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS credits_spent int default 1;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_generation_type text;

-- Users fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS sticker_set_name text;

-- Emotion presets
CREATE TABLE IF NOT EXISTS emotion_presets (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS emotion_presets_active_idx ON emotion_presets (is_active, sort_order);

INSERT INTO emotion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('happy', '😄', 'Радуюсь!', 'Feeling happy', 'happy, joyful expression, big smile', 1),
  ('warm', '😊', 'Тёплое настроение', 'Warm mood', 'warm smile, gentle expression, content', 2),
  ('excited', '🤩', 'В восторге', 'Super excited', 'excited, amazed, star eyes, thrilled', 3),
  ('sad', '😢', 'Грустный', 'Feeling sad', 'sad, teary eyes, melancholic', 4),
  ('angry', '😠', 'Злой', 'Angry', 'angry, frowning, irritated expression', 5),
  ('surprised', '😲', 'Удивлённый', 'Surprised', 'surprised, shocked, wide eyes, open mouth', 6),
  ('love', '😍', 'Влюблён', 'In love', 'heart eyes, loving expression, dreamy', 7),
  ('custom', '✍️', 'Своя эмоция', 'Custom emotion', '', 8)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;

-- bot_texts_new updates
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.add_to_pack', '➕ Добавить в пак'),
  ('en', 'btn.add_to_pack', '➕ Add to pack'),
  ('ru', 'btn.change_style', '🎨 Изменить стиль'),
  ('en', 'btn.change_style', '🎨 Change style'),
  ('ru', 'btn.change_emotion', '😊 Изменить эмоцию'),
  ('en', 'btn.change_emotion', '😊 Change emotion'),
  ('ru', 'emotion.choose', 'Выберите эмоцию для стикера 😊'),
  ('en', 'emotion.choose', 'Choose an emotion for the sticker 😊'),
  ('ru', 'emotion.custom_prompt', 'Опишите желаемую эмоцию ✍️'),
  ('en', 'emotion.custom_prompt', 'Describe the desired emotion ✍️'),
  ('ru', 'sticker.added_to_pack', 'Стикер добавлен в пак! 🎉\n{link}'),
  ('en', 'sticker.added_to_pack', 'Sticker added to pack! 🎉\n{link}'),
  ('ru', 'error.no_stickers_added', 'Вы не добавили ни одного стикера 🧩'),
  ('en', 'error.no_stickers_added', 'You haven''t added any stickers 🧩'),
  ('ru', 'error.technical', 'Что-то пошло не так. Попробуйте повторить попытку позже ⚠️'),
  ('en', 'error.technical', 'Something went wrong. Please try again later ⚠️')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
