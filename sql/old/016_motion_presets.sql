-- Motion presets for pose/action changes

CREATE TABLE IF NOT EXISTS motion_presets (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS motion_presets_active_idx ON motion_presets (is_active, sort_order);

INSERT INTO motion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('waving', '👋', 'Машет рукой', 'Waving', 'waving hand, greeting gesture, friendly wave', 1),
  ('thumbs_up', '👍', 'Показывает класс', 'Thumbs up', 'thumbs up gesture, approval, like sign', 2),
  ('facepalm', '🤦', 'Фейспалм', 'Facepalm', 'facepalm gesture, hand on face, frustrated', 3),
  ('praying', '🙏', 'Молится', 'Praying', 'hands together, praying or pleading gesture', 4),
  ('flexing', '💪', 'Показывает силу', 'Flexing', 'flexing arm, showing bicep, strong pose', 5),
  ('running', '🏃', 'Бежит', 'Running', 'running pose, dynamic movement, legs in motion', 6),
  ('dancing', '💃', 'Танцует', 'Dancing', 'dancing pose, joyful movement, party dance', 7),
  ('shrugging', '🤷', 'Пожимает плечами', 'Shrugging', 'shrugging shoulders, palms up, uncertain', 8),
  ('peace', '✌️', 'Знак мира', 'Peace sign', 'peace sign gesture, two fingers up, victory', 9),
  ('heart_hands', '🫶', 'Сердечко руками', 'Heart hands', 'hands forming heart shape, love gesture', 10),
  ('covering_eyes', '🙈', 'Закрывает глаза', 'Covering eyes', 'hands covering eyes, shy, peek-a-boo', 11),
  ('celebrating', '🎉', 'Празднует', 'Celebrating', 'celebrating pose, arms up, party, cheering', 12),
  ('custom', '✍️', 'Своё движение', 'Custom pose', '', 13)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;

-- Session fields for motion
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_motion text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS motion_prompt text;

-- Localization
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.change_motion', '🏃 Изменить движение'),
  ('en', 'btn.change_motion', '🏃 Change pose'),
  ('ru', 'motion.choose', '🏃 Выберите движение:'),
  ('en', 'motion.choose', '🏃 Choose a pose:'),
  ('ru', 'motion.custom_prompt', '✍️ Опишите желаемое движение или позу:'),
  ('en', 'motion.custom_prompt', '✍️ Describe the desired pose or action:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
